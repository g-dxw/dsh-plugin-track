// @vitest-environment jsdom
import {act, createElement, useEffect} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ShotEditor} from '../src/client/ShotEditor.tsx'
import {api, download} from '../src/client/util.ts'
import type {EditorNavigationHandle} from '../src/client/editor-navigation.tsx'
import type {ShotEditorSceneHandle, ShotEditorSceneProps} from '../src/client/ShotEditorScene.tsx'
import {createShotEditorPlan, evaluateShotEditorFrame, parseShotEditorPlan, shotEditorTrackFingerprint, type ShotEditorPlan} from '../src/track/shot-editor.ts'
import {DEFAULT_MAP_SETTINGS, MAP_SETTINGS_KEY, readMapSettings, type MapSettings} from '../src/track/map-settings.ts'
import type {SandboxCameraState} from '../src/track/sandbox/types.ts'
import type {PlacemarkGroup, TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import {editedMetrics} from '../src/track/edit.ts'
import {createShotCaptureStore} from '../src/client/shot-capture-store.ts'
import type {OpenMontageEditorScope} from '../src/track/shot-project-scope.ts'

const state = vi.hoisted(() => ({
  ready: true,
  points: [] as TrackPlacemark[],
  groups: [] as PlacemarkGroup[],
  routeContext: {segmentStarts: [0, 2], references: []},
  preferences: null as MapSettings | null,
  sceneProps: null as ShotEditorSceneProps | null,
  sceneHandle: null as ShotEditorSceneHandle | null,
  camera: {position: [100, 120, 200], target: [0, 0, 0], fov: 45} as SandboxCameraState,
  stageSize: [640, 360],
  terrainSize: [640, 360],
}))
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: () => ({
  points: state.points, groups: state.groups, loading: !state.ready, editReady: state.ready,
  error: '', stateError: '', routeContext: state.routeContext, retry: vi.fn(),
})}))
vi.mock('../src/client/map-settings.tsx', () => ({
  useMapSettings: () => ({settings: state.preferences}),
  BasemapControls: () => null,
}))
vi.mock('../src/client/ShotEditorScene.tsx', () => ({ShotEditorScene: (props: ShotEditorSceneProps) => {
  state.sceneProps = props
  useEffect(() => {
    props.onReady(state.sceneHandle)
    return () => props.onReady(null)
  }, [props.onReady])
  // Keep the real executable frame evaluator on the controlled preview path.
  useEffect(() => {
    if (props.plan) state.sceneHandle?.renderAt(props.plan, props.time)
  }, [props.plan, props.time])
  return createElement('div', {'data-testid': 'shot-editor-scene'}, createElement('canvas', {className: 'trk-sandbox-canvas', width: state.terrainSize[0], height: state.terrainSize[1]}))
}}))
vi.mock('../src/client/util.ts', async original => ({
  ...await original<typeof import('../src/client/util.ts')>(), api: vi.fn(), download: vi.fn(),
}))

const coordinates: TrackRecord['coordinates'] = [
  [114.17, 27.54, 600, null], [114.18, 27.53, 1100, null],
  [114.19, 27.48, 1600, null], [114.17, 27.45, 1900, null],
]
const track: TrackRecord = {id: 'shot-ui', name: '测试山地轨迹', format: 'kml', filename: 'test.kml',
  createdAt: '2026-10-04', bytes: 80, points: coordinates.length, coordinates, metrics: editedMetrics(coordinates)}
const key = 'cqai-track.shot-editor.' + track.id
const camera: SandboxCameraState = {position: [100, 120, 200], target: [0, 0, 0], fov: 45}
const points: TrackPlacemark[] = [
  {id: 'kml-12', name: '发云界', coordinates: [114.197, 27.523], description: '', images: []},
  {id: 'kml-63', name: '绝望坡', coordinates: [114.193, 27.486], description: '', images: []},
  {id: 'kml-119', name: '金顶', coordinates: [114.173, 27.455], description: '', images: []},
]
let node: HTMLDivElement, root: Root, canvas: HTMLCanvasElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
let recorders: FakeRecorder[], streams: {stop: ReturnType<typeof vi.fn>}[]
let captureDescriptor: PropertyDescriptor | undefined
let createURLDescriptor: PropertyDescriptor | undefined, revokeURLDescriptor: PropertyDescriptor | undefined
let createURL: ReturnType<typeof vi.fn>

class FakeRecorder {
  static isTypeSupported = vi.fn(() => true)
  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  start = vi.fn(() => {this.state = 'recording'})
  stop = vi.fn(() => {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({data: new Blob(['recorded-frames'], {type: this.mimeType})} as BlobEvent)
      this.onstop?.()
    })
  })
  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    this.mimeType = options.mimeType || ''
    recorders.push(this)
  }
}
function makeScene(sceneFingerprint = 'scene-current'): ShotEditorSceneHandle {
  return {
    sceneFingerprint,
    getCameraState: vi.fn(() => structuredClone(state.camera)),
    applyCameraState: vi.fn(value => {state.camera = structuredClone(value)}),
    renderAt: vi.fn((plan, time) => {
      const evaluated = evaluateShotEditorFrame(plan, time)
      if (evaluated.camera) state.camera = evaluated.camera
    }),
    getCaptureCanvas: vi.fn(() => canvas),
    resetView: vi.fn(),
  }
}
function currentPlan(): ShotEditorPlan {
  const plan = parseShotEditorPlan(state.sceneProps?.plan, track.id)
  if (!plan) throw new Error('Expected an executable scene plan')
  return plan
}
function saved(plan: ShotEditorPlan) {
  return {schema: 'cqai-track-shot-editor@1', plan, appearance: {
    lighting: {...DEFAULT_MAP_SETTINGS.lighting}, sandboxColors: {...DEFAULT_MAP_SETTINGS.sandboxColors},
    sandboxBackground: DEFAULT_MAP_SETTINGS.sandboxBackground,
  }}
}
function initialPlan() {
  return createShotEditorPlan({trackId: track.id,
    fingerprint: shotEditorTrackFingerprint(coordinates, state.routeContext.segmentStarts),
    sceneFingerprint: 'scene-current', title: track.name, camera})
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api).mockImplementation(async (path, body) => path.includes('?') ? {project: null} as never : {project: {...(body as {project: object}).project, revision: 'revision-' + vi.mocked(api).mock.calls.length, updatedAt: '2026-10-09'}} as never)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.spyOn(performance, 'now').mockReturnValue(0)
  localStorage.clear()
  localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(DEFAULT_MAP_SETTINGS))
  state.ready = true
  state.points = structuredClone(points)
  state.groups = []
  state.routeContext = {segmentStarts: [0, 2], references: []}
  state.preferences = readMapSettings()
  state.sceneProps = null
  state.camera = structuredClone(camera)
  state.stageSize = [640, 360]; state.terrainSize = [640, 360]
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const [width, height] = this.classList.contains('trk-se-stage') ? state.stageSize : [0, 0]
    return {width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({width, height})} as DOMRect
  })
  canvas = document.createElement('canvas')
  canvas.width = 1280; canvas.height = 720
  state.sceneHandle = makeScene()
  recorders = []; streams = []; frames = new Map(); nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  captureDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'captureStream')
  createURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {configurable: true, value: () => {
    const mediaTrack = {stop: vi.fn()}; streams.push(mediaTrack)
    return {getTracks: () => [mediaTrack], getVideoTracks: () => [mediaTrack]} as unknown as MediaStream
  }})
  createURL = vi.fn(() => 'blob:shot-' + createURL.mock.calls.length)
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: createURL})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: vi.fn()})
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount())
  node.remove()
  for (const [target, name, descriptor] of [
    [HTMLCanvasElement.prototype, 'captureStream', captureDescriptor],
    [URL, 'createObjectURL', createURLDescriptor], [URL, 'revokeObjectURL', revokeURLDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(target, name, descriptor)
    else Reflect.deleteProperty(target, name)
  }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function render(props: Partial<Parameters<typeof ShotEditor>[0]> = {}) {
  await act(async () => root.render(createElement(ShotEditor, {track, basemap: 'none',
    onBasemap: vi.fn(), onCancel: vi.fn(), ...props})))
}
function approval(scope: OpenMontageEditorScope, canProduce = true) {return new Response(JSON.stringify({canProduce, scenePlanDigest: scope.scenePlanDigest, project: {projectId: scope.projectId, trackId: track.id}, shots: [{shotId: scope.shotId, sceneId: scope.sceneId, editor: 'sandbox', scope}]}), {headers: {'content-type': 'application/json'}})}
function button(text: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)
  if (!found) throw new Error('Missing button: ' + text)
  return found
}
async function click(text: string) {await act(async () => button(text).click())}
async function edit(label: string, value: string) {
  await act(async () => {
    const input = node.querySelector<HTMLInputElement>('[aria-label="' + label + '"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}
async function selectLabel(sourceId: string) {
  await act(async () => {
    const select = node.querySelector<HTMLSelectElement>('select[aria-label="添加地名"]')!
    select.value = sourceId; select.dispatchEvent(new Event('change', {bubbles: true}))
  })
}
async function frame(time: number) {
  const callbacks = [...frames.values()]; frames.clear()
  await act(async () => {for (const callback of callbacks) callback(time)})
}
function playback() {return node.querySelector('[aria-label="三维镜头播放状态"]')!.textContent}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {resolve = yes})
  return {promise, resolve}
}
async function importFile(contents: Promise<string>) {
  const file = new File(['pending configuration'], 'shots.json', {type: 'application/json'})
  Object.defineProperty(file, 'text', {value: vi.fn(() => contents)})
  await act(async () => {
    const input = node.querySelector<HTMLInputElement>('input[aria-label="导入镜头 JSON"]')!
    Object.defineProperty(input, 'files', {configurable: true, value: [file]})
    input.dispatchEvent(new Event('change', {bubbles: true}))
  })
}

describe('shot editor executable draft lifecycle', () => {
  it('restores a failed sandbox take and its recording parameters after another shot without reusing a released URL', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    const scope = {projectId: 'project-1', shotId: 'sandbox-a', sceneId: 'SC04', scenePlanDigest: 'confirmed-1'}, captureStore = createShotCaptureStore()
    let savedProject: object | null = null
    vi.mocked(api).mockImplementation(async (action, payload) => {
      if (payload) {savedProject = {...(payload as {project: object}).project, revision: 'captured-v1', updatedAt: '2026-10-09'}; return {project: savedProject} as never}
      return {project: action.includes('shotId=sandbox-a') ? savedProject : null} as never
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(approval(scope)).mockResolvedValueOnce(new Response(JSON.stringify({error: '测试 409：分镜内容已变化'}), {status: 409, headers: {'content-type': 'application/json'}})))
    await render({scope, captureStore}); await edit('镜头总时长', '1'); await click('保存工程'); await click('录制镜头 WebM'); await frame(0); await frame(34); await frame(1000); await act(async () => {vi.advanceTimersByTime(150)})
    await click('回填当前分镜素材')
    const retained = captureStore.get(track.id, scope, 'sandbox')!, originalUrl = node.querySelector('.trk-gm-video a[download]')!.getAttribute('href')
    await render({scope: {...scope, shotId: 'sandbox-b'}, captureStore})
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(originalUrl); expect(node.querySelector('.trk-gm-video')).toBeNull()
    await render({scope, captureStore})
    expect(createURL.mock.calls.at(-1)![0]).toBe(retained.blob); expect(node.querySelector('.trk-gm-video a[download]')!.getAttribute('href')).not.toBe(originalUrl)
    expect(node.textContent).toContain('测试 409：分镜内容已变化'); expect(button('回填当前分镜素材').disabled).toBe(false)
    await click('导出本次录制参数'); expect(JSON.parse(vi.mocked(download).mock.calls.at(-1)![1])).toEqual(retained.saved)
  })
  it('does not adopt a legacy browser draft into a scoped shot and requires saving before recording', async () => {
    localStorage.setItem(key, '{invalid legacy draft'); const original = localStorage.getItem(key)
    const scope = {projectId: 'project-1', shotId: 'shot-1', sceneId: 'SC03', scenePlanDigest: 'confirmed-1'}
    await render({scope})
    expect(currentPlan().duration).toBe(20); expect(node.textContent).not.toContain('旧浏览器草稿无法识别')
    expect(vi.mocked(api).mock.calls[0][0]).toContain('projectId=project-1&shotId=shot-1')
    expect(button('录制镜头 WebM').disabled).toBe(true)
    await edit('镜头总时长', '11'); await click('保存工程')
    const payload = vi.mocked(api).mock.calls.find(([, data]) => data !== undefined)![1] as Record<string, unknown>
    expect(payload).toMatchObject({projectId: 'project-1', shotId: 'shot-1', expectedRevision: null})
    expect(button('录制镜头 WebM').disabled).toBe(false)
    await edit('镜头总时长', '12'); expect(button('录制镜头 WebM').disabled).toBe(true)
    await render({scope: {...scope, shotId: 'shot-2'}})
    expect(currentPlan().duration).toBe(20); expect(localStorage.getItem(key)).toBe(original)
    expect(node.querySelector<HTMLAnchorElement>('.trk-gm-file-tools a')!.href).toContain('shotId=shot-2')
  })
  it('retains the actual recorded sandbox Blob and saved revision for scoped scene backfill', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    const scope = {projectId: 'project-1', shotId: 'sandbox-1', sceneId: 'SC04', scenePlanDigest: 'confirmed-1'}, onShotResult = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => {
      if (String(path).includes('/openmontage-state?')) return approval(scope)
      const query = new URL(String(path), 'http://localhost').searchParams
      return new Response(JSON.stringify({take: {takeId: query.get('takeId'), shotId: scope.shotId, sceneId: scope.sceneId, scenePlanDigest: scope.scenePlanDigest, projectRevision: query.get('projectRevision'), editor: 'sandbox'}}), {headers: {'content-type': 'application/json'}})
    })
    vi.stubGlobal('fetch', fetcher)
    await render({scope, onShotResult}); await edit('镜头总时长', '1'); await click('保存工程')
    const revision = (vi.mocked(api).mock.results.at(-1)!.value as Promise<{project: {revision: string}}>)
    const savedRevision = (await revision).project.revision
    await click('录制镜头 WebM'); await frame(0); await frame(34); await frame(1000); await act(async () => {vi.advanceTimersByTime(150)})
    expect(recorders[0].stop).toHaveBeenCalledTimes(1); expect(streams[0].stop).toHaveBeenCalledTimes(1)
    const blob = createURL.mock.calls[0][0] as Blob; expect(blob.size).toBeGreaterThan(0)
    await click('回填当前分镜素材')
    expect(fetcher.mock.calls[1][1]!.body).toBe(blob); expect(new URL(String(fetcher.mock.calls[1][0]), 'http://localhost').searchParams.get('projectRevision')).toBe(savedRevision)
    expect(onShotResult).toHaveBeenCalledTimes(1); expect(node.querySelector('.trk-gm-video a[download]')).not.toBeNull()
  })
  it.each(['unapproved', 'changed-mapping', 'unreadable'])('preserves a scoped sandbox project without starting recording when approval is %s', async reason => {
    const scope = {projectId: 'project-1', shotId: 'sandbox-1', sceneId: 'SC04', scenePlanDigest: 'confirmed-1'}
    const response = reason === 'unreadable' ? new Response('service unavailable', {status: 503}) : approval(reason === 'changed-mapping' ? {...scope, sceneId: 'SC99'} : scope, reason !== 'unapproved')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response))
    await render({scope}); await click('保存工程'); const original = JSON.stringify(currentPlan())
    await click('录制镜头 WebM'); await frame(0); await frame(34)
    expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0); expect(frames.size).toBe(0)
    expect(JSON.stringify(currentPlan())).toBe(original); expect(node.textContent).toContain('镜头工程已保留')
    expect(button('录制镜头 WebM').disabled).toBe(false)
  })
  it('cancels a pending scoped approval check without starting recording or changing its saved project', async () => {
    const scope = {projectId: 'project-1', shotId: 'sandbox-1', sceneId: 'SC04', scenePlanDigest: 'confirmed-1'}
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    vi.stubGlobal('fetch', fetcher)
    await render({scope}); await click('保存工程'); const original = JSON.stringify(currentPlan())
    await click('录制镜头 WebM'); const signal = fetcher.mock.calls[0][1]!.signal!
    expect(signal.aborted).toBe(false); expect(frames.size).toBe(0)
    await click('取消录制'); expect(signal.aborted).toBe(true)
    expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0); expect(JSON.stringify(currentPlan())).toBe(original)
    expect(button('录制镜头 WebM').disabled).toBe(false)
  })
  it('pauses a failed scene during playback and permits rebuilding with the recovered scene', async () => {
    await render(); await click('播放镜头'); await frame(1000)
    expect(playback()).toContain('正在播放'); expect(frames.size).toBe(1)
    await act(async () => state.sceneProps!.onReady(null))
    expect(playback()).toContain('已暂停'); expect(frames.size).toBe(0)
    expect(button('播放镜头').disabled).toBe(true)
    state.sceneHandle = makeScene('scene-recovered')
    await act(async () => state.sceneProps!.onReady(state.sceneHandle))
    expect(button('重新建立镜头').disabled).toBe(false)
    expect(button('播放镜头').disabled).toBe(true)
    await click('重新建立镜头')
    await click('确认重新建立')
    expect(currentPlan().sceneFingerprint).toBe('scene-recovered')
    expect(button('播放镜头').disabled).toBe(false)
    await click('播放镜头'); await frame(1000)
    expect(playback()).toContain('正在播放')
    expect(state.sceneHandle.renderAt).toHaveBeenCalled()
  })

  it('rejects an import that finishes after recording starts without stopping the active recording', async () => {
    await render()
    const original = currentPlan(), pending = deferred<string>()
    const imported = structuredClone(original)
    imported.caption = {text: '过期导入的字幕', from: 0, to: imported.duration}
    const payload = saved(imported); payload.appearance.lighting.ambient = .1
    await importFile(pending.promise)
    await click('录制镜头 WebM')
    await frame(0); await frame(34)
    expect(recorders).toHaveLength(1); expect(recorders[0].state).toBe('recording')
    expect(state.sceneProps!.locked).toBe(true)
    await act(async () => pending.resolve(JSON.stringify(payload)))
    expect(currentPlan()).toEqual(original)
    expect(state.sceneProps!.settings.lighting.ambient).toBe(DEFAULT_MAP_SETTINGS.lighting.ambient)
    expect(playback()).toContain('正在录制'); expect(frames.size).toBe(1)
    expect(recorders[0].stop).not.toHaveBeenCalled()
    await frame(1000)
    expect(state.sceneProps!.time).toBe(1); expect(frames.size).toBe(1)
    await click('取消录制')
    expect(recorders[0].stop).toHaveBeenCalledTimes(1)
    expect(streams[0].stop).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0); expect(createURL).not.toHaveBeenCalled()
  })

  it('advances the label selector after a manual choice so subsequent additions use remaining places', async () => {
    await render()
    await selectLabel('kml-63'); await click('添加')
    expect(currentPlan().labels.map(item => item.sourceId)).toEqual(['kml-63'])
    const selector = node.querySelector<HTMLSelectElement>('select[aria-label="添加地名"]')!
    expect(selector.value).toBe('kml-12')
    // The old stale selection displayed the next option but silently retried kml-63 here.
    await click('添加')
    expect(currentPlan().labels.map(item => item.sourceId)).toEqual(['kml-63', 'kml-12'])
    await selectLabel('kml-119'); await click('添加')
    expect(currentPlan().labels.map(item => item.name)).toEqual(['绝望坡', '发云界', '金顶'])
    expect(button('添加').disabled).toBe(true)
  })

  it('keeps an incompatible legacy draft and all its keyframes available for backup without replacing the cache', async () => {
    const incompatible = initialPlan()
    incompatible.fingerprint = 'a-different-route-fingerprint'
    incompatible.caption = {text: '保留原草稿', from: 0, to: incompatible.duration}
    const original = JSON.stringify(saved(incompatible), null, 2)
    localStorage.setItem(key, original)
    const preferences = localStorage.getItem(MAP_SETTINGS_KEY)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    await render()
    expect(localStorage.getItem(key)).toBe(original); expect(writes).not.toHaveBeenCalled()
    expect(node.textContent).toContain('原草稿与当前轨迹或三维场景不一致')
    expect(state.sceneProps!.plan).toBe(null)
    expect(button('播放镜头').disabled).toBe(true)
    expect(localStorage.getItem(MAP_SETTINGS_KEY)).toBe(preferences)
    await click('导出镜头 JSON')
    expect(JSON.parse(vi.mocked(download).mock.calls[0][1]).plan).toEqual(incompatible)
    expect(vi.mocked(api).mock.calls.filter(call => call[1])).toHaveLength(0)
    await click('保存工程')
    expect((vi.mocked(api).mock.calls.at(-1)![1] as {project: {plan: ShotEditorPlan}}).project.plan).toEqual(incompatible)
    expect(localStorage.getItem(key)).toBe(original); expect(writes).not.toHaveBeenCalled()
    expect(localStorage.getItem(MAP_SETTINGS_KEY)).toBe(preferences)
  })

  it('restores a compatible camera and caption draft instead of replacing it with defaults', async () => {
    const restored = initialPlan()
    restored.title = '已保存的镜头'
    restored.caption = {text: '已保存的字幕', from: 0, to: 20}
    restored.cameraKeyframes[0].camera = {position: [220, 150, 280], target: [10, 0, 20], fov: 55}
    localStorage.setItem(key, JSON.stringify(saved(restored)))
    await render()
    expect(currentPlan()).toEqual(restored)
    expect(state.camera).toEqual(restored.cameraKeyframes[0].camera)
    expect(node.textContent).toContain('已恢复旧浏览器草稿')
    expect(JSON.parse(localStorage.getItem(key)!).plan.caption.text).toBe('已保存的字幕')
  })

  it('captures a manually adjusted view and restores it after seeking backward on the independent route timeline', async () => {
    const sourceCoordinates = structuredClone(track.coordinates)
    await render(); await edit('当前时间', '5')
    const manual: SandboxCameraState = {position: [160, 120, 200], target: [10, 0, 20], fov: 52}
    state.camera = structuredClone(manual)
    await click('保存当前视角')
    expect(currentPlan().cameraKeyframes.find(item => item.time === 5)?.camera).toEqual(manual)
    await edit('当前时间', '13')
    expect(evaluateShotEditorFrame(currentPlan(), state.sceneProps!.time).routeProgress).toBe(1)
    await edit('当前时间', '2')
    expect(evaluateShotEditorFrame(currentPlan(), state.sceneProps!.time).routeProgress).toBe(0)
    await edit('当前时间', '5')
    expect(state.camera).toEqual(manual)
    expect(evaluateShotEditorFrame(currentPlan(), state.sceneProps!.time).routeProgress).toBeCloseTo(1 / 9)
    expect(track.coordinates).toEqual(sourceCoordinates)
  })
})

describe('shot editor workspace and shared workbench', () => {
  it('switches a narrow properties panel to preview and waits for two stable resized terrain frames before recording', async () => {
    let handle: EditorNavigationHandle | null = null
    await render({onRegister: value => {handle = value}})
    state.stageSize = [360, 202.5]; state.terrainSize = [1, 1]
    await click('属性')
    const project = currentPlan()
    expect(node.querySelector('.trk-shot-editor')?.getAttribute('data-panel')).toBe('properties')
    await click('录制镜头 WebM')
    expect(node.querySelector('.trk-shot-editor')?.getAttribute('data-panel')).toBe('preview')
    expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0)
    expect(playback()).toContain('准备录制'); expect(handle!.busy).toBe(true)
    expect(button('属性').disabled).toBe(true); expect(button('返回轨迹').disabled).toBe(true)
    const navigate = vi.fn(); await act(async () => handle!.requestLeave(navigate))
    expect(navigate).not.toHaveBeenCalled(); expect(node.querySelector('[role="dialog"]')).toBe(null)
    await frame(0)
    expect(recorders).toHaveLength(0)
    // ResizeObserver repairs the display:none renderer after preview becomes visible.
    const terrain = node.querySelector<HTMLCanvasElement>('.trk-sandbox-canvas')!
    terrain.width = 360; terrain.height = 203
    await frame(17)
    expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0)
    await frame(34)
    expect(recorders).toHaveLength(1); expect(streams).toHaveLength(1)
    expect(recorders[0].start).toHaveBeenCalledWith(250)
    expect(playback()).toContain('正在录制'); expect(state.sceneProps!.locked).toBe(true)
    expect(currentPlan()).toEqual(project)
    await click('取消录制')
    expect(frames.size).toBe(0); expect(streams[0].stop).toHaveBeenCalledTimes(1)
    expect(handle!.busy).toBe(false)
  })

  it('cancels preparation without creating a recorder and allows a clean retry', async () => {
    await render(); await click('属性'); await click('录制镜头 WebM')
    await frame(0)
    expect(recorders).toHaveLength(0); expect(frames.size).toBe(1)
    await click('取消录制')
    expect(frames.size).toBe(0); expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0)
    expect(button('属性').disabled).toBe(false)
    await click('录制镜头 WebM'); await frame(0); await frame(34)
    expect(recorders).toHaveLength(1)
    await click('取消录制')
  })

  it('never captures a 1 by 1 terrain canvas and releases the pending frame when its layout cannot settle', async () => {
    await render(); state.terrainSize = [1, 1]
    await click('属性'); await click('录制镜头 WebM')
    await frame(0); await frame(3001)
    expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0); expect(frames.size).toBe(0)
    expect(node.textContent).toContain('三维画布布局尚未就绪，录制未开始')
    expect(button('返回轨迹').disabled).toBe(false)
    expect(button('录制镜头 WebM').disabled).toBe(false)
  })

  it('cleans pending preparation when deactivated or unmounted so a stale animation callback cannot start capture', async () => {
    await render(); await click('录制镜头 WebM')
    const stale = [...frames.values()][0]
    await render({active: false})
    expect(frames.size).toBe(0); expect(recorders).toHaveLength(0)
    await act(async () => stale(34))
    expect(recorders).toHaveLength(0)
    await render({active: true}); await click('录制镜头 WebM')
    const afterUnmount = [...frames.values()][0]
    await act(async () => root.unmount())
    expect(frames.size).toBe(0)
    await act(async () => afterUnmount(34))
    expect(recorders).toHaveLength(0); expect(streams).toHaveLength(0)
    root = createRoot(node)
  })

  it('prefers a saved workspace over legacy storage and explicitly saves the complete plan and appearance', async () => {
    const project = saved(initialPlan()); project.plan.title = '轨迹目录工程'; project.appearance.lighting.ambient = .33
    const legacy = saved(initialPlan()); legacy.plan.title = '旧浏览器工程'
    localStorage.setItem(key, JSON.stringify(legacy))
    const cache = localStorage.getItem(key), writes = vi.spyOn(Storage.prototype, 'setItem')
    vi.mocked(api).mockResolvedValueOnce({project: {...project, revision: 'workspace-v1', updatedAt: '2026-10-09'}} as never)
    await render()
    expect(node.querySelector('h2')?.textContent).toBe('镜头编辑')
    expect(node.textContent).not.toContain('镜头案例')
    expect(currentPlan()).toEqual(project.plan)
    expect(state.sceneProps!.settings.lighting.ambient).toBe(.33)
    expect(button('保存工程').disabled).toBe(true)
    expect(writes).not.toHaveBeenCalled()
    await edit('画面标题', '工作区的新标题'); await edit('太阳亮度', '1.7')
    expect(button('保存工程').disabled).toBe(false)
    expect(vi.mocked(api).mock.calls.filter(call => call[1])).toHaveLength(0)
    await click('保存工程')
    const body = vi.mocked(api).mock.calls.at(-1)![1] as {id: string; project: ReturnType<typeof saved>; expectedRevision: string}
    expect(body.id).toBe(track.id); expect(body.expectedRevision).toBe('workspace-v1')
    expect(body.project.plan.title).toBe('工作区的新标题'); expect(body.project.appearance.lighting.intensity).toBe(1.7)
    expect(body.project.plan.cameraKeyframes).toEqual(project.plan.cameraKeyframes)
    expect(body.project.plan.routeKeyframes).toEqual(project.plan.routeKeyframes)
    expect(button('保存工程').disabled).toBe(true)
    expect(node.querySelector('.trk-gm-save-status')?.textContent).toContain('已保存到轨迹工作区')
    expect(localStorage.getItem(key)).toBe(cache); expect(writes).not.toHaveBeenCalled()
  })

  it('keeps read failures protected and retries without generating or writing a replacement', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('工作区暂时无法读取'))
    await render()
    expect(node.textContent).toContain('工作区暂时无法读取')
    expect(node.querySelector('[data-testid="shot-editor-scene"]')).toBe(null)
    expect(button('保存工程').disabled).toBe(true); expect(button('重新建立镜头').disabled).toBe(true)
    const backup = node.querySelector<HTMLAnchorElement>('a[download="shot-editor-project-original.json"]')
    expect(backup?.textContent).toBe('下载原工程备份')
    expect(backup?.getAttribute('href')).toBe(`/api/cqai-track/shot-project-backup?id=${encodeURIComponent(track.id)}&scene=sandbox`)
    expect(vi.mocked(api).mock.calls.filter(call => call[1])).toHaveLength(0)
    const project = saved(initialPlan()); project.plan.caption.text = '读取恢复原工程'
    vi.mocked(api).mockResolvedValueOnce({project: {...project, revision: 'read-restored', updatedAt: '2026-10-09'}} as never)
    await click('重新读取工程')
    expect(currentPlan()).toEqual(project.plan)
    expect(button('保存工程').disabled).toBe(true)
  })

  it.each([{}, {project: {...saved(initialPlan()), revision: 123, updatedAt: '2026-10-09'}}])('protects malformed workspace read replies instead of treating them as no project: %j', async reply => {
    vi.mocked(api).mockResolvedValueOnce(reply as never)
    await render()
    expect(button('保存工程').disabled).toBe(true)
    expect(button('重新建立镜头').disabled).toBe(true)
    expect(node.querySelector('[data-testid="shot-editor-scene"]')).toBe(null)
    expect(node.textContent).toContain('读取失败')
    expect(vi.mocked(api).mock.calls.filter(call => call[1])).toHaveLength(0)
  })

  it('undoes and redoes appearance together with the native camera snapshot', async () => {
    await render(); await click('保存工程')
    const before = currentPlan(), oldLook = structuredClone(state.sceneProps!.settings.lighting)
    await edit('太阳亮度', '2.5')
    expect(state.sceneProps!.settings.lighting.intensity).toBe(2.5)
    await click('撤销')
    expect(state.sceneProps!.settings.lighting).toEqual(oldLook); expect(currentPlan()).toEqual(before)
    expect(button('保存工程').disabled).toBe(true)
    await click('重做')
    expect(state.sceneProps!.settings.lighting.intensity).toBe(2.5); expect(currentPlan()).toEqual(before)
    expect(button('保存工程').disabled).toBe(false)
  })

  it('keeps route keys and label/caption clips independent when using the common keyboard timeline', async () => {
    const project = saved(initialPlan())
    project.plan.labels = [{id: 'label-1', sourceId: 'kml-12', name: '发云界', coordinates: [114.197, 27.523], from: 2, to: 8}]
    project.plan.caption = {text: '原字幕', from: 3, to: 6}
    vi.mocked(api).mockResolvedValueOnce({project: {...project, revision: 'clip-v1', updatedAt: '2026-10-09'}} as never)
    await render()
    const routeKey = node.querySelector<HTMLButtonElement>('[data-key-lane="route"] [aria-label="路线进度关键帧 4 秒"]')!
    await act(async () => routeKey.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})))
    expect(currentPlan().routeKeyframes.find(item => item.id === 'route-hold')!.time).toBeCloseTo(4 + 1 / 30)
    expect(currentPlan().cameraKeyframes).toEqual(project.plan.cameraKeyframes)
    const label = node.querySelector<HTMLButtonElement>('[aria-label="移动片段：发云界"]')!
    await act(async () => label.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})))
    expect(currentPlan().labels[0].from).toBeCloseTo(2 + 1 / 30); expect(currentPlan().labels[0].to).toBeCloseTo(8 + 1 / 30)
    expect(currentPlan().labels[0].coordinates).toEqual(project.plan.labels[0].coordinates)
    const caption = node.querySelector<HTMLButtonElement>('[aria-label="调整出点：字幕"]')!
    await act(async () => caption.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true})))
    expect(currentPlan().caption).toEqual({text: '原字幕', from: 3, to: 6 - 1 / 30})
    expect(node.querySelector<HTMLInputElement>('[aria-label="显示图层：发云界"]')!.disabled).toBe(true)
    expect(label.disabled).toBe(false)
    await click('撤销')
    expect(currentPlan().caption).toEqual(project.plan.caption)
  })

  it('preserves the model, current time, appearance and history while the inactive scene is unmounted', async () => {
    await render(); await edit('画面标题', '保留编辑'); await edit('太阳亮度', '2.2'); await edit('当前时间', '5')
    const snapshot = currentPlan()
    await click('播放镜头'); await frame(1000)
    const retainedTime = state.sceneProps!.time
    expect(frames.size).toBe(1)
    await render({active: false})
    expect(node.querySelector('[data-testid="shot-editor-scene"]')).toBe(null); expect(frames.size).toBe(0)
    await render({active: true})
    expect(currentPlan()).toEqual(snapshot); expect(state.sceneProps!.time).toBe(retainedTime)
    expect(state.sceneProps!.settings.lighting.intensity).toBe(2.2)
    expect(playback()).toContain('已暂停')
    await click('撤销')
    expect(currentPlan().title).toBe('保留编辑'); expect(state.sceneProps!.settings.lighting.intensity).toBe(DEFAULT_MAP_SETTINGS.lighting.intensity)
  })

  it('waits for delayed save before navigating and preserves the dirty indicator during that save', async () => {
    let handle: EditorNavigationHandle | null = null
    const onRegister = (value: EditorNavigationHandle | null) => {handle = value}
    const destination = vi.fn(), operation = deferred<{project: object}>()
    await render({onRegister})
    const snapshot = saved(currentPlan())
    vi.mocked(api).mockReturnValueOnce(operation.promise as never)
    await act(async () => handle!.requestLeave(destination))
    expect(node.querySelector('[role="dialog"]')).not.toBe(null)
    await click('保存后继续')
    expect(destination).not.toHaveBeenCalled(); expect(handle!.busy).toBe(true)
    expect(node.querySelector('.trk-gm-dirty')).not.toBe(null)
    expect(node.querySelector('.trk-gm-save-status')?.textContent).toContain('正在保存')
    expect(button('放弃本次修改').disabled).toBe(true)
    const otherDestination = vi.fn()
    await act(async () => handle!.requestLeave(otherDestination))
    await act(async () => operation.resolve({project: {...snapshot, revision: 'save-ack', updatedAt: '2026-10-09'}}))
    expect(destination).toHaveBeenCalledTimes(1); expect(otherDestination).not.toHaveBeenCalled()
    expect(node.querySelector('[role="dialog"]')).toBe(null); expect(node.querySelector('.trk-gm-dirty')).toBe(null)
  })

  it('blocks leaving on a revision conflict and keeps the error through scene remounts', async () => {
    const project = saved(initialPlan()), onCancel = vi.fn()
    vi.mocked(api).mockResolvedValueOnce({project: {...project, revision: 'conflict-v1', updatedAt: '2026-10-09'}} as never)
    await render({onCancel}); await edit('画面标题', '本窗口修改')
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('conflict'), {status: 409}))
    await click('返回轨迹'); await click('保存后继续')
    expect(onCancel).not.toHaveBeenCalled(); expect(node.querySelector('[role="dialog"]')).not.toBe(null)
    expect(node.textContent).toContain('工程已被其他窗口更新')
    expect(currentPlan().title).toBe('本窗口修改')
    await click('取消')
    await render({active: false, onCancel}); await render({active: true, onCancel})
    expect(node.textContent).toContain('工程已被其他窗口更新')
    await act(async () => state.sceneProps!.onError('场景渲染暂时失败'))
    expect(node.textContent).toContain('场景渲染暂时失败')
    expect(node.textContent).toContain('工程已被其他窗口更新')
    await act(async () => state.sceneProps!.onReady(state.sceneHandle))
    expect(node.textContent).not.toContain('场景渲染暂时失败')
    expect(node.textContent).toContain('工程已被其他窗口更新')
    await click('返回轨迹'); await click('放弃本次修改')
    expect(onCancel).toHaveBeenCalledTimes(1); expect(currentPlan()).toEqual(project.plan)
  })

  it.each(['new', 'legacy'])('discarding a %s draft keeps its original editable snapshot on return', async origin => {
    const source = saved(initialPlan()); source.plan.title = '原编辑起点'; source.appearance.lighting.ambient = .45
    if (origin === 'legacy') localStorage.setItem(key, JSON.stringify(source))
    const onCancel = vi.fn()
    await render({onCancel})
    const initial = currentPlan(), initialLook = structuredClone(state.sceneProps!.settings.lighting)
    await edit('画面标题', '离开前修改'); await edit('太阳亮度', '2.9')
    await click('返回轨迹'); await click('放弃本次修改')
    expect(onCancel).toHaveBeenCalledTimes(1); expect(currentPlan()).toEqual(initial)
    expect(state.sceneProps!.settings.lighting).toEqual(initialLook)
    await render({active: false}); await render({active: true})
    expect(currentPlan()).toEqual(initial); expect(node.querySelector('.trk-gm-dirty')).toBe(null)
    expect(button('保存工程').disabled).toBe(false)
    await click('保存工程')
    const savedBody = vi.mocked(api).mock.calls.at(-1)![1] as {project: ReturnType<typeof saved>; expectedRevision: string | null}
    expect(savedBody.project.plan).toEqual(initial); expect(savedBody.project.appearance.lighting).toEqual(initialLook)
    expect(savedBody.expectedRevision).toBe(null); expect(button('保存工程').disabled).toBe(true)
    await edit('画面标题', '回到编辑继续')
    expect(button('保存工程').disabled).toBe(false)
  })

  it('requires a rebuild confirmation and can undo back to every original keyframe without a write', async () => {
    const source = saved(initialPlan()); source.plan.fingerprint = 'previous-route'; source.plan.caption.text = '旧字幕保留'
    localStorage.setItem(key, JSON.stringify(source))
    await render()
    const trigger = button('重新建立镜头'); trigger.focus()
    await click('重新建立镜头')
    expect(node.querySelector('[role="dialog"]')?.textContent).toContain('这会替换当前镜头与关键帧')
    expect(vi.mocked(api).mock.calls.filter(call => call[1])).toHaveLength(0)
    await click('取消')
    expect(document.activeElement).toBe(trigger)
    await click('导出镜头 JSON')
    expect(JSON.parse(vi.mocked(download).mock.calls.at(-1)![1]).plan).toEqual(source.plan)
    await click('重新建立镜头'); await click('确认重新建立')
    expect(currentPlan().fingerprint).not.toBe('previous-route')
    await click('撤销'); await click('导出镜头 JSON')
    expect(JSON.parse(vi.mocked(download).mock.calls.at(-1)![1]).plan).toEqual(source.plan)
    expect(state.sceneProps!.plan).toBe(null)
    expect(vi.mocked(api).mock.calls.filter(call => call[1])).toHaveLength(0)
  })

  it('supports scoped shortcuts without hijacking text undo or focused button activation', async () => {
    await render()
    const workbench = node.querySelector<HTMLElement>('.trk-shot-editor')!
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true, cancelable: true})))
    expect(button('保存工程').disabled).toBe(true)
    await edit('画面标题', '快捷键修改')
    const title = node.querySelector<HTMLInputElement>('[aria-label="画面标题"]')!
    await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true, cancelable: true})))
    expect(currentPlan().title).toBe('快捷键修改')
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true, cancelable: true})))
    expect(currentPlan().title).toBe(track.name)
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true})))
    expect(currentPlan().title).toBe('快捷键修改')
    await edit('当前时间', '5')
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', bubbles: true, cancelable: true})))
    expect(currentPlan().cameraKeyframes.some(key => key.time === 5)).toBe(true)
    await act(async () => button('保存工程').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', bubbles: true, cancelable: true})))
    expect(playback()).toContain('已暂停')
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', code: 'Space', bubbles: true, cancelable: true})))
    expect(playback()).toContain('正在播放')
  })

  it('cancels a pending file read when explicit saving begins instead of applying an unsaved late import', async () => {
    await render()
    const original = currentPlan(), contents = deferred<string>(), imported = saved(structuredClone(original))
    imported.plan.title = '保存后晚到的导入'
    await importFile(contents.promise); await click('保存工程')
    await act(async () => contents.resolve(JSON.stringify(imported)))
    expect(currentPlan()).toEqual(original)
    expect(button('保存工程').disabled).toBe(true)
    expect(node.textContent).not.toContain('已导入镜头配置')
  })

  it('does not mark a changed or unversioned save acknowledgement clean', async () => {
    await render()
    const original = currentPlan()
    const wrong = saved(structuredClone(original)); wrong.plan.title = '服务端确认了其他工程'
    vi.mocked(api).mockResolvedValueOnce({project: {...wrong, revision: 'wrong-ack', updatedAt: '2026-10-09'}} as never)
    await click('保存工程')
    expect(currentPlan()).toEqual(original); expect(node.textContent).toContain('服务端未确认')
    expect(button('保存工程').disabled).toBe(false); expect(node.querySelector('.trk-gm-dirty')).not.toBe(null)
    vi.mocked(api).mockResolvedValueOnce({project: saved(original)} as never)
    await click('保存工程')
    expect(button('保存工程').disabled).toBe(false)
    await click('保存工程')
    expect(button('保存工程').disabled).toBe(true)
  })

  it('guards re-reading after a conflict and restores the latest saved workspace only after explicit discard', async () => {
    const source = saved(initialPlan())
    vi.mocked(api).mockResolvedValueOnce({project: {...source, revision: 'old-v1', updatedAt: '2026-10-09'}} as never)
    await render(); await edit('画面标题', '本地未保存')
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('conflict'), {status: 409}))
    await click('保存工程'); await click('重新读取已保存工程')
    expect(node.querySelector('[role="dialog"]')).not.toBe(null); expect(currentPlan().title).toBe('本地未保存')
    await click('取消')
    expect(currentPlan().title).toBe('本地未保存')
    const newer = saved(initialPlan()); newer.plan.title = '其他窗口的新版本'
    vi.mocked(api).mockResolvedValueOnce({project: {...newer, revision: 'new-v2', updatedAt: '2026-10-09'}} as never)
    await click('重新读取已保存工程'); await click('放弃本次修改')
    expect(currentPlan()).toEqual(newer.plan); expect(node.querySelector('.trk-gm-dirty')).toBe(null)
    expect(node.textContent).not.toContain('工程已被其他窗口更新')
  })
})
