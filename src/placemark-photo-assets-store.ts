import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { readSource, readTrack, trackDir } from './artifacts.ts'
import { readAnnotations } from './annotations-store.ts'
import { readPlacemarkState } from './placemark-state-store.ts'
import { PlacemarkPhotoError, readPlacemarkPhoto, writePlacemarkPhoto, placemarkPhotoTrackExists, type StoredPlacemarkPhoto } from './placemark-photos-store.ts'
import { downloadRemotePlacemarkPhoto } from './remote-placemark-photo.ts'
import { imageLink } from './track/placemarks.ts'
import { localPlacemarkPhoto, PLACEMARK_PHOTO_FILE, PLACEMARK_PHOTO_MAX_BYTES } from './track/placemark-photos.ts'
import { PLACEMARK_THUMBNAIL_MAX_SIZE, PLACEMARK_THUMBNAIL_QUALITY, placemarkPhotoAssetUrl, type PlacemarkPhotoSize } from './track/placemark-photo-assets.ts'

const THUMBNAIL_VERSION = 1
const RECORD_DIRECTORY = 'placemark-photo-assets'
const THUMBNAIL_DIRECTORY = 'placemark-thumbnails'
const THUMBNAIL_FILE = /^[a-f0-9]{64}\.jpg$/u
const jobs = new Map<string, Promise<PlacemarkPhotoAsset>>()
let activeJobs = 0
const waiters: Array<() => void> = []

export interface PlacemarkPhotoAsset {
  version: 1
  source: string
  status: 'pending' | 'ready' | 'error'
  originalFilename?: string
  thumbnailFilename?: string
  thumbnailVersion?: number
  originalWidth?: number
  originalHeight?: number
  width?: number
  height?: number
  error?: string
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function sourceKey(id: string, source: string, env: NodeJS.ProcessEnv): string {
  return join(trackDir(id, env), RECORD_DIRECTORY, digest(source) + '.json')
}
function requiredSource(id: string, source: string, env: NodeJS.ProcessEnv): string {
  if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
  try {placemarkPhotoAssetUrl(id, source, 'thumbnail')} catch {throw new PlacemarkPhotoError('图片资源地址无效')}
  return imageLink(source)!
}
function readRecord(id: string, source: string, env: NodeJS.ProcessEnv): PlacemarkPhotoAsset | null {
  try {
    const path = sourceKey(id, source, env), stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 16384) return null
    const item = JSON.parse(readFileSync(path, 'utf8')) as PlacemarkPhotoAsset
    if (item.version !== 1 || item.source !== source || !['pending', 'ready', 'error'].includes(item.status)
      || (item.originalFilename !== undefined && !PLACEMARK_PHOTO_FILE.test(item.originalFilename))
      || (item.thumbnailFilename !== undefined && !THUMBNAIL_FILE.test(item.thumbnailFilename))) return null
    return item
  } catch {return null}
}
function atomicWrite(id: string, folder: string, filename: string, body: string | Buffer, env: NodeJS.ProcessEnv): void {
  if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
  const directory = join(trackDir(id, env), folder)
  mkdirSync(directory, {recursive: true})
  const temporary = join(directory, `.asset-${randomUUID()}.tmp`)
  try {writeFileSync(temporary, body, {flag: 'wx'}); renameSync(temporary, join(directory, filename))}
  catch (error) {try {unlinkSync(temporary)} catch {} throw error}
}
function saveRecord(id: string, record: PlacemarkPhotoAsset, env: NodeJS.ProcessEnv): void {
  atomicWrite(id, RECORD_DIRECTORY, digest(record.source) + '.json', JSON.stringify(record), env)
}
function readThumbnail(id: string, filename: string | undefined, env: NodeJS.ProcessEnv): StoredPlacemarkPhoto | null {
  if (!filename || !THUMBNAIL_FILE.test(filename)) return null
  try {
    const path = join(trackDir(id, env), THUMBNAIL_DIRECTORY, filename), stat = lstatSync(path)
    if (!stat.isFile() || !stat.size || stat.size > PLACEMARK_PHOTO_MAX_BYTES) return null
    const body = readFileSync(path)
    if (body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff || digest(body) !== filename.slice(0, 64)) return null
    return {body, filename, mime: 'image/jpeg'}
  } catch {return null}
}

/** Remote references and state identities remain unchanged; assets are a sidecar. */
export function trackPhotoSources(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const track = readTrack(id, env)
  if (!track) throw new PlacemarkPhotoError('轨迹不存在', 404)
  const values = (track.placemarks || []).flatMap(point => point.images)
  try {
    const state = readPlacemarkState(id, env)
    for (const point of state.added) values.push(...point.images)
    for (const edit of state.edits) if (edit.images) values.push(...edit.images)
  } catch { /* A broken editing sidecar does not break original image downloads. */ }
  try {
    for (const annotation of readAnnotations(id, env)) {
      values.push(...(annotation.imageUrls || []))
      if (annotation.photo?.sourceUrl) values.push(annotation.photo.sourceUrl)
    }
  } catch { /* Independent art state can be repaired without affecting originals. */ }
  return [...new Set(values.map(imageLink).filter((url): url is string => !!url))]
}
function authorizedSource(id: string, source: string, env: NodeJS.ProcessEnv): boolean {
  if (readRecord(id, source, env) || trackPhotoSources(id, env).includes(source)) return true
  // Older tracks may retain point photos only in their KML. This bounded source
  // match permits first paint while the browser registers recovered references.
  const original = readSource(id, env)
  if (original?.ext !== 'kml') return false
  const text = original.body.toString('utf8').replace(/&amp;/gu, '&')
  if (text.includes(source)) return true
  try {return text.includes(decodeURI(source))} catch {return false}
}

async function processAsset(id: string, source: string, env: NodeJS.ProcessEnv): Promise<PlacemarkPhotoAsset> {
  if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
  let record = readRecord(id, source, env) || {version: 1 as const, source, status: 'pending' as const}
  let original = record.originalFilename ? readPlacemarkPhoto(id, record.originalFilename, env) : null
  if (original && record.status === 'ready' && record.thumbnailVersion === THUMBNAIL_VERSION && readThumbnail(id, record.thumbnailFilename, env)) return record
  try {
    if (!original) {
      const local = localPlacemarkPhoto(source)
      const bytes = local ? readPlacemarkPhoto(local.trackId, local.filename, env)?.body
        : (await downloadRemotePlacemarkPhoto(source)).body
      if (!bytes) throw new PlacemarkPhotoError('原图不存在', 404)
      const saved = writePlacemarkPhoto(id, bytes, undefined, env)
      const filename = localPlacemarkPhoto(saved.url)!.filename
      original = readPlacemarkPhoto(id, filename, env)
      if (!original) throw new PlacemarkPhotoError('原图缓存无法读取', 500)
      record = {version: 1, source, status: 'pending', originalFilename: filename}
      saveRecord(id, record, env)
    }
    const pipeline = sharp(original.body, {limitInputPixels: 40_000_000, failOn: 'error', pages: 1})
    const metadata = await pipeline.metadata()
    const {data, info} = await pipeline.rotate()
      .resize({width: PLACEMARK_THUMBNAIL_MAX_SIZE, height: PLACEMARK_THUMBNAIL_MAX_SIZE, fit: 'inside', withoutEnlargement: true})
      .flatten({background: '#ffffff'}).jpeg({quality: PLACEMARK_THUMBNAIL_QUALITY}).toBuffer({resolveWithObject: true})
    const thumbnailFilename = digest(data) + '.jpg'
    if (!readThumbnail(id, thumbnailFilename, env)) atomicWrite(id, THUMBNAIL_DIRECTORY, thumbnailFilename, data, env)
    record = {version: 1, source, status: 'ready', originalFilename: original.filename,
      thumbnailFilename, thumbnailVersion: THUMBNAIL_VERSION, originalWidth: metadata.width,
      originalHeight: metadata.height, width: info.width, height: info.height}
    saveRecord(id, record, env)
    return record
  } catch (error) {
    const message = error instanceof PlacemarkPhotoError ? error.message : '图片无法处理，请重试或更换图片'
    if (placemarkPhotoTrackExists(id, env)) saveRecord(id, {...record, status: 'error', error: message}, env)
    throw error instanceof PlacemarkPhotoError ? error : new PlacemarkPhotoError(message, 422)
  }
}
async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (activeJobs >= 3) await new Promise<void>(resolve => waiters.push(resolve))
  else activeJobs++
  try {return await run()}
  finally {const next = waiters.shift(); if (next) next(); else activeJobs--}
}
export function ensurePlacemarkPhotoAsset(id: string, value: string, env: NodeJS.ProcessEnv = process.env): Promise<PlacemarkPhotoAsset> {
  env = {...env}
  const source = requiredSource(id, value, env)
  if (!authorizedSource(id, source, env)) throw new PlacemarkPhotoError('图片未关联到此轨迹', 404)
  const key = sourceKey(id, source, env), existing = jobs.get(key)
  if (existing) return existing
  const job = limited(() => processAsset(id, source, env))
  jobs.set(key, job)
  void job.finally(() => {if (jobs.get(key) === job) jobs.delete(key)}).catch(() => {})
  return job
}

/** Register recovered legacy KML URLs before rendering; downloads run independently. */
export function queuePlacemarkPhotos(id: string, sources: unknown = undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
  if (sources !== undefined && (!Array.isArray(sources) || sources.length > 5000 || sources.some(source => typeof source !== 'string'))) {
    throw new PlacemarkPhotoError('图片资源列表无效，一次最多 5000 张')
  }
  const values = sources === undefined ? trackPhotoSources(id, env) : sources as string[]
  // Validate the whole selection before registering any source.
  const normalized = [...new Set(values.map(source => requiredSource(id, source, env)))]
  for (const source of normalized) {
    const record = readRecord(id, source, env)
    if (!record) saveRecord(id, {version: 1, source, status: 'pending'}, env)
    if (record?.status === 'ready' && record.thumbnailVersion === THUMBNAIL_VERSION && record.originalFilename && record.thumbnailFilename) {
      try {
        // Warm-up checks file presence; on-demand serving verifies byte hashes.
        if (lstatSync(join(trackDir(id, env), 'placemark-photos', record.originalFilename)).isFile()
          && lstatSync(join(trackDir(id, env), THUMBNAIL_DIRECTORY, record.thumbnailFilename)).isFile()) continue
      } catch { /* Missing resources are rebuilt. */ }
    }
    void ensurePlacemarkPhotoAsset(id, source, env).catch(() => {})
  }
  return normalized.length
}
const warmups = new Map<string, Promise<number>>()
/** Yield between small batches so imports and image responses remain responsive. */
export function preparePlacemarkPhotos(id: string, sources?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  env = {...env}
  if (!placemarkPhotoTrackExists(id, env)) return Promise.reject(new PlacemarkPhotoError('轨迹不存在', 404))
  const key = join(trackDir(id, env), RECORD_DIRECTORY)
  const running = sources === undefined ? warmups.get(key) : null
  if (running) return running
  const operation = (async () => {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
    if (sources !== undefined && (!Array.isArray(sources) || sources.length > 5000 || sources.some(source => typeof source !== 'string'))) {
      throw new PlacemarkPhotoError('图片资源列表无效，一次最多 5000 张')
    }
    const values = sources === undefined ? trackPhotoSources(id, env) : sources as string[]
    const normalized = [...new Set(values.map(source => requiredSource(id, source, env)))]
    for (let start = 0; start < normalized.length; start += 32) {
      queuePlacemarkPhotos(id, normalized.slice(start, start + 32), env)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return normalized.length
  })()
  if (sources === undefined) {
    warmups.set(key, operation)
    void operation.finally(() => {if (warmups.get(key) === operation) warmups.delete(key)}).catch(() => {})
  }
  return operation
}
export function listPlacemarkPhotoAssets(id: string, env: NodeJS.ProcessEnv = process.env): PlacemarkPhotoAsset[] {
  if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
  const directory = join(trackDir(id, env), RECORD_DIRECTORY)
  if (!existsSync(directory)) return []
  const result: PlacemarkPhotoAsset[] = []
  for (const filename of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(filename)) continue
    try {
      const path = join(directory, filename), stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 16384) continue
      const source = JSON.parse(readFileSync(path, 'utf8')).source
      if (typeof source !== 'string' || filename !== digest(source) + '.json') continue
      const record = readRecord(id, source, env)
      if (record) result.push(record)
    } catch { /* Partial or corrupt cache never makes the track unreadable. */ }
  }
  return result
}
export async function readPlacemarkPhotoAsset(id: string, value: string, size: PlacemarkPhotoSize, env: NodeJS.ProcessEnv = process.env): Promise<StoredPlacemarkPhoto> {
  if (size !== 'thumbnail' && size !== 'original') throw new PlacemarkPhotoError('图片尺寸类型无效')
  const source = requiredSource(id, value, env)
  if (!authorizedSource(id, source, env)) throw new PlacemarkPhotoError('图片未关联到此轨迹', 404)
  const cached = readRecord(id, source, env)
  if (size === 'original' && cached?.originalFilename) {
    const original = readPlacemarkPhoto(id, cached.originalFilename, env)
    if (original) return original
  }
  let record: PlacemarkPhotoAsset
  try {record = await ensurePlacemarkPhotoAsset(id, source, env)}
  catch (error) {
    const failed = readRecord(id, source, env)
    const original = size === 'original' && failed?.originalFilename ? readPlacemarkPhoto(id, failed.originalFilename, env) : null
    if (original) return original
    throw error
  }
  const photo = size === 'thumbnail' ? readThumbnail(id, record.thumbnailFilename, env)
    : record.originalFilename ? readPlacemarkPhoto(id, record.originalFilename, env) : null
  if (!photo || !placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('图片缓存不存在', 404)
  return photo
}
