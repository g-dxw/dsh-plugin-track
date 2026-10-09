import type { TrackPoint } from '../protocol.ts'

export interface PlaybackPath {
  /** Valid input coordinates in original order; invalid fixes are omitted. */
  points: readonly TrackPoint[]
  cumulativeDistances: readonly number[]
  totalDistance: number
}

export interface PlaybackSample {
  position: TrackPoint | null
  /** The point at/before the playhead, indexed into path.points. */
  index: number
  progress: number
  distance: number
}

/** Build once per track. No original point arrays or tuples are changed. */
export function createPlaybackPath(points: readonly TrackPoint[]): PlaybackPath {
  const valid: TrackPoint[] = []
  const cumulativeDistances: number[] = []
  let totalDistance = 0
  for (const point of points) {
    const [lon, lat, elevation, time] = point
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
    const safeElevation = finite(elevation)
    const safeTime = typeof time === 'number' && Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : null
    const safePoint: TrackPoint = elevation === safeElevation && time === safeTime ? point : [lon, lat, safeElevation, safeTime]
    const last = valid[valid.length - 1]
    if (last) totalDistance += distanceBetween(last, safePoint)
    valid.push(safePoint)
    cumulativeDistances.push(totalDistance)
  }
  return {points: valid, cumulativeDistances, totalDistance}
}

/** O(log n) distance lookup. Callers can draw a throttled/simplified walked line. */
export function samplePlayback(path: PlaybackPath, requestedProgress: number): PlaybackSample {
  const progress = clampProgress(requestedProgress)
  const {points, cumulativeDistances, totalDistance} = path
  if (!points.length) return {position: null, index: -1, progress, distance: 0}
  const distance = totalDistance * progress
  const last = points.length - 1
  if (progress === 1) return {position: [...points[last]], index: last, progress, distance: totalDistance}
  if (progress === 0 || totalDistance <= 1e-6) return {position: [...points[0]], index: 0, progress, distance}

  // Find the last cumulative distance <= target. This skips zero-length legs
  // and avoids scanning even when a track has hundreds of thousands of fixes.
  let left = 0
  let right = cumulativeDistances.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (cumulativeDistances[middle] <= distance) left = middle + 1
    else right = middle
  }
  const index = Math.max(0, Math.min(last, left - 1))
  if (index === last) return {position: [...points[last]], index, progress, distance}
  const segmentLength = cumulativeDistances[index + 1] - cumulativeDistances[index]
  const ratio = Math.max(0, Math.min(1, (distance - cumulativeDistances[index]) / segmentLength))
  const start = points[index]
  const end = points[index + 1]
  const longitudeDelta = ((end[0] - start[0] + 540) % 360) - 180
  const lon = wrapLongitude(start[0] + longitudeDelta * ratio)
  const lat = start[1] + (end[1] - start[1]) * ratio
  return {
    position: [lon, lat, interpolateNullable(start[2], end[2], ratio), interpolateNullable(start[3], end[3], ratio)],
    index,
    progress,
    distance,
  }
}

/** elapsedMs is the elapsed frame increment, independent of recorded GPX time. */
export function advancePlayback(progress: number, elapsedMs: number, durationMs: number): number {
  const current = clampProgress(progress)
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(durationMs)) return current
  if (durationMs <= 0) return 1
  return clampProgress(current + elapsedMs / durationMs)
}

function distanceBetween(start: TrackPoint, end: TrackPoint): number {
  const radians = Math.PI / 180
  const deltaLat = (end[1] - start[1]) * radians
  const deltaLon = (end[0] - start[0]) * radians
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(start[1] * radians) * Math.cos(end[1] * radians) * Math.sin(deltaLon / 2) ** 2
  // Floating-point rounding near antipodes must not make sqrt(1 - value) NaN.
  const a = Math.max(0, Math.min(1, value))
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? 1 : 0
  return Math.max(0, Math.min(1, value))
}
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function interpolateNullable(start: number | null, end: number | null, ratio: number): number | null {
  if (ratio === 0) return start
  if (ratio === 1) return end
  if (start === null || end === null) return null
  const difference = end - start
  // Opposite large finite elevations can overflow their difference.
  return Number.isFinite(difference) ? start + difference * ratio : start * (1 - ratio) + end * ratio
}
function wrapLongitude(lon: number): number { return ((lon + 180) % 360 + 360) % 360 - 180 }

