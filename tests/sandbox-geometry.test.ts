import { describe, expect, it } from 'vitest'
import type { TrackPoint } from '../src/protocol.ts'
import { gridCoordinate, terrainPosition } from '../src/track/sandbox/coordinates.ts'
import {
  MAXIMUM_ROUTE_POINTS, TERRAIN_EXAGGERATION, routePath, routePaths, sampleRoute, sceneHeight,
  terrainModel, terrainSides, terrainTop, triangleElevation,
} from '../src/track/sandbox/geometry.ts'
import type { TerrainGrid } from '../src/track/sandbox/types.ts'

function grid(elevations = [100, 100, 100, 100], columns = 2, rows = 2): TerrainGrid {
  return {bounds: [120, 30, 120.02, 30.02], columns, rows, widthMeters: 1000, depthMeters: 1000, elevations}
}

describe('sandbox terrain geometry', () => {
  it('uses raw DEM metres and exaggerates their relative height exactly once', () => {
    const terrain = grid([100, 200, 300, 400])
    const model = terrainModel(terrain)
    const geometry = terrainTop(terrain, model)
    expect(TERRAIN_EXAGGERATION).toBe(1.25)
    expect(geometry.positions[4] - geometry.positions[1]).toBe(125)
    expect(sceneHeight(400, model) - sceneHeight(100, model)).toBe(375)
    expect(model.topHeight).toBe(model.baseThickness + 375)
    expect(terrain.elevations).toEqual([100, 200, 300, 400])
  })

  it('makes a valid solid model for flat terrain and elevations below sea level', () => {
    const terrain = grid([-15, -15, -15, -15])
    const model = terrainModel(terrain)
    const top = terrainTop(terrain, model)
    const sides = terrainSides(terrain, model)
    expect(model.minimumElevation).toBe(-15)
    expect(model.topHeight).toBe(model.baseThickness)
    expect(top.positions.filter((_, index) => index % 3 === 1)).toEqual(new Float32Array(4).fill(model.baseThickness))
    expect(sides.positions.filter((_, index) => index % 6 === 4)).toEqual(new Float32Array(4))
    expect(sides.indices).toHaveLength(24)
    for (const buffer of [top.positions, top.colors!, top.uvs!, sides.positions]) {
      expect([...buffer].every(Number.isFinite)).toBe(true)
    }
  })

  it('aligns the northern row with the top of the map texture and faces upwards', () => {
    const top = terrainTop(grid(), terrainModel(grid()))
    expect([...top.uvs!]).toEqual([0, 1, 1, 1, 0, 0, 1, 0])
    const [a, b, c] = [...top.indices]
    const ax = top.positions[a * 3]
    const az = top.positions[a * 3 + 2]
    const bx = top.positions[b * 3]
    const bz = top.positions[b * 3 + 2]
    const cx = top.positions[c * 3]
    const cz = top.positions[c * 3 + 2]
    expect((bz - az) * (cx - ax) - (bx - ax) * (cz - az)).toBeGreaterThan(0)
  })

  it('keeps every buffer and index valid at the 96 by 96 grid limit', () => {
    const terrain = grid(Array.from({length: 96 * 96}, (_, index) => 200 + Math.sin(index / 15) * 50), 96, 96)
    const model = terrainModel(terrain)
    for (const mesh of [terrainTop(terrain, model), terrainSides(terrain, model)]) {
      expect([...mesh.positions].every(Number.isFinite)).toBe(true)
      expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3)
    }
  })

  it('rejects incomplete and nonfinite DEM before constructing a mesh', () => {
    expect(() => terrainModel(grid([100]))).toThrow('高程')
    expect(() => terrainModel(grid([100, 200, NaN, 200]))).toThrow('高程')
    expect(() => terrainModel({...grid(), widthMeters: 0})).toThrow('高程')
  })
})

describe('sandbox route grounding', () => {
  it('preserves the first and last usable fixes within the source-point budget', () => {
    const points: TrackPoint[] = Array.from({length: 2400}, (_, index) => [120 + index / 200000, 30, null, null])
    const selected = sampleRoute([[NaN, 30, null, null], ...points, [120, NaN, null, null]])
    expect(selected).toHaveLength(MAXIMUM_ROUTE_POINTS)
    expect(selected[0]).toBe(points[0])
    expect(selected[selected.length - 1]).toBe(points[points.length - 1])
  })

  it('grounds a route without GPX elevation and ignores any provided file elevation', () => {
    const terrain = grid([100, 200, 300, 400])
    const model = terrainModel(terrain)
    const withoutEle: TrackPoint[] = [[120, 30.02, null, null], [120.02, 30, null, null]]
    const withEle: TrackPoint[] = [[120, 30.02, 80000, null], [120.02, 30, -80000, null]]
    const path = routePath(withoutEle, terrain, model)
    expect(path).toEqual(routePath(withEle, terrain, model))
    expect(path[0]).toMatchObject(terrainPosition(120, 30.02, terrain))
    expect(path[path.length - 1]).toMatchObject(terrainPosition(120.02, 30, terrain))
    expect(path[0].y).toBeGreaterThan(model.baseThickness)
    expect(path[path.length - 1].y).toBeGreaterThan(model.topHeight)
  })

  it('splits a long route segment over an intermediate ridge instead of tunneling through it', () => {
    const terrain = grid([0, 1000, 0, 0, 1000, 0, 0, 1000, 0], 3, 3)
    const model = terrainModel(terrain)
    const from = gridCoordinate(0, 1, terrain)
    const to = gridCoordinate(2, 1, terrain)
    const path = routePath([[...from, null, null], [...to, null, null]], terrain, model)
    expect(path.some(point => Math.abs(point.x) < 1e-7 && point.y > sceneHeight(1000, model))).toBe(true)
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1]
      const b = path[index]
      for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const x = a.x + (b.x - a.x) * t
        const z = a.z + (b.z - a.z) * t
        const y = a.y + (b.y - a.y) * t
        expect(y).toBeGreaterThan(sceneHeight(triangleElevation(x, z, terrain), model) - 1e-5)
      }
    }
  })

  it('follows both halves of an uneven cell without a curve overshooting its surface', () => {
    const terrain = grid([0, 500, 600, 0])
    const model = terrainModel(terrain)
    const path = routePath([[120, 30.02, null, null], [120.02, 30, null, null]], terrain, model)
    expect(path).toHaveLength(3)
    const middle = path[1]
    expect(middle.x).toBeCloseTo(0)
    expect(middle.z).toBeCloseTo(0)
    expect(middle.y).toBeCloseTo(sceneHeight(550, model) + 1)
  })

  it('handles empty and one-point tracks with finite endpoint data', () => {
    const terrain = grid()
    const model = terrainModel(terrain)
    expect(routePath([], terrain, model)).toEqual([])
    const path = routePath([[120.01, 30.01, null, null]], terrain, model)
    expect(path).toHaveLength(1)
    expect(Object.values(path[0]).every(Number.isFinite)).toBe(true)
  })
})

describe('configurable sandbox relief and segmented routes', () => {
  it('applies a selected multiplier exactly once to raw DEM and clamps invalid factors', () => {
    const terrain = grid([100, 200, 300, 400])
    const model = terrainModel(terrain, 2)
    expect(sceneHeight(400, model) - sceneHeight(100, model)).toBe(600)
    expect(model.topHeight).toBe(model.baseThickness + 600)
    expect(terrain.elevations).toEqual([100, 200, 300, 400])
    expect(terrainModel(terrain, NaN).exaggeration).toBe(1.25)
    expect(terrainModel(terrain, 20).exaggeration).toBe(3)
  })
  it('retains a sharp bend that a uniform source stride would omit', () => {
    const points: TrackPoint[] = Array.from({length: 1200}, (_, index) =>
      [120 + index / 200000, 30, null, null])
    points[613] = [points[613][0], 30.002, null, null]
    const snapshot = points.map(point => [...point])
    const selected = sampleRoute(points)
    expect(selected).toContain(points[612])
    expect(selected).toContain(points[613])
    expect(selected).toContain(points[614])
    expect(selected[0]).toBe(points[0])
    expect(selected.at(-1)).toBe(points.at(-1))
    expect(points).toEqual(snapshot)
  })
  it('does not bridge imported segment gaps and preserves single-fix segments', () => {
    const terrain = grid([100, 200, 300, 400])
    const points: TrackPoint[] = [[120, 30.02, null, null], [120.005, 30.018, null, null],
      [120.015, 30.002, null, null], [120.02, 30, null, null], [120.01, 30.01, null, null]]
    const paths = routePaths(points, terrain, terrainModel(terrain), [4, 2, 2, -1, 90])
    expect(paths).toHaveLength(3)
    expect(paths[0][0]).toMatchObject(terrainPosition(...points[0].slice(0, 2) as [number, number], terrain))
    expect(paths[1][0]).toMatchObject(terrainPosition(...points[2].slice(0, 2) as [number, number], terrain))
    expect(paths[2]).toHaveLength(1)
  })
})
