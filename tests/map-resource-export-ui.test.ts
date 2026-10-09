// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {MapView} from '../src/client/MapView.tsx'
import {DEFAULT_MAP_SETTINGS, writeMapSettings} from '../src/track/map-settings.ts'
import type {TrackPlacemark, TrackPoint} from '../src/protocol.ts'
import type {TerrainGrid} from '../src/track/sandbox/types.ts'

type Handler = (event?: unknown) => void
type FakeMap = {
  canvas: HTMLCanvasElement; styleReady: boolean; tilesReady: boolean; moving: boolean; autoRender: boolean
  handlers: Map<string, Handler[]>; emit: (name: string, event?: unknown) => void
  triggerRepaint: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>
}
type Result = {terrain: TerrainGrid; texture: HTMLCanvasElement | null; textureUnavailable: boolean}
type FakeSandbox = {
  canvas: HTMLCanvasElement; renderFrame: ReturnType<typeof vi.fn>; getCaptureCanvas: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}
const state = vi.hoisted(() => ({
  maps: [] as FakeMap[], sandboxes: [] as FakeSandbox[], pending: [] as {signal: AbortSignal; resolve: (value: Result) => void}[],
  sampler: vi.fn(), capture: vi.fn(), store: vi.fn(), noWebGL: false,
}))
vi.mock('../src/client/map-resource-capture.ts', () => ({captureMapImage: state.capture}))
vi.mock('../src/client/resources-api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/resources-api.ts')>(), storeResourceMapImage: state.store,
}))
vi.mock('../src/track/map-floating-placemarks.ts', () => ({
  MapFloatingPlacemarkLayer: class {update = vi.fn(); dispose = vi.fn()},
}))
vi.mock('../src/track/sandbox/sampling.ts', () => ({
  sampleSandboxDetached: state.sampler,
  isSandboxDEMError: (event: {sourceId?: string}) => event.sourceId === 'cqai-track-terrain-dem',
}))
vi.mock('../src/track/sandbox/renderer.ts', () => ({
  SandboxRenderer: class {
    canvas = document.createElement('canvas')
    renderFrame = vi.fn()
    getCaptureCanvas = vi.fn(() => this.canvas)
    build = vi.fn(); updateLighting = vi.fn(); updateColors = vi.fn(); updateBackground = vi.fn()
    updatePlacemarks = vi.fn(); updateRouteColor = vi.fn(); zoomIn = vi.fn(); zoomOut = vi.fn(); resetView = vi.fn()
    dispose = vi.fn(() => this.canvas.remove())
    constructor(container: HTMLDivElement) {
      this.canvas.width = 800; this.canvas.height = 600; container.append(this.canvas); state.sandboxes.push(this)
    }
  },
}))
vi.mock('maplibre-gl', () => ({
  Map: class {
    container: HTMLElement
    canvas = document.createElement('canvas')
    handlers = new Map<string, Handler[]>()
    sources = new Map<string, {setData: ReturnType<typeof vi.fn>}>()
    layers = new Map<string, {id: string; paint?: Record<string, unknown>}>()
    styleReady = true; tilesReady = true; moving = false; autoRender = true
    currentTerrain: {source: string; exaggeration: number} | null = null
    camera = {center: [119.44, 30.34], zoom: 12, pitch: 0, bearing: 0}
    on(name: string, handler: Handler) {this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); return this}
    off = vi.fn((name: string, handler: Handler) => {this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); return this})
    emit(name: string, event?: unknown) {for (const handler of [...(this.handlers.get(name) ?? [])]) handler(event)}
    triggerRepaint = vi.fn(() => {if (this.autoRender) queueMicrotask(() => this.emit('render'))})
    isStyleLoaded = () => this.styleReady
    areTilesLoaded = () => this.tilesReady
    isMoving = () => this.moving
    getCanvas = () => this.canvas
    getCanvasContainer = () => this.container
    getTerrain = () => this.currentTerrain
    setTerrain = vi.fn((next: typeof this.currentTerrain) => {this.currentTerrain = next})
    getCenter = () => ({lng: this.camera.center[0], lat: this.camera.center[1]})
    getZoom = () => this.camera.zoom
    getPitch = () => this.camera.pitch
    getBearing = () => this.camera.bearing
    jumpTo = vi.fn((next: Partial<typeof this.camera>) => {this.camera = {...this.camera, ...next}})
    dragRotate = {enable: vi.fn(), disable: vi.fn()}
    touchPitch = {enable: vi.fn(), disable: vi.fn()}
    keyboard = {enableRotation: vi.fn(), disableRotation: vi.fn()}
    touchZoomRotate = {disableRotation: vi.fn(), enableRotation: vi.fn()}
    addControl = vi.fn(); fitBounds = vi.fn(); remove = vi.fn()
    removeSource = vi.fn((id: string) => this.sources.delete(id))
    removeLayer = vi.fn((id: string) => this.layers.delete(id))
    getLayoutProperty = vi.fn(); setLayoutProperty = vi.fn(); setSky = vi.fn()
    setPaintProperty = vi.fn((id: string, property: string, value: unknown) => {const layer = this.layers.get(id); if (layer) {layer.paint ??= {}; layer.paint[property] = value}})
    getStyle = () => ({version: 8, sources: {}, layers: []})
    getSource = (id: string) => this.sources.get(id)
    getLayer = (id: string) => this.layers.get(id)
    getPaintProperty = (id: string, property: string) => this.layers.get(id)?.paint?.[property]
    addSource = (id: string) => this.sources.set(id, {setData: vi.fn()})
    addLayer = (layer: {id: string; paint?: Record<string, unknown>}) => this.layers.set(layer.id, layer)
    setStyle = vi.fn(() => {
      this.sources.clear(); this.layers.clear(); this.currentTerrain = null
      queueMicrotask(() => this.emit('styledata'))
    })
    constructor(options: {container: HTMLElement}) {
      if (state.noWebGL) throw new Error('No WebGL')
      this.container = options.container; this.canvas.width = 1200; this.canvas.height = 900
      this.container.append(this.canvas); state.maps.push(this)
    }
  },
  Marker: class {
    coordinates: [number, number] = [0, 0]
    element: HTMLButtonElement
    remove = vi.fn(() => this.element.remove())
    constructor(options: {element: HTMLButtonElement}) {this.element = options.element}
    setLngLat(coordinates: [number, number]) {this.coordinates = [...coordinates]; return this}
    getLngLat() {return {lng: this.coordinates[0], lat: this.coordinates[1]}}
    setDraggable() {return this}
    on() {return this}
    addTo(map: {container: HTMLElement}) {map.container.append(this.element); return this}
  },
  NavigationControl: class {}, AttributionControl: class {},
  LngLatBounds: class {
    constructor(private sw: number[], private ne: number[]) {}
    getWest() {return this.sw[0]} getSouth() {return this.sw[1]}
    getEast() {return this.ne[0]} getNorth() {return this.ne[1]}
  },
}))

const POINTS: TrackPoint[] = [[119.44, 30.34, null, null], [119.46, 30.36, null, null]]
const RESULT: Result = {terrain: {bounds: [119.43, 30.33, 119.47, 30.37], columns: 2, rows: 2, widthMeters: 2000, depthMeters: 2000, elevations: [600, 900, 500, 700]}, texture: null, textureUnavailable: false}
const PLACEMARKS: TrackPlacemark[] = [
  {id: 'visible', name: '山口', coordinates: [119.445, 30.345], description: '', images: []},
  {id: 'hidden', name: '隐藏点', coordinates: [119.45, 30.35], description: '', images: [], hidden: true},
]
type Props = Parameters<typeof MapView>[0]
let root: Root | null
let container: HTMLDivElement
let png: Blob
beforeEach(() => {
  localStorage.clear(); state.maps = []; state.sandboxes = []; state.pending = []; state.noWebGL = false
  writeMapSettings({...DEFAULT_MAP_SETTINGS})
  png = new Blob(['captured frame'], {type: 'image/png'})
  state.capture.mockReset().mockResolvedValue(png)
  state.store.mockReset().mockResolvedValue({id: 'map-image', source: 'map-capture'})
  state.sampler.mockReset().mockImplementation((_points, options: {signal: AbortSignal}) => new Promise<Result>(resolve => state.pending.push({signal: options.signal, resolve})))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => {root!.unmount()})
  root = null; container.remove(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function render(options: Partial<Props> = {}) {
  await act(async () => {root!.render(createElement(MapView, {points: POINTS, name: '山区轨迹', trackId: 'track-a', basemap: 'vector', onBasemap: vi.fn(), ...options}))})
}
function findButton(label: string) {return [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)}
function button(label: string) {const found = findButton(label); if (!found) throw new Error(`Missing button ${label}`); return found}
async function click(label: string) {await act(async () => {button(label).click()})}
function captureOptions() {return state.capture.mock.calls.at(-1)![0] as {canvas: HTMLCanvasElement; markers?: HTMLElement[]; credits?: unknown; background?: string}}
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
async function sandboxReady() {await act(async () => {state.pending.at(-1)!.resolve(RESULT)})}

describe('map view saves the selected image to its track resource library', () => {
  it('requires a saved track and disables capture while picking a placemark or without WebGL', async () => {
    await render({trackId: undefined}); expect(findButton('保存到资源库')).toBeUndefined()
    await render({onPickPlacemark: vi.fn()}); expect(button('保存到资源库').disabled).toBe(true)
    await act(async () => {root!.unmount()}); root = createRoot(container); state.noWebGL = true
    await render(); expect(button('保存到资源库').disabled).toBe(true)
    expect(state.capture).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled()
  })

  it('captures a newly rendered 2D frame with visible markers and credits, excluding details and tools', async () => {
    await render({placemarks: PLACEMARKS, selectedPlacemark: 'visible', onSelectPlacemark: vi.fn()})
    state.maps[0].autoRender = false
    await click('保存到资源库')
    expect(button('保存中…').disabled).toBe(true); expect(state.capture).not.toHaveBeenCalled()
    expect(state.maps[0].triggerRepaint).toHaveBeenCalled()
    await act(async () => {state.maps[0].emit('render')})
    const options = captureOptions()
    expect(options.canvas).toBe(state.maps[0].canvas)
    expect(options.markers?.map(marker => marker.dataset.placemarkId)).toEqual(['visible'])
    expect(options.markers?.every(marker => marker.classList.contains('trk-map-placemark'))).toBe(true)
    expect(JSON.stringify(options.credits)).toContain('OpenStreetMap')
    expect(state.store).toHaveBeenCalledWith('track-a', expect.stringContaining('山区轨迹'), 'map', png)
    expect(container.textContent).toContain('二维地图已保存到资源库')
  })

  it('waits for tile and camera readiness instead of exporting a partial or moving native frame', async () => {
    await render(); const map = state.maps[0]; map.autoRender = false; map.tilesReady = false
    await click('保存到资源库'); await act(async () => {map.emit('render')})
    expect(state.capture).not.toHaveBeenCalled()
    map.tilesReady = true; map.moving = true
    await act(async () => {map.emit('render')}); expect(state.capture).not.toHaveBeenCalled()
    map.moving = false
    await act(async () => {map.emit('render')})
    expect(state.capture).toHaveBeenCalledTimes(1); expect(state.store).toHaveBeenCalledTimes(1)
    expect(map.off).toHaveBeenCalledWith('render', expect.any(Function))
  })

  it('exports only the collapsed group node without duplicating its members', async () => {
    await render({placemarks: PLACEMARKS, placemarkGroups: [{id: 'group-11111111-1111-1111-1111-111111111111', name: '山口合影', description: '', memberIds: ['visible', 'hidden'], coordinates: [119.445, 30.345]}]})
    await click('保存到资源库')
    expect(captureOptions().markers?.map(marker => marker.dataset.placemarkId)).toEqual(['group-11111111-1111-1111-1111-111111111111'])
    expect(captureOptions().markers?.[0].querySelector('.trk-map-placemark-dot')?.textContent).toBe('G1')
  })

  it('releases a stalled render wait after timeout so a new capture can succeed', async () => {
    await render(); vi.useFakeTimers()
    const map = state.maps[0]; map.autoRender = false; map.styleReady = false
    await click('保存到资源库')
    await act(async () => {await vi.advanceTimersByTimeAsync(12000)})
    expect(map.handlers.get('render')).toHaveLength(0)
    expect(container.textContent).toContain('地图仍在加载')
    expect(button('保存到资源库').disabled).toBe(false); expect(findButton('重试保存')).toBeUndefined()
    expect(state.capture).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled()
    vi.useRealTimers(); map.styleReady = true; map.autoRender = true
    await click('保存到资源库'); expect(state.store).toHaveBeenCalledTimes(1)
  })

  it('shows encoding failure without uploading or offering an unusable PNG retry', async () => {
    state.capture.mockRejectedValueOnce(new Error('图片编码失败'))
    await render(); await click('保存到资源库')
    expect(container.textContent).toContain('图片编码失败')
    expect(state.store).not.toHaveBeenCalled(); expect(findButton('重试保存')).toBeUndefined()
    expect(button('保存到资源库').disabled).toBe(false)
    await click('保存到资源库')
    expect(state.capture).toHaveBeenCalledTimes(2); expect(state.store).toHaveBeenCalledTimes(1)
  })

  it('exports the 3D map canvas with the selected terrain credits', async () => {
    await render({placemarks: PLACEMARKS}); await click('3D 地图'); await click('保存到资源库')
    expect(captureOptions().canvas).toBe(state.maps[0].canvas)
    expect(JSON.stringify(captureOptions().credits)).toContain('Mapterhorn')
    expect(state.store).toHaveBeenCalledWith('track-a', expect.any(String), 'terrain', png)
    expect(container.textContent).toContain('3D 地图已保存到资源库')
  })

  it('exports sandbox pixels only once its terrain is ready and renders the current camera', async () => {
    await render(); await click('3D 沙盘')
    expect(button('保存到资源库').disabled).toBe(true); expect(state.store).not.toHaveBeenCalled()
    await sandboxReady(); await click('保存到资源库')
    const sandbox = state.sandboxes[0]
    expect(sandbox.renderFrame).toHaveBeenCalled(); expect(sandbox.getCaptureCanvas).toHaveBeenCalled()
    expect(captureOptions().canvas).toBe(sandbox.canvas)
    expect(captureOptions().markers?.length ?? 0).toBe(0)
    expect(JSON.stringify(captureOptions().credits)).toContain('Mapterhorn')
    expect(JSON.stringify(captureOptions().credits)).not.toContain('OpenStreetMap')
    expect(state.store).toHaveBeenCalledWith('track-a', expect.any(String), 'sandbox', png)
    expect(container.textContent).toContain('3D 沙盘已保存到资源库')
  })

  it('prevents duplicate uploads while saving and keeps the captured view immutable when switching', async () => {
    const upload = deferred<unknown>(); state.store.mockImplementation(() => upload.promise)
    await render(); const save = button('保存到资源库')
    await act(async () => {save.click(); save.click()})
    expect(state.capture).toHaveBeenCalledTimes(1); expect(state.store).toHaveBeenCalledTimes(1)
    expect(button('保存中…').disabled).toBe(true)
    await click('3D 地图')
    expect(state.store).toHaveBeenLastCalledWith('track-a', expect.any(String), 'map', png)
    await act(async () => {upload.resolve({id: 'map-image'})})
    expect(container.textContent).toContain('二维地图已保存到资源库')
    expect(container.textContent).not.toContain('3D 地图已保存到资源库')
  })

  it('retries the failed immutable PNG instead of recapturing the newly selected view', async () => {
    state.store.mockRejectedValueOnce(new Error('资源库连接中断'))
    await render(); await click('保存到资源库')
    expect(container.textContent).toContain('资源库连接中断'); expect(button('重试保存').disabled).toBe(false)
    const first = state.store.mock.calls[0]
    await click('3D 地图'); await click('重试保存')
    expect(state.capture).toHaveBeenCalledTimes(1); expect(state.store.mock.calls[1]).toEqual(first)
    expect(container.textContent).toContain('二维地图已保存到资源库')
  })

  it('can retry an existing PNG while the newly selected sandbox is still loading', async () => {
    state.store.mockRejectedValueOnce(new Error('资源库连接中断'))
    await render(); await click('保存到资源库'); const first = state.store.mock.calls[0]
    await click('3D 沙盘'); expect(button('保存到资源库').disabled).toBe(true)
    await click('重试保存')
    expect(state.capture).toHaveBeenCalledTimes(1); expect(state.store.mock.calls[1]).toEqual(first)
    expect(container.textContent).toContain('二维地图已保存到资源库')
  })

  it('does not show an old track upload completion as a result for the newly selected track', async () => {
    const upload = deferred<unknown>(); state.store.mockImplementation(() => upload.promise)
    await render(); await click('保存到资源库')
    await render({trackId: 'track-b', name: '海岸轨迹'})
    await act(async () => {upload.resolve({id: 'map-image'})})
    expect(state.store).toHaveBeenCalledTimes(1)
    expect(state.store.mock.calls[0][0]).toBe('track-a')
    expect(container.textContent).not.toContain('已保存到资源库')
    expect(button('保存到资源库').disabled).toBe(false)
    await click('保存到资源库')
    expect(state.store.mock.calls[1][0]).toBe('track-b')
  })

  it('does not upload a PNG whose encoding completes after selecting another track', async () => {
    const encoding = deferred<Blob>(); state.capture.mockImplementation(() => encoding.promise)
    await render(); await click('保存到资源库')
    expect(state.capture).toHaveBeenCalledTimes(1); expect(state.store).not.toHaveBeenCalled()
    await render({trackId: 'track-b', name: '海岸轨迹'})
    await act(async () => {encoding.resolve(png)})
    expect(state.store).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('已保存到资源库')
    expect(button('保存到资源库').disabled).toBe(false)
  })

  it('cancels capture if the view changes before the requested frame arrives', async () => {
    await render(); const map = state.maps[0]; map.autoRender = false
    await click('保存到资源库'); await click('3D 地图')
    await act(async () => {map.emit('render')})
    expect(state.capture).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/视图.*变化|重新导出/u)
  })

  it('removes a pending render listener on unmount and never uploads after disposal', async () => {
    await render(); const map = state.maps[0]; map.autoRender = false
    await click('保存到资源库'); expect(map.handlers.get('render')?.length).toBeGreaterThan(0)
    await act(async () => {root!.unmount()}); root = null
    expect(map.handlers.get('render')).toHaveLength(0)
    expect(map.off).toHaveBeenCalledWith('render', expect.any(Function))
    await act(async () => {map.emit('render')})
    expect(state.capture).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled()
  })

  it('cancels a pending old track frame before it can reach the resource API', async () => {
    await render(); const map = state.maps[0]; map.autoRender = false
    await click('保存到资源库'); await render({trackId: 'track-b', name: '海岸轨迹'})
    await act(async () => {map.emit('render')})
    expect(state.capture).not.toHaveBeenCalled(); expect(state.store).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('已保存到资源库')
    expect(button('保存到资源库').disabled).toBe(false)
  })
})
