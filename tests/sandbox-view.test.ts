// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapView } from '../src/client/MapView.tsx'
import { readBasemap } from '../src/client/util.ts'
import { MAP_SETTINGS_KEY, readMapSettings, sanitizeMapSettings, writeMapSettings } from '../src/track/map-settings.ts'
import { SATELLITE_STYLE, type BasemapId } from '../src/track/basemaps.ts'
import { TRACK_LINE } from '../src/track/trail-layer.ts'
import type { PlacemarkGroup, TrackPlacemark, TrackPoint } from '../src/protocol.ts'
import type { SandboxPlacemark, TerrainGrid } from '../src/track/sandbox/types.ts'

type FakeRenderer = {updateLighting: ReturnType<typeof vi.fn>; updateColors: ReturnType<typeof vi.fn>; updateBackground: ReturnType<typeof vi.fn>; updatePlacemarks: ReturnType<typeof vi.fn>; updateRouteColor: ReturnType<typeof vi.fn>; loseContext: () => void; build: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn<() => void>>; zoomIn: ReturnType<typeof vi.fn>; zoomOut: ReturnType<typeof vi.fn>; resetView: ReturnType<typeof vi.fn>}
type Pending = {signal: AbortSignal; resolve: (value: Result) => void; reject: (reason: unknown) => void}
type Result = {terrain: TerrainGrid; texture: HTMLCanvasElement | null; textureUnavailable: boolean}
const state = vi.hoisted(() => ({
  maps: [] as {emit: (name: string, event?: unknown) => void; setStyle: ReturnType<typeof vi.fn<(style: typeof SATELLITE_STYLE) => void>>; remove: ReturnType<typeof vi.fn>; setTerrain: ReturnType<typeof vi.fn>; getTerrain: () => {source:string;exaggeration:number}|null; jumpTo:ReturnType<typeof vi.fn<(next: {pitch?:number; bearing?:number; zoom?:number; center?:number[]}) => void>>; fitBounds:ReturnType<typeof vi.fn>; getLayer:(id:string)=>{id:string;paint?:Record<string,unknown>}|undefined; getPitch:()=>number; getBearing:()=>number; getSource:(id:string)=>unknown}[],
  renderers: [] as FakeRenderer[], pending: [] as Pending[], sampler: vi.fn(), noWebGL: false, rendererFailure: false,
}))

vi.mock('../src/track/sandbox/sampling.ts', () => ({
  sampleSandboxDetached: state.sampler,
  isSandboxDEMError: (event: {sourceId?: string}) => event.sourceId === 'cqai-track-terrain-dem',
}))
vi.mock('../src/track/sandbox/renderer.ts', () => ({
  SandboxRenderer: class {
    build = vi.fn()
    updateLighting = vi.fn()
    updateColors = vi.fn()
    updateBackground = vi.fn()
    updatePlacemarks = vi.fn()
    updateRouteColor = vi.fn()
    zoomIn = vi.fn()
    zoomOut = vi.fn()
    resetView = vi.fn()
    dispose: ReturnType<typeof vi.fn<() => void>>
    loseContext: () => void
    constructor(container: HTMLDivElement, onContextLost?: () => void) {
      if (state.rendererFailure) throw new Error('GPU context unavailable')
      const canvas = document.createElement('canvas')
      container.appendChild(canvas)
      this.dispose = vi.fn(() => canvas.remove())
      this.loseContext = () => { this.dispose(); onContextLost?.() }
      state.renderers.push(this)
    }
  },
}))
vi.mock('maplibre-gl', () => ({
  Map: class {
    container: HTMLElement
    sources = new Map<string, {setData: ReturnType<typeof vi.fn>}>()
    layers = new Map<string, {id: string; paint?: Record<string, unknown>}>()
    handlers = new Map<string, ((event?: unknown) => void)[]>()
    style = {}
    currentTerrain: {source: string; exaggeration: number} | null = null
    camera = {center: [119.44,30.34], zoom: 12, pitch: 0, bearing: 0}
    getTerrain = () => this.currentTerrain
    setTerrain = vi.fn((next: typeof this.currentTerrain) => {this.currentTerrain=next})
    removeSource = vi.fn((id:string) => this.sources.delete(id))
    removeLayer = vi.fn((id:string) => this.layers.delete(id))
    getLayoutProperty = vi.fn()
    setLayoutProperty = vi.fn()
    setSky = vi.fn()
    setPaintProperty = vi.fn((id: string, property: string, value: unknown) => {
      const layer = this.layers.get(id)
      if (layer) {layer.paint ??= {}; layer.paint[property] = value}
    })
    getCenter = () => ({lng:this.camera.center[0],lat:this.camera.center[1]})
    getZoom = () => this.camera.zoom
    getPitch = () => this.camera.pitch
    getBearing = () => this.camera.bearing
    jumpTo = vi.fn((next: Partial<typeof this.camera>) => {this.camera={...this.camera,...next}})
    dragRotate = {enable:vi.fn(),disable:vi.fn()}
    touchPitch = {enable:vi.fn(),disable:vi.fn()}
    keyboard = {enableRotation:vi.fn(),disableRotation:vi.fn()}
    touchZoomRotate = {disableRotation: vi.fn(),enableRotation:vi.fn()}
    addControl = vi.fn()
    fitBounds = vi.fn()
    remove = vi.fn()
    getStyle = () => ({version: 8, sources: {}, layers: []})
    getSource = (id: string) => this.sources.get(id)
    getLayer = (id: string) => this.layers.get(id)
    getPaintProperty = (id: string, property: string) => this.layers.get(id)?.paint?.[property]
    addSource = (id: string) => this.sources.set(id, {setData: vi.fn()})
    addLayer = (layer: {id: string; paint?: Record<string, unknown>}) => this.layers.set(layer.id, layer)
    setStyle = vi.fn((_style: typeof SATELLITE_STYLE) => {
      this.sources.clear(); this.layers.clear(); this.style = {}; this.currentTerrain=null
      queueMicrotask(() => this.emit('styledata'))
    })
    on(name: string, handler: (event?: unknown) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]) }
    emit(name: string, event?: unknown) { for (const handler of this.handlers.get(name) ?? []) handler(event) }
    constructor(options: {container: HTMLElement}) {
      if (state.noWebGL) throw new Error('No WebGL')
      this.container = options.container
      state.maps.push(this)
    }
  },
  Marker: class {
    coordinates: [number, number] = [0, 0]
    element: HTMLButtonElement
    remove = vi.fn(() => this.element.remove())
    constructor(options: {element: HTMLButtonElement}) {this.element = options.element}
    setLngLat(coordinates: [number, number]) {this.coordinates = [...coordinates]; return this}
    getLngLat() {return {lng: this.coordinates[0], lat: this.coordinates[1]}}
    setDraggable(_value: boolean) {return this}
    on(_event: string, _handler: () => void) {return this}
    addTo(map: {container: HTMLElement}) {map.container.append(this.element); return this}
  },
  NavigationControl: class {}, AttributionControl: class {},
  LngLatBounds: class {
    constructor(private sw: number[], private ne: number[]) {}
    getWest() { return this.sw[0] } getSouth() { return this.sw[1] }
    getEast() { return this.ne[0] } getNorth() { return this.ne[1] }
  },
}))

const POINTS: TrackPoint[] = [[119.44, 30.34, null, null], [119.46, 30.36, null, null]]
const RESULT: Result = {terrain: {bounds: [119.43, 30.33, 119.47, 30.37], columns: 2, rows: 2, widthMeters: 2000, depthMeters: 2000, elevations: [600, 900, 500, 700]}, texture: null, textureUnavailable: false}
const SANDBOX_PLACEMARKS: TrackPlacemark[] = [
  {id: 'hidden', name: '隐藏单点', coordinates: [119.44, 30.34], description: '', images: [], hidden: true},
  {id: 'solo', name: '河边', coordinates: [119.445, 30.345], description: '单点说明', images: ['https://example.com/river.jpg']},
  {id: 'group-a', name: '山口', coordinates: [119.45, 30.35], description: '组内说明', images: ['https://example.com/pass.jpg']},
  {id: 'group-b', name: '隐藏子点', coordinates: [119.451, 30.351], description: '', images: [], hidden: true},
  {id: 'hidden-member', name: '隐藏组子点', coordinates: [119.455, 30.355], description: '', images: []},
  {id: 'tail', name: '终点', coordinates: [119.46, 30.36], description: '', images: []},
]
const SANDBOX_GROUPS: PlacemarkGroup[] = [
  {id: 'group-11111111-1111-1111-1111-111111111111', name: '山口合影', description: '组说明',
    memberIds: ['group-a', 'group-b'], coordinates: [119.45, 30.35]},
  {id: 'group-22222222-2222-2222-2222-222222222222', name: '隐藏组', description: '',
    memberIds: ['hidden-member'], coordinates: [119.455, 30.355], hidden: true},
]
type PlacemarkOptions = Pick<Parameters<typeof MapView>[0],
  'placemarks' | 'placemarkGroups' | 'placemarkTypeFilter' | 'selectedPlacemark' | 'onSelectPlacemark' | 'onClosePlacemark'>
function latestPlacemarkUpdate(renderer: FakeRenderer) {
  const call = renderer.updatePlacemarks.mock.calls.at(-1)
  if (!call) throw new Error('Missing sandbox placemark update')
  return call as [readonly SandboxPlacemark[], {visible: boolean; selectedId: string | null; onSelect: (id: string) => void}]
}
let root: Root | null
let container: HTMLDivElement

beforeEach(() => {
  localStorage.clear()
  state.maps = []; state.renderers = []; state.pending = []; state.noWebGL = false; state.rendererFailure = false
  state.sampler.mockReset().mockImplementation((_points, options: {signal: AbortSignal}) => new Promise<Result>((resolve, reject) => {
    state.pending.push({signal: options.signal, resolve, reject})
  }))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null; container.remove(); vi.unstubAllGlobals()
})
async function render(points = POINTS, basemap: BasemapId = 'vector', onBasemap: (next: BasemapId) => void = vi.fn(), options: PlacemarkOptions = {}) {
  await act(async () => { root!.render(createElement(MapView, {points, name: '山区轨迹', basemap, onBasemap, ...options})) })
}
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node =>
    node.getAttribute('aria-label') === text || node.textContent === text)
  if (!found) throw new Error('Missing button ' + text)
  return found
}
async function editColor(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="' + name + '"]')
  if (!input) throw new Error('Missing color setting ' + name)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}
async function selectBackground(value: 'solid' | 'environment') {
  const element = container.querySelector<HTMLSelectElement>('[role="dialog"] select[aria-label="背景模式"]')
  if (!element) throw new Error('Missing sandbox background mode')
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', {bubbles: true})) })
}
async function changeRouteColor(routeColor: string) {
  await act(async () => {
    const next = writeMapSettings({...readMapSettings(), routeColor})
    window.dispatchEvent(new StorageEvent('storage', {key: MAP_SETTINGS_KEY, newValue: JSON.stringify(next)}))
  })
}
async function click(text: string) { await act(async () => { button(text).click() }) }
async function markerVisibilityControl() {
  if (!container.querySelector('section[aria-label="标记点与路线设置"]')) await click('标记点与路线')
  const checkbox = container.querySelector<HTMLInputElement>('section[aria-label="标记点与路线设置"] input[aria-label="显示标记点"]')
  if (!checkbox) throw new Error('Missing map marker visibility checkbox')
  return checkbox
}
async function ready(index = 0, result = RESULT) { await act(async () => { state.pending[index].resolve(result) }) }
function selected(mode: 'map' | 'terrain' | 'sandbox') { return container.querySelector(`[data-track-view="${mode}"]`)?.getAttribute('aria-pressed') === 'true' }

describe('2D and sandbox view integration', () => {
  it('offers satellite imagery and remembers the explicit basemap selection', async () => {
    const onBasemap = vi.fn()
    await render(POINTS, 'vector', onBasemap)
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="地图图层"]')!.click())
    const satellite = container.querySelector<HTMLInputElement>('input[value="satellite"]')!
    expect(satellite).toBeDefined()
    await act(async () => satellite.click())
    expect(onBasemap).toHaveBeenCalledWith('satellite')
    expect(readBasemap()).toBe('satellite')
  })

  it('cancels stale terrain generation when changing to satellite and forwards its new image texture', async () => {
    await render(POINTS, 'terrain'); await click('3D 沙盘')
    const previous = state.pending[0]
    await render(POINTS, 'satellite')
    expect(previous.signal.aborted).toBe(true)
    expect(state.pending).toHaveLength(2)
    expect(state.maps[0].setStyle).toHaveBeenLastCalledWith(SATELLITE_STYLE)
    expect(state.sampler.mock.calls[1][1].textureEnabled).toBe(true)
    const staleTexture = document.createElement('canvas')
    await ready(0, {...RESULT, texture: staleTexture})
    expect(state.renderers).toHaveLength(0)
    const satelliteTexture = document.createElement('canvas')
    await ready(1, {...RESULT, texture: satelliteTexture})
    expect(state.renderers).toHaveLength(1)
    expect(state.renderers[0].build).toHaveBeenCalledWith(RESULT.terrain, POINTS, satelliteTexture, expect.objectContaining({quality: 'standard', exaggeration: 1.25}))
    expect(selected('sandbox')).toBe(true)
  })

  it('shows satellite credits on the 3D surface without attributing unrelated basemaps', async () => {
    await render(POINTS, 'satellite'); await click('3D 沙盘')
    await ready(0, {...RESULT, texture: document.createElement('canvas')})
    const attribution = container.querySelector('.trk-sandbox-attribution')!
    for (const credit of ['Mapterhorn', 'Esri', 'Vantor', 'Earthstar', 'GIS']) expect(attribution.textContent).toContain(credit)
    expect(attribution.textContent).not.toMatch(/OpenStreetMap|OpenTopoMap|OpenMapTiles/u)
    expect([...attribution.querySelectorAll('a')].some(link => link.href.includes('arcgis') || link.href.includes('esri'))).toBe(true)
  })

  it('keeps terrain colors after satellite imagery fails and explicitly retries the selected satellite style', async () => {
    await render(POINTS, 'satellite'); await click('3D 沙盘')
    const styleCalls = state.maps[0].setStyle.mock.calls.length
    await act(async () => { state.maps[0].emit('error', {sourceId: 'satellite-imagery'}) })
    expect(state.maps[0].setStyle).toHaveBeenCalledTimes(styleCalls + 1)
    await ready(0, {...RESULT, textureUnavailable: true})
    expect(selected('sandbox')).toBe(true)
    expect(state.renderers[0].build).toHaveBeenCalledWith(RESULT.terrain, POINTS, null, expect.objectContaining({quality: 'standard', exaggeration: 1.25}))
    expect(container.textContent).toContain('底图不可用，已显示地形着色')
    expect(container.querySelector('.trk-sandbox-attribution')?.textContent).not.toContain('Esri')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="地图图层"]')!.click())
    await click('重新加载当前底图')
    expect(state.renderers[0].dispose).toHaveBeenCalled()
    expect(state.maps[0].setStyle).toHaveBeenLastCalledWith(SATELLITE_STYLE)
    expect(state.sampler.mock.calls[1][1].textureEnabled).toBe(true)
    const texture = document.createElement('canvas')
    await ready(1, {...RESULT, texture})
    expect(state.renderers[1].build).toHaveBeenCalledWith(RESULT.terrain, POINTS, texture, expect.objectContaining({quality: 'standard', exaggeration: 1.25}))
    expect(container.textContent).not.toContain('底图不可用，已显示地形着色')
    expect(container.querySelector('.trk-sandbox-attribution')?.textContent).toContain('Esri')
  })

  it('does not capture a previously failed satellite style as a successful blank texture', async () => {
    await render(POINTS, 'satellite')
    await act(async () => { state.maps[0].emit('error', {sourceId: 'satellite-imagery'}) })
    await click('3D 沙盘')
    expect(state.sampler.mock.calls[0][1].textureEnabled).toBe(false)
    await ready()
    expect(container.textContent).toContain('底图不可用，已显示地形着色')
    expect(container.querySelector('.trk-sandbox-attribution')?.textContent).not.toContain('Esri')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="地图图层"]')!.click())
    await click('重新加载当前底图')
    expect(state.sampler.mock.calls[1][1].textureEnabled).toBe(true)
    await ready(1, {...RESULT, texture: document.createElement('canvas')})
    expect(container.querySelector('.trk-sandbox-attribution')?.textContent).toContain('Esri')
  })
  it('starts with the offline 2D path and initializes terrain only after the user asks', async () => {
    await render()
    expect(selected('map')).toBe(true)
    expect(state.sampler).not.toHaveBeenCalled()
    expect(state.renderers).toHaveLength(0)
    await click('3D 沙盘')
    expect(selected('sandbox')).toBe(true)
    expect(container.textContent).toContain('正在生成 3D 沙盘')
    expect(state.sampler).toHaveBeenCalledTimes(1)
    await ready()
    expect(state.renderers[0].build).toHaveBeenCalledWith(RESULT.terrain, POINTS, null, expect.objectContaining({quality: 'standard', exaggeration: 1.25}))
    expect(container.textContent).not.toContain('正在生成 3D 沙盘')
    await click('＋'); await click('－'); await click('重置视角')
    expect(state.renderers[0].zoomIn).toHaveBeenCalledOnce()
    expect(state.renderers[0].zoomOut).toHaveBeenCalledOnce()
    expect(state.renderers[0].resetView).toHaveBeenCalledOnce()
  })

  it('keeps the current sandbox when its selected tab is clicked again', async () => {
    await render(); await click('3D 沙盘'); await ready()
    await click('3D 沙盘')
    expect(state.renderers[0].dispose).not.toHaveBeenCalled()
    expect(container.querySelector('.trk-sandbox canvas')).not.toBeNull()
    expect(state.sampler).toHaveBeenCalledOnce()
  })

  it('releases a completed renderer on returning to 2D and creates a fresh one on reentry', async () => {
    await render(); await click('3D 沙盘'); await ready()
    await click('二维地图')
    expect(selected('map')).toBe(true)
    expect(state.renderers[0].dispose).toHaveBeenCalledOnce()
    expect(container.querySelector('.trk-sandbox canvas')).toBeNull()
    await click('3D 沙盘'); await ready(1)
    expect(state.renderers).toHaveLength(2)
  })

  it('aborts loading immediately and ignores a late completion after switching to 2D', async () => {
    await render(); await click('3D 沙盘')
    await click('二维地图')
    expect(state.pending[0].signal.aborted).toBe(true)
    await ready()
    expect(selected('map')).toBe(true)
    expect(state.renderers).toHaveLength(0)
    expect(container.textContent).not.toContain('暂时不可用')
  })

  it('resets a new track to 2D and prevents old terrain from appearing over it', async () => {
    await render(); await click('3D 沙盘')
    await render([[120, 31, 800, null], [120.1, 31.1, 1200, null]])
    expect(state.pending[0].signal.aborted).toBe(true)
    await ready()
    expect(selected('map')).toBe(true)
    expect(state.renderers).toHaveLength(0)
  })

  it('cancels a pending generation before changing the basemap and regenerates its texture', async () => {
    await render(); await click('3D 沙盘')
    const original = state.pending[0]
    await render(POINTS, 'terrain')
    expect(original.signal.aborted).toBe(true)
    expect(state.pending).toHaveLength(2)
    await ready(0)
    expect(state.renderers).toHaveLength(0)
    await ready(1)
    expect(state.renderers).toHaveLength(1)
    expect(selected('sandbox')).toBe(true)
  })

  it('scopes DEM errors to the sandbox while keeping the basemap style intact', async () => {
    await render(); await click('3D 沙盘')
    const calls = state.maps[0].setStyle.mock.calls.length
    await act(async () => {
      state.maps[0].emit('error', {sourceId: 'cqai-track-terrain-dem'})
      state.pending[0].reject(new Error('高程加载失败'))
    })
    expect(selected('map')).toBe(true)
    expect(state.maps[0].setStyle).toHaveBeenCalledTimes(calls)
    expect(container.textContent).toContain('高程加载失败')
    await click('重试沙盘'); await ready(1)
    expect(selected('sandbox')).toBe(true)
    expect(container.textContent).not.toContain('暂时不可用')
  })

  it('preserves a ready terrain model when its imagery fails', async () => {
    await render(); await click('3D 沙盘')
    const calls = state.maps[0].setStyle.mock.calls.length
    await act(async () => { state.maps[0].emit('error', {sourceId: 'opentopomap'}) })
    expect(state.maps[0].setStyle).toHaveBeenCalledTimes(calls + 1)
    await ready(0, {...RESULT, textureUnavailable: true})
    expect(selected('sandbox')).toBe(true)
    expect(container.textContent).toContain('底图不可用，已显示地形着色')
    expect(state.renderers).toHaveLength(1)
  })

  it('uses terrain colors when the basemap already failed, then retries imagery explicitly', async () => {
    await render()
    await act(async () => { state.maps[0].emit('error', {sourceId: 'ofm'}) })
    await click('3D 沙盘')
    expect(state.sampler.mock.calls[0][1].textureEnabled).toBe(false)
    await ready()
    expect(container.textContent).toContain('底图不可用，已显示地形着色')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="地图图层"]')!.click())
    await click('重新加载当前底图')
    expect(state.sampler.mock.calls[1][1].textureEnabled).toBe(true)
    await ready(1)
    expect(container.textContent).not.toContain('底图不可用，已显示地形着色')
  })

  it('returns to 2D with Retry after the active GPU context is lost', async () => {
    await render(); await click('3D 沙盘'); await ready()
    await act(async () => { state.renderers[0].loseContext() })
    expect(selected('map')).toBe(true)
    expect(container.textContent).toContain('图形上下文已丢失')
    expect(container.querySelector('.trk-sandbox canvas')).toBeNull()
    await click('重试沙盘'); await ready(1)
    expect(selected('sandbox')).toBe(true)
    expect(state.renderers).toHaveLength(2)
  })
  it('falls back after a renderer failure and allows an explicit retry', async () => {
    await render(); await click('3D 沙盘'); state.rendererFailure = true; await ready()
    expect(selected('map')).toBe(true)
    expect(container.textContent).toContain('GPU context unavailable')
    state.rendererFailure = false
    await click('重试沙盘'); await ready(1)
    expect(selected('sandbox')).toBe(true)
  })

  it('keeps the SVG track outline when the 2D map cannot create WebGL', async () => {
    state.noWebGL = true; await render()
    expect(button('3D 沙盘').disabled).toBe(true)
    expect(container.querySelector('svg[aria-label="轨迹轮廓"]')).not.toBeNull()
    expect(state.sampler).not.toHaveBeenCalled()
  })

  it('aborts pending data and disposes the map on unmount without accepting late results', async () => {
    await render(); await click('3D 沙盘')
    await act(async () => { root!.unmount(); root = null })
    expect(state.pending[0].signal.aborted).toBe(true)
    expect(state.maps[0].remove).toHaveBeenCalledOnce()
    await ready()
    expect(state.renderers).toHaveLength(0)
    expect(container.childElementCount).toBe(0)
  })
})


describe('native terrain and live sandbox lighting', () => {
  it('adds real terrain only in the explicit 3D mode and restores each camera', async () => {
    await render()
    const map = state.maps[0]
    expect(map.getSource('cqai-track-map-dem')).toBeUndefined()
    await click('3D 地图')
    expect(selected('terrain')).toBe(true)
    expect(selected('map')).toBe(false)
    expect(map.getTerrain()).toEqual({source:'cqai-track-map-dem',exaggeration:1.25})
    expect(map.getPitch()).toBe(60)
    await act(async()=>{map.jumpTo({pitch:72,bearing:90,zoom:13})})
    await click('二维地图')
    expect(map.getPitch()).toBe(0)
    expect(map.getSource('cqai-track-map-dem')).toBeUndefined()
    await click('3D 地图')
    expect(map.getPitch()).toBe(72)
    expect(map.getBearing()).toBe(90)
  })

  it('samples the sandbox independently of an enabled native terrain source', async () => {
    await render(); await click('3D 地图')
    const map=state.maps[0], terrain=map.getTerrain(), calls=map.setTerrain.mock.calls.length
    await click('3D 沙盘')
    expect(state.sampler.mock.calls[0][0]).toBe(POINTS)
    expect(state.sampler.mock.calls[0][1].settings.quality).toBe('standard')
    expect(map.setTerrain).toHaveBeenCalledTimes(calls)
    expect(map.getTerrain()).toEqual(terrain)
    await ready()
    expect(map.getTerrain()).toEqual(terrain)
  })

  it('returns to 2D on a native DEM error without discarding the route or its basemap', async () => {
    await render(); await click('3D 地图')
    const map=state.maps[0], calls=map.setStyle.mock.calls.length
    await act(async()=>{map.emit('error',{sourceId:'cqai-track-map-dem'})})
    expect(selected('map')).toBe(true)
    expect(map.getTerrain()).toBeNull()
    expect(map.setStyle).toHaveBeenCalledTimes(calls)
    expect(container.textContent).toContain('地形高程加载失败')
  })

  it('changes and resets lighting without sampling or rebuilding terrain, and restores local values', async () => {
    await render(); await click('3D 沙盘'); await ready()
    await click('光影')
    const input=container.querySelector<HTMLInputElement>('input[aria-label="太阳方位角"]')!
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
    await act(async()=>{setter.call(input,'90');input.dispatchEvent(new Event('input',{bubbles:true}))})
    expect(state.renderers[0].updateLighting).toHaveBeenLastCalledWith(expect.objectContaining({azimuth:90}))
    expect(state.renderers[0].build).toHaveBeenCalledOnce()
    expect(state.sampler).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem('cqai-track.map-settings')!).lighting.azimuth).toBe(90)
    const azimuth=90
    await click('二维地图'); await click('3D 沙盘'); await ready(1)
    expect(state.renderers[1].build).toHaveBeenCalledWith(RESULT.terrain,POINTS,null,expect.objectContaining({lighting:expect.objectContaining({azimuth})}))
    await click('光影'); await click('恢复默认光影')
    const defaults = {azimuth: 118, elevation: 85, intensity: 4.1, ambient: 0.65, shadows: true}
    expect(state.renderers[1].updateLighting).toHaveBeenLastCalledWith(defaults)
    expect(readMapSettings().lighting).toEqual(defaults)
    expect(state.sampler).toHaveBeenCalledTimes(2)
    expect(state.renderers[1].build).toHaveBeenCalledOnce()
  })

  it('keeps appearance drafts unapplied until save and switches backgrounds on the existing sandbox without resampling or rebuilding', async () => {
    const original = writeMapSettings(sanitizeMapSettings({sandboxColors: {sides: '#2468ac', background: '#102030'}}))
    await render(); await click('3D 沙盘'); await ready()
    const renderer = state.renderers[0], updates = renderer.updateColors.mock.calls.length
    const backgroundUpdates = renderer.updateBackground.mock.calls.length
    await click('3D 沙盘设置')
    await editColor('侧壁颜色', '#123456'); await editColor('背景颜色', '#654321')
    await selectBackground('environment')
    expect(readMapSettings()).toEqual(original)
    expect(renderer.updateColors).toHaveBeenCalledTimes(updates)
    expect(renderer.updateBackground).toHaveBeenCalledTimes(backgroundUpdates)
    await click('取消')
    expect(readMapSettings()).toEqual(original)
    expect(renderer.updateColors).toHaveBeenCalledTimes(updates)
    expect(renderer.updateBackground).toHaveBeenCalledTimes(backgroundUpdates)

    await click('3D 沙盘设置')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="侧壁颜色"]')!.value).toBe(original.sandboxColors.sides)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="背景颜色"]')!.value).toBe(original.sandboxColors.background)
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="背景模式"]')!.value).toBe(original.sandboxBackground)
    await editColor('侧壁颜色', '#123456'); await editColor('背景颜色', '#654321')
    await selectBackground('environment')
    await click('保存应用')
    const colors = {sides: '#123456', background: '#654321'}
    expect(readMapSettings()).toEqual({...original, sandboxColors: colors, sandboxBackground: 'environment'})
    expect(renderer.updateColors).toHaveBeenLastCalledWith(colors)
    expect(renderer.updateBackground).toHaveBeenLastCalledWith('environment')
    expect(container.querySelector<HTMLElement>('.trk-sandbox')!.style.backgroundColor).toBe('rgb(101, 67, 33)')
    await click('3D 沙盘设置'); await selectBackground('solid'); await click('保存应用')
    expect(renderer.updateBackground).toHaveBeenLastCalledWith('solid')
    expect(readMapSettings()).toEqual({...original, sandboxColors: colors, sandboxBackground: 'solid'})
    await changeRouteColor('#aa6611')
    expect(renderer.updateRouteColor).toHaveBeenLastCalledWith('#aa6611')
    expect(readMapSettings().routeColor).toBe('#aa6611')
    expect(state.renderers).toEqual([renderer])
    expect(renderer.build).toHaveBeenCalledOnce(); expect(renderer.dispose).not.toHaveBeenCalled()
    expect(state.sampler).toHaveBeenCalledOnce()
    expect(selected('sandbox')).toBe(true)
  })

  it('builds with the latest saved colors and background mode changed during terrain loading without restarting the sampler', async () => {
    await render(); await click('3D 沙盘')
    const pending = state.pending[0]
    await click('3D 沙盘设置')
    await editColor('侧壁颜色', '#aabbcc'); await editColor('背景颜色', '#334455')
    await selectBackground('environment')
    await click('保存应用')
    const colors = {sides: '#aabbcc', background: '#334455'}
    await changeRouteColor('#3355aa')
    expect(readMapSettings().sandboxColors).toEqual(colors)
    expect(readMapSettings().sandboxBackground).toBe('environment')
    expect(container.querySelector<HTMLElement>('.trk-sandbox-loading')!.style.backgroundColor).toBe('rgb(51, 68, 85)')
    expect(pending.signal.aborted).toBe(false)
    expect(state.pending).toEqual([pending]); expect(state.renderers).toHaveLength(0)
    expect(state.sampler).toHaveBeenCalledOnce()
    await ready()
    expect(state.renderers).toHaveLength(1)
    expect(state.renderers[0].build).toHaveBeenCalledWith(RESULT.terrain, POINTS, null, expect.objectContaining({colors, background: 'environment', routeColor: '#3355aa'}))
    expect(state.renderers[0].dispose).not.toHaveBeenCalled()
    expect(state.sampler).toHaveBeenCalledOnce()
    expect(selected('sandbox')).toBe(true)
  })

  it('projects visible points and groups with stable numbering and connects sandbox selections to existing details and photos', async () => {
    const onSelect = vi.fn(), onClose = vi.fn()
    const options = {placemarks: SANDBOX_PLACEMARKS, placemarkGroups: SANDBOX_GROUPS,
      onSelectPlacemark: onSelect, onClosePlacemark: onClose}
    await render(POINTS, 'vector', vi.fn(), options); await click('3D 沙盘'); await ready()
    const renderer = state.renderers[0]
    const [markers, selection] = latestPlacemarkUpdate(renderer)
    expect(markers).toEqual([
      expect.objectContaining({id: 'solo', coordinates: [119.445, 30.345], label: '2', title: '河边'}),
      expect.objectContaining({id: SANDBOX_GROUPS[0].id, coordinates: [119.45, 30.35], label: 'G1', title: '山口合影', groupCount: 2}),
      expect.objectContaining({id: 'tail', coordinates: [119.46, 30.36], label: '6', title: '终点'}),
    ])
    expect(selection).toMatchObject({visible: true, selectedId: null})
    await act(async () => selection.onSelect(SANDBOX_GROUPS[0].id))
    expect(onSelect).toHaveBeenLastCalledWith(SANDBOX_GROUPS[0].id)
    await render(POINTS, 'vector', vi.fn(), {...options, selectedPlacemark: 'group-a'})
    expect(latestPlacemarkUpdate(renderer)[1].selectedId).toBe(SANDBOX_GROUPS[0].id)
    const details = container.querySelector<HTMLElement>('.trk-sandbox-details')!
    expect(details.querySelector('.trk-placemark-group-details')).not.toBeNull()
    expect(details.textContent).toContain('山口合影'); expect(details.textContent).toContain('组内说明')
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe('group-a')
    await click('查看大图')
    expect(container.querySelector('.trk-placemark-photo-viewer-image')?.getAttribute('src')).toBe('https://example.com/pass.jpg')
    await click('关闭大图')
    expect(container.querySelector('.trk-placemark-photo-viewer')).toBeNull()
    await render(POINTS, 'vector', vi.fn(), {...options, selectedPlacemark: 'solo'})
    expect(latestPlacemarkUpdate(renderer)[1].selectedId).toBe('solo')
    expect(details.querySelector('.trk-placemark-group-details')).toBeNull()
    expect(details.textContent).toContain('单点说明')
    await click('关闭点位详情')
    expect(onClose).toHaveBeenCalledOnce()
    expect(renderer.build).toHaveBeenCalledOnce(); expect(state.sampler).toHaveBeenCalledOnce()
  })

  it('changes marker visibility immediately from the map display panel and clears details and photos without resampling or rebuilding', async () => {
    const options = {placemarks: SANDBOX_PLACEMARKS, placemarkGroups: SANDBOX_GROUPS}
    await render(POINTS, 'vector', vi.fn(), options)
    expect(container.querySelector('button[aria-label="显示标记点"]')).toBeNull()
    expect(button('标记点与路线')).toBeDefined()
    const mapToggle = await markerVisibilityControl()
    expect(mapToggle.checked).toBe(true)
    expect(container.querySelectorAll('.trk-map-placemark')).toHaveLength(3)
    await act(async () => mapToggle.click())
    expect(mapToggle.checked).toBe(false)
    expect(container.querySelectorAll('.trk-map-placemark')).toHaveLength(0)
    await click('3D 地图')
    expect(container.querySelector('button[aria-label="显示标记点"]')).toBeNull()
    const terrainToggle = await markerVisibilityControl()
    expect(terrainToggle.checked).toBe(false)
    expect(container.querySelectorAll('.trk-map-placemark')).toHaveLength(0)
    await act(async () => terrainToggle.click())
    expect(terrainToggle.checked).toBe(true)
    expect([...container.querySelectorAll('.trk-map-placemark')].map(marker => marker.getAttribute('aria-label'))).toEqual([
      '标注点 2：河边', '标记组 G1：山口合影，2 个子点', '标注点 6：终点',
    ])
    expect(state.sampler).not.toHaveBeenCalled()
    await click('3D 沙盘'); await ready()
    const renderer = state.renderers[0]
    await render(POINTS, 'vector', vi.fn(), {...options, selectedPlacemark: 'solo'})
    await click('查看大图')
    expect(container.querySelector('.trk-placemark-photo-viewer-image')?.getAttribute('src')).toBe('https://example.com/river.jpg')
    const toggle = await markerVisibilityControl()
    expect(toggle.type).toBe('checkbox'); expect(toggle.checked).toBe(true)
    await act(async () => toggle.focus())
    expect(document.activeElement).toBe(toggle)
    await act(async () => toggle.click())
    expect(toggle.checked).toBe(false)
    expect(button('标记点与路线').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(toggle)
    expect(readMapSettings().sandboxPlacemarks).toBe(false)
    expect(latestPlacemarkUpdate(renderer)[0]).toEqual([])
    expect(latestPlacemarkUpdate(renderer)[1]).toMatchObject({visible: false, selectedId: null})
    expect(container.querySelector('.trk-sandbox-details')?.hasAttribute('hidden')).toBe(true)
    expect(container.querySelector('.trk-sandbox-details')?.childElementCount).toBe(0)
    expect(container.querySelector('.trk-placemark-photo-viewer')).toBeNull()
    await act(async () => toggle.click())
    expect(toggle.checked).toBe(true)
    expect(button('标记点与路线').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(toggle)
    expect(readMapSettings().sandboxPlacemarks).toBe(true)
    expect(latestPlacemarkUpdate(renderer)[1]).toMatchObject({visible: true, selectedId: 'solo'})
    expect(container.querySelector('.trk-sandbox-details')?.textContent).toContain('单点说明')
    expect(state.renderers).toEqual([renderer])
    expect(renderer.build).toHaveBeenCalledOnce(); expect(renderer.dispose).not.toHaveBeenCalled()
    expect(state.sampler).toHaveBeenCalledOnce()
  })

  it('applies the latest markers, selection, callback and visibility after terrain finishes loading', async () => {
    const previousSelect = vi.fn(), latestSelect = vi.fn()
    const initial = {placemarks: SANDBOX_PLACEMARKS, placemarkGroups: SANDBOX_GROUPS, onSelectPlacemark: previousSelect}
    await render(POINTS, 'vector', vi.fn(), initial); await click('3D 沙盘')
    const pending = state.pending[0]
    const latest = SANDBOX_PLACEMARKS.map(point => ({
      ...point, type: point.id === 'tail' ? undefined : ['solo','group-a'].includes(point.id) ? '补给' : '风景',
      ...(point.id === 'solo' ? {name: '更新后的河边', coordinates: [119.447, 30.347] as [number, number]} : {}),
    }))
    await render(POINTS, 'vector', vi.fn(), {...initial, placemarks: latest, placemarkTypeFilter: ['type:补给', 'untyped'],
      selectedPlacemark: 'group-a', onSelectPlacemark: latestSelect})
    expect(button('标记点与路线').disabled).toBe(false)
    const toggle = await markerVisibilityControl()
    expect(toggle.disabled).toBe(false); expect(toggle.checked).toBe(true)
    await act(async () => toggle.click())
    expect(toggle.checked).toBe(false)
    expect(readMapSettings().sandboxPlacemarks).toBe(false)
    expect(state.pending).toEqual([pending]); expect(pending.signal.aborted).toBe(false)
    expect(state.renderers).toHaveLength(0)
    await ready()
    const renderer = state.renderers[0], [hiddenMarkers, hiddenSelection] = latestPlacemarkUpdate(renderer)
    expect(hiddenMarkers).toEqual([])
    expect(hiddenSelection).toMatchObject({visible: false, selectedId: null})
    expect(container.querySelector('.trk-sandbox-details')?.childElementCount).toBe(0)
    const currentToggle = await markerVisibilityControl()
    expect(currentToggle.checked).toBe(false)
    await act(async () => currentToggle.click())
    const [markers, selection] = latestPlacemarkUpdate(renderer)
    expect(markers.map(point => point.id)).toEqual(['solo', SANDBOX_GROUPS[0].id, 'tail'])
    expect(markers.find(point => point.id === 'solo')).toMatchObject({coordinates: [119.447, 30.347], title: '更新后的河边', label: '2'})
    expect(markers.find(point => point.id === SANDBOX_GROUPS[0].id)).toMatchObject({label: 'G1', groupCount: 1})
    expect(markers.find(point => point.id === 'tail')).toMatchObject({label: '6'})
    expect(selection).toMatchObject({visible: true, selectedId: SANDBOX_GROUPS[0].id})
    await act(async () => selection.onSelect('solo'))
    expect(latestSelect).toHaveBeenLastCalledWith('solo'); expect(previousSelect).not.toHaveBeenCalled()
    expect(renderer.build).toHaveBeenCalledOnce(); expect(state.sampler).toHaveBeenCalledOnce()
  })

  it('keeps native and sandbox markers filtered with original ordinals without changing the camera or resampling', async () => {
    const placemarks = SANDBOX_PLACEMARKS.map(point => ({
      ...point, type: point.id === 'tail' ? undefined : point.id === 'solo' || point.id === 'group-b' ? '补给' : '风景',
      ...(point.id === 'group-b' ? {hidden: false, images: ['https://example.com/supply.jpg']} : {}),
    }))
    const original = JSON.stringify({placemarks, groups: SANDBOX_GROUPS})
    const options = {placemarks, placemarkGroups: SANDBOX_GROUPS}
    await render(POINTS, 'vector', vi.fn(), options); await click('3D 地图')
    const map = state.maps[0], terrain = map.getTerrain(), fits = map.fitBounds.mock.calls.length
    await act(async () => map.jumpTo({pitch: 72, bearing: 29}))
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: 'type:风景'})
    expect(container.querySelectorAll('.trk-map-placemark')).toHaveLength(1)
    expect(container.querySelector('.trk-map-placemark')?.getAttribute('aria-label')).toBe('标记组 G1：山口合影，1 个子点')
    expect(selected('terrain')).toBe(true)
    expect(map.getPitch()).toBe(72); expect(map.getBearing()).toBe(29)
    expect(map.getTerrain()).toEqual(terrain); expect(map.fitBounds).toHaveBeenCalledTimes(fits)
    expect(state.sampler).not.toHaveBeenCalled()
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: ['type:补给', 'untyped']})
    expect([...container.querySelectorAll('.trk-map-placemark')].map(marker => marker.getAttribute('aria-label'))).toEqual([
      '标注点 2：河边', '标记组 G1：山口合影，1 个子点', '标注点 6：终点',
    ])
    expect(map.getPitch()).toBe(72); expect(map.getBearing()).toBe(29)
    expect(map.getTerrain()).toEqual(terrain); expect(map.fitBounds).toHaveBeenCalledTimes(fits)
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: 'type:风景'})
    await click('3D 沙盘'); await ready()
    const renderer = state.renderers[0]
    expect(latestPlacemarkUpdate(renderer)[0]).toEqual([
      expect.objectContaining({id: SANDBOX_GROUPS[0].id, label: 'G1', groupCount: 1}),
    ])
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: 'type:风景', selectedPlacemark: SANDBOX_GROUPS[0].id})
    expect(container.querySelector('.trk-sandbox-details')?.textContent).toContain('1 / 1')
    await click('查看大图')
    expect(container.querySelector('.trk-placemark-photo-viewer-image')?.getAttribute('src')).toBe('https://example.com/pass.jpg')
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: 'untyped', selectedPlacemark: SANDBOX_GROUPS[0].id})
    expect(latestPlacemarkUpdate(renderer)[0]).toEqual([expect.objectContaining({id: 'tail', label: '6'})])
    expect(latestPlacemarkUpdate(renderer)[1].selectedId).toBeNull()
    expect(container.querySelector('.trk-sandbox-details')?.childElementCount).toBe(0)
    expect(container.querySelector('.trk-placemark-photo-viewer')).toBeNull()
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: ['type:补给', 'untyped']})
    expect(latestPlacemarkUpdate(renderer)[0]).toEqual([
      expect.objectContaining({id: 'solo', label: '2'}),
      expect.objectContaining({id: SANDBOX_GROUPS[0].id, label: 'G1', groupCount: 1}),
      expect.objectContaining({id: 'tail', label: '6'}),
    ])
    await render(POINTS, 'vector', vi.fn(), {...options, placemarkTypeFilter: []})
    expect(latestPlacemarkUpdate(renderer)[0]).toEqual([])
    expect(latestPlacemarkUpdate(renderer)[1].selectedId).toBeNull()
    expect(container.querySelector('.trk-sandbox-details')?.childElementCount).toBe(0)
    expect(JSON.stringify({placemarks, groups: SANDBOX_GROUPS})).toBe(original)
    expect(state.renderers).toEqual([renderer]); expect(renderer.dispose).not.toHaveBeenCalled()
    expect(renderer.build).toHaveBeenCalledOnce(); expect(state.sampler).toHaveBeenCalledOnce()
  })

  it('updates the actual native route color in place and restores the latest color after a style reload', async () => {
    await render()
    const map = state.maps[0], fits = map.fitBounds.mock.calls.length, styles = map.setStyle.mock.calls.length
    await changeRouteColor('#1277aa')
    expect(map.getLayer(TRACK_LINE)?.paint?.['line-color']).toBe('#1277aa')
    expect(map.setStyle).toHaveBeenCalledTimes(styles); expect(map.fitBounds).toHaveBeenCalledTimes(fits)
    await click('3D 地图')
    await act(async () => map.jumpTo({pitch: 72, bearing: 25}))
    const terrain = map.getTerrain()
    await changeRouteColor('#bb7733')
    expect(map.getLayer(TRACK_LINE)?.paint?.['line-color']).toBe('#bb7733')
    expect(map.getTerrain()).toEqual(terrain)
    expect(map.getPitch()).toBe(72); expect(map.getBearing()).toBe(25)
    expect(map.setStyle).toHaveBeenCalledTimes(styles)
    await act(async () => map.setStyle(SATELLITE_STYLE))
    expect(map.getLayer(TRACK_LINE)?.paint?.['line-color']).toBe('#bb7733')
    expect(selected('terrain')).toBe(true)
    expect(map.getPitch()).toBe(72); expect(map.getBearing()).toBe(25)
    expect(map.fitBounds).toHaveBeenCalledTimes(fits)
    expect(state.maps).toEqual([map]); expect(state.sampler).not.toHaveBeenCalled()
  })

  it('never requests an OSM texture from the hidden sampler', async () => {
    await render(POINTS,'osm'); await click('3D 沙盘'); await ready()
    expect(state.sampler.mock.calls[0][1].textureEnabled).toBe(false)
    expect(state.maps[0].setStyle.mock.calls.at(-1)?.[0].sources).toEqual({})
    expect(container.textContent).toContain('OSM 标准图仅用于交互查看')
    expect(container.querySelector('.trk-sandbox-attribution')?.textContent).not.toContain('OpenStreetMap')
    await click('二维地图')
    expect(Object.values(state.maps[0].setStyle.mock.calls.at(-1)?.[0].sources ?? {})).toEqual(expect.arrayContaining([expect.objectContaining({type:'raster'})]))
  })
})
