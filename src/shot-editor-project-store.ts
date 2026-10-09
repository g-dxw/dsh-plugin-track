import {existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {readTrack, trackDir} from './artifacts.ts'
import {resolveOpenMontageShotDirectory, runOpenMontageCommandSync} from './openmontage-store.ts'
import type {ShotProjectScope} from './track/shot-project-scope.ts'
import {parseShotEditorPlan} from './track/shot-editor.ts'
import {SHOT_EDITOR_PROJECT_MAX_BYTES, SHOT_EDITOR_PROJECT_SCHEMA, type ShotEditorAppearance, type ShotEditorProjectEnvelope, type ShotEditorProjectInput} from './track/shot-editor-project-types.ts'

export class ShotEditorProjectError extends Error {
  constructor(message: string, readonly status = 400) {super(message)}
}
export class ShotEditorProjectConflictError extends ShotEditorProjectError {
  constructor() {super('三维镜头工程已被其他操作更新，请重新读取后重试', 409)}
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ShotEditorProjectError('三维镜头工程格式无效')
  const names = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !descriptors[key] || !('value' in descriptors[key]) || !descriptors[key].enumerable)) {
    throw new ShotEditorProjectError('三维镜头工程字段无效')
  }
  return value as Record<string, unknown>
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !!value.trim()
}
/** Reject getters and values that JSON would silently discard before serialization. */
function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 100) throw new ShotEditorProjectError('三维镜头工程层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new ShotEditorProjectError('三维镜头工程包含不可保存的数据')
  }
  if (ancestors.has(value)) throw new ShotEditorProjectError('三维镜头工程包含循环引用')
  const names = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value) && (Object.getPrototypeOf(value) !== Array.prototype || names.length !== value.length + 1)) throw new ShotEditorProjectError('三维镜头工程数组无效')
  ancestors.add(value)
  for (const key of names) {
    if (Array.isArray(value) && key === 'length') continue
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ShotEditorProjectError('三维镜头工程字段不可保存')
    jsonValue(descriptor.value, depth + 1, ancestors)
  }
  ancestors.delete(value)
}
function bounded(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ShotEditorProjectError('三维镜头光影参数无效')
  return value
}
function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) throw new ShotEditorProjectError('三维镜头颜色无效')
  return value
}
function appearance(value: unknown): ShotEditorAppearance {
  const raw = object(value, ['lighting', 'sandboxColors', 'sandboxBackground'])
  const light = object(raw.lighting, ['azimuth', 'elevation', 'intensity', 'ambient', 'shadows'])
  const colors = object(raw.sandboxColors, ['sides', 'background'])
  if (typeof light.shadows !== 'boolean' || !['solid', 'environment'].includes(raw.sandboxBackground as string)) throw new ShotEditorProjectError('三维镜头外观设置无效')
  return {lighting: {azimuth: bounded(light.azimuth, 0, 360), elevation: bounded(light.elevation, 5, 85),
    intensity: bounded(light.intensity, 0, 5), ambient: bounded(light.ambient, 0, 2), shadows: light.shadows},
    sandboxColors: {sides: color(colors.sides), background: color(colors.background)}, sandboxBackground: raw.sandboxBackground as ShotEditorAppearance['sandboxBackground']}
}
function validateInput(id: string, value: unknown): ShotEditorProjectInput {
  jsonValue(value)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > SHOT_EDITOR_PROJECT_MAX_BYTES) throw new ShotEditorProjectError('三维镜头工程最多 2 MB', 413)
  const raw = object(value, ['schema', 'plan', 'appearance'])
  const plan = raw.plan && typeof raw.plan === 'object' && !Array.isArray(raw.plan) ? parseShotEditorPlan(raw.plan, id) : null
  if (raw.schema !== SHOT_EDITOR_PROJECT_SCHEMA || !plan) throw new ShotEditorProjectError('三维镜头工程版本、轨迹编号或镜头数据无效')
  return {schema: SHOT_EDITOR_PROJECT_SCHEMA, plan, appearance: appearance(raw.appearance)}
}
function requiredTrack(id: string, env: NodeJS.ProcessEnv): void {
  if (!readTrack(id, env)) throw new ShotEditorProjectError('轨迹不存在', 404)
}
function projectDirectory(id: string, env: NodeJS.ProcessEnv, scope?: ShotProjectScope): string {
  return scope ? resolveOpenMontageShotDirectory(id, scope, env) : trackDir(id, env)
}
function readEnvelope(id: string, env: NodeJS.ProcessEnv, scope?: ShotProjectScope): ShotEditorProjectEnvelope | null {
  const file = join(projectDirectory(id, env, scope), 'shot-editor-project.json')
  if (!existsSync(file)) return null
  if (statSync(file).size > SHOT_EDITOR_PROJECT_MAX_BYTES + 4096) throw new ShotEditorProjectError('已保存的三维镜头工程过大', 413)
  let value: unknown
  try {value = JSON.parse(readFileSync(file, 'utf8'))} catch {throw new ShotEditorProjectError('已保存的三维镜头工程损坏，请先恢复备份')}
  const raw = object(value, ['schema', 'plan', 'appearance', 'revision', 'updatedAt'])
  if (!revision(raw.revision) || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) throw new ShotEditorProjectError('已保存的三维镜头工程修订号或时间无效')
  return {...validateInput(id, {schema: raw.schema, plan: raw.plan, appearance: raw.appearance}), revision: raw.revision, updatedAt: raw.updatedAt}
}
/** An independent sidecar never changes the route, placemarks, SVG or browser cache. */
export function readShotEditorProject(id: string, env: NodeJS.ProcessEnv = process.env, scope?: ShotProjectScope): ShotEditorProjectEnvelope | null {
  requiredTrack(id, env)
  return readEnvelope(id, env, scope)
}
/** Compare and replace atomically, retaining the last complete save after any failure. */
export function writeShotEditorProject(id: string, value: unknown, expectedRevision: unknown, env: NodeJS.ProcessEnv = process.env, scope?: ShotProjectScope): ShotEditorProjectEnvelope {
  requiredTrack(id, env)
  const previous = readEnvelope(id, env, scope), directory = projectDirectory(id, env, scope)
  if (previous && expectedRevision === undefined) throw new ShotEditorProjectConflictError()
  if (!(expectedRevision === null || revision(expectedRevision))) throw new ShotEditorProjectError('缺少有效的三维镜头工程修订号')
  if (expectedRevision !== (previous?.revision ?? null)) throw new ShotEditorProjectConflictError()
  const saved: ShotEditorProjectEnvelope = {...validateInput(id, value), revision: randomUUID(), updatedAt: new Date().toISOString()}
  if (scope) return runOpenMontageCommandSync<ShotEditorProjectEnvelope>('engine-write', {trackId: id, ...scope, editor: 'sandbox', project: saved, expectedRevision}, env)
  const temporary = join(directory, `.shot-editor-project-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(saved), {encoding: 'utf8', flag: 'wx'})
    renameSync(temporary, join(directory, 'shot-editor-project.json'))
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
      try {unlinkSync(temporary)} catch { /* Never remove a temporary file owned by another writer. */ }
    }
    throw error
  }
  return saved
}
