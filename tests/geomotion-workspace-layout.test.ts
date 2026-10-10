// @vitest-environment jsdom
import {act, createElement, useEffect} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {GeoMotionEditor} from '../src/client/GeoMotionEditor.tsx'
import type {GeoMotionSceneHandle} from '../src/client/GeoMotionScene.tsx'
import {api} from '../src/client/util.ts'
import {DEFAULT_MAP_SETTINGS} from '../src/track/map-settings.ts'
import {createGeoMotionProject, geoCameraKeys, geoNewKey, type GeoMotionProject} from '../src/track/geomotion.ts'
import {cameraFromShots, createLayer, projectWith} from '../src/track/vendor/geomotion/document/index.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord} from '../src/protocol.ts'

type SceneProps = {project: GeoMotionProject; onReady: (handle: GeoMotionSceneHandle | null) => void}
const state = vi.hoisted(() => ({props: null as SceneProps | null, scene: null as GeoMotionSceneHandle | null, mounts: 0, unmounts: 0}))
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: () => ({
  points: [], groups: [], loading: false, editReady: true, error: '', stateError: '', routeError: '', routeContext: {segmentStarts: [0]}, retry: vi.fn(),
})}))
vi.mock('../src/client/map-settings.tsx', () => ({useMapSettings: () => ({settings: DEFAULT_MAP_SETTINGS}), BasemapControls: () => null}))
vi.mock('../src/client/GeoMotionScene.tsx', () => ({GeoMotionScene: (props: SceneProps) => {
  state.props = props
  useEffect(() => {state.mounts++; return () => {state.unmounts++}}, [])
  useEffect(() => {props.onReady(state.scene); return () => props.onReady(null)}, [props.onReady])
  return createElement('div', {'data-testid': 'retained-workspace-scene'})
}}))
vi.mock('../src/client/util.ts', async original => ({...await original<typeof import('../src/client/util.ts')>(), api: vi.fn(), download: vi.fn()}))

const coordinates: TrackRecord['coordinates'] = [[114.17, 27.54, 600, null], [114.18, 27.53, 1100, null], [114.19, 27.48, 1600, null]]
const track: TrackRecord = {id: 'workspace-layout', name: '大工程布局测试', format: 'gpx', filename: 'layout.gpx', createdAt: '2026-10-10', bytes: 80, points: coordinates.length, coordinates, metrics: editedMetrics(coordinates)}
let host: HTMLDivElement, root: Root, onCancel: () => void, initial: GeoMotionProject
const layerId = (index: number) => `layer-${String(index).padStart(2, '0')}`
const layerName = (index: number) => `节点 ${String(index).padStart(2, '0')}`
function documentFixture() {
  const keys = Array.from({length: 24}, (_, index) => ({...geoNewKey(index * 3, {center: [114.18, 27.5], zoom: 12, bearing: 0, pitch: 45}), id: `camera-key-${index}`}))
  const layers = Array.from({length: 72}, (_, index) => createLayer('text', 0, {id: layerId(index + 1), name: layerName(index + 1), text: `测试文字 ${index + 1}`, in: 0, out: 78, fade: 0}))
  return projectWith([cameraFromShots(keys, {id: 'camera', name: '相机'}), ...layers], {name: '72 图层与 24 相机关键帧', duration: 78, width: 1280, height: 720, fps: 30, basemap: 'none', terrain: false})
}
function envelope(document: GeoMotionProject, revision = 'saved-1') {
  return {schema: 'cqai-track-geomotion@1', trackId: track.id, sourceFingerprint: createGeoMotionProject({...track, segmentStarts: [0]}, []).sourceFingerprint, revision, document}
}
function current() {if (!state.props) throw new Error('Scene is not ready'); return state.props.project}
function button(label: string, within: ParentNode = host) {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === label || value.textContent === label)
  if (!found) throw new Error('Missing button: ' + label)
  return found
}
async function click(label: string, within: ParentNode = host) {await act(async () => button(label, within).click())}
function input(label: string) {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!found) throw new Error('Missing input: ' + label)
  return found
}
async function edit(label: string, value: string) {await act(async () => {
  const target = input(label)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
  target.dispatchEvent(new Event('input', {bubbles: true}))
})}
function scene() {return host.querySelector('[data-testid="retained-workspace-scene"]')}
function workspace() {return host.querySelector<HTMLElement>('[aria-label="地图场景镜头编辑"]')!}
function writes() {return vi.mocked(api).mock.calls.filter(([, payload]) => payload !== undefined)}
async function render() {await act(async () => root.render(createElement(GeoMotionEditor, {track, basemap: 'none', onBasemap: vi.fn(), onCancel, onCases: vi.fn()})))}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  state.props = null; state.mounts = 0; state.unmounts = 0
  state.scene = {getCamera: vi.fn(() => ({center: [114.18, 27.5] as [number, number], zoom: 12, bearing: 0, pitch: 45})), renderAt: vi.fn(async () => {}), getCaptureCanvas: vi.fn(() => document.createElement('canvas')), freezeConfiguration: vi.fn(() => () => {})}
  initial = documentFixture(); onCancel = vi.fn()
  vi.mocked(api).mockImplementation(async (_action, payload) => payload === undefined
    ? {project: envelope(structuredClone(initial))}
    : {project: envelope((payload as {project: {document: GeoMotionProject}}).project.document, 'saved-2')})
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()})

describe('GeoMotion workspace interactions with a large composition', () => {
  it('searches only the sidebar and edits the original selected layer through its native checkbox', async () => {
    await render()
    expect(Object.keys(current().nodes)).toHaveLength(73)
    expect(geoCameraKeys(current())).toHaveLength(24)
    expect(host.querySelector('[aria-label="镜头编辑导航"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="镜头工程操作"]')).not.toBeNull()
    const sidebar = host.querySelector<HTMLElement>('[aria-label="图层和地名"]')!
    const timeline = host.querySelector<HTMLElement>('[aria-label="镜头时间轴"]')!
    expect(sidebar.querySelectorAll('.trk-gm-layer-row')).toHaveLength(72)
    const original = JSON.stringify(current()), retained = scene()
    await edit('搜索图层', '节点 72')
    expect(sidebar.querySelectorAll('.trk-gm-layer-row')).toHaveLength(1)
    expect(timeline.querySelectorAll('button[aria-label^="移动片段："]')).toHaveLength(72)
    expect(timeline.querySelectorAll('button[aria-label^="相机关键帧 "]')).toHaveLength(24)
    expect(JSON.stringify(current())).toBe(original); expect(scene()).toBe(retained)
    await act(async () => sidebar.querySelector<HTMLButtonElement>('.trk-gm-layer-row button')!.click())
    expect(input('图层名称').value).toBe('节点 72')
    const checkbox = input('显示图层：节点 72')
    expect(checkbox.type).toBe('checkbox'); expect(checkbox.checked).toBe(true)
    await act(async () => checkbox.click())
    expect(current().nodes[layerId(72)]).toMatchObject({id: layerId(72), visible: false})
    const restored = structuredClone(current()); restored.nodes[layerId(72)] = initial.nodes[layerId(72)]
    expect(restored).toEqual(initial)
    expect(writes()).toHaveLength(0); expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0)
  })

  it('expands the preview without remounting its scene and restores three columns on timeline selection', async () => {
    await render()
    const retained = scene(), original = JSON.stringify(current()), reads = vi.mocked(api).mock.calls.length
    await click('展开地图预览'); expect(workspace().classList.contains('is-preview-focused')).toBe(true)
    await click('恢复三栏布局'); expect(workspace().classList.contains('is-preview-focused')).toBe(false)
    await click('展开地图预览'); await click('相机关键帧 3 秒')
    expect(workspace().classList.contains('is-preview-focused')).toBe(false)
    expect(button('相机关键帧 3 秒').getAttribute('aria-pressed')).toBe('true')
    await click('展开地图预览'); await click('移动片段：节点 72')
    expect(workspace().classList.contains('is-preview-focused')).toBe(false)
    expect(input('图层名称').value).toBe('节点 72')
    const tabs = host.querySelector<HTMLElement>('[aria-label="编辑面板"]')!
    for (const panel of ['镜头属性', '图层和地名']) {
      await click('展开地图预览')
      expect(workspace().classList.contains('is-preview-focused')).toBe(true)
      expect(host.querySelector('.trk-gm-properties')!.getAttribute('aria-hidden')).toBe('true')
      await click(panel, tabs)
      expect(workspace().classList.contains('is-preview-focused')).toBe(false)
      expect(host.querySelector('.trk-gm-properties')!.getAttribute('aria-hidden')).not.toBe('true')
      expect(host.querySelector('.trk-gm-layers')!.getAttribute('aria-hidden')).not.toBe('true')
    }
    expect(scene()).toBe(retained); expect(state.mounts).toBe(1); expect(state.unmounts).toBe(0)
    expect(JSON.stringify(current())).toBe(original); expect(vi.mocked(api).mock.calls).toHaveLength(reads)
  })

  it('keeps camera sliders and original numeric fields synchronized while protecting and saving the draft', async () => {
    await render()
    const output = [...host.querySelectorAll<HTMLDetailsElement>('.trk-gm-inspector-body details')].find(value => value.querySelector('summary')?.textContent === '工程与输出')
    expect(output).toBeDefined(); expect(output!.open).toBe(false)
    const controls = [
      {label: '缩放级别', field: 'zoom', slider: 14.5, numeric: 9.55},
      {label: '朝向（度）', field: 'bearing', slider: 90, numeric: 65.37},
      {label: '俯仰（度）', field: 'pitch', slider: 55, numeric: 50.5},
      {label: '途中拉远幅度', field: 'dip', slider: 2, numeric: 3.3333},
    ] as const
    for (const control of controls) {
      expect(input(control.label + '滑杆').type).toBe('range'); expect(input(control.label + '滑杆').step).toBe('any'); expect(input(control.label).type).toBe('number')
      await edit(control.label + '滑杆', String(control.slider))
      expect(Number(input(control.label).value)).toBe(control.slider)
      expect(geoCameraKeys(current())[0][control.field]).toBe(control.slider)
      await edit(control.label, String(control.numeric))
      expect(Number(input(control.label + '滑杆').value)).toBe(control.numeric)
      expect(geoCameraKeys(current())[0][control.field]).toBe(control.numeric)
    }
    const retained = scene(), draft = JSON.stringify(current()), trigger = button('返回轨迹')
    trigger.focus(); await click('返回轨迹')
    expect(host.querySelector('[role="dialog"]')).not.toBeNull(); expect(onCancel).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0)
    await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})))
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
    expect(JSON.stringify(current())).toBe(draft); expect(scene()).toBe(retained)
    await click('返回轨迹'); await click('保存后继续')
    expect(writes()).toHaveLength(1)
    expect(writes()[0][1]).toMatchObject({id: track.id, expectedRevision: 'saved-1', project: {document: current()}})
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it('dismisses project file tools with Escape and outside interaction without changing or saving the draft', async () => {
    await render(); await edit('缩放级别', '14')
    const files = host.querySelector<HTMLDetailsElement>('.trk-gm-file-tools')!, summary = files.querySelector('summary')!
    const action = button('导出 JSON', files), outside = input('搜索图层')
    const draft = JSON.stringify(current()), retained = scene(), reads = vi.mocked(api).mock.calls.length
    expect(files.open).toBe(false)
    summary.focus(); await act(async () => summary.click()); expect(files.open).toBe(true)
    action.focus()
    const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
    await act(async () => action.dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true); expect(files.open).toBe(false); expect(document.activeElement).toBe(summary)

    await act(async () => summary.click()); expect(files.open).toBe(true); action.focus()
    await act(async () => outside.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, cancelable: true})))
    expect(files.open).toBe(false)
    // A pointer dismissal leaves focus untouched; the browser can then focus the clicked control.
    expect(document.activeElement).toBe(action)
    outside.focus(); expect(document.activeElement).toBe(outside)

    await act(async () => summary.click()); expect(files.open).toBe(true); action.focus()
    await act(async () => outside.focus())
    expect(files.open).toBe(false); expect(document.activeElement).toBe(outside)
    expect(JSON.stringify(current())).toBe(draft); expect(scene()).toBe(retained)
    expect(host.querySelector('.trk-gm-dirty')).not.toBeNull(); expect(writes()).toHaveLength(0)
    expect(vi.mocked(api).mock.calls).toHaveLength(reads)
  })
})