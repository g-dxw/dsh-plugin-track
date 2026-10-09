import { describe, expect, it } from 'vitest'
import { connectPoints, deletePoint, editedMetrics, insertPoint, joinPoints, movePoint, reversePoints, splitPoints } from '../src/track/edit.ts'
import { pointMetrics } from '../src/track/metrics.ts'
import { METRICS_VERSION, type TrackPoint } from '../src/protocol.ts'

const T0 = Date.parse('2026-10-01T01:00:00Z')
const POINTS: TrackPoint[] = [[120, 30, 100, T0], [120.01, 30, 120, T0 + 1000], [120.02, 30, 110, T0 + 2000], [120.03, 30, 150, T0 + 3000]]
const FROZEN: readonly TrackPoint[] = Object.freeze(POINTS.map(point => Object.freeze([...point]) as unknown as TrackPoint))

function drawn(lon: number, lat: number): TrackPoint { return [lon, lat, null, null] }

describe('immutable point edits', () => {
  it('moves a point without mutating the stored tuples, clearing location-bound metadata', () => {
    const moved = movePoint(FROZEN, 1, 120.005, 30.01)
    expect(moved).not.toBe(FROZEN)
    expect(moved[1]).toEqual(drawn(120.005, 30.01))
    expect(moved[0]).toBe(FROZEN[0])
    expect(FROZEN).toEqual(POINTS)
  })

  it('inserts new unknown-elevation/time points before, between, and after recorded points', () => {
    expect(insertPoint(FROZEN, 0, 119.99, 30)).toEqual([drawn(119.99, 30), ...POINTS])
    expect(insertPoint(FROZEN, 2, 120.015, 30.01)).toEqual([POINTS[0], POINTS[1], drawn(120.015, 30.01), POINTS[2], POINTS[3]])
    expect(insertPoint(FROZEN, POINTS.length, 120.04, 30)).toEqual([...POINTS, drawn(120.04, 30)])
    expect(insertPoint([], 0, 120, 30)).toEqual([drawn(120, 30)])
    expect(FROZEN).toEqual(POINTS)
  })

  it('deletes a point with its metadata and permits an empty unsaved draft', () => {
    expect(deletePoint(FROZEN, 1)).toEqual([POINTS[0], POINTS[2], POINTS[3]])
    expect(deletePoint([POINTS[0]], 0)).toEqual([])
    expect(FROZEN).toEqual(POINTS)
  })

  it('reverses order while retaining every recorded elevation and timestamp', () => {
    expect(reversePoints(FROZEN)).toEqual([POINTS[3], POINTS[2], POINTS[1], POINTS[0]])
    expect(reversePoints(reversePoints(FROZEN))).toEqual(POINTS)
    expect(reversePoints([])).toEqual([])
    expect(FROZEN).toEqual(POINTS)
  })

  it.each([-1, 4, 0.5, Number.NaN])('rejects invalid point index %s before changing anything', index => {
    expect(() => movePoint(FROZEN, index, 120, 30)).toThrow('轨迹点位置无效')
    expect(() => deletePoint(FROZEN, index)).toThrow('轨迹点位置无效')
    expect(FROZEN).toEqual(POINTS)
  })

  it.each([-1, 5, 0.5, Number.NaN])('rejects invalid insertion position %s', index => {
    expect(() => insertPoint(FROZEN, index, 120, 30)).toThrow('插入位置无效')
  })

  it.each([[181, 30], [-181, 30], [120, 91], [120, -91], [Number.NaN, 30], [120, Number.POSITIVE_INFINITY]])('refuses malformed drawn coordinates %s %s', (lon, lat) => {
    expect(() => movePoint(FROZEN, 0, lon, lat)).toThrow('轨迹坐标无效')
    expect(() => insertPoint(FROZEN, 0, lon, lat)).toThrow('轨迹坐标无效')
  })
})

describe('splitting and joining', () => {
  it('shares the selected internal location and metadata between two valid results', () => {
    const [first, second] = splitPoints(FROZEN, 1)
    expect(first).toEqual([POINTS[0], POINTS[1]])
    expect(second).toEqual([POINTS[1], POINTS[2], POINTS[3]])
    expect(first[1]).not.toBe(second[0])
    expect(first[1]).not.toBe(FROZEN[1])
    expect(joinPoints([first, second])).toEqual(POINTS)
    expect(FROZEN).toEqual(POINTS)
  })

  it.each([0, 3, -1, 4, 0.5])('does not split at an endpoint or invalid position %s', index => {
    expect(() => splitPoints(FROZEN, index)).toThrow('两段都至少需要 2 个点')
  })

  it('concatenates the explicit chosen order without choosing an orientation or routing', () => {
    expect(joinPoints([[POINTS[2], POINTS[3]], [POINTS[0], POINTS[1]]])).toEqual([POINTS[2], POINTS[3], POINTS[0], POINTS[1]])
    expect(joinPoints([[], [POINTS[0]], [], [POINTS[1]], []])).toEqual([POINTS[0], POINTS[1]])
    expect(joinPoints([])).toEqual([])
  })

  it('preserves overlapping coordinates when time or height differs and retains internal duplicates', () => {
    const sameLocationDifferentHeight: TrackPoint = [120.01, 30, 130, POINTS[1][3]]
    const sameLocationDifferentTime: TrackPoint = [120.01, 30, 120, T0 + 5000]
    expect(joinPoints([[POINTS[0], POINTS[1]], [sameLocationDifferentHeight, POINTS[2]]])).toHaveLength(4)
    expect(joinPoints([[POINTS[0], POINTS[1]], [sameLocationDifferentTime, POINTS[2]]])).toHaveLength(4)
    expect(joinPoints([[POINTS[0], POINTS[1], POINTS[1]], [POINTS[1], POINTS[2]]])).toEqual([POINTS[0], POINTS[1], POINTS[1], POINTS[2]])
  })

  it('joins a large flat track without variadic push/apply stack overflow', () => {
    const large = Array<TrackPoint>(160_000).fill(POINTS[0])
    expect(joinPoints([large, large])).toHaveLength(319_999)
  })
})

describe('manual connections', () => {
  it('keeps both endpoints and outside points while replacing the interior path', () => {
    expect(connectPoints(FROZEN, 0, 2)).toEqual([POINTS[0], POINTS[2], POINTS[3]])
    const via: TrackPoint[] = [[120.004, 30.004, 1900, T0 + 6000], [120.008, 30.006, -10, 0]]
    expect(connectPoints(FROZEN, 0, 2, via)).toEqual([POINTS[0], drawn(120.004, 30.004), drawn(120.008, 30.006), POINTS[2], POINTS[3]])
    expect(via[0]).toEqual([120.004, 30.004, 1900, T0 + 6000])
    expect(FROZEN).toEqual(POINTS)
  })

  it('can insert a manual bend between adjacent points without removing either', () => {
    expect(connectPoints(FROZEN, 1, 2, [drawn(120.015, 30.005)])).toEqual([POINTS[0], POINTS[1], drawn(120.015, 30.005), POINTS[2], POINTS[3]])
  })

  it('requires the selected endpoint to follow the starting point', () => {
    expect(() => connectPoints(FROZEN, 2, 1)).toThrow('连接终点必须在起点之后')
    expect(() => connectPoints(FROZEN, 1, 1)).toThrow('连接终点必须在起点之后')
    expect(() => connectPoints(FROZEN, 0, 4)).toThrow('轨迹点位置无效')
    expect(() => connectPoints(FROZEN, 0, 2, [[190, 30, null, null]])).toThrow('轨迹坐标无效')
  })
})

describe('metrics for edited copies', () => {
  it('matches recorded-track metrics when every elevation is known', () => {
    expect(editedMetrics(FROZEN)).toEqual({...pointMetrics(FROZEN), calculationVersion: METRICS_VERSION})
  })

  it('counts height changes within measured runs without inventing climbs through unknown heights', () => {
    const mixed: TrackPoint[] = [[120, 30, 100, T0], [120.01, 30, 120, T0 + 1000], [120.02, 30, null, null], [120.03, 30, 200, T0 + 2000], [120.04, 30, 190, T0 + 3000]]
    const metrics = editedMetrics(mixed)
    expect(metrics.elevationGain).toBe(20)
    expect(metrics.elevationLoss).toBe(10)
    expect(metrics.distance).toBe(pointMetrics(mixed).distance)
    expect(metrics.duration).toBe(3000)
    expect(metrics.elevationMin).toBe(100)
    expect(metrics.elevationMax).toBe(200)
    expect(metrics.bbox).toEqual([120, 30, 120.04, 30])
    expect(pointMetrics(mixed).elevationGain).toBe(metrics.elevationGain)
  })

  it('reports unknown ranges and no invented times for wholly drawn points', () => {
    expect(editedMetrics([drawn(120, 30), drawn(120.01, 30)])).toMatchObject({elevationGain: 0, elevationLoss: 0, elevationMin: null, elevationMax: null, duration: 0})
    expect(editedMetrics([])).toEqual({...pointMetrics([]), calculationVersion: METRICS_VERSION})
  })

  it('still treats measured sea level and negative elevation as actual values', () => {
    expect(editedMetrics([[120, 30, -10, null], [120.01, 30, 0, null], [120.02, 30, 20, null]])).toMatchObject({elevationGain: 30, elevationLoss: 0, elevationMin: -10, elevationMax: 20})
  })
})
