import {describe, expect, it} from 'vitest'
import type {PlacemarkGroup, TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import type {TrackAnnotation} from '../src/track/annotations.ts'
import {createGeoMotionProject, geoCameraKeys, geoEvaluate, geoNewKey, geoParseProject, geoResizeDuration, geoSetCameraKey} from '../src/track/geomotion.ts'
import {createGroup} from '../src/track/vendor/geomotion/document/index.ts'
import {extractVideoMaterials, geoProjectFromVideoMaterials, mergeVideoMaterialSegment, splitVideoMaterialSegment, validateVideoMaterials, videoMaterialSegmentMetrics, videoMaterialsFingerprint} from '../src/track/video-materials.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
function track(): TrackRecord {
  return {id: 'actual-track', name: '真实反穿路线', filename: 'actual.kml', format: 'kml', createdAt: '2026-10-04T00:00:00Z', bytes: 100, points: 7,
    coordinates: [[114.1, 27.5, 1000, 0], [114.101, 27.501, 1050, 60000], [114.102, 27.502, 1100, 120000], [114.103, 27.503, 1050, 180000], [115.1, 27.6, 800, 240000], [115.101, 27.601, 850, 300000], [115.102, 27.602, 900, 360000]], segmentStarts: [0, 4],
    metrics: {distance: 123456, elevationGain: 150, elevationLoss: 50, duration: 0, elevationMax: 1450, elevationMin: 1300, bbox: [114.1, 27.5, 115.102, 27.602]}}
}
const points: TrackPlacemark[] = [
  {id: 'a', name: '山脊点', coordinates: [114.1022, 27.5024], description: '来自 KML 的介绍', images: ['https://example.test/actual.jpg']},
  {id: 'b', name: '隐藏点', coordinates: [115.101, 27.601], description: '', images: [], hidden: true},
  {id: 'c', name: '后段终点', coordinates: [115.102, 27.602], description: '', images: []},
]
const annotations: TrackAnnotation[] = [{id: 'art-a', sourceId: 'a', pointIndex: 2, sourceCoordinates: [114.1022, 27.5024], label: '我确认的山脊', description: 'SVG 的视频介绍', color: '#0f766e', visible: false,
  position: {x: 1000, y: 1500}, photo: {dataUrl: PNG, x: 800, y: 200, sourceUrl: 'https://example.test/actual.jpg'}},
  {id: 'art-manual', pointIndex: 1, label: '沿路线补充', color: '#2563eb', kind: 'note', visible: true, position: {x: 600, y: 2000}}]

describe('geographic two-dimensional video material preparation', () => {
  it('extracts actual connected geometry and facts without connecting KML gaps or relying on stale totals', () => {
    const input = track(), before = JSON.stringify(input), doc = extractVideoMaterials(input, points)
    expect(doc.sourcePointCount).toBe(7)
    expect(doc.sourceSegmentStarts).toEqual([0, 4])
    expect(doc.segments.map(segment => [segment.startIndex, segment.endIndex])).toEqual([[0, 3], [4, 6]])
    expect(doc.markers.map(marker => [marker.sourceId, marker.selected])).toEqual([['a', true], ['b', false], ['c', true]])
    expect(doc.markers[0].coordinates).toEqual(points[0].coordinates)
    expect(doc.markers[0].photoCandidates).toEqual(['https://example.test/actual.jpg'])
    const actualDistance = doc.segments.reduce((sum, segment) => sum + videoMaterialSegmentMetrics(input, segment).distance, 0)
    expect(doc.information.find(item => item.id === 'info-distance')?.text).toBe(`${(actualDistance / 1000).toFixed(2)} 公里`)
    expect(actualDistance).toBeLessThan(1000)
    expect(doc.information.find(item => item.id === 'info-duration')?.text).toBe('0 小时 6 分钟')
    expect(doc.information.filter(item => item.selected).map(item => item.id)).toEqual(['info-title'])
    expect(JSON.stringify(input)).toBe(before)
    expect(JSON.stringify(doc)).not.toContain('coordinates":[[114.1')
  })
  it('takes saved SVG choices first, preserving geographic anchors, photos and hidden states instead of artwork pixels', () => {
    const source = JSON.stringify(annotations), doc = extractVideoMaterials(track(), points, [], annotations, true)
    expect(doc.markers).toHaveLength(4)
    expect(doc.markers[0]).toMatchObject({name: '我确认的山脊', sourceId: 'a', pointIndex: 2, coordinates: [114.1022, 27.5024], selected: false, color: '#0f766e', description: 'SVG 的视频介绍', photo: {dataUrl: PNG}})
    expect(doc.markers[1]).toMatchObject({name: '沿路线补充', pointIndex: 1, coordinates: [114.101, 27.501], selected: true})
    expect(doc.markers.some(marker => marker.name === '山脊点')).toBe(false)
    expect(doc.markers.some(marker => marker.coordinates[0] === 1000 || marker.coordinates[1] === 2000)).toBe(false)
    expect(JSON.stringify(annotations)).toBe(source)
    const unsaved = extractVideoMaterials(track(), points, [], annotations, false)
    expect(unsaved.markers.map(marker => marker.name)).toEqual(points.map(point => point.name))
  })
  it('uses effective groups and actual cover candidates while suppressing grouped leaves', () => {
    const group: PlacemarkGroup = {id: 'group-real', name: '营地组', description: '原始分组说明', memberIds: ['a', 'c'], coordinates: [115.102, 27.602], cover: {pointId: 'a', imageUrl: points[0].images[0]}}
    const doc = extractVideoMaterials(track(), points, [group])
    expect(doc.markers.map(marker => marker.name)).toEqual(['营地组', '隐藏点'])
    expect(doc.markers[0]).toMatchObject({coordinates: group.coordinates, pointIndex: 6, photoCandidates: [points[0].images[0]], selected: true})
    group.hidden = true
    expect(extractVideoMaterials(track(), points, [group]).markers[0].selected).toBe(false)
  })
  it('splits on a shared real point and merges only that original run immutably', () => {
    const doc = extractVideoMaterials(track(), points), before = JSON.stringify(doc), first = doc.segments[0]
    const split = splitVideoMaterialSegment(doc, first.id, 2)
    expect(split.segments.map(segment => [segment.startIndex, segment.endIndex])).toEqual([[0, 2], [2, 3], [4, 6]])
    expect(mergeVideoMaterialSegment(split, first.id).segments).toEqual(doc.segments)
    expect(() => splitVideoMaterialSegment(doc, first.id, 3)).toThrow('内部')
    expect(() => mergeVideoMaterialSegment(doc, first.id)).toThrow('断点')
    expect(() => videoMaterialSegmentMetrics(track(), {...first, endIndex: 4})).toThrow('断点')
    expect(JSON.stringify(doc)).toBe(before)
  })
  it('fingerprints relevant source edits and persisted SVG choices but excludes arbitrary settings and unsaved artwork', () => {
    const input = track(), baseline = videoMaterialsFingerprint(input, points)
    expect(videoMaterialsFingerprint(structuredClone(input), structuredClone(points))).toBe(baseline)
    expect(videoMaterialsFingerprint(Object.assign(track(), {mapTilerKey: 'private-token'}), points)).toBe(baseline)
    expect(videoMaterialsFingerprint(track(), points, [], annotations, false)).toBe(baseline)
    expect(videoMaterialsFingerprint(track(), points, [], annotations, true)).not.toBe(baseline)
    input.coordinates[1][2] = 900
    expect(videoMaterialsFingerprint(input, points)).not.toBe(baseline)
    input.coordinates = track().coordinates; input.segmentStarts = [0]
    expect(videoMaterialsFingerprint(input, points)).not.toBe(baseline)
    const edited = structuredClone(points); edited[0].hidden = true
    expect(videoMaterialsFingerprint(track(), edited)).not.toBe(baseline)
  })
  it('builds only confirmed exact source slices, selected marker/photo pairs and chronological introduction overlays', () => {
    const input = track(), doc = splitVideoMaterialSegment(extractVideoMaterials(input, points, [], annotations, true), 'segment-0', 2)
    doc.markers[0].selected = true
    doc.markers[1].photo = {dataUrl: PNG}
    doc.markers[2].selected = false
    doc.markers[3].selected = false
    doc.segments[2].selected = false
    doc.segments[0].description = '第一段真实介绍'; doc.segments[1].description = '第二段真实介绍'
    doc.information.find(item => item.id === 'info-distance')!.selected = true
    const before = JSON.stringify({input, doc}), project = geoProjectFromVideoMaterials(input, doc), nodes = Object.values(project.nodes)
    const routes = nodes.filter(node => node.type === 'route'), markers = nodes.filter(node => node.type === 'marker'), images = nodes.filter(node => node.type === 'image'), sections = nodes.filter(node => node.type === 'text').filter(node => node.id.startsWith('material-section'))
    expect(routes.map(route => route.coords)).toEqual([input.coordinates.slice(0, 3).map(point => point.slice(0, 2)), input.coordinates.slice(2, 4).map(point => point.slice(0, 2))])
    expect(markers.map(marker => marker.coord)).toEqual([[114.101, 27.501], [114.1022, 27.5024]])
    expect(images).toHaveLength(2)
    expect(images[0].caption).toBe('沿路线补充'); expect(images[1].caption).toBe('我确认的山脊')
    expect(images[0].out).toBeLessThanOrEqual(images[1].in)
    expect(sections[0].out).toBeLessThanOrEqual(sections[1].in)
    const visibleImages = (time: number) => geoEvaluate(project, time).images.filter(image => image.alpha > 0).length
    expect(visibleImages((images[0].in + images[0].out) / 2)).toBe(1)
    expect(visibleImages((images[1].in + images[1].out) / 2)).toBe(1)
    expect(visibleImages(0)).toBe(0)
    expect(nodes.find(node => node.type === 'text' && node.id === 'material-information')).toMatchObject({text: expect.stringContaining('路线长度：'), y: .04})
    expect(geoParseProject(JSON.stringify(project)).format).toBe(7)
    expect(JSON.stringify({input, doc})).toBe(before)
  })
  it('preserves authored camera shots and output settings while replacing only the material draft', () => {
    const input = track(), doc = extractVideoMaterials(input, points)
    let previous = geoResizeDuration(createGeoMotionProject(input, points).document, 8)
    previous = geoSetCameraKey(previous, geoNewKey(3, {center: [114.102, 27.502], zoom: 14.5, pitch: 50, bearing: 72}))
    previous = {...structuredClone(previous), fps: 24, width: 1920, height: 1080, terrain: false, terrainExaggeration: 1.8, basemap: 'author-map', background: '#102030'}
    const group = createGroup('相机分组'), camera = Object.values(previous.nodes).find(node => node.type === 'camera')!
    previous.nodes[group.id] = group; camera.parentId = group.id
    const before = JSON.stringify(previous), shots = geoCameraKeys(previous), next = geoProjectFromVideoMaterials(input, doc, previous)
    expect(next).toMatchObject({duration: 8, fps: 24, width: 1920, height: 1080, terrain: false, terrainExaggeration: 1.8, basemap: 'author-map', background: '#102030'})
    expect(geoCameraKeys(next)).toEqual(shots)
    expect(geoEvaluate(next, 3).camera).toEqual(geoEvaluate(previous, 3).camera)
    expect(Object.values(next.nodes).filter(node => node.type === 'camera').every(node => node.parentId === null)).toBe(true)
    expect(Object.values(next.nodes).some(node => node.id === group.id)).toBe(false)
    expect(Object.values(next.nodes).filter(node => node.type === 'route').every(node => node.out === 8 && node.id.startsWith('material-route-'))).toBe(true)
    expect(Object.values(previous.nodes).filter(node => node.type === 'route').some(route => next.nodes[route.id])).toBe(false)
    expect(JSON.stringify(previous)).toBe(before)
    expect(geoParseProject(JSON.stringify(next)).format).toBe(7)
  })
  it('keeps selected point descriptions in the same actual route slot as their image and excludes hidden descriptions', () => {
    const input = track(), doc = extractVideoMaterials(input, points, [], annotations, true)
    doc.markers[0].selected = true; doc.markers[1].photo = {dataUrl: PNG}; doc.markers[1].description = '路线内第一处说明'
    doc.markers[2].description = '隐藏点不可显示'
    const project = geoProjectFromVideoMaterials(input, doc), nodes = Object.values(project.nodes), images = nodes.filter(node => node.type === 'image')
    for (const image of images) {
      const text = nodes.find(node => node.type === 'text' && node.id === image.id.replace('material-photo-', 'material-point-'))
      expect(text).toMatchObject({in: image.in, out: image.out, y: .32})
      expect(geoEvaluate(project, (image.in + image.out) / 2).texts.some(item => item.alpha > 0 && item.style.text.includes(image.caption))).toBe(true)
    }
    expect(nodes.filter(node => node.type === 'text').some(node => node.text.includes('隐藏点不可显示'))).toBe(false)
    const firstRoute = nodes.find(node => node.type === 'route')!
    expect(images.every(image => image.in >= 20 * .16 && image.out <= 20 * .16 + 20 * .68 * videoMaterialSegmentMetrics(input, doc.segments[0]).distance / doc.segments.reduce((sum, part) => sum + videoMaterialSegmentMetrics(input, part).distance, 0))).toBe(true)
    expect(firstRoute.coords).toHaveLength(4)
  })
  it('rejects mismatched source geometry and keeps deselected materials out of the animation', () => {
    const input = track(), doc = extractVideoMaterials(input, points)
    doc.markers.forEach(marker => marker.selected = false); doc.segments.forEach(segment => segment.selected = false); doc.information.forEach(item => item.selected = false)
    expect(Object.values(geoProjectFromVideoMaterials(input, doc).nodes).map(node => node.type)).toEqual(['camera'])
    expect(() => geoProjectFromVideoMaterials({...input, id: 'other'}, doc)).toThrow('不匹配')
    expect(() => geoProjectFromVideoMaterials({...input, segmentStarts: [0]}, doc)).toThrow('不匹配')
    expect(() => geoProjectFromVideoMaterials({...input, coordinates: input.coordinates.slice(1)}, doc)).toThrow('不匹配')
  })
  it('validates allowed fields, bounds, IDs, colours, stable references, images and independent returned arrays', () => {
    const doc = extractVideoMaterials(track(), points)
    expect(() => validateVideoMaterials({...doc, coordinates: track().coordinates})).toThrow('字段')
    expect(() => validateVideoMaterials({...doc, sourcePointCount: 500001})).toThrow('点数')
    expect(() => validateVideoMaterials({...doc, sourceSegmentStarts: [0, 4, 3]})).toThrow('顺序')
    expect(() => validateVideoMaterials({...doc, sourceFingerprint: 'anything'})).toThrow('来源')
    const mutate = (change: (next: typeof doc) => void) => {const next = structuredClone(doc); change(next); return () => validateVideoMaterials(next)}
    expect(mutate(next => next.markers[0].coordinates = [1000, 999])).toThrow('地理坐标')
    expect(mutate(next => next.markers[0].pointIndex = 7)).toThrow('序号')
    expect(mutate(next => next.markers[0].color = 'red')).toThrow('颜色')
    expect(mutate(next => next.markers[1].id = next.markers[0].id)).toThrow('重复')
    expect(mutate(next => next.markers[0].name = '\u0000bad')).toThrow('文字')
    expect(mutate(next => next.markers[0].photoCandidates = ['blob:unsafe'])).toThrow('图片引用')
    expect(mutate(next => next.markers[0].photo = {dataUrl: 'data:image/svg+xml;base64,PHN2Zz4='})).toThrow('照片')
    expect(mutate(next => next.markers[0].photo = {dataUrl: 'data:image/png;base64,YmFk'})).toThrow('照片数据')
    expect(mutate(next => next.segments[0].endIndex = 4)).toThrow('断点')
    expect(mutate(next => next.markers = Array.from({length: 101}, (_, i) => ({...next.markers[0], id: `new-${i}`})))).toThrow('最多')
    const result = validateVideoMaterials(doc); result.markers[0].coordinates[0] = 1; result.markers[0].photoCandidates.push('https://example.test/b.jpg'); result.sourceSegmentStarts.push(6)
    expect(doc.markers[0].coordinates[0]).toBe(points[0].coordinates[0]); expect(doc.markers[0].photoCandidates).toHaveLength(1); expect(doc.sourceSegmentStarts).toEqual([0, 4])
  })
  it('keeps unavailable height/time facts absent and supports dateline anchors with the nearest route index', () => {
    const input = track(); input.coordinates = [[179.95, 20, null, null], [-179.95, 20.01, null, null], [-179.9, 20.02, null, null]]; input.segmentStarts = [0]
    const mark: TrackPlacemark = {id: 'dateline', name: '跨日界线点', description: '', images: [], coordinates: [-179.96, 20.01]}
    const doc = extractVideoMaterials(input, [mark])
    expect(doc.markers[0].pointIndex).toBe(1)
    expect(doc.information.map(item => item.id)).toEqual(['info-title', 'info-distance'])
    expect(() => geoProjectFromVideoMaterials(input, doc)).not.toThrow()
  })
})
