import type { PlacemarkTimeSource, RoutePosition, TrackPlacemark, TrackPoint } from '../protocol.ts'
import { imageLink } from './placemarks.ts'
import { projectProfilePlacemarks } from './profile-placemarks.ts'
import { validateRoutePosition } from './placemark-location.ts'

export interface PlacemarkEdit {
  id: string
  coordinates?: [number, number]
  elevation?: number | null
  time?: number | null
  timeSource?: PlacemarkTimeSource
  routePosition?: RoutePosition
  images?: string[]
  name?: string
  description?: string
  type?: string | string[]
  hidden?: boolean
}

/** Read both saved formats without letting malformed legacy values break a view. */
export function placemarkTypes(point: {type?: string | string[]}): string[] {
  const value = point?.type
  const types = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(types.filter((type): type is string => typeof type === 'string').map(type => type.trim()).filter(Boolean))]
}

export function validatePlacemarkEdits(value: unknown): PlacemarkEdit[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('点位调整最多 10000 项')
  const ids = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('点位调整格式无效')
    const item = raw as Partial<PlacemarkEdit>
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id)) throw new Error('点位调整编号无效或重复')
    ids.add(item.id)
    const result: PlacemarkEdit = {id: item.id}
    if (item.name !== undefined) {
      if (typeof item.name !== 'string' || item.name.length > 160) throw new Error('点位名称最多 160 个字符')
      result.name = item.name
    }
    if (item.description !== undefined) {
      if (typeof item.description !== 'string' || item.description.length > 10000) throw new Error('点位说明最多 10000 个字符')
      result.description = item.description
    }
    if (item.type !== undefined) {
      if (typeof item.type === 'string') {
        if (item.type.length > 64) throw new Error('点位类型最多 64 个字符')
        result.type = item.type
      } else if (Array.isArray(item.type) && item.type.length <= 20) {
        const normalized: string[] = []
        for (const type of item.type) {
          if (typeof type !== 'string' || !type.trim() || type.trim().length > 64) throw new Error('每个点位类型须为 1 至 64 个字符的文字标签')
          normalized.push(type.trim())
        }
        result.type = [...new Set(normalized)]
      } else throw new Error('点位类型须为文字或最多 20 项的文字标签列表')
    }
    if (item.hidden !== undefined) {
      if (typeof item.hidden !== 'boolean') throw new Error('点位显隐状态无效')
      result.hidden = item.hidden
    }
    if (item.coordinates !== undefined) {
      if (!Array.isArray(item.coordinates) || item.coordinates.length !== 2 || !item.coordinates.every(value => typeof value === 'number' && Number.isFinite(value))
        || Math.abs(item.coordinates[0]) > 180 || Math.abs(item.coordinates[1]) > 90) throw new Error('点位调整坐标无效')
      result.coordinates = [item.coordinates[0], item.coordinates[1]]
    }
    if (item.elevation !== undefined) {
      if (item.elevation !== null && (typeof item.elevation !== 'number' || !Number.isFinite(item.elevation))) throw new Error('点位调整海拔无效')
      result.elevation = item.elevation
    }
    if (item.time !== undefined) {
      if (item.time !== null && (typeof item.time !== 'number' || !Number.isFinite(item.time) || !Number.isFinite(new Date(item.time).getTime()))) throw new Error('点位调整时间无效')
      result.time = item.time
    }
    if (item.timeSource !== undefined) {
      if (!['track', 'estimated', 'unknown'].includes(item.timeSource)) throw new Error('点位调整时间来源无效')
      result.timeSource = item.timeSource
    }
    if (item.routePosition !== undefined) result.routePosition = validateRoutePosition(item.routePosition)
    if (item.images !== undefined) {
      if (!Array.isArray(item.images) || item.images.length > 30 || item.images.some(url => typeof url !== 'string' || url.length > 4096 || !imageLink(url))) throw new Error('点位调整图片链接无效')
      result.images = [...new Set(item.images.map(url => imageLink(url)!))]
    }
    return result
  })
}

export function editedPlacemarks(points: TrackPlacemark[], edits: readonly PlacemarkEdit[]): TrackPlacemark[] {
  if (!edits.length) return points
  const byId = new Map(edits.map(edit => [edit.id, edit]))
  return points.map(point => {
    const edit = byId.get(point.id)
    return edit ? {...point, ...(edit.coordinates ? {coordinates: edit.coordinates} : {}),
      ...(edit.elevation !== undefined ? {elevation: edit.elevation} : {}),
      ...(edit.time !== undefined ? {time: edit.time} : {}), ...(edit.timeSource !== undefined ? {timeSource: edit.timeSource} : {}),
      ...(edit.routePosition !== undefined ? {routePosition: edit.routePosition} : {}), ...(edit.images ? {images: edit.images} : {}),
      ...(edit.name !== undefined ? {name: edit.name} : {}), ...(edit.description !== undefined ? {description: edit.description} : {}),
      ...(edit.type !== undefined ? {type: edit.type} : {}), ...(edit.hidden !== undefined ? {hidden: edit.hidden} : {})} : point
  })
}

export function patchPlacemarkEdits(edits: readonly PlacemarkEdit[], patches: readonly PlacemarkEdit[]): PlacemarkEdit[] {
  const byId = new Map(edits.map(edit => [edit.id, edit]))
  for (const patch of patches) byId.set(patch.id, {...byId.get(patch.id), ...patch})
  return validatePlacemarkEdits([...byId.values()])
}

/** Legacy/group attachment helper. Point moves use the explicit location candidates instead. */
export function snapPlacemarkToTrack(point: TrackPlacemark, coordinates: [number, number], track: readonly TrackPoint[], segmentStarts?: readonly number[]): PlacemarkEdit {
  if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('标注点位置无效')
  const [projection] = projectProfilePlacemarks(track, [{...point, coordinates, routePosition: undefined}], segmentStarts)
  if (!projection) throw new Error('轨迹没有可对应的坐标点')
  const start = track[projection.startIndex], end = track[projection.endIndex], ratio = projection.fraction
  let delta = end[0] - start[0]
  if (delta > 180) delta -= 360
  if (delta < -180) delta += 360
  let lon = start[0] + delta * ratio
  if (lon > 180) lon -= 360
  if (lon < -180) lon += 360
  const valid = (value: number | null) => typeof value === 'number' && Number.isFinite(value)
  const elevation = ratio === 0 && valid(start[2]) ? start[2] : ratio === 1 && valid(end[2]) ? end[2]
    : valid(start[2]) && valid(end[2]) ? start[2]! + (end[2]! - start[2]!) * ratio : null
  return {id: point.id, coordinates: [lon, start[1] + (end[1] - start[1]) * ratio], elevation}
}
