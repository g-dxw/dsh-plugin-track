import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackDir } from './artifacts.ts'
import { PLACEMARK_PHOTO_FILE, PLACEMARK_PHOTO_MAX_BYTES, placemarkPhotoUrl } from './track/placemark-photos.ts'

export class PlacemarkPhotoError extends Error {
  constructor(message: string, readonly status = 400) {super(message)}
}

type PhotoExtension = 'jpg' | 'png' | 'webp' | 'gif' | 'avif'
const MIME: Record<PhotoExtension, string> = {jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif'}

function photoExtension(body: Buffer): PhotoExtension | null {
  if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff && body[3] !== 0 && body[3] !== 0xff) return 'jpg'
  if (body.length >= 33 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && body.readUInt32BE(8) === 13 && body.toString('latin1', 12, 16) === 'IHDR' && body.readUInt32BE(16) > 0 && body.readUInt32BE(20) > 0) return 'png'
  if (body.length >= 13 && ['GIF87a', 'GIF89a'].includes(body.toString('latin1', 0, 6)) && body.readUInt16LE(6) > 0 && body.readUInt16LE(8) > 0) return 'gif'
  if (body.length >= 20 && body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP'
    && body.readUInt32LE(4) >= 12 && body.readUInt32LE(4) <= body.length - 8
    && ['VP8 ', 'VP8L', 'VP8X'].includes(body.toString('latin1', 12, 16)) && body.readUInt32LE(16) <= body.length - 20) return 'webp'
  if (body.length >= 16 && body.toString('latin1', 4, 8) === 'ftyp') {
    const boxSize = body.readUInt32BE(0)
    if (boxSize >= 16 && boxSize <= body.length && boxSize % 4 === 0) {
      const brands = [body.toString('latin1', 8, 12)]
      for (let offset = 16; offset < boxSize; offset += 4) brands.push(body.toString('latin1', offset, offset + 4))
      if (brands.some(brand => brand === 'avif' || brand === 'avis')) return 'avif'
    }
  }
  return null
}

/** Photos only need an owned track directory; never reparse a large path per image. */
export function placemarkPhotoTrackExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) return false
  try {return lstatSync(join(trackDir(id, env), 'track.json')).isFile()} catch {return false}
}
export interface StoredPlacemarkPhoto {body: Buffer; mime: string; filename: string}

/** A strict filename plus an existing track is the entire filesystem address surface. */
export function readPlacemarkPhoto(id: string, filename: string, env: NodeJS.ProcessEnv = process.env): StoredPlacemarkPhoto | null {
  if (!PLACEMARK_PHOTO_FILE.test(filename)) throw new PlacemarkPhotoError('本地图片编号无效')
  if (!placemarkPhotoTrackExists(id, env)) return null
  try {
    const path = join(trackDir(id, env), 'placemark-photos', filename), stat = lstatSync(path)
    if (!stat.isFile() || !stat.size || stat.size > PLACEMARK_PHOTO_MAX_BYTES) return null
    const body = readFileSync(path), extension = filename.slice(filename.lastIndexOf('.') + 1) as PhotoExtension
    if (photoExtension(body) !== extension || createHash('sha256').update(body).digest('hex') !== filename.slice(0, 64)) return null
    return {body, mime: MIME[extension], filename}
  } catch {return null}
}

/** Owned assets outlive edits and undo; deleting the track removes their directory. */
export function writePlacemarkPhoto(id: string, bytes: Uint8Array, contentType?: string, env: NodeJS.ProcessEnv = process.env): {url: string} {
  if (!placemarkPhotoTrackExists(id, env)) throw new PlacemarkPhotoError('轨迹不存在', 404)
  if (!bytes.byteLength) throw new PlacemarkPhotoError('请选择非空图片')
  if (bytes.byteLength > PLACEMARK_PHOTO_MAX_BYTES) throw new PlacemarkPhotoError('图片最多 20 MiB', 413)
  const body = Buffer.from(bytes), extension = photoExtension(body)
  if (!extension) throw new PlacemarkPhotoError('只支持 JPEG、PNG、WebP、GIF 或 AVIF 图片', 415)
  const declaredType = contentType?.split(';', 1)[0].trim().toLowerCase()
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== MIME[extension]) throw new PlacemarkPhotoError('图片内容与格式声明不一致', 415)
  const filename = createHash('sha256').update(body).digest('hex') + '.' + extension
  const url = placemarkPhotoUrl(id, filename), directory = join(trackDir(id, env), 'placemark-photos'), path = join(directory, filename)
  if (existsSync(path)) {
    if (!readPlacemarkPhoto(id, filename, env)?.body.equals(body)) throw new PlacemarkPhotoError('已存图片内容无效', 409)
    return {url}
  }
  mkdirSync(directory, {recursive: true})
  const temporary = join(directory, `.photo-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, body, {flag: 'wx'})
    renameSync(temporary, path)
  } catch (error) {
    try {unlinkSync(temporary)} catch { /* only this call's temporary file */ }
    throw error
  }
  return {url}
}
