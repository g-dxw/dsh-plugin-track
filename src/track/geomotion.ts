/** Track's geographic animation facade; rendering and persistence remain host-owned. */
import type { PlacemarkGroup, TrackPlacemark, TrackRecord } from '../protocol.ts'
import { groupHidden, placemarkListItems } from './placemark-groups.ts'
import {
  cameraFromShots, camerasOf, createLayer, keyframe, liveCamera, migrate,
  projectWith, shotsOf, shiftLayer, staticTrack, transact, windowTrack,
  type CameraKeyframe, type CameraNode, type DocNode, type MarkerLayer, type Project, type RouteLayer,
} from './vendor/geomotion/document/index.ts'
import { EASING_NAMES } from './vendor/geomotion/animation/index.ts'
import { evaluate } from './vendor/geomotion/evaluator/index.ts'
import { fitBounds } from './vendor/geomotion/entities/index.ts'
import { measure } from './vendor/geomotion/geometry/index.ts'
import type { Scene } from './vendor/geomotion/renderer/index.ts'

export type GeoMotionProject = Project
export type GeoKeyframe = CameraKeyframe
export interface GeoCamera {center: [number, number]; zoom: number; bearing: number; pitch: number}
export type { Scene as GeoScene, OverlayFrame as GeoOverlayFrame } from './vendor/geomotion/renderer/index.ts'
export { syncScene as geoSyncScene, resetSyncCache as geoResetSyncCache } from './vendor/geomotion/map/index.ts'
export { drawOverlay as geoDrawOverlay, scaleFor as geoScaleFor, imagesReady as geoImagesReady } from './vendor/geomotion/renderer/index.ts'
export { getImage as geoGetImage } from './vendor/geomotion/renderer/images.ts'

const DURATION = 20
const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const coordinate = (value: unknown): value is [number, number] => Array.isArray(value) && value.length >= 2
  && finite(value[0]) && finite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
const copyCoordinate = (value: readonly number[]): [number, number] => [value[0], value[1]]

/** Invalid fixes break the line even in legacy tracks with no explicit segmentStarts. */
function connectedRuns(track: TrackRecord): [number, number][][] {
  const starts = new Set(track.segmentStarts || [])
  const runs: [number, number][][] = []
  let active: [number, number][] | null = null
  track.coordinates.forEach((point, index) => {
    if (starts.has(index) || !coordinate(point)) active = null
    if (!coordinate(point)) return
    if (!active) {active = []; runs.push(active)}
    active.push(copyCoordinate(point))
  })
  return runs
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return finite(value) ? value : typeof value === 'number' ? String(value) : value
}
function fingerprint(track: TrackRecord, points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[], runs: [number, number][][]): string {
  // An explicit source projection avoids carrying provider settings/API keys into animation documents.
  const input = JSON.stringify(stable({trackId: track.id, name: track.name, runs,
    coordinates: track.coordinates, segmentStarts: track.segmentStarts || [], points, groups}))
  let a = 2166136261, b = 3335557771
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index)
    a = Math.imul(a ^ code, 16777619); b = Math.imul(b ^ code, 2246822519)
  }
  return `gm1-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`
}

/** Fit the source fixes, accounting for an antimeridian crossing before fitting. */
function overview(coords: readonly [number, number][], width = 1280, height = 720): GeoCamera {
  if (!coords.length) throw new Error('当前轨迹没有有效坐标，无法创建动画工程')
  const origin = coords[0][0]
  const longitudes = coords.map(point => {
    let lon = point[0]
    while (lon - origin > 180) lon -= 360
    while (lon - origin < -180) lon += 360
    return lon
  })
  const bounds = coords.reduce((box, point, index) => {const lat = clamp(point[1], -85.051129, 85.051129); return [Math.min(box[0], longitudes[index]), Math.min(box[1], lat), Math.max(box[2], longitudes[index]), Math.max(box[3], lat)] as [number, number, number, number]}, [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number])
  const camera = fitBounds(bounds, width, height, .19, 45, 15)
  camera.center[0] = ((camera.center[0] + 180) % 360 + 360) % 360 - 180
  return camera
}

export function createGeoMotionProject(track: TrackRecord, points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[] = []): {document: GeoMotionProject; sourceFingerprint: string} {
  const runs = connectedRuns(track), coordinates = runs.flat()
  const camera = overview(coordinates)
  const cameraNode = cameraFromShots([geoNewKey(0, {...camera, zoom: Math.max(0, camera.zoom - 1.1)}), geoNewKey(DURATION * .75, camera), geoNewKey(DURATION, camera)], {name: '相机'})
  const nodes: DocNode[] = [cameraNode]
  const lengths = runs.map(run => measure(run).length)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  let cursor = DURATION * .18
  const drawingDuration = DURATION * .62
  for (let index = 0; index < runs.length; index++) {
    const span = total > 0 ? drawingDuration * lengths[index] / total : drawingDuration / runs.length
    const route = createLayer('route', 0, {
      name: runs.length === 1 ? track.name : `${track.name} · 第 ${index + 1} 段`,
      coords: runs[index], curve: 'straight', color: '#3dc5ff', width: 4,
      in: 0, out: DURATION, fade: 0,
      progress: windowTrack(cursor, cursor + Math.max(.001, span), 'linear'),
      follow: {enabled: false, zoom: camera.zoom, pitch: camera.pitch, faceHeading: false},
    }) as RouteLayer
    nodes.push(route); cursor += span
  }
  for (const item of placemarkListItems(points, groups)) {
    const source = item.kind === 'point' ? item.point : item.group
    const hidden = item.kind === 'point' ? item.point.hidden : groupHidden(item.group, points)
    if (hidden || !coordinate(source.coordinates)) continue
    nodes.push(createLayer('marker', 0, {
      name: source.name, label: source.name, coord: copyCoordinate(source.coordinates),
      in: 0, out: DURATION, fade: 0, color: '#ffbd2e', size: staticTrack(8),
      labelSize: 26, labelColor: '#ffffff', labelOffset: 16, halo: true, behaviours: {},
    }) as MarkerLayer)
  }
  const document = projectWith(nodes, {
    name: `${track.name} · 轨迹动画`, duration: DURATION, fps: 30, width: 1280, height: 720,
    basemap: 'track-shared', terrain: true, terrainExaggeration: 1, background: '#0d1117', contexts: [], story: [],
  })
  return {document, sourceFingerprint: fingerprint(track, points, groups, runs)}
}

function cameraOf(project: GeoMotionProject): CameraNode {
  const camera = liveCamera(project)
  if (!camera) throw new Error('动画工程缺少相机')
  return camera
}
export function geoCameraKeys(project: GeoMotionProject): GeoKeyframe[] {
  return shotsOf(cameraOf(project)).sort((a, b) => a.t - b.t)
}
function validCamera(camera: GeoCamera): boolean {
  return coordinate(camera.center) && finite(camera.zoom) && camera.zoom >= 0 && camera.zoom <= 24
    && finite(camera.bearing) && Math.abs(camera.bearing) <= 36000 && finite(camera.pitch) && camera.pitch >= 0 && camera.pitch <= 85
}
function validateKey(key: GeoKeyframe, duration: number): void {
  if (!key || typeof key.id !== 'string' || !key.id || !finite(key.t) || key.t < 0 || key.t > duration
    || !validCamera(key) || !EASING_NAMES.includes(key.easing) || !finite(key.dip) || key.dip < 0 || key.dip > 12) {
    throw new Error('相机关键帧无效，请检查时间、坐标、缩放与俯仰角')
  }
}
export function geoNewKey(time: number, camera: GeoCamera): GeoKeyframe {
  if (!finite(time) || time < 0 || !validCamera(camera)) throw new Error('无法创建相机关键帧：时间或镜头参数无效')
  return keyframe(time, copyCoordinate(camera.center), camera.zoom, {bearing: camera.bearing, pitch: camera.pitch})
}
function replaceCamera(project: GeoMotionProject, keys: readonly GeoKeyframe[]): GeoMotionProject {
  const original = cameraOf(project)
  const replacement = cameraFromShots(keys, {id: original.id, name: original.name})
  replacement.parentId = original.parentId; replacement.order = original.order
  return transact(project, draft => {draft.nodes[original.id] = replacement}).next
}
export function geoSetCameraKey(project: GeoMotionProject, key: GeoKeyframe): GeoMotionProject {
  validateKey(key, project.duration)
  const rows = geoCameraKeys(project), sameId = rows.find(row => row.id === key.id)
  const sameTime = rows.find(row => row.id !== key.id && Math.abs(row.t - key.t) < .000001)
  const id = sameId?.id || sameTime?.id || key.id
  const updated = {...key, id, center: copyCoordinate(key.center)}
  return replaceCamera(project, [...rows.filter(row => row.id !== id && row.id !== key.id && row.id !== sameTime?.id), updated].sort((a, b) => a.t - b.t))
}
export function geoRemoveCameraKey(project: GeoMotionProject, id: string): GeoMotionProject {
  const rows = geoCameraKeys(project)
  if (rows.length <= 1 || !rows.some(row => row.id === id)) return project
  return replaceCamera(project, rows.filter(row => row.id !== id))
}

/** Retimes existing authored tracks, rather than regenerating the user's camera and labels. */
export function geoResizeDuration(project: GeoMotionProject, duration: number): GeoMotionProject {
  if (!finite(duration) || duration < 1 || duration > 3600) throw new Error('动画时长须为 1 到 3600 秒')
  if (duration === project.duration) return project
  const ratio = duration / project.duration
  const next = structuredClone(project)
  const retimeTracks = (value: unknown): void => {
    if (Array.isArray(value)) {value.forEach(retimeTracks); return}
    if (!isRecord(value)) return
    if (value.kind === 'keyframed' && Array.isArray(value.keys)) {
      for (const key of value.keys) if (isRecord(key) && finite(key.t)) key.t *= ratio
      return
    }
    for (const child of Object.values(value)) retimeTracks(child)
  }
  retimeTracks(next.nodes)
  for (const node of Object.values(next.nodes)) if ('in' in node) {
    node.in *= ratio; node.out *= ratio; node.fade *= ratio
  }
  for (const block of next.story) {block.t *= ratio; block.d *= ratio}
  if (next.audio) for (const cue of next.audio.cues) cue.t *= ratio
  next.duration = duration
  return next
}

function checkedPlain(value: unknown, depth = 0): void {
  if (depth > 80) throw new Error('动画工程嵌套过深')
  if (typeof value === 'number' && !finite(value)) throw new Error('动画工程包含无效数值')
  if (Array.isArray(value)) {value.forEach(child => checkedPlain(child, depth + 1)); return}
  if (isRecord(value)) for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('动画工程包含无效字段')
    checkedPlain(child, depth + 1)
  }
}
function validateProject(project: GeoMotionProject): void {
  if (typeof project.name !== 'string' || project.name.length > 4000 || !finite(project.duration) || project.duration < 1 || project.duration > 3600
    || !Number.isInteger(project.fps) || project.fps < 1 || project.fps > 60
    || !Number.isInteger(project.width) || project.width < 64 || project.width > 4096
    || !Number.isInteger(project.height) || project.height < 64 || project.height > 4096) throw new Error('动画工程的名称、时长、帧率或尺寸无效')
  if (!isRecord(project.nodes) || Object.keys(project.nodes).length > 10000 || !camerasOf(project).length) throw new Error('动画工程缺少相机或图层数量过多')
  if (typeof project.basemap !== 'string' || typeof project.background !== 'string' || typeof project.terrain !== 'boolean' || !finite(project.terrainExaggeration) || project.terrainExaggeration < 0 || project.terrainExaggeration > 10 || !Array.isArray(project.contexts) || !Array.isArray(project.story)) throw new Error('动画工程的地图或故事设置无效')
  const known = new Set(['camera', 'group', 'route', 'marker', 'text', 'shape', 'regions', 'clouds', 'image'])
  let fixes = 0
  for (const [id, node] of Object.entries(project.nodes)) {
    if (!id || !node || node.id !== id || typeof node.name !== 'string' || node.name.length > 4000 || !known.has(node.type)) throw new Error('动画工程包含无效图层')
    if (node.parentId !== null && (!project.nodes[node.parentId] || project.nodes[node.parentId].type !== 'group')) throw new Error('动画工程图层分组引用无效')
    const ancestors = new Set([id]); let parent = node.parentId
    while (parent !== null) {
      if (ancestors.has(parent)) throw new Error('动画工程图层分组存在循环')
      ancestors.add(parent); parent = project.nodes[parent]?.parentId ?? null
    }
    if (node.type === 'camera') {
      const keys = shotsOf(node)
      if (keys.length > 40000) throw new Error('相机关键帧数量过多')
      for (const key of keys) validateKey(key, project.duration)
      if (!keys.length && !validCamera(evaluate(project, 0).camera)) throw new Error('动画工程相机参数无效')
    } else if (node.type !== 'group') {
      if (!finite(node.in) || !finite(node.out) || node.in < 0 || node.out < node.in || node.out > project.duration
        || !finite(node.fade) || node.fade < 0 || typeof node.visible !== 'boolean') throw new Error('动画工程图层时间或显隐设置无效')
      if (node.type === 'route') {
        if (!Array.isArray(node.coords) || node.coords.some(point => !coordinate(point)) || !['straight', 'geodesic', 'arc'].includes(node.curve)) throw new Error('动画工程路线坐标无效')
        fixes += node.coords.length
      } else if (node.type === 'marker' && (!coordinate(node.coord) || typeof node.label !== 'string' || node.label.length > 4000)) throw new Error('动画工程地名标注无效')
    }
  }
  if (fixes > 500000) throw new Error('动画工程轨迹点数量过多')
}

/** Clip moves shift absolute property keys with the window; trims preserve the authored content. */
export function geoSetLayerWindow(project: GeoMotionProject, id: string, range: {in: number; out: number}, mode?: 'move' | 'start' | 'end'): GeoMotionProject {
  const layer = project.nodes[id]
  if (!layer || layer.type === 'camera' || layer.type === 'group') return project
  if (layer.locked) throw new Error('该图层已锁定，不能修改时间窗口')
  if (!finite(range.in) || !finite(range.out) || range.in < 0 || range.out < range.in || range.out > project.duration) throw new Error('片段时间须位于工程时长内，结束时间不能早于开始时间')
  if (Math.abs(range.in-layer.in)<1e-9 && Math.abs(range.out-layer.out)<1e-9) return project
  const moving = mode === 'move' || mode === undefined && Math.abs((range.out-range.in)-(layer.out-layer.in)) < 1e-8
  const next = structuredClone(project), original = next.nodes[id]
  if (original.type === 'camera' || original.type === 'group') return project
  next.nodes[id] = moving
    ? {...shiftLayer(original, range.in-original.in), in: range.in, out: range.out}
    : {...original, in: range.in, out: range.out}
  return geoParseProject(next)
}
/** Opens detached format-1..7 GeoMotion files with upstream migrations and Chinese diagnostics. */
export function geoParseProject(value: unknown): GeoMotionProject {
  try {
    let parsed: unknown = value
    if (typeof value === 'string') {
      if (new TextEncoder().encode(value).byteLength > MAX_DOCUMENT_BYTES) throw new Error('动画工程文件过大，上限 24 MB')
      parsed = JSON.parse(value)
    }
    if (!isRecord(parsed) || !Number.isInteger(parsed.format) || (parsed.format as number) < 1 || (parsed.format as number) > 7) throw new Error('动画工程格式无效，仅支持 GeoMotion 1 到 7 版工程')
    checkedPlain(parsed)
    const detached = structuredClone(parsed)
    const project = detached.format === 7 ? detached as unknown as GeoMotionProject : migrate(detached)
    const sortTracks = (item: unknown): void => {
      if (Array.isArray(item)) {item.forEach(sortTracks); return}
      if (!isRecord(item)) return
      if (item.kind === 'keyframed' && Array.isArray(item.keys)) {
        item.keys.sort((a, b) => (isRecord(a) && finite(a.t) ? a.t : 0) - (isRecord(b) && finite(b.t) ? b.t : 0))
        return
      }
      Object.values(item).forEach(sortTracks)
    }
    sortTracks(project.nodes)
    validateProject(project)
    return project
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('动画') || error instanceof Error && error.message.startsWith('相机')) throw error
    throw new Error('动画工程文件无效或内容不完整')
  }
}
export function geoEvaluate(project: GeoMotionProject, time: number): Scene {
  const normalized = Number.isNaN(time) ? 0 : clamp(time, 0, project.duration)
  return evaluate(project, normalized)
}
