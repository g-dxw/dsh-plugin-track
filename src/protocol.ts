/**
 * Loopback HTTP surface shared by the host half and the browser panel.
 *
 * Parsing happens in the browser (the renderer already has `DOMParser`, and the
 * panel has to draw with no network at all), so the host half is just a store:
 * it takes a parsed track and an original file, and hands them back later.
 */

export const API = '/api/cqai-track'
/** Bump when imported statistics need to be recalculated from the retained source. */
export const METRICS_VERSION = 2

/** Track files the panel accepts, keyed by the extension it dispatches on. */
export const TRACK_EXTENSIONS = ['gpx', 'kml', 'tcx'] as const

/** A filename extension the panel knows how to parse. */
export type TrackExtension = typeof TRACK_EXTENSIONS[number]

/**
 * `[lon, lat, ele, time]`, the storage form of one track point.
 *
 * `ele` (metres) and `time` (epoch milliseconds) are nullable because plenty of
 * GPX files carry neither; the track still draws, it just has no profile. A
 * positional tuple rather than an object: a long ride is tens of thousands of
 * points, and the difference between the two spellings is hundreds of
 * kilobytes of JSON per track.
 */
export type TrackPoint = [number, number, number | null, number | null]

/** A stable attachment distinguishing repeated visits along a route. */
export interface RoutePosition {startIndex: number; endIndex: number; fraction: number}
export type PlacemarkTimeSource = 'track' | 'estimated' | 'unknown'

/** KML locations are independent from the measured track path. */
export interface TrackPlacemark {
  id: string
  name: string
  coordinates: [number, number]
  description: string
  images: string[]
  /** Selected point types; older records keep one string. Empty text or [] clears them. */
  type?: string | string[]
  /** Hidden points retain their identity and data so they can be shown again. */
  hidden?: boolean
  /** Metres from this point's KML coordinates; absent on older records. */
  elevation?: number | null
  /** This point's own TimeStamp, as epoch milliseconds; absent on older records. */
  time?: number | null
  routePosition?: RoutePosition
  timeSource?: PlacemarkTimeSource
}

/** A local presentation group references original points without changing them. */
export interface PlacemarkGroup {
  id: string
  name: string
  description: string
  memberIds: string[]
  coordinates: [number, number]
  cover?: {pointId: string; imageUrl: string}
  hidden?: boolean
}

/** What the panel computes once, at import, and the list view reads back. */
export interface TrackMetrics {
  /** Total length along the path, in metres. */
  distance: number
  /** Cumulative positive elevation change, in metres. */
  elevationGain: number
  /** Cumulative negative elevation change, in metres. */
  elevationLoss: number
  /** Elapsed milliseconds from recorded point times or an explicit file summary. */
  duration: number
  /** Absent in records imported before the current calculation method. */
  calculationVersion?: number
  /** Largest elevation seen, in metres, or null when the track has none. */
  elevationMax: number | null
  /** Smallest elevation seen, in metres, or null when the track has none. */
  elevationMin: number | null
  /** `[minLon, minLat, maxLon, maxLat]`, or null for a track with no points. */
  bbox: [number, number, number, number] | null
}

/** Everything stored for one track, minus the point array. */
export interface TrackSummary {
  /** Stable local id, also the directory name under `<DSH home>/track`. */
  id: string
  /** Imported filename stem, or a user-supplied title for edited/new tracks. */
  name: string
  /** Original filename as the user picked it. */
  filename: string
  /** Lowercase extension the file was parsed as. */
  format: TrackExtension
  /** ISO timestamp of import. */
  createdAt: string
  /** Size of the original file in bytes. */
  bytes: number
  /** Point count, so the list can show it without loading the points. */
  points: number
  /** Derived statistics, computed at import time. */
  metrics: TrackMetrics
}

/** A stored track with its points; only the detail endpoint returns this. */
export interface TrackRecord extends TrackSummary {
  /** The path, in storage form. */
  coordinates: TrackPoint[]
  placemarks?: TrackPlacemark[]
  /** First point of each connected part; omitted on legacy imports. */
  segmentStarts?: number[]
}

/**
 * What the panel posts. The points and the original text travel together so
 * the host writes both in one request — a track whose source file is missing
 * would break the "export original" button.
 */
export interface TrackInput {
  /** Display name, or empty to fall back to the filename. */
  name?: string
  /** Original filename, extension included. */
  filename: string
  /** Original file text, stored verbatim for re-export. */
  source: string
  /** The parsed path. */
  points: TrackPoint[]
  placemarks?: TrackPlacemark[]
  /** First point of each connected part; omitted on legacy imports. */
  segmentStarts?: number[]
  /** Statistics the panel already computed. */
  metrics: TrackMetrics
}

/**
 * The panel's own upload constraint, mirrored from
 * `cqai-dsh-plugin-video`'s `validateUpload`: one place that decides what a
 * track file may be, so the two halves cannot drift.
 */
export const UPLOADS = {
  /** Cap on the original file text, in bytes. A 8 MB GPX is already a very long day out. */
  maxSourceBytes: 8 * 1024 * 1024,
  /** Cap on the request body, which carries the file plus the parsed points. */
  maxRequestBytes: 24 * 1024 * 1024,
  /** Cap on the point count. Beyond this the map stops being readable anyway. */
  maxPoints: 500_000,
  /** Extensions the panel will look at, lowercased without the dot. */
  extensions: TRACK_EXTENSIONS,
} as const

/** Why a file was refused, or `null` when it is acceptable. */
export function validateUpload(filename: string, source: string): string | null {
  if (!filename.trim()) return '文件名不能为空'
  const extension = extensionOf(filename)
  if (!extension) return `只支持 ${UPLOADS.extensions.join(' / ').toUpperCase()} 文件`
  // The tuple is `as const`, so `includes` is typed against the three known
  // extensions; the argument is whatever the user's filename held.
  if (!(UPLOADS.extensions as readonly string[]).includes(extension)) {
    return `暂不支持 .${extension} 文件，请使用 ${UPLOADS.extensions.join(' / ').toUpperCase()}`
  }
  if (!source.trim()) return '文件内容为空'
  if (byteLength(source) > UPLOADS.maxSourceBytes) return `文件过大，上限 ${Math.round(UPLOADS.maxSourceBytes / 1048576)} MB`
  return null
}

/** Lowercased extension without the dot, or `''` when there is none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase()
}

/** UTF-8 byte length, which is what the caps above are counted in. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
