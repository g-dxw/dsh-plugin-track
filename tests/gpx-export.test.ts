// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toGPXText, editedTrackInput } from '../src/track/gpx-export.ts'
import { parseTrackFile } from '../src/track/import.ts'
import { UPLOADS, type TrackPoint } from '../src/protocol.ts'

const T0 = Date.parse('2026-10-01T01:00:00.123Z')
const POINTS: TrackPoint[] = [[120.1234567890123, 30.2345678901234, 123.4567890123, T0], [120.13, 30.24, null, null], [120.14, 30.25, 0, 0], [120.15, 30.26, -12.5, T0 + 4000]]
const LIMITS = {...UPLOADS}
afterEach(() => { Object.assign(UPLOADS, LIMITS); vi.restoreAllMocks() })

describe('generated edited GPX', () => {
  it('writes valid XML, escapes the name, and preserves every represented tuple value on re-import', () => {
    const name = '环线 <测试> & "卫星" \'手绘\' 🏔'
    const source = toGPXText(POINTS, {name})
    expect(source).toContain('环线 &lt;测试&gt; &amp; &quot;卫星&quot; &apos;手绘&apos; 🏔')
    expect(source).toContain('lat="30.2345678901234" lon="120.1234567890123"')
    const parsed = parseTrackFile('edited.gpx', source)
    expect(parsed.name).toBe('edited')
    const xml = new DOMParser().parseFromString(source, 'application/xml')
    expect(xml.querySelector('metadata > name')?.textContent).toBe(name)
    expect(xml.querySelector('trk > name')?.textContent).toBe(name)
    expect(parsed.points).toEqual(POINTS)
    expect(POINTS[1]).toEqual([120.13, 30.24, null, null])
  })

  it('expands scientific notation into GPX decimals without losing numeric precision', () => {
    const points: TrackPoint[] = [[1e-7, -2e-8, 1e21, null], [5e-324, 0.00000123456789, -1e-25, null]]
    const source = toGPXText(points, {name: '小坐标'})
    expect(source).toContain('lat="-0.00000002" lon="0.0000001"')
    expect(source).toContain('<ele>1000000000000000000000</ele>')
    expect(source).not.toMatch(/[\d]e[+-]?\d/iu)
    expect(parseTrackFile('decimal.gpx', source).points).toEqual(points)
  })
  it('omits unknown heights/times rather than fabricating sea-level or generation timestamps', () => {
    const source = toGPXText([[120, 30, null, null], [120.01, 30, null, null]], {name: '手绘路线'})
    expect(source).not.toContain('<ele>')
    expect(source).not.toContain('<time>')
    expect(source).not.toContain('undefined')
    expect(parseTrackFile('drawn.gpx', source).points).toEqual([[120, 30, null, null], [120.01, 30, null, null]])
  })

  it('keeps real zero height, negative height, and epoch-zero time', () => {
    const source = toGPXText(POINTS, {name: '零值'})
    expect(source).toContain('<ele>0</ele><time>1970-01-01T00:00:00.000Z</time>')
    expect(source).toContain('<ele>-12.5</ele>')
  })

  it('supports plain numeric-looking GPX names without changing coordinate values', () => {
    const source = toGPXText(POINTS, {name: '123'})
    expect(new DOMParser().parseFromString(source, 'application/xml').querySelector('metadata > name')?.textContent).toBe('123')
    expect(parseTrackFile('numeric.gpx', source).name).toBe('numeric')
    expect(parseTrackFile('numeric.gpx', source).points).toEqual(POINTS)
  })

  it.each([[], [POINTS[0]]].map(points => ({points})))('refuses an incomplete draft before producing a file', ({points}) => {
    expect(() => toGPXText(points, {name: '草稿'})).toThrow('至少需要 2 个点')
  })

  it.each([[-181, 30, null, null], [181, 30, null, null], [120, -91, null, null], [120, 91, null, null], [Number.NaN, 30, null, null], [120, Number.POSITIVE_INFINITY, null, null]].map(point => ({point})))('rejects invalid coordinates %j', ({point}) => {
    expect(() => toGPXText([point as TrackPoint, POINTS[1]], {name: '无效'})).toThrow('坐标无效')
  })

  it.each([[120, 30, Number.NaN, null], [120, 30, Number.POSITIVE_INFINITY, null]].map(point => ({point})))('rejects invalid numeric elevation %j', ({point}) => {
    expect(() => toGPXText([point as TrackPoint, POINTS[1]], {name: '无效'})).toThrow('海拔无效')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e20, 0.5])('rejects invalid/nonrepresentable timestamp %s', time => {
    expect(() => toGPXText([[120, 30, 100, time], POINTS[1]], {name: '无效'})).toThrow('时间无效')
  })

  it('rejects malformed tuple shape and illegal XML name characters', () => {
    expect(() => toGPXText([[120, 30] as unknown as TrackPoint, POINTS[1]], {name: '无效'})).toThrow('轨迹点无效')
    expect(() => toGPXText(POINTS, {name: '标题\u0000'})).toThrow('非法 XML 字符')
    expect(() => toGPXText(POINTS, {name: '\ud800'})).toThrow('非法 XML 字符')
  })

  it('rejects more than the supported 500000 points before allocating their XML', () => {
    expect(() => toGPXText(Array<TrackPoint>(UPLOADS.maxPoints + 1).fill(POINTS[0]), {name: '大轨迹'})).toThrow('轨迹点过多')
  })

  it('enforces the actual 8 MiB UTF-8 source limit, including non-ASCII names', () => {
    const longName = '轨'.repeat(Math.floor(UPLOADS.maxSourceBytes / 6) + 1)
    expect(() => toGPXText(POINTS, {name: longName})).toThrow('上限 8 MB')
  })
})

describe('save input for an edited copy', () => {
  it('uses a new generated GPX source, safe filename, independent tuples, and recalculated edit metrics', () => {
    const points: TrackPoint[] = [[120, 30, 100, T0], [120.01, 30, 120, T0 + 1000], [120.02, 30, null, null], [120.03, 30, 200, T0 + 2000], [120.04, 30, 190, T0 + 3000]]
    const input = editedTrackInput(points, {name: '  环线 / 修改:副本  '})
    expect(input.name).toBe('环线 / 修改:副本')
    expect(input.filename).toBe('环线 修改 副本.gpx')
    expect(input.points).toEqual(points)
    expect(input.points).not.toBe(points)
    expect(input.points[0]).not.toBe(points[0])
    expect(parseTrackFile(input.filename, input.source).points).toEqual(points)
    expect(input.metrics).toMatchObject({elevationGain: 20, elevationLoss: 10, duration: 3000, elevationMin: 100, elevationMax: 200})
  })

  it('uses a usable fallback for an empty display name and caps filename stems', () => {
    expect(editedTrackInput(POINTS, {name: '  '})).toMatchObject({name: '编辑轨迹', filename: '编辑轨迹.gpx'})
    expect(editedTrackInput(POINTS, {name: '轨'.repeat(100)}).filename).toHaveLength(84)
  })

  it('never cuts a filename through an emoji surrogate pair', () => {
    const input = editedTrackInput(POINTS, {name: 'A' + '🏔'.repeat(80)})
    expect(Array.from(input.filename.slice(0, -4))).toHaveLength(80)
    expect(() => encodeURIComponent(input.filename)).not.toThrow()
  })
  it('checks the encoded request size after source and point metadata are combined', () => {
    // Keep this fixture small and reduce only the allowed request budget. The
    // check is on real UTF-8 JSON bytes, including source quoting and metadata.
    const input = editedTrackInput(POINTS, {name: '副本'})
    const bytes = new TextEncoder().encode(JSON.stringify(input)).length
    Object.assign(UPLOADS, {maxRequestBytes: bytes - 1})
    expect(() => editedTrackInput(POINTS, {name: '副本'})).toThrow('保存请求上限 24 MB')
    Object.assign(UPLOADS, {maxRequestBytes: bytes})
    expect(editedTrackInput(POINTS, {name: '副本'}).points).toEqual(POINTS)
  })
})


