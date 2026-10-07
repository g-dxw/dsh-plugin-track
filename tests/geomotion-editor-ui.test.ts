// @vitest-environment jsdom
import {act, createElement, useEffect} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {GeoMotionEditor} from '../src/client/GeoMotionEditor.tsx'
import {createGeoMotionProject, geoCameraKeys, geoNewKey, geoResizeDuration, geoSetCameraKey, type GeoMotionProject} from '../src/track/geomotion.ts'
import {extractVideoMaterials, type VideoMaterialsDocument} from '../src/track/video-materials.ts'
import {createLayer} from '../src/track/vendor/geomotion/document/index.ts'
import {DEFAULT_MAP_SETTINGS, type MapSettings} from '../src/track/map-settings.ts'
import type {TrackPlacemark, PlacemarkGroup, TrackRecord} from '../src/protocol.ts'
import type {GeoMotionSceneHandle} from '../src/client/GeoMotionScene.tsx'
import {editedMetrics} from '../src/track/edit.ts'
import {api, download} from '../src/client/util.ts'
import {exportGeoMotionVideo} from '../src/client/geomotion-video-export.ts'

type SceneProps = {project: GeoMotionProject; time: number; basemap: string; settings: MapSettings; onReady: (handle: GeoMotionSceneHandle | null) => void}
const state = vi.hoisted(() => ({
  ready: true, error: '', points: [] as TrackPlacemark[], groups: [] as PlacemarkGroup[],
  segmentStarts: [0, 2], preferences: null as MapSettings | null,
  sceneProps: null as SceneProps | null, scene: null as GeoMotionSceneHandle | null,
}))
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: () => ({
  points: state.points, groups: state.groups, loading: !state.ready, editReady: state.ready,
  error: state.error, stateError: '', routeError: '', routeContext: state.ready ? {segmentStarts: state.segmentStarts} : null, retry: vi.fn(),
})}))
vi.mock('../src/client/map-settings.tsx', () => ({useMapSettings: () => ({settings: state.preferences}), BasemapControls: () => null}))
vi.mock('../src/client/GeoMotionScene.tsx', () => ({GeoMotionScene: (props: SceneProps) => {
  state.sceneProps = props
  useEffect(() => {props.onReady(state.scene); return () => props.onReady(null)}, [props.onReady])
  return createElement('div', {'data-testid': 'geomotion-scene'})
}}))
vi.mock('../src/client/geomotion-video-export.ts', () => ({exportGeoMotionVideo: vi.fn()}))
vi.mock('../src/client/util.ts', async original => ({...await original<typeof import('../src/client/util.ts')>(), api: vi.fn(), download: vi.fn()}))
const coordinates: TrackRecord['coordinates'] = [[114.17, 27.54, 600, null], [114.18, 27.53, 1100, null], [114.19, 27.48, 1600, null], [114.17, 27.45, 1900, null]]
const track: TrackRecord = {id: 'geomotion-ui', name: '测试山地轨迹', format: 'gpx', filename: 'test.gpx', createdAt: '2026-10-04', bytes: 80, points: coordinates.length, coordinates, metrics: editedMetrics(coordinates)}
const points: TrackPlacemark[] = [
  {id: 'summit', name: '已保存的新地名', coordinates: [114.18, 27.53], description: '', images: []},
  {id: 'hidden', name: '隐藏点位', coordinates: [114.19, 27.48], description: '', images: [], hidden: true},
]
let node: HTMLDivElement, root: Root, frames: Map<number, FrameRequestCallback>, frameId: number
let createURL: ReturnType<typeof vi.fn>, revokeURL: ReturnType<typeof vi.fn>, onCancel: () => void
let descriptors: (PropertyDescriptor | undefined)[]
function deferred<T>() {let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
function current(): GeoMotionProject {if (!state.sceneProps) throw new Error('Scene not ready'); return state.sceneProps.project}
function stored(document: GeoMotionProject, id = track.id, revision = 'revision-1') {return {trackId: id, sourceFingerprint: createGeoMotionProject({...track, segmentStarts: state.segmentStarts}, state.points).sourceFingerprint, revision, document}}
function button(text: string) {const result = [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text || item.textContent?.startsWith(text)); if (!result) throw new Error('Missing button: ' + text); return result}
async function click(text: string) {await act(async () => button(text).click())}
async function render(value = track, preparedMaterials?: VideoMaterialsDocument) {await act(async () => root.render(createElement(GeoMotionEditor, {track: value, preparedMaterials, basemap: 'none', onBasemap: vi.fn(), onCancel, onCases: () => {}})))}
async function edit(label: string, value: string) {await act(async () => {
  const input = node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', {bubbles: true}))
})}
async function key(element: Element, value: string, options: KeyboardEventInit = {}) {await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', {key: value, bubbles: true, ...options})))}
async function frame(clock: number) {const callbacks = [...frames.values()]; frames.clear(); await act(async () => {callbacks.forEach(callback => callback(clock))})}
async function importFile(contents: Promise<string>) {
  const file = new File(['pending'], 'shots.json', {type: 'application/json'}); Object.defineProperty(file, 'text', {value: () => contents})
  await act(async () => {const input = node.querySelector<HTMLInputElement>('input[aria-label="导入镜头工程 JSON"]')!; Object.defineProperty(input, 'files', {configurable: true, value: [file]}); input.dispatchEvent(new Event('change', {bubbles: true}))})
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.ready = true; state.error = ''
  state.points = structuredClone(points); state.groups = []; state.segmentStarts = [0, 2]
  state.preferences = structuredClone(DEFAULT_MAP_SETTINGS); state.sceneProps = null
  state.scene = {getCamera: vi.fn(() => ({center: [114.2, 27.5] as [number, number], zoom: 14, pitch: 55, bearing: 70})), renderAt: vi.fn(async () => {}), getCaptureCanvas: vi.fn(() => document.createElement('canvas')), freezeConfiguration: vi.fn(() => () => {})}
  frames = new Map(); frameId = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {frames.set(++frameId, callback); return frameId}))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.spyOn(performance, 'now').mockReturnValue(0)
  createURL = vi.fn(() => 'blob:geomotion-' + createURL.mock.calls.length); revokeURL = vi.fn()
  descriptors = ['createObjectURL', 'revokeObjectURL'].map(name => Object.getOwnPropertyDescriptor(URL, name))
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: createURL}); Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: revokeURL})
  vi.mocked(api).mockImplementation(async (_action, data) => data === undefined ? {project: null} : {project: stored((data as {project: {document: GeoMotionProject}}).project.document)})
  vi.mocked(exportGeoMotionVideo).mockResolvedValue({blob: new Blob(['frames'], {type: 'video/webm'}), filename: '测试镜头.webm'})
  onCancel = vi.fn(); node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount()); node.remove()
  for (const [index, name] of ['createObjectURL', 'revokeObjectURL'].entries()) {if (descriptors[index]) Object.defineProperty(URL, name, descriptors[index]!); else Reflect.deleteProperty(URL, name)}
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('native GeoMotion workspace', () => {
  it('waits for effective saved points and source segments before building, and never writes while reading', async () => {
    state.ready = false; const read = deferred<{project: null}>(); vi.mocked(api).mockReturnValue(read.promise)
    await render(); expect(state.sceneProps).toBeNull(); expect(button('保存工程').disabled).toBe(true)
    await act(async () => read.resolve({project: null})); expect(state.sceneProps).toBeNull()
    state.ready = true; await render()
    expect(Object.values(current().nodes).filter(node => node.type === 'route')).toHaveLength(2)
    const markers = Object.values(current().nodes).filter(node => node.type === 'marker')
    expect(markers.map(marker => marker.name)).toEqual(['已保存的新地名'])
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })
  it('does not overwrite a project when the initial GET fails and supports explicit retry', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('暂时断开'))
    await render(); expect(node.textContent).toContain('工程读取失败：暂时断开'); expect(state.sceneProps).toBeNull()
    expect(button('保存工程').disabled).toBe(true); await click('重试读取工程'); expect(current()).toBeTruthy()
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })
  it('saves only the independent animation document using the loaded revision', async () => {
    const document = createGeoMotionProject({...track, segmentStarts: [0, 2]}, points).document
    vi.mocked(api).mockImplementation(async (_action, data) => data === undefined ? {project: stored(document, track.id, 'saved-4')} : {project: stored((data as {project: {document: GeoMotionProject}}).project.document, track.id, 'saved-5')})
    const source = JSON.stringify(track); await render(); await edit('镜头时长（秒）', '24'); await click('保存工程')
    const payload = vi.mocked(api).mock.calls.find(([, data]) => data !== undefined)![1] as {id: string; expectedRevision: string; project: {trackId: string; document: GeoMotionProject}}
    expect(payload.id).toBe(track.id); expect(payload.expectedRevision).toBe('saved-4'); expect(payload.project.trackId).toBe(track.id)
    expect(payload.project.document.duration).toBe(24); expect(JSON.stringify(track)).toBe(source); expect(node.textContent).toContain('版本 saved-5')
  })
  it('brings confirmed 2D materials into a reversible unsaved draft while retaining the loaded camera and output settings', async () => {
    const effectiveTrack = {...track, segmentStarts: [0, 2]}
    let document = geoResizeDuration(createGeoMotionProject(effectiveTrack, points).document, 12)
    document = geoSetCameraKey(document, geoNewKey(3.5, {center: [114.19, 27.48], zoom: 15, bearing: 65, pitch: 52}))
    document = {...structuredClone(document), fps: 24, width: 1920, height: 1080, basemap: 'satellite', terrain: false, terrainExaggeration: 1.9, background: '#112233'}
    const oldCaption = createLayer('text', 0, {id: 'old-authored-caption', name: '原来的介绍', text: '已编排的旧文字', in: 1, out: 10})
    document.nodes[oldCaption.id] = oldCaption
    const original = JSON.stringify(document), originalKeys = geoCameraKeys(document), source = JSON.stringify(track), sourcePoints = JSON.stringify(state.points)
    const envelope = stored(document, track.id, 'saved-materials-7')
    vi.mocked(api).mockResolvedValue({project: envelope})
    const prepared = extractVideoMaterials(effectiveTrack, points)
    prepared.markers.forEach(marker => marker.selected = false)
    prepared.markers.push({id: 'prep-focus', name: '二维确认的终点', description: '这里展示我补充的真实路线说明', coordinates: [114.17, 27.45], pointIndex: 3, selected: true, color: '#0f766e', photoCandidates: [],
      photo: {dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}})
    prepared.segments[0].selected = false; prepared.segments[1].description = '只介绍第二个真实连接段'
    prepared.information.push({id: 'info-custom', label: '路线说明', text: '只展示已经确认的介绍信息', selected: true})
    await render(track, prepared)
    const applied = JSON.stringify(current()), nodes = Object.values(current().nodes)
    expect(current()).toMatchObject({duration: 12, fps: 24, width: 1920, height: 1080, basemap: 'satellite', terrain: false, terrainExaggeration: 1.9, background: '#112233'})
    expect(geoCameraKeys(current())).toEqual(originalKeys)
    expect(nodes.filter(node => node.type === 'route').map(route => route.coords)).toEqual([[[114.19, 27.48], [114.17, 27.45]]])
    expect(nodes.filter(node => node.type === 'marker').map(marker => marker.name)).toEqual(['二维确认的终点'])
    expect(nodes.filter(node => node.type === 'image').map(image => image.caption)).toEqual(['二维确认的终点'])
    expect(nodes.filter(node => node.type === 'text').some(text => text.text.includes('这里展示我补充的真实路线说明'))).toBe(true)
    expect(nodes.filter(node => node.type === 'text').some(text => text.text.includes('只展示已经确认的介绍信息'))).toBe(true)
    expect(current().nodes[oldCaption.id]).toBeUndefined()
    expect(node.querySelector('.trk-gm-heading')!.textContent).toContain('有未保存修改')
    expect(node.textContent).not.toContain('轨迹或已保存地名已变化')
    expect(vi.mocked(api).mock.calls).toHaveLength(1)
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
    await click('导出 JSON')
    const exported = JSON.parse(vi.mocked(download).mock.calls.at(-1)![1]) as {sourceFingerprint: string; document: GeoMotionProject}
    expect(exported.sourceFingerprint).toBe(envelope.sourceFingerprint)
    expect(exported.sourceFingerprint.startsWith('gm1-')).toBe(true)
    expect(exported.sourceFingerprint).not.toBe(prepared.sourceFingerprint)
    await click('撤销')
    expect(JSON.stringify(current())).toBe(original)
    expect(node.querySelector('.trk-gm-heading')!.textContent).not.toContain('有未保存修改')
    await render(track, prepared)
    expect(JSON.stringify(current())).toBe(original)
    expect(button('重做').disabled).toBe(false)
    await click('重做')
    expect(JSON.stringify(current())).toBe(applied)
    expect(geoCameraKeys(current())).toEqual(originalKeys)
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
    expect(JSON.stringify(track)).toBe(source); expect(JSON.stringify(state.points)).toBe(sourcePoints); expect(JSON.stringify(document)).toBe(original)
  })
  it('waits for effective source readiness before applying prepared materials to an already restored camera composition', async () => {
    const effectiveTrack = {...track, segmentStarts: [0, 2]}, document = createGeoMotionProject(effectiveTrack, points).document
    const prepared = extractVideoMaterials(effectiveTrack, points)
    prepared.markers[0].name = '等来源读取完成再带入'
    state.ready = false
    vi.mocked(api).mockResolvedValue({project: stored(document)})
    await render(track, prepared)
    expect(JSON.stringify(current())).toBe(JSON.stringify(document))
    expect(button('撤销').disabled).toBe(true)
    expect(node.textContent).not.toContain('已将确认的二维素材带入镜头草稿')
    state.ready = true
    await render(track, prepared)
    expect(Object.values(current().nodes).some(node => node.type === 'marker' && node.name === '等来源读取完成再带入')).toBe(true)
    expect(geoCameraKeys(current())).toEqual(geoCameraKeys(document))
    expect(button('撤销').disabled).toBe(false)
    expect(node.textContent).not.toContain('轨迹或已保存地名已变化')
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
    await click('撤销')
    expect(JSON.stringify(current())).toBe(JSON.stringify(document))
    await render(track, prepared)
    expect(JSON.stringify(current())).toBe(JSON.stringify(document))
  })
  it('records the actual map camera through K only while editor focus is outside form fields', async () => {
    await render(); await edit('当前时间（秒）', '4')
    const workspace = node.querySelector<HTMLDivElement>('.trk-gm')!; workspace.focus(); await key(workspace, 'k')
    const recorded = geoCameraKeys(current()).find(key => key.t === 4)!
    expect(recorded.center).toEqual([114.2, 27.5]); expect(recorded.zoom).toBe(14); expect(recorded.bearing).toBe(70)
    const before = JSON.stringify(current()), input = node.querySelector<HTMLInputElement>('[aria-label="经度"]')!; input.focus(); await key(input, 'k'); expect(JSON.stringify(current())).toBe(before)
    await click('撤销'); expect(geoCameraKeys(current()).some(key => key.t === 4)).toBe(false)
    await click('重做'); expect(geoCameraKeys(current()).some(key => key.t === 4)).toBe(true)
  })
  it('provides keyboard and numeric alternatives for retiming a timeline keyframe', async () => {
    await render(); const first = node.querySelector<HTMLButtonElement>('.trk-gm-key')!; first.focus(); await key(first, 'ArrowRight')
    expect(geoCameraKeys(current())[0].t).toBeCloseTo(1 / current().fps, 10)
    await edit('关键帧时间（秒）', '2.5'); expect(geoCameraKeys(current())[0].t).toBe(2.5)
    expect(node.querySelector<HTMLInputElement>('[aria-label="当前时间（秒）"]')!.value).toBe('2.5')
  })
  it('applies editable templates and retains the last route frame during duration changes', async () => {
    await render(); await click('环绕航拍'); const keys = geoCameraKeys(current()); expect(keys.length).toBeGreaterThan(2)
    expect(keys.at(-1)!.bearing).toBeGreaterThan(keys[0].bearing)
    await edit('镜头时长（秒）', '40'); expect(current().duration).toBe(40); expect(geoCameraKeys(current()).at(-1)!.t).toBe(40)
    await click('撤销'); expect(current().duration).toBe(20)
  })
  it('changes geographic label windows without writing source placemarks', async () => {
    await render(); const original = structuredClone(state.points)
    await click('已保存的新地名'); await edit('开始显示（秒）', '3'); await edit('结束显示（秒）', '8')
    const marker = Object.values(current().nodes).find(node => node.type === 'marker')!; expect(marker.in).toBe(3); expect(marker.out).toBe(8)
    expect(state.points).toEqual(original); expect(vi.mocked(api).mock.calls).toHaveLength(1)
  })
  it('keeps a saved composition stable until the user explicitly rebuilds changed source data', async () => {
    const imported = createGeoMotionProject({...track, segmentStarts: [0, 2]}, points)
    vi.mocked(api).mockResolvedValue({project: {trackId: track.id, sourceFingerprint: imported.sourceFingerprint, document: imported.document, revision: 'revision-1'}})
    await render(); const original = JSON.stringify(current())
    state.points = [{...points[0], name: '再次修改的地名'}]; await render()
    expect(JSON.stringify(current())).toBe(original); expect(node.textContent).toContain('轨迹或已保存地名已变化')
    await click('根据当前轨迹重建'); expect(Object.values(current().nodes).some(node => node.name === '再次修改的地名')).toBe(true)
    await click('撤销'); expect(JSON.stringify(current())).toBe(original); expect(node.textContent).toContain('轨迹或已保存地名已变化')
  })
  it('blocks mutation and navigation during export, freezes settings, and cancels late output', async () => {
    const exported = deferred<{blob: Blob; filename: string}>(); vi.mocked(exportGeoMotionVideo).mockReturnValue(exported.promise)
    await render(); const original = JSON.stringify(current()); await click('导出 WebM 视频')
    const options = vi.mocked(exportGeoMotionVideo).mock.calls[0][0]
    expect(button('返回轨迹').disabled).toBe(true); expect(button('保存工程').disabled).toBe(true); expect(button('环境介绍').disabled).toBe(true)
    expect(node.querySelector<HTMLInputElement>('[aria-label="导入镜头工程 JSON"]')!.disabled).toBe(true)
    const settings = state.sceneProps!.settings; state.preferences = {...state.preferences!, exaggeration: 2}; await render(); expect(state.sceneProps!.settings).toBe(settings)
    expect(JSON.stringify(current())).toBe(original); await click('取消导出'); expect(options.signal!.aborted).toBe(true)
    await act(async () => exported.resolve({blob: new Blob(['late']), filename: 'late.webm'})); expect(createURL).not.toHaveBeenCalled(); expect(node.textContent).toContain('已取消视频导出')
  })
  it('previews exported video without automatic download and releases object URLs on exit', async () => {
    await render(); await click('导出 WebM 视频')
    expect(node.querySelector('video')?.getAttribute('src')).toBe('blob:geomotion-1'); expect(node.querySelector('a[download]')?.getAttribute('download')).toBe('测试镜头.webm')
    expect(download).not.toHaveBeenCalled(); await act(async () => root.unmount()); expect(revokeURL).toHaveBeenCalledWith('blob:geomotion-1')
    root = createRoot(node)
  })
  it('cancels playback and export resources on unmount and rejects late cross-track reads', async () => {
    const oldRead = deferred<{project: null}>(); vi.mocked(api).mockReturnValueOnce(oldRead.promise)
    await render(); await render({...track, id: 'second-track'}); expect(current()).toBeTruthy()
    const before = JSON.stringify(current()); await act(async () => oldRead.resolve({project: null})); expect(JSON.stringify(current())).toBe(before)
    await click('播放'); await frame(1000); expect(state.sceneProps!.time).toBe(1)
    await act(async () => root.unmount()); expect(frames.size).toBe(0); root = createRoot(node)
  })
  it('invalidates a pending import when exporting begins and rejects another track envelope', async () => {
    await render(); const original = JSON.stringify(current()), text = deferred<string>()
    await importFile(text.promise); const exported = deferred<{blob: Blob; filename: string}>(); vi.mocked(exportGeoMotionVideo).mockReturnValue(exported.promise); await click('导出 WebM 视频')
    await act(async () => text.resolve(JSON.stringify({...current(), duration: 99}))); expect(JSON.stringify(current())).toBe(original)
    await click('取消导出'); await act(async () => exported.resolve({blob: new Blob(), filename: 'cancelled.webm'}))
    await importFile(Promise.resolve(JSON.stringify({trackId: 'unrelated', document: current()}))); expect(node.textContent).toContain('属于另一条轨迹')
  })
  it('restores complete saved compositions and their basemap even when source data is unavailable', async () => {
    const document = {...createGeoMotionProject({...track, segmentStarts: [0, 2]}, points).document, basemap: 'satellite'}
    state.ready = false; state.error = '原文件暂时无法读取'
    vi.mocked(api).mockResolvedValue({project: stored(document)})
    await render(); expect(state.sceneProps!.basemap).toBe('satellite'); expect(current().basemap).toBe('satellite')
    expect(node.textContent).toContain('原文件暂时无法读取'); await click('导出 JSON')
    expect(vi.mocked(download).mock.calls[0][1]).toContain('satellite'); expect(button('基于当前轨迹新建工程').disabled).toBe(true)
  })
  it('saves before leaving and retains edits when the server reports a conflicting revision', async () => {
    await render(); await edit('镜头时长（秒）', '26'); await click('返回轨迹')
    expect(onCancel).toHaveBeenCalledTimes(1)
    await edit('镜头时长（秒）', '28')
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('工程冲突'), {status: 409}))
    await click('返回轨迹'); expect(onCancel).toHaveBeenCalledTimes(1); expect(current().duration).toBe(28)
    expect(node.textContent).toContain('当前编辑保留')
  })
  it('commits a dragged key at the time indicated by the same timeline coordinate', async () => {
    await render(); const timeline = node.querySelector<HTMLDivElement>('.trk-gm-tl-ruler')!
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, right: 1000, bottom: 60, width: 1000, height: 60, x: 0, y: 0, toJSON() {}})
    const key = node.querySelector<HTMLButtonElement>('.trk-gm-key')!
    await act(async () => key.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, clientX: 0})))
    await act(async () => key.dispatchEvent(new MouseEvent('pointermove', {bubbles: true, clientX: 300})))
    await act(async () => key.dispatchEvent(new MouseEvent('pointerup', {bubbles: true, clientX: 300})))
    expect(geoCameraKeys(current())[0].t).toBe(6)
    expect(node.querySelector<HTMLInputElement>('[aria-label="当前时间（秒）"]')!.value).toBe('6')
  })

  it('treats a source-only import as unsaved and persists its fingerprint before leaving', async () => {
    await render(); await click('保存工程'); const document = structuredClone(current())
    await importFile(Promise.resolve(JSON.stringify({trackId: track.id, sourceFingerprint: 'different-source-only', document})))
    expect(node.querySelector('.trk-gm-heading')!.textContent).toContain('有未保存修改')
    vi.mocked(api).mockImplementation(async (_action, payload) => ({project: {...stored((payload as {project: {document: GeoMotionProject}}).project.document, track.id, 'revision-2'), sourceFingerprint: 'different-source-only'}}))
    await click('返回轨迹'); expect(onCancel).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(api).mock.calls.at(-1)![1] as {project: {sourceFingerprint: string}}
    expect(payload.project.sourceFingerprint).toBe('different-source-only')
  })

})
