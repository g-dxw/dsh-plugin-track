// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackAnimation, type AnimationShot, type TrackAnimationProps } from '../src/client/TrackAnimation.tsx'
import { editedMetrics } from '../src/track/edit.ts'
import type { TrackPoint, TrackRecord } from '../src/protocol.ts'
import { BLANK_STYLE, MAPTILER_LOGO_URL, SATELLITE_STYLE } from '../src/track/basemaps.ts'
import type { TrackFrameRenderer } from '../src/track/frame-renderer.ts'
import { DEFAULT_MAP_SETTINGS } from '../src/track/map-settings.ts'

type FakeSource = {data: GeoJSON.FeatureCollection; setData: ReturnType<typeof vi.fn>; animationPoints?: readonly TrackPoint[]; pending?: boolean; loaded: () => boolean}
type FakeMap = {
  canvas: HTMLCanvasElement; sources: Map<string, FakeSource>; layers: Map<string, unknown>
  emit: (name: string, event?: unknown) => void; getCanvas: () => HTMLCanvasElement
  setStyle: ReturnType<typeof vi.fn>; fitBounds: ReturnType<typeof vi.fn>; jumpTo: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>
}
const state = vi.hoisted(() => ({maps: [] as FakeMap[], noWebGL: false, networkPending: false, workersPending: false, tilesPending: false}))
vi.mock('maplibre-gl', () => ({
  Map: class {
    canvas = document.createElement('canvas')
    sources = new Map<string, FakeSource>()
    layers = new Map<string, unknown>()
    handlers = new Map<string, ((event?: unknown) => void)[]>()
    touchZoomRotate = {disableRotation: vi.fn()}
    addControl = vi.fn()
    fitBounds = vi.fn()
    jumpTo = vi.fn(() => this.emit('render'))
    triggerRepaint = vi.fn(() => this.emit('render'))
    style = {_loaded: true}
    getCanvas = () => this.canvas
    isStyleLoaded = () => !state.networkPending
    areTilesLoaded = () => !state.tilesPending
    isSourceLoaded = (id: string) => this.sources.get(id)?.loaded() ?? false
    getSource = (id: string) => this.sources.get(id)
    getLayer = (id: string) => this.layers.get(id)
    addSource = (id: string, value: {data: GeoJSON.FeatureCollection}) => {
      const source: FakeSource = {
        data: value.data, loaded: () => !source.pending && !state.workersPending,
        setData: vi.fn((data: GeoJSON.FeatureCollection) => {
          source.data = data; source.pending = true
          queueMicrotask(() => {source.pending = false; this.emit('render')})
        }),
      }
      this.sources.set(id, source)
    }
    addLayer = (layer: {id: string}) => this.layers.set(layer.id, layer)
    remove = vi.fn(() => this.canvas.remove())
    setStyle = vi.fn(() => {
      this.sources.clear(); this.layers.clear()
      queueMicrotask(() => {this.emit('styledata'); this.emit('render')})
    })
    on(name: string, handler: (event?: unknown) => void) {this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])}
    off(name: string, handler: (event?: unknown) => void) {this.handlers.set(name, (this.handlers.get(name) ?? []).filter(candidate => candidate !== handler))}
    emit(name: string, event?: unknown) {for (const handler of this.handlers.get(name) ?? []) handler(event)}
    constructor(options: {container: HTMLElement}) {
      if (state.noWebGL) throw new Error('No WebGL')
      this.canvas.width = 640; this.canvas.height = 480
      options.container.appendChild(this.canvas)
      state.maps.push(this)
    }
  },
  NavigationControl: class {}, AttributionControl: class {},
}))

const POINTS: TrackPoint[] = [[119.4, 30.3, 100, null], [119.5, 30.3, 200, null], [119.5, 30.4, null, null]]
function record(id = 'original', points = POINTS): TrackRecord {
  return {id, name: '山谷路线', filename: '山谷路线.gpx', format: 'gpx', createdAt: '2026-10-01T00:00:00Z', bytes: 1234, points: points.length, coordinates: points, metrics: editedMetrics(points)}
}
class FakeRecorder {
  static isTypeSupported = vi.fn((mime: string) => mime === 'video/webm;codecs=vp8')
  static fail = false
  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  firstPosition: unknown
  start = vi.fn(() => {
    this.state = 'recording'
    this.firstPosition = (state.maps[0].sources.get('cqai-track-animation-position')?.data.features[0]?.geometry as GeoJSON.Point | undefined)?.coordinates
  })
  pause = vi.fn(() => {this.state = 'paused'})
  resume = vi.fn(() => {this.state = 'recording'})
  stop = vi.fn(() => {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({data: new Blob(['video-frames'], {type: this.mimeType})} as BlobEvent)
      this.onstop?.(new Event('stop'))
    })
  })
  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    if (FakeRecorder.fail) throw new Error('Recorder refused')
    this.mimeType = options.mimeType!
    recorders.push(this)
  }
}
let root: Root | null
let container: HTMLDivElement
let props: TrackAnimationProps
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let recorders: FakeRecorder[]
let streams: {track: {stop: ReturnType<typeof vi.fn>}; stream: MediaStream}[]
let captureStream: ReturnType<typeof vi.fn>
let context: {drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn>; measureText: (text: string) => {width: number}}
let createURL: ReturnType<typeof vi.fn>
let revokeURL: ReturnType<typeof vi.fn>
let captureDescriptor: PropertyDescriptor | undefined
let createURLDescriptor: PropertyDescriptor | undefined
let revokeURLDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  FakeRecorder.fail = false; FakeRecorder.isTypeSupported.mockReset().mockImplementation(mime => mime === 'video/webm;codecs=vp8')
  state.maps = []; state.noWebGL = false; state.networkPending = false; state.workersPending = false; state.tilesPending = false; localStorage.clear(); recorders = []; streams = []
  frames = new Map(); nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {const id = nextFrame++; frames.set(id, callback); return id}))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  context = {drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: text => ({width: text.length * 7})}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  captureStream = vi.fn(() => {
    const track = {stop: vi.fn()}
    const stream = {getTracks: () => [track], getVideoTracks: () => [track]} as unknown as MediaStream
    streams.push({track, stream}); return stream
  })
  captureDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'captureStream')
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {configurable: true, value: captureStream})
  createURL = vi.fn(() => 'blob:video-' + createURL.mock.calls.length)
  revokeURL = vi.fn()
  createURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: createURL})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: revokeURL})
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  props = {track: record(), basemap: 'vector', onBasemap: vi.fn(), onCancel: vi.fn()}
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null; container.remove()
  for (const [target, key, descriptor] of [[HTMLCanvasElement.prototype, 'captureStream', captureDescriptor], [URL, 'createObjectURL', createURLDescriptor], [URL, 'revokeObjectURL', revokeURLDescriptor]] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render(next: Partial<TrackAnimationProps> = {}) {
  props = {...props, ...next}
  await act(async () => root!.render(createElement(TrackAnimation, props)))
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  if (!result) throw new Error('Button missing: ' + text)
  return result
}
async function click(text: string) {await act(async () => button(text).click())}
async function frame(timestamp: number) {await act(async () => {const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(timestamp))})}
async function duration(seconds: number) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="动画总时长"]')!
    select.value = String(seconds); select.dispatchEvent(new Event('change', {bubbles: true}))
  })
}
function progress() {return container.querySelector('output')!.textContent!}
async function seek(value: number) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="播放进度"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}
function geometry(id: string) {return state.maps[0].sources.get('cqai-track-animation-' + id)!.data.features[0]?.geometry}

describe('track animation playback and WebM recording', () => {
  it('plays by route distance without timestamps and leaves the original points unchanged', async () => {
    const original = JSON.stringify(POINTS)
    await render(); await duration(15); await click('播放'); await frame(0); await frame(7500)
    expect(progress()).toContain('50%'); expect(progress()).toContain('/ 15 秒')
    expect(geometry('position')?.type).toBe('Point')
    expect(geometry('walked')?.type).toBe('LineString')
    expect(JSON.stringify(POINTS)).toBe(original)
    await frame(15000)
    expect(progress()).toContain('100%'); expect(container.textContent).toContain('播放完成'); expect(frames.size).toBe(0)
    expect((geometry('position') as GeoJSON.Point).coordinates).toEqual(POINTS.at(-1)!.slice(0, 2))
  })
  it('pauses without accumulating wall-clock time, continues, restarts and seeks', async () => {
    await render(); await duration(15); await click('播放'); await frame(0); await frame(3000)
    expect(progress()).toContain('20%')
    await click('暂停'); expect(frames.size).toBe(0)
    await click('继续播放'); await frame(30000); await frame(33000)
    expect(progress()).toContain('40%')
    await click('重新播放'); expect(progress()).toContain('0%')
    await seek(750); expect(progress()).toContain('75%')
  })
  it('burns the full map canvas, title, progress and correct satellite credits into captured frames', async () => {
    await render({basemap: 'satellite'})
    expect(state.maps[0].setStyle).toHaveBeenLastCalledWith(SATELLITE_STYLE)
    expect(context.drawImage).toHaveBeenLastCalledWith(state.maps[0].canvas, 0, 0, 640, 480)
    const text = context.fillText.mock.calls.map(call => call[0]).join(' ')
    for (const label of ['山谷路线', '轨迹动画', 'Esri', 'Vantor', 'Earthstar', 'GIS']) expect(text).toContain(label)
    expect(text).not.toMatch(/OpenStreetMap|OpenMapTiles|OpenTopoMap/u)
    await click('录制并导出 WebM')
    expect(captureStream).toHaveBeenCalledWith(30)
    expect(recorders[0].mimeType).toBe('video/webm;codecs=vp8')
    expect(button('卫星').disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="播放进度"]')!.disabled).toBe(true)
  })
  it('automatically produces a downloadable WebM at the end and releases the video track', async () => {
    await render(); await duration(15); await click('录制并导出 WebM'); await frame(0); await frame(15000)
    expect(recorders[0].stop).not.toHaveBeenCalled()
    await act(async () => new Promise(resolve => setTimeout(resolve, 120)))
    expect(recorders[0].stop).toHaveBeenCalledOnce(); expect(streams[0].track.stop).toHaveBeenCalledOnce()
    expect(createURL).toHaveBeenCalledOnce()
    const link = container.querySelector<HTMLAnchorElement>('a[download]')!
    expect(link.download).toBe('山谷路线-动画.webm'); expect(link.href).toContain('blob:video')
    expect((createURL.mock.calls[0][0] as Blob).type).toBe('video/webm;codecs=vp8')
    expect(container.textContent).toContain('WebM 视频已生成')
  })
  it('pauses and resumes the recorder together with playback, and retains an early stop', async () => {
    await render(); await click('录制并导出 WebM'); await frame(0); await frame(2000)
    await click('暂停'); expect(recorders[0].pause).toHaveBeenCalledOnce(); expect(container.textContent).toContain('录制已暂停')
    await click('继续播放'); expect(recorders[0].resume).toHaveBeenCalledOnce()
    await frame(30000); expect(progress()).toContain('7%')
    await click('停止并导出')
    expect(createURL).toHaveBeenCalledOnce(); expect(streams[0].track.stop).toHaveBeenCalledOnce()
    expect(progress()).not.toContain('100%'); expect(container.querySelector('a[download]')).not.toBeNull()
  })
  it('discards a capture on exit and ignores callbacks which arrive after cleanup', async () => {
    await render(); await click('录制并导出 WebM'); await frame(0)
    const onData = recorders[0].ondataavailable!; const onStop = recorders[0].onstop!
    await click('返回轨迹详情')
    await act(async () => {onData({data: new Blob(['late'])} as BlobEvent); onStop(new Event('stop'))})
    expect(props.onCancel).toHaveBeenCalledOnce(); expect(recorders[0].stop).toHaveBeenCalledOnce()
    expect(streams[0].track.stop).toHaveBeenCalledOnce(); expect(frames.size).toBe(0); expect(createURL).not.toHaveBeenCalled()
  })
  it('cancels a capture on a track switch, resets playback, and releases map resources on unmount', async () => {
    await render(); await click('录制并导出 WebM'); await frame(0); await frame(2000)
    await render({track: record('next', [[120, 31, null, null], [120.1, 31.1, null, null]])})
    expect(streams[0].track.stop).toHaveBeenCalledOnce(); expect(createURL).not.toHaveBeenCalled(); expect(progress()).toContain('0%')
    await act(async () => root!.unmount()); root = null
    expect(state.maps[0].remove).toHaveBeenCalledOnce(); expect(frames.size).toBe(0)
    await act(async () => state.maps[0].emit('render'))
    expect(createURL).not.toHaveBeenCalled()
  })
  it('revokes exported URLs when recording again, changing track, or leaving', async () => {
    await render(); await click('录制并导出 WebM'); await click('停止并导出')
    const first = container.querySelector<HTMLAnchorElement>('a[download]')!.href
    await click('录制并导出 WebM'); expect(revokeURL).toHaveBeenCalledWith(first)
    await click('停止并导出'); const second = container.querySelector<HTMLAnchorElement>('a[download]')!.href
    await render({track: record('next')}); expect(revokeURL).toHaveBeenCalledWith(second)
    expect(revokeURL).toHaveBeenCalledTimes(2)
  })
  it('keeps playback available without MediaRecorder or canvas capture support', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    await render(); expect(button('录制并导出 WebM').disabled).toBe(true)
    expect(container.textContent).toContain('不支持 WebM 录制')
    await click('播放'); await frame(0); await frame(3000); expect(progress()).toContain('10%')
  })
  it('reports a missing captureStream API while keeping ordinary playback', async () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {configurable: true, value: undefined})
    await render(); expect(button('录制并导出 WebM').disabled).toBe(true)
    expect(container.textContent).toContain('不支持 canvas.captureStream'); expect(button('播放').disabled).toBe(false)
  })
  it('clearly reports missing WebGL, without scheduling frames or constructing a recorder', async () => {
    state.noWebGL = true
    await render(); expect(button('播放').disabled).toBe(true); expect(button('录制并导出 WebM').disabled).toBe(true)
    expect(container.textContent).toContain('没有可用的 WebGL'); expect(frames.size).toBe(0); expect(recorders).toHaveLength(0)
  })
  it('preserves playback when canvas capture is blocked by a cross-origin/graphics error', async () => {
    context.drawImage.mockImplementation(() => {throw new DOMException('Blocked', 'SecurityError')})
    await render(); expect(button('播放').disabled).toBe(false); expect(button('录制并导出 WebM').disabled).toBe(true)
    expect(container.textContent).toContain('跨域或图形设备限制')
  })
  it('falls back to a plain track after imagery fails and still supports playback and recording', async () => {
    await render({basemap: 'satellite'})
    await act(async () => state.maps[0].emit('error', {}))
    expect(state.maps[0].setStyle).toHaveBeenLastCalledWith(BLANK_STYLE)
    expect(container.textContent).toContain('仍可播放和录制'); expect(button('录制并导出 WebM').disabled).toBe(false)
    context.fillText.mockClear(); await click('录制并导出 WebM'); await frame(0); await frame(5000)
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('无底图')
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).not.toContain('Esri')
  })
  it('clamps Mercator display coordinates and caps displayed points without changing large originals', async () => {
    const points: TrackPoint[] = Array.from({length: 20_000}, (_, index) => [index / 20000, 89, null, null])
    await render({track: record('polar', points)})
    const full = (geometry('full') as GeoJSON.LineString).coordinates
    expect(full.length).toBeLessThanOrEqual(5000)
    expect(full.every(point => Number.isFinite(point[0]) && point[1] === 85.051129)).toBe(true)
    expect(points[0][1]).toBe(89); expect(points).toHaveLength(20_000)
    await seek(500)
    expect((geometry('walked') as GeoJSON.LineString).coordinates.length).toBeLessThanOrEqual(5000)
  })
  it('cleans up stream tracks when recorder construction fails', async () => {
    FakeRecorder.fail = true
    await render(); await click('录制并导出 WebM')
    expect(streams[0].track.stop).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Recorder refused')
    expect(button('播放').disabled).toBe(false); expect(frames.size).toBe(0)
  })
  it('handles a genuine WebGL context loss once and completes the already captured video', async () => {
    await render(); await click('录制并导出 WebM'); await frame(0); await frame(1000)
    await act(async () => state.maps[0].canvas.dispatchEvent(new Event('webglcontextlost', {cancelable: true})))
    expect(state.maps[0].remove).toHaveBeenCalledOnce(); expect(frames.size).toBe(0)
    expect(streams[0].track.stop).toHaveBeenCalledOnce(); expect(container.textContent).toContain('上下文已丢失')
    expect(button('继续播放').disabled).toBe(true)
    await act(async () => root!.unmount()); root = null
    expect(state.maps[0].remove).toHaveBeenCalledOnce()
  })
  it('executes overview, follow and checkpoint shots, burns narration, and uses script duration', async () => {
    const script: AnimationShot[] = [{type: 'overview', duration: 3, narration: '山谷全景'}, {type: 'follow', duration: 3}, {type: 'checkpoint', duration: 3, pointIndex: 1, narration: '补给点'}]
    await render({script})
    expect(container.textContent).toContain('3 个镜头 · 9 秒')
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="动画总时长"]')!.disabled).toBe(true)
    const initialFits = state.maps[0].fitBounds.mock.calls.length
    await click('播放'); await frame(0); await frame(3500)
    expect(container.textContent).toContain('跟随'); expect(state.maps[0].jumpTo).toHaveBeenCalled()
    expect(state.maps[0].fitBounds.mock.calls.length).toBe(initialFits)
    await frame(6500)
    expect(state.maps[0].jumpTo).toHaveBeenCalledWith({center: [119.5, 30.3], zoom: 15})
    expect(container.textContent).toContain('点位聚焦')
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('补给点')
    await frame(9000); expect(progress()).toContain('100%')
    await click('重新播放'); expect(container.textContent).toContain('全景')
    expect(state.maps[0].fitBounds.mock.calls.length).toBeGreaterThan(initialFits)
  })
  it('releases a recorder that never emits its final stop event instead of hanging the UI', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    await render(); await click('录制并导出 WebM')
    recorders[0].stop.mockImplementation(() => {recorders[0].state = 'inactive'})
    await click('停止并导出')
    expect(button('正在生成视频…').disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(5001))
    expect(container.textContent).toContain('未能完成视频封装')
    expect(streams[0].track.stop).toHaveBeenCalledOnce(); expect(createURL).not.toHaveBeenCalled()
    expect(button('录制并导出 WebM').disabled).toBe(false)
  })
  it('uses the parent-provided back label', async () => {
    await render({backLabel: '返回镜头脚本'})
    await click('返回镜头脚本'); expect(props.onCancel).toHaveBeenCalledOnce()
  })
  it('installs complete route layers while basemap tiles are still pending', async () => {
    state.networkPending = true
    await render()
    expect(geometry('full')?.type).toBe('LineString')
    expect(geometry('position')?.type).toBe('Point')
    expect(button('录制并导出 WebM').disabled).toBe(false)
  })
  it('waits for a fully rendered reset frame before recording a previously advanced route', async () => {
    await render(); await seek(750)
    expect((geometry('position') as GeoJSON.Point).coordinates).not.toEqual(POINTS[0].slice(0, 2))
    state.workersPending = true
    await click('录制并导出 WebM')
    expect(recorders[0].start).not.toHaveBeenCalled(); expect(button('准备录制…').disabled).toBe(true)
    expect(frames.size).toBe(0)
    state.workersPending = false
    await act(async () => state.maps[0].emit('render'))
    expect(recorders[0].start).toHaveBeenCalledOnce()
    expect(recorders[0].firstPosition).toEqual(POINTS[0].slice(0, 2))
    expect(progress()).toContain('0%'); expect(frames.size).toBe(1)
  })
  it('keeps the final endpoint and 100-percent label rendered before stopping the stream', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    await render(); await duration(15); await click('录制并导出 WebM'); await frame(0)
    state.workersPending = true
    await frame(15000)
    expect(recorders[0].stop).not.toHaveBeenCalled(); expect(button('正在生成视频…').disabled).toBe(true)
    state.workersPending = false
    await act(async () => state.maps[0].emit('render'))
    expect((geometry('position') as GeoJSON.Point).coordinates).toEqual(POINTS.at(-1)!.slice(0, 2))
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('100%')
    await act(async () => vi.advanceTimersByTime(99))
    expect(recorders[0].stop).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(recorders[0].stop).toHaveBeenCalledOnce(); expect(createURL).toHaveBeenCalledOnce()
  })
  it('releases preparation tracks when GeoJSON workers never acknowledge the initial frame', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    await render(); state.workersPending = true
    await click('录制并导出 WebM')
    await act(async () => vi.advanceTimersByTime(5001))
    expect(container.textContent).toContain('起点画面加载超过 5 秒')
    expect(streams[0].track.stop).toHaveBeenCalledOnce(); expect(recorders[0].start).not.toHaveBeenCalled()
    expect(createURL).not.toHaveBeenCalled()
  })
  it('rejects an invalid shot script before playback or recording', async () => {
    await render({script: [{type: 'checkpoint', duration: 3, pointIndex: 99}]})
    expect(container.textContent).toContain('镜头脚本无效')
    expect(button('播放').disabled).toBe(true); expect(button('录制并导出 WebM').disabled).toBe(true)
  })

  it('renders requested frames through the adapter only after source and tile completion', async () => {
    let adapter: TrackFrameRenderer | null = null
    await render({onFrameRenderer: next => {adapter = next}})
    expect(adapter).not.toBeNull(); expect(adapter!.getCaptureCanvas()).not.toBeNull()
    state.workersPending = true; state.tilesPending = true
    let done = false
    const request = adapter!.renderFrame({progress: 0.5, elapsedMs: 15_000}).then(() => {done = true})
    await act(async () => {state.maps[0].emit('render')})
    expect(done).toBe(false)
    state.workersPending = false
    await act(async () => {state.maps[0].emit('render')})
    expect(done).toBe(false)
    state.tilesPending = false
    await act(async () => {state.maps[0].emit('render'); await request})
    expect(done).toBe(true)
    expect((geometry('position') as GeoJSON.Point).coordinates[0]).toBe(119.5)
    expect((geometry('position') as GeoJSON.Point).coordinates[1]).toBeGreaterThan(30.3)
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('50%')
  })

  it('rejects superseded frames and never lets their render events finish a newer request', async () => {
    let adapter: TrackFrameRenderer | null = null
    await render({onFrameRenderer: next => {adapter = next}})
    state.workersPending = true
    const first = adapter!.renderFrame({progress: 0.25, elapsedMs: 7500}).catch(reason => reason)
    let secondDone = false
    const second = adapter!.renderFrame({progress: 0.75, elapsedMs: 22_500}).then(() => {secondDone = true})
    expect((await first).name).toBe('AbortError')
    await act(async () => {state.maps[0].emit('render')})
    expect(secondDone).toBe(false)
    state.workersPending = false
    await act(async () => {state.maps[0].emit('render'); await second})
    expect(secondDone).toBe(true)
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('75%')
  })

  it('cancels pending frame requests on abort, source error and renderer disposal', async () => {
    let adapter: TrackFrameRenderer | null = null
    await render({onFrameRenderer: next => {adapter = next}})
    const saved = adapter!
    state.workersPending = true
    const controller = new AbortController()
    const aborted = saved.renderFrame({progress: 0.2, elapsedMs: 6000}, controller.signal).catch(reason => reason)
    controller.abort(); expect((await aborted).name).toBe('AbortError')
    const failed = saved.renderFrame({progress: 0.4, elapsedMs: 12_000}).catch(reason => reason)
    await act(async () => state.maps[0].emit('error', {sourceId: 'cqai-track-animation-position'}))
    expect(await failed).toBeInstanceOf(Error)
    const disposed = saved.renderFrame({progress: 0.6, elapsedMs: 18_000}).catch(reason => reason)
    await act(async () => root!.unmount()); root = null
    expect((await disposed).name).toBe('AbortError')
    expect(adapter).toBeNull(); expect(saved.getCaptureCanvas()).toBeNull()
    await expect(saved.renderFrame({progress: 1, elapsedMs: 30_000})).rejects.toHaveProperty('name', 'AbortError')
  })

  it('rejects invalid frames and times out an unacknowledged source request', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    let adapter: TrackFrameRenderer | null = null
    await render({onFrameRenderer: next => {adapter = next}})
    await expect(adapter!.renderFrame({progress: NaN, elapsedMs: 1})).rejects.toBeInstanceOf(RangeError)
    state.workersPending = true
    const timedOut = adapter!.renderFrame({progress: 0.8, elapsedMs: 24_000}).catch(reason => reason)
    await act(async () => vi.advanceTimersByTime(10_001))
    expect((await timedOut).message).toContain('did not finish rendering')
    expect(button('播放').disabled).toBe(false)
  })

  it('burns the official MapTiler logo before making its capture canvas available', async () => {
    const images: {crossOrigin: string; src: string; onload: (() => void) | null; onerror: (() => void) | null}[] = []
    vi.stubGlobal('Image', class {
      crossOrigin = ''; src = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null
      constructor() {images.push(this)}
    })
    localStorage.setItem('cqai-track.map-settings', JSON.stringify({version: 1, maptilerKey: 'test-key', basemap: 'maptiler-streets'}))
    let adapter: TrackFrameRenderer | null = null
    await render({basemap: 'maptiler-streets', onFrameRenderer: next => {adapter = next}})
    expect(images).toHaveLength(1); expect(images[0].crossOrigin).toBe('anonymous'); expect(images[0].src).toBe(MAPTILER_LOGO_URL)
    expect(adapter!.getCaptureCanvas()).toBeNull(); expect(button('录制并导出 WebM').disabled).toBe(true)
    await act(async () => images[0].onload?.())
    expect(context.drawImage.mock.calls.some(call => call[0] === images[0])).toBe(true)
    expect(adapter!.getCaptureCanvas()).not.toBeNull()
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('MapTiler')
    await act(async () => state.maps[0].emit('error', {}))
    expect(adapter!.getCredits?.()).toEqual([])
  })

  it('keeps the recording provider stable until recording ends despite external settings changes', async () => {
    await render({basemap: 'satellite'})
    await click('录制并导出 WebM')
    const calls = state.maps[0].setStyle.mock.calls.length
    await act(async () => window.dispatchEvent(new CustomEvent('cqai-track:map-settings-changed', {detail: {...DEFAULT_MAP_SETTINGS, maptilerKey: 'another-key'}})))
    await render({basemap: 'vector'})
    expect(state.maps[0].setStyle).toHaveBeenCalledTimes(calls)
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="其他地图源"]')!.disabled).toBe(true)
    await click('停止并导出')
    expect(state.maps[0].setStyle.mock.calls.length).toBeGreaterThan(calls)
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="其他地图源"]')!.disabled).toBe(false)
  })

  it('rejects pending frames when the MapTiler logo fails without blocking map playback', async () => {
    const images: {onload: (() => void) | null; onerror: (() => void) | null}[] = []
    vi.stubGlobal('Image', class {
      crossOrigin = ''; src = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null
      constructor() {images.push(this)}
    })
    localStorage.setItem('cqai-track.map-settings', JSON.stringify({version: 1, maptilerKey: 'test-key', basemap: 'maptiler-streets'}))
    let adapter: TrackFrameRenderer | null = null
    await render({basemap: 'maptiler-streets', onFrameRenderer: next => {adapter = next}})
    const request = adapter!.renderFrame({progress: 0.4, elapsedMs: 12_000}).catch(reason => reason)
    await act(async () => images[0].onerror?.())
    expect((await request).message).toContain('MapTiler logo')
    expect(adapter!.getCaptureCanvas()).toBeNull()
    expect(button('播放').disabled).toBe(false); expect(button('录制并导出 WebM').disabled).toBe(true)
    expect(container.textContent).toContain('MapTiler 标志加载失败')
    await render({basemap: 'none'})
    expect(button('录制并导出 WebM').disabled).toBe(false)
  })

  it('waits for a newly drawn camera and narration when two frame requests have the same progress', async () => {
    let adapter: TrackFrameRenderer | null = null
    await render({onFrameRenderer: next => {adapter = next}})
    await act(async () => {await adapter!.renderFrame({progress: 0.5, elapsedMs: 15_000, shot: {type: 'checkpoint', duration: 3, pointIndex: 0}, shotIndex: 0})})
    state.workersPending = true
    let finished = false
    const request = adapter!.renderFrame({progress: 0.5, elapsedMs: 15_000,
      shot: {type: 'checkpoint', duration: 3, pointIndex: 2, narration: '终点镜头'}, shotIndex: 1}).then(() => {finished = true})
    await act(async () => state.maps[0].emit('render'))
    expect(finished).toBe(false)
    expect(state.maps[0].jumpTo).toHaveBeenLastCalledWith({center: [119.5, 30.4], zoom: 15})
    state.workersPending = false
    await act(async () => {state.maps[0].emit('render'); await request})
    expect(finished).toBe(true)
    expect(context.fillText.mock.calls.map(call => call[0]).join(' ')).toContain('终点镜头')
  })

  it('records the composed canvas containing an undistorted readable official MapTiler logo', async () => {
    const images: {naturalWidth: number; naturalHeight: number; onload: (() => void) | null}[] = []
    vi.stubGlobal('Image', class {
      crossOrigin = ''; src = ''; naturalWidth = 67; naturalHeight = 20
      onload: (() => void) | null = null; onerror: (() => void) | null = null
      constructor() {images.push(this)}
    })
    localStorage.setItem('cqai-track.map-settings', JSON.stringify({version: 1, maptilerKey: 'test-key', basemap: 'maptiler-streets'}))
    await render({basemap: 'maptiler-streets'})
    await act(async () => images[0].onload?.())
    const logoDraw = context.drawImage.mock.calls.filter(call => call[0] === images[0]).at(-1)!
    expect(logoDraw[3] / logoDraw[4]).toBeCloseTo(67 / 20)
    expect(context.fillRect.mock.calls.some(call => call[2] === logoDraw[3] + 6 && call[3] === logoDraw[4] + 4)).toBe(true)
    await click('录制并导出 WebM')
    expect(captureStream.mock.contexts[0]).toBeInstanceOf(HTMLCanvasElement)
    expect(captureStream.mock.contexts[0]).not.toBe(state.maps[0].canvas)
    expect(recorders[0].start).toHaveBeenCalledOnce()
    const titleAndCredits = context.fillText.mock.calls.map(call => call[0]).join(' ')
    expect(titleAndCredits).toContain('MapTiler'); expect(titleAndCredits).toContain('OpenStreetMap')
    await frame(0); await frame(3000)
    expect(context.drawImage.mock.calls.filter(call => call[0] === images[0]).length).toBeGreaterThan(1)
  })

  it('ignores an old MapTiler logo failure after changing to a provider that does not use it', async () => {
    const images: {onload: (() => void) | null; onerror: (() => void) | null}[] = []
    vi.stubGlobal('Image', class {
      crossOrigin = ''; src = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null
      constructor() {images.push(this)}
    })
    localStorage.setItem('cqai-track.map-settings', JSON.stringify({version: 1, maptilerKey: 'test-key', basemap: 'maptiler-streets'}))
    await render({basemap: 'maptiler-streets'})
    const oldError = images[0].onerror
    await render({basemap: 'none'})
    expect(button('录制并导出 WebM').disabled).toBe(false)
    await act(async () => oldError?.())
    expect(button('录制并导出 WebM').disabled).toBe(false)
    expect(container.textContent).not.toContain('MapTiler 标志加载失败')
  })
})


