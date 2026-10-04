/** Editable, deterministic examples; film time and route progress are independent. */
import type { TrackPlacemark, TrackPoint, TrackRecord } from '../protocol.ts'
import { analyzeTrack } from './analysis.ts'
import { editedMetrics } from './edit.ts'

export const SHOT_CASES = [
  {id: 'route-draw', label: '整线描画', description: '固定全景，逐渐画出整条路线。', category: 'shot', usesPoint: false, usesSection: false, sequence: ['全景定位', '整线描画']},
  {id: 'point-hold', label: '定点展示', description: '聚焦一个真实点位，路线保持暂停。', category: 'shot', usesPoint: true, usesSection: false, sequence: ['定点展示']},
  {id: 'zoom-in', label: '全景推近点', description: '从路线全景平滑推近选定点位。', category: 'shot', usesPoint: true, usesSection: false, sequence: ['路线全景', '推近目标']},
  {id: 'zoom-out', label: '点拉远到全景', description: '先看点位，再平滑拉回路线全貌。', category: 'shot', usesPoint: true, usesSection: false, sequence: ['目标点', '拉回路线全景']},
  {id: 'route-follow', label: '沿线跟随', description: '相机随行进位置移动，逐段展示路线。', category: 'shot', usesPoint: false, usesSection: false, sequence: ['起点定位', '沿线跟随']},
  {id: 'section-to-route', label: '某段展开到整线', description: '突出一段连续路线，再展开整体位置关系。', category: 'shot', usesPoint: false, usesSection: true, sequence: ['选段局部', '展开完整路线']},
  {id: 'route-intro', label: '路线介绍组合', description: '起点、终点和全景信息依次出现。', category: 'narrative', usesPoint: false, usesSection: false, sequence: ['起点展示', '终点展示', '全景信息']},
  {id: 'story-opening', label: '故事开场组合', description: '人工文字引入，建立位置，再呈现路线。', category: 'narrative', usesPoint: false, usesSection: false, sequence: ['文字引入', '位置建立', '路线呈现']},
  {id: 'local-opening', label: '局部开场组合', description: '先看局部点位，说明地点，再展开全貌。', category: 'narrative', usesPoint: true, usesSection: false, sequence: ['局部展示', '地点说明', '展开全貌']},
] as const
export type ShotCaseId = typeof SHOT_CASES[number]['id']
export interface ShotCaseParameters {
  duration: number
  detailZoom: number
  pitch: number
  bearing: number
  pointIndex: number
  startIndex: number
  endIndex: number
  placemarkId?: string
  caption: string
}
interface PlannedRun {startIndex: number; points: [number, number][]; cumulative: number[]; distance: number; offset: number}
export interface ShotCasePlan {
  id: ShotCaseId
  title: string
  duration: number
  bounds: [number, number, number, number]
  fullLines: [number, number][][]
  summary: string[]
  warnings: string[]
  steps: {label: string; duration: number}[]
  /** Internal immutable snapshots, exposed so the plan can stay entirely local. */
  parameters: ShotCaseParameters
  runs: PlannedRun[]
  totalDistance: number
  overviewCenter: [number, number]
  selectedTarget: {coordinates: [number, number]; label: string} | null
  selectedCamera: [number, number] | null
  sectionLines: [number, number][][]
  sectionCenter: [number, number] | null
  trackName: string
  information: string
}
export interface ShotCaseFrame {
  progress: number
  routeProgress: number
  camera: {center: [number, number]; zoomOffset: number; bearing: number; pitch: number}
  walkedLines: [number, number][][]
  position: [number, number] | null
  target: {coordinates: [number, number]; label: string} | null
  caption: string
  stepLabel: string
}
const DISPLAY_POINT_LIMIT = 6000
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))
const ease = (value: number) => value * value * (3 - 2 * value)
const finiteHeight = (point: TrackPoint) => typeof point[2] === 'number' && Number.isFinite(point[2])
const finiteTime = (point: TrackPoint) => typeof point[3] === 'number' && Number.isFinite(point[3]) && Number.isFinite(new Date(point[3]).getTime())
function coordinates(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && typeof value[0] === 'number' && typeof value[1] === 'number' && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
}
function nearLongitude(lon: number, reference: number) {return lon + Math.round((reference - lon) / 360) * 360}
function interpolate(start: [number, number], end: [number, number], progress: number): [number, number] {
  return [start[0] + (end[0] - start[0]) * progress, start[1] + (end[1] - start[1]) * progress]
}
function distance(start: [number, number], end: [number, number]): number {
  const radians = Math.PI / 180
  const a = Math.sin((end[1] - start[1]) * radians / 2) ** 2 + Math.cos(start[1] * radians) * Math.cos(end[1] * radians) * Math.sin((end[0] - start[0]) * radians / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(clamp(a, 0, 1)))
}
function copied(value: [number, number]): [number, number] {return [value[0], value[1]]}
function simplified(points: readonly [number, number][], maximum = DISPLAY_POINT_LIMIT): [number, number][] {
  const stride = Math.max(1, Math.ceil((points.length - 1) / Math.max(1, maximum - 1)))
  const output: [number, number][] = []
  for (let index = 0; index < points.length - 1; index += stride) output.push(copied(points[index]))
  if (points.length) output.push(copied(points[points.length - 1]))
  return output
}
function inputParameters(value: ShotCaseParameters): ShotCaseParameters {
  if (!value || typeof value !== 'object') throw new Error('镜头参数缺失')
  for (const key of ['duration', 'detailZoom', 'pitch', 'bearing', 'pointIndex', 'startIndex', 'endIndex'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new Error('镜头参数需为有效数字')
  }
  if (value.duration < 3 || value.duration > 120) throw new Error('案例时长需为 3 至 120 秒')
  if (value.detailZoom < 0 || value.detailZoom > 6) throw new Error('推近倍率差需为 0 至 6')
  if (value.pitch < 0 || value.pitch > 75) throw new Error('俯仰角需为 0 至 75 度')
  if (['pointIndex', 'startIndex', 'endIndex'].some(key => !Number.isInteger(value[key as 'pointIndex']) || value[key as 'pointIndex'] < 0)) throw new Error('轨迹点序号需为非负整数')
  if (typeof value.caption !== 'string' || value.caption.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value.caption)) throw new Error('示例文字需为 1000 字以内的有效文本')
  if (value.placemarkId !== undefined && (typeof value.placemarkId !== 'string' || !value.placemarkId.trim() || value.placemarkId.length > 128)) throw new Error('独立点位编号无效')
  return {...value, caption: value.caption.trim(), bearing: ((value.bearing % 360) + 360) % 360}
}
const ratios: Record<ShotCaseId, number[]> = {
  'route-draw': [.15, .85], 'point-hold': [1], 'zoom-in': [.2, .8], 'zoom-out': [.2, .8], 'route-follow': [.15, .85],
  'section-to-route': [.3, .7], 'route-intro': [.3, .3, .4], 'story-opening': [.25, .35, .4], 'local-opening': [.3, .3, .4],
}

export function buildShotCasePlan(track: TrackRecord, id: ShotCaseId, parameters: ShotCaseParameters, placemarks: readonly TrackPlacemark[] = track.placemarks || []): ShotCasePlan {
  const definition = SHOT_CASES.find(item => item.id === id)
  if (!definition) throw new Error('未知镜头案例')
  const settings = inputParameters(parameters)
  const breaks = new Set(track.segmentStarts || [])
  const runs: PlannedRun[] = []
  const sourceRuns: TrackPoint[][] = []
  let active: PlannedRun | null = null, offset = 0, reference: number | null = null
  let crossedDateLine = false, invalid = 0
  track.coordinates.forEach((point, index) => {
    if (breaks.has(index) || !coordinates(point)) active = null
    if (!coordinates(point)) {invalid++; return}
    if (!active) {
      active = {startIndex: index, points: [], cumulative: [], distance: 0, offset}
      runs.push(active); sourceRuns.push([])
    }
    const previous = active.points[active.points.length - 1]
    const lon = nearLongitude(point[0], previous?.[0] ?? reference ?? point[0])
    if (Math.abs(lon - point[0]) > 180) crossedDateLine = true
    const coordinate: [number, number] = [lon, point[1]]
    if (previous) {const length = distance(previous, coordinate); active.distance += length; offset += length}
    active.points.push(coordinate); active.cumulative.push(active.distance)
    sourceRuns[sourceRuns.length - 1].push([point[0], point[1], finiteHeight(point) ? point[2] : null, finiteTime(point) ? point[3] : null])
    if (reference === null) reference = lon
  })
  if (!runs.length) throw new Error('轨迹没有有效坐标，暂不能预览案例')
  const warnings = ['本库展示二维地图相机案例；俯仰角不代表已加载真实三维地形。', '示例文字可人工修改，不自动判断路线难度、设施或山峰名称。']
  if (invalid) warnings.push(`${invalid} 个无效坐标已断开，不跨无效点插值。`)
  if (runs.length > 1) warnings.push(`路线含 ${runs.length} 个连续段，分段间不连线、不计距离；跟随时在分段边界切换位置。`)
  if (crossedDateLine) warnings.push('路线跨日期变更线，已使用连续经度展示，避免绕地球插值。')
  if (!offset) warnings.push('轨迹没有可行进距离，路线推进只能展示固定采样位置。')
  const pointAtIndex = (index: number): [number, number] | null => {
    const run = runs.find(item => index >= item.startIndex && index < item.startIndex + item.points.length)
    return run ? copied(run.points[index - run.startIndex]) : null
  }
  let selectedTarget: ShotCasePlan['selectedTarget'] = null, selectedCamera: [number, number] | null = null
  if (definition.usesPoint) {
    if (settings.placemarkId) {
      const target = placemarks.find(point => point.id === settings.placemarkId)
      if (!target || target.hidden || !coordinates(target.coordinates) || target.coordinates.length !== 2) throw new Error('独立目标点不存在、已隐藏或坐标无效')
      selectedTarget = {coordinates: copied(target.coordinates), label: target.name.trim() || '独立点位'}
      selectedCamera = [nearLongitude(target.coordinates[0], reference!), target.coordinates[1]]
      warnings.push('独立点位使用其原坐标，未吸附到轨迹；名称与说明来自用户记录。')
    } else {
      selectedCamera = pointAtIndex(settings.pointIndex)
      if (!selectedCamera) throw new Error('目标轨迹点不存在或坐标无效')
      selectedTarget = {coordinates: [track.coordinates[settings.pointIndex][0], track.coordinates[settings.pointIndex][1]], label: `轨迹点 ${settings.pointIndex + 1}`}
    }
  }
  let sectionLines: [number, number][][] = [], sectionCenter: [number, number] | null = null
  if (definition.usesSection) {
    const run = runs.find(item => settings.startIndex >= item.startIndex && settings.endIndex < item.startIndex + item.points.length)
    if (settings.startIndex >= settings.endIndex || !run) throw new Error('请选择同一连续段内从前到后的两个有效轨迹点')
    const points = run.points.slice(settings.startIndex - run.startIndex, settings.endIndex - run.startIndex + 1)
    sectionLines = [simplified(points)]
    const sectionBounds = boundsOf([points])
    sectionCenter = [(sectionBounds[0] + sectionBounds[2]) / 2, (sectionBounds[1] + sectionBounds[3]) / 2]
  }
  const fullLines = runs.map(run => simplified(run.points, Math.max(2, Math.floor(DISPLAY_POINT_LIMIT / runs.length))))
  const bounds = boundsOf([...runs.map(run => run.points), ...(selectedCamera ? [[selectedCamera]] : [])])
  const overviewCenter: [number, number] = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
  const metrics = sourceRuns.map(points => editedMetrics(points))
  const reports = sourceRuns.map(points => analyzeTrack(points))
  const elevations = sourceRuns.flat().filter(finiteHeight).map(point => point[2]!)
  const minimum = elevations.reduce((current, value) => Math.min(current, value), Infinity)
  const maximum = elevations.reduce((current, value) => Math.max(current, value), -Infinity)
  const altitude = elevations.length ? `有效采样海拔约 ${Math.round(minimum)}–${Math.round(maximum)} m；不是已核实峰顶高程。` : '文件海拔缺失，不能推断真实爬升或最高采样点。'
  const gain = metrics.reduce((sum, item) => sum + item.elevationGain, 0), loss = metrics.reduce((sum, item) => sum + item.elevationLoss, 0)
  const timeSpan = metrics.reduce((sum, item) => sum + item.duration, 0)
  const knownSpan = reports.some((report, index) => report.timestampPoints >= 2 && report.reversedTimes === 0 && metrics[index].duration > 0)
  const measuredDistance = metrics.reduce((sum, item) => sum + item.distance, 0)
  const summary = [`路线：${track.name || track.filename || '未命名轨迹'}；有效点 ${sourceRuns.reduce((sum, points) => sum + points.length, 0)} 个，连续段 ${runs.length} 个。`,
    `按连续段重新计算路线距离约 ${Number.isFinite(measuredDistance) ? (measuredDistance / 1000).toFixed(2) : '未知'} km（不跨段补线）。`, altitude,
    ...(elevations.length ? [`各连续段按 editedMetrics 统计累计上升约 ${finiteMetric(gain)} m、下降约 ${finiteMetric(loss)} m；海拔噪声会影响统计。`] : []),
    knownSpan ? `各连续段有效时间戳的记录跨度合计约 ${(timeSpan / 60000).toFixed(1)} 分钟，不等于实际移动或休息时间。` : '记录时间跨度未知：没有可靠的起止时间，不能推断实际停留。', '难度：待补充，需人工提供；不从 GPS 自动评分。']
  if (reports.some(report => report.elevationPoints < report.pointCount)) warnings.push('海拔缺失处不补零；爬升统计仅覆盖连续有效采样。')
  if (reports.some(report => report.reversedTimes || report.longGaps)) warnings.push('时间存在非递增或长间隔，只展示记录跨度，不解释为休息。')
  const information = `距离 ${Number.isFinite(measuredDistance) ? (measuredDistance / 1000).toFixed(2) + ' km' : '未知'}｜累计上升 ${elevations.length ? finiteMetric(gain) + ' m' : '未知'}｜记录跨度 ${knownSpan ? (timeSpan / 60000).toFixed(1) + ' 分钟' : '未知'}｜难度待补充`
  const steps = definition.sequence.map((label, index) => ({label, duration: settings.duration * ratios[id][index]}))
  steps[steps.length - 1].duration = settings.duration - steps.slice(0, -1).reduce((sum, step) => sum + step.duration, 0)
  return {id, title: definition.label, duration: settings.duration, bounds, fullLines, summary, warnings, steps,
    parameters: settings, runs, totalDistance: offset, overviewCenter, selectedTarget, selectedCamera, sectionLines, sectionCenter,
    trackName: track.name || track.filename || '未命名轨迹', information}
}
function finiteMetric(value: number): string {return Number.isFinite(value) ? String(Math.round(value)) : '无法计算'}
function boundsOf(lines: readonly (readonly [number, number][])[]): [number, number, number, number] {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const line of lines) for (const [lon, lat] of line) {west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat)}
  if (east - west < .0001) {west -= .00005; east += .00005}
  if (north - south < .0001) {south -= .00005; north += .00005}
  return [west, south, east, north]
}
function phaseAt(plan: ShotCasePlan, progress: number) {
  const seconds = progress * plan.duration
  let start = 0
  for (let index = 0; index < plan.steps.length; index++) {
    const duration = plan.steps[index].duration
    if (seconds < start + duration || index === plan.steps.length - 1) return {index, progress: clamp((seconds - start) / duration, 0, 1)}
    start += duration
  }
  return {index: 0, progress: 0}
}
function routeAt(plan: ShotCasePlan, progress: number): {position: [number, number]; walked: [number, number][][]} {
  if (progress <= 0 || !plan.totalDistance) return {position: copied(plan.runs[0].points[0]), walked: []}
  if (progress >= 1) return {position: copied(plan.runs[plan.runs.length - 1].points.at(-1)!), walked: plan.fullLines.map(line => line.map(copied))}
  const requested = plan.totalDistance * progress
  const walked: [number, number][][] = []
  let current = plan.runs[plan.runs.length - 1]
  for (const run of plan.runs) {
    if (run.distance && requested < run.offset + run.distance) {current = run; break}
    walked.push(simplified(run.points, Math.max(2, Math.floor(DISPLAY_POINT_LIMIT / plan.runs.length))))
  }
  const amount = clamp(requested - current.offset, 0, current.distance)
  let low = 0, high = current.cumulative.length
  while (low < high) {const middle = (low + high) >>> 1; if (current.cumulative[middle] <= amount) low = middle + 1; else high = middle}
  const index = Math.max(0, Math.min(current.points.length - 1, low - 1))
  const next = Math.min(index + 1, current.points.length - 1)
  const span = current.cumulative[next] - current.cumulative[index]
  const position = interpolate(current.points[index], current.points[next], span ? (amount - current.cumulative[index]) / span : 0)
  const budget = Math.max(2, Math.floor(DISPLAY_POINT_LIMIT / plan.runs.length))
  const stride = Math.max(1, Math.ceil(index / Math.max(1, budget - 2)))
  const partial: [number, number][] = []
  for (let point = 0; point < index; point += stride) partial.push(copied(current.points[point]))
  partial.push(copied(current.points[index]))
  if (position[0] !== current.points[index][0] || position[1] !== current.points[index][1]) partial.push(copied(position))
  walked.push(partial)
  return {position, walked}
}

export function sampleShotCase(plan: ShotCasePlan, requestedProgress: number): ShotCaseFrame {
  const progress = Number.isFinite(requestedProgress) ? clamp(requestedProgress, 0, 1) : requestedProgress === Infinity ? 1 : 0
  const phase = phaseAt(plan, progress), local = ease(phase.progress)
  const settings = plan.parameters, overview = plan.overviewCenter
  let center = copied(overview), zoomOffset = 0, routeProgress = 0
  let target = plan.selectedTarget ? {coordinates: copied(plan.selectedTarget.coordinates), label: plan.selectedTarget.label} : null
  let caption = settings.caption || plan.trackName
  let walkedLines: [number, number][][] = [], position: [number, number] | null = null
  const first = plan.runs[0].points[0], last = plan.runs[plan.runs.length - 1].points.at(-1)!
  switch (plan.id) {
    case 'route-draw': routeProgress = phase.index ? phase.progress : 0; break
    case 'point-hold': center = copied(plan.selectedCamera!); zoomOffset = settings.detailZoom; break
    case 'zoom-in': center = interpolate(overview, plan.selectedCamera!, phase.index ? local : 0); zoomOffset = settings.detailZoom * (phase.index ? local : 0); break
    case 'zoom-out': center = interpolate(plan.selectedCamera!, overview, phase.index ? local : 0); zoomOffset = settings.detailZoom * (phase.index ? 1 - local : 1); break
    case 'route-follow': routeProgress = phase.index ? phase.progress : 0; zoomOffset = settings.detailZoom; break
    case 'section-to-route':
      center = interpolate(plan.sectionCenter!, overview, phase.index ? local : 0)
      zoomOffset = settings.detailZoom * (phase.index ? 1 - local : 1)
      walkedLines = plan.sectionLines.map(line => line.map(copied))
      break
    case 'route-intro':
      if (phase.index === 0) {center = copied(first); zoomOffset = settings.detailZoom; target = {coordinates: copied(first), label: '轨迹起点'}; caption = '轨迹起点'}
      else if (phase.index === 1) {center = interpolate(first, last, local); zoomOffset = settings.detailZoom; target = {coordinates: copied(last), label: '轨迹终点'}; caption = '轨迹终点'}
      else {center = interpolate(last, overview, local); zoomOffset = settings.detailZoom * (1 - local); target = null; caption = plan.information + (settings.caption ? '｜' + settings.caption : '')}
      break
    case 'story-opening':
      if (phase.index === 0) {zoomOffset = -.5; caption = settings.caption || '这一程，沿着路线认识周边环境。'}
      else if (phase.index === 1) {zoomOffset = -.5 * (1 - local); caption = plan.trackName}
      else {routeProgress = phase.progress; caption = settings.caption || plan.trackName}
      break
    case 'local-opening':
      if (phase.index < 2) {center = copied(plan.selectedCamera!); zoomOffset = settings.detailZoom; caption = phase.index ? plan.selectedTarget!.label : settings.caption || '先看一处局部，再展开整条路线。'}
      else {center = interpolate(plan.selectedCamera!, overview, local); zoomOffset = settings.detailZoom * (1 - local); caption = settings.caption || plan.trackName}
      break
  }
  if (['route-draw', 'route-follow', 'story-opening'].includes(plan.id)) {
    const route = routeAt(plan, routeProgress)
    walkedLines = route.walked
    position = plan.id === 'story-opening' && phase.index < 2 ? null : route.position
    if (plan.id === 'route-follow') center = copied(route.position)
  }
  return {progress, routeProgress, camera: {center, zoomOffset, bearing: settings.bearing, pitch: settings.pitch},
    walkedLines, position, target, caption, stepLabel: plan.steps[phase.index].label}
}



