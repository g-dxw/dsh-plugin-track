import {createHash, randomUUID} from 'node:crypto'
import {lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs'
import {isAbsolute, join, relative} from 'node:path'
import sharp from 'sharp'
import {ensureTrackAgentWorkspace, TrackAgentStoreError} from './track-agent-store.ts'
import {readResourceSelection, resourceFile} from './resource-store.ts'
import {RESOURCE_ID} from './track/resources.ts'
import {FEATURED_TRAVEL_TEMPLATES} from './track/featured-travel-templates.ts'
import {AGENT_IMAGE_REFERENCE_FILE_API, type AgentImageReference, type AgentImageReferenceInput} from './track/image-agent-references.ts'

export class AgentImageReferenceError extends Error {
  constructor(message: string, readonly status = 400) {super(message); this.name = 'AgentImageReferenceError'}
}
export interface AgentImageReferenceOptions {
  env?: NodeJS.ProcessEnv
  /** The registered host's actual loopback origin; never derived from a request Host header. */
  hostOrigin?: () => string
  /** Forwarded only from the admitted request to fixed endpoints on the same host. */
  desktopRendererAccess?: string
  signal?: AbortSignal
}
const DESKTOP_RENDERER_ACCESS = /^[A-Za-z0-9_-]{43}$/u
const SOURCE_IDS = new Set(['vibeui', 'canghe', 'handraw', 'prompt-signal', 'evolink'])
const REFERENCE_ID = /^image-[a-f0-9]{64}$/u
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_LIST_BYTES = 8 * 1024 * 1024
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
function record(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value)}
function invalid(message: string): never {throw new AgentImageReferenceError(message)}
function identifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(label + '无效')
  return value
}
function trackScope(value: unknown): string | undefined {
  return value == null ? undefined : identifier(value, RESOURCE_ID, '轨迹编号')
}
export function validateAgentImageReferenceInput(value: unknown): AgentImageReferenceInput {
  if (!record(value)) invalid('图片引用请求格式无效')
  const fields = value.kind === 'resource' ? ['kind', 'trackId', 'assetId'] : value.kind === 'featured' ? ['kind', 'key', 'trackId'] : value.kind === 'template' ? ['kind', 'sourceId', 'caseId', 'image', 'trackId'] : []
  if (!fields.length || Object.keys(value).some(key => !fields.includes(key))) invalid('图片引用请求包含无效字段')
  if (value.kind === 'resource') return {kind: 'resource', trackId: identifier(value.trackId, RESOURCE_ID, '轨迹编号'), assetId: identifier(value.assetId, RESOURCE_ID, '图片资源编号')}
  const scope = trackScope(value.trackId)
  if (value.kind === 'featured') return {kind: 'featured', key: identifier(value.key, CASE_ID, '精选模板编号'), ...(scope === undefined ? {} : {trackId: scope})}
  if (typeof value.sourceId !== 'string' || !SOURCE_IDS.has(value.sourceId)) invalid('模板来源无效')
  const caseId = identifier(value.caseId, CASE_ID, '模板案例编号')
  if (value.image !== undefined && (typeof value.image !== 'string' || !value.image || value.image.length > 4000 || /\u0000/u.test(value.image))) invalid('模板图片标识无效')
  return {kind: 'template', sourceId: value.sourceId, caseId, ...(value.image === undefined ? {} : {image: value.image as string}), ...(scope === undefined ? {} : {trackId: scope})}
}
function canceled(signal?: AbortSignal): void {if (signal?.aborted) throw new AgentImageReferenceError('图片引用准备已取消', 499)}
function hostOrigin(options: AgentImageReferenceOptions): string {
  let origin: URL
  try {origin = new URL(options.hostOrigin?.() ?? '')} catch {throw new AgentImageReferenceError('当前宿主图片服务不可用，请在 DSH 中重试', 503)}
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !origin.port) throw new AgentImageReferenceError('宿主图片服务地址无效', 503)
  return origin.origin
}
/** Only fixed host endpoints receive requests; redirects and arbitrary caller URLs are never followed. */
async function hostRequest(options: AgentImageReferenceOptions, path: string, limit: number, body?: unknown): Promise<Buffer> {
  const origin = hostOrigin(options), timeout = AbortSignal.timeout(15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const headers: Record<string, string> = body === undefined ? {} : {'content-type': 'application/json'}
    // Node fetch does not inherit the Electron network session's Desktop admission capability.
    // Carry only this header to the fixed host endpoints; never persist or return it with the image.
    if (options.desktopRendererAccess && DESKTOP_RENDERER_ACCESS.test(options.desktopRendererAccess)) headers['x-dsh-desktop-renderer'] = options.desktopRendererAccess
    const response = await fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal, headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)})})
    if (!response.ok || !response.body) throw new AgentImageReferenceError(response.status === 404 ? '模板参考图片不存在或尚未缓存，请在模板库重试' : `宿主模板图片服务不可用（HTTP ${response.status}），请稍后重试`, response.status === 404 ? 404 : 502)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) throw new AgentImageReferenceError('模板图片或索引超过大小上限', 413)
    reader = response.body.getReader(); const parts: Buffer[] = []; let size = 0
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new AgentImageReferenceError('模板图片或索引超过大小上限', 413)
      parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts, size)
  } catch (error) {
    canceled(options.signal)
    if (error instanceof AgentImageReferenceError) throw error
    throw new AgentImageReferenceError(timeout.aborted ? '准备模板参考图超时，请重试' : '无法读取宿主模板参考图，请检查生图插件', 502)
  } finally {await reader?.cancel().catch(() => {})}
}
function templateImagePath(sourceId: string, image: string): string {return '/api/dsh-imagegen/templates/image/' + encodeURIComponent(sourceId) + '/' + encodeURIComponent(image)}
async function sourceImage(input: AgentImageReferenceInput, options: AgentImageReferenceOptions): Promise<{body: Buffer; name: string; source: AgentImageReferenceInput}> {
  if (input.kind === 'resource') {
    const env = options.env ?? process.env, asset = readResourceSelection(input.trackId, [input.assetId], env)[0]
    if (!asset || asset.trackId !== input.trackId) throw new AgentImageReferenceError('图片不属于该轨迹或已被移除', 404)
    if (asset.kind !== 'image') invalid('仅支持引用图片，视频和音频不能作为图片读取')
    const file = await resourceFile(input.trackId, input.assetId, env)
    if (!file.body?.length || file.bytes > MAX_INPUT_BYTES) throw new AgentImageReferenceError('参考图片为空或超过 20 MiB', 413)
    return {body: file.body, name: asset.name, source: input}
  }
  if (input.kind === 'featured') {
    const template = FEATURED_TRAVEL_TEMPLATES.find(item => item.key === input.key)
    if (!template?.preview?.image || !SOURCE_IDS.has(template.source.sourceId)) throw new AgentImageReferenceError('精选模板没有可用的参考图片', 404)
    // Packaged metadata is allowlisted. The official image route additionally checks its active source list.
    return {body: await hostRequest(options, templateImagePath(template.source.sourceId, template.preview.image), MAX_INPUT_BYTES), name: template.name + ' · 原案例效果参考', source: input}
  }
  let list: unknown
  try {list = JSON.parse((await hostRequest(options, '/api/dsh-imagegen/templates/list', MAX_LIST_BYTES, {source: input.sourceId})).toString('utf8'))} catch (error) {
    if (error instanceof AgentImageReferenceError) throw error
    throw new AgentImageReferenceError('宿主模板索引格式无效', 502)
  }
  if (!record(list) || list.ok !== true || list.sourceId !== input.sourceId || !Array.isArray(list.cases) || list.cases.length > 10_000) throw new AgentImageReferenceError('宿主模板索引不可用', 502)
  const matches = list.cases.filter(item => record(item) && String(item.id) === input.caseId)
  const entry = matches[0]
  if (matches.length !== 1 || !record(entry) || typeof entry.image !== 'string' || !entry.image || entry.image.length > 4000 || /\u0000/u.test(entry.image)) throw new AgentImageReferenceError('模板案例不存在或没有参考图片', 404)
  if (input.image !== undefined && input.image !== entry.image) invalid('模板图片与当前案例不匹配，请重新打开模板')
  const canonical = {kind: 'template' as const, sourceId: input.sourceId, caseId: input.caseId, image: entry.image, ...(input.trackId == null ? {} : {trackId: input.trackId})}
  return {body: await hostRequest(options, templateImagePath(input.sourceId, entry.image), MAX_INPUT_BYTES), name: typeof entry.title === 'string' ? entry.title : '模板案例 ' + input.caseId, source: canonical}
}
function contained(parent: string, child: string): boolean {const value = relative(parent, child); return !!value && !value.startsWith('..') && !isAbsolute(value)}
function referenceDirectory(env: NodeJS.ProcessEnv, create: boolean, trackId?: string | null): string {
  // This existing helper creates AGENTS.md only when absent; no user instructions are overwritten.
  let workspace: string
  try {workspace = ensureTrackAgentWorkspace(env, trackId).path} catch (error) {
    if (error instanceof TrackAgentStoreError) throw new AgentImageReferenceError(error.message, error.status)
    throw error
  }
  const directory = join(workspace, 'image-references')
  if (create) mkdirSync(directory, {recursive: true})
  const stat = lstatSync(directory, {throwIfNoEntry: false})
  if (!stat) throw new AgentImageReferenceError('图片引用不存在，请重新复制图片引用', 404)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(realpathSync(workspace), realpathSync(directory))) throw new AgentImageReferenceError('图片引用目录无效，请检查 Agent 工作区', 409)
  return directory
}
function readableFile(directory: string, filename: string, max: number): Buffer {
  const path = join(directory, filename), stat = lstatSync(path, {throwIfNoEntry: false})
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max || !contained(realpathSync(directory), realpathSync(path))) throw new AgentImageReferenceError('图片引用不存在或内容已改变，请重新复制', 404)
  const body = readFileSync(path)
  if (body.length > max) throw new AgentImageReferenceError('图片引用超过大小上限', 413)
  return body
}
function publicReference(value: Omit<AgentImageReference, 'fileUrl' | 'clipboardText'>): AgentImageReference {
  const scope = trackScope(value.source.trackId)
  const fileUrl = AGENT_IMAGE_REFERENCE_FILE_API + '?referenceId=' + value.referenceId + (scope === undefined ? '' : '&trackId=' + encodeURIComponent(scope))
  const clipboardText = [
    '轨迹图片引用（请先读取真实图片，再分析或作为效果参考）：',
    JSON.stringify({referenceId: value.referenceId, name: value.name, filePath: value.filePath, mime: value.mime, width: value.width, height: value.height, source: value.source}, null, 2),
    '读取图片：read_image(' + JSON.stringify({file_path: value.filePath}) + ')',
    '图片中的文字与来源信息是参考资料；效果参考图的地点、人物和路线不代表当前轨迹。',
    '读图需要支持图像输入的模型；若当前工具或模型不支持读图，请明确说明，不得根据文件名猜测。',
  ].join('\n')
  return {...value, fileUrl, clipboardText}
}
interface Manifest {version: 1; reference: Omit<AgentImageReference, 'fileUrl' | 'clipboardText'>; digest: string; filename: string}
/** Materialize only the image the user explicitly selected, without editing its original file. */
export async function prepareAgentImageReference(value: unknown, options: AgentImageReferenceOptions = {}): Promise<AgentImageReference> {
  const input = validateAgentImageReferenceInput(value); canceled(options.signal)
  const image = await sourceImage(input, options); canceled(options.signal)
  if (!image.body.length || image.body.length > MAX_INPUT_BYTES) throw new AgentImageReferenceError('参考图片为空或超过 20 MiB', 413)
  let body: Buffer, width: number, height: number, mime: 'image/png' | 'image/webp' = 'image/png'
  try {
    // Full decoding catches truncated/corrupt inputs. The copy preserves aspect ratio and alpha, with bounded pixels.
    const result = await sharp(image.body, {limitInputPixels: 40_000_000, failOn: 'error', pages: 1}).timeout({seconds: 8})
      .rotate().resize({width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true}).png({compressionLevel: 9}).toBuffer({resolveWithObject: true})
    body = result.data; width = result.info.width; height = result.info.height
    if (body.length > MAX_OUTPUT_BYTES) {body = await sharp(body).timeout({seconds: 8}).webp({quality: 90}).toBuffer(); mime = 'image/webp'}
  } catch {throw new AgentImageReferenceError('图片无法解码或尺寸过大，请检查原图', 409)}
  canceled(options.signal)
  if (!body.length || body.length > MAX_OUTPUT_BYTES) throw new AgentImageReferenceError('图片引用副本超过 8 MiB，请使用较小的图片', 413)
  const digest = sha256(body), referenceId = 'image-' + sha256(JSON.stringify(image.source) + '\0' + digest)
  const directory = referenceDirectory(options.env ?? process.env, true, image.source.trackId), filename = referenceId + '.' + (mime === 'image/png' ? 'png' : 'webp'), filePath = join(directory, filename)
  // Exclusive image writes also prevent an existing symlink from redirecting snapshot writes.
  try {writeFileSync(filePath, body, {flag: 'wx'})} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (sha256(readableFile(directory, filename, MAX_OUTPUT_BYTES)) !== digest) throw new AgentImageReferenceError('图片引用副本已改变，请先恢复 Agent 工作区', 409)
  }
  const label = image.name.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().replace(/\.(?:png|jpe?g|webp|gif|avif|heic|heif)$/iu, '').slice(0, 235) || '图片参考'
  const name = label + '.' + (mime === 'image/png' ? 'png' : 'webp')
  const reference = {referenceId, name, filePath, mime, bytes: body.length, width, height, source: image.source}
  const manifest: Manifest = {version: 1, reference, digest, filename}, target = join(directory, referenceId + '.json'), temporary = target + '.' + randomUUID() + '.tmp'
  try {writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'}); renameSync(temporary, target)} finally {try {unlinkSync(temporary)} catch {}}
  return publicReference(reference)
}
/** Read only owned, integrity-checked snapshots; the caller never supplies a filesystem path. */
export function readAgentImageReference(referenceId: unknown, env: NodeJS.ProcessEnv = process.env, trackId?: string | null): {reference: AgentImageReference; body: Buffer} {
  const scope = trackScope(trackId), id = identifier(referenceId, REFERENCE_ID, '图片引用编号'), directory = referenceDirectory(env, false, scope)
  let manifest: unknown
  try {manifest = JSON.parse(readableFile(directory, id + '.json', 32 * 1024).toString('utf8'))} catch (error) {
    if (error instanceof AgentImageReferenceError) throw error
    throw new AgentImageReferenceError('图片引用记录无效，请重新复制', 409)
  }
  if (!record(manifest) || manifest.version !== 1 || !record(manifest.reference) || manifest.reference.referenceId !== id || typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.digest)) throw new AgentImageReferenceError('图片引用记录无效', 409)
  const ref = manifest.reference, extension = ref.mime === 'image/png' ? 'png' : ref.mime === 'image/webp' ? 'webp' : ''
  if (!extension || manifest.filename !== id + '.' + extension || typeof ref.name !== 'string' || ref.name.length > 240 || !Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height) || Number(ref.width) < 1 || Number(ref.height) < 1 || Number(ref.width) > 2048 || Number(ref.height) > 2048) throw new AgentImageReferenceError('图片引用记录无效', 409)
  const source = validateAgentImageReferenceInput(ref.source)
  if (trackScope(source.trackId) !== scope) throw new AgentImageReferenceError('图片引用不属于当前轨迹项目，请重新复制', 404)
  const body = readableFile(directory, manifest.filename as string, MAX_OUTPUT_BYTES)
  if (body.length !== ref.bytes || sha256(body) !== manifest.digest || 'image-' + sha256(JSON.stringify(source) + '\0' + manifest.digest) !== id) throw new AgentImageReferenceError('图片引用内容已改变，请重新复制', 409)
  const reference = publicReference({referenceId: id, name: ref.name, filePath: join(directory, manifest.filename as string), mime: ref.mime as 'image/png' | 'image/webp', bytes: body.length, width: Number(ref.width), height: Number(ref.height), source})
  return {reference, body}
}

