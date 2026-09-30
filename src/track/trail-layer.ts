/**
 * The track line, as MapLibre sources and layers.
 *
 * Adapted from wanderer's `vendor/maplibre-layer-manager/trail-layer.ts`, which
 * expresses a layer as a whole standalone style. Swapping basemaps replaces the
 * style, so the track has to be re-addable to a map that was just reset — these
 * helpers do that idempotently instead of returning a style fragment.
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { TrackPoint } from '../protocol.ts'

export const TRACK_SOURCE = 'cqai-track-line'
export const TRACK_CASING = 'cqai-track-casing'
export const TRACK_LINE = 'cqai-track-line-stroke'
export const TRACK_START = 'cqai-track-start'
export const TRACK_END = 'cqai-track-end'
export const TRACK_ENDS_SOURCE = 'cqai-track-ends'

/** Track colour; also used by the elevation chart so the two read as one thing. */
export const TRACK_COLOR = '#b8a1ff'

export interface TrackGeoJSON {
  line: GeoJSON.Feature<GeoJSON.LineString>
  ends: GeoJSON.FeatureCollection<GeoJSON.Point>
}

/**
 * `[lon, lat, ele, time][]` (the storage form) → GeoJSON.
 *
 * The elevation is carried on the position, which is what the elevation
 * profile reads back out; the timestamp rides along in `coordinateProperties`
 * the same way wanderer's `TrackSegment.toGeoJSON` puts it.
 */
export function toGeoJSON(points: readonly TrackPoint[]): TrackGeoJSON {
  const coordinates: number[][] = []
  const times: (string | null)[] = []
  for (const [lon, lat, ele, time] of points) {
    if (typeof lon !== 'number' || typeof lat !== 'number') continue
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    coordinates.push(Number.isFinite(ele) ? [lon, lat, ele as number] : [lon, lat])
    times.push(time ? new Date(time).toISOString() : null)
  }

  const line: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    geometry: {type: 'LineString', coordinates},
    properties: {coordinateProperties: {times}},
  }

  const ends: GeoJSON.FeatureCollection<GeoJSON.Point> = {type: 'FeatureCollection', features: []}
  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  if (first) ends.features.push({type: 'Feature', geometry: {type: 'Point', coordinates: first}, properties: {role: 'start'}})
  if (last) ends.features.push({type: 'Feature', geometry: {type: 'Point', coordinates: last}, properties: {role: 'end'}})

  return {line, ends}
}

/**
 * Add (or refresh) the track on a map. Safe to call after a `setStyle`, and
 * safe to call twice — an existing source or layer is replaced, not duplicated.
 */
export function addTrack(map: MapLibreMap, data: TrackGeoJSON): void {
  setData(map, TRACK_SOURCE, data.line)
  setData(map, TRACK_ENDS_SOURCE, data.ends)
  ensureLayer(map, {
    id: TRACK_CASING,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#00000066', 'line-width': 8 },
  })
  ensureLayer(map, {
    id: TRACK_LINE,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TRACK_COLOR, 'line-width': 4 },
  })
  for (const [id, role] of [[TRACK_START, 'start'], [TRACK_END, 'end']] as const) {
    ensureLayer(map, {
      id,
      type: 'circle',
      source: TRACK_ENDS_SOURCE,
      filter: ['==', ['get', 'role'], role],
      paint: {
        'circle-radius': 6,
        'circle-color': role === 'start' ? '#4ade80' : '#f87171',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    })
  }
}

/** Drop every track layer and source, leaving the basemap alone. */
export function removeTrack(map: MapLibreMap): void {
  for (const id of [TRACK_ENDS_SOURCE, TRACK_SOURCE]) {
    if (map.getLayer(`${id}-stroke`)) map.removeLayer(`${id}-stroke`)
  }
  for (const id of [TRACK_CASING, TRACK_LINE, TRACK_START, TRACK_END]) {
    if (map.getLayer(id)) map.removeLayer(id)
  }
  for (const id of [TRACK_ENDS_SOURCE, TRACK_SOURCE]) {
    if (map.getSource(id)) map.removeSource(id)
  }
}

/** Is `source` in this style, and is it one we can push data into? */
export function hasTrackStyle(map: MapLibreMap): boolean {
  return Boolean(map.getSource(TRACK_SOURCE))
}

function setData(map: MapLibreMap, id: string, data: GeoJSON.Feature | GeoJSON.FeatureCollection): void {
  const source = map.getSource(id) as GeoJSONSource | undefined
  if (source) {
    source.setData(data as GeoJSON.GeoJSON)
    return
  }
  if (!map.style || !styleIsReady(map)) return
  map.addSource(id, {type: 'geojson', data: data as GeoJSON.GeoJSON})
}

function ensureLayer(map: MapLibreMap, layer: Parameters<MapLibreMap['addLayer']>[0]): void {
  if (!map.style || !styleIsReady(map)) return
  if (map.getLayer(layer.id)) map.removeLayer(layer.id)
  map.addLayer(layer)
}

/**
 * `map.style` exists as soon as the Map does, but `addSource` throws until the
 * style has actually loaded. `isStyleLoaded()` also flips false again while a
 * new style is diffing, and `styledata`/`load` re-run this path, so the guard
 * only ever defers work to the next event.
 */
export function styleIsReady(map: MapLibreMap): boolean {
  // The typing admits `void` because MapLibre returns nothing in a couple of
  // odd paths (`isStyleLoaded` delegates to the style object when there is one).
  return map.isStyleLoaded() === true
}
