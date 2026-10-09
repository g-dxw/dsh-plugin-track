// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {TrackRecord} from '../src/protocol.ts'
import type {ResourceAsset, ResourceJob, ResourceLibraryEnvelope} from '../src/track/resources.ts'
import {ResourceImageWorkspace, type ResourceImageRestore} from '../src/client/ResourceImageWorkspace.tsx'
import {ResourceImageHistory} from '../src/client/ResourceImageHistory.tsx'
import {loadImagePromptModels, optimizeImagePrompt} from '../src/client/image-prompt-ai.ts'
import {loadResourceLibrary, updateResource, uploadResource} from '../src/client/resources-api.ts'
import {IMAGEGEN_RESOURCE_SETTINGS_DEFAULT, IMAGEGEN_RESOURCE_SIZES, IMAGEGEN_RESOURCE_QUALITIES, loadImagegenCatalog} from '../src/client/imagegen.ts'
import {emptyImageDraft, imageDraftDirty, imageDraftFromJob, readImageDraft, writeImageDraft} from '../src/client/resource-image-draft.ts'
vi.mock('../src/client/image-prompt-ai.ts', () => ({loadImagePromptModels: vi.fn(), optimizeImagePrompt: vi.fn()}))
const state = vi.hoisted(() => ({submit: vi.fn(), refresh: undefined as undefined | (() => Promise<void>), templateProps: undefined as any}))
vi.mock('../src/client/useResourceJobs.ts', () => ({useResourceJobs: (_id: string, _jobs: unknown, refresh: () => Promise<void>) => {state.refresh = refresh; return {working: false, error: '', submit: state.submit, sync: vi.fn(), cancel: vi.fn(), clearError: vi.fn()}}}))
vi.mock('../src/client/resources-api.ts', async original => ({...await original<typeof import('../src/client/resources-api.ts')>(), loadResourceLibrary: vi.fn(), updateResource: vi.fn(), uploadResource: vi.fn(), prepareResourcePreview: vi.fn().mockResolvedValue(undefined)}))
vi.mock('../src/client/imagegen.ts', async original => ({...await original<typeof import('../src/client/imagegen.ts')>(), loadImagegenCatalog: vi.fn()}))
vi.mock('../src/client/PromptTemplateLibrary.tsx', () => ({PromptTemplateLibrary: (props: any) => {state.templateProps = props; return createElement('div', {role: 'dialog'}, createElement('button', {onClick: () => props.onUse('案例完整提示词')}, '套用参考案例'))}}))
let counter = 0, track: TrackRecord, library: ResourceLibraryEnvelope, container: HTMLDivElement, root: Root
let onBack: ReturnType<typeof vi.fn<() => void>>, onHistory: ReturnType<typeof vi.fn<() => void>>, onUse: ReturnType<typeof vi.fn<(asset: ResourceAsset) => Promise<void>>>, onRestore: ReturnType<typeof vi.fn<(job: ResourceJob, resultId?: string) => void>>
function asset(id: string, name = id, extra: Partial<ResourceAsset> = {}): ResourceAsset {return {id, trackId: track.id, kind: 'image', name, mime: 'image/png', bytes: 20, url: `/api/cqai-track/resource-file?id=${track.id}&assetId=${id}`, sourceUrl: `/api/cqai-track/placemark-photo?id=${track.id}&file=${'a'.repeat(64)}.png`, source: 'upload', tags: [], candidate: false, metadata: {}, createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', usages: [], status: 'ready', ...extra}}
function task(extra: Partial<ResourceJob> = {}): ResourceJob {return {id: 'history-task', trackId: track.id, mode: 'edit', sourceAssetId: 'a2', references: [{assetId: 'a2', role: 'subject', name: '背包'}, {assetId: 'a1', role: 'subject', name: '山景'}, {assetId: 'e1', role: 'effect', name: '效果样图'}], prompt: '  历史完整要求\n第二行  ', model: 'host-model', channelId: 'cqai', presetId: 'deleted-template', presetVersion: 7, settings: {size: '16:9', quality: '2k', n: 2, detail: ''}, status: 'completed', resultAssetIds: ['r1', 'r2'], resultsPersisted: true, createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', ...extra}}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes}); return {promise, resolve}}
function button(text: string, scope: ParentNode = container) {const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!result) throw new Error('Missing button ' + text); return result}
async function click(text: string, scope?: ParentNode) {await act(async () => button(text, scope).click())}
async function edit(label: string, value: string) {await act(async () => {const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', {bubbles: true}))})}
async function render(extra: Record<string, unknown> = {}) {await act(async () => root.render(createElement(ResourceImageWorkspace, {track, onBack, onHistory, onUseImage: onUse, ...extra})))}
async function history() {await act(async () => root.render(createElement(ResourceImageHistory, {track, onBack, onRestore})))}
async function picker(role: '主体' | '效果', ids: string[]) {await click('从资源库选择', container.querySelector(`[aria-label="${role}参考图"]`)!); await act(async () => {for (const id of ids) container.querySelector<HTMLInputElement>(`[aria-label="选择参考图片：${library.assets.find(asset => asset.id === id)!.name}"]`)!.click()}); await click(`添加到${role}参考`)}
function prompt() {return container.querySelector<HTMLTextAreaElement>('[aria-label="图片创作提示词"]')!.value}
function references(role: '主体' | '效果') {return [...container.querySelectorAll<HTMLElement>(`[aria-label="${role}参考图"] .trk-i-reference-copy`)].map(item => item.textContent)}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); state.templateProps = undefined; state.refresh = undefined
  track = {id: `image-workspace-${++counter}`, name: '旅程图片创作测试', filename: 'route.gpx', format: 'gpx', createdAt: '2026-10-05', points: 0, bytes: 1, coordinates: [], metrics: {distance: 0, elevationGain: 0, elevationLoss: 0, duration: 0, elevationMin: null, elevationMax: null, bbox: null}}
  library = {revision: '1', assets: [asset('a1', '山景'), asset('a2', '背包'), asset('e1', '效果样图'), asset('r1', '结果一', {candidate: true, source: 'ai-edit', jobId: 'history-task'}), asset('r2', '结果二', {candidate: true, source: 'ai-edit', jobId: 'history-task'})], jobs: []}
  vi.mocked(loadImagePromptModels).mockResolvedValue({available: true, defaultModel: 'vision-text', models: [{id: 'vision-text', label: '宿主识图模型', supportsVision: true}]})
  vi.mocked(optimizeImagePrompt).mockResolvedValue({prompt: '依据实际山景优化光影', changes: ['保留参考中的山脊与装备']})
  vi.mocked(loadResourceLibrary).mockImplementation(async () => structuredClone(library))
  vi.mocked(updateResource).mockImplementation(async (_id, id, patch) => {const index = library.assets.findIndex(asset => asset.id === id); library.assets[index] = {...library.assets[index], ...patch} as ResourceAsset; return structuredClone(library.assets[index])})
  vi.mocked(loadImagegenCatalog).mockResolvedValue({available: true, defaultModel: 'host-model', models: [{id: 'host-model', label: '宿主已支持模型', channelId: 'cqai', maxReferenceImages: 5, maxOutputImages: 4, allowedSizes: IMAGEGEN_RESOURCE_SIZES, allowedQualities: IMAGEGEN_RESOURCE_QUALITIES}]})
  state.submit.mockImplementation(async input => {const job = task({id: 'new-task', prompt: input.prompt, model: input.model, status: 'queued', resultAssetIds: [], resultsPersisted: false}); library.jobs.push(job); await state.refresh?.(); return job})
  onBack = vi.fn<() => void>(); onHistory = vi.fn<() => void>(); onUse = vi.fn<(asset: ResourceAsset) => Promise<void>>().mockResolvedValue(undefined); onRestore = vi.fn<(job: ResourceJob, resultId?: string) => void>(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()})

describe('unified independent AI image composition', () => {
  it('starts with empty prompt and references, preserves selected image order and never auto-submits', async () => {
    await render({initialAssetIds: ['a2', 'a1']}); expect(prompt()).toBe(''); expect(references('主体')[0]).toContain('主体1 · 主图背包'); expect(references('主体')[1]).toContain('山景'); expect(references('效果')).toHaveLength(0); expect(container.querySelector('[role=dialog]')).toBeNull(); expect(state.submit).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('AI 美化')
  })
  it('supports effect-only reference input and preserves exact user prompt without a mode switch', async () => {
    await render(); await picker('效果', ['e1']); const value = '  {"要求":"保留用户文本"}\n  '
    await edit('图片创作提示词', value); await click('生成图片'); expect(state.submit).toHaveBeenCalledWith(expect.objectContaining({prompt: value, references: [{asset: expect.objectContaining({id: 'e1'}), role: 'effect'}]})); expect(state.submit.mock.calls[0][0].mode).toBeUndefined()
  })
  it('moves duplicate input to its chosen role instead of sending the same image twice', async () => {
    await render({initialAssetIds: ['a1']}); await picker('效果', ['a1', 'e1']); expect(container.querySelector('[aria-label="选择参考图用途"]')).not.toBeNull(); await click('移到效果组'); expect(references('主体')).toHaveLength(0); expect(references('效果')).toHaveLength(2)
    await edit('图片创作提示词', '按照效果参考创作'); await click('生成图片'); const input = state.submit.mock.calls[0][0]; expect(input.references.map((reference: any) => reference.asset.id)).toEqual(['a1', 'e1']); expect(input.references.every((reference: any) => reference.role === 'effect')).toBe(true)
  })
  it('keeps model limits visible and blocks unsupported multi-reference input', async () => {
    vi.mocked(loadImagegenCatalog).mockResolvedValue({available: true, defaultModel: 'unknown', models: [{id: 'unknown', label: '未知能力模型', channelId: 'cqai'}]})
    await render({initialAssetIds: ['a1', 'a2']}); await edit('图片创作提示词', '多图要求'); expect(button('生成图片').disabled).toBe(true); expect(container.textContent).toContain('尚未确认多参考图能力'); expect(state.submit).not.toHaveBeenCalled()
  })
  it('restores complete historical configuration, chosen result and deleted template snapshot without generating', async () => {
    const job = task(); library.jobs.push(job); await render({restore: {job, resultAssetId: 'r2', token: 'restore-1'}})
    expect(prompt()).toBe(job.prompt); expect(references('主体')[0]).toContain('背包'); expect(references('效果')[0]).toContain('效果样图'); expect(container.querySelector<HTMLSelectElement>('[aria-label="图片画幅"]')!.value).toBe('16:9'); expect(container.querySelector<HTMLButtonElement>('[aria-label="选择生成结果2"]')!.getAttribute('aria-pressed')).toBe('true'); expect(state.submit).not.toHaveBeenCalled()
    await click('生成图片'); expect(state.submit).toHaveBeenCalledWith(expect.objectContaining({prompt: job.prompt, channelId: 'cqai', presetId: 'deleted-template', presetVersion: 7, restoredFromJobId: job.id, settings: job.settings})); expect(state.submit.mock.calls[0][0].references.map((reference: any) => reference.asset.id)).toEqual(['a2', 'a1', 'e1'])
  })
  it('preserves a modified draft before restore and can recover it later', async () => {
    await render(); await edit('图片创作提示词', '不能丢失的草稿'); const job = task(); library.jobs.push(job)
    await render({restore: {job, token: 'restore-dirty-1'}}); expect(prompt()).toBe('不能丢失的草稿'); await click('留在当前创作'); expect(prompt()).toBe('不能丢失的草稿')
    await render({restore: {job, token: 'restore-dirty-2'}}); await click('保留草稿并恢复'); expect(prompt()).toBe(job.prompt); expect(readImageDraft(track.id, true)?.prompt).toBe('不能丢失的草稿'); await click('恢复保留的草稿'); expect(prompt()).toBe('不能丢失的草稿'); expect(state.submit).not.toHaveBeenCalled()
  })
  it('blocks missing and unreadable reference files until explicitly removed', async () => {
    library.assets.find(asset => asset.id === 'a2')!.status = 'error'; const job = task({references: [{assetId: 'gone', role: 'subject', name: '已删除的原图'}, {assetId: 'a2', role: 'effect', name: '文件已丢失'}], settings: {...IMAGEGEN_RESOURCE_SETTINGS_DEFAULT}}); library.jobs.push(job)
    await render({restore: {job, token: 'missing'}}); expect(button('生成图片').disabled).toBe(true); expect(container.textContent).toContain('2 张参考图已缺失'); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除主体1"]')!.click()); expect(button('生成图片').disabled).toBe(true); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除效果1"]')!.click()); expect(button('生成图片').disabled).toBe(false)
  })
  it('uses only subject references for comparison and stops comparison after moving the last subject', async () => {
    const job = task({references: [{assetId: 'a1', role: 'subject'}], settings: {...IMAGEGEN_RESOURCE_SETTINGS_DEFAULT}}); library.jobs.push(job); await render({restore: {job, token: 'compare'}}); await click('对比'); expect(container.querySelectorAll('.trk-i-compare img')).toHaveLength(2)
    await click('移到效果', container.querySelector('[aria-label="主体参考图"]')!); expect(container.querySelector('.trk-i-compare')).toBeNull(); expect([...container.querySelectorAll('button')].some(button => button.textContent === '对比')).toBe(false)
  })
  it('queues a second reference group during upload and disables upload controls', async () => {
    const first = deferred<ResourceAsset>()
    vi.mocked(uploadResource).mockImplementation(async (_id, file, progress) => {const saved = file.name === 'subject-a.png' ? await first.promise : asset(file.name.replace('.png', ''), file.name); library.assets.push(saved); progress?.(100); return saved})
    await render(); const subject = container.querySelector<HTMLInputElement>('[aria-label="上传主体参考图"]')!, effect = container.querySelector<HTMLInputElement>('[aria-label="上传效果参考图"]')!
    Object.defineProperty(subject, 'files', {value: [new File(['a'], 'subject-a.png', {type: 'image/png'}), new File(['b'], 'subject-b.png', {type: 'image/png'})], configurable: true}); Object.defineProperty(effect, 'files', {value: [new File(['c'], 'effect-a.png', {type: 'image/png'})], configurable: true})
    await act(async () => {subject.dispatchEvent(new Event('change', {bubbles: true})); effect.dispatchEvent(new Event('change', {bubbles: true}))}); expect(subject.disabled).toBe(true); expect(effect.disabled).toBe(true); expect(container.textContent).toContain('效果参考图已排队')
    await act(async () => first.resolve(asset('subject-a', 'subject-a.png'))); expect(uploadResource).toHaveBeenCalledTimes(3); expect(references('主体')).toHaveLength(2); expect(references('效果')).toHaveLength(1); expect(subject.disabled).toBe(false)
  })
  it('saves selected result before applying to a point and refuses use on save failure', async () => {
    const job = task(); library.jobs.push(job); await render({restore: {job, resultAssetId: 'r2', token: 'use-result'}}); vi.mocked(updateResource).mockRejectedValueOnce(new Error('无法保存'))
    await click('添加到点位'); expect(onUse).not.toHaveBeenCalled(); await click('添加到点位'); expect(updateResource).toHaveBeenLastCalledWith(track.id, 'r2', {candidate: false}); expect(onUse).toHaveBeenCalledWith(expect.objectContaining({id: 'r2', candidate: false}))
  })
  it('retains unavailable model and unsupported historical settings until explicit changes', async () => {
    vi.mocked(loadImagegenCatalog).mockResolvedValue({available: true, defaultModel: 'dalle', models: [{id: 'dalle', label: '受限模型', channelId: 'cqai', maxReferenceImages: 1, maxOutputImages: 1, allowedSizes: ['auto', '1:1'], allowedQualities: ['auto'], allowedDetails: ['']}]})
    const job = task({model: 'dalle', references: [], settings: {size: '3:4', quality: '4k', n: 1, detail: ''}}); library.jobs.push(job); await render({restore: {job, token: 'unsupported'}}); expect(button('生成图片').disabled).toBe(true); expect(container.querySelector<HTMLSelectElement>('[aria-label="图片画幅"]')!.value).toBe('3:4'); await click('恢复自动设置'); expect(button('生成图片').disabled).toBe(false)
    await render({restore: {job: {...job, model: 'removed-model'}, token: 'unavailable-model'}}); await click('保留草稿并恢复'); expect(button('生成图片').disabled).toBe(true); expect(container.textContent).toContain('原模型当前不可用'); expect(container.querySelector<HTMLSelectElement>('[aria-label="AI 创作模型"]')!.value).toBe('removed-model')
  })
  it('traps reference picker focus and Escape closes without adding references', async () => {
    await render(); await click('从资源库选择', container.querySelector('[aria-label="主体参考图"]')!); const dialog = container.querySelector<HTMLElement>('[role=dialog]')!
    await act(async () => {container.querySelector<HTMLInputElement>('[aria-label="选择参考图片：山景"]')!.click()}); const last = button('添加到主体参考', dialog); last.focus(); await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true}))); expect(document.activeElement).toBe(button('关闭选择', dialog))
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))); expect(container.querySelector('[role=dialog]')).toBeNull(); expect(references('主体')).toHaveLength(0)
  })
})

describe('image task history gallery', () => {
  it('groups actual outputs by task and restores the clicked result with complete task configuration', async () => {
    const job = task(); library.jobs.push(job); await history(); expect(container.querySelectorAll('.trk-i-history-card')).toHaveLength(1); expect(container.textContent).toContain('2 张结果'); await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === `任务结果 2：${job.prompt}`)!.click()); await act(async () => container.querySelector<HTMLButtonElement>('.trk-i-history-image')!.click()); expect(onRestore).toHaveBeenCalledWith(job, 'r2'); expect(state.submit).not.toHaveBeenCalled()
  })
  it('zooms without restoring or changing a draft and shows pending/failed/canceled status cards', async () => {
    library.jobs.push(task(), task({id: 'pending', prompt: '正在执行', status: 'running', resultAssetIds: [], resultsPersisted: false}), task({id: 'failed', prompt: '失败任务', status: 'failed', resultAssetIds: [], error: '宿主生成失败'}), task({id: 'canceled', prompt: '取消任务', status: 'canceled', resultAssetIds: []}))
    await history(); expect(container.querySelectorAll('.trk-i-history-card')).toHaveLength(4); expect(container.querySelectorAll('.trk-i-history-placeholder')).toHaveLength(3); await click('放大'); expect(container.querySelector('[role=dialog]')).not.toBeNull(); expect(onRestore).not.toHaveBeenCalled(); await click('关闭预览'); expect(container.querySelector('[role=dialog]')).toBeNull()
  })
  it('filters by actual task state and preserves failed input for restoration', async () => {
    const failed = task({id: 'failed', prompt: '失败要求原文', status: 'failed', resultAssetIds: []}); library.jobs.push(task(), failed)
    await history(); await act(async () => {const field = container.querySelector<HTMLSelectElement>('[aria-label="历史任务状态"]')!; field.value = 'failed'; field.dispatchEvent(new Event('change', {bubbles: true}))}); expect(container.querySelectorAll('.trk-i-history-card')).toHaveLength(1); await click('恢复任务'); expect(onRestore).toHaveBeenCalledWith(failed, undefined)
  })
})

describe('durable reference-id drafts', () => {
  it('recovers the newest in-memory draft after localStorage quota failure instead of an older saved copy', () => {
    const draft = emptyImageDraft(track.id); draft.prompt = '较旧文本'; expect(writeImageDraft(draft)).toBeNull(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('quota')}); draft.prompt = '最新不能丢失的文本'; expect(writeImageDraft(draft)).toContain('无法持久保存'); expect(readImageDraft(track.id)?.prompt).toBe(draft.prompt)
  })
  it('counts settings/model-only modifications as dirty and snapshots ordered refs/channel/template', () => {
    const draft = emptyImageDraft(track.id); draft.settings.size = '16:9'; expect(imageDraftDirty(draft)).toBe(true); draft.settings.size = 'auto'; draft.model = 'chosen'; expect(imageDraftDirty(draft)).toBe(true)
    const restored = imageDraftFromJob(track.id, task(), 'r2'); expect(restored.references.map(reference => reference.assetId)).toEqual(['a2', 'a1', 'e1']); expect(restored).toMatchObject({channelId: 'cqai', presetId: 'deleted-template', presetVersion: 7, selectedResultId: 'r2'}); expect(imageDraftDirty(restored)).toBe(false); expect(JSON.stringify(restored)).not.toContain('data:image')
  })
})

describe('prompt optimizer composer integration', () => {
  it('opens template adaptation without changing the draft, preserves source attribution, applies only with acceptance, and can undo', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render({initialAssetIds: ['a2', 'a1']}); await picker('效果', ['e1']); await edit('图片创作提示词', '最初完整草稿'); await click('参考 e图宝')
    const source = {kind: 'etubao', sourceId: 'vibeui', caseId: 'case-1', sourceLabel: '作者案例', sourceUrl: 'https://example.com/author', homepage: 'https://example.com/'}
    await act(async () => state.templateProps.onOptimizeUse('原案例提示词', undefined, {name: '山间旅行案例', source}))
    expect(prompt()).toBe('最初完整草稿'); expect(optimizeImagePrompt).not.toHaveBeenCalled(); await click('优化提示词')
    expect(optimizeImagePrompt).toHaveBeenCalledWith(track.id, expect.objectContaining({prompt: '原案例提示词', references: [{assetId: 'a2', role: 'subject'}, {assetId: 'a1', role: 'subject'}, {assetId: 'e1', role: 'effect'}]}), expect.any(AbortSignal)); expect(prompt()).toBe('最初完整草稿'); await click('应用到提示词')
    expect(prompt()).toBe('依据实际山景优化光影'); expect(container.textContent).toContain('AI 调整自：山间旅行案例'); expect(readImageDraft(track.id)?.promptAttribution).toMatchObject({adapted: true, source}); expect(state.submit).not.toHaveBeenCalled(); expect(references('主体')[0]).toContain('背包')
    await click('撤销提示词优化'); expect(prompt()).toBe('最初完整草稿'); expect(state.submit).not.toHaveBeenCalled(); expect(readImageDraft(track.id)?.promptUndo).toBeUndefined()
  })
  it('keeps the current draft when the user cancels the reviewed optimization preview', async () => {
    await render(); await edit('图片创作提示词', '不能替换的原稿'); await click('继续调整'); await edit('提示词调整要求', '更自然'); await click('优化提示词')
    expect(prompt()).toBe('不能替换的原稿'); expect(container.querySelector('[aria-label="继续调整提示词"]')).not.toBeNull(); expect(state.submit).not.toHaveBeenCalled(); await click('关闭优化'); expect(prompt()).toBe('不能替换的原稿')
  })
  it('retains the personal template version as adapted attribution without saving over the template or submitting an image', async () => {
    await render(); await click('我的模板'); const chosen = {id: 'personal', name: '旅行曝光', prompt: '原模板', category: '旅行', tags: [], mode: 'both', version: 4, createdAt: '', updatedAt: ''}
    await act(async () => state.templateProps.onOptimizeUse(chosen.prompt, chosen)); await click('优化提示词'); await click('应用到提示词')
    expect(readImageDraft(track.id)).toMatchObject({prompt: '依据实际山景优化光影', presetId: 'personal', presetVersion: 4, promptAttribution: {name: '旅行曝光', adapted: true, templateId: 'personal', templateVersion: 4}}); expect(state.submit).not.toHaveBeenCalled(); expect(chosen.prompt).toBe('原模板')
  })
})
