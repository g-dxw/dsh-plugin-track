/**
 * Bounding box of a GeoJSON object, in `[west, south, east, north]` order.
 *
 * Upstream imported this from `$lib/util/geojson_util`, which pulls in turf's
 * `coordEach`. Walking the coordinates directly is the whole of what this needs
 * and keeps the plugin free of a turf dependency.
 */
function eachCoord(value: unknown, visit: (coord: number[]) => void): void {
  if (!value) return
  if (Array.isArray(value)) {
    // A position is a flat array of numbers; anything else is a nested list.
    if (value.length && value.every(item => typeof item === 'number')) {
      visit(value as number[])
      return
    }
    for (const item of value) eachCoord(item, visit)
    return
  }
  if (typeof value !== 'object') return
  const node = value as {type?: string, geometry?: unknown, coordinates?: unknown, features?: unknown}
  if (node.type === 'FeatureCollection') {
    eachCoord(node.features, visit)
    return
  }
  if (node.type === 'Feature') {
    eachCoord(node.geometry, visit)
    return
  }
  eachCoord(node.coordinates, visit)
}

export function bbox(geojson: GeoJSON.GeoJsonObject): GeoJSON.BBox {
  const result: number[] = [Infinity, Infinity, -Infinity, -Infinity]
  eachCoord(geojson, coord => {
    if (typeof coord[0] !== 'number' || typeof coord[1] !== 'number') return
    if (result[0]! > coord[0]) result[0] = coord[0]
    if (result[1]! > coord[1]) result[1] = coord[1]
    if (result[2]! < coord[0]) result[2] = coord[0]
    if (result[3]! < coord[1]) result[3] = coord[1]
  })
  // An empty geometry has no box at all; upstream returns the sentinel corners
  // and so do we, rather than inventing [0, 0, 0, 0].
  return result as unknown as GeoJSON.BBox
}
