// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {placemarkPhotoThumbnailUrl,placemarkPhotoOriginalUrl} from '../src/track/placemark-photo-assets.ts'
import { MapView } from '../src/client/MapView.tsx'
import {locatePlacemarkCandidates} from '../src/track/placemark-location.ts'
import { MAP_SETTINGS_KEY, readMapSettings, writeMapSettings } from '../src/track/map-settings.ts'
import type { PlacemarkGroup, TrackPlacemark, TrackPoint } from '../src/protocol.ts'
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
const state = vi.hoisted(() => ({
  maps: [] as MapStub[], markers: [] as MarkerStub[], popups: [] as PopupStub[], noWebGL: false,
  sampler: vi.fn(), renderers: [] as {updatePlacemarks: ReturnType<typeof vi.fn>}[],
}))

vi.mock('../src/client/maplibre-css.ts', () => ({
  MAP_STYLE: '.maplibregl-marker{left:0;position:absolute;top:0;transition:opacity .2s;will-change:transform}',
}))
vi.mock('../src/track/trail-layer.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/track/trail-layer.ts')>(), addTrack: vi.fn(),
}))
vi.mock('../src/track/sandbox/sampling.ts', () => ({sampleSandboxDetached: state.sampler, isSandboxDEMError: () => false}))
vi.mock('../src/track/sandbox/renderer.ts', () => ({
  SandboxRenderer: class {
    build = vi.fn(); dispose = vi.fn(); zoomIn = vi.fn(); zoomOut = vi.fn(); resetView = vi.fn()
    updatePlacemarks = vi.fn()
    constructor() {state.renderers.push(this)}
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
  state.maps = []; state.markers = []; state.popups = []; state.renderers = []; state.noWebGL = false
  state.sampler.mockReset().mockImplementation(() => new Promise(() => {}))
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
function latestPopup() {return state.popups[state.popups.length - 1]}
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
}

const GROUP: PlacemarkGroup = {id:'group-11111111-1111-4111-8111-111111111111',name:'山间风景',description:'沿线景点合辑',memberIds:['a','b'],coordinates:[120.03,30.04],cover:{pointId:'a',imageUrl:PLACEMARKS[0].images[1]}}
function groupMarker() {return container.querySelector<HTMLElement>(`[data-placemark-id="${GROUP.id}"]`)!}
function currentGroupImage() {return container.querySelector<HTMLImageElement>('.trk-placemark-group-details img')?.src}

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
    if (!noWebGL) expect(latestPopup().coordinates).toEqual(PLACEMARKS[1].coordinates)
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
    if (!noWebGL) expect(latestPopup().coordinates).toEqual(moved.mock.calls[0][1])
    await render(options)
    expect(marker('b')).toBeNull()
    expect(groupMarker().getAttribute('aria-pressed')).toBe('true')
    expect(details().querySelector('[aria-label="编辑标记组"]')).not.toBeNull()
    if (!noWebGL) expect(latestPopup().coordinates).toEqual(GROUP.coordinates)
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
    expect(selection()).toBe(sameCoverChild?'a':'b')
    expect(currentGroupImage()).toBe(sameCoverChild?PLACEMARKS[0].images[0]:PLACEMARKS[1].images[0])
    await click(groupMarker())
    expect(selection()).toBe(GROUP.id)
    expect(selectedFromMap).toHaveBeenLastCalledWith(GROUP.id)
    expect(currentGroupImage()).toBe(GROUP.cover!.imageUrl)
    const profileSelected=selection()===GROUP.id?GROUP.cover!.pointId:selection()
    expect(details().querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(profileSelected)
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe('b');expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
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
    expect(selectedFromMap).toHaveBeenLastCalledWith('a')
  })

  it.each([
    {noWebGL:false,method:'button'}, {noWebGL:true,method:'button'},
    {noWebGL:false,method:'Escape'}, {noWebGL:true,method:'Escape'}, {noWebGL:false,method:'map'},
  ])('opens the default cover after closing through $method with noWebGL=$noWebGL',async({noWebGL,method})=>{
    state.noWebGL=noWebGL
    await render({initialGroups:[GROUP]});await click(groupMarker())
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe('b');expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    if(method==='map')await act(async()=>latestPopup().remove())
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

  it('uses the cover after the parent clears and reopens group selection without a popup close callback',async()=>{
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
    if(!noWebGL)expect(latestPopup().coordinates).toEqual(GROUP.coordinates)
    else expect(groupMarker().querySelector('rect')?.getAttribute('fill')).toBe('#a9c4ff')
  })

  it('starts at cover, wraps across children, and retains same-child photo and navigation focus after rebuilding',async()=>{
    await render({initialGroups:[GROUP]});await click(groupMarker())
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    expect(details().textContent).toContain('2 / 3')
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe('b');expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('下一张组图片')
    await act(async()=>details().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})))
    expect(selection()).toBe('a');expect(currentGroupImage()).toBe(PLACEMARKS[0].images[0])
    await click(details().querySelector('[aria-label="下一张组图片"]')!)
    expect(selection()).toBe('a');expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await render({initialGroups:[GROUP],disabled:true})
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    await click(groupMarker())
    expect(currentGroupImage()).toBe(PLACEMARKS[0].images[1])
    expect(closed).not.toHaveBeenCalled()
  })

  it('keeps the large viewer open while changing children and same-child images and syncs the popup',async()=>{
    await render({initialGroups:[GROUP]});await click(groupMarker())
    await click(details().querySelector('.trk-placemark-details-view')!)
    const viewer=container.querySelector<HTMLDialogElement>('dialog')!
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[1])
    await click(viewer.querySelector('[aria-label="下一张大图"]')!)
    expect(container.querySelector('dialog')).toBe(viewer);expect(viewer.open).toBe(true)
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[1].images[0])
    expect(selection()).toBe('b');expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
    await act(async()=>viewer.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
    expect(selection()).toBe('a');expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[0])
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
    expect(selection()).toBe('b');expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
  })

  it.each([false,true])('omits a fully hidden group and its popup with noWebGL=%s',async noWebGL=>{
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
    expect(latestPopup().coordinates).toEqual([120.07,30.08])
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

describe('map placemark details with controlled selection', () => {
  it.each(['button','Escape'] as const)('views a linked photo and closes it via %s while preserving the point',async method=>{
    await render();await click(marker('a'))
    const popup=latestPopup()
    await click(details().querySelector('[aria-label="查看图片 2 大图"]')!)
    const viewer=container.querySelector<HTMLDialogElement>('dialog')!
    expect(viewer.open).toBe(true)
    expect(viewer.querySelector('img')?.src).toBe(PLACEMARKS[0].images[1])
    if(method==='button')await click(viewer.querySelector('[aria-label="关闭大图"]')!)
    else await act(async()=>viewer.dispatchEvent(new Event('cancel',{cancelable:true,bubbles:true})))
    expect(container.querySelector('dialog')).toBeNull()
    expect(selection()).toBe('a')
    expectDetails('a')
    expect(popup.remove).not.toHaveBeenCalled()
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
    expect(state.maps[0].easeTo).toHaveBeenLastCalledWith(expect.objectContaining({center: PLACEMARKS[0].coordinates, duration: 250}))
    expect(latestPopup().options).toMatchObject({closeButton: false, closeOnClick: true})
  })

  it('removes the previous popup without clearing the newly selected point', async () => {
    await render(); await click(marker('a'))
    const previous = latestPopup()
    await click(marker('b'))
    expect(previous.off).toHaveBeenCalledWith('close', expect.any(Function))
    expect(previous.remove).toHaveBeenCalledOnce()
    expect(previous.contents?.isConnected).toBe(false)
    expect(closed).not.toHaveBeenCalled()
    expect(selection()).toBe('b')
    expectDetails('b')
    expect(marker('b').getAttribute('aria-pressed')).toBe('true')
    expect(marker('a').getAttribute('aria-pressed')).toBe('false')
  })

  it('clears selection on a MapLibre close event so the same marker can reopen', async () => {
    await render(); await click(marker('a'))
    await act(async () => latestPopup().remove())
    expect(closed).toHaveBeenCalledOnce()
    expect(selection()).toBe('none')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(marker('a'))
    await click(marker('a'))
    expectDetails('a')
    expect(state.popups).toHaveLength(2)
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
    const previous = latestPopup()
    await click(container.querySelector('[data-track-view="sandbox"]')!)
    expect(container.querySelector('.trk-map-wrap')!.classList.contains('trk-sandbox-active')).toBe(true)
    expect(container.querySelector('.trk-map')!.getAttribute('aria-hidden')).toBe('true')
    expect(previous.remove).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(closed).not.toHaveBeenCalled()
    expect(selection()).toBe('b')
    await click(container.querySelector('[data-track-view="map"]')!)
    expectDetails('b')
  })

  it('removes the map, markers and popup on unmount without a close callback', async () => {
    await render(); await click(marker('a'))
    const previous = latestPopup()
    await act(async () => root!.unmount())
    root = null
    expect(state.maps[0].remove).toHaveBeenCalledOnce()
    expect(state.markers.every(marker => marker.remove.mock.calls.length === 1)).toBe(true)
    expect(previous.contents?.isConnected).toBe(false)
    expect(previous.off).toHaveBeenCalledWith('close', expect.any(Function))
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
    expect(container.querySelector('.trk-outline-details')?.contains(details())).toBe(true)
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

  it('hides the popup while dragging, emits the stable id and updates the marker and popup after the move', async () => {
    await render({editable: true}); await click(marker('a'))
    const previous = latestPopup(), dragged = state.markers[1], original = POINTS.map(point => [...point])
    await act(async () => dragged.emit('dragstart'))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(previous.off).toHaveBeenCalledWith('close', expect.any(Function))
    expect(closed).not.toHaveBeenCalled()
    dragged.coordinates = [120.06, 30.04]
    await act(async () => dragged.emit('dragend'))
    expect(moved).toHaveBeenCalledExactlyOnceWith('b', [120.06, 30.04])
    expect(selection()).toBe('b')
    expectDetails('b')
    expect(latestPopup().coordinates).toEqual([120.06, 30.04])
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
  it('keeps readonly popup controls unchanged and shows edit only when the callback exists', async () => {
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
    expect(selection()).toBe('b'); expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])

    await render({...options,placemarkTypeFilter:'type:营地'})
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(selection()).toBe('b'); expect(groupMarker().getAttribute('aria-pressed')).toBe('false')
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
    expect(selection()).toBe('b'); expect(closed).not.toHaveBeenCalled()
    await render({...options,placemarkTypeFilter:'all'})
    expect(container.querySelectorAll('[data-placemark-id]')).toHaveLength(3)
    expect(groupMarker().getAttribute('aria-label')).toBe('标记组 G2：山间风景，2 个子点')
    expect(currentGroupImage()).toBe(PLACEMARKS[1].images[0])
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
    expect(route.getAttribute('stroke')).toBe('#3dc5ff')
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
