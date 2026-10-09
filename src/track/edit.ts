import { METRICS_VERSION, type TrackMetrics, type TrackPoint } from '../protocol.ts'
import { pointMetrics } from './metrics.ts'

export interface EditPart {
  id: string
  name: string
  points: TrackPoint[]
}

/** Each edit returns a new outer array; unchanged tuples can safely be shared. */
export function movePoint(points: readonly TrackPoint[], index: number, lon: number, lat: number): TrackPoint[] {
  pointIndex(points, index)
  const next = points.slice()
  // A recorded height/time describes the old location, not a moved map handle.
  next[index] = drawnPoint(lon, lat)
  return next
}

/** index is the insertion position, including before the first/after the last. */
export function insertPoint(points: readonly TrackPoint[], index: number, lon: number, lat: number): TrackPoint[] {
  if (!Number.isInteger(index) || index < 0 || index > points.length) throw new Error('插入位置无效')
  return [...points.slice(0, index), drawnPoint(lon, lat), ...points.slice(index)]
}

/** Empty drafts are allowed; saving a track applies the minimum point count. */
export function deletePoint(points: readonly TrackPoint[], index: number): TrackPoint[] {
  pointIndex(points, index)
  return [...points.slice(0, index), ...points.slice(index + 1)]
}

export function reversePoints(points: readonly TrackPoint[]): TrackPoint[] {
  return points.slice().reverse()
}

/** The selected internal point is the end of the first and start of the second. */
export function splitPoints(points: readonly TrackPoint[], index: number): [TrackPoint[], TrackPoint[]] {
  if (!Number.isInteger(index) || index <= 0 || index >= points.length - 1) throw new Error('请选择内部轨迹点拆分，两段都至少需要 2 个点')
  const first = points.slice(0, index + 1)
  const second = points.slice(index)
  first[first.length - 1] = [...points[index]]
  second[0] = [...points[index]]
  return [first, second]
}

/** Join in the chosen order, removing only an identical tuple at each join. */
export function joinPoints(parts: readonly (readonly TrackPoint[])[]): TrackPoint[] {
  const joined: TrackPoint[] = []
  for (const part of parts) {
    if (!part.length) continue
    const previous = joined[joined.length - 1]
    const first = part[0]
    const offset = previous && previous.every((value, index) => value === first[index]) ? 1 : 0
    for (let index = offset; index < part.length; index++) joined.push(part[index])
  }
  return joined
}

/** Replace the path between the selected endpoints with a manual connection. */
export function connectPoints(points: readonly TrackPoint[], startIndex: number, endIndex: number, via: readonly TrackPoint[] = []): TrackPoint[] {
  pointIndex(points, startIndex)
  pointIndex(points, endIndex)
  if (startIndex >= endIndex) throw new Error('连接终点必须在起点之后')
  return [
    ...points.slice(0, startIndex + 1),
    ...via.map(point => drawnPoint(point[0], point[1])),
    ...points.slice(endIndex),
  ]
}

/**
 * Edited paths may mix recorded and drawn points. Missing elevation breaks the
 * climb accumulator instead of fabricating a descent/climb through sea level.
 * Distance, time range and raw extrema keep the existing metric conventions.
 */
export function editedMetrics(points: readonly TrackPoint[]): TrackMetrics {
  return {...pointMetrics(points), calculationVersion: METRICS_VERSION}
}

function pointIndex(points: readonly TrackPoint[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= points.length) throw new Error('轨迹点位置无效')
}

function drawnPoint(lon: number, lat: number): TrackPoint {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new Error('轨迹坐标无效，经度需在 -180 至 180，纬度需在 -90 至 90')
  }
  return [lon, lat, null, null]
}
