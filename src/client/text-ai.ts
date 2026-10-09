/** Browser-side same-origin text AI calls. Generation starts only when a caller submits. */
import { API } from '../protocol.ts'
import type { AnimationScript, AnimationShot, RouteAIAnalysis, RouteAIContext, TextAIRequest, TextModelCatalog } from '../ai.ts'

const CLIENT_TIMEOUT_MS = 65_000
const UNAVAILABLE = '文本 AI 服务暂未就绪，请在 DSH 中启用账号服务后重试'
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function canceled(): DOMException {return new DOMException('AI 请求已取消', 'AbortError')}
async function request(action: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw canceled()
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, {once: true})
  const timer = setTimeout(() => {timedOut = true; controller.abort()}, CLIENT_TIMEOUT_MS)
  try {
    const response = await fetch(`${API}/${action}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal,
      ...(body === undefined ? {} : {headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify(body)}),
    })
    if (response.status === 404 || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error(UNAVAILABLE)
    const value = record(await response.json().catch(() => undefined))
    if (!value) throw new Error('文本 AI 服务返回数据格式无效，请重试')
    if (!response.ok || value.ok === false) throw new Error(typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : `AI 请求失败（HTTP ${response.status}）`)
    return value
  } catch (error) {
    if (signal?.aborted) throw canceled()
    if (timedOut) throw new Error('文本模型响应超时，请重试或选择其他模型')
    if (error instanceof Error) throw error
    throw new Error('无法连接文本 AI 服务，请稍后重试')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
export async function loadTextModels(signal?: AbortSignal): Promise<TextModelCatalog> {
  const found = await request('text-models', undefined, signal)
  if (!Array.isArray(found.models) || typeof found.available !== 'boolean') throw new Error('文本模型目录格式无效，请刷新重试')
  const models = found.models.map(raw => {
    const model = record(raw)
    if (!model || typeof model.id !== 'string' || !model.id.trim() || typeof model.label !== 'string' || !model.label.trim()) throw new Error('文本模型目录格式无效，请刷新重试')
    return {id: model.id, label: model.label}
  })
  return {
    models, available: found.available,
    ...(typeof found.defaultModel === 'string' && models.some(model => model.id === found.defaultModel) ? {defaultModel: found.defaultModel} : {}),
    ...(typeof found.message === 'string' ? {message: found.message} : {}),
  }
}
/** Only the explicitly allowed summary is serialized; source files/photos stay local. */
function summary(context: RouteAIContext): RouteAIContext {
  return {
    name: context.name, pointCount: context.pointCount, distance: context.distance,
    elevationGain: context.elevationGain, elevationLoss: context.elevationLoss, elevationMin: context.elevationMin, elevationMax: context.elevationMax, duration: context.duration,
    elevationCoverage: context.elevationCoverage, timestampCoverage: context.timestampCoverage,
    coordinates: context.coordinates.map(({index, lon, lat, elevation}) => ({index, lon, lat, elevation})),
    annotations: context.annotations.map(({pointIndex, label, kind}) => ({pointIndex, label, ...(kind === undefined ? {} : {kind})})),
    restCandidates: context.restCandidates.map(({startIndex, endIndex, duration}) => ({startIndex, endIndex, duration})), userNotes: context.userNotes,
  }
}
function payload(input: TextAIRequest): TextAIRequest {
  if (!input.model.trim()) throw new Error('请选择文本模型')
  return {model: input.model.trim(), context: summary(input.context)}
}
export async function analyzeRoute(input: TextAIRequest, signal?: AbortSignal): Promise<RouteAIAnalysis> {
  const found = await request('analyze', payload(input), signal)
  if (typeof found.difficulty !== 'string' || !found.difficulty.trim() || typeof found.summary !== 'string' || !found.summary.trim()) throw new Error('AI 分析数据不完整，请重新生成')
  const list = (name: string): string[] => {
    const value = found[name]
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error('AI 分析数据不完整，请重新生成')
    return value as string[]
  }
  return {difficulty: found.difficulty, summary: found.summary, audience: list('audience'), equipment: list('equipment'), checkpoints: list('checkpoints'), restPoints: list('restPoints'), limitations: list('limitations')}
}
export async function generateAnimationScript(input: TextAIRequest, signal?: AbortSignal): Promise<AnimationScript> {
  const found = await request('animation-script', payload(input), signal)
  if (typeof found.title !== 'string' || !found.title.trim() || !Array.isArray(found.shots) || found.shots.length < 2 || found.shots.length > 12) throw new Error('AI 动画脚本格式无效，请重新生成')
  const allowedPoints = new Set([...input.context.coordinates.map(point => point.index), ...input.context.annotations.map(annotation => annotation.pointIndex)])
  const shots: AnimationShot[] = found.shots.map(raw => {
    const shot = record(raw)
    if (!shot || (shot.type !== 'overview' && shot.type !== 'follow' && shot.type !== 'checkpoint') || typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration < 3 || shot.duration > 30) throw new Error('AI 镜头类型或时长无效，请重新生成')
    if ((shot.type === 'checkpoint' && shot.pointIndex === undefined) || (shot.pointIndex !== undefined && (typeof shot.pointIndex !== 'number' || !Number.isInteger(shot.pointIndex) || shot.pointIndex < 0 || shot.pointIndex >= input.context.pointCount)) || (shot.type === 'checkpoint' && !allowedPoints.has(shot.pointIndex as number))) throw new Error('AI 镜头点序号无效，请重新生成')
    if (shot.narration !== undefined && typeof shot.narration !== 'string') throw new Error('AI 镜头旁白格式无效，请重新生成')
    return {type: shot.type, duration: shot.duration, ...(typeof shot.pointIndex === 'number' ? {pointIndex: shot.pointIndex} : {}), ...(typeof shot.narration === 'string' ? {narration: shot.narration} : {})}
  })
  if (!shots.some(shot => shot.type === 'overview') || !shots.some(shot => shot.type === 'follow') || shots.reduce((total, shot) => total + shot.duration, 0) > 180) throw new Error('AI 脚本缺少全景或跟随镜头，或超过 180 秒，请重新生成')
  return {title: found.title, shots}
}

