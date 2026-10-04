// @vitest-environment jsdom
import {act, createElement, useEffect} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ShotEditor} from '../src/client/ShotEditor.tsx'
import type {ShotEditorSceneHandle, ShotEditorSceneProps} from '../src/client/ShotEditorScene.tsx'
import {createShotEditorPlan, evaluateShotEditorFrame, parseShotEditorPlan, shotEditorTrackFingerprint, type ShotEditorPlan} from '../src/track/shot-editor.ts'
import {DEFAULT_MAP_SETTINGS, MAP_SETTINGS_KEY, readMapSettings, type MapSettings} from '../src/track/map-settings.ts'
import type {SandboxCameraState} from '../src/track/sandbox/types.ts'
import type {PlacemarkGroup, TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import {editedMetrics} from '../src/track/edit.ts'

const state = vi.hoisted(() => ({
  ready: true,
  points: [] as TrackPlacemark[],
  groups: [] as PlacemarkGroup[],
  routeContext: {segmentStarts: [0, 2], references: []},
  preferences: null as MapSettings | null,
  sceneProps: null as ShotEditorSceneProps | null,
  sceneHandle: null as ShotEditorSceneHandle | null,
  camera: {position: [100, 120, 200], target: [0, 0, 0], fov: 45} as SandboxCameraState,
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
  return createElement('div', {'data-testid': 'shot-editor-scene'})
}}))
vi.mock('../src/client/util.ts', async original => ({
  ...await original<typeof import('../src/client/util.ts')>(), download: vi.fn(),
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
async function render() {
  await act(async () => root.render(createElement(ShotEditor, {track, basemap: 'none',
    onBasemap: vi.fn(), onCancel: vi.fn(), onCases: vi.fn()})))
}
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
function playback() {return node.querySelector('[aria-label="镜头播放状态"]')!.textContent}
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

  it('preserves an incompatible cached draft byte for byte until the user explicitly saves', async () => {
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
    expect(currentPlan().fingerprint).toBe(shotEditorTrackFingerprint(coordinates, [0, 2]))
    expect(currentPlan().caption.text).toBe('')
    expect(localStorage.getItem(MAP_SETTINGS_KEY)).toBe(preferences)
    await click('保存草稿')
    const written = JSON.parse(localStorage.getItem(key)!).plan
    expect(parseShotEditorPlan(written, track.id)?.fingerprint).toBe(currentPlan().fingerprint)
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
    expect(node.textContent).toContain('已恢复此浏览器的镜头草稿')
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
