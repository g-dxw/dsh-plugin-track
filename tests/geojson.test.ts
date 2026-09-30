/**
 * The shape of an exported GeoJSON file.
 *
 * This is the one artefact of the plugin that leaves the app: it goes into
 * geojson.io, mapshaper, QGIS. So the assertions here are about the contract
 * those tools read, not about our own panel — a `LineString`, positions in
 * `[lon, lat, ele]` order, times as ISO strings, and a version number no viewer
 * has to be told about twice.
 */
import { describe, expect, it } from 'vitest'
import { toGeoJSONText, trackFeatureCollection } from '../src/track/export.ts'
import { clipTitle } from '../src/track/title.ts'
import { clipboardSafeName } from '../src/client/util.ts'
import type { TrackPoint } from '../src/protocol.ts'

const T0 = Date.parse('2026-09-20T01:00:00Z')

/** Three points: elevation and time, elevation only, then neither. */
const POINTS: TrackPoint[] = [
  [120, 30, 100, T0],
  [120.01, 30.02, 110, T0 + 600_000],
  [120.02, 30.01, null, null],
]

/**
 * The first feature's geometry, narrowed to a line.
 *
 * `Feature.geometry` is the whole `Geometry` union, so reading `.coordinates`
 * off it is a type error even though the export only ever writes lines here.
 * Narrowing once keeps the assertions below about the coordinates themselves.
 */
function firstLine(collection: GeoJSON.FeatureCollection): GeoJSON.LineString {
  const geometry = collection.features[0].geometry
  if (geometry.type !== 'LineString') throw new Error(`expected a LineString, got ${geometry.type}`)
  return geometry
}

describe('a GeoJSON export', () => {
  const collection = trackFeatureCollection(POINTS, {name: '测试环线'})

  it('opens with the path itself', () => {
    expect(collection.type).toBe('FeatureCollection')
    expect(collection.features[0].type).toBe('Feature')
    expect(collection.features[0].geometry.type).toBe('LineString')
  })

  it('writes positions as [lon, lat] and [lon, lat, ele], in that order', () => {
    // GeoJSON is lon-first; getting this backwards is the classic way to land a
    // track in the Indian Ocean, and no unit test of ours would notice otherwise.
    expect(firstLine(collection).coordinates).toEqual([
      [120, 30, 100],
      [120.01, 30.02, 110],
      // No elevation means no third element — not a 0, and not a null literal.
      [120.02, 30.01],
    ])
  })

  it('keeps times and elevations beside the coordinates, as strings and nulls', () => {
    const properties = collection.features[0].properties!
    expect(properties.coordinateProperties.times).toEqual([
      '2026-09-20T01:00:00.000Z',
      '2026-09-20T01:10:00.000Z',
      null,
    ])
    // Nulls hold the positions of their own points: a viewer zipping these two
    // arrays against the coordinates must not have them shift underneath it.
    expect(properties.coordinateProperties.elevations).toEqual([100, 110, null])
  })

  it('names the track on every feature, not only the first', () => {
    for (const feature of collection.features) expect(feature.properties!.name).toBe('测试环线')
  })

  it('marks where the walk started and stopped', () => {
    expect(collection.features).toHaveLength(3)
    expect(collection.features[1].geometry).toEqual({type: 'Point', coordinates: [120, 30, 100]})
    expect(collection.features[1].properties!.role).toBe('start')
    expect(collection.features[2].geometry).toEqual({type: 'Point', coordinates: [120.02, 30.01]})
    expect(collection.features[2].properties!.role).toBe('end')
  })

  it('drops the markers when the caller asks it to', () => {
    // The elevation profile renders the same shape and wants the line alone.
    const bare = trackFeatureCollection(POINTS, {name: '测试环线', includeEndpoints: false})
    expect(bare.features).toHaveLength(1)
  })
})

describe('a track the export has to cope with', () => {
  it('emits an empty LineString rather than a crash for a track with no points', () => {
    const collection = trackFeatureCollection([], {name: '空的'})
    expect(collection.features).toHaveLength(1)
    expect(firstLine(collection).coordinates).toEqual([])
  })

  it('refuses to write a half-broken fix into the file', () => {
    // A NaN longitude is a half-written GPS fix; it would make the whole
    // LineString invalid in a strict reader, so it is dropped here instead.
    const damaged: TrackPoint[] = [
      [120, 30, 100, T0],
      [Number.NaN, 30, 100, T0],
      [120.02, 30, 100, T0],
    ]
    const collection = trackFeatureCollection(damaged, {name: '损坏'})
    expect(firstLine(collection).coordinates).toEqual([[120, 30, 100], [120.02, 30, 100]])
    // The dropped point takes its time and elevation slots with it, so the three
    // arrays stay the same length.
    expect(collection.features[0].properties!.coordinateProperties.times).toHaveLength(2)
    expect(collection.features[0].properties!.coordinateProperties.elevations).toHaveLength(2)
  })
})

describe('the exported text', () => {
  it('is pretty-printed JSON that parses back to the same object', () => {
    const text = toGeoJSONText(POINTS, {name: '测试环线'})
    expect(text).toContain('\n  "type": "FeatureCollection"')
    expect(JSON.parse(text)).toEqual(trackFeatureCollection(POINTS, {name: '测试环线'}))
  })

  it('carries no undefined and no NaN, which would make the file unparseable', () => {
    // `JSON.stringify` turns both into the literal `null`/drop, so a bug that
    // smuggles one in would only show up in the viewer. Round-tripping the text
    // is the cheapest way to pin the output as real JSON.
    const text = toGeoJSONText([
      [120, 30, null, null],
      [120.01, 30, 100, null],
    ], {name: '无时间'})
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
    expect(JSON.parse(text)).toBeTruthy()
  })
})

describe('names that become filenames', () => {
  it('keeps a title short enough to read on a map label', () => {
    expect(clipTitle('  晨跑  ')).toBe('晨跑')
    expect(clipTitle('')).toBe('轨迹')
    expect(clipTitle('名'.repeat(120))).toHaveLength(60)
    expect(clipTitle('名'.repeat(120)).endsWith('…')).toBe(true)
  })

  it('strips the characters a filesystem or a shell would choke on', () => {
    expect(clipboardSafeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(clipboardSafeName('   ')).toBe('轨迹')
    expect(clipboardSafeName('名'.repeat(200))).toHaveLength(80)
  })
})
