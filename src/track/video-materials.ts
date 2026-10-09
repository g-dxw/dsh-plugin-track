/** The geographic source plan for video recording; artwork pixels never become map coordinates. */
import type { PlacemarkGroup, TrackMetrics, TrackPlacemark, TrackRecord } from '../protocol.ts'
import { annotationVisible, type TrackAnnotation } from './annotations.ts'
import { groupHidden, groupPhotos, placemarkListItems } from './placemark-groups.ts'
import { imageLink } from './placemarks.ts'
import { pointMetrics } from './metrics.ts'
import { createGeoMotionProject, geoParseProject, type GeoMotionProject } from './geomotion.ts'
import { createLayer, projectWith, staticTrack, windowTrack, type DocNode, type RouteLayer } from './vendor/geomotion/document/index.ts'

export interface VideoMaterialMarker {
  id: string; name: string; description: string; coordinates: [number, number]; pointIndex: number
  selected: boolean; color: string; sourceId?: string; photoCandidates: string[]
  photo?: {dataUrl: string; sourceUrl?: string}; labelOffset?: {x: number; y: number}
}
export interface VideoMaterialSegment {id: string; name: string; startIndex: number; endIndex: number; selected: boolean; description: string; color: string}
export interface VideoMaterialInformation {id: string; label: string; text: string; selected: boolean}
export interface VideoMaterialsDocument {
  schema: 'cqai-track-video-materials@1'; trackId: string; title: string; sourceFingerprint: string
  sourcePointCount: number; sourceSegmentStarts: number[]; markers: VideoMaterialMarker[]
  segments: VideoMaterialSegment[]; information: VideoMaterialInformation[]
}

const SCHEMA = 'cqai-track-video-materials@1'
const MAX_PHOTOS = 8 * 1024 * 1024
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const HEX = /^#[0-9a-f]{6}$/iu
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const coord = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(finite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
function record(value: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${what}格式无效`)
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error(`${what}包含不支持的字段`)
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, what: string, empty = true): string {
  if (typeof value !== 'string' || value.length > max || BAD_TEXT.test(value) || (!empty && !value.trim())) throw new Error(`${what}文字无效或过长`)
  return value
}
function clean(value: string | undefined, max: number): string {return Array.from((value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '')).slice(0, max).join('').slice(0, max)}
function id(value: unknown, seen: Set<string>, what: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || seen.has(value)) throw new Error(`${what}编号无效或重复`)
  seen.add(value); return value
}
function bool(value: unknown): boolean {if (typeof value !== 'boolean') throw new Error('素材选择状态无效'); return value}
function color(value: unknown): string {if (typeof value !== 'string' || !HEX.test(value)) throw new Error('素材颜色无效'); return value}
function index(value: unknown, count: number): number {if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= count) throw new Error('素材轨迹点序号无效'); return value as number}
function reference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !imageLink(value)) throw new Error('图片引用须为有效 HTTP 链接或插件本地图片')
  return imageLink(value)!
}
function startsFor(track: TrackRecord): number[] {
  const starts = track.segmentStarts || [0]
  if (starts.some(start => !Number.isInteger(start) || start < 0 || start >= track.coordinates.length)) throw new Error('原始轨迹分段无效')
  return [...new Set([0, ...starts])].sort((a, b) => a - b)
}
function runOf(starts: readonly number[], point: number): number {
  let run = 0
  for (let i = 1; i < starts.length && starts[i] <= point; i++) run = i
  return run
}
function sourceCheck(track: TrackRecord): void {
  if (track.coordinates.length < 2 || track.coordinates.length > 500000 || track.coordinates.some(point => !coord([point[0], point[1]]))) throw new Error('当前轨迹需要 2 至 500000 个有效坐标点')
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}
/** Includes actual source geometry, effective points/groups and saved SVG state, without host settings. */
export function videoMaterialsFingerprint(track: TrackRecord, points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[] = [], annotations: readonly TrackAnnotation[] = [], saved = false): string {
  const input = JSON.stringify(stable({id: track.id, name: track.name, coordinates: track.coordinates, segmentStarts: startsFor(track), points, groups, annotations: saved ? annotations : [], saved}))
  let a = 2166136261, b = 3335557771
  for (let i = 0; i < input.length; i++) {a = Math.imul(a ^ input.charCodeAt(i), 16777619); b = Math.imul(b ^ input.charCodeAt(i), 2246822519)}
  return `vm1-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`
}
function nearest(track: TrackRecord, coordinate: [number, number]): number {
  let pointIndex = 0, distance = Infinity
  for (let i = 0; i < track.coordinates.length; i++) {
    const point = track.coordinates[i], dx = ((point[0] - coordinate[0] + 540) % 360) - 180
    const next = (dx * Math.cos(coordinate[1] * Math.PI / 180)) ** 2 + (point[1] - coordinate[1]) ** 2
    if (next < distance) {distance = next; pointIndex = i}
  }
  return pointIndex
}
function photos(values: readonly string[]): string[] {return [...new Set(values.map(imageLink).filter((url): url is string => !!url))].slice(0, 30)}
function fullMetrics(track: TrackRecord, starts: number[]): TrackMetrics {
  const parts = starts.map((start, i) => pointMetrics(track.coordinates.slice(start, starts[i + 1] ?? track.coordinates.length)))
  const timed = track.coordinates.map(point => point[3]).filter((value): value is number => finite(value))
  let minTime = Infinity, maxTime = -Infinity
  for (const value of timed) {minTime = Math.min(minTime, value); maxTime = Math.max(maxTime, value)}
  const extrema = parts.flatMap(part => part.elevationMax === null || part.elevationMin === null ? [] : [part.elevationMin, part.elevationMax])
  let min = Infinity, max = -Infinity
  for (const value of extrema) {min = Math.min(min, value); max = Math.max(max, value)}
  return {distance: parts.reduce((sum, part) => sum + part.distance, 0), elevationGain: parts.reduce((sum, part) => sum + part.elevationGain, 0), elevationLoss: parts.reduce((sum, part) => sum + part.elevationLoss, 0),
    duration: timed.length > 1 ? maxTime - minTime : 0, elevationMin: extrema.length ? min : null, elevationMax: extrema.length ? max : null, bbox: null}
}
/** Start with real route facts and saved SVG choices; subsequent edits are a separate presentation plan. */
export function extractVideoMaterials(track: TrackRecord, points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[] = [], annotations: readonly TrackAnnotation[] = [], annotationsSaved = false): VideoMaterialsDocument {
  sourceCheck(track)
  const starts = startsFor(track), markers: VideoMaterialMarker[] = [], seen = new Set<string>(), covered = new Set<string>()
  if (starts.length > 200) throw new Error('二维视频准备最多支持 200 个原始路线分段')
  function unique(prefix: string, raw: string): string {
    const stem = clean(raw, 100).replace(/[^A-Za-z0-9_-]/gu, '-') || 'item'
    let next = `${prefix}-${stem}`, suffix = 1
    while (seen.has(next)) next = `${prefix}-${stem}-${suffix++}`
    seen.add(next); return next
  }
  if (annotationsSaved) for (const annotation of annotations.slice(0, 100)) {
    const pointIndex = index(annotation.pointIndex, track.coordinates.length)
    const coordinate: [number, number] = annotation.sourceCoordinates ? [...annotation.sourceCoordinates] : [track.coordinates[pointIndex][0], track.coordinates[pointIndex][1]]
    if (!coord(coordinate)) throw new Error('SVG 标注来源坐标无效')
    const candidates = photos([...(annotation.imageUrls || []), ...(annotation.photo?.sourceUrl ? [annotation.photo.sourceUrl] : [])])
    markers.push({id: unique('svg', annotation.id), name: clean(annotation.label, 160) || '未命名标记', description: clean(annotation.description, 4000), coordinates: coordinate, pointIndex,
      selected: annotationVisible(annotation), color: HEX.test(annotation.color) ? annotation.color : '#d33d33', photoCandidates: candidates,
      ...(annotation.sourceId ? {sourceId: annotation.sourceId} : {}), ...(annotation.photo ? {photo: {dataUrl: annotation.photo.dataUrl, ...(annotation.photo.sourceUrl ? {sourceUrl: annotation.photo.sourceUrl} : {})}} : {})})
    covered.add(annotation.sourceId || annotation.id)
  }
  for (const item of placemarkListItems(points, groups)) {
    if (markers.length >= 100) break
    const source = item.kind === 'point' ? item.point : item.group
    if (covered.has(source.id)) continue
    if (!coord(source.coordinates)) continue
    const candidates = item.kind === 'point' ? photos(item.point.images) : photos([...(item.group.cover ? [item.group.cover.imageUrl] : []), ...groupPhotos(item.group, points).map(photo => photo.url)])
    markers.push({id: unique('source', source.id), sourceId: source.id, name: clean(source.name, 160) || '未命名标记', description: clean(source.description, 4000),
      coordinates: [...source.coordinates], pointIndex: nearest(track, source.coordinates), selected: item.kind === 'point' ? !item.point.hidden : !groupHidden(item.group, points), color: '#d33d33', photoCandidates: candidates})
  }
  const metrics = fullMetrics(track, starts), information: VideoMaterialInformation[] = [{id: 'info-title', label: '路线标题', text: clean(track.name, 160) || '轨迹视频', selected: true},
    {id: 'info-distance', label: '路线长度', text: `${(metrics.distance / 1000).toFixed(2)} 公里`, selected: false}]
  if (metrics.elevationMax !== null) information.push({id: 'info-gain', label: '累计爬升', text: `${Math.round(metrics.elevationGain)} 米`, selected: false}, {id: 'info-loss', label: '累计下降', text: `${Math.round(metrics.elevationLoss)} 米`, selected: false},
    {id: 'info-min', label: '最低海拔', text: `${Math.round(metrics.elevationMin!)} 米`, selected: false}, {id: 'info-max', label: '最高海拔', text: `${Math.round(metrics.elevationMax)} 米`, selected: false})
  if (metrics.duration > 0) {const seconds = Math.round(metrics.duration / 1000); information.push({id: 'info-duration', label: '记录时长', text: `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`, selected: false})}
  return validateVideoMaterials({schema: SCHEMA, trackId: track.id, title: clean(track.name, 160) || '轨迹视频', sourceFingerprint: videoMaterialsFingerprint(track, points, groups, annotations, annotationsSaved),
    sourcePointCount: track.coordinates.length, sourceSegmentStarts: starts, markers, segments: starts.map((start, i) => ({id: `segment-${start}`, name: `第 ${i + 1} 段`, startIndex: start, endIndex: (starts[i + 1] ?? track.coordinates.length) - 1, selected: true, description: '', color: ['#2563eb', '#0f766e', '#7c3aed', '#b45309'][i % 4]})), information})
}
function photoData(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PHOTOS || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('照片须为嵌入的 PNG、JPEG 或 WebP 图片')
  const comma = value.indexOf(','), encoded = value.slice(comma + 1)
  if (encoded.length % 4 !== 0) throw new Error('照片数据无效')
  let binary: string
  try {binary = atob(encoded.slice(0, Math.min(encoded.length, 32)))} catch {throw new Error('照片数据无效')}
  const format = value.slice(11, value.indexOf(';'))
  const signature = format === 'png' ? binary.startsWith('\x89PNG\r\n\x1a\n') : format === 'jpeg' ? binary.startsWith('\xff\xd8\xff') : binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP'
  if (!signature) throw new Error('照片数据与图片类型不匹配')
  return value
}
/** Reject unknown fields and detach the persisted plan; it contains no duplicate route geometry. */
export function validateVideoMaterials(value: unknown): VideoMaterialsDocument {
  const raw = record(value, ['schema', 'trackId', 'title', 'sourceFingerprint', 'sourcePointCount', 'sourceSegmentStarts', 'markers', 'segments', 'information'], '视频素材工程')
  if (raw.schema !== SCHEMA || typeof raw.trackId !== 'string' || !IDENTIFIER.test(raw.trackId) || typeof raw.sourceFingerprint !== 'string' || !/^vm1-[a-z0-9]{1,13}-[a-z0-9]{1,13}$/u.test(raw.sourceFingerprint)) throw new Error('视频素材工程来源或版本无效')
  if (!Number.isInteger(raw.sourcePointCount) || (raw.sourcePointCount as number) < 2 || (raw.sourcePointCount as number) > 500000) throw new Error('视频素材来源轨迹点数无效')
  const count = raw.sourcePointCount as number
  if (!Array.isArray(raw.sourceSegmentStarts) || !raw.sourceSegmentStarts.length || raw.sourceSegmentStarts.length > 200 || raw.sourceSegmentStarts[0] !== 0) throw new Error('视频素材原始分段无效')
  const starts = raw.sourceSegmentStarts.map(start => index(start, count))
  if (starts.some((start, i) => i > 0 && start <= starts[i - 1])) throw new Error('视频素材原始分段必须按轨迹顺序且不重复')
  if (!Array.isArray(raw.markers) || raw.markers.length > 100 || !Array.isArray(raw.segments) || raw.segments.length > 200 || !Array.isArray(raw.information) || raw.information.length > 30) throw new Error('最多 100 个标记、200 个路线分段和 30 条介绍信息')
  const seen = new Set<string>(); let photoBytes = 0
  const markers: VideoMaterialMarker[] = raw.markers.map(value => {
    const item = record(value, ['id', 'name', 'description', 'coordinates', 'pointIndex', 'selected', 'color', 'sourceId', 'photoCandidates', 'photo', 'labelOffset'], '视频标记')
    if (!coord(item.coordinates)) throw new Error('视频标记地理坐标无效')
    if (!Array.isArray(item.photoCandidates) || item.photoCandidates.length > 30) throw new Error('标记图片候选最多 30 张')
    const marker: VideoMaterialMarker = {id: id(item.id, seen, '视频标记'), name: text(item.name, 160, '标记名称', false), description: text(item.description, 4000, '标记说明'), coordinates: [...item.coordinates],
      pointIndex: index(item.pointIndex, count), selected: bool(item.selected), color: color(item.color), photoCandidates: [...new Set(item.photoCandidates.map(reference))]}
    if (item.sourceId !== undefined) {if (typeof item.sourceId !== 'string' || !IDENTIFIER.test(item.sourceId)) throw new Error('标记来源编号无效'); marker.sourceId = item.sourceId}
    if (item.labelOffset !== undefined) {
      const offset = record(item.labelOffset, ['x', 'y'], '标记文字偏移')
      if (!finite(offset.x) || !finite(offset.y) || Math.abs(offset.x) > 1200 || Math.abs(offset.y) > 1200) throw new Error('标记文字偏移无效')
      marker.labelOffset = {x: offset.x, y: offset.y}
    }
    if (item.photo !== undefined) {
      const photo = record(item.photo, ['dataUrl', 'sourceUrl'], '标记照片'), dataUrl = photoData(photo.dataUrl)
      photoBytes += dataUrl.length
      if (photoBytes > MAX_PHOTOS) throw new Error('素材照片总大小上限 8 MB')
      marker.photo = {dataUrl, ...(photo.sourceUrl !== undefined ? {sourceUrl: reference(photo.sourceUrl)} : {})}
    }
    return marker
  })
  const segments: VideoMaterialSegment[] = raw.segments.map(value => {
    const item = record(value, ['id', 'name', 'startIndex', 'endIndex', 'selected', 'description', 'color'], '视频路线分段')
    const startIndex = index(item.startIndex, count), endIndex = index(item.endIndex, count)
    if (endIndex < startIndex || runOf(starts, startIndex) !== runOf(starts, endIndex)) throw new Error('视频路线分段不能跨越原始断点或逆向')
    return {id: id(item.id, seen, '视频路线分段'), name: text(item.name, 160, '路线分段名称', false), startIndex, endIndex, selected: bool(item.selected), description: text(item.description, 4000, '路线分段说明'), color: color(item.color)}
  })
  segments.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  if (segments.some((segment, i) => i > 0 && segment.startIndex < segments[i - 1].endIndex)) throw new Error('视频路线分段不能重复覆盖轨迹区间')
  const information: VideoMaterialInformation[] = raw.information.map(value => {
    const item = record(value, ['id', 'label', 'text', 'selected'], '视频介绍信息')
    return {id: id(item.id, seen, '视频介绍信息'), label: text(item.label, 80, '信息标题', false), text: text(item.text, 2000, '介绍信息'), selected: bool(item.selected)}
  })
  return {schema: SCHEMA, trackId: raw.trackId, title: text(raw.title, 160, '视频标题', false), sourceFingerprint: raw.sourceFingerprint, sourcePointCount: count, sourceSegmentStarts: starts, markers, segments, information}
}
export function splitVideoMaterialSegment(document: VideoMaterialsDocument, segmentId: string, pointIndex: number): VideoMaterialsDocument {
  const doc = validateVideoMaterials(document), segment = doc.segments.find(segment => segment.id === segmentId)
  if (!segment || !Number.isInteger(pointIndex) || pointIndex <= segment.startIndex || pointIndex >= segment.endIndex) throw new Error('请选择当前分段内部的轨迹点拆分，两段都至少包含 2 个点')
  if (doc.segments.length >= 200) throw new Error('路线分段最多 200 段')
  let nextId = `split-${pointIndex}`, suffix = 1
  const ids = new Set([...doc.segments, ...doc.markers, ...doc.information].map(item => item.id))
  while (ids.has(nextId)) nextId = `split-${pointIndex}-${suffix++}`
  const at = doc.segments.indexOf(segment)
  doc.segments.splice(at, 1, {...segment, endIndex: pointIndex}, {...segment, id: nextId, name: `${segment.name} · 后段`.slice(0, 160), startIndex: pointIndex})
  return validateVideoMaterials(doc)
}
/** Only adjacent presentation parts of the same original connected run may join. */
export function mergeVideoMaterialSegment(document: VideoMaterialsDocument, segmentId: string): VideoMaterialsDocument {
  const doc = validateVideoMaterials(document), at = doc.segments.findIndex(segment => segment.id === segmentId), first = doc.segments[at], next = doc.segments[at + 1]
  if (!first || !next || first.endIndex !== next.startIndex || runOf(doc.sourceSegmentStarts, first.startIndex) !== runOf(doc.sourceSegmentStarts, next.endIndex)) throw new Error('只能合并同一原始路线内的相邻分段，不能跨越轨迹断点')
  doc.segments.splice(at, 2, {...first, endIndex: next.endIndex, description: [first.description, next.description].filter(Boolean).join('\n\n').slice(0, 4000)})
  return validateVideoMaterials(doc)
}
export function videoMaterialSegmentMetrics(track: TrackRecord, segment: VideoMaterialSegment): TrackMetrics {
  const starts = startsFor(track), start = index(segment.startIndex, track.coordinates.length), end = index(segment.endIndex, track.coordinates.length)
  if (end < start || runOf(starts, start) !== runOf(starts, end)) throw new Error('路线统计不能跨越原始轨迹断点')
  return pointMetrics(track.coordinates.slice(start, end + 1))
}
/** Translate only confirmed materials into native format-7 layers and sequential introduction slots. */
export function geoProjectFromVideoMaterials(track: TrackRecord, document: VideoMaterialsDocument, previous?: GeoMotionProject): GeoMotionProject {
  sourceCheck(track)
  const doc = validateVideoMaterials(document)
  if (doc.trackId !== track.id || doc.sourcePointCount !== track.coordinates.length || JSON.stringify(doc.sourceSegmentStarts) !== JSON.stringify(startsFor(track))) throw new Error('视频素材工程与当前轨迹来源不匹配，请重新提取后确认')
  const base = previous ? geoParseProject(previous) : createGeoMotionProject(track, [], []).document, duration = base.duration
  // Existing authored camera tracks and output settings survive replacing the material draft.
  const nodes: DocNode[] = Object.values(base.nodes).filter(node => node.type === 'camera').map(node => ({...node, parentId: null}))
  const info = doc.information.filter(item => item.selected && item.text.trim()).map(item => item.id === 'info-title' ? item.text : `${item.label}：${item.text}`)
  const infoLines = info.join('\n').split('\n').length
  const sectionY = Math.max(.14, Math.min(.5, .04 + (infoLines * 24 * 1.22 + 32) / 1080))
  const sectionLines = Math.max(0, ...doc.segments.filter(item => item.selected && item.description.trim()).map(item => `${item.name}\n${item.description}`.split('\n').length))
  const pointY = Math.max(.32, Math.min(.76, sectionY + (sectionLines * 24 * 1.22 + 32) / 1080))
  const segments = doc.segments.filter(segment => segment.selected), lengths = segments.map(segment => videoMaterialSegmentMetrics(track, segment).distance), total = lengths.reduce((sum, value) => sum + value, 0)
  const windows: {segment: VideoMaterialSegment; start: number; end: number}[] = []
  let cursor = duration * .16
  segments.forEach((segment, i) => {
    const span = duration * .68 * (total > 0 ? lengths[i] / total : 1 / Math.max(1, segments.length)), end = cursor + span
    windows.push({segment, start: cursor, end})
    nodes.push(createLayer('route', 0, {id: `material-route-${segment.id}`, name: segment.name, coords: track.coordinates.slice(segment.startIndex, segment.endIndex + 1).map(point => [point[0], point[1]]),
      curve: 'straight', color: segment.color, in: 0, out: duration, fade: 0, width: 4, progress: windowTrack(cursor, Math.max(cursor + .001, end), 'linear')}) as RouteLayer)
    if (segment.description.trim()) nodes.push(createLayer('text', cursor, {id: `material-section-${segment.id}`, name: `${segment.name} · 介绍`, text: `${segment.name}\n${segment.description}`,
      in: cursor, out: Math.max(cursor + .001, end), fade: Math.min(.2, span / 4), x: .05, y: sectionY, size: 24, align: 'left', background: true, anim: 'fade'}))
    cursor = end
  })
  const selected = doc.markers.filter(marker => marker.selected).sort((a, b) => a.pointIndex - b.pointIndex)
  const introductions = selected.filter(marker => marker.photo || marker.description.trim())
  const slotOf = (marker: VideoMaterialMarker): {start: number; end: number} => {
    // Boundary markers use the later split, retaining route order without bridging source gaps.
    const window = [...windows].reverse().find(window => marker.pointIndex >= window.segment.startIndex && marker.pointIndex <= window.segment.endIndex)
    const peers = window ? introductions.filter(candidate => [...windows].reverse().find(item => candidate.pointIndex >= item.segment.startIndex && candidate.pointIndex <= item.segment.endIndex) === window)
      : introductions.filter(candidate => !windows.some(item => candidate.pointIndex >= item.segment.startIndex && candidate.pointIndex <= item.segment.endIndex))
    const at = Math.max(0, peers.indexOf(marker)), start = window?.start ?? duration * .16, end = window?.end ?? duration * .84
    const span = Math.max(.001, end - start) / Math.max(1, peers.length)
    return {start: start + at * span, end: start + (at + 1) * span}
  }
  for (const marker of selected) {
    nodes.push(createLayer('marker', 0, {id: `material-marker-${marker.id}`, name: marker.name, label: marker.name, coord: [...marker.coordinates], color: marker.color, in: 0, out: duration, fade: 0,
      size: staticTrack(8), labelSize: 26, labelColor: '#ffffff', labelOffset: 16, halo: true, behaviours: {}}))
    if (marker.photo || marker.description.trim()) {
      const slot = slotOf(marker), fade = Math.min(.25, (slot.end - slot.start) / 4)
      if (marker.photo) nodes.push(createLayer('image', slot.start, {id: `material-photo-${marker.id}`, name: `${marker.name} · 图片`, src: marker.photo.dataUrl, caption: marker.name,
        in: slot.start, out: slot.end, fade, x: .96, y: .14, width: .27, anchor: 'topRight', anim: 'fade', border: true, shadow: true}))
      if (marker.description.trim()) nodes.push(createLayer('text', slot.start, {id: `material-point-${marker.id}`, name: `${marker.name} · 介绍`, text: `${marker.name}\n${marker.description}`,
        in: slot.start, out: slot.end, fade, x: .05, y: pointY, size: 22, align: 'left', background: true, anim: 'fade'}))
    }
  }

  if (info.length) nodes.push(createLayer('text', 0, {id: 'material-information', name: '路线介绍信息', text: info.join('\n'), in: 0, out: duration, fade: 0, x: .05, y: .04, size: 24, align: 'left', background: true, anim: 'none'}))
  return geoParseProject(projectWith(nodes, {...base, name: `${doc.title} · 素材编排`}))
}
