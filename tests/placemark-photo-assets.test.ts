import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import { removeTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { writeAnnotations } from '../src/annotations-store.ts'
import { readPlacemarkState, writePlacemarkState } from '../src/placemark-state-store.ts'
import { PlacemarkPhotoError, writePlacemarkPhoto } from '../src/placemark-photos-store.ts'
import { ensurePlacemarkPhotoAsset, listPlacemarkPhotoAssets, preparePlacemarkPhotos, queuePlacemarkPhotos, readPlacemarkPhotoAsset, trackPhotoSources } from '../src/placemark-photo-assets-store.ts'
import type { TrackInput } from '../src/protocol.ts'

const {download} = vi.hoisted(() => ({download: vi.fn()}))
vi.mock('../src/remote-placemark-photo.ts', () => ({downloadRemotePlacemarkPhoto: download}))
const roots: string[] = []
const source = 'https://photos.example/large.png'
const input: TrackInput = {filename: 'original.kml', source: '<kml>original source bytes</kml>',
  points: [[120, 30, 100, null], [120.01, 30, 110, null]],
  placemarks: [{id: 'kml-1', name: '景点', description: '原描述', coordinates: [120, 30], images: [source]}],
  metrics: {distance: 1000, elevationGain: 10, elevationLoss: 0, duration: 0, elevationMax: 110, elevationMin: 100, bbox: [120, 30, 120.01, 30]}}
function fixture(images = [source]) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-photo-assets-')); roots.push(home)
  const env = {DSH_HOME: home}, {id} = writeTrack({...input, placemarks: [{...input.placemarks![0], images}]}, env)
  return {id, env, dir: trackDir(id, env)}
}
const image = (width = 2048, height = 1536) => sharp({create: {width, height, channels: 4, background: '#31a6dd80'}}).png().toBuffer()
beforeEach(() => {download.mockReset()})
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-photo-assets-')) throw new Error('Unexpected asset fixture')
    rmSync(root, {recursive: true, force: true})
  }
})

describe('placemark original and thumbnail assets', () => {
  it('stores exact original bytes and creates a bounded JPEG reused after a fresh module read', async () => {
    const {id, env, dir} = fixture(), bytes = await image()
    download.mockResolvedValue({body: bytes, mime: 'image/png'})
    const record = await ensurePlacemarkPhotoAsset(id, source, env)
    expect(record).toMatchObject({status: 'ready', originalWidth: 2048, originalHeight: 1536, width: 1024, height: 768})
    const thumbnail = await readPlacemarkPhotoAsset(id, source, 'thumbnail', env)
    expect(thumbnail.mime).toBe('image/jpeg')
    expect(await sharp(thumbnail.body).metadata()).toMatchObject({format: 'jpeg', width: 1024, height: 768})
    expect((await readPlacemarkPhotoAsset(id, source, 'original', env)).body).toEqual(bytes)
    expect(readFileSync(join(dir, 'placemark-photos', record.originalFilename!))).toEqual(bytes)
    vi.resetModules()
    const reloaded = await import('../src/placemark-photo-assets-store.ts')
    expect((await reloaded.readPlacemarkPhotoAsset(id, source, 'thumbnail', env)).body).toEqual(thumbnail.body)
    expect(reloaded.listPlacemarkPhotoAssets(id, env)).toEqual([record])
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('does not enlarge small photos and applies EXIF orientation only to the thumbnail', async () => {
    const small = 'https://photos.example/small.png', rotated = 'https://photos.example/rotated.jpg'
    const {id, env} = fixture([small, rotated]), smallBytes = await image(80, 60)
    const orientedBytes = await sharp({create: {width: 1600, height: 800, channels: 3, background: '#d64b30'}}).jpeg().withMetadata({orientation: 6}).toBuffer()
    download.mockImplementation(async (url: string) => ({body: url === small ? smallBytes : orientedBytes}))
    expect(await ensurePlacemarkPhotoAsset(id, small, env)).toMatchObject({width: 80, height: 60})
    expect(await ensurePlacemarkPhotoAsset(id, rotated, env)).toMatchObject({originalWidth: 1600, originalHeight: 800, width: 512, height: 1024})
    const thumbnail = await readPlacemarkPhotoAsset(id, rotated, 'thumbnail', env)
    expect(await sharp(thumbnail.body).metadata()).toMatchObject({width: 512, height: 1024})
    expect((await readPlacemarkPhotoAsset(id, rotated, 'original', env)).body).toEqual(orientedBytes)
  })

  it('deduplicates selection and single-flights concurrent original and thumbnail reads', async () => {
    const {id, env, dir} = fixture(), bytes = await image(300, 200)
    let finish!: (value: {body: Buffer}) => void
    download.mockImplementation(() => new Promise(resolveResult => {finish = resolveResult}))
    expect(queuePlacemarkPhotos(id, [source, source], env)).toBe(1)
    const job = ensurePlacemarkPhotoAsset(id, source, env)
    expect(ensurePlacemarkPhotoAsset(id, source, env)).toBe(job)
    const original = readPlacemarkPhotoAsset(id, source, 'original', env)
    const thumbnail = readPlacemarkPhotoAsset(id, source, 'thumbnail', env)
    finish({body: bytes})
    await job
    expect((await original).body).toEqual(bytes)
    expect((await thumbnail).mime).toBe('image/jpeg')
    expect(download).toHaveBeenCalledTimes(1)
    expect(readdirSync(join(dir, 'placemark-photos'))).toHaveLength(1)
    expect(readdirSync(join(dir, 'placemark-thumbnails'))).toHaveLength(1)
  })

  it('repairs a corrupted thumbnail from the cached original without downloading again', async () => {
    const {id, env, dir} = fixture(), bytes = await image(1200, 900)
    download.mockResolvedValue({body: bytes})
    const record = await ensurePlacemarkPhotoAsset(id, source, env)
    const expected = (await readPlacemarkPhotoAsset(id, source, 'thumbnail', env)).body
    writeFileSync(join(dir, 'placemark-thumbnails', record.thumbnailFilename!), Buffer.from([0xff, 0xd8, 0xff, 0]))
    expect((await readPlacemarkPhotoAsset(id, source, 'thumbnail', env)).body).toEqual(expected)
    expect((await readPlacemarkPhotoAsset(id, source, 'original', env)).body).toEqual(bytes)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('isolates a failed photo and allows a later retry while keeping successful originals readable', async () => {
    const bad = 'https://photos.example/retry.png', {id, env} = fixture([source, bad]), bytes = await image(64, 48)
    download.mockImplementation(async (url: string) => {
      if (url === bad) throw new PlacemarkPhotoError('下载失败', 502)
      return {body: bytes}
    })
    expect(queuePlacemarkPhotos(id, undefined, env)).toBe(2)
    const results = await Promise.allSettled([ensurePlacemarkPhotoAsset(id, source, env), ensurePlacemarkPhotoAsset(id, bad, env)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(listPlacemarkPhotoAssets(id, env).find(record => record.source === bad)).toMatchObject({status: 'error', error: '下载失败'})
    expect((await readPlacemarkPhotoAsset(id, source, 'original', env)).body).toEqual(bytes)
    download.mockResolvedValue({body: bytes})
    expect(await ensurePlacemarkPhotoAsset(id, bad, env)).toMatchObject({status: 'ready'})
    expect(download).toHaveBeenCalledTimes(3)
  })

  it('collects imported, added, edited and annotation references while preserving every source and state file', async () => {
    const edited = 'https://photos.example/edit.png', added = 'https://photos.example/added.png'
    const art = 'https://photos.example/art.png', artSource = 'https://photos.example/art-original.png'
    const {id, env, dir} = fixture(), state = readPlacemarkState(id, env)
    writePlacemarkState(id, state.revision, {...state, routeContext: {segmentStarts: [0], references: input.placemarks},
      added: [{id: 'local-00000000-0000-0000-0000-000000000001', name: '新增', description: '', images: [added], coordinates: [120, 30], elevation: 100, time: null, timeSource: 'unknown', routePosition: {startIndex: 0, endIndex: 1, fraction: 0}}],
      edits: [{id: 'kml-1', images: [edited, source]}]}, env)
    writeAnnotations(id, [{id: 'art', pointIndex: 0, label: '照片', color: '#7c3aed', imageUrls: [art, source], photo: {dataUrl: 'data:image/png;base64,AAAA', sourceUrl: artSource}}], env)
    const names = ['track.json', 'source.kml', 'placemark-state.json', 'annotations.json']
    const before = names.map(name => readFileSync(join(dir, name)))
    expect(trackPhotoSources(id, env)).toEqual([source, added, edited, art, artSource])
    download.mockResolvedValue({body: await image(32, 24)})
    expect(queuePlacemarkPhotos(id, undefined, env)).toBe(5)
    await Promise.all(trackPhotoSources(id, env).map(url => ensurePlacemarkPhotoAsset(id, url, env)))
    names.forEach((name, index) => expect(readFileSync(join(dir, name))).toEqual(before[index]))
    expect(download).toHaveBeenCalledTimes(5)
  })

  it('registers recovered legacy URLs and local uploads without rewriting logical references', async () => {
    const {id, env, dir} = fixture([]), legacy = 'https://photos.example/legacy.png', bytes = await image(128, 96)
    const local = writePlacemarkPhoto(id, bytes, undefined, env).url
    download.mockResolvedValue({body: bytes})
    expect(() => ensurePlacemarkPhotoAsset(id, legacy, env)).toThrow('未关联')
    expect(queuePlacemarkPhotos(id, [legacy, local], env)).toBe(2)
    await Promise.all([legacy, local].map(url => ensurePlacemarkPhotoAsset(id, url, env)))
    expect((await readPlacemarkPhotoAsset(id, local, 'original', env)).body).toEqual(bytes)
    expect(listPlacemarkPhotoAssets(id, env).map(record => record.source).sort()).toEqual([legacy, local].sort())
    expect(download).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(dir, 'track.json'), 'utf8')).placemarks[0].images).toEqual([])
    expect(() => queuePlacemarkPhotos(id, [source, 'file:///outside.png'], env)).toThrow()
    expect(listPlacemarkPhotoAssets(id, env)).toHaveLength(2)
  })

  it('does not recreate a deleted track when an in-flight download finishes', async () => {
    const {id, env, dir} = fixture(), bytes = await image(20, 10)
    let finish!: (value: {body: Buffer}) => void
    download.mockImplementation(() => new Promise(resolveResult => {finish = resolveResult}))
    const job = ensurePlacemarkPhotoAsset(id, source, env)
    const rejected = expect(job).rejects.toMatchObject({status: 404})
    expect(removeTrack(id, env)).toBe(true)
    finish({body: bytes})
    await rejected
    expect(existsSync(dir)).toBe(false)
    expect(() => queuePlacemarkPhotos(id, undefined, env)).toThrow('轨迹不存在')
    await expect(readPlacemarkPhotoAsset(id, source, 'original', env)).rejects.toMatchObject({status: 404})
    expect(existsSync(dir)).toBe(false)
  })

  it('skips a queued download if the track was deleted while all worker slots were occupied', async () => {
    const sources = Array.from({length: 4}, (_, index) => 'https://photos.example/queued-' + index + '.png')
    const {id, env, dir} = fixture(sources), bytes = await image(20, 10)
    let finish!: (value: {body: Buffer}) => void
    const pending = new Promise<{body: Buffer}>(resolveResult => {finish = resolveResult})
    download.mockReturnValue(pending)
    const jobs = sources.map(url => ensurePlacemarkPhotoAsset(id, url, env))
    const settled = Promise.allSettled(jobs)
    expect(download).toHaveBeenCalledTimes(3)
    expect(removeTrack(id, env)).toBe(true)
    finish({body: bytes})
    const results = await settled
    expect(results.every(result => result.status === 'rejected' && (result.reason as PlacemarkPhotoError).status === 404)).toBe(true)
    expect(download).toHaveBeenCalledTimes(3)
    expect(existsSync(dir)).toBe(false)
  })

  it('defers and coalesces large warmups and yields between registration batches before downloads finish', async () => {
    const sources = Array.from({length: 65}, (_, index) => 'https://photos.example/batch-' + index + '.png')
    const {id, env, dir} = fixture(sources), bytes = await image(20, 10)
    let finish!: (value: {body: Buffer}) => void
    const pending = new Promise<{body: Buffer}>(resolveResult => {finish = resolveResult})
    download.mockReturnValue(pending)
    const preparation = preparePlacemarkPhotos(id, undefined, env)
    expect(preparePlacemarkPhotos(id, undefined, env)).toBe(preparation)
    expect(existsSync(join(dir, 'placemark-photo-assets'))).toBe(false)
    expect(download).not.toHaveBeenCalled()
    try {
      await new Promise<void>(resolveResult => setImmediate(resolveResult))
      expect(listPlacemarkPhotoAssets(id, env)).toHaveLength(32)
      expect(download).toHaveBeenCalledTimes(3)
      await new Promise<void>(resolveResult => setImmediate(resolveResult))
      expect(listPlacemarkPhotoAssets(id, env)).toHaveLength(64)
      expect(await preparation).toBe(65)
      expect(listPlacemarkPhotoAssets(id, env)).toHaveLength(65)
      expect(download).toHaveBeenCalledTimes(3)
    } finally {finish({body: bytes})}
    await Promise.all(sources.map(url => ensurePlacemarkPhotoAsset(id, url, env)))
    expect(download).toHaveBeenCalledTimes(65)
  })

  it('authorizes a recovered KML image URL containing escaped ampersands on its first read', async () => {
    const {id, env, dir} = fixture([]), legacy = 'https://photos.example/legacy.png?a=1&b=2', bytes = await image(20, 10)
    const original = '<kml><description>&lt;img src="https://photos.example/legacy.png?a=1&amp;b=2"&gt;</description></kml>'
    writeFileSync(join(dir, 'source.kml'), original)
    download.mockResolvedValue({body: bytes})
    expect(listPlacemarkPhotoAssets(id, env)).toEqual([])
    expect((await readPlacemarkPhotoAsset(id, legacy, 'original', env)).body).toEqual(bytes)
    expect(listPlacemarkPhotoAssets(id, env)).toMatchObject([{source: legacy, status: 'ready'}])
    expect(readFileSync(join(dir, 'source.kml'), 'utf8')).toBe(original)
    expect(download).toHaveBeenCalledExactlyOnceWith(legacy)
  })
})
