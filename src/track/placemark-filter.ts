import type { PlacemarkGroup, TrackPlacemark } from '../protocol.ts'
import { placemarkTypes } from './placemark-edits.ts'
import { placemarkListItems, type PlacemarkListItem } from './placemark-groups.ts'

export const ALL_PLACEMARK_TYPES = 'all'
export const UNCLASSIFIED_PLACEMARKS = 'untyped'

/** A legacy single selection or the union of several encoded type selections. */
export type PlacemarkTypeFilter = string | readonly string[]
export function placemarkTypeValues(filter: PlacemarkTypeFilter): readonly string[] {
  return typeof filter === 'string' ? [filter] : filter
}
export function isAllPlacemarkTypes(filter: PlacemarkTypeFilter): boolean {
  return placemarkTypeValues(filter).includes(ALL_PLACEMARK_TYPES)
}

export function matchesPlacemarkType(point: TrackPlacemark, filter: PlacemarkTypeFilter): boolean {
  if (isAllPlacemarkTypes(filter)) return true
  const types = placemarkTypes(point)
  return placemarkTypeValues(filter).some(value => value === UNCLASSIFIED_PLACEMARKS
    ? types.length === 0 : value.startsWith('type:') && types.includes(value.slice(5)))
}

export function placemarkTypeOptions(points: readonly TrackPlacemark[]): {value: string; label: string; count: number}[] {
  const counts = new Map<string, number>()
  let untyped = 0
  for (const point of points) {
    const types = placemarkTypes(point)
    if (!types.length) untyped += 1
    for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [
    {value: ALL_PLACEMARK_TYPES, label: '全部类型', count: points.length},
    ...Array.from(counts, ([type, count]) => ({value: `type:${type}`, label: type, count})),
    ...(untyped ? [{value: UNCLASSIFIED_PLACEMARKS, label: '未分类', count: untyped}] : []),
  ]
}

/** Filter the display projection after numbering, keeping persisted order and groups intact. */
export function filteredPlacemarkListItems(points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[], filter: PlacemarkTypeFilter): PlacemarkListItem[] {
  const items = placemarkListItems(points, groups)
  if (isAllPlacemarkTypes(filter)) return items
  return items.flatMap((item): PlacemarkListItem[] => {
    if (item.kind === 'point') return matchesPlacemarkType(item.point, filter) ? [item] : []
    const members = item.members.filter(point => matchesPlacemarkType(point, filter))
    return members.length ? [{...item, members}] : []
  })
}
