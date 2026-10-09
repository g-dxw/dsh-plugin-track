import { describe, expect, it } from 'vitest'
import type { PlacemarkGroup, TrackPlacemark, TrackPoint } from '../src/protocol.ts'
import { annotationPosition, annotationVisible, diagramCoordinates, type TrackAnnotation } from '../src/track/annotations.ts'
import { annotationPlacemarkNodes, initialPlacemarkAnnotations, mergePlacemarkAnnotationEdits, projectPlacemarkAnnotations, type AnnotationPlacemarkState } from '../src/track/annotation-placemarks.ts'

const coordinates: TrackPoint[] = [[119.4, 30.3, 500, null], [119.5, 30.4, 600, null], [119.6, 30.35, 700, null]]
const groupId = 'group-00000000-0000-0000-0000-000000000001'
const photo = {dataUrl: 'data:image/png;base64,AAAA', x: 80, y: 240}
function point(id: string, overrides: Partial<TrackPlacemark> = {}): TrackPlacemark {
  return {id, name: id, description: `${id} description`, coordinates: [119.4, 30.3], images: [], ...overrides}
}
function annotation(id: string, sourceId?: string, overrides: Partial<TrackAnnotation> = {}): TrackAnnotation {
  return {id, pointIndex: 0, label: `SVG ${id}`, color: '#7c3aed', ...(sourceId ? {sourceId} : {}), ...overrides}
}
function fixture(): AnnotationPlacemarkState {
  const points = [
    point('solo'),
    point('member-a', {images: ['https://example.com/a.jpg', 'https://example.com/shared.jpg']}),
    point('hidden', {hidden: true, type: '打卡点'}),
    point('member-b', {coordinates: [119.5, 30.4], images: ['https://example.com/b.jpg', 'https://example.com/shared.jpg']}),
    point('tail', {coordinates: [119.6, 30.35]}),
  ]
  const group: PlacemarkGroup = {id: groupId, name: '风景组', description: '分组说明', memberIds: ['member-b', 'member-a'], coordinates: [119.6, 30.35], cover: {pointId: 'member-b', imageUrl: 'https://example.com/b.jpg'}}
  return {points, groups: [group]}
}

describe('SVG source placemark initialization', () => {
  it('keeps visible top-level order and uses one group node with its own coordinates and cover first', () => {
    const state = fixture(), before = structuredClone(state)
    expect(annotationPlacemarkNodes(state).map(item => item.id)).toEqual(['solo', groupId, 'hidden', 'tail'])
    const result = initialPlacemarkAnnotations(state, coordinates)
    expect(result.map(item => item.sourceId)).toEqual(['solo', groupId, 'tail'])
    expect(result.every(item => item.visible === true && annotationVisible(item))).toBe(true)
    expect(result[1]).toMatchObject({id: groupId, sourceId: groupId, sourceCoordinates: [119.6, 30.35], pointIndex: 2, label: '风景组', description: '分组说明', imageUrls: ['https://example.com/b.jpg', 'https://example.com/a.jpg', 'https://example.com/shared.jpg']})
    expect(result.some(item => ['member-a', 'member-b', 'hidden'].includes(item.sourceId || ''))).toBe(false)
    expect(state).toEqual(before)
  })

  it.each(['explicit group hidden', 'all members hidden'] as const)('omits a group when %s while retaining independent visible points', scenario => {
    const state = fixture()
    if (scenario === 'explicit group hidden') state.groups[0].hidden = true
    else state.points = state.points.map(item => item.id.startsWith('member-') ? {...item, hidden: true} : item)
    expect(annotationPlacemarkNodes(state).find(item => item.id === groupId)?.hidden).toBe(true)
    expect(initialPlacemarkAnnotations(state, coordinates).map(item => item.sourceId)).toEqual(['solo', 'tail'])
  })

  it('falls back from a hidden cover member and does not expose its photos', () => {
    const state = fixture()
    state.points = state.points.map(item => item.id === 'member-b' ? {...item, hidden: true} : item)
    const result = initialPlacemarkAnnotations(state, coordinates).find(item => item.sourceId === groupId)!
    expect(result.imageUrls).toEqual(['https://example.com/a.jpg', 'https://example.com/shared.jpg'])
    expect(result.visible).toBe(true)
  })
})

describe('SVG source visibility projection', () => {
  it('suppresses hidden, deleted and grouped leaf annotations without rewriting saved artwork', () => {
    const state = fixture()
    const stored = [
      annotation('art-solo', 'solo', {label: '我的标题', position: {x: 220, y: 340}, photo}),
      annotation('art-hidden', 'hidden', {visible: true, kind: 'checkin', photo}),
      annotation('art-deleted', 'deleted', {visible: true, photo}),
      annotation('art-child-a', 'member-a', {visible: true, photo}),
      annotation('art-group', groupId, {visible: true, label: '我的分组标题', position: {x: 480, y: 540}}),
      annotation('art-child-b', 'member-b', {visible: true}),
    ]
    const before = structuredClone({stored, state})
    const result = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(result.map(item => item.id)).toEqual(['art-solo', 'art-group'])
    expect(result[0]).toMatchObject({id: 'art-solo', label: 'solo', description: 'solo description', sourceCoordinates: [119.4, 30.3], pointIndex: 0, color: '#7c3aed', position: {x: 220, y: 340}, photo, visible: true})
    expect(result[1]).toMatchObject({id: 'art-group', label: '风景组', description: '分组说明', sourceCoordinates: [119.6, 30.35], pointIndex: 2, position: {x: 480, y: 540}, visible: true})
    expect({stored, state}).toEqual(before)
  })

  it('replaces old grouped member annotations with a single current group node', () => {
    const state = fixture()
    const stored = [annotation('manual'), annotation('art-child-b', 'member-b', {visible: true}), annotation('art-child-a', 'member-a', {visible: true}), annotation('art-solo', 'solo')]
    const before = structuredClone(stored)
    const result = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(result.map(item => item.id)).toEqual(['manual', groupId, 'art-solo'])
    expect(result[1]).toMatchObject({sourceId: groupId, label: '风景组', visible: true, sourceCoordinates: state.groups[0].coordinates, imageUrls: ['https://example.com/b.jpg', 'https://example.com/a.jpg', 'https://example.com/shared.jpg']})
    expect(stored).toEqual(before)
  })

  it('keeps an explicitly hidden saved group instead of generating a visible replacement from its members', () => {
    const state = fixture()
    const savedGroup = annotation('saved-group', groupId, {visible: false, label: '自定义组名', photo, position: {x: 320, y: 450}})
    const stored = [annotation('art-child-a', 'member-a', {visible: true}), savedGroup, annotation('art-child-b', 'member-b', {visible: true})]
    const result = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({id: 'saved-group', label: '风景组', description: '分组说明', sourceCoordinates: [119.6, 30.35], pointIndex: 2, visible: false, photo, position: {x: 320, y: 450}})
    expect(savedGroup.label).toBe('自定义组名')
    expect(annotationVisible(result[0])).toBe(false)
  })

  it('defaults eligible legacy source nodes to visible while preserving explicit SVG and manual rules', () => {
    const state: AnnotationPlacemarkState = {points: [point('solo')], groups: []}
    const stored = [annotation('legacy', 'solo'), annotation('source-hidden', 'solo', {visible: false, kind: 'checkin'}), annotation('manual-default'), annotation('manual-show', undefined, {visible: true}), annotation('manual-kind', undefined, {kind: 'rest'}), annotation('manual-hide', undefined, {visible: false, kind: 'checkin'})]
    const result = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(result.map(annotationVisible)).toEqual([true, false, false, true, true, false])
    expect(stored[0]).not.toHaveProperty('visible')
    expect(result[0].label).toBe('solo')
    expect(result[1].label).toBe('solo')
    for (let index = 2; index < result.length; index++) expect(result[index]).toBe(stored[index])
  })

  it.each(['explicit group hidden', 'all members hidden'] as const)('suppresses both an existing group and old child fallback when %s', scenario => {
    const state = fixture()
    if (scenario === 'explicit group hidden') state.groups[0].hidden = true
    else state.points = state.points.map(item => item.id.startsWith('member-') ? {...item, hidden: true} : item)
    expect(projectPlacemarkAnnotations([annotation('existing-group', groupId, {visible: true})], state, coordinates)).toEqual([])
    expect(projectPlacemarkAnnotations([annotation('old-child', 'member-a', {visible: true})], state, coordinates)).toEqual([])
  })

  it('preserves a deliberately empty saved canvas and does not refill a manual-only canvas', () => {
    const state = fixture()
    expect(projectPlacemarkAnnotations([], state, coordinates)).toEqual([])
    const manual = annotation('manual', undefined, {visible: true})
    expect(projectPlacemarkAnnotations([manual], state, coordinates)).toEqual([manual])
  })

  it('restores leaf artwork with current metadata after a source point becomes visible and ungrouped again', () => {
    const state = fixture()
    const stored = [annotation('saved-child', 'member-a', {visible: true, label: '我的点位', position: {x: 400, y: 580}, photo})]
    expect(projectPlacemarkAnnotations(stored, state, coordinates).map(item => item.id)).toEqual([groupId])
    expect(projectPlacemarkAnnotations(stored, {...state, groups: []}, coordinates)[0]).toMatchObject({id: 'saved-child', label: 'member-a', description: 'member-a description', color: '#7c3aed', position: {x: 400, y: 580}, photo, visible: true})
    const hidden: AnnotationPlacemarkState = {points: state.points.map(item => item.id === 'member-a' ? {...item, hidden: true} : item), groups: []}
    expect(projectPlacemarkAnnotations(stored, hidden, coordinates)).toEqual([])
    expect(projectPlacemarkAnnotations(stored, {...state, groups: []}, coordinates)[0].photo).toEqual(photo)
    expect(stored[0].label).toBe('我的点位')
  })
})

describe('merging edits from the visible SVG projection', () => {
  it('preserves suppressed source data while saving displayed edits without materializing the source default', () => {
    const state = fixture()
    const stored = [annotation('hidden-edit', 'hidden', {visible: true, photo}), annotation('deleted-edit', 'deleted', {position: {x: 80, y: 140}, photo}), annotation('child-edit', 'member-a', {photo}), annotation('saved-group', groupId, {visible: false}), annotation('solo-edit', 'solo', {photo})]
    const displayed = projectPlacemarkAnnotations(stored, state, coordinates), before = structuredClone({stored, displayed})
    const next = displayed.map(item => item.id === 'solo-edit' ? {...item, color: '#2563eb', position: {x: 660, y: 760}, photo: {...photo, x: 280}} : item)
    const result = mergePlacemarkAnnotationEdits(stored, displayed, next)
    expect(result.slice(0, 4)).toEqual(stored.slice(0, 4))
    expect(result[4]).toMatchObject({id: 'solo-edit', label: 'solo', description: 'solo description', imageUrls: [], sourceCoordinates: [119.4, 30.3], pointIndex: 0, color: '#2563eb', position: {x: 660, y: 760}, photo: {...photo, x: 280}})
    expect(result[4]).not.toHaveProperty('visible')
    expect({stored, displayed}).toEqual(before)
  })

  it('keeps an unchanged source-derived visibility default implicit', () => {
    const stored = [annotation('legacy-source', 'solo')]
    const displayed = projectPlacemarkAnnotations(stored, {points: [point('solo')], groups: []}, coordinates)
    const result = mergePlacemarkAnnotationEdits(stored, displayed, displayed)
    expect(result).toEqual(stored)
    expect(result[0]).toBe(stored[0])
    expect(result[0]).not.toHaveProperty('visible')
  })

  it('does not append untouched generated groups when saving another edit at the stored annotation limit', () => {
    const state=fixture(), stored=Array.from({length:99},(_,index)=>annotation(`child-${index}`,index%2?'member-a':'member-b'))
    stored.push(annotation('manual',undefined,{visible:true}))
    const displayed=projectPlacemarkAnnotations(stored,state,coordinates)
    const next=displayed.map(item=>item.id==='manual'?{...item,label:'调整后的手工点'}:item)
    const merged=mergePlacemarkAnnotationEdits(stored,displayed,next)
    expect(merged).toHaveLength(100);expect(merged.at(-1)?.label).toBe('调整后的手工点')
    expect(projectPlacemarkAnnotations(merged,state,coordinates).map(item=>item.sourceId||item.id)).toEqual([groupId,'manual'])
  })

  it('persists explicit visibility switches in either direction', () => {
    const state: AnnotationPlacemarkState = {points: [point('solo')], groups: []}
    const stored = [annotation('legacy-source', 'solo')], displayed = projectPlacemarkAnnotations(stored, state, coordinates)
    const hidden = mergePlacemarkAnnotationEdits(stored, displayed, displayed.map(item => ({...item, visible: false})))
    expect(hidden).toEqual([{...displayed[0], visible: false}])
    const hiddenDisplay = projectPlacemarkAnnotations(hidden, state, coordinates)
    expect(mergePlacemarkAnnotationEdits(hidden, hiddenDisplay, hiddenDisplay.map(item => ({...item, visible: true})))).toEqual([{...displayed[0], visible: true}])
  })

  it('removes only displayed deletions and saves generated group and manual edits while retaining group members', () => {
    const state = fixture()
    const stored = [annotation('child-a', 'member-a', {photo}), annotation('child-b', 'member-b', {visible: false}), annotation('solo-edit', 'solo')]
    const displayed = projectPlacemarkAnnotations(stored, state, coordinates), before = structuredClone({stored, displayed})
    const group = {...displayed.find(item => item.sourceId === groupId)!, color: '#0f766e', position: {x: 500, y: 620}}, manual = annotation('new-manual', undefined, {visible: true})
    const result = mergePlacemarkAnnotationEdits(stored, displayed, [group, manual])
    expect(result).toEqual([stored[0], stored[1], group, manual])
    expect({stored, displayed}).toEqual(before)
  })
})

describe('SVG source metadata and geographic synchronization', () => {
  it('uses renamed and moved source metadata while retaining SVG style and layout', () => {
    const sourceUrl = 'https://example.com/updated.jpg'
    const stored = [annotation('saved-source', 'solo', {label: '旧画布标题', description: '旧说明', imageUrls: ['https://example.com/old.jpg'], sourceCoordinates: [119.4, 30.3], pointIndex: 0, kind: 'checkin', visible: false, position: {x: 370, y: 510}, photo: {...photo, sourceUrl}})]
    const state: AnnotationPlacemarkState = {points: [point('solo', {name: '山顶休息点', description: '更新后的源说明', coordinates: [119.58, 30.36], images: [sourceUrl], type: ['休息点', '风景']} )], groups: []}
    const before = structuredClone({stored, state})
    const result = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(result[0]).toMatchObject({id: 'saved-source', sourceId: 'solo', label: '山顶休息点', description: '更新后的源说明', imageUrls: [sourceUrl], sourceCoordinates: [119.58, 30.36], pointIndex: 2, kind: 'rest', visible: false, color: '#7c3aed', position: {x: 370, y: 510}, photo: {...photo, sourceUrl}})
    expect({stored, state}).toEqual(before)
  })

  it('keeps exact fractional source coordinates instead of snapping to the nearest track vertex', () => {
    const state: AnnotationPlacemarkState = {points: [point('solo', {coordinates: [119.44, 30.34]})], groups: []}
    const stored = [annotation('source', 'solo', {sourceCoordinates: [119.6, 30.35], pointIndex: 2})]
    const result = projectPlacemarkAnnotations(stored, state, coordinates)[0]
    expect(result.sourceCoordinates).toEqual([119.44, 30.34])
    expect(result.pointIndex).toBe(0)
    const [x, y] = annotationPosition(result, coordinates), route = diagramCoordinates(coordinates)
    expect(x).toBeGreaterThan(route[0][0])
    expect(x).toBeLessThan(route[1][0])
    expect(y).toBeLessThan(route[0][1])
    expect(y).toBeGreaterThan(route[1][1])
    expect([x, y]).not.toEqual(route[result.pointIndex])
  })

  it('recomputes nearest track index when route vertices change without changing the source anchor', () => {
    const source: [number, number] = [119.58, 30.36]
    const state: AnnotationPlacemarkState = {points: [point('solo', {coordinates: source})], groups: []}
    const stored = [annotation('source', 'solo', {pointIndex: 2, sourceCoordinates: source})]
    const reordered: TrackPoint[] = [coordinates[2], coordinates[0], coordinates[1]]
    const result = projectPlacemarkAnnotations(stored, state, reordered)[0]
    expect(result.pointIndex).toBe(0)
    expect(result.sourceCoordinates).toEqual(source)
  })

  it('refreshes a moved and renamed group from its own node, with current member photos and types', () => {
    const state = fixture()
    state.groups[0] = {...state.groups[0], name: '新的风景组', description: '组说明已更新', coordinates: [119.44, 30.34]}
    state.points = state.points.map(item => item.id === 'member-a' ? {...item, type: ['休息点', '风景']} : item)
    const stored = [annotation('saved-group', groupId, {label: '旧组名', description: '旧组说明', sourceCoordinates: [119.6, 30.35], pointIndex: 2, position: {x: 430, y: 590}, photo: {...photo, sourceUrl: 'https://example.com/b.jpg'}, kind: 'checkin'})]
    expect(annotationPlacemarkNodes(state).find(item => item.id === groupId)?.type).toEqual(['休息点', '风景'])
    const result = projectPlacemarkAnnotations(stored, state, coordinates)[0]
    expect(result).toMatchObject({id: 'saved-group', label: '新的风景组', description: '组说明已更新', sourceCoordinates: [119.44, 30.34], pointIndex: 0, kind: 'rest', imageUrls: ['https://example.com/b.jpg', 'https://example.com/a.jpg', 'https://example.com/shared.jpg'], position: {x: 430, y: 590}, photo: {...photo, sourceUrl: 'https://example.com/b.jpg'}})
  })

  it('removes a stale recognized kind when the point editor clears or replaces its type', () => {
    const stored = [annotation('source', 'solo', {kind: 'checkin'})]
    const types: (string | string[])[] = ['', [], ['风景']]
    for (const type of types) {
      const state: AnnotationPlacemarkState = {points: [point('solo', {type})], groups: []}
      expect(projectPlacemarkAnnotations(stored, state, coordinates)[0].kind).toBeUndefined()
    }
    const typed: AnnotationPlacemarkState = {points: [point('solo', {type: '打卡点'})], groups: []}
    expect(initialPlacemarkAnnotations(typed, coordinates)[0].kind).toBe('checkin')
  })

  it('temporarily omits removed source photos while retaining saved photos and their layout for source restoration', () => {
    const sourceUrl = 'https://example.com/saved.jpg'
    const stored = [annotation('source', 'solo', {imageUrls: [sourceUrl], photo: {...photo, sourceUrl}, position: {x: 210, y: 410}})]
    const state: AnnotationPlacemarkState = {points: [point('solo')], groups: []}
    const displayed = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(displayed[0].imageUrls).toEqual([])
    expect(displayed[0].photo).toBeUndefined()
    expect(mergePlacemarkAnnotationEdits(stored, displayed, displayed)[0]).toBe(stored[0])
    expect(stored[0].photo).toEqual({...photo, sourceUrl})
    const edited = displayed.map(item => ({...item, color: '#2563eb', position: {x: 260, y: 480}}))
    const merged = mergePlacemarkAnnotationEdits(stored, displayed, edited)
    expect(merged[0]).toMatchObject({color: '#2563eb', position: {x: 260, y: 480}, photo: {...photo, sourceUrl}})
    expect(projectPlacemarkAnnotations(merged, state, coordinates)[0].photo).toBeUndefined()
    const restored: AnnotationPlacemarkState = {points: [point('solo', {images: [sourceUrl]})], groups: []}
    expect(projectPlacemarkAnnotations(merged, restored, coordinates)[0]).toMatchObject({photo: {...photo, sourceUrl}, color: '#2563eb', position: {x: 260, y: 480}})
  })

  it('saves explicit removal or replacement of a currently visible source photo', () => {
    const sourceUrl = 'https://example.com/saved.jpg'
    const state: AnnotationPlacemarkState = {points: [point('solo', {images: [sourceUrl]})], groups: []}
    const stored = [annotation('source', 'solo', {photo: {...photo, sourceUrl}})]
    const displayed = projectPlacemarkAnnotations(stored, state, coordinates)
    const removed = mergePlacemarkAnnotationEdits(stored, displayed, displayed.map(item => ({...item, photo: undefined})))
    expect(removed[0].photo).toBeUndefined()
    const replacement = {dataUrl: 'data:image/png;base64,BBBB', x: 190, y: 380}
    const replaced = mergePlacemarkAnnotationEdits(stored, displayed, displayed.map(item => ({...item, photo: replacement})))
    expect(replaced[0].photo).toEqual(replacement)
  })

  it('keeps local artwork photos without a source URL and manual annotations unchanged', () => {
    const state: AnnotationPlacemarkState = {points: [point('solo')], groups: []}
    const manual = annotation('manual', undefined, {label: '手工标题', description: '手工说明', sourceCoordinates: [119.6, 30.35], pointIndex: 2, imageUrls: ['https://example.com/manual.jpg'], photo, kind: 'rest'})
    const stored = [annotation('linked', 'solo', {photo}), manual]
    const result = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(result[0].photo).toEqual(photo)
    expect(result[1]).toBe(manual)
  })

  it('retains source names up to 160 characters and group descriptions up to 10000 characters', () => {
    const state = fixture(), name = '山'.repeat(160), description = '说明'.repeat(5000)
    state.groups[0] = {...state.groups[0], name, description}
    state.points[0] = {...state.points[0], name, description: '点'.repeat(4000)}
    const initialized = initialPlacemarkAnnotations(state, coordinates)
    expect(initialized[0].label).toBe(name)
    expect(initialized[0].description).toBe('点'.repeat(4000))
    expect(initialized[1].label).toBe(name)
    expect(initialized[1].description).toBe(description)
    const projected = projectPlacemarkAnnotations([annotation('old-group', groupId, {label: '旧名称', description: '旧说明'})], state, coordinates)
    expect(projected[0].label).toBe(name)
    expect(projected[0].description).toBe(description)
  })

  it('does not turn source refreshes into canonical artwork edits, but saves current metadata with a real layout change', () => {
    const state: AnnotationPlacemarkState = {points: [point('solo', {name: '当前点位', description: '当前说明', coordinates: [119.58, 30.36], type: '休息点', images: ['https://example.com/current.jpg']})], groups: []}
    const stored = [annotation('source', 'solo', {label: '旧名称', description: '旧说明', sourceCoordinates: [119.4, 30.3], pointIndex: 0, imageUrls: ['https://example.com/old.jpg']})]
    const displayed = projectPlacemarkAnnotations(stored, state, coordinates)
    expect(mergePlacemarkAnnotationEdits(stored, displayed, displayed)[0]).toBe(stored[0])
    const next = displayed.map(item => ({...item, position: {x: 470, y: 640}, color: '#2563eb'}))
    const merged = mergePlacemarkAnnotationEdits(stored, displayed, next)
    expect(merged[0]).toMatchObject({id: 'source', label: '当前点位', description: '当前说明', sourceCoordinates: [119.58, 30.36], pointIndex: 2, kind: 'rest', imageUrls: ['https://example.com/current.jpg'], position: {x: 470, y: 640}, color: '#2563eb'})
    expect(merged[0]).not.toHaveProperty('visible')
    expect(stored[0].label).toBe('旧名称')
  })
})
