// @vitest-environment jsdom
/**
 * The three readers, driven by hand-written files.
 *
 * jsdom is not optional here: `parseTrackFile` runs `DOMParser`, which the node
 * environment does not have, and the point of these tests is to exercise the
 * real parsing path rather than a shim standing in for it. The docblock above
 * is what selects the environment — the file name carries no `.dom` marker, so
 * the config's `node` default would otherwise collect it.
 */
import { describe, expect, it } from 'vitest'
import { parseTrackFile } from '../src/track/import.ts'
import { UPLOADS, validateUpload } from '../src/protocol.ts'
import {
  GPX_EMPTY, GPX_NO_ELEVATION, GPX_ROUTE_ONLY, GPX_TRACK, GPX_UNTERMINATED,
  KML_TRACK, LEG_METRES, MINUTE, NOT_GPX, STEP, T0, TCX_SINGLE_POINT, TCX_TRACK,
} from './fixtures.ts'

describe('a GPX with elevation and time', () => {
  const parsed = parseTrackFile('morning.gpx', GPX_TRACK)

  it('reads every track point, in order', () => {
    expect(parsed.format).toBe('gpx')
    expect(parsed.points).toHaveLength(3)
    expect(parsed.points.map(point => point.slice(0, 2))).toEqual([
      [120, 30], [120.01, 30], [120.02, 30],
    ])
  })

  it('keeps elevation as a number and time as epoch milliseconds', () => {
    expect(parsed.points.map(point => point[2])).toEqual([100, 120, 110])
    expect(parsed.points.map(point => point[3])).toEqual([T0, T0 + STEP, T0 + 2 * STEP])
  })

  it('sums the raw legs into one distance', () => {
    expect(parsed.metrics.distance).toBeCloseTo(2 * LEG_METRES, 6)
  })

  it('reports gain and loss from the smoothed accumulator', () => {
    // 100 → 120 → 110: one +20 banked, then one −10, both past the 5 m bar.
    expect(parsed.metrics.elevationGain).toBeCloseTo(20, 6)
    expect(parsed.metrics.elevationLoss).toBeCloseTo(10, 6)
  })

  it('takes the extreme elevations from the raw values', () => {
    expect(parsed.metrics.elevationMax).toBe(120)
    expect(parsed.metrics.elevationMin).toBe(100)
  })

  it('measures duration between the first and last timestamp', () => {
    expect(parsed.metrics.duration).toBe(20 * MINUTE)
  })

  it('frames the path with a [minLon, minLat, maxLon, maxLat] box', () => {
    expect(parsed.metrics.bbox).toEqual([120, 30, 120.02, 30])
  })

  it('names the file from its metadata block', () => {
    expect(parsed.name).toBe('测试环线')
  })
})

describe('a GPX with no elevation at all', () => {
  const parsed = parseTrackFile('walk.gpx', GPX_NO_ELEVATION)

  it('leaves elevation null rather than inventing sea level', () => {
    // The whole reason GPX does not go through the vendor reader: that one
    // writes `0`, and a flat profile is a lie about a real walk.
    expect(parsed.points.map(point => point[2])).toEqual([null, null, null])
    expect(parsed.points.map(point => point[3])).toEqual([null, null, null])
  })

  it('still measures distance, and reports no gain, no loss, no extremes', () => {
    expect(parsed.metrics.distance).toBeCloseTo(2 * LEG_METRES, 6)
    expect(parsed.metrics.elevationGain).toBe(0)
    expect(parsed.metrics.elevationLoss).toBe(0)
    expect(parsed.metrics.elevationMax).toBeNull()
    expect(parsed.metrics.elevationMin).toBeNull()
    expect(parsed.metrics.duration).toBe(0)
  })

  it('falls back to the track element for a name when there is no metadata', () => {
    expect(parsed.name).toBe('无海拔')
  })
})

describe('a GPX that is not a usable track', () => {
  it('refuses a route-only file instead of storing an empty track', () => {
    // `<rte>` parses fine and holds points, but it is a plan, not a recording —
    // and the map layer only ever draws what `flatten()` walked.
    expect(() => parseTrackFile('plan.gpx', GPX_ROUTE_ONLY)).toThrow(/没有可用的坐标点/u)
  })

  it('reports a GPX with no trk, rte or wpt as not being a track', () => {
    expect(() => parseTrackFile('empty.gpx', GPX_EMPTY)).toThrow(/没有 <trk>、<rte> 或 <wpt>/u)
  })

  it('reports truncated XML as a syntax error', () => {
    expect(() => parseTrackFile('cut.gpx', GPX_UNTERMINATED)).toThrow(/XML 语法错误/u)
  })

  it('reports well-formed XML that is not GPX by its missing root', () => {
    expect(() => parseTrackFile('other.gpx', NOT_GPX)).toThrow(/缺少 <gpx> 根元素/u)
  })
})

describe('a KML LineString', () => {
  const parsed = parseTrackFile('route.kml', KML_TRACK)

  it('reads lon/lat/elevation in GeoJSON order', () => {
    expect(parsed.format).toBe('kml')
    expect(parsed.points).toHaveLength(3)
    expect(parsed.points[0]).toEqual([120, 30, 100, null])
    expect(parsed.points[2]).toEqual([120.02, 30, 110, null])
  })

  it('shares the distance and elevation arithmetic with the GPX path', () => {
    expect(parsed.metrics.distance).toBeCloseTo(2 * LEG_METRES, 6)
    expect(parsed.metrics.elevationGain).toBeCloseTo(20, 6)
    expect(parsed.metrics.duration).toBe(0)
  })

  it('takes the Placemark name', () => {
    expect(parsed.name).toBe('测试路线')
  })

  it('refuses a document whose root is not <kml>', () => {
    expect(() => parseTrackFile('route.kml', NOT_GPX)).toThrow(/缺少 <kml> 根元素/u)
  })
})

describe('a TCX activity', () => {
  const parsed = parseTrackFile('ride.tcx', TCX_TRACK)

  it('reads the Trackpoint list', () => {
    expect(parsed.format).toBe('tcx')
    expect(parsed.points).toHaveLength(3)
    expect(parsed.points[0]).toEqual([120, 30, 100, T0])
    expect(parsed.points[2]).toEqual([120.02, 30, 110, T0 + 2 * STEP])
  })

  it('computes the same statistics the GPX file of the same shape gets', () => {
    expect(parsed.metrics.distance).toBeCloseTo(2 * LEG_METRES, 6)
    expect(parsed.metrics.elevationGain).toBeCloseTo(20, 6)
    expect(parsed.metrics.duration).toBe(20 * MINUTE)
  })

  it('refuses a Lap holding a single Trackpoint', () => {
    // The vendored reader builds a LineString from two or more Trackpoints; a
    // one-point Lap is dropped there, and the panel is told rather than shown
    // an empty map.
    expect(() => parseTrackFile('singleton.tcx', TCX_SINGLE_POINT)).toThrow(/没有可用的坐标点/u)
  })

  it('refuses a document whose root is not <TrainingCenterDatabase>', () => {
    expect(() => parseTrackFile('ride.tcx', NOT_GPX)).toThrow(/缺少 <TrainingCenterDatabase> 根元素/u)
  })
})

describe('upload validation, before any parsing happens', () => {
  it('accepts the three formats it knows', () => {
    expect(validateUpload('a.gpx', '<gpx/>')).toBeNull()
    expect(validateUpload('a.kml', '<kml/>')).toBeNull()
    expect(validateUpload('a.tcx', '<TrainingCenterDatabase/>')).toBeNull()
    // The extension is matched case-insensitively, because a camera writes `.GPX`.
    expect(validateUpload('a.GPX', '<gpx/>')).toBeNull()
  })

  it('names the format it cannot take', () => {
    expect(validateUpload('ride.fit', 'x')).toBe('暂不支持 .fit 文件，请使用 GPX / KML / TCX')
  })

  it('refuses a nameless or empty file with a sentence the panel can show', () => {
    expect(validateUpload('   ', 'x')).toBe('文件名不能为空')
    expect(validateUpload('track', 'x')).toBe('只支持 GPX / KML / TCX 文件')
    expect(validateUpload('a.gpx', '  \n ')).toBe('文件内容为空')
  })

  it('caps the original file at the advertised 8 MB', () => {
    expect(validateUpload('big.gpx', 'x'.repeat(UPLOADS.maxSourceBytes))).toBeNull()
    expect(validateUpload('big.gpx', 'x'.repeat(UPLOADS.maxSourceBytes + 1))).toBe('文件过大，上限 8 MB')
  })

  it('counts the cap in UTF-8 bytes, not characters', () => {
    // 3-byte characters: a character count would let a 3× oversized file past.
    const chinese = '轨'.repeat(UPLOADS.maxSourceBytes / 3).concat('轨')
    expect(validateUpload('big.gpx', chinese)).toBe('文件过大，上限 8 MB')
  })

  it('refuses through the parser too, so a caller cannot skip the check', () => {
    expect(() => parseTrackFile('ride.fit', GPX_TRACK)).toThrow(/暂不支持/u)
  })
})

describe('the point cap', () => {
  it('refuses a track with more points than the store will take', () => {
    // Written as KML, not GPX: the same half-million points spelled as
    // `<trkpt lat="30" lon="…"/>` is 16 MB of XML, and the upload cap would
    // refuse it first — this test is about the point cap, not the size cap.
    const coordinates = Array.from({length: UPLOADS.maxPoints + 1}, (_, index) => (
      `${String(120 + index / 100000)},30`
    )).join(' ')
    const huge = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>`
      + `<LineString><coordinates>${coordinates}</coordinates></LineString>`
      + `</Placemark></Document></kml>`
    expect(() => parseTrackFile('huge.kml', huge)).toThrow(/轨迹点过多/u)
  })

  it('refuses an oversized file before it ever looks at the points', () => {
    // The two caps are ordered: size first, so a 16 MB file never reaches the
    // XML reader at all.
    const oversized = 'x'.repeat(UPLOADS.maxSourceBytes + 1)
    expect(() => parseTrackFile('huge.gpx', oversized)).toThrow(/文件过大/u)
  })
})
