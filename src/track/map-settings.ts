/** Browser-local map preferences; never included in exported tracks or Agent context. */
import type { BasemapId } from './basemaps.ts'
import { TRACK_COLOR } from './trail-layer.ts'

export type SandboxQuality = 'eco' | 'standard' | 'fine'
export type SandboxBackground = 'solid' | 'environment'
export type PlacemarkDisplayMode = 'point' | 'marker'
export interface SandboxLighting {azimuth: number; elevation: number; intensity: number; ambient: number; shadows: boolean}
export interface SandboxColors {sides: string; background: string}
export interface MapCredit {label: string; url: string}
export interface TerrainProviderDefinition {
  id: 'mapterhorn' | 'maptiler'
  url?: string
  tiles?: string[]
  encoding: 'terrarium' | 'mapbox'
  tileSize: number
  maxzoom: number
  credits: readonly MapCredit[]
}
export interface MapSettings {
  version: 1
  basemap: BasemapId
  routeColor: string
  terrainPlacemarkMode: PlacemarkDisplayMode
  sandboxPlacemarkMode: PlacemarkDisplayMode
  /** Shared screen-space styles for numbered points and group tiles. */
  placemarkPointSize: number
  placemarkPointColor: string
  placemarkGroupColor: string
  placemarkPointRadius: number
  placemarkPointShowCount: boolean
  placemarkPointShowName: boolean
  sandboxLabelColor: string
  sandboxLabelSize: number
  /** Multiplier of the automatic world-space floating label height. */
  sandboxLabelHeight: number
  sandboxConnectorColor: string
  /** Internal palette revision keeps legacy defaults separate from later user choices. */
  sandboxMarkerPaletteVersion: 3
  maptilerKey: string
  tiandituKey: string
  terrainProvider: 'mapterhorn' | 'maptiler'
  exaggeration: number
  quality: SandboxQuality
  buildings: boolean
  lighting: SandboxLighting
  sandboxColors: SandboxColors
  sandboxBackground: SandboxBackground
  /** Legacy preference name retained; controls marker visibility in every map view. */
  sandboxPlacemarks: boolean
}
export const MAP_SETTINGS_KEY = 'cqai-track.map-settings'
export const LEGACY_BASEMAP_KEY = 'cqai-track.basemap'
export const SANDBOX_LABEL_SIZE_MIN = 10
export const SANDBOX_LABEL_SIZE_MAX = 32
export const SANDBOX_LABEL_HEIGHT_MIN = .2
export const SANDBOX_LABEL_HEIGHT_MAX = 3
export const PLACEMARK_POINT_SIZE_MIN = 12
export const PLACEMARK_POINT_SIZE_MAX = 64
export const PLACEMARK_POINT_RADIUS_MIN = 0
export const PLACEMARK_POINT_RADIUS_MAX = 50
const LEGACY_TRACK_COLOR = '#3dc5ff'
const LEGACY_CONNECTOR_COLOR = '#ffb347'
export const DEFAULT_SANDBOX_LIGHTING: Readonly<SandboxLighting> = Object.freeze({azimuth: 118, elevation: 85, intensity: 4.1, ambient: 0.65, shadows: true})
export const DEFAULT_SANDBOX_COLORS: Readonly<SandboxColors> = Object.freeze({sides: '#707070', background: '#bacaaa'})
export const DEFAULT_MAP_SETTINGS: Readonly<MapSettings> = Object.freeze({
  version: 1, basemap: 'vector', routeColor: TRACK_COLOR, sandboxLabelColor: '#ffffff', sandboxLabelSize: 16, sandboxLabelHeight: 1, sandboxConnectorColor: '#ffffff', sandboxMarkerPaletteVersion: 3, maptilerKey: '', tiandituKey: '', terrainProvider: 'mapterhorn',
  terrainPlacemarkMode: 'point', sandboxPlacemarkMode: 'marker', placemarkPointSize: 24, placemarkPointColor: '#c83532', placemarkGroupColor: '#2563eb', placemarkPointRadius: 50, placemarkPointShowCount: true, placemarkPointShowName: false,
  exaggeration: 1.25, quality: 'standard', buildings: false, lighting: DEFAULT_SANDBOX_LIGHTING, sandboxColors: DEFAULT_SANDBOX_COLORS, sandboxBackground: 'solid', sandboxPlacemarks: true,
})
const BASEMAP_IDS = ['vector', 'terrain', 'satellite', 'none', 'osm', 'maptiler-streets', 'maptiler-outdoor', 'maptiler-satellite'] as const
export function isBasemapId(value: unknown): value is BasemapId {return BASEMAP_IDS.includes(value as BasemapId)}
function numberWithin(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
export function sanitizePlacemarkPointSize(value: unknown): number {
  return Math.round(numberWithin(value, DEFAULT_MAP_SETTINGS.placemarkPointSize, PLACEMARK_POINT_SIZE_MIN, PLACEMARK_POINT_SIZE_MAX))
}
/** CSS border radius percentages vary from square tiles to circles. */
export function sanitizePlacemarkPointRadius(value: unknown): number {
  return Math.round(numberWithin(value, DEFAULT_MAP_SETTINGS.placemarkPointRadius, PLACEMARK_POINT_RADIUS_MIN, PLACEMARK_POINT_RADIUS_MAX))
}
/** Marker text uses integer CSS pixels in both the settings UI and captured scene. */
export function sanitizeSandboxLabelSize(value: unknown): number {
  return Math.round(numberWithin(value, DEFAULT_MAP_SETTINGS.sandboxLabelSize, SANDBOX_LABEL_SIZE_MIN, SANDBOX_LABEL_SIZE_MAX))
}
/** Relative lift keeps the control useful across terrain extents without changing source elevation. */
export function sanitizeSandboxLabelHeight(value: unknown): number {
  return Math.round(numberWithin(value, DEFAULT_MAP_SETTINGS.sandboxLabelHeight, SANDBOX_LABEL_HEIGHT_MIN, SANDBOX_LABEL_HEIGHT_MAX) * 10) / 10
}
export function sanitizeLighting(value: unknown): SandboxLighting {
  const lighting = value && typeof value === 'object' ? value as Partial<SandboxLighting> : {}
  return {
    azimuth: numberWithin(lighting.azimuth, DEFAULT_SANDBOX_LIGHTING.azimuth, 0, 360), elevation: numberWithin(lighting.elevation, DEFAULT_SANDBOX_LIGHTING.elevation, 5, 85),
    intensity: numberWithin(lighting.intensity, DEFAULT_SANDBOX_LIGHTING.intensity, 0, 5), ambient: numberWithin(lighting.ambient, DEFAULT_SANDBOX_LIGHTING.ambient, 0, 2),
    shadows: typeof lighting.shadows === 'boolean' ? lighting.shadows : DEFAULT_SANDBOX_LIGHTING.shadows,
  }
}
/** Color inputs store six-digit sRGB values; unsupported CSS values fall back per field. */
function sanitizeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
}
export function sanitizeSandboxColors(value: unknown): SandboxColors {
  const colors = value && typeof value === 'object' ? value as Partial<SandboxColors> : {}
  return {sides: sanitizeColor(colors.sides, DEFAULT_SANDBOX_COLORS.sides), background: sanitizeColor(colors.background, DEFAULT_SANDBOX_COLORS.background)}
}
/** Reject unknown/invalid fields and return a fresh complete value. */
export function sanitizeMapSettings(value: unknown): MapSettings {
  const source = value && typeof value === 'object' ? value as Partial<MapSettings> : {}
  const maptilerKey = typeof source.maptilerKey === 'string' ? source.maptilerKey.trim().slice(0, 512) : ''
  const tiandituKey = typeof source.tiandituKey === 'string' ? source.tiandituKey.trim().slice(0, 512) : ''
  const basemap = isBasemapId(source.basemap) ? source.basemap : DEFAULT_MAP_SETTINGS.basemap
  return {
    version: 1, basemap: basemap.startsWith('maptiler-') && !maptilerKey ? 'vector' : basemap,
    routeColor: sanitizeColor(source.routeColor, DEFAULT_MAP_SETTINGS.routeColor),
    terrainPlacemarkMode: source.terrainPlacemarkMode === 'point' || source.terrainPlacemarkMode === 'marker' ? source.terrainPlacemarkMode : DEFAULT_MAP_SETTINGS.terrainPlacemarkMode,
    sandboxPlacemarkMode: source.sandboxPlacemarkMode === 'point' || source.sandboxPlacemarkMode === 'marker' ? source.sandboxPlacemarkMode : DEFAULT_MAP_SETTINGS.sandboxPlacemarkMode,
    placemarkPointSize: sanitizePlacemarkPointSize(source.placemarkPointSize),
    placemarkPointColor: sanitizeColor(source.placemarkPointColor, DEFAULT_MAP_SETTINGS.placemarkPointColor),
    placemarkGroupColor: sanitizeColor(source.placemarkGroupColor, DEFAULT_MAP_SETTINGS.placemarkGroupColor),
    placemarkPointRadius: sanitizePlacemarkPointRadius(source.placemarkPointRadius),
    placemarkPointShowCount: typeof source.placemarkPointShowCount === 'boolean' ? source.placemarkPointShowCount : DEFAULT_MAP_SETTINGS.placemarkPointShowCount,
    placemarkPointShowName: typeof source.placemarkPointShowName === 'boolean' ? source.placemarkPointShowName : DEFAULT_MAP_SETTINGS.placemarkPointShowName,
    sandboxLabelColor: sanitizeColor(source.sandboxLabelColor, DEFAULT_MAP_SETTINGS.sandboxLabelColor),
    sandboxLabelSize: sanitizeSandboxLabelSize(source.sandboxLabelSize),
    sandboxLabelHeight: sanitizeSandboxLabelHeight(source.sandboxLabelHeight),
    sandboxConnectorColor: sanitizeColor(source.sandboxConnectorColor, DEFAULT_MAP_SETTINGS.sandboxConnectorColor),
    sandboxMarkerPaletteVersion: 3,
    maptilerKey, tiandituKey, terrainProvider: source.terrainProvider === 'maptiler' && maptilerKey ? 'maptiler' : 'mapterhorn',
    exaggeration: numberWithin(source.exaggeration, 1.25, 1, 3),
    quality: source.quality === 'eco' || source.quality === 'fine' ? source.quality : 'standard',
    buildings: typeof source.buildings === 'boolean' ? source.buildings : false,
    lighting: sanitizeLighting(source.lighting),
    sandboxColors: sanitizeSandboxColors(source.sandboxColors),
    sandboxBackground: source.sandboxBackground === 'environment' ? 'environment' : 'solid',
    sandboxPlacemarks: typeof source.sandboxPlacemarks === 'boolean' ? source.sandboxPlacemarks : true,
  }
}
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
function browserStorage(): PreferenceStorage | undefined {try {return typeof localStorage === 'undefined' ? undefined : localStorage} catch {return undefined}}
export function readMapSettings(storage: PreferenceStorage | undefined = browserStorage()): MapSettings {
  try {
    const stored = storage?.getItem(MAP_SETTINGS_KEY)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (parsed && typeof parsed === 'object' && (parsed as {version?: unknown}).version === 1) {
        const settings = sanitizeMapSettings(parsed)
        // Migrate known previous defaults once; a revision-2 cyan/cyan pair was an explicit user choice.
        const revision = (parsed as {sandboxMarkerPaletteVersion?: unknown}).sandboxMarkerPaletteVersion
        const previousDefault = settings.routeColor === LEGACY_TRACK_COLOR
          && (settings.sandboxConnectorColor === LEGACY_CONNECTOR_COLOR
            || (revision !== 2 && settings.sandboxConnectorColor === LEGACY_TRACK_COLOR))
        if (revision !== 3 && previousDefault) {
          settings.routeColor = DEFAULT_MAP_SETTINGS.routeColor
          settings.sandboxConnectorColor = DEFAULT_MAP_SETTINGS.sandboxConnectorColor
          try {storage?.setItem(MAP_SETTINGS_KEY, JSON.stringify(settings))} catch { /* Keep the migrated value in memory if storage refuses writes. */ }
        }
        return settings
      }
    }
  } catch { /* Malformed/blocked storage falls through to the legacy preference. */ }
  try {return sanitizeMapSettings({basemap: storage?.getItem(LEGACY_BASEMAP_KEY)})} catch {return sanitizeMapSettings(null)}
}
export function writeMapSettings(value: MapSettings, storage: PreferenceStorage | undefined = browserStorage()): MapSettings {
  const settings = sanitizeMapSettings(value)
  try {storage?.setItem(MAP_SETTINGS_KEY, JSON.stringify(settings)); storage?.setItem(LEGACY_BASEMAP_KEY, settings.basemap)} catch { /* Memory state still works when storage is unavailable. */ }
  return settings
}
