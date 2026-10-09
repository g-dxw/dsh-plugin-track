/** Same-origin adapter for the installed DSH image-generation plugin. */

export interface ImagegenModel {
  /** User-facing alias accepted by the host, rather than an upstream model id. */
  id: string
  label: string
  channelId?: string
  upstreamId?: string
  /** Verified host forwarding limit for recognized CQAI model mappings; unknown stays unset. */
  maxReferenceImages?: number
  maxOutputImages?: number
  allowedSizes?: readonly string[]
  allowedQualities?: readonly string[]
  allowedDetails?: readonly string[]
  capabilityMessage?: string
}

export interface ResourceImageSettings {size: string; quality: string; n: number; detail: string}
export const IMAGEGEN_RESOURCE_SETTINGS_DEFAULT: ResourceImageSettings = {size: 'auto', quality: 'auto', n: 1, detail: ''}
export const IMAGEGEN_RESOURCE_SIZES = ['auto', '1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9'] as const
export const IMAGEGEN_RESOURCE_QUALITIES = ['auto', '1k', '2k', '4k'] as const

export interface ImagegenCatalog {
  models: ImagegenModel[]
  defaultModel: string | null
  available: boolean
  message?: string
}

export interface ResourceImageInput {
  mode: 'edit' | 'text'
  prompt: string
  model: string
  image?: string
  /** Additional references in exact caller order; the primary remains in image. */
  images?: string[]
  channelId?: string
  settings?: ResourceImageSettings
  maxReferenceImages?: number
  maxOutputImages?: number
  allowedSizes?: readonly string[]
  allowedQualities?: readonly string[]
  allowedDetails?: readonly string[]
}

export interface TrackArtInput extends Omit<ResourceImageInput, 'mode' | 'image'> {
  image: string
}

export interface TrackArtTask {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  images: {dataUrl: string; revisedPrompt?: string}[]
  error?: string
}

export class ImagegenError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ImagegenError'
  }
}

const API = '/api/dsh-imagegen'
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const MAX_REFERENCE_IMAGES = 5
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024
const UNAVAILABLE = '生图插件未启用或不可用，请在插件管理中启用生图功能'
type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null
}

function failure(message: string, code = 'invalid-response'): ImagegenError {
  return new ImagegenError(message, code)
}

/** The desktop renderer supplies its own access capability; never copy keys here. */
async function post(path: string, body?: unknown): Promise<RecordValue> {
  let response: Response
  try {
    response = await fetch(`${API}/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      ...(body === undefined ? {} : {
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      }),
    })
  } catch {
    throw failure('无法连接生图服务，请检查应用和网络后重试', 'network-error')
  }
  if (response.status === 404 || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    if (response.status === 403) throw failure('访问生图服务被拒绝，请在 DSH 应用中重试', 'access-denied')
    throw failure(UNAVAILABLE, 'plugin-unavailable')
  }
  let envelope: RecordValue | null
  try {
    envelope = record(await response.json())
  } catch {
    throw failure('生图服务返回了无效数据，请稍后重试')
  }
  if (!envelope) throw failure('生图服务返回了无效数据，请稍后重试')
  if (!response.ok || envelope.ok !== true) {
    throw failure(
      typeof envelope.message === 'string' && envelope.message.trim()
        ? envelope.message : `生图请求失败（HTTP ${response.status}）`,
      typeof envelope.code === 'string' ? envelope.code : 'request-failed',
    )
  }
  return envelope
}

/** Mirror only verified CQAI routing: forced OpenAI transport forwards at most five references. */
export function cqaiModelCapabilities(upstreamId: string): Pick<ImagegenModel, 'maxReferenceImages' | 'maxOutputImages' | 'capabilityMessage' | 'allowedSizes' | 'allowedQualities' | 'allowedDetails'> {
  const id = upstreamId.trim()
  const settings = {allowedSizes: IMAGEGEN_RESOURCE_SIZES, allowedQualities: IMAGEGEN_RESOURCE_QUALITIES, allowedDetails: ['', 'standard', 'high']}
  const known = /^(?:gpt-image|dall-e|grok-imagine(?:-|$)|nanobanana|(?:doubao-)?seedream|qwen-image(?:[-_.]|$)|(?:minimax[-_/])?image-\d+|glm-image|cogview(?:-|$))/iu.test(id)
    || new Set(['gemini-3-pro-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image']).has(id)
  if (!known) return {...settings, maxOutputImages: 4, capabilityMessage: '此模型的多参考图能力尚未核实；使用多图前请选择已核实的宿主模型'}
  if (id === 'dall-e-3') return {...settings, allowedSizes: ['auto', '1:1', '9:16', '16:9', '21:9'], allowedQualities: ['auto'], allowedDetails: [''], maxReferenceImages: 5, maxOutputImages: 1, capabilityMessage: '宿主对此模型仅保留支持的画幅、自动画质、默认细节和单张输出'}
  if (/^(?:glm-image|cogview(?:-|$))/iu.test(id)) return {...settings, maxReferenceImages: 0, maxOutputImages: 4, capabilityMessage: '此模型在宿主目录中仅支持文字生图'}
  return {...settings, maxReferenceImages: 5, maxOutputImages: 4, capabilityMessage: '宿主可按顺序传递最多 5 张参考图，模型是否接受以服务返回为准'}
}

/** Validate without invoking the host; never let the host silently slice references or clamp count. */
export function validateResourceImageInput(input: ResourceImageInput): {body: RecordValue; settings: ResourceImageSettings} {
  if (input.mode !== 'edit' && input.mode !== 'text') throw failure('图片生成模式无效', 'invalid-mode')
  const prompt = input.prompt.trim(), model = input.model.trim()
  if (!prompt) throw failure(input.mode === 'edit' ? '请填写图片美化要求' : '请填写生图提示词', 'prompt-required')
  if (!model) throw failure('请选择生图模型', 'model-required')
  const settings = {...IMAGEGEN_RESOURCE_SETTINGS_DEFAULT, ...input.settings}
  if (!IMAGEGEN_RESOURCE_SIZES.some(value => value === settings.size) || !IMAGEGEN_RESOURCE_QUALITIES.some(value => value === settings.quality)
    || !['', 'standard', 'high'].includes(settings.detail) || !Number.isInteger(settings.n) || settings.n < 1 || settings.n > 4) {
    throw failure('输出参数超出宿主支持范围，请调整后再生成', 'invalid-settings')
  }
  const capabilities = cqaiModelCapabilities(model)
  const allowedSizes = capabilities.allowedSizes!.filter(value => !input.allowedSizes || input.allowedSizes.includes(value))
  const allowedQualities = capabilities.allowedQualities!.filter(value => !input.allowedQualities || input.allowedQualities.includes(value))
  const allowedDetails = capabilities.allowedDetails!.filter(value => !input.allowedDetails || input.allowedDetails.includes(value))
  if (!allowedSizes.includes(settings.size) || !allowedQualities.includes(settings.quality) || !allowedDetails.includes(settings.detail)) {
    throw failure('当前宿主模型不支持这些输出参数，请调整保留的历史参数后再生成', 'unsupported-settings')
  }
  const maxOutputImages = Math.min(input.maxOutputImages ?? 4, capabilities.maxOutputImages ?? 4)
  if (maxOutputImages !== undefined && settings.n > maxOutputImages) throw failure('此宿主模型不支持当前出图数量，请调整数量后再生成', 'unsupported-count')
  if (input.channelId?.trim() && input.channelId.trim() !== 'cqai' && (settings.size !== 'auto' || settings.quality !== 'auto' || settings.n !== 1 || settings.detail !== '')) {
    throw failure('该历史通道的输出参数能力尚未核实，请保留历史值并显式选择已核实的宿主模型通道', 'settings-channel-unverified')
  }
  const references = input.mode === 'edit' ? [input.image ?? '', ...(input.images ?? [])] : []
  if (references.length > 1 && input.channelId?.trim() && input.channelId.trim() !== 'cqai') throw failure('该历史通道的多参考图传递能力尚未核实，请显式选择已核实的宿主模型通道', 'reference-channel-unverified')
  if (references.length > MAX_REFERENCE_IMAGES) throw failure('宿主最多支持 5 张参考图，请减少参考图后再生成', 'too-many-references')
  if (references.length > 1 && input.maxReferenceImages === undefined) throw failure('当前模型的多参考图能力尚未核实，请选择支持多参考图的宿主模型', 'reference-capability-unknown')
  if (input.maxReferenceImages !== undefined && references.length > input.maxReferenceImages) throw failure('当前宿主模型不支持所选参考图数量，请调整参考图或切换模型', 'reference-capacity-exceeded')
  for (const reference of references) validateReference(reference)
  const body: RecordValue = {
    mode: input.mode, prompt, model,
    ...(input.mode === 'edit' ? {image: references[0].trim(), ...(references.length > 1 ? {images: references.slice(1).map(value => value.trim())} : {})} : {}),
    channelId: input.channelId?.trim() || 'cqai', ...settings,
  }
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_JSON_BODY_BYTES) throw failure('参考图片合计过大，超过宿主 24 MiB 请求上限；请缩小图片后重试', 'reference-batch-too-large')
  return {body, settings}
}

/** Reading the catalog does not submit a generation or change provider settings. */
export async function loadImagegenCatalog(): Promise<ImagegenCatalog> {
  try {
    const envelope = await post('cqai/provider', {refresh: false})
    const provider = record(envelope.provider)
    if (!provider || !Array.isArray(provider.models)) throw failure('生图模型目录格式无效，请稍后重试')
    const models: ImagegenModel[] = []
    const upstreamToAlias = new Map<string, string>()
    for (const value of provider.models) {
      const mapping = record(value)
      if (!mapping || typeof mapping.alias !== 'string' || !mapping.alias.trim()
        || typeof mapping.id !== 'string' || !mapping.id.trim()) continue
      const alias = mapping.alias.trim()
      if (!models.some(model => model.id === alias)) models.push({id: alias, label: alias, channelId: 'cqai', upstreamId: mapping.id, ...cqaiModelCapabilities(mapping.id)})
      upstreamToAlias.set(mapping.id, alias)
    }
    const selected = typeof provider.defaultModel === 'string' ? provider.defaultModel : ''
    const defaultModel = upstreamToAlias.get(selected)
      ?? models.find(model => model.id === selected)?.id
      ?? (models.length === 1 ? models[0].id : null)
    if (provider.state !== 'signed-in') {
      const message = typeof provider.message === 'string' && provider.message.trim()
        ? provider.message
        : provider.state === 'reauth-required' ? 'CQAI 登录已过期，请重新登录后生成图片'
          : provider.state === 'authorizing' ? 'CQAI 正在登录，请完成登录后重试'
            : provider.state === 'signed-out' ? '请先登录 CQAI 账号以使用生图功能'
              : 'CQAI 生图服务暂不可用，请稍后重试'
      return {models, defaultModel, available: false, message}
    }
    if (!models.length) return {models, defaultModel: null, available: false, message: '当前账号没有可用的生图模型'}
    return {
      models, defaultModel, available: true,
      ...(typeof provider.warning === 'string' && provider.warning.trim() ? {message: provider.warning} : {}),
    }
  } catch (error) {
    return {models: [], defaultModel: null, available: false, message: error instanceof Error ? error.message : UNAVAILABLE}
  }
}

function base64(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s/gu, '')
  return compact && /^[A-Za-z0-9+/]+={0,2}$/u.test(compact) && compact.length % 4 === 0 ? compact : null
}

function validateReference(image: string): void {
  const matched = typeof image === 'string' ? /^data:image\/(?:png|jpeg|webp);base64,(.*)$/su.exec(image.trim()) : null
  const payload = base64(matched?.[1])
  if (!payload) throw failure('请提供 PNG、JPEG 或 WebP 格式的照片参考图', 'invalid-reference')
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  if (payload.length / 4 * 3 - padding > MAX_REFERENCE_BYTES) {
    throw failure('照片参考图不能超过 10 MiB，请缩小图片后重试', 'reference-too-large')
  }
}

/** Call only for an explicit user submission; no automatic retries or reference truncation. */
export async function submitResourceImage(input: ResourceImageInput): Promise<{taskId: string}> {
  const {body} = validateResourceImageInput(input)
  const envelope = await post('tasks/submit', body)
  const task = record(envelope.task)
  if (!task || typeof task.id !== 'string' || !task.id.trim()) throw failure('生图服务没有返回任务编号，请查看 e图宝 任务后再重试')
  return {taskId: task.id}
}

/** Retained for existing track-map and point-photo workflows. */
export async function submitTrackArt(input: TrackArtInput): Promise<{taskId: string}> {
  return submitResourceImage({...input, mode: 'edit'})
}

/** The host lists its queue; return only the task this panel explicitly owns. */
export async function loadTrackArtTask(taskId: string): Promise<TrackArtTask> {
  if (!taskId.trim()) throw failure('生图任务编号无效', 'invalid-task')
  const envelope = await post('tasks/list')
  if (!Array.isArray(envelope.tasks)) throw failure('生图任务列表格式无效，请稍后重试')
  let task = envelope.tasks.map(record).find(item => item?.id === taskId)
  if (!task || task.status === 'completed' && task.resultAvailable === true && !record(task.result)) {
    // Summaries omit results and cap recent terminal tasks; retrieve only our owned task.
    let detail: RecordValue
    try {detail = await post('tasks/get', {id: taskId})}
    catch (error) {
      if (!task && error instanceof ImagegenError && error.code === 'not-found') {
        return {status: 'failed', images: [], error: '生图任务不存在或已过期，请重新生成'}
      }
      throw error
    }
    const fullTask = record(detail.task)
    if (!fullTask || fullTask.id !== taskId) throw failure('生图任务详情不匹配，请稍后重试')
    task = fullTask
  }
  const status = task.status === 'cancelled' ? 'canceled' : task.status
  if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'canceled') {
    throw failure('生图任务状态无效，请稍后重试')
  }
  const images: TrackArtTask['images'] = []
  if (status === 'completed') {
    const result = record(task.result)
    if (Array.isArray(result?.images)) for (const value of result.images) {
      const image = record(value)
      const payload = base64(image?.b64)
      if (!image || !payload || typeof image.mime !== 'string'
        || !/^image\/(?:png|jpeg|webp|gif|avif)$/iu.test(image.mime)) continue
      images.push({
        dataUrl: `data:${image.mime.toLowerCase()};base64,${payload}`,
        ...(typeof image.revisedPrompt === 'string' ? {revisedPrompt: image.revisedPrompt} : {}),
      })
    }
    if (!images.length) return {status: 'failed', images, error: '生图任务未返回可用图片，请重新生成'}
  }
  return {
    status, images,
    ...(typeof task.error === 'string' && task.error.trim() ? {error: task.error}
      : status === 'failed' ? {error: '图片生成失败，请稍后重试'} : {}),
  }
}

export async function cancelTrackArtTask(taskId: string): Promise<void> {
  if (!taskId.trim()) throw failure('生图任务编号无效', 'invalid-task')
  await post('tasks/cancel', {id: taskId})
}
