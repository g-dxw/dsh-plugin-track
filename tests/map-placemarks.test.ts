// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {placemarkPhotoThumbnailUrl,placemarkPhotoOriginalUrl} from '../src/track/placemark-photo-assets.ts'
import { MapView } from '../src/client/MapView.tsx'
import { TrackOverview } from '../src/client/TrackOverview.tsx'
import {locatePlacemarkCandidates} from '../src/track/placemark-location.ts'
import { DEFAULT_MAP_SETTINGS, MAP_SETTINGS_KEY, readMapSettings, writeMapSettings } from '../src/track/map-settings.ts'
import type { PlacemarkGroup, TrackPlacemark, TrackPoint, TrackRecord } from '../src/protocol.ts'
import type { SandboxPlacemark } from '../src/track/sandbox/types.ts'

type MapStub = {on: ReturnType<typeof vi.fn>; container: HTMLElement; easeTo: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; project: ReturnType<typeof vi.fn>; unproject: ReturnType<typeof vi.fn>; fitBounds: ReturnType<typeof vi.fn>}
type MarkerStub = {
  element: HTMLButtonElement; remove: ReturnType<typeof vi.fn>; draggable: boolean; coordinates: [number, number]
  setDraggable: ReturnType<typeof vi.fn>; setLngLat: ReturnType<typeof vi.fn>
  emit: (event: string) => void
}
type PopupStub = {
  contents: HTMLElement | null
  options: {closeButton: boolean; closeOnClick: boolean}
  remove: ReturnType<typeof vi.fn<() => void>>
  off: ReturnType<typeof vi.fn>
  map: MapStub | null
  coordinates: [number, number] | null
}
type FloatingOptions = {
  visible?: boolean; selectedId?: string | null; labelColor?: string; labelSize?: number; labelHeight?: number; connectorColor?: string
  onSelect?: (id: string) => void
}
type FloatingStub = {
  map: MapStub; container: HTMLElement
  update: ReturnType<typeof vi.fn<(markers: readonly SandboxPlacemark[], options: FloatingOptions) => void>>
  getButton: ReturnType<typeof vi.fn<(id: string) => HTMLButtonElement | undefined>>
  dispose: ReturnType<typeof vi.fn<() => void>>
}
const state = vi.hoisted(() => ({
  maps: [] as MapStub[], markers: [] as MarkerStub[], popups: [] as PopupStub[], noWebGL: false,
  sampler: vi.fn(), floating: [] as FloatingStub[], renderers: [] as {updatePlacemarks: ReturnType<typeof vi.fn>}[],
  overview: {points: [] as TrackPlacemark[], groups: [] as PlacemarkGroup[]},
}))

// Keep the real Overview selection/expansion effects in the integration case;
// only its persisted data and the unrelated profile renderer are replaced.
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: () => ({
  ...state.overview, loading: false, error: '', stateError: '', retry: vi.fn(), manualOrder: false,
  orderReady: true, editReady: true, groupReady: true, routeReady: true, routeContext: {segmentStarts: [0]},
  saving: false, editing: false, grouping: false, orderError: '', editError: '', groupError: '', routeError: '',
  canUndo: false, canRedo: false,
})}))
vi.mock('../src/client/ElevationChart.tsx', () => ({ElevationChart: () => null}))
vi.mock('../src/client/maplibre-css.ts', () => ({
  MAP_STYLE: '.maplibregl-marker{left:0;position:absolute;top:0;transition:opacity .2s;will-change:transform}',
}))
vi.mock('../src/track/trail-layer.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/track/trail-layer.ts')>(), addTrack: vi.fn(),
}))
vi.mock('../src/track/sandbox/sampling.ts', () => ({sampleSandboxDetached: state.sampler, isSandboxDEMError: () => false}))
vi.mock('../src/track/sandbox/renderer.ts', () => ({
  SandboxRenderer: class {
    build = vi.fn(); dispose = vi.fn(() => {for (const button of this.buttons.values()) button.remove(); this.buttons.clear()}); zoomIn = vi.fn(); zoomOut = vi.fn(); resetView = vi.fn()
    buttons = new Map<string, HTMLButtonElement>()
    options: FloatingOptions = {}
    updatePlacemarks = vi.fn((markers: readonly SandboxPlacemark[], options: FloatingOptions) => {
      this.options = options
      const ids = new Set(markers.map(marker => marker.id))
      for (const [id, button] of this.buttons) if (!ids.has(id)) {button.remove(); this.buttons.delete(id)}
      for (const marker of markers) {
        let button = this.buttons.get(marker.id)
        if (!button) {
          button = document.createElement('button'); button.dataset.sandboxPlacemark = marker.id
          button.addEventListener('click', event => {event.stopPropagation(); if (this.options.visible !== false) this.options.onSelect?.(marker.id)})
          this.buttons.set(marker.id, button); this.container.append(button)
        }
        button.textContent = marker.title || marker.label; button.hidden = options.visible === false
        button.setAttribute('aria-pressed', String(options.selectedId === marker.id))
      }
    })
    constructor(private container: HTMLElement) {state.renderers.push(this)}
  },
}))
vi.mock('../src/track/map-floating-placemarks.ts', () => ({
  MapFloatingPlacemarkLayer: class {
    buttons = new Map<string, HTMLButtonElement>()
    options: FloatingOptions = {}
    update = vi.fn((markers: readonly SandboxPlacemark[], options: FloatingOptions) => {
      this.options = options
      const ids = new Set(markers.map(marker => marker.id))
      for (const [id, button] of this.buttons) if (!ids.has(id)) {button.remove(); this.buttons.delete(id)}
      for (const marker of markers) {
        let button = this.buttons.get(marker.id)
        if (!button) {
          button = document.createElement('button'); button.type = 'button'
          button.dataset.mapFloatingPlacemark = marker.id
          button.addEventListener('click', () => {if (this.options.visible) this.options.onSelect?.(marker.id)})
          this.buttons.set(marker.id, button); this.container.append(button)
        }
        button.textContent = marker.title || marker.label
        button.hidden = !options.visible
        button.setAttribute('aria-pressed', String(options.selectedId === marker.id))
      }
    })
    getButton = vi.fn((id: string) => this.buttons.get(id))
    dispose = vi.fn(() => {for (const button of this.buttons.values()) button.remove(); this.buttons.clear()})
    constructor(public map: MapStub, public container: HTMLElement) {state.floating.push(this)}
  },
}))
vi.mock('maplibre-gl', () => ({
  Map: class {
    container: HTMLElement
    touchZoomRotate = {disableRotation: vi.fn()}
    addControl = vi.fn()
    fitBounds = vi.fn()
    easeTo = vi.fn()
    project = vi.fn((position: {lng: number; lat: number}) => ({x: (position.lng - 120) * 1000, y: (30.1 - position.lat) * 1000}))
    unproject = vi.fn(([x, y]: [number, number]) => ({lng: 120 + x / 1000, lat: 30.1 - y / 1000}))
    setStyle = vi.fn()
    setPaintProperty = vi.fn()
    getLayer = vi.fn(() => true)
    // The marker integration fixture starts before MapLibre has loaded a style.
    getStyle = vi.fn(() => undefined)
    on = vi.fn()
    remove = vi.fn(() => {
      // Real MapLibre removal also removes its popups and emits their close events.
      for (const popup of state.popups.filter(popup => popup.map === this)) popup.remove()
    })
    constructor(options: {container: HTMLElement}) {
      if (state.noWebGL) throw new Error('No WebGL')
      this.container = options.container
      state.maps.push(this)
    }
  },
  Marker: class {
    element: HTMLButtonElement
    draggable: boolean
    coordinates: [number, number] = [0, 0]
    handlers = new Map<string, Set<() => void>>()
    remove = vi.fn(() => this.element.remove())
    setDraggable = vi.fn((value: boolean) => {this.draggable = value; return this})
    setLngLat = vi.fn((coordinates: [number, number]) => {this.coordinates = [...coordinates]; return this})
    constructor(options: {element: HTMLButtonElement; draggable: boolean}) {this.element = options.element; this.draggable = options.draggable; state.markers.push(this)}
    getLngLat() {return {lng: this.coordinates[0], lat: this.coordinates[1]}}
    on(event: string, handler: () => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set())
      this.handlers.get(event)!.add(handler)
      return this
    }
    emit(event: string) {for (const handler of this.handlers.get(event) ?? []) handler()}
    addTo(map: MapStub) {this.element.classList.add('maplibregl-marker'); map.container.append(this.element); return this}
  },
  Popup: class {
    contents: HTMLElement | null = null
    map: MapStub | null = null
    coordinates: [number, number] | null = null
    options: {closeButton: boolean; closeOnClick: boolean}
    handlers = new Map<string, Set<() => void>>()
    off = vi.fn((event: string, handler: () => void) => {this.handlers.get(event)?.delete(handler); return this})
    remove = vi.fn(() => {
      this.contents?.remove()
      this.map = null
      for (const handler of this.handlers.get('close') ?? []) handler()
    })
    constructor(options: {closeButton: boolean; closeOnClick: boolean}) {this.options = options; state.popups.push(this)}
    setLngLat(coordinates: [number, number]) {this.coordinates = [...coordinates]; return this}
    setDOMContent(contents: HTMLElement) {this.contents = contents; return this}
    addTo(map: MapStub) {this.map = map; if (this.contents) map.container.append(this.contents); return this}
    on(event: string, handler: () => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set())
      this.handlers.get(event)!.add(handler)
      return this
    }
  },
  NavigationControl: class {}, AttributionControl: class {},
  LngLatBounds: class {
    constructor(private sw: number[], private ne: number[]) {}
    getWest() {return this.sw[0]} getSouth() {return this.sw[1]}
    getEast() {return this.ne[0]} getNorth() {return this.ne[1]}
  },
}))

const POINTS: TrackPoint[] = [[120, 30, 100, null], [120.1, 30.1, 130, null]]
const PLACEMARKS: TrackPlacemark[] = [
  {id: 'a', name: '牧场', coordinates: [120, 30], description: '草地与树林\n附近有补给点', images: ['https://example.com/meadow.jpg', 'https://example.com/forest.jpg']},
  {id: 'b', name: '山口', coordinates: [120.1, 30.1], description: '经过山口后继续上行', images: ['https://example.com/pass.jpg']},
]
let root: Root | null
let container: HTMLDivElement
let closed: ReturnType<typeof vi.fn<() => void>>
let moved: ReturnType<typeof vi.fn<(id: string, coordinates: [number, number]) => void>>
let selectedFromMap: ReturnType<typeof vi.fn<(id: string) => void>>
let edited: ReturnType<typeof vi.fn<(id: string) => void>>
let dragChanged: ReturnType<typeof vi.fn<(active: boolean) => void>>
const originalShowModal=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal')
const originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close')

type MapOptions = {trackId?:string;editable?: boolean; disabled?: boolean; editDetails?: boolean; initialLocations?: TrackPlacemark[]; initialSelection?: string | null; initialGroups?: PlacemarkGroup[]; expandedPlacemarkGroups?: ReadonlySet<string>; placemarkTypeFilter?: Parameters<typeof MapView>[0]['placemarkTypeFilter']}
function ControlledMap({trackId,editable = false, disabled = false, editDetails = false, initialLocations = PLACEMARKS, initialSelection = null, initialGroups = [], expandedPlacemarkGroups, placemarkTypeFilter = 'all'}: MapOptions) {
  const [selected, setSelected] = useState<string | null>(initialSelection)
  const [locations, setLocations] = useState(initialLocations)
  const [groups, setGroups] = useState(initialGroups)
  return createElement('div', null,
    createElement('output', {'data-selection': true}, selected ?? 'none'),
    createElement(MapView, {
      trackId,points: POINTS, name: '山区轨迹', basemap: 'none', onBasemap: () => {}, placemarks: locations,
      placemarkGroups: groups, expandedPlacemarkGroups, placemarkTypeFilter,
      selectedPlacemark: selected, onSelectPlacemark: id => {selectedFromMap(id); setSelected(id)},
      onClosePlacemark: () => {closed(); setSelected(null)},
      placemarkEditingDisabled: disabled,
      onEditPlacemark: editDetails ? edited : undefined,
      onPlacemarkDragChange: editable ? dragChanged : undefined,
      onMovePlacemark: editable ? (id, coordinates) => {
        moved(id, coordinates)
        setLocations(previous => previous.map(point => point.id === id ? {...point, coordinates} : point))
        setGroups(previous => previous.map(group => group.id === id ? {...group, coordinates} : group))
      } : undefined,
    }))
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','')}})
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open')}})
  state.maps = []; state.markers = []; state.popups = []; state.renderers = []; state.floating = []; state.noWebGL = false
  state.sampler.mockReset().mockImplementation(() => new Promise(() => {}))
  state.overview = {points: PLACEMARKS, groups: [GROUP]}
  closed = vi.fn<() => void>()
  moved = vi.fn<(id: string, coordinates: [number, number]) => void>()
  selectedFromMap = vi.fn<(id: string) => void>()
  edited = vi.fn<(id: string) => void>()
  dragChanged = vi.fn<(active: boolean) => void>()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  expect(state.popups).toHaveLength(0)
  container.remove(); localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if(originalShowModal)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShowModal)
  else delete (HTMLDialogElement.prototype as unknown as Record<string,unknown>).showModal
  if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose)
  else delete (HTMLDialogElement.prototype as unknown as Record<string,unknown>).close
})
async function render(options: MapOptions = {}) {await act(async () => root!.render(createElement(ControlledMap, options)))}
function marker(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[aria-label="标注点 ${id === 'a' ? 1 : 2}：${id === 'a' ? '牧场' : '山口'}"]`)!
}
async function click(element: Element) {await act(async () => element.dispatchEvent(new MouseEvent('click', {bubbles: true})))}
function details() {return container.querySelector<HTMLElement>('[role="dialog"]')!}
function selection() {return container.querySelector('[data-selection]')!.textContent}
function detailsHost() {return container.querySelector<HTMLDivElement>('.trk-map-details')!}
function expectFixedPanel() {
  const host = detailsHost(), style = getComputedStyle(host)
  expect(container.querySelectorAll('.trk-map-details')).toHaveLength(1)
  expect(host.parentElement).toBe(mapWrapper()); expect(host.contains(details())).toBe(true)
  expect(style.position).toBe('absolute'); expect(style.left).toBe('50%'); expect(style.top).toBe('50%')
  expect(style.transform.replace(/\s/g, '')).toBe('translate(-50%,-50%)')
  expect(state.popups).toHaveLength(0)
  for (const map of state.maps) expect(map.easeTo).not.toHaveBeenCalled()
  return host
}
async function pointer(element: Element, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y})
  Object.defineProperty(event, 'pointerId', {value: pointerId})
  await act(async () => element.dispatchEvent(event))
}
function outlineRect(width = 1000, height = 700) {
  const svg = container.querySelector<SVGSVGElement>('.trk-outline')!
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({})})
  return svg
}
function expectDetails(id: 'a' | 'b') {
  const point = PLACEMARKS[id === 'a' ? 0 : 1]
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(details().getAttribute('aria-label')).toBe(`点位详情：${point.name}`)
  expect(details().textContent).toContain(point.description)
  expect([...details().querySelectorAll('img')].map(image => image.src)).toEqual(point.images)
  expectFixedPanel()
}

const GROUP: PlacemarkGroup = {id:'group-11111111-1111-4111-8111-111111111111',name:'山间风景',description:'沿线景点合辑',memberIds:['a','b'],coordinates:[120.03,30.04],cover:{pointId:'a',imageUrl:PLACEMARKS[0].images[1]}}
function groupMarker() {return container.querySelector<HTMLElement>(`[data-placemark-id="${GROUP.id}"]`)!}
function currentGroupImage() {return container.querySelector<HTMLImageElement>('.trk-placemark-group-details img')?.src}

function mapWrapper() {return container.querySelector<HTMLDivElement>('[data-track-map-view]')!}
function displayModeInput() {return container.querySelector<HTMLSelectElement>('select[aria-label="显示模式"]')!}
async function chooseDisplayMode(value: 'point' | 'marker') {
  await act(async () => {const input = displayModeInput(); input.value = value; input.dispatchEvent(new Event('change', {bubbles: true}))})
}
async function changePointStyle(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

describe('map display mode and point style integration', () => {
  it('reuses the native map and coordinate markers while switching terrain point and floating-marker modes, then disposes the helper', async () => {
    const source = JSON.stringify({points: POINTS, placemarks: PLACEMARKS})
    await render({editable: true})
    const native = state.maps[0], coordinateMarkers = [...state.markers]
    const coordinateCalls = coordinateMarkers.map(marker => marker.setLngLat.mock.calls.length)
    const fitCount = native.fitBounds.mock.calls.length
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    expect(state.floating).toHaveLength(0)
    await click(container.querySelector('[data-track-view="terrain"]')!)
    expect(mapWrapper().dataset.trackMapView).toBe('terrain')
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    await click(container.querySelector('[data-map-display-trigger]')!)
    expect(displayModeInput().value).toBe('point')
    await chooseDisplayMode('marker')
    expect(mapWrapper().dataset.placemarkMode).toBe('marker')
    expect(state.floating).toHaveLength(1)
    const floating = state.floating[0], firstUpdate = floating.update.mock.calls.at(-1)!
    const floatingPoints = firstUpdate[0], button = floating.getButton('a')!
    expect(floating.map).toBe(native)
    expect(firstUpdate[0].map(point => [point.id, point.coordinates, point.label])).toEqual([['a', PLACEMARKS[0].coordinates, '1'], ['b', PLACEMARKS[1].coordinates, '2']])
    expect(firstUpdate[1]).toMatchObject({visible: true, labelColor: '#ffffff', labelSize: 16, labelHeight: 1, connectorColor: '#ffffff'})
    expect(button.hidden).toBe(false)
    await click(button)
    expect(selectedFromMap).toHaveBeenCalledExactlyOnceWith('a')
    expect(selection()).toBe('a'); expectDetails('a')
    expect(floating.update.mock.calls.at(-1)![1]).toMatchObject({selectedId: 'a', visible: true})
    expect(floating.update.mock.calls.at(-1)![0]).toBe(floatingPoints)
    await click(details().querySelector('[aria-label="关闭点位详情"]')!)
    expect(closed).toHaveBeenCalledOnce(); expect(selection()).toBe('none')
    expect(floating.getButton).toHaveBeenLastCalledWith('a'); expect(document.activeElement).toBe(button)
    if (!container.querySelector('select[aria-label="显示模式"]')) await click(container.querySelector('[data-map-display-trigger]')!)
    await chooseDisplayMode('point')
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    expect(floating.update.mock.calls.at(-1)![1].visible).toBe(false)
    expect(floating.getButton('a')).toBe(button); expect(button.hidden).toBe(true)
    await chooseDisplayMode('marker')
    expect(state.floating).toEqual([floating])
    expect(floating.getButton('a')).toBe(button); expect(button.hidden).toBe(false)
    expect(floating.update.mock.calls.at(-1)![0]).toBe(floatingPoints)
    await click(container.querySelector('[data-track-view="map"]')!)
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    expect(container.querySelector('select[aria-label="显示模式"]')).toBeNull()
    expect(floating.update.mock.calls.at(-1)![1].visible).toBe(false)
    expect(state.maps).toHaveLength(1); expect(state.maps[0]).toBe(native); expect(native.remove).not.toHaveBeenCalled()
    expect(state.markers).toHaveLength(coordinateMarkers.length); coordinateMarkers.forEach((marker, index) => expect(state.markers[index]).toBe(marker))
    expect(coordinateMarkers.map(marker => marker.coordinates)).toEqual(PLACEMARKS.map(point => point.coordinates))
    coordinateMarkers.forEach((marker, index) => {
      expect(marker.setLngLat).toHaveBeenCalledTimes(coordinateCalls[index]); expect(marker.remove).not.toHaveBeenCalled()
    })
    // Selecting the floating label can ease the camera; switching its style does not refit the route.
    expect(native.fitBounds).toHaveBeenCalledTimes(fitCount)
    expect(moved).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce()
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS})).toBe(source)
    await act(async () => root!.unmount()); root = null
    expect(floating.dispose).toHaveBeenCalledOnce(); expect(button.isConnected).toBe(false)
    expect(native.remove).toHaveBeenCalledOnce()
    coordinateMarkers.forEach(marker => expect(marker.remove).toHaveBeenCalledOnce())
  })

  it('starts with native point and sandbox marker defaults and retains each view choice independently', async () => {
    state.sampler.mockResolvedValue({terrain: {}, texture: null, textureUnavailable: false})
    await render()
    const native = state.maps[0], coordinateMarkers = [...state.markers]
    expect(readMapSettings()).toMatchObject({terrainPlacemarkMode: 'point', sandboxPlacemarkMode: 'marker'})
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    await click(container.querySelector('[data-track-view="terrain"]')!)
    await click(container.querySelector('[data-map-display-trigger]')!)
    expect(displayModeInput().value).toBe('point')
    await chooseDisplayMode('marker')
    const floating = state.floating[0]
    await click(container.querySelector('[data-track-view="sandbox"]')!)
    expect(mapWrapper().dataset.placemarkMode).toBe('marker')
    expect(displayModeInput().value).toBe('marker')
    const renderer = state.renderers[0]
    expect(renderer.updatePlacemarks.mock.calls.at(-1)![1]).toMatchObject({mode: 'marker'})
    expect(floating.update.mock.calls.at(-1)![1].visible).toBe(false)
    await chooseDisplayMode('point')
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    expect(renderer.updatePlacemarks.mock.calls.at(-1)![1]).toMatchObject({mode: 'point', pointSize: 24, pointColor: '#c83532', groupColor: '#2563eb', pointRadius: 50})
    expect(readMapSettings()).toMatchObject({terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point'})
    await click(container.querySelector('[data-track-view="map"]')!)
    expect(mapWrapper().dataset.placemarkMode).toBe('point')
    expect(container.querySelector('select[aria-label="显示模式"]')).toBeNull()
    await click(container.querySelector('[data-track-view="terrain"]')!)
    expect(displayModeInput().value).toBe('marker'); expect(mapWrapper().dataset.placemarkMode).toBe('marker')
    expect(state.floating).toEqual([floating]); expect(floating.update.mock.calls.at(-1)![1].visible).toBe(true)
    expect(state.maps).toHaveLength(1); expect(state.maps[0]).toBe(native); expect(state.markers).toHaveLength(coordinateMarkers.length); coordinateMarkers.forEach((marker, index) => expect(state.markers[index]).toBe(marker))
    expect(coordinateMarkers.map(marker => marker.coordinates)).toEqual(PLACEMARKS.map(point => point.coordinates))
    expect(moved).not.toHaveBeenCalled(); expect(selectedFromMap).not.toHaveBeenCalled()
  })

  it.each([false, true])('updates point and group styling immediately without changing source or edit coordinates, fallback=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const source = JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})
    await render({editable: true, initialGroups: [GROUP], expandedPlacemarkGroups: new Set([GROUP.id])})
    const wrapper = mapWrapper(), point = marker('a'), group = groupMarker(), native = state.maps[0], coordinateMarkers = [...state.markers]
    const coordinateCalls = coordinateMarkers.map(marker => marker.setLngLat.mock.calls.length)
    const outline = noWebGL ? outlineRect() : null
    const route = outline?.querySelector('polyline')!, routePoints = route?.getAttribute('points')
    const badge = noWebGL ? point.querySelector<SVGRectElement>('[data-point-badge]')! : null
    const groupBadge = noWebGL ? group.querySelector<SVGRectElement>('[data-point-badge]')! : null
    const originalAnchor = noWebGL ? [point.querySelector('circle')!.getAttribute('cx'), point.querySelector('circle')!.getAttribute('cy')] : null
    if (noWebGL) {expect(group.querySelectorAll('rect')).toHaveLength(1); expect(groupBadge?.getAttribute('rx')).toBe('12'); expect(groupBadge?.getAttribute('ry')).toBe('12')}
    await click(container.querySelector('[data-map-display-trigger]')!)
    await changePointStyle('点位大小', '40'); await changePointStyle('点位圆角', '10')
    await changePointStyle('点位颜色', '#123456'); await changePointStyle('分组颜色', '#654321')
    expect(mapWrapper()).toBe(wrapper)
    expect(wrapper.style.getPropertyValue('--trk-point-size')).toBe('40px')
    expect(wrapper.style.getPropertyValue('--trk-point-color')).toBe('#123456')
    expect(wrapper.style.getPropertyValue('--trk-group-color')).toBe('#654321')
    expect(wrapper.style.getPropertyValue('--trk-point-radius')).toBe('10%')
    expect(readMapSettings()).toMatchObject({placemarkPointSize: 40, placemarkPointColor: '#123456', placemarkGroupColor: '#654321', placemarkPointRadius: 10})
    expect(marker('a')).toBe(point); expect(groupMarker()).toBe(group)
    if (noWebGL) {
      expect(point.querySelector('[data-point-badge]')).toBe(badge); expect(group.querySelector('[data-point-badge]')).toBe(groupBadge)
      expect([point.querySelector('circle')!.getAttribute('cx'), point.querySelector('circle')!.getAttribute('cy')]).toEqual(originalAnchor)
      for (const rectangle of [badge!, groupBadge!]) {
        expect(rectangle.getAttribute('width')).toBe('40'); expect(rectangle.getAttribute('height')).toBe('40'); expect(rectangle.getAttribute('rx')).toBe('4')
      }
      expect(Number(badge!.getAttribute('x'))).toBe(Number(originalAnchor![0]) - 20)
      expect(Number(badge!.getAttribute('y'))).toBe(Number(originalAnchor![1]) - 20)
      expect(badge!.getAttribute('fill')).toBe('#123456'); expect(groupBadge!.getAttribute('fill')).toBe('#654321')
      expect(route.getAttribute('points')).toBe(routePoints)
    } else {
      expect(state.maps).toHaveLength(1); expect(state.maps[0]).toBe(native); expect(native.remove).not.toHaveBeenCalled()
      expect(state.markers).toHaveLength(coordinateMarkers.length); coordinateMarkers.forEach((marker, index) => expect(state.markers[index]).toBe(marker))
      expect(coordinateMarkers.map(marker => marker.coordinates)).toEqual([GROUP.coordinates, ...PLACEMARKS.map(point => point.coordinates)])
      coordinateMarkers.forEach((marker, index) => {expect(marker.setLngLat).toHaveBeenCalledTimes(coordinateCalls[index]); expect(marker.remove).not.toHaveBeenCalled()})
    }
    for (const radius of [0, 50]) {
      await changePointStyle('点位圆角', String(radius))
      expect(wrapper.style.getPropertyValue('--trk-point-radius')).toBe(`${radius}%`)
      if (noWebGL) {
        expect(badge!.getAttribute('rx')).toBe(String(40 * radius / 100))
        expect(groupBadge!.getAttribute('rx')).toBe(String(40 * radius / 100))
      }
    }
    expect(moved).not.toHaveBeenCalled(); expect(selectedFromMap).not.toHaveBeenCalled()
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})).toBe(source)
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledTimes(1); expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120 + (noWebGL ? .1 * 20 / 840 : .02))
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30)
    expect(PLACEMARKS[0].coordinates).toEqual([120, 30]); expect(GROUP.coordinates).toEqual([120.03, 30.04])
    if (noWebGL) expect(route.getAttribute('points')).toBe(routePoints)
  })
})


describe('point names and group count display', () => {
  it.each([false, true])('toggles name and group count without recreating markers or editing coordinates, fallback=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const original = JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})
    await render({editable: true, initialGroups: [GROUP], expandedPlacemarkGroups: new Set([GROUP.id])})
    const point = marker('a'), group = groupMarker(), coordinateMarkers = [...state.markers]
    const coordinates = coordinateMarkers.map(marker => marker.coordinates)
    const nativeName = () => point.querySelector<HTMLElement>('.trk-map-placemark-name')
    const nativeCount = () => group.querySelector<HTMLElement>('.trk-map-placemark-count')
    const svgName = () => point.querySelector('[data-point-name]')
    const svgCount = () => group.querySelector('[data-point-count]')
    expect(readMapSettings()).toMatchObject({placemarkPointShowCount: true, placemarkPointShowName: false})
    if (noWebGL) {expect(svgName()).toBeNull(); expect(svgCount()).not.toBeNull()}
    else {expect(nativeName()?.hidden).toBe(true); expect(nativeCount()?.hidden).toBe(false)}
    await click(container.querySelector('[data-map-display-trigger]')!)
    await click(container.querySelector('input[aria-label="显示名称"]')!)
    await click(container.querySelector('input[aria-label="显示组内点位数量"]')!)
    expect(readMapSettings()).toMatchObject({placemarkPointShowCount: false, placemarkPointShowName: true})
    expect(marker('a')).toBe(point); expect(groupMarker()).toBe(group)
    if (noWebGL) {
      expect(svgName()?.textContent).toBe(PLACEMARKS[0].name)
      expect(group.querySelector('[data-point-name]')?.textContent).toBe(GROUP.name)
      expect(svgCount()).toBeNull()
    } else {
      expect(nativeName()?.hidden).toBe(false); expect(nativeName()?.textContent).toBe(PLACEMARKS[0].name)
      expect(group.querySelector<HTMLElement>('.trk-map-placemark-name')?.textContent).toBe(GROUP.name)
      expect(nativeCount()?.hidden).toBe(true)
      expect(state.markers).toEqual(coordinateMarkers); expect(state.markers.map(marker => marker.coordinates)).toEqual(coordinates)
    }
    expect(group.getAttribute('aria-label')).toContain('2 个子点')
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})).toBe(original)
    expect(moved).not.toHaveBeenCalled(); expect(selectedFromMap).not.toHaveBeenCalled()
    await click(container.querySelector('input[aria-label="显示名称"]')!)
    await click(container.querySelector('input[aria-label="显示组内点位数量"]')!)
    if (noWebGL) {expect(svgName()).toBeNull(); expect(svgCount()).not.toBeNull()}
    else {expect(nativeName()?.hidden).toBe(true); expect(nativeCount()?.hidden).toBe(false)}
    expect(marker('a')).toBe(point); expect(groupMarker()).toBe(group)
  })

  it('forwards names and count preferences through both live and deferred sandbox builds', async () => {
    writeMapSettings({...DEFAULT_MAP_SETTINGS, sandboxPlacemarkMode: 'point', placemarkPointShowCount: false, placemarkPointShowName: true})
    let complete!: (value: unknown) => void
    state.sampler.mockImplementationOnce(() => new Promise(resolve => {complete = resolve}))
    await render({initialGroups: [GROUP], expandedPlacemarkGroups: new Set([GROUP.id])})
    await click(container.querySelector('[data-track-view="sandbox"]')!)
    await act(async () => {complete({terrain: {}, texture: null, textureUnavailable: false})})
    const renderer = state.renderers[0]
    expect(renderer.updatePlacemarks.mock.calls.at(-1)![1]).toMatchObject({mode: 'point', pointShowCount: false, pointShowName: true})
    await click(container.querySelector('[data-map-display-trigger]')!)
    await click(container.querySelector('input[aria-label="显示组内点位数量"]')!)
    await click(container.querySelector('input[aria-label="显示名称"]')!)
    expect(renderer.updatePlacemarks.mock.calls.at(-1)![1]).toMatchObject({pointShowCount: true, pointShowName: false})
    expect(renderer.updatePlacemarks.mock.calls.at(-1)![0].find((point: SandboxPlacemark) => point.id === GROUP.id)).toMatchObject({title: GROUP.name, groupCount: 2, coordinates: GROUP.coordinates})
    expect(moved).not.toHaveBeenCalled()
  })
})

describe('expanded map groups', () => {
  it.each([false, true])('shows children at their original positions and removes them on collapse with noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const locations = [...PLACEMARKS, {id: 'c', name: '终点', coordinates: [120.08, 30.08] as [number, number], description: '', images: []}]
    const original = JSON.stringify({locations, group: GROUP})
    const options = {initialGroups: [GROUP], initialLocations: locations}
    await render(options)
    const initialFitCount = state.maps[0]?.fitBounds.mock.calls.length
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    await render({...options, expandedPlacemarkGroups: new Set([GROUP.id])})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(4)
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G1：山间风景，2 个子点')
    expect(marker('a').getAttribute('aria-label')).toBe('标注点 1：牧场')
    expect(marker('b').getAttribute('aria-label')).toBe('标注点 2：山口')
    expect(container.querySelector('[data-placemark-id="c"]')?.getAttribute('aria-label')).toBe('标注点 3：终点')
    if (noWebGL) {
      const a = marker('a').querySelector('circle')!, b = marker('b').querySelector('circle')!
      expect(Number(a.getAttribute('cx'))).toBeCloseTo(80)
      expect(Number(a.getAttribute('cy'))).toBeCloseTo(580)
      expect(Number(b.getAttribute('cx'))).toBeCloseTo(920)
      expect(Number(b.getAttribute('cy'))).toBeCloseTo(120)
    } else {
      expect(state.markers.filter(item => item.element.isConnected).map(item => [item.element.dataset.placemarkId, item.coordinates]))
        .toEqual([[GROUP.id, GROUP.coordinates], ['a', PLACEMARKS[0].coordinates], ['b', PLACEMARKS[1].coordinates], ['c', locations[2].coordinates]])
      expect(state.maps[0].fitBounds).toHaveBeenCalledTimes(initialFitCount!)
    }
    await render(options)
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    expect(marker('a')).toBeNull(); expect(marker('b')).toBeNull()
    expect(groupMarker()).not.toBeNull()
    expect(JSON.stringify({locations, group: GROUP})).toBe(original)
  })

  it.each([false, true])('uses expanded child details, editing and movement targets, then group details after collapse with noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const options = {initialGroups: [GROUP], initialSelection: 'b', editable: true, editDetails: true}
    await render({...options, expandedPlacemarkGroups: new Set([GROUP.id])})
    expectDetails('b')
    expect(marker('b').getAttribute('aria-pressed')).toBe('true')
    expect(groupMarker().getAttribute('aria-pressed')).toBe('false')
    expectFixedPanel(); expect(details().textContent).toContain('120.100000')
    await click(details().querySelector('[aria-label="编辑点位"]')!)
    expect(edited).toHaveBeenCalledExactlyOnceWith('b')
    if (noWebGL) outlineRect()
    await act(async () => marker('b').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledTimes(1)
    expect(moved.mock.calls[0][0]).toBe('b')
    expect(moved.mock.calls[0][1][0]).toBeLessThan(PLACEMARKS[1].coordinates[0])
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(PLACEMARKS[1].coordinates[1])
    expectDetails('b')
    expect(document.activeElement).toBe(marker('b'))
    expectFixedPanel(); expect(details().textContent).toContain(moved.mock.calls[0][1][0].toFixed(6))
    await render(options)
    expect(marker('b')).toBeNull()
    expect(groupMarker().getAttribute('aria-pressed')).toBe('true')
    expect(details().querySelector('[aria-label="编辑标记组"]')).not.toBeNull()
    expectFixedPanel(); expect(details().getAttribute('aria-label')).toBe(`组详情：${GROUP.name}`)
    expect(closed).not.toHaveBeenCalled()
  })

  it.each([false, true])('respects matching types, child visibility, group visibility and the global display toggle with noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const locations = [{...PLACEMARKS[0], type: '营地'}, {...PLACEMARKS[1], type: '风景'},
      {id: 'hidden', name: '隐藏营地', coordinates: [130, 40] as [number, number], description: '', images: [], type: '营地', hidden: true}]
    const group = {...GROUP, memberIds: [...GROUP.memberIds, 'hidden']}
    const renderVisibility = async (placemarkTypeFilter: Parameters<typeof MapView>[0]['placemarkTypeFilter'] = 'all', hidden = false) => act(async () => root!.render(createElement(MapView, {
      points: POINTS, name: '展开分组', basemap: 'none', onBasemap: () => {}, placemarks: locations,
      placemarkGroups: [{...group, hidden}], expandedPlacemarkGroups: new Set([GROUP.id]), placemarkTypeFilter, selectedPlacemark: 'hidden',
    })))
    await renderVisibility()
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(3)
    expect(container.querySelector('[data-placemark-id="hidden"]')).toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await renderVisibility('type:营地')
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    expect(marker('a')).not.toBeNull(); expect(marker('b')).toBeNull()
    await renderVisibility('type:风景')
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    expect(marker('a')).toBeNull(); expect(marker('b')).not.toBeNull()
    await renderVisibility([])
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
    await renderVisibility('all', true)
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
    await renderVisibility()
    await act(async () => {
      const next = writeMapSettings({...readMapSettings(), sandboxPlacemarks: false})
      window.dispatchEvent(new StorageEvent('storage', {key: MAP_SETTINGS_KEY, newValue: JSON.stringify(next)}))
    })
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
  })

  it('keeps sandbox markers and selection synchronized when expanding and collapsing a group', async () => {
    state.sampler.mockResolvedValue({terrain: {}, texture: null, textureUnavailable: false})
    const options = {initialGroups: [GROUP], initialSelection: 'b'}
    await render({...options, expandedPlacemarkGroups: new Set([GROUP.id])})
    await click(container.querySelector('[data-track-view="sandbox"]')!)
    const renderer = state.renderers[0]
    const latestMarkers = () => renderer.updatePlacemarks.mock.calls.at(-1)! as [SandboxPlacemark[], {selectedId: string | null}]
    expect(latestMarkers()[0].map(point => [point.id, point.coordinates, point.label]))
      .toEqual([[GROUP.id, GROUP.coordinates, 'G1'], ['a', PLACEMARKS[0].coordinates, '1'], ['b', PLACEMARKS[1].coordinates, '2']])
    expect(latestMarkers()[1].selectedId).toBe('b')
    expectDetails('b')
    await render(options)
    expect(latestMarkers()[0].map(point => point.id)).toEqual([GROUP.id])
    expect(latestMarkers()[1].selectedId).toBe(GROUP.id)
    expect(details().querySelector('[aria-label="编辑点位"]')).toBeNull()
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
  })
})

describe('group map markers and photo carousel',()=>{
  it('keeps grouped MapLibre markers out of document flow while anchoring their count badge',async()=>{
    await render({initialGroups:[GROUP]})
    // jsdom installs the effect's head stylesheet after React's body stylesheet.
    // Refresh the body sheet to match browsers' head-before-body cascade order.
    const componentStyle=container.querySelector('style')!
    componentStyle.parentElement!.append(componentStyle)
    const group=groupMarker(),count=group.querySelector<HTMLElement>('.trk-map-placemark-count')!
    expect(group.classList.contains('maplibregl-marker')).toBe(true)
    expect(getComputedStyle(group).position).toBe('absolute')
    expect(getComputedStyle(group).left).toBe('0px')
    expect(getComputedStyle(group).top).toBe('0px')
    expect(count.parentElement).toBe(group)
    expect(getComputedStyle(count).position).toBe('absolute')
    expect(count.textContent).toBe('2')
    expect(state.markers[0].coordinates).toEqual(GROUP.coordinates)
  })

  it.each([
    {noWebGL:false,sameCoverChild:false},{noWebGL:true,sameCoverChild:false},
    {noWebGL:false,sameCoverChild:true},{noWebGL:true,sameCoverChild:true},
  ])('returns to cover on group marker selection after a child slide, sameCoverChild=$sameCoverChild noWebGL=$noWebGL',async({noWebGL,sameCoverChild})=>{
    state.noWebGL=noWebGL
    await render({initialGroups:[GROUP]});await click(groupMarker())
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    if(sameCoverChild)await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe(GROUP.id)
    expect(currentGroupImage()).toBe(sameCoverChild?PLACEMARKS[0].images[0]:PLACEMARKS[1].images[0])
    await click(groupMarker())
    expect(selection()).toBe(GROUP.id)
    expect(selectedFromMap).toHaveBeenLastCalledWith(GROUP.id)
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    const profileSelected=selection()===GROUP.id?GROUP.cover!.pointId:selection()
    expect(details().querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(profileSelected)
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
  })

  it.each([false,true])('returns to cover when the parent selects the group row after a child selection with noWebGL=%s',async noWebGL=>{
    state.noWebGL=noWebGL
    const renderSelection=async(selectedPlacemark:string)=>act(async()=>root!.render(createElement(MapView,{
      points:POINTS,name:'组行选择',basemap:'none',onBasemap:()=>{},placemarks:PLACEMARKS,placemarkGroups:[GROUP],selectedPlacemark,
      onSelectPlacemark:selectedFromMap,onClosePlacemark:closed,
    })))
    await renderSelection('b')
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await renderSelection(GROUP.id)
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect(details().querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(GROUP.cover!.pointId)
    expect(selectedFromMap).not.toHaveBeenCalled()
  })

  it.each([false,true])('applies a saved cover immediately when group selection remains active with noWebGL=%s',async noWebGL=>{
    state.noWebGL=noWebGL
    const renderCover=async(cover:PlacemarkGroup['cover'])=>act(async()=>root!.render(createElement(MapView,{
      points:POINTS,name:'保存封面',basemap:'none',onBasemap:()=>{},placemarks:PLACEMARKS,placemarkGroups:[{...GROUP,cover}],
      selectedPlacemark:GROUP.id,onSelectPlacemark:selectedFromMap,onClosePlacemark:closed,
    })))
    await renderCover(GROUP.cover)
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await renderCover({pointId:'b',imageUrl:PLACEMARKS[1].images[0]})
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(details().querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe('b')
    expect(details().textContent).toContain(PLACEMARKS[1].description)
    expect(selectedFromMap).not.toHaveBeenCalled()
  })

  it.each([false,true])('defers a changed cover for a selected child and applies it when parent subsequently selects group with noWebGL=%s',async noWebGL=>{
    state.noWebGL=noWebGL
    const renderSelection=async(cover:PlacemarkGroup['cover'],selectedPlacemark:string)=>act(async()=>root!.render(createElement(MapView,{
      points:POINTS,name:'抽屉保存选择',basemap:'none',onBasemap:()=>{},placemarks:PLACEMARKS,placemarkGroups:[{...GROUP,cover}],
      selectedPlacemark,onSelectPlacemark:selectedFromMap,onClosePlacemark:closed,
    })))
    await renderSelection(GROUP.cover,'a')
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    const cover={pointId:'b',imageUrl:PLACEMARKS[1].images[0]}
    await renderSelection(cover,'a')
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await renderSelection(cover,GROUP.id)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0])
    expect(selectedFromMap).not.toHaveBeenCalled()
  })

  it.each([
    {noWebGL:false,method:'button'}, {noWebGL:true,method:'button'},
    {noWebGL:false,method:'Escape'}, {noWebGL:true,method:'Escape'}, {noWebGL:false,method:'map'},
  ])('opens the default cover after closing through $method with noWebGL=$noWebGL',async({noWebGL,method})=>{
    state.noWebGL=noWebGL
    await render({initialGroups:[GROUP]});await click(groupMarker())
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    if(method==='map')await click(container.querySelector('.trk-map')!)
    else if(method==='Escape')await act(async()=>details().querySelector('[aria-label="关闭点位详情"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
    else await click(details().querySelector('[aria-label="关闭点位详情"]')!)
    expect(selection()).toBe('none');expect(container.querySelector('[role="dialog"]')).toBeNull()
    await click(groupMarker())
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect(details().textContent).toContain('2 / 3')
    expect(closed).toHaveBeenCalledOnce()
  })

  it.each([false,true])('preserves an open slide on cover changes, then opens the new cover with noWebGL=%s',async noWebGL=>{
    state.noWebGL=noWebGL
    function CoverMap({cover}:{cover:PlacemarkGroup['cover']}){
      const[selected,setSelected]=useState<string|null>(null)
      return createElement(MapView,{points:POINTS,name:'组封面',basemap:'none',onBasemap:()=>{},placemarks:PLACEMARKS,
        placemarkGroups:[{...GROUP,cover}],selectedPlacemark:selected,onSelectPlacemark:setSelected,onClosePlacemark:()=>setSelected(null)})
    }
    await act(async()=>root!.render(createElement(CoverMap,{cover:GROUP.cover})))
    await click(groupMarker());await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    const cover={pointId:'a',imageUrl:PLACEMARKS[0].images[0]}
    await act(async()=>root!.render(createElement(CoverMap,{cover})))
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await click(details().querySelector('[aria-label="关闭点位详情"]')!);await click(groupMarker())
    expect(currentGroupImage()).toBe(cover.imageUrl)
    expect(details().textContent).toContain('1 / 3')
  })

  it('uses the cover after the parent clears and reopens group selection without a user close callback',async()=>{
    const renderSelection=async(selectedPlacemark:string|null)=>act(async()=>root!.render(createElement(MapView,{
      points:POINTS,name:'外部选择',basemap:'none',onBasemap:()=>{},placemarks:PLACEMARKS,placemarkGroups:[GROUP],selectedPlacemark,
      onSelectPlacemark:selectedFromMap,onClosePlacemark:closed,
    })))
    await renderSelection(GROUP.id)
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await renderSelection(null);expect(container.querySelector('[role="dialog"]')).toBeNull()
    await renderSelection(GROUP.id)
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect(closed).not.toHaveBeenCalled()
  })

  it.each([false,true])('renders one group marker, keeps leaf ordinals, and selects a child with noWebGL=%s',async noWebGL=>{
    state.noWebGL=noWebGL
    await render({initialGroups:[GROUP],initialSelection:'b',initialLocations:[...PLACEMARKS,{id:'c',name:'终点',coordinates:[120.08,30.08],description:'',images:[]}]})
    expect(container.querySelector('[data-placemark-id="a"]')).toBeNull()
    expect(container.querySelector('[data-placemark-id="b"]')).toBeNull()
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    expect(groupMarker().getAttribute('aria-pressed')).toBe('true')
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G1：山间风景，2 个子点')
    expect(container.querySelector('[data-placemark-id="c"]')?.getAttribute('aria-label')).toBe('标注点 3：终点')
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(details().textContent).toContain(PLACEMARKS[1].description)
    expect(details().textContent).toContain('120.100000')
    expect(details().textContent).not.toContain('120.030000')
    expectFixedPanel()
    if(noWebGL) {expect(groupMarker().querySelectorAll('rect')).toHaveLength(1); expect(groupMarker().querySelector('[data-point-badge]')?.getAttribute('fill')).toBe('#2563eb')}
  })

  it('starts at cover, wraps across children, and retains same-child photo and navigation focus after rebuilding',async()=>{
    await render({initialGroups:[GROUP]});await click(groupMarker())
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    expect(details().textContent).toContain('2 / 3')
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('下一张组图片')
    await act(async()=>details().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})))
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await render({initialGroups:[GROUP],disabled:true})
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await click(groupMarker())
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    expect(closed).not.toHaveBeenCalled()
  })

  it('keeps the large viewer open while changing children and same-child images and syncs the fixed card',async()=>{
    await render({initialGroups:[GROUP]});await click(groupMarker())
    await click(details().querySelector('.trk-placemark-details-view')!)
    const viewer=container.querySelector<HTMLDialogElement>('dialog')!
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[1])
    await click(viewer.querySelector('[aria-label="下一张大图"]')!)
    expect(container.querySelector('dialog')).toBe(viewer);expect(viewer.open).toBe(true)
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[1].images[0])
    expect(selection()).toBe(GROUP.id);expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await act(async()=>viewer.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
    expect(selection()).toBe(GROUP.id);expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[0])
    await click(viewer.querySelector('[aria-label="下一张大图"]')!)
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[1])
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await click(viewer.querySelector('[aria-label="关闭大图"]')!)
    expect(container.querySelector('dialog')).toBeNull();expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    expect(document.activeElement).toBe(details().querySelector('.trk-placemark-details-view'))
    expect(closed).not.toHaveBeenCalled()
  })

  it('shows a selected hidden child metadata and union types without its image or a different child image',async()=>{
    await render({initialGroups:[GROUP],initialSelection:'a',initialLocations:[{...PLACEMARKS[0],hidden:true,type:['营地'],elevation:101}, {...PLACEMARKS[1],type:['风景']}]})
    expect(currentGroupImage()).toBeUndefined()
    expect(details().textContent).toContain(PLACEMARKS[0].description)
    expect(details().textContent).toContain('101')
    expect([...details().querySelectorAll('.trk-placemark-details-type')].map(badge=>badge.textContent)).toEqual(['营地','风景'])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe('a');expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(selectedFromMap).not.toHaveBeenCalled()
  })

  it.each([false,true])('omits a fully hidden group and its details with noWebGL=%s',async noWebGL=>{
    state.noWebGL=noWebGL
    await render({initialGroups:[GROUP],initialSelection:GROUP.id,initialLocations:PLACEMARKS.map(point=>({...point,hidden:true}))})
    expect(groupMarker()).toBeNull();expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
  })

  it('does not show readonly edit, disables busy editing, and edits the group rather than current child',async()=>{
    await render({initialGroups:[GROUP],initialSelection:'a'})
    expect(details().querySelector('.trk-placemark-details-edit')).toBeNull()
    expect(state.markers[0].draggable).toBe(false)
    await render({initialGroups:[GROUP],editable:true,editDetails:true,disabled:true})
    expect(details().querySelector<HTMLButtonElement>('[aria-label="编辑标记组"]')!.disabled).toBe(true)
    expect(state.markers[0].draggable).toBe(false)
    await render({initialGroups:[GROUP],editable:true,editDetails:true})
    await click(details().querySelector('[aria-label="编辑标记组"]')!)
    expect(edited).toHaveBeenCalledExactlyOnceWith(GROUP.id)
  })

  it('moves only the group marker and resets the transient drag before publishing its location',async()=>{
    await render({initialGroups:[GROUP],editable:true})
    const dragged=state.markers[0]
    await act(async()=>dragged.emit('dragstart'))
    dragged.coordinates=[120.07,30.08]
    await act(async()=>dragged.emit('dragend'))
    expect(moved).toHaveBeenCalledExactlyOnceWith(GROUP.id,[120.07,30.08])
    expect(dragged.setLngLat).toHaveBeenCalledWith(GROUP.coordinates)
    expectFixedPanel(); expect(groupMarker().getAttribute('aria-pressed')).toBe('true')
    expect(details().textContent).toContain('120.000000')
    expect(PLACEMARKS[0].coordinates).toEqual([120,30])
  })

  it('supports group dragging and Alt+arrows in the SVG fallback without changing the route',async()=>{
    state.noWebGL=true
    await render({initialGroups:[GROUP],editable:true})
    const svg=outlineRect(),path=svg.querySelector('polyline')!.getAttribute('points')
    await pointer(groupMarker(),'pointerdown',332,396)
    await pointer(svg,'pointermove',500,350)
    await pointer(svg,'pointerup',500,350)
    expect(moved.mock.calls[0][0]).toBe(GROUP.id)
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.05)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30.05)
    expect(svg.querySelector('polyline')!.getAttribute('points')).toBe(path)
    await act(async()=>groupMarker().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true,cancelable:true})))
    expect(moved.mock.calls[1][0]).toBe(GROUP.id)
    expect(moved.mock.calls[1][1][0]).toBeCloseTo(120.05+.1*20/840)
    expect(document.activeElement).toBe(groupMarker())
  })
})

describe('fixed canvas details and gallery selection boundaries', () => {
  it.each([false, true])('keeps a real Overview group collapsed through thumbnail and large-photo navigation, noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const original = JSON.stringify(state.overview), pointReference = state.overview.points, groupReference = state.overview.groups
    const track = {id: 'overview-gallery', format: 'kml', name: '真实父级轮播', coordinates: POINTS,
      segmentStarts: [0], metrics: {elevationMax: 130}, placemarks: PLACEMARKS} as TrackRecord
    await act(async () => root!.render(createElement(TrackOverview, {track, basemap: 'none', onBasemap: vi.fn()})))
    await click(mapWrapper().querySelector(`[data-placemark-id="${GROUP.id}"]`)!)
    const host = expectFixedPanel(), children = container.querySelector<HTMLElement>(`[id="children-${GROUP.id}"]`)!
    const groupRow = container.querySelector<HTMLButtonElement>('.trk-overview-group-point')!
    const imageSource = (rendered: string | undefined, size: 'thumbnail' | 'original') => {
      expect(rendered).toBeDefined()
      const asset = new URL(rendered!, window.location.href), source = asset.searchParams.get('source')
      expect(asset.searchParams.get('id')).toBe(track.id); expect(asset.searchParams.get('size')).toBe(size)
      expect(source).not.toBeNull()
      const expected = size === 'thumbnail' ? placemarkPhotoThumbnailUrl(track.id, source!) : placemarkPhotoOriginalUrl(track.id, source!)
      expect(asset.href).toBe(new URL(expected, window.location.href).href)
      return source
    }
    const assertCollapsed = () => {
      expect(children.hidden).toBe(true); expect(groupRow.getAttribute('aria-expanded')).toBe('false')
      expect(groupRow.getAttribute('aria-pressed')).toBe('true')
      expect(mapWrapper().querySelectorAll('[data-placemark-id]')).toHaveLength(1)
      expect(mapWrapper().querySelector('[data-placemark-id="a"]')).toBeNull()
      expect(detailsHost()).toBe(host); expect(detailsHost().querySelector('.trk-placemark-group-details')).not.toBeNull()
    }
    assertCollapsed(); expect(imageSource(currentGroupImage(), 'thumbnail')).toBe(GROUP.cover!.imageUrl)
    for (const expected of [PLACEMARKS[1].images[0], PLACEMARKS[0].images[0], PLACEMARKS[0].images[1]]) {
      await click(details().querySelector('[aria-label="下一张组图片"]')!)
      expect(imageSource(currentGroupImage(), 'thumbnail')).toBe(expected); assertCollapsed()
    }
    await click(details().querySelector('.trk-placemark-details-view')!)
    const viewer = container.querySelector<HTMLDialogElement>('dialog')!
    for (const expected of [PLACEMARKS[1].images[0], PLACEMARKS[0].images[0]]) {
      await click(viewer.querySelector('[aria-label="下一张大图"]')!)
      expect(container.querySelector('dialog')).toBe(viewer); expect(viewer.open).toBe(true)
      expect(imageSource(viewer.querySelector('img')?.src, 'original')).toBe(expected); assertCollapsed()
    }
    await click(viewer.querySelector('[aria-label="关闭大图"]')!)
    expect(imageSource(currentGroupImage(), 'thumbnail')).toBe(PLACEMARKS[0].images[0]); assertCollapsed()
    expect(document.activeElement).toBe(details().querySelector('.trk-placemark-details-view'))
    expect(state.overview.points).toBe(pointReference); expect(state.overview.groups).toBe(groupReference)
    expect(JSON.stringify(state.overview)).toBe(original)
  })

  it.each([
    {view: 'map', mode: 'point', noWebGL: false}, {view: 'map', mode: 'point', noWebGL: true},
    {view: 'terrain', mode: 'point', noWebGL: false}, {view: 'terrain', mode: 'marker', noWebGL: false},
    {view: 'sandbox', mode: 'point', noWebGL: false}, {view: 'sandbox', mode: 'marker', noWebGL: false},
  ] as const)('uses the same centered host and preserves group selection in $view/$mode, noWebGL=$noWebGL', async ({view, mode, noWebGL}) => {
    state.noWebGL = noWebGL; state.sampler.mockResolvedValue({terrain: {}, texture: null, textureUnavailable: false})
    writeMapSettings({...DEFAULT_MAP_SETTINGS, terrainPlacemarkMode: mode, sandboxPlacemarkMode: mode})
    await render({initialGroups: [GROUP]})
    const host = detailsHost(), original = JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})
    if (view !== 'map') await click(container.querySelector(`[data-track-view="${view}"]`)!)
    const activeMarker = () => view === 'sandbox' ? container.querySelector<HTMLButtonElement>(`[data-sandbox-placemark="${GROUP.id}"]`)!
      : view === 'terrain' && mode === 'marker' ? state.floating[0].getButton(GROUP.id)! : groupMarker()
    await click(activeMarker()); expectFixedPanel(); expect(detailsHost()).toBe(host)
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl); expect(selection()).toBe(GROUP.id)
    const fitCalls = state.maps[0]?.fitBounds.mock.calls.length, callbackCount = selectedFromMap.mock.calls.length
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0]); expect(selection()).toBe(GROUP.id)
    await act(async () => details().dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true})))
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0]); expect(selection()).toBe(GROUP.id)
    expect(selectedFromMap).toHaveBeenCalledTimes(callbackCount)
    await click(details().querySelector('.trk-placemark-details-view')!)
    const viewer = container.querySelector<HTMLDialogElement>('dialog')!
    await click(viewer.querySelector('[aria-label="下一张大图"]')!)
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl); expect(container.querySelector('dialog')).toBe(viewer)
    expect(selection()).toBe(GROUP.id); expect(selectedFromMap).toHaveBeenCalledTimes(callbackCount)
    await click(viewer.querySelector('[aria-label="关闭大图"]')!)
    expectFixedPanel(); expect(detailsHost()).toBe(host)
    expect(document.activeElement).toBe(details().querySelector('.trk-placemark-details-view'))
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0]); expect(selectedFromMap).toHaveBeenCalledTimes(callbackCount)
    await click(activeMarker())
    expect(selection()).toBe(GROUP.id); expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect(selectedFromMap).toHaveBeenCalledTimes(callbackCount + 1)
    await click(details().querySelector('[aria-label="关闭点位详情"]')!)
    expect(closed).toHaveBeenCalledOnce(); expect(selection()).toBe('none'); expect(document.activeElement).toBe(activeMarker())
    expect(detailsHost()).toBe(host); expect(host.children).toHaveLength(0)
    if (state.maps[0]) {expect(state.maps[0].fitBounds).toHaveBeenCalledTimes(fitCalls!); expect(state.maps[0].easeTo).not.toHaveBeenCalled()}
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})).toBe(original)
  })

  it.each([false, true])('honors external child selection, lets its gallery cross children locally, and relocates only on a later external child selection, noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const renderSelection = (selectedPlacemark: string) => act(async () => root!.render(createElement(MapView, {
      points: POINTS, name: '外部子点选择', basemap: 'none', onBasemap: vi.fn(), placemarks: PLACEMARKS,
      placemarkGroups: [GROUP], selectedPlacemark, onSelectPlacemark: selectedFromMap, onClosePlacemark: closed,
    })))
    await renderSelection('a'); const host = expectFixedPanel()
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0]); expect(selectedFromMap).not.toHaveBeenCalled()
    await renderSelection('a'); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await renderSelection('b'); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0])
    await renderSelection('a'); expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0])
    expect(detailsHost()).toBe(host); expect(selectedFromMap).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled()
  })

  it.each([false, true])('clears a remembered group photo for an externally selected child without photos, and keeps that child metadata through unrelated renders, noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const empty: TrackPlacemark = {id: 'no-photo', name: '无图观景点', coordinates: [120.06, 30.05],
      description: '这个子点没有照片，仍应保留自己的信息', images: [], elevation: 188}
    const locations = [...PLACEMARKS, empty], group = {...GROUP, memberIds: [...GROUP.memberIds, empty.id]}
    const original = JSON.stringify({locations, group})
    const renderSelection = (selectedPlacemark: string, placemarkEditingDisabled = false) => act(async () => root!.render(createElement(MapView, {
      points: POINTS, name: '无图子点外部选择', basemap: 'none', onBasemap: vi.fn(), placemarks: locations, placemarkGroups: [group],
      selectedPlacemark, placemarkEditingDisabled, onSelectPlacemark: selectedFromMap, onClosePlacemark: closed,
    })))
    await renderSelection(group.id); await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await renderSelection(empty.id); const host = expectFixedPanel()
    const assertEmptyChild = () => {
      expect(currentGroupImage()).toBeUndefined(); expect(details().querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(empty.id)
      expect(details().textContent).toContain(empty.name); expect(details().textContent).toContain(empty.description)
      expect(details().textContent).toContain('188'); expect(details().textContent).not.toContain(PLACEMARKS[1].description)
    }
    assertEmptyChild(); await renderSelection(empty.id, true); assertEmptyChild()
    expect(detailsHost()).toBe(host); expect(selectedFromMap).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled()
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0]); expect(selectedFromMap).not.toHaveBeenCalled()
    await renderSelection(empty.id, false)
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0]); expect(detailsHost()).toBe(host)
    expect(JSON.stringify({locations, group})).toBe(original)
  })

  it.each(['drag', 'keyboard'] as const)('keeps a non-cover SVG group slide while moving its position with %s', async method => {
    state.noWebGL = true
    const original = JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})
    await render({initialGroups: [GROUP], editable: true}); await click(groupMarker())
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0]); expect(selection()).toBe(GROUP.id)
    const host = expectFixedPanel(), svg = outlineRect(), route = svg.querySelector('polyline')!.getAttribute('points')
    if (method === 'drag') {
      await pointer(groupMarker(), 'pointerdown', 332, 396)
      await pointer(svg, 'pointermove', 500, 350); await pointer(svg, 'pointerup', 500, 350)
      expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.05); expect(moved.mock.calls[0][1][1]).toBeCloseTo(30.05)
    } else {
      await act(async () => groupMarker().dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
      expect(moved.mock.calls[0][1][0]).toBeCloseTo(GROUP.coordinates[0] + .1 * 20 / 840)
      expect(document.activeElement).toBe(groupMarker())
    }
    expect(moved).toHaveBeenCalledTimes(1); expect(moved.mock.calls[0][0]).toBe(GROUP.id)
    expect(selection()).toBe(GROUP.id); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(details().querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe('b')
    expect(detailsHost()).toBe(host); expectFixedPanel(); expect(closed).not.toHaveBeenCalled()
    expect(svg.querySelector('polyline')!.getAttribute('points')).toBe(route)
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group: GROUP})).toBe(original)
  })

  it('isolates card pointer, click, wheel and carousel keyboard events from the map and closes only on the background', async () => {
    await render({initialGroups: [GROUP]}); await click(groupMarker())
    const host = expectFixedPanel(), mapEvents = vi.fn(), names = ['pointerdown', 'click', 'dblclick', 'wheel', 'keydown']
    for (const name of names) document.body.addEventListener(name, mapEvents)
    const target = details().querySelector('.trk-placemark-details-description')!
    for (const name of ['pointerdown', 'click', 'dblclick', 'wheel']) await act(async () => target.dispatchEvent(new Event(name, {bubbles: true, cancelable: true})))
    await act(async () => details().dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true})))
    expect(mapEvents).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled(); expect(selection()).toBe(GROUP.id)
    expect(detailsHost()).toBe(host); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    for (const name of names) document.body.removeEventListener(name, mapEvents)
    await click(container.querySelector('.trk-map')!)
    expect(closed).toHaveBeenCalledOnce(); expect(selection()).toBe('none'); expect(document.activeElement).toBe(groupMarker())
  })

  it.each([false, true])('keeps the current card after a background drag or rotation and closes after a separate background click, noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    await render(); await click(marker('a')); const host = expectFixedPanel()
    const surface = container.querySelector(noWebGL ? '.trk-outline' : '.trk-map')!
    await pointer(surface, 'pointerdown', 100, 100)
    await pointer(surface, 'pointermove', 150, 130)
    await pointer(surface, 'pointerup', 150, 130)
    await click(surface)
    expect(selection()).toBe('a'); expectDetails('a'); expect(detailsHost()).toBe(host); expect(closed).not.toHaveBeenCalled()
    await pointer(surface, 'pointerdown', 160, 140); await pointer(surface, 'pointerup', 160, 140)
    await click(surface)
    expect(selection()).toBe('none'); expect(closed).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(marker('a'))
  })

  it('adapts its fixed card to canvas resize without moving the map on open, image load or local photo navigation', async () => {
    const observers: {callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>}[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn()
      constructor(public callback: ResizeObserverCallback) {observers.push(this)}
    })
    await render({initialGroups: [GROUP]})
    let width = 640, height = 480
    for (const canvas of [mapWrapper(), container.querySelector<HTMLElement>('.trk-map')!]) Object.defineProperties(canvas, {
      clientWidth: {configurable: true, get: () => width}, clientHeight: {configurable: true, get: () => height},
    })
    await click(groupMarker()); const host = expectFixedPanel()
    const fitCalls = state.maps[0].fitBounds.mock.calls.length
    await act(async () => {
      for (const image of details().querySelectorAll('img')) image.dispatchEvent(new Event('load'))
      for (const observer of observers) observer.callback([], observer as unknown as ResizeObserver)
    })
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    width = 180; height = 190
    await act(async () => {
      for (const observer of observers) observer.callback([], observer as unknown as ResizeObserver)
      window.dispatchEvent(new Event('resize'))
    })
    expectFixedPanel(); expect(detailsHost()).toBe(host); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(observers.some(observer => observer.observe.mock.calls.some(([element]) => element === mapWrapper() || element === container.querySelector('.trk-map')))).toBe(true)
    const card = detailsHost().querySelector<HTMLElement>('.trk-placemark-details')!
    expect(parseFloat(card.style.width)).toBeGreaterThan(0); expect(parseFloat(card.style.width)).toBeLessThanOrEqual(width - 16)
    expect(parseFloat(details().style.maxHeight)).toBeGreaterThan(0); expect(parseFloat(details().style.maxHeight)).toBeLessThanOrEqual(height - 16)
    expect(state.maps[0].easeTo).not.toHaveBeenCalled(); expect(state.maps[0].fitBounds).toHaveBeenCalledTimes(fitCalls)
    await act(async () => root!.unmount()); root = null
    expect(observers.every(observer => observer.disconnect.mock.calls.length >= 1)).toBe(true)
    expect(closed).not.toHaveBeenCalled()
  })
})

describe('map placemark details with controlled selection', () => {
  it.each(['button','Escape'] as const)('views a linked photo and closes it via %s while preserving the point',async method=>{
    await render();await click(marker('a'))
    const host=expectFixedPanel(), contents=details()
    await click(details().querySelector('[aria-label="查看图片 2 大图"]')!)
    const viewer=container.querySelector<HTMLDialogElement>('dialog')!
    expect(viewer.open).toBe(true)
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[1])
    if(method==='button')await click(viewer.querySelector('[aria-label="关闭大图"]')!)
    else await act(async()=>viewer.dispatchEvent(new Event('cancel',{cancelable:true,bubbles:true})))
    expect(container.querySelector('dialog')).toBeNull()
    expect(selection()).toBe('a')
    expectDetails('a')
    expect(detailsHost()).toBe(host); expect(details()).toBe(contents)
    expect(closed).not.toHaveBeenCalled()
  })
  it('clears an open large photo when switching the selected point',async()=>{
    await render();await click(marker('a'))
    await click(details().querySelector('.trk-placemark-details-view')!)
    expect(container.querySelector('dialog')).not.toBeNull()
    await click(marker('b'))
    expect(container.querySelector('dialog')).toBeNull()
    expect(selection()).toBe('b')
    expectDetails('b')
  })
  it('opens the point description and linked photos directly from its marker', async () => {
    await render()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(state.markers).toHaveLength(2)
    await click(marker('a'))
    expect(selection()).toBe('a')
    expectDetails('a')
    expect(marker('a').getAttribute('aria-pressed')).toBe('true')
    expectFixedPanel(); expect(state.markers[0].coordinates).toEqual(PLACEMARKS[0].coordinates)
  })

  it('replaces the fixed card contents without clearing the newly selected point or recreating its host', async () => {
    await render(); await click(marker('a'))
    const host = expectFixedPanel(), previous = details()
    await click(marker('b'))
    expect(previous.isConnected).toBe(false); expect(detailsHost()).toBe(host)
    expect(closed).not.toHaveBeenCalled()
    expect(selection()).toBe('b')
    expectDetails('b')
    expect(marker('b').getAttribute('aria-pressed')).toBe('true')
    expect(marker('a').getAttribute('aria-pressed')).toBe('false')
  })

  it('clears selection on a map background click so the same marker can reopen', async () => {
    await render(); await click(marker('a'))
    const host = expectFixedPanel()
    await click(container.querySelector('.trk-map')!)
    expect(closed).toHaveBeenCalledOnce()
    expect(selection()).toBe('none')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(marker('a'))
    await click(marker('a'))
    expectDetails('a')
    expectFixedPanel(); expect(detailsHost()).toBe(host)
  })

  it.each(['button', 'Escape'] as const)('closes via %s and allows the same point to reopen', async method => {
    await render(); await click(marker('a'))
    if (method === 'button') await click(details().querySelector('[aria-label="关闭点位详情"]')!)
    else await act(async () => details().dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    expect(closed).toHaveBeenCalledOnce()
    expect(selection()).toBe('none')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await click(marker('a'))
    expectDetails('a')
  })

  it('hides markers and removes details in 3D without emitting a user close', async () => {
    await render(); await click(marker('b'))
    const host = expectFixedPanel(), previous = details()
    await click(container.querySelector('[data-track-view="sandbox"]')!)
    expect(container.querySelector('.trk-map-wrap')!.classList.contains('trk-sandbox-active')).toBe(true)
    expect(container.querySelector('.trk-map')!.getAttribute('aria-hidden')).toBe('true')
    expect(previous.isConnected).toBe(false); expect(detailsHost()).toBe(host)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(closed).not.toHaveBeenCalled()
    expect(selection()).toBe('b')
    await click(container.querySelector('[data-track-view="map"]')!)
    expectDetails('b')
  })

  it('removes the map, markers and fixed panel on unmount without a close callback', async () => {
    await render(); await click(marker('a'))
    const host = expectFixedPanel(), previous = details()
    await act(async () => root!.unmount())
    root = null
    expect(state.maps[0].remove).toHaveBeenCalledOnce()
    expect(state.markers.every(marker => marker.remove.mock.calls.length === 1)).toBe(true)
    expect(previous.isConnected).toBe(false); expect(host.isConnected).toBe(false)
    expect(closed).not.toHaveBeenCalled()
  })
})

describe('placemark details without WebGL', () => {
  it('opens the same details from an SVG point and supports close and reopening', async () => {
    state.noWebGL = true
    await render()
    expect(state.popups).toHaveLength(0)
    expect(marker('a').tagName.toLowerCase()).toBe('g')
    await click(marker('a'))
    expectDetails('a')
    expectFixedPanel()
    await click(details().querySelector('[aria-label="关闭点位详情"]')!)
    expect(selection()).toBe('none')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await click(marker('a'))
    expectDetails('a')
  })

  it.each(['Enter', ' '] as const)('opens SVG point details with the %s key and closes with Escape', async key => {
    state.noWebGL = true
    await render()
    const point = marker('b')
    expect(point.getAttribute('role')).toBe('button')
    expect(point.getAttribute('tabindex')).toBe('0')
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true})))
    expect(selection()).toBe('b')
    expectDetails('b')
    await act(async () => details().dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    expect(closed).toHaveBeenCalledOnce()
    expect(selection()).toBe('none')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true})))
    expectDetails('b')
  })
})

describe('map placemark position editing', () => {
  it('keeps ordinary markers read-only and enables dragging only with an enabled callback', async () => {
    await render()
    expect(state.markers.every(marker => !marker.draggable)).toBe(true)
    expect(marker('a').getAttribute('data-placemark-id')).toBe('a')
    await render({editable: true})
    expect(state.markers.every(marker => marker.draggable)).toBe(true)
    expect(marker('a').getAttribute('data-placemark-draggable')).toBe('true')
    expect(marker('a').getAttribute('title')).toContain('Alt+方向键修正位置')
    expect(container.querySelector('.trk-map-drag-hint')?.textContent).toContain('拖动标记')
    await render({editable: true, disabled: true})
    expect(state.markers.every(marker => !marker.draggable)).toBe(true)
    expect(marker('a').getAttribute('data-placemark-draggable')).toBe('false')
    expect(container.querySelector('.trk-map-drag-hint')?.textContent).toContain('暂不可编辑')
  })

  it('hides the fixed card while dragging, emits the stable id and updates the marker and contents after the move', async () => {
    await render({editable: true}); await click(marker('a'))
    const host = expectFixedPanel(), previous = details(), dragged = state.markers[1], original = POINTS.map(point => [...point])
    await act(async () => dragged.emit('dragstart'))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(previous.isConnected).toBe(false); expect(detailsHost()).toBe(host)
    expect(closed).not.toHaveBeenCalled()
    dragged.coordinates = [120.06, 30.04]
    await act(async () => dragged.emit('dragend'))
    expect(moved).toHaveBeenCalledExactlyOnceWith('b', [120.06, 30.04])
    expect(selection()).toBe('b')
    expectDetails('b')
    expectFixedPanel(); expect(details().textContent).toContain('120.060000'); expect(details().textContent).toContain('30.040000')
    expect(state.markers[state.markers.length - 1].coordinates).toEqual([120.06, 30.04])
    expect(POINTS).toEqual(original)
    expect(PLACEMARKS[1].coordinates).toEqual([120.1, 30.1])
    await act(async () => dragged.element.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1})))
    expect(selectedFromMap).toHaveBeenCalledTimes(2)
  })

  it('locks history when a marker is pressed and releases a click without saving a move', async () => {
    await render({editable:true})
    await pointer(marker('a'),'pointerdown',10,10)
    expect(dragChanged).toHaveBeenLastCalledWith(true)
    await pointer(marker('a'),'pointerup',10,10)
    expect(dragChanged).toHaveBeenLastCalledWith(false)
    expect(moved).not.toHaveBeenCalled()
  })

  it('starts the marker write before releasing the gesture history lock', async () => {
    const sequence:string[]=[]
    dragChanged.mockImplementation(active=>sequence.push(active?'start':'end'))
    moved.mockImplementation(()=>sequence.push('save'))
    await render({editable:true})
    const dragged=state.markers[0]
    await act(async()=>dragged.emit('dragstart'))
    dragged.coordinates=[120.02,30.02]
    await act(async()=>dragged.emit('dragend'))
    expect(sequence.slice(0,3)).toEqual(['start','save','end'])
  })

  it('cancels a blurred marker drag, restores its location and ignores a late dragend', async () => {
    await render({editable:true})
    const dragged=state.markers[0]
    await act(async()=>dragged.emit('dragstart'))
    dragged.coordinates=[120.02,30.02]
    await act(async()=>window.dispatchEvent(new Event('blur')))
    expect(dragChanged).toHaveBeenLastCalledWith(false)
    expect(dragged.coordinates).toEqual(PLACEMARKS[0].coordinates)
    expect(dragged.element.isConnected).toBe(false)
    const restored=state.markers.slice().reverse().find(item=>item.element.dataset.placemarkId==='a')!
    expect(restored).not.toBe(dragged)
    expect(restored.element.isConnected).toBe(true)
    expect(restored.draggable).toBe(true)
    expect(restored.coordinates).toEqual(PLACEMARKS[0].coordinates)
    await act(async()=>dragged.emit('dragend'))
    expect(moved).not.toHaveBeenCalled()
  })

  it('restores the published position when a move is a no-op or the parent rejects it', async () => {
    const move=vi.fn()
    await act(async()=>root!.render(createElement(MapView,{points:POINTS,name:'山区轨迹',basemap:'none',onBasemap:()=>{},placemarks:PLACEMARKS,onMovePlacemark:move})))
    const dragged=state.markers[0]
    await act(async()=>dragged.emit('dragstart'))
    dragged.coordinates=[120.001,30.001]
    await act(async()=>dragged.emit('dragend'))
    expect(move).toHaveBeenCalledWith('a',[120.001,30.001])
    expect(dragged.coordinates).toEqual(PLACEMARKS[0].coordinates)
  })

  it('locks SVG history on pointerdown and releases it when the gesture is cancelled', async () => {
    state.noWebGL=true
    await render({editable:true})
    const svg=outlineRect(),point=svg.querySelector('[data-outline-placemark="a"]')!
    await pointer(point,'pointerdown',80,580)
    expect(dragChanged).toHaveBeenLastCalledWith(true)
    await act(async()=>svg.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(dragChanged).toHaveBeenLastCalledWith(false)
    expect(moved).not.toHaveBeenCalled()
  })

  it('restores the marker when editing becomes disabled during a drag and ignores its late dragend', async () => {
    await render({editable: true})
    const dragged = state.markers[0]
    await act(async () => dragged.emit('dragstart'))
    dragged.coordinates = [120.03, 30.02]
    await render({editable: true, disabled: true})
    expect(dragged.draggable).toBe(false)
    expect(dragged.coordinates).toEqual(PLACEMARKS[0].coordinates)
    await act(async () => dragged.emit('dragend'))
    expect(moved).not.toHaveBeenCalled()
  })

  it('disables marker dragging in the terrain view and restores it on returning to the map', async () => {
    await render({editable: true})
    await click(container.querySelector('[data-track-view="sandbox"]')!)
    expect(state.markers.every(marker => !marker.draggable)).toBe(true)
    await click(container.querySelector('[data-track-view="map"]')!)
    expect(state.markers.every(marker => marker.draggable)).toBe(true)
  })

  it('normalizes a wrapped longitude before emitting a moved coordinate', async () => {
    await render({editable: true})
    const dragged = state.markers[0]
    await act(async () => dragged.emit('dragstart'))
    dragged.coordinates = [480.02, 30.01]
    await act(async () => dragged.emit('dragend'))
    expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.02)
  })

  it('rejects an invalid marker coordinate without changing or selecting a point', async () => {
    await render({editable: true})
    const dragged = state.markers[0]
    await act(async () => dragged.emit('dragstart'))
    dragged.coordinates = [NaN, 30]
    await act(async () => dragged.emit('dragend'))
    expect(moved).not.toHaveBeenCalled()
    expect(selectedFromMap).not.toHaveBeenCalled()
    expect(dragged.coordinates).toEqual(PLACEMARKS[0].coordinates)
  })

  it('supports Alt+arrow position correction in screen pixels and leaves ordinary arrows alone', async () => {
    await render({editable: true})
    const point = marker('a')
    const ordinary = new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true})
    await act(async () => point.dispatchEvent(ordinary))
    expect(moved).not.toHaveBeenCalled()
    expect(ordinary.defaultPrevented).toBe(false)
    const keyboard = new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})
    await act(async () => point.dispatchEvent(keyboard))
    expect(keyboard.defaultPrevented).toBe(true)
    expect(moved).toHaveBeenCalledOnce()
    expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.02)
    expect(state.maps[0].unproject).toHaveBeenLastCalledWith([20, expect.any(Number)])
    expect(selection()).toBe('a')
    expect(document.activeElement).toBe(marker('a'))
    await act(async () => marker('a').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledTimes(2)
    expect(moved.mock.calls[1][1][0]).toBeCloseTo(120.04)
    expect(document.activeElement).toBe(marker('a'))
    await render({editable: true, disabled: true})
    await act(async () => marker('a').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledTimes(2)
  })
})

describe('SVG outline placemark position editing', () => {
  it('converts a drag in a letterboxed SVG into geographic coordinates without changing the path', async () => {
    state.noWebGL = true
    await render({editable: true}); await click(marker('a'))
    const svg = outlineRect(1000, 1000), path = svg.querySelector('polyline')!.getAttribute('points')
    const point = marker('a')
    expect(point.getAttribute('data-placemark-draggable')).toBe('true')
    await pointer(point, 'pointerdown', 80, 730)
    await pointer(svg, 'pointermove', 500, 500)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(point.querySelector('circle')!.getAttribute('cx')).toBe('500')
    await pointer(svg, 'pointerup', 500, 500)
    expect(moved).toHaveBeenCalledOnce()
    expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.05)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30.05)
    expect(selection()).toBe('a'); expectDetails('a')
    expect(svg.querySelector('polyline')!.getAttribute('points')).toBe(path)
    const selects = selectedFromMap.mock.calls.length
    await act(async () => point.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1})))
    expect(selectedFromMap).toHaveBeenCalledTimes(selects)
  })

  it.each(['pointercancel', 'lostpointercapture'] as const)('cancels %s and leaves the saved location untouched', async event => {
    state.noWebGL = true
    await render({editable: true})
    const svg = outlineRect(), point = marker('a')
    await pointer(point, 'pointerdown', 80, 580)
    await pointer(svg, 'pointermove', 500, 350)
    await pointer(svg, event, 500, 350)
    expect(point.querySelector('circle')!.getAttribute('cx')).toBe('80')
    await pointer(svg, 'pointerup', 500, 350)
    expect(moved).not.toHaveBeenCalled()
  })

  it('prevents a disabled drag but keeps point details available', async () => {
    state.noWebGL = true
    await render({editable: true, disabled: true})
    const svg = outlineRect(), point = marker('a')
    await pointer(point, 'pointerdown', 80, 580)
    await pointer(svg, 'pointermove', 500, 350)
    await pointer(svg, 'pointerup', 500, 350)
    expect(moved).not.toHaveBeenCalled()
    await click(point)
    expectDetails('a')
  })

  it('supports the same Alt+arrow correction without WebGL using actual screen scaling', async () => {
    state.noWebGL = true
    await render({editable: true})
    outlineRect(500, 350)
    await act(async () => marker('a').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledOnce()
    expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120 + .1 * 40 / 840)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30)
    expect(selection()).toBe('a')
    expect(marker('a').getAttribute('aria-keyshortcuts')).toContain('Alt+ArrowRight')
    expect(document.activeElement).toBe(marker('a'))
  })
})

describe('editing map point details and preserving hidden locations', () => {
  it('keeps readonly card controls unchanged and shows edit only when the callback exists', async () => {
    await render(); await click(marker('a'))
    expect(details().querySelector('.trk-placemark-details-edit')).toBeNull()
    await render({editDetails: true})
    await click(details().querySelector('[aria-label="编辑点位"]')!)
    expect(edited).toHaveBeenCalledExactlyOnceWith('a')
    expect(selection()).toBe('a')
    expect(closed).not.toHaveBeenCalled()
    expect(container.querySelector('dialog')).toBeNull()
  })

  it('disables the edit action when busy and reenables the same selected point afterward', async () => {
    await render({editDetails: true, disabled: true}); await click(marker('b'))
    const button = details().querySelector<HTMLButtonElement>('.trk-placemark-details-edit')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(edited).not.toHaveBeenCalled()
    await render({editDetails: true})
    await click(details().querySelector('.trk-placemark-details-edit')!)
    expect(edited).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('renders an edit action and type badge for a point without images', async () => {
    await render({editDetails: true, initialLocations: [{...PLACEMARKS[0], images: [], type: '补给点'}, PLACEMARKS[1]]})
    await click(marker('a'))
    expect(details().querySelector('.trk-placemark-details-view')).toBeNull()
    expect(details().querySelector('.trk-placemark-details-type')?.textContent).toBe('补给点')
    await click(details().querySelector('.trk-placemark-details-edit')!)
    expect(edited).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('omits hidden WebGL markers without renumbering visible locations or widening the route fit', async () => {
    await render({initialLocations: [{...PLACEMARKS[0], hidden: true, coordinates: [130, 40]}, PLACEMARKS[1]]})
    expect(container.querySelector('[data-placemark-id="a"]')).toBeNull()
    expect(state.markers).toHaveLength(1)
    expect(marker('b').querySelector('.trk-map-placemark-dot')?.textContent).toBe('2')
    for (const [bounds] of state.maps[0].fitBounds.mock.calls) {
      expect(bounds.getWest()).toBe(120)
      expect(bounds.getEast()).toBe(120.1)
      expect(bounds.getNorth()).toBe(30.1)
    }
  })

  it.each([false, true])('does not open a selected hidden ungrouped point with noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    await render({editDetails: true, initialSelection: 'a', initialLocations: [{...PLACEMARKS[0], hidden: true}, PLACEMARKS[1]]})
    expect(container.querySelector('[data-placemark-id="a"]')).toBeNull()
    expect(selection()).toBe('a')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(edited).not.toHaveBeenCalled()
    expect(selection()).toBe('a')
  })

  it('omits hidden SVG markers and their bounds while preserving ordinal gaps', async () => {
    state.noWebGL = true
    await render({initialLocations: [{...PLACEMARKS[0], hidden: true, coordinates: [130, 40]}, PLACEMARKS[1]]})
    const svg = container.querySelector('.trk-outline')!
    expect(svg.querySelector('[data-outline-placemark="a"]')).toBeNull()
    expect(svg.querySelector('[data-outline-placemark="b"] text')?.textContent).toBe('2')
    expect(svg.querySelector('polyline')?.getAttribute('points')).toBe('80,580 920,120')
  })
})

describe('new placemark map positioning',()=>{
  it('picks a map coordinate only while the positioning mode is active',async()=>{
    const pick=vi.fn(),props={points:POINTS,name:'定位路线',basemap:'none' as const,onBasemap:()=>{},placemarks:[]}
    await act(async()=>root!.render(createElement(MapView,{...props,onPickPlacemark:pick})))
    const handler=state.maps[0].on.mock.calls.find(([event])=>event==='click')![1]
    await act(async()=>handler({lngLat:{lng:120.045,lat:30.065}}))
    expect(pick).toHaveBeenCalledExactlyOnceWith([120.045,30.065])
    await act(async()=>root!.render(createElement(MapView,props)))
    await act(async()=>handler({lngLat:{lng:120.05,lat:30.07}}))
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('uses the same independent route segments and click coordinates in SVG fallback',async()=>{
    state.noWebGL=true
    const pick=vi.fn()
    const points:TrackPoint[]=[[120,30,100,null],[120.02,30.02,110,null],[120.08,30.08,120,null],[120.1,30.1,130,null]]
    await act(async()=>root!.render(createElement(MapView,{points,segmentStarts:[0,2],name:'两段路线',basemap:'none',onBasemap:()=>{},placemarks:[],onPickPlacemark:pick})))
    const svg=outlineRect()
    expect(svg.querySelectorAll('polyline')).toHaveLength(2)
    for(const path of svg.querySelectorAll('polyline'))expect(path.getAttribute('points')!.split(' ')).toHaveLength(2)
    await act(async()=>svg.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:500,clientY:350})))
    expect(pick.mock.calls[0][0][0]).toBeCloseTo(120.05)
    expect(pick.mock.calls[0][0][1]).toBeCloseTo(30.05)
  })

  it('does not bridge invalid GPS fixes in SVG fallback',async()=>{
    state.noWebGL=true
    const points:TrackPoint[]=[[120,30,100,null],[120.02,30.02,110,null],[NaN,NaN,null,null],[120.08,30.08,120,null],[120.1,30.1,130,null]]
    await act(async()=>root!.render(createElement(MapView,{points,segmentStarts:[0],name:'断点路线',basemap:'none',onBasemap:()=>{},placemarks:[]})))
    const paths=container.querySelectorAll('.trk-outline polyline')
    expect(paths).toHaveLength(2)
    for(const path of paths)expect(path.getAttribute('points')!.split(' ')).toHaveLength(2)
  })
})

describe('SVG positioning across the date line',()=>{
  it.each([179,-179])('keeps click and drag at the short crossing midpoint starting at %s',async first=>{
    state.noWebGL=true
    const pick=vi.fn(),move=vi.fn()
    const points:TrackPoint[]=[[first,10,100,1000],[-first,10,300,3000]]
    const marks:TrackPlacemark[]=[{id:'dateline',name:'日期变更线',description:'',images:[],coordinates:[first,10]}]
    const props={points,segmentStarts:[0],name:'跨线轨迹',basemap:'none' as const,onBasemap:()=>{},placemarks:marks}
    await act(async()=>root!.render(createElement(MapView,{...props,onPickPlacemark:pick})))
    let svg=outlineRect()
    await act(async()=>svg.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:500,clientY:580})))
    expect(Math.abs(pick.mock.calls[0][0][0])).toBeCloseTo(180)
    const chosen=locatePlacemarkCandidates(points,{segmentStarts:[0],references:[]},pick.mock.calls[0][0])[0]
    expect(chosen.routePosition.fraction).toBeCloseTo(.5);expect(chosen.elevation).toBeCloseTo(200);expect(chosen.time).toBeCloseTo(2000)
    await act(async()=>root!.render(createElement(MapView,{...props,onMovePlacemark:move})))
    svg=outlineRect()
    const mark=svg.querySelector<SVGGElement>('[data-outline-placemark]')!,circle=mark.querySelector('circle')!
    const x=Number(circle.getAttribute('cx')),y=Number(circle.getAttribute('cy'))
    await pointer(mark,'pointerdown',x,y);await pointer(svg,'pointermove',500,580);await pointer(svg,'pointerup',500,580)
    expect(move).toHaveBeenCalledTimes(1);expect(Math.abs(move.mock.calls[0][1][0])).toBeCloseTo(180)
    const movedLocation=locatePlacemarkCandidates(points,{segmentStarts:[0],references:[]},move.mock.calls[0][1])[0]
    expect(movedLocation.routePosition.fraction).toBeCloseTo(.5);expect(movedLocation.elevation).toBeCloseTo(200);expect(movedLocation.time).toBeCloseTo(2000)
  })
})

const FILTER_LOCATIONS: TrackPlacemark[] = [
  {id:'first',name:'补给组子点',coordinates:[120,30],description:'',images:[],type:'补给'},
  {...PLACEMARKS[0],type:['营地']},
  {...PLACEMARKS[1],type:'风景'},
  {id:'hidden-camp',name:'隐藏营地',coordinates:[120.05,30.05],description:'',images:[],type:'营地',hidden:true},
  {id:'untyped',name:'未分类终点',coordinates:[120.08,30.08],description:'',images:[]},
]
const FILTER_GROUPS: PlacemarkGroup[] = [
  {id:'group-22222222-2222-4222-8222-222222222222',name:'先行补给组',description:'',memberIds:['first'],coordinates:[120,30]},
  GROUP,
]
async function changeRouteColor(routeColor: string) {
  await act(async () => {
    const next = writeMapSettings({...readMapSettings(), routeColor})
    window.dispatchEvent(new StorageEvent('storage', {key: MAP_SETTINGS_KEY, newValue: JSON.stringify(next)}))
  })
}

describe('type-filtered map placemarks', () => {
  it.each([false,true])('keeps full-list group numbers and scopes details and large photos to matching children with noWebGL=%s', async noWebGL => {
    state.noWebGL = noWebGL
    const original = JSON.stringify({points:FILTER_LOCATIONS,groups:FILTER_GROUPS})
    const options = {initialLocations:FILTER_LOCATIONS,initialGroups:FILTER_GROUPS,initialSelection:GROUP.id}
    await render({...options,placemarkTypeFilter:'type:营地'})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(1)
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，1 个子点')
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect([...details().querySelectorAll('.trk-placemark-details-type')].map(badge => badge.textContent)).toEqual(['营地'])
    await click(details().querySelector('.trk-placemark-details-view')!)
    expect(container.querySelector('dialog img')?.getAttribute('src')).toBe(GROUP.cover!.imageUrl)

    await render({...options,placemarkTypeFilter:'type:风景'})
    expect(container.querySelector('dialog')).toBeNull()
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，1 个子点')
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(details().textContent).toContain(PLACEMARKS[1].description)
    expect(details().textContent).not.toContain(PLACEMARKS[0].description)
    expect([...details().querySelectorAll('.trk-placemark-details-type')].map(badge => badge.textContent)).toEqual(['风景'])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe(GROUP.id); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])

    await render({...options,placemarkTypeFilter:'type:营地'})
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect(selection()).toBe(GROUP.id); expect(groupMarker().getAttribute('aria-pressed')).toBe('true')
    expect(closed).not.toHaveBeenCalled()
    await render({...options,placemarkTypeFilter:['type:营地','type:风景','untyped']})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，2 个子点')
    expect(container.querySelector('[data-placemark-id="untyped"]')?.getAttribute('aria-label')).toBe('标注点 5：未分类终点')
    expect(container.querySelector('[data-placemark-id="hidden-camp"]')).toBeNull()
    await render({...options,placemarkTypeFilter:[]})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('dialog')).toBeNull()
    expect(selection()).toBe(GROUP.id); expect(closed).not.toHaveBeenCalled()
    await render({...options,placemarkTypeFilter:'all'})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(3)
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，2 个子点')
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    expect(container.querySelector('[data-placemark-id="untyped"]')?.getAttribute('aria-label')).toBe('标注点 5：未分类终点')
    expect(JSON.stringify({points:FILTER_LOCATIONS,groups:FILTER_GROUPS})).toBe(original)
  })

  it('filters untyped SVG markers and updates route color without changing its route points or original ordinals', async () => {
    state.noWebGL = true
    const options = {initialLocations:FILTER_LOCATIONS,initialGroups:FILTER_GROUPS}
    await render({...options,placemarkTypeFilter:'untyped'})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(1)
    expect(container.querySelector('[data-placemark-id="untyped"]')?.getAttribute('aria-label')).toBe('标注点 5：未分类终点')
    const route = container.querySelector<SVGPolylineElement>('.trk-outline polyline')!
    const points = route.getAttribute('points')
    expect(route.getAttribute('stroke')).toBe('#1bb1a7')
    await changeRouteColor('#1277aa')
    expect(route.getAttribute('stroke')).toBe('#1277aa')
    expect(route.getAttribute('points')).toBe(points)
    await render({...options,placemarkTypeFilter:'type:营地'})
    expect(container.querySelector('[data-placemark-id="untyped"]')).toBeNull()
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，1 个子点')
    expect(container.querySelector('.trk-outline polyline')?.getAttribute('points')).toBe(points)
    expect(container.querySelector('.trk-outline polyline')?.getAttribute('stroke')).toBe('#1277aa')
    await render({...options,placemarkTypeFilter:['type:营地','untyped']})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    await render({...options,placemarkTypeFilter:[]})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
    expect(container.querySelector('.trk-outline polyline')?.getAttribute('points')).toBe(points)
    await render({...options,placemarkTypeFilter:['type:营地','untyped']})
    await click(container.querySelector('[data-map-display-trigger]')!)
    const toggle = container.querySelector<HTMLInputElement>('[aria-label="显示标记点"]')!
    expect(toggle.checked).toBe(true)
    await click(toggle)
    expect(toggle.checked).toBe(false)
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(0)
    expect(container.querySelector('.trk-outline polyline')?.getAttribute('points')).toBe(points)
    expect(container.querySelector('.trk-outline polyline')?.getAttribute('stroke')).toBe('#1277aa')
    await click(toggle)
    expect(toggle.checked).toBe(true)
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，1 个子点')
    expect(container.querySelector('[data-placemark-id="untyped"]')?.getAttribute('aria-label')).toBe('标注点 5：未分类终点')
  })
})


it.each([false,true])('uses cached thumbnails in the map and cached originals in the viewer, fallback=%s',async noWebGL=>{
 state.noWebGL=noWebGL
 await render({trackId:'track-1'});await click(marker('a'))
 expect(details().querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',PLACEMARKS[0].images[0]))
 await click(details().querySelector('[aria-label="查看图片 2 大图"]')!)
 expect(container.querySelector('dialog img')?.getAttribute('src')).toBe(placemarkPhotoOriginalUrl('track-1',PLACEMARKS[0].images[1]))
 expect(selection()).toBe('a')
})


describe('SVG fallback point sizes in CSS pixels', () => {
  it('compensates observer resizes while retaining editable anchors, route geometry and source coordinates', async () => {
    state.noWebGL = true
    const notifications = new Map<Element, () => void>()
    const observe = vi.fn(), disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(target: Element) {notifications.set(target, this.callback); observe(target)}
      disconnect = disconnect
    })
    writeMapSettings({...DEFAULT_MAP_SETTINGS, placemarkPointSize: 40, placemarkPointRadius: 10, placemarkPointShowName: true})
    const group = {...GROUP, memberIds: ['b']}
    const source = JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group})
    await render({editable: true, initialGroups: [group]})
    const svg = outlineRect(500, 350)
    const point = marker('a'), grouped = groupMarker()
    const hit = point.querySelector<SVGCircleElement>('[data-point-hit]')!
    const badge = point.querySelector<SVGRectElement>('[data-point-badge]')!
    const name = point.querySelector<HTMLSpanElement>('.trk-outline-point-name')!
    const nameBox = point.querySelector<SVGForeignObjectElement>('[data-point-name]')!
    const visual = point.querySelector<SVGGElement>('[data-point-visual]')!
    const groupVisual = grouped.querySelector<SVGGElement>('[data-point-visual]')!
    const count = grouped.querySelector('[data-point-count]')!
    const path = svg.querySelector('polyline')!, pathPoints = path.getAttribute('points')
    const x = Number(hit.getAttribute('cx')), y = Number(hit.getAttribute('cy'))
    expect(observe.mock.calls.filter(([target]) => target === svg)).toHaveLength(1)
    expect(visual.getAttribute('transform')).toBe(`translate(${x} ${y}) scale(1) translate(${-x} ${-y})`)
    expect(hit).toBe(point.querySelector('circle'))
    expect([x, y]).toEqual([80, 580])
    expect(badge.getAttribute('width')).toBe('40'); expect(badge.getAttribute('rx')).toBe('4')
    expect(name.style.fontSize).toBe('16px')
    expect(nameBox.getAttribute('height')).toBe('44')
    expect(Number(hit.getAttribute('r')) * 2).toBe(48)

    for (const [width, height, scale] of [[500, 350, .5], [250, 175, .25]]) {
      outlineRect(width, height)
      await act(async () => notifications.get(svg)!())
      expect(marker('a')).toBe(point); expect(groupMarker()).toBe(grouped)
      expect(point.querySelector('[data-point-visual]')).toBe(visual)
      expect(grouped.querySelector('[data-point-visual]')).toBe(groupVisual)
      expect(grouped.querySelector('[data-point-count]')).toBe(count)
      expect(visual.getAttribute('transform')).toBe(`translate(${x} ${y}) scale(${1 / scale}) translate(${-x} ${-y})`)
      const groupHit = grouped.querySelector('circle')!
      const gx = Number(groupHit.getAttribute('cx')), gy = Number(groupHit.getAttribute('cy'))
      expect(groupVisual.getAttribute('transform')).toBe(`translate(${gx} ${gy}) scale(${1 / scale}) translate(${-gx} ${-gy})`)
      expect(point.querySelector('[data-point-hit]')).toBe(hit)
      expect([Number(hit.getAttribute('cx')), Number(hit.getAttribute('cy'))]).toEqual([x, y])
      expect(point.getAttribute('transform')).toBeNull()
      expect(badge.getAttribute('width')).toBe('40'); expect(badge.getAttribute('rx')).toBe('4')
      expect(name.style.fontSize).toBe('16px')
      expect(nameBox.getAttribute('height')).toBe('44')
      expect(Number(hit.getAttribute('r')) * 2).toBeGreaterThanOrEqual(44)
      expect(svg.querySelector('polyline')).toBe(path); expect(path.getAttribute('points')).toBe(pathPoints)
      expect(moved).not.toHaveBeenCalled()
      expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group})).toBe(source)
    }
    // Only the display group is compensated; Alt+Right still moves 20 real screen pixels.
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledOnce(); expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120 + .1 * 80 / 840)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30)
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS, group})).toBe(source)
    await act(async () => root!.unmount()); root = null
    expect(disconnect.mock.calls.length).toBe(observe.mock.calls.length)
  })

  it('keeps a 44px default hit target, handles zero sizes and uses a cleaned-up resize listener without ResizeObserver', async () => {
    state.noWebGL = true
    vi.stubGlobal('ResizeObserver', undefined)
    const added = vi.spyOn(window, 'addEventListener'), removed = vi.spyOn(window, 'removeEventListener')
    await render()
    const svg = outlineRect(), point = marker('a')
    const hit = point.querySelector<SVGCircleElement>('[data-point-hit]')!
    const visual = point.querySelector<SVGGElement>('[data-point-visual]')!
    const x = Number(hit.getAttribute('cx')), y = Number(hit.getAttribute('cy'))
    const resize = added.mock.calls.find(([event]) => event === 'resize')![1]
    expect(hit.getAttribute('r')).toBe('22')
    expect(visual.getAttribute('transform')).toContain('scale(1)')
    for (const [width, height, inverse] of [[500, 500, 2], [0, 350, 1], [NaN, 350, 1], [250, 350, 4]]) {
      outlineRect(width, height)
      await act(async () => window.dispatchEvent(new Event('resize')))
      expect(marker('a')).toBe(point); expect(point.querySelector('[data-point-visual]')).toBe(visual)
      expect(visual.getAttribute('transform')).toBe(`translate(${x} ${y}) scale(${inverse}) translate(${-x} ${-y})`)
      expect(Number(hit.getAttribute('r')) * 2).toBe(44)
    }
    await act(async () => root!.unmount()); root = null
    expect(removed.mock.calls.some(([event, handler]) => event === 'resize' && handler === resize)).toBe(true)
    expect(svg.isConnected).toBe(false)
  })
})


describe('SVG fallback content-box and screen matrix coordinates', () => {
  it('shares the padded content-box transform for CSS sizes, picking, dragging and keyboard corrections', async () => {
    state.noWebGL = true
    vi.stubGlobal('ResizeObserver', undefined)
    writeMapSettings({...DEFAULT_MAP_SETTINGS, placemarkPointShowName: true})
    const locations: TrackPlacemark[] = [{...PLACEMARKS[0], coordinates: [120.05, 30.05]}, PLACEMARKS[1]]
    const source = JSON.stringify({points: POINTS, locations})
    const picked = vi.fn()
    await act(async () => root!.render(createElement(MapView, {
      points: POINTS, name: '带内边距轮廓', basemap: 'none', onBasemap: () => {}, placemarks: locations,
      onMovePlacemark: moved, onSelectPlacemark: selectedFromMap, onPickPlacemark: picked,
    })))
    const svg = outlineRect(500, 350)
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({left: 100, top: 50, width: 500, height: 350, right: 600, bottom: 400, x: 100, y: 50, toJSON: () => ({})})
    svg.style.cssText = 'padding:12px;border:2px solid transparent;box-sizing:border-box'
    Object.defineProperty(svg, 'getScreenCTM', {configurable: true, value: () => null})
    await act(async () => window.dispatchEvent(new Event('resize')))
    const point = marker('a'), visual = point.querySelector('[data-point-visual]')!
    const hit = point.querySelector('circle')!, badge = point.querySelector('[data-point-badge]')!
    const x = Number(hit.getAttribute('cx')), y = Number(hit.getAttribute('cy'))
    expect(x).toBeCloseTo(500); expect(y).toBeCloseTo(350)
    // The true 472x322 content box has scale .46 and screen origin (120, 64).
    expect(visual.getAttribute('transform')).toBe(`translate(${x} ${y}) scale(${1 / .46}) translate(${-x} ${-y})`)
    expect(hit.getAttribute('r')).toBe('22'); expect(badge.getAttribute('width')).toBe('24')
    expect(point.querySelector<HTMLSpanElement>('.trk-outline-point-name')!.style.fontSize).toBe('16px')
    await act(async () => svg.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 350, clientY: 225})))
    expect(picked).toHaveBeenCalledOnce()
    expect(picked.mock.calls[0][0][0]).toBeCloseTo(120.05); expect(picked.mock.calls[0][0][1]).toBeCloseTo(30.05)
    // (396,248) maps to the geographic route frame (600,400), without a padding-induced offset.
    await pointer(point, 'pointerdown', 350, 225)
    await pointer(svg, 'pointermove', 396, 248)
    await pointer(svg, 'pointerup', 396, 248)
    expect(moved).toHaveBeenCalledOnce(); expect(moved.mock.calls[0][0]).toBe('a')
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120 + .1 * 520 / 840)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30 + .1 * 180 / 460)
    moved.mockClear()
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledOnce()
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.05 + .1 * (20 / .46) / 840)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30.05)
    expect(marker('a')).toBe(point)
    expect(JSON.stringify({points: POINTS, locations})).toBe(source)
  })

  it('prefers a rotated getScreenCTM affine over the outer rect and inverts its screen directions', async () => {
    state.noWebGL = true
    vi.stubGlobal('ResizeObserver', undefined)
    const picked = vi.fn(), source = JSON.stringify({points: POINTS, placemarks: PLACEMARKS})
    await act(async () => root!.render(createElement(MapView, {
      points: POINTS, name: '旋转轮廓', basemap: 'none', onBasemap: () => {}, placemarks: PLACEMARKS,
      onMovePlacemark: moved, onSelectPlacemark: selectedFromMap, onPickPlacemark: picked,
    })))
    const svg = outlineRect(2000, 1500)
    svg.style.cssText = 'padding:7px;border:3px solid transparent'
    const getScreenCTM = vi.fn(() => ({a: 0, b: .5, c: -.5, d: 0, e: 430, f: 60}))
    Object.defineProperty(svg, 'getScreenCTM', {configurable: true, value: getScreenCTM})
    await act(async () => window.dispatchEvent(new Event('resize')))
    const point = marker('a'), hit = point.querySelector('circle')!
    expect(point.querySelector('[data-point-visual]')!.getAttribute('transform')).toBe('translate(80 580) matrix(0 -2 2 0 0 0) translate(-80 -580)')
    expect([Number(hit.getAttribute('cx')), Number(hit.getAttribute('cy'))]).toEqual([80, 580])
    // Forward CTM maps route frame (500,350) to screen (255,310).
    await act(async () => svg.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 255, clientY: 310})))
    expect(picked).toHaveBeenCalledOnce()
    expect(picked.mock.calls[0][0][0]).toBeCloseTo(120.05); expect(picked.mock.calls[0][0][1]).toBeCloseTo(30.05)
    await pointer(point, 'pointerdown', 140, 100)
    await pointer(svg, 'pointermove', 255, 310)
    await pointer(svg, 'pointerup', 255, 310)
    expect(moved).toHaveBeenCalledOnce()
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120.05); expect(moved.mock.calls[0][1][1]).toBeCloseTo(30.05)
    moved.mockClear()
    // Under this 90-degree screen transform, ArrowRight is a northward route-frame delta.
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true})))
    expect(moved).toHaveBeenCalledOnce()
    expect(moved.mock.calls[0][1][0]).toBeCloseTo(120)
    expect(moved.mock.calls[0][1][1]).toBeCloseTo(30 + .1 * 40 / 460)
    expect(getScreenCTM).toHaveBeenCalled(); expect(marker('a')).toBe(point)
    expect(JSON.stringify({points: POINTS, placemarks: PLACEMARKS})).toBe(source)
  })
})
