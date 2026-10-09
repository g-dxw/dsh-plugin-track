import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadImagePromptModels, optimizeImagePrompt} from '../src/client/image-prompt-ai.ts'
import {IMAGE_PROMPT_TIMEOUT_MS, type ImagePromptOptimizationRequest} from '../src/track/image-prompt.ts'
const fetchMock = vi.fn<typeof fetch>()
const input = (patch: Partial<ImagePromptOptimizationRequest> = {}): ImagePromptOptimizationRequest => ({model: 'vision-model', prompt: '保留真实山形和人物，改善光线', references: [{assetId: 'subject-photo', role: 'subject'}, {assetId: 'style-photo', role: 'effect'}], ...patch})
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json; charset=utf-8'}})
beforeEach(() => {vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset()})
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals()})
describe('image prompt same-origin adapter', () => {
  it('preserves verified vision capability and provider default while keeping text models', async () => {
    fetchMock.mockResolvedValue(reply({models: [{id: 'text', label: '文字', supportsVision: false}, {id: 'vision', label: '识图', supportsVision: true}], available: true, defaultModel: 'vision'}))
    expect(await loadImagePromptModels()).toEqual({models: [{id: 'text', label: '文字', supportsVision: false}, {id: 'vision', label: '识图', supportsVision: true}], available: true, defaultModel: 'vision'})
    expect(fetchMock.mock.calls[0][0]).toBe('/api/cqai-track/resource-prompt-models')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({method: 'GET', credentials: 'same-origin'})
  })
  it('does not guess an unavailable default or unknown image capability', async () => {
    fetchMock.mockResolvedValueOnce(reply({models: [{id: 'text', label: '文字', supportsVision: false}], available: true, defaultModel: 'missing'}))
    expect((await loadImagePromptModels()).defaultModel).toBeUndefined()
    fetchMock.mockResolvedValueOnce(reply({models: [{id: 'unknown', label: '未知'}], available: true}))
    await expect(loadImagePromptModels()).rejects.toThrow('目录格式无效')
  })
  it('sends only identities and exact ordered roles, not image URLs or arbitrary client metadata', async () => {
    fetchMock.mockResolvedValue(reply({ok: true, prompt: '结合主体内容与风格参考后的提示词', changes: ['保留山形']}))
    const raw = {...input({model: ' vision-model ', requirements: '保留人物'}), track: {secret: 'not transmitted'}, image: 'data:must-not-send', references: [{assetId: 'subject-photo', role: 'subject', url: 'https://never.example/image'}, {assetId: 'style-photo', role: 'effect', name: 'not transmitted'}]}
    expect(await optimizeImagePrompt('my-track', raw as ImagePromptOptimizationRequest)).toEqual({prompt: '结合主体内容与风格参考后的提示词', changes: ['保留山形']})
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/cqai-track/resource-prompt-optimize?id=my-track')
    expect(init).toMatchObject({method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-cqai-track': '1'}})
    expect(JSON.parse(init!.body as string)).toEqual({model: 'vision-model', prompt: input().prompt, requirements: '保留人物', references: [{assetId: 'subject-photo', role: 'subject'}, {assetId: 'style-photo', role: 'effect'}]})
  })
  it('accepts text-only rewriting with empty references', async () => {
    fetchMock.mockResolvedValue(reply({prompt: '文字优化', changes: []}))
    await optimizeImagePrompt('my-track', input({references: []}))
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).references).toEqual([])
  })
  it.each([
    ['../foreign', input()], ['my-track', input({prompt: ' '})], ['my-track', input({prompt: '字'.repeat(20001)})],
    ['my-track', input({model: ' '})], ['my-track', input({requirements: '字'.repeat(4001)})],
    ['my-track', input({references: Array.from({length: 6}, (_, n) => ({assetId: 'photo-' + n, role: 'subject'}))})],
    ['my-track', input({references: [{assetId: 'same', role: 'subject'}, {assetId: 'same', role: 'effect'}]})],
    ['my-track', {...input(), references: [null]}], ['my-track', input({references: [{assetId: 'photo', role: 'unknown' as 'subject'}]})]
  ])('rejects invalid input before any host request %#', async (trackId, value) => {
    await expect(optimizeImagePrompt(trackId, value as ImagePromptOptimizationRequest)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([{prompt: '', changes: []}, {prompt: '字'.repeat(20001), changes: []}, {prompt: '可用', changes: ['']}, {prompt: '可用', changes: Array(13).fill('变更')}, {prompt: '可用', changes: ['字'.repeat(501)]}])('rejects malformed optimized output %#', async value => {
    fetchMock.mockResolvedValue(reply(value))
    await expect(optimizeImagePrompt('my-track', input())).rejects.toThrow('原提示词已保留')
  })
  it('reports host error and non-JSON readiness failures', async () => {
    fetchMock.mockResolvedValueOnce(reply({error: '请先配置识图模型'}, 503))
    await expect(optimizeImagePrompt('my-track', input())).rejects.toThrow('请先配置识图模型')
    fetchMock.mockResolvedValueOnce(new Response('<html>old runtime</html>', {headers: {'content-type': 'text/html'}}))
    await expect(loadImagePromptModels()).rejects.toThrow('暂未就绪')
  })
  it('rejects an already aborted request without network activity', async () => {
    const signal = AbortSignal.abort()
    await expect(optimizeImagePrompt('my-track', input(), signal)).rejects.toMatchObject({name: 'AbortError'})
    await expect(loadImagePromptModels(signal)).rejects.toMatchObject({name: 'AbortError'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('forwards user cancellation and rejects even when a fetch implementation returns late', async () => {
    let finish!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
    const controller = new AbortController(), pending = optimizeImagePrompt('my-track', input(), controller.signal)
    controller.abort(); finish(reply({prompt: 'late result', changes: []}))
    await expect(pending).rejects.toMatchObject({name: 'AbortError'})
    expect((fetchMock.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true)
  })
  it('accepts a 90-second optimization response without aborting at the old browser deadline', async () => {
    vi.useFakeTimers()
    const value={prompt:'延迟完成的参考图提示词',changes:['保留照片主体']}
    fetchMock.mockImplementationOnce(()=>new Promise(resolve=>setTimeout(()=>resolve(reply(value)),90_000)))
    const pending=optimizeImagePrompt('my-track',input()),forwarded=fetchMock.mock.calls[0][1]!.signal as AbortSignal
    await vi.advanceTimersByTimeAsync(65_001);expect(forwarded.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(24_999);await expect(pending).resolves.toEqual(value)
    expect(forwarded.aborted).toBe(false);expect(fetchMock).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })
  it('still allows user cancellation after 65 seconds and ignores a late response', async () => {
    vi.useFakeTimers()
    let finish!: (value:Response)=>void
    fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const controller=new AbortController(),request=input(),before=structuredClone(request)
    const pending=optimizeImagePrompt('my-track',request,controller.signal)
    const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
    const forwarded=fetchMock.mock.calls[0][1]!.signal as AbortSignal
    await vi.advanceTimersByTimeAsync(65_001);expect(forwarded.aborted).toBe(false)
    controller.abort();expect(forwarded.aborted).toBe(true)
    finish(reply({prompt:'取消后迟到结果',changes:[]}));await rejected
    expect(request).toEqual(before);expect(fetchMock).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps the model catalog browser deadline at 65 seconds', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))))
    const pending=loadImagePromptModels(),rejected=expect(pending).rejects.toThrow('超时')
    const forwarded=fetchMock.mock.calls[0][1]!.signal as AbortSignal
    await vi.advanceTimersByTimeAsync(64_999);expect(forwarded.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1);await rejected
    expect(forwarded.aborted).toBe(true);expect(fetchMock).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })
  it('enforces the optimization browser deadline at 315 seconds independently of user cancellation', async () => {
    expect(IMAGE_PROMPT_TIMEOUT_MS+15_000).toBe(315_000)
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const pending = optimizeImagePrompt('my-track', input())
    const check = expect(pending).rejects.toThrow('超时')
    const forwarded=fetchMock.mock.calls[0][1]!.signal as AbortSignal
    await vi.advanceTimersByTimeAsync(65_000);expect(forwarded.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(IMAGE_PROMPT_TIMEOUT_MS+15_000-65_000-1);expect(forwarded.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1);await check
    expect(forwarded.aborted).toBe(true);expect(fetchMock).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })
})
