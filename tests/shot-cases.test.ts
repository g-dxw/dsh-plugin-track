import { describe, expect, it } from 'vitest'
import type { TrackPoint, TrackRecord, TrackPlacemark } from '../src/protocol.ts'
import { editedMetrics } from '../src/track/edit.ts'
import { buildShotCasePlan, sampleShotCase, SHOT_CASES, type ShotCaseParameters, type ShotCaseId } from '../src/track/shot-cases.ts'

const POINTS: TrackPoint[] = [[101, 31, 3000, 0], [101.01, 31, 3030, 60000], [101.02, 31.01, 3060, 120000], [101.03, 31.02, 3020, 180000]]
const parameters: ShotCaseParameters = {duration: 10, detailZoom: 3, pitch: 35, bearing: 20, pointIndex: 0, startIndex: 0, endIndex: 2, caption: '人工示例文字'}
function track(points: TrackPoint[] = POINTS, overrides: Partial<TrackRecord> = {}): TrackRecord {
  return {id: 'case-route', name: '案例路线', filename: 'case.kml', format: 'kml', createdAt: '2026-10-02T00:00:00Z', bytes: 100,
    points: points.length, metrics: editedMetrics(points), coordinates: structuredClone(points), ...overrides}
}
function plan(id: ShotCaseId, changes: Partial<ShotCaseParameters> = {}, source = track(), markers?: TrackPlacemark[]) {
  return buildShotCasePlan(source, id, {...parameters, ...changes}, markers)
}

describe('editable scene case plans', () => {
  it('offers six atomic shots and three narrative examples, with exact total duration', () => {
    expect(SHOT_CASES.filter(item => item.category === 'shot')).toHaveLength(6)
    expect(SHOT_CASES.filter(item => item.category === 'narrative')).toHaveLength(3)
    for (const example of SHOT_CASES) {
      const built = plan(example.id, {duration: 11.3})
      expect(built.steps.map(step => step.label)).toEqual([...example.sequence])
      expect(built.steps.reduce((sum, step) => sum + step.duration, 0)).toBeCloseTo(11.3, 10)
      expect(sampleShotCase(built, 1).stepLabel).toBe(example.sequence.at(-1))
    }
  })

  it('produces real intermediate push and pull camera frames while keeping route time paused', () => {
    const incoming = plan('zoom-in'), outgoing = plan('zoom-out')
    const opening = sampleShotCase(incoming, 0), middle = sampleShotCase(incoming, .6), ending = sampleShotCase(incoming, 1)
    expect(opening.camera.zoomOffset).toBe(0)
    expect(middle.camera.zoomOffset).toBeCloseTo(1.5)
    expect(ending.camera.zoomOffset).toBe(3)
    expect(middle.camera.center).not.toEqual(opening.camera.center)
    expect(middle.camera.center).not.toEqual(ending.camera.center)
    expect(ending.camera.center).toEqual([101, 31])
    const pulled = sampleShotCase(outgoing, .6)
    expect(pulled.camera.zoomOffset).toBeCloseTo(1.5)
    expect(sampleShotCase(outgoing, 1).camera.center).toEqual(outgoing.overviewCenter)
    for (const frame of [opening, middle, ending, pulled]) {expect(frame.routeProgress).toBe(0); expect(frame.walkedLines).toEqual([]); expect(frame.position).toBeNull()}
  })

  it('holds an independently located placemark without snapping it onto the route', () => {
    const marker: TrackPlacemark = {id: 'peak', name: '用户标注山头', coordinates: [101.3, 31.2], description: '', images: []}
    const built = plan('point-hold', {placemarkId: 'peak'}, track(), [marker])
    expect(built.selectedTarget).toEqual({coordinates: [101.3, 31.2], label: '用户标注山头'})
    expect(built.bounds[2]).toBe(101.3)
    expect(sampleShotCase(built, 0).camera).toEqual(sampleShotCase(built, .7).camera)
    expect(sampleShotCase(built, .7).camera.center).toEqual([101.3, 31.2])
    expect(sampleShotCase(built, 1).routeProgress).toBe(0)
    expect(() => plan('point-hold', {placemarkId: 'peak'}, track(), [{...marker, hidden: true}])).toThrow('隐藏')
    expect(() => plan('point-hold', {placemarkId: 'absent'}, track(), [marker])).toThrow('不存在')
  })

  it('draws a distance-indexed route and moves the follow camera, with exact endpoints', () => {
    const drawn = plan('route-draw'), followed = plan('route-follow')
    expect(sampleShotCase(drawn, .15).routeProgress).toBe(0)
    const middle = sampleShotCase(drawn, .575)
    expect(middle.routeProgress).toBeCloseTo(.5)
    expect(middle.walkedLines[0].length).toBeGreaterThan(1)
    expect(middle.position).not.toEqual(POINTS[1].slice(0, 2))
    expect(sampleShotCase(drawn, 1).walkedLines).toEqual(drawn.fullLines)
    expect(sampleShotCase(followed, 0).camera.center).toEqual(POINTS[0].slice(0, 2))
    expect(sampleShotCase(followed, .575).camera.center).toEqual(sampleShotCase(followed, .575).position)
    expect(sampleShotCase(followed, 1).camera.center).toEqual(POINTS.at(-1)!.slice(0, 2))
  })

  it('shows a selected section before expanding the camera to the whole route', () => {
    const built = plan('section-to-route', {startIndex: 0, endIndex: 1})
    const close = sampleShotCase(built, .2), middle = sampleShotCase(built, .65), wide = sampleShotCase(built, 1)
    expect(close.camera.center).toEqual(built.sectionCenter)
    expect(middle.camera.center).not.toEqual(close.camera.center)
    expect(middle.camera.center).not.toEqual(wide.camera.center)
    expect(wide.camera.center).toEqual(built.overviewCenter)
    expect(wide.camera.zoomOffset).toBe(0)
    expect(close.walkedLines).toEqual([[POINTS[0].slice(0, 2), POINTS[1].slice(0, 2)]])
    expect(close.routeProgress).toBe(0)
  })

  it('respects narrative stage boundaries and exposes route facts only as recorded metadata', () => {
    const intro = plan('route-intro')
    expect(sampleShotCase(intro, .299).stepLabel).toBe('起点展示')
    expect(sampleShotCase(intro, .3).stepLabel).toBe('终点展示')
    expect(sampleShotCase(intro, .3).camera.center).toEqual(POINTS[0].slice(0, 2))
    expect(sampleShotCase(intro, .599).camera.center[0]).toBeCloseTo(POINTS.at(-1)![0], 4)
    expect(sampleShotCase(intro, .6).stepLabel).toBe('全景信息')
    expect(sampleShotCase(intro, .6).camera.center).toEqual(POINTS.at(-1)!.slice(0, 2))
    const final = sampleShotCase(intro, 1)
    expect(final.camera.center).toEqual(intro.overviewCenter)
    expect(final.caption).toContain('距离')
    expect(final.caption).toContain('累计上升')
    expect(final.caption).toContain('记录跨度')
    expect(final.caption).toContain('难度待补充')
    const story = plan('story-opening')
    expect(sampleShotCase(story, .1).caption).toBe('人工示例文字')
    expect(sampleShotCase(story, .25).stepLabel).toBe('位置建立')
    expect(sampleShotCase(story, .6).stepLabel).toBe('路线呈现')
    expect(sampleShotCase(story, .5).routeProgress).toBe(0)
    expect(sampleShotCase(story, .8).routeProgress).toBeCloseTo(.5)
    expect(sampleShotCase(story, 1).routeProgress).toBe(1)
    const local = plan('local-opening')
    expect(sampleShotCase(local, .4).caption).toBe('轨迹点 1')
    expect(sampleShotCase(local, .8).camera.center).not.toEqual(sampleShotCase(local, 0).camera.center)
    expect(sampleShotCase(local, 1).routeProgress).toBe(0)
  })

  it('keeps disjoint segments and invalid coordinates disconnected while retaining source indices', () => {
    const points: TrackPoint[] = [[101, 31, 100, 0], [101.01, 31, 110, 1000], [105, 31, 3000, 2000], [105.01, 31, 3010, 3000]]
    const source = track(points, {segmentStarts: [0, 2]})
    const built = plan('route-follow', {}, source)
    expect(built.fullLines).toHaveLength(2)
    const boundary = built.runs[0].distance / built.totalDistance
    const at = sampleShotCase(built, .15 + .85 * boundary)
    expect(at.position![0]).toBeCloseTo(105, 8)
    expect(at.walkedLines).toHaveLength(2)
    expect(at.walkedLines[0].at(-1)).toEqual([101.01, 31])
    expect(at.walkedLines[1][0]).toEqual([105, 31])
    expect(() => plan('section-to-route', {startIndex: 1, endIndex: 2}, source)).toThrow('连续段')
    expect(plan('point-hold', {pointIndex: 2}, source).selectedTarget!.coordinates).toEqual([105, 31])
    const invalid = track([[101, 31, null, null], [Number.NaN, 31, null, null], [105, 31, null, null], [105.01, 31, null, null]])
    expect(plan('route-draw', {}, invalid).fullLines).toHaveLength(2)
    expect(() => plan('point-hold', {pointIndex: 1}, invalid)).toThrow('无效')
    expect(() => plan('section-to-route', {startIndex: 0, endIndex: 2}, invalid)).toThrow('连续段')
  })

  it('unwraps the date line so route and camera interpolation take the short direction', () => {
    const source = track([[179, 20, null, null], [-179, 20, null, null]])
    const built = plan('route-follow', {}, source)
    expect(built.bounds[2] - built.bounds[0]).toBeCloseTo(2)
    expect(built.fullLines).toEqual([[[179, 20], [181, 20]]])
    expect(sampleShotCase(built, .575).camera.center[0]).toBeCloseTo(180)
    const selected = plan('zoom-in', {pointIndex: 1}, source)
    expect(selected.selectedTarget!.coordinates).toEqual([-179, 20])
    expect(sampleShotCase(selected, 1).camera.center).toEqual([181, 20])
    expect(sampleShotCase(selected, .6).camera.center[0]).toBeGreaterThan(180)
  })

  it('keeps overall route information before a long editable caption', () => {
    const caption = '人工补充文案。'.repeat(70)
    const built = plan('route-intro', {caption})
    const frame = sampleShotCase(built, .8)
    expect(frame.stepLabel).toBe('全景信息')
    expect(frame.caption.startsWith(built.information + '｜')).toBe(true)
    expect(frame.caption).toContain('距离')
    expect(frame.caption).toContain('累计上升')
    expect(frame.caption).toContain('记录跨度')
    expect(frame.caption).toContain('难度待补充')
    expect(frame.caption.endsWith(caption)).toBe(true)
  })
  it('rejects unknown cases and malformed parameters, and marks absent metadata as unknown', () => {
    expect(() => buildShotCasePlan(track(), 'unknown' as ShotCaseId, parameters)).toThrow('未知')
    for (const change of [{duration: 2}, {duration: 121}, {detailZoom: 7}, {pitch: 76}, {bearing: Number.NaN}, {pointIndex: -1}, {startIndex: .5}, {caption: 42}]) {
      expect(() => plan('point-hold', change as Partial<ShotCaseParameters>)).toThrow()
    }
    expect(() => plan('route-draw', {}, track([]))).toThrow('没有有效坐标')
    const missing = plan('route-intro', {}, track(POINTS.map(([lon, lat]) => [lon, lat, null, null])))
    expect(missing.summary.join()).toContain('时间跨度未知')
    expect(missing.summary.join()).toContain('文件海拔缺失')
    expect(missing.summary.join()).toContain('难度：待补充')
    expect(sampleShotCase(missing, 1).caption).toContain('累计上升 未知')
    expect(sampleShotCase(missing, 1).caption).toContain('记录跨度 未知')
    for (const progress of [-1, 2, Number.NaN, -Infinity, Infinity]) {
      const frame = sampleShotCase(missing, progress)
      expect(Number.isFinite(frame.camera.zoomOffset)).toBe(true)
      expect(frame.camera.center.every(Number.isFinite)).toBe(true)
    }
  })

  it('snapshots input parameters and geometry without mutating the track', () => {
    const source = track(), before = structuredClone(source), settings = {...parameters}
    const built = buildShotCasePlan(source, 'zoom-in', settings)
    settings.detailZoom = 6; source.coordinates[0][0] = 104
    expect(sampleShotCase(built, 1).camera.zoomOffset).toBe(3)
    expect(sampleShotCase(built, 1).camera.center).toEqual(before.coordinates[0].slice(0, 2))
    const original = track(); buildShotCasePlan(original, 'route-follow', parameters)
    expect(original).toEqual(before)
  })
})

