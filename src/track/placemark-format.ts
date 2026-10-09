import type {PlacemarkTimeSource, TrackPlacemark} from '../protocol.ts'
import { formatDateTime } from './format.ts'

/** Earlier imports invented numbered titles; keep those out of the photo captions. */
export function placemarkTitle(point: TrackPlacemark): string {
  const name = point.name.trim()
  if (point.elevation === undefined && point.time === undefined && /^kml-\d+$/u.test(point.id)
    && name === `标注点 ${point.id.slice(4)}`) return ''
  return name
}

export function formatPlacemarkElevation(elevation?: number | null): string {
  return elevation === null || elevation === undefined || !Number.isFinite(elevation)
    ? '' : `海拔 ${Math.round(elevation)} m`
}

export function formatPlacemarkTime(time?: number | null, timeSource?: PlacemarkTimeSource): string {
  if (time === null || time === undefined || typeof time !== 'number' || !Number.isFinite(time)) return timeSource === 'unknown' ? '时间未知' : ''
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return timeSource === 'unknown' ? '时间未知' : ''
  const text = `${formatDateTime(date.toISOString())}:${String(date.getSeconds()).padStart(2, '0')}`
  return timeSource === 'estimated' ? `${text}（估算）` : text
}

export function formatPlacemarkCoordinates(coordinates: readonly [number, number]): string {
  return `经度 ${coordinates[0].toFixed(6)} · 纬度 ${coordinates[1].toFixed(6)}`
}
