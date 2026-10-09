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

/** Default track colour; also used by the elevation chart. */
export const TRACK_COLOR = '#1bb1a7'

export interface TrackGeoJSON {
  line: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>
  ends: GeoJSON.FeatureCollection<GeoJSON.Point>
}

/**
 * `[lon, lat, ele, time][]` (the storage form) → GeoJSON.
 *
 * The elevation is carried on the position, which is what the elevation
 * profile reads back out; the timestamp rides along in `coordinateProperties`
 * the same way wanderer's `TrackSegment.toGeoJSON` puts it.
 */
export function toGeoJSON(points: readonly TrackPoint[], segmentStarts?: readonly number[]): TrackGeoJSON {
  const coordinates: number[][] = []
  const times: (string | null)[] = []
  const parts: number[][][] = [], partTimes: (string | null)[][] = []
  const starts = new Set(segmentStarts)
  let newRun = true
  for (let index = 0; index < points.length; index++) {
    const [lon, lat, ele, time] = points[index]
    if (starts.has(index)) newRun = true
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)
      || (segmentStarts && (Math.abs(lon) > 180 || Math.abs(lat) > 90))) {newRun = true; continue}
    coordinates.push(Number.isFinite(ele) ? [lon, lat, ele as number] : [lon, lat])
    const timestamp = segmentStarts ? (typeof time === 'number' && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString() : null)
      : time ? new Date(time).toISOString() : null
    times.push(timestamp)
    if (newRun) {parts.push([]); partTimes.push([]); newRun = false}
    parts[parts.length - 1].push(coordinates[coordinates.length - 1])
    partTimes[partTimes.length - 1].push(timestamp)
  }

  const split = !!segmentStarts && parts.length > 1
  const line: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString> = {
    type: 'Feature',
    geometry: split ? {type: 'MultiLineString', coordinates: parts} : {type: 'LineString', coordinates},
    properties: {coordinateProperties: {times: split ? partTimes : times}},
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
 * safe to call twice — existing sources are refreshed and layers are retained.
 */
export function addTrack(map: MapLibreMap, data: TrackGeoJSON, color: string = TRACK_COLOR): void {
  if (!styleIsReady(map)) return
  setData(map, TRACK_SOURCE, data.line)
  setData(map, TRACK_ENDS_SOURCE, data.ends)
  ensureLayer(map, {
    id: TRACK_CASING,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#00000066', 'line-width': 8 },
  })
  if (map.getLayer(TRACK_LINE)) updateTrackColor(map, color)
  else ensureLayer(map, {
    id: TRACK_LINE,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': 4 },
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

/** A live color edit touches only the stroke paint; geometry and endpoint markers stay intact. */
export function updateTrackColor(map: MapLibreMap, color: string): void {
  if (map.getLayer(TRACK_LINE)) map.setPaintProperty(TRACK_LINE, 'line-color', color)
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
  map.addSource(id, {type: 'geojson', data: data as GeoJSON.GeoJSON})
}

function ensureLayer(map: MapLibreMap, layer: Parameters<MapLibreMap['addLayer']>[0]): void {
  if (map.getLayer(layer.id)) return
  map.addLayer(layer)
}

/**
 * `getStyle()` returns nothing until the style is initialized, which is the
 * prerequisite for adding sources and layers. `isStyleLoaded()` also waits for
 * source data and tiles: adding our first GeoJSON source makes it false, even
 * though the style can already accept the remaining source and all four layers.
 */
export function styleIsReady(map: MapLibreMap): boolean {
  return Boolean(map.getStyle())
}
