// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorMap, type EditorMapProps, type EditorTool} from '../src/client/EditorMap.tsx'
import type {TrackPoint} from '../src/protocol.ts'

type FakeMap = {
  canvas: HTMLCanvasElement; panEnabled: boolean
  sources: Map<string, {data: unknown; setData: ReturnType<typeof vi.fn>}>
  dragPan: {enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>}
  remove: ReturnType<typeof vi.fn>
  project: (point: readonly number[]) => {x: number; y: number}
  emit: (name: string, value?: unknown) => void
}
const state = vi.hoisted(() => ({maps: [] as FakeMap[], hitIndex: 1 as number | null}))
vi.mock('maplibre-gl', () => ({
  Map: class {
    canvas = document.createElement('canvas')
    sources = new Map<string, {data: unknown; setData: ReturnType<typeof vi.fn>}>()
    layers = new Map<string, unknown>()
    handlers = new Map<string, ((value?: unknown) => void)[]>()
    style = {_loaded: true}
    panEnabled = true
    dragPan = {enable: vi.fn(() => {this.panEnabled = true}), disable: vi.fn(() => {this.panEnabled = false})}
    touchZoomRotate = {disableRotation: vi.fn()}
    addControl = vi.fn()
    fitBounds = vi.fn()
    jumpTo = vi.fn()
    getCanvas = () => this.canvas
    getBounds = () => ({contains: () => true})
    getStyle = () => ({version: 8, sources: Object.fromEntries(this.sources), layers: [...this.layers.values()]})
    getSource = (id: string) => this.sources.get(id)
    getLayer = (id: string) => this.layers.get(id)
    addSource = (id: string, initial: {data: unknown}) => {
      const value = {data: initial.data, setData: vi.fn((data: unknown) => {value.data = data})}
      this.sources.set(id, value)
    }
    addLayer = (layer: {id: string}) => this.layers.set(layer.id, layer)
    setStyle = vi.fn(() => {this.sources.clear(); this.layers.clear(); queueMicrotask(() => this.emit('styledata'))})
    project = (point: readonly number[]) => ({x: (point[0] - 119) * 10000, y: (point[1] - 30) * 10000})
    unproject = (pixel: readonly number[]) => ({lng: 119 + pixel[0] / 10000, lat: 30 + pixel[1] / 10000})
    queryRenderedFeatures = () => state.hitIndex === null ? [] : [{properties: {index: state.hitIndex}}]
    on(name: string, handler: (value?: unknown) => void) {this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])}
    emit(name: string, value?: unknown) {for (const handler of this.handlers.get(name) ?? []) handler(value)}
    remove = vi.fn(() => {this.handlers.clear(); this.canvas.remove()})
    constructor(options: {container: HTMLElement}) {
      options.container.appendChild(this.canvas)
      this.canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON() {}})
      state.maps.push(this)
    }
  },
  NavigationControl: class {}, AttributionControl: class {},
}))

const POINTS: TrackPoint[] = [[119, 30, 100, null], [119.01, 30.01, 200, null], [119.02, 30.02, 300, null]]
const OTHER: TrackPoint[] = [[119.1, 30.1, null, null], [119.11, 30.11, null, null]]
let node: HTMLDivElement
let root: Root | null
let props: EditorMapProps
let documentAdd: ReturnType<typeof vi.spyOn>
let documentRemove: ReturnType<typeof vi.spyOn>
let windowAdd: ReturnType<typeof vi.spyOn>
let windowRemove: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state.maps = []; state.hitIndex = 1
  documentAdd = vi.spyOn(document, 'addEventListener'); documentRemove = vi.spyOn(document, 'removeEventListener')
  windowAdd = vi.spyOn(window, 'addEventListener'); windowRemove = vi.spyOn(window, 'removeEventListener')
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node)
  props = {
    parts: [{id: 'a', name: 'A段', points: POINTS}, {id: 'b', name: 'B段', points: OTHER}], activePartId: 'a', selectedIndices: [],
    tool: 'select', basemap: 'none', onBasemap: vi.fn(), onSelectPoint: vi.fn(), onMovePoint: vi.fn(),
    onAddPoint: vi.fn(), onInsertPoint: vi.fn(), onFreehand: vi.fn(),
  }
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null; node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render(next: Partial<EditorMapProps> = {}) {
  props = {...props, ...next}
  await act(async () => root!.render(createElement(EditorMap, props)))
}
function event(x = 100, y = 100) {
  return {originalEvent: new MouseEvent('mousedown', {button: 0}), point: {x, y}, lngLat: {lng: 119 + x / 10000, lat: 30 + y / 10000}, preventDefault: vi.fn()}
}
async function down(x = 100, y = 100) {await act(async () => state.maps[0].emit('mousedown', event(x, y)))}
async function move(x = 200, y = 200) {await act(async () => document.dispatchEvent(new MouseEvent('mousemove', {clientX: x, clientY: y, bubbles: true})))}
async function up() {await act(async () => document.dispatchEvent(new MouseEvent('mouseup', {button: 0, bubbles: true})))}
function expectNoCommit() {
  expect(props.onMovePoint).not.toHaveBeenCalled(); expect(props.onSelectPoint).not.toHaveBeenCalled(); expect(props.onFreehand).not.toHaveBeenCalled()
}
function expectPreviewEmpty() {expect(state.maps[0].sources.get('cqai-track-edit-preview')?.data).toEqual({type: 'FeatureCollection', features: []})}

describe('editor map immutable gesture ownership and cleanup', () => {
  it('commits a normal point drag once on document mouseup and suppresses its synthetic click', async () => {
    await render(); await down(); expect(state.maps[0].panEnabled).toBe(false)
    await move(); expect(props.onMovePoint).not.toHaveBeenCalled()
    await up()
    expect(props.onMovePoint).toHaveBeenCalledExactlyOnceWith(1, 119.02, 30.02)
    expect(props.onSelectPoint).toHaveBeenCalledExactlyOnceWith(1)
    expect(state.maps[0].panEnabled).toBe(true); expectPreviewEmpty()
    await act(async () => state.maps[0].emit('click', event(200, 200)))
    expect(props.onMovePoint).toHaveBeenCalledOnce(); expect(props.onSelectPoint).toHaveBeenCalledOnce()
  })
  it('commits one entire freehand stroke on document mouseup', async () => {
    await render({tool: 'freehand'}); await down(50, 50); await move(100, 100); await move(150, 150)
    expect(props.onFreehand).not.toHaveBeenCalled(); await up()
    expect(props.onFreehand).toHaveBeenCalledExactlyOnceWith([[119.005, 30.005], [119.01, 30.01], [119.015, 30.015]])
    expect(props.onMovePoint).not.toHaveBeenCalled(); expect(state.maps[0].panEnabled).toBe(true); expectPreviewEmpty()
  })
  it('cancels a drag when selecting another part instead of applying the old index to that part', async () => {
    await render(); await down(); await move()
    await render({activePartId: 'b'}); await up()
    expectNoCommit(); expect(state.maps[0].panEnabled).toBe(true); expectPreviewEmpty()
    expect(OTHER[1]).toEqual([119.11, 30.11, null, null])
  })
  it('cancels a drag when undo/redo replaces the current immutable points array', async () => {
    await render(); await down(); await move()
    const reverted = [...POINTS]; reverted[1] = [119.03, 30.03, 500, null]
    await render({parts: [{...props.parts[0], points: reverted}, props.parts[1]]}); await up()
    expectNoCommit(); expect(reverted[1]).toEqual([119.03, 30.03, 500, null]); expect(state.maps[0].panEnabled).toBe(true)
  })
  it('retains a gesture when only unrelated part metadata changes', async () => {
    await render(); await down(); await move()
    await render({parts: [props.parts[0], {...props.parts[1], name: '新的B段名称'}]}); await up()
    expect(props.onMovePoint).toHaveBeenCalledExactlyOnceWith(1, 119.02, 30.02)
  })
  it.each(['draw', 'insert', 'split', 'connect', 'freehand'] as EditorTool[])('cancels an old select drag when the tool changes to %s', async tool => {
    await render(); await down(); await move(); await render({tool}); await up()
    expectNoCommit(); expect(state.maps[0].panEnabled).toBe(true); expectPreviewEmpty()
  })
  it('cancels on disabled/readOnly transitions even if the editor is re-enabled before mouseup', async () => {
    await render(); await down(); await move(); await render({disabled: true}); await render({disabled: false}); await up()
    expectNoCommit(); expect(state.maps[0].panEnabled).toBe(true)
    await down(); await move(); await render({readOnly: true}); await render({readOnly: false}); await up()
    expectNoCommit(); expect(state.maps[0].panEnabled).toBe(true)
  })
  it('cancels a freehand stroke when an asynchronous library load changes the active part', async () => {
    await render({tool: 'freehand'}); await down(50, 50); await move(100, 100)
    await render({disabled: true}); await render({activePartId: 'b', disabled: false}); await up()
    expectNoCommit(); expect(state.maps[0].panEnabled).toBe(true); expectPreviewEmpty()
  })
  it('cancels on window blur and restores pan without committing a later mouseup', async () => {
    await render(); await down(); await move()
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(state.maps[0].panEnabled).toBe(true); expectPreviewEmpty()
    await move(300, 300); await up(); expectNoCommit()
  })
  it('keeps Escape cancellation working for both drag and freehand gestures', async () => {
    await render(); await down(); await move()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    await up(); expectNoCommit(); expectPreviewEmpty()
    await render({tool: 'freehand'}); await down(50, 50); await move(100, 100)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    await up(); expectNoCommit(); expect(state.maps[0].panEnabled).toBe(true)
  })
  it('releases document/window listeners, cancels an active gesture and removes the MapLibre map once', async () => {
    await render(); await down(); await move()
    const documentListeners = ['mousemove', 'mouseup', 'keydown'].map(name => [name, documentAdd.mock.calls.find((call: unknown[]) => call[0] === name)![1]] as const)
    const blurListener = windowAdd.mock.calls.find((call: unknown[]) => call[0] === 'blur')![1]
    await act(async () => root!.unmount()); root = null
    for (const [name, listener] of documentListeners) expect(documentRemove).toHaveBeenCalledWith(name, listener)
    expect(windowRemove).toHaveBeenCalledWith('blur', blurListener)
    expect(state.maps[0].remove).toHaveBeenCalledOnce(); expect(state.maps[0].panEnabled).toBe(true)
    await move(300, 300); await up(); await act(async () => window.dispatchEvent(new Event('blur')))
    expectNoCommit(); expect(state.maps[0].remove).toHaveBeenCalledOnce()
  })
  it('does not begin a modifying gesture when the map is read-only', async () => {
    await render({readOnly: true, tool: 'freehand'}); await down(50, 50); await move(100, 100); await up()
    expectNoCommit(); expect(state.maps[0].dragPan.disable).not.toHaveBeenCalled()
  })
})

