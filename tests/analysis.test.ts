import { describe, expect, it } from 'vitest'
import { analyzeTrack, findRestCandidates } from '../src/track/analysis.ts'
import type { TrackPoint } from '../src/protocol.ts'

function fix(time: number | null, lon = 119, lat = 30): TrackPoint { return [lon, lat, null, time] }
function route(kilometers: number, gain: number | null = 0): TrackPoint[] { return [[0, 0, gain === null ? null : 0, null], [kilometers / 111.195, 0, gain, null]] }

 describe('conservative rest candidates', () => {
  it('requires at least five minutes, three actual samples, and reports original indexes', () => {
    const points = [fix(0, 118), fix(60_000), fix(210_000, 119.0001), fix(360_000, 118.9999), fix(420_000, 120)]
    expect(findRestCandidates(points)).toEqual([{startIndex: 1, endIndex: 3, duration: 300_000, lat: 30, lon: 119}])
    expect(findRestCandidates([fix(0), fix(150_000), fix(299_999)])).toEqual([])
    expect(findRestCandidates([fix(0), fix(300_000)])).toEqual([])
  })

  it('emits one candidate for an entire stationary cluster rather than overlapping windows', () => {
    const points = Array.from({length: 11}, (_, index) => fix(index * 60_000))
    expect(findRestCandidates(points)).toEqual([{startIndex: 0, endIndex: 10, duration: 600_000, lat: 30, lon: 119}])
  })

  it('does not treat a long missing sampling interval as a rest', () => {
    expect(findRestCandidates([fix(0), fix(1_800_000)])).toEqual([])
    expect(findRestCandidates([fix(0), fix(150_000), fix(450_001)])).toEqual([])
    expect(findRestCandidates([fix(0), fix(300_000), fix(600_000)])).toHaveLength(1)
  })

  it('does not bridge a long gap between two independently observed rests', () => {
    const points = [0, 150_000, 300_000, 900_001, 1_050_001, 1_200_001].map(time => fix(time))
    expect(findRestCandidates(points)).toEqual([
      {startIndex: 0, endIndex: 2, duration: 300_000, lat: 30, lon: 119},
      {startIndex: 3, endIndex: 5, duration: 300_000, lat: 30, lon: 119},
    ])
  })

  it('requires every sample to stay in the anchor radius, excluding out-and-back movement', () => {
    expect(findRestCandidates([fix(0), fix(150_000, 119.001), fix(300_000)])).toEqual([])
    expect(findRestCandidates([fix(0), fix(150_000, 119.0002), fix(300_000, 119.0004)])).toEqual([])
    expect(findRestCandidates([fix(0), fix(150_000, 119.0001), fix(300_000, 118.9999)])).toHaveLength(1)
  })

  it('breaks candidates at missing, non-finite, and invalid dates without inventing elapsed time', () => {
    for (const time of [null, Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      expect(findRestCandidates([fix(0), fix(150_000), fix(time), fix(300_000), fix(450_000)])).toEqual([])
    }
    expect(findRestCandidates([fix(null), fix(null), fix(null)])).toEqual([])
  })

  it('breaks candidates at equal or reversed timestamps', () => {
    expect(findRestCandidates([fix(0), fix(150_000), fix(150_000), fix(300_000)])).toEqual([])
    expect(findRestCandidates([fix(300_000), fix(150_000), fix(0)])).toEqual([])
  })

  it('breaks at invalid coordinates and accepts actual dateline and polar fixes', () => {
    expect(findRestCandidates([fix(0), fix(150_000), fix(200_000, Number.NaN), fix(300_000), fix(450_000)])).toEqual([])
    expect(findRestCandidates([fix(0, 181), fix(150_000, 181), fix(300_000, 181)])).toEqual([])
    expect(findRestCandidates([fix(0, 119, 91), fix(150_000, 119, 91), fix(300_000, 119, 91)])).toEqual([])
    expect(findRestCandidates([fix(0, 180, 0), fix(150_000, -179.9999, 0), fix(300_000, 180, 0)])).toHaveLength(1)
    expect(findRestCandidates([fix(0, 0, 90), fix(150_000, 90, 90), fix(300_000, 180, 90)])).toHaveLength(1)
  })

  it('caps the chronological, non-overlapping candidate list at fifty', () => {
    const points: TrackPoint[] = []
    for (let cluster = 0; cluster < 60; cluster++) {
      for (let sample = 0; sample < 3; sample++) points.push(fix((cluster * 3 + sample) * 150_000, 119 + cluster / 1000))
    }
    const candidates = findRestCandidates(points)
    expect(candidates).toHaveLength(50)
    expect(candidates[49]).toMatchObject({startIndex: 147, endIndex: 149})
    expect(candidates.every((candidate, index) => index === 0 || candidate.startIndex > candidates[index - 1].endIndex)).toBe(true)
  })

  it('keeps original arrays and all recorded metadata unchanged', () => {
    const points: TrackPoint[] = [fix(0), fix(150_000), fix(300_000)]
    const original = structuredClone(points)
    const frozen = Object.freeze(points.map(point => Object.freeze(point))) as unknown as readonly TrackPoint[]
    expect(analyzeTrack(frozen).restCandidates).toHaveLength(1)
    expect(points).toEqual(original)
    expect(findRestCandidates([])).toEqual([])
    expect(findRestCandidates([fix(0)])).toEqual([])
  })
})

describe('local hiking guidance with explicit limits', () => {
  it.each([[4, '轻量'], [8, '中等'], [15, '较费力'], [25, '高负荷']])('uses %s km as distance reference for %s', (kilometers, label) => {
    const report = analyzeTrack(route(kilometers as number))
    expect(report.guidance.difficulty).toContain(label)
    expect(report.guidance.difficulty).toContain('本地参考')
    expect(report.guidance.audience).toHaveLength(1)
  })

  it.each([[100, '轻量'], [300, '中等'], [800, '较费力'], [1300, '高负荷']])('uses continuous %s m climb as %s reference even for a short route', (gain, label) => {
    const report = analyzeTrack(route(1, gain as number))
    expect(report.metrics.elevationGain).toBe(gain)
    expect(report.guidance.difficulty).toContain(label)
  })

  it('makes missing elevation explicit rather than treating absence as a known flat route', () => {
    const report = analyzeTrack(route(8, null))
    expect(report.guidance.difficulty).toContain('仅按距离判断')
    expect(report.guidance.limitations.join('\n')).toContain('没有文件海拔')
    expect(report.guidance.limitations.join('\n')).toContain('没有时间戳')
    expect(report.restCandidates).toEqual([])
  })

  it('does not count a null elevation as sea level and reports partial coverage', () => {
    const report = analyzeTrack([[0, 0, 500, 0], [0.01, 0, null, null], [0.02, 0, 800, 300_000]])
    expect(report.metrics.elevationGain).toBe(0)
    expect(report.guidance.difficulty).toContain('海拔不完整')
    expect(report.guidance.limitations.join('\n')).toContain('可能低估实际爬升')
    expect(report.guidance.limitations.join('\n')).toContain('时间戳不完整')
  })

  it('states confirmation, activity, weather, fitness and facility limits without generating facilities', () => {
    const guidance = analyzeTrack(route(15)).guidance
    const limitations = guidance.limitations.join('\n')
    expect(limitations).toContain('需本人确认')
    expect(limitations).toContain('活动类型')
    expect(limitations).toContain('天气')
    expect(limitations).toContain('个人体能')
    expect(limitations).toContain('不能证明厕所')
    expect(guidance.equipment.join('\n')).toContain('离线')
    expect(guidance.equipment.join('\n')).toContain('不能预设沿途能补给')
    expect(guidance.equipment.join('\n')).toContain('照明')
  })

  it('warns that long or reversed time gaps are not evidence of a rest', () => {
    const report = analyzeTrack([fix(0), fix(1_800_000), fix(1_700_000)])
    expect(report.restCandidates).toEqual([])
    expect(report.guidance.limitations.join('\n')).toContain('不能把这些间隔当作停留证据')
  })

  it('declines a difficulty rating when meaningful movement is absent', () => {
    for (const points of [[], [fix(0)], [fix(0), fix(300_000)]]) {
      expect(analyzeTrack(points).guidance).toMatchObject({difficulty: '无法分级（有效行进数据不足）', audience: [], equipment: []})
    }
  })
})
