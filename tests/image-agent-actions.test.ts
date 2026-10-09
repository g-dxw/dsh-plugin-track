// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {AgentImageReferenceInput} from '../src/track/image-agent-references.ts'
import {ImageAgentActions, ImageAgentContext} from '../src/client/ImageAgentActions.tsx'

const resource = {kind: 'resource' as const, trackId: 'track-one', assetId: 'existing-photo-one'}
const reference = {source: resource, referenceId: 'track-image:track-one/existing-photo-one', name: '山脊.jpg', filePath: '/workspace/image-references/ridge.jpg',
  mime: 'image/jpeg', bytes: 3, width: 100, height: 80, fileUrl: '/api/cqai-track/agent-image-reference-file?referenceId=track-image%3Atrack-one%2Fexisting-photo-one&trackId=track-one',
  clipboardText: '图片引用 ID：track-image:track-one/existing-photo-one\n请用 read_image 读取 /workspace/image-references/ridge.jpg'}
let root: Root, node: HTMLDivElement
const addFile = vi.fn(async (_file: File, _signal: AbortSignal) => {}), copied = vi.fn(async (_text: string) => {})
function response(data: unknown, status = 200) {return new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}})}
async function render(available = true, onAdded?: () => void, image: AgentImageReferenceInput = resource, trackId: string | null | undefined = resource.trackId) {
  await act(async () => {root.render(createElement(ImageAgentContext.Provider, {value: {available, addFile, trackId}}, createElement(ImageAgentActions, {image, onAdded})))})
}
async function click(label: string) {
  await act(async () => {const button = [...node.querySelectorAll('button')].find(item => item.textContent === label)!; button.click()})
}
beforeEach(() => {
  ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: copied}})
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const image=JSON.parse(String(init?.body ?? '{}')) as AgentImageReferenceInput
    const fileUrl=reference.fileUrl.split('&')[0] + (image.trackId == null ? '' : '&trackId='+encodeURIComponent(image.trackId))
    return response({reference:{...reference,source:image,fileUrl}})
  }))
})
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals()})

describe('image Agent actions', () => {
  it('copies the complete prepared reference with write protection; never adds or sends a message', async () => {
    await render(); await click('复制图片引用')
    expect(fetch).toHaveBeenCalledWith('/api/cqai-track/agent-image-reference', expect.objectContaining({method: 'POST', headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify(resource)}))
    expect(copied).toHaveBeenCalledWith(reference.clipboardText)
    expect(addFile).not.toHaveBeenCalled()
    expect(node.textContent).toContain('图片引用已复制')
  })
  it('keeps full readable text when clipboard permission is denied', async () => {
    copied.mockRejectedValueOnce(new Error('denied'))
    await render(); await click('复制图片引用')
    expect(node.querySelector('textarea')?.value).toBe(reference.clipboardText)
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('完整引用')
    expect(node.textContent).not.toContain('图片引用已复制')
  })
  it('keeps copying available when native Agent draft admission is unavailable', async () => {
    await render(false)
    expect([...node.querySelectorAll('button')].find(item => item.textContent === '添加到 Agent')?.disabled).toBe(true)
    await click('复制图片引用'); expect(copied).toHaveBeenCalledOnce()
  })
  it('adds original image bytes to the native draft and closes the template only after success', async () => {
    const close = vi.fn()
    vi.mocked(fetch).mockImplementationOnce(async () => response({reference})).mockImplementationOnce(async () => new Response(new Uint8Array([1, 2, 3]), {headers: {'content-type': 'image/jpeg'}}))
    await render(true, close); await click('添加到 Agent')
    const file = addFile.mock.calls[0][0]
    expect(file.name).toBe('山脊.jpg'); expect(file.type).toBe('image/jpeg'); expect(file.size).toBe(3)
    expect(addFile.mock.calls[0][1].aborted).toBe(false)
    expect(copied).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  })
  it('shows preparation failures without advertising success or closing a template', async () => {
    const close = vi.fn(); vi.mocked(fetch).mockResolvedValueOnce(response({error: '图片已移除'}, 404))
    await render(true, close); await click('添加到 Agent')
    expect(node.querySelector('[role="alert"]')?.textContent).toBe('图片已移除')
    expect(addFile).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })
  it('refuses unsupported draft image MIME without passing a disguised file to the host', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => response({reference})).mockImplementationOnce(async () => new Response('<html>error</html>', {headers: {'content-type': 'text/html'}}))
    await render(); await click('添加到 Agent')
    expect(addFile).not.toHaveBeenCalled(); expect(node.textContent).toContain('此图片格式暂不支持')
  })
  it('refuses an out-of-plugin file URL returned by a broken service', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({reference: {...reference, fileUrl: 'https://untrusted.example/image.png'}}))
    await render(); await click('添加到 Agent')
    expect(fetch).toHaveBeenCalledOnce(); expect(addFile).not.toHaveBeenCalled()
    expect(node.textContent).toContain('图片引用响应无效')
  })
  it('refuses a service response that belongs to another route or advertises a different file scope', async () => {
    for(const wrong of [{...reference,source:{...resource,trackId:'track-two'}},{...reference,fileUrl:reference.fileUrl.replace('trackId=track-one','trackId=track-two')}]){
      vi.mocked(fetch).mockResolvedValueOnce(response({reference:wrong}))
      await render();await click('添加到 Agent')
      expect(node.textContent).toContain('不属于当前轨迹项目');expect(addFile).not.toHaveBeenCalled();expect(copied).not.toHaveBeenCalled()
    }
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('scopes featured and source template requests to the selected route, including the global library', async () => {
    for(const image of [{kind:'featured' as const,key:'travel-natural-photo'},{kind:'template' as const,sourceId:'canghe',caseId:'538'}]){
      await render(true,undefined,image,'selected-route');await click('复制图片引用')
      expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({body:JSON.stringify({...image,trackId:'selected-route'})}))
      await render(true,undefined,{...image,trackId:'old-route'},null);await click('复制图片引用')
      expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({body:JSON.stringify({...image,trackId:null})}))
    }
  })
  it('keeps copying a resource available while refusing admission to another route Agent', async () => {
    await render(true,undefined,resource,'track-other')
    const button=[...node.querySelectorAll('button')].find(item=>item.textContent==='添加到 Agent')!
    expect(button.disabled).toBe(true);expect(button.title).toContain('所属的轨迹')
    await click('添加到 Agent');expect(fetch).not.toHaveBeenCalled();expect(addFile).not.toHaveBeenCalled()
    await click('复制图片引用');expect(copied).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('/api/cqai-track/agent-image-reference',expect.objectContaining({body:JSON.stringify(resource)}))
  })
  it('cancels a template request when the selected route changes and never appends it to the next Agent', async () => {
    let resolve!: (value:Response)=>void
    vi.mocked(fetch).mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    const image={kind:'featured' as const,key:'travel-natural-photo'},close=vi.fn()
    await render(true,close,image,'track-one');await click('添加到 Agent')
    const signal=(vi.mocked(fetch).mock.calls[0][1] as RequestInit).signal!
    await render(true,close,image,'track-two');expect(signal.aborted).toBe(true)
    await act(async()=>resolve(response({reference})))
    expect(fetch).toHaveBeenCalledOnce();expect(addFile).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
  })
  it('cancels downloading image bytes during route switches before native draft admission', async () => {
    let resolve!: (value:Response)=>void
    vi.mocked(fetch).mockImplementationOnce(async()=>response({reference})).mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    await render();await click('添加到 Agent')
    const signal=(vi.mocked(fetch).mock.calls[1][1] as RequestInit).signal!
    await render(true,undefined,resource,'track-two');expect(signal.aborted).toBe(true)
    await act(async()=>resolve(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}})))
    expect(addFile).not.toHaveBeenCalled();expect(node.textContent).not.toContain('图片已添加')
  })
  it('cancels stale preparation on a selection change before copying a wrong image', async () => {
    let resolve!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(done => {resolve = done}))
    await render(); await click('复制图片引用')
    const signal = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).signal!
    await render(true, undefined, {...resource, assetId: 'asset-next'})
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(response({reference})))
    expect(copied).not.toHaveBeenCalled(); expect(addFile).not.toHaveBeenCalled()
  })
})
