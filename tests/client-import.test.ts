// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { File as NodeFile } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { useTracks, type TracksState } from '../src/client/useTracks.ts'
import { API, METRICS_VERSION } from '../src/protocol.ts'
import { GPX_TRACK, KML_TRACK, KML_SUMMARY, KML_WAYPOINT_FIRST, TCX_TRACK } from './fixtures.ts'
import { editedTrackInput } from '../src/track/gpx-export.ts'
import { writeTrack } from '../src/artifacts.ts'
import { parseTrackFile } from '../src/track/import.ts'

const fetchFromNode = globalThis.fetch
const tempPrefix = join(resolve(tmpdir()), 'cqai-track-client-')
let ctx: Context
let root: Root
let container: HTMLDivElement
let home: string
let base: string
let state: TracksState
let completed: {path: string; method: string; ok: boolean}[]

function Panel(): null {
  state = useTracks()
  return null
}

beforeEach(async () => {
  home = mkdtempSync(tempPrefix)
  vi.stubEnv('DSH_HOME', home)
  ctx = new Context()
  await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0})
  await ctx.plugin(plugin)
  base = 'http://127.0.0.1:' + String(ctx.webServer.port)
  completed = []
  // Resolve relative URLs while retaining the real server and HTTP transport.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = typeof input === 'string' ? new URL(input, base).href : input
    const response = await fetchFromNode(url, options)
    await response.clone().arrayBuffer()
    completed.push({
      path: typeof input === 'string' ? new URL(input, base).pathname : '',
      method: options?.method ?? 'GET',
      ok: response.ok,
    })
    return response
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(Panel)) })
  await act(async () => {
    await vi.waitFor(() => {
      expect(completed.some(request => request.path === API + '/tracks' && request.method === 'GET')).toBe(true)
    })
  })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  await ctx?.fiber.dispose()
  container?.remove()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (home) {
    if (!resolve(home).startsWith(tempPrefix)) throw new Error('Unexpected test storage path')
    rmSync(home, {recursive: true, force: true})
  }
})

describe('the panel import and original-file export', () => {
  it('recalculates legacy imports from the retained source without changing titles or source bytes', async () => {
    const parsed = parseTrackFile('峨眉山.kml', KML_SUMMARY)
    const legacy = writeTrack({filename: '峨眉山.kml', source: KML_SUMMARY, name: '我的自定义名称', points: parsed.points,
      metrics: {...parsed.metrics, distance: 1, elevationGain: 99999, duration: 0, calculationVersion: undefined}})
    await act(async () => {
      state.refresh(); state.openTrack(legacy.id)
      await vi.waitFor(() => expect(completed.some(request => request.path === API + '/source')).toBe(true))
    })
    expect(state.open!.metrics).toEqual(parsed.metrics)
    expect(state.open!.name).toBe('我的自定义名称')
    expect(state.list.find(track => track.id === legacy.id)?.metrics).toEqual(parsed.metrics)
    expect(state.open!.coordinates).toEqual(parsed.points)
    const requests = completed.length
    await act(async () => {
      state.refresh()
      await vi.waitFor(() => expect(completed.length).toBeGreaterThan(requests))
    })
    expect(state.list.find(track => track.id === legacy.id)?.metrics).toEqual(parsed.metrics)
    expect(await (await fetchFromNode(base + API + '/source?id=' + legacy.id)).text()).toBe(KML_SUMMARY)
  })

  it('stores the current calculation version so new imports need no source reload', async () => {
    await act(async () => {
      state.importFiles([new NodeFile([KML_SUMMARY], '峨眉山.kml') as unknown as File])
      await vi.waitFor(() => expect(completed.some(request => request.path === API + '/track')).toBe(true))
    })
    expect(state.open!.metrics.duration).toBe(45_222_000)
    expect(completed.some(request => request.path === API + '/source')).toBe(false)
  })

  it('retries a temporarily unavailable legacy source on reopening', async () => {
    const parsed = parseTrackFile('峨眉山.kml', KML_SUMMARY)
    const legacy = writeTrack({filename: '峨眉山.kml', source: KML_SUMMARY, points: parsed.points,
      metrics: {...parsed.metrics, duration: 0, calculationVersion: undefined}})
    const send = globalThis.fetch
    let sourceReads = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => {
      if (typeof input === 'string' && input.startsWith(API + '/source') && ++sourceReads === 1) {
        return Promise.resolve(new Response('temporarily unavailable', {status: 503}))
      }
      return send(input, options)
    })
    await act(async () => {
      state.openTrack(legacy.id)
      await vi.waitFor(() => expect(sourceReads).toBe(1))
    })
    expect(state.open!.metrics.duration).toBe(0)
    expect(state.note).toContain('原文件暂时无法读取')
    await act(async () => {
      state.closeTrack(); state.openTrack(legacy.id)
      await vi.waitFor(() => expect(completed.some(request => request.path === API + '/source')).toBe(true))
    })
    expect(sourceReads).toBe(2)
    expect(state.open!.metrics.duration).toBe(45_222_000)
    expect(state.note).toBe('')
  })
  it('clears the unavailable-service message after a successful refresh', async () => {
    const send = globalThis.fetch
    let unavailable = true
    vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => unavailable
      ? Promise.resolve(new Response('<html>app shell</html>', {headers: {'content-type': 'text/html'}}))
      : send(input, options))
    await act(async () => {state.refresh()})
    expect(state.error).toContain('轨迹服务暂未就绪')
    unavailable = false
    const previousRequests = completed.length
    await act(async () => {
      state.refresh()
      await vi.waitFor(() => expect(completed.length).toBeGreaterThan(previousRequests))
    })
    expect(state.error).toBe('')
    expect(state.list).toEqual([])
  })

  it.each([
    {filename: '晨跑.gpx', source: GPX_TRACK, title: '晨跑'},
    {filename: '武功山反穿.kml', source: KML_TRACK, title: '武功山反穿'},
    {filename: '骑行.tcx', source: TCX_TRACK, title: '骑行'},
  ])('imports $filename and returns the unchanged original file', async ({filename, source, title}) => {
    const original = source.replace(/\r?\n/gu, '\r\n')
    const file = new NodeFile([original], filename) as unknown as File
    await act(async () => {
      state.importFiles([file])
      await vi.waitFor(() => {
        expect(completed.some(request =>
          request.path === API + '/track' && request.method === 'GET'
          || request.path === API + '/tracks' && request.method === 'POST' && !request.ok)).toBe(true)
      })
    })

    expect(state.note).toBe('')
    expect(state.error).toBe('')
    expect(state.open?.filename).toBe(filename)
    expect(state.open?.name).toBe(title)
    expect(state.list.find(track => track.id === state.open?.id)?.name).toBe(title)
    expect(state.open?.coordinates.length).toBeGreaterThan(0)
    expect(state.list.some(track => track.id === state.open?.id)).toBe(true)
    const response = await fetchFromNode(base + API + '/source?id=' + encodeURIComponent(state.open!.id))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''" + encodeURIComponent(filename))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(original, 'utf8'))
  })

  it('persists KML locations and image links independently from the measured path', async () => {
    const source = KML_TRACK.replace('</Document>', '<Placemark><name>牧场</name><description><![CDATA[草地 <img src="https://example.com/one.jpg"><img src="https://example.com/two.jpg">]]></description><Point><coordinates>120.01,30</coordinates></Point></Placemark></Document>')
    const file = new NodeFile([source], '点位路线.kml', {type: 'application/xml'})
    await act(async () => {
      state.importFiles([file as unknown as File])
      await vi.waitFor(() => expect(completed.some(request => request.path === API + '/track' && request.method === 'GET')).toBe(true))
    })
    const id = state.open!.id
    expect(state.open!.coordinates).toHaveLength(3)
    expect(state.open!.placemarks![0]).toMatchObject({name: '牧场', description: '草地', images: ['https://example.com/one.jpg', 'https://example.com/two.jpg']})
    const reads = completed.filter(request => request.path === API + '/track').length
    await act(async () => {
      state.closeTrack(); state.openTrack(id)
      await vi.waitFor(() => expect(completed.filter(request => request.path === API + '/track').length).toBeGreaterThan(reads))
    })
    expect(state.open!.placemarks).toHaveLength(1)
    const original = await fetchFromNode(base + API + '/source?id=' + id)
    expect(await original.text()).toBe(source)
    const before = await fetchFromNode(base + API + '/annotations?id=' + id)
    expect(await before.json()).toEqual({annotations: [], saved: false, layout: {}, route: {x: 0, y: 0, scale: 1}, canvas: {width: 1200, height: 900}, canvasSaved: false, styles: {}})
    const save = await fetchFromNode(base + API + '/annotations', {method: 'POST', headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify({id, annotations: []})})
    expect(save.ok).toBe(true)
    expect(await (await fetchFromNode(base + API + '/annotations?id=' + id)).json()).toEqual({annotations: [], saved: true, layout: {}, route: {x: 0, y: 0, scale: 1}, canvas: {width: 1200, height: 900}, canvasSaved: false, styles: {}})
  })

  it.each([
    {source: KML_WAYPOINT_FIRST, variant: 'named route'},
    {source: KML_WAYPOINT_FIRST.replace('<name>测试路线</name>', ''), variant: 'unnamed route'},
    {source: KML_WAYPOINT_FIRST.replace('<Document>', '<Document><name>文件里的路线名</name>'), variant: 'named document'},
  ])('stores and reopens the filename title for a $variant', async ({source}) => {
    const title = '峨眉山'
    await act(async () => {
      state.importFiles([new NodeFile([source], '峨眉山.kml') as unknown as File])
      await vi.waitFor(() => expect(completed.some(request => request.path === API + '/track' && request.method === 'GET')).toBe(true))
    })
    const id = state.open!.id
    expect(state.error).toBe('')
    expect(state.open!.name).toBe(title)
    expect(state.list.find(track => track.id === id)?.name).toBe(title)
    expect(state.open!.placemarks?.[0].name).toBe('起点')
    const reads = completed.filter(request => request.path === API + '/track').length
    await act(async () => {
      state.closeTrack(); state.openTrack(id)
      await vi.waitFor(() => expect(completed.filter(request => request.path === API + '/track').length).toBeGreaterThan(reads))
    })
    expect(state.open!.name).toBe(title)
    expect(await (await fetchFromNode(base + API + '/source?id=' + id)).text()).toBe(source)
  })
})
describe('edited copies through the panel and actual HTTP storage', () => {
  it('opens a saved copy, deletes it with DELETE, and preserves the original file', async () => {
    await act(async () => {
      state.importFiles([new NodeFile([GPX_TRACK], 'original.gpx') as unknown as File])
      await vi.waitFor(() => expect(completed.some(request => request.path === API + '/track' && request.method === 'GET')).toBe(true))
    })
    const original = state.open!
    const points = original.coordinates.map((point, index) => index === 1 ? [point[0] + 0.001, point[1], null, null] as typeof point : point)
    const input = editedTrackInput(points, {name: '编辑副本'})
    await act(async () => state.saveEdited([input]))
    const copy = state.open!
    expect(copy.id).not.toBe(original.id)
    expect(copy.coordinates).toEqual(points)
    expect(state.list.map(item => item.id)).toContain(original.id)
    expect(state.note).toContain('原始轨迹保留')
    const savedAnnotations = await fetchFromNode(base + API + '/annotations', {method: 'POST', headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify({id: copy.id, annotations: [{id: 'photo-point', pointIndex: 0, label: '起点照片', color: '#d33d33', photo: {dataUrl: 'data:image/png;base64,cGljdHVyZUE=', x: 40, y: 200}}]})})
    expect(savedAnnotations.ok).toBe(true)
    await act(async () => {
      state.remove(copy.id)
      await vi.waitFor(() => expect(completed.some(request => request.method === 'DELETE' && request.ok)).toBe(true))
    })
    expect(completed.some(request => request.method === 'DELETE' && request.path === API + '/track' && request.ok)).toBe(true)
    expect(state.open).toBeNull()
    expect((await fetchFromNode(base + API + '/source?id=' + copy.id)).status).toBe(404)
    expect((await fetchFromNode(base + API + '/annotations?id=' + copy.id)).status).toBe(400)
    const response = await fetchFromNode(base + API + '/source?id=' + original.id)
    expect(await response.text()).toBe(GPX_TRACK)
    expect(state.error).toBe('')
  })
})
