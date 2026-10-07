// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import {editedMetrics} from '../src/track/edit.ts'
import {diagramCoordinates} from '../src/track/annotations.ts'
import {extractVideoMaterials, type VideoMaterialsDocument} from '../src/track/video-materials.ts'
import {VideoMaterialPrep} from '../src/client/VideoMaterialPrep.tsx'
import {api, download} from '../src/client/util.ts'
import {readAnnotationPhoto, readLinkedAnnotationPhoto} from '../src/client/annotation-photo.ts'
const state = vi.hoisted(() => ({ready: true, error: '', points: [] as TrackPlacemark[], starts: [0, 3], options: undefined as unknown}))
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: (_track: unknown, _history: unknown, options: unknown) => {
  state.options = options
  return {points: state.points, groups: [], loading: !state.ready, editReady: state.ready, error: state.error, stateError: '', routeError: '', routeContext: state.ready ? {segmentStarts: state.starts} : null, retry: vi.fn()}
}}))
vi.mock('../src/client/util.ts', async original => ({...await original<typeof import('../src/client/util.ts')>(), api: vi.fn(), download: vi.fn()}))
vi.mock('../src/client/annotation-photo.ts', () => ({readLinkedAnnotationPhoto: vi.fn(), readAnnotationPhoto: vi.fn()}))
const coordinates: TrackRecord['coordinates'] = [[114.1, 27.5, 100, 1000], [114.11, 27.51, 150, 2000], [114.12, 27.52, 180, 3000], [115.1, 28.5, 500, 4000], [115.11, 28.51, 530, 5000]]
const track: TrackRecord = {id: 'materials-ui', name: '真实测试路线', filename: 'route.gpx', format: 'gpx', createdAt: '2026-10-04', points: 5, bytes: 100, coordinates, metrics: editedMetrics(coordinates)}
const points: TrackPlacemark[] = [{id: 'view', name: '真实观景点', coordinates: [114.11, 27.512], description: '山谷旁', images: ['https://example.com/a.jpg', 'https://example.com/b.jpg']}, {id: 'hidden', name: '隐藏地点', coordinates: [115.1, 28.5], description: '', images: [], hidden: true}]
const photo = 'data:image/jpeg;base64,/9j/AA=='
let container: HTMLDivElement, root: Root, onBack: () => void, onCompose: (document: VideoMaterialsDocument) => void, revision: number
function deferred<T>() {let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
function envelope(document: VideoMaterialsDocument) {return {schema: 'cqai-track-video-materials-envelope@1', trackId: document.trackId, document, revision: `revision-${++revision}`, updatedAt: '2026-10-04'}}
function button(text: string) {const value = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!value) throw new Error('Missing button: ' + text); return value}
async function click(text: string) {await act(async () => button(text).click())}
async function render(value = track) {await act(async () => root.render(createElement(VideoMaterialPrep, {track: value, onBack, onCompose})))}
async function edit(label: string, value: string) {await act(async () => {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', {bubbles: true}))
})}
function exported(): VideoMaterialsDocument {const call = vi.mocked(download).mock.calls.at(-1); if (!call) throw new Error('No export'); return JSON.parse(call[1] as string)}
function writes() {return vi.mocked(api).mock.calls.filter(([, payload]) => payload !== undefined)}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.ready = true; state.error = ''; state.points = structuredClone(points); state.starts = [0, 3]; revision = 0
  vi.mocked(api).mockImplementation(async (action, payload) => {
    if (payload !== undefined) return {materials: envelope((payload as {document: VideoMaterialsDocument}).document)}
    return action.startsWith('annotations?') ? {annotations: [], saved: false} : {materials: null}
  })
  vi.mocked(readAnnotationPhoto).mockResolvedValue(photo); vi.mocked(readLinkedAnnotationPhoto).mockResolvedValue(photo)
  onBack = vi.fn(); onCompose = vi.fn(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()})

describe('2D video material preparation', () => {
  it('waits for effective route breaks and saved source choices without writing or reading candidate photo bytes', async () => {
    state.ready = false; await render(); expect(button('用所选素材编排镜头').disabled).toBe(true); expect(writes()).toHaveLength(0)
    state.ready = true; await render(); await click('导出素材 JSON')
    expect(exported().sourceSegmentStarts).toEqual([0, 3]); expect(exported().segments).toHaveLength(2)
    expect(exported().markers[0].coordinates).toEqual(points[0].coordinates); expect(exported().markers[1].selected).toBe(false)
    expect(state.options).toEqual({preparePhotos: false}); expect(readLinkedAnnotationPhoto).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0)
    expect(container.querySelectorAll('path.trk-vm-route')).toHaveLength(2)
  })
  it('keeps real source coordinates from saved SVG and ignores old pixel positions', async () => {
    vi.mocked(api).mockImplementation(async action => action.startsWith('annotations?') ? {saved: true, annotations: [{id: 'old-svg', pointIndex: 1, label: '原SVG地名', color: '#2563eb', visible: true, sourceId: 'view', sourceCoordinates: [114.11, 27.512], position: {x: 1100, y: 500}}]} : {materials: null})
    await render(); await click('导出素材 JSON'); const marker = exported().markers.find(item => item.name === '原SVG地名')!
    expect(marker.coordinates).toEqual([114.11, 27.512]); expect(marker).not.toHaveProperty('position')
    await edit('文字横向偏移', '120'); await click('导出素材 JSON')
    expect(exported().markers[0].coordinates).toEqual(marker.coordinates); expect(exported().markers[0].labelOffset?.x).toBe(120)
  })
  it('confirms source visibility, name and description separately and supports undo/redo', async () => {
    await render(); await click('取消选择'); await edit('标记名称', '我的展示名称'); await edit('标记说明', '山地环境介绍'); await click('导出素材 JSON')
    expect(exported().markers.every(item => !item.selected)).toBe(true); expect(exported().markers[0].name).toBe('我的展示名称'); expect(exported().markers[0].description).toBe('山地环境介绍')
    await click('撤销'); await click('导出素材 JSON'); expect(exported().markers[0].description).toBe('山谷旁')
    await click('重做'); await click('全选'); await click('导出素材 JSON'); expect(exported().markers.every(item => item.selected)).toBe(true)
    expect(state.points[0].name).toBe('真实观景点'); expect(writes()).toHaveLength(0)
  })
  it('splits a real run at the selected index and merges only its adjacent split', async () => {
    await render(); await click('路线分段'); await edit('拆分点序号', '1'); await click('在此拆分'); await click('导出素材 JSON')
    expect(exported().segments.map(item => [item.startIndex, item.endIndex])).toEqual([[0, 1], [1, 2], [3, 4]])
    await click('与下一段合并'); await click('导出素材 JSON'); expect(exported().segments.map(item => [item.startIndex, item.endIndex])).toEqual([[0, 2], [3, 4]])
    expect(button('与下一段合并').disabled).toBe(true)
  })
  it('adds a marker from the nearest real route point rather than SVG pixels', async () => {
    await render(); await click('沿路线添加标记')
    const svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!, projected = diagramCoordinates(coordinates)[1]
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 100, top: 20, width: 1200, height: Number(svg.viewBox?.baseVal?.height) || Number(svg.getAttribute('viewBox')!.split(' ')[3]), right: 1300, bottom: 2000, x: 100, y: 20, toJSON() {}})
    await act(async () => svg.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: projected[0] + 100, clientY: projected[1] + 20})))
    await click('导出素材 JSON'); const marker = exported().markers.at(-1)!
    expect(marker.pointIndex).toBe(1); expect(marker.coordinates).toEqual(coordinates[1].slice(0, 2))
  })
  it('loads only the user-selected candidate and embeds a bounded photo in the selected marker', async () => {
    await render(); expect(readLinkedAnnotationPhoto).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="使用这张图片：2"]')!.click())
    expect(readLinkedAnnotationPhoto).toHaveBeenCalledWith(points[0].images[1], track.id)
    await click('导出素材 JSON'); expect(exported().markers[0].photo).toEqual({dataUrl: photo, sourceUrl: points[0].images[1]})
    await click('删除选图'); await click('导出素材 JSON'); expect(exported().markers[0].photo).toBeUndefined()
  })
  it('ignores photo completion after switching tracks and locks edits during selection', async () => {
    const reading = deferred<string>(); vi.mocked(readLinkedAnnotationPhoto).mockReturnValue(reading.promise)
    await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="使用这张图片：1"]')!.click())
    expect(button('保存素材').disabled).toBe(true); expect((container.querySelector('[aria-label="标记名称"]')!.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    await render({...track, id: 'materials-other'}); await act(async () => reading.resolve(photo)); await click('导出素材 JSON')
    expect(exported().trackId).toBe('materials-other'); expect(exported().markers[0].photo).toBeUndefined(); expect(writes()).toHaveLength(0)
  })
  it('saves successfully before composing and sends only the separate materials document', async () => {
    await render(); await edit('标记名称', '展示地名'); await click('用所选素材编排镜头')
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe('video-materials'); expect(writes()[0][1]).toMatchObject({id: track.id, expectedRevision: null})
    expect(onCompose).toHaveBeenCalledWith(expect.objectContaining({trackId: track.id, markers: expect.arrayContaining([expect.objectContaining({name: '展示地名'})])}))
  })
  it('retains draft on revision conflict and refuses compose or leave', async () => {
    const conflict = Object.assign(new Error('conflict'), {status: 409})
    vi.mocked(api).mockImplementation(async (action, payload) => {if (payload !== undefined) throw conflict; return action.startsWith('annotations?') ? {annotations: [], saved: false} : {materials: null}})
    await render(); await edit('标记名称', '未保存的地名'); await click('用所选素材编排镜头'); expect(onCompose).not.toHaveBeenCalled(); expect(container.textContent).toContain('当前修改仍保留')
    await click('返回'); expect(container.querySelector('[role=dialog]')).not.toBeNull(); await click('保存后返回'); expect(onBack).not.toHaveBeenCalled()
    await click('留在页面'); await click('导出素材 JSON'); expect(exported().markers[0].name).toBe('未保存的地名')
  })
  it('rebuilds changed sources explicitly and undo restores the previous fingerprint and edits', async () => {
    await render(); await edit('标记名称', '原素材编辑'); await click('导出素材 JSON'); const previous = exported()
    state.points = [{...points[0], name: '新的来源名称'}]; await render(); expect(container.textContent).toContain('来源轨迹、地名或 SVG 标注已变化')
    await click('从当前轨迹重新提取'); await click('确认重新提取'); await click('导出素材 JSON'); expect(exported().markers[0].name).toBe('新的来源名称'); expect(exported().sourceFingerprint).not.toBe(previous.sourceFingerprint)
    await click('撤销'); await click('导出素材 JSON'); expect(exported()).toEqual(previous); expect(container.textContent).toContain('来源轨迹、地名或 SVG 标注已变化')
  })
  it('restores a complete saved sidecar for backup when the original source is unavailable', async () => {
    const saved = extractVideoMaterials({...track, segmentStarts: [0, 3]}, points)
    state.ready = false; state.error = '原始文件无法读取'
    vi.mocked(api).mockImplementation(async action => action.startsWith('annotations?') ? {annotations: [], saved: false} : {materials: envelope(saved)})
    await render(); await click('导出素材 JSON'); expect(exported()).toEqual(saved); expect(button('用所选素材编排镜头').disabled).toBe(true); expect(writes()).toHaveLength(0)
  })
  it('edits real route facts and adds a selected custom introduction without touching source metrics', async () => {
    await render(); await click('路线信息'); await edit('视频标题', '环境介绍视频'); await edit('介绍文字：info-distance', '沿山谷步道行进'); await click('添加自定义介绍'); await click('导出素材 JSON')
    expect(exported().title).toBe('环境介绍视频'); expect(exported().information.find(item => item.id === 'info-distance')?.text).toBe('沿山谷步道行进')
    expect(exported().information.at(-1)).toMatchObject({label: '自定义介绍', selected: true}); expect(track.name).toBe('真实测试路线')
  })
  it('fits the complete route to both viewport dimensions and restores fit after zooming', async () => {
    await render(); const viewport = container.querySelector<HTMLElement>('.trk-vm-canvas-scroll')!, svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 340, height: 420, x: 0, y: 0, right: 340, bottom: 420, toJSON() {}})
    await act(async () => window.dispatchEvent(new Event('resize')))
    const width = parseFloat(svg.style.width), height = parseFloat(svg.style.height)
    expect(width).toBeLessThanOrEqual(292); expect(height).toBeLessThanOrEqual(372); expect(width).toBeGreaterThan(0)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="放大画布"]')!.click()); expect(parseFloat(svg.style.width)).toBeCloseTo(width * 1.25)
    viewport.scrollLeft = 120; viewport.scrollTop = 90; await click('适应'); expect(parseFloat(svg.style.width)).toBeCloseTo(width); expect(viewport.scrollLeft).toBe(0); expect(viewport.scrollTop).toBe(0)
  })
  it('keeps zoom stable when visible scrollbars change the content box and still follows real container resize', async () => {
    let notify!: ResizeObserverCallback
    const observe = vi.fn(), disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {constructor(callback: ResizeObserverCallback) {notify = callback} observe = observe; disconnect = disconnect})
    await render()
    const viewport = container.querySelector<HTMLElement>('.trk-vm-canvas-scroll')!, svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    const rect = vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 990.5, height: 513.3125, x: 0, y: 0, right: 990.5, bottom: 513.3125, toJSON() {}})
    const clientWidth = vi.spyOn(viewport, 'clientWidth', 'get').mockReturnValue(975), clientHeight = vi.spyOn(viewport, 'clientHeight', 'get').mockReturnValue(513)
    const report = async (width = 990.5, height = 513.3125) => act(async () => notify([{target: viewport, borderBoxSize: [{inlineSize: width, blockSize: height}], contentRect: {width: clientWidth.mock.results.at(-1)?.value ?? 975, height: clientHeight.mock.results.at(-1)?.value ?? 513}} as unknown as ResizeObserverEntry], {} as ResizeObserver))
    await report(); expect(observe).toHaveBeenCalledWith(viewport, {box: 'border-box'})
    for (let index = 0; index < 8; index++) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="放大画布"]')!.click())
    const before = svg.getAttribute('style')
    for (let index = 0; index < 12; index++) {
      clientHeight.mockReturnValue(index % 2 ? 498 : 513); clientWidth.mockReturnValue(index % 2 ? 975 : 990)
      await report(); expect(svg.getAttribute('style')).toBe(before)
    }
    await report(900.7, 480.2); const resized = svg.getAttribute('style'); expect(resized).not.toBe(before)
    await report(900.9, 480.8); expect(svg.getAttribute('style')).toBe(resized)
    expect(writes()).toHaveLength(0); expect(rect).toHaveBeenCalled()
  })
  it('keeps label drag preview separate from geographic position and cancels safely', async () => {
    await render(); const svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 1200, height: Number(svg.getAttribute('viewBox')!.split(' ')[3]), x: 0, y: 0, right: 1200, bottom: 2000, toJSON() {}})
    const label = container.querySelector<SVGTextElement>('text.trk-vm-marker-label')!
    const pointer = async (type: string, x: number) => act(async () => {const event = new Event(type, {bubbles: true}); Object.defineProperties(event, {pointerId: {value: 5}, button: {value: 0}, clientX: {value: x}, clientY: {value: 200}}); label.dispatchEvent(event)})
    await pointer('pointerdown', 100); await pointer('pointermove', 130); await click('导出素材 JSON'); expect(exported().markers[0].labelOffset).toBeUndefined()
    await pointer('pointercancel', 130); await click('导出素材 JSON'); expect(exported().markers[0].labelOffset).toBeUndefined()
    await pointer('pointerdown', 100); await pointer('pointermove', 150); await pointer('pointerup', 150); await click('导出素材 JSON')
    expect(exported().markers[0].labelOffset).toEqual({x: 68, y: -14}); expect(exported().markers[0].coordinates).toEqual(points[0].coordinates)
    await click('撤销'); await pointer('pointerdown', 100); await pointer('pointermove', 180); await act(async () => window.dispatchEvent(new Event('blur'))); await pointer('pointerup', 180); await click('导出素材 JSON'); expect(exported().markers[0].labelOffset).toBeUndefined()
  })
  it('imports a same-track JSON draft atomically and can undo it without server writes', async () => {
    await render(); const imported = extractVideoMaterials({...track, segmentStarts: [0, 3]}, points); imported.title = '导入的标题'
    const file = new File(['draft'], 'materials.json', {type: 'application/json'}); Object.defineProperty(file, 'text', {value: async () => JSON.stringify(imported)})
    const input = container.querySelector<HTMLInputElement>('[aria-label="导入素材 JSON"]')!
    await act(async () => {Object.defineProperty(input, 'files', {configurable: true, value: [file]}); input.dispatchEvent(new Event('change', {bubbles: true}))})
    await click('导出素材 JSON'); expect(exported().title).toBe('导入的标题'); expect(writes()).toHaveLength(0)
    await click('撤销'); await click('导出素材 JSON'); expect(exported().title).toBe(track.name)
  })
  it('reports photo failures, keeps the draft unchanged and unlocks controls', async () => {
    vi.mocked(readLinkedAnnotationPhoto).mockRejectedValue(new Error('选图加载失败'))
    await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="使用这张图片：1"]')!.click())
    expect(container.textContent).toContain('选图加载失败'); expect(button('保存素材').disabled).toBe(false); await click('导出素材 JSON'); expect(exported().markers[0].photo).toBeUndefined()
  })
  it('lets add and split tools receive clicks on existing marker circles without editing the old marker', async () => {
    await render(); const svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 100, top: 20, width: 1200, height: Number(svg.getAttribute('viewBox')!.split(' ')[3]), x: 100, y: 20, right: 1300, bottom: 2000, toJSON() {}})
    const existingCircle = container.querySelector<SVGCircleElement>('[aria-label="选择标记：真实观景点"]')!
    const clickCircle = async () => act(async () => existingCircle.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: Number(existingCircle.getAttribute('cx')) + 100, clientY: Number(existingCircle.getAttribute('cy')) + 20})))
    await click('沿路线添加标记'); await clickCircle(); await edit('标记名称', '新增的路线标记'); await click('导出素材 JSON')
    expect(exported().markers).toHaveLength(3); expect(exported().markers[0].name).toBe('真实观景点'); expect(exported().markers.at(-1)).toMatchObject({name: '新增的路线标记', pointIndex: 1, coordinates: coordinates[1].slice(0, 2)})
    await click('选择拆分点'); await clickCircle()
    expect((container.querySelector<HTMLInputElement>('[aria-label="拆分点序号"]')!).value).toBe('1'); expect(button('在此拆分').disabled).toBe(false)
    await click('在此拆分'); await click('导出素材 JSON')
    expect(exported().markers[0].name).toBe('真实观景点'); expect(exported().markers).toHaveLength(3); expect(exported().segments.map(item => [item.startIndex, item.endIndex])).toEqual([[0, 1], [1, 2], [3, 4]])
  })
  it('lets add-tool clicks on an existing marker label reach the route picker', async () => {
    await render(); const svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 1200, height: Number(svg.getAttribute('viewBox')!.split(' ')[3]), x: 0, y: 0, right: 1200, bottom: 2000, toJSON() {}})
    const label = container.querySelector<SVGTextElement>('text.trk-vm-marker-label')!
    await click('沿路线添加标记'); await act(async () => label.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: Number(label.getAttribute('x')), clientY: Number(label.getAttribute('y'))})))
    await click('导出素材 JSON'); expect(exported().markers).toHaveLength(3); expect(exported().markers[0].name).toBe('真实观景点')
  })
  it('zooms around the wheel pointer, clamps safely and leaves material data and history unchanged', async () => {
    await render(); const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!, svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 340, height: 420, x: 0, y: 0, right: 340, bottom: 420, toJSON() {}})
    await act(async () => window.dispatchEvent(new Event('resize')))
    await click('导出素材 JSON'); const before = exported(), width = parseFloat(svg.style.width)
    const wheel = async (deltaY: number, clientX = 270, clientY = 110) => {
      const event = new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY, clientX, clientY})
      await act(async () => viewport.dispatchEvent(event)); return event
    }
    const event = await wheel(-120), ratio = Number(viewport.dataset.zoom) / 100
    expect(event.defaultPrevented).toBe(true); expect(ratio).toBeGreaterThan(1); expect(parseFloat(svg.style.width)).toBeCloseTo(width * ratio)
    expect(Number(viewport.dataset.panX)).toBeCloseTo(100 * (1 - ratio)); expect(Number(viewport.dataset.panY)).toBeCloseTo(-100 * (1 - ratio))
    for (let index = 0; index < 10; index++) await wheel(-240)
    expect(Number(viewport.dataset.zoom)).toBe(800)
    for (let index = 0; index < 10; index++) await wheel(240)
    expect(Number(viewport.dataset.zoom)).toBe(50)
    await click('适应'); expect(Number(viewport.dataset.zoom)).toBe(100); expect(Number(viewport.dataset.panX)).toBe(0); expect(Number(viewport.dataset.panY)).toBe(0)
    await click('导出素材 JSON'); expect(exported()).toEqual(before); expect(button('撤销').disabled).toBe(true); expect(writes()).toHaveLength(0)
  })
  it('pans blank space and explicit pan over labels without moving geographic markers or label offsets', async () => {
    await render(); const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!, paper = container.querySelector<SVGRectElement>('.trk-vm-paper')!, label = container.querySelector<SVGTextElement>('.trk-vm-marker-label')!
    await click('导出素材 JSON'); const before = exported()
    const pointer = async (target: Element, type: string, x: number, y: number) => act(async () => {
      const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerId: {value: 11}, pointerType: {value: 'mouse'}, button: {value: 0}, clientX: {value: x}, clientY: {value: y}}); target.dispatchEvent(event)
    })
    await pointer(paper, 'pointerdown', 100, 100); await pointer(viewport, 'pointermove', 180, 140); await pointer(viewport, 'pointerup', 180, 140)
    expect(Number(viewport.dataset.panX)).toBe(80); expect(Number(viewport.dataset.panY)).toBe(40)
    await act(async () => paper.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 180, clientY: 140})))
    await click('平移'); await pointer(label, 'pointerdown', 100, 100); await pointer(viewport, 'pointermove', 50, 160); await pointer(viewport, 'pointerup', 50, 160)
    expect(Number(viewport.dataset.panX)).toBe(30); expect(Number(viewport.dataset.panY)).toBe(100)
    await act(async () => label.dispatchEvent(new MouseEvent('click', {bubbles: true})))
    await click('导出素材 JSON'); expect(exported()).toEqual(before); expect(button('撤销').disabled).toBe(true); expect(writes()).toHaveLength(0)
  })
  it('keeps add-point clicks available after middle-mouse panning and suppresses only the drag click', async () => {
    await render(); await click('沿路线添加标记')
    const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!, svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!, circle = container.querySelector<SVGCircleElement>('[aria-label="选择标记：真实观景点"]')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 1200, height: Number(svg.getAttribute('viewBox')!.split(' ')[3]), x: 0, y: 0, right: 1200, bottom: 2000, toJSON() {}})
    const point = diagramCoordinates(coordinates)[1]
    const pointer = async (type: string, x: number) => act(async () => {const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerId: {value: 12}, pointerType: {value: 'mouse'}, button: {value: 1}, clientX: {value: x}, clientY: {value: point[1]}}); circle.dispatchEvent(event)})
    const addClick = async () => act(async () => circle.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: point[0], clientY: point[1]})))
    await pointer('pointerdown', point[0]); await pointer('pointermove', point[0] + 70); await pointer('pointerup', point[0] + 70); await addClick()
    await click('导出素材 JSON'); expect(exported().markers).toHaveLength(2); expect(Number(viewport.dataset.panX)).toBe(70)
    await addClick(); await click('导出素材 JSON')
    expect(exported().markers).toHaveLength(3); expect(exported().markers.at(-1)).toMatchObject({coordinates: coordinates[1].slice(0, 2), pointIndex: 1})
    expect(writes()).toHaveLength(0)
  })
  it('offers pan buttons and focused keyboard navigation while leaving property-field arrows alone', async () => {
    await render(); const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="向右平移画布"]')!.click()); expect(Number(viewport.dataset.panX)).toBe(80)
    await act(async () => {viewport.focus(); viewport.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true}))})
    expect(Number(viewport.dataset.panY)).toBe(-40)
    const field = container.querySelector<HTMLInputElement>('[aria-label="标记名称"]')!
    await act(async () => {field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true}))})
    expect(Number(viewport.dataset.panX)).toBe(80)
    await act(async () => {viewport.focus(); viewport.dispatchEvent(new KeyboardEvent('keydown', {key: '0', bubbles: true, cancelable: true}))})
    expect(Number(viewport.dataset.panX)).toBe(0); expect(Number(viewport.dataset.panY)).toBe(0); expect(writes()).toHaveLength(0)
  })
  it('cancels navigation on blur and blocks wheel zoom during label drag or photo loading', async () => {
    await render(); const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!, label = container.querySelector<SVGTextElement>('.trk-vm-marker-label')!
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 340, height: 420, x: 0, y: 0, right: 340, bottom: 420, toJSON() {}})
    const pointer = async (target: Element, type: string, x: number) => act(async () => {const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerId: {value: 14}, pointerType: {value: 'mouse'}, button: {value: 0}, clientX: {value: x}, clientY: {value: 100}}); target.dispatchEvent(event)})
    const wheel = async () => act(async () => viewport.dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY: -120, clientX: 170, clientY: 210})))
    await pointer(viewport, 'pointerdown', 100); await pointer(viewport, 'pointermove', 160)
    await act(async () => window.dispatchEvent(new Event('blur'))); await pointer(viewport, 'pointermove', 220)
    expect(Number(viewport.dataset.panX)).toBe(60); expect(viewport.classList.contains('is-panning')).toBe(false)
    await pointer(label, 'pointerdown', 100); await wheel(); expect(Number(viewport.dataset.zoom)).toBe(100); await pointer(label, 'pointercancel', 100)
    const reading = deferred<string>(); vi.mocked(readLinkedAnnotationPhoto).mockReturnValue(reading.promise)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="使用这张图片：1"]')!.click())
    await wheel(); expect(Number(viewport.dataset.zoom)).toBe(100)
    await act(async () => reading.resolve(photo)); await wheel(); expect(Number(viewport.dataset.zoom)).toBeGreaterThan(100); expect(writes()).toHaveLength(0)
  })
  it('pinches with two touch pointers in add mode without creating markers on release', async () => {
    await render(); await click('沿路线添加标记')
    const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!, svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 340, height: 420, x: 0, y: 0, right: 340, bottom: 420, toJSON() {}})
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 1200, height: Number(svg.getAttribute('viewBox')!.split(' ')[3]), x: 0, y: 0, right: 1200, bottom: 2000, toJSON() {}})
    const pointer = async (type: string, id: number, x: number) => act(async () => {const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerId: {value: id}, pointerType: {value: 'touch'}, button: {value: 0}, clientX: {value: x}, clientY: {value: 210}}); viewport.dispatchEvent(event)})
    const point = diagramCoordinates(coordinates)[1], clickAfterTouch = async () => act(async () => svg.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: point[0], clientY: point[1]})))
    await pointer('pointerdown', 21, 120); await pointer('pointerdown', 22, 220); await pointer('pointermove', 22, 270)
    expect(Number(viewport.dataset.zoom)).toBe(150); expect(Number(viewport.dataset.panX)).toBeCloseTo(25)
    await pointer('pointerup', 21, 120); await clickAfterTouch(); await pointer('pointerup', 22, 270); await clickAfterTouch()
    await click('导出素材 JSON'); expect(exported().markers).toHaveLength(2); expect(button('撤销').disabled).toBe(true); expect(writes()).toHaveLength(0)
  })
  it('treats an add/split touch tap as a click but never turns a single-finger drag into one', async () => {
    await render(); const viewport = container.querySelector<HTMLDivElement>('.trk-vm-canvas-scroll')!, svg = container.querySelector<SVGSVGElement>('svg.trk-vm-svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width: 1200, height: Number(svg.getAttribute('viewBox')!.split(' ')[3]), x: 0, y: 0, right: 1200, bottom: 2000, toJSON() {}})
    const point = diagramCoordinates(coordinates)[1]
    const pointer = async (type: string, x: number) => act(async () => {const event = new Event(type, {bubbles: true, cancelable: true}); Object.defineProperties(event, {pointerId: {value: 31}, pointerType: {value: 'touch'}, button: {value: 0}, clientX: {value: x}, clientY: {value: point[1]}}); viewport.dispatchEvent(event)})
    const tapClick = async () => act(async () => svg.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: point[0], clientY: point[1]})))
    await click('沿路线添加标记'); await pointer('pointerdown', point[0]); await pointer('pointermove', point[0] + 30); await pointer('pointerup', point[0] + 30); await tapClick()
    await click('导出素材 JSON'); expect(exported().markers).toHaveLength(2); expect(Number(viewport.dataset.panX)).toBe(0)
    await pointer('pointerdown', point[0]); await pointer('pointerup', point[0]); await tapClick()
    await click('导出素材 JSON'); expect(exported().markers).toHaveLength(3)
    await click('选择拆分点'); await pointer('pointerdown', point[0]); await pointer('pointermove', point[0] + 30); await pointer('pointerup', point[0] + 30); await tapClick()
    expect(container.textContent).not.toContain('已选轨迹点 1，可在此拆分路线')
    await pointer('pointerdown', point[0]); await pointer('pointerup', point[0]); await tapClick()
    expect(container.textContent).toContain('已选轨迹点 1，可在此拆分路线'); expect(writes()).toHaveLength(0)
  })
})