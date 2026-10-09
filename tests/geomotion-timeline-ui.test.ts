// @vitest-environment jsdom
import {act, createElement, useEffect} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {GeoMotionTimeline, type GeoMotionTimelineProps} from '../src/client/GeoMotionTimeline.tsx'
import {GeoMotionEditor} from '../src/client/GeoMotionEditor.tsx'
import {createGeoMotionProject, geoCameraKeys, type GeoKeyframe, type GeoMotionProject} from '../src/track/geomotion.ts'
import {DEFAULT_MAP_SETTINGS} from '../src/track/map-settings.ts'
import type {GeoMotionSceneHandle} from '../src/client/GeoMotionScene.tsx'
import type {TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import {editedMetrics} from '../src/track/edit.ts'
import {api} from '../src/client/util.ts'

const integration = vi.hoisted(() => ({points: [] as TrackPlacemark[], project: null as GeoMotionProject | null, scene: null as GeoMotionSceneHandle | null}))
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: () => ({points: integration.points, groups: [], loading: false, editReady: true, error: '', stateError: '', routeError: '', routeContext: {segmentStarts: [0]}, retry: vi.fn()})}))
vi.mock('../src/client/map-settings.tsx', () => ({useMapSettings: () => ({settings: DEFAULT_MAP_SETTINGS}), BasemapControls: () => null}))
vi.mock('../src/client/GeoMotionScene.tsx', () => ({GeoMotionScene: (props: {project: GeoMotionProject; onReady: (handle: GeoMotionSceneHandle | null) => void}) => {
  integration.project = props.project
  useEffect(() => {props.onReady(integration.scene); return () => props.onReady(null)}, [props.onReady])
  return createElement('div', {'data-testid': 'timeline-integration-scene'})
}}))
vi.mock('../src/client/util.ts', async original => ({...await original<typeof import('../src/client/util.ts')>(), api: vi.fn(), download: vi.fn()}))

const camera = (id: string, t: number): GeoKeyframe => ({id, t, center: [114.18, 27.5], zoom: 13, bearing: 0, pitch: 45, easing: 'linear', dip: 0})
const coordinates: TrackRecord['coordinates'] = [[114.17, 27.54, 600, null], [114.18, 27.53, 1100, null], [114.19, 27.48, 1600, null]]
const track: TrackRecord = {id: 'timeline-integration', name: '真实轨迹测试副本', format: 'gpx', filename: 'source.gpx', createdAt: '2026-10-04', bytes: 80, points: coordinates.length, coordinates, metrics: editedMetrics(coordinates)}
let host: HTMLDivElement, root: Root | null, props: GeoMotionTimelineProps
let actualRect: {left: number; width: number}
let capture: ReturnType<typeof vi.fn>, releaseCapture: ReturnType<typeof vi.fn>
let originalCapture: PropertyDescriptor | undefined, originalRelease: PropertyDescriptor | undefined
const rect = (left: number, width: number): DOMRect => ({left, right: left + width, x: left, y: 0, top: 0, bottom: 48, width, height: 48, toJSON: () => ({})}) as DOMRect
function redraw() {root!.render(createElement(GeoMotionTimeline, props))}
async function render(patch: Partial<GeoMotionTimelineProps> = {}) {props = {...props, ...patch}; await act(async () => redraw())}
function button(label: string): HTMLButtonElement {
  const value = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) || [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  if (!value) throw new Error('Missing timeline button: ' + label)
  return value
}
function keyButton(t: number): HTMLButtonElement {return button(`相机关键帧 ${t} 秒`)}
function ruler(): HTMLElement {const value = host.querySelector<HTMLElement>('[aria-label="时间刻度"]'); if (!value) throw new Error('Timeline ruler missing'); return value}
async function pointer(element: EventTarget, type: string, clientX: number, options: {pointerId?: number; button?: number} = {}) {
  await act(async () => {
    const event = new MouseEvent(type, {bubbles: true, cancelable: true, clientX, clientY: 20, button: options.button ?? 0})
    Object.defineProperties(event, {pointerId: {value: options.pointerId ?? 7}, isPrimary: {value: true}})
    element.dispatchEvent(event)
  })
}
async function clickAt(element: EventTarget, clientX: number) {
  await pointer(element, 'pointerdown', clientX)
  await pointer(element, 'pointerup', clientX)
  await act(async () => element.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, clientX})))
}
async function press(element: Element, key: string, options: KeyboardEventInit = {}) {await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, key, ...options})))}
async function numeric(label: string, value: string) {await act(async () => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error('Missing numeric alternative: ' + label)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', {bubbles: true}))
})}
function clip(id: string) {const value = props.layers.find(layer => layer.id === id); if (!value) throw new Error('Layer missing'); return value}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  actualRect = {left: 100, width: 1000}
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect(actualRect.left, actualRect.width))
  vi.stubGlobal('ResizeObserver', class {constructor(private callback: ResizeObserverCallback) {} observe(target: Element) {this.callback([{target, contentRect: rect(100, 800)} as ResizeObserverEntry], this as unknown as ResizeObserver)} unobserve() {} disconnect() {}})
  capture = vi.fn(); releaseCapture = vi.fn()
  originalCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setPointerCapture'); originalRelease = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'releasePointerCapture')
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {configurable: true, value: capture})
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {configurable: true, value: releaseCapture})
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  props = {
    duration: 10, fps: 20, time: 0, keys: [camera('key-a', 1), camera('key-b', 4), camera('key-c', 8)],
    layers: [
      {id: 'source', name: '原始旅程参考', type: 'source', in: 0, out: 10, visible: true, locked: true},
      {id: 'route', name: '轨迹片段', type: 'route', in: 2, out: 5, visible: true},
      {id: 'label', name: '地名片段', type: 'marker', in: 1, out: 6, visible: true},
      {id: 'hidden', name: '隐藏片段', type: 'marker', in: 2, out: 6, visible: false},
    ],
    selectedKeyId: 'key-a', selectedLayerId: 'camera', playing: false, recording: false, disabled: false, editDisabled: false,
    onSeek: vi.fn(t => {props = {...props, time: t}; redraw()}), onPlayPause: vi.fn(),
    onSelectKey: vi.fn((id, t) => {props = {...props, selectedKeyId: id, selectedLayerId: 'camera', time: t}; redraw()}),
    onKeyTime: vi.fn((id, t) => {props = {...props, keys: props.keys.map(key => key.id === id ? {...key, t} : key)}; redraw()}),
    onSelectLayer: vi.fn(id => {props = {...props, selectedLayerId: id}; redraw()}),
    onLayerRange: vi.fn((id, range) => {props = {...props, layers: props.layers.map(layer => layer.id === id ? {...layer, ...range} : layer)}; redraw()}),
    onToggleLayer: vi.fn(), onAddKey: vi.fn(),
  }
  integration.points = [{id: 'summit', name: '可编辑地名', coordinates: [114.18, 27.53], description: '', images: []}]
  integration.project = null
  integration.scene = {getCamera: () => ({center: [114.18, 27.5], zoom: 13, bearing: 0, pitch: 45}), renderAt: async () => {}, getCaptureCanvas: () => document.createElement('canvas'), freezeConfiguration: () => () => {}}
  vi.mocked(api).mockResolvedValue({project: null})
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host.remove()
  if (originalCapture) Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', originalCapture); else Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
  if (originalRelease) Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', originalRelease); else Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('editing timeline geometry and seek', () => {
  it('seeks from the actual ruler rectangle rather than a CSS percentage or viewport width', async () => {
    await render(); await clickAt(ruler(), 350)
    expect(props.onSeek).toHaveBeenLastCalledWith(2.5)
    expect(host.querySelector<HTMLInputElement>('[aria-label="当前时间（秒）"]')!.value).toBe('2.5')
  })
  it('accounts for a scrolled ruler through its measured left edge without adding scroll twice', async () => {
    await render(); actualRect = {left: -300, width: 1000}
    const viewport = ruler().parentElement!
    Object.defineProperty(viewport, 'scrollLeft', {configurable: true, value: 400, writable: true})
    await act(async () => viewport.dispatchEvent(new Event('scroll', {bubbles: true})))
    await clickAt(ruler(), 200)
    expect(props.onSeek).toHaveBeenLastCalledWith(5)
  })
  it('keeps click mapping correct after timeline zoom changes the measured ruler width', async () => {
    await render()
    const slider = host.querySelector<HTMLInputElement>('[aria-label="时间轴缩放"]')!
    await numeric('时间轴缩放', slider.max || '160')
    actualRect = {left: 100, width: 2000}
    await clickAt(ruler(), 600)
    expect(props.onSeek).toHaveBeenLastCalledWith(2.5)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.onLayerRange).not.toHaveBeenCalled()
  })
  it('offers current-time numeric seeking as an alternative to precise pointer positioning', async () => {
    await render(); await numeric('当前时间（秒）', '3.25')
    expect(props.onSeek).toHaveBeenLastCalledWith(3.25)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.onLayerRange).not.toHaveBeenCalled()
  })
})

describe('camera keyframe transactions', () => {
  it('shows a drag ghost but changes the document only once at pointer release', async () => {
    await render(); const key = keyButton(1), before = JSON.stringify(props.keys)
    await pointer(key, 'pointerdown', 200); await pointer(key, 'pointermove', 450)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(JSON.stringify(props.keys)).toBe(before)
    expect(props.onSeek).toHaveBeenLastCalledWith(3.5)
    await pointer(key, 'pointerup', 450)
    expect(props.onKeyTime).toHaveBeenCalledExactlyOnceWith('key-a', 3.5)
    await pointer(key, 'pointerup', 450)
    expect(props.onKeyTime).toHaveBeenCalledTimes(1)
  })
  it.each(['pointercancel', 'escape', 'blur'])('discards a ghost on %s without committing a key', async mode => {
    await render({time: .5}); const key = keyButton(1)
    await pointer(key, 'pointerdown', 200); await pointer(key, 'pointermove', 450)
    if (mode === 'pointercancel') await pointer(key, 'pointercancel', 450)
    else if (mode === 'escape') await press(key, 'Escape')
    else await act(async () => window.dispatchEvent(new Event('blur')))
    await pointer(window, 'pointerup', 450)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.keys[0].t).toBe(1)
  })
  it('cancels a pending key drag when recording disables edits, even if a later release arrives', async () => {
    await render(); const key = keyButton(1)
    await pointer(key, 'pointerdown', 200); await pointer(key, 'pointermove', 450)
    await render({disabled: true, editDisabled: true, recording: true})
    await pointer(window, 'pointerup', 450)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.keys[0].t).toBe(1)
  })
  it('removes its pointer transaction on unmount instead of committing it later', async () => {
    await render(); const key = keyButton(1)
    await pointer(key, 'pointerdown', 200); await pointer(key, 'pointermove', 450)
    await act(async () => root!.unmount()); root = null
    await pointer(window, 'pointerup', 450)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.onLayerRange).not.toHaveBeenCalled()
  })
  it('ignores another pointer while a captured keyframe transaction is active', async () => {
    await render(); const key = keyButton(1)
    await pointer(key, 'pointerdown', 200, {pointerId: 7})
    await pointer(key, 'pointermove', 450, {pointerId: 9}); await pointer(key, 'pointerup', 450, {pointerId: 9})
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.keys[0].t).toBe(1)
    await pointer(key, 'pointermove', 450, {pointerId: 7}); await pointer(key, 'pointerup', 450, {pointerId: 7})
    expect(props.onKeyTime).toHaveBeenCalledExactlyOnceWith('key-a', 3.5)
  })
  it('rejects a drag onto another key at the same time without replacing or swallowing its identity', async () => {
    await render(); const before = JSON.stringify(props.keys), key = keyButton(1)
    await pointer(key, 'pointerdown', 200); await pointer(key, 'pointermove', 500); await pointer(key, 'pointerup', 500)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(JSON.stringify(props.keys)).toBe(before)
    expect(props.keys.map(value => value.id)).toEqual(['key-a', 'key-b', 'key-c'])
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/关键帧|同.*时间|占用/)
  })
  it('uses one frame for arrow keys and ten frames with Shift while leaving keyup passive', async () => {
    await render(); const key = keyButton(1)
    await press(key, 'ArrowRight')
    expect(props.onKeyTime).toHaveBeenLastCalledWith('key-a', 1.05)
    const changed = keyButton(1.05)
    await press(changed, 'ArrowRight', {shiftKey: true})
    expect(props.onKeyTime).toHaveBeenLastCalledWith('key-a', 1.55)
    await act(async () => changed.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true, key: 'ArrowRight'})))
    expect(props.onKeyTime).toHaveBeenCalledTimes(2)
  })
})

describe('clip editing and layer locks', () => {
  it('moves a full clip as one transaction and clamps its range to the composition without changing its length', async () => {
    await render(); const item = button('移动片段：轨迹片段')
    await pointer(item, 'pointerdown', 400); await pointer(item, 'pointermove', 1500)
    expect(props.onLayerRange).not.toHaveBeenCalled(); expect([clip('route').in, clip('route').out]).toEqual([2, 5])
    await pointer(item, 'pointerup', 1500)
    expect(props.onLayerRange).toHaveBeenCalledExactlyOnceWith('route', {in: 7, out: 10}, 'move')
    expect(clip('route').out - clip('route').in).toBe(3)
  })
  it('keeps at least one frame when trimming either edge past its opposite edge', async () => {
    await render(); const first = button('调整入点：轨迹片段')
    await pointer(first, 'pointerdown', 300); await pointer(first, 'pointermove', 900); await pointer(first, 'pointerup', 900)
    expect(props.onLayerRange).toHaveBeenLastCalledWith('route', {in: 4.95, out: 5}, 'start')
    await render({layers: props.layers.map(layer => layer.id === 'route' ? {...layer, in: 2, out: 5} : layer)})
    const last = button('调整出点：轨迹片段')
    await pointer(last, 'pointerdown', 600); await pointer(last, 'pointermove', 100); await pointer(last, 'pointerup', 100)
    expect(props.onLayerRange).toHaveBeenLastCalledWith('route', {in: 2, out: 2.05}, 'end')
  })
  it('provides frame keyboard alternatives for clip movement and edge trimming', async () => {
    await render(); await press(button('移动片段：轨迹片段'), 'ArrowRight')
    expect(props.onLayerRange).toHaveBeenLastCalledWith('route', {in: 2.05, out: 5.05}, 'move')
    await press(button('调整入点：轨迹片段'), 'ArrowRight', {shiftKey: true})
    expect(props.onLayerRange).toHaveBeenLastCalledWith('route', {in: 2.55, out: 5.05}, 'start')
    await press(button('调整出点：轨迹片段'), 'ArrowLeft')
    expect(props.onLayerRange).toHaveBeenLastCalledWith('route', {in: 2.55, out: 5}, 'end')
  })
  it('shows hidden layers only on explicit request and does not change their visibility while filtering', async () => {
    await render()
    expect(host.querySelector('button[aria-label="移动片段：隐藏片段"]')).toBeNull()
    const filter = host.querySelector<HTMLInputElement>('[aria-label="显示隐藏图层"]')!
    await act(async () => filter.click())
    expect(button('移动片段：隐藏片段')).toBeTruthy()
    expect(props.onToggleLayer).not.toHaveBeenCalled(); expect(clip('hidden').visible).toBe(false)
  })
  it('keeps source reference clips read only for pointer, keyboard and visibility edits', async () => {
    await render(); const source = button('移动片段：原始旅程参考')
    expect(source.disabled).toBe(true)
    const visibility = host.querySelector<HTMLInputElement>('[aria-label="显示图层：原始旅程参考"]')!
    expect(visibility.disabled).toBe(true); await act(async () => visibility.click())
    await pointer(source, 'pointerdown', 100); await pointer(source, 'pointermove', 350); await pointer(source, 'pointerup', 350); await press(source, 'ArrowRight')
    expect(props.onLayerRange).not.toHaveBeenCalled(); expect(props.onToggleLayer).not.toHaveBeenCalled()
    expect([clip('source').in, clip('source').out]).toEqual([0, 10])
  })
  it('can disable unsupported visibility controls while retaining clip time editing', async () => {
    await render({layers: props.layers.map(layer => layer.id === 'label' ? {...layer, visibilityLocked: true} : layer)})
    const visibility = host.querySelector<HTMLInputElement>('[aria-label="显示图层：地名片段"]')!
    expect(visibility.disabled).toBe(true); await act(async () => visibility.click())
    expect(props.onToggleLayer).not.toHaveBeenCalled()
    const item = button('移动片段：地名片段'); expect(item.disabled).toBe(false)
    await press(item, 'ArrowRight'); expect(props.onLayerRange).toHaveBeenLastCalledWith('label', {in: 1.05, out: 6.05}, 'move')
  })
  it('disables document edits while locked and rejects synthetic pointer and key events too', async () => {
    await render({disabled: true, editDisabled: true, recording: true})
    const key = keyButton(1), item = button('移动片段：轨迹片段')
    expect(key.disabled).toBe(true); expect(item.disabled).toBe(true); expect(button('添加关键帧').disabled).toBe(true)
    expect(host.querySelector<HTMLInputElement>('[aria-label="当前时间（秒）"]')!.disabled).toBe(true)
    await pointer(key, 'pointerdown', 200); await pointer(key, 'pointermove', 450); await pointer(key, 'pointerup', 450); await press(item, 'ArrowRight')
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.onLayerRange).not.toHaveBeenCalled(); expect(props.onAddKey).not.toHaveBeenCalled()
  })
  it('cancels an in-progress clip ghost when its edit lock changes before release', async () => {
    await render(); const item = button('移动片段：轨迹片段')
    await pointer(item, 'pointerdown', 400); await pointer(item, 'pointermove', 550)
    await render({editDisabled: true}); await pointer(window, 'pointerup', 550)
    expect(props.onLayerRange).not.toHaveBeenCalled(); expect([clip('route').in, clip('route').out]).toEqual([2, 5])
  })
})

describe('independent keyframe lanes', () => {
  function multiLaneProps(): Partial<GeoMotionTimelineProps> {
    return {
      keys: [], selectedKeyId: 'shared', selectedLaneId: 'route',
      keyLanes: [{id: 'camera', name: '相机', keys: [{id: 'shared', t: 1}, {id: 'camera-other', t: 1.05}]}, {id: 'route', name: '路线进度', keys: [{id: 'shared', t: 1}, {id: 'route-other', t: 4}]}],
      onSelectLane: vi.fn(id => {props = {...props, selectedLaneId: id}; redraw()}),
      onSelectKey: vi.fn((id, t, laneId) => {props = {...props, selectedKeyId: id, selectedLaneId: laneId, time: t}; redraw()}),
      onKeyTime: vi.fn((id, t, laneId) => {props = {...props, keyLanes: props.keyLanes!.map(lane => lane.id === laneId ? {...lane, keys: lane.keys.map(key => key.id === id ? {...key, t} : key)} : lane)}; redraw()}),
    }
  }
  it('edits structural keys and checks keyboard collisions only within the selected lane', async () => {
    await render(multiLaneProps())
    expect(button('路线进度关键帧 1 秒').getAttribute('aria-pressed')).toBe('true')
    expect(button('相机关键帧 1 秒').getAttribute('aria-pressed')).toBe('false')
    await press(button('路线进度关键帧 1 秒'), 'ArrowRight')
    expect(props.onKeyTime).toHaveBeenLastCalledWith('shared', 1.05, 'route')
    expect(props.keyLanes![0].keys[0].t).toBe(1)
    await press(button('相机关键帧 1 秒'), 'ArrowRight')
    expect(props.onKeyTime).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('原关键帧保留')
    expect(props.onLayerRange).not.toHaveBeenCalled()
  })
  it('keeps duplicate key IDs separate while dragging and commits only to their own lane', async () => {
    await render(multiLaneProps()); const route = button('路线进度关键帧 1 秒')
    await pointer(route, 'pointerdown', 200); await pointer(route, 'pointermove', 450)
    expect(button('相机关键帧 1 秒').classList.contains('is-dragging')).toBe(false)
    expect(button('路线进度关键帧 3.5 秒').classList.contains('is-dragging')).toBe(true)
    expect(props.onKeyTime).not.toHaveBeenCalled()
    await pointer(route, 'pointerup', 450)
    expect(props.onKeyTime).toHaveBeenCalledExactlyOnceWith('shared', 3.5, 'route')
    expect(props.keyLanes![0].keys[0].t).toBe(1)
    expect(props.keyLanes![1].keys[0].t).toBe(3.5)
  })
  it('adds on the selected lane and rejects a same-lane drag collision without swallowing key identity', async () => {
    await render(multiLaneProps()); await act(async () => button('添加关键帧').click())
    expect(props.onAddKey).toHaveBeenLastCalledWith('route')
    const route = button('路线进度关键帧 1 秒')
    await pointer(route, 'pointerdown', 200); await pointer(route, 'pointermove', 500); await pointer(route, 'pointerup', 500)
    expect(props.onKeyTime).not.toHaveBeenCalled(); expect(props.keyLanes![1].keys.map(key => key.id)).toEqual(['shared', 'route-other'])
    const lane = host.querySelector<HTMLButtonElement>('[data-key-lane=camera]')!.previousElementSibling!.querySelector<HTMLButtonElement>('button')!
    await act(async () => lane.click()); await act(async () => button('添加关键帧').click())
    expect(props.onAddKey).toHaveBeenLastCalledWith('camera')
    expect(props.onSelectLane).toHaveBeenLastCalledWith('camera')
  })
})

describe('timeline and numeric inspector integration', () => {
  it('selects a clip on the timeline and exposes right-side numeric window edits without touching source data', async () => {
    const sourceBefore = JSON.stringify(track), pointsBefore = JSON.stringify(integration.points)
    const document = createGeoMotionProject({...track, segmentStarts: [0]}, integration.points).document
    vi.mocked(api).mockResolvedValue({project: {trackId: track.id, sourceFingerprint: 'existing', revision: 'revision-1', document}})
    await act(async () => root!.render(createElement(GeoMotionEditor, {track, basemap: 'none', onBasemap: vi.fn(), onCancel: vi.fn(), onCases: vi.fn()})))
    await act(async () => button('移动片段：可编辑地名').click())
    await numeric('开始显示（秒）', '2'); await numeric('结束显示（秒）', '7')
    const marker = Object.values(integration.project!.nodes).find(node => node.type === 'marker')!
    expect(marker.in).toBe(2); expect(marker.out).toBe(7)
    const firstKey = geoCameraKeys(integration.project!)[0]
    await act(async () => keyButton(firstKey.t).click())
    await numeric('关键帧时间（秒）', '5')
    expect(geoCameraKeys(integration.project!).find(key => key.id === firstKey.id)!.t).toBe(5)
    const keysBeforeCollision = JSON.stringify(geoCameraKeys(integration.project!))
    const otherKey = geoCameraKeys(integration.project!).find(key => key.id !== firstKey.id)!
    await numeric('关键帧时间（秒）', String(otherKey.t))
    expect(JSON.stringify(geoCameraKeys(integration.project!))).toBe(keysBeforeCollision)
    expect(host.textContent).toContain('此时间已有关键帧')
    expect(JSON.stringify(track)).toBe(sourceBefore); expect(JSON.stringify(integration.points)).toBe(pointsBefore)
    expect(vi.mocked(api).mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })
})
