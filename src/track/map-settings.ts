/** Browser-local map preferences; never included in exported tracks or Agent context. */
import type { BasemapId } from './basemaps.ts'
import { TRACK_COLOR } from './trail-layer.ts'

export type SandboxQuality = 'eco' | 'standard' | 'fine'
export type SandboxBackground = 'solid' | 'environment'
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
export const DEFAULT_SANDBOX_LIGHTING: Readonly<SandboxLighting> = Object.freeze({azimuth: 118, elevation: 85, intensity: 4.1, ambient: 0.65, shadows: true})
export const DEFAULT_SANDBOX_COLORS: Readonly<SandboxColors> = Object.freeze({sides: '#707070', background: '#bacaaa'})
export const DEFAULT_MAP_SETTINGS: Readonly<MapSettings> = Object.freeze({
  version: 1, basemap: 'vector', routeColor: TRACK_COLOR, maptilerKey: '', tiandituKey: '', terrainProvider: 'mapterhorn',
  exaggeration: 1.25, quality: 'standard', buildings: false, lighting: DEFAULT_SANDBOX_LIGHTING, sandboxColors: DEFAULT_SANDBOX_COLORS, sandboxBackground: 'solid', sandboxPlacemarks: true,
})
const BASEMAP_IDS = ['vector', 'terrain', 'satellite', 'none', 'osm', 'maptiler-streets', 'maptiler-outdoor', 'maptiler-satellite'] as const
export function isBasemapId(value: unknown): value is BasemapId {return BASEMAP_IDS.includes(value as BasemapId)}
function numberWithin(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
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
export function sanitizeSandboxColors(value: unknown): SandboxColors {
  const colors = value && typeof value === 'object' ? value as Partial<SandboxColors> : {}
  const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
  return {sides: color(colors.sides, DEFAULT_SANDBOX_COLORS.sides), background: color(colors.background, DEFAULT_SANDBOX_COLORS.background)}
}
/** Reject unknown/invalid fields and return a fresh complete value. */
export function sanitizeMapSettings(value: unknown): MapSettings {
  const source = value && typeof value === 'object' ? value as Partial<MapSettings> : {}
  const maptilerKey = typeof source.maptilerKey === 'string' ? source.maptilerKey.trim().slice(0, 512) : ''
  const tiandituKey = typeof source.tiandituKey === 'string' ? source.tiandituKey.trim().slice(0, 512) : ''
  const basemap = isBasemapId(source.basemap) ? source.basemap : DEFAULT_MAP_SETTINGS.basemap
  return {
    version: 1, basemap: basemap.startsWith('maptiler-') && !maptilerKey ? 'vector' : basemap,
    routeColor: typeof source.routeColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.routeColor.trim()) ? source.routeColor.trim().toLowerCase() : DEFAULT_MAP_SETTINGS.routeColor,
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
      if (parsed && typeof parsed === 'object' && (parsed as {version?: unknown}).version === 1) return sanitizeMapSettings(parsed)
    }
  } catch { /* Malformed/blocked storage falls through to the legacy preference. */ }
  try {return sanitizeMapSettings({basemap: storage?.getItem(LEGACY_BASEMAP_KEY)})} catch {return sanitizeMapSettings(null)}
}
export function writeMapSettings(value: MapSettings, storage: PreferenceStorage | undefined = browserStorage()): MapSettings {
  const settings = sanitizeMapSettings(value)
  try {storage?.setItem(MAP_SETTINGS_KEY, JSON.stringify(settings)); storage?.setItem(LEGACY_BASEMAP_KEY, settings.basemap)} catch { /* Memory state still works when storage is unavailable. */ }
  return settings
}
