import type {ImagePromptAttribution} from './image-prompt-context.ts'
import type {ResourceJob, ResourceJobReference, ResourceJobSettings} from '../track/resources.ts'

export interface ResourceImageDraft {
  trackId: string
  references: ResourceJobReference[]
  prompt: string
  model: string
  channelId?: string
  presetId?: string
  presetVersion?: string | number
  promptAttribution?: ImagePromptAttribution
  promptUndo?: {prompt: string; presetId?: string; presetVersion?: string | number; attribution?: ImagePromptAttribution; appliedPrompt: string}
  settings: ResourceJobSettings
  restoredFromJobId?: string
  activeJobId?: string
  selectedResultId?: string
  baseline: string
  updatedAt: string
}
export const DEFAULT_IMAGE_SETTINGS: ResourceJobSettings = {size: 'auto', quality: 'auto', n: 1, detail: ''}
const memory = new Map<string, ResourceImageDraft>()
const storageKey = (trackId: string, backup = false) => `cqai-track:image-draft:${trackId}${backup ? ':reserved' : ''}`
export function imageDraftFingerprint(draft: Pick<ResourceImageDraft, 'references' | 'prompt' | 'model' | 'settings' | 'channelId' | 'presetId' | 'presetVersion'>): string {
  return JSON.stringify({references: draft.references.map(item => ({assetId: item.assetId, role: item.role})), prompt: draft.prompt, model: draft.model, channelId: draft.channelId, presetId: draft.presetId, presetVersion: draft.presetVersion, settings: {size: draft.settings.size, quality: draft.settings.quality, n: draft.settings.n, detail: draft.settings.detail}})
}
export function emptyImageDraft(trackId: string): ResourceImageDraft {
  const draft = {trackId, references: [], prompt: '', model: '', settings: {...DEFAULT_IMAGE_SETTINGS}, baseline: '', updatedAt: new Date().toISOString()} as ResourceImageDraft
  draft.baseline = imageDraftFingerprint(draft); return draft
}
export function imageDraftHasInput(draft: ResourceImageDraft): boolean {return !!draft.prompt.trim() || !!draft.references.length}
export function imageDraftDirty(draft: ResourceImageDraft): boolean {return imageDraftFingerprint(draft) !== draft.baseline}
export function imageDraftFromJob(trackId: string, job: ResourceJob, selectedResultId?: string): ResourceImageDraft {
  const references = job.references?.map(reference => ({...reference})) || (job.sourceAssetId ? [{assetId: job.sourceAssetId, role: 'subject' as const}] : [])
  const draft: ResourceImageDraft = {trackId, references, prompt: job.prompt, model: job.model, channelId: job.channelId, presetId: job.presetId, presetVersion: job.presetVersion, settings: {...DEFAULT_IMAGE_SETTINGS, ...job.settings}, restoredFromJobId: job.id, activeJobId: job.id, selectedResultId: selectedResultId || job.resultAssetIds[0], baseline: '', updatedAt: new Date().toISOString()}
  draft.baseline = imageDraftFingerprint(draft); return draft
}
/** Names and ids are snapshots; pixels remain in the resource store. */
export function writeImageDraft(draft: ResourceImageDraft, backup = false): string | null {
  const key = storageKey(draft.trackId, backup)
  memory.set(key, structuredClone(draft))
  try {localStorage.setItem(key, JSON.stringify({version: 1, draft})); return null}
  catch {return '当前环境无法持久保存创作草稿；本次页面内仍保留。'}
}
export function readImageDraft(trackId: string, backup = false): ResourceImageDraft | null {
  const key = storageKey(trackId, backup)
  const currentSession = memory.get(key); if (currentSession) return structuredClone(currentSession)
  try {
    const envelope = JSON.parse(localStorage.getItem(key) || 'null') as {version?: unknown; draft?: ResourceImageDraft} | null
    const draft = envelope?.draft
    if (envelope?.version === 1 && draft?.trackId === trackId && typeof draft.prompt === 'string' && typeof draft.model === 'string' && typeof draft.baseline === 'string'
      && Array.isArray(draft.references) && draft.references.length <= 100 && draft.references.every(item => typeof item.assetId === 'string' && ['subject', 'effect'].includes(item.role))
      && draft.settings && typeof draft.settings.size === 'string' && typeof draft.settings.quality === 'string' && typeof draft.settings.detail === 'string' && Number.isInteger(draft.settings.n) && draft.settings.n > 0 && draft.settings.n <= 100) return structuredClone(draft)
  } catch { /* A corrupt or unavailable browser store does not affect resource files. */ }
  const saved = memory.get(key); return saved ? structuredClone(saved) : null
}
export function clearReservedImageDraft(trackId: string): void {
  const key = storageKey(trackId, true); memory.delete(key)
  try {localStorage.removeItem(key)} catch { /* Memory backup still clears. */ }
}
export function moveImageReference(references: ResourceJobReference[], assetId: string, direction: -1 | 1): ResourceJobReference[] {
  const index = references.findIndex(item => item.assetId === assetId), reference = references[index]
  if (!reference) return references
  const group = references.filter(item => item.role === reference.role), position = group.findIndex(item => item.assetId === assetId), target = group[position + direction]
  if (!target) return references
  const otherIndex = references.findIndex(item => item.assetId === target.assetId), next = references.map(item => ({...item})); [next[index], next[otherIndex]] = [next[otherIndex], next[index]]; return next
}