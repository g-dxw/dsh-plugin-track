/** Same-origin prompt rewriting. Sends resource identities; original image bytes stay host-side. */
import {API} from '../protocol.ts'
import {RESOURCE_ID} from '../track/resources.ts'
import {IMAGE_PROMPT_TIMEOUT_MS, type ImagePromptModelCatalog, type ImagePromptOptimizationRequest, type ImagePromptOptimizationResponse} from '../track/image-prompt.ts'
const TIMEOUT_MS = 65_000
function record(value: unknown): Record<string, unknown> | null {return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null}
function canceled() {return new DOMException('提示词优化已取消', 'AbortError')}
async function request(action: string, body?: unknown, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw canceled()
  const controller = new AbortController(), abort = () => controller.abort()
  let timedOut = false
  signal?.addEventListener('abort', abort, {once: true})
  const timer = setTimeout(() => {timedOut = true; controller.abort()}, timeoutMs)
  try {
    const response = await fetch(`${API}/${action}`, {method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal,
      ...(body === undefined ? {} : {headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify(body)})})
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('提示词优化服务暂未就绪，请重启轨迹插件后重试')
    const result = record(await response.json().catch(() => undefined))
    if (controller.signal.aborted) throw canceled()
    if (!result) throw new Error('提示词优化服务返回的数据无效')
    if (!response.ok || result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : `提示词优化失败（HTTP ${response.status}）`)
    return result
  } catch (error) {
    if (signal?.aborted) throw canceled()
    if (timedOut) throw new Error('等待提示词优化服务返回超时，原提示词已保留；请重试或更换模型')
    throw error instanceof Error ? error : new Error('无法连接提示词优化服务')
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort)}
}
export async function loadImagePromptModels(signal?: AbortSignal): Promise<ImagePromptModelCatalog> {
  const found = await request('resource-prompt-models', undefined, signal)
  if (!Array.isArray(found.models) || typeof found.available !== 'boolean') throw new Error('提示词优化模型目录格式无效')
  const models = found.models.map(raw => {
    const model = record(raw)
    if (!model || typeof model.id !== 'string' || !model.id.trim() || typeof model.label !== 'string' || !model.label.trim() || typeof model.supportsVision !== 'boolean') throw new Error('提示词优化模型目录格式无效')
    return {id: model.id, label: model.label, supportsVision: model.supportsVision}
  })
  return {models, available: found.available,
    ...(typeof found.defaultModel === 'string' && models.some(model => model.id === found.defaultModel) ? {defaultModel: found.defaultModel} : {}),
    ...(typeof found.message === 'string' ? {message: found.message} : {})}
}
export async function optimizeImagePrompt(trackId: string, input: ImagePromptOptimizationRequest, signal?: AbortSignal): Promise<ImagePromptOptimizationResponse> {
  if (signal?.aborted) throw canceled()
  if (!RESOURCE_ID.test(trackId)) throw new Error('当前轨迹编号无效')
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) throw new Error('请选择提示词优化模型')
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw new Error('待优化提示词需为 1–20000 个字符')
  if (input.requirements !== undefined && (typeof input.requirements !== 'string' || input.requirements.length > 4000)) throw new Error('补充要求最多 4000 个字符')
  if (!Array.isArray(input.references) || input.references.length > 5 || input.references.some(item => !item || typeof item.assetId !== 'string' || !RESOURCE_ID.test(item.assetId) || !['subject', 'effect'].includes(item.role)) || new Set(input.references.map(item => item.assetId)).size !== input.references.length) throw new Error('请选择最多 5 张不重复的主体或效果参考图')
  // Explicit serialization excludes URLs, base64, source files and unrelated assets.
  const payload: ImagePromptOptimizationRequest = {model: input.model.trim(), prompt: input.prompt,
    ...(input.requirements === undefined ? {} : {requirements: input.requirements}), references: input.references.map(({assetId, role}) => ({assetId, role}))}
  const found = await request(`resource-prompt-optimize?id=${encodeURIComponent(trackId)}`, payload, signal, IMAGE_PROMPT_TIMEOUT_MS + 15_000)
  if (typeof found.prompt !== 'string' || !found.prompt.trim() || found.prompt.length > 20000 || !Array.isArray(found.changes) || found.changes.length > 12 || found.changes.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error('优化后的提示词格式无效，原提示词已保留')
  return {prompt: found.prompt, changes: found.changes as string[]}
}
