/** Same-origin adapter for the installed DSH image-generation plugin. */

export interface ImagegenModel {
  /** User-facing alias accepted by the host, rather than an upstream model id. */
  id: string
  label: string
  channelId?: string
}

export interface ImagegenCatalog {
  models: ImagegenModel[]
  defaultModel: string | null
  available: boolean
  message?: string
}

export interface TrackArtInput {
  prompt: string
  image: string
  model: string
  channelId?: string
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
      if (!models.some(model => model.id === alias)) models.push({id: alias, label: alias, channelId: 'cqai'})
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

/** Call only for an explicit user submission; one request produces one image. */
export async function submitTrackArt(input: TrackArtInput): Promise<{taskId: string}> {
  const prompt = input.prompt.trim()
  const model = input.model.trim()
  if (!prompt) throw failure('请填写图片美化要求', 'prompt-required')
  if (!model) throw failure('请选择生图模型', 'model-required')
  validateReference(input.image)
  const envelope = await post('tasks/submit', {
    mode: 'edit', prompt, model, image: input.image.trim(),
    channelId: input.channelId?.trim() || 'cqai',
    size: 'auto', quality: 'auto', n: 1, detail: '',
  })
  const task = record(envelope.task)
  if (!task || typeof task.id !== 'string' || !task.id.trim()) throw failure('生图服务没有返回任务编号，请稍后重试')
  return {taskId: task.id}
}

/** The host lists its queue; return only the task this panel explicitly owns. */
export async function loadTrackArtTask(taskId: string): Promise<TrackArtTask> {
  if (!taskId.trim()) throw failure('生图任务编号无效', 'invalid-task')
  const envelope = await post('tasks/list')
  if (!Array.isArray(envelope.tasks)) throw failure('生图任务列表格式无效，请稍后重试')
  const task = envelope.tasks.map(record).find(item => item?.id === taskId)
  if (!task) return {status: 'failed', images: [], error: '生图任务不存在或已过期，请重新生成'}
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
