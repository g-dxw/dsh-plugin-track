import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import type { TrackRecord } from './protocol.ts'
import { validatePlacemarkEdits } from './track/placemark-edits.ts'
import { validatePlacemarkGroups } from './track/placemark-groups.ts'
import { isPlacemarkOrder } from './track/placemark-order.ts'
import { derivePlacemarkLocation } from './track/placemark-location.ts'
import { validatePlacemarkState, validatePlacemarkStateData, type PlacemarkState, type PlacemarkStateData } from './track/placemark-state.ts'

export class PlacemarkStateConflictError extends Error {
  readonly status = 409
  constructor() {super('标注状态已被其他操作更新（409），请重新读取后重试')}
}

function requiredTrack(id: string, env: NodeJS.ProcessEnv): TrackRecord {
  const track = readTrack(id, env)
  if (!track) throw new Error('轨迹不存在')
  return track
}
export function hasPlacemarkState(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  requiredTrack(id, env)
  return existsSync(join(trackDir(id, env), 'placemark-state.json'))
}

function legacyField(id: string, name: string, field: string, fallback: unknown, env: NodeJS.ProcessEnv): unknown {
  const path = join(trackDir(id, env), name)
  if (!existsSync(path)) return fallback
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || (value as {version?: unknown}).version !== 1) throw new Error('旧标注状态文件格式无效')
  return (value as Record<string, unknown>)[field]
}

/** A corrupt authoritative file must never resurrect stale legacy relationships. */
function readState(track: TrackRecord, env: NodeJS.ProcessEnv, patch: Partial<PlacemarkStateData> = {}): PlacemarkState {
  const path = join(trackDir(track.id, env), 'placemark-state.json')
  if (existsSync(path)) return validatePlacemarkState(JSON.parse(readFileSync(path, 'utf8')), track.coordinates)
  const order = 'order' in patch ? patch.order : legacyField(track.id, 'placemark-order.json', 'order', null, env)
  if (!isPlacemarkOrder(order)) throw new Error('点位排序数据无效')
  const edits = validatePlacemarkEdits('edits' in patch ? patch.edits : legacyField(track.id, 'placemark-edits.json', 'edits', [], env))
  const groups = validatePlacemarkGroups('groups' in patch ? patch.groups : legacyField(track.id, 'placemark-groups.json', 'groups', [], env))
  return {version: 1, revision: 0, ...validatePlacemarkStateData({added: [], deletedIds: [], edits, order, groups, routeContext: null}, track.coordinates)}
}

export function readPlacemarkState(id: string, env: NodeJS.ProcessEnv = process.env): PlacemarkState {
  return readState(requiredTrack(id, env), env)
}

function legacyCoordinatesAllowed(track: TrackRecord, context: PlacemarkStateData['routeContext'], id: string, coordinates: [number, number], env: NodeJS.ProcessEnv): boolean {
  const same = (value: unknown) => JSON.stringify(value) === JSON.stringify(coordinates)
  if (track.placemarks?.some(point => point.id === id && same(point.coordinates)) || context?.references.some(point => point.id === id && same(point.coordinates))) return true
  try {
    return validatePlacemarkEdits(legacyField(track.id, 'placemark-edits.json', 'edits', [], env)).some(edit => edit.id === id && !!edit.coordinates && same(edit.coordinates))
  } catch {return false}
}

function normalizeLocations(data: PlacemarkStateData, previous: PlacemarkState, track: TrackRecord, env: NodeJS.ProcessEnv, allowLegacyPositions: boolean): PlacemarkStateData {
  if (previous.routeContext && JSON.stringify(data.routeContext) !== JSON.stringify(previous.routeContext)) throw new Error('轨迹定位上下文已固定，不可修改')
  const context = data.routeContext
  if (context && track.segmentStarts && JSON.stringify(context.segmentStarts) !== JSON.stringify(track.segmentStarts)) throw new Error('轨迹定位分段与导入数据不一致')
  const originalIds = new Set(track.placemarks?.map(point => point.id))
  if (data.added.some(point => originalIds.has(point.id))) throw new Error('新增点编号与原始点重复')
  const added = data.added.map(point => {
    if (!context || !point.routePosition) throw new Error('新增标注点缺少轨迹定位上下文')
    const location = derivePlacemarkLocation(track.coordinates, context, point.routePosition)
    return {...point, coordinates: location.coordinates, elevation: location.elevation, time: location.time, timeSource: location.timeSource, routePosition: location.routePosition}
  })
  const beforeById = new Map(previous.edits.map(edit => [edit.id, edit]))
  const addedIds = new Set(added.map(point => point.id))
  const edits = data.edits.map(edit => {
    const before = beforeById.get(edit.id)
    const changed = JSON.stringify(edit.coordinates) !== JSON.stringify(before?.coordinates)
    if (!edit.routePosition) {
      if (edit.coordinates && (addedIds.has(edit.id) || (changed && !(allowLegacyPositions && !context) && !legacyCoordinatesAllowed(track, context, edit.id, edit.coordinates, env)))) throw new Error('移动标注点须选择有效的轨迹位置')
      return edit
    }
    if (!context) throw new Error('标注点缺少轨迹定位上下文')
    const location = derivePlacemarkLocation(track.coordinates, context, edit.routePosition)
    return {...edit, coordinates: location.coordinates, elevation: location.elevation, time: location.time, timeSource: location.timeSource, routePosition: location.routePosition}
  })
  return validatePlacemarkStateData({...data, added, edits}, track.coordinates)
}

function replaceState(track: TrackRecord, previous: PlacemarkState, data: PlacemarkStateData, env: NodeJS.ProcessEnv, allowLegacyPositions = false): PlacemarkState {
  if (previous.revision === Number.MAX_SAFE_INTEGER) throw new Error('标注状态修订号已达到上限')
  const normalized = normalizeLocations(validatePlacemarkStateData(data, track.coordinates), previous, track, env, allowLegacyPositions)
  const state: PlacemarkState = {version: 1, revision: previous.revision + 1, ...normalized}
  const directory = trackDir(track.id, env), temporary = join(directory, `.placemark-state-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(state), 'utf8')
    renameSync(temporary, join(directory, 'placemark-state.json'))
  } catch (error) {
    try {unlinkSync(temporary)} catch { /* only this call's temporary file */ }
    throw error
  }
  return state
}

export function writePlacemarkState(id: string, revision: unknown, value: unknown, env: NodeJS.ProcessEnv = process.env): PlacemarkState {
  const track = requiredTrack(id, env)
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('缺少有效的标注状态修订号')
  const previous = readState(track, env)
  if (revision !== previous.revision) throw new PlacemarkStateConflictError()
  return replaceState(track, previous, validatePlacemarkStateData(value, track.coordinates), env)
}

/** Existing clients still write one field, but every successful write shares one canonical file. */
export function patchPlacemarkState(id: string, patch: Partial<Pick<PlacemarkStateData, 'order' | 'edits' | 'groups'>>, env: NodeJS.ProcessEnv = process.env): PlacemarkState {
  const track = requiredTrack(id, env), previous = readState(track, env, patch)
  return replaceState(track, previous, {...previous, ...patch}, env, true)
}
