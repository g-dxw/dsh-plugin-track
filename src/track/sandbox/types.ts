/** The region displayed by the terrain model: west, south, east, north. */
export type SandboxBounds = [number, number, number, number]

/** Camera and orbit target in the displayed terrain's metre-based scene coordinates. */
export interface SandboxCameraState {
  position: [number, number, number]
  target: [number, number, number]
  fov: number
}

/** Raw DEM metres on a regular Web Mercator grid, north to south. */
export interface TerrainGrid {
  bounds: SandboxBounds
  columns: number
  rows: number
  widthMeters: number
  depthMeters: number
  elevations: number[]
}

/** Browser overlay metadata; marker height is always sampled from the displayed DEM. */
export interface SandboxPlacemark {
  id: string
  coordinates: readonly [number, number]
  label: string
  title?: string
  groupCount?: number
}
