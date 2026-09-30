/**
 * Statistics over a flat point list.
 *
 * Ported from wanderer's `GpxMetricsComputation` (AGPL-3.0 — see
 * `src/track/LICENSE`), and deliberately kept numerically identical to the copy
 * in `model/gpx-metrics-computation.ts` so a GPX parsed through the native model
 * and a KML parsed through the vendor reader report the same numbers for the
 * same shape:
 *
 *  - distance is the *raw* sum of every consecutive haversine leg;
 *  - elevation gain / loss only count while the raw accumulator is being fed;
 *  - and the smoothed accumulator — which is what `getTotals()` actually reports
 *    — only advances one anchor every `thresholdXY` metres, and only banks the
 *    change once it exceeds `thresholdZ` metres. That is what keeps GPS noise on
 *    a flat road from reporting hundreds of metres of climb.
 */
import { haversineDistance } from './model/utils.ts'
import type { TrackPoint } from '../protocol.ts'

/** Travel below this many metres never moves the smoothing anchor. */
export const THRESHOLD_XY_M = 5
/** Elevation change below this many metres never counts as up or down. */
export const THRESHOLD_Z_M = 5

export interface PointMetrics {
  /** Raw summed distance, in metres. */
  distance: number
  elevationGain: number
  elevationLoss: number
  /** Milliseconds between the first and the last timestamped point. */
  duration: number
  elevationMax: number | null
  elevationMin: number | null
  bbox: [number, number, number, number] | null
}

/** The accumulation half of `GpxMetricsComputation`, over `TrackPoint` tuples. */
class MetricsAccumulator {
  private lastPoint: TrackPoint | null = null
  private lastFilteredPoint: TrackPoint | null = null
  private lastZ = 0
  private lastFilteredZ = 0
  totalDistance = 0
  totalElevationGain = 0
  totalElevationLoss = 0
  totalElevationGainSmoothed = 0
  totalElevationLossSmoothed = 0

  constructor(private readonly thresholdXY_m: number, private readonly thresholdZ_m: number) {}

  add(point: TrackPoint) {
    const [lon, lat, elevation] = point
    const value = elevation ?? 0

    if (!this.lastPoint || !this.lastFilteredPoint) {
      // Both anchors start on the first point, elevation included.
      this.lastPoint = point
      this.lastFilteredPoint = point
      this.lastFilteredZ = value
      this.lastZ = value
      return
    }

    const distance = haversineDistance(this.lastPoint[1], this.lastPoint[0], lat, lon)
    const smoothedDistance = haversineDistance(this.lastFilteredPoint[1], this.lastFilteredPoint[0], lat, lon)

    this.totalDistance += distance
    this.lastPoint = point

    const elevationDiff = value - this.lastZ
    this.lastZ = value
    if (elevationDiff > 0) this.totalElevationGain += elevationDiff
    if (elevationDiff < 0) this.totalElevationLoss -= elevationDiff

    if (smoothedDistance < this.thresholdXY_m) return
    this.lastFilteredPoint = point

    const smoothedDiff = value - this.lastFilteredZ
    if (Math.abs(smoothedDiff) < this.thresholdZ_m) return
    this.lastFilteredZ = value
    if (smoothedDiff > 0) this.totalElevationGainSmoothed += smoothedDiff
    else this.totalElevationLossSmoothed -= smoothedDiff
  }
}

/**
 * What `GPX.getTotals()` reports: gain and loss come from the *smoothed*
 * accumulator while the distance is the raw one. That asymmetry is upstream's,
 * not an oversight, and matching it keeps our numbers comparable to theirs.
 */
export function pointMetrics(points: readonly TrackPoint[]): PointMetrics {
  const accumulator = new MetricsAccumulator(THRESHOLD_XY_M, THRESHOLD_Z_M)

  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let elevationMax: number | null = null
  let elevationMin: number | null = null
  let startedAt: number | null = null
  let endedAt: number | null = null

  for (const point of points) {
    const [lon, lat, elevation, time] = point
    accumulator.add(point)

    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (elevation !== null) {
      if (elevationMax === null || elevation > elevationMax) elevationMax = elevation
      if (elevationMin === null || elevation < elevationMin) elevationMin = elevation
    }
    if (time !== null) {
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
