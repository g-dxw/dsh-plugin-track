/** Public tile services and their mandatory credits. API keys stay browser-local. */
import type { StyleSpecification } from 'maplibre-gl'
import type { MapCredit, MapSettings, TerrainProviderDefinition } from './map-settings.ts'
import openfreemap from './basemap/openfreemap.json'

export type BasemapId = 'vector' | 'terrain' | 'satellite' | 'none' | 'osm' | 'maptiler-streets' | 'maptiler-outdoor' | 'maptiler-satellite'
export interface BasemapOption {id: BasemapId; label: string; attribution?: string; credits?: readonly MapCredit[]; requiresKey?: boolean}
export const MAPTILER_LOGO_URL = 'https://api.maptiler.com/resources/logo.svg'
export const OSM_CREDIT: MapCredit = {label: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright'}
export const MAPTILER_CREDIT: MapCredit = {label: '© MapTiler', url: 'https://www.maptiler.com/copyright/'}
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
const MAPTILER_ATTRIBUTION = '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">&copy; MapTiler</a> ' + OSM_ATTRIBUTION
const TERRAIN_ATTRIBUTION = '&copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener noreferrer">OpenTopoMap</a> (CC-BY-SA)'
const SATELLITE_URL = 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9'
const SATELLITE_CREDITS = 'Esri, Vantor, Earthstar Geographics, and the GIS User Community'
const SATELLITE_ATTRIBUTION = `Source: <a href="${SATELLITE_URL}" target="_blank" rel="noopener noreferrer">${SATELLITE_CREDITS}</a>`
export const BASEMAP_OPTIONS: readonly BasemapOption[] = [
  {id: 'vector', label: '矢量', attribution: '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' + OSM_ATTRIBUTION,
    credits: [OSM_CREDIT, {label: 'OpenMapTiles', url: 'https://www.openmaptiles.org/'}, {label: 'OpenFreeMap', url: 'https://openfreemap.org/'}]},
  {id: 'terrain', label: '地形', attribution: TERRAIN_ATTRIBUTION,
    credits: [{label: '© OpenStreetMap contributors, SRTM', url: OSM_CREDIT.url}, {label: 'OpenTopoMap (CC-BY-SA)', url: 'https://opentopomap.org'}]},
  {id: 'satellite', label: '卫星', attribution: SATELLITE_ATTRIBUTION, credits: [{label: `Source: ${SATELLITE_CREDITS}`, url: SATELLITE_URL}]},
  {id: 'none', label: '无底图'},
  {id: 'osm', label: 'OpenStreetMap', attribution: OSM_ATTRIBUTION, credits: [OSM_CREDIT]},
  {id: 'maptiler-streets', label: 'MapTiler 街道', attribution: MAPTILER_ATTRIBUTION, credits: [MAPTILER_CREDIT, OSM_CREDIT], requiresKey: true},
  {id: 'maptiler-outdoor', label: 'MapTiler 户外', attribution: MAPTILER_ATTRIBUTION, credits: [MAPTILER_CREDIT, OSM_CREDIT], requiresKey: true},
  {id: 'maptiler-satellite', label: 'MapTiler 卫星', attribution: MAPTILER_ATTRIBUTION, credits: [MAPTILER_CREDIT, OSM_CREDIT], requiresKey: true},
]
export const DEFAULT_BASEMAP: BasemapId = 'vector'
export const VECTOR_STYLE = openfreemap as unknown as StyleSpecification
export const TERRAIN_STYLE: StyleSpecification = {
  version: 8, sources: {opentopomap: {type: 'raster', tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 17, attribution: TERRAIN_ATTRIBUTION}},
  layers: [{id: 'opentopomap', type: 'raster', source: 'opentopomap'}],
}
export const SATELLITE_STYLE: StyleSpecification = {
  version: 8, sources: {'esri-world-imagery': {type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: SATELLITE_ATTRIBUTION}},
  layers: [{id: 'esri-world-imagery', type: 'raster', source: 'esri-world-imagery'}],
}
export const OSM_STYLE: StyleSpecification = {
  version: 8, sources: {osm: {type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIBUTION}},
  layers: [{id: 'osm', type: 'raster', source: 'osm'}],
}
/** The track stays usable with no network. */
export const BLANK_STYLE: StyleSpecification = {
  version: 8, sources: {}, layers: [{id: 'cqai-track-background', type: 'background', paint: {'background-color': '#eef1f5'}}],
}
export function styleFor(basemap: BasemapId, settings?: Pick<MapSettings, 'maptilerKey'>): StyleSpecification | string {
  if (basemap === 'vector') return VECTOR_STYLE
  if (basemap === 'terrain') return TERRAIN_STYLE
  if (basemap === 'satellite') return SATELLITE_STYLE
  if (basemap === 'osm') return OSM_STYLE
  if (basemap.startsWith('maptiler-')) {
    if (!settings?.maptilerKey.trim()) return VECTOR_STYLE
    const style = basemap === 'maptiler-streets' ? 'streets-v4' : basemap === 'maptiler-outdoor' ? 'outdoor-v4' : 'satellite-v4'
    return `https://api.maptiler.com/maps/${style}/style.json?key=${encodeURIComponent(settings.maptilerKey.trim())}`
  }
  return BLANK_STYLE
}
export function basemapCredits(basemap: BasemapId): readonly MapCredit[] {return BASEMAP_OPTIONS.find(option => option.id === basemap)?.credits ?? []}
export function terrainProviderFor(settings?: Pick<MapSettings, 'terrainProvider' | 'maptilerKey'>): TerrainProviderDefinition {
  if (settings?.terrainProvider === 'maptiler' && settings.maptilerKey.trim()) return {
    id: 'maptiler', url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${encodeURIComponent(settings.maptilerKey.trim())}`,
    encoding: 'mapbox', tileSize: 512, maxzoom: 14, credits: [MAPTILER_CREDIT],
  }
  return {id: 'mapterhorn', tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'], encoding: 'terrarium', tileSize: 512, maxzoom: 12,
    credits: [{label: '© Mapterhorn', url: 'https://mapterhorn.com/'}]}
}
