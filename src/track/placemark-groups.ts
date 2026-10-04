import type { PlacemarkGroup, TrackPlacemark } from '../protocol.ts'
import { placemarkTypes } from './placemark-edits.ts'
import { imageLink } from './placemarks.ts'

const GROUP_ID = /^group-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const LEAF_ID = /^[A-Za-z0-9_-]{1,64}$/u
function validCoordinates(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
    && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
}

/** References may come from retained KML source, rather than track.json metadata. */
export function validatePlacemarkGroups(value: unknown): PlacemarkGroup[] {
  if (!Array.isArray(value)) throw new Error('标注点分组格式无效')
  if (value.length > 5000) throw new Error('标注点分组最多 5000 项')
  const groups: PlacemarkGroup[] = [], ids = new Set<string>(), members = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('标注点分组格式无效')
    const item = raw as Partial<PlacemarkGroup>
    if (typeof item.id !== 'string' || !GROUP_ID.test(item.id) || ids.has(item.id)) throw new Error('分组编号无效或重复')
    if (typeof item.name !== 'string' || item.name.length > 160) throw new Error('分组名称最多 160 个字符')
    if (typeof item.description !== 'string' || item.description.length > 10000) throw new Error('分组说明最多 10000 个字符')
    if (!validCoordinates(item.coordinates)) throw new Error('分组坐标无效')
    if (!Array.isArray(item.memberIds) || !item.memberIds.length || item.memberIds.length > 10000) throw new Error('分组须包含标注点，成员总数最多 10000 个')
    const memberIds: string[] = []
    for (const id of item.memberIds) {
      if (typeof id !== 'string' || !LEAF_ID.test(id) || /^group-/iu.test(id) || members.has(id)) throw new Error('成员编号无效、重复或已属于其他组')
      members.add(id); memberIds.push(id)
      if (members.size > 10000) throw new Error('分组成员总数最多 10000 个')
    }
    const group: PlacemarkGroup = {id:item.id,name:item.name,description:item.description,memberIds,coordinates:[...item.coordinates]}
    if (item.cover !== undefined) {
      const cover = item.cover
      if (!cover || typeof cover !== 'object' || Array.isArray(cover) || typeof cover.pointId !== 'string' || !memberIds.includes(cover.pointId)
        || typeof cover.imageUrl !== 'string' || cover.imageUrl.length > 4096) throw new Error('分组默认图片须属于组成员')
      const imageUrl = imageLink(cover.imageUrl)
      if (!imageUrl) throw new Error('分组默认图片链接无效')
      group.cover = {pointId:cover.pointId,imageUrl}
    }
    if (item.hidden !== undefined) {
      if (typeof item.hidden !== 'boolean') throw new Error('分组显隐状态无效')
      group.hidden = item.hidden
    }
    ids.add(group.id); groups.push(group)
  }
  return groups
}

export function groupMembers(group: PlacemarkGroup, points: readonly TrackPlacemark[]): TrackPlacemark[] {
  const ids = new Set(group.memberIds)
  return points.filter(point => ids.has(point.id))
}
export interface PlacemarkGroupPhoto {point: TrackPlacemark; url: string}
export function groupPhotos(group: PlacemarkGroup, points: readonly TrackPlacemark[]): PlacemarkGroupPhoto[] {
  return groupMembers(group, points).filter(point => !point.hidden).flatMap(point => {
    const urls = [...new Set(point.images.filter((url): url is string => typeof url === 'string').map(imageLink).filter((url): url is string => !!url))]
    return urls.map(url => ({point, url}))
  })
}
export function groupCoverPhoto(group: PlacemarkGroup, points: readonly TrackPlacemark[]): PlacemarkGroupPhoto | undefined {
  const photos = groupPhotos(group, points), cover = group.cover
  const url = cover && imageLink(cover.imageUrl)
  return photos.find(photo => photo.point.id === cover?.pointId && photo.url === url) || photos[0]
}
/** Merge only the group projection; the flat child data and its order remain intact. */
export function mergePlacemarkGroups(selected: readonly PlacemarkGroup[], points: readonly TrackPlacemark[]): PlacemarkGroup {
  const selectedIds = new Set<string>()
  const groups = selected.filter(group => {
    if (selectedIds.has(group.id)) return false
    selectedIds.add(group.id); return true
  })
  if (groups.length < 2) throw new Error('请选择至少两个不同分组进行合并')
  const first = groups[0], ids = new Set(groups.flatMap(group => group.memberIds))
  const known: TrackPlacemark[] = [], memberIds: string[] = [], included = new Set<string>()
  for (const point of points) {
    if (!ids.has(point.id) || included.has(point.id)) continue
    included.add(point.id); memberIds.push(point.id); known.push(point)
  }
  for (const group of groups) for (const id of group.memberIds) {
    if (included.has(id)) continue
    included.add(id); memberIds.push(id)
  }
  const merged: PlacemarkGroup = {
    id: first.id,
    name: first.name,
    description: groups.map(group => group.description).filter(description => description.length > 0).join('\n\n'),
    memberIds,
    coordinates: [...(known[Math.floor(known.length / 2)]?.coordinates || first.coordinates)],
  }
  if (first.hidden !== undefined) merged.hidden = first.hidden
  if (first.cover !== undefined) merged.cover = {...first.cover}
  else {
    const photo = groupCoverPhoto(merged, points)
    if (photo) merged.cover = {pointId: photo.point.id, imageUrl: photo.url}
  }
  return validatePlacemarkGroups([merged])[0]
}
export function groupTypes(group: PlacemarkGroup, points: readonly TrackPlacemark[]): string[] {
  return [...new Set(groupMembers(group, points).flatMap(placemarkTypes))]
}
export function groupHidden(group: PlacemarkGroup, points: readonly TrackPlacemark[]): boolean {
  return !!group.hidden || !groupMembers(group, points).some(point => !point.hidden && validCoordinates(point.coordinates))
}

export type PlacemarkListItem =
  | {kind: 'point'; point: TrackPlacemark; number: number}
  | {kind: 'group'; group: PlacemarkGroup; number: number; members: TrackPlacemark[]}

/** Groups are a display projection; leaf IDs and the persisted flat order stay intact. */
export function placemarkListItems(points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[]): PlacemarkListItem[] {
  const byMember = new Map<string, PlacemarkGroup>(), members = new Map<string, TrackPlacemark[]>()
  for (const group of groups) for (const id of group.memberIds) if (!byMember.has(id)) byMember.set(id, group)
  for (const point of points) {
    const group = byMember.get(point.id)
    if (group) {
      const current = members.get(group.id) || []
      current.push(point); members.set(group.id, current)
    }
  }
  const shown = new Set<string>(), result: PlacemarkListItem[] = []
  let groupNumber = 0
  points.forEach((point, index) => {
    const group = byMember.get(point.id)
    if (!group) result.push({kind:'point',point,number:index+1})
    else if (!shown.has(group.id)) {
      shown.add(group.id)
      result.push({kind:'group',group,number:++groupNumber,members:members.get(group.id)!})
    }
  })
  return result
}
