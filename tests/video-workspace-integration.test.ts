// @vitest-environment jsdom
import {act, createElement, useEffect} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {TrackVideoScript} from '../src/client/TrackVideoScript.tsx'
import {api} from '../src/client/util.ts'
import {generateVideoScript} from '../src/client/video-script-ai.ts'
import {createGeoMotionProject, geoCameraKeys, geoNewKey, geoSetCameraKey, type GeoMotionProject} from '../src/track/geomotion.ts'
import {createShotEditorPlan, evaluateShotEditorFrame, shotEditorTrackFingerprint, type ShotEditorPlan} from '../src/track/shot-editor.ts'
import {extractVideoMaterials, type VideoMaterialsDocument} from '../src/track/video-materials.ts'
import {DEFAULT_MAP_SETTINGS, type MapSettings} from '../src/track/map-settings.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import type {GeoMotionSceneHandle} from '../src/client/GeoMotionScene.tsx'
import type {ShotEditorSceneHandle, ShotEditorSceneProps} from '../src/client/ShotEditorScene.tsx'
import type {ShotEditorProjectEnvelope, ShotEditorProjectInput} from '../src/track/shot-editor-project-types.ts'

type MapSceneProps = {project: GeoMotionProject; time: number; settings: MapSettings; onReady: (handle: GeoMotionSceneHandle | null) => void}
const state = vi.hoisted(() => ({
  points: [] as TrackPlacemark[], routeContext: {segmentStarts: [0, 2], references: []}, preferences: null as MapSettings | null,
  mapProps: null as MapSceneProps | null, mapHandle: null as GeoMotionSceneHandle | null,
  sandboxProps: null as ShotEditorSceneProps | null, sandboxHandle: null as ShotEditorSceneHandle | null,
}))
vi.mock('../src/client/useTrackPlacemarks.ts', () => ({useTrackPlacemarks: () => ({
  points: state.points, groups: [], loading: false, editReady: true, routeReady: true,
  error: '', stateError: '', routeError: '', routeContext: state.routeContext, retry: vi.fn(),
})}))
vi.mock('../src/client/map-settings.tsx', () => ({useMapSettings: () => ({settings: state.preferences}), BasemapControls: () => null}))
vi.mock('../src/client/GeoMotionScene.tsx', () => ({GeoMotionScene: (props: MapSceneProps) => {
  state.mapProps = props
  useEffect(() => {props.onReady(state.mapHandle); return () => props.onReady(null)}, [props.onReady])
  return createElement('div', {'data-renderer': 'map'})
}}))
vi.mock('../src/client/ShotEditorScene.tsx', () => ({ShotEditorScene: (props: ShotEditorSceneProps) => {
  state.sandboxProps = props
  useEffect(() => {props.onReady(state.sandboxHandle); return () => props.onReady(null)}, [props.onReady])
  useEffect(() => {if (props.plan) state.sandboxHandle?.renderAt(props.plan, props.time)}, [props.plan, props.time])
  return createElement('div', {'data-renderer': 'sandbox'})
}}))
vi.mock('../src/client/MapView.tsx', () => ({MapView: () => createElement('div', {'data-renderer': 'planning'})}))
vi.mock('../src/client/useTextModels.ts', () => ({useTextModels: () => ({catalog: {available: false, models: []}, model: '', setModel: vi.fn(), reload: vi.fn()})}))
vi.mock('../src/client/video-script-ai.ts', () => ({generateVideoScript: vi.fn()}))
vi.mock('../src/client/geomotion-video-export.ts', () => ({exportGeoMotionVideo: vi.fn()}))
vi.mock('../src/client/util.ts', async original => ({...await original<typeof import('../src/client/util.ts')>(), api: vi.fn(), download: vi.fn()}))

const coordinates: TrackRecord['coordinates'] = [[114.17, 27.54, 600, null], [114.18, 27.53, 1100, null], [114.19, 27.48, 1600, null], [114.17, 27.45, 1900, null]]
const track: TrackRecord = {id: 'video-workspace', name: '合成工作台测试轨迹', format: 'gpx', filename: 'fixture.gpx', createdAt: '2026-10-09', bytes: 80, points: coordinates.length, coordinates, metrics: editedMetrics(coordinates)}
const points: TrackPlacemark[] = [{id: 'summit', name: '原始山顶', coordinates: [114.18, 27.53], description: '源点位说明', images: []}]
const effectiveTrack = {...track, segmentStarts: [0, 2]}
const legacyKey = 'cqai-track.shot-editor.' + track.id
const camera = {position: [100, 120, 200] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45}
const date = '2026-10-09T00:00:00.000Z'
type MapEnvelope = ReturnType<typeof mapEnvelope>
type MaterialEnvelope = ReturnType<typeof materialEnvelope>
let node: HTMLDivElement, root: Root, onCancel: () => void
let savedMap: MapEnvelope, savedSandbox: ShotEditorProjectEnvelope | null, savedMaterials: MaterialEnvelope
let mapWrites: number, sandboxWrites: number, materialWrites: number
let frames: Map<number, FrameRequestCallback>, frameId: number
let pendingRejects: ((reason?: unknown) => void)[]
let mapWrite: ((payload: MapPayload) => Promise<{project: MapEnvelope}>) | null
let sandboxWrite: ((payload: SandboxPayload) => Promise<{project: ShotEditorProjectEnvelope}>) | null
let materialWrite: ((payload: MaterialPayload) => Promise<{materials: MaterialEnvelope}>) | null
type MapPayload = {id: string; expectedRevision: string | null; project: {trackId: string; sourceFingerprint: string; document: GeoMotionProject}}
type SandboxPayload = {id: string; expectedRevision: string | null; project: ShotEditorProjectInput}
type MaterialPayload = {id: string; expectedRevision: string | null; document: VideoMaterialsDocument}

function mapEnvelope(document: GeoMotionProject, revision = 'map-saved-1') {return {schema: 'cqai-track-geomotion@1' as const, trackId: track.id, sourceFingerprint: createGeoMotionProject(effectiveTrack, points).sourceFingerprint, document: structuredClone(document), revision, updatedAt: date}}
function materialEnvelope(document: VideoMaterialsDocument, revision = 'materials-saved-1') {return {schema: 'cqai-track-video-materials-envelope@1' as const, trackId: track.id, document: structuredClone(document), revision, updatedAt: date}}
function sandboxInput(): ShotEditorProjectInput {
  const plan = createShotEditorPlan({trackId: track.id, fingerprint: createSandboxFingerprint(), sceneFingerprint: 'fixture-scene', title: track.name, camera})
  plan.cameraKeyframes = [
    {id: 'old-camera-start', time: 0, camera: structuredClone(camera), easing: 'smooth'},
    {id: 'old-camera-middle', time: 7, camera: {position: [220, 180, -120], target: [30, 15, 10], fov: 52}, easing: 'linear'},
    {id: 'old-camera-end', time: plan.duration, camera: {position: [-300, 250, 400], target: [-20, 0, 40], fov: 38}, easing: 'smooth'},
  ]
  plan.routeKeyframes = [{id: 'old-route-start', time: 0, progress: 0}, {id: 'old-route-pause', time: 9, progress: .42}, {id: 'old-route-end', time: plan.duration, progress: 1}]
  plan.labels = [{id: 'old-label', sourceId: 'summit', name: '旧镜头地名', coordinates: [114.18, 27.53], from: 2, to: 16}]
  plan.caption = {text: '旧镜头完整字幕', from: 3, to: 18}; plan.routeColor = '#123456'
  return {schema: 'cqai-track-shot-editor@1', plan, appearance: {lighting: {...DEFAULT_MAP_SETTINGS.lighting, azimuth: 137, intensity: 1.6}, sandboxColors: {...DEFAULT_MAP_SETTINGS.sandboxColors, background: '#183042'}, sandboxBackground: 'solid'}}
}
function createSandboxFingerprint() {return shotEditorTrackFingerprint(coordinates, [0, 2])}
function sandboxEnvelope(project: ShotEditorProjectInput, revision = 'sandbox-saved-1'): ShotEditorProjectEnvelope {return {...structuredClone(project), revision, updatedAt: date}}
function deferred<T>() {let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); pendingRejects.push(reject); return {promise, resolve, reject}}
function button(text: string, scope: ParentNode = node) {const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!value) throw new Error('Missing button: ' + text); return value}
async function click(text: string, scope: ParentNode = node) {await act(async () => button(text, scope).click())}
async function tab(text: string) {await click(text, node.querySelector('[role=tablist]')!)}
function selectedTab() {return node.querySelector('[role=tab][aria-selected=true]')!.textContent}
function mapWorkspace() {return node.querySelector<HTMLElement>('[aria-label="地图场景镜头编辑"]')!}
function materialWorkspace() {return node.querySelector<HTMLElement>('[aria-label="二维素材准备编辑器"]')!}
function currentMap() {if (!state.mapProps) throw new Error('Map not rendered'); return state.mapProps.project}
function currentSandbox(): ShotEditorPlan {if (!state.sandboxProps?.plan) throw new Error('Sandbox plan not rendered'); return state.sandboxProps.plan}
function writes(action?: string) {return vi.mocked(api).mock.calls.filter(([name, payload]) => payload !== undefined && (!action || name === action))}
function renderer(name: string | null) {expect([...node.querySelectorAll('[data-renderer]')].map(item => item.getAttribute('data-renderer'))).toEqual(name ? [name] : [])}
async function edit(label: string, value: string, scope: ParentNode = node) {await act(async () => {
  const field = scope.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  if (!field) throw new Error('Missing field: ' + label)
  Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', {bubbles: true}))
})}
async function render() {await act(async () => root.render(createElement(TrackVideoScript, {track, basemap: 'none', onBasemap: vi.fn(), onCancel})))}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear()
  state.points = structuredClone(points); state.routeContext = {segmentStarts: [0, 2], references: []}; state.preferences = structuredClone(DEFAULT_MAP_SETTINGS)
  state.mapProps = null; state.sandboxProps = null
  state.mapHandle = {getCamera: vi.fn(() => ({center: [114.2, 27.5] as [number, number], zoom: 14, pitch: 55, bearing: 70})), renderAt: vi.fn(async () => {}), getCaptureCanvas: vi.fn(() => document.createElement('canvas')), freezeConfiguration: vi.fn(() => () => {})}
  state.sandboxHandle = {sceneFingerprint: 'fixture-scene', getCameraState: vi.fn(() => structuredClone(camera)), applyCameraState: vi.fn(), renderAt: vi.fn((plan, time) => {evaluateShotEditorFrame(plan, time)}), getCaptureCanvas: vi.fn(() => document.createElement('canvas')), resetView: vi.fn()}
  frames = new Map(); frameId = 0; pendingRejects = []; vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {frames.set(++frameId, callback); return frameId})); vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.spyOn(performance, 'now').mockReturnValue(0)
  let project = createGeoMotionProject(effectiveTrack, points).document
  project = geoSetCameraKey(project, geoNewKey(7, {center: [114.19, 27.48], zoom: 15, bearing: 65, pitch: 52}))
  savedMap = mapEnvelope({...project, fps: 24, width: 1920, height: 1080, background: '#112233'})
  savedSandbox = sandboxEnvelope(sandboxInput()); savedMaterials = materialEnvelope(extractVideoMaterials(effectiveTrack, points))
  mapWrites = 0; sandboxWrites = 0; materialWrites = 0; mapWrite = null; sandboxWrite = null; materialWrite = null
  vi.mocked(api).mockImplementation(async (action, payload) => {
    if (action.startsWith('annotations?')) return {annotations: [], saved: false}
    if (action.startsWith('resources?')) return {assets: [], jobs: []}
    if (action === 'openmontage-settings') return {ready:false,settings:{sourceDirectory:'local/source',pythonPath:'python'},issues:['缺少本地连接'],projectsDirectory:'isolated'}
    if (action.startsWith('openmontage-projects?')) return {projects:[]}
    if (action.startsWith('geomotion-project?')) return {project: structuredClone(savedMap)}
    if (action.startsWith('shot-editor-project?')) return {project: structuredClone(savedSandbox)}
    if (action.startsWith('video-materials?')) return {materials: structuredClone(savedMaterials)}
    if (action === 'geomotion-project' && payload !== undefined) {
      const input = payload as MapPayload; if (mapWrite) return mapWrite(input)
      expect(input.expectedRevision).toBe(savedMap.revision); savedMap = mapEnvelope(input.project.document, 'map-confirmed-' + ++mapWrites); return {project: structuredClone(savedMap)}
    }
    if (action === 'shot-editor-project' && payload !== undefined) {
      const input = payload as SandboxPayload; if (sandboxWrite) return sandboxWrite(input)
      expect(input.expectedRevision).toBe(savedSandbox?.revision || null); savedSandbox = sandboxEnvelope(input.project, 'sandbox-confirmed-' + ++sandboxWrites); return {project: structuredClone(savedSandbox)}
    }
    if (action === 'video-materials' && payload !== undefined) {
      const input = payload as MaterialPayload; if (materialWrite) return materialWrite(input)
      expect(input.expectedRevision).toBe(savedMaterials.revision); savedMaterials = materialEnvelope(input.document, 'materials-confirmed-' + ++materialWrites); return {materials: structuredClone(savedMaterials)}
    }
    throw new Error('Unexpected fixture API: ' + action)
  })
  onCancel = vi.fn(); node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {await act(async () => {pendingRejects.forEach(reject => reject(new Error('fixture cleanup')))}); await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()})

describe('video workspace with real editor drafts and controlled scenes', () => {
  it('opens the map editor read-only and never starts AI or a second renderer', async () => {
    const source = JSON.stringify(track), sourcePoints = JSON.stringify(state.points)
    await render(); expect(selectedTab()).toBe('镜头编辑'); renderer('map'); expect(currentMap()).toEqual(savedMap.document)
    expect(writes()).toHaveLength(0); expect(generateVideoScript).not.toHaveBeenCalled()
    expect(JSON.stringify(track)).toBe(source); expect(JSON.stringify(state.points)).toBe(sourcePoints)
    expect(node.textContent).not.toContain('镜头案例')
  })
  it('guards root tabs once, preserves cancellation and failed saves, and waits for confirmation before switching', async () => {
    await render(); const mounted = mapWorkspace()
    await edit('镜头时长（秒）', '26'); const editedKeys = structuredClone(geoCameraKeys(currentMap())); await tab('素材准备')
    expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1); expect(selectedTab()).toBe('镜头编辑'); expect(writes()).toHaveLength(0)
    await click('取消', node.querySelector('[role=dialog]')!); expect(currentMap().duration).toBe(26); renderer('map')
    mapWrite = async () => {throw Object.assign(new Error('fixture revision conflict'), {status: 409})}
    await tab('素材准备'); await click('保存后继续', node.querySelector('[role=dialog]')!)
    expect(selectedTab()).toBe('镜头编辑'); expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1); expect(currentMap().duration).toBe(26)
    expect(node.textContent).toContain('当前编辑保留'); await click('取消', node.querySelector('[role=dialog]')!)
    const saving = deferred<{project: MapEnvelope}>(); mapWrite = () => saving.promise
    await tab('素材准备'); await click('保存后继续', node.querySelector('[role=dialog]')!)
    expect([...node.querySelector('[aria-label="视频制作内容"]')!.querySelectorAll<HTMLButtonElement>('[role=tab]')].every(item => item.disabled)).toBe(true); expect(selectedTab()).toBe('镜头编辑')
    const payload = writes('geomotion-project').at(-1)![1] as MapPayload
    expect(payload.expectedRevision).toBe('map-saved-1'); expect(geoCameraKeys(payload.project.document)).toEqual(editedKeys)
    savedMap = mapEnvelope(payload.project.document, 'map-confirmed-1')
    await act(async () => saving.resolve({project: savedMap})); expect(selectedTab()).toBe('素材准备'); renderer(null); expect(node.querySelector('[role=dialog]')).toBeNull()
    expect(mapWorkspace()).toBe(mounted); mapWrite = null; await tab('镜头编辑'); renderer('map'); expect(currentMap()).toEqual(savedMap.document)
  })
  it('discards only the current map edits and retains the mounted baseline and its complete keys', async () => {
    await render(); const mounted = mapWorkspace(), baseline = structuredClone(savedMap.document)
    await edit('镜头时长（秒）', '31'); await tab('脚本策划'); await click('放弃本次修改', node.querySelector('[role=dialog]')!)
    expect(selectedTab()).toBe('脚本策划'); renderer(null); expect(node.textContent).toContain('OpenMontage'); expect(mapWorkspace()).toBe(mounted); expect(writes()).toHaveLength(0)
    await tab('镜头编辑'); renderer('map'); expect(currentMap()).toEqual(baseline); expect(node.querySelector('[role=dialog]')).toBeNull()
  })
  it('restores the entire saved sandbox project across scenes with only one active renderer and no extra GET', async () => {
    const expected = structuredClone(savedSandbox!); await render(); await click('3D 沙盘', node.querySelector('[aria-label="镜头场景"]')!)
    renderer('sandbox'); expect(currentSandbox()).toEqual(expected.plan); expect(state.sandboxProps!.settings.lighting).toEqual(expected.appearance.lighting)
    expect(state.sandboxProps!.settings.sandboxColors).toEqual(expected.appearance.sandboxColors); const mounted = node.querySelector('[aria-label="三维场景镜头编辑"]') || node.querySelector('.trk-shot-editor')
    expect(mounted).not.toBeNull()
    await click('地图', node.querySelector('[aria-label="镜头场景"]')!); renderer('map'); expect(currentMap()).toEqual(savedMap.document)
    await click('3D 沙盘', node.querySelector('[aria-label="镜头场景"]')!); renderer('sandbox'); expect(currentSandbox()).toEqual(expected.plan)
    expect(node.querySelector('[aria-label="三维场景镜头编辑"]') || node.querySelector('.trk-shot-editor')).toBe(mounted)
    expect(vi.mocked(api).mock.calls.filter(([name]) => name.startsWith('shot-editor-project?'))).toHaveLength(1); expect(writes()).toHaveLength(0)
  })
  it('uses sandbox registration for root cancellation and explicit saves without dropping old keyframes or appearance', async () => {
    const expected = structuredClone(savedSandbox!); await render(); await click('3D 沙盘', node.querySelector('[aria-label="镜头场景"]')!)
    await edit('画面标题', '新沙盘镜头标题'); await tab('素材准备'); expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1)
    await click('取消', node.querySelector('[role=dialog]')!); expect(currentSandbox().title).toBe('新沙盘镜头标题'); renderer('sandbox'); expect(writes()).toHaveLength(0)
    await tab('素材准备'); await click('保存后继续', node.querySelector('[role=dialog]')!)
    expect(selectedTab()).toBe('素材准备'); renderer(null); expect(node.querySelector('[role=dialog]')).toBeNull()
    const payload = writes('shot-editor-project')[0][1] as SandboxPayload
    expect(payload.expectedRevision).toBe('sandbox-saved-1'); expect(payload.project).toEqual({schema: expected.schema, appearance: expected.appearance, plan: {...expected.plan, title: '新沙盘镜头标题'}})
    await tab('镜头编辑'); renderer('sandbox'); expect(currentSandbox()).toEqual(payload.project.plan)
    expect(writes('shot-editor-project')).toHaveLength(1); expect(onCancel).not.toHaveBeenCalled()
  })
  it('imports a legacy sandbox cache completely without rewriting it and saves migration only after a root decision', async () => {
    const legacy = sandboxInput(), bytes = JSON.stringify(legacy); savedSandbox = null; localStorage.setItem(legacyKey, bytes)
    await render(); await click('3D 沙盘', node.querySelector('[aria-label="镜头场景"]')!)
    renderer('sandbox'); expect(currentSandbox()).toEqual(legacy.plan); expect(writes()).toHaveLength(0); expect(localStorage.getItem(legacyKey)).toBe(bytes)
    await edit('画面标题', '显式保存旧镜头'); await click('地图', node.querySelector('[aria-label="镜头场景"]')!)
    expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1); await click('保存后继续', node.querySelector('[role=dialog]')!)
    renderer('map'); const payload = writes('shot-editor-project')[0][1] as SandboxPayload
    expect(payload.expectedRevision).toBeNull(); expect(payload.project).toEqual({...legacy, plan: {...legacy.plan, title: '显式保存旧镜头'}})
    expect(localStorage.getItem(legacyKey)).toBe(bytes); await click('3D 沙盘', node.querySelector('[aria-label="镜头场景"]')!); expect(currentSandbox()).toEqual(payload.project.plan)
  })
  it('composes only after the material save and accepts subsequent confirmations while preserving all camera keys', async () => {
    await render(); const keys = structuredClone(geoCameraKeys(currentMap())); await tab('素材准备'); const mounted = materialWorkspace()
    await edit('标记名称', '第一次确认地名'); const saving = deferred<{materials: MaterialEnvelope}>(); materialWrite = () => saving.promise
    await click('用所选素材编排镜头', materialWorkspace()); expect(selectedTab()).toBe('素材准备'); expect(node.querySelector('[role=dialog]')).toBeNull(); renderer(null)
    const payload = writes('video-materials')[0][1] as MaterialPayload; expect(payload.expectedRevision).toBe('materials-saved-1')
    expect([...node.querySelector('[aria-label="视频制作内容"]')!.querySelectorAll<HTMLButtonElement>('[role=tab]')].every(item => item.disabled)).toBe(true)
    materialWrites = 1; savedMaterials = materialEnvelope(payload.document, 'materials-confirmed-1'); await act(async () => saving.resolve({materials: savedMaterials})); materialWrite = null
    expect(selectedTab()).toBe('镜头编辑'); renderer('map'); expect(geoCameraKeys(currentMap())).toEqual(keys)
    expect(Object.values(currentMap().nodes).some(item => item.type === 'marker' && item.label === '第一次确认地名')).toBe(true)
    expect(writes('geomotion-project')).toHaveLength(0); expect(node.querySelector('.trk-gm-dirty')).not.toBeNull()
    await click('保存工程', mapWorkspace()); await tab('素材准备'); expect(materialWorkspace()).toBe(mounted)
    await edit('标记名称', '第二次确认地名'); await click('用所选素材编排镜头', materialWorkspace())
    renderer('map'); expect(geoCameraKeys(currentMap())).toEqual(keys); expect(Object.values(currentMap().nodes).some(item => item.type === 'marker' && item.label === '第二次确认地名')).toBe(true)
    expect(writes('video-materials')).toHaveLength(2); expect(state.points).toEqual(points)
  })
  it('uses a single material guard for the internal return and restores its confirmed draft on re-entry', async () => {
    await render(); await tab('素材准备'); await edit('标记名称', '内部返回仍保留的地名')
    await click('返回镜头编辑', materialWorkspace()); expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1)
    await click('保存后继续', node.querySelector('[role=dialog]')!); expect(selectedTab()).toBe('镜头编辑'); renderer('map'); expect(node.querySelector('[role=dialog]')).toBeNull()
    expect(writes('video-materials')).toHaveLength(1); await tab('素材准备')
    expect(materialWorkspace().querySelector<HTMLInputElement>('[aria-label="标记名称"]')!.value).toBe('内部返回仍保留的地名'); expect(writes('video-materials')).toHaveLength(1)
  })
  it('guards the root return and restores focus and the current draft when cancelled', async () => {
    await render(); await edit('镜头时长（秒）', '28'); const snapshot = structuredClone(currentMap())
    const back = button('返回轨迹', node.querySelector('.trk-video-navigation')!); back.focus()
    await act(async () => back.click()); expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1); expect(onCancel).not.toHaveBeenCalled()
    expect(node.querySelector('[role=dialog]')!.contains(document.activeElement)).toBe(true)
    await click('取消', node.querySelector('[role=dialog]')!); expect(document.activeElement).toBe(back); expect(currentMap()).toEqual(snapshot)
    await act(async () => back.click()); await click('放弃本次修改', node.querySelector('[role=dialog]')!)
    expect(onCancel).toHaveBeenCalledTimes(1); expect(currentMap()).toEqual(savedMap.document); expect(writes()).toHaveLength(0)
  })
  it('keeps legacy script data as a backup while switching to the new native planning page', async () => {
    const raw='{"notes":"旧脚本不能覆盖"}';localStorage.setItem('cqai-track.video-script.'+track.id,raw)
    await render();await tab('脚本策划');const planning=node.querySelector('[aria-label="OpenMontage 脚本策划"]')!
    expect(planning.textContent).toContain('旧版脚本草稿备份');await tab('镜头编辑');renderer('map');await tab('脚本策划')
    expect(node.querySelector('[aria-label="OpenMontage 脚本策划"]')).toBe(planning);expect(localStorage.getItem('cqai-track.video-script.'+track.id)).toBe(raw)
    expect(writes()).toHaveLength(0);expect(generateVideoScript).not.toHaveBeenCalled()
  })
})
