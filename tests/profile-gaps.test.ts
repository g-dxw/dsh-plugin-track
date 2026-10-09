import { describe, expect, it } from 'vitest'
import { smoothElevations } from '../src/track/vendor/elevation-profile/tools.ts'

describe('elevation gaps after manual edits', () => {
  it('keeps missing altitudes missing and does not turn their neighbours into NaN', () => {
    const path = [[119, 30, 500], [119.001, 30], [119.002, 30, 800]]
    const result = smoothElevations(path, 5)
    expect(result).toEqual(path)
    expect(result[1]).toHaveLength(2)
    expect(result[0][2]).toBe(500)
    expect(result[2][2]).toBe(800)
  })
  it('smooths measured contiguous runs without smoothing across a missing point', () => {
    const result = smoothElevations([[119, 30, 10], [119.001, 30, 20], [119.002, 30], [119.003, 30, 100], [119.004, 30, 200]], 9)
    expect(result[0][2]).toBeCloseTo(50 / 3)
    expect(result[3][2]).toBeCloseTo(500 / 3)
    expect(result[2]).toHaveLength(2)
  })
  it('leaves the upstream weighted smoothing unchanged for complete altitudes', () => {
    const result = smoothElevations([[119, 30, 10], [119.001, 30, 20], [119.002, 30, 30]], 3)
    expect(result[1][2]).toBeCloseTo(140 / 6)
  })
})
