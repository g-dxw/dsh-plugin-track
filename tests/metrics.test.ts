/**
 * The statistics, and the smoothing that decides which elevation changes count.
 *
 * These run in the node environment on purpose: nothing here touches the DOM.
 * Moving the accumulator off wanderer's model objects and onto plain tuples was
 * what made the arithmetic testable without a file, and this file is the payoff.
 *
 * The distances are the same 30°N arithmetic the parsing fixtures use — one
 * 0.01° step east is `LEG_METRES`, imported rather than retyped so the two
 * suites cannot drift apart.
 */
import { describe, expect, it } from 'vitest'
import GpxMetricsComputation from '../src/track/model/gpx-metrics-computation.ts'
import { pointMetrics, THRESHOLD_XY_M, THRESHOLD_Z_M } from '../src/track/metrics.ts'
import type { TrackPoint } from '../src/protocol.ts'
import { LEG_METRES } from './fixtures.ts'

/** Metres per degree of longitude at 30°N, which is where every fixture sits. */
const DEGREE_M = LEG_METRES / 0.01

/** A point `offset` metres east of the origin, at the fixtures' latitude. */
function point(offset: number, elevation: number | null, time: number | null = null): TrackPoint {
  return [120 + offset / DEGREE_M, 30, elevation, time]
}

/** The ported accumulator, driven the way `GPX.getTotals()` drives it. */
function nativeTotals(points: readonly TrackPoint[]) {
  const computation = new GpxMetricsComputation(THRESHOLD_XY_M, THRESHOLD_Z_M)
  for (const [lon, lat, elevation] of points) {
    computation.addAndFilter({$: {lat, lon}, ele: elevation})
  }
  return computation
}

describe('a track with nothing in it', () => {
  it('reports zeros and no extent rather than infinities', () => {
    // The bbox loop seeds its bounds with ±Infinity and only decides at the end
    // whether it saw enough to frame. A naive reading would report an empty
    // track as spanning the whole planet.
    const metrics = pointMetrics([])
    expect(metrics).toEqual({
      distance: 0,
      elevationGain: 0,
      elevationLoss: 0,
      duration: 0,
      elevationMax: null,
      elevationMin: null,
      bbox: null,
    })
  })

  it('treats one lone point as having no extent, but still reports its height', () => {
    const metrics = pointMetrics([point(0, 100)])
    expect(metrics.distance).toBe(0)
    expect(metrics.bbox).toBeNull()
    expect(metrics.elevationMax).toBe(100)
    expect(metrics.elevationMin).toBe(100)
  })
})

describe('distance', () => {
  it('sums every leg at the raw spacing', () => {
    expect(pointMetrics([point(0, 100), point(962.9763121562811, 100), point(1925.9526243125622, 100)]).distance)
      .toBeCloseTo(2 * LEG_METRES, 6)
  })

  it('keeps counting legs that the elevation smoothing ignores', () => {
    // Two metres between samples is under the 5 m XY bar, so the smoothing never
    // advances — but the walk still happened.
    const jittered = [
      point(0, 100), point(1.9259526243125623, 103), point(3.8519052486251246, 100),
      point(5.7778578729376869, 103), point(7.7038104972502492, 100),
    ]
    const metrics = pointMetrics(jittered)
    expect(metrics.distance).toBeCloseTo(4 * (LEG_METRES / 500), 6)
    expect(metrics.elevationGain).toBe(0)
    expect(metrics.elevationLoss).toBe(0)
  })
})

describe('elevation gain and loss', () => {
  it('banks a climb the smoothing accepts', () => {
    const metrics = pointMetrics([point(0, 100), point(LEG_METRES, 130), point(2 * LEG_METRES, 100)])
    expect(metrics.elevationGain).toBeCloseTo(30, 6)
    expect(metrics.elevationLoss).toBeCloseTo(30, 6)
  })

  it('refuses a rise smaller than the 5 m bar, however far it was walked', () => {
    // The raw accumulator would call this 3 m of climb. `getTotals()` reports the
    // smoothed one, and 3 m is inside the noise band it exists to suppress.
    const metrics = pointMetrics([point(0, 100), point(LEG_METRES, 101.5), point(2 * LEG_METRES, 103)])
    expect(metrics.elevationGain).toBe(0)
    expect(metrics.elevationLoss).toBe(0)
  })

  it('counts nothing at all for a track with no elevations', () => {
    const metrics = pointMetrics([point(0, null), point(LEG_METRES, null), point(2 * LEG_METRES, null)])
    expect(metrics.elevationGain).toBe(0)
    expect(metrics.elevationLoss).toBe(0)
    // Not 0: an elevation-less track has no profile, and saying it is flat at sea
    // level would be inventing one.
    expect(metrics.elevationMax).toBeNull()
    expect(metrics.elevationMin).toBeNull()
  })

  it('takes the extremes from the raw values, not the smoothed ones', () => {
    const metrics = pointMetrics([point(0, 100), point(LEG_METRES, 103), point(2 * LEG_METRES, 120), point(3 * LEG_METRES, 102)])
    // 103 and 100 are both inside the smoothed band; the peak is still the peak.
    expect(metrics.elevationMax).toBe(120)
    expect(metrics.elevationMin).toBe(100)
  })
})

describe('duration and extent', () => {
  it('spans the first and last timestamp, whichever order they arrive in', () => {
    const base = Date.parse('2026-09-20T01:00:00Z')
    const metrics = pointMetrics([
      point(0, 100, base + 600_000),
      point(LEG_METRES, 100, base),
      point(2 * LEG_METRES, 100, base + 300_000),
    ])
    expect(metrics.duration).toBe(600_000)
  })

  it('reports no duration when the points carry no times', () => {
    expect(pointMetrics([point(0, 100), point(LEG_METRES, 100)]).duration).toBe(0)
  })

  it('frames the path as [minLon, minLat, maxLon, maxLat]', () => {
    const metrics = pointMetrics([
      [120.02, 30.01, 100, null],
      [120, 30.03, 100, null],
      [120.01, 29.99, 100, null],
    ])
    expect(metrics.bbox).toEqual([120, 29.99, 120.02, 30.03])
  })
})

describe('the ported arithmetic against wanderer’s original', () => {
  it('reports the same numbers the model-object accumulator does', () => {
    // `metrics.ts` exists because the model objects are gone; if the two ever
    // disagree, the GPX path and the KML path have silently diverged.
    const points = [
      point(0, 100), point(1.9259526243125623, 100), point(3.8519052486251246, 104),
      point(LEG_METRES, 120), point(LEG_METRES + 1.9259526243125623, 118), point(2 * LEG_METRES, 90),
      point(3 * LEG_METRES, 96), point(3 * LEG_METRES + 1.9259526243125623, 130),
    ]
    const mine = pointMetrics(points)
    const theirs = nativeTotals(points)
    expect(mine.distance).toBeCloseTo(theirs.totalDistance, 6)
    expect(mine.elevationGain).toBeCloseTo(theirs.totalElevationGainSmoothed, 6)
    expect(mine.elevationLoss).toBeCloseTo(theirs.totalElevationLossSmoothed, 6)
    // And both actually banked something, so the equality above is not 0 === 0.
    expect(theirs.totalElevationGainSmoothed).toBeGreaterThan(0)
    expect(theirs.totalElevationLossSmoothed).toBeGreaterThan(0)
  })
})
