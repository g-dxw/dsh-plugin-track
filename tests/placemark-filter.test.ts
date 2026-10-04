import { describe, expect, it } from 'vitest'
import type { PlacemarkGroup, TrackPlacemark } from '../src/protocol.ts'
import { ALL_PLACEMARK_TYPES, UNCLASSIFIED_PLACEMARKS, filteredPlacemarkListItems, matchesPlacemarkType, placemarkTypeOptions, placemarkTypeValues, isAllPlacemarkTypes } from '../src/track/placemark-filter.ts'

function point(id: string, type?: string | string[]): TrackPlacemark {
  return {id, name: id, description: '', coordinates: [120, 30], images: [], ...(type === undefined ? {} : {type})}
}
const points = [point('group-a', [' 风景 ', '水源', '风景']), point('solo', '水源'), point('group-b', '营地'), point('group-c'), point('tail', [])]
const groups: PlacemarkGroup[] = [
  {id: 'group-one', name: '第一组', description: '', coordinates: [120, 30], memberIds: ['group-a']},
  {id: 'group-two', name: '第二组', description: '', coordinates: [120, 30], memberIds: ['group-b', 'group-c']},
]

describe('placemark type display filters', () => {
  it('counts normalized labels once per point and separates unclassified points from real reserved-looking labels', () => {
    expect(placemarkTypeOptions(points)).toEqual([
      {value: ALL_PLACEMARK_TYPES, label: '全部类型', count: 5},
      {value: 'type:风景', label: '风景', count: 1},
      {value: 'type:水源', label: '水源', count: 2},
      {value: 'type:营地', label: '营地', count: 1},
      {value: UNCLASSIFIED_PLACEMARKS, label: '未分类', count: 2},
    ])
    const reserved = point('reserved', ['all', 'untyped', 'type:水源'])
    expect(matchesPlacemarkType(reserved, 'type:all')).toBe(true)
    expect(matchesPlacemarkType(reserved, 'type:untyped')).toBe(true)
    expect(matchesPlacemarkType(reserved, 'type:type:水源')).toBe(true)
    expect(matchesPlacemarkType(reserved, UNCLASSIFIED_PLACEMARKS)).toBe(false)
    expect(matchesPlacemarkType(points[0], 'type:水')).toBe(false)
    expect(matchesPlacemarkType(points[0], '风景')).toBe(false)
    expect(matchesPlacemarkType(points[3], UNCLASSIFIED_PLACEMARKS)).toBe(true)
    expect(placemarkTypeOptions([])).toEqual([{value: ALL_PLACEMARK_TYPES, label: '全部类型', count: 0}])
    expect(placemarkTypeValues('type:营地')).toEqual(['type:营地'])
    expect(isAllPlacemarkTypes(['type:不存在', ALL_PLACEMARK_TYPES])).toBe(true)
    expect(matchesPlacemarkType(reserved, ['type:all', UNCLASSIFIED_PLACEMARKS])).toBe(true)
    expect(matchesPlacemarkType(points[3], ['type:all', UNCLASSIFIED_PLACEMARKS])).toBe(true)
    expect(matchesPlacemarkType(reserved, [UNCLASSIFIED_PLACEMARKS, 'type:不存在'])).toBe(false)
    expect(matchesPlacemarkType(points[0], [])).toBe(false)
  })

  it('preserves original point and group numbering, filters only group members, and retains original records', () => {
    const snapshot = structuredClone({points, groups})
    const selected = filteredPlacemarkListItems(points, groups, 'type:水源')
    expect(selected).toEqual([
      {kind: 'group', group: groups[0], number: 1, members: [points[0]]},
      {kind: 'point', point: points[1], number: 2},
    ])
    expect(selected[0].kind === 'group' && selected[0].group).toBe(groups[0])
    expect(filteredPlacemarkListItems(points, groups, UNCLASSIFIED_PLACEMARKS)).toEqual([
      {kind: 'group', group: groups[1], number: 2, members: [points[3]]},
      {kind: 'point', point: points[4], number: 5},
    ])
    expect(filteredPlacemarkListItems(points, groups, 'type:不存在')).toEqual([])
    const union = ['type:水源', 'type:风景', UNCLASSIFIED_PLACEMARKS, 'type:水源'] as const
    const combined = filteredPlacemarkListItems(points, groups, union)
    expect(combined).toEqual([
      {kind: 'group', group: groups[0], number: 1, members: [points[0]]},
      {kind: 'point', point: points[1], number: 2},
      {kind: 'group', group: groups[1], number: 2, members: [points[3]]},
      {kind: 'point', point: points[4], number: 5},
    ])
    expect(combined.flatMap(item => item.kind === 'group' ? item.members.map(member => member.id) : [item.point.id])).toEqual(
      ['group-a', 'solo', 'group-c', 'tail'])
    expect(filteredPlacemarkListItems(points, groups, [])).toEqual([])
    expect(union).toEqual(['type:水源', 'type:风景', UNCLASSIFIED_PLACEMARKS, 'type:水源'])
    expect({points, groups}).toEqual(snapshot)
  })

  it('keeps the full projection for all types including hidden metadata, without changing visibility flags', () => {
    const hidden = {...points[0], hidden: true}
    const result = filteredPlacemarkListItems([hidden, ...points.slice(1)], [{...groups[0], hidden: true}, groups[1]], ['type:不存在', ALL_PLACEMARK_TYPES])
    expect(result.map(item => item.kind === 'group' ? `G${item.number}` : item.number)).toEqual(['G1', 2, 'G2', 5])
    expect(result[0].kind === 'group' && result[0].members[0]).toBe(hidden)
    expect(hidden.hidden).toBe(true)
  })
})
