import { describe, expect, it } from 'vitest'
import type { TrackPoint, TrackRecord, TrackPlacemark } from '../src/protocol.ts'
import type { TrackAnnotation } from '../src/track/annotations.ts'
import { editedMetrics } from '../src/track/edit.ts'
import { analyzeVideoScript, createVideoScriptDraft, validateVideoScriptDraft, videoScriptMarkdown } from '../src/track/video-script.ts'

const POINTS: TrackPoint[] = [[101, 31, 3000, null], [101.001, 31, 3030, null], [101.002, 31, 3060, null], [101.003, 31, 3020, null], [101.004, 31, 2990, null]]
function track(points: TrackPoint[] = POINTS, overrides: Partial<TrackRecord> = {}): TrackRecord {
  return {id: 'sample', name: '测试路线', filename: 'route.kml', format: 'kml', createdAt: '2026-10-02T00:00:00Z',
    bytes: 100, points: points.length, metrics: editedMetrics(points), coordinates: structuredClone(points), ...overrides}
}
const point = (overrides: Partial<TrackPlacemark> = {}): TrackPlacemark => ({id: 'outside', name: '外侧山头', coordinates: [101.2, 31.1], description: '用户自己记录', images: ['https://example.test/private-photo.jpg'], ...overrides})

function sampleDraft() {
  const analysis = analyzeVideoScript(track())
  return {analysis, draft: createVideoScriptDraft(analysis, ['route-overview', 'high-point'])}
}

describe('local route film analysis', () => {
  it('recalculates current coordinates, preserves indices and never calls a sampled maximum a summit', () => {
    const input = track(POINTS, {metrics: {...editedMetrics(POINTS), distance: 999999, elevationMax: 8888}})
    const original = structuredClone(input)
    const analysis = analyzeVideoScript(input)
    expect(analysis.summary.join('\n')).not.toContain('999.99')
    expect(analysis.pointCount).toBe(5)
    const maximum = analysis.candidates.find(item => item.kind === 'high-point')!
    expect(maximum.title).toBe('最高采样点')
    expect(maximum.target).toMatchObject({pointIndex: 2, coordinates: [101.002, 31]})
    expect(maximum.draftNarration).toContain('3060')
    expect(maximum.draftNarration).not.toContain('山顶')
    expect(analysis.candidates.some(item => item.kind === 'climb-section' && item.readiness === 'ready')).toBe(true)
    expect(analysis.candidates.some(item => item.kind === 'descent-section' && item.readiness === 'ready')).toBe(true)
    expect(input).toEqual(original)
  })

  it('makes missing elevation, time, real terrain and surrounding peak evidence explicit', () => {
    const analysis = analyzeVideoScript(track(POINTS.map(([lon, lat]) => [lon, lat, null, null])))
    for (const kind of ['high-point', 'elevation-profile', 'climb-section', 'descent-section', 'recorded-stop', 'terrain-overview', 'surrounding-peaks', 'preparation']) {
      const candidate = analysis.candidates.find(item => item.kind === kind)!
      expect(candidate.readiness).toBe('needs-info')
      expect(candidate.missing.length).toBeGreaterThan(0)
    }
    expect(analysis.limitations.join('\n')).toContain('没有有效时间戳')
    expect(analysis.candidates.find(item => item.kind === 'route-overview')!.readiness).toBe('ready')
    expect(() => createVideoScriptDraft(analysis, ['high-point'])).toThrow('待补')
  })

  it('retains off-route placemark and source-annotation coordinates and exposes photo counts only', () => {
    const annotation: TrackAnnotation = {id: 'from-point', sourceId: 'outside', sourceCoordinates: [101.2, 31.1],
      pointIndex: 0, label: '山头', color: '#ff0000', imageUrls: ['https://example.test/private-photo.jpg']}
    const analysis = analyzeVideoScript(track(), [annotation], [point({description: '用户说明 <img src="https://example.test/private-photo.jpg"> 实际目标'}), point({id: 'hidden', hidden: true})])
    const marker = analysis.candidates.find(item => item.id === 'placemark-outside')!
    expect(marker.target).toEqual({placemarkId: 'outside', coordinates: [101.2, 31.1]})
    expect(marker.facts.join('\n')).toContain('关联照片 1 张')
    expect(analysis.candidates.find(item => item.id === 'annotation-from-point')!.target).toEqual({coordinates: [101.2, 31.1]})
    expect(analysis.candidates.some(item => item.id === 'placemark-hidden')).toBe(false)
    expect(JSON.stringify(analysis)).not.toContain('private-photo')
    const draft = createVideoScriptDraft(analysis, [marker.id])
    const invalid = structuredClone(draft); invalid.shots[0].target = {pointIndex: 0, coordinates: [101, 31]}
    expect(() => validateVideoScriptDraft(invalid, analysis)).toThrow('真实候选')
  })

  it('excludes source annotations belonging to hidden placemarks and rejects invalid point indices', () => {
    const analysis = analyzeVideoScript(track(), [
      {id: 'hidden-source', sourceId: 'hidden', sourceCoordinates: [101.2, 31.1], pointIndex: 0, label: '隐藏', color: '#ff0000'},
      {id: 'invalid', pointIndex: 999, label: '越界', color: '#ff0000'},
    ], [point({id: 'hidden', hidden: true})])
    expect(analysis.candidates.some(item => item.kind === 'annotation' || item.id === 'placemark-hidden')).toBe(false)
  })

  it('does not invent climbing, connecting distances or time stops across segment boundaries', () => {
    const points: TrackPoint[] = [[101, 31, 100, 0], [101, 31, 100, 150000], [101, 31, 1000, 300000], [101, 31, 1000, 450000]]
    const analysis = analyzeVideoScript(track(points, {segmentStarts: [0, 2]}))
    expect(analysis.summary.join('\n')).toContain('上升约 0 m')
    expect(analysis.candidates.some(item => item.kind === 'climb-section' && item.readiness === 'ready')).toBe(false)
    expect(analysis.candidates.some(item => item.kind === 'recorded-stop' && item.target)).toBe(false)
    expect(analysis.limitations.join('\n')).toContain('不跨断点')
    const disconnected = analyzeVideoScript(track([[101, 31, null, null], [105, 31, null, null]], {segmentStarts: [0, 1]}))
    expect(disconnected.summary.join('\n')).toContain('距离 0.00 km')
    expect(disconnected.candidates.find(item => item.id === 'route-progress')!.readiness).toBe('needs-info')
  })

  it('finds a recorded stationary interval while requiring confirmation of its actual meaning', () => {
    const analysis = analyzeVideoScript(track([[101, 31, 100, 0], [101, 31, 100, 150000], [101, 31, 100, 300000]]))
    const stop = analysis.candidates.find(item => item.id === 'recorded-stop-1')!
    expect(stop.target).toMatchObject({pointIndex: 0, endIndex: 2})
    expect(stop.facts[0]).toContain('5.0 分钟')
    expect(stop.readiness).toBe('needs-info')
    expect(stop.missing.join()).toContain('确认')
    expect(stop.draftNarration).toBe('')
    const broken = analyzeVideoScript(track([[101, 31, 100, 0], [101, 31, 100, 900000], [101, 31, 100, 1800000]]))
    expect(broken.candidates.some(item => item.id === 'recorded-stop-1')).toBe(false)
  })

  it('changes the fingerprint for coordinates, breaks, point edits, photos and annotations', () => {
    const originalTrack = track(), annotations: TrackAnnotation[] = [{id: 'note', pointIndex: 1, label: '标注', color: '#ff0000'}]
    const originalPoint = point()
    const base = analyzeVideoScript(originalTrack, annotations, [originalPoint]).fingerprint
    const changedCoordinates = track(); changedCoordinates.coordinates[0][0] += 0.00001
    expect(analyzeVideoScript(changedCoordinates, annotations, [originalPoint]).fingerprint).not.toBe(base)
    expect(analyzeVideoScript(track(POINTS, {segmentStarts: [0, 2]}), annotations, [originalPoint]).fingerprint).not.toBe(base)
    for (const edit of [{name: '新名字'}, {type: ['山峰']}, {description: '新说明'}, {images: ['https://example.test/other.jpg']}, {hidden: true}]) {
      expect(analyzeVideoScript(originalTrack, annotations, [point(edit)]).fingerprint).not.toBe(base)
    }
    expect(analyzeVideoScript(originalTrack, [{...annotations[0], label: '修改'}], [originalPoint]).fingerprint).not.toBe(base)
    expect(analyzeVideoScript(structuredClone(originalTrack), structuredClone(annotations), [structuredClone(originalPoint)]).fingerprint).toBe(base)
  })

  it('caps large candidate sets and does not fabricate route information for an empty file', () => {
    const markers = Array.from({length: 100}, (_, index) => point({id: `p-${index}`}))
    expect(analyzeVideoScript(track(), [], markers).candidates.length).toBe(48)
    const empty = analyzeVideoScript(track([]))
    expect(empty.candidates.find(item => item.id === 'route-overview')!.readiness).toBe('needs-info')
    expect(empty.candidates.some(item => item.id === 'start' || item.id === 'finish')).toBe(false)
    expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/u)
  })
})

describe('editable script cache boundary', () => {
  it('creates a single local unconfirmed shot and exports clear targets, evidence and missing data', () => {
    const analysis = analyzeVideoScript(track(), [], [point()])
    const draft = createVideoScriptDraft(analysis, ['placemark-outside'], '保留路线参照')
    expect(draft.shots).toHaveLength(1)
    expect(draft.shots[0].confirmed).toBe(false)
    const document = videoScriptMarkdown(draft, analysis)
    expect(document).toContain('独立点位 outside')
    expect(document).toContain('101.20000, 31.10000')
    expect(document).toContain('依据：')
    expect(document).toContain('待确认')
    expect(document).toContain('未采用的待补镜头')
    expect(document).not.toContain('private-photo')
  })

  it('rejects broken cache shapes, string confirmations, invalid targets, stale keys and unknown candidates', () => {
    const {draft, analysis} = sampleDraft()
    for (const invalid of [null, [], {}, {...draft, version: 2}, {...draft, shots: 'bad'}, {...draft, title: 1}, {...draft, notes: null}, {...draft, shots: [null]}]) {
      expect(() => validateVideoScriptDraft(invalid, analysis)).toThrow()
    }
    for (const changes of [{confirmed: 'false'}, {duration: 2}, {duration: 121}, {duration: Number.NaN}, {kind: 'made-up'}, {candidateId: 'unknown'}, {materials: [42]},
      {target: {coordinates: [181, 0]}}, {target: {endIndex: 1}}, {target: {pointIndex: -1}}, {target: {pointIndex: 500000}}, {target: {coordinates: [101, 31, 0]}}, {target: {placemarkId: 'p', pointIndex: 0}}, {target: {unexpected: true}}]) {
      const invalid = structuredClone(draft); Object.assign(invalid.shots[0], changes)
      expect(() => validateVideoScriptDraft(invalid, analysis)).toThrow()
    }
    expect(() => validateVideoScriptDraft({...draft, fingerprint: 'stale'}, analysis)).toThrow('已改变')
    expect(() => validateVideoScriptDraft({...draft, trackId: 'different'}, analysis)).toThrow('已改变')
    const wrongType = structuredClone(draft); wrongType.shots[0].kind = 'finish'
    expect(() => validateVideoScriptDraft(wrongType, analysis)).toThrow('类型不匹配')
    const wrongTarget = structuredClone(draft); wrongTarget.shots[1].target!.pointIndex = 0
    expect(() => validateVideoScriptDraft(wrongTarget, analysis)).toThrow('真实候选')
  })

  it('rejects pending candidates even if cache flags them confirmed, and bounds the whole draft', () => {
    const {draft, analysis} = sampleDraft()
    const pending = structuredClone(draft); pending.shots[0].candidateId = 'surrounding-peaks'; pending.shots[0].kind = 'surrounding-peaks'; pending.shots[0].confirmed = true
    expect(() => validateVideoScriptDraft(pending, analysis)).toThrow('待补')
    expect(() => createVideoScriptDraft(analysis, ['route-overview', 'route-overview'])).toThrow('不同镜头')
    expect(() => validateVideoScriptDraft({...draft, shots: Array.from({length: 25}, (_, index) => ({...draft.shots[0], id: `s${index}`, candidateId: `c${index}`}))})).toThrow('24')
    const long = {...draft, shots: Array.from({length: 16}, (_, index) => ({...draft.shots[0], id: `s${index}`, candidateId: `c${index}`, duration: 120}))}
    expect(() => validateVideoScriptDraft(long)).toThrow('1800')
  })
})

