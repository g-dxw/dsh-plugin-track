/**
 * Turning a stored track back into GeoJSON.
 *
 * Same shape the map layer and the elevation profile already consume, so the
 * exported file and what the panel draws cannot disagree. Times ride along in
 * `coordinateProperties.times` (the @tmcw/togeojson convention) with
 * `elevations` beside them, and the path is followed by a start and an end
 * point so a viewer that ignores line styling still shows where the walk began.
 */
import type { TrackPoint } from '../protocol.ts'

export interface ExportOptions {
  /** Name written into every feature's properties. */
  name: string
  /** Include the two markers; on by default. */
  includeEndpoints?: boolean
}

export function trackFeatureCollection(
  points: readonly TrackPoint[],
  {name, includeEndpoints = true}: ExportOptions,
): GeoJSON.FeatureCollection {
  const coordinates: number[][] = []
  const times: (string | null)[] = []
  const elevations: (number | null)[] = []

  for (const [lon, lat, elevation, time] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    coordinates.push(elevation === null ? [lon, lat] : [lon, lat, elevation])
    elevations.push(elevation)
    times.push(time === null ? null : new Date(time).toISOString())
  }

  const features: GeoJSON.Feature[] = [{
    type: 'Feature',
    geometry: {type: 'LineString', coordinates},
    properties: {name, coordinateProperties: {times, elevations}},
  }]

  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  if (includeEndpoints && first && last) {
    features.push({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: first},
      properties: {name, role: 'start'},
    })
    features.push({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: last},
      properties: {name, role: 'end'},
    })
  }

  return {type: 'FeatureCollection', features}
}

/** The GeoJSON text the export button hands to the browser. */
export function toGeoJSONText(points: readonly TrackPoint[], options: ExportOptions): string {
  return JSON.stringify(trackFeatureCollection(points, options), null, 2)
}
