/** The sandbox's heights and mesh data, independent of WebGL. */
import type { TrackPoint } from '../../protocol.ts'
import { terrainPosition } from './coordinates.ts'
import type { TerrainGrid } from './types.ts'

export const TERRAIN_EXAGGERATION = 1.25
export const MAXIMUM_ROUTE_POINTS = 500

export interface TerrainModel {
  minimumElevation: number
  maximumElevation: number
  baseThickness: number
  topHeight: number
  exaggeration: number
}

export interface GeometryData {
  positions: Float32Array
  indices: Uint32Array
  colors?: Float32Array
  uvs?: Float32Array
}

export interface SandboxPosition { x: number; y: number; z: number }

export function terrainModel(terrain: TerrainGrid, exaggeration = TERRAIN_EXAGGERATION): TerrainModel {
  if (!Number.isInteger(terrain.columns) || !Number.isInteger(terrain.rows)
    || terrain.columns < 2 || terrain.rows < 2
    || terrain.elevations.length !== terrain.columns * terrain.rows
    || !Number.isFinite(terrain.widthMeters) || terrain.widthMeters <= 0
    || !Number.isFinite(terrain.depthMeters) || terrain.depthMeters <= 0
    || terrain.elevations.some(elevation => !Number.isFinite(elevation))) {
    throw new Error('沙盘高程网格无效')
  }
  let minimumElevation = Infinity
  let maximumElevation = -Infinity
  for (const elevation of terrain.elevations) {
    minimumElevation = Math.min(minimumElevation, elevation)
    maximumElevation = Math.max(maximumElevation, elevation)
  }
  const relief = maximumElevation - minimumElevation
  exaggeration = Number.isFinite(exaggeration) ? Math.max(1, Math.min(3, exaggeration)) : TERRAIN_EXAGGERATION
  const diagonal = Math.hypot(terrain.widthMeters, terrain.depthMeters)
  const baseThickness = Math.max(30, Math.min(500, Math.max(diagonal * 0.025, relief * 0.15)))
  return {
    minimumElevation,
    maximumElevation,
    baseThickness,
    topHeight: baseThickness + relief * exaggeration,
    exaggeration,
  }
}

export function sceneHeight(elevation: number, model: TerrainModel): number {
  return model.baseThickness + (elevation - model.minimumElevation) * model.exaggeration
}

export function terrainTop(terrain: TerrainGrid, model: TerrainModel): GeometryData {
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const relief = Math.max(1, model.maximumElevation - model.minimumElevation)
  for (let row = 0; row < terrain.rows; row++) {
    for (let column = 0; column < terrain.columns; column++) {
      const elevation = terrain.elevations[row * terrain.columns + column]
      positions.push(
        (column / (terrain.columns - 1) - 0.5) * terrain.widthMeters,
        sceneHeight(elevation, model),
        (row / (terrain.rows - 1) - 0.5) * terrain.depthMeters,
      )
      uvs.push(column / (terrain.columns - 1), 1 - row / (terrain.rows - 1))
      const height = (elevation - model.minimumElevation) / relief
      colors.push(0.28 + height * 0.43, 0.42 + height * 0.3, 0.25 + height * 0.33)
      if (row === terrain.rows - 1 || column === terrain.columns - 1) continue
      const a = row * terrain.columns + column
      const b = a + 1
      const c = a + terrain.columns
      const d = c + 1
      // North is negative Z. This winding points the top face upwards.
      indices.push(a, c, b, b, c, d)
    }
  }
  return {
    positions: new Float32Array(positions), indices: new Uint32Array(indices),
    colors: new Float32Array(colors), uvs: new Float32Array(uvs),
  }
}

/** A closed ring down to Y=0, including every uneven perimeter vertex. */
export function terrainSides(terrain: TerrainGrid, model: TerrainModel): GeometryData {
  const positions: number[] = []
  const indices: number[] = []
  const perimeter: [number, number][] = []
  for (let column = 0; column < terrain.columns; column++) perimeter.push([column, 0])
  for (let row = 1; row < terrain.rows; row++) perimeter.push([terrain.columns - 1, row])
  for (let column = terrain.columns - 2; column >= 0; column--) perimeter.push([column, terrain.rows - 1])
  for (let row = terrain.rows - 2; row > 0; row--) perimeter.push([0, row])
  for (const [column, row] of perimeter) {
    const x = (column / (terrain.columns - 1) - 0.5) * terrain.widthMeters
    const z = (row / (terrain.rows - 1) - 0.5) * terrain.depthMeters
    positions.push(x, sceneHeight(terrain.elevations[row * terrain.columns + column], model), z, x, 0, z)
  }
  for (let index = 0; index < perimeter.length; index++) {
    const a = index * 2
    const b = ((index + 1) % perimeter.length) * 2
    indices.push(a, a + 1, b, b, a + 1, b + 1)
  }
  return {positions: new Float32Array(positions), indices: new Uint32Array(indices)}
}

/** Preserve endpoints and sharp turns; fill the remaining display budget evenly. */
export function sampleRoute(points: readonly TrackPoint[]): TrackPoint[] {
  const valid = points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
  if (valid.length <= MAXIMUM_ROUTE_POINTS) return valid
  const selected = new Set<number>([0, valid.length - 1])
  for (let index = 1; index < valid.length - 1; index++) {
    const a = valid[index - 1]
    const b = valid[index]
    const c = valid[index + 1]
    const latitudeScale = Math.cos(b[1] * Math.PI / 180)
    const ax = (b[0] - a[0]) * latitudeScale
    const ay = b[1] - a[1]
    const bx = (c[0] - b[0]) * latitudeScale
    const by = c[1] - b[1]
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by)
    if (length > 0 && (ax * bx + ay * by) / length < Math.cos(Math.PI / 6)) selected.add(index)
  }
  // Protected turns may exceed the soft budget rather than cutting sharp bends.
  const remaining = Math.max(0, MAXIMUM_ROUTE_POINTS - selected.size)
  const candidates = Array.from({length: valid.length}, (_, index) => index).filter(index => !selected.has(index))
  for (let index = 0; index < remaining; index++) {
    selected.add(candidates[Math.floor((index + 0.5) * candidates.length / remaining)])
  }
  return [...selected].sort((a, b) => a - b).map(index => valid[index])
}

/** Match the actual triangle faces rather than a bilinear surface above them. */
export function triangleElevation(x: number, z: number, terrain: TerrainGrid): number {
  const gx = Math.max(0, Math.min(terrain.columns - 1, (x / terrain.widthMeters + 0.5) * (terrain.columns - 1)))
  const gz = Math.max(0, Math.min(terrain.rows - 1, (z / terrain.depthMeters + 0.5) * (terrain.rows - 1)))
  const column = Math.min(terrain.columns - 2, Math.floor(gx))
  const row = Math.min(terrain.rows - 2, Math.floor(gz))
  const dx = gx - column
  const dz = gz - row
  const a = row * terrain.columns + column
  const [ha, hb, hc, hd] = [a, a + 1, a + terrain.columns, a + terrain.columns + 1]
    .map(index => terrain.elevations[index])
  return dx + dz <= 1
    ? ha + (hb - ha) * dx + (hc - ha) * dz
    : hd + (hc - hd) * (1 - dx) + (hb - hd) * (1 - dz)
}

/**
 * Split every segment at grid and triangle boundaries. Each resulting segment
 * follows a single plane, so long GPS gaps cannot send the line through a ridge.
 * Source-file elevation never enters the calculation.
 */
export function routePath(points: readonly TrackPoint[], terrain: TerrainGrid, model: TerrainModel): SandboxPosition[] {
  const route = sampleRoute(points).map(([lon, lat]) => terrainPosition(lon, lat, terrain))
  const path: SandboxPosition[] = []
  const lift = Math.max(0.2, Math.max(terrain.widthMeters, terrain.depthMeters) * 0.001)
  const append = (x: number, z: number) => {
    path.push({x, y: sceneHeight(triangleElevation(x, z, terrain), model) + lift, z})
  }
  if (route.length) append(route[0].x, route[0].z)
  for (let index = 1; index < route.length; index++) {
    const from = route[index - 1]
    const to = route[index]
    const ax = (from.x / terrain.widthMeters + 0.5) * (terrain.columns - 1)
    const az = (from.z / terrain.depthMeters + 0.5) * (terrain.rows - 1)
    const bx = (to.x / terrain.widthMeters + 0.5) * (terrain.columns - 1)
    const bz = (to.z / terrain.depthMeters + 0.5) * (terrain.rows - 1)
    const breaks = new Set<number>([1])
    for (const [start, end] of [[ax, bx], [az, bz], [ax + az, bx + bz]]) {
      if (Math.abs(end - start) < 1e-10) continue
      for (let boundary = Math.floor(Math.min(start, end)) + 1; boundary < Math.max(start, end); boundary++) {
        const t = (boundary - start) / (end - start)
        if (t > 1e-10 && t < 1 - 1e-10) breaks.add(t)
      }
    }
    for (const t of [...breaks].sort((a, b) => a - b)) {
      append(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)
    }
  }
  return path
}

/** Keep imported segment gaps as gaps, including their individual endpoints. */
export function routePaths(points: readonly TrackPoint[], terrain: TerrainGrid, model: TerrainModel,
  segmentStarts: readonly number[] = []): SandboxPosition[][] {
  const starts = [0, ...new Set(segmentStarts.filter(index => Number.isInteger(index) && index > 0 && index < points.length))]
    .sort((a, b) => a - b)
  return starts.map((start, index) => routePath(points.slice(start, starts[index + 1] ?? points.length), terrain, model))
    .filter(path => path.length > 0)
}