import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackArtTask, loadImagegenCatalog, loadTrackArtTask, submitTrackArt } from '../src/client/imagegen.ts'

const PNG = 'data:image/png;base64,aGVsbG8='
const INPUT = {prompt: '保留轨迹和地点，绘制山地旅行地图', image: PNG, model: '画图模型'}
const fetchMock = vi.fn<typeof fetch>()

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json; charset=utf-8'}})
}

function provider(models: unknown[], extra: Record<string, unknown> = {}): void {
  fetchMock.mockResolvedValueOnce(json({ok: true, provider: {provider: 'cqai', state: 'signed-in', models, ...extra}}))
}

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('existing imagegen catalog', () => {
  it('maps account default upstream id to the alias and reads only the safe provider view', async () => {
    provider([{alias: '画图模型', id: 'upstream-a'}, {alias: '另一个模型', id: 'upstream-b'}], {defaultModel: 'upstream-b'})
    expect(await loadImagegenCatalog()).toEqual({
      models: [{id: '画图模型', label: '画图模型', channelId: 'cqai'}, {id: '另一个模型', label: '另一个模型', channelId: 'cqai'}],
      defaultModel: '另一个模型', available: true,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/dsh-imagegen/cqai/provider')
    expect(init).toMatchObject({method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'}})
    expect(JSON.parse(init!.body as string)).toEqual({refresh: false})
  })

  it('keeps a multiple-model catalog unselected without an account default', async () => {
    provider([{alias: 'a', id: 'one'}, {alias: 'b', id: 'two'}])
    expect(await loadImagegenCatalog()).toMatchObject({available: true, defaultModel: null})
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('permits the sole model and recognizes a default alias without silently picking among several', async () => {
    provider([{alias: 'a', id: 'one'}])
    expect(await loadImagegenCatalog()).toMatchObject({defaultModel: 'a'})
    provider([{alias: 'a', id: 'one'}, {alias: 'b', id: 'two'}], {defaultModel: 'b'})
    expect(await loadImagegenCatalog()).toMatchObject({defaultModel: 'b'})
    provider([{alias: 'a', id: 'one'}, {alias: 'b', id: 'two'}], {defaultModel: 'removed'})
    expect(await loadImagegenCatalog()).toMatchObject({defaultModel: null})
  })

  it('filters malformed and duplicate aliases and retains a catalog warning', async () => {
    provider([null, {}, {alias: '', id: 'one'}, {alias: 'a'}, {alias: 'a', id: 'one'}, {alias: 'a', id: 'one'}], {warning: '正在使用缓存模型目录'})
    expect(await loadImagegenCatalog()).toEqual({models: [{id: 'a', label: 'a', channelId: 'cqai'}], defaultModel: 'a', available: true, message: '正在使用缓存模型目录'})
  })

  it.each([
    ['signed-out', '登录 CQAI'], ['authorizing', '正在登录'], ['reauth-required', '已过期'], ['error', '暂不可用'],
  ])('does not enable submission for provider state %s', async (state, message) => {
    provider([], {state})
    expect(await loadImagegenCatalog()).toMatchObject({available: false, models: [], defaultModel: null, message: expect.stringContaining(message)})
  })

  it('reports no image models and preserves the host account message', async () => {
    provider([])
    expect(await loadImagegenCatalog()).toMatchObject({available: false, message: '当前账号没有可用的生图模型'})
    provider([], {state: 'error', message: '账号服务暂不可用'})
    expect(await loadImagegenCatalog()).toMatchObject({available: false, message: '账号服务暂不可用'})
  })

  it.each([200, 404])('recognizes an HTML fallback at HTTP %s as an unavailable plugin', async status => {
    fetchMock.mockResolvedValueOnce(new Response('<!doctype html><html>DSH</html>', {status, headers: {'content-type': 'text/html'}}))
    expect(await loadImagegenCatalog()).toEqual({models: [], defaultModel: null, available: false, message: expect.stringContaining('生图插件未启用或不可用')})
  })

  it('reports connection and malformed catalog failures without submitting an image request', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await loadImagegenCatalog()).toMatchObject({available: false, message: expect.stringContaining('无法连接生图服务')})
    fetchMock.mockResolvedValueOnce(json({ok: true, provider: {models: null}}))
    expect(await loadImagegenCatalog()).toMatchObject({available: false, message: expect.stringContaining('模型目录格式无效')})
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/cqai/provider'))).toBe(true)
  })
})

describe('explicit image-edit submission', () => {
  it('submits one PNG reference through the real host queue without any credentials or upstream URL', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'owned-task', status: 'queued'}}))
    expect(await submitTrackArt({...INPUT, prompt: ` ${INPUT.prompt} `})).toEqual({taskId: 'owned-task'})
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/dsh-imagegen/tasks/submit')
    expect(init).toMatchObject({method: 'POST', credentials: 'same-origin'})
    expect(init!.headers).toEqual({'content-type': 'application/json'})
    expect(JSON.parse(init!.body as string)).toEqual({
      mode: 'edit', prompt: INPUT.prompt, model: INPUT.model, image: PNG, channelId: 'cqai',
      size: 'auto', quality: 'auto', n: 1, detail: '',
    })
  })

  it('preserves an explicitly selected channel', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'custom-task'}}))
    await submitTrackArt({...INPUT, channelId: 'custom:chosen'})
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).channelId).toBe('custom:chosen')
  })

  it.each(['jpeg', 'webp'])('submits the selected %s photo without changing its reference bytes', async mime => {
    const image = `data:image/${mime};base64,cGljdHVyZQ==`
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'photo-task'}}))
    expect(await submitTrackArt({...INPUT, image})).toEqual({taskId: 'photo-task'})
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({mode: 'edit', image, n: 1})
  })

  it.each([
    [{...INPUT, prompt: ' '}, '美化要求'],
    [{...INPUT, model: ''}, '请选择生图模型'],
    [{...INPUT, image: 'data:image/svg+xml;base64,aGVsbG8='}, 'PNG'],
    [{...INPUT, image: 'https://example.com/map.png'}, 'PNG'],
    [{...INPUT, image: 'data:image/png;base64,invalid!'}, 'PNG'],
  ])('rejects invalid submission input before contacting the host', async (input, message) => {
    await expect(submitTrackArt(input)).rejects.toThrow(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces the host reference-image size limit before submitting', async () => {
    const oversized = `data:image/png;base64,${'AAAA'.repeat(Math.floor(10 * 1024 * 1024 / 3) + 1)}`
    await expect(submitTrackArt({...INPUT, image: oversized})).rejects.toThrow('10 MiB')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors a HTTP-200 host failure instead of pretending the task started', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: false, code: 'model-choice-required', message: '请先选择生图模型'}))
    await expect(submitTrackArt(INPUT)).rejects.toMatchObject({message: '请先选择生图模型', code: 'model-choice-required'})
  })

  it('rejects missing task ids and reports denied desktop access', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {}}))
    await expect(submitTrackArt(INPUT)).rejects.toThrow('任务编号')
    fetchMock.mockResolvedValueOnce(new Response('Forbidden', {status: 403}))
    await expect(submitTrackArt(INPUT)).rejects.toMatchObject({code: 'access-denied', message: expect.stringContaining('DSH 应用')})
  })
})

describe('owned imagegen task lifecycle', () => {
  it('filters by submitted id and returns only that task normalized into renderable data URLs', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [
      {id: 'other-task', status: 'completed', result: {images: [{b64: 'b3RoZXI=', mime: 'image/png'}]}},
      {id: 'owned-task', status: 'completed', result: {images: [
        {b64: 'aGVsbG8=', mime: 'image/png', revisedPrompt: '保留路线的山地地图'},
        {b64: 'd29ybGQ=', mime: 'image/jpeg'},
      ]}},
    ]}))
    expect(await loadTrackArtTask('owned-task')).toEqual({status: 'completed', images: [
      {dataUrl: PNG, revisedPrompt: '保留路线的山地地图'},
      {dataUrl: 'data:image/jpeg;base64,d29ybGQ='},
    ]})
    expect(fetchMock.mock.calls[0]).toEqual(['/api/dsh-imagegen/tasks/list', {method: 'POST', credentials: 'same-origin'}])
  })

  it.each(['queued', 'running', 'cancelled', 'failed'])('normalizes %s without exposing partial or unrelated images', async status => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'owned-task', status, error: status === 'failed' ? '上游生成失败' : undefined, result: {images: [{b64: 'aGVsbG8=', mime: 'image/png'}]}}]}))
    expect(await loadTrackArtTask('owned-task')).toEqual({status: status === 'cancelled' ? 'canceled' : status, images: [], ...(status === 'failed' ? {error: '上游生成失败'} : {})})
  })

  it('ends polling for expired tasks and for completed tasks without a safe image', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'other-task', status: 'running'}]}))
    expect(await loadTrackArtTask('owned-task')).toMatchObject({status: 'failed', images: [], error: expect.stringContaining('已过期')})
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'owned-task', status: 'completed', result: {images: [{b64: 'aGVsbG8=', mime: 'image/svg+xml'}, {b64: 'invalid!', mime: 'image/png'}]}}]}))
    expect(await loadTrackArtTask('owned-task')).toMatchObject({status: 'failed', images: [], error: expect.stringContaining('未返回可用图片')})
  })

  it('rejects an unknown task status and invalid JSON response', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, tasks: [{id: 'owned-task', status: 'surprise'}]}))
    await expect(loadTrackArtTask('owned-task')).rejects.toThrow('任务状态无效')
    fetchMock.mockResolvedValueOnce(new Response('{', {headers: {'content-type': 'application/json'}}))
    await expect(loadTrackArtTask('owned-task')).rejects.toThrow('无效数据')
  })

  it('cancels only the explicitly submitted task through the host cancel route', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: true, task: {id: 'owned-task', status: 'cancelled'}}))
    await expect(cancelTrackArtTask('owned-task')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/dsh-imagegen/tasks/cancel')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({id: 'owned-task'})
  })

  it('propagates cancel errors and never polls or cancels an empty id', async () => {
    fetchMock.mockResolvedValueOnce(json({ok: false, code: 'not-found', message: 'task not found'}))
    await expect(cancelTrackArtTask('owned-task')).rejects.toMatchObject({code: 'not-found'})
    await expect(cancelTrackArtTask('')).rejects.toThrow('任务编号无效')
    await expect(loadTrackArtTask(' ')).rejects.toThrow('任务编号无效')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
