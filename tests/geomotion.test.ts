import {describe, expect, it} from 'vitest'
import type {PlacemarkGroup, TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import {createGeoMotionProject, geoCameraKeys, geoEvaluate, geoNewKey,
  geoParseProject, geoRemoveCameraKey, geoResizeDuration, geoSetCameraKey} from '../src/track/geomotion.ts'

const point = (id: string, name: string, lon: number, hidden = false): TrackPlacemark => ({id, name, coordinates: [lon, 27.5], description: '', images: [], hidden})
function track(): TrackRecord {
  return {id: 'actual-track', name: '武功山真实轨迹', filename: 'hike.gpx', format: 'gpx', createdAt: '2026-10-04T00:00:00Z', bytes: 100, points: 5,
    coordinates: [[114.1, 27.5, 1400, null], [114.11, 27.51, 1450, null], [115.1, 27.6, 1300, null], [115.11, 27.61, 1400, null], [115.12, 27.62, 1350, null]], segmentStarts: [0, 2],
    metrics: {distance: 4000, elevationGain: 150, elevationLoss: 50, duration: 0, elevationMax: 1450, elevationMin: 1300, bbox: [114.1, 27.5, 115.12, 27.62]}}
}
const points = [point('a', '发云界', 114.1), point('b', '金顶', 115.1), point('hidden', '隐藏点', 114.2, true)]

function built() {return createGeoMotionProject(track(), points).document}

describe('Track and GeoMotion project adapter', () => {
  it('keeps real disconnected route geometry and imports effective named markers without modifying source', () => {
    const input = track(), original = JSON.stringify(input), pointJson = JSON.stringify(points)
    const {document} = createGeoMotionProject(input, points)
    expect(document).toMatchObject({duration: 20, width: 1280, height: 720, fps: 30, terrain: true, terrainExaggeration: 1})
    const nodes = Object.values(document.nodes), routes = nodes.filter(node => node.type === 'route')
    expect(routes).toHaveLength(2)
    expect(routes.map(route => route.coords)).toEqual([[[114.1, 27.5], [114.11, 27.51]], [[115.1, 27.6], [115.11, 27.61], [115.12, 27.62]]])
    expect(routes.every(route => route.curve === 'straight')).toBe(true)
    expect(nodes.filter(node => node.type === 'marker').map(marker => [marker.label, marker.coord])).toEqual([['发云界', [114.1, 27.5]], ['金顶', [115.1, 27.5]]])
    expect(JSON.stringify(input)).toBe(original); expect(JSON.stringify(points)).toBe(pointJson)
    routes[0].coords[0][0] = 20
    expect(input.coordinates[0][0]).toBe(114.1)
  })

  it('honors the current group projection and suppresses hidden groups and their children', () => {
    const group: PlacemarkGroup = {id: 'group-live', name: '山脊营地', coordinates: [114.1, 27.5], memberIds: ['a', 'b'], description: ''}
    const document = createGeoMotionProject(track(), points, [group]).document
    const markers = Object.values(document.nodes).filter(node => node.type === 'marker')
    expect(markers.map(marker => marker.label)).toEqual(['山脊营地'])
    group.hidden = true
    expect(Object.values(createGeoMotionProject(track(), points, [group]).document.nodes).filter(node => node.type === 'marker')).toHaveLength(0)
  })

  it('breaks at invalid coordinates and preserves isolated fixes instead of bridging a missing section', () => {
    const input = track(); input.segmentStarts = undefined; input.coordinates[1][0] = NaN
    const routes = Object.values(createGeoMotionProject(input, []).document.nodes).filter(node => node.type === 'route')
    expect(routes.map(route => route.coords.length)).toEqual([1, 3])
    expect(routes[0].coords[0]).toEqual([114.1, 27.5])
    input.coordinates = []
    expect(() => createGeoMotionProject(input, [])).toThrow('没有有效坐标')
  })

  it('fits an antimeridian crossing locally and handles large valid routes without spreading argument limits', () => {
    const input = track(); input.coordinates = [[179.9, 20, 0, null], [-179.9, 20.1, 0, null]]; input.segmentStarts = [0]
    const document = createGeoMotionProject(input, []).document, camera = geoCameraKeys(document)[1]
    expect(Math.abs(camera.center[0])).toBeGreaterThan(179)
    expect(camera.zoom).toBeGreaterThan(8)
    input.coordinates = Array.from({length: 130000}, (_, index) => [114 + index / 1e7, 27.5, null, null])
    expect(() => createGeoMotionProject(input, [])).not.toThrow()
  })

  it('finishes drawing before the outro and keeps real route labels visible through the final frame', () => {
    const document = built()
    for (const time of [16, 18, 20]) {
      const scene = geoEvaluate(document, time)
      expect(scene.routes.every(route => route.progress === 1 && route.alpha === 1)).toBe(true)
      expect(scene.markers.map(marker => marker.style.label)).toEqual(['发云界', '金顶'])
      expect(scene.markers.every(marker => marker.alpha === 1)).toBe(true)
    }
  })
  it('fingerprints the real coordinates, breaks, edits, grouping and hidden states but no map key settings', () => {
    const input = track(), initial = createGeoMotionProject(input, points).sourceFingerprint
    expect(createGeoMotionProject(structuredClone(input), structuredClone(points)).sourceFingerprint).toBe(initial)
    input.segmentStarts = [0]
    expect(createGeoMotionProject(input, points).sourceFingerprint).not.toBe(initial)
    const edited = structuredClone(points); edited[0].name = '我编辑的发云界'
    expect(createGeoMotionProject(track(), edited).sourceFingerprint).not.toBe(initial)
    edited[0].name = points[0].name; edited[0].hidden = true
    expect(createGeoMotionProject(track(), edited).sourceFingerprint).not.toBe(initial)
    const withKey = Object.assign(track(), {mapTilerKey: 'private-key-not-source'})
    expect(createGeoMotionProject(withKey, points).sourceFingerprint).toBe(initial)
    expect(JSON.stringify(createGeoMotionProject(withKey, points).document)).not.toContain('private-key')
  })
})

describe('GeoMotion editable camera tracks', () => {
  it('inserts, retimes and removes keys immutably, retaining at least one key', () => {
    const document = built(), before = JSON.stringify(document)
    const key = geoNewKey(5, {center: [114.2, 27.6], zoom: 12, bearing: 30, pitch: 45})
    const edited = geoSetCameraKey(document, key)
    expect(geoCameraKeys(edited).map(row => row.t)).toEqual([0, 5, 15, 20])
    expect(geoEvaluate(edited, 5).camera.center).toEqual([114.2, 27.6])
    const moved = geoSetCameraKey(edited, {...key, t: 9})
    expect(geoCameraKeys(moved).map(row => row.t)).toEqual([0, 9, 15, 20])
    let last = moved
    for (const row of geoCameraKeys(moved)) last = geoRemoveCameraKey(last, row.id)
    expect(geoCameraKeys(last)).toHaveLength(1)
    expect(geoRemoveCameraKey(last, geoCameraKeys(last)[0].id)).toBe(last)
    expect(JSON.stringify(document)).toBe(before)
  })

  it('uses one camera key at each timestamp when editing a key onto an occupied time', () => {
    const document = built(), first = geoCameraKeys(document)[0], last = geoCameraKeys(document)[2]
    const replaced = geoSetCameraKey(document, {...last, t: first.t, zoom: 10})
    expect(geoCameraKeys(replaced).map(row => row.t)).toEqual([0, 15])
    expect(geoEvaluate(replaced, 0).camera.zoom).toBe(10)
  })

  it('evaluates random and reverse seeks deterministically without changing the engineering document', () => {
    const document = built(), serialized = JSON.stringify(document), reference = geoEvaluate(document, 7.123)
    for (const t of [19, 4, 0, 12.5, 1, 20, 7.123]) geoEvaluate(document, t)
    expect(geoEvaluate(document, 7.123)).toEqual(reference)
    expect(geoEvaluate(document, NaN)).toEqual(geoEvaluate(document, 0))
    expect(geoEvaluate(document, Infinity)).toEqual(geoEvaluate(document, 20))
    expect(JSON.stringify(document)).toBe(serialized)
  })

  it('resizes duration proportionally while preserving route reveal, label timing, and manually edited cameras', () => {
    const document = geoSetCameraKey(built(), geoNewKey(5, {center: [114.2, 27.6], zoom: 12, bearing: 30, pitch: 45}))
    const next = geoResizeDuration(document, 40)
    expect(geoCameraKeys(next).map(row => row.t)).toEqual([0, 10, 30, 40])
    expect(geoEvaluate(next, 10).camera).toEqual(geoEvaluate(document, 5).camera)
    expect(geoEvaluate(next, 12).routes.map(route => route.progress)).toEqual(geoEvaluate(document, 6).routes.map(route => route.progress))
    expect(Object.values(next.nodes).filter(node => node.type === 'marker').every(node => node.out === 40)).toBe(true)
    expect(document.duration).toBe(20)
    expect(() => geoResizeDuration(document, 0)).toThrow('时长')
  })
})

describe('GeoMotion project files', () => {
  it('migrates format-6 files and sorts unsorted camera channel keys without mutating the imported document', () => {
    const document = built(), all = Object.values(document.nodes)
    const {nodes: _nodes, ...fields} = document
    const legacy = {...fields, format: 6, cameras: all.filter(node => node.type === 'camera'), layers: all.filter(node => node.type !== 'camera')}
    const migrated = geoParseProject(legacy)
    expect(migrated.format).toBe(7)
    expect(geoCameraKeys(migrated).map(key => key.t)).toEqual([0, 15, 20])
    expect(Object.values(migrated.nodes).filter(node => node.type === 'route').map(route => route.coords)).toEqual(all.filter(node => node.type === 'route').map(route => route.coords))
    const unordered = structuredClone(document), camera = Object.values(unordered.nodes).find(node => node.type === 'camera')!
    for (const property of Object.values(camera.tracks)) if (property.kind === 'keyframed') property.keys.reverse()
    const original = JSON.stringify(unordered), sorted = geoParseProject(unordered)
    expect(geoCameraKeys(sorted).map(key => key.t)).toEqual([0, 15, 20])
    expect(JSON.stringify(unordered)).toBe(original)
    expect(geoEvaluate(sorted, 7.5).camera).toEqual(geoEvaluate(document, 7.5).camera)
  })
  it('round-trips standalone format-7 files as detached objects and validates imports with Chinese diagnostics', () => {
    const document = built(), parsed = geoParseProject(JSON.stringify(document))
    expect(parsed).toEqual(document)
    expect(parsed).not.toBe(document)
    const first = geoCameraKeys(parsed)[0]; first.center[0] = 10
    expect(geoCameraKeys(parsed)[0].center[0]).not.toBe(10)
    expect(() => geoParseProject('{bad json')).toThrow('动画工程')
    expect(() => geoParseProject({})).toThrow('格式无效')
    expect(() => geoParseProject({...document, format: 99})).toThrow('格式无效')
    expect(() => geoParseProject({...document, duration: NaN})).toThrow('无效数值')
    expect(() => geoParseProject({...document, height: 1072.5})).toThrow('尺寸无效')
    expect(() => geoParseProject({...document, nodes: {}})).toThrow('缺少相机')
    const malformed = structuredClone(document), marker = Object.values(malformed.nodes).find(node => node.type === 'marker')!
    marker.out = 100
    expect(() => geoParseProject(malformed)).toThrow('图层时间')
    expect(() => geoParseProject('{"format":7,"__proto__":{"polluted":true}}')).toThrow('无效字段')
  })
})
