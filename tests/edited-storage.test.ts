import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTrack, writeTrackBatch, readSource, listTracks, tracksRoot } from '../src/artifacts.ts'
import * as plugin from '../src/index.ts'
import { API, type TrackInput } from '../src/protocol.ts'
import { pointMetrics } from '../src/track/metrics.ts'

let home: string
let previousHome: string | undefined
let ctx: Context | undefined
beforeEach(() => {home = mkdtempSync(join(tmpdir(), 'cqai-track-edit-')); previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home})
afterEach(async () => {
  await ctx?.fiber.dispose(); ctx = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  if (!home.startsWith(join(tmpdir(), 'cqai-track-edit-'))) throw new Error('Unexpected edit test directory')
  rmSync(home, {recursive: true, force: true})
})
function input(name = '测试副本'): TrackInput {
  const points: TrackInput['points'] = [[119.44, 30.34, null, null], [119.45, 30.35, null, null]]
  return {name, filename: name + '.gpx', source: `<gpx version="1.1"><trk><name>${name}</name><trkseg><trkpt lon="119.44" lat="30.34"/><trkpt lon="119.45" lat="30.35"/></trkseg></trk></gpx>`, points, metrics: pointMetrics(points)}
}
async function server() {
  ctx = new Context()
  await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0})
  await ctx.plugin(plugin)
  return `http://127.0.0.1:${ctx.webServer.port}${API}`
}

describe('edited copies save together', () => {
  it('writes two copies and preserves the original GPX byte for byte', async () => {
    const original = writeTrack(input('原始轨迹'))
    const bytes = readSource(original.id)!.body
    const base = await server()
    const response = await fetch(base + '/edited-tracks', {method: 'POST', headers: {'x-cqai-track': '1', 'content-type': 'application/json'}, body: JSON.stringify({tracks: [input('第一段'), input('第二段')]})})
    expect(response.status).toBe(201)
    const result = await response.json() as {id: string}[]
    expect(result).toHaveLength(2)
    expect(new Set(result.map(track => track.id)).size).toBe(2)
    expect(listTracks()).toHaveLength(3)
    expect(readSource(original.id)!.body).toEqual(bytes)
    for (const track of result) expect(readSource(track.id)?.ext).toBe('gpx')
  })
  it('validates every split result before writing any of them', async () => {
    const base = await server()
    const bad = {...input('第二段'), points: [[119, 30, null, null]]}
    const response = await fetch(base + '/edited-tracks', {method: 'POST', headers: {'x-cqai-track': '1', 'content-type': 'application/json'}, body: JSON.stringify({tracks: [input('第一段'), bad]})})
    expect(response.status).toBe(400)
    expect((await response.json() as {error: string}).error).toContain('2 个点')
    expect(listTracks()).toHaveLength(0)
  })
  it('rolls back only the new copies if a later filesystem write fails', () => {
    const original = writeTrack(input('原始轨迹'))
    const bytes = readSource(original.id)!.body
    const bad = {...input('失败副本'), points: [[1n, 30, null, null]]} as unknown as TrackInput
    expect(() => writeTrackBatch([input('第一段'), bad])).toThrow()
    expect(listTracks().map(track => track.id)).toEqual([original.id])
    expect(readSource(original.id)!.body).toEqual(bytes)
    expect(readdirSync(tracksRoot())).toEqual([original.id])
  })
  it('does not leave a half-written directory after an individual write fails', () => {
    const bad = {...input(), points: [[1n, 30, null, null]]} as unknown as TrackInput
    expect(() => writeTrack(bad)).toThrow()
    expect(listTracks()).toHaveLength(0)
    expect(readdirSync(tracksRoot())).toHaveLength(0)
  })
})
