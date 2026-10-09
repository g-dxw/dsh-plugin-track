import sharp from 'sharp'
import {createHash, randomUUID} from 'node:crypto'
import {existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs'
import {open} from 'node:fs/promises'
import type {IncomingMessage} from 'node:http'
import {join} from 'node:path'
import {readTrack, trackDir} from './artifacts.ts'
import {readAnnotations} from './annotations-store.ts'
import {readPlacemarkState} from './placemark-state-store.ts'
import {effectivePlacemarks} from './track/placemark-state.ts'
import {trackPhotoSources, readPlacemarkPhotoAsset, listPlacemarkPhotoAssets} from './placemark-photo-assets-store.ts'
import {readPlacemarkPhoto, writePlacemarkPhoto} from './placemark-photos-store.ts'
import {localPlacemarkPhoto} from './track/placemark-photos.ts'
import {imageLink} from './track/placemarks.ts'
import {RESOURCE_ID, RESOURCE_LIMITS, RESOURCE_MAP_VIEW_LABELS, isResourceMapView, SVG_ANNOTATION_MAX_BYTES, SVG_ANNOTATION_MAX_PIXELS, RESOURCE_VIDEO_ROLES, resourceFileUrl, type ResourceAsset, type ResourceJob, type ResourceJobReference, type ResourceJobSettings, type ResourceKind, type ResourceMapView, type ResourceMetadata, type ResourceLibraryEnvelope, type ResourceUsage} from './track/resources.ts'

export class ResourceError extends Error {constructor(message: string, readonly status = 400) {super(message)}}
type StoredAsset = Omit<ResourceAsset, 'url' | 'usages'> & {filename?: string}
interface Index {schema: 'cqai-track-resources@1'; revision: string; assets: StoredAsset[]; jobs: ResourceJob[]; hiddenSources: string[]}
const FILE = /^[a-f0-9]{64}\.(?:mp4|mov|webm|mkv|ogg|mp3|aac|wav|flac|m4a)$/u
const MAX_INDEX = 8 * 1024 * 1024
const MIME_BY_KIND: Record<ResourceKind, string[]> = {image:['','image/jpeg','image/png','image/webp','image/gif','image/avif'],video:['video/mp4','video/quicktime','video/webm','video/x-matroska','video/ogg'],audio:['audio/mpeg','audio/aac','audio/wav','audio/flac','audio/mp4','audio/webm','audio/ogg']}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const date = () => new Date().toISOString()
function requiredTrack(id: string, env: NodeJS.ProcessEnv) {
  if (!RESOURCE_ID.test(id)) throw new ResourceError('轨迹编号无效')
  const track = readTrack(id, env)
  if (!track) throw new ResourceError('轨迹不存在', 404)
  return track
}
function record(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype}
function text(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/u.test(value) && label !== '提示词' || (!empty && !value.trim())) throw new ResourceError(`${label}无效或过长`)
  return value.trim()
}
function metadata(value: unknown): ResourceMetadata {
  if (!record(value)) throw new ResourceError('媒体信息格式无效')
  const result: ResourceMetadata = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'hasAudio') {if (typeof item !== 'boolean') throw new ResourceError('媒体声音状态无效'); result.hasAudio = item; continue}
    if (!['width','height','duration','rotation','sampleRate','channels','fps'].includes(key) || typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1e9) throw new ResourceError('媒体信息无效')
    result[key as Exclude<keyof ResourceMetadata, 'hasAudio'>] = item
  }
  return result
}
function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new ResourceError('标签最多 30 项')
  return [...new Set(value.map(item => text(item, 80, '标签')))]
}
function load(id: string, env: NodeJS.ProcessEnv): Index {
  requiredTrack(id, env)
  const path = join(trackDir(id, env), 'resources.json')
  if (!existsSync(path)) return {schema: 'cqai-track-resources@1', revision: '0', assets: [], jobs: [], hiddenSources: []}
  try {
    if (lstatSync(path).size > MAX_INDEX) throw new Error()
    const value = JSON.parse(readFileSync(path, 'utf8')) as Index
    if (value.schema !== 'cqai-track-resources@1' || !RESOURCE_ID.test(value.revision) || !Array.isArray(value.assets) || value.assets.length > 10000 || !Array.isArray(value.jobs) || value.jobs.length > 2000 || !Array.isArray(value.hiddenSources) || value.hiddenSources.some(source => typeof source !== 'string' || !imageLink(source))) throw new Error()
    const ids = new Set<string>()
    for (const asset of value.assets) {
      if (!RESOURCE_ID.test(asset.id) || asset.trackId !== id || ids.has(asset.id) || !['image','video','audio'].includes(asset.kind) || !['existing-photo','upload','ai-edit','ai-generate','svg-annotation','map-capture'].includes(asset.source) || !['ready','pending','error'].includes(asset.status) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || typeof asset.candidate !== 'boolean' || !Number.isFinite(Date.parse(asset.createdAt)) || !Number.isFinite(Date.parse(asset.updatedAt))) throw new Error()
      text(asset.name, 240, '资源名称'); if (!MIME_BY_KIND[asset.kind].includes(asset.mime)) throw new Error(); tags(asset.tags); metadata(asset.metadata)
      if (asset.source === 'map-capture' ? !isResourceMapView(asset.mapView) || asset.kind !== 'image' || asset.mime !== 'image/png' || !!asset.jobId || !!asset.parentAssetId : asset.mapView !== undefined) throw new Error()
      if (asset.videoRole && !RESOURCE_VIDEO_ROLES.includes(asset.videoRole)) throw new Error()
      if (asset.kind !== 'image' && (!asset.filename || !FILE.test(asset.filename))) throw new Error()
      if (asset.kind === 'image' && (!asset.sourceUrl || asset.sourceUrl.length > 4096 || !imageLink(asset.sourceUrl) || (localPlacemarkPhoto(asset.sourceUrl)?.trackId ?? id) !== id)) throw new Error()
      ids.add(asset.id)
    }
    for (const job of value.jobs) validateJob(id, job, value, env, true)
    return value
  } catch {throw new ResourceError('资源库索引损坏，请恢复备份后重试', 500)}
}
function save(id: string, value: Index, env: NodeJS.ProcessEnv): void {
  requiredTrack(id, env)
  value.revision = randomUUID()
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > MAX_INDEX || value.assets.length > 10000 || value.jobs.length > 2000) throw new ResourceError('资源库索引或任务数量超过上限', 413)
  const temp = join(trackDir(id, env), `.resources-${randomUUID()}.tmp`)
  try {writeFileSync(temp, body, {encoding: 'utf8', flag: 'wx'}); renameSync(temp, join(trackDir(id, env), 'resources.json'))}
  catch (error) {try {unlinkSync(temp)} catch {} throw error}
}
function usageMap(id: string, env: NodeJS.ProcessEnv): Map<string, ResourceUsage[]> {
  const track = requiredTrack(id, env), state = readPlacemarkState(id, env), map = new Map<string, ResourceUsage[]>()
  const add = (url: string, usage: ResourceUsage) => {const list = map.get(url) ?? []; if (!list.some(item => item.kind === usage.kind && item.id === usage.id)) list.push(usage); map.set(url, list)}
  for (const point of effectivePlacemarks(track.placemarks ?? [], state)) for (const url of point.images) add(url, {kind: 'placemark', id: point.id, name: point.name})
  for (const group of state.groups) if (group.cover) add(group.cover.imageUrl, {kind: 'placemark', id: group.id, name: group.name})
  for (const annotation of readAnnotations(id, env)) for (const url of [...(annotation.imageUrls ?? []), ...(annotation.photo?.sourceUrl ? [annotation.photo.sourceUrl] : [])]) add(url, {kind: 'svg', id: annotation.id, name: annotation.label})
  // These independent drafts may contain generic references not attached to a location.
  for (const filename of ['video-materials.json','geomotion-project.json']) {
    const path = join(trackDir(id, env), filename)
    if (!existsSync(path)) continue
    if (lstatSync(path).size > 20 * 1024 * 1024) throw new ResourceError('视频素材工程过大，无法核验资源引用', 409)
    let document: unknown
    try {document = JSON.parse(readFileSync(path, 'utf8'))} catch {throw new ResourceError('视频素材工程损坏，无法核验资源引用', 409)}
    const visit = (value: unknown, depth = 0) => {
      if (depth > 100) throw new ResourceError('视频素材工程层级过深', 409)
      if (typeof value === 'string' && (value.startsWith('http') || value.startsWith('/api/'))) add(value, {kind: 'video', id: filename, name: '视频素材工程'})
      else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1)
    }
    visit(document)
  }
  return map
}
function expose(id: string, asset: StoredAsset, usages: Map<string, ResourceUsage[]>): ResourceAsset {
  const {filename, ...publicAsset} = asset, url = resourceFileUrl(id, asset.id)
  const refs = [...(usages.get(url) ?? []), ...(asset.sourceUrl ? usages.get(asset.sourceUrl) ?? [] : [])]
  if (asset.videoRole) refs.push({kind: 'video', id: 'selected-materials', name: asset.videoRole})
  return {...publicAsset, url, usages: refs}
}
function aggregate(id: string, value: Index, env: NodeJS.ProcessEnv, selection?: ReadonlySet<string>): StoredAsset[] {
  const cache = new Map(listPlacemarkPhotoAssets(id, env).map(item => [item.source, item]))
  const known = new Set(value.assets.map(asset => asset.sourceUrl)), now = date(), track = requiredTrack(id, env)
  const refreshed = value.assets.filter(asset => !selection || selection.has(asset.id)).map(asset => {
    if (asset.kind !== 'image') return asset
    const local = localPlacemarkPhoto(asset.sourceUrl), photo = local && local.trackId === id ? readPlacemarkPhoto(id, local.filename, env) : null, cached = cache.get(asset.sourceUrl!)
    return {...asset, ...(photo ? {mime:photo.mime,bytes:photo.body.length,error:undefined}:local ? {error:'图片原始文件不存在或内容已改变'}:{}), status:local && !photo ? 'error' as const : photo || cached?.status === 'ready' ? 'ready' as const : cached?.status === 'error' ? 'error' as const : asset.status, metadata:{...asset.metadata,...(cached?.originalWidth ? {width:cached.originalWidth}:{}),...(cached?.originalHeight ? {height:cached.originalHeight}:{})}}
  })
  return [...refreshed, ...trackPhotoSources(id, env).filter(source => !known.has(source) && !value.hiddenSources.includes(source) && (!selection || selection.has('existing-' + hash(source).slice(0,40)))).map(source => {
    const local = localPlacemarkPhoto(source), photo = local && local.trackId === id ? readPlacemarkPhoto(id, local.filename, env) : null, cached = cache.get(source)
    return {id: `existing-${hash(source).slice(0, 40)}`, trackId: id, kind: 'image' as const, name: `轨迹照片 ${hash(source).slice(0, 6)}`, mime: photo?.mime ?? '', bytes: photo?.body.length ?? 0, source: 'existing-photo' as const, sourceUrl: source, tags: [], candidate: false,
      metadata: {...(cached?.originalWidth ? {width: cached.originalWidth} : {}), ...(cached?.originalHeight ? {height: cached.originalHeight} : {})}, createdAt: track.createdAt || now, updatedAt: track.createdAt || now,
      status: local && !photo ? 'error' as const : photo || cached?.status === 'ready' ? 'ready' as const : cached?.status === 'error' ? 'error' as const : 'pending' as const, ...(local && !photo ? {error:'图片原始文件不存在或内容已改变'} : cached?.error ? {error:cached.error} : {})}
  })]
}
export function readResources(id: string, env: NodeJS.ProcessEnv = process.env): ResourceLibraryEnvelope {
  const value = load(id, env), usages = usageMap(id, env)
  return {revision: value.revision, assets: aggregate(id, value, env).map(asset => expose(id, asset, usages)), jobs: value.jobs}
}
/** Selected callers do not decode/hash originals belonging to unrelated library items. */
export function readResourceSelection(id: string, assetIds: readonly string[], env: NodeJS.ProcessEnv = process.env): ResourceAsset[] {
  if (assetIds.some(assetId => !RESOURCE_ID.test(assetId))) throw new ResourceError('资源编号无效')
  if (!assetIds.length) {requiredTrack(id,env);return []}
  const value = load(id,env), usages = usageMap(id,env)
  return aggregate(id,value,env,new Set(assetIds)).map(asset=>expose(id,asset,usages))
}
function assetFrom(id: string, assetId: string, value: Index, env: NodeJS.ProcessEnv): StoredAsset {
  if (!RESOURCE_ID.test(assetId)) throw new ResourceError('资源编号无效')
  const asset = aggregate(id, value, env, new Set([assetId])).find(asset => asset.id === assetId)
  if (!asset) throw new ResourceError('资源不存在', 404)
  return asset
}
export function updateResource(id: string, assetId: string, patch: unknown, env: NodeJS.ProcessEnv = process.env): ResourceAsset {
  if (!record(patch) || Object.keys(patch).some(key => !['name','tags','candidate','videoRole','metadata'].includes(key))) throw new ResourceError('资源修改字段无效')
  const value = load(id, env), asset = assetFrom(id, assetId, value, env), usages = usageMap(id, env)
  if (patch.name !== undefined) asset.name = text(patch.name, 240, '资源名称')
  if (patch.tags !== undefined) asset.tags = tags(patch.tags)
  if (patch.candidate !== undefined) {if (typeof patch.candidate !== 'boolean') throw new ResourceError('候选状态无效'); asset.candidate = patch.candidate}
  if (patch.videoRole !== undefined) {
    if (patch.videoRole === null) delete asset.videoRole
    else if (RESOURCE_VIDEO_ROLES.includes(patch.videoRole as never)) asset.videoRole = patch.videoRole as ResourceAsset['videoRole']
    else throw new ResourceError('视频用途无效')
  }
  if (patch.metadata !== undefined) asset.metadata = {...asset.metadata, ...metadata(patch.metadata)}
  asset.updatedAt = date()
  const index = value.assets.findIndex(item => item.id === asset.id)
  if (index === -1) value.assets.push(asset); else value.assets[index] = asset
  save(id, value, env)
  return expose(id, asset, usages)
}
export function removeResource(id: string, assetId: string, env: NodeJS.ProcessEnv = process.env): void {
  const value = load(id, env), asset = assetFrom(id, assetId, value, env), usages = usageMap(id, env)
  if (expose(id, asset, usages).usages.length) throw new ResourceError('资源仍被点位、SVG 或视频素材使用，请先解除引用', 409)
  if (value.jobs.some(job => (job.sourceAssetId === assetId || job.references?.some(reference => reference.assetId === assetId)) && ['submitting','queued','running','unknown'].includes(job.status))) throw new ResourceError('图片仍有未结束的生成任务', 409)
  value.assets = value.assets.filter(item => item.id !== assetId)
  if (asset.sourceUrl && !value.hiddenSources.includes(asset.sourceUrl)) value.hiddenSources.push(asset.sourceUrl)
  for (const job of value.jobs) {
    if (job.resultsPersisted === undefined && job.status === 'completed' && job.resultAssetIds.length > 0 && !job.error) job.resultsPersisted = true
    job.resultAssetIds = job.resultAssetIds.filter(item => item !== assetId)
  }
  save(id, value, env)
  // Image bytes can belong to placemark undo history; only generic unreferenced media are reclaimed here.
  if (asset.filename && !value.assets.some(item => item.filename === asset.filename)) try {unlinkSync(join(trackDir(id, env), 'media', asset.filename))} catch {}
}
function jobReferences(value: unknown): ResourceJobReference[] {
  if (!Array.isArray(value) || value.length > 64) throw new ResourceError('参考图片列表无效或过长')
  const ids = new Set<string>()
  return value.map(item => {
    if (!record(item) || Object.keys(item).some(key => !['assetId','role','name'].includes(key)) || !['subject','effect'].includes(String(item.role))) throw new ResourceError('参考图片角色无效')
    const assetId = text(item.assetId,128,'参考图片编号')
    if (!RESOURCE_ID.test(assetId) || ids.has(assetId)) throw new ResourceError('参考图片编号无效或重复')
    ids.add(assetId)
    return {assetId,role:item.role as ResourceJobReference['role'],...(item.name === undefined ? {} : {name:text(item.name,240,'参考图片名称')})}
  })
}
function jobSettings(value: unknown): ResourceJobSettings {
  if (!record(value) || Object.keys(value).some(key => !['size','quality','n','detail'].includes(key)) || typeof value.n !== 'number' || !Number.isInteger(value.n) || value.n < 1 || value.n > 4) throw new ResourceError('生成设置无效')
  return {size:text(value.size,80,'生成尺寸'),quality:text(value.quality,80,'生成质量'),n:value.n,detail:text(value.detail,80,'生成细节',true)}
}
function validateJob(id: string, input: unknown, value: Index, env: NodeJS.ProcessEnv, persisted = false): ResourceJob {
  if (!record(input) || !RESOURCE_ID.test(String(input.id)) || input.trackId !== id || !['edit','text'].includes(String(input.mode)) || !['submitting','queued','running','completed','failed','canceled','unknown'].includes(String(input.status))) throw new ResourceError('生成任务信息无效')
  const previous = value.jobs.find(job => job.id === input.id)
  const referenceInput = input.references === undefined ? previous?.references : input.references
  const references = referenceInput === undefined ? undefined : jobReferences(referenceInput)
  const primary = references?.find(reference => reference.role === 'subject') ?? references?.[0]
  const legacySource = input.sourceAssetId === undefined ? previous?.sourceAssetId : text(input.sourceAssetId,128,'来源图片编号')
  if (legacySource && !RESOURCE_ID.test(legacySource)) throw new ResourceError('来源图片编号无效')
  if (references !== undefined && legacySource !== undefined && legacySource !== primary?.assetId) throw new ResourceError('来源图片与参考图片主图不一致',409)
  const sourceAssetId = references === undefined ? legacySource : primary?.assetId
  if (input.mode === 'edit' && !sourceAssetId) throw new ResourceError('美化任务缺少参考图片')
  // Historical records keep their snapshots even when their former sources have been removed.
  // Only a newly created job may introduce references, and every reference must resolve here.
  if (!persisted && !previous) {
    if (input.mode === 'text' && (sourceAssetId || references?.length)) throw new ResourceError('文生图任务不能包含参考图片')
    for (const assetId of references?.map(reference => reference.assetId) ?? (sourceAssetId ? [sourceAssetId] : [])) {
      const asset = assetFrom(id,assetId,value,env)
      if (asset.kind !== 'image') throw new ResourceError('参考资源必须为当前轨迹图片')
      if (localPlacemarkPhoto(asset.sourceUrl) && asset.status === 'error') throw new ResourceError('参考图片原始文件不可用，请补回图片或移除参考',409)
    }
  }
  if (previous && !persisted && input.status === 'submitting' && previous.status !== 'submitting') throw new ResourceError('重新生成必须创建新任务',409)
  if (previous && !persisted && ['completed','canceled'].includes(previous.status) && input.status !== previous.status) throw new ResourceError('已结束的任务不能退回运行状态',409)
  const prompt = text(input.prompt,20000,'提示词'), model = text(input.model,240,'模型')
  const settingsInput = input.settings === undefined ? previous?.settings : input.settings
  const settings = settingsInput === undefined ? undefined : jobSettings(settingsInput)
  const submittedInput = input.submittedPrompt === undefined ? previous?.submittedPrompt : input.submittedPrompt
  const submittedPrompt = submittedInput === undefined ? undefined : text(submittedInput,40000,'提示词')
  const restoredInput = input.restoredFromJobId === undefined ? previous?.restoredFromJobId : input.restoredFromJobId
  const restoredFromJobId = restoredInput === undefined ? undefined : text(restoredInput,128,'历史任务编号')
  if (restoredFromJobId && (!RESOURCE_ID.test(restoredFromJobId) || restoredFromJobId === input.id)) throw new ResourceError('历史任务编号无效')
  if (!persisted && !previous && restoredFromJobId && !value.jobs.some(job => job.id === restoredFromJobId)) throw new ResourceError('恢复来源任务不存在',404)
  if (previous && !persisted && (previous.sourceAssetId !== sourceAssetId || previous.mode !== input.mode || previous.prompt !== prompt || previous.model !== model
    || JSON.stringify(previous.references === undefined ? undefined : jobReferences(previous.references)) !== JSON.stringify(references)
    || JSON.stringify(previous.settings === undefined ? undefined : jobSettings(previous.settings)) !== JSON.stringify(settings)
    || previous.submittedPrompt !== submittedPrompt || previous.restoredFromJobId !== restoredFromJobId)) throw new ResourceError('已提交任务的来源和生成参数不能改写',409)
  const resultAssetIds = persisted ? input.resultAssetIds : previous?.resultAssetIds ?? []
  if (!Array.isArray(resultAssetIds) || resultAssetIds.some(assetId => typeof assetId !== 'string' || !RESOURCE_ID.test(assetId))) throw new ResourceError('生成结果编号无效')
  if (persisted && (!Number.isFinite(Date.parse(String(input.createdAt))) || !Number.isFinite(Date.parse(String(input.updatedAt))))) throw new ResourceError('生成任务时间无效')
  const now = date(), job: ResourceJob = {id:String(input.id),trackId:id,mode:input.mode as ResourceJob['mode'],prompt,model,status:input.status as ResourceJob['status'],resultAssetIds:[...new Set(resultAssetIds)],createdAt:previous?.createdAt ?? (persisted ? text(input.createdAt,40,'创建时间') : now),updatedAt:persisted ? text(input.updatedAt,40,'更新时间') : now}
  if (references !== undefined) job.references = references
  if (settings !== undefined) job.settings = settings
  if (submittedPrompt !== undefined) job.submittedPrompt = submittedPrompt
  if (restoredFromJobId !== undefined) job.restoredFromJobId = restoredFromJobId
  if (input.resultsPersisted !== undefined && typeof input.resultsPersisted !== 'boolean') throw new ResourceError('生成结果保存状态无效')
  if (!persisted && input.resultsPersisted === true && previous?.resultsPersisted !== true && (job.status !== 'completed' || !job.resultAssetIds.length)) throw new ResourceError('尚无本地生成结果，不能标记保存完成',409)
  job.resultsPersisted = previous?.resultsPersisted === true || input.resultsPersisted === true || (persisted && input.resultsPersisted === undefined && job.status === 'completed' && job.resultAssetIds.length > 0 && !input.error)
  if (input.error !== undefined) job.error = text(input.error,1000,'任务错误',true)
  for (const key of ['hostTaskId','channelId','presetId'] as const) {
    const item = input[key] ?? previous?.[key]
    if (item !== undefined) job[key] = text(item,240,key,true)
  }
  if (sourceAssetId) job.sourceAssetId = sourceAssetId
  const presetVersion = input.presetVersion ?? previous?.presetVersion
  if (presetVersion !== undefined) {
    if (!(typeof presetVersion === 'string' && presetVersion.length <= 100 || typeof presetVersion === 'number' && Number.isFinite(presetVersion))) throw new ResourceError('预设版本无效')
    job.presetVersion = presetVersion
  }
  if (previous && !persisted && (previous.channelId !== job.channelId || previous.presetId !== job.presetId || previous.presetVersion !== job.presetVersion)) throw new ResourceError('任务的模型通道和预设快照不能改写',409)
  if (previous?.hostTaskId && job.hostTaskId !== previous.hostTaskId) throw new ResourceError('生成任务编号不能改写',409)
  return job
}
export function upsertResourceJob(id: string, input: unknown, env: NodeJS.ProcessEnv = process.env): ResourceJob {
  const value = load(id, env)
  const job = validateJob(id, input, value, env)
  const index = value.jobs.findIndex(item => item.id === job.id)
  if (index === -1) value.jobs.push(job); else value.jobs[index] = job
  save(id, value, env)
  return job
}
interface Format {kind: ResourceKind; mime: string; extension: string}
function format(head: Buffer, declared: string, requested?: ResourceKind): Format {
  const mime = declared.split(';', 1)[0].trim().toLowerCase()
  const image: [boolean, string, string][] = [
    [head.length >= 33 && head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'image/png','png'],
    [head.length > 4 && head[0] === 255 && head[1] === 216 && head[2] === 255, 'image/jpeg','jpg'],
    [['GIF87a','GIF89a'].includes(head.toString('latin1',0,6)), 'image/gif','gif'],
    [head.toString('latin1',0,4) === 'RIFF' && head.toString('latin1',8,12) === 'WEBP', 'image/webp','webp'],
    [head.toString('latin1',4,8) === 'ftyp' && /avif|avis/u.test(head.toString('latin1',8,64)), 'image/avif','avif'],
  ]
  const matched = image.find(item => item[0])
  let result: Format | undefined = matched ? {kind: 'image', mime: matched[1], extension: matched[2]} : undefined
  if (!result && head.toString('latin1',0,4) === 'RIFF' && head.toString('latin1',8,12) === 'WAVE') result = {kind:'audio',mime:'audio/wav',extension:'wav'}
  if (!result && head.toString('latin1',0,4) === 'fLaC') result = {kind:'audio',mime:'audio/flac',extension:'flac'}
  if (!result && head.length >= 7 && head[0] === 255 && (head[1] & 246) === 240 && ((head[2] >> 2) & 15) < 13) result = {kind:'audio',mime:'audio/aac',extension:'aac'}
  if (!result && (head.toString('latin1',0,3) === 'ID3' || head[0] === 255 && (head[1] & 224) === 224 && (head[1] & 6) !== 0)) result = {kind:'audio',mime:'audio/mpeg',extension:'mp3'}
  if (!result && head.toString('latin1',0,4) === 'OggS') result = {kind:requested === 'video' ? 'video' : 'audio',mime:requested === 'video' ? 'video/ogg':'audio/ogg',extension:'ogg'}
  if (!result && head.length >= 4 && head.subarray(0,4).equals(Buffer.from([26,69,223,163]))) {
    const position = head.indexOf(Buffer.from([66,130]),4)
    const size = position >= 0 ? head[position+2] : 0
    const docType = size >= 128 && position+3+(size & 127) <= head.length ? head.toString('latin1',position+3,position+3+(size & 127)) : ''
    if (docType === 'webm') result = {kind:requested === 'audio' ? 'audio':'video',mime:requested === 'audio' ? 'audio/webm':'video/webm',extension:'webm'}
    else if (docType === 'matroska') result = {kind:'video',mime:'video/x-matroska',extension:'mkv'}
  }
  if (!result && head.length >= 16 && head.toString('latin1',4,8) === 'ftyp') {
    const audio = requested === 'audio' || mime.startsWith('audio/') || head.toString('latin1',8,12) === 'M4A '
    const quicktime = head.toString('latin1',8,12) === 'qt  '
    result = {kind:audio ? 'audio':'video',mime:audio ? 'audio/mp4':quicktime ? 'video/quicktime':'video/mp4',extension:audio ? 'm4a':quicktime ? 'mov':'mp4'}
  }
  if (!result || requested && requested !== result.kind || mime && mime !== 'application/octet-stream' && mime !== result.mime && !(result.mime === 'audio/wav' && ['audio/x-wav','audio/wave'].includes(mime)) && !(result.mime === 'audio/flac' && mime === 'audio/x-flac')) throw new ResourceError('媒体内容与类型不匹配，支持常用图片、MP4/MOV/WebM/MKV、MP3/AAC/WAV/M4A/FLAC/OGG', 415)
  return result
}
/** Validate complete PNG pixels before registering an immutable artwork or map snapshot. */
async function snapshotMetadata(path: string, head: Buffer, label: string): Promise<ResourceMetadata> {
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20)
  if (!width || !height || width * height > SVG_ANNOTATION_MAX_PIXELS) throw new ResourceError(`${label} PNG 最多 1600 万像素`,413)
  try {
    const image = sharp(path,{limitInputPixels:SVG_ANNOTATION_MAX_PIXELS,failOn:'error',pages:1}).timeout({seconds:8})
    const info = await image.metadata()
    if (info.format !== 'png' || info.width !== width || info.height !== height || (info.pages ?? 1) > 1) throw new Error()
    await image.stats()
    return {width,height}
  } catch {throw new ResourceError(label === '标注' ? '标注 PNG 无法解码，请重新保存画布' : '地图 PNG 无法解码，请重新导出',415)}
}
export interface ResourceUploadOptions {name: string; kind?: ResourceKind; jobId?: string; parentAssetId?: string; annotation?: boolean; mapView?: ResourceMapView}
export async function uploadResource(id: string, req: IncomingMessage, options: ResourceUploadOptions, env: NodeJS.ProcessEnv = process.env): Promise<ResourceAsset> {
  requiredTrack(id, env)
  const name = text(options.name, 240, '资源名称'), initial = load(id, env), annotation = options.annotation === true, mapCapture = options.mapView !== undefined, snapshot = annotation || mapCapture, snapshotLabel = mapCapture ? '地图' : '标注'
  if (mapCapture && !isResourceMapView(options.mapView)) throw new ResourceError('地图视图类型无效')
  if (snapshot && (options.kind && options.kind !== 'image' || options.jobId || options.parentAssetId || annotation && mapCapture)) throw new ResourceError(`${snapshotLabel}快照必须为独立 PNG 图片`)
  if (options.kind && !['image','video','audio'].includes(options.kind)) throw new ResourceError('资源类型无效')
  const job = options.jobId ? initial.jobs.find(job => job.id === options.jobId) : undefined
  if (options.jobId && !job) throw new ResourceError('生成任务不存在', 404)
  if (job && options.parentAssetId !== undefined && options.parentAssetId !== job.sourceAssetId) throw new ResourceError('生成结果来源与任务不一致', 409)
  if (job && job.status === 'canceled') throw new ResourceError('已取消任务不能保存新结果', 409)
  const requested = snapshot || job ? 'image' : options.kind, directory = join(trackDir(id, env), 'media'), temporary = join(directory, `.upload-${randomUUID()}.tmp`)
  const initialLimit = snapshot ? SVG_ANNOTATION_MAX_BYTES : RESOURCE_LIMITS[requested ?? 'video']
  if (Number(req.headers['content-length']) > initialLimit) throw new ResourceError(snapshot ? `${snapshotLabel} PNG 最多 10 MiB` : '媒体文件超过当前类型大小上限', 413)
  mkdirSync(directory, {recursive:true})
  const handle = await open(temporary, 'wx'), digest = createHash('sha256')
  let size = 0, head = Buffer.alloc(0), detected: Format | undefined, ownedFinal: string | undefined, completed = false
  try {
    for await (const raw of req.iterator({destroyOnReturn:false})) {
      const chunk = Buffer.from(raw); size += chunk.length
      if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0,4096-head.length)])
      if (!detected && head.length >= 512) detected = format(head, String(req.headers['content-type'] ?? ''), requested)
      if (size > (snapshot ? SVG_ANNOTATION_MAX_BYTES : detected ? RESOURCE_LIMITS[detected.kind] : initialLimit)) throw new ResourceError(snapshot ? `${snapshotLabel} PNG 最多 10 MiB` : '媒体文件超过当前类型大小上限', 413)
      if (snapshot && detected && detected.mime !== 'image/png') throw new ResourceError(`${snapshotLabel}快照只支持 PNG 图片`,415)
      digest.update(chunk)
      let offset = 0
      while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten
    }
    if (!size) throw new ResourceError('请选择非空媒体文件')
    detected ??= format(head, String(req.headers['content-type'] ?? ''), requested)
    if (size > (snapshot ? SVG_ANNOTATION_MAX_BYTES : RESOURCE_LIMITS[detected.kind])) throw new ResourceError(snapshot ? `${snapshotLabel} PNG 最多 10 MiB` : '媒体文件超过当前类型大小上限', 413)
    if (snapshot && detected.mime !== 'image/png') throw new ResourceError(`${snapshotLabel}快照只支持 PNG 图片`,415)
    await handle.close()
    const mediaMetadata = snapshot ? await snapshotMetadata(temporary,head,snapshotLabel) : {}
    requiredTrack(id, env)
    const value = load(id, env), contentHash = digest.digest('hex')
    if (job && value.jobs.find(item => item.id === job.id)?.status === 'canceled') throw new ResourceError('任务已取消，未保存新结果',409)
    let sourceUrl: string | undefined, filename: string | undefined
    if (detected.kind === 'image') sourceUrl = writePlacemarkPhoto(id, readFileSync(temporary), detected.mime, env).url
    else filename = `${contentHash}.${detected.extension}`
    const prior = value.assets.find(asset => asset.kind === detected!.kind && (sourceUrl ? asset.sourceUrl === sourceUrl : asset.filename === filename) && asset.jobId === options.jobId && (mapCapture ? asset.source === 'map-capture' && asset.mapView === options.mapView : annotation ? asset.source === 'svg-annotation' : !['svg-annotation','map-capture'].includes(asset.source)))
    if (prior) return expose(id, prior, usageMap(id, env))
    if (filename) {
      const destination = join(directory, filename)
      if (existsSync(destination)) {if (lstatSync(destination).size !== size) throw new ResourceError('已有媒体内容无效',409)}
      else {renameSync(temporary, destination); ownedFinal = destination}
    }
    const now = date(), asset: StoredAsset = {id:`asset-${randomUUID()}`,trackId:id,kind:detected.kind,name,mime:detected.mime,bytes:size,source:mapCapture ? 'map-capture':annotation ? 'svg-annotation':job ? job.mode === 'edit' ? 'ai-edit':'ai-generate':'upload',tags:mapCapture ? [RESOURCE_MAP_VIEW_LABELS[options.mapView!]]:annotation ? ['SVG标注']:[],...(mapCapture ? {mapView:options.mapView}:{}),candidate:!!job,metadata:mediaMetadata,createdAt:now,updatedAt:now,status:'ready',...(sourceUrl ? {sourceUrl}:{}),...(filename ? {filename}:{}),...(job ? {jobId:job.id,...(job.sourceAssetId ? {parentAssetId:job.sourceAssetId}:{})}:{})}
    value.assets.push(asset)
    if (job) {
      const currentJob = value.jobs.find(item => item.id === job.id)!
      currentJob.resultAssetIds = [...new Set([...currentJob.resultAssetIds, asset.id])]; currentJob.updatedAt = now
    }
    save(id, value, env); completed = true
    return expose(id, asset, usageMap(id, env))
  } finally {await handle.close().catch(()=>{}); try {unlinkSync(temporary)} catch {}; if (ownedFinal && !completed) try {unlinkSync(ownedFinal)} catch {}}
}
export async function resourceFile(id: string, assetId: string, env: NodeJS.ProcessEnv = process.env): Promise<{path?:string;body?:Buffer;mime:string;bytes:number}> {
  const value = load(id, env), asset = assetFrom(id, assetId, value, env)
  if (asset.kind === 'image') {
    const local = localPlacemarkPhoto(asset.sourceUrl), photo = local ? readPlacemarkPhoto(id, local.filename, env) : await readPlacemarkPhotoAsset(id, asset.sourceUrl!, 'original', env)
    if (!photo) throw new ResourceError('图片原始文件不存在',404)
    return {body:photo.body,mime:photo.mime,bytes:photo.body.length}
  }
  const path = join(trackDir(id,env),'media',asset.filename!), stat = lstatSync(path, {throwIfNoEntry:false})
  if (!stat?.isFile() || stat.size !== asset.bytes) throw new ResourceError('媒体文件不存在或内容已改变',404)
  return {path,mime:asset.mime,bytes:stat.size}
}













