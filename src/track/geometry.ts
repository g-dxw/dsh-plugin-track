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

/** Positions may also carry a vendor timestamp in their fourth slot. */
type Position = readonly unknown[]

type Geometry = {
  type: string
  coordinates?: unknown
}

type Feature = {
  geometry?: unknown
  properties?: {name?: unknown; coordinateProperties?: {times?: unknown}}
}

export interface FlattenedTrack {
  points: TrackPoint[]
  /** Source line/run boundaries in the flattened array. */
  segmentStarts: number[]
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
 * `coordinateProperties.times`. The position's own timestamp is authoritative:
 * the vendor's separate array can omit a missing time and shift later entries.
 */
function timeOf(position: Position): number | null {
  return toEpoch(position[3])
}

/** Feature boundaries also delimit timestamp arrays; they must never be zipped globally. */
function* featuresOf(geoJson: unknown): Generator<Feature> {
  if (!geoJson || typeof geoJson !== 'object') return
  const node = geoJson as {type?: string; features?: unknown}
  if (node.type === 'FeatureCollection') {
    for (const feature of Array.isArray(node.features) ? node.features : []) yield* featuresOf(feature)
  } else if (node.type === 'Feature') {
    yield geoJson as Feature
  } else {
    // Bare geometries remain usable, with their own fourth-slot timestamps.
    yield {geometry: geoJson}
  }
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

function positionsOf(geometry: Geometry): {positions: Position[]; starts: Set<number>} {
  const depth = nestDepth(typeof geometry.type === 'string' ? geometry.type : '')
  const positions: Position[] = [], starts = new Set<number>()
  if (depth < 0 || !Array.isArray(geometry.coordinates)) return {positions, starts}
  const walk = (value: unknown, level: number) => {
    if (!Array.isArray(value)) return
    if (level === 0) {
      positions.push(value as Position)
      return
    }
    if (level === 1) starts.add(positions.length)
    for (const child of value) walk(child, level - 1)
  }
  walk(geometry.coordinates, depth)
  return {positions, starts}
}

/**
 * One position into a `TrackPoint`. Non-numeric or non-finite longitude /
 * latitude drop the point — a half-written GPS fix is worse than a gap.
 */
function toPoint(position: Position, time: number | null): TrackPoint | null {
  if (!Array.isArray(position) || position.length < 2) return null
  const lon = position[0], lat = position[1]
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)
    || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null
  const rawElevation = position[2]
  const elevation = typeof rawElevation === 'number' && Number.isFinite(rawElevation) ? rawElevation : null
  return [lon, lat, elevation, timeOf(position) ?? time]
}

/** Flatten a timestamp list without dropping null / invalid placeholders. */
function flatTimesOf(value: unknown): (number | null)[] {
  const times: (number | null)[] = []
  const walk = (child: unknown) => {
    if (Array.isArray(child)) {
      for (const value of child) walk(value)
    } else {
      times.push(toEpoch(child))
    }
  }
  if (Array.isArray(value)) walk(value)
  return times
}

/** Match nested line / polygon time arrays to the same coordinate branches. */
function shapedTimesOf(geometry: Geometry, value: unknown): (number | null)[] {
  if (!Array.isArray(value) || !value.some(Array.isArray)) return flatTimesOf(value)
  const times: (number | null)[] = []
  const walk = (coordinates: unknown, depth: number, branchTimes: unknown) => {
    if (!Array.isArray(coordinates)) return
    if (depth === 0) {
      times.push(toEpoch(branchTimes))
      return
    }
    for (let index = 0; index < coordinates.length; index += 1) {
      walk(coordinates[index], depth - 1, Array.isArray(branchTimes) ? branchTimes[index] : undefined)
    }
  }
  walk(geometry.coordinates, nestDepth(geometry.type), value)
  return times
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
  const points: TrackPoint[] = [], segmentStarts: number[] = []
  let name = ''

  for (const feature of featuresOf(geoJson)) {
    const geometries = [...geometriesOf(feature.geometry)]
    const featureTimes = feature.properties?.coordinateProperties?.times
    const flatTimes = geometries.length > 1 ? flatTimesOf(featureTimes) : []
    const groupedTimes = geometries.length > 1 && Array.isArray(featureTimes)
      && featureTimes.length === geometries.length && featureTimes.some(Array.isArray)
    let cursor = 0

    for (let geometryIndex = 0; geometryIndex < geometries.length; geometryIndex += 1) {
      const geometry = geometries[geometryIndex]
      const {positions, starts} = positionsOf(geometry)
      const times = groupedTimes
        ? shapedTimesOf(geometry, featureTimes[geometryIndex])
        : geometries.length === 1 ? shapedTimesOf(geometry, featureTimes) : flatTimes.slice(cursor, cursor + positions.length)
      let newRun = true
      for (let index = 0; index < positions.length; index += 1) {
        if (starts.has(index)) newRun = true
        const point = toPoint(positions[index], times[index] ?? null)
        if (point) {
          if (newRun) segmentStarts.push(points.length)
          newRun = false
          points.push(point)
          const candidate = feature.properties?.name
          if (!name && typeof candidate === 'string' && candidate.trim()) name = candidate.trim()
        } else newRun = true
      }
      // Invalid fixes retain their slots so every later timestamp stays aligned.
      cursor += positions.length
    }
  }

  return {points, segmentStarts, name: fallbackName || name, ...timeRange(points)}
}
