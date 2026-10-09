import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadImagegenCatalog, loadTrackArtTask, submitResourceImage } from '../src/client/imagegen.ts'
import { etubaoTemplateImage, etubaoTemplateInput, loadEtubaoTemplates } from '../src/client/etubao-templates.ts'

const fetchMock = vi.fn<typeof fetch>()
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}})
beforeEach(() => {fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)})
afterEach(() => {vi.unstubAllGlobals()})
describe('resource image modes through existing host imagegen', () => {
  it('submits explicit text mode without uploading a selected photo', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'text-task'}}))
    expect(await submitResourceImage({mode: 'text', prompt: ' 山地旅行海报 ', model: '画图模型', image: 'data:image/png;base64,cGhvdG8='})).toEqual({taskId: 'text-task'})
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/dsh-imagegen/tasks/submit')
    expect(JSON.parse(init!.body as string)).toEqual({mode: 'text', prompt: '山地旅行海报', model: '画图模型', channelId: 'cqai', size: 'auto', quality: 'auto', n: 1, detail: ''})
  })
  it('requires a real photo for edit mode and never silently falls back to text', async () => {
    await expect(submitResourceImage({mode: 'edit', prompt: '自然修复', model: 'm'})).rejects.toMatchObject({code: 'invalid-reference'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not retry a failed submission with an unknown result', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    await expect(submitResourceImage({mode: 'text', prompt: '山地', model: 'm'})).rejects.toMatchObject({code: 'network-error'})
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
describe('read-only e图宝 reference adapter', () => {
  it('reads only one selected source and retains attribution when saving a personal copy', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, sourceId: 'handraw', cases: [
      {id: 42, title: '手绘旅行', prompt: '画旅行手账', category: 'travel', categoryZh: '旅行', styles: ['手绘'], scenes: ['山地'], sourceLabel: '@creator', sourceUrl: 'https://example.com/author', image: '42.png'},
    ]}))
    const cases = await loadEtubaoTemplates('handraw')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/dsh-imagegen/templates/list')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({source: 'handraw'})
    expect(etubaoTemplateInput('handraw', cases[0])).toMatchObject({name: '手绘旅行', prompt: '画旅行手账', mode: 'both', source: {sourceId: 'handraw', caseId: '42', sourceLabel: '@creator', sourceUrl: 'https://example.com/author'}})
    expect(etubaoTemplateImage('handraw', cases[0])).toBe('/api/dsh-imagegen/templates/image/handraw/42.png')
  })
  it('drops unsafe links/images and malformed prompts without importing cases into personal templates', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, sourceId: 'handraw', cases: [
      {id: 'a', title: '案例', prompt: '参考', sourceUrl: 'javascript:alert(1)', image: '../private.png'},
      {id: 'b', title: '缺提示词'}, null,
    ]}))
    const cases = await loadEtubaoTemplates('handraw')
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({sourceUrl: '', image: ''})
    expect(etubaoTemplateImage('handraw', cases[0])).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('rejects an unknown registry source or a wrong host source response', async () => {
    await expect(loadEtubaoTemplates('../outside')).rejects.toMatchObject({code: 'invalid-source'})
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(json({ok: true, sourceId: 'other', cases: []}))
    await expect(loadEtubaoTemplates('handraw')).rejects.toMatchObject({code: 'invalid-response'})
  })
})


describe('current e图宝 summary task protocol', () => {
  it('loads only the owned completed task result through tasks/get after summary polling', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [
      {id: 'other-task', status: 'completed', resultAvailable: true},
      {id: 'owned-task', status: 'completed', resultAvailable: true, request: {mode: 'edit', prompt: '美化'}},
    ]}))
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'owned-task', status: 'completed', result: {images: [{b64: 'cGljdHVyZQ==', mime: 'image/png'}]}}}))
    expect(await loadTrackArtTask('owned-task')).toEqual({status: 'completed', images: [{dataUrl: 'data:image/png;base64,cGljdHVyZQ=='}]})
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/dsh-imagegen/tasks/list', '/api/dsh-imagegen/tasks/get'])
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({id: 'owned-task'})
  })
  it('recovers an owned completed task omitted from the recent terminal summary limit', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'recent-other-task', status: 'completed', resultAvailable: true}]}))
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'owned-task', status: 'completed', result: {images: [{b64: 'cGljdHVyZQ==', mime: 'image/png'}]}}}))
    expect(await loadTrackArtTask('owned-task')).toMatchObject({status: 'completed', images: [{dataUrl: 'data:image/png;base64,cGljdHVyZQ=='}]})
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({id: 'owned-task'})
  })
  it('propagates task lookup transport failures so an omitted summary is not mistaken for an expired task', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: []}))
    fetchMock.mockRejectedValueOnce(new TypeError('connection lost'))
    await expect(loadTrackArtTask('owned-task')).rejects.toMatchObject({code: 'network-error'})
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('rejects a task detail for an unrelated id instead of reading its generated image', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'owned-task', status: 'completed', resultAvailable: true}]}))
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'other-task', status: 'completed', result: {images: [{b64: 'cGljdHVyZQ==', mime: 'image/png'}]}}}))
    await expect(loadTrackArtTask('owned-task')).rejects.toMatchObject({code: 'invalid-response', message: expect.stringContaining('不匹配')})
  })
  it('keeps polling lightweight before completion and never fetches unrelated payloads', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'owned-task', status: 'running', resultAvailable: false}, {id: 'other-task', status: 'completed', resultAvailable: true}]}))
    expect(await loadTrackArtTask('owned-task')).toEqual({status: 'running', images: []})
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})


describe('v2 verified capabilities and reference batches', () => {
  it('adds known CQAI forwarding capabilities using upstream ids rather than user-facing aliases', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, provider: {state: 'signed-in', models: [
      {alias: '我的默认模型', id: 'gpt-image-2'}, {alias: '未知模型', id: 'private-new-model'}, {alias: '文字模型', id: 'glm-image'}, {alias: '旧模型', id: 'dall-e-3'},
    ]}}))
    const catalog = await loadImagegenCatalog()
    expect(catalog.models[0]).toMatchObject({id: '我的默认模型', upstreamId: 'gpt-image-2', maxReferenceImages: 5, maxOutputImages: 4})
    expect(catalog.models[1].maxReferenceImages).toBeUndefined()
    expect(catalog.models[1].capabilityMessage).toContain('尚未核实')
    expect(catalog.models[2].maxReferenceImages).toBe(0)
    expect(catalog.models[3].maxOutputImages).toBe(1)
    expect(catalog.defaultModel).toBeNull()
  })
  it('sends first image in image and all remaining references in images with explicit output settings', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'multi-task'}}))
    await submitResourceImage({mode: 'edit', prompt: '融合主体与光线', model: 'known-model', image: 'data:image/png;base64,cHJpbWFyeQ==', images: ['data:image/jpeg;base64,ZXh0cmE=','data:image/webp;base64,dGhpcmQ='], maxReferenceImages: 5, settings: {size: '16:9', quality: '2k', n: 3, detail: ''}})
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({mode: 'edit', prompt: '融合主体与光线', model: 'known-model', channelId: 'cqai', image: 'data:image/png;base64,cHJpbWFyeQ==', images: ['data:image/jpeg;base64,ZXh0cmE=','data:image/webp;base64,dGhpcmQ='], size: '16:9', quality: '2k', n: 3, detail: ''})
  })
  it('rejects more than five references and unknown multi-reference capability before contacting the host', async () => {
    const image = 'data:image/png;base64,cHJpbWFyeQ=='
    await expect(submitResourceImage({mode: 'edit', prompt: '融合', model: 'known-model', image, images: Array(5).fill(image), maxReferenceImages: 5})).rejects.toMatchObject({code: 'too-many-references'})
    await expect(submitResourceImage({mode: 'edit', prompt: '融合', model: 'unknown-model', image, images: [image]})).rejects.toMatchObject({code: 'reference-capability-unknown'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects an invalid reference anywhere in the batch and does not drop it', async () => {
    await expect(submitResourceImage({mode: 'edit', prompt: '融合', model: 'known', image: 'data:image/png;base64,cHJpbWFyeQ==', images: ['data:image/svg+xml;base64,cGljdHVyZQ=='], maxReferenceImages: 5})).rejects.toMatchObject({code: 'invalid-reference'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects unsupported count instead of letting host clamp or DALL-E3 reduce it', async () => {
    await expect(submitResourceImage({mode: 'text', prompt: '插图', model: 'model', settings: {size: 'auto', quality: 'auto', n: 5, detail: ''}})).rejects.toMatchObject({code: 'invalid-settings'})
    await expect(submitResourceImage({mode: 'text', prompt: '插图', model: 'dall-e-3', maxOutputImages: 1, settings: {size: 'auto', quality: 'auto', n: 2, detail: ''}})).rejects.toMatchObject({code: 'unsupported-count'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('checks the combined 24 MiB host JSON limit after validating each individual image', async () => {
    const image = 'data:image/png;base64,' + 'AAAA'.repeat(3 * 1024 * 1024)
    await expect(submitResourceImage({mode: 'edit', prompt: '融合', model: 'known', image, images: [image], maxReferenceImages: 5})).rejects.toMatchObject({code: 'reference-batch-too-large'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('model-specific host settings and retained historical choices', () => {
  it('exposes exact DALL-E3 settings retained by current host without offering square-fallback ratios', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, provider: {state: 'signed-in', models: [{alias: '旧生图模型', id: 'dall-e-3'}]}}))
    const model = (await loadImagegenCatalog()).models[0]
    expect(model).toMatchObject({maxOutputImages: 1, allowedSizes: ['auto', '1:1', '9:16', '16:9', '21:9'], allowedQualities: ['auto'], allowedDetails: ['']})
    expect(model.allowedSizes).not.toContain('3:4')
  })
  it.each([
    {size: '3:4', quality: 'auto', n: 1, detail: ''},
    {size: 'auto', quality: '2k', n: 1, detail: ''},
    {size: 'auto', quality: 'auto', n: 1, detail: 'high'},
  ])('rejects DALL-E3 historical parameters that host would discard or replace', async settings => {
    const snapshot = {...settings}
    await expect(submitResourceImage({mode: 'text', prompt: '旅行海报', model: 'dall-e-3', settings})).rejects.toMatchObject({code: 'unsupported-settings'})
    expect(fetchMock).not.toHaveBeenCalled()
    expect(settings).toEqual(snapshot)
  })
  it('rejects unsupported restored settings for a user alias using verified catalog metadata', async () => {
    await expect(submitResourceImage({mode: 'text', prompt: '旅行海报', model: '任意别名', allowedSizes: ['auto', '1:1', '16:9', '9:16', '21:9'], allowedQualities: ['auto'], allowedDetails: [''], settings: {size: 'auto', quality: '4k', n: 1, detail: ''}})).rejects.toMatchObject({code: 'unsupported-settings'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not allow caller limits to override a known host single-output restriction', async () => {
    await expect(submitResourceImage({mode: 'text', prompt: '海报', model: 'dall-e-3', maxOutputImages: 4, settings: {size: 'auto', quality: 'auto', n: 2, detail: ''}})).rejects.toMatchObject({code: 'unsupported-count'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('allows a supported DALL-E3 ratio and unchanged defaults', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'supported-old-model'}}))
    await submitResourceImage({mode: 'text', prompt: '旅行海报', model: 'dall-e-3', settings: {size: '16:9', quality: 'auto', n: 1, detail: ''}})
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({size: '16:9', quality: 'auto', n: 1, detail: ''})
  })
  it('rejects unverified native-channel multi-reference and non-default output settings without switching channels', async () => {
    const image = 'data:image/png;base64,cHJpbWFyeQ=='
    await expect(submitResourceImage({mode: 'edit', prompt: '效果', model: 'grok-imagine-image', channelId: 'custom:native', image, images: [image], maxReferenceImages: 5})).rejects.toMatchObject({code: 'reference-channel-unverified'})
    await expect(submitResourceImage({mode: 'text', prompt: '效果', model: 'grok-imagine-image', channelId: 'custom:native', settings: {size: 'auto', quality: '4k', n: 1, detail: ''}})).rejects.toMatchObject({code: 'settings-channel-unverified'})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
