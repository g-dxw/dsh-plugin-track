import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import * as plugin from '../src/index.ts'
import { trackDir, writeTrack } from '../src/artifacts.ts'
import { API, type TrackInput } from '../src/protocol.ts'
import { PLACEMARK_PHOTO_MAX_BYTES, localPlacemarkPhoto } from '../src/track/placemark-photos.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-placemark-photos-routes-')) throw new Error('Unexpected photo fixture')
    rmSync(root, {recursive: true, force: true})
  }
})
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const input: TrackInput = {filename: 'original.gpx', source: '<gpx>original bytes</gpx>', points: [[120, 30, 100, null], [120.01, 30, 110, null]],
  metrics: {distance: 1000, elevationGain: 10, elevationLoss: 0, duration: 0, elevationMax: 110, elevationMin: 100, bbox: [120, 30, 120.01, 30]}}
async function withServer(run: (base: string, id: string, dir: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-placemark-photos-routes-')); roots.push(home)
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home
  const ctx = new Context()
  try {
    const {id} = writeTrack(input), dir = trackDir(id)
    await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0}); await ctx.plugin(plugin)
    await run(`http://127.0.0.1:${ctx.webServer.port}`, id, dir)
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  }
}
function upload(base: string, id: string, body: Uint8Array = PNG, headers: Record<string, string> = {}) {
  return fetch(`${base}${API}/placemark-photos?id=${encodeURIComponent(id)}`, {method: 'POST', headers: {'x-cqai-track': '1', ...headers}, body: new Uint8Array(body)})
}
function rawUpload(url: string, headers: Record<string, string>, chunks: readonly Buffer[]): Promise<{status: number; body: string}> {
  return new Promise((resolveResult, reject) => {
    const req = request(url, {method: 'POST', headers: {'x-cqai-track': '1', ...headers}}, res => {
      const parts: Buffer[] = []
      res.on('data', chunk => parts.push(Buffer.from(chunk)))
      res.on('end', () => resolveResult({status: res.statusCode!, body: Buffer.concat(parts).toString('utf8')}))
      res.on('error', reject)
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

describe('placemark photo HTTP routes', () => {
  it('round-trips original bytes with safe binary headers, deduplicates and ignores upload filenames', async () => withServer(async (base, id, dir) => {
    const track = readFileSync(join(dir, 'track.json')), source = readFileSync(join(dir, 'source.gpx'))
    const response = await upload(base, id, PNG, {'content-type': 'image/png', 'content-disposition': 'attachment; filename="../../outside.png"'})
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store')
    const result = await response.json() as {url: string}, filename = localPlacemarkPhoto(result.url)!.filename
    const saved = await fetch(base + result.url)
    expect(saved.status).toBe(200); expect(saved.headers.get('content-type')).toBe('image/png')
    expect(saved.headers.get('content-length')).toBe(String(PNG.length)); expect(saved.headers.get('x-content-type-options')).toBe('nosniff')
    expect(saved.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(await saved.arrayBuffer())).toEqual(PNG)
    expect(await (await upload(base, id, PNG, {'content-type': 'application/octet-stream'})).json()).toEqual(result)
    expect(await (await upload(base, id)).json()).toEqual(result)
    expect(readdirSync(join(dir, 'placemark-photos'))).toEqual([filename])
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readFileSync(join(dir, 'source.gpx'))).toEqual(source)
    const removed = await fetch(`${base}${API}/track?id=${id}`, {method: 'DELETE', headers: {'x-cqai-track': '1'}})
    expect(removed.status).toBe(200); expect(existsSync(dir)).toBe(false); expect((await fetch(base + result.url)).status).toBe(404)
  }), 30000)
  it('uses the existing local application gate for uploads and photo reads', async () => withServer(async (base, id, dir) => {
    const address = `${base}${API}/placemark-photos?id=${id}`
    const blockedHeaders: Record<string, string>[] = [{}, {'x-cqai-track': '1', origin: 'https://evil.example'}, {'x-cqai-track': '1', 'sec-fetch-site': 'cross-site'}]
    for (const headers of blockedHeaders) {
      expect((await fetch(address, {method: 'POST', headers, body: PNG})).status).toBe(403)
    }
    expect(existsSync(join(dir, 'placemark-photos'))).toBe(false)
    const {url} = await (await upload(base, id, PNG, {origin: base})).json() as {url: string}
    expect((await fetch(base + url, {headers: {origin: 'https://evil.example'}})).status).toBe(403)
    expect((await fetch(base + url, {headers: {'sec-fetch-site': 'cross-site'}})).status).toBe(403)
    expect((await fetch(base + url, {headers: {origin: base}})).status).toBe(200)
  }), 30000)
  it('rejects empty, unsupported and mismatched images and bounds declared and chunked request bytes', async () => withServer(async (base, id, dir) => {
    expect((await upload(base, id, Buffer.alloc(0))).status).toBe(400)
    for (const [body, mime] of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'], [Buffer.from('not an image'), 'application/octet-stream'], [PNG, 'image/jpeg']] as const) {
      const response = await upload(base, id, body, {'content-type': mime})
      expect(response.status).toBe(415); expect(await response.json()).toHaveProperty('error')
    }
    const address = `${base}${API}/placemark-photos?id=${id}`
    const declared = await rawUpload(address, {'content-length': String(PLACEMARK_PHOTO_MAX_BYTES + 1)}, [])
    expect(declared.status).toBe(413); expect(JSON.parse(declared.body).error).toContain('20 MiB')
    const streamed = await rawUpload(address, {'transfer-encoding': 'chunked'}, [Buffer.alloc(PLACEMARK_PHOTO_MAX_BYTES), Buffer.from([1])])
    expect(streamed.status).toBe(413); expect(JSON.parse(streamed.body).error).toContain('20 MiB')
    expect(existsSync(join(dir, 'placemark-photos'))).toBe(false)
  }), 30000)
  it('rejects traversal and missing resources without reading unrelated files or creating tracks', async () => withServer(async (base, id, dir) => {
    const filename = '0'.repeat(64) + '.png'
    expect((await fetch(`${base}${API}/placemark-photo?id=${id}&photo=${filename}`)).status).toBe(404)
    for (const photo of ['', '../track.json', '..\\source.gpx', 'C:\\outside.png', 'a'.repeat(64) + '.svg']) {
      expect((await fetch(`${base}${API}/placemark-photo?id=${id}&photo=${encodeURIComponent(photo)}`)).status).toBe(400)
    }
    for (const trackId of ['missing', '../outside', 'C:\\outside']) {
      expect((await upload(base, trackId)).status).toBe(404)
      expect((await fetch(`${base}${API}/placemark-photo?id=${encodeURIComponent(trackId)}&photo=${filename}`)).status).toBe(404)
    }
    expect(readdirSync(dir).sort()).toEqual(['source.gpx', 'track.json'])
  }), 30000)
})
