// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {TrackRecord} from '../src/protocol.ts'
import type {ResourceAsset, ResourceAssetPatch, ResourceLibraryEnvelope} from '../src/track/resources.ts'
import {ResourceLibrary} from '../src/client/ResourceLibrary.tsx'
import {loadResourceLibrary, updateResource, uploadResource} from '../src/client/resources-api.ts'
const state = vi.hoisted(() => ({submit: vi.fn()}))
vi.mock('../src/client/useResourceJobs.ts', () => ({useResourceJobs: () => ({working: false, error: '', submit: state.submit, sync: vi.fn(), cancel: vi.fn(), clearError: vi.fn()})}))
vi.mock('../src/client/resources-api.ts', async original => ({...await original<typeof import('../src/client/resources-api.ts')>(), loadResourceLibrary: vi.fn(), updateResource: vi.fn(), uploadResource: vi.fn(), deleteResource: vi.fn(), prepareResourcePreview: vi.fn().mockResolvedValue(undefined)}))
const track: TrackRecord = {id: 'resource-ui', name: '资源测试路线', filename: 'route.gpx', format: 'gpx', createdAt: '2026-10-05', points: 0, bytes: 1, coordinates: [], metrics: {distance: 0, elevationGain: 0, elevationLoss: 0, duration: 0, elevationMin: null, elevationMax: null, bbox: null}}
const asset = (id: string, kind: ResourceAsset['kind'], extra: Partial<ResourceAsset> = {}): ResourceAsset => ({id, trackId: track.id, kind, name: id, mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg', bytes: 200, url: `/api/cqai-track/resource-file?id=${track.id}&assetId=${id}`, source: 'upload', tags: [], candidate: false, metadata: {}, createdAt: '2026-10-05', updatedAt: '2026-10-05', usages: [], status: 'ready', ...extra})
let library: ResourceLibraryEnvelope, container: HTMLDivElement, root: Root, onBack: ReturnType<typeof vi.fn<() => void>>, onUse: ReturnType<typeof vi.fn<(asset: ResourceAsset) => Promise<void>>>
function button(text: string) {const value = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text); if (!value) throw new Error('Missing button: ' + text); return value}
async function click(text: string) {await act(async () => button(text).click())}
async function choose(name: string) {await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="查看素材：${name}"]`)!.click())}
async function render(extra: Record<string, unknown> = {}) {await act(async () => root.render(createElement(ResourceLibrary, {track, onBack, onUseImage: onUse, ...extra})))}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  library = {revision: '1', assets: [asset('真实照片', 'image', {sourceUrl: '/api/cqai-track/placemark-photo?id=resource-ui&file=a.png'}), asset('旅程视频', 'video'), asset('现场声音', 'audio')], jobs: []}
  vi.mocked(loadResourceLibrary).mockImplementation(async () => structuredClone(library))
  vi.mocked(updateResource).mockImplementation(async (_trackId, id, patch: ResourceAssetPatch) => {const index = library.assets.findIndex(item => item.id === id); library.assets[index] = {...library.assets[index], ...patch} as ResourceAsset; return structuredClone(library.assets[index])})
  onBack = vi.fn<() => void>(); onUse = vi.fn<(asset: ResourceAsset) => Promise<void>>().mockResolvedValue(undefined); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()})

describe('independent track resource workspace', () => {
  it('opens all media without importing templates or submitting AI and returns to track detail', async () => {
    await render(); expect(container.querySelectorAll('.trk-r-card')).toHaveLength(3); expect(container.textContent).toContain('所属轨迹：资源测试路线'); expect(state.submit).not.toHaveBeenCalled(); expect(updateResource).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull(); expect(button('历史记录')).toBeDefined(); expect(button('AI 图片创作')).toBeDefined()
    await click('← 返回轨迹详情'); expect(onBack).toHaveBeenCalledOnce()
  })
  it('switches workbench by media kind and uses native video/audio previews with lazy metadata', async () => {
    await render(); expect(container.querySelector('video')).toBeNull(); expect(container.querySelector('audio')).toBeNull()
    await choose('旅程视频'); expect([...container.querySelectorAll('button')].some(node => node.textContent === 'AI 美化')).toBe(false)
    await click('打开预览'); const video = container.querySelector('video')!; expect(video.controls).toBe(true); expect(video.getAttribute('src')).toContain('assetId=旅程视频')
    Object.defineProperties(video, {duration: {value: 32}, videoWidth: {value: 1920}, videoHeight: {value: 1080}})
    await act(async () => video.dispatchEvent(new Event('loadedmetadata'))); expect(updateResource).toHaveBeenCalledWith(track.id, '旅程视频', {metadata: {duration: 32, width: 1920, height: 1080}})
    await click('← 返回资源库'); await choose('现场声音'); await click('打开预览'); expect(container.querySelector('audio')!.controls).toBe(true)
  })
  it('persists candidate before adding to a point and refuses use after save failure', async () => {
    library.assets.push(asset('待选图片', 'image', {candidate: true, source: 'ai-edit', parentAssetId: '真实照片'}))
    await render(); await choose('待选图片'); vi.mocked(updateResource).mockRejectedValueOnce(new Error('磁盘写入失败'))
    await click('添加到点位'); expect(onUse).not.toHaveBeenCalled(); expect(container.textContent).toContain('磁盘写入失败')
    await click('添加到点位'); expect(updateResource).toHaveBeenLastCalledWith(track.id, '待选图片', {candidate: false}); expect(onUse).toHaveBeenCalledWith(expect.objectContaining({id: '待选图片', candidate: false}))
  })
  it('shows original/candidate comparison and keeps source intact after saving', async () => {
    library.assets.push(asset('比较结果', 'image', {candidate: true, source: 'ai-edit', parentAssetId: '真实照片'}))
    await render(); await choose('比较结果'); await click('打开预览'); await click('左右对照'); expect(container.querySelectorAll('.trk-r-compare img')).toHaveLength(2)
    await click('保存到资源库'); expect(library.assets.find(item => item.id === '真实照片')?.candidate).toBe(false); expect(library.assets.find(item => item.id === '比较结果')?.candidate).toBe(false)
  })
  it('imports mixed files separately, keeps successful items and exposes per-file retry', async () => {
    vi.mocked(uploadResource).mockImplementation(async (_id, file, progress) => {progress?.(50); if (file.name === 'broken.jpg') throw new Error('文件内容损坏'); const created = asset(file.name, file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image'); library.assets.push(created); return created})
    await render(); const input = container.querySelector<HTMLInputElement>('[aria-label="导入图片视频音频"]')!
    Object.defineProperty(input, 'files', {value: [new File(['photo'], 'new.jpg', {type: 'image/jpeg'}), new File(['bad'], 'broken.jpg', {type: 'image/jpeg'}), new File(['clip'], 'new.mp4', {type: 'video/mp4'}), new File(['sound'], 'new.mp3', {type: 'audio/mpeg'})], configurable: true})
    await act(async () => input.dispatchEvent(new Event('change', {bubbles: true}))); expect(uploadResource).toHaveBeenCalledTimes(4); expect(library.assets).toHaveLength(6); expect(container.textContent).toContain('文件内容损坏'); expect(button('重试此文件')).toBeDefined()
  })
  it('saves a video role for audio and protects referenced resources from deletion', async () => {
    await render(); await choose('现场声音'); await act(async () => {const select = container.querySelector<HTMLSelectElement>('[aria-label="视频素材用途"]')!; select.value = 'narration'; select.dispatchEvent(new Event('change', {bubbles: true}))})
    await click('加入视频素材清单'); expect(updateResource).toHaveBeenLastCalledWith(track.id, '现场声音', {videoRole: 'narration'})
    library.assets[0].usages = [{kind: 'placemark', id: 'p1', name: '山口'}]; await render({reloadToken: 1}); await choose('真实照片'); expect(button('移除资源').disabled).toBe(true); expect(container.textContent).toContain('山口')
  })
  it('opens creation with the exact selected image and puts history in the original header slot', async () => {
    const onCreate = vi.fn(), onHistory = vi.fn()
    await render({initialAssetUrl: library.assets[0].sourceUrl, onCreate, onHistory})
    await click('AI 图片创作'); expect(onCreate).toHaveBeenCalledWith(['真实照片']); expect(state.submit).not.toHaveBeenCalled()
    await click('历史记录'); expect(onHistory).toHaveBeenCalledOnce(); expect(container.querySelector('textarea')).toBeNull()
  })
  it('passes only selected images to the dedicated composer while preserving multi selection', async () => {
    const onCreate = vi.fn(); await render({onCreate})
    await act(async () => {for (const node of container.querySelectorAll<HTMLInputElement>('.trk-r-check input')) node.click()})
    await click('用所选图片创作'); expect(onCreate).toHaveBeenCalledWith(['真实照片']); expect(container.textContent).toContain('批量整理 · 3 项')
  })
  it('opens empty image creation from video details without passing media as image references', async () => {
    const onCreate = vi.fn(); await render({onCreate}); await choose('旅程视频'); await click('AI 图片创作'); expect(onCreate).toHaveBeenCalledWith([])
  })
  it('does not compare an effect-only output against a supposed original photo', async () => {
    library.assets.push(asset('效果生成结果', 'image', {source: 'ai-edit', parentAssetId: '真实照片', jobId: 'effect-job'}))
    library.jobs.push({id: 'effect-job', trackId: track.id, mode: 'edit', prompt: '借鉴色调', model: 'm', references: [{assetId: '真实照片', role: 'effect'}], sourceAssetId: '真实照片', status: 'completed', resultAssetIds: ['效果生成结果'], createdAt: '2026-10-05', updatedAt: '2026-10-05'})
    await render(); await choose('效果生成结果'); await click('打开预览'); expect(container.querySelector('[aria-label="图片结果对比"]')).toBeNull(); expect(container.textContent).not.toContain('原图已移除')
  })

})


describe('SVG annotation library images',()=>{
  it('shows the SVG source label and selects its PNG for image creation',async()=>{
    const onCreate=vi.fn()
    library.assets.push(asset('路线-SVG 标注.png','image',{source:'svg-annotation',tags:['SVG 标注'],metadata:{width:2400,height:1800}}))
    await render({onCreate});await choose('路线-SVG 标注.png')
    expect(container.textContent).toContain('SVG 标注')
    await click('AI 图片创作');expect(onCreate).toHaveBeenCalledWith(['路线-SVG 标注.png'])
    expect(state.submit).not.toHaveBeenCalled()
  })
})
