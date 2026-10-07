import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {GeoMotionProject} from '../src/track/geomotion.ts'
import type {GeoMotionSceneHandle} from '../src/client/GeoMotionScene.tsx'
import {exportGeoMotionVideo} from '../src/client/geomotion-video-export.ts'

const encoder = vi.hoisted(() => ({
  failure: null as string | null,
  supported: true,
  blockAdd: false,
  blockStart: false,
  blockFinalize: false,
  codecClosed: false,
  pendingStartResolve: null as (() => void) | null,
  pendingFinalizeResolve: null as (() => void) | null,
  pendingAddResolve: null as (() => void) | null,
  pendingAddReject: null as ((error: Error) => void) | null,
  target: null as {buffer: ArrayBuffer | null} | null,
  events: [] as Array<{name: string; args: unknown[]}>,
  canEncode: vi.fn(async (_codec: string, _options: unknown) => true),
}))
vi.mock('mediabunny', () => {
  const event = (name: string, ...args: unknown[]) => encoder.events.push({name, args})
  const fail = (name: string) => {if (encoder.failure === name) throw new Error(`${name} failed`)}
  class BufferTarget {
    buffer: ArrayBuffer | null = null
    constructor() {event('target'); fail('target'); encoder.target = this}
  }
  class WebMOutputFormat {constructor() {event('format'); fail('format')}}
  class Output {
    state = 'pending'
    constructor(options: unknown) {event('output', options); fail('output')}
    addVideoTrack(source: unknown, options: unknown) {event('track', source, options); fail('track')}
    async start() {
      event('start'); this.state = 'started'; fail('start')
      if (encoder.blockStart) await new Promise<void>(resolve => {encoder.pendingStartResolve = resolve})
      event('started')
    }
    async finalize() {
      event('finalize'); this.state = 'finalizing'; fail('finalize')
      if (encoder.blockFinalize) await new Promise<void>(resolve => {encoder.pendingFinalizeResolve = resolve})
      encoder.codecClosed = true; this.state = 'finalized'; event('finalized')
      if (encoder.target) encoder.target.buffer = encoder.failure === 'empty' ? new ArrayBuffer(0) : Uint8Array.from([26, 69, 223, 163]).buffer
    }
    async cancel() {
      event('cancel')
      if (this.state === 'finalized' || this.state === 'finalizing') {event('cancel-noop'); return}
      if (encoder.pendingAddReject) event('cancel-during-add')
      encoder.pendingAddReject?.(new Error('cancelled pending encoder input')); encoder.pendingAddReject = null
      this.state = 'canceled'; encoder.codecClosed = true; event('output-closed'); fail('cancel')
    }
  }
  class CanvasSource {
    constructor(canvas: unknown, options: unknown) {event('source', canvas, options); fail('source')}
    async add(timestamp: number, duration: number) {
      event('frame', timestamp, duration); fail('add')
      if (encoder.blockAdd) await new Promise<void>((resolve, reject) => {encoder.pendingAddResolve = resolve; encoder.pendingAddReject = reject})
      encoder.pendingAddReject = null; event('frame-drained')
    }
    close() {event('close'); if (encoder.codecClosed) throw new DOMException('Cannot call flush on a closed codec', 'InvalidStateError'); fail('close')}
  }
  return {BufferTarget, WebMOutputFormat, Output, CanvasSource, canEncodeVideo: encoder.canEncode}
})

function project(init: Partial<GeoMotionProject> = {}): GeoMotionProject {
  return {format: 7, name: '真实轨迹 / 片头', duration: 1, fps: 30, width: 1920, height: 1080, basemap: 'track-shared', terrain: true, terrainExaggeration: 1, background: '#14202b', contexts: [], story: [], nodes: {
    title: {id: 'title', type: 'text', name: '字幕', parentId: null, order: 'a0', visible: true, in: 0, out: 1, fade: 0, text: '拍摄前的真实地名', x: .5, y: .4, size: 44, color: '#ffffff', weight: 600, align: 'center', background: false, backgroundColor: '#000000', letterSpacing: 0, anim: 'none'},
  }, ...init}
}
function sceneFor(document: GeoMotionProject) {
  const capture = {width: document.width, height: document.height, kind: 'map-with-labels-subtitles-and-credits'} as unknown as HTMLCanvasElement
  const mapCanvas = {width: document.width, height: document.height, kind: 'map-only'} as unknown as HTMLCanvasElement
  const observed: Array<{project: GeoMotionProject; time: number}> = []
  const release = vi.fn(() => {encoder.events.push({name: 'release', args: []})})
  const freeze = vi.fn(() => {encoder.events.push({name: 'freeze', args: []}); return release})
  const renderAt = vi.fn(async (value: GeoMotionProject, time: number, _signal?: AbortSignal) => {observed.push({project: structuredClone(value), time})})
  const getCaptureCanvas = vi.fn(() => capture)
  const scene: GeoMotionSceneHandle = {renderAt, getCaptureCanvas, freezeConfiguration: freeze, getCamera: () => ({center: [120, 30], zoom: 12, bearing: 0, pitch: 45})}
  return {scene, capture, mapCanvas, observed, release, freeze, renderAt, getCaptureCanvas}
}
function events(name: string) {return encoder.events.filter(event => event.name === name)}

beforeEach(() => {
  encoder.failure = null; encoder.supported = true; encoder.blockAdd = false; encoder.blockStart = false; encoder.blockFinalize = false; encoder.codecClosed = false
  encoder.pendingStartResolve = null; encoder.pendingFinalizeResolve = null; encoder.pendingAddResolve = null; encoder.pendingAddReject = null; encoder.target = null; encoder.events.length = 0
  encoder.canEncode.mockReset().mockImplementation(async () => encoder.supported)
  vi.stubGlobal('VideoEncoder', class {})
})
afterEach(() => {vi.unstubAllGlobals()})

describe('GeoMotion composed frame video export', () => {
  it('preserves 1920×1080, uses only the complete composition canvas and emits an ordered 30-frame VP9 timeline', async () => {
    const document = project(), view = sceneFor(document), progress: Array<{completed: number; total: number}> = []
    const result = await exportGeoMotionVideo({project: document, scene: view.scene, onProgress: state => progress.push(state)})
    expect(encoder.canEncode).toHaveBeenCalledWith('vp9', expect.objectContaining({width: 1920, height: 1080}))
    expect(events('source')).toHaveLength(1)
    expect(events('source')[0].args[0]).toBe(view.capture)
    expect(events('source')[0].args[0]).not.toBe(view.mapCanvas)
    expect(events('source')[0].args[1]).toMatchObject({codec: 'vp9', latencyMode: 'quality'})
    expect([view.capture.width, view.capture.height]).toEqual([1920, 1080])
    expect(events('track')[0].args[1]).toEqual({frameRate: 30})
    expect(events('frame')).toHaveLength(30)
    const frames = events('frame')
    for (let index = 0; index < frames.length; index++) {
      expect(frames[index].args[0]).toBeCloseTo(index / 30, 12)
      expect(frames[index].args[1]).toBeCloseTo(1 / 30, 12)
      expect(view.observed[index].time).toBeCloseTo(index / 30, 12)
    }
    expect(progress).toHaveLength(31)
    expect(progress[0]).toEqual({completed: 0, total: 30})
    expect(progress.at(-1)).toEqual({completed: 30, total: 30})
    expect(result.blob.type).toBe('video/webm'); expect(result.blob.size).toBe(4); expect(result.filename).toBe('真实轨迹 片头.webm')
    expect(events('cancel')).toHaveLength(0); expect(events('finalize')).toHaveLength(1); expect(events('close')).toHaveLength(0); expect(view.release).toHaveBeenCalledOnce()
    expect(encoder.events.at(-1)?.name).toBe('release')
  })
  it('uses a shortened final frame when duration does not land on a frame boundary', async () => {
    const document = project({duration: .11}), view = sceneFor(document)
    await exportGeoMotionVideo({project: document, scene: view.scene})
    const frames = events('frame')
    expect(frames).toHaveLength(4)
    expect(frames.at(-1)!.args[0]).toBeCloseTo(.1, 12)
    expect(frames.at(-1)!.args[1]).toBeCloseTo(.01, 12)
    expect(frames.reduce((sum, frame) => sum + (frame.args[1] as number), 0)).toBeCloseTo(.11, 12)
  })
  it('holds a deep project snapshot even when the original dimensions, title and nested nodes change during export', async () => {
    const document = project(), original = structuredClone(document), view = sceneFor(document)
    const result = await exportGeoMotionVideo({project: document, scene: view.scene, onProgress: state => {
      if (state.completed === 0) {
        document.name = '之后编辑的工程'; document.width = 640; document.height = 360; document.duration = 10
        const title = document.nodes.title
        if (title.type === 'text') title.text = '未被保存的地名修改'
      }
    }})
    expect(view.observed).toHaveLength(30)
    for (const frame of view.observed) expect(frame.project).toEqual(original)
    expect(result.filename).toBe('真实轨迹 片头.webm')
    expect(document).not.toEqual(original)
    expect(view.release).toHaveBeenCalledOnce()
  })
  it('rejects a canvas of a different size before starting encoding and always releases the configuration', async () => {
    const document = project(), view = sceneFor(document)
    view.capture.height = 1072
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).rejects.toThrow('画布与导出尺寸不一致')
    expect(events('source')).toHaveLength(0); expect(events('start')).toHaveLength(0)
    expect(events('cancel')).toHaveLength(1); expect(view.release).toHaveBeenCalledOnce()
  })
  it('lets the current encoder input drain before cancellation, avoiding a close concurrent with add', async () => {
    const document = project(), view = sceneFor(document), controller = new AbortController(), progress = vi.fn()
    encoder.blockAdd = true
    const exporting = exportGeoMotionVideo({project: document, scene: view.scene, signal: controller.signal, onProgress: progress})
    const rejected = expect(exporting).rejects.toMatchObject({name: 'AbortError'})
    await vi.waitFor(() => expect(encoder.pendingAddResolve).not.toBeNull())
    controller.abort()
    expect(events('cancel')).toHaveLength(0); expect(view.release).not.toHaveBeenCalled()
    encoder.pendingAddResolve!()
    await rejected
    expect(events('cancel-during-add')).toHaveLength(0); expect(events('cancel')).toHaveLength(1); expect(events('close')).toHaveLength(0)
    expect(events('finalize')).toHaveLength(0); expect(view.release).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledTimes(1)
    expect(encoder.events.findIndex(event => event.name === 'frame-drained')).toBeLessThan(encoder.events.findIndex(event => event.name === 'cancel'))
    expect(encoder.events.at(-1)?.name).toBe('release')
  })
  it('waits for pending initialization before cancelling and never submits a frame after abort', async () => {
    const document = project(), view = sceneFor(document), controller = new AbortController(), progress = vi.fn()
    encoder.blockStart = true
    const exporting = exportGeoMotionVideo({project: document, scene: view.scene, signal: controller.signal, onProgress: progress})
    const rejected = expect(exporting).rejects.toMatchObject({name: 'AbortError'})
    await vi.waitFor(() => expect(encoder.pendingStartResolve).not.toBeNull())
    controller.abort()
    expect(events('cancel')).toHaveLength(0); expect(view.release).not.toHaveBeenCalled()
    encoder.pendingStartResolve!()
    await rejected
    expect(events('frame')).toHaveLength(0); expect(events('cancel')).toHaveLength(1); expect(events('close')).toHaveLength(0)
    expect(progress).not.toHaveBeenCalled(); expect(view.release).toHaveBeenCalledOnce()
    expect(encoder.events.findIndex(event => event.name === 'started')).toBeLessThan(encoder.events.findIndex(event => event.name === 'cancel'))
  })
  it('waits for an in-flight final flush before discarding an aborted export and does not close the codec twice', async () => {
    const document = project({duration: .01}), view = sceneFor(document), controller = new AbortController()
    encoder.blockFinalize = true
    const exporting = exportGeoMotionVideo({project: document, scene: view.scene, signal: controller.signal})
    const rejected = expect(exporting).rejects.toMatchObject({name: 'AbortError'})
    await vi.waitFor(() => expect(encoder.pendingFinalizeResolve).not.toBeNull())
    controller.abort()
    expect(events('cancel')).toHaveLength(0); expect(view.release).not.toHaveBeenCalled()
    encoder.pendingFinalizeResolve!()
    await rejected
    expect(events('close')).toHaveLength(0); expect(events('cancel-noop')).toHaveLength(1); expect(view.release).toHaveBeenCalledOnce()
    expect(encoder.events.findIndex(event => event.name === 'finalized')).toBeLessThan(encoder.events.findIndex(event => event.name === 'cancel'))
  })
  it('passes the abort signal to pending rendering so it stops promptly without waiting for unavailable map tiles', async () => {
    const document = project(), view = sceneFor(document), controller = new AbortController()
    view.renderAt.mockImplementation(async (_project, _time, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('tiles cancelled', 'AbortError')), {once: true})
    }))
    const exporting = exportGeoMotionVideo({project: document, scene: view.scene, signal: controller.signal})
    const rejected = expect(exporting).rejects.toMatchObject({name: 'AbortError'})
    await vi.waitFor(() => expect(view.renderAt).toHaveBeenCalledOnce())
    controller.abort(); await rejected
    expect(events('source')).toHaveLength(0); expect(events('cancel')).toHaveLength(1); expect(view.release).toHaveBeenCalledOnce()
  })
  it('cancels and unlocks if rendering a later frame fails, without finalizing an incomplete video', async () => {
    const document = project(), view = sceneFor(document)
    view.renderAt.mockImplementation(async (_project, time) => {if (time > 0) throw new Error('terrain tile missing')})
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).rejects.toThrow('terrain tile missing')
    expect(events('frame')).toHaveLength(1); expect(events('finalize')).toHaveLength(0); expect(events('cancel')).toHaveLength(1); expect(events('close')).toHaveLength(0)
    expect(view.release).toHaveBeenCalledOnce()
  })
  it('preserves the rendering error and still releases resources when cancelling the output also fails', async () => {
    const document = project(), view = sceneFor(document)
    encoder.failure = 'cancel'
    view.renderAt.mockImplementation(async (_project, time) => {if (time > 0) throw new Error('original tile error')})
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).rejects.toThrow('original tile error')
    expect(events('cancel')).toHaveLength(1); expect(events('close')).toHaveLength(0); expect(view.release).toHaveBeenCalledOnce()
  })
  it.each(['source', 'track', 'start', 'add', 'finalize', 'empty'])('cleans encoding resources and configuration after %s failure', async failure => {
    const document = project(), view = sceneFor(document)
    encoder.failure = failure
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).rejects.toThrow(failure === 'empty' ? '没有生成有效视频' : `${failure} failed`)
    expect(events('cancel')).toHaveLength(1); expect(view.release).toHaveBeenCalledOnce()
    if (failure !== 'source') expect(events('close')).toHaveLength(0)
    expect(encoder.events.at(-1)?.name).toBe('release')
  })
  it.each(['target', 'format', 'output'])('releases any acquired configuration when %s initialization throws', async failure => {
    const document = project(), view = sceneFor(document)
    encoder.failure = failure
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).rejects.toThrow(`${failure} failed`)
    expect(view.release.mock.calls.length).toBe(view.freeze.mock.calls.length)
    expect(events('source')).toHaveLength(0)
  })
  it('uses Output as the sole codec owner instead of calling the detached CanvasSource.close after finalization', async () => {
    const document = project(), view = sceneFor(document)
    encoder.failure = 'close'
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).resolves.toMatchObject({filename: '真实轨迹 片头.webm'})
    expect(encoder.codecClosed).toBe(true); expect(events('close')).toHaveLength(0); expect(view.release).toHaveBeenCalledOnce()
  })
  it('does not acquire scene resources for unsupported codecs or a request already aborted', async () => {
    const document = project(), view = sceneFor(document)
    encoder.supported = false
    await expect(exportGeoMotionVideo({project: document, scene: view.scene})).rejects.toThrow('不支持')
    const controller = new AbortController(); controller.abort()
    await expect(exportGeoMotionVideo({project: document, scene: view.scene, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'})
    expect(view.freeze).not.toHaveBeenCalled(); expect(view.renderAt).not.toHaveBeenCalled(); expect(events('output')).toHaveLength(0)
  })
})
