import type { PlacemarkGroup, TrackPlacemark, TrackPoint } from '../protocol.ts'
import { editedPlacemarks, validatePlacemarkEdits, type PlacemarkEdit } from './placemark-edits.ts'
import { validatePlacemarkGroups } from './placemark-groups.ts'
import { isPlacemarkOrder, orderedPlacemarks } from './placemark-order.ts'
import { imageLink, validatePlacemarks } from './placemarks.ts'
import { derivePlacemarkLocation, validateRouteContext, validateRoutePosition, type PlacemarkRouteContext } from './placemark-location.ts'

/** One transaction owns point lifetimes, their edits and their presentation relationships. */
export interface PlacemarkStateData {
  added: TrackPlacemark[]
  deletedIds: string[]
  edits: PlacemarkEdit[]
  order: string[] | null
  groups: PlacemarkGroup[]
  routeContext: PlacemarkRouteContext | null
}
export interface PlacemarkState extends PlacemarkStateData {version: 1; revision: number}
export type PlacemarkStateDocument = PlacemarkState

const POINT_ID = /^[A-Za-z0-9_-]{1,64}$/u
const LOCAL_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function validateAdded(value: unknown): TrackPlacemark[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('新增标注点最多 5000 个')
  const ids = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('新增标注点格式无效')
    const point = raw as TrackPlacemark
    if (typeof point.id !== 'string' || !LOCAL_ID.test(point.id) || ids.has(point.id)) throw new Error('新增标注点编号无效或重复')
    if (typeof point.name !== 'string' || typeof point.description !== 'string' || !Array.isArray(point.images)
      || !Array.isArray(point.coordinates)) throw new Error('新增标注点信息不完整')
    const patch = validatePlacemarkEdits([point])[0]
    if (!patch.coordinates || patch.elevation === undefined || point.time === undefined || point.timeSource === undefined) throw new Error('新增标注点须保存轨迹推导的位置、海拔与时间')
    if (point.time !== null && (typeof point.time !== 'number' || !Number.isFinite(point.time) || !Number.isFinite(new Date(point.time).getTime()))) throw new Error('标注点时间无效')
    if (!['track', 'estimated', 'unknown'].includes(point.timeSource)) throw new Error('标注点时间来源无效')
    const routePosition = validateRoutePosition(point.routePosition)
    ids.add(point.id)
    return {id: point.id, name: patch.name!, description: patch.description!, images: patch.images!, coordinates: patch.coordinates,
      elevation: patch.elevation, time: point.time, timeSource: point.timeSource, routePosition,
      ...(patch.type === undefined ? {} : {type: patch.type}), ...(patch.hidden === undefined ? {} : {hidden: patch.hidden})}
  })
}

function contextWithoutTrack(value: unknown): PlacemarkRouteContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('轨迹定位上下文无效')
  const context = value as PlacemarkRouteContext
  if (!Array.isArray(context.segmentStarts) || context.segmentStarts.some((index, position) => !Number.isInteger(index) || index < 0 || (position > 0 && index <= context.segmentStarts[position - 1]))
    || (context.segmentStarts.length > 0 && context.segmentStarts[0] !== 0)) throw new Error('轨迹分段数据无效')
  if (!Array.isArray(context.references) || context.references.some(point => !point || point.routePosition !== undefined || point.timeSource !== undefined)) throw new Error('时间参照只能使用原始标注点')
  const references = validatePlacemarks(context.references)
  return {segmentStarts: [...context.segmentStarts], references}
}

export function validatePlacemarkStateData(value: unknown, trackCoords?: readonly TrackPoint[]): PlacemarkStateData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('标注状态格式无效')
  const data = value as PlacemarkStateData
  const added = validateAdded(data.added), edits = validatePlacemarkEdits(data.edits), groups = validatePlacemarkGroups(data.groups)
  if (!Array.isArray(data.deletedIds) || data.deletedIds.length > 10000 || data.deletedIds.some(id => typeof id !== 'string' || !POINT_ID.test(id) || /^group-/iu.test(id))
    || new Set(data.deletedIds).size !== data.deletedIds.length) throw new Error('删除标注点编号无效或重复')
  const removed = new Set(data.deletedIds)
  if (added.some(point => removed.has(point.id))) throw new Error('新增点不能同时被删除')
  if (edits.some(edit => removed.has(edit.id)) || groups.some(group => group.memberIds.some(id => removed.has(id)))
    || (Array.isArray(data.order) && data.order.some(id => removed.has(id)))) throw new Error('已删除标注点仍被排序、修改或分组引用')
  if (!isPlacemarkOrder(data.order)) throw new Error('点位排序数据无效')
  const routeContext = data.routeContext === null ? null : trackCoords ? validateRouteContext(data.routeContext, trackCoords) : contextWithoutTrack(data.routeContext)
  const positioned = [...added, ...edits.filter(edit => !!edit.routePosition)]
  if (positioned.length && !routeContext) throw new Error('新增或移动标注点缺少轨迹定位上下文')
  if (trackCoords && routeContext) for (const point of positioned) derivePlacemarkLocation(trackCoords, routeContext, point.routePosition!)
  return {added, deletedIds: [...data.deletedIds], edits, order: data.order === null ? null : [...data.order], groups, routeContext}
}

export function validatePlacemarkState(value: unknown, trackCoords?: readonly TrackPoint[]): PlacemarkState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('标注状态文件格式无效')
  const state = value as PlacemarkState
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('标注状态版本或修订号无效')
  const data = validatePlacemarkStateData(state, trackCoords)
  if (trackCoords && data.routeContext) for (const point of [...data.added, ...data.edits.filter(edit => !!edit.routePosition)]) {
    const location = derivePlacemarkLocation(trackCoords, data.routeContext, point.routePosition!)
    if (JSON.stringify(point.coordinates) !== JSON.stringify(location.coordinates) || point.elevation !== location.elevation || point.time !== location.time || point.timeSource !== location.timeSource) throw new Error('标注状态中的位置、海拔或时间与轨迹不一致')
  }
  return {version: 1, revision: state.revision, ...data}
}
export function clonePlacemarkStateData(data: PlacemarkStateData): PlacemarkStateData {return validatePlacemarkStateData(data)}

export function effectivePlacemarks(raw: readonly TrackPlacemark[], data: PlacemarkStateData): TrackPlacemark[] {
  const removed = new Set(data.deletedIds), ids = new Set(raw.map(point => point.id))
  const points = [...raw, ...data.added.filter(point => !ids.has(point.id))].filter(point => !removed.has(point.id))
  return orderedPlacemarks(editedPlacemarks(points, data.edits), data.order)
}

/** Removing one or many points changes all relationships in a single history snapshot. */
export function removeStatePlacemarks(raw: readonly TrackPlacemark[], data: PlacemarkStateData, ids: readonly string[]): PlacemarkStateData {
  const current = effectivePlacemarks(raw, data), known = new Set(current.map(point => point.id))
  const removed = new Set(ids.filter(id => known.has(id))), addedIds = new Set(data.added.map(point => point.id))
  const deletedIds = [...new Set([...data.deletedIds, ...removed].filter(id => !addedIds.has(id)))]
  const remaining = current.filter(point => !removed.has(point.id))
  const groups = data.groups.flatMap(group => {
    const memberIds = group.memberIds.filter(id => !removed.has(id))
    if (!memberIds.length) return []
    const next: PlacemarkGroup = {...group, coordinates: [...group.coordinates], memberIds}
    if (group.cover && removed.has(group.cover.pointId)) {
      const wanted = new Set(memberIds)
      const photo = remaining.filter(point => wanted.has(point.id) && !point.hidden).flatMap(point => point.images.map(imageLink).filter((url): url is string => !!url).map(imageUrl => ({pointId: point.id, imageUrl})))[0]
      if (photo) next.cover = photo
      else delete next.cover
    }
    return [next]
  })
  return validatePlacemarkStateData({...data, added: data.added.filter(point => !removed.has(point.id)), deletedIds,
    edits: data.edits.filter(edit => !removed.has(edit.id)), order: data.order === null ? null : data.order.filter(id => !removed.has(id)), groups})
}
