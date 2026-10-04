import type { TrackPoint } from '../protocol.ts'
import { haversineDistance } from './model/utils.ts'
import { editedMetrics } from './edit.ts'

export interface RestCandidate {
  startIndex: number
  endIndex: number
  /** Milliseconds supported by a continuous sequence of actual timestamps. */
  duration: number
  lat: number
  lon: number
}

export interface TrackGuidance {
  difficulty: string
  audience: string[]
  equipment: string[]
  limitations: string[]
}

const REST_DURATION_MS = 5 * 60 * 1000
const REST_RADIUS_M = 30
const REST_CANDIDATE_LIMIT = 50

/** Only adjacent, positive timestamp intervals can describe actual movement. */
export function analyzeTrack(points: readonly TrackPoint[]) {
  let elevationPoints = 0, timestampPoints = 0, duplicatePoints = 0, reversedTimes = 0, jumps = 0, timedLegs = 0, longGaps = 0
  let movingTime = 0, stoppedTime = 0, movingDistance = 0, maximumSpeed = 0
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (point[2] !== null && Number.isFinite(point[2])) elevationPoints += 1
    if (point[3] !== null && Number.isFinite(point[3])) timestampPoints += 1
    if (index === 0) continue
    const previous = points[index - 1]
    if (point[0] === previous[0] && point[1] === previous[1]) duplicatePoints += 1
    if (point[3] === null || previous[3] === null) continue
    const interval = point[3] - previous[3]
    if (interval <= 0) {reversedTimes += 1; continue}
    if (interval > 30 * 60 * 1000) {longGaps += 1; continue}
    const distance = haversineDistance(previous[1], previous[0], point[1], point[0])
    const speed = distance / (interval / 1000)
    if (speed > 200 / 3.6) {jumps += 1; continue}
    timedLegs += 1
    maximumSpeed = Math.max(maximumSpeed, speed)
    if (speed >= 0.5) {movingTime += interval; movingDistance += distance} else stoppedTime += interval
  }
  const metrics = editedMetrics(points)
  return {
    metrics, pointCount: points.length, elevationPoints, timestampPoints,
    duplicatePoints, reversedTimes, jumps, timedLegs, longGaps, movingTime, stoppedTime, movingDistance,
    averageMovingSpeed: movingTime ? movingDistance / (movingTime / 1000) : null,
    maximumSpeed: timedLegs ? maximumSpeed : null,
    restCandidates: findRestCandidates(points),
    guidance: trackGuidance(points, metrics, elevationPoints, timestampPoints),
  }
}

/** Candidates require user confirmation: stationary coordinates alone cannot prove a rest. */
export function findRestCandidates(points: readonly TrackPoint[]): RestCandidate[] {
  const candidates: RestCandidate[] = []
  let startIndex = -1
  let endIndex = -1
  const finish = () => {
    if (startIndex < 0 || endIndex - startIndex < 2 || candidates.length >= REST_CANDIDATE_LIMIT) return
    const start = points[startIndex]
    const end = points[endIndex]
    const duration = end[3]! - start[3]!
    if (duration >= REST_DURATION_MS) candidates.push({startIndex, endIndex, duration, lat: start[1], lon: start[0]})
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!validTimedPoint(point)) {
      finish()
      startIndex = endIndex = -1
      continue
    }
    if (startIndex < 0) {
      startIndex = endIndex = index
      continue
    }
    const previous = points[endIndex]
    const gap = point[3]! - previous[3]!
    const anchor = points[startIndex]
    const distance = haversineDistance(anchor[1], anchor[0], point[1], point[0])
    // A long gap provides no evidence of where the person was between fixes.
    // Test every fix against the anchor; an out-and-back walk is not a rest.
    if (gap <= 0 || gap > REST_DURATION_MS || !Number.isFinite(distance) || distance > REST_RADIUS_M) {
      finish()
      startIndex = endIndex = index
    } else endIndex = index
  }
  finish()
  return candidates
}

function validTimedPoint(point: TrackPoint): boolean {
  return Number.isFinite(point[0]) && point[0] >= -180 && point[0] <= 180
    && Number.isFinite(point[1]) && point[1] >= -90 && point[1] <= 90
    && point[3] !== null && Number.isFinite(point[3]) && Number.isFinite(new Date(point[3]).getTime())
}

function trackGuidance(points: readonly TrackPoint[], metrics: ReturnType<typeof editedMetrics>, elevationPoints: number, timestampPoints: number): TrackGuidance {
  const limitations = [
    '这是按距离和文件中连续有效海拔生成的本地徒步参考，不是正式路线难度评级。',
    '未确认活动类型、路面、坡度分布、天气和个人体能；出发前需结合实际情况判断。',
    '轨迹不能证明厕所、补给点或饮水设施的位置与开放情况，需要另行核实。',
    '休息候选仅表示连续时间采样在 30 米范围内至少 5 分钟，需本人确认；采样中断不计为休息。',
  ]
  if (!elevationPoints) limitations.push('没有文件海拔，不能判断实际爬升；难度仅参考距离。')
  else if (elevationPoints < points.length) limitations.push('文件海拔不完整，爬升仅统计连续有效片段，可能低估实际爬升。')
  else limitations.push('海拔噪声会影响爬升统计，不能由累计爬升推断路面和技术难度。')
  if (!timestampPoints) limitations.push('没有时间戳，不能识别休息或估算实际移动速度与用时。')
  else if (timestampPoints < points.length) limitations.push('时间戳不完整，休息候选和移动统计只覆盖有效连续片段。')
  if (points.some((point, index) => index > 0 && point[3] !== null && points[index - 1][3] !== null && (point[3]! - points[index - 1][3]! > REST_DURATION_MS || point[3]! <= points[index - 1][3]!))) {
    limitations.push('存在较长采样间隔或非递增时间，不能把这些间隔当作停留证据。')
  }

  if (points.length < 2 || !Number.isFinite(metrics.distance) || metrics.distance <= 0 || !Number.isFinite(metrics.elevationGain)) {
    return {difficulty: '无法分级（有效行进数据不足）', audience: [], equipment: [], limitations}
  }
  // Transparent local heuristics, not a technical terrain or fitness rating.
  const distanceLevel = metrics.distance <= 5_000 ? 0 : metrics.distance <= 12_000 ? 1 : metrics.distance <= 20_000 ? 2 : 3
  const climbLevel = metrics.elevationGain <= 200 ? 0 : metrics.elevationGain <= 600 ? 1 : metrics.elevationGain <= 1_200 ? 2 : 3
  const level = Math.max(distanceLevel, climbLevel)
  const labels = ['轻量', '中等', '较费力', '高负荷']
  const audience = [
    ['可供有基础步行能力的休闲徒步者评估'],
    ['可供有日常运动习惯、能持续步行的徒步者评估'],
    ['可供有较长距离徒步经验并完成体能准备的人评估'],
    ['可供有长距离和爬升经验、已确认撤退路线的人评估'],
  ][level]
  let difficulty = `${labels[level]}（本地参考）`
  if (!elevationPoints) difficulty += '；仅按距离判断'
  else if (elevationPoints < points.length) difficulty += '；海拔不完整'

  // General examples from NPS Ten Essentials: https://www.nps.gov/articles/10essentials.htm
  const equipment = [
    '适合实际路面的合脚防滑鞋',
    '按天气、距离和个人需要准备饮水与食物，不能预设沿途能补给',
    '可离线使用的地图和备用电源',
    '按天气准备防雨、保暖和防晒用品',
    '照明与基本急救用品',
  ]
  if (level >= 2) equipment.push('结合路况评估登山杖，并预留备用食物和撤退时间')
  return {difficulty, audience, equipment, limitations}
}
