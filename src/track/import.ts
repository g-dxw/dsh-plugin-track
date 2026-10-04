/**
 * File text → flat point list + statistics.
 *
 * This is the one place that knows how the three formats differ, and it runs in
 * the renderer for two reasons: the panel has to work with no network at all,
 * and the renderer already ships a `DOMParser`, which is the only thing the
 * readers need.
 *
 * GPX goes through the ported native model, which is the only reader that keeps
 * a missing `<ele>` genuinely missing (upstream's `toGeoJSON` would write `0`
 * and hand the elevation chart a flat sea-level profile for a phone recording
 * that simply had no barometer). KML and TCX have no native model here and go
 * through the vendored `toGeoJSON` reader.
 *
 * Every failure raises a message the panel can show verbatim — "不是合法的 GPX
 * 文件" tells the user which file to go and look at; "导入失败" does not.
 */
import GPX from './model/gpx.ts'
import {parseGpxXml} from './model/gpx-xml.ts'
import type Waypoint from './model/waypoint.ts'
import { flattenGeoJSON } from './geometry.ts'
import { pointMetrics } from './metrics.ts'
import { kml, tcx } from './vendor/toGeoJSON.ts'
import { parseKmlPlacemarks } from './placemarks.ts'
import {
  extensionOf, METRICS_VERSION, UPLOADS, validateUpload,
  type TrackExtension, type TrackPoint, type TrackPlacemark, type TrackMetrics,
} from '../protocol.ts'

export interface ParsedTrack {
  /** Default imported title: the filename without its final extension. */
  name: string
  /** Lowercase extension this was parsed as. */
  format: TrackExtension
  points: TrackPoint[]
  segmentStarts: number[]
  placemarks?: TrackPlacemark[]
  metrics: TrackMetrics
}

/** The label the user sees for each format, in error messages. */
const FORMAT_LABEL: Record<TrackExtension, string> = {gpx: 'GPX', kml: 'KML', tcx: 'TCX'}

/**
 * Parse the document, or explain why it is not one.
 *
 * `DOMParser` never throws on malformed XML — it hands back a document holding
 * a `<parsererror>` — so the check is a query, not a try/catch. The namespace
 * cleanup mirrors the GPX reader: writers that emit `xmlns=""` inside the body
 * break element resolution, and comments only slow the walk down.
 */
function readXml(source: string, label: string): Document {
  if (!/\S/u.test(source)) throw new Error(`${label} 文件是空的`)
  const cleaned = source.replace(/\sxmlns=""/gu, '').replace(/<!--[\s\S]*?-->/gu, '')
  const document = new DOMParser().parseFromString(cleaned, 'application/xml')
  const problem = document.getElementsByTagName('parsererror')[0] ?? document.querySelector('parsererror')
  if (problem) throw new Error(`不是合法的 ${label} 文件：XML 语法错误`)
  if (!document.documentElement) throw new Error(`不是合法的 ${label} 文件：没有根元素`)
  return document
}

/** A `Waypoint` from the GPX model into storage form; null when unusable. */
function pointOf(waypoint: Waypoint): TrackPoint | null {
  const lon = waypoint.$.lon
  const lat = waypoint.$.lat
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null
  const elevation = typeof waypoint.ele === 'number' && Number.isFinite(waypoint.ele) ? waypoint.ele : null
  const time = waypoint.time instanceof Date && Number.isFinite(waypoint.time.getTime())
    ? waypoint.time.getTime()
    : null
  return [lon, lat, elevation, time]
}

function parseGpx(source: string): {points: TrackPoint[]; segmentStarts: number[]} {
  const object = parseGpxXml(source)
  // Bare empty line elements read as undefined, which the native model cannot construct.
  // Keep empty fixes as invalid slots so the next valid fix starts a separate run.
  const list = (value: any): any[] => Array.isArray(value) ? value : value ? [value] : []
  object.trk = list(object.trk).filter(track => track && typeof track === 'object').map(track => ({...track,
    trkseg: list(track.trkseg).filter(segment => segment && typeof segment === 'object').map(segment => ({...segment,
      trkpt: list(segment.trkpt).map(point => point && typeof point.$?.lon === 'number' && typeof point.$?.lat === 'number'
        && Number.isFinite(point.$.lon) && Number.isFinite(point.$.lat)
        ? point : {$: {lon: Infinity, lat: Infinity}}),
    })),
  }))
  const gpx = GPX.fromObject(object)
  const points: TrackPoint[] = [], segmentStarts: number[] = []
  for (const track of gpx.trk || []) {
    for (const segment of track.trkseg || []) {
      let newRun = true
      for (const waypoint of segment.trkpt || []) {
        const point = pointOf(waypoint)
        if (!point) {newRun = true; continue}
        if (newRun) segmentStarts.push(points.length)
        newRun = false
        points.push(point)
      }
    }
  }
  if (!points.length && !gpx.trk?.length && !gpx.rte?.length && !gpx.wpt?.length) {
    throw new Error('这不是 GPX 轨迹文件：文件里没有 <trk>、<rte> 或 <wpt>')
  }
  return {points, segmentStarts}
}

/** KML and TCX share the vendored reader and its `[lon, lat, ele]` ordering. */
function parseViaGeoJson(source: string, format: 'kml' | 'tcx'): {points: TrackPoint[]; segmentStarts: number[]; duration: number} {
  const label = FORMAT_LABEL[format]
  const document = readXml(source, label)
  const root = document.documentElement.localName.toLowerCase()
  if (format === 'kml' && root !== 'kml') throw new Error('不是合法的 KML 文件：缺少 <kml> 根元素')
  if (format === 'tcx' && root !== 'trainingcenterdatabase') {
    throw new Error('不是合法的 TCX 文件：缺少 <TrainingCenterDatabase> 根元素')
  }
  const {points, segmentStarts} = flattenGeoJSON(format === 'kml' ? kml(document) : tcx(document))
  return {points, segmentStarts,
    duration: format === 'kml' ? kmlSummaryDuration(document) : 0}
}

/** Only explicit, unit-qualified summary fields describe elapsed route time.
 * Placemark timestamps and KML TimeSpan describe display validity/photos and
 * must not manufacture timestamps for an otherwise untimed route.
 */
function kmlSummaryDuration(document: Document): number {
  const scopes = Array.from(document.getElementsByTagName('*'))
    .filter(element => element.localName === 'Document')
  for (const scope of scopes) {
    const fields = new Map<string, string>()
    for (const extended of Array.from(scope.children).filter(child => child.localName === 'ExtendedData')) {
      for (const field of Array.from(extended.getElementsByTagName('*'))) {
        if (field.localName !== 'Data' && field.localName !== 'SimpleData') continue
        const name = field.getAttribute('name')
        const value = field.localName === 'Data'
          ? Array.from(field.children).find(child => child.localName === 'value')?.textContent
          : field.textContent
        if (name && value?.trim()) fields.set(name, value.trim())
      }
    }
    const positive = (name: string, multiplier = 1): number => {
      const value = fields.get(name)
      const parsed = value === undefined ? 0 : Number(value) * multiplier
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    }
    const duration = positive('TimeUsed') || positive('duration_seconds', 1000)
    if (duration) return duration
    const begin = positive('BeginTime')
    const end = positive('EndTime')
    if (begin && end > begin) return end - begin
    const startIso = fields.get('start_time')
    const endIso = fields.get('end_time')
    // Date-only labels are not recorded start/end times.
    if (startIso?.includes('T') && endIso?.includes('T')) {
      const elapsed = Date.parse(endIso) - Date.parse(startIso)
      if (Number.isFinite(elapsed) && elapsed > 0) return elapsed
    }
  }
  return 0
}

/**
 * Parse a track file. Throws a user-facing message on anything unusable; a
 * file that parses but holds no coordinates is refused rather than stored
 * empty, because an empty track has nothing to draw and nothing to report.
 */
export function parseTrackFile(filename: string, source: string): ParsedTrack {
  const problem = validateUpload(filename, source)
  if (problem) throw new Error(problem)

  const format = extensionOf(filename) as TrackExtension
  const parsed = format === 'gpx' ? {...parseGpx(source), duration: 0} : parseViaGeoJson(source, format)
  const {points} = parsed
  const name = filename.trim().replace(/\.[^.]+$/u, '').trim() || filename.trim()

  if (!points.length) throw new Error(`${FORMAT_LABEL[format]} 文件里没有可用的坐标点`)
  if (points.length > UPLOADS.maxPoints) {
    throw new Error(`轨迹点过多（${points.length}），上限 ${UPLOADS.maxPoints}`)
  }

  const metrics: TrackMetrics = {...pointMetrics(points), calculationVersion: METRICS_VERSION}
  if (!metrics.duration) metrics.duration = parsed.duration
  return {name, format, points, segmentStarts: parsed.segmentStarts, metrics, ...(format === 'kml' ? {placemarks: parseKmlPlacemarks(source)} : {})}
}
