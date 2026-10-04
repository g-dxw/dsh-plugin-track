import type { TrackPoint } from '../../protocol.ts'
import type { SandboxQuality } from '../map-settings.ts'
import type { SandboxBounds, TerrainGrid } from './types.ts'

const MAX_LATITUDE = 85.051129
const CIRCUMFERENCE = 40075016.68557849
export const MAXIMUM_GRID_SIZE = 192
export const MINIMUM_GRID_SIZE = 2
export const SANDBOX_QUALITY_BUDGETS = {
  eco: {grid: 96, texture: 1024},
  standard: {grid: 192, texture: 2048},
  fine: {grid: 256, texture: 4096},
} as const

export function mercatorY(latitude: number): number {
  const radians = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)) * Math.PI / 180
  return Math.max(0, Math.min(1, (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2))
}

export function latitudeFromMercator(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI
}

/** Pad by 20 percent, with a 150 metre minimum on each side. */
export function sandboxBounds(points: readonly TrackPoint[]): SandboxBounds | null {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > MAX_LATITUDE) continue
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  if (!Number.isFinite(west) || east - west > 180) return null
  const latitudeScale = Math.max(0.01, Math.cos((south + north) / 2 * Math.PI / 180))
  const latitudePadding = Math.max((north - south) * 0.2, 150 / CIRCUMFERENCE * 360)
  const longitudePadding = Math.max((east - west) * 0.2, 150 / (CIRCUMFERENCE * latitudeScale) * 360)
  return [
    Math.max(-180, west - longitudePadding),
    Math.max(-MAX_LATITUDE, south - latitudePadding),
    Math.min(180, east + longitudePadding),
    Math.min(MAX_LATITUDE, north + latitudePadding),
  ]
}

/** Match metres per grid cell on both axes, including narrow routes. */
export function createTerrainGrid(bounds: SandboxBounds, quality: SandboxQuality = 'standard'): TerrainGrid {
  const [west, south, east, north] = bounds
  const latitudeScale = Math.cos((south + north) / 2 * Math.PI / 180)
  const widthMeters = Math.max(1, (east - west) / 360 * CIRCUMFERENCE * latitudeScale)
  const depthMeters = Math.max(1, (mercatorY(south) - mercatorY(north)) * CIRCUMFERENCE * latitudeScale)
  const maximum = Math.max(widthMeters, depthMeters)
  const size = SANDBOX_QUALITY_BUDGETS[quality].grid
  return {
    bounds,
    columns: Math.max(MINIMUM_GRID_SIZE, Math.round(widthMeters / maximum * (size - 1)) + 1),
    rows: Math.max(MINIMUM_GRID_SIZE, Math.round(depthMeters / maximum * (size - 1)) + 1),
    widthMeters,
    depthMeters,
    elevations: [],
  }
}

export function gridCoordinate(column: number, row: number, terrain: TerrainGrid): [number, number] {
  const [west, south, east, north] = terrain.bounds
  const northY = mercatorY(north)
  return [
    west + column / (terrain.columns - 1) * (east - west),
    latitudeFromMercator(northY + row / (terrain.rows - 1) * (mercatorY(south) - northY)),
  ]
}

function gridRatio(lon: number, lat: number, terrain: TerrainGrid): [number, number] {
  const [west, south, east, north] = terrain.bounds
  return [
    Math.max(0, Math.min(1, (lon - west) / (east - west))),
    Math.max(0, Math.min(1, (mercatorY(lat) - mercatorY(north)) / (mercatorY(south) - mercatorY(north)))),
  ]
}

export function terrainPosition(lon: number, lat: number, terrain: TerrainGrid): {x: number; z: number} {
  const [x, z] = gridRatio(lon, lat, terrain)
  return {x: (x - 0.5) * terrain.widthMeters, z: (z - 0.5) * terrain.depthMeters}
}
