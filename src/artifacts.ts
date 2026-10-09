import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  extensionOf,
  type TrackExtension, type TrackMetrics, type TrackPoint, type TrackRecord, type TrackSummary, type TrackPlacemark,
} from './protocol.ts'

/**
 * Track storage: `<DSH home>/track/<id>/`, holding
 *
 *   track.json    the parsed path plus everything the list needs
 *   source.<ext>  the file as the user picked it, kept byte for byte
 *
 * Both are written at import time. Storing the parsed path is what makes the
 * panel work offline — drawing a track needs no re-parse — and keeping the
 * original alongside is what makes "export the original file" honest rather
 * than a re-serialisation of the same data.
 *
 * Every read tolerates a half-written or hand-edited directory by skipping it,
 * the way the publisher treats its own job directories: one bad track must not
 * take down the list.
 */

/** Root of this plugin's storage. */
export function tracksRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(undefined, env), 'track')
}

/** Directory of a single track. Ids never come from a file, so no traversal is possible. */
export function trackDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(tracksRoot(env), id)
}

/**
 * Whether an id looks like one of ours.
 *
 * The ids this module mints are `2026-09-22T10-30-00-000Z` (plus a `-2`, `-3`…
 * suffix on a collision), so the bar is deliberately tight. It matters because
 * the HTTP layer takes the id straight off the query string: without this,
 * `?id=../../../../home/someone` would read a `track.json` from anywhere on the
 * disk that happened to parse. A loopback-only endpoint is still an endpoint.
 */
function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)
}

/** What `track.json` holds on disk. */
interface TrackFile extends TrackSummary {
  coordinates: TrackPoint[]
  placemarks?: TrackPlacemark[]
  segmentStarts?: number[]
}

/** One track's metadata, or `null` when the directory is not a readable track. */
function read(id: string, env: NodeJS.ProcessEnv): TrackFile | null {
  if (!validId(id)) return null
  try {
    const file = join(trackDir(id, env), 'track.json')
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrackFile>
    if (!Array.isArray(parsed.coordinates)) return null
    return {
      ...(parsed as TrackFile),
      id,
      coordinates: parsed.coordinates,
    }
  } catch {
    return null
  }
}

/** Every stored track's metadata, newest first. The point arrays are not read out. */
export function listTracks(env: NodeJS.ProcessEnv = process.env): TrackSummary[] {
  const root = tracksRoot(env)
  if (!existsSync(root)) return []
  const tracks: TrackSummary[] = []
  for (const id of readdirSync(root)) {
    const found = read(id, env)
    if (!found) continue
    const {coordinates, placemarks: _placemarks, segmentStarts: _segmentStarts, ...summary} = found
    tracks.push({...summary, points: coordinates.length})
  }
  return tracks.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/** One track including its points, or `null` when the id is unknown. */
export function readTrack(id: string, env: NodeJS.ProcessEnv = process.env): TrackRecord | null {
  const found = read(id, env)
  if (!found) return null
  return {...found, points: found.coordinates.length}
}

/** Delete a track and its source file. Returns whether anything was there. */
export function removeTrack(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!validId(id)) return false
  const dir = trackDir(id, env)
  if (!existsSync(dir)) return false
  rmSync(dir, {recursive: true, force: true})
  return true
}

/** The original file's bytes, or `null` when this track has no readable source. */
export function readSource(id: string, env: NodeJS.ProcessEnv = process.env): {body: Buffer; ext: string} | null {
  if (!validId(id)) return null
  const dir = trackDir(id, env)
  if (!existsSync(dir)) return null
  const stored = read(id, env)
  const extensions = stored?.format ? [stored.format] : ['gpx', 'kml', 'tcx']
  for (const ext of extended(extensions)) {
    const file = join(dir, `source.${ext}`)
    try {
      if (existsSync(file) && statSync(file).isFile()) return {body: readFileSync(file), ext}
    } catch { /* unreadable source just means no download */ }
  }
  return null
}

/** A stored track's own guess at extensions, widened with every one we write. */
function extended(preferred: readonly string[]): string[] {
  return [...new Set([...preferred, 'gpx', 'kml', 'tcx'])]
}

/** ISO timestamp used for ids: filesystem-safe, and sorts by import time. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, '-')
}

/**
 * Persist one imported track. The id is derived from the import time plus a
 * counter, so two files dropped in the same millisecond still get their own
 * directories.
 */
export function writeTrack(input: {
  name?: string
  filename: string
  source: string
  points: TrackPoint[]
  placemarks?: TrackPlacemark[]
  segmentStarts?: number[]
  metrics: TrackMetrics
}, env: NodeJS.ProcessEnv = process.env): TrackSummary {
  const root = tracksRoot(env)
  mkdirSync(root, {recursive: true})
  const filename = input.filename.trim()
  const createdAt = new Date().toISOString()
  const id = uniqueId(root, stamp(new Date(createdAt)))
  const format = (extensionOf(filename) || 'gpx') as TrackExtension
  const dir = join(root, id)
  mkdirSync(dir, {recursive: true})

  const summary: TrackSummary = {
    id,
    name: (input.name ?? '').trim() || filename.replace(/\.[^.]+$/u, '') || `轨迹 ${id.slice(0, 10)}`,
    filename,
    format,
    createdAt,
    bytes: Buffer.byteLength(input.source, 'utf8'),
    points: input.points.length,
    metrics: input.metrics,
  }

  try {
    writeFileSync(join(dir, 'track.json'), JSON.stringify({...summary, coordinates: input.points, ...(input.placemarks ? {placemarks: input.placemarks} : {}), ...(input.segmentStarts === undefined ? {} : {segmentStarts: [...input.segmentStarts]})}), 'utf8')
    writeFileSync(join(dir, `source.${format}`), input.source, 'utf8')
    return summary
  } catch (error) {
    // This directory was minted by this call. Never roll back an outside path.
    if (dirname(resolve(dir)) === resolve(root)) rmSync(dir, {recursive: true, force: true})
    throw error
  }
}

/** `2026-09-22T10-30-00-000Z`, then `-2`, `-3`… until the directory is free. */
function uniqueId(root: string, base: string): string {
  let id = base
  for (let suffix = 2; existsSync(join(root, id)); suffix += 1) id = `${base}-${suffix}`
  return id
}

/** Save split results together; a failed batch removes only copies created by it. */
export function writeTrackBatch(inputs: readonly Parameters<typeof writeTrack>[0][], env: NodeJS.ProcessEnv = process.env): TrackSummary[] {
  const written: TrackSummary[] = []
  try {
    for (const input of inputs) written.push(writeTrack(input, env))
    return written
  } catch (error) {
    for (const track of written) removeTrack(track.id, env)
    throw error
  }
}
