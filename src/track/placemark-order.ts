import type { TrackPlacemark } from '../protocol.ts'

/** Valid dates first; equal or unavailable timestamps retain source order. */
export function chronologicalPlacemarks(points: TrackPlacemark[]): TrackPlacemark[] {
  const time = (point: TrackPlacemark) => typeof point.time === 'number' && Number.isFinite(point.time)
    && Math.abs(point.time) <= 8.64e15 ? point.time : Infinity
  const sorted = points.map((point, index) => ({point, index, time: time(point)}))
    .sort((left, right) => left.time === right.time ? left.index - right.index : left.time - right.time)
    .map(item => item.point)
  return sorted.every((point, index) => point === points[index]) ? points : sorted
}

/** Unknown saved IDs are ignored; newly recovered points follow in time order. */
export function orderedPlacemarks(points: TrackPlacemark[], order: readonly string[] | null): TrackPlacemark[] {
  const chronological = chronologicalPlacemarks(points)
  if (order === null) return chronological
  const byId = new Map(chronological.map(point => [point.id, point]))
  const sorted: TrackPlacemark[] = []
  for (const id of order) {
    const point = byId.get(id)
    if (point) {sorted.push(point); byId.delete(id)}
  }
  for (const point of chronological) if (byId.delete(point.id)) sorted.push(point)
  return sorted.every((point, index) => point === points[index]) ? points : sorted
}

export function isPlacemarkOrder(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.length <= 10000
    && value.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 200)
    && new Set(value).size === value.length)
}
