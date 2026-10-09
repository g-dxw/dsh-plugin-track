import {describe, expect, it} from 'vitest'
import {flattenGeoJSON} from '../src/track/geometry.ts'

const T0 = Date.parse('2026-05-29T06:48:22Z')
const TIMES = [0, 1, 2, 3].map(index => new Date(T0 + index * 60_000).toISOString())
const LINE = [[120, 30, 100], [120.01, 30, 110]]

function feature(geometry: unknown, times?: unknown, name = '') {
  return {type: 'Feature', geometry, properties: {name, coordinateProperties: {times}}}
}

function line(times?: unknown, name = '') {
  return feature({type: 'LineString', coordinates: LINE}, times, name)
}

function collection(...features: unknown[]) {
  return {type: 'FeatureCollection', features}
}

function timesOf(value: unknown) {
  return flattenGeoJSON(value).points.map(point => point[3])
}

describe('timestamps stay with their own feature', () => {
  it('does not give an untimed line the following feature timestamps', () => {
    expect(timesOf(collection(line(), line(TIMES.slice(0, 2))))).toEqual([null, null, T0, T0 + 60_000])
  })

  it('does not give a later untimed line the preceding feature timestamps', () => {
    expect(timesOf(collection(line(TIMES.slice(0, 2)), line()))).toEqual([T0, T0 + 60_000, null, null])
  })

  it('ignores timestamps belonging to Point features', () => {
    const point = feature({type: 'Point', coordinates: [119, 29]}, ['2020-01-01T00:00:00Z'])
    const result = flattenGeoJSON(collection(point, line(TIMES.slice(0, 2))))
    expect(result.points.map(point => point[3])).toEqual([T0, T0 + 60_000])
    expect(result.startedAt).toBe(T0)
    expect(result.endedAt).toBe(T0 + 60_000)
  })

  it('supports an individual Feature instead of only FeatureCollection', () => {
    expect(timesOf(line(TIMES.slice(0, 2)))).toEqual([T0, T0 + 60_000])
  })

  it('retains the first drawable feature name and explicit fallback name', () => {
    const source = collection(feature({type: 'Point', coordinates: [120, 30]}, undefined, '起点'), line(undefined, '路线'))
    expect(flattenGeoJSON(source).name).toBe('路线')
    expect(flattenGeoJSON(source, '文件名').name).toBe('文件名')
  })
})

describe('timestamps follow nested coordinates', () => {
  const multiLine = {type: 'MultiLineString', coordinates: [LINE, [[121, 31, 200], [121.01, 31, 210]]]}

  it('reads nested MultiLineString time arrays in point order', () => {
    expect(timesOf(feature(multiLine, [TIMES.slice(0, 2), TIMES.slice(2)]))).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 180_000])
  })

  it('does not move the second segment times onto an untimed first segment', () => {
    expect(timesOf(feature(multiLine, [[], TIMES.slice(2)]))).toEqual([null, null, T0 + 120_000, T0 + 180_000])
  })

  it('still accepts a flat timestamp array for a multiline geometry', () => {
    expect(timesOf(feature(multiLine, TIMES))).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 180_000])
  })

  it('keeps null and invalid timestamp slots within each segment', () => {
    expect(timesOf(feature(multiLine, [[null, TIMES[1]], ['invalid', TIMES[3]]]))).toEqual([null, T0 + 60_000, null, T0 + 180_000])
  })

  it('keeps the time slot of a dropped coordinate instead of shifting later times', () => {
    const damaged = {type: 'MultiLineString', coordinates: [[[120, 30], ['invalid', 30], [120.02, 30]], LINE]}
    expect(timesOf(feature(damaged, [[TIMES[0], TIMES[1], TIMES[2]], [null, TIMES[3]]]))).toEqual([T0, T0 + 120_000, null, T0 + 180_000])
  })

  it('matches separate GeometryCollection line groups while ignoring point geometry', () => {
    const geometry = {type: 'GeometryCollection', geometries: [{type: 'Point', coordinates: [119, 29]}, {type: 'LineString', coordinates: LINE}, {type: 'LineString', coordinates: LINE}]}
    expect(timesOf(feature(geometry, [[], TIMES.slice(2)]))).toEqual([null, null, T0 + 120_000, T0 + 180_000])
  })

  it('matches the deeper coordinate shape of MultiPolygon times', () => {
    const geometry = {type: 'MultiPolygon', coordinates: [[LINE], [LINE]]}
    expect(timesOf(feature(geometry, [[[TIMES[0], TIMES[1]]], [[TIMES[2], TIMES[3]]]]))).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 180_000])
  })
})

describe('a coordinate timestamp is authoritative', () => {
  it('prefers fourth-slot ISO timestamps to a shifted vendor array', () => {
    const geometry = {type: 'LineString', coordinates: [[120, 30, 100, TIMES[0]], [120.01, 30, 110, TIMES[1]]]}
    expect(timesOf(feature(geometry, [TIMES[2], TIMES[3]]))).toEqual([T0, T0 + 60_000])
  })

  it('accepts epoch milliseconds including zero in the fourth slot', () => {
    const geometry = {type: 'LineString', coordinates: [[120, 30, 100, 0], [120.01, 30, 110, T0]]}
    expect(timesOf(feature(geometry, TIMES.slice(0, 2)))).toEqual([0, T0])
  })

  it('uses aligned external times when the fourth slot is absent or invalid', () => {
    const geometry = {type: 'LineString', coordinates: [[120, 30, 100], [120.01, 30, 110, 'invalid']]}
    expect(timesOf(feature(geometry, TIMES.slice(0, 2)))).toEqual([T0, T0 + 60_000])
  })

  it('keeps direct timestamps on a bare geometry', () => {
    expect(timesOf({type: 'LineString', coordinates: [[120, 30, 100, TIMES[0]], [120.01, 30, 110, TIMES[1]]]})).toEqual([T0, T0 + 60_000])
  })

  it('leaves a file without timestamps untimed', () => {
    const result = flattenGeoJSON(collection(line()))
    expect(result.points.map(point => point[3])).toEqual([null, null])
    expect(result.startedAt).toBeNull()
    expect(result.endedAt).toBeNull()
  })
})
