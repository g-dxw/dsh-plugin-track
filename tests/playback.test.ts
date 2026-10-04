import { describe, expect, it } from 'vitest'
import { advancePlayback, createPlaybackPath, samplePlayback } from '../src/track/playback.ts'
import type { TrackPoint } from '../src/protocol.ts'

const POINTS: TrackPoint[] = [[120, 30, 100, 1000], [120.01, 30, 120, 2000], [120.03, 30, 110, 3000]]

describe('distance-indexed track animation', () => {
  it('builds cumulative geodetic distance once without modifying the original track', () => {
    const original = structuredClone(POINTS)
    const path = createPlaybackPath(Object.freeze(POINTS.map(point => Object.freeze([...point]) as unknown as TrackPoint)))
    expect(path.cumulativeDistances[0]).toBe(0)
    expect(path.cumulativeDistances[1]).toBeCloseTo(962.9763121562811, 6)
    expect(path.totalDistance).toBeCloseTo(3 * path.cumulativeDistances[1], 4)
    expect(path.cumulativeDistances[2]).toBe(path.totalDistance)
    expect(POINTS).toEqual(original)
    expect(path.points).toEqual(POINTS)
  })

  it('samples by distance rather than point count or recording timestamp', () => {
    const path = createPlaybackPath(POINTS)
    const sample = samplePlayback(path, 0.5)
    expect(sample.index).toBe(1)
    expect(sample.position![0]).toBeCloseTo(120.015, 7)
    expect(sample.position![1]).toBe(30)
    expect(sample.distance).toBeCloseTo(path.totalDistance / 2, 8)
    const differentTimes = createPlaybackPath(POINTS.map(([lon, lat, elevation], index) => [lon, lat, elevation, index ? 10_000_000 : null]))
    expect(samplePlayback(differentTimes, 0.5).position!.slice(0, 2)).toEqual(sample.position!.slice(0, 2))
  })

  it('returns exact first and last points for seeking and completion', () => {
    const path = createPlaybackPath(POINTS)
    expect(samplePlayback(path, -10)).toMatchObject({position: POINTS[0], index: 0, progress: 0, distance: 0})
    expect(samplePlayback(path, 10)).toMatchObject({position: POINTS[2], index: 2, progress: 1, distance: path.totalDistance})
    expect(samplePlayback(path, Number.NaN).position).toEqual(POINTS[0])
    expect(samplePlayback(path, Number.POSITIVE_INFINITY).position).toEqual(POINTS[2])
  })

  it('handles repeated start/interior/end points without zero division or stuck progress', () => {
    const points = [POINTS[0], POINTS[0], POINTS[1], POINTS[1], POINTS[2], POINTS[2]]
    const path = createPlaybackPath(points)
    expect(samplePlayback(path, 0).index).toBe(0)
    expect(samplePlayback(path, 0.1).index).toBe(1)
    expect(samplePlayback(path, 0.5).index).toBe(3)
    expect(samplePlayback(path, 1).index).toBe(5)
    for (const progress of [0, 0.1, 0.5, 0.9, 1]) expect(samplePlayback(path, progress).position!.every(value => value === null || Number.isFinite(value))).toBe(true)
  })

  it('keeps absent elevation/time absent while interpolating known endpoint metadata', () => {
    const missing = createPlaybackPath([[120, 30, null, null], [120.01, 30, 100, 1000]])
    expect(samplePlayback(missing, 0.5).position!.slice(2)).toEqual([null, null])
    const measured = createPlaybackPath([[120, 30, 0, 0], [120.01, 30, 100, 1000]])
    expect(samplePlayback(measured, 0.5).position!.slice(2)).toEqual([50, 500])
  })

  it('filters only invalid coordinate fixes and sanitizes invalid optional metadata without mutation', () => {
    const points: TrackPoint[] = [[120, 30, Number.NaN, 1e20], [Number.NaN, 30, null, null], [181, 30, null, null], [120, 91, null, null], [120.01, 30, null, null]]
    const path = createPlaybackPath(points)
    expect(path.points).toEqual([[120, 30, null, null], [120.01, 30, null, null]])
    expect(samplePlayback(path, 1).index).toBe(1)
    expect(Number.isNaN(points[0][2])).toBe(true)
    expect(points[0][3]).toBe(1e20)
  })

  it('keeps polar latitudes accurate and finite so the view can clamp only its Mercator drawing', () => {
    const path = createPlaybackPath([[0, 89, null, null], [180, -89, null, null]])
    expect(Number.isFinite(path.totalDistance)).toBe(true)
    expect(path.points[0][1]).toBe(89)
    expect(samplePlayback(path, 0.5).position!.every(value => value === null || Number.isFinite(value))).toBe(true)
  })

  it('interpolates dateline-crossing longitude along its short direction', () => {
    const path = createPlaybackPath([[179, 0, null, null], [-179, 0, null, null]])
    expect(path.totalDistance).toBeCloseTo(222389.853289, 3)
    expect(Math.abs(samplePlayback(path, 0.5).position![0])).toBe(180)
    expect(samplePlayback(path, 0.25).position![0]).toBeCloseTo(179.5)
  })

  it('returns meaningful empty, single-point, and stationary-track results', () => {
    expect(samplePlayback(createPlaybackPath([]), 0.5)).toEqual({position: null, index: -1, progress: 0.5, distance: 0})
    expect(samplePlayback(createPlaybackPath([POINTS[0]]), 0.5)).toEqual({position: POINTS[0], index: 0, progress: 0.5, distance: 0})
    const stationary: TrackPoint[] = [[120, 30, 100, 0], [120, 30, 110, 1000]]
    const path = createPlaybackPath(stationary)
    expect(samplePlayback(path, 0.5)).toMatchObject({position: stationary[0], index: 0, distance: 0})
    expect(samplePlayback(path, 1)).toMatchObject({position: stationary[1], index: 1, distance: 0})
  })

  it('samples a 500000-point path through a bounded logarithmic number of distance reads', () => {
    const points: TrackPoint[] = Array.from({length: 500_000}, (_, index) => [-100 + index / 10000, 30, null, null])
    const path = createPlaybackPath(points)
    let reads = 0
    const distances = new Proxy(path.cumulativeDistances, {get(target, key, receiver) {if (typeof key === 'string' && /^\d+$/u.test(key)) reads++; return Reflect.get(target, key, receiver)}})
    const sample = samplePlayback({...path, cumulativeDistances: distances}, 0.731)
    expect(sample.position!.every(value => value === null || Number.isFinite(value))).toBe(true)
    expect(reads).toBeLessThan(30)
  })
})

describe('elapsed animation progress', () => {
  it('advances a frame increment independently of GPX time and caps completion', () => {
    expect(advancePlayback(0, 1500, 15000)).toBe(0.1)
    expect(advancePlayback(0.5, 1500, 15000)).toBe(0.6)
    expect(advancePlayback(0.95, 1500, 15000)).toBe(1)
  })

  it('holds progress when paused/invalid and handles immediate completion without NaN', () => {
    expect(advancePlayback(0.3, 0, 15000)).toBe(0.3)
    expect(advancePlayback(0.3, -10, 15000)).toBe(0.3)
    expect(advancePlayback(0.3, Number.NaN, 15000)).toBe(0.3)
    expect(advancePlayback(0.3, 100, Number.NaN)).toBe(0.3)
    expect(advancePlayback(0.3, 100, 0)).toBe(1)
    expect(advancePlayback(-1, 1000, 10000)).toBe(0.1)
  })
})

describe('large measured animation metadata', () => {
  it('keeps interpolation finite when opposite endpoint elevations overflow their difference', () => {
    const path = createPlaybackPath([[120, 30, 1e308, 0], [120.01, 30, -1e308, 1000]])
    expect(samplePlayback(path, 0.5).position![2]).toBe(0)
    expect(samplePlayback(path, 0.25).position![2]).toBeCloseTo(5e307)
    expect(samplePlayback(path, 0.75).position![2]).toBeCloseTo(-5e307)
  })
})
