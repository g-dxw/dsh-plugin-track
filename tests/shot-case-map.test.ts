// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShotCaseMap, type ShotCaseMapProps } from '../src/client/ShotCaseMap.tsx'
import { buildShotCasePlan, sampleShotCase, type ShotCaseId, type ShotCaseParameters } from '../src/track/shot-cases.ts'
import { editedMetrics } from '../src/track/edit.ts'
import type { TrackPoint, TrackPlacemark, TrackRecord } from '../src/protocol.ts'
import { BLANK_STYLE, MAPTILER_LOGO_URL, SATELLITE_STYLE } from '../src/track/basemaps.ts'
import { DEFAULT_MAP_SETTINGS, MAP_SETTINGS_KEY } from '../src/track/map-settings.ts'

type FakeSource = {data: GeoJSON.FeatureCollection; pending: boolean; loaded: () => boolean; setData: ReturnType<typeof vi.fn>}
type Gesture = {enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>}
type FakeMap = {
  canvas: HTMLCanvasElement; sources: Map<string, FakeSource>; layers: Map<string, unknown>; handlers: Map<string, ((event?: unknown) => void)[]>
  options: Record<string, unknown>; camera: {center: [number, number]; zoom: number; bearing: number; pitch: number}
  gestures: Gesture[]; emit: (name: string, event?: unknown) => void; setStyle: ReturnType<typeof vi.fn>; jumpTo: ReturnType<typeof vi.fn>
  cameraForBounds: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; project: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>
}
const state = vi.hoisted(() => ({maps: [] as FakeMap[], noWebGL: false, workersPending: false, tilesPending: false, stylePending: false}))
vi.mock('maplibre-gl', () => ({
  Map: class {
    canvas = document.createElement('canvas')
    sources = new Map<string, FakeSource>(); layers = new Map<string, unknown>(); handlers = new Map<string, ((event?: unknown) => void)[]>()
    options: Record<string, unknown>; camera = {center: [0, 0] as [number, number], zoom: 10, bearing: 0, pitch: 0}
    dragPan = {enable: vi.fn(), disable: vi.fn()}; scrollZoom = {enable: vi.fn(), disable: vi.fn()}
    boxZoom = {enable: vi.fn(), disable: vi.fn()}; doubleClickZoom = {enable: vi.fn(), disable: vi.fn()}
    keyboard = {enable: vi.fn(), disable: vi.fn()}; touchPitch = {enable: vi.fn(), disable: vi.fn()}
    touchZoomRotate = {enable: vi.fn(), disable: vi.fn(), disableRotation: vi.fn()}
    gestures = [this.dragPan, this.scrollZoom, this.boxZoom, this.doubleClickZoom, this.keyboard, this.touchZoomRotate, this.touchPitch]
    style = {_loaded: true}; blank = true
    addControl = vi.fn(); resize = vi.fn()
    getCanvas = () => this.canvas
    getCenter = () => ({lng: this.camera.center[0], lat: this.camera.center[1]})
    getZoom = () => this.camera.zoom
    getBearing = () => this.camera.bearing
    getPitch = () => this.camera.pitch
    cameraForBounds = vi.fn(() => ({zoom: 10}))
    project = vi.fn((coordinate: [number, number]) => ({x: 320 + (coordinate[0] - this.camera.center[0]) * 100, y: 240 - (coordinate[1] - this.camera.center[1]) * 100}))
    jumpTo = vi.fn((camera: FakeMap['camera']) => {this.camera = {...camera, center: [...camera.center]}; this.emit('render')})
    triggerRepaint = vi.fn(() => this.emit('render'))
    areTilesLoaded = () => this.blank || !state.tilesPending
    isSourceLoaded = (id: string) => this.sources.get(id)?.loaded() ?? false
    getSource = (id: string) => this.sources.get(id)
    getLayer = (id: string) => this.layers.get(id)
    addSource = (id: string, value: {data: GeoJSON.FeatureCollection}) => {
      const source: FakeSource = {
        data: value.data, pending: false, loaded: () => !source.pending && !state.workersPending,
        setData: vi.fn((data: GeoJSON.FeatureCollection) => {
          source.data = data; source.pending = true
          queueMicrotask(() => {source.pending = false; this.emit('render')})
        }),
      }
      this.sources.set(id, source)
    }
    addLayer = (layer: {id: string}) => this.layers.set(layer.id, layer)
    remove = vi.fn(() => this.canvas.remove())
    setStyle = vi.fn((value: unknown) => {
      this.sources.clear(); this.layers.clear()
      this.blank = typeof value === 'object' && value !== null && Object.keys((value as {sources?: object}).sources || {}).length === 0
      this.style._loaded = this.blank || !state.stylePending
      queueMicrotask(() => {this.emit('styledata'); this.emit('render')})
    })
    on(name: string, handler: (event?: unknown) => void) {this.handlers.set(name, [...(this.handlers.get(name) || []), handler])}
    off(name: string, handler: (event?: unknown) => void) {this.handlers.set(name, (this.handlers.get(name) || []).filter(current => current !== handler))}
    emit(name: string, event?: unknown) {for (const handler of this.handlers.get(name) || []) handler(event)}
    constructor(options: Record<string, unknown> & {container: HTMLElement}) {
      if (state.noWebGL) throw new Error('No WebGL')
      this.options = options; this.canvas.width = 640; this.canvas.height = 480
      options.container.appendChild(this.canvas); state.maps.push(this)
    }
  },
  AttributionControl: class {},
}))

const POINTS: TrackPoint[] = [[101, 31, 3000, 0], [101.01, 31, 3020, 60_000], [101.02, 31.01, 3060, 120_000], [101.04, 31.03, 3040, 180_000]]
const PARAMETERS: ShotCaseParameters = {duration: 10, detailZoom: 3, pitch: 35, bearing: 20, pointIndex: 0, startIndex: 0, endIndex: 2, caption: '这是一段人工示例文案'}
function track(points = POINTS, override: Partial<TrackRecord> = {}): TrackRecord {
  return {id: 'case-map', name: '合成案例路线', filename: 'case.kml', format: 'kml', createdAt: '2026-10-02T00:00:00Z', bytes: 100,
    coordinates: structuredClone(points), points: points.length, metrics: editedMetrics(points), ...override}
}
function plan(id: ShotCaseId = 'zoom-in', changes: Partial<ShotCaseParameters> = {}, source = track(), placemarks?: TrackPlacemark[]) {
  return buildShotCasePlan(source, id, {...PARAMETERS, ...changes}, placemarks)
}
class FakeImage {
  onload: (() => void) | null = null; onerror: (() => void) | null = null
  crossOrigin = ''; src = ''; naturalWidth = 67; naturalHeight = 20
  constructor() {images.push(this)}
}
let images: FakeImage[], root: Root | null, container: HTMLDivElement, props: ShotCaseMapProps
let context: {drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn>; measureText: (text: string) => {width: number}}
let observers: {callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>}[]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state.maps = []; state.noWebGL = false; state.workersPending = false; state.tilesPending = false; state.stylePending = false
  localStorage.clear(); images = []; observers = []
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn()
    constructor(public callback: () => void) {observers.push(this)}
  })
  context = {drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: text => ({width: text.length * 7})}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  props = {plan: plan(), progress: 0, basemap: 'none', onBasemap: vi.fn(), onCanvas: vi.fn(), onUnavailable: vi.fn(), onCaptureError: vi.fn(), onCaptureFrame: vi.fn()}
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null; container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function render(next: Partial<ShotCaseMapProps> = {}) {
  props = {...props, ...next}
  await act(async () => root!.render(createElement(ShotCaseMap, props)))
}
async function emit(event: string, value?: unknown) {await act(async () => state.maps.at(-1)!.emit(event, value))}
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  if (!button) throw new Error('Missing button: ' + text)
  await act(async () => button.click())
}
function geometry(id: string): GeoJSON.Geometry | undefined {return state.maps.at(-1)!.sources.get('cqai-shot-case-' + id)?.data.features[0]?.geometry}
function labels() {return context.fillText.mock.calls.map(call => call[0]).join(' ')}
function capture() {return (props.onCanvas as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as HTMLCanvasElement | null}

describe('independent case map camera and route frames', () => {
  it('moves through real intermediate camera values while leaving route progress paused for a push', async () => {
    const original = JSON.stringify(props.plan)
    await render()
    const first = {...state.maps[0].camera}
    const walked = JSON.stringify(geometry('walked'))
    await render({progress: .6})
    const middle = {...state.maps[0].camera}
    await render({progress: 1})
    const last = {...state.maps[0].camera}
    expect(first.zoom).toBe(10); expect(middle.zoom).toBeCloseTo(11.5); expect(last.zoom).toBe(13)
    expect(middle.center).not.toEqual(first.center); expect(middle.center).not.toEqual(last.center)
    expect(JSON.stringify(geometry('walked'))).toBe(walked)
    expect(JSON.stringify(props.plan)).toBe(original)
    expect(state.maps[0].options).toMatchObject({canvasContextAttributes: {preserveDrawingBuffer: true}, maxPitch: 75})
    expect(labels()).toContain('镜头案例'); expect(labels()).toContain('示例文案'); expect(labels()).not.toContain('已采用脚本')
    expect(container.textContent).toContain('不代表真实 3D 山体')
  })
  it('keeps segmented lines separate and advances the route with a fixed overview camera', async () => {
    const segmented = track([...POINTS, [102, 32, 3200, null], [102.01, 32.01, 3220, null]], {segmentStarts: [4]})
    const fullPlan = plan('route-draw', {}, segmented)
    await render({plan: fullPlan})
    expect(geometry('full')?.type).toBe('MultiLineString')
    expect((geometry('full') as GeoJSON.MultiLineString).coordinates).toEqual(fullPlan.fullLines)
    const firstCamera = {...state.maps[0].camera}
    await render({progress: .5})
    const intermediate = geometry('walked') as GeoJSON.MultiLineString
    expect(intermediate.coordinates).not.toEqual(fullPlan.fullLines)
    expect(state.maps[0].camera).toEqual(firstCamera)
    await render({progress: 1})
    expect((geometry('walked') as GeoJSON.MultiLineString).coordinates).toEqual(fullPlan.fullLines)
  })
  it('filters singleton segments from line geometry while retaining their real marker position', async () => {
    const singleton = track([POINTS[0], POINTS[1], [102, 32, 3200, null]], {segmentStarts: [2]})
    await render({plan: plan('route-draw', {}, singleton), progress: 1})
    expect((geometry('full') as GeoJSON.MultiLineString).coordinates).toHaveLength(1)
    expect((geometry('position') as GeoJSON.Point).coordinates).toEqual([102, 32])
  })
  it('shows independent point coordinates and burns its Chinese label into the captured frame', async () => {
    const marker: TrackPlacemark = {id: 'separate-peak', name: '已记录山峰', coordinates: [101.08, 31.05], description: '', images: []}
    const pointPlan = plan('point-hold', {placemarkId: marker.id}, track(), [marker])
    await render({plan: pointPlan, progress: .5})
    expect((geometry('target') as GeoJSON.Point).coordinates).toEqual(marker.coordinates)
    expect(labels()).toContain(marker.name)
    expect(state.maps[0].project).toHaveBeenLastCalledWith(marker.coordinates)
    expect(geometry('position')).toBeUndefined()
  })
  it('projects a dateline target in the same world as the continuous camera longitude', async () => {
    const dateline = track([[179, 10, 100, null], [-179, 10.1, 120, null]])
    const marker: TrackPlacemark = {id: 'across-date', name: '独立点', coordinates: [-178, 10.2], description: '', images: []}
    const targetPlan = plan('point-hold', {placemarkId: marker.id}, dateline, [marker])
    await render({plan: targetPlan})
    expect(state.maps[0].camera.center[0]).toBe(182)
    expect((geometry('target') as GeoJSON.Point).coordinates).toEqual([182, 10.2])
    expect(state.maps[0].project).toHaveBeenLastCalledWith([182, 10.2])
  })
})

describe('camera data and geographic labels', () => {
  it('does not resubmit unchanged GeoJSON during push, pull, hold or section-camera motion', async () => {
    for (const id of ['zoom-in', 'zoom-out', 'point-hold', 'section-to-route'] as const) {
      await render({plan: plan(id), progress: 0})
      const sources = [...state.maps[0].sources.values()]
      const counts = sources.map(source => source.setData.mock.calls.length)
      for (const progress of [.3, .5, .7, 1]) await render({progress})
      expect(sources.map(source => source.setData.mock.calls.length)).toEqual(counts)
      expect(props.onCaptureFrame).toHaveBeenCalledWith(.5)
    }
  })
  it('uses fitted overview center and smoothly removes padding offset toward the detail target, even with zero zoom change', async () => {
    await render()
    const map = state.maps[0], overview = props.plan.overviewCenter
    const fitted: [number, number] = [overview[0] + .03, overview[1] + .02]
    map.cameraForBounds.mockReturnValue({zoom: 10, center: {lng: fitted[0], lat: fitted[1]}})
    await render({plan: plan('zoom-in', {detailZoom: 0}), progress: 0})
    expect(map.camera.center).toEqual(fitted)
    await render({progress: .6})
    expect(map.camera.center[0]).toBeCloseTo((fitted[0] + props.plan.selectedCamera![0]) / 2)
    expect(map.camera.center[1]).toBeCloseTo((fitted[1] + props.plan.selectedCamera![1]) / 2)
    await render({progress: 1})
    expect(map.camera.center).toEqual(props.plan.selectedCamera)
    expect(map.cameraForBounds).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({bearing: PARAMETERS.bearing}))
  })
  it('does not draw an offscreen target as a misleading edge label', async () => {
    const marker: TrackPlacemark = {id: 'offscreen', name: '屏外目标名称', coordinates: [101.08, 31.05], description: '', images: []}
    await render({plan: plan('point-hold', {placemarkId: marker.id}, track(), [marker])})
    const map = state.maps[0]
    for (const projected of [{x: -2000, y: 240}, {x: 320, y: 600}, {x: NaN, y: 240}]) {
      map.project.mockReturnValue(projected); context.fillText.mockClear()
      await render({captureRequest: (props.captureRequest || 0) + 1})
      expect(context.fillText.mock.calls.some(call => call[0] === marker.name)).toBe(false)
      expect(labels()).toContain('示例文案')
    }
  })
})

describe('paint acknowledgements and capture lifecycle', () => {
  it('acknowledges actual intermediate paint while provider tiles are pending, but keeps final frame protected', async () => {
    await render({basemap: 'vector'})
    const callback = props.onCaptureFrame as ReturnType<typeof vi.fn>
    callback.mockClear(); state.tilesPending = true
    await render({progress: .5})
    expect(callback).toHaveBeenCalledWith(.5)
    callback.mockClear()
    await render({progress: 1})
    expect(callback).not.toHaveBeenCalledWith(1)
    state.tilesPending = false
    await emit('render')
    expect(callback).toHaveBeenLastCalledWith(1)
  })
  it('captures completed intermediate frames and coalesces newer progress without starving route workers', async () => {
    await render({plan: plan('route-draw')})
    const map = state.maps[0], source = map.sources.get('cqai-shot-case-walked')!
    const callback = props.onCaptureFrame as ReturnType<typeof vi.fn>
    callback.mockClear(); state.workersPending = true
    const before = source.setData.mock.calls.length
    await render({progress: .3})
    await render({progress: .4}); await render({progress: .6}); await render({progress: .8})
    expect(source.setData.mock.calls.length).toBe(before + 1)
    expect(callback).not.toHaveBeenCalled()
    state.workersPending = false
    await emit('render')
    expect(callback).toHaveBeenCalledWith(.3)
    expect(callback).toHaveBeenCalledWith(.8)
    expect(source.setData.mock.calls.length).toBe(before + 2)
    await render({progress: 1})
    expect(callback).toHaveBeenLastCalledWith(1)
    expect((geometry('walked') as GeoJSON.MultiLineString).coordinates).toEqual(props.plan.fullLines)
    const burnedProgress = context.fillText.mock.calls.map(call => call[0])
    expect(burnedProgress).toContain('30%'); expect(burnedProgress).toContain('80%'); expect(burnedProgress).toContain('100%')
  })
  it('uses the burned credits once the composite is visible and restores DOM credits on capture failure', async () => {
    await render({basemap: 'satellite'})
    expect(container.querySelector('.trk-shot-case-credits')).toBeNull()
    expect(labels()).toContain('Esri')
    context.drawImage.mockImplementationOnce(() => {throw new DOMException('Tainted', 'SecurityError')})
    await render({captureRequest: 1})
    expect(container.querySelector('.trk-shot-case-credits')).not.toBeNull()
  })
  it('does not acknowledge worker-pending or mismatched endpoints, or endpoints awaiting tiles', async () => {
    await render({basemap: 'vector'})
    const callback = props.onCaptureFrame as ReturnType<typeof vi.fn>
    callback.mockClear(); state.workersPending = true
    await render({progress: 1})
    await emit('render')
    expect(callback).not.toHaveBeenCalled()
    state.workersPending = false
    const map = state.maps[0], camera = {...map.camera}
    map.camera = {...camera, zoom: camera.zoom + 1}
    await emit('render')
    expect(callback).not.toHaveBeenCalled()
    map.camera = camera; state.tilesPending = true
    await emit('render')
    expect(callback).not.toHaveBeenCalled()
    state.tilesPending = false
    await emit('render')
    expect(callback).toHaveBeenLastCalledWith(1)
    expect(callback.mock.calls.every(call => call[0] === 1)).toBe(true)
  })
  it('repaints and confirms an unchanged zero progress through captureRequest', async () => {
    await render()
    const callback = props.onCaptureFrame as ReturnType<typeof vi.fn>
    callback.mockClear()
    await render({captureRequest: 1})
    expect(callback).toHaveBeenCalledWith(0)
    expect(capture()?.width).toBe(640)
    expect(context.drawImage).toHaveBeenLastCalledWith(state.maps[0].canvas, 0, 0, 640, 480)
  })
  it('avoids an endless GeoJSON update cycle on repeated styledata and render events', async () => {
    await render()
    const source = state.maps[0].sources.get('cqai-shot-case-walked')!
    const updates = source.setData.mock.calls.length
    await emit('styledata'); await emit('render')
    expect(source.setData.mock.calls.length).toBe(updates)
  })
  it('resizes both the map and captured canvas and disposes observers and callbacks', async () => {
    await render()
    const map = state.maps[0], observer = observers[0]
    map.canvas.width = 1280; map.canvas.height = 720
    await act(async () => observer.callback())
    expect(map.resize).toHaveBeenCalledOnce()
    expect(capture()?.width).toBe(1280); expect(capture()?.height).toBe(720)
    await act(async () => root!.unmount()); root = null
    expect(observer.disconnect).toHaveBeenCalledOnce(); expect(map.remove).toHaveBeenCalledOnce()
    expect(capture()).toBeNull()
    expect([...map.handlers.values()].every(handlers => handlers.length === 0)).toBe(true)
    const calls = (props.onCaptureFrame as ReturnType<typeof vi.fn>).mock.calls.length
    map.emit('render'); observer.callback(); window.dispatchEvent(new Event('resize'))
    expect((props.onCaptureFrame as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    expect(map.resize).toHaveBeenCalledOnce()
  })
  it('locks every gesture and provider configuration while disabled, then releases them', async () => {
    await render()
    const original = state.maps[0]
    await render({disabled: true, basemap: 'satellite'})
    expect(state.maps).toHaveLength(1); expect(original.setStyle).toHaveBeenLastCalledWith(BLANK_STYLE)
    for (const gesture of original.gestures) expect(gesture.disable).toHaveBeenCalled()
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => ['卫星', '无底图'].includes(button.textContent || '')).every(button => button.disabled)).toBe(true)
    await render({disabled: false})
    expect(original.remove).toHaveBeenCalledOnce()
    expect(state.maps.at(-1)!.setStyle).toHaveBeenLastCalledWith(SATELLITE_STYLE)
    for (const gesture of state.maps.at(-1)!.gestures) expect(gesture.enable).toHaveBeenCalled()
  })
})

describe('failures, pure-color fallback and provider attribution', () => {
  it('falls back on basemap errors and captures only the actual blank-map attribution', async () => {
    await render({basemap: 'satellite'})
    expect(labels()).toContain('Esri'); expect(labels()).not.toContain('OpenStreetMap')
    context.fillText.mockClear()
    await emit('error', {sourceId: 'esri-world-imagery'})
    expect(state.maps[0].setStyle).toHaveBeenLastCalledWith(BLANK_STYLE)
    expect(geometry('full')?.type).toBe('MultiLineString')
    expect(labels()).toContain('无底图'); expect(labels()).not.toMatch(/Esri|OpenStreetMap|MapTiler/u)
    expect(container.textContent).toContain('仍可播放与录制')
    expect(capture()).not.toBeNull(); expect(props.onUnavailable).toHaveBeenLastCalledWith(null)
  })
  it('falls back to pure color when a provider stalls without an error event', async () => {
    vi.useFakeTimers(); state.stylePending = true
    await render({basemap: 'satellite'})
    expect(capture()).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(15_001))
    expect(state.maps[0].setStyle).toHaveBeenLastCalledWith(BLANK_STYLE)
    expect(capture()).not.toBeNull()
  })
  it('handles WebGL initialization failure and permits recovery', async () => {
    state.noWebGL = true
    await render()
    expect(props.onUnavailable).toHaveBeenLastCalledWith(expect.stringContaining('WebGL'))
    expect(capture()).toBeNull()
    state.noWebGL = false
    await click('重试地图')
    expect(props.onUnavailable).toHaveBeenLastCalledWith(null); expect(capture()).not.toBeNull()
  })
  it('disposes a lost graphics context and recovers with a fresh map', async () => {
    await render()
    const original = state.maps[0], event = new Event('webglcontextlost', {cancelable: true})
    await act(async () => original.canvas.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(original.remove).toHaveBeenCalledOnce(); expect(observers[0].disconnect).toHaveBeenCalledOnce()
    expect(capture()).toBeNull(); expect(props.onUnavailable).toHaveBeenLastCalledWith(expect.stringContaining('上下文'))
    await click('重试地图')
    expect(state.maps).toHaveLength(2); expect(capture()).not.toBeNull()
  })
  it('invalidates capture on a tainted canvas and recovers without changing the old recording module', async () => {
    await render()
    context.drawImage.mockImplementationOnce(() => {throw new DOMException('Tainted', 'SecurityError')})
    await render({captureRequest: 1})
    expect(capture()).toBeNull(); expect(props.onCaptureError).toHaveBeenLastCalledWith(expect.stringContaining('跨域'))
    await click('重试地图')
    expect(capture()).not.toBeNull(); expect(props.onCaptureError).toHaveBeenLastCalledWith(null)
  })
  it('leaves the native map playable when 2D capture is unavailable and allows retry', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null)
    await render()
    expect(capture()).toBeNull(); expect(props.onCaptureError).toHaveBeenLastCalledWith(expect.stringContaining('视频画面'))
    expect(state.maps[0].jumpTo).toHaveBeenCalled(); expect(props.onUnavailable).toHaveBeenLastCalledWith(null)
    await click('重试地图')
    expect(capture()).not.toBeNull()
  })
  it('does not mask a route-source error as a provider failure', async () => {
    await render()
    const styles = state.maps[0].setStyle.mock.calls.length
    await emit('error', {sourceId: 'cqai-shot-case-walked'})
    expect(capture()).toBeNull(); expect(props.onCaptureError).toHaveBeenLastCalledWith(expect.stringContaining('路线数据'))
    expect(state.maps[0].setStyle.mock.calls.length).toBe(styles)
    await click('重试地图'); expect(capture()).not.toBeNull()
  })
  it('waits for the MapTiler logo and burns its required mark and credits into the canvas', async () => {
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify({...DEFAULT_MAP_SETTINGS, maptilerKey: 'fake-test-key'}))
    await render({basemap: 'maptiler-satellite'})
    expect(images).toHaveLength(1); expect(images[0].src).toBe(MAPTILER_LOGO_URL); expect(images[0].crossOrigin).toBe('anonymous')
    expect(capture()).toBeNull(); expect(props.onCaptureFrame).not.toHaveBeenCalled()
    await act(async () => images[0].onload?.())
    expect(capture()).not.toBeNull(); expect(labels()).toContain('MapTiler'); expect(labels()).toContain('OpenStreetMap')
    expect(context.drawImage.mock.calls.some(call => call[0] === images[0])).toBe(true)
    await act(async () => root!.unmount()); root = null
    expect(images[0].onload).toBeNull(); expect(images[0].onerror).toBeNull()
  })
  it('blocks capture when a required MapTiler logo fails and recovers on an alternative basemap', async () => {
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify({...DEFAULT_MAP_SETTINGS, maptilerKey: 'fake-test-key'}))
    await render({basemap: 'maptiler-streets'})
    await act(async () => images[0].onerror?.())
    expect(capture()).toBeNull(); expect(props.onCaptureError).toHaveBeenLastCalledWith(expect.stringContaining('标志'))
    await render({basemap: 'none'})
    expect(capture()).not.toBeNull(); expect(labels()).toContain('无底图')
  })
})
