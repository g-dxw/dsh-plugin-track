/**
 * The HTTP surface, against a real DSH web server.
 *
 * Nothing is stubbed except the `$DSH_HOME` the store writes into: the routes,
 * the gate, and the content-disposition header are all exercised through an
 * actual socket, because the parts most likely to break — the byte-for-byte
 * round trip and the 403 on a cross-origin call — are exactly the parts a
 * mocked request object would paper over.
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import * as plugin from '../src/index.ts'
import { permitted } from '../src/index.ts'
import { readSource, tracksRoot } from '../src/artifacts.ts'
import { API, type TrackInput } from '../src/protocol.ts'

const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})})
function temp(): string {const root = mkdtempSync(join(tmpdir(), 'cqai-track-')); roots.push(root); return root}

/** A request shaped the way `permitted` reads one, with loopback defaults. */
function request(headers: Record<string, string>, method = 'POST'): IncomingMessage {
  return {method, headers: {host: '127.0.0.1:43120', ...headers}, socket: {remoteAddress: '127.0.0.1'}} as IncomingMessage
}

describe('the loopback gate', () => {
  it('lets the panel through', () => {
    expect(permitted(request({'x-cqai-track': '1'}))).toBe(true)
    expect(permitted(request({}, 'GET'))).toBe(true)
    expect(permitted(request({'x-cqai-track': '1', origin: 'http://127.0.0.1:43120'}))).toBe(true)
    expect(permitted(request({'x-cqai-track': '1', origin: 'https://127.0.0.1:43120'}))).toBe(true)
    expect(permitted(request({'x-cqai-track': '1', 'sec-fetch-site': 'same-origin'}))).toBe(true)
    expect(permitted({method: 'GET', headers: {host: '127.0.0.1:43120'}, socket: {remoteAddress: '::1'}} as IncomingMessage)).toBe(true)
  })

  it('refuses anything a page in the user’s own browser could reach', () => {
    // No header: a plain form POST from any local page would otherwise land here.
    expect(permitted(request({}))).toBe(false)
    expect(permitted(request({'x-cqai-track': '1', origin: 'https://evil.example'}))).toBe(false)
    expect(permitted(request({'x-cqai-track': '1', 'sec-fetch-site': 'cross-site'}))).toBe(false)
    expect(permitted({method: 'GET', headers: {host: '127.0.0.1:43120'}, socket: {remoteAddress: '10.0.0.7'}} as IncomingMessage)).toBe(false)
    expect(permitted({method: 'GET', headers: {host: '127.0.0.1:43120'}, socket: {}} as IncomingMessage)).toBe(false)
  })
})

const POINTS: TrackInput['points'] = [
  [120, 30, 100, Date.parse('2026-09-20T01:00:00Z')],
  [120.01, 30, 120, Date.parse('2026-09-20T01:10:00Z')],
  [120.02, 30, 110, Date.parse('2026-09-20T01:20:00Z')],
]

const SOURCE = '<?xml version="1.0"?><gpx><trk><name>晨跑</name></trk></gpx>'

const BODY: TrackInput = {
  name: '晨跑',
  filename: 'morning.gpx',
  source: SOURCE,
  points: POINTS,
  metrics: {
    distance: 1200, elevationGain: 20, elevationLoss: 10, duration: 1_200_000,
    elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.02, 30],
  },
}

describe('the HTTP surface', () => {
  it('mounts on DSH’s own server and answers the panel’s actions', async () => {
    const home = temp()
    const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home
    const ctx = new Context()
    try {
      await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0})
      await ctx.plugin(plugin)
      const base = `http://127.0.0.1:${String(ctx.webServer.port)}${API}`
      const send = (action: string, body?: unknown, method?: string) => fetch(`${base}/${action}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {'x-cqai-track': '1', 'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
      })

      // The first run of the plugin has no store at all, and an empty list is not
      // an error — the panel must be able to draw itself before any import.
      const initial = await send('tracks')
      expect(initial.status).toBe(200)
      expect(initial.headers.get('content-type')).toContain('application/json')
      expect(await initial.json()).toEqual([])
      // Agent opens before import and uses one workspace/session for the library.
      const emptyAgent = await send('agent-workspace', {})
      expect(emptyAgent.status).toBe(200)
      const agentWorkspace = await emptyAgent.json()
      expect(agentWorkspace).toEqual({path: join(home, 'track-agent', '轨迹'), sessionId: null})
      const emptyContext = await send('agent-context', {page: 'library'})
      expect(await emptyContext.json()).toMatchObject({version: 2, library: {trackCount: 0}, current: {page: 'library', trackId: null}})
      expect((await send('agent-session', {sessionId: 'library-session'})).status).toBe(200)
      expect(await (await send('agent-workspace', {})).json()).toEqual({...agentWorkspace, sessionId: 'library-session'})
      expect((await send('agent-context', {page: '__proto__'})).status).toBe(400)
      expect((await send('agent-context', {page: 'overview', trackId: '../escape'})).status).toBe(400)
      expect((await send('agent-session', {sessionId: '../escape'})).status).toBe(400)
      expect((await fetch(`${base}/agent-workspace`, {method: 'POST', body: '{}'})).status).toBe(403)
      // An optional account service must not prevent the ordinary track routes
      // from mounting, or manufacture a script while no AI is connected.
      for (const action of ['text-models', 'analyze', 'animation-script', 'video-script']) {
        const unavailable = await send(action, action === 'text-models' ? undefined : {})
        expect(unavailable.status).toBe(503)
        expect(await unavailable.json()).toMatchObject({error: expect.stringContaining('账号服务')})
      }

      const created = await send('tracks', BODY)
      expect(created.status).toBe(201)
      const written = await created.json()
      expect(written).toMatchObject({name: '晨跑', filename: 'morning.gpx', format: 'gpx', points: 3})
      expect(written.metrics.distance).toBe(1200)
      const selectedContext = await send('agent-context', {page: 'overview', trackId: written.id})
      expect(await selectedContext.json()).toMatchObject({library: {trackCount: 1}, current: {page: 'overview', trackId: written.id, track: {name: '晨跑'}}})
      expect(await (await send('agent-workspace', {})).json()).toEqual({...agentWorkspace, sessionId: 'library-session'})
      const listContext = await send('agent-context', {page: 'library'})
      expect(await listContext.json()).toMatchObject({current: {page: 'library', trackId: null, track: null}})

      // The list carries metadata only: a track with 500k points must not turn the
      // panel's index into a payload the size of the track itself.
      const [summary] = await (await send('tracks')).json()
      expect(summary).not.toHaveProperty('coordinates')
      expect(summary.id).toBe(written.id)

      const detail = await (await send(`track?id=${written.id}`)).json()
      expect(detail.coordinates).toEqual(POINTS)

      // The original file comes back byte for byte, as a download. `fc`-grade
      // equality is the whole point of keeping `source.<ext>` beside the parse.
      const source = await send(`source?id=${written.id}`)
      expect(source.status).toBe(200)
      expect(source.headers.get('content-disposition')).toContain('attachment')
      expect(source.headers.get('content-disposition')).toContain('morning.gpx')
      expect(await source.text()).toBe(SOURCE)
      expect(Number(source.headers.get('content-length'))).toBe(Buffer.byteLength(SOURCE, 'utf8'))

      expect((await send(`track?id=${written.id}`, undefined, 'DELETE')).status).toBe(200)
      expect(await (await send('tracks')).json()).toEqual([])
      // An optional account service must not prevent the ordinary track routes
      // from mounting, or manufacture a script while no AI is connected.
      for (const action of ['text-models', 'analyze', 'animation-script', 'video-script']) {
        const unavailable = await send(action, action === 'text-models' ? undefined : {})
        expect(unavailable.status).toBe(503)
        expect(await unavailable.json()).toMatchObject({error: expect.stringContaining('账号服务')})
      }
      // A second delete is a 404, not a crash — the panel may ask twice.
      expect((await send(`track?id=${written.id}`, undefined, 'DELETE')).status).toBe(404)
      expect((await send('track?id=missing')).status).toBe(404)
      expect((await send('source?id=missing')).status).toBe(404)
      expect((await send('不存在')).status).toBe(404)
      // An id that tries to walk out of the store is an unknown track, not a read.
      expect((await send('track?id=../../outside')).status).toBe(404)

      // Validation errors come back as 400 with a sentence the panel can show.
      const nameless = await send('tracks', {...BODY, filename: 42})
      expect(nameless.status).toBe(400)
      expect((await nameless.json()).error).toBe('缺少文件名')
      const noPoints = await send('tracks', {...BODY, points: []})
      expect(noPoints.status).toBe(400)
      expect((await noPoints.json()).error).toBe('轨迹里没有可用的坐标点')
      const halfFix = await send('tracks', {...BODY, points: [[Number.NaN, 30, 100, null]]})
      expect((await halfFix.json()).error).toBe('第 1 个轨迹点无效')

      // The gate applies to the mounted route too, not only to the helper.
      expect((await fetch(`${base}/tracks`, {headers: {origin: 'https://evil.example'}})).status).toBe(403)
      expect((await fetch(`${base}/tracks`, {method: 'POST', body: '{}'})).status).toBe(403)
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    }
  }, 30000)

  it('keeps the original bytes, not a re-serialisation of them', async () => {
    // The export promise is "here is the file you gave us". A store that wrote the
    // source back out through the parser would still round-trip *this* fixture, so
    // the check is against the directory on disk rather than the response alone.
    const home = temp()
    const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home
    const ctx = new Context()
    try {
      await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0})
      await ctx.plugin(plugin)
      const base = `http://127.0.0.1:${String(ctx.webServer.port)}${API}`
      const written = await (await fetch(`${base}/tracks`, {
        method: 'POST',
        headers: {'x-cqai-track': '1', 'content-type': 'application/json'},
        body: JSON.stringify({...BODY, source: '轨'}),
      })).json()
      expect(written.bytes).toBe(3)
      expect(readSource(written.id, {DSH_HOME: home})!.body.toString('utf8')).toBe('轨')
      expect(tracksRoot({DSH_HOME: home})).toContain('track')
      expect(readSource(written.id, {DSH_HOME: home})!.ext).toBe('gpx')
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    }
  }, 30000)
})
