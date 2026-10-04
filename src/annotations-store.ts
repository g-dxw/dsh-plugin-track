import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import { validateAnnotations, validateArtLayout, validateArtRouteTransform, type ArtLayout, type ArtRouteTransform, type TrackAnnotation } from './track/annotations.ts'

/** Sidecar annotations never rewrite a track's GPX or stored coordinates. */
export function annotationsSaved(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  return existsSync(join(trackDir(id, env), 'annotations.json'))
}

export function readAnnotations(id: string, env: NodeJS.ProcessEnv = process.env): TrackAnnotation[] {
  const track = readTrack(id, env)
  if (!track) throw new Error('轨迹不存在')
  const path = join(trackDir(id, env), 'annotations.json')
  if (!existsSync(path)) return []
  const document = JSON.parse(readFileSync(path, 'utf8')) as {annotations?: unknown}
  return validateAnnotations(document.annotations, track.coordinates.length)
}
export function readArtLayout(id: string, env: NodeJS.ProcessEnv = process.env): ArtLayout {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  const path = join(trackDir(id, env), 'annotations.json')
  if (!existsSync(path)) return {}
  const document = JSON.parse(readFileSync(path, 'utf8')) as {layout?: unknown}
  return validateArtLayout(document.layout)
}
export function readArtRouteTransform(id: string, env: NodeJS.ProcessEnv = process.env): ArtRouteTransform {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  const path = join(trackDir(id, env), 'annotations.json')
  if (!existsSync(path)) return validateArtRouteTransform(undefined)
  const document = JSON.parse(readFileSync(path, 'utf8')) as {route?: unknown}
  return validateArtRouteTransform(document.route)
}
export function writeAnnotations(id: string, value: unknown, env: NodeJS.ProcessEnv = process.env, layout?: unknown, route?: unknown): TrackAnnotation[] {
  const track = readTrack(id, env)
  if (!track) throw new Error('轨迹不存在')
  const annotations = validateAnnotations(value, track.coordinates.length)
  const positions = layout===undefined ? readArtLayout(id, env) : validateArtLayout(layout)
  const transform = route===undefined ? readArtRouteTransform(id, env) : validateArtRouteTransform(route)
  const directory = trackDir(id, env)
  const temporary = join(directory, `.annotations-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify({version: 1, annotations, ...(Object.keys(positions).length ? {layout: positions} : {}), ...(transform.x!==0 || transform.y!==0 || transform.scale!==1 ? {route: transform} : {})}), 'utf8')
    renameSync(temporary, join(directory, 'annotations.json'))
  } catch (error) {
    try {unlinkSync(temporary)} catch { /* only an owned temporary sidecar */ }
    throw error
  }
  return annotations
}
