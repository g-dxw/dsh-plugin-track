import {useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {BasemapId} from '../track/basemaps.ts'
import {isBasemapId, type MapSettings} from '../track/map-settings.ts'
import {GEOMOTION_PROJECT_MAX_BYTES, GEOMOTION_PROJECT_SCHEMA, type GeoMotionProjectEnvelope} from '../track/geomotion-project-types.ts'
import {createGeoMotionProject, geoCameraKeys, geoNewKey, geoParseProject, geoRemoveCameraKey, geoResizeDuration, geoSetCameraKey, geoSetLayerWindow, type GeoCamera, type GeoKeyframe, type GeoMotionProject} from '../track/geomotion.ts'
import {useTrackPlacemarks} from './useTrackPlacemarks.ts'
import {BasemapControls, useMapSettings} from './map-settings.tsx'
import {GeoMotionScene, type GeoMotionSceneHandle} from './GeoMotionScene.tsx'
import {exportGeoMotionVideo} from './geomotion-video-export.ts'
import {api, clipboardSafeName, download} from './util.ts'
import {GeoMotionTimeline} from './GeoMotionTimeline.tsx'
import {ShotProjectBackup, ShotWorkbench, ShotWorkbenchToolbar} from './ShotWorkbench.tsx'
import {EditorConfirmationDialog, useEditorNavigation, type EditorNavigationHandle} from './editor-navigation.tsx'
import {timelineKeyCollision} from '../track/geomotion-timeline.ts'
import {geoProjectFromVideoMaterials, type VideoMaterialsDocument} from '../track/video-materials.ts'
import {shotProjectKey, shotScopeQuery, type OpenMontageEditorScope} from '../track/shot-project-scope.ts'
import {assertShotCaptureApproval, freezeShotResult, ShotResultUpload, type ShotResultIdentity, type ShotUploadState} from './shot-result-bridge.tsx'
import type {ShotCaptureStore} from './shot-capture-store.ts'

type Props = {track: TrackRecord; basemap: BasemapId; onBasemap: (id: BasemapId) => void; onCancel: () => void; onCases?: () => void; onMaterials?: () => void; preparedMaterials?: VideoMaterialsDocument; active?: boolean; onRegister?: (handle: EditorNavigationHandle | null) => void; scope?: OpenMontageEditorScope; onShotResult?: () => void; captureStore?: ShotCaptureStore}
type StoredProject = GeoMotionProjectEnvelope
type ProjectReply = {project: StoredProject | null}
type CapturedVideo = {url: string; filename: string; blob: Blob; identity?: ShotResultIdentity; uploadState?: ShotUploadState}
type FrozenCapture = {project: GeoMotionProject; settings: MapSettings; basemap: BasemapId; identity?: ShotResultIdentity}
type HistoryEntry = {document: GeoMotionProject; sourceFingerprint: string}
const pendingSaves = new Map<string, Promise<ProjectReply>>()
const describeError = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const round = (value: number, digits = 2) => Number(value.toFixed(digits))
const serialise = (value: GeoMotionProject) => JSON.stringify(value)
function waitForExportLayout(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame: number | null = null, completed = 0, finished = false
    const finish = (reason?: Error) => {
      if (finished) return
      finished = true; if (frame !== null) cancelAnimationFrame(frame)
      signal.removeEventListener('abort', aborted)
      if (reason) reject(reason); else resolve()
    }
    const aborted = () => finish(new DOMException('视频导出已取消', 'AbortError'))
    const step = () => {frame = null; if (signal.aborted) aborted(); else if (++completed === 2) finish(); else frame = requestAnimationFrame(step)}
    signal.addEventListener('abort', aborted, {once: true})
    if (signal.aborted) aborted(); else frame = requestAnimationFrame(step)
  })
}
const easeOptions: {value: GeoKeyframe['easing']; label: string}[] = [
  {value: 'linear', label: '匀速'}, {value: 'easeIn', label: '渐入'}, {value: 'easeOut', label: '渐出'},
  {value: 'easeInOut', label: '平滑进出'}, {value: 'easeInOutCubic', label: '柔和进出'},
  {value: 'easeInOutExpo', label: '快速进出'}, {value: 'easeOutBack', label: '回弹'}, {value: 'hold', label: '保持构图'},
]

/** A keyed workspace isolates drafts, requests and capture resources between tracks. */
export function GeoMotionEditor(props: Props) {return <EditorWorkspace key={shotProjectKey(props.track.id, props.scope)} {...props}/>}
function EditorWorkspace({track, basemap, onBasemap, onCancel, onCases, onMaterials, preparedMaterials, active = true, onRegister, scope, onShotResult, captureStore}: Props) {
  const placemarks = useTrackPlacemarks(track, undefined, {preparePhotos: false})
  const {settings: preferences} = useMapSettings()
  const [project, setProject] = useState<GeoMotionProject | null>(null)
  const [sourceFingerprint, setSourceFingerprint] = useState(''), [savedFingerprint, setSavedFingerprint] = useState('')
  const [stored, setStored] = useState<StoredProject | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0), [loadError, setLoadError] = useState('')
  const [revision, setRevision] = useState<string | null>(null), [savedText, setSavedText] = useState('')
  const [saving, setSaving] = useState(false), [saveStatus, setSaveStatus] = useState('正在读取镜头工程…')
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false)
  const [scene, setScene] = useState<GeoMotionSceneHandle | null>(null)
  const [cameraMoved, setCameraMoved] = useState(false)
  const [selectedKey, setSelectedKey] = useState(''), [selectedLayer, setSelectedLayer] = useState('camera')
  const [past, setPast] = useState<HistoryEntry[]>([]), [future, setFuture] = useState<HistoryEntry[]>([])
  const [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [rebuildRequested, setRebuildRequested] = useState(false)
  const [panel, setPanel] = useState<'preview' | 'layers' | 'properties'>('preview')
  const [capture, setCapture] = useState<FrozenCapture | null>(null)
  const [progress, setProgress] = useState({completed: 0, total: 0})
  const [video, setVideo] = useState<CapturedVideo | null>(null)
  const [uploading, setUploading] = useState(false)
  const workspaceKey = shotProjectKey(track.id, scope)
  const workspace = useRef<HTMLDivElement>(null)
  const preparedApplied = useRef<string | null>(null)
  const preparedSignature = useMemo(() => preparedMaterials ? JSON.stringify(preparedMaterials) : null, [preparedMaterials])
  const alive = useRef(true), initialized = useRef(false), animationFrame = useRef<number | null>(null)
  const exporter = useRef<AbortController | null>(null), videoURL = useRef<string | null>(null)
  const importRequest = useRef(0), savingRef = useRef(false)
  const importReading = useRef<number | null>(null), currentActive = useRef(active)
  currentActive.current = active
  const acceptedDraft = useRef<HistoryEntry | null>(null)
  const latest = useRef(project), currentTime = useRef(time), currentCapture = useRef(capture)
  const currentRevision = useRef(revision), currentSource = useRef(sourceFingerprint), currentScene = useRef(scene)
  latest.current = project; currentTime.current = time; currentCapture.current = capture
  currentRevision.current = revision; currentSource.current = sourceFingerprint; currentScene.current = scene
  const sourceTrack = useMemo(() => placemarks.routeContext ? {...track, segmentStarts: placemarks.routeContext.segmentStarts} : track, [track, placemarks.routeContext])
  const sourceReady = placemarks.editReady && !placemarks.loading && !placemarks.error && !placemarks.stateError
    && !!placemarks.routeContext && !placemarks.routeError
  const currentImport = useMemo(() => {
    if (!sourceReady) return null
    try {return createGeoMotionProject(sourceTrack, placemarks.points, placemarks.groups)} catch {return null}
  }, [sourceReady, sourceTrack, placemarks.points, placemarks.groups])
  const sourceChanged = !!currentImport && !!sourceFingerprint && currentImport.sourceFingerprint !== sourceFingerprint
  const keys = useMemo(() => project ? geoCameraKeys(project) : [], [project])
  const activeKey = keys.find(key => key.id === selectedKey) || keys[0]
  const layers = useMemo(() => project ? Object.values(project.nodes).filter(node => node.type !== 'camera' && node.type !== 'group') : [], [project])
  const layer = project?.nodes[selectedLayer]
  const activeLayer = layer && layer.type !== 'camera' && layer.type !== 'group' ? layer : null
  const dirty = !!project && (serialise(project) !== savedText || sourceFingerprint !== savedFingerprint)
  const recording = capture !== null
  const locked = !active || recording || playing || saving || uploading
  const ready = active && !!project && !!scene && loadState === 'ready'
  const duration = project?.duration || 20
  const previewBasemap = project && isBasemapId(project.basemap) ? project.basemap : basemap
  const acceptScene = useCallback((handle: GeoMotionSceneHandle | null) => setScene(handle), [])
  const cameraChanged = useCallback((_camera: GeoCamera) => {if (!currentCapture.current) setCameraMoved(true)}, [])
  const navigation = useEditorNavigation({active, dirty, busy: recording || saving || uploading || rebuildRequested, save: saveProject, discard: discardProject, onRegister})
  useEffect(() => {if (!active) {setRebuildRequested(false); invalidateImport()}}, [active])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; importRequest.current++
      exporter.current?.abort()
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current)
      if (videoURL.current) URL.revokeObjectURL(videoURL.current)
    }
  }, [])
  useEffect(() => {
    if (!scope || !captureStore) return
    const retained = captureStore.get(track.id, scope, 'map')
    if (!retained) return
    const url = URL.createObjectURL(retained.blob); videoURL.current = url
    setVideo({...retained, url})
  }, [workspaceKey, captureStore])

  useEffect(() => {
    let active = true
    setLoadState('loading'); setLoadError(''); setSaveStatus('正在读取镜头工程…')
    const load = async () => {
      await pendingSaves.get(workspaceKey)?.catch(() => {})
      const result = await api<ProjectReply>(`geomotion-project?id=${encodeURIComponent(track.id)}${shotScopeQuery(scope)}`)
      if (!active) return
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'project') || result.project === undefined) throw new Error('服务端未确认镜头工程读取结果，原工程已保留')
      if (result.project && result.project.trackId !== track.id) throw new Error('读取到的工程不属于当前轨迹')
      if (result.project && (typeof result.project.revision !== 'string' || !result.project.revision.trim())) throw new Error('已保存工程的版本号无效')
      setStored(result.project); setRevision(result.project?.revision ?? null)
      setLoadState('ready'); initialized.current = false
    }
    void load().catch(reason => {
      if (active) {setLoadState('error'); setLoadError(describeError(reason)); setSaveStatus('工程读取失败，尚未写入草稿')}
    })
    return () => {active = false}
  }, [workspaceKey, loadAttempt])

  useEffect(() => {
    if (initialized.current || loadState !== 'ready' || (!stored && !currentImport)) return
    initialized.current = true
    try {
      const next = stored ? geoParseProject(stored.document) : {...currentImport!.document, basemap, terrainExaggeration: preferences.exaggeration}
      if (!next) throw new Error('已保存镜头工程无法识别，请导出备份或基于当前轨迹重建')
      setProject(next); setSourceFingerprint(stored?.sourceFingerprint || currentImport!.sourceFingerprint)
      acceptedDraft.current = {document: structuredClone(next), sourceFingerprint: stored?.sourceFingerprint || currentImport!.sourceFingerprint}
      setSelectedKey(geoCameraKeys(next)[0]?.id || ''); setSelectedLayer('camera'); setTime(0)
      setPast([]); setFuture([]); setSavedText(stored ? serialise(next) : ''); setSavedFingerprint(stored?.sourceFingerprint || '')
      setSaveStatus(stored ? `已恢复工程 · 版本 ${stored.revision.slice(0, 8)}` : '新工程，尚未保存')
      setError('')
    } catch (reason) {setError(describeError(reason)); setSaveStatus('原草稿已保留，请手动重建')}
  }, [loadState, currentImport, stored, basemap, preferences.exaggeration])

  useEffect(() => {
    if (scope || !preparedMaterials || !preparedSignature || preparedApplied.current === preparedSignature || !active || recording || playing || saving || !initialized.current || !project || !sourceReady || loadState !== 'ready' || !currentImport) return
    preparedApplied.current = preparedSignature
    try {
      const next = geoProjectFromVideoMaterials(sourceTrack, preparedMaterials, project)
      commit(next, '已将确认的二维素材带入镜头草稿，原相机构图保留；可撤销恢复', currentImport.sourceFingerprint)
      setSelectedLayer('camera'); setSelectedKey(geoCameraKeys(next)[0]?.id || ''); seek(0)
    } catch (reason) {setError(describeError(reason))}
  }, [preparedMaterials, preparedSignature, active, recording, playing, saving, project, sourceReady, loadState, sourceTrack, currentImport])

  useEffect(() => {
    if (!active) {setPlaying(false); return}
    if (!playing || !project || recording) return
    const startTime = currentTime.current >= project.duration ? 0 : currentTime.current
    const startClock = performance.now()
    const step = (clock: number) => {
      if (!alive.current || currentCapture.current) return
      const next = Math.min(project.duration, startTime + (clock - startClock) / 1000)
      currentTime.current = next; setTime(next); setCameraMoved(false)
      if (next >= project.duration) {setPlaying(false); animationFrame.current = null}
      else animationFrame.current = requestAnimationFrame(step)
    }
    animationFrame.current = requestAnimationFrame(step)
    return () => {if (animationFrame.current !== null) {cancelAnimationFrame(animationFrame.current); animationFrame.current = null}}
  }, [active, playing, project?.duration, recording])

  function commit(next: GeoMotionProject, label = '', fingerprint = currentSource.current) {
    const previous = latest.current
    if (!previous || currentCapture.current || playing) return
    if (serialise(next) === serialise(previous) && fingerprint === currentSource.current) return
    invalidateImport()
    const previousEntry = {document: previous, sourceFingerprint: currentSource.current}
    latest.current = next; setProject(next)
    setPast(values => [...values.slice(-59), previousEntry]); setFuture([])
    currentSource.current = fingerprint; setSourceFingerprint(fingerprint)
    setCameraMoved(false); setError(''); if (label) setNotice(label)
  }
  function editProject(transform: (value: GeoMotionProject) => GeoMotionProject, label = '') {
    if (!latest.current || locked) return
    try {commit(transform(latest.current), label)} catch (reason) {setError(describeError(reason))}
  }
  function seek(value: number) {
    if (!Number.isFinite(value) || currentCapture.current) return
    setPlaying(false); const next = clamp(value, 0, latest.current?.duration || duration)
    currentTime.current = next; setTime(next); setCameraMoved(false)
  }
  function recordCamera() {
    if (!latest.current || !currentScene.current || locked) return
    let newKey: GeoKeyframe
    try {newKey = geoNewKey(currentTime.current, currentScene.current.getCamera())} catch (reason) {setError(describeError(reason)); return}
    const previous = geoCameraKeys(latest.current).find(key => Math.abs(key.t - newKey.t) < .001)
    if (previous) newKey.id = previous.id
    editProject(value => geoSetCameraKey(value, newKey), `已记录 ${round(newKey.t)} 秒的相机构图`)
    setSelectedKey(newKey.id); setSelectedLayer('camera'); setPanel('properties')
  }
  function keyPatch(patch: Partial<GeoKeyframe>) {
    if (!activeKey || !latest.current) return
    if (typeof patch.t === 'number' && timelineKeyCollision(activeKey.id, patch.t, geoCameraKeys(latest.current))) {
      setNotice('此时间已有关键帧，请移动到其他时间')
      return
    }
    editProject(value => geoSetCameraKey(value, {...activeKey, ...patch}))
    if (typeof patch.t === 'number') seek(patch.t)
  }
  function layerPatch(patch: Record<string, unknown>, id = selectedLayer) {
    editProject(value => {
      const next = structuredClone(value), target = next.nodes[id]
      if (!target || target.type === 'camera' || target.type === 'group') return value
      Object.assign(target, patch)
      return geoParseProject(next)
    })
  }
  function history(direction: 'undo' | 'redo') {
    if (locked || !latest.current) return
    const stack = direction === 'undo' ? past : future, value = stack[stack.length - 1]
    if (!value) return
    invalidateImport()
    const previous = {document: latest.current, sourceFingerprint: currentSource.current}
    latest.current = value.document; setProject(value.document)
    currentSource.current = value.sourceFingerprint; setSourceFingerprint(value.sourceFingerprint)
    if (direction === 'undo') {setPast(stack.slice(0, -1)); setFuture(values => [...values, previous])}
    else {setFuture(stack.slice(0, -1)); setPast(values => [...values, previous])}
    setTime(valueTime => Math.min(valueTime, value.document.duration)); setCameraMoved(false)
  }
  async function saveProject(): Promise<boolean> {
    const document = latest.current
    if (!document || loadState !== 'ready' || savingRef.current || currentCapture.current || uploading) return false
    invalidateImport()
    savingRef.current = true; setSaving(true); setError(''); setSaveStatus('正在保存镜头工程…')
    const snapshot = structuredClone(document), fingerprint = currentSource.current, expectedRevision = currentRevision.current
    const operation = api<ProjectReply>('geomotion-project', {id: track.id, project: {trackId: track.id, sourceFingerprint: fingerprint, document: snapshot}, expectedRevision, ...(scope ? {projectId: scope.projectId, shotId: scope.shotId} : {})})
    pendingSaves.set(workspaceKey, operation)
    try {
      const result = await operation
      if (!result.project || result.project.trackId !== track.id || typeof result.project.revision !== 'string' || !result.project.revision || result.project.revision === expectedRevision) throw new Error('服务端未确认当前工程已保存')
      if (serialise(geoParseProject(result.project.document)) !== serialise(snapshot)) throw new Error('服务端保存结果与当前工程不一致')
      if (alive.current) {
        currentRevision.current = result.project.revision; setRevision(result.project.revision)
        acceptedDraft.current = {document: snapshot, sourceFingerprint: fingerprint}
        setSavedText(serialise(snapshot)); setSavedFingerprint(fingerprint); setSaveStatus(`已保存到轨迹工作区 · 版本 ${result.project.revision.slice(0, 8)}`)
      }
      return true
    } catch (reason) {
      if (alive.current) {
        const conflict = reason && typeof reason === 'object' && 'status' in reason && reason.status === 409
        setError(conflict ? '工程已被其他窗口更新，当前编辑保留。请先导出 JSON，再重新读取已保存工程。' : describeError(reason))
        setSaveStatus('保存失败，当前编辑仍保留')
      }
      return false
    } finally {
      if (pendingSaves.get(workspaceKey) === operation) pendingSaves.delete(workspaceKey)
      savingRef.current = false
      if (alive.current) setSaving(false)
    }
  }
  function discardProject() {
    const accepted = acceptedDraft.current
    if (!accepted || savingRef.current || currentCapture.current) return
    invalidateImport()
    const document = structuredClone(accepted.document)
    latest.current = document; setProject(document)
    currentSource.current = accepted.sourceFingerprint; setSourceFingerprint(accepted.sourceFingerprint)
    setSavedText(serialise(document)); setSavedFingerprint(accepted.sourceFingerprint)
    setPast([]); setFuture([]); setPlaying(false); setCameraMoved(false); setError(''); setNotice('已放弃本次未保存修改')
    const nextTime = Math.min(currentTime.current, document.duration); currentTime.current = nextTime; setTime(nextTime)
    setSelectedKey(geoCameraKeys(document)[0]?.id || ''); setSelectedLayer('camera')
    setSaveStatus(currentRevision.current ? `已恢复已保存工程 · 版本 ${currentRevision.current.slice(0, 8)}` : '新工程，尚未保存')
  }
  function rebuild() {
    if (!currentImport || locked || loadState !== 'ready') return
    const document = {...currentImport.document, basemap, terrainExaggeration: preferences.exaggeration}
    if (latest.current) commit(document, '已根据当前轨迹和地名重建镜头，请保存工程', currentImport.sourceFingerprint)
    else {latest.current = document; setProject(document); acceptedDraft.current = {document: structuredClone(document), sourceFingerprint: currentImport.sourceFingerprint}; setPast([]); setFuture([]); setError('')}
    initialized.current = true; setSourceFingerprint(currentImport.sourceFingerprint); currentSource.current = currentImport.sourceFingerprint
    setTime(0); setSelectedLayer('camera'); setSelectedKey(geoCameraKeys(document)[0]?.id || '')
  }
  function requestRebuild() {
    if (!currentImport || locked || loadState !== 'ready' || rebuildRequested) return
    setRebuildRequested(true)
  }
  function exportJson() {
    if (!latest.current || recording) return
    const contents = {schema: GEOMOTION_PROJECT_SCHEMA, trackId: track.id, sourceFingerprint: currentSource.current, document: latest.current}
    download(`${clipboardSafeName(track.name)}-镜头工程.json`, JSON.stringify(contents, null, 2))
  }
  function invalidateImport() {
    importRequest.current++
    if (importReading.current !== null) {importReading.current = null; if (alive.current) setNotice('已取消工程导入，当前草稿已保留')}
  }
  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || locked || !latest.current) return
    const request = ++importRequest.current, expectedProject = latest.current, expectedSource = currentSource.current, expectedScene = currentScene.current
    if (file.size > GEOMOTION_PROJECT_MAX_BYTES) {setError('工程 JSON 超过 16 MB，请选择较小的文件'); return}
    importReading.current = request
    try {
      const value: unknown = JSON.parse(await file.text())
      if (!alive.current || request !== importRequest.current) return
      if (!currentActive.current || currentCapture.current || savingRef.current || latest.current !== expectedProject || currentSource.current !== expectedSource || currentScene.current !== expectedScene) {invalidateImport(); return}
      importReading.current = null
      const wrapped = value && typeof value === 'object' && 'document' in value ? value as {document: unknown; trackId?: unknown; sourceFingerprint?: unknown} : null
      if (wrapped?.trackId && wrapped.trackId !== track.id) throw new Error('这个工程属于另一条轨迹，请在对应轨迹中导入')
      const document = geoParseProject(wrapped ? wrapped.document : value)
      if (!document) throw new Error('镜头工程格式无效')
      const fingerprint = typeof wrapped?.sourceFingerprint === 'string' && wrapped.sourceFingerprint ? wrapped.sourceFingerprint : currentSource.current
      commit(document, '镜头工程已导入，请保存到轨迹工作区', fingerprint)
      setSelectedKey(geoCameraKeys(document)[0]?.id || ''); setSelectedLayer('camera'); seek(0)
    } catch (reason) {if (alive.current && request === importRequest.current) setError(describeError(reason))}
    finally {if (importReading.current === request) importReading.current = null}
  }
  async function exportVideo() {
    if (!latest.current || !currentScene.current || exporter.current || playing || savingRef.current || uploading) return
    if (scope && (dirty || !currentRevision.current)) {setError('请先保存当前分镜的镜头工程，再输出视频'); return}
    let identity: ShotResultIdentity | undefined
    try {identity = freezeShotResult(track.id, scope, currentRevision.current, 'map')} catch (reason) {setError(describeError(reason)); return}
    const controller = new AbortController(), frozen = {project: structuredClone(latest.current), settings: structuredClone(preferences), basemap: previewBasemap, identity}
    exporter.current = controller; currentCapture.current = frozen
    setCapture(frozen); setProgress({completed: 0, total: Math.ceil(frozen.project.duration * frozen.project.fps)})
    setError(''); setNotice(''); setPanel('preview'); invalidateImport()
    try {
      if (frozen.identity) await assertShotCaptureApproval(frozen.identity, controller.signal)
      await waitForExportLayout(controller.signal)
      if (!alive.current || controller.signal.aborted || !currentScene.current) throw new DOMException('视频导出已取消', 'AbortError')
      const result = await exportGeoMotionVideo({project: frozen.project, scene: currentScene.current, signal: controller.signal, onProgress: value => {if (alive.current && !controller.signal.aborted) setProgress(value)}})
      if (!alive.current || controller.signal.aborted) return
      if (videoURL.current) URL.revokeObjectURL(videoURL.current)
      const url = URL.createObjectURL(result.blob); videoURL.current = url
      if (frozen.identity) captureStore?.set({blob: result.blob, filename: result.filename, identity: frozen.identity})
      setVideo({url, filename: result.filename, blob: result.blob, identity: frozen.identity}); setNotice('视频已生成，可先播放，再下载文件')
    } catch (reason) {
      if (alive.current) {if (controller.signal.aborted) setNotice('已取消视频导出，镜头工程已保留'); else setError(describeError(reason))}
    } finally {
      if (exporter.current === controller) exporter.current = null
      currentCapture.current = null
      if (alive.current) {if (controller.signal.aborted) setNotice('已取消视频导出，镜头工程已保留'); setCapture(null); void currentScene.current?.renderAt(latest.current!, currentTime.current).catch(() => {})}
    }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!active) return
    if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return
    if (!workspace.current?.contains(document.activeElement)) return
    if (recording || uploading) return
    if (event.key.toLowerCase() === 'k' && !event.ctrlKey && !event.metaKey && !event.altKey) {event.preventDefault(); recordCamera()}
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo')}
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault(); void saveProject()}
    else if (event.key === ' ' && event.target === workspace.current && ready) {event.preventDefault(); setPlaying(value => !value)}
  }
  const sourceError = placemarks.error || placemarks.stateError || placemarks.routeError
  const visibleSaveStatus = dirty && !saving && loadState === 'ready' && saveStatus !== '保存失败，当前编辑仍保留'
    ? '等待保存到轨迹工作区' : saveStatus
  return <ShotWorkbench workspaceRef={workspace} panel={panel} onKeyDown={keyboard} ariaLabel="地图场景镜头编辑" context={<>地图场景 · {track.name}{scope && <> · 分镜 {scope.sceneId}</>}</>} dirty={dirty} status={visibleSaveStatus} dialog={<>{navigation.dialog}{active && rebuildRequested && <EditorConfirmationDialog title="重建当前镜头工程？" description="将用当前轨迹和地名替换图层，并重新生成相机关键帧。重建后可撤销恢复，确认保存前不会改写已保存工程。" confirmLabel="确认重建工程" busy={recording || saving || playing} onCancel={() => setRebuildRequested(false)} onConfirm={() => {rebuild(); setRebuildRequested(false)}}/>}</>}
    navigation={<>
      {onMaterials&&!scope&&<button type="button" disabled={!active || recording || saving || uploading || rebuildRequested} onClick={()=>navigation.requestLeave(onMaterials)}>二维素材准备</button>}
      {onCases && <button type="button" disabled={!active || recording || saving || uploading || rebuildRequested} onClick={() => navigation.requestLeave(onCases)}>返回视频制作</button>}
      <button type="button" disabled={!active || recording || saving || uploading || rebuildRequested} onClick={() => navigation.requestLeave(onCancel)}>返回轨迹</button>
    </>}
    toolbar={<ShotWorkbenchToolbar fileTools={<>
        <ShotProjectBackup trackId={track.id} scene="map" scope={scope} disabled={recording || saving || uploading}/>
        <button type="button" disabled={!project || recording} onClick={exportJson}>导出 JSON</button>
        <label className={`trk-gm-file${locked || !project ? ' is-disabled' : ''}`}>导入 JSON<input aria-label="导入镜头工程 JSON" type="file" accept="application/json,.json" disabled={locked || !project} onChange={event => void importJson(event)}/></label>
      </>}>
        <button type="button" disabled={!past.length || locked || saving} onClick={() => history('undo')}>撤销</button>
        <button type="button" disabled={!future.length || locked || saving} onClick={() => history('redo')}>重做</button>
        <button type="button" className="trk-gm-primary" disabled={!active || !project || loadState !== 'ready' || saving || recording || uploading} onClick={() => void saveProject()}>{saving ? '正在保存…' : '保存工程'}</button>
        <button type="button" disabled={!ready || playing || recording || saving || uploading || !!scope && (dirty || !revision)} onClick={() => void exportVideo()}>导出 WebM 视频</button>
    </ShotWorkbenchToolbar>}
    timeline={<GeoMotionTimeline duration={duration} fps={project?.fps || 30} time={time} keys={keys} layers={layers}
      selectedKeyId={activeKey?.id || ''} selectedLayerId={selectedLayer} playing={playing} recording={recording}
      disabled={!ready || recording || uploading} editDisabled={!ready || locked}
      onSeek={seek} onPlayPause={()=>{setPlaying(value=>!value);setCameraMoved(false)}} onAddKey={recordCamera}
      onSelectKey={(id,t)=>{setSelectedKey(id);setSelectedLayer('camera');seek(t);setPanel('properties')}}
      onKeyTime={(id,t)=>{const key=latest.current&&geoCameraKeys(latest.current).find(key=>key.id===id);if(!key)return;if(timelineKeyCollision(id,t,geoCameraKeys(latest.current!))){setNotice('此时间已有关键帧，请移动到其他时间');return}editProject(value=>geoSetCameraKey(value,{...key,t}));seek(t)}}
      onSelectLayer={id=>{setSelectedLayer(id);setPanel('properties')}}
      onLayerRange={(id,range,mode)=>editProject(value=>geoSetLayerWindow(value,id,range,mode))}
      onToggleLayer={id=>{const node=latest.current?.nodes[id];if(node&&node.type!=='camera'&&node.type!=='group'&&!node.locked)layerPatch({visible:!node.visible},id)}}/>}
    footer={<span>{project?.width || 1280} × {project?.height || 720} · {project?.fps || 30} 帧 / 秒</span>}>
    {sourceError && <div role="alert" className="trk-gm-alert"><span>轨迹和地名读取失败：{sourceError}</span><button type="button" disabled={recording} onClick={placemarks.retry}>重新读取轨迹</button></div>}
    {loadError && <div role="alert" className="trk-gm-alert"><span>工程读取失败：{loadError}</span><button type="button" disabled={recording} onClick={() => setLoadAttempt(value => value + 1)}>重试读取工程</button></div>}
    {error && <div role="alert" className="trk-gm-alert"><span>{error}</span><button type="button" disabled={locked || saving} onClick={() => setLoadAttempt(value => value + 1)}>重新读取已保存工程</button></div>}
    {sourceChanged && <div role="status" className="trk-gm-notice"><span>轨迹或已保存地名已变化，当前镜头仍使用原工程。</span><button type="button" disabled={locked || saving} onClick={requestRebuild}>根据当前轨迹重建</button></div>}
    {notice && <p className="trk-gm-notice" role="status">{notice}</p>}
    <nav className="trk-gm-panel-tabs" aria-label="编辑面板"><button type="button" aria-pressed={panel === 'layers'} disabled={recording} onClick={() => setPanel('layers')}>图层和地名</button><button type="button" aria-pressed={panel === 'preview'} disabled={recording} onClick={() => setPanel('preview')}>地图预览</button><button type="button" aria-pressed={panel === 'properties'} disabled={recording} onClick={() => setPanel('properties')}>镜头属性</button></nav>
    <div className="trk-gm-workspace">
      <aside className="trk-gm-layers" aria-label="图层和地名">
        <div className="trk-gm-panel-title"><h3>图层和地名</h3><span>{layers.length} 个</span></div>
        <button type="button" className="trk-gm-layer" aria-pressed={selectedLayer === 'camera'} onClick={() => {setSelectedLayer('camera'); setPanel('properties')}}><span>相机镜头</span><small>{keys.length} 个关键帧</small></button>
        <div className="trk-gm-layer-list">{layers.map(node => <div className="trk-gm-layer-row" key={node.id}>
          <input aria-label={`显示图层：${node.name}`} type="checkbox" checked={node.visible} disabled={locked || node.locked} onChange={event => layerPatch({visible: event.target.checked}, node.id)}/>
          <button type="button" className="trk-gm-layer" aria-pressed={selectedLayer === node.id} onClick={() => {setSelectedLayer(node.id); setPanel('properties')}}><span>{node.name}</span><small>{node.type === 'marker' ? '地名' : node.type === 'route' ? '轨迹' : node.type === 'text' ? '文字' : '图层'}</small></button>
        </div>)}</div>
        <button type="button" className="trk-gm-rebuild" disabled={!currentImport || locked || saving || loadState !== 'ready'} onClick={requestRebuild}>基于当前轨迹新建工程</button>
      </aside>
      <section className="trk-gm-preview" aria-label="镜头地图预览">
        <div className="trk-gm-mapbar"><BasemapControls className="trk-gm-basemaps" basemap={capture?.basemap || previewBasemap} onBasemap={value => {if (!recording) {onBasemap(value); editProject(document => ({...document, basemap: value}))}}} disabled={locked}/></div>
        <div className={`trk-gm-stage${recording ? ' is-recording' : ''}`} style={project ? {aspectRatio: `${project.width} / ${project.height}`} : undefined}>
          {active && project && <GeoMotionScene project={capture?.project || project} time={time} basemap={capture?.basemap || previewBasemap} settings={capture?.settings || preferences} onReady={acceptScene} onCameraChange={cameraChanged}/>}
          {!project && <div className="trk-gm-empty" role="status">{loadState === 'error' ? '请先重新读取工程' : sourceError ? '请先恢复轨迹和地名' : '正在读取轨迹、地名与镜头工程…'}</div>}
          {recording && <div className="trk-gm-capture-mask" aria-hidden="true"/>}
        </div>
        <div className="trk-gm-preview-help"><span>{cameraMoved ? '当前构图尚未记录' : '拖动地图调整位置，滚轮缩放，右键拖动旋转'}</span><button type="button" disabled={!ready || locked} onClick={recordCamera}>记录当前构图（K）</button></div>
        {recording && <div className="trk-gm-progress" role="status"><label>视频导出 <progress max={progress.total || 1} value={progress.completed}/></label><span>{progress.completed} / {progress.total} 帧</span><button type="button" onClick={() => exporter.current?.abort()}>取消导出</button></div>}
        {video && <div className="trk-gm-video"><video controls playsInline src={video.url} aria-label="导出视频预览"/><a href={video.url} download={video.filename}>下载视频</a>{video.identity && <ShotResultUpload key={video.identity.takeId} blob={video.blob} identity={video.identity} scope={scope} revision={revision} dirty={dirty} active={active} disabled={recording || saving || playing} onBusy={setUploading} onUploaded={onShotResult} initialState={video.uploadState} onState={state => captureStore?.updateUpload(video.identity!, state)}/>}</div>}
      </section>
      <aside className="trk-gm-properties" aria-label="镜头属性">
        <div className="trk-gm-panel-title"><h3>{selectedLayer === 'camera' ? '相机关键帧' : activeLayer?.type === 'marker' ? '地名属性' : '图层属性'}</h3></div>
        {selectedLayer === 'camera' ? <>
          <label>选择关键帧<select aria-label="选择相机关键帧" value={activeKey?.id || ''} disabled={!keys.length || locked} onChange={event => {setSelectedKey(event.target.value); const key = keys.find(value => value.id === event.target.value); if (key) seek(key.t)}}>{keys.map(key => <option key={key.id} value={key.id}>{round(key.t)} 秒</option>)}</select></label>
          {activeKey && <fieldset disabled={locked}><legend>构图参数</legend>
            <NumberField label="关键帧时间（秒）" value={activeKey.t} min={0} max={duration} step={.1} onValue={t => keyPatch({t})}/>
            <div className="trk-gm-two"><NumberField label="经度" value={activeKey.center[0]} min={-180} max={180} step={.0001} onValue={value => keyPatch({center: [value, activeKey.center[1]]})}/><NumberField label="纬度" value={activeKey.center[1]} min={-85} max={85} step={.0001} onValue={value => keyPatch({center: [activeKey.center[0], value]})}/></div>
            <NumberField label="缩放级别" value={activeKey.zoom} min={0} max={22} step={.1} onValue={zoom => keyPatch({zoom})}/>
            <div className="trk-gm-two"><NumberField label="朝向（度）" value={activeKey.bearing} min={-3600} max={3600} step={1} onValue={bearing => keyPatch({bearing})}/><NumberField label="俯仰（度）" value={activeKey.pitch} min={0} max={85} step={1} onValue={pitch => keyPatch({pitch})}/></div>
            <label>运动缓动<select aria-label="运动缓动" value={activeKey.easing} onChange={event => keyPatch({easing: event.target.value as GeoKeyframe['easing']})}>{easeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <NumberField label="途中拉远幅度" value={activeKey.dip} min={0} max={6} step={.1} onValue={dip => keyPatch({dip})}/>
            <button type="button" disabled={keys.length <= 1} onClick={() => {editProject(value => geoRemoveCameraKey(value, activeKey.id)); setSelectedKey('')}}>删除此关键帧</button>
          </fieldset>}
        </> : activeLayer && <fieldset disabled={locked || activeLayer.locked}><legend>图层显示</legend>
          <label>图层名称<input aria-label="图层名称" value={activeLayer.name} onChange={event => layerPatch({name: event.target.value})}/></label>
          {activeLayer.type === 'marker' && <label>地名文字<input aria-label="地名文字" value={activeLayer.label} onChange={event => layerPatch({label: event.target.value})}/></label>}
          {activeLayer.type === 'text' && <label>文字内容<textarea aria-label="文字内容" value={activeLayer.text} onChange={event => layerPatch({text: event.target.value})}/></label>}
          <NumberField label="开始显示（秒）" value={activeLayer.in} min={0} max={activeLayer.out} step={.1} onValue={value => layerPatch({in: value})}/>
          <NumberField label="结束显示（秒）" value={activeLayer.out} min={activeLayer.in} max={duration} step={.1} onValue={value => layerPatch({out: value})}/>
          <NumberField label="淡入淡出（秒）" value={activeLayer.fade} min={0} max={duration} step={.1} onValue={fade => layerPatch({fade})}/>
          <label className="trk-gm-checkbox"><input type="checkbox" aria-label="显示当前图层" checked={activeLayer.visible} onChange={event => layerPatch({visible: event.target.checked})}/>显示图层</label>
        </fieldset>}
        <details className="trk-gm-output" open><summary>工程与输出</summary><fieldset disabled={locked || !project}>
          <NumberField label="镜头时长（秒）" value={duration} min={1} max={300} step={1} onValue={value => {editProject(document => geoResizeDuration(document, value)); seek(Math.min(time, value))}}/>
          <label>画面尺寸<select aria-label="画面尺寸" value={`${project?.width || 1280}x${project?.height || 720}`} onChange={event => {const [width, height] = event.target.value.split('x').map(Number); editProject(value => ({...value, width, height}))}}><option value="1280x720">横屏 1280 × 720</option><option value="1920x1080">横屏 1920 × 1080</option><option value="720x1280">竖屏 720 × 1280</option></select></label>
          <label>视频帧率<select aria-label="视频帧率" value={project?.fps || 30} onChange={event => editProject(value => ({...value, fps: Number(event.target.value)}))}><option value={24}>24 帧 / 秒</option><option value={30}>30 帧 / 秒</option><option value={60}>60 帧 / 秒</option></select></label>
          <label className="trk-gm-checkbox"><input type="checkbox" aria-label="三维地形" checked={project?.terrain || false} onChange={event => editProject(value => ({...value, terrain: event.target.checked}))}/>三维地形</label>
          <NumberField label="地形起伏倍数" value={project?.terrainExaggeration || 1} min={1} max={3} step={.05} onValue={terrainExaggeration => editProject(value => ({...value, terrainExaggeration}))}/>
        </fieldset></details>
      </aside>
    </div>
  </ShotWorkbench>
}

function NumberField({label, value, min, max, step = .1, onValue, disabled = false}: {label: string; value: number; min?: number; max?: number; step?: number; onValue: (value: number) => void; disabled?: boolean}) {
  return <label>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={round(value, 5)} disabled={disabled} onChange={event => {const value = event.target.valueAsNumber; if (Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max)) onValue(value)}}/></label>
}
