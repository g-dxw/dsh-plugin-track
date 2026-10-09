// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseTrackFile } from '../src/track/import.ts'
import { formatAverageSpeed, formatDuration } from '../src/track/format.ts'
import { METRICS_VERSION } from '../src/protocol.ts'
import { KML_SUMMARY, KML_TRACK } from './fixtures.ts'

const summary = (fields: string) => KML_TRACK.replace('<Document>', `<Document><ExtendedData>${fields}</ExtendedData>`)
const field = (name: string, value: string) => `<Data name="${name}"><value>${value}</value></Data>`

describe('KML elapsed time without per-point timestamps', () => {
  it('uses exporter milliseconds, retains untimed points and ignores later photo timestamps', () => {
    const result = parseTrackFile('峨眉山.kml', KML_SUMMARY)
    expect(result.metrics.duration).toBe(45_222_000)
    expect(result.metrics.calculationVersion).toBe(METRICS_VERSION)
    expect(result.points.every(point => point[3] === null)).toBe(true)
    expect(formatDuration(result.metrics.duration)).toBe('12 小时 33 分 42 秒')
  })
  it('supports explicit seconds and ISO summary start/end fields', () => {
    expect(parseTrackFile('route.kml', summary(field('duration_seconds', '30609'))).metrics.duration).toBe(30_609_000)
    expect(parseTrackFile('route.kml', summary(field('start_time', '2026-05-29T01:00:00Z') + field('end_time', '2026-05-29T02:00:01Z'))).metrics.duration).toBe(3_601_000)
  })
  it('uses explicit epoch-millisecond start/end when TimeUsed is unavailable', () => {
    expect(parseTrackFile('route.kml', KML_SUMMARY.replace(field('TimeUsed', '45222000'), '')).metrics.duration).toBe(45_222_000)
  })
  it.each(['-1', 'invalid', 'Infinity', '0', '1e999'])('rejects invalid summary duration %s', value => {
    expect(parseTrackFile('route.kml', summary(field('TimeUsed', value))).metrics.duration).toBe(0)
  })
  it('does not mistake display TimeSpan or Point summary fields for activity time', () => {
    const source = KML_TRACK.replace('<Document>', '<Document><TimeSpan><begin>2026-05-29T01:00:00Z</begin><end>2026-05-29T02:00:00Z</end></TimeSpan><Placemark><ExtendedData>' + field('TimeUsed', '10000') + '</ExtendedData><Point><coordinates>120,30</coordinates></Point></Placemark>')
    expect(parseTrackFile('route.kml', source).metrics.duration).toBe(0)
  })
  it('prefers recorded route timestamps to an unrelated summary', () => {
    const source = summary(field('TimeUsed', '99999999')).replace('<kml ', '<kml xmlns:gx="http://www.google.com/kml/ext/2.2" ').replace(/<LineString>[\s\S]*?<\/LineString>/u, '<gx:Track><when>2026-05-29T01:00:00Z</when><when>2026-05-29T01:01:00Z</when><gx:coord>120 30 100</gx:coord><gx:coord>120.01 30 120</gx:coord></gx:Track>')
    expect(parseTrackFile('route.kml', source).metrics.duration).toBe(60_000)
  })
})

describe('statistics display', () => {
  it('keeps seconds for long recordings and calculates km/h from the displayed length/time', () => {
    expect(formatDuration(44_612_000)).toBe('12 小时 23 分 32 秒')
    expect(formatAverageSpeed(25_310, 44_612_000)).toBe('2.04 km/h')
  })
  it('shows missing time as unknown rather than zero speed', () => {
    expect(formatAverageSpeed(25_310, 0)).toBe('-')
    expect(formatAverageSpeed(Number.NaN, 1000)).toBe('-')
    expect(formatAverageSpeed(0, 1000)).toBe('0.00 km/h')
  })
})
