/** Local, evidence-bounded planning. No network, encoding or generative model is used here. */
import type { TrackRecord, TrackPoint, TrackPlacemark } from '../protocol.ts'
import type { TrackAnnotation } from './annotations.ts'
import { analyzeTrack } from './analysis.ts'
import { editedMetrics } from './edit.ts'
import { MAX_VIDEO_CANDIDATES, MAX_VIDEO_DURATION, MAX_VIDEO_SHOTS, VIDEO_SCENE_KINDS,
  type VideoSceneCandidate, type VideoSceneKind, type VideoSceneTarget, type VideoScriptAnalysis,
  type VideoScriptDraft, type VideoScriptShot } from './video-script-types.ts'

export type { VideoScriptAnalysis, VideoScriptDraft } from './video-script-types.ts'

interface Run {start: number; points: TrackPoint[]}
interface HeightSection {start: number; end: number; change: number}
const MAX_TEXT = 4000
function description(value: string): string {
  return clean(value.replace(/<script[\s\S]*?<\/script>/giu, '').replace(/<style[\s\S]*?<\/style>/giu, '').replace(/<[^>]*>/gu, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/(?:https?:\/\/|data:image\/)[^\s<>]+/giu, '[链接已省略]'))
}
const clean = (value: string, maximum = 600) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim().slice(0, maximum)
const number = (value: number) => Number.isFinite(value) ? Math.round(value) : 0
const location = (point: readonly [number, number, ...unknown[]]) => `${point[0].toFixed(5)}, ${point[1].toFixed(5)}`
const validCoordinates = (value: unknown): value is [number, number] => Array.isArray(value) && value.length >= 2
  && typeof value[0] === 'number' && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
  && typeof value[1] === 'number' && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90
const coordinate = (point: readonly [number, number, ...unknown[]]): [number, number] => [point[0], point[1]]
const hasHeight = (point: TrackPoint) => typeof point[2] === 'number' && Number.isFinite(point[2])
const hasTime = (point: TrackPoint) => typeof point[3] === 'number' && Number.isFinite(point[3]) && Number.isFinite(new Date(point[3]).getTime())

/** Explicit breaks and invalid coordinates both end a run; original point indices survive. */
function connectedRuns(track: TrackRecord): Run[] {
  const breaks = new Set(track.segmentStarts || [])
  const runs: Run[] = []
  let active: Run | null = null
  track.coordinates.forEach((point, index) => {
    if (breaks.has(index) || !validCoordinates(point)) active = null
    if (!validCoordinates(point)) return
    if (!active) {active = {start: index, points: []}; runs.push(active)}
    active.points.push([point[0], point[1], hasHeight(point) ? point[2] : null, hasTime(point) ? point[3] : null])
  })
  return runs
}

/** Stable ordering makes equivalent object property orders produce the same local fingerprint. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return value
}
function fingerprint(track: TrackRecord, annotations: readonly TrackAnnotation[], placemarks: readonly TrackPlacemark[]): string {
  const content = JSON.stringify(stableValue({id: track.id, name: track.name, filename: track.filename,
    coordinates: track.coordinates, segmentStarts: track.segmentStarts || [], placemarks, annotations}))
  let first = 2166136261, second = 3335557771
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 2246822519)
  }
  return `vs1-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}
function photos(links: readonly string[] | undefined, photo?: TrackAnnotation['photo']): number {
  const count = new Set((links || []).filter(link => typeof link === 'string' && link.trim())).size
  return count + (photo?.dataUrl && (!photo.sourceUrl || !(links || []).includes(photo.sourceUrl)) ? 1 : 0)
}
function heightSections(runs: readonly Run[], direction: 1 | -1): HeightSection[] {
  const sections: HeightSection[] = []
  for (const run of runs) {
    let start = -1, end = -1
    const finish = () => {
      if (start < 0 || end - start < 2) return
      const change = (run.points[end][2]! - run.points[start][2]!) * direction
      if (change >= 20 && editedMetrics(run.points.slice(start, end + 1)).distance >= 5) {
        sections.push({start: run.start + start, end: run.start + end, change})
      }
    }
    for (let index = 1; index < run.points.length; index++) {
      const previous = run.points[index - 1], point = run.points[index]
      if (!hasHeight(previous) || !hasHeight(point) || (point[2]! - previous[2]!) * direction < 0) {finish(); start = end = -1; continue}
      if (start < 0) start = index - 1
      end = index
    }
    finish()
  }
  return sections.sort((a, b) => b.change - a.change || a.start - b.start).slice(0, 2)
}

export function analyzeVideoScript(track: TrackRecord, annotations: readonly TrackAnnotation[] = [], placemarks: readonly TrackPlacemark[] = track.placemarks || []): VideoScriptAnalysis {
  const runs = connectedRuns(track)
  const measured = runs.flatMap(run => run.points)
  const metrics = runs.map(run => editedMetrics(run.points))
  const reports = runs.map(run => analyzeTrack(run.points))
  const distance = metrics.reduce((sum, item) => sum + item.distance, 0)
  const gain = metrics.reduce((sum, item) => sum + item.elevationGain, 0)
  const loss = metrics.reduce((sum, item) => sum + item.elevationLoss, 0)
  const elevationCount = measured.filter(hasHeight).length
  const timeCount = measured.filter(hasTime).length
  const visible = placemarks.filter(point => !point.hidden && validCoordinates(point.coordinates))
  const hiddenIds = new Set(placemarks.filter(point => point.hidden).map(point => point.id))
  const validAnnotations = annotations.filter(annotation => !hiddenIds.has(annotation.sourceId || annotation.id)
    && (annotation.sourceCoordinates ? validCoordinates(annotation.sourceCoordinates)
      : Number.isInteger(annotation.pointIndex) && validCoordinates(track.coordinates[annotation.pointIndex])))
  const photoCount = visible.reduce((sum, point) => sum + photos(point.images), 0)
    + validAnnotations.filter(annotation => !visible.some(point => point.id === annotation.sourceId)).reduce((sum, annotation) => sum + photos(annotation.imageUrls, annotation.photo), 0)
  const trackName = clean(track.name || track.filename || '未命名轨迹', 120)
  const limitations = ['本地规则生成的可编辑脚本草稿；未调用 AI，镜头需逐项确认。',
    '事实来自轨迹采样与用户已有标注，不能证明山峰名称、路况难度或设施开放情况。',
    '影片秒数是建议制作时长，与 GPS 记录时间分开；本模块不会录制或修改当前动画。',
    '只统计照片数量，不发送或导出照片链接、照片内容及轨迹源文件。']
  if (runs.length > 1) limitations.push(`按 ${runs.length} 个连续轨迹段分别计算，不跨断点连接距离、爬升或时间停留。`)
  if (measured.length !== track.coordinates.length) limitations.push('无效坐标已排除，并断开前后采样；候选仍使用原轨迹点序号。')
  if (!elevationCount) limitations.push('没有有效文件海拔，不能判断海拔剖面、最高采样点及上升下降段。')
  else if (elevationCount < measured.length) limitations.push('文件海拔不完整，仅统计连续有效海拔片段，可能低估实际爬升。')
  if (!timeCount) limitations.push('没有有效时间戳，不能识别实际时间采样停留或推断行程用时。')
  else if (timeCount < measured.length) limitations.push('时间戳不完整，停留候选只覆盖连续有效时间采样。')
  if (reports.some(report => report.reversedTimes || report.longGaps)) limitations.push('存在非递增时间或较长采样间隔，不能将这些间隔解释为休息。')
  const summary = [`${trackName}：${measured.length} 个有效轨迹点，${runs.length} 个连续段。`,
    `按当前坐标重新计算距离 ${(Number.isFinite(distance) ? distance / 1000 : 0).toFixed(2)} km，累计上升约 ${number(gain)} m、下降约 ${number(loss)} m。`,
    `有效海拔 ${elevationCount}/${measured.length}，有效时间 ${timeCount}/${measured.length}。`,
    `可见独立点位 ${visible.length} 个，已有有效标注 ${validAnnotations.length} 个，关联照片约 ${photoCount} 张。`]
  const candidates: VideoSceneCandidate[] = []
  const add = (id: string, kind: VideoSceneKind, title: string, facts: string[], evidence: string[], visual: string,
    camera: string, draftNarration: string, duration = 10, target?: VideoSceneTarget, missing: string[] = [], materials: string[] = []) => {
    candidates.push({id, kind, title, readiness: missing.length ? 'needs-info' : 'ready', facts, evidence, missing,
      visual, camera, draftNarration, onScreenText: title, materials, duration, ...(target ? {target} : {})})
  }
  const usable = measured.length >= 2 && Number.isFinite(distance) && distance > 0
  const coordinateMissing = usable ? [] : ['至少两个可连接且形成有效行进距离的坐标点']
  add('route-overview', 'route-overview', '路线总览', summary.slice(0, 2), ['当前轨迹坐标；逐连续段 editedMetrics 重新计算，不使用过期导入统计'],
    '显示完整路线及起终点；不连接分段空隙。', '从路线全景建立位置关系，保持起终点可见。',
    `这条路线是${trackName}，当前轨迹记录的距离约 ${(Number.isFinite(distance) ? distance / 1000 : 0).toFixed(1)} 公里。`, 10, undefined, coordinateMissing)
  add('terrain-overview', 'terrain-overview', '地形与路线关系（待补区域高程）', elevationCount ? [`轨迹有 ${elevationCount} 个有效海拔样本。`] : [],
    ['轨迹只有路线上的采样，不包含路线外的区域地形高程'], '路线与区域地形同屏；加载并检查真实地形后确定构图。',
    '确认沙盘范围后缓慢斜俯视，避免先编造山脊、湖谷关系。', '', 12, undefined,
    ['真实区域高程及其来源', '确认地形范围与路线贴合效果'], ['区域高程、可用底图及署名'])
  add('route-progress', 'route-progress', '路线推进', [`路线推进以行进距离为依据；${runs.length} 个连续段分别展示。`],
    ['当前轨迹坐标顺序与 segmentStarts'], '逐段显示已走路线与当前位置，关键点停留须另行安排。', '跟随当前位置，镜头切换与路线进度独立编排。',
    `沿着${trackName}的记录路线，依次看清这一程的行进方向。`, 20, undefined, coordinateMissing)
  let highIndex = -1
  track.coordinates.forEach((point, index) => {if (validCoordinates(point) && hasHeight(point) && (highIndex < 0 || point[2]! > track.coordinates[highIndex][2]!)) highIndex = index})
  const high = highIndex >= 0 ? track.coordinates[highIndex] : null
  const elevations = measured.filter(hasHeight).map(point => point[2]!)
  const minimum = elevations.reduce((value, item) => Math.min(value, item), Infinity)
  const maximum = high?.[2]
  add('elevation-profile', 'elevation-profile', '海拔剖面', elevationCount ? [`有效采样海拔约 ${number(minimum)}–${number(maximum!)} m。`, `累计上升约 ${number(gain)} m、下降约 ${number(loss)} m。`] : [],
    ['文件中的有效海拔；editedMetrics 在各连续段内统计，缺测高度不插值'], '将路线与海拔剖面并列，分段和缺测位置保留断开。',
    '固定路线全景，让进度在剖面与地图同步指示。', elevationCount ? `轨迹采样海拔约从 ${number(minimum)} 米到 ${number(maximum!)} 米，展示的是记录中的高度变化。` : '',
    12, undefined, elevationCount >= 2 ? [] : ['至少两个有效文件海拔样本'])
  add('high-point', 'high-point', '最高采样点', high ? [`第 ${highIndex + 1} 个轨迹点，文件海拔约 ${number(high[2]!)} m。`, `坐标 ${location(high)}；不是已验证山顶。`] : [],
    ['在当前有效轨迹海拔样本中取最大值；未查证山峰资料'], '突出最高轨迹采样点及其在路线中的位置。', '缓慢聚焦采样点，保留附近路线作为参照。',
    high ? `这里是当前轨迹记录中的最高采样点，文件海拔约 ${number(high[2]!)} 米。` : '', 8,
    high ? {pointIndex: highIndex, coordinates: coordinate(high)} : undefined, high ? [] : ['有效文件海拔'])
  for (const [direction, kind, name] of [[1, 'climb-section', '上升'], [-1, 'descent-section', '下降']] as const) {
    const sections = heightSections(runs, direction)
    sections.forEach((section, index) => add(`${kind}-${index + 1}`, kind, `连续${name}采样段 ${index + 1}`,
      [`第 ${section.start + 1}–${section.end + 1} 个轨迹点，连续样本净${name}约 ${number(section.change)} m。`],
      ['同一连接段内至少三个连续有效海拔样本；单调高度变化至少 20 m；不代表坡度或技术难度'],
      `突出这段路线与对应海拔变化，不跨轨迹分段。`, '先展示该段范围，再沿段推进。',
      `这段连续轨迹采样记录了约 ${number(section.change)} 米的净${name}。`, 10,
      {pointIndex: section.start, endIndex: section.end, coordinates: coordinate(track.coordinates[section.start])}))
    if (!sections.length) add(`${kind}-missing`, kind, `${name}段（待补或确认）`, ['未找到满足连续有效海拔、至少三个点和 20 m 净变化条件的采样段。'],
      ['保守的本地海拔采样规则，不跨缺测或 segmentStarts'], `确认需要展示的${name}范围后再编排。`, '待选定实际轨迹段。', '', 10, undefined,
      [elevationCount ? `确认需要展示的${name}范围，或补充更完整海拔采样` : '有效文件海拔'])
  }
  const firstRun = runs[0], lastRun = runs[runs.length - 1]
  if (firstRun) {
    const first = firstRun.points[0]
    add('start', 'placemark', '轨迹起点', [`第 ${firstRun.start + 1} 个轨迹点，坐标 ${location(first)}。`, '轨迹起点不能自动视为集合或住宿地点。'],
      ['当前轨迹首个有效坐标'], '显示路线起点；集合信息另行确认。', '聚焦起点后展开附近路线。', '从轨迹记录的起点开始，看清路线出发方向。', 8,
      {pointIndex: firstRun.start, coordinates: coordinate(first)})
  }
  add('preparation', 'preparation', '集合与出发准备（待补）', [], ['轨迹起点和标注文字不能证明集合安排、住宿或设施现状'],
    '聚焦确认后的集合点，展示时间、交通或住宿说明。', '从区域位置推近实际集合点，避免默认为轨迹起点。', '', 10, undefined,
    ['已确认的集合地点与时间', '住宿、休息安排及有效说明（如需展示）'], ['用户确认的地点、说明与照片'])
  add('surrounding-peaks', 'surrounding-peaks', '周边山峰介绍（待补资料）', [], ['最高轨迹采样点和用户点位名称不能替代山峰名称、峰位、海拔依据'],
    '展示已核实的周边山峰名称、峰位与路线关系。', '按确认的目标峰缓慢环绕，标签避免遮挡路线。', '', 12, undefined,
    ['山峰名称、真实峰位和海拔依据', '来源或用户确认；区域地形范围'], ['山峰资料及可用区域高程'])
  if (lastRun) {
    const pointIndex = lastRun.start + lastRun.points.length - 1, end = lastRun.points[lastRun.points.length - 1]
    add('finish', 'finish', '路线终点与收尾', [`第 ${pointIndex + 1} 个轨迹点，坐标 ${location(end)}。`], ['当前轨迹最后一个有效坐标；没有推断撤退或交通条件'],
      '定位终点后回到整体路线，显示已确认的距离与高度信息。', '从终点缓慢拉回全景。', `回到路线全景，看清${trackName}的起终点与整段行程。`, 8,
      {pointIndex, coordinates: coordinate(end)})
  }
  const stops = runs.flatMap((run, index) => reports[index].restCandidates.map(stop => ({...stop, startIndex: run.start + stop.startIndex, endIndex: run.start + stop.endIndex}))).slice(0, 6)
  stops.forEach((stop, index) => add(`recorded-stop-${index + 1}`, 'recorded-stop', `时间采样停留候选 ${index + 1}`,
    [`第 ${stop.startIndex + 1}–${stop.endIndex + 1} 个采样点在 30 m 范围内持续约 ${(stop.duration / 60000).toFixed(1)} 分钟。`, '只表示连续时间采样，不证明休息、补给或设施。'],
    ['analyzeTrack：至少三个真实时间采样；相邻时间递增且间隔不超过 5 分钟；未跨分段'],
    '经确认后显示停留点及对应说明。', '聚焦实际采样范围，路线推进暂停。', '', 8,
    {pointIndex: stop.startIndex, endIndex: stop.endIndex, coordinates: [stop.lon, stop.lat]}, ['用户确认是否实际停留及停留原因']))
  if (!stops.length && !timeCount) add('recorded-stop-missing', 'recorded-stop', '时间停留分析（缺时间）', [], ['当前轨迹无有效时间戳'],
    '补充真实时间采样后再分析停留。', '未有数据，暂不编排。', '', 8, undefined, ['连续有效时间戳；不能从坐标重复推断休息'])
  visible.forEach((point, index) => {
    const name = clean(point.name || `点位 ${index + 1}`, 160), count = photos(point.images)
    const types = Array.isArray(point.type) ? point.type.join('、') : point.type || ''
    add(`placemark-${point.id}`, 'placemark', name, [`用户独立点位，坐标 ${location(point.coordinates)}。`, ...(types ? [`用户分类：${clean(types, 100)}。`] : []),
      ...(point.description ? [`用户说明：${description(point.description)}（未外部核验）。`] : []), `关联照片 ${count} 张。`],
      [`当前可见独立点位 ${point.id}；使用该点原始坐标，不吸附到轨迹`], '显示独立点位与路线的相对位置；照片由用户另行选择。',
      '聚焦该点的真实坐标，同时保留路线参照。', `这里是你标注的${name}。`, 8,
      {placemarkId: point.id, coordinates: [...point.coordinates]}, [], count ? [`已有照片 ${count} 张（未读取内容）`] : [])
  })
  validAnnotations.forEach((annotation, index) => {
    const target = annotation.sourceCoordinates ? {coordinates: [...annotation.sourceCoordinates] as [number, number]}
      : {pointIndex: annotation.pointIndex, coordinates: coordinate(track.coordinates[annotation.pointIndex])}
    const name = clean(annotation.label || `标注 ${index + 1}`, 160), count = photos(annotation.imageUrls, annotation.photo)
    add(`annotation-${annotation.id}`, 'annotation', name, [`用户已有标注${annotation.kind ? `，类别 ${annotation.kind}` : ''}。`,
      ...(annotation.description ? [`用户说明：${description(annotation.description)}（未外部核验）。`] : []), `关联照片 ${count} 张。`],
      [annotation.sourceCoordinates ? `已有标注 ${annotation.id} 保留其独立来源坐标` : `已有标注 ${annotation.id} 对应轨迹点 ${annotation.pointIndex + 1}`],
      '呈现已保存的标注名称、说明及用户选定照片。', '聚焦标注目标，保证文字与路线清楚。', `这里是你标注的${name}。`, 8, target, [],
      count ? [`已有照片 ${count} 张（未读取内容）`] : [])
  })
  if (candidates.length > MAX_VIDEO_CANDIDATES) limitations.push(`候选共 ${candidates.length} 个，当前显示前 ${MAX_VIDEO_CANDIDATES} 个；请减少点位或聚焦重点内容。`)
  return {trackId: track.id, trackName, pointCount: track.coordinates.length, fingerprint: fingerprint(track, annotations, placemarks), summary, limitations, candidates: candidates.slice(0, MAX_VIDEO_CANDIDATES)}
}

export function createVideoScriptDraft(analysis: VideoScriptAnalysis, candidateIds: readonly string[], notes = ''): VideoScriptDraft {
  if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > MAX_VIDEO_SHOTS || new Set(candidateIds).size !== candidateIds.length) throw new Error(`请选择 1 至 ${MAX_VIDEO_SHOTS} 个不同镜头`)
  const shots: VideoScriptShot[] = candidateIds.map((id, index) => {
    const candidate = analysis.candidates.find(item => item.id === id)
    if (!candidate) throw new Error('镜头候选不存在，请重新分析轨迹')
    if (candidate.readiness !== 'ready' || candidate.missing.length) throw new Error(`“${candidate.title}”仍有待补信息，不能自动纳入草稿`)
    return {id: `shot-${index + 1}`, candidateId: candidate.id, kind: candidate.kind, title: candidate.title,
      duration: candidate.duration, visual: candidate.visual, camera: candidate.camera, narration: candidate.draftNarration,
      onScreenText: candidate.onScreenText, materials: [...candidate.materials], confirmed: false,
      ...(candidate.target ? {target: structuredClone(candidate.target)} : {})}
  })
  return validateVideoScriptDraft({version: 1, trackId: analysis.trackId, fingerprint: analysis.fingerprint,
    title: `${analysis.trackName} · 视频脚本草稿`, notes, shots}, analysis)
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, maximum = MAX_TEXT, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) || required && !value.trim()) throw new Error(`${label}格式无效或过长`)
  return value.trim()
}
function targetValue(value: unknown): VideoSceneTarget | undefined {
  if (value === undefined) return undefined
  const raw = object(value, '镜头目标格式无效')
  if (!Object.keys(raw).length || Object.keys(raw).some(key => !['pointIndex', 'endIndex', 'coordinates', 'placemarkId'].includes(key))) throw new Error('镜头目标字段无效')
  const target: VideoSceneTarget = {}
  for (const key of ['pointIndex', 'endIndex'] as const) if (raw[key] !== undefined) {
    if (typeof raw[key] !== 'number' || !Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] >= 500_000) throw new Error('镜头轨迹点序号无效')
    target[key] = raw[key]
  }
  if (target.endIndex !== undefined && (target.pointIndex === undefined || target.endIndex < target.pointIndex)) throw new Error('镜头轨迹段范围无效')
  if (raw.coordinates !== undefined) {
    if (!validCoordinates(raw.coordinates) || raw.coordinates.length !== 2) throw new Error('镜头坐标无效')
    target.coordinates = [...raw.coordinates]
  }
  if (raw.placemarkId !== undefined) {
    target.placemarkId = text(raw.placemarkId, '点位编号', 128, true)
    if (target.pointIndex !== undefined || target.endIndex !== undefined) throw new Error('独立点位不能伪装成轨迹点')
  }
  return target
}
function equalTargets(a: VideoSceneTarget | undefined, b: VideoSceneTarget | undefined) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b))
}

/** Cached drafts and model responses pass through the same strict, bounded boundary. */
export function validateVideoScriptDraft(value: unknown, analysis?: VideoScriptAnalysis): VideoScriptDraft {
  const raw = object(value, '视频脚本草稿格式无效')
  if (raw.version !== 1) throw new Error('不支持的视频脚本版本')
  const trackId = text(raw.trackId, '轨迹编号', 128, true), key = text(raw.fingerprint, '数据指纹', 100, true)
  if (analysis && (trackId !== analysis.trackId || key !== analysis.fingerprint)) throw new Error('轨迹或点位已改变，请重新分析并确认脚本')
  if (!Array.isArray(raw.shots) || raw.shots.length < 1 || raw.shots.length > MAX_VIDEO_SHOTS) throw new Error(`脚本需包含 1 至 ${MAX_VIDEO_SHOTS} 个镜头`)
  const ids = new Set<string>(), selected = new Set<string>()
  let total = 0
  const shots = raw.shots.map(value => {
    const shot = object(value, '镜头格式无效')
    const id = text(shot.id, '镜头编号', 128, true), candidateId = text(shot.candidateId, '候选编号', 200, true)
    if (ids.has(id) || selected.has(candidateId)) throw new Error('镜头或候选编号重复')
    ids.add(id); selected.add(candidateId)
    if (typeof shot.kind !== 'string' || !(VIDEO_SCENE_KINDS as readonly string[]).includes(shot.kind)) throw new Error('镜头类型无效')
    if (typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration < 3 || shot.duration > 120) throw new Error('每个镜头时长需为 3 至 120 秒')
    total += shot.duration
    if (typeof shot.confirmed !== 'boolean') throw new Error('镜头确认状态必须为布尔值')
    if (!Array.isArray(shot.materials) || shot.materials.length > 24) throw new Error('镜头素材说明格式无效')
    const target = targetValue(shot.target)
    if (analysis) {
      if (target && [target.pointIndex, target.endIndex].some(index => index !== undefined && index >= analysis.pointCount)) throw new Error('镜头轨迹点超出当前轨迹')
      const candidate = analysis.candidates.find(item => item.id === candidateId)
      if (!candidate || candidate.kind !== shot.kind) throw new Error('镜头候选不存在或类型不匹配')
      if (candidate.readiness !== 'ready' || candidate.missing.length) throw new Error('待补信息的候选不能纳入可确认草稿')
      if (!equalTargets(target, candidate.target)) throw new Error('镜头目标与真实候选数据不匹配')
    }
    return {id, candidateId, kind: shot.kind as VideoSceneKind, duration: shot.duration, confirmed: shot.confirmed,
      title: text(shot.title, '镜头标题', 160, true), visual: text(shot.visual, '画面', 1600), camera: text(shot.camera, '运镜', 1000),
      narration: text(shot.narration, '旁白', 1200), onScreenText: text(shot.onScreenText, '屏幕文字', 600),
      materials: shot.materials.map(item => text(item, '素材说明', 600)), ...(target ? {target} : {})}
  })
  if (total > MAX_VIDEO_DURATION) throw new Error(`脚本总时长不能超过 ${MAX_VIDEO_DURATION} 秒`)
  return {version: 1, trackId, fingerprint: key, title: text(raw.title, '脚本标题', 160, true), notes: text(raw.notes, '补充要求', 4000), shots}
}

function markdown(value: string): string { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_[\]#|]/gu, '\\$&') }
export function videoScriptMarkdown(draft: VideoScriptDraft, analysis: VideoScriptAnalysis): string {
  const checked = validateVideoScriptDraft(draft, analysis)
  const lines = [`# ${markdown(checked.title)}`, '', '这是可编辑的本地视频脚本；每个镜头需确认后再制作。影片时长与 GPS 记录时间独立。', '',
    `轨迹：${markdown(analysis.trackName)}；数据指纹：${checked.fingerprint}`, '', '## 数据概况', '',
    ...analysis.summary.map(item => `- ${markdown(item)}`), '', '## 数据边界', '', ...analysis.limitations.map(item => `- ${markdown(item)}`), '',
    `建议总时长：${checked.shots.reduce((sum, shot) => sum + shot.duration, 0)} 秒。`, '']
  if (checked.notes) lines.push('## 补充要求', '', markdown(checked.notes), '')
  checked.shots.forEach((shot, index) => {
    const candidate = analysis.candidates.find(item => item.id === shot.candidateId)!
    lines.push(`## 镜头 ${index + 1}：${markdown(shot.title)}`, '', `时长：${shot.duration} 秒；状态：${shot.confirmed ? '已确认' : '待确认'}。`, '',
      `画面：${markdown(shot.visual)}`, '', `运镜：${markdown(shot.camera)}`, '', `旁白：${markdown(shot.narration) || '待填写'}`, '', `屏幕文字：${markdown(shot.onScreenText) || '无'}`, '')
    if (shot.target) {
      const target = shot.target
      lines.push(`目标：${target.placemarkId ? `独立点位 ${markdown(target.placemarkId)}` : target.pointIndex !== undefined ? `轨迹点 ${target.pointIndex + 1}${target.endIndex !== undefined ? ` 至 ${target.endIndex + 1}` : ''}` : '独立地理坐标'}${target.coordinates ? `；坐标 ${location(target.coordinates)}` : ''}。`, '')
    }
    lines.push('事实与依据：', '', ...candidate.facts.map(item => `- ${markdown(item)}`), ...candidate.evidence.map(item => `- 依据：${markdown(item)}`), '')
    if (shot.materials.length) lines.push('素材要求：', '', ...shot.materials.map(item => `- ${markdown(item)}`), '')
  })
  const pending = analysis.candidates.filter(candidate => candidate.readiness === 'needs-info')
  if (pending.length) lines.push('## 未采用的待补镜头', '', ...pending.map(candidate => `- ${markdown(candidate.title)}：${candidate.missing.map(markdown).join('；')}`), '')
  return lines.join('\n')
}


