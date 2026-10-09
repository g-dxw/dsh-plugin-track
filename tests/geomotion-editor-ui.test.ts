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
import {API} from '../src/protocol.ts'
import type {GeoMotionSceneHandle} from '../src/client/GeoMotionScene.tsx'
import {editedMetrics} from '../src/track/edit.ts'
import {api, download} from '../src/client/util.ts'
import {exportGeoMotionVideo} from '../src/client/geomotion-video-export.ts'
import type {EditorNavigationHandle} from '../src/client/editor-navigation.tsx'
import {createShotCaptureStore} from '../src/client/shot-capture-store.ts'
import type {OpenMontageEditorScope} from '../src/track/shot-project-scope.ts'

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
vi.mock('../src/client/map-settings.tsx', () => ({useMapSettings: () => ({settings: state.preferences}), BasemapControls: (props: {className?: string}) => createElement('div', {className: props.className, 'data-testid': 'basemap-controls'})}))
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
let createURL: ReturnType<typeof vi.fn>, revokeURL: ReturnType<typeof vi.fn>, onCancel: () => void, onCases: () => void, onMaterials: () => void
let descriptors: (PropertyDescriptor | undefined)[]
function deferred<T>() {let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
function current(): GeoMotionProject {if (!state.sceneProps) throw new Error('Scene not ready'); return state.sceneProps.project}
function stored(document: GeoMotionProject, id = track.id, revision = 'revision-1') {return {trackId: id, sourceFingerprint: createGeoMotionProject({...track, segmentStarts: state.segmentStarts}, state.points).sourceFingerprint, revision, document}}
function approval(scope: OpenMontageEditorScope, canProduce = true) {return new Response(JSON.stringify({canProduce, scenePlanDigest: scope.scenePlanDigest, project: {projectId: scope.projectId, trackId: track.id}, shots: [{shotId: scope.shotId, sceneId: scope.sceneId, editor: 'map', scope}]}), {headers: {'content-type': 'application/json'}})}
function button(text: string) {const result = [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text || item.textContent?.startsWith(text)); if (!result) throw new Error('Missing button: ' + text); return result}
async function click(text: string) {await act(async () => button(text).click())}
async function render(value = track, preparedMaterials?: VideoMaterialsDocument, extra: Partial<Parameters<typeof GeoMotionEditor>[0]> = {}) {await act(async () => root.render(createElement(GeoMotionEditor, {track: value, preparedMaterials, basemap: 'none', onBasemap: vi.fn(), onCancel, onCases, onMaterials, ...extra})))}
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
  onCancel = vi.fn(); onCases = vi.fn(); onMaterials = vi.fn(); node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount()); node.remove()
  for (const [index, name] of ['createObjectURL', 'revokeObjectURL'].entries()) {if (descriptors[index]) Object.defineProperty(URL, name, descriptors[index]!); else Reflect.deleteProperty(URL, name)}
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('native GeoMotion workspace', () => {
  it('restores a failed capture after visiting another shot with the same Blob and take, using a fresh downloadable URL', async () => {
    const scope = {projectId: 'project-1', shotId: 'shot-a', sceneId: 'SC03', scenePlanDigest: 'confirmed-1'}, captureStore = createShotCaptureStore()
    const blob = new Blob(['retained map capture'], {type: 'video/webm'}); vi.mocked(exportGeoMotionVideo).mockResolvedValue({blob, filename: 'retained.webm'})
    let savedProject: ReturnType<typeof stored> | null = null
    vi.mocked(api).mockImplementation(async (action, payload) => {
      if (payload) {savedProject = stored((payload as {project: {document: GeoMotionProject}}).project.document); return {project: savedProject}}
      return {project: action.includes('shotId=shot-a') ? savedProject : null}
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(approval(scope)).mockResolvedValueOnce(new Response(JSON.stringify({error: '测试 409：工程版本冲突'}), {status: 409, headers: {'content-type': 'application/json'}}))
    vi.stubGlobal('fetch', fetcher)
    await render(track, undefined, {scope, captureStore}); await click('保存工程'); await click('导出 WebM 视频'); await frame(0); await frame(16); await click('回填当前分镜素材')
    const identity = captureStore.get(track.id, scope, 'map')!.identity, originalUrl = node.querySelector('.trk-gm-video a[download]')!.getAttribute('href')
    await render(track, undefined, {scope: {...scope, shotId: 'shot-b', sceneId: 'SC04'}, captureStore})
    expect(revokeURL).toHaveBeenCalledWith(originalUrl); expect(node.querySelector('.trk-gm-video a[download]')).toBeNull()
    await render(track, undefined, {scope, captureStore})
    expect(createURL.mock.calls.at(-1)![0]).toBe(blob); expect(node.querySelector('.trk-gm-video a[download]')!.getAttribute('href')).not.toBe(originalUrl)
    expect(node.textContent).toContain('测试 409：工程版本冲突'); expect(button('回填当前分镜素材').disabled).toBe(false)
    expect(captureStore.get(track.id, scope, 'map')!.identity).toBe(identity)
    await render(track, undefined, {scope: {...scope, scenePlanDigest: 'new-confirmed-plan'}, captureStore})
    expect(button('回填当前分镜素材').disabled).toBe(true); expect(node.querySelector('.trk-gm-video a[download]')).not.toBeNull()
  })
  it('isolates project shots from legacy materials and only exports saved scoped projects', async () => {
    const scope = {projectId: 'project-1', shotId: 'shot-1', sceneId: 'SC03', scenePlanDigest: 'confirmed-1'}
    await render(track, undefined, {scope})
    expect(vi.mocked(api).mock.calls[0][0]).toBe('geomotion-project?id=geomotion-ui&projectId=project-1&shotId=shot-1')
    expect(button('导出 WebM 视频').disabled).toBe(true)
    expect(node.textContent).toContain('分镜 SC03'); expect(node.textContent).not.toContain('二维素材准备')
    await edit('镜头时长（秒）', '11'); await click('保存工程')
    const payload = vi.mocked(api).mock.calls.find(([, data]) => data !== undefined)![1] as Record<string, unknown>
    expect(payload).toMatchObject({projectId: 'project-1', shotId: 'shot-1', expectedRevision: null})
    expect(button('导出 WebM 视频').disabled).toBe(false)
    await edit('镜头时长（秒）', '13'); expect(button('导出 WebM 视频').disabled).toBe(true)
    await render(track, undefined, {scope: {...scope, shotId: 'shot-2', sceneId: 'SC04'}})
    expect(current().duration).toBe(20); expect(node.textContent).toContain('分镜 SC04')
    expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain('shotId=shot-2')
    expect(node.querySelector<HTMLAnchorElement>('.trk-gm-file-tools a')!.href).toContain('shotId=shot-2')
  })
  it('backfills the exported map Blob with frozen revision and retries a failed take without losing its download', async () => {
    const scope = {projectId: 'project-1', shotId: 'shot-1', sceneId: 'SC03', scenePlanDigest: 'confirmed-1'}, onShotResult = vi.fn()
    const blob = new Blob(['map frames'], {type: 'video/webm'}); vi.mocked(exportGeoMotionVideo).mockResolvedValue({blob, filename: 'map.webm'})
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(approval(scope)).mockResolvedValueOnce(new Response(JSON.stringify({error: '回填暂时失败'}), {status: 503, headers: {'content-type': 'application/json'}}))
      .mockImplementation(async path => {
        const query = new URL(String(path), 'http://localhost').searchParams
        return new Response(JSON.stringify({take: {takeId: query.get('takeId'), shotId: scope.shotId, sceneId: scope.sceneId, scenePlanDigest: scope.scenePlanDigest, projectRevision: query.get('projectRevision'), editor: 'map'}}), {headers: {'content-type': 'application/json'}})
      })
    vi.stubGlobal('fetch', fetcher)
    await render(track, undefined, {scope, onShotResult}); await click('保存工程'); await click('导出 WebM 视频'); await frame(0); await frame(16)
    await click('回填当前分镜素材'); expect(node.textContent).toContain('回填暂时失败'); expect(node.querySelector('.trk-gm-video a[download]')).not.toBeNull()
    await edit('镜头时长（秒）', '21'); expect(button('回填当前分镜素材').disabled).toBe(true)
    await click('撤销'); expect(button('回填当前分镜素材').disabled).toBe(false)
    await click('回填当前分镜素材')
    expect(fetcher.mock.calls).toHaveLength(3); expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[2][0]); expect(fetcher.mock.calls[1][1]!.body).toBe(blob)
    expect(new URL(String(fetcher.mock.calls[1][0]), 'http://localhost').searchParams.get('projectRevision')).toBe('revision-1')
    expect(onShotResult).toHaveBeenCalledTimes(1); expect(node.textContent).toContain('已回填当前分镜素材')
  })
  it.each(['unapproved', 'changed-mapping', 'unreadable'])('preserves a saved scoped map project without starting export when approval is %s', async reason => {
    const scope = {projectId: 'project-1', shotId: 'shot-1', sceneId: 'SC03', scenePlanDigest: 'confirmed-1'}
    const response = reason === 'unreadable' ? new Response('service unavailable', {status: 503}) : approval(reason === 'changed-mapping' ? {...scope, sceneId: 'SC99'} : scope, reason !== 'unapproved')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response))
    await render(track, undefined, {scope}); await click('保存工程'); const original = JSON.stringify(current())
    await click('导出 WebM 视频'); await frame(0); await frame(16)
    expect(exportGeoMotionVideo).not.toHaveBeenCalled(); expect(frames.size).toBe(0)
    expect(JSON.stringify(current())).toBe(original); expect(node.textContent).toContain('镜头工程已保留')
    expect(button('导出 WebM 视频').disabled).toBe(false)
  })
  it('cancels the scoped approval check without starting export or changing the saved project', async () => {
    const scope = {projectId: 'project-1', shotId: 'shot-1', sceneId: 'SC03', scenePlanDigest: 'confirmed-1'}
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    vi.stubGlobal('fetch', fetcher)
    await render(track, undefined, {scope}); await click('保存工程'); const original = JSON.stringify(current())
    await click('导出 WebM 视频'); const signal = fetcher.mock.calls[0][1]!.signal!
    expect(signal.aborted).toBe(false); expect(frames.size).toBe(0)
    await click('取消导出'); expect(signal.aborted).toBe(true)
    expect(exportGeoMotionVideo).not.toHaveBeenCalled(); expect(JSON.stringify(current())).toBe(original)
    expect(button('导出 WebM 视频').disabled).toBe(false)
  })
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
    const backup = node.querySelector<HTMLAnchorElement>('.trk-gm-file-tools a')!
    expect(backup.getAttribute('href')).toBe(`${API}/shot-project-backup?id=${track.id}&scene=map`)
    expect(backup.getAttribute('aria-disabled')).not.toBe('true')
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
  it('uses the shared shot title and project tools and returns a saved project without writing', async () => {
    const project = createGeoMotionProject({...track, segmentStarts: state.segmentStarts}, points).document
    vi.mocked(api).mockResolvedValueOnce({project: stored(project)})
    await render(); const previous = JSON.stringify(current())
    expect(node.querySelector('h2')!.textContent).toBe('镜头编辑')
    expect(node.querySelector('.trk-gm-context')!.textContent).toContain('地图场景')
    expect(node.querySelector('.trk-gm-mapbar > [data-testid="basemap-controls"]')!.className).toBe('trk-gm-basemaps')
    expect([...node.querySelectorAll('button')].some(item => item.textContent?.includes('案例'))).toBe(false)
    const tools = node.querySelector<HTMLDetailsElement>('.trk-gm-file-tools')!
    expect(tools.open).toBe(false); expect(tools.querySelector('summary')!.textContent).toBe('工程文件')
    await act(async () => tools.querySelector('summary')!.click())
    expect(tools.open).toBe(true); await click('导出 JSON')
    expect(JSON.parse(vi.mocked(download).mock.calls.at(-1)![1] as string).document).toEqual(current())
    expect(JSON.stringify(current())).toBe(previous)
    await click('返回视频制作'); expect(onCases).toHaveBeenCalledTimes(1); expect(onCancel).not.toHaveBeenCalled()
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })
  it('waits for an explicit save decision before leaving and keeps the dialog and conflict edits in place', async () => {
    await render(); await edit('镜头时长（秒）', '26')
    const snapshot = structuredClone(current()), saving = deferred<{project: ReturnType<typeof stored>}>()
    vi.mocked(api).mockReturnValueOnce(saving.promise)
    await click('返回视频制作')
    expect(vi.mocked(api).mock.calls.filter(([, data]) => data !== undefined)).toHaveLength(0)
    expect(node.querySelector('[role=dialog]')).not.toBeNull(); expect(onCases).not.toHaveBeenCalled()
    await click('保存后继续')
    const status = node.querySelector<HTMLElement>('.trk-gm-heading [role=status]')!
    expect(status.getAttribute('aria-live')).toBe('polite'); expect(status.textContent).toBe('正在保存镜头工程…')
    expect(node.querySelector('.trk-gm-dirty')!.textContent).toBe('有未保存修改')
    expect(button('返回视频制作').disabled).toBe(true); expect(onCases).not.toHaveBeenCalled()
    await act(async () => saving.resolve({project: stored(snapshot)}))
    expect(onCases).toHaveBeenCalledTimes(1); expect(node.querySelector('.trk-gm-dirty')).toBeNull()
    expect(status.textContent).toContain('已保存到轨迹工作区')
    await edit('镜头时长（秒）', '28'); expect(status.textContent).toBe('等待保存到轨迹工作区')
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('工程冲突'), {status: 409}))
    await click('返回视频制作'); await click('保存后继续'); expect(onCases).toHaveBeenCalledTimes(1); expect(current().duration).toBe(28)
    expect(status.textContent).toBe('保存失败，当前编辑仍保留'); expect(node.textContent).toContain('当前编辑保留')
    expect(node.querySelector('[role=dialog]')).not.toBeNull()
    expect(button('撤销').disabled).toBe(false)
  })
  it('keeps draft history and playhead when inactive, removes the map scene, and never reinitializes on return', async () => {
    const register = vi.fn<(handle: EditorNavigationHandle | null) => void>()
    await render(track, undefined, {onRegister: register, onCases: undefined})
    expect(node.querySelector('button')?.textContent).not.toContain('案例')
    await edit('镜头时长（秒）', '27'); await edit('当前时间（秒）', '4')
    const draft = JSON.stringify(current()), reads = vi.mocked(api).mock.calls.length
    await click('播放'); await frame(1000); expect(state.sceneProps!.time).toBe(5)
    await render(track, undefined, {active: false, onRegister: register, onCases: undefined})
    expect(node.querySelector('[data-testid=geomotion-scene]')).toBeNull()
    expect(frames.size).toBe(0); expect(register).toHaveBeenLastCalledWith(null)
    expect(node.querySelector<HTMLInputElement>('[aria-label="当前时间（秒）"]')!.value).toBe('5')
    await render(track, undefined, {active: true, onRegister: register, onCases: undefined})
    expect(node.querySelector('[data-testid=geomotion-scene]')).not.toBeNull()
    expect(JSON.stringify(current())).toBe(draft); expect(state.sceneProps!.time).toBe(5)
    expect(button('撤销').disabled).toBe(false); expect(button('播放').disabled).toBe(false)
    expect(vi.mocked(api).mock.calls).toHaveLength(reads)
    await click('撤销'); expect(current().duration).toBe(20)
  })
  it('cancels leaving without changing the draft or writing and discards to the latest saved baseline', async () => {
    await render(); await click('保存工程'); const baseline = JSON.stringify(current())
    await edit('镜头时长（秒）', '29'); const draft = JSON.stringify(current())
    const trigger = button('返回轨迹'); trigger.focus(); await click('返回轨迹'); await click('取消')
    expect(document.activeElement).toBe(trigger); expect(JSON.stringify(current())).toBe(draft)
    expect(onCancel).not.toHaveBeenCalled()
    await click('返回轨迹'); await click('放弃本次修改')
    expect(onCancel).toHaveBeenCalledTimes(1); expect(JSON.stringify(current())).toBe(baseline)
    expect(node.querySelector('.trk-gm-dirty')).toBeNull(); expect(button('撤销').disabled).toBe(true)
    expect(vi.mocked(api).mock.calls.filter(([, data]) => data !== undefined)).toHaveLength(1)
  })
  it('discards an unsaved initial project to its first snapshot and can reactivate it without a blank scene', async () => {
    await render(); const baseline = JSON.stringify(current())
    await edit('镜头时长（秒）', '31'); await click('返回轨迹'); await click('放弃本次修改')
    expect(JSON.stringify(current())).toBe(baseline); expect(onCancel).toHaveBeenCalledTimes(1)
    await render(track, undefined, {active: false}); await render()
    expect(node.querySelector('[data-testid=geomotion-scene]')).not.toBeNull()
    expect(JSON.stringify(current())).toBe(baseline)
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
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
  it('applies each newly confirmed material document once in a retained editor without replacing authored camera or output settings', async () => {
    const effectiveTrack = {...track, segmentStarts: [0, 2]}
    const first = extractVideoMaterials(effectiveTrack, points)
    first.markers[0].name = '第一次确认的地名'
    let document = geoResizeDuration(createGeoMotionProject(effectiveTrack, points).document, 12)
    document = {...geoSetCameraKey(document, geoNewKey(3.5, {center: [114.19, 27.48], zoom: 15, bearing: 65, pitch: 52})), fps: 24, width: 1920, height: 1080, basemap: 'satellite'}
    vi.mocked(api).mockResolvedValue({project: stored(document)})
    await render(track, first); const firstDraft = JSON.stringify(current()), authoredKeys = geoCameraKeys(current())
    await edit('当前时间（秒）', '4')
    await render(track, first, {active: false})
    const second = structuredClone(first); second.markers[0].name = '第二次确认的地名'; second.markers[0].description = '第二次确认的介绍'
    await render(track, second, {active: false})
    await render(track, second, {active: true})
    const secondDraft = JSON.stringify(current())
    expect(Object.values(current().nodes).some(node => node.type === 'marker' && node.name === '第二次确认的地名')).toBe(true)
    expect(current()).toMatchObject({duration: 12, fps: 24, width: 1920, height: 1080, basemap: 'satellite'})
    expect(geoCameraKeys(current())).toEqual(authoredKeys)
    await render(track, structuredClone(second)); expect(JSON.stringify(current())).toBe(secondDraft)
    await click('撤销'); expect(JSON.stringify(current())).toBe(firstDraft)
    await render(track, structuredClone(second)); expect(JSON.stringify(current())).toBe(firstDraft)
    expect(button('重做').disabled).toBe(false)
    await click('重做'); expect(JSON.stringify(current())).toBe(secondDraft)
    expect(vi.mocked(api).mock.calls).toHaveLength(1)
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
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
  it('retains manually recorded cameras during duration changes without template replacement controls', async () => {
    await render()
    expect(node.querySelector('.trk-gm-templates')).toBeNull()
    for (const label of ['环境介绍', '环绕航拍', '升高拉远', '地名巡游']) expect(node.textContent).not.toContain(label)
    await edit('当前时间（秒）', '4'); await click('记录当前构图（K）')
    const keys = geoCameraKeys(current()), original = JSON.stringify(current())
    expect(keys.map(key => key.t)).toEqual([0, 4, 15, 20])
    await edit('镜头时长（秒）', '40')
    expect(current().duration).toBe(40)
    expect(geoCameraKeys(current()).map(key => key.t)).toEqual([0, 8, 30, 40])
    expect(geoCameraKeys(current())[1]).toMatchObject({...keys[1], t: 8})
    await click('撤销'); expect(JSON.stringify(current())).toBe(original)
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
    await click('根据当前轨迹重建'); expect(JSON.stringify(current())).toBe(original)
    await click('确认重建工程'); expect(Object.values(current().nodes).some(node => node.name === '再次修改的地名')).toBe(true)
    await click('撤销'); expect(JSON.stringify(current())).toBe(original); expect(node.textContent).toContain('轨迹或已保存地名已变化')
  })
  it('requires a separate rebuild confirmation before replacing authored camera keys and allows undo without any write', async () => {
    const document = geoSetCameraKey(createGeoMotionProject({...track, segmentStarts: [0, 2]}, points).document, geoNewKey(3.5, {center: [114.19, 27.48], zoom: 15, bearing: 65, pitch: 52}))
    vi.mocked(api).mockResolvedValue({project: stored(document)})
    const register = vi.fn<(handle: EditorNavigationHandle | null) => void>()
    await render(track, undefined, {onRegister: register, onCases: undefined}); const original = JSON.stringify(current())
    expect([...node.querySelectorAll('button')].some(item => item.textContent === '返回视频制作')).toBe(false)
    const trigger = button('基于当前轨迹新建工程'); trigger.focus(); await click('基于当前轨迹新建工程')
    expect(node.querySelector('[role=dialog]')!.textContent).toContain('重新生成相机关键帧')
    expect(JSON.stringify(current())).toBe(original); expect(register.mock.calls.at(-1)![0]?.busy).toBe(true)
    await click('取消'); expect(JSON.stringify(current())).toBe(original); expect(window.document.activeElement).toBe(trigger)
    expect(register.mock.calls.at(-1)![0]?.busy).toBe(false)
    await click('基于当前轨迹新建工程'); await click('确认重建工程')
    expect(geoCameraKeys(current()).some(key => key.t === 3.5)).toBe(false)
    expect(button('撤销').disabled).toBe(false); await click('撤销'); expect(JSON.stringify(current())).toBe(original)
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })
  it('blocks mutation and navigation during export, freezes settings, and cancels late output', async () => {
    const exported = deferred<{blob: Blob; filename: string}>(); vi.mocked(exportGeoMotionVideo).mockReturnValue(exported.promise)
    await render(); const original = JSON.stringify(current()); await click('导出 WebM 视频')
    expect(button('返回轨迹').disabled).toBe(true); expect(button('保存工程').disabled).toBe(true); expect(button('记录当前构图（K）').disabled).toBe(true)
    expect(node.querySelector<HTMLInputElement>('[aria-label="导入镜头工程 JSON"]')!.disabled).toBe(true)
    const settings = state.sceneProps!.settings; state.preferences = {...state.preferences!, exaggeration: 2}; await render(); expect(state.sceneProps!.settings).toBe(settings)
    await frame(0); await frame(16); const options = vi.mocked(exportGeoMotionVideo).mock.calls[0][0]
    expect(JSON.stringify(current())).toBe(original); await click('取消导出'); expect(options.signal!.aborted).toBe(true)
    await act(async () => exported.resolve({blob: new Blob(['late']), filename: 'late.webm'})); expect(createURL).not.toHaveBeenCalled(); expect(node.textContent).toContain('已取消视频导出')
  })
  it('previews exported video without automatic download and releases object URLs on exit', async () => {
    await render(); await click('导出 WebM 视频'); await frame(0); await frame(16)
    expect(node.querySelector('video')?.getAttribute('src')).toBe('blob:geomotion-1'); expect(node.querySelector('.trk-gm-video a[download]')?.getAttribute('download')).toBe('测试镜头.webm')
    expect(download).not.toHaveBeenCalled(); await act(async () => root.unmount()); expect(revokeURL).toHaveBeenCalledWith('blob:geomotion-1')
    root = createRoot(node)
  })
  it('switches a narrow properties panel to preview and waits two layout frames before starting the encoder', async () => {
    await render(); const original = JSON.stringify(current())
    await click('镜头属性'); expect(node.querySelector('.trk-gm')!.getAttribute('data-panel')).toBe('properties')
    await click('导出 WebM 视频')
    expect(node.querySelector('.trk-gm')!.getAttribute('data-panel')).toBe('preview')
    expect(button('返回轨迹').disabled).toBe(true); expect(button('保存工程').disabled).toBe(true)
    expect(exportGeoMotionVideo).not.toHaveBeenCalled()
    await frame(0); expect(exportGeoMotionVideo).not.toHaveBeenCalled()
    await frame(16); expect(exportGeoMotionVideo).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(current())).toBe(original); expect(node.querySelector('video')).not.toBeNull()
  })
  it.each(['cancel', 'unmount'])('cancels pending layout frames before export on %s without starting an encoder', async action => {
    await render(); const original = JSON.stringify(current()); await click('导出 WebM 视频')
    await frame(0); expect(frames.size).toBe(1)
    if (action === 'cancel') await click('取消导出')
    else {await act(async () => root.unmount()); root = createRoot(node)}
    expect(frames.size).toBe(0); await frame(16)
    expect(exportGeoMotionVideo).not.toHaveBeenCalled(); expect(createURL).not.toHaveBeenCalled()
    if (action === 'cancel') {expect(JSON.stringify(current())).toBe(original); expect(button('保存工程').disabled).toBe(false); expect(node.textContent).toContain('已取消视频导出')}
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
  it.each(['inactive', 'discard', 'edit', 'save'])('rejects a late file read after %s without replacing the current camera draft', async action => {
    const document = geoSetCameraKey(createGeoMotionProject({...track, segmentStarts: [0, 2]}, points).document, geoNewKey(3.5, {center: [114.19, 27.48], zoom: 15, bearing: 65, pitch: 52}))
    vi.mocked(api).mockImplementation(async (_action, data) => data === undefined ? {project: stored(document)} : {project: stored((data as {project: {document: GeoMotionProject}}).project.document, track.id, 'revision-2')})
    await render()
    if (action === 'discard') await edit('镜头时长（秒）', '26')
    const file = deferred<string>(), imported = {...structuredClone(current()), duration: 99}
    await importFile(file.promise)
    if (action === 'inactive') await render(track, undefined, {active: false})
    else if (action === 'discard') {await click('返回轨迹'); await click('放弃本次修改')}
    else if (action === 'edit') await edit('镜头时长（秒）', '27')
    else await click('保存工程')
    const expected = action === 'discard' ? JSON.stringify(document) : JSON.stringify(current())
    await act(async () => file.resolve(JSON.stringify(imported)))
    if (action === 'inactive') await render()
    expect(JSON.stringify(current())).toBe(expected)
    expect(geoCameraKeys(current())).toEqual(geoCameraKeys(JSON.parse(expected)))
    expect(node.textContent).toContain(action === 'discard' ? '已放弃本次未保存修改' : '已取消工程导入')
    expect(vi.mocked(api).mock.calls.filter(([, data]) => data !== undefined)).toHaveLength(action === 'save' ? 1 : 0)
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
    await render(); await edit('镜头时长（秒）', '26'); await click('返回轨迹'); await click('保存后继续')
    expect(onCancel).toHaveBeenCalledTimes(1)
    await edit('镜头时长（秒）', '28')
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('工程冲突'), {status: 409}))
    await click('返回轨迹'); await click('保存后继续'); expect(onCancel).toHaveBeenCalledTimes(1); expect(current().duration).toBe(28)
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
    await click('返回轨迹'); await click('保存后继续'); expect(onCancel).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(api).mock.calls.at(-1)![1] as {project: {sourceFingerprint: string}}
    expect(payload.project.sourceFingerprint).toBe('different-source-only')
  })

})
