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
import { pointMetrics } from '../src/track/metrics.ts'
import type { TrackPoint } from '../src/protocol.ts'
import { LEG_METRES } from './fixtures.ts'

/** Metres per degree of longitude at 30°N, which is where every fixture sits. */
const DEGREE_M = LEG_METRES / 0.01

/** A point `offset` metres east of the origin, at the fixtures' latitude. */
function point(offset: number, elevation: number | null, time: number | null = null): TrackPoint {
  return [120 + offset / DEGREE_M, 30, elevation, time]
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
    const jittered = [0, 1, 2, 3, 4].map(index => point(index * LEG_METRES / 500, 100))
    const metrics = pointMetrics(jittered)
    expect(metrics.distance).toBeCloseTo(4 * (LEG_METRES / 500), 6)
    expect(metrics.elevationGain).toBe(0)
    expect(metrics.elevationLoss).toBe(0)
  })

  it('measures a slope using both the horizontal leg and its measured height change', () => {
    const metrics = pointMetrics([point(0, 100), point(LEG_METRES, 130)])
    // Pythagoras, using the independently measured horizontal fixture leg.
    expect(metrics.distance).toBeCloseTo(Math.sqrt(LEG_METRES ** 2 + 30 ** 2), 6)
    expect(metrics.distance).toBeGreaterThan(LEG_METRES)
  })

  it('uses horizontal distance for each leg with an unknown endpoint height', () => {
    const metrics = pointMetrics([
      point(0, 100), point(LEG_METRES, null), point(2 * LEG_METRES, 200), point(3 * LEG_METRES, 220),
    ])
    expect(metrics.distance).toBeCloseTo(2 * LEG_METRES + Math.sqrt(LEG_METRES ** 2 + 20 ** 2), 6)
    expect(metrics.elevationGain).toBe(20)
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
    // A 3 m drift stays inside the existing climb noise threshold.
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

  it('rejects an isolated elevation spike without adding a vertical detour', () => {
    const heights = [100, 100, 100, 100, 200, 100, 100, 100, 100]
    const metrics = pointMetrics(heights.map((height, index) => point(index * LEG_METRES, height)))
    expect(metrics.elevationGain).toBe(0)
    expect(metrics.elevationLoss).toBe(0)
    expect(metrics.distance).toBeCloseTo(8 * LEG_METRES, 6)
    // Filtering the profile must not discard the measured high/low cards.
    expect(metrics.elevationMax).toBe(200)
    expect(metrics.elevationMin).toBe(100)
  })

  it('retains a sustained summit and its descent after median filtering', () => {
    const heights = [100, 100, 120, 120, 120, 120, 100, 100]
    const metrics = pointMetrics(heights.map((height, index) => point(index * LEG_METRES, height)))
    expect(metrics.elevationGain).toBe(20)
    expect(metrics.elevationLoss).toBe(20)
    expect(metrics.distance).toBeCloseTo(5 * LEG_METRES + 2 * Math.sqrt(LEG_METRES ** 2 + 20 ** 2), 6)
  })

  it('preserves recorded changes at the first and last two points', () => {
    const heights = [100, 110, 110, 110, 110, 110, 110, 100, 100]
    const metrics = pointMetrics(heights.map((height, index) => point(index * LEG_METRES, height)))
    expect(metrics.elevationGain).toBe(10)
    expect(metrics.elevationLoss).toBe(10)
    expect(metrics.distance).toBeCloseTo(6 * LEG_METRES + 2 * Math.sqrt(LEG_METRES ** 2 + 10 ** 2), 6)
  })

  it('keeps short measured runs around a gap without smoothing or climbing across it', () => {
    const heights = [100, 110, 120, null, 400, 410, 420]
    const metrics = pointMetrics(heights.map((height, index) => point(index * LEG_METRES, height)))
    expect(metrics.elevationGain).toBe(40)
    expect(metrics.elevationLoss).toBe(0)
    expect(metrics.distance).toBeCloseTo(2 * LEG_METRES + 4 * Math.sqrt(LEG_METRES ** 2 + 10 ** 2), 6)
    expect(metrics.elevationMin).toBe(100)
    expect(metrics.elevationMax).toBe(420)
  })

  it('does not invent a climb from sea level after missing starting elevations', () => {
    const metrics = pointMetrics([point(0, null), point(LEG_METRES, 100), point(2 * LEG_METRES, 130), point(3 * LEG_METRES, null)])
    expect(metrics.elevationGain).toBe(30)
    expect(metrics.elevationLoss).toBe(0)
  })

  it('accepts measured zero and negative elevations as real heights', () => {
    const metrics = pointMetrics([point(0, -10), point(LEG_METRES, 0), point(2 * LEG_METRES, 20)])
    expect(metrics.elevationGain).toBe(30)
    expect(metrics.elevationLoss).toBe(0)
    expect(metrics.elevationMin).toBe(-10)
  })

  it('accumulates a gradual rise past the horizontal sampling and vertical thresholds', () => {
    const metrics = pointMetrics([0, 1, 2, 3].map(index => point(index * 2, 100 + index * 2)))
    expect(metrics.elevationGain).toBe(6)
    expect(metrics.elevationLoss).toBe(0)
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

describe('physical consistency', () => {
  it('preserves a steady uphill profile without mutating its recorded points', () => {
    const points = Object.freeze(Array.from({length: 9}, (_, index) =>
      Object.freeze(point(index * LEG_METRES, 100 + index * 10)))) as readonly TrackPoint[]
    const metrics = pointMetrics(points)
    expect(metrics.elevationGain).toBe(80)
    expect(metrics.elevationLoss).toBe(0)
    expect(metrics.distance).toBeCloseTo(8 * Math.sqrt(LEG_METRES ** 2 + 10 ** 2), 6)
    expect(points.map(point => point[2])).toEqual([100, 110, 120, 130, 140, 150, 160, 170, 180])
  })
})
