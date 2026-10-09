import type { PlacemarkGroup, TrackPlacemark } from '../protocol.ts'
import { groupMembers, placemarkListItems } from '../track/placemark-groups.ts'

/** A member stays inside its group; top-level moves treat the group as one row. */
export function placemarkOrderScope(points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[], id: string): string[] {
  const parent = groups.find(group => group.memberIds.includes(id))
  return parent ? groupMembers(parent, points).map(point => point.id)
    : placemarkListItems(points, groups).map(item => item.kind === 'group' ? item.group.id : item.point.id)
}

export function moveGroupedPlacemark(points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[], sourceId: string, targetId: string, after: boolean): string[] | null {
  if (sourceId === targetId) return null
  const scope = placemarkOrderScope(points, groups, sourceId)
  if (!scope.includes(sourceId) || !scope.includes(targetId)) return null
  const ordered = scope.filter(id => id !== sourceId)
  ordered.splice(ordered.indexOf(targetId) + (after ? 1 : 0), 0, sourceId)
  if (ordered.every((id, index) => id === scope[index])) return null
  const parent = groups.find(group => group.memberIds.includes(sourceId))
  if (parent) {
    // Only replace member slots, leaving unrelated point positions untouched.
    const members = new Set(scope)
    let cursor = 0
    return points.map(point => members.has(point.id) ? ordered[cursor++] : point.id)
  }
  const rows = new Map<string, readonly string[]>(placemarkListItems(points, groups).map(item => item.kind === 'group'
    ? [item.group.id, item.members.map(point => point.id)] as const
    : [item.point.id, [item.point.id]] as const))
  return ordered.flatMap(id => rows.get(id) || [])
}

export function shiftGroupedPlacemark(points: readonly TrackPlacemark[], groups: readonly PlacemarkGroup[], id: string, direction: -1 | 1): string[] | null {
  const scope = placemarkOrderScope(points, groups, id), index = scope.indexOf(id)
  const next = index + direction
  if (index < 0 || next < 0 || next >= scope.length) return null
  return moveGroupedPlacemark(points, groups, id, scope[next], direction > 0)
}
