// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ResourceAsset, ResourceJob} from '../src/track/resources.ts'
import {useResourceJobs, syncResourceJob} from '../src/client/useResourceJobs.ts'
import {saveResourceJob, readResourceReference, storeResourceResult} from '../src/client/resources-api.ts'
import {cancelTrackArtTask, ImagegenError, loadTrackArtTask, submitResourceImage} from '../src/client/imagegen.ts'
vi.mock('../src/client/resources-api.ts', () => ({saveResourceJob: vi.fn(), readResourceReference: vi.fn(), storeResourceResult: vi.fn()}))
vi.mock('../src/client/imagegen.ts', async original => ({...await original<typeof import('../src/client/imagegen.ts')>(), submitResourceImage: vi.fn(), loadTrackArtTask: vi.fn(), cancelTrackArtTask: vi.fn()}))
const trackId = 'job-client'
const source: ResourceAsset = {id: 'source-photo', trackId, kind: 'image', name: '真实原图', mime: 'image/jpeg', bytes: 10, url: '/source', source: 'upload', tags: [], candidate: false, metadata: {}, createdAt: '2026-10-05', updatedAt: '2026-10-05', usages: [], status: 'ready'}
const job = (extra: Partial<ResourceJob> = {}): ResourceJob => ({id: 'test-job', trackId, mode: 'text', prompt: '用户要求', model: 'chosen-model', status: 'queued', hostTaskId: 'host-task', resultAssetIds: [], createdAt: '2026-10-05', updatedAt: '2026-10-05', ...extra})
let container: HTMLDivElement, root: Root, controller: ReturnType<typeof useResourceJobs>, refresh: ReturnType<typeof vi.fn<() => Promise<void>>>, records: Map<string, ResourceJob>, events: string[]
function Harness({jobs = []}: {jobs?: ResourceJob[]}) {controller = useResourceJobs(trackId, jobs, refresh); return createElement('div', null, controller.error)}
async function render(jobs: ResourceJob[] = []) {await act(async () => root.render(createElement(Harness, {jobs})))}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); records = new Map(); events = []; refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  vi.mocked(saveResourceJob).mockImplementation(async (_id, value) => {events.push('save:' + value.status); records.set(value.id, structuredClone(value)); return value})
  vi.mocked(submitResourceImage).mockImplementation(async () => {events.push('host-submit'); return {taskId: 'host-new'}})
  vi.mocked(readResourceReference).mockResolvedValue('data:image/jpeg;base64,/9j/AA==')
  vi.mocked(loadTrackArtTask).mockResolvedValue({status: 'running', images: []})
  vi.mocked(cancelTrackArtTask).mockResolvedValue(undefined)
  vi.mocked(storeResourceResult).mockResolvedValue({...source, id: 'candidate', candidate: true, source: 'ai-generate'})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()})

describe('resource AI client submission and recovery', () => {
  it('persists immutable intent before calling host and sends exact selected photo and template snapshot', async () => {
    await render(); await act(async () => controller.submit({mode: 'edit', prompt: '提亮真实照片', model: 'chosen-model', channelId: 'cqai', source, template: {id: 'my-template', name: '我的模板', prompt: '旧模板原文', mode: 'edit', category: '', tags: [], version: 3, createdAt: '2026-10-05', updatedAt: '2026-10-05'}}))
    expect(events).toEqual(['save:submitting', 'host-submit', 'save:queued']); expect(readResourceReference).toHaveBeenCalledWith(source)
    expect(submitResourceImage).toHaveBeenCalledWith({mode: 'edit', prompt: '提亮真实照片', model: 'chosen-model', image: 'data:image/jpeg;base64,/9j/AA==', channelId: 'cqai'})
    expect([...records.values()][0]).toMatchObject({sourceAssetId: source.id, presetId: 'my-template', presetVersion: 3, prompt: '提亮真实照片', hostTaskId: 'host-new'})
  })
  it('never calls host if local job persistence fails', async () => {
    vi.mocked(saveResourceJob).mockRejectedValueOnce(new Error('本地保存失败')); await render(); await act(async () => controller.submit({mode: 'text', prompt: '插图', model: 'chosen-model'}))
    expect(submitResourceImage).not.toHaveBeenCalled(); expect(container.textContent).toContain('本地保存失败')
  })
  it('marks ambiguous response unknown and never automatically resubmits after navigation or timer', async () => {
    vi.mocked(submitResourceImage).mockRejectedValueOnce(new ImagegenError('响应中断', 'network-error'))
    await render(); await act(async () => controller.submit({mode: 'text', prompt: '插图', model: 'chosen-model'}))
    const stored = [...records.values()][0]; expect(stored.status).toBe('unknown'); expect(stored.hostTaskId).toBeUndefined(); expect(container.textContent).toContain('不会自动重新生成')
    vi.useFakeTimers(); await render([stored]); await act(async () => vi.advanceTimersByTimeAsync(12000)); expect(submitResourceImage).toHaveBeenCalledOnce(); expect(loadTrackArtTask).not.toHaveBeenCalled()
  })
  it('normalizes interrupted submit on reopen without inventing host identity or generating again', async () => {
    await render([job({id: 'interrupted', status: 'submitting', hostTaskId: undefined})]); expect(records.get('interrupted')).toMatchObject({status: 'unknown'}); expect(submitResourceImage).not.toHaveBeenCalled(); expect(loadTrackArtTask).not.toHaveBeenCalled()
  })
  it('serializes concurrent task recovery so a completed result is imported once', async () => {
    vi.mocked(loadTrackArtTask).mockResolvedValue({status: 'completed', images: [{dataUrl: 'data:image/png;base64,AAAA'}]})
    await Promise.all([syncResourceJob(trackId, job({id: 'concurrent'})), syncResourceJob(trackId, job({id: 'concurrent'}))])
    expect(loadTrackArtTask).toHaveBeenCalledOnce(); expect(storeResourceResult).toHaveBeenCalledOnce(); expect(records.get('concurrent')).toMatchObject({status: 'completed', resultAssetIds: ['candidate']})
  })
  it('keeps completed job when saving result fails and retries existing output without a new generation', async () => {
    vi.mocked(loadTrackArtTask).mockResolvedValue({status: 'completed', images: [{dataUrl: 'data:image/png;base64,AAAA'}]}); vi.mocked(storeResourceResult).mockRejectedValueOnce(new Error('磁盘写入失败'))
    const existing = job({id: 'save-retry'}); await syncResourceJob(trackId, existing); expect(records.get(existing.id)).toMatchObject({status: 'completed', resultAssetIds: []}); expect(records.get(existing.id)?.error).toContain('结果保存失败')
    await syncResourceJob(trackId, records.get(existing.id)!); expect(records.get(existing.id)?.resultAssetIds).toEqual(['candidate']); expect(submitResourceImage).not.toHaveBeenCalled()
  })
  it('queries actual host state after cancel instead of assuming cancellation succeeded', async () => {
    await render(); await act(async () => controller.cancel(job({id: 'cancel-check'})))
    expect(cancelTrackArtTask).toHaveBeenCalledWith('host-task'); expect(loadTrackArtTask).toHaveBeenCalledWith('host-task'); expect(records.get('cancel-check')?.status).toBe('running')
  })
})

describe('v2 ordered references and immutable generation intent', () => {
  it('uses effects-only references as an edit while retaining separate user and submitted prompts', async () => {
    await render()
    let result: ResourceJob | undefined
    await act(async () => {result = await controller.submit({prompt: '绘制我的山地旅行插图', model: 'chosen-model', references: [{asset: source, role: 'effect'}], settings: {size: '16:9', quality: '2k', n: 2, detail: ''}, restoredFromJobId: 'previous-job', maxReferenceImages: 5, maxOutputImages: 4})})
    expect(result?.id).toBe([...records.keys()][0])
    expect(result).toMatchObject({mode: 'edit', prompt: '绘制我的山地旅行插图', references: [{assetId: source.id, role: 'effect', name: source.name}], settings: {size: '16:9', quality: '2k', n: 2, detail: ''}, restoredFromJobId: 'previous-job'})
    expect(result?.submittedPrompt).toContain('仅提供效果参考')
    expect(vi.mocked(submitResourceImage).mock.calls[0][0]).toMatchObject({mode: 'edit', prompt: result?.submittedPrompt, image: 'data:image/jpeg;base64,/9j/AA==', settings: result?.settings})
  })
  it('uploads every reference in visible order and chooses the first subject for result lineage', async () => {
    const effect = {...source, id: 'effect-photo', name: '氛围参考'}, subject = {...source, id: 'subject-photo', name: '徒步主体'}
    vi.mocked(readResourceReference).mockImplementation(async asset => asset.id === effect.id ? 'data:image/png;base64,ZWZmZWN0' : 'data:image/jpeg;base64,c3ViamVjdA==')
    await render()
    await act(async () => controller.submit({prompt: '自然融合', model: 'chosen-model', references: [{asset: effect, role: 'effect'}, {asset: subject, role: 'subject'}], maxReferenceImages: 5}))
    expect(readResourceReference).toHaveBeenNthCalledWith(1, effect)
    expect(readResourceReference).toHaveBeenNthCalledWith(2, subject)
    expect(vi.mocked(submitResourceImage).mock.calls[0][0]).toMatchObject({mode: 'edit', image: 'data:image/png;base64,ZWZmZWN0', images: ['data:image/jpeg;base64,c3ViamVjdA==']})
    const saved = [...records.values()][0]
    expect(saved.sourceAssetId).toBe(subject.id)
    expect(saved.references).toEqual([{assetId: effect.id, role: 'effect', name: effect.name}, {assetId: subject.id, role: 'subject', name: subject.name}])
    expect(saved.submittedPrompt).toContain('图 1：效果参考（氛围参考）')
    expect(saved.submittedPrompt).toContain('图 2：主体参考（徒步主体）')
  })
  it('rejects unreadable reference batches before host submission or partial intent persistence', async () => {
    vi.mocked(readResourceReference).mockRejectedValueOnce(new Error('第二张参考图读取失败'))
    await render()
    let result: ResourceJob | undefined
    await act(async () => {result = await controller.submit({prompt: '效果融合', model: 'chosen-model', references: [{asset: source, role: 'subject'}, {asset: {...source, id: 'other'}, role: 'effect'}], maxReferenceImages: 5})})
    expect(result).toBeUndefined()
    expect(readResourceReference).toHaveBeenCalledTimes(2)
    expect(saveResourceJob).not.toHaveBeenCalled()
    expect(submitResourceImage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('读取失败')
  })
  it('rejects unknown multi-reference capability visibly without dropping any selected reference', async () => {
    await render()
    await act(async () => controller.submit({prompt: '效果融合', model: 'unknown-model', references: [{asset: source, role: 'subject'}, {asset: {...source, id: 'other'}, role: 'effect'}]}))
    expect(readResourceReference).not.toHaveBeenCalled()
    expect(submitResourceImage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('尚未核实')
  })
  it('returns the exact persisted unknown job when host response is ambiguous', async () => {
    vi.mocked(submitResourceImage).mockRejectedValueOnce(new ImagegenError('响应中断', 'network-error'))
    await render()
    let result: ResourceJob | undefined
    await act(async () => {result = await controller.submit({prompt: '文字新图', model: 'chosen-model', references: []})})
    expect(result).toMatchObject({status: 'unknown', mode: 'text', references: [], prompt: '文字新图'})
    expect(result?.id).toBe([...records.keys()][0])
    expect(submitResourceImage).toHaveBeenCalledOnce()
  })
  it('freezes reference identity and role during asynchronous image reads', async () => {
    let finish!: (value: string) => void
    vi.mocked(readResourceReference).mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
    await render()
    const mutable = {asset: {...source}, role: 'subject' as 'subject' | 'effect'}
    const request = {prompt: '原始要求', model: 'chosen-model', channelId: 'cqai', references: [mutable], settings: {size: 'auto', quality: 'auto', n: 1, detail: ''}}
    let pending!: Promise<ResourceJob | undefined>
    await act(async () => {pending = controller.submit(request)})
    mutable.asset.name = '改名后的照片'; mutable.asset.id = 'different-photo'; mutable.role = 'effect'; request.prompt = '改动要求'; request.settings.n = 4; request.channelId = 'different-channel'
    await act(async () => {finish('data:image/jpeg;base64,/9j/AA=='); await pending})
    const saved = [...records.values()][0]
    expect(saved).toMatchObject({prompt: '原始要求', channelId: 'cqai', references: [{assetId: source.id, role: 'subject', name: source.name}], settings: {n: 1}})
    expect(vi.mocked(submitResourceImage).mock.calls[0][0]).toMatchObject({channelId: 'cqai', settings: {n: 1}})
  })
})

describe('restored template snapshots and unsupported settings', () => {
  it('preserves deleted template id/version without loading or replacing the original user prompt', async () => {
    await render()
    let result: ResourceJob | undefined
    await act(async () => {result = await controller.submit({prompt: '原任务中修改过的用户要求', model: 'chosen-model', references: [], presetId: 'deleted-template-id', presetVersion: 7, restoredFromJobId: 'original-job'})})
    expect(result).toMatchObject({prompt: '原任务中修改过的用户要求', presetId: 'deleted-template-id', presetVersion: 7, restoredFromJobId: 'original-job'})
    expect(vi.mocked(submitResourceImage).mock.calls[0][0].prompt).toBe('原任务中修改过的用户要求')
  })
  it('lets a newly chosen template replace the historical template metadata explicitly', async () => {
    await render()
    await act(async () => controller.submit({prompt: '当前要求', model: 'chosen-model', references: [], presetId: 'deleted-template-id', presetVersion: 7, template: {id: 'new-template', name: '新模板', prompt: '模板原文', mode: 'both', category: '', tags: [], version: 2, createdAt: '2026-10-05', updatedAt: '2026-10-05'}}))
    expect([...records.values()][0]).toMatchObject({presetId: 'new-template', presetVersion: 2, prompt: '当前要求'})
  })
  it('keeps invalid restored settings unchanged and rejects before persistence or billed submission', async () => {
    await render()
    const settings = {size: '3:4', quality: '4k', n: 2, detail: 'high'}, snapshot = {...settings}
    await act(async () => controller.submit({prompt: '历史要求', model: '旧模型别名', references: [], settings, allowedSizes: ['auto', '1:1', '9:16', '16:9', '21:9'], allowedQualities: ['auto'], allowedDetails: [''], maxOutputImages: 1}))
    expect(settings).toEqual(snapshot)
    expect(saveResourceJob).not.toHaveBeenCalled()
    expect(submitResourceImage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('不支持这些输出参数')
  })
})
