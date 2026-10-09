import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import { readPlacemarkState } from './placemark-state-store.ts'
import { localPlacemarkPhoto } from './track/placemark-photos.ts'
import { validateVideoMaterials, type VideoMaterialsDocument } from './track/video-materials.ts'

export const VIDEO_MATERIALS_ENVELOPE_SCHEMA = 'cqai-track-video-materials-envelope@1' as const
export const VIDEO_MATERIALS_MAX_BYTES = 16 * 1024 * 1024
export interface VideoMaterialsEnvelope {
  schema: typeof VIDEO_MATERIALS_ENVELOPE_SCHEMA
  trackId: string
  document: VideoMaterialsDocument
  revision: string
  updatedAt: string
}
export class VideoMaterialsError extends Error {
  constructor(message: string, readonly status = 400) {super(message)}
}
export class VideoMaterialsConflictError extends VideoMaterialsError {
  constructor() {super('视频素材准备已被其他操作更新，请重新读取后重试', 409)}
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !!value.trim()
}
/** Reject data that JSON would silently discard or turn into a different saved value. */
function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 100) throw new VideoMaterialsError('视频素材准备层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!Array.isArray(value) && !record(value)) throw new VideoMaterialsError('视频素材准备包含不可保存的数据')
  if (ancestors.has(value)) throw new VideoMaterialsError('视频素材准备包含循环引用')
  ancestors.add(value)
  for (const item of Object.values(value)) jsonValue(item, depth + 1, ancestors)
  ancestors.delete(value)
}
function requiredTrack(id: string, env: NodeJS.ProcessEnv) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) throw new VideoMaterialsError('轨迹编号无效')
  const track = readTrack(id, env)
  if (!track) throw new VideoMaterialsError('轨迹不存在', 404)
  return track
}
function documentForTrack(id: string, value: unknown, env: NodeJS.ProcessEnv): VideoMaterialsDocument {
  const track = requiredTrack(id, env)
  jsonValue(value)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > VIDEO_MATERIALS_MAX_BYTES) throw new VideoMaterialsError('视频素材准备最多 16 MiB', 413)
  let document: VideoMaterialsDocument
  try {document = validateVideoMaterials(JSON.parse(serialized))}
  catch (error) {throw new VideoMaterialsError(error instanceof Error ? error.message : '视频素材准备格式无效')}
  if (document.trackId !== id || document.sourcePointCount !== track.coordinates.length) throw new VideoMaterialsError('视频素材准备与原轨迹编号或点数不一致')
  // A materials plan can split a connected part, but must retain original gaps.
  const originalStarts = track.segmentStarts ?? readPlacemarkState(id, env).routeContext?.segmentStarts ?? [0]
  if (document.sourceSegmentStarts.length !== originalStarts.length || document.sourceSegmentStarts.some((start, index) => start !== originalStarts[index])) throw new VideoMaterialsError('视频素材准备与原轨迹分段不一致')
  for (const marker of document.markers) {
    const urls = [...marker.photoCandidates, ...(marker.photo?.sourceUrl ? [marker.photo.sourceUrl] : [])]
    for (const url of urls) {
      const local = localPlacemarkPhoto(url)
      if (local && local.trackId !== id) throw new VideoMaterialsError('视频素材图片必须属于当前轨迹')
    }
  }
  return document
}
function readEnvelope(id: string, env: NodeJS.ProcessEnv): VideoMaterialsEnvelope | null {
  const file = join(trackDir(id, env), 'video-materials.json')
  if (!existsSync(file)) return null
  if (statSync(file).size > VIDEO_MATERIALS_MAX_BYTES + 4096) throw new VideoMaterialsError('已保存的视频素材准备过大', 413)
  let value: unknown
  try {value = JSON.parse(readFileSync(file, 'utf8'))} catch {throw new VideoMaterialsError('已保存的视频素材准备损坏，请先恢复备份')}
  if (!record(value) || value.schema !== VIDEO_MATERIALS_ENVELOPE_SCHEMA || value.trackId !== id || !revision(value.revision) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new VideoMaterialsError('已保存的视频素材准备版本、编号或修订号无效')
  return {schema: VIDEO_MATERIALS_ENVELOPE_SCHEMA, trackId: id, document: documentForTrack(id, value.document, env), revision: value.revision, updatedAt: value.updatedAt}
}

/** This independent sidecar never rewrites the route, SVG annotations or placemarks. */
export function readVideoMaterials(id: string, env: NodeJS.ProcessEnv = process.env): VideoMaterialsEnvelope | null {
  requiredTrack(id, env)
  return readEnvelope(id, env)
}
/** Compare-and-replace retains the previous complete save if the replacement fails. */
export function writeVideoMaterials(id: string, value: unknown, expectedRevision: unknown, env: NodeJS.ProcessEnv = process.env): VideoMaterialsEnvelope {
  requiredTrack(id, env)
  const previous = readEnvelope(id, env)
  if (previous && expectedRevision === undefined) throw new VideoMaterialsConflictError()
  if (!(expectedRevision === null || revision(expectedRevision))) throw new VideoMaterialsError('缺少有效的视频素材准备修订号')
  if (expectedRevision !== (previous?.revision ?? null)) throw new VideoMaterialsConflictError()
  const saved: VideoMaterialsEnvelope = {schema: VIDEO_MATERIALS_ENVELOPE_SCHEMA, trackId: id, document: documentForTrack(id, value, env), revision: randomUUID(), updatedAt: new Date().toISOString()}
  const temporary = join(trackDir(id, env), `.video-materials-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(saved), {encoding: 'utf8', flag: 'wx'})
    renameSync(temporary, join(trackDir(id, env), 'video-materials.json'))
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
      try {unlinkSync(temporary)} catch { /* A colliding name never grants ownership of another temporary file. */ }
    }
    throw error
  }
  return saved
}
