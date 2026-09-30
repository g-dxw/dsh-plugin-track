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
import { API } from '../src/protocol.ts'
import { GPX_TRACK, KML_TRACK, TCX_TRACK } from './fixtures.ts'

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
  await ctx.plugin({...plugin, inject: ['webServer']})
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
  it.each([
    {filename: '晨跑.gpx', source: GPX_TRACK},
    {filename: '武功山反穿.kml', source: KML_TRACK},
    {filename: '骑行.tcx', source: TCX_TRACK},
  ])('imports $filename and returns the unchanged original file', async ({filename, source}) => {
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
    expect(state.open?.coordinates.length).toBeGreaterThan(0)
    expect(state.list.some(track => track.id === state.open?.id)).toBe(true)
    const response = await fetchFromNode(base + API + '/source?id=' + encodeURIComponent(state.open!.id))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''" + encodeURIComponent(filename))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(original, 'utf8'))
  })
})