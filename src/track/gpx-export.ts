import { byteLength, UPLOADS, type TrackInput, type TrackPoint } from '../protocol.ts'
import { editedMetrics } from './edit.ts'

export interface GPXExportOptions { name: string }

/** A new GPX copy of the edited path, without pretending to preserve source XML. */
export function toGPXText(points: readonly TrackPoint[], {name}: GPXExportOptions): string {
  validatePoints(points)
  const escapedName = xmlText(name)
  const pieces = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<gpx version="1.1" creator="cqai-dsh-plugin-track" xmlns="http://www.topografix.com/GPX/1/1">\n',
    `<metadata><name>${escapedName}</name></metadata>\n<trk><name>${escapedName}</name><trkseg>\n`,
  ]
  let size = pieces.reduce((total, piece) => total + byteLength(piece), 0)
  for (const [lon, lat, elevation, time] of points) {
    const piece = `<trkpt lat="${decimal(lat)}" lon="${decimal(lon)}">${elevation === null ? '' : `<ele>${decimal(elevation)}</ele>`}${time === null ? '' : `<time>${new Date(time).toISOString()}</time>`}</trkpt>\n`
    // The point representation is ASCII; only the escaped name needed UTF-8.
    size += piece.length
    if (size > UPLOADS.maxSourceBytes) throw sourceTooLarge()
    pieces.push(piece)
  }
  const ending = '</trkseg></trk>\n</gpx>\n'
  if (size + ending.length > UPLOADS.maxSourceBytes) throw sourceTooLarge()
  pieces.push(ending)
  return pieces.join('')
}

/** The existing create endpoint stores this as a new id and generated GPX file. */
export function editedTrackInput(points: readonly TrackPoint[], options: GPXExportOptions): TrackInput {
  const name = options.name.trim() || '编辑轨迹'
  const source = toGPXText(points, {name})
  const stem = Array.from(name.replace(/[\\/:*?"<>|]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('') || '编辑轨迹'
  const input: TrackInput = {
    name,
    filename: `${stem}.gpx`,
    source,
    points: points.map(point => [...point]),
    metrics: editedMetrics(points),
  }
  if (byteLength(JSON.stringify(input)) > UPLOADS.maxRequestBytes) throw new Error('编辑结果过大，保存请求上限 24 MB')
  return input
}

function validatePoints(points: readonly TrackPoint[]): void {
  if (points.length < 2) throw new Error('轨迹至少需要 2 个点才能保存')
  if (points.length > UPLOADS.maxPoints) throw new Error(`轨迹点过多，上限 ${UPLOADS.maxPoints}`)
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    if (!Array.isArray(point) || point.length !== 4) throw new Error(`第 ${index + 1} 个轨迹点无效`)
    const [lon, lat, elevation, time] = point
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new Error(`第 ${index + 1} 个轨迹点坐标无效`)
    }
    if (elevation !== null && !Number.isFinite(elevation)) throw new Error(`第 ${index + 1} 个轨迹点海拔无效`)
    if (time !== null && (!Number.isFinite(time) || !Number.isInteger(time) || !Number.isFinite(new Date(time).getTime()))) {
      throw new Error(`第 ${index + 1} 个轨迹点时间无效`)
    }
  }
}

function xmlText(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (!(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
      throw new Error('轨迹名称含有非法 XML 字符')
    }
  }
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;')
}

function sourceTooLarge(): Error { return new Error('编辑结果 GPX 文件过大，上限 8 MB') }

/** GPX uses xs:decimal, whose lexical form does not permit exponent notation. */
function decimal(value: number): string {
  const text = String(value)
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/u.exec(text)
  if (!match) return text
  const [, sign, whole, fraction = '', exponent] = match
  const digits = whole + fraction
  const position = whole.length + Number(exponent)
  if (position <= 0) return `${sign}0.${'0'.repeat(-position)}${digits}`
  if (position >= digits.length) return `${sign}${digits}${'0'.repeat(position - digits.length)}`
  return `${sign}${digits.slice(0, position)}.${digits.slice(position)}`
}
