import { describe, expect, it } from 'vitest'
import { createTerrainGrid, gridCoordinate, latitudeFromMercator, mercatorY, sandboxBounds, terrainPosition } from '../src/track/sandbox/coordinates.ts'
import type { TrackPoint } from '../src/protocol.ts'

describe('shared sandbox projection', () => {
  it('round-trips latitude without mixing degrees with map-texture Mercator rows', () => {
    for (const latitude of [-85, -60, 0, 30, 60, 85]) expect(latitudeFromMercator(mercatorY(latitude))).toBeCloseTo(latitude, 9)
  })
  it('pads even a single fix into a usable region and clips Mercator/world limits', () => {
    const single = createTerrainGrid(sandboxBounds([[120, 30, null, null]])!)
    expect(single.widthMeters).toBeCloseTo(300, 2)
    expect(single.depthMeters).toBeCloseTo(300, 2)
    const edge = sandboxBounds([[179.999, 85.05, null, null]])!
    expect(edge[2]).toBe(180)
    expect(edge[3]).toBe(85.051129)
    expect(mercatorY(edge[3])).toBe(0)
    expect(mercatorY(-edge[3])).toBe(1)
  })
  it('rejects unsupported date-line and invalid regions without creating world-sized terrain', () => {
    const invalid = [[NaN, 30, null, null], [0, 90, null, null]] as TrackPoint[]
    expect(sandboxBounds(invalid)).toBeNull()
    expect(sandboxBounds([[179, 30, null, null], [-179, 30, null, null]])).toBeNull()
  })
  it('keeps grid quality limits while preserving metres per cell', () => {
    const wide = createTerrainGrid([110, 30, 120, 30.01])
    expect(wide.columns).toBe(192)
    expect(wide.rows).toBe(2)
    expect(wide.widthMeters).toBeGreaterThan(wide.depthMeters * 100)
    const tall = createTerrainGrid([120, 20, 120.01, 30])
    expect(tall.columns).toBe(2)
    expect(tall.rows).toBe(192)
  })
  it('maps grid corners and texture corners to the same model positions', () => {
    const grid = createTerrainGrid([119, 30, 121, 32])
    expect(gridCoordinate(0, 0, grid)[0]).toBe(119)
    expect(gridCoordinate(0, 0, grid)[1]).toBeCloseTo(32, 9)
    const southeast = gridCoordinate(grid.columns - 1, grid.rows - 1, grid)
    expect(southeast[0]).toBe(121)
    expect(southeast[1]).toBeCloseTo(30, 9)
    const northwestPosition = terrainPosition(119, 32, grid)
    expect(northwestPosition.x).toBe(-grid.widthMeters / 2)
    expect(northwestPosition.z).toBe(-grid.depthMeters / 2)
    const southeastPosition = terrainPosition(...southeast, grid)
    expect(southeastPosition.x).toBeCloseTo(grid.widthMeters / 2, 5)
    expect(southeastPosition.z).toBeCloseTo(grid.depthMeters / 2, 5)
  })
  it('uses uniform texture row spacing at high latitudes instead of uniform degrees', () => {
    const grid = createTerrainGrid([10, 50, 12, 75])
    const row = (grid.rows - 1) / 2
    const center = gridCoordinate((grid.columns - 1) / 2, row, grid)
    expect(center[1]).not.toBeCloseTo(62.5, 1)
    expect(mercatorY(center[1])).toBeCloseTo((mercatorY(50) + mercatorY(75)) / 2, 10)
    expect(terrainPosition(...center, grid).z).toBeCloseTo(0, 5)
  })
})

describe('sandbox quality budgets', () => {
  it('uses bounded grid sizes for all quality modes with a standard default', () => {
    for (const [quality, size] of [['eco', 96], ['standard', 192], ['fine', 256]] as const) {
      const terrain = createTerrainGrid([120, 30, 120.02, 30.02], quality)
      expect(Math.max(terrain.rows, terrain.columns)).toBe(size)
      expect((terrain.widthMeters / (terrain.columns - 1)) / (terrain.depthMeters / (terrain.rows - 1))).toBeCloseTo(1, 2)
    }
    expect(createTerrainGrid([120, 30, 120.02, 30.02]).rows).toBe(192)
  })
  it('expands long routes by twenty percent and short routes by a metre-based floor', () => {
    const bounds = sandboxBounds([[120, 30, null, null], [121, 31, null, null]])!
    expect(bounds).toEqual([119.8, 29.8, 121.2, 31.2])
    const high = createTerrainGrid(sandboxBounds([[120, 70, null, null]])!)
    expect(high.widthMeters).toBeCloseTo(300, 2)
    expect(high.depthMeters).toBeCloseTo(300, 2)
  })
})