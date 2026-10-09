/**
 * Statistics over a flat point list.
 *
 * The climb thresholds originate in wanderer's `GpxMetricsComputation`
 * (AGPL-3.0 — see `src/track/LICENSE`). All import formats share this corrected
 * calculation: a five-sample elevation median removes isolated sensor noise,
 * route length includes the resulting vertical travel, and missing elevations
 * break the climb accumulator rather than being mistaken for sea level.
 */
import { haversineDistance } from './model/utils.ts'
import type { TrackPoint } from '../protocol.ts'

/** Travel below this many metres never moves the smoothing anchor. */
export const THRESHOLD_XY_M = 5
/** Elevation change below this many metres never counts as up or down. */
export const THRESHOLD_Z_M = 5

export interface PointMetrics {
  /** Summed slope distance in metres; legs without heights use horizontal distance. */
  distance: number
  elevationGain: number
  elevationLoss: number
  /** Milliseconds between the first and the last timestamped point. */
  duration: number
  elevationMax: number | null
  elevationMin: number | null
  bbox: [number, number, number, number] | null
}

/**
 * Use only complete windows of five measured heights. Endpoints and short
 * measured runs stay intact, and a missing height never gets interpolated.
 */
function filteredElevations(points: readonly TrackPoint[]): (number | null)[] {
  const elevations = points.map(point => Number.isFinite(point[2]) ? point[2] : null)
  return elevations.map((elevation, index) => {
    if (index < 2 || index >= elevations.length - 2 || elevation === null) return elevation
    const window = elevations.slice(index - 2, index + 3)
    if (window.some(value => value === null)) return elevation
    return (window as number[]).sort((a, b) => a - b)[2]
  })
}

/** Horizontal sampling is preserved; only the elevation profile is filtered. */
class MetricsAccumulator {
  private lastPoint: TrackPoint | null = null
  private lastElevation: number | null = null
  private lastFilteredPoint: TrackPoint | null = null
  private lastFilteredZ: number | null = null
  totalDistance = 0
  totalElevationGainSmoothed = 0
  totalElevationLossSmoothed = 0

  constructor(private readonly thresholdXY_m: number, private readonly thresholdZ_m: number) {}

  add(point: TrackPoint, elevation: number | null) {
    const [lon, lat] = point
    if (this.lastPoint) {
      const horizontal = haversineDistance(this.lastPoint[1], this.lastPoint[0], lat, lon)
      this.totalDistance += elevation !== null && this.lastElevation !== null
        ? Math.hypot(horizontal, elevation - this.lastElevation)
        : horizontal
    }
    this.lastPoint = point
    this.lastElevation = elevation

    if (elevation === null) {
      this.lastFilteredPoint = null
      this.lastFilteredZ = null
      return
    }
    if (!this.lastFilteredPoint || this.lastFilteredZ === null) {
      this.lastFilteredPoint = point
      this.lastFilteredZ = elevation
      return
    }

    const smoothedDistance = haversineDistance(this.lastFilteredPoint[1], this.lastFilteredPoint[0], lat, lon)
    if (smoothedDistance < this.thresholdXY_m) return
    this.lastFilteredPoint = point

    const smoothedDiff = elevation - this.lastFilteredZ
    if (Math.abs(smoothedDiff) < this.thresholdZ_m) return
    this.lastFilteredZ = elevation
    if (smoothedDiff > 0) this.totalElevationGainSmoothed += smoothedDiff
    else this.totalElevationLossSmoothed -= smoothedDiff
  }
}

/**
 * Gain, loss and slope length use the same filtered heights. Extrema use the
 * original measurements, and duration is the range of valid point timestamps.
 */
export function pointMetrics(points: readonly TrackPoint[]): PointMetrics {
  const accumulator = new MetricsAccumulator(THRESHOLD_XY_M, THRESHOLD_Z_M)
  const elevations = filteredElevations(points)

  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let elevationMax: number | null = null
  let elevationMin: number | null = null
  let startedAt: number | null = null
  let endedAt: number | null = null

  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    const [lon, lat, elevation, time] = point
    accumulator.add(point, elevations[index])

    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (elevation !== null && Number.isFinite(elevation)) {
      if (elevationMax === null || elevation > elevationMax) elevationMax = elevation
      if (elevationMin === null || elevation < elevationMin) elevationMin = elevation
    }
    if (time !== null && Number.isFinite(time)) {
      if (startedAt === null || time < startedAt) startedAt = time
      if (endedAt === null || time > endedAt) endedAt = time
    }
  }

  // A single point has no extent worth framing; an empty track has none at all.
  const hasExtent = points.length > 1 && Number.isFinite(minLat) && Number.isFinite(minLon)

  return {
    distance: accumulator.totalDistance,
    elevationGain: accumulator.totalElevationGainSmoothed,
    elevationLoss: accumulator.totalElevationLossSmoothed,
    duration: startedAt !== null && endedAt !== null ? Math.abs(endedAt - startedAt) : 0,
    elevationMax,
    elevationMin,
    bbox: hasExtent ? [minLon, minLat, maxLon, maxLat] : null,
  }
}
