/**
 * Flattening a GeoJSON object down to the point list the panel stores.
 *
 * The two vendor parsers disagree on geometry kind: KML yields whatever the
 * document contains (`LineString`, `MultiLineString`, and more), TCX only ever
 * yields `LineString` / `MultiLineString`. Everything downstream — the map
 * layer, the elevation profile, the statistics — wants one flat `TrackPoint[]`,
 * so this is where the shapes are reconciled.
 *
 * Timestamps ride along out-of-band in `properties.coordinateProperties.times`,
 * which is the convention @tmcw/togeojson uses and the one the vendored
 * elevation profile reads.
 */
import type { TrackPoint } from '../protocol.ts'

/** A position as GeoJSON shapes it: `[lon, lat]` or `[lon, lat, ele]`. */
type Position = readonly number[]

type Geometry = {
  type: string
  coordinates?: unknown
}

export interface FlattenedTrack {
  points: TrackPoint[]
  /** Track name the file itself carries, when it has one. */
  name: string
  /** Earliest / latest timestamp seen, as epoch milliseconds. */
  startedAt: number | null
  endedAt: number | null
}

/** Epoch milliseconds a timestamp may hold, or null when absent/invalid. */
function toEpoch(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The trailing element of a TCX position, which is not an elevation.
 *
 * `toGeoJSON` writes a `Trackpoint`'s time into `coordinates` as a fourth
 * element — `[lon, lat, altitude, "2026-09-20T01:00:00Z"]` — as well as into
 * `coordinateProperties.times`. Reading that slot as a number would turn every
 * TCX elevation into `NaN`; the times array is the better source when it is
 * there, and this is the fallback for when it is not.
 */
function timeOf(position: Position): number | null {
  const trailing = position[3]
  return typeof trailing === 'string' ? toEpoch(trailing) : null
}

/**
 * Every geometry a GeoJSON object holds, however deeply nested, in document
 * order — which is also the order `coordinateProperties.times` run in.
 */
function* geometriesOf(geoJson: unknown): Generator<Geometry> {
  if (!geoJson || typeof geoJson !== 'object') return
  const node = geoJson as {type?: string; features?: unknown; geometry?: unknown; geometries?: unknown}
  switch (node.type) {
    case 'FeatureCollection':
      for (const feature of Array.isArray(node.features) ? node.features : []) yield* geometriesOf(feature)
      return
    case 'Feature':
      yield* geometriesOf(node.geometry)
      return
    case 'GeometryCollection':
      for (const geometry of Array.isArray(node.geometries) ? node.geometries : []) yield* geometriesOf(geometry)
      return
    case 'LineString':
    case 'MultiLineString':
    case 'Polygon':
    case 'MultiPolygon':
      yield node as Geometry
      return
    default:
      // `Point` and anything unknown carries no line to draw.
      return
  }
}

/**
 * How many nested arrays sit between `coordinates` and a single position, or -1
 * for a geometry we do not draw. `LineString` is one, not zero: its coordinates
 * *are* the list of positions, so the walk has to descend once to reach them.
 */
function nestDepth(type: string): number {
  switch (type) {
    case 'LineString': return 1
    case 'MultiLineString':
    case 'Polygon': return 2
    case 'MultiPolygon': return 3
    default: return -1
  }
}

function positionsOf(geometry: Geometry): Position[] {
  const depth = nestDepth(typeof geometry.type === 'string' ? geometry.type : '')
  if (depth < 0 || !Array.isArray(geometry.coordinates)) return []
  const positions: Position[] = []
  const walk = (value: unknown, level: number) => {
    if (!Array.isArray(value)) return
    if (level === 0) {
      positions.push(value as Position)
      return
    }
    for (const child of value) walk(child, level - 1)
  }
  walk(geometry.coordinates, depth)
  return positions
}

/**
 * One position into a `TrackPoint`. Non-numeric or non-finite longitude /
 * latitude drop the point — a half-written GPS fix is worse than a gap.
 */
function toPoint(position: Position, time: number | null): TrackPoint | null {
  if (!Array.isArray(position) || position.length < 2) return null
  const lon = Number(position[0])
  const lat = Number(position[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  const rawElevation = position[2]
  const elevation = typeof rawElevation === 'number' && Number.isFinite(rawElevation) ? rawElevation : null
  return [lon, lat, elevation, time ?? timeOf(position)]
}

/** All `coordinateProperties.times` in the collection, in document order. */
function timesOf(geoJson: unknown): (number | null)[] {
  const times: (number | null)[] = []
  if (!geoJson || typeof geoJson !== 'object') return times
  const features = (geoJson as {features?: unknown}).features
  for (const feature of Array.isArray(features) ? features : []) {
    const properties = (feature as {properties?: {coordinateProperties?: {times?: unknown}}})?.properties
    const list = properties?.coordinateProperties?.times
    if (!Array.isArray(list)) continue
    for (const value of list) times.push(toEpoch(value))
  }
  return times
}

/** Name carried by the document's first named feature, if any. */
function nameOf(geoJson: unknown): string {
  const features = (geoJson as {features?: unknown})?.features
  for (const feature of Array.isArray(features) ? features : []) {
    const name = (feature as {properties?: {name?: unknown}})?.properties?.name
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return ''
}

function timeRange(points: readonly TrackPoint[]): {startedAt: number | null; endedAt: number | null} {
  let startedAt: number | null = null
  let endedAt: number | null = null
  for (const point of points) {
    const time = point[3]
    if (time === null) continue
    if (startedAt === null || time < startedAt) startedAt = time
    if (endedAt === null || time > endedAt) endedAt = time
  }
  return {startedAt, endedAt}
}

/**
 * GeoJSON → flat point list. Used for the KML / TCX halves, which have no
 * native model of their own (GPX keeps its own reader so elevation-less points
 * stay elevation-less rather than being flattened to 0).
 */
export function flattenGeoJSON(geoJson: unknown, fallbackName = ''): FlattenedTrack {
  const times = timesOf(geoJson)
  const points: TrackPoint[] = []
  let cursor = 0

  for (const geometry of geometriesOf(geoJson)) {
    const positions = positionsOf(geometry)
    for (let index = 0; index < positions.length; index += 1) {
      const point = toPoint(positions[index], times[cursor + index] ?? null)
      if (point) points.push(point)
    }
    // Advance by positions *seen*, not points kept, so a dropped fix does not
    // shift every later timestamp onto the wrong coordinate.
    cursor += positions.length
  }

  return {points, name: fallbackName || nameOf(geoJson), ...timeRange(points)}
}
