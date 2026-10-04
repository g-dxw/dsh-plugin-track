import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import * as plugin from '../src/index.ts'
import { trackDir, writeTrack } from '../src/artifacts.ts'
import { ensurePlacemarkPhotoAsset } from '../src/placemark-photo-assets-store.ts'
import { API, type TrackInput } from '../src/protocol.ts'
import { placemarkPhotoAssetUrl } from '../src/track/placemark-photo-assets.ts'

const {download} = vi.hoisted(() => ({download: vi.fn()}))
vi.mock('../src/remote-placemark-photo.ts', () => ({downloadRemotePlacemarkPhoto: download}))
const roots: string[] = []
const source = 'https://photos.example/image.png'
const input: TrackInput = {filename: 'original.gpx', source: '<gpx>original bytes</gpx>',
  points: [[120, 30, 100, null], [120.01, 30, 110, null]],
  metrics: {distance: 1000, elevationGain: 10, elevationLoss: 0, duration: 0, elevationMax: 110, elevationMin: 100, bbox: [120, 30, 120.01, 30]}}
const point = {id: 'kml-1', name: '照片', description: '', coordinates: [120, 30] as [number, number], images: [source]}
beforeEach(() => {download.mockReset()})
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-photo-assets-routes-')) throw new Error('Unexpected asset route fixture')
    rmSync(root, {recursive: true, force: true})
  }
})
async function withServer(run: (base: string, id: string, dir: string, bytes: Buffer) => Promise<void>, photos = false) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-photo-assets-routes-')); roots.push(home)
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home
  const ctx = new Context()
  try {
    const bytes = await sharp({create: {width: 2048, height: 1536, channels: 3, background: '#2398dc'}}).png().toBuffer()
    download.mockResolvedValue({body: bytes, mime: 'image/png'})
    const {id} = writeTrack({...input, placemarks: photos ? [point] : []}), dir = trackDir(id)
    await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0}); await ctx.plugin(plugin)
    await run('http://127.0.0.1:' + ctx.webServer.port, id, dir, bytes)
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  }
}
function queue(base: string, id: string, sources?: unknown, headers: Record<string, string> = {'x-cqai-track': '1'}) {
  return fetch(base + API + '/placemark-photo-cache?id=' + encodeURIComponent(id), {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(sources === undefined ? {} : {sources})})
}
const asset = (base: string, id: string, size: 'thumbnail' | 'original', url = source) => base + placemarkPhotoAssetUrl(id, url, size)

describe('placemark photo asset HTTP routes', () => {
  it('queues legacy references and serves cached JPEG thumbnails and exact originals with binary headers', async () => withServer(async (base, id, dir, bytes) => {
    const before = ['track.json', 'source.gpx'].map(name => readFileSync(join(dir, name)))
    const queued = await queue(base, id, [source, source])
    expect(queued.status).toBe(202); expect(await queued.json()).toEqual({queued: 1})
    const thumbnail = await fetch(asset(base, id, 'thumbnail'))
    expect(thumbnail.status).toBe(200)
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg')
    expect(thumbnail.headers.get('x-content-type-options')).toBe('nosniff')
    expect(thumbnail.headers.get('cache-control')).toContain('private')
    const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer())
    expect(thumbnail.headers.get('content-length')).toBe(String(thumbnailBytes.length))
    expect(await sharp(thumbnailBytes).metadata()).toMatchObject({format: 'jpeg', width: 1024, height: 768})
    const original = await fetch(asset(base, id, 'original'))
    expect(original.status).toBe(200); expect(original.headers.get('content-type')).toBe('image/png')
    expect(original.headers.get('content-length')).toBe(String(bytes.length))
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes)
    const listed = await fetch(base + API + '/placemark-photo-cache?id=' + id)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({assets: [{source, status: 'ready', width: 1024, height: 768}]})
    expect(Buffer.from(await (await fetch(asset(base, id, 'thumbnail'))).arrayBuffer())).toEqual(thumbnailBytes)
    expect(download).toHaveBeenCalledTimes(1)
    ;['track.json', 'source.gpx'].forEach((name, index) => expect(readFileSync(join(dir, name))).toEqual(before[index]))
  }), 30000)

  it('enforces the existing same-origin read and custom-header write gates before creating cache files', async () => withServer(async (base, id, dir) => {
    const blockedWrites: Record<string, string>[] = [{}, {'x-cqai-track': '1', origin: 'https://evil.example'}, {'x-cqai-track': '1', 'sec-fetch-site': 'cross-site'}]
    for (const headers of blockedWrites) {
      expect((await queue(base, id, [source], headers)).status).toBe(403)
    }
    const blockedReads: Record<string, string>[] = [{origin: 'https://evil.example'}, {'sec-fetch-site': 'cross-site'}]
    for (const headers of blockedReads) {
      expect((await fetch(asset(base, id, 'thumbnail'), {headers})).status).toBe(403)
      expect((await fetch(base + API + '/placemark-photo-cache?id=' + id, {headers})).status).toBe(403)
    }
    expect(existsSync(join(dir, 'placemark-photo-assets'))).toBe(false)
    expect(download).not.toHaveBeenCalled()
    expect((await queue(base, id, [source], {'x-cqai-track': '1', origin: base})).status).toBe(202)
    expect((await fetch(asset(base, id, 'thumbnail'), {headers: {origin: base}})).status).toBe(200)
  }), 30000)

  it('rejects invalid sizes, ambiguous queries, unrelated sources and invalid queue selections', async () => withServer(async (base, id, dir) => {
    const valid = asset(base, id, 'thumbnail')
    for (const url of [valid.replace('size=thumbnail', 'size=small'), valid.replace('&size=thumbnail', ''), valid + '&size=original', valid + '&source=' + encodeURIComponent(source), valid + '&id=' + id, valid + '&extra=1']) {
      expect((await fetch(url)).status).toBe(400)
    }
    expect((await fetch(asset(base, id, 'original'))).status).toBe(404)
    expect((await fetch(asset(base, 'missing', 'original'))).status).toBe(404)
    for (const sources of ['invalid', [source, 7], [source, 'file:///outside.png']]) expect((await queue(base, id, sources)).status).toBe(400)
    expect((await queue(base, 'missing', [source])).status).toBe(404)
    expect(existsSync(join(dir, 'placemark-photo-assets'))).toBe(false)
    expect(download).not.toHaveBeenCalled()
  }), 30000)

  it('keeps the upload response and original endpoint compatible while automatically preparing local thumbnails', async () => withServer(async (base, id, _dir, bytes) => {
    const uploaded = await fetch(base + API + '/placemark-photos?id=' + id, {method: 'POST', headers: {'x-cqai-track': '1', 'content-type': 'image/png'}, body: new Uint8Array(bytes)})
    expect(uploaded.status).toBe(201)
    const result = await uploaded.json() as {url: string}
    expect(Object.keys(result)).toEqual(['url'])
    expect(Buffer.from(await (await fetch(base + result.url)).arrayBuffer())).toEqual(bytes)
    const thumbnail = await fetch(asset(base, id, 'thumbnail', result.url))
    expect(thumbnail.status).toBe(200)
    expect(await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).toMatchObject({width: 1024, height: 768, format: 'jpeg'})
    expect(Buffer.from(await (await fetch(asset(base, id, 'original', result.url))).arrayBuffer())).toEqual(bytes)
    expect(download).not.toHaveBeenCalled()
  }), 30000)

  it('responds to open and import while their automatically started downloads remain pending', async () => withServer(async (base, id, _dir, bytes) => {
    let finish!: (value: {body: Buffer}) => void
    const pending = new Promise<{body: Buffer}>(resolveResult => {finish = resolveResult})
    download.mockReturnValue(pending)
    const jobs: Array<ReturnType<typeof ensurePlacemarkPhotoAsset>> = []
    let importedId = ''
    try {
      expect(download).not.toHaveBeenCalled()
      const opened = await fetch(base + API + '/track?id=' + id, {signal: AbortSignal.timeout(3000)})
      expect(opened.status).toBe(200)
      jobs.push(ensurePlacemarkPhotoAsset(id, source))
      expect(download).toHaveBeenCalledTimes(1)
      const imported = await fetch(base + API + '/tracks', {method: 'POST', headers: {'x-cqai-track': '1', 'content-type': 'application/json'}, body: JSON.stringify({...input, placemarks: [point]}), signal: AbortSignal.timeout(3000)})
      expect(imported.status).toBe(201)
      const created = await imported.json() as {id: string}
      importedId = created.id
      jobs.push(ensurePlacemarkPhotoAsset(created.id, source))
      expect(download).toHaveBeenCalledTimes(2)
    } finally {
      finish({body: bytes})
      await Promise.allSettled(jobs)
    }
    expect((await fetch(asset(base, importedId, 'thumbnail'))).status).toBe(200)
  }, true), 30000)
})
