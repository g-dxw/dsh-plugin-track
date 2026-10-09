import {useCallback, useEffect, useRef, useState} from 'react'
import type {ResourceAsset, ResourceJob} from '../track/resources.ts'
import type {ResourcePromptTemplate} from '../track/resource-templates.ts'
import {cancelTrackArtTask, ImagegenError, IMAGEGEN_RESOURCE_SETTINGS_DEFAULT, loadTrackArtTask, submitResourceImage, validateResourceImageInput, type ResourceImageSettings} from './imagegen.ts'
import {readResourceReference, saveResourceJob, storeResourceResult} from './resources-api.ts'

const locks = new Map<string, Promise<void>>()
const submitting = new Set<string>()
const hostJournal = new Map<string, string>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const key = (job: ResourceJob) => `track-resource-job:${job.trackId}:${job.id}`
function rememberHost(job: ResourceJob, hostTaskId: string) {
  hostJournal.set(key(job), hostTaskId)
  try {localStorage.setItem(key(job), hostTaskId)} catch { /* The server remains authoritative; memory covers navigation. */ }
}
function rememberedHost(job: ResourceJob): string | undefined {
  if (job.hostTaskId) return job.hostTaskId
  try {return hostJournal.get(key(job)) || localStorage.getItem(key(job)) || undefined} catch {return hostJournal.get(key(job))}
}
export function resourceJobNeedsSync(job: ResourceJob): boolean {
  return !!rememberedHost(job) && (['queued', 'running', 'unknown', 'submitting'].includes(job.status) || job.status === 'completed' && job.resultsPersisted !== true && (job.resultsPersisted === false || job.resultAssetIds.length === 0))
}

/** A lock protects local result persistence. It never repeats a host submission. */
export async function syncResourceJob(trackId: string, original: ResourceJob): Promise<void> {
  if (original.status === 'canceled' || original.status === 'completed' && original.resultsPersisted === true) return
  const lockKey = key(original)
  if (locks.has(lockKey)) return locks.get(lockKey)
  const task = (async () => {
    const hostTaskId = rememberedHost(original)
    if (!hostTaskId || submitting.has(lockKey)) return
    const job = {...original, hostTaskId}
    let state: Awaited<ReturnType<typeof loadTrackArtTask>>
    try {state = await loadTrackArtTask(hostTaskId)}
    catch (error) {await saveResourceJob(trackId, {...job, status: job.status === 'completed' || job.status === 'canceled' ? job.status : 'unknown', error: `任务查询失败：${message(error)}。不会重复提交。`, updatedAt: new Date().toISOString()}); return}
    const resultAssetIds = [...job.resultAssetIds]
    if (state.status === 'completed') {
      try {
        for (const image of state.images) {
          const asset = await storeResourceResult(trackId, job, image.dataUrl)
          if (!resultAssetIds.includes(asset.id)) resultAssetIds.push(asset.id)
        }
      } catch (error) {
        await saveResourceJob(trackId, {...job, status: 'completed', resultAssetIds, resultsPersisted: false, error: `生成已完成，结果保存失败：${message(error)}。可重试保存已有结果。`, updatedAt: new Date().toISOString()})
        return
      }
    }
    await saveResourceJob(trackId, {...job, status: job.status === 'completed' || job.status === 'canceled' ? job.status : state.status, resultAssetIds, resultsPersisted: state.status === 'completed' ? true : job.resultsPersisted, error: state.error, updatedAt: new Date().toISOString()})
  })()
  locks.set(lockKey, task)
  try {await task} finally {locks.delete(lockKey)}
}

export interface ResourceJobSubmitInput {
  mode?: 'edit' | 'text'
  prompt: string
  model: string
  channelId?: string
  source?: ResourceAsset
  references?: {asset: ResourceAsset; role: 'subject' | 'effect'}[]
  template?: ResourcePromptTemplate
  presetId?: string
  presetVersion?: string | number
  settings?: ResourceImageSettings
  restoredFromJobId?: string
  maxReferenceImages?: number
  maxOutputImages?: number
  allowedSizes?: readonly string[]
  allowedQualities?: readonly string[]
  allowedDetails?: readonly string[]
}
/** Role instructions apply to the exact uploaded order; the user's own text remains in job.prompt. */
export function resourceReferencePrompt(prompt: string, references: {asset: ResourceAsset; role: 'subject' | 'effect'}[]): string {
  if (!references.length) return prompt
  const subjects = references.filter(reference => reference.role === 'subject')
  const instructions = references.map((reference, index) => '图 ' + (index + 1) + '：' + (reference.role === 'subject' ? '主体参考' : '效果参考') + '（' + reference.asset.name.replace(/[\r\n]/gu, ' ') + '）')
  return prompt + '\n\n参考图说明（按上传顺序）：\n' + instructions.join('\n')
    + '\n主体参考用于保留需要的主体、人物或地点结构；效果参考仅用于色彩、光线、氛围与风格。'
    + (subjects.length ? '不要因效果参考而替换主体参考中的人物、地点和主要物体。' : '本次仅提供效果参考，请按用户要求创作主体，不要复制效果参考中的人物或地点。')
}

export function useResourceJobs(trackId: string, jobs: ResourceJob[], onChange: () => Promise<void>) {
  const jobsRef = useRef(jobs), refreshRef = useRef(onChange), alive = useRef(true)
  jobsRef.current = jobs; refreshRef.current = onChange
  const [working, setWorking] = useState(false), [error, setError] = useState('')
  const submissionLock = useRef(false)
  useEffect(() => {alive.current = true; return () => {alive.current = false}}, [])
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
      const interrupted = jobsRef.current.filter(job => job.status === 'submitting' && !submitting.has(key(job)) && !rememberedHost(job))
      for (const job of interrupted) {await saveResourceJob(trackId, {...job, status: 'unknown', error: '提交未取得宿主任务编号，请先在 e图宝核对本次任务，不会自动重新生成。', updatedAt: new Date().toISOString()})}
      const pending = jobsRef.current.filter(resourceJobNeedsSync)
      if (!pending.length) {if (interrupted.length && !stopped) await refreshRef.current(); return}
      for (const job of pending) {if (stopped) return; await syncResourceJob(trackId, job)}; if (!stopped) await refreshRef.current()
      }
      catch (reason) {if (!stopped) setError(message(reason))}
    }
    void tick()
    const interval = setInterval(() => {void tick()}, 4000)
    return () => {stopped = true; clearInterval(interval)}
  }, [trackId, jobs.some(job => resourceJobNeedsSync(job) || job.status === 'submitting')])

  const submit = useCallback(async (input: ResourceJobSubmitInput): Promise<ResourceJob | undefined> => {
    if (submissionLock.current) return
    submissionLock.current = true; setWorking(true); setError('')
    const channelId = input.channelId?.trim(), maxReferenceImages = input.maxReferenceImages, maxOutputImages = input.maxOutputImages
    const allowedSizes = input.allowedSizes && [...input.allowedSizes], allowedQualities = input.allowedQualities && [...input.allowedQualities], allowedDetails = input.allowedDetails && [...input.allowedDetails]
    const explicitReferences = input.references !== undefined, includeSettings = input.references !== undefined || input.settings !== undefined
    // Freeze identity/order/parameters before any await so composer edits cannot alter this submission.
    const references = (explicitReferences ? input.references! : input.mode === 'edit' && input.source ? [{asset: input.source, role: 'subject' as const}] : [])
      .map(reference => ({asset: {...reference.asset}, role: reference.role}))
    const mode = explicitReferences ? references.length ? 'edit' : 'text' : input.mode ?? (references.length ? 'edit' : 'text')
    const primary = references.find(reference => reference.role === 'subject') ?? references[0]
    const settings = {...IMAGEGEN_RESOURCE_SETTINGS_DEFAULT, ...input.settings}
    const prompt = input.prompt.trim()
    const submittedPrompt = explicitReferences ? resourceReferencePrompt(prompt, references) : prompt
    const now = new Date().toISOString()
    const job: ResourceJob = {
      id: `job-${crypto.randomUUID()}`, trackId, mode, prompt, model: input.model.trim(),
      ...(primary ? {sourceAssetId: primary.asset.id} : {}),
      ...(explicitReferences ? {references: references.map(reference => ({assetId: reference.asset.id, role: reference.role, name: reference.asset.name})), settings, submittedPrompt} : input.settings ? {settings, submittedPrompt} : {}),
      ...(input.restoredFromJobId ? {restoredFromJobId: input.restoredFromJobId} : {}),
      ...(channelId ? {channelId: channelId} : {}),
      ...(input.template ? {presetId: input.template.id, presetVersion: input.template.version} : input.presetId ? {presetId: input.presetId, ...(input.presetVersion !== undefined ? {presetVersion: input.presetVersion} : {})} : {}),
      status: 'submitting', resultAssetIds: [], resultsPersisted: false, createdAt: now, updatedAt: now,
    }
    let persisted = false, hostStarted = false
    submitting.add(key(job))
    try {
      if (!job.prompt) throw new Error('请填写图片要求')
      if (!job.model) throw new Error('请选择宿主模型')
      if (mode === 'edit' && !references.length) throw new Error('请先选择一张参考照片')
      if (references.some(reference => reference.asset.kind !== 'image' || reference.asset.trackId !== trackId || !['subject', 'effect'].includes(reference.role))) throw new Error('参考图必须是当前轨迹的图片，且设置为主体或效果参考')
      if (references.length > 5) throw new ImagegenError('宿主最多支持 5 张参考图，请调整后再生成', 'too-many-references')
      if (references.length > 1 && maxReferenceImages === undefined) throw new ImagegenError('当前模型的多参考图能力尚未核实，请选择支持多参考图的宿主模型', 'reference-capability-unknown')
      if (maxReferenceImages !== undefined && references.length > maxReferenceImages) throw new ImagegenError('当前宿主模型不支持所选参考图数量，请调整参考图或切换模型', 'reference-capacity-exceeded')
      // Every selected image is read; no host call or intent persistence starts after a partial read.
      const images = await Promise.all(references.map(reference => readResourceReference(reference.asset)))
      const generationInput = {
        mode, prompt: submittedPrompt, model: job.model,
        ...(images.length ? {image: images[0], ...(images.length > 1 ? {images: images.slice(1)} : {})} : {}),
        ...(channelId ? {channelId: channelId} : {channelId: undefined}),
        ...(includeSettings ? {settings} : {}),
        ...(maxReferenceImages !== undefined ? {maxReferenceImages: maxReferenceImages} : {}),
        ...(maxOutputImages !== undefined ? {maxOutputImages: maxOutputImages} : {}),
        ...(allowedSizes ? {allowedSizes} : {}), ...(allowedQualities ? {allowedQualities} : {}), ...(allowedDetails ? {allowedDetails} : {}),
      }
      validateResourceImageInput(generationInput)
      await saveResourceJob(trackId, job); persisted = true
      if (alive.current) await refreshRef.current()
      hostStarted = true
      const reply = await submitResourceImage(generationInput)
      rememberHost(job, reply.taskId)
      const queued: ResourceJob = {...job, hostTaskId: reply.taskId, status: 'queued', updatedAt: new Date().toISOString()}
      await saveResourceJob(trackId, queued)
      if (alive.current) await refreshRef.current()
      return queued
    } catch (reason) {
      const uncertain = hostStarted && (!(reason instanceof ImagegenError) || ['network-error', 'invalid-response'].includes(reason.code))
      const errorText = uncertain ? `提交状态不明：${message(reason)}。请在 e图宝核对本次任务，不会自动重新生成。` : message(reason)
      if (alive.current) setError(errorText)
      if (persisted) {
        const failed: ResourceJob = {...job, ...(rememberedHost(job) ? {hostTaskId: rememberedHost(job)} : {}), status: uncertain ? 'unknown' : 'failed', error: errorText, updatedAt: new Date().toISOString()}
        try {await saveResourceJob(trackId, failed); if (alive.current) await refreshRef.current()}
        catch { /* The persisted submitting record must remain visible for manual recovery. */ }
        return failed
      }
      return undefined
    } finally {
      submitting.delete(key(job)); submissionLock.current = false
      if (alive.current) setWorking(false)
    }
  }, [trackId])
  const sync = useCallback(async (job: ResourceJob) => {
    setError('')
    if (!rememberedHost(job)) {setError('未取得宿主任务编号，请在 e图宝核对原任务；不会自动重新提交。'); return}
    try {await syncResourceJob(trackId, job); if (alive.current) await refreshRef.current()} catch (reason) {if (alive.current) setError(message(reason))}
  }, [trackId])
  const cancel = useCallback(async (job: ResourceJob) => {
    setError('')
    const hostTaskId = rememberedHost(job)
    if (!hostTaskId) {setError('本次提交状态不明，请在 e图宝确认任务后取消'); return}
    try {await cancelTrackArtTask(hostTaskId); await syncResourceJob(trackId, {...job, hostTaskId}); if (alive.current) await refreshRef.current()}
    catch (reason) {if (alive.current) setError(message(reason))}
  }, [trackId])
  return {working, error, submit, sync, cancel, clearError: () => setError('')}
}

