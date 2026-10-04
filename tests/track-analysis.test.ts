import { describe, expect, it } from 'vitest'
import { analyzeTrack } from '../src/track/analysis.ts'
import type { TrackPoint } from '../src/protocol.ts'

describe('track movement and data quality analysis', () => {
  it('does not invent movement or elevation for a manually drawn route', () => {
    const report = analyzeTrack([[119, 30, null, null], [119.01, 30, null, null]])
    expect(report.averageMovingSpeed).toBeNull()
    expect(report.maximumSpeed).toBeNull()
    expect(report.timestampPoints).toBe(0)
    expect(report.metrics.distance).toBeGreaterThan(0)
    expect(report.metrics.elevationGain).toBe(0)
  })
  it('counts stationary time and repeated locations with complete timestamps', () => {
    const report = analyzeTrack([[119, 30, 100, 0], [119, 30, 100, 60000]])
    expect(report.timestampPoints).toBe(2)
    expect(report.duplicatePoints).toBe(1)
    expect(report.stoppedTime).toBe(60000)
    expect(report.movingTime).toBe(0)
    expect(report.maximumSpeed).toBe(0)
  })
  it('uses only complete adjacent intervals for average moving speed', () => {
    const points: TrackPoint[] = [[119, 30, 100, 0], [119.001, 30, 110, 60000], [119.01, 30, null, null]]
    const report = analyzeTrack(points)
    expect(report.movingTime).toBe(60000)
    expect(report.timedLegs).toBe(1)
    expect(report.movingDistance).toBeLessThan(report.metrics.distance)
    expect(report.averageMovingSpeed).toBeCloseTo(report.movingDistance / 60)
    expect(report.metrics.elevationLoss).toBe(0)
  })
  it('excludes reversed and repeated timestamps rather than reporting negative speed', () => {
    const report = analyzeTrack([[119, 30, null, 1000], [119.01, 30, null, 1000], [119.02, 30, null, 0]])
    expect(report.reversedTimes).toBe(2)
    expect(report.maximumSpeed).toBeNull()
  })
  it('separates unrealistic jumps from long sampling gaps', () => {
    const report = analyzeTrack([[119, 30, null, 0], [120, 31, null, 1000], [120.01, 31, null, 2000000]])
    expect(report.jumps).toBe(1)
    expect(report.longGaps).toBe(1)
    expect(report.timedLegs).toBe(0)
    expect(report.maximumSpeed).toBeNull()
  })
  it('keeps elapsed time and distance while elevation gaps do not create sea-level climbs', () => {
    const report = analyzeTrack([[119, 30, 500, 0], [119.01, 30, null, 60000], [119.02, 30, 800, 120000]])
    expect(report.metrics.duration).toBe(120000)
    expect(report.metrics.elevationMax).toBe(800)
    expect(report.metrics.elevationGain).toBe(0)
    expect(report.metrics.elevationLoss).toBe(0)
    expect(report.elevationPoints).toBe(2)
  })
})
