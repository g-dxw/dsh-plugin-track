import type {RoutePosition, TrackPlacemark, TrackPoint} from '../protocol.ts'
import {haversineDistance} from './model/utils.ts'

export interface ProfilePlacemarkProjection {
  id: string
  number: number
  startIndex: number
  endIndex: number
  fraction: number
}

type Segment = {
  startIndex: number
  endIndex: number
  x0: number
  y0: number
  x1: number
  y1: number
  partIndex: number
  distanceStart: number
  length: number
}
type Node = {
  west: number
  east: number
  south: number
  north: number
  firstIndex: number
  start: number
  end: number
  left?: Node
  right?: Node
}
type Match = {segment: Segment; fraction: number; distance: number}
const LEAF_SIZE = 12
// Degree-space roundoff should not choose a different lap at coincident locations.
const TIE_EPSILON = 1e-14
const METERS_PER_DEGREE = 111195.0802335329
type SpatialIndex = {segments: Segment[]; tree: Node; before: Map<number, Map<number, Segment>>; after: Map<number, Map<number, Segment>>}
type CachedIndices = {defaultIndex?: SpatialIndex | null; byStarts: WeakMap<readonly number[], SpatialIndex | null>}
const indices = new WeakMap<readonly TrackPoint[], CachedIndices>()

function spatialIndex(points: readonly TrackPoint[], segmentStarts?: readonly number[]): SpatialIndex | null {
  let cached = indices.get(points)
  if (!cached) {cached = {byStarts: new WeakMap()}; indices.set(points, cached)}
  if (segmentStarts ? cached.byStarts.has(segmentStarts) : cached.defaultIndex !== undefined) {
    return segmentStarts ? cached.byStarts.get(segmentStarts)! : cached.defaultIndex!
  }
  const segments = segmentsOf(points, segmentStarts)
  let index: SpatialIndex | null = null
  if (segments.length) {
    const before = new Map<number, Map<number, Segment>>(), after = new Map<number, Map<number, Segment>>()
    for (const segment of segments) {
      if (segment.length > 0) {
        let incoming = before.get(segment.partIndex), outgoing = after.get(segment.partIndex)
        if (!incoming) {incoming = new Map(); before.set(segment.partIndex, incoming)}
        if (!outgoing) {outgoing = new Map(); after.set(segment.partIndex, outgoing)}
        incoming.set(segment.distanceStart + segment.length, segment)
        outgoing.set(segment.distanceStart, segment)
      }
    }
    index = {segments, tree: buildTree(segments, 0, segments.length), before, after}
  }
  // Both track and segment arrays are immutable; identity avoids rejoining every break per reference.
  if (segmentStarts) cached.byStarts.set(segmentStarts, index)
  else cached.defaultIndex = index
  return index
}

function validAnchor(points: readonly TrackPoint[], starts: ReadonlySet<number>, value?: RoutePosition): value is RoutePosition {
  if (!value || !Number.isInteger(value.startIndex) || !Number.isInteger(value.endIndex)
    || value.startIndex < 0 || value.endIndex >= points.length
    || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1
    || (value.endIndex !== value.startIndex && value.endIndex !== value.startIndex + 1)
    || (value.endIndex === value.startIndex && value.fraction !== 0)) return false
  const a = points[value.startIndex], b = points[value.endIndex]
  return !!a && !!b && validPosition(a[0], a[1]) && validPosition(b[0], b[1])
    && (value.endIndex === value.startIndex || !starts.has(value.endIndex))
}

export interface RouteProjectionCandidate extends RoutePosition {offset: number}

/** Nearby local minima describe separate passages, including adjacent out-and-back edges. */
export function routeProjectionCandidates(points: readonly TrackPoint[], coordinates: readonly number[], segmentStarts?: readonly number[]): RouteProjectionCandidate[] {
  const [lon, lat] = coordinates
  if (!validPosition(lon, lat)) return []
  const index = spatialIndex(points, segmentStarts)
  if (!index) return []
  const scale = Math.cos(lat * Math.PI / 180)
  const nearest = nearestSegment(index.tree, index.segments, lon, lat)
  const radius = Math.sqrt(nearest.distance) + 5 / METERS_PER_DEGREE
  const pending: Node[] = [index.tree]
  const matches: {match: Match; offset: number; distance: number; partIndex: number}[] = []
  while (pending.length) {
    const node = pending.pop()!
    if (boxDistance(node, lon, lat, scale) > radius * radius + TIE_EPSILON) continue
    if (node.left && node.right) {pending.push(node.left, node.right); continue}
    for (let i = node.start; i < node.end; i += 1) {
      const match = projectionOnSegment(index.segments[i], lon, lat, scale)
      if (match.distance > radius * radius + TIE_EPSILON) continue
      const {segment, fraction} = match
      const incoming = index.before.get(segment.partIndex)?.get(segment.distanceStart)
      const outgoing = index.after.get(segment.partIndex)?.get(segment.distanceStart + segment.length)
      const neighbours = segment.length === 0 ? [incoming, outgoing]
        : fraction === 0 ? [incoming] : fraction === 1 ? [outgoing] : []
      if (neighbours.some(neighbour => neighbour && neighbour.partIndex === segment.partIndex
        && projectionOnSegment(neighbour, lon, lat, scale).distance < match.distance - TIE_EPSILON)) continue
      const x = segment.x0 + (segment.x1 - segment.x0) * fraction
      const projectedLon = ((x + 180) % 360 + 360) % 360 - 180
      const projectedLat = segment.y0 + (segment.y1 - segment.y0) * fraction
      matches.push({match, offset: haversineDistance(lat, lon, projectedLat, projectedLon),
        distance: segment.distanceStart + segment.length * fraction, partIndex: segment.partIndex})
    }
  }
  const minimum = matches.reduce((minimum, match) => Math.min(minimum, match.offset), Infinity)
  matches.sort((a, b) => a.partIndex - b.partIndex || a.distance - b.distance || a.match.segment.startIndex - b.match.segment.startIndex)
  const result: RouteProjectionCandidate[] = []
  let previous: typeof matches[number] | undefined
  for (const item of matches) {
    if (item.offset > minimum + 5 + .001) continue
    // Merge the shared endpoint and stationary fixes at the same measured position only.
    if (previous && previous.partIndex === item.partIndex && Math.abs(previous.distance - item.distance) < .001) continue
    previous = item
    const {segment, fraction} = item.match
    const vertex = fraction === 0 ? segment.startIndex : fraction === 1 ? segment.endIndex : null
    result.push(vertex === null
      ? {startIndex: segment.startIndex, endIndex: segment.endIndex, fraction, offset: item.offset}
      : {startIndex: vertex, endIndex: vertex, fraction: 0, offset: item.offset})
  }
  return result
}

/** Locate source KML points on the measured path without inventing elevation or time. */
export function projectProfilePlacemarks(points: readonly TrackPoint[], placemarks: readonly TrackPlacemark[], segmentStarts?: readonly number[]): ProfilePlacemarkProjection[] {
  if (!points.length || !placemarks.length) return []
  const indexData = spatialIndex(points, segmentStarts)
  if (!indexData) return []
  const {segments, tree} = indexData
  const starts = new Set(segmentStarts)
  const projected: ProfilePlacemarkProjection[] = []
  for (let index = 0; index < placemarks.length; index += 1) {
    const point = placemarks[index]
    const [lon, lat] = point?.coordinates || []
    if (!validPosition(lon, lat)) continue
    if (validAnchor(points, starts, point.routePosition)) {
      const {startIndex, endIndex, fraction} = point.routePosition
      projected.push({id: point.id, number: index + 1, startIndex, endIndex, fraction})
      continue
    }
    const match = nearestSegment(tree, segments, lon, lat)
    projected.push({id: point.id, number: index + 1, startIndex: match.segment.startIndex, endIndex: match.segment.endIndex, fraction: match.fraction})
  }
  return projected
}

function validPosition(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
}

/** Invalid fixes break paths. A valid isolated fix remains a zero-length segment. */
function segmentsOf(points: readonly TrackPoint[], segmentStarts?: readonly number[]): Segment[] {
  const segments: Segment[] = []
  const starts = new Set(segmentStarts)
  let partIndex = -1, distance = 0
  let previousIndex: number | null = null
  let runStart: number | null = null
  let previousX = 0, previousY = 0, worldReference: number | null = null
  const finishRun = () => {
    if (previousIndex !== null && previousIndex === runStart) {
      segments.push({startIndex: previousIndex, endIndex: previousIndex, x0: previousX, y0: previousY, x1: previousX, y1: previousY, partIndex, distanceStart: distance, length: 0})
    }
    previousIndex = null
    runStart = null
  }
  for (let index = 0; index < points.length; index += 1) {
    if (starts.has(index)) finishRun()
    const [lon, lat] = points[index] || []
    if (!validPosition(lon, lat)) {finishRun(); continue}
    let x = lon
    if (worldReference !== null) {
      if (x - worldReference > 180) x -= 360 * Math.ceil((x - worldReference - 180) / 360)
      else if (x - worldReference < -180) x += 360 * Math.ceil((worldReference - x - 180) / 360)
    }
    if (previousIndex === null) {runStart = index; partIndex += 1}
    else {
      const length = previousX === x && previousY === lat ? 0 : haversineDistance(previousY, previousX, lat, lon)
      const last = segments[segments.length - 1]
      // A stationary platform has one geometric minimum; its first source edge stays stable.
      if (length > 0 || !last || last.partIndex !== partIndex || last.length > 0) {
        segments.push({startIndex: previousIndex, endIndex: index, x0: previousX, y0: previousY, x1: x, y1: lat, partIndex, distanceStart: distance, length})
      }
      distance += length
    }
    previousIndex = index
    previousX = x
    previousY = lat
    worldReference = x
  }
  finishRun()
  return segments
}

/** Balanced segment-box hierarchy; quickselect avoids sorting every subtree. */
function buildTree(segments: Segment[], start: number, end: number): Node {
  const node: Node = {west: Infinity, east: -Infinity, south: Infinity, north: -Infinity, firstIndex: Infinity, start, end}
  for (let index = start; index < end; index += 1) {
    const segment = segments[index]
    node.west = Math.min(node.west, segment.x0, segment.x1)
    node.east = Math.max(node.east, segment.x0, segment.x1)
    node.south = Math.min(node.south, segment.y0, segment.y1)
    node.north = Math.max(node.north, segment.y0, segment.y1)
    node.firstIndex = Math.min(node.firstIndex, segment.startIndex)
  }
  if (end - start <= LEAF_SIZE) return node
  const middle = Math.floor((start + end) / 2)
  const longitudeScale = Math.cos((node.south + node.north) / 2 * Math.PI / 180)
  const axis = (node.east - node.west) * longitudeScale > node.north - node.south ? 'x' : 'y'
  selectMiddle(segments, start, end - 1, middle, axis)
  node.left = buildTree(segments, start, middle)
  node.right = buildTree(segments, middle, end)
  return node
}

function selectMiddle(segments: Segment[], start: number, end: number, middle: number, axis: 'x' | 'y'): void {
  const compare = (a: Segment, b: Segment) => {
    const centerA = axis === 'x' ? a.x0 + a.x1 : a.y0 + a.y1
    const centerB = axis === 'x' ? b.x0 + b.x1 : b.y0 + b.y1
    return centerA - centerB || a.startIndex - b.startIndex
  }
  let left = start, right = end
  while (left < right) {
    const pivot = segments[Math.floor((left + right) / 2)]
    let low = left, high = right
    while (low <= high) {
      while (compare(segments[low], pivot) < 0) low += 1
      while (compare(segments[high], pivot) > 0) high -= 1
      if (low <= high) {
        const temporary = segments[low]
        segments[low] = segments[high]
        segments[high] = temporary
        low += 1
        high -= 1
      }
    }
    if (middle <= high) right = high
    else if (middle >= low) left = low
    else return
  }
}

/** Distance to the closest periodic copy of a longitude interval. */
function longitudeGap(lon: number, west: number, east: number): number {
  if (east - west >= 360) return 0
  const x = lon + 360 * Math.round(((west + east) / 2 - lon) / 360)
  return Math.max(west - x, x - east, 0)
}

function boxDistance(node: Node, lon: number, lat: number, scale: number): number {
  const dx = longitudeGap(lon, node.west, node.east) * scale
  const dy = Math.max(node.south - lat, lat - node.north, 0)
  return dx * dx + dy * dy
}

function nearestSegment(tree: Node, segments: readonly Segment[], lon: number, lat: number): Match {
  const scale = Math.cos(lat * Math.PI / 180)
  let best: Match | null = null
  const pending: {node: Node; distance: number}[] = [{node: tree, distance: boxDistance(tree, lon, lat, scale)}]
  while (pending.length) {
    const {node, distance} = pending.pop()!
    if (best && (distance > best.distance + TIE_EPSILON
      || (Math.abs(distance - best.distance) <= TIE_EPSILON && node.firstIndex >= best.segment.startIndex))) continue
    if (node.left && node.right) {
      const left = {node: node.left, distance: boxDistance(node.left, lon, lat, scale)}
      const right = {node: node.right, distance: boxDistance(node.right, lon, lat, scale)}
      const leftFirst = left.distance < right.distance || (left.distance === right.distance && left.node.firstIndex < right.node.firstIndex)
      pending.push(leftFirst ? right : left, leftFirst ? left : right)
      continue
    }
    for (let index = node.start; index < node.end; index += 1) {
      const next = projectionOnSegment(segments[index], lon, lat, scale)
      if (!best || next.distance < best.distance - TIE_EPSILON
        || (Math.abs(next.distance - best.distance) <= TIE_EPSILON && next.segment.startIndex < best.segment.startIndex)) best = next
    }
  }
  return best!
}

function projectionOnSegment(segment: Segment, lon: number, lat: number, scale: number): Match {
  const x = lon + 360 * Math.round(((segment.x0 + segment.x1) / 2 - lon) / 360)
  const dx = (segment.x1 - segment.x0) * scale, dy = segment.y1 - segment.y0
  const lengthSquared = dx * dx + dy * dy
  let best: Match | null = null
  // Neighbouring periodic copies also handle an exactly antipodal tie consistently.
  for (const queryX of [x, x - 360, x + 360]) {
    const qx = (queryX - segment.x0) * scale, qy = lat - segment.y0
    const fraction = lengthSquared ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / lengthSquared)) : 0
    const offsetX = qx - fraction * dx, offsetY = qy - fraction * dy
    const next = {segment, fraction, distance: offsetX * offsetX + offsetY * offsetY}
    if (!best || next.distance < best.distance - TIE_EPSILON
      || (Math.abs(next.distance - best.distance) <= TIE_EPSILON && next.fraction < best.fraction)) best = next
  }
  return best!
}
