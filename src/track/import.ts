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
import type Waypoint from './model/waypoint.ts'
import { flattenGeoJSON } from './geometry.ts'
import { pointMetrics, type PointMetrics } from './metrics.ts'
import { kml, tcx } from './vendor/toGeoJSON.ts'
import {
  extensionOf, UPLOADS, validateUpload,
  type TrackExtension, type TrackPoint,
} from '../protocol.ts'

export interface ParsedTrack {
  /** Name from the file's own metadata, or `''` when it carries none. */
  name: string
  /** Lowercase extension this was parsed as. */
  format: TrackExtension
  points: TrackPoint[]
  metrics: PointMetrics
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
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  const elevation = typeof waypoint.ele === 'number' && Number.isFinite(waypoint.ele) ? waypoint.ele : null
  const time = waypoint.time instanceof Date && Number.isFinite(waypoint.time.getTime())
    ? waypoint.time.getTime()
    : null
  return [lon, lat, elevation, time]
}

/** Document name: the metadata block first, then the first track's own name. */
function nameOfGpx(gpx: GPX): string {
  const candidates: unknown[] = [gpx.metadata?.name, ...(gpx.trk ?? []).map(track => track.name)]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return ''
}

function parseGpx(source: string): Pick<ParsedTrack, 'name' | 'points'> {
  const gpx = GPX.parse(source)
  const points: TrackPoint[] = []
  for (const waypoint of gpx.flatten()) {
    const point = pointOf(waypoint)
    if (point) points.push(point)
  }
  if (!points.length && !gpx.trk?.length && !gpx.rte?.length && !gpx.wpt?.length) {
    throw new Error('这不是 GPX 轨迹文件：文件里没有 <trk>、<rte> 或 <wpt>')
  }
  return {name: nameOfGpx(gpx), points}
}

/** KML and TCX share the vendored reader and its `[lon, lat, ele]` ordering. */
function parseViaGeoJson(source: string, format: 'kml' | 'tcx'): Pick<ParsedTrack, 'name' | 'points'> {
  const label = FORMAT_LABEL[format]
  const document = readXml(source, label)
  const root = document.documentElement.nodeName.toLowerCase()
  if (format === 'kml' && root !== 'kml') throw new Error('不是合法的 KML 文件：缺少 <kml> 根元素')
  if (format === 'tcx' && root !== 'trainingcenterdatabase') {
    throw new Error('不是合法的 TCX 文件：缺少 <TrainingCenterDatabase> 根元素')
  }
  const flattened = flattenGeoJSON(format === 'kml' ? kml(document) : tcx(document))
  return {name: flattened.name, points: flattened.points}
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
  const {name, points} = format === 'gpx' ? parseGpx(source) : parseViaGeoJson(source, format)

  if (!points.length) throw new Error(`${FORMAT_LABEL[format]} 文件里没有可用的坐标点`)
  if (points.length > UPLOADS.maxPoints) {
    throw new Error(`轨迹点过多（${points.length}），上限 ${UPLOADS.maxPoints}`)
  }

  return {name, format, points, metrics: pointMetrics(points)}
}
