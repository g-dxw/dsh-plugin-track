import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import { GEOMOTION_PROJECT_MAX_BYTES, GEOMOTION_PROJECT_SCHEMA, type GeoMotionProjectEnvelope, type GeoMotionProjectInput } from './track/geomotion-project-types.ts'

export class GeoMotionProjectError extends Error {
  constructor(message: string, readonly status = 400) {super(message)}
}
export class GeoMotionProjectConflictError extends GeoMotionProjectError {
  constructor() {super('镜头工程已被其他操作更新，请重新读取后重试', 409)}
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function bounded(value: unknown, min: number, max: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
}
function text(value: unknown, max: number, nonempty = false): value is string {
  return typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim())
}

/** Reject values that would silently change on JSON round-trip, and excessive nesting. */
function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 100) throw new GeoMotionProjectError('镜头工程层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!Array.isArray(value) && !record(value)) throw new GeoMotionProjectError('镜头工程包含不可保存的数据')
  if (ancestors.has(value)) throw new GeoMotionProjectError('镜头工程包含循环引用')
  ancestors.add(value)
  for (const item of Object.values(value)) jsonValue(item, depth + 1, ancestors)
  ancestors.delete(value)
}

function coordinate(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && bounded(value[0], -180, 180) && bounded(value[1], -90, 90)
}
function cameraTrack(value: unknown, check: (item: unknown) => boolean, duration: number): boolean {
  if (!record(value)) return false
  if (value.kind === 'static') return check(value.value)
  if (value.kind === 'keyframed') return Array.isArray(value.keys) && value.keys.length <= 20_000 && value.keys.every(key => record(key) && text(key.id, 256, true) && bounded(key.t, 0, duration) && check(key.value) && text(key.easing, 64, true))
  if (value.kind === 'bound') return text(value.ref, 1024, true) && text(value.path, 1024, true)
  if (value.kind === 'expr') return text(value.source, 16_384)
  return false
}

/** Storage validates the current envelope and basic format-7 graph without importing UI code. */
function validateDocument(value: unknown): Record<string, unknown> {
  if (!record(value) || value.format !== 7 || !text(value.name, 10_000) || !bounded(value.duration, .01, 3600) || !bounded(value.fps, 1, 120, true) || !bounded(value.width, 64, 4096, true) || !bounded(value.height, 64, 4096, true) || !record(value.nodes) || !Array.isArray(value.contexts) || value.contexts.length > 1000 || !Array.isArray(value.story) || value.story.length > 10_000) {
    throw new GeoMotionProjectError('镜头工程格式、时长、帧率或画面尺寸无效')
  }
  const nodes = Object.entries(value.nodes)
  if (!nodes.length || nodes.length > 20_000) throw new GeoMotionProjectError('镜头工程节点数量无效')
  const types = new Set(['camera', 'group', 'route', 'marker', 'text', 'shape', 'regions', 'clouds', 'image'])
  for (const [id, node] of nodes) {
    if (!text(id, 256, true) || !record(node) || node.id !== id || !(typeof node.type === 'string' && types.has(node.type)) || !text(node.name, 10_000) || !text(node.order, 256, true) || !(node.parentId === null || text(node.parentId, 256, true))) throw new GeoMotionProjectError('镜头工程节点结构无效')
    if (node.type === 'camera') {
      if (!record(node.tracks) || !cameraTrack(node.tracks.center, coordinate, value.duration) || !cameraTrack(node.tracks.zoom, item => bounded(item, -5, 30), value.duration) || !cameraTrack(node.tracks.bearing, item => bounded(item, -100_000, 100_000), value.duration) || !cameraTrack(node.tracks.pitch, item => bounded(item, 0, 85), value.duration)) throw new GeoMotionProjectError('镜头工程相机轨道无效')
    } else {
      if (typeof node.visible !== 'boolean') throw new GeoMotionProjectError('镜头工程节点显示设置无效')
      if (node.type !== 'group' && (!bounded(node.in, 0, 3600) || !bounded(node.out, node.in, 3600) || !bounded(node.fade, 0, 3600))) throw new GeoMotionProjectError('镜头工程图层时间无效')
      if (node.type === 'route' && (!Array.isArray(node.coords) || node.coords.length > 500_000 || !node.coords.every(coordinate))) throw new GeoMotionProjectError('镜头工程路线坐标无效')
      if (node.type === 'marker' && !coordinate(node.coord)) throw new GeoMotionProjectError('镜头工程地名坐标无效')
    }
  }
  const resolved = new Set<string>()
  for (const [id, node] of nodes) {
    const parent = (node as Record<string, unknown>).parentId
    if (parent !== null && (!Object.hasOwn(value.nodes, parent as string) || parent === id || (value.nodes[parent as string] as Record<string, unknown>).type !== 'group')) throw new GeoMotionProjectError('镜头工程节点父级无效')
  }
  for (const [id] of nodes) {
    const seen = new Set<string>()
    let current: string | null = id
    while (current !== null && !resolved.has(current)) {
      if (seen.has(current)) throw new GeoMotionProjectError('镜头工程节点父级形成循环')
      seen.add(current)
      current = (value.nodes[current] as Record<string, unknown>).parentId as string | null
    }
    for (const visited of seen) resolved.add(visited)
  }
  jsonValue(value)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > GEOMOTION_PROJECT_MAX_BYTES) throw new GeoMotionProjectError('镜头工程最多 16 MiB', 413)
  return JSON.parse(serialized) as Record<string, unknown>
}

function validateInput(id: string, value: unknown): GeoMotionProjectInput {
  if (!record(value) || value.trackId !== id || !text(value.sourceFingerprint, 512, true) || ('schema' in value && value.schema !== GEOMOTION_PROJECT_SCHEMA)) throw new GeoMotionProjectError('镜头工程轨迹编号或来源标识无效')
  return {trackId: id, sourceFingerprint: value.sourceFingerprint, document: validateDocument(value.document)}
}
function requiredTrack(id: string, env: NodeJS.ProcessEnv): void {
  if (!readTrack(id, env)) throw new GeoMotionProjectError('轨迹不存在', 404)
}
function readEnvelope(id: string, env: NodeJS.ProcessEnv): GeoMotionProjectEnvelope | null {
  const path = join(trackDir(id, env), 'geomotion-project.json')
  if (!existsSync(path)) return null
  if (statSync(path).size > GEOMOTION_PROJECT_MAX_BYTES + 4096) throw new GeoMotionProjectError('已保存的镜头工程过大', 413)
  let value: unknown
  try {value = JSON.parse(readFileSync(path, 'utf8'))} catch {throw new GeoMotionProjectError('已保存的镜头工程损坏，请先恢复备份')}
  if (!record(value) || value.schema !== GEOMOTION_PROJECT_SCHEMA || !text(value.revision, 256, true) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new GeoMotionProjectError('已保存的镜头工程版本或修订号无效')
  return {...validateInput(id, value), schema: GEOMOTION_PROJECT_SCHEMA, revision: value.revision, updatedAt: value.updatedAt}
}

export function readGeoMotionProject(id: string, env: NodeJS.ProcessEnv = process.env): GeoMotionProjectEnvelope | null {
  requiredTrack(id, env)
  return readEnvelope(id, env)
}

/** Synchronous compare-and-replace prevents stale editors from silently losing authored work. */
export function writeGeoMotionProject(id: string, value: unknown, expectedRevision: unknown, env: NodeJS.ProcessEnv = process.env): GeoMotionProjectEnvelope {
  requiredTrack(id, env)
  const previous = readEnvelope(id, env)
  if (previous && expectedRevision === undefined) throw new GeoMotionProjectConflictError()
  if (!(expectedRevision === null || text(expectedRevision, 256, true))) throw new GeoMotionProjectError('缺少有效的镜头工程修订号')
  if (expectedRevision !== (previous?.revision ?? null)) throw new GeoMotionProjectConflictError()
  const project: GeoMotionProjectEnvelope = {...validateInput(id, value), schema: GEOMOTION_PROJECT_SCHEMA, revision: randomUUID(), updatedAt: new Date().toISOString()}
  const temporary = join(trackDir(id, env), `.geomotion-project-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(project), {encoding: 'utf8', flag: 'wx'})
    renameSync(temporary, join(trackDir(id, env), 'geomotion-project.json'))
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
      try {unlinkSync(temporary)} catch { /* A name collision never grants ownership of another temporary file. */ }
    }
    throw error
  }
  return project
}
