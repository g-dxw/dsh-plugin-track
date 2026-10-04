import type { Map as MapLibreMap, FillExtrusionLayerSpecification, ExpressionSpecification } from 'maplibre-gl'
import { terrainProviderFor, type BasemapId } from './basemaps.ts'
import type { MapSettings } from './map-settings.ts'
import { TRACK_CASING, TRACK_LINE } from './trail-layer.ts'

export const MAP_DEM_SOURCE = 'cqai-track-map-dem'
const HILLS = 'cqai-track-map-hillshade'
const BUILDINGS = 'cqai-track-map-buildings'
const installed = new WeakMap<MapLibreMap, {style: unknown; signature: string}>()

export function isMapTerrainError(event: unknown): boolean {
  const visited = new Set<unknown>()
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return false
    visited.add(value)
    const item = value as Record<string, unknown>
    return item.sourceId === MAP_DEM_SOURCE || item.source === MAP_DEM_SOURCE || item.id === MAP_DEM_SOURCE
      || ['source', 'tile', 'error', 'cause'].some(key => inspect(item[key], depth + 1))
  }
  return inspect(event, 0)
}

/** Only this module's DEM/layers are removed. Route sources and the camera stay intact. */
export function configureMapTerrain(map: MapLibreMap, settings: MapSettings, enabled: boolean, basemap: BasemapId): void {
  const style = map.getStyle()
  if (!style) return
  const provider = terrainProviderFor(settings)
  const signature = JSON.stringify([provider.id, provider.url, provider.tiles, provider.encoding, provider.maxzoom])
  const prior = installed.get(map)
  if (map.getSource(MAP_DEM_SOURCE) && (!enabled || prior?.style !== map.style || prior.signature !== signature)) {
    if (map.getTerrain?.()?.source === MAP_DEM_SOURCE) map.setTerrain(null)
    if (map.getLayer(HILLS)) map.removeLayer(HILLS)
    map.removeSource(MAP_DEM_SOURCE)
    installed.delete(map)
  }
  if (enabled) {
    if (!map.getSource(MAP_DEM_SOURCE)) {
      map.addSource(MAP_DEM_SOURCE, {
        type: 'raster-dem', ...(provider.url ? {url: provider.url} : {tiles: provider.tiles}),
        tileSize: provider.tileSize, encoding: provider.encoding, maxzoom: provider.maxzoom,
        attribution: provider.credits.map(credit => `<a href="${credit.url}" target="_blank" rel="noopener noreferrer">${credit.label}</a>`).join(' · '),
      })
      installed.set(map, {style: map.style, signature})
    }
    if (map.getTerrain?.()?.source !== MAP_DEM_SOURCE || map.getTerrain?.()?.exaggeration !== settings.exaggeration) {
      map.setTerrain({source: MAP_DEM_SOURCE, exaggeration: settings.exaggeration})
    }
    if (!map.getLayer(HILLS)) {
      // Satellite imagery already contains sunlight and shadows. Keep its colors
      // intact instead of painting pale highlights and slope accents over it.
      const satellite = basemap === 'satellite' || basemap === 'maptiler-satellite'
      map.addLayer({id: HILLS, type: 'hillshade', source: MAP_DEM_SOURCE, paint: {
        ...(satellite ? {
          'hillshade-shadow-color': 'rgba(0, 0, 0, 0.22)',
          'hillshade-highlight-color': 'rgba(0, 0, 0, 0)',
          'hillshade-accent-color': 'rgba(0, 0, 0, 0)',
          'hillshade-illumination-anchor': 'map' as const,
          'hillshade-exaggeration': 0.25,
        } : {
          'hillshade-shadow-color': '#403b36', 'hillshade-highlight-color': '#f8f3e8',
          'hillshade-exaggeration': 0.35,
        }),
        'hillshade-illumination-direction': 315,
      }}, style.layers.find(layer => layer.type === 'symbol' || (layer.type !== 'background' && layer.id.startsWith('cqai-track-')))?.id)
    }
    map.setSky?.({'sky-color': '#c8e4f2', 'horizon-color': '#edf3f5', 'fog-color': '#edf3f5'})
  } else if (prior || map.getTerrain?.()?.source === MAP_DEM_SOURCE) {
    if (map.getTerrain?.()?.source === MAP_DEM_SOURCE) map.setTerrain(null)
    // MapLibre's runtime accepts undefined to remove sky; its public type omits it.
    map.setSky?.(undefined as unknown as Parameters<MapLibreMap['setSky']>[0])
  }
  configureTrackWidths(map, enabled)
  configureGroundEnds(map, enabled)
  configureBuildings(map, enabled && settings.buildings, basemap)
}

const TERRAIN_TRACK_WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 10, 1.5, 12, 1.7, 14, 2.1, 17, 3]
const TERRAIN_CASING_WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 10, 2.4, 12, 2.6, 14, 3.1, 17, 4]
const WIDTH_TRANSITION = {duration: 0, delay: 0}

// Keep a fine route on the terrain texture, with enough width when zoomed in.
// Width changes must be immediate: terrain can cache an early transition frame.
function configureTrackWidths(map: MapLibreMap, enabled: boolean): void {
  for (const [id, flatWidth, terrainWidth] of [
    [TRACK_LINE, 4, TERRAIN_TRACK_WIDTH], [TRACK_CASING, 8, TERRAIN_CASING_WIDTH],
  ] as const) {
    if (!map.getLayer(id)) continue
    const width = enabled ? terrainWidth : flatWidth
    if (JSON.stringify(map.getPaintProperty(id, 'line-width')) === JSON.stringify(width)) continue
    if (JSON.stringify(map.getPaintProperty(id, 'line-width-transition')) !== JSON.stringify(WIDTH_TRANSITION)) {
      map.setPaintProperty(id, 'line-width-transition', WIDTH_TRANSITION)
    }
    map.setPaintProperty(id, 'line-width', width)
  }
}

function configureBuildings(map: MapLibreMap, enabled: boolean, basemap: BasemapId): void {
  const style = map.getStyle()
  if (!style) return
  const existing = (style.layers ?? []).filter(layer => layer.type === 'fill-extrusion' && layer.id !== BUILDINGS)
  for (const layer of existing) {
    const visibility = enabled ? 'visible' : 'none'
    if (map.getLayoutProperty(layer.id, 'visibility') !== visibility) map.setLayoutProperty(layer.id, 'visibility', visibility)
  }
  if (map.getLayer(BUILDINGS)) {
    if (!enabled) map.removeLayer(BUILDINGS)
    return
  }
  if (!enabled || existing.length) return
  // Discover the source layer in the actual style; raster maps have no buildings.
  const footprint = (style.layers ?? []).find(layer => 'source-layer' in layer && layer['source-layer'] === 'building' && 'source' in layer)
  if (!footprint || !('source' in footprint) || !('source-layer' in footprint)) return
  const modern = basemap.startsWith('maptiler-')
  const height = modern ? 'height' : 'render_height'
  const base = modern ? 'height_min' : 'render_min_height'
  const layer: FillExtrusionLayerSpecification = {
    id: BUILDINGS, type: 'fill-extrusion', source: footprint.source!,
    'source-layer': footprint['source-layer'], minzoom: 14,
    filter: ['has', height],
    paint: {
      'fill-extrusion-color': '#c6c0b6',
      'fill-extrusion-height': ['coalesce', ['get', height], 0],
      'fill-extrusion-base': ['coalesce', ['get', base], 0],
      'fill-extrusion-opacity': 0.75,
    },
  }
  map.addLayer(layer, style.layers.find(item => item.type === 'symbol')?.id)
}

// Lines and fills use MapLibre's draped terrain mesh; native circle layers sample
// DEM height separately and can float away from the route on a steep slope.
const GROUND_ENDS = 'cqai-track-map-ground-ends'
const GROUND_END_FILL = 'cqai-track-map-ground-end-fill'
const GROUND_END_OUTLINE = 'cqai-track-map-ground-end-outline'
const groundEndState = new WeakMap<MapLibreMap, string>()
function configureGroundEnds(map: MapLibreMap, enabled: boolean): void {
  const original = ['cqai-track-start', 'cqai-track-end']
  const remove = () => {
    for (const id of [GROUND_END_OUTLINE, GROUND_END_FILL]) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(GROUND_ENDS)) map.removeSource(GROUND_ENDS)
    groundEndState.delete(map)
  }
  const style = map.getStyle()
  const source = style?.sources?.['cqai-track-ends']
  const points = source?.type === 'geojson' && typeof source.data === 'object' && source.data.type === 'FeatureCollection'
    ? source.data.features.filter(feature => feature.geometry?.type === 'Point') : []
  if (!enabled || !points.length) {
    remove()
    for (const id of original) if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') === 'none') map.setLayoutProperty(id, 'visibility', 'visible')
    return
  }
  const zoom = Math.round((map.getZoom?.() ?? 12) * 100) / 100
  const signature = JSON.stringify([zoom, points])
  if (!map.getSource(GROUND_ENDS) || groundEndState.get(map) !== signature) {
    const radius = 10 * 360 / (512 * 2 ** zoom)
    const features = points.flatMap<GeoJSON.Feature<GeoJSON.Polygon>>(feature => {
      if (feature.geometry?.type !== 'Point') return []
      const [lon, lat] = feature.geometry.coordinates
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return []
      const ring = Array.from({length: 33}, (_, index) => {
        const angle = index / 32 * Math.PI * 2
        return [lon + Math.cos(angle) * radius, lat + Math.sin(angle) * radius * Math.cos(lat * Math.PI / 180)]
      })
      ring[32] = ring[0]
      return [{type: 'Feature', geometry: {type: 'Polygon', coordinates: [ring]}, properties: feature.properties}]
    })
    const data: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {type: 'FeatureCollection', features}
    const existing = map.getSource(GROUND_ENDS)
    if (existing?.type === 'geojson') (existing as import('maplibre-gl').GeoJSONSource).setData(data)
    else map.addSource(GROUND_ENDS, {type: 'geojson', data})
    groundEndState.set(map, signature)
  }
  if (!map.getLayer(GROUND_END_FILL)) map.addLayer({
    id: GROUND_END_FILL, type: 'fill', source: GROUND_ENDS,
    paint: {'fill-color': ['match', ['get', 'role'], 'start', '#4ade80', '#f87171'], 'fill-opacity': 0.99},
  })
  if (!map.getLayer(GROUND_END_OUTLINE)) map.addLayer({
    id: GROUND_END_OUTLINE, type: 'line', source: GROUND_ENDS,
    paint: {'line-color': '#ffffff', 'line-width': 2},
  })
  for (const id of original) if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') map.setLayoutProperty(id, 'visibility', 'none')
}
