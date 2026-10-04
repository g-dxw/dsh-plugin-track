import type {Map as MapLibreMap, LayerSpecification, SourceSpecification} from 'maplibre-gl'
import {describe, expect, it, vi} from 'vitest'
import {configureMapTerrain, isMapTerrainError, MAP_DEM_SOURCE} from '../src/track/map-terrain.ts'
import {sanitizeMapSettings} from '../src/track/map-settings.ts'
import {TRACK_CASING, TRACK_LINE} from '../src/track/trail-layer.ts'

const HILLS = 'cqai-track-map-hillshade'
const BUILDINGS = 'cqai-track-map-buildings'
const ROUTE = 'cqai-track-line'
const ROUTE_SOURCE = 'cqai-track-geojson'
const routeLayer: LayerSpecification = {id: ROUTE, type: 'line', source: ROUTE_SOURCE}
const routeSource: SourceSpecification = {type: 'geojson', data: {type: 'FeatureCollection', features: []}}
const footprint: LayerSpecification = {id: 'building-footprint', type: 'fill', source: 'openmaptiles', 'source-layer': 'building'}
const label: LayerSpecification = {id: 'place-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place'}
function fakeMap(initialLayers: LayerSpecification[] = [routeLayer]) {
  const sources = new Map<string, SourceSpecification & {setData?: ReturnType<typeof vi.fn>}>([[ROUTE_SOURCE, routeSource], ['openmaptiles', {type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf']} ]])
  const layers = new Map<string, LayerSpecification>(initialLayers.map(layer => [layer.id, {...layer}]))
  const events: string[] = []
  let terrain: {source: string; exaggeration?: number} | null = null
  const state = {ready: true, zoom: 12}
  const calls = {
    style: {},
    getStyle: vi.fn(() => state.ready ? {version: 8, sources: Object.fromEntries(sources), layers: [...layers.values()]} : undefined),
    getSource: vi.fn((id: string) => sources.get(id)), getLayer: vi.fn((id: string) => layers.get(id)),
    addSource: vi.fn((id: string, source: SourceSpecification) => {
      events.push(`source+${id}`)
      if (source.type === 'geojson') Object.assign(source, {setData: vi.fn((data: GeoJSON.GeoJSON) => {source.data = data})})
      sources.set(id, source)
    }),
    removeSource: vi.fn((id: string) => {
      if ([...layers.values()].some(layer => 'source' in layer && layer.source === id)) throw new Error('Source still referenced by layer')
      if (terrain?.source === id) throw new Error('Source still referenced by terrain')
      events.push(`source-${id}`); sources.delete(id)
    }),
    addLayer: vi.fn((layer: LayerSpecification, before?: string) => {events.push(`layer+${layer.id}`); layers.set(layer.id, layer)}),
    removeLayer: vi.fn((id: string) => {events.push(`layer-${id}`); layers.delete(id)}),
    getTerrain: vi.fn(() => terrain),
    getZoom: vi.fn(() => state.zoom),
    setTerrain: vi.fn((value: {source: string; exaggeration?: number} | null) => {events.push(value ? 'terrain+' : 'terrain-'); terrain = value}),
    setSky: vi.fn(),
    getPaintProperty: vi.fn((id: string, property: string) => (layers.get(id) as {paint?: Record<string, unknown>} | undefined)?.paint?.[property]),
    setPaintProperty: vi.fn((id: string, property: string, value: unknown) => {
      const layer = layers.get(id)!
      layers.set(id, {...layer, paint: {...('paint' in layer ? layer.paint : {}), [property]: value}} as LayerSpecification)
    }),
    getLayoutProperty: vi.fn((id: string, property: string) => (layers.get(id)?.layout as Record<string, unknown> | undefined)?.[property]),
    setLayoutProperty: vi.fn((id: string, property: string, value: unknown) => {
      const layer = layers.get(id)!
      layers.set(id, {...layer, layout: {...layer.layout, [property]: value}} as LayerSpecification)
    }),
  }
  return {map: calls as unknown as MapLibreMap, calls, sources, layers, events, state}
}

describe('native map terrain lifecycle', () => {
  it('waits for a style before touching any sources or layers', () => {
    const value = fakeMap(); value.state.ready = false
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    expect(value.calls.addSource).not.toHaveBeenCalled(); expect(value.calls.setTerrain).not.toHaveBeenCalled()
  })
  it.each([
    ['mapterhorn', '', 'terrarium', 12], ['maptiler', 'test-key', 'mapbox', 14],
  ] as const)('uses the encoding and source zoom of %s', (provider, key, encoding, zoom) => {
    const value = fakeMap()
    configureMapTerrain(value.map, sanitizeMapSettings({terrainProvider: provider, maptilerKey: key}), true, 'vector')
    const source = value.sources.get(MAP_DEM_SOURCE)
    expect(source).toMatchObject({type: 'raster-dem', encoding, tileSize: 512, maxzoom: zoom})
    expect(value.calls.setTerrain).toHaveBeenCalledWith({source: MAP_DEM_SOURCE, exaggeration: 1.25})
    expect(value.calls.addLayer.mock.calls[0][1]).toBe(ROUTE)
    if (!source || source.type !== 'raster-dem') throw new Error('Missing DEM source')
    expect(source.attribution).toContain(provider === 'maptiler' ? 'MapTiler' : 'Mapterhorn')
    expect(provider === 'maptiler' ? source.url : source.tiles?.[0]).toContain(provider === 'maptiler' ? 'terrain-rgb-v2/tiles.json?key=test-key' : 'tiles.mapterhorn.com')
  })
  it('keeps hillshade above the offline background and below the route', () => {
    const value = fakeMap([{id:'cqai-track-background', type:'background', paint:{'background-color':'#eef1f5'}}, routeLayer])
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'none')
    expect(value.calls.addLayer.mock.calls.find(([layer]) => layer.id === HILLS)?.[1]).toBe(ROUTE)
  })
  it('removes terrain and hillshade before switching provider, preserving route objects', () => {
    const value = fakeMap(); const route = value.layers.get(ROUTE)
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    value.events.length = 0
    configureMapTerrain(value.map, sanitizeMapSettings({terrainProvider: 'maptiler', maptilerKey: 'key'}), true, 'vector')
    expect(value.events.slice(0, 3)).toEqual(['terrain-', `layer-${HILLS}`, `source-${MAP_DEM_SOURCE}`])
    expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource); expect(value.layers.get(ROUTE)).toBe(route)
    expect(value.calls.removeSource).toHaveBeenCalledExactlyOnceWith(MAP_DEM_SOURCE)
    expect(value.sources.get(MAP_DEM_SOURCE)).toMatchObject({encoding: 'mapbox', maxzoom: 14})
  })
  it('refreshes a MapTiler source after key rotation', () => {
    const value = fakeMap()
    configureMapTerrain(value.map, sanitizeMapSettings({terrainProvider: 'maptiler', maptilerKey: 'old-key'}), true, 'vector')
    configureMapTerrain(value.map, sanitizeMapSettings({terrainProvider: 'maptiler', maptilerKey: 'new-key'}), true, 'vector')
    expect(value.calls.removeSource).toHaveBeenCalledOnce()
    expect(value.sources.get(MAP_DEM_SOURCE)).toMatchObject({url: 'https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=new-key'})
  })
  it('updates exaggeration without rebuilding DEM, hillshade or track sources', () => {
    const value = fakeMap()
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    configureMapTerrain(value.map, sanitizeMapSettings({exaggeration: 2}), true, 'vector')
    configureMapTerrain(value.map, sanitizeMapSettings({exaggeration: 2}), true, 'vector')
    expect(value.calls.addSource).toHaveBeenCalledOnce(); expect(value.calls.removeSource).not.toHaveBeenCalled()
    expect(value.calls.setTerrain).toHaveBeenCalledTimes(2)
    expect(value.calls.setTerrain).toHaveBeenLastCalledWith({source: MAP_DEM_SOURCE, exaggeration: 2})
  })
  it('disables only its terrain source and layers, preserving foreign map data', () => {
    const value = fakeMap([routeLayer, footprint, label])
    value.sources.set('foreign-dem', {type: 'raster-dem', tiles: ['https://elsewhere/{z}/{x}/{y}.png']})
    configureMapTerrain(value.map, sanitizeMapSettings({buildings: true}), true, 'vector')
    configureMapTerrain(value.map, sanitizeMapSettings({buildings: true}), false, 'vector')
    expect(value.sources.has(MAP_DEM_SOURCE)).toBe(false); expect(value.layers.has(HILLS)).toBe(false); expect(value.layers.has(BUILDINGS)).toBe(false)
    expect(value.sources.has('foreign-dem')).toBe(true); expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource)
    expect(value.layers.has(ROUTE)).toBe(true); expect(value.layers.has('building-footprint')).toBe(true)
    expect(value.calls.setTerrain).toHaveBeenLastCalledWith(null); expect(value.calls.setSky).toHaveBeenLastCalledWith(undefined)
  })
  it('leaves an unrelated native terrain untouched when disabled without prior installation', () => {
    const value = fakeMap(); value.calls.setTerrain({source: 'foreign-dem', exaggeration: 1})
    value.calls.setTerrain.mockClear()
    configureMapTerrain(value.map, sanitizeMapSettings(null), false, 'none')
    expect(value.calls.setTerrain).not.toHaveBeenCalled(); expect(value.calls.removeSource).not.toHaveBeenCalled()
  })
  it('reinstalls its source after a style identity changes', () => {
    const value = fakeMap()
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    value.calls.style = {}; value.sources.delete(MAP_DEM_SOURCE); value.layers.delete(HILLS)
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'satellite')
    expect(value.calls.addSource).toHaveBeenCalledTimes(2); expect(value.layers.has(HILLS)).toBe(true)
  })
})


const routeWidthLayers: LayerSpecification[] = [
  {id: TRACK_CASING, type: 'line', source: ROUTE_SOURCE, paint: {'line-color': '#00000066', 'line-width': 8}},
  {id: TRACK_LINE, type: 'line', source: ROUTE_SOURCE, paint: {'line-color': '#23aaff', 'line-width': 4}},
]
describe('native terrain route width lifecycle', () => {
  it('restores 2D widths after leaving 3D without changing route data or color', () => {
    const value = fakeMap(routeWidthLayers)
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'satellite')
    expect(Array.isArray(value.calls.getPaintProperty(TRACK_LINE, 'line-width'))).toBe(true)
    expect(Array.isArray(value.calls.getPaintProperty(TRACK_CASING, 'line-width'))).toBe(true)
    expect(value.calls.getPaintProperty(TRACK_LINE, 'line-width-transition')).toEqual({duration: 0, delay: 0})
    configureMapTerrain(value.map, sanitizeMapSettings(null), false, 'satellite')
    expect(value.calls.getPaintProperty(TRACK_LINE, 'line-width')).toBe(4)
    expect(value.calls.getPaintProperty(TRACK_CASING, 'line-width')).toBe(8)
    expect(value.calls.getPaintProperty(TRACK_LINE, 'line-color')).toBe('#23aaff')
    expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource)
    expect(value.calls.removeLayer.mock.calls.map(([id]) => id)).not.toContain(TRACK_LINE)
  })
  it('does not rewrite paint or rebuild route data on repeated terrain and zoom synchronization', () => {
    const value = fakeMap(routeWidthLayers)
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'satellite')
    value.calls.setPaintProperty.mockClear()
    value.state.zoom = 16
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'satellite')
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'satellite')
    expect(value.calls.setPaintProperty).not.toHaveBeenCalled()
    expect(value.calls.addSource).toHaveBeenCalledOnce()
    expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource)
  })
})

describe('building schema adapters and DEM error boundaries', () => {
  it.each([
    ['vector', 'render_height', 'render_min_height'], ['maptiler-streets', 'height', 'height_min'],
  ] as const)('uses the %s footprint source with the matching height fields', (basemap, height, base) => {
    const value = fakeMap([footprint, label, routeLayer])
    configureMapTerrain(value.map, sanitizeMapSettings({buildings: true, maptilerKey: 'key'}), true, basemap)
    const layer = value.layers.get(BUILDINGS)
    expect(layer).toMatchObject({type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14, filter: ['has', height]})
    if (!layer || layer.type !== 'fill-extrusion') throw new Error('Missing building layer')
    expect(layer.paint?.['fill-extrusion-height']).toEqual(['coalesce', ['get', height], 0])
    expect(layer.paint?.['fill-extrusion-base']).toEqual(['coalesce', ['get', base], 0])
    expect(value.calls.addLayer.mock.calls.find(([item]) => item.id === BUILDINGS)?.[1]).toBe('place-label')
  })
  it('does not invent a building source for raster maps', () => {
    const value = fakeMap()
    configureMapTerrain(value.map, sanitizeMapSettings({buildings: true}), true, 'satellite')
    expect(value.layers.has(BUILDINGS)).toBe(false)
    expect(value.calls.addSource.mock.calls.map(([id]) => id)).toEqual([MAP_DEM_SOURCE])
  })
  it('uses existing style extrusions and reversibly toggles them', () => {
    const extrusion: LayerSpecification = {id: 'vendor-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building'}
    const value = fakeMap([extrusion, footprint, routeLayer])
    configureMapTerrain(value.map, sanitizeMapSettings({buildings: false}), true, 'maptiler-outdoor')
    expect(value.calls.setLayoutProperty).toHaveBeenLastCalledWith('vendor-buildings', 'visibility', 'none')
    configureMapTerrain(value.map, sanitizeMapSettings({buildings: true}), true, 'maptiler-outdoor')
    expect(value.calls.setLayoutProperty).toHaveBeenLastCalledWith('vendor-buildings', 'visibility', 'visible')
    expect(value.layers.has(BUILDINGS)).toBe(false)
  })
  it('recognizes its own DEM failures in nested events without matching track failures or cycles', () => {
    expect(isMapTerrainError({sourceId: MAP_DEM_SOURCE})).toBe(true)
    expect(isMapTerrainError({error: {cause: {tile: {source: MAP_DEM_SOURCE}}}})).toBe(true)
    expect(isMapTerrainError({error: {sourceId: ROUTE_SOURCE}})).toBe(false)
    const cycle: {cause?: unknown} = {}; cycle.cause = cycle
    expect(isMapTerrainError({error: cycle})).toBe(false)
    expect(isMapTerrainError('terrain failure')).toBe(false)
  })
})
const ENDS_SOURCE = 'cqai-track-ends'
const START = 'cqai-track-start'
const END = 'cqai-track-end'
const GROUND_ENDS = 'cqai-track-map-ground-ends'
const GROUND_FILL = 'cqai-track-map-ground-end-fill'
const GROUND_OUTLINE = 'cqai-track-map-ground-end-outline'
const endsData: GeoJSON.FeatureCollection<GeoJSON.Point> = {type: 'FeatureCollection', features: [
  {type: 'Feature', geometry: {type: 'Point', coordinates: [119.44, 30.33, 1600]}, properties: {role: 'start'}},
  {type: 'Feature', geometry: {type: 'Point', coordinates: [119.45, 30.34, 1700]}, properties: {role: 'end'}},
]}
function mapWithEnds() {
  const circles: LayerSpecification[] = [START, END].map(id => ({id, type: 'circle', source: ENDS_SOURCE, paint: {'circle-radius': 6}}))
  const value = fakeMap([routeLayer, ...circles])
  value.sources.set(ENDS_SOURCE, {type: 'geojson', data: endsData})
  return value
}
function groundData(value: ReturnType<typeof fakeMap>): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const source = value.sources.get(GROUND_ENDS)
  if (!source || source.type !== 'geojson' || typeof source.data !== 'object' || source.data.type !== 'FeatureCollection') throw new Error('Missing polygon endpoint source')
  return source.data as GeoJSON.FeatureCollection<GeoJSON.Polygon>
}

describe('native terrain endpoints share the route draping path', () => {
  it('uses fill and line polygons instead of live circles without changing stored elevation or endpoint roles', () => {
    const value = mapWithEnds()
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    expect(value.layers.get(GROUND_FILL)).toMatchObject({type: 'fill', source: GROUND_ENDS})
    expect(value.layers.get(GROUND_OUTLINE)).toMatchObject({type: 'line', source: GROUND_ENDS})
    expect(value.calls.getLayoutProperty(START, 'visibility')).toBe('none')
    expect(value.calls.getLayoutProperty(END, 'visibility')).toBe('none')
    const data = groundData(value)
    expect(data.features.map(feature => feature.properties?.role)).toEqual(['start', 'end'])
    for (const [index, feature] of data.features.entries()) {
      const ring = feature.geometry.coordinates[0]
      expect(ring).toHaveLength(33); expect(ring.at(-1)).toEqual(ring[0])
      expect(ring.every(position => position.length === 2 && position.every(Number.isFinite))).toBe(true)
      const [lon, lat] = endsData.features[index].geometry.coordinates
      expect(Math.min(...ring.map(position => position[0]))).toBeLessThan(lon)
      expect(Math.max(...ring.map(position => position[0]))).toBeGreaterThan(lon)
      expect(Math.min(...ring.map(position => position[1]))).toBeLessThan(lat)
      expect(Math.max(...ring.map(position => position[1]))).toBeGreaterThan(lat)
    }
    expect(value.sources.get(ENDS_SOURCE)).toMatchObject({data: endsData})
    expect(endsData.features[0].geometry.coordinates[2]).toBe(1600)
    expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource)
  })
  it('restores circle endpoints in 2D and removes only the owned draped geometry', () => {
    const value = mapWithEnds()
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    configureMapTerrain(value.map, sanitizeMapSettings(null), false, 'vector')
    expect(value.layers.has(GROUND_FILL)).toBe(false); expect(value.layers.has(GROUND_OUTLINE)).toBe(false)
    expect(value.sources.has(GROUND_ENDS)).toBe(false)
    expect(value.calls.getLayoutProperty(START, 'visibility')).toBe('visible')
    expect(value.calls.getLayoutProperty(END, 'visibility')).toBe('visible')
    expect(value.layers.get(START)).toMatchObject({type: 'circle', source: ENDS_SOURCE, paint: {'circle-radius': 6}})
    expect(value.sources.get(ENDS_SOURCE)).toMatchObject({data: endsData})
    expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource); expect(value.layers.has(ROUTE)).toBe(true)
  })
  it('rescales existing endpoint polygons on zoom without rebuilding DEM, route or endpoint layers', () => {
    const value = mapWithEnds()
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    const initialRadius = groundData(value).features[0].geometry.coordinates[0][0][0] - endsData.features[0].geometry.coordinates[0]
    const source = value.sources.get(GROUND_ENDS)!
    const initialLayer = value.layers.get(GROUND_FILL)
    value.state.zoom += 1
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    const zoomedRadius = groundData(value).features[0].geometry.coordinates[0][0][0] - endsData.features[0].geometry.coordinates[0]
    expect(zoomedRadius / initialRadius).toBeCloseTo(0.5, 8)
    expect(source.setData).toHaveBeenCalledOnce()
    expect(value.sources.get(GROUND_ENDS)).toBe(source); expect(value.layers.get(GROUND_FILL)).toBe(initialLayer)
    expect(value.calls.addSource.mock.calls.map(([id]) => id)).toEqual([MAP_DEM_SOURCE, GROUND_ENDS])
    expect(value.calls.removeSource).not.toHaveBeenCalled(); expect(value.calls.setTerrain).toHaveBeenCalledOnce()
    expect(value.sources.get(ROUTE_SOURCE)).toBe(routeSource)
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    expect(source.setData).toHaveBeenCalledOnce()
  })
  it('removes draped endpoints and restores circles when endpoint features become empty', () => {
    const value = mapWithEnds()
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    value.sources.set(ENDS_SOURCE, {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
    configureMapTerrain(value.map, sanitizeMapSettings(null), true, 'vector')
    expect(value.sources.has(GROUND_ENDS)).toBe(false); expect(value.layers.has(GROUND_FILL)).toBe(false)
    expect(value.calls.getLayoutProperty(START, 'visibility')).toBe('visible')
    expect(value.calls.getLayoutProperty(END, 'visibility')).toBe('visible')
    expect(value.sources.has(MAP_DEM_SOURCE)).toBe(true)
  })
})
