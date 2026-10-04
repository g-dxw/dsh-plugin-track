/** Versioned, local executable shots. Movie seconds and route progress are independent. */
import type { TrackPoint } from '../protocol.ts'
import type { SandboxCameraState } from './sandbox/types.ts'
import { TRACK_COLOR } from './trail-layer.ts'

export interface ShotEditorPlan {
  version: 1
  trackId: string
  fingerprint: string
  sceneFingerprint: string
  title: string
  duration: number
  cameraKeyframes: {id: string; time: number; camera: SandboxCameraState; easing: 'linear' | 'smooth'}[]
  routeKeyframes: {id: string; time: number; progress: number}[]
  labels: {id: string; sourceId: string; name: string; coordinates: [number, number]; from: number; to: number}[]
  caption: {text: string; from: number; to: number}
  routeColor: string
}
export interface ShotEditorFrame {
  camera: SandboxCameraState | null
  routeProgress: number
  labels: ShotEditorPlan['labels']
  caption: string
}
const MAX_DURATION = 1800
const MAX_KEYS = 128
const MAX_LABELS = 200
const CAMERA_BOUND = 1e9
const fail = (): never => { throw new Error('Invalid shot editor plan') }

/** Reject inherited state, accessors, symbol fields and unexpected keys before reading values. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail()
  const names = Reflect.ownKeys(value)
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of keys) if (!descriptors[key] || !('value' in descriptors[key])) return fail()
  return value as Record<string, unknown>
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail()
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor)) return fail()
  }
  return value
}
function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) return fail()
  return value
}
function text(value: unknown, maximum: number, required = true): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) return fail()
  return value
}
function vector(value: unknown): [number, number, number] {
  const values = list(value, 3)
  if (values.length !== 3) return fail()
  return [number(values[0], -CAMERA_BOUND, CAMERA_BOUND), number(values[1], -CAMERA_BOUND, CAMERA_BOUND),
    number(values[2], -CAMERA_BOUND, CAMERA_BOUND)]
}
function camera(value: unknown): SandboxCameraState {
  const raw = object(value, ['position', 'target', 'fov'])
  const position = vector(raw.position), target = vector(raw.target)
  if (Math.hypot(...position.map((item, index) => item - target[index])) < 1e-6) return fail()
  return {position, target, fov: number(raw.fov, 5, 120)}
}
function unique<T extends {id: string; time: number}>(values: T[]): T[] {
  if (new Set(values.map(value => value.id)).size !== values.length
    || new Set(values.map(value => value.time)).size !== values.length) return fail()
  return values.sort((a, b) => a.time - b.time)
}
function interval(raw: Record<string, unknown>, duration: number): {from: number; to: number} {
  const from = number(raw.from, 0, duration), to = number(raw.to, 0, duration)
  if (to < from) return fail()
  return {from, to}
}

/** Validate and detach untrusted saved/imported data; invalid or unsupported versions return null. */
export function parseShotEditorPlan(value: unknown, expectedTrackId?: string): ShotEditorPlan | null {
  try {
    if (typeof value === 'string') {
      if (value.length > 2_000_000) return null
      value = JSON.parse(value)
    }
    const raw = object(value, ['version', 'trackId', 'fingerprint', 'sceneFingerprint', 'title', 'duration',
      'cameraKeyframes', 'routeKeyframes', 'labels', 'caption', 'routeColor'])
    if (raw.version !== 1) return null
    const trackId = text(raw.trackId, 160)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(trackId) || (expectedTrackId !== undefined && trackId !== expectedTrackId)) return null
    const duration = number(raw.duration, 1, MAX_DURATION)
    const cameraKeyframes = unique(list(raw.cameraKeyframes, MAX_KEYS).map(value => {
      const key = object(value, ['id', 'time', 'camera', 'easing'])
      if (key.easing !== 'linear' && key.easing !== 'smooth') return fail()
      return {id: text(key.id, 128), time: number(key.time, 0, duration), camera: camera(key.camera), easing: key.easing as 'linear' | 'smooth'}
    }))
    const routeKeyframes = unique(list(raw.routeKeyframes, MAX_KEYS).map(value => {
      const key = object(value, ['id', 'time', 'progress'])
      return {id: text(key.id, 128), time: number(key.time, 0, duration), progress: number(key.progress, 0, 1)}
    }))
    const labels = list(raw.labels, MAX_LABELS).map(value => {
      const label = object(value, ['id', 'sourceId', 'name', 'coordinates', 'from', 'to'])
      const coordinates = list(label.coordinates, 2)
      if (coordinates.length !== 2) return fail()
      return {id: text(label.id, 128), sourceId: text(label.sourceId, 200), name: text(label.name, 160),
        coordinates: [number(coordinates[0], -180, 180), number(coordinates[1], -90, 90)] as [number, number],
        ...interval(label, duration)}
    })
    if (new Set(labels.map(label => label.id)).size !== labels.length) return null
    const caption = object(raw.caption, ['text', 'from', 'to'])
    const routeColor = text(raw.routeColor, 7)
    if (!/^#[\da-f]{6}$/iu.test(routeColor)) return null
    return {version: 1, trackId, fingerprint: text(raw.fingerprint, 256), sceneFingerprint: text(raw.sceneFingerprint, 256),
      title: text(raw.title, 160), duration, cameraKeyframes, routeKeyframes, labels,
      caption: {text: text(caption.text, 1200, false), ...interval(caption, duration)}, routeColor}
  } catch { return null }
}
const copyCamera = (value: SandboxCameraState): SandboxCameraState => ({
  position: [...value.position], target: [...value.target], fov: value.fov,
})
function cameraInterval(keys: ShotEditorPlan['cameraKeyframes'], time: number): SandboxCameraState | null {
  if (!keys.length) return null
  const ordered = [...keys].sort((a, b) => a.time - b.time)
  if (time <= ordered[0].time) return copyCamera(ordered[0].camera)
  if (time >= ordered[ordered.length - 1].time) return copyCamera(ordered[ordered.length - 1].camera)
  const right = ordered.findIndex(key => key.time >= time), from = ordered[right - 1], to = ordered[right]
  let fraction = (time - from.time) / (to.time - from.time)
  // Easing belongs to the outgoing interval. It never alters movie time or route time.
  if (from.easing === 'smooth') fraction = fraction * fraction * (3 - 2 * fraction)
  const blend = (a: number, b: number) => a + (b - a) * fraction
  return {position: from.camera.position.map((value, index) => blend(value, to.camera.position[index])) as [number, number, number],
    target: from.camera.target.map((value, index) => blend(value, to.camera.target[index])) as [number, number, number],
    fov: blend(from.camera.fov, to.camera.fov)}
}
function routeInterval(keys: ShotEditorPlan['routeKeyframes'], time: number): number {
  if (!keys.length) return 1
  const ordered = [...keys].sort((a, b) => a.time - b.time)
  if (time <= ordered[0].time) return ordered[0].progress
  if (time >= ordered[ordered.length - 1].time) return ordered[ordered.length - 1].progress
  const right = ordered.findIndex(key => key.time >= time), from = ordered[right - 1], to = ordered[right]
  return from.progress + (to.progress - from.progress) * (time - from.time) / (to.time - from.time)
}

/** Pure random-access evaluation: playback, reverse seeks and recording all use this function. */
export function evaluateShotEditorFrame(plan: ShotEditorPlan, requestedTime: number): ShotEditorFrame {
  const time = Number.isFinite(requestedTime) ? Math.max(0, Math.min(plan.duration, requestedTime))
    : requestedTime === Infinity ? plan.duration : 0
  return {camera: cameraInterval(plan.cameraKeyframes, time), routeProgress: routeInterval(plan.routeKeyframes, time),
    labels: plan.labels.filter(label => label.from <= time && time <= label.to)
      .map(label => ({...label, coordinates: [...label.coordinates] as [number, number]})),
    caption: plan.caption.from <= time && time <= plan.caption.to ? plan.caption.text : ''}
}
export function createShotEditorPlan(input: {trackId: string; fingerprint: string; sceneFingerprint: string;
  title: string; camera: SandboxCameraState | null}): ShotEditorPlan {
  const start = input.camera ? camera(input.camera) : null
  let end: SandboxCameraState | null = null
  if (start) {
    const [x, y, z] = start.position.map((value, index) => value - start.target[index])
    const angle = Math.PI / 15, scale = 1.15
    end = {target: [...start.target], fov: start.fov, position: [
      start.target[0] + (x * Math.cos(angle) + z * Math.sin(angle)) * scale,
      start.target[1] + y * scale,
      start.target[2] + (z * Math.cos(angle) - x * Math.sin(angle)) * scale,
    ]}
  }
  const plan: ShotEditorPlan = {version: 1, trackId: input.trackId, fingerprint: input.fingerprint,
    sceneFingerprint: input.sceneFingerprint, title: input.title, duration: 20,
    cameraKeyframes: start && end ? [{id: 'camera-start', time: 0, camera: start, easing: 'smooth'},
      {id: 'camera-end', time: 20, camera: end, easing: 'smooth'}] : [],
    routeKeyframes: [{id: 'route-start', time: 0, progress: 0}, {id: 'route-hold', time: 4, progress: 0},
      {id: 'route-drawn', time: 13, progress: 1}, {id: 'route-end', time: 20, progress: 1}],
    labels: [], caption: {text: '', from: 0, to: 20}, routeColor: TRACK_COLOR}
  const valid = parseShotEditorPlan(plan, input.trackId)
  if (!valid) throw new Error('镜头草稿的轨迹或相机数据无效')
  return valid
}

/** Includes source samples and canonical breaks; equivalent break orderings yield the same identity. */
export function shotEditorTrackFingerprint(points: readonly TrackPoint[], segmentStarts: readonly number[] = []): string {
  const breaks = [0, ...new Set(segmentStarts.filter(index => Number.isInteger(index) && index > 0 && index < points.length))]
    .sort((a, b) => a - b)
  const content = JSON.stringify({points: points.map(point => point.map(value =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value)), segmentStarts: breaks})
  let first = 2166136261, second = 3335557771
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 2246822519)
  }
  return 'se1-' + (first >>> 0).toString(36) + '-' + (second >>> 0).toString(36)
}
