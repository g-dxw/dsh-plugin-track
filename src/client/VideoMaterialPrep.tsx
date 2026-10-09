import {useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {VideoMaterialsEnvelope} from '../video-materials-store.ts'
import {annotationPosition, diagramCoordinates, diagramHeight, validateAnnotations, type TrackAnnotation} from '../track/annotations.ts'
import {extractVideoMaterials, validateVideoMaterials, splitVideoMaterialSegment, mergeVideoMaterialSegment, videoMaterialSegmentMetrics, type VideoMaterialsDocument} from '../track/video-materials.ts'
import {useTrackPlacemarks} from './useTrackPlacemarks.ts'
import {readAnnotationPhoto, readLinkedAnnotationPhoto} from './annotation-photo.ts'
import {api, clipboardSafeName, download} from './util.ts'
import {VIDEO_MATERIAL_PREP_CSS} from './video-material-prep-css.ts'
import {useVideoCanvasNavigation} from './useVideoCanvasNavigation.ts'
import {VideoResourceImagePicker} from './VideoResourceImagePicker.tsx'
import {useEditorNavigation, type EditorNavigationHandle} from './editor-navigation.tsx'

type Props = {track: TrackRecord; onBack: () => void; onCompose: (document: VideoMaterialsDocument) => void; active?:boolean; onRegister?:(value:EditorNavigationHandle|null)=>void}
type Envelope = VideoMaterialsEnvelope
type Reply = {materials: Envelope | null}
type Marker = VideoMaterialsDocument['markers'][number]
type Segment = VideoMaterialsDocument['segments'][number]
type Tab = 'markers' | 'segments' | 'information'
type LabelDrag = {id: string; pointerId: number; start: [number, number]; offset: {x: number; y: number}; next: {x: number; y: number}}
const pendingSaves = new Map<string, Promise<Reply>>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const serialise = (document: VideoMaterialsDocument) => JSON.stringify(document)
const newId = () => `material-${crypto.randomUUID()}`
const labelName = (name: string, fallback: string) => name.trim() || fallback
const maxImportBytes = 16 * 1024 * 1024

/** Each track has isolated history, requests and photo selection. */
export function VideoMaterialPrep(props: Props) {return <MaterialWorkspace key={props.track.id} {...props}/>}
function MaterialWorkspace({track, onBack, onCompose, active=true, onRegister}: Props) {
  const placemarks = useTrackPlacemarks(track, undefined, {preparePhotos: false})
  const sourceTrack = useMemo(() => ({...track, segmentStarts: placemarks.routeContext?.segmentStarts || track.segmentStarts}), [track, placemarks.routeContext])
  const sourceReady = placemarks.editReady && !placemarks.loading && !placemarks.error && !placemarks.stateError && !!placemarks.routeContext && !placemarks.routeError
  const [document, setDocument] = useState<VideoMaterialsDocument | null>(null)
  const [stored, setStored] = useState<Envelope | null>(null), [revision, setRevision] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<TrackAnnotation[]>([]), [annotationsSaved, setAnnotationsSaved] = useState(false)
  const [annotationsReady, setAnnotationsReady] = useState(false), [annotationsError, setAnnotationsError] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading'), [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0)
  const [baseline, setBaseline] = useState(''), [past, setPast] = useState<VideoMaterialsDocument[]>([]), [future, setFuture] = useState<VideoMaterialsDocument[]>([])
  const [tab, setTab] = useState<Tab>('markers'), [mobilePanel, setMobilePanel] = useState<'canvas' | 'properties'>('canvas')
  const [markerId, setMarkerId] = useState(''), [segmentId, setSegmentId] = useState(''), [pointIndex, setPointIndex] = useState(0)
  const [tool, setTool] = useState<'select' | 'pan' | 'add' | 'point'>('select')
  const [saving, setSaving] = useState(false), [photoBusy, setPhotoBusy] = useState(false), [importBusy, setImportBusy] = useState(false)
  const [status, setStatus] = useState('正在读取素材…'), [error, setError] = useState(''), [photoError, setPhotoError] = useState('')
  const [rebuildPrompt, setRebuildPrompt] = useState(false)
  const [labelGhost, setLabelGhost] = useState<{id: string; x: number; y: number} | null>(null)
  const alive = useRef(true), initialized = useRef(false), latest = useRef(document), revisionRef = useRef(revision)
  const busyRef = useRef(false), photoRequest = useRef(0), importRequest = useRef(0), drag = useRef<LabelDrag | null>(null)
  const stage = useRef<SVGSVGElement>(null), canvasScroll = useRef<HTMLDivElement>(null), workspace = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({width: 0, height: 0})
  latest.current = document; revisionRef.current = revision
  const busy = saving || photoBusy || importBusy
  busyRef.current = busy
  const canEdit = !!document && loadState === 'ready' && sourceReady && annotationsReady && !annotationsError && !busy
  const serialisedDocument = useMemo(() => document ? serialise(document) : '', [document])
  const dirty = !!document && serialisedDocument !== baseline
  const currentSource = useMemo(() => {
    if (!sourceReady || !annotationsReady || annotationsError) return null
    try {return {document: extractVideoMaterials(sourceTrack, placemarks.points, placemarks.groups, annotations, annotationsSaved), error: ''}}
    catch (reason) {return {document: null, error: message(reason)}}
  }, [sourceReady, sourceTrack, placemarks.points, placemarks.groups, annotations, annotationsSaved, annotationsReady, annotationsError])
  const sourceChanged = !!document && !!currentSource?.document && document.sourceFingerprint !== currentSource.document.sourceFingerprint
  const sourceError = placemarks.error || placemarks.stateError || placemarks.routeError || annotationsError || currentSource?.error || ''
  const activeMarker = document?.markers.find(item => item.id === markerId)
  const activeSegment = document?.segments.find(item => item.id === segmentId)
  const projection = useMemo(() => {
    try {return track.coordinates.length ? {points: diagramCoordinates(track.coordinates), height: diagramHeight(track.coordinates), error: ''} : {points: [], height: 900, error: '当前轨迹没有坐标'}}
    catch (reason) {return {points: [], height: 900, error: message(reason)}}
  }, [track.coordinates])
  const editorNavigation = useEditorNavigation({active,dirty,busy,save:async()=>!!await save(),discard:()=>{
    const previous=baseline?validateVideoMaterials(JSON.parse(baseline)):currentSource?.document?structuredClone(currentSource.document):null
    latest.current=previous;setDocument(previous);if(!baseline&&previous)setBaseline(serialise(previous));setPast([]);setFuture([]);setError('');setStatus('已放弃本次未保存修改')
  },onRegister})
  const navigation = useVideoCanvasNavigation({viewport: canvasScroll, mode: tool, disabled: !active || busy || !!projection.error || !!editorNavigation.dialog || rebuildPrompt, canNavigate: () => !drag.current && !busyRef.current})
  const {zoom, x: panX, y: panY} = navigation.view
  const fitWidth = Math.max(1, Math.min(Math.max(1, (viewport.width || 600) - 48), Math.max(1, (viewport.height || 500) - 48) * 1200 / projection.height))
  const canvasWidth = fitWidth * zoom / 100, canvasHeight = canvasWidth * projection.height / 1200
  const geometryCompatible = !!document && document.sourcePointCount === track.coordinates.length && (!sourceReady || JSON.stringify(document.sourceSegmentStarts) === JSON.stringify([...new Set([0, ...(sourceTrack.segmentStarts || [])])].sort((a, b) => a - b)))
  const counts = document ? {markers: document.markers.filter(item => item.selected).length, segments: document.segments.filter(item => item.selected).length, information: document.information.filter(item => item.selected).length, photos: document.markers.filter(item => item.selected && item.photo).length} : {markers: 0, segments: 0, information: 0, photos: 0}

  useEffect(() => {
    alive.current = true
    return () => {alive.current = false; photoRequest.current++; importRequest.current++; drag.current = null}
  }, [])
  useEffect(() => {
    let active = true
    setLoadState('loading'); setLoadError(''); setAnnotationsReady(false); setAnnotationsError('')
    const loadMaterials = async () => {
      await pendingSaves.get(track.id)?.catch(() => {})
      const reply = await api<Reply>(`video-materials?id=${encodeURIComponent(track.id)}`)
      if (!active) return
      if (reply.materials && (reply.materials.trackId !== track.id || typeof reply.materials.revision !== 'string' || !reply.materials.revision)) throw new Error('素材草稿的轨迹或版本信息无效')
      setStored(reply.materials); setRevision(reply.materials?.revision || null); initialized.current = false; setLoadState('ready')
    }
    void loadMaterials().catch(reason => {if (active) {setLoadError(message(reason)); setLoadState('error'); setStatus('素材读取失败，未写入任何草稿')}})
    void api<{annotations: unknown; saved?: boolean}>(`annotations?id=${encodeURIComponent(track.id)}`).then(reply => {
      if (!active) return
      setAnnotations(validateAnnotations(reply.annotations, track.coordinates.length)); setAnnotationsSaved(reply.saved === true); setAnnotationsReady(true)
    }).catch(reason => {if (active) {setAnnotationsError('读取 SVG 标注失败：' + message(reason)); setAnnotationsReady(true)}})
    return () => {active = false}
  }, [track.id, attempt])
  useEffect(() => {
    if (initialized.current || loadState !== 'ready' || (!stored && !currentSource?.document)) return
    initialized.current = true
    try {
      const next = stored ? validateVideoMaterials(stored.document) : currentSource!.document!
      if (next.trackId !== track.id) throw new Error('素材不属于当前轨迹')
      latest.current = next; setDocument(next); setBaseline(stored ? serialise(next) : '')
      setPast([]); setFuture([]); setMarkerId(next.markers[0]?.id || ''); setSegmentId(next.segments[0]?.id || '')
      setStatus(stored ? '已恢复保存的素材' : '已从真实轨迹提取，请确认展示内容'); setError('')
    } catch (reason) {setError(message(reason)); setStatus('原草稿已保留，请导出备份或重新提取')}
  }, [loadState, stored, currentSource, track.id])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = ''}
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useLayoutEffect(() => {
    const element = canvasScroll.current
    if (!element) return
    // Scrollbars change the content box; fit must use the stable outside box.
    const measure = (entry?: ResizeObserverEntry) => {
      const box = entry?.borderBoxSize?.[0], rect = element.getBoundingClientRect()
      const width = Math.floor(box?.inlineSize ?? rect.width), height = Math.floor(box?.blockSize ?? rect.height)
      if (width > 0 && height > 0) setViewport(previous => previous.width === width && previous.height === height ? previous : {width, height})
    }
    const resized = () => measure()
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => measure(entries[0]))
    observer?.observe(element, {box: 'border-box'}); window.addEventListener('resize', resized)
    return () => {observer?.disconnect(); window.removeEventListener('resize', resized)}
  }, [])
  useEffect(() => {setPhotoError('')}, [markerId])
  useEffect(() => {
    const cancel = () => {drag.current = null; setLabelGhost(null)}
    window.addEventListener('blur', cancel); return () => window.removeEventListener('blur', cancel)
  }, [])
  useEffect(() => {if (!canEdit) {drag.current = null; setLabelGhost(null)}}, [canEdit])

  function commit(next: VideoMaterialsDocument, note = '') {
    const previous = latest.current
    if (!previous || busyRef.current || !canEdit || serialise(next) === serialise(previous)) return
    latest.current = next; setDocument(next); setPast(values => [...values.slice(-49), previous]); setFuture([])
    setError(''); if (note) setStatus(note)
  }
  function mutate(change: (next: VideoMaterialsDocument) => void, note = '') {
    if (!latest.current || !canEdit || busyRef.current) return
    const next = structuredClone(latest.current); change(next); commit(next, note)
  }
  function patchMarker(patch: Partial<Marker>) {const id = markerId; mutate(next => {const marker = next.markers.find(item => item.id === id); if (marker) Object.assign(marker, patch)})}
  function patchSegment(patch: Partial<Segment>) {const id = segmentId; mutate(next => {const segment = next.segments.find(item => item.id === id); if (segment) Object.assign(segment, patch)})}
  function undo(redo = false) {
    if (!canEdit || busyRef.current || !latest.current) return
    const source = redo ? future : past, next = source.at(-1)
    if (!next) return
    const previous = latest.current; latest.current = next; setDocument(next)
    if (redo) {setFuture(source.slice(0, -1)); setPast(values => [...values, previous])}
    else {setPast(source.slice(0, -1)); setFuture(values => [...values, previous])}
    setError(''); setStatus(redo ? '已重做' : '已撤销')
  }
  function selectMarker(id: string) {if (busyRef.current) return; setMarkerId(id); setTab('markers'); setTool('select'); setMobilePanel('properties')}
  function selectSegment(id: string) {if (busyRef.current) return; setSegmentId(id); setTab('segments'); setTool('select'); setMobilePanel('properties')}
  function selectAll(selected: boolean) {mutate(next => {for (const item of next[tab]) item.selected = selected}, selected ? '本栏素材已全选' : '本栏素材已取消选择')}
  function rebuild() {
    if (!currentSource?.document || !canEdit || busyRef.current) return
    const next = structuredClone(currentSource.document); commit(next, '已重新提取当前真实轨迹，原编辑可撤销恢复')
    setMarkerId(next.markers[0]?.id || ''); setSegmentId(next.segments[0]?.id || ''); setRebuildPrompt(false); setTool('select')
  }
  async function save(): Promise<VideoMaterialsDocument | null> {
    if (!latest.current || busyRef.current || loadState !== 'ready') return null
    let snapshot: VideoMaterialsDocument
    try {snapshot = validateVideoMaterials(latest.current)} catch (reason) {setError(message(reason)); return null}
    const expectedRevision = revisionRef.current
    busyRef.current = true; setSaving(true); setError(''); setStatus('正在保存素材…')
    const request = api<Reply>('video-materials', {id: track.id, document: snapshot, expectedRevision})
    pendingSaves.set(track.id, request)
    try {
      const reply = await request, envelope = reply.materials
      if (!envelope || envelope.trackId !== track.id || typeof envelope.revision !== 'string' || !envelope.revision || envelope.revision === expectedRevision) throw new Error('服务端未确认素材保存结果')
      const confirmed = validateVideoMaterials(envelope.document)
      if (serialise(confirmed) !== serialise(snapshot)) throw new Error('服务端保存内容与当前素材不一致')
      if (!alive.current) return null
      revisionRef.current = envelope.revision; setRevision(envelope.revision); latest.current = confirmed; setDocument(confirmed)
      setBaseline(serialise(confirmed)); setStatus('素材已保存'); return confirmed
    } catch (reason) {
      if (alive.current) {setError((reason as {status?: number})?.status === 409 ? '素材已在其他窗口更新。当前修改仍保留，请导出备份后重新读取。' : '保存失败：' + message(reason)); setStatus('当前草稿仍保留')}
      return null
    } finally {
      if (pendingSaves.get(track.id) === request) pendingSaves.delete(track.id)
      if (alive.current) {busyRef.current = false; setSaving(false)}
    }
  }
  async function compose() {
    if (!canEdit || busyRef.current || !geometryCompatible) return
    if (!counts.markers && !counts.segments && !counts.information) {setError('请至少选择一项用于视频的素材'); return}
    const saved = await save(); if (saved && alive.current) onCompose(saved)
  }
  function back() {editorNavigation.requestLeave(onBack)}
  async function choosePhoto(file: File | string) {
    const id = markerId, previous = latest.current
    if (!id || !previous || !canEdit || busyRef.current) return
    const request = ++photoRequest.current; busyRef.current = true; setPhotoBusy(true); setPhotoError('')
    try {
      const dataUrl = typeof file === 'string' ? await readLinkedAnnotationPhoto(file, track.id) : await readAnnotationPhoto(file)
      if (!alive.current || request !== photoRequest.current || latest.current !== previous) return
      const next = structuredClone(previous), marker = next.markers.find(item => item.id === id)
      if (!marker) return
      marker.photo = {dataUrl, ...(typeof file === 'string' ? {sourceUrl: file} : {})}
      const valid = validateVideoMaterials(next)
      busyRef.current = false; commit(valid, '已选择展示图片')
    } catch (reason) {if (alive.current && request === photoRequest.current) setPhotoError(message(reason))}
    finally {if (alive.current && request === photoRequest.current) {busyRef.current = false; setPhotoBusy(false)}}
  }
  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || !canEdit || busyRef.current) return
    if (file.size > maxImportBytes) {setError('素材 JSON 不能超过 16 MiB'); return}
    const request = ++importRequest.current; busyRef.current = true; setImportBusy(true)
    try {
      const parsed = JSON.parse(await file.text()), next = validateVideoMaterials(parsed.document ?? parsed)
      if (!alive.current || request !== importRequest.current) return
      if (next.trackId !== track.id) throw new Error('导入素材不属于当前轨迹')
      busyRef.current = false; commit(next, '已导入素材，尚未保存'); setMarkerId(next.markers[0]?.id || ''); setSegmentId(next.segments[0]?.id || '')
    } catch (reason) {if (alive.current && request === importRequest.current) setError('导入失败：' + message(reason))}
    finally {if (alive.current && request === importRequest.current) {busyRef.current = false; setImportBusy(false)}}
  }
  function canvasPoint(clientX: number, clientY: number): [number, number] {
    const svg = stage.current
    if (!svg) return [0, 0]
    const matrix = svg.getScreenCTM?.()
    if (matrix && svg.createSVGPoint) {const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY; const transformed = point.matrixTransform(matrix.inverse()); return [transformed.x, transformed.y]}
    const rect = svg.getBoundingClientRect(); return [(clientX - rect.left) * 1200 / (rect.width || 1), (clientY - rect.top) * projection.height / (rect.height || 1)]
  }
  function chooseRoutePoint(clientX: number, clientY: number) {
    if (!canEdit || busyRef.current || !geometryCompatible || (tool !== 'add' && tool !== 'point')) return
    const [x, y] = canvasPoint(clientX, clientY)
    let index = 0, distance = Infinity
    projection.points.forEach(([px, py], i) => {const next = Math.hypot(px - x, py - y); if (next < distance) {index = i; distance = next}})
    if (distance > 75) {setStatus('请点击靠近路线的位置'); return}
    setPointIndex(index)
    const segment = latest.current?.segments.find(item => index >= item.startIndex && index <= item.endIndex)
    if (tool === 'point') {if (segment) setSegmentId(segment.id); setTab('segments'); setMobilePanel('properties'); setStatus(`已选轨迹点 ${index}，可在此拆分路线`); return}
    if ((latest.current?.markers.length || 0) >= 100) {setError('最多可准备 100 个标记'); return}
    const coordinate = track.coordinates[index], id = newId()
    mutate(next => next.markers.push({id, name: `标记 ${next.markers.length + 1}`, description: '', coordinates: [coordinate[0], coordinate[1]], pointIndex: index, selected: true, color: '#d33d33', photoCandidates: []}), '已沿真实路线添加标记')
    selectMarker(id)
  }
  function split() {
    if (!latest.current || !activeSegment || !canEdit || busyRef.current) return
    try {const next = splitVideoMaterialSegment(latest.current, activeSegment.id, pointIndex); commit(next, `已在轨迹点 ${pointIndex} 拆分路线`); setTool('select')}
    catch (reason) {setError(message(reason))}
  }
  function merge() {
    if (!latest.current || !activeSegment || !canEdit || busyRef.current) return
    try {commit(mergeVideoMaterialSegment(latest.current, activeSegment.id), '已与下一段合并')}
    catch (reason) {setError(message(reason))}
  }
  // View navigation does not change geographic geometry or material history.
  const markerPositions = useMemo(() => new Map((document?.markers || []).map(marker => [marker.id, projection.points.length
    ? annotationPosition({id: marker.id, pointIndex: Math.min(marker.pointIndex, track.coordinates.length - 1), label: marker.name || '标记', color: marker.color, sourceCoordinates: marker.coordinates}, track.coordinates)
    : [600, projection.height / 2] as [number, number]])), [document?.markers, track.coordinates, projection])
  const segmentPaths = useMemo(() => {
    const breaks = new Set([...(document?.sourceSegmentStarts || []), ...(sourceTrack.segmentStarts || [])])
    return new Map((document?.segments || []).map(segment => [segment.id, projection.points.slice(segment.startIndex, segment.endIndex + 1).map(([x, y], offset) => `${offset === 0 || breaks.has(segment.startIndex + offset) ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')]))
  }, [document?.segments, document?.sourceSegmentStarts, sourceTrack.segmentStarts, projection.points])
  function markerPosition(marker: Marker): [number, number] {return markerPositions.get(marker.id) || [600, projection.height / 2]}
  function segmentPath(segment: Segment): string {return segmentPaths.get(segment.id) || ''}
  function beginLabel(event: ReactPointerEvent<SVGTextElement>, marker: Marker) {
    if (!canEdit || busyRef.current || event.button !== 0 || tool !== 'select' || drag.current) return
    event.stopPropagation(); setMarkerId(marker.id); setTab('markers')
    const offset = marker.labelOffset || {x: 18, y: -14}
    drag.current = {id: marker.id, pointerId: event.pointerId, start: canvasPoint(event.clientX, event.clientY), offset, next: offset}
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  function moveLabel(event: ReactPointerEvent<SVGTextElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId || !canEdit || busyRef.current) return
    const [x, y] = canvasPoint(event.clientX, event.clientY)
    current.next = {x: Math.max(-1200, Math.min(1200, Math.round(current.offset.x + x - current.start[0]))), y: Math.max(-1200, Math.min(1200, Math.round(current.offset.y + y - current.start[1])))}
    setLabelGhost({id: current.id, ...current.next})
  }
  function finishLabel(event: ReactPointerEvent<SVGTextElement>, cancel = false) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null; setLabelGhost(null)
    if (!cancel && canEdit && !busyRef.current) mutate(next => {const marker = next.markers.find(item => item.id === current.id); if (marker) marker.labelOffset = current.next})
  }
  function dialogKeyboard(event: KeyboardEvent<HTMLElement>, close: () => void) {
    if (event.key === 'Escape' && !busyRef.current) {event.preventDefault(); event.stopPropagation(); close()}
    if (event.key !== 'Tab') return
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')]
    const first = focusable[0], last = focusable.at(-1)
    if (!first) {event.preventDefault(); return}
    if (event.shiftKey && globalThis.document.activeElement === first) {event.preventDefault(); last?.focus()}
    else if (!event.shiftKey && globalThis.document.activeElement === last) {event.preventDefault(); first.focus()}
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (event.key === 'Escape' && drag.current) {drag.current = null; setLabelGhost(null); setStatus('已取消文字拖动'); return}
    if (!active || editorNavigation.dialog || rebuildPrompt || !workspace.current?.contains(globalThis.document.activeElement) || target.matches('input,textarea,select,[contenteditable="true"]') || busyRef.current) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {event.preventDefault(); undo(event.shiftKey)}
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {event.preventDefault(); undo(true)}
  }
  const segmentMetrics = useMemo(() => {
    if (!activeSegment || !geometryCompatible) return null
    try {return videoMaterialSegmentMetrics(sourceTrack, activeSegment)} catch {return null}
  }, [activeSegment, geometryCompatible, sourceTrack])
  const canMerge = useMemo(() => {
    if (!document || !activeSegment) return false
    const ordered = [...document.segments].sort((a, b) => a.startIndex - b.startIndex), index = ordered.findIndex(item => item.id === activeSegment.id), next = ordered[index + 1]
    if (!next || next.startIndex !== activeSegment.endIndex) return false
    return !document.sourceSegmentStarts.some(start => start > activeSegment.startIndex && start <= next.endIndex)
  }, [document, activeSegment])
  const sourceUnavailable = loadState === 'ready' && !document && !currentSource?.document
  const shortPhotoName = (url: string, index: number) => {try {const parsed = new URL(url, globalThis.location.href); return decodeURIComponent(parsed.pathname.split('/').at(-1) || parsed.hostname).slice(0, 60) || `图片 ${index + 1}`} catch {return `图片 ${index + 1}`}}

  return <div className="trk-vm" ref={workspace} tabIndex={0} onKeyDown={keyboard} data-panel={mobilePanel} aria-label="二维素材准备编辑器">
    <style>{VIDEO_MATERIAL_PREP_CSS}</style>
    <header className="trk-vm-header">
      <div className="trk-vm-heading"><button type="button" onClick={back} disabled={busy}>返回镜头编辑</button><div><h2>素材准备</h2><p>确认地点、路线、图片和介绍，再编排镜头</p></div></div>
      <div className="trk-vm-actions"><button type="button" onClick={() => undo()} disabled={!canEdit || !past.length}>撤销</button><button type="button" onClick={() => undo(true)} disabled={!canEdit || !future.length}>重做</button><button type="button" onClick={() => void save()} disabled={!document || busy || loadState !== 'ready'}>{saving ? '保存中…' : '保存素材'}</button><button type="button" className="trk-vm-primary" onClick={() => void compose()} disabled={!canEdit || !geometryCompatible}>用所选素材编排镜头</button></div>
    </header>
    <div className="trk-vm-summary" aria-live="polite"><span>{status}{dirty ? ' · 有未保存修改' : ''}</span><span>已选 {counts.markers} 个标记 · {counts.segments} 段路线 · {counts.photos} 张图片 · {counts.information} 条介绍</span></div>
    {error && <div className="trk-vm-error" role="alert">{error}</div>}
    {loadError && <div className="trk-vm-error" role="alert">素材读取失败：{loadError}<button type="button" onClick={() => setAttempt(value => value + 1)} disabled={busy}>重试读取</button></div>}
    {sourceError && <div className="trk-vm-error" role="alert">{sourceError}<button type="button" onClick={() => {placemarks.retry(); setAttempt(value => value + 1)}} disabled={busy}>重试读取来源</button>{document && <span>已保存素材可导出备份。</span>}</div>}
    {sourceChanged && <div className="trk-vm-notice" role="status">来源轨迹、地名或 SVG 标注已变化。当前素材保留；重新提取会带入最新来源。<button type="button" onClick={() => setRebuildPrompt(true)} disabled={!canEdit}>重新提取</button></div>}
    {sourceUnavailable && !sourceError && <p className="trk-vm-empty" role="status">正在读取真实轨迹和已保存点位…</p>}
    {loadState === 'loading' && <p className="trk-vm-empty" role="status">正在读取素材草稿…</p>}
    <nav className="trk-vm-mobile" aria-label="素材准备视图"><button type="button" aria-pressed={mobilePanel === 'canvas'} onClick={() => setMobilePanel('canvas')}>二维画布</button><button type="button" aria-pressed={mobilePanel === 'properties'} onClick={() => setMobilePanel('properties')}>素材属性</button></nav>
    <div className="trk-vm-body">
      <section className="trk-vm-canvas-panel" aria-label="真实路线二维预览">
        <div className="trk-vm-canvas-toolbar">
          <div role="group" aria-label="画布工具"><button type="button" aria-pressed={tool === 'select'} onClick={() => setTool('select')} disabled={busy}>选择</button><button type="button" aria-pressed={tool === 'pan'} onClick={() => setTool(tool === 'pan' ? 'select' : 'pan')} disabled={busy}>平移</button><button type="button" aria-pressed={tool === 'add'} onClick={() => setTool(tool === 'add' ? 'select' : 'add')} disabled={!canEdit || !geometryCompatible || (document?.markers.length || 0) >= 100}>沿路线添加标记</button><button type="button" aria-pressed={tool === 'point'} onClick={() => {setTool(tool === 'point' ? 'select' : 'point'); setTab('segments')}} disabled={!canEdit || !geometryCompatible}>选择拆分点</button></div>
          <div role="group" aria-label="画布缩放"><button type="button" aria-label="缩小画布" disabled={busy || zoom <= 50} onClick={() => navigation.zoomAt(zoom - 25)}>−</button><span>{Math.round(zoom)}%</span><button type="button" aria-label="放大画布" disabled={busy || zoom >= 800} onClick={() => navigation.zoomAt(zoom + 25)}>＋</button><button type="button" disabled={busy} onClick={() => {navigation.reset(); if (canvasScroll.current) {canvasScroll.current.scrollLeft = 0; canvasScroll.current.scrollTop = 0}}}>适应</button></div>
          <div role="group" aria-label="画布平移"><button type="button" aria-label="向左平移画布" disabled={busy} onClick={() => navigation.panBy(-80, 0)}>←</button><button type="button" aria-label="向上平移画布" disabled={busy} onClick={() => navigation.panBy(0, -80)}>↑</button><button type="button" aria-label="向下平移画布" disabled={busy} onClick={() => navigation.panBy(0, 80)}>↓</button><button type="button" aria-label="向右平移画布" disabled={busy} onClick={() => navigation.panBy(80, 0)}>→</button></div>
        </div>
        <p className="trk-vm-help">{tool === 'add' ? '点击路线添加标记；滚轮缩放，按住空格拖动平移。' : tool === 'point' ? '点击路线选择拆分点；滚轮缩放，按住空格拖动平移。' : tool === 'pan' ? '拖动画布平移；滚轮围绕鼠标缩放，点击适应恢复整条路线。' : '滚轮缩放 · 空白处拖动平移 · 拖动名称调整文字位置。'}</p>
        <div className={`trk-vm-canvas-scroll${navigation.panning ? " is-panning" : ""}`} ref={canvasScroll} role="group" tabIndex={0} aria-label="素材画布视图" data-tool={tool} data-zoom={zoom} data-pan-x={panX} data-pan-y={panY} {...navigation.handlers}>
          {projection.error ? <p role="alert">{projection.error}</p> : <div className="trk-vm-canvas-inner"><svg ref={stage} className="trk-vm-svg" viewBox={`0 0 1200 ${projection.height}`} style={{width: canvasWidth, height: canvasHeight, transform: `translate(-50%, -50%) translate(${panX}px, ${panY}px)`}} role="img" aria-label="真实轨迹与视频素材" onClick={event => chooseRoutePoint(event.clientX, event.clientY)} data-tool={tool}>
            <title>{document?.title || track.name} · 二维路线素材</title>
            <defs><pattern id={`grid-${track.id}`} width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 50" fill="none" className="trk-vm-grid"/></pattern></defs>
            <rect width="1200" height={projection.height} className="trk-vm-paper"/><rect width="1200" height={projection.height} fill={`url(#grid-${track.id})`}/>
            <text x="55" y="65" className="trk-vm-svg-title">{document?.title || track.name}</text><text x="55" y="102" className="trk-vm-svg-subtitle">真实轨迹 · {document?.sourceSegmentStarts.length || 0} 个原始连接段 · 北 ↑</text>
            {geometryCompatible && document?.segments.map(segment => <g key={segment.id}>
              <path d={segmentPath(segment)} fill="none" stroke={segment.color} strokeWidth={segment.id === segmentId && tab === 'segments' ? 10 : 6} opacity={segment.selected ? 1 : .25} className="trk-vm-route"/>
              <path d={segmentPath(segment)} fill="none" stroke="transparent" strokeWidth="28" className="trk-vm-route-hit" role="button" tabIndex={busy ? -1 : 0} aria-label={`选择路线分段：${labelName(segment.name, '未命名分段')}`} onClick={event => {if (tool === 'select') {event.stopPropagation(); selectSegment(segment.id)}}} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); selectSegment(segment.id)}}}/>
            </g>)}
            {tool === 'point' && projection.points[pointIndex] && <circle cx={projection.points[pointIndex][0]} cy={projection.points[pointIndex][1]} r="12" className="trk-vm-split-point"/>}
            {geometryCompatible && document?.markers.map(marker => {
              const [x, y] = markerPosition(marker), offset = labelGhost?.id === marker.id ? labelGhost : marker.labelOffset || {x: 18, y: -14}, active = marker.id === markerId && tab === 'markers'
              return <g key={marker.id} className={`trk-vm-marker${active ? ' is-active' : ''}`} opacity={marker.selected ? 1 : .35} data-marker-id={marker.id} data-lon={marker.coordinates[0]} data-lat={marker.coordinates[1]}>
                {active && marker.photo && <g><line x1={x} y1={y} x2={x + 32} y2={y - 38} className="trk-vm-photo-stem"/><rect x={x + 24} y={y - 132} width="148" height="108" rx="10" className="trk-vm-photo-frame"/><image href={marker.photo.dataUrl} x={x + 30} y={y - 126} width="136" height="96" preserveAspectRatio="xMidYMid slice" onError={() => setPhotoError('选中的图片无法显示，请重新选择图片')}/></g>}
                <circle cx={x} cy={y} r={active ? 12 : 9} fill={marker.color} role="button" tabIndex={busy ? -1 : 0} aria-label={`选择标记：${labelName(marker.name, '未命名标记')}`} onClick={event => {if (tool === 'select') {event.stopPropagation(); selectMarker(marker.id)}}} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); selectMarker(marker.id)}}}/>
                <line x1={x} y1={y} x2={x + offset.x} y2={y + offset.y} className="trk-vm-label-stem"/>
                <text x={x + offset.x} y={y + offset.y} className="trk-vm-marker-label" onPointerDown={event => beginLabel(event, marker)} onPointerMove={moveLabel} onPointerUp={event => finishLabel(event)} onPointerCancel={event => finishLabel(event, true)} onLostPointerCapture={event => finishLabel(event, true)} onClick={event => {if (tool === 'select') {event.stopPropagation(); selectMarker(marker.id)}}}>{labelName(marker.name, '未命名标记')}</text>
              </g>
            })}
          </svg></div>}
        </div>
        {!geometryCompatible && document && <p className="trk-vm-notice">当前轨迹点数或原始断点与素材来源不一致，请重新提取后预览路线。</p>}
      </section>
      <aside className="trk-vm-properties" aria-label="视频素材属性">
        <div className="trk-vm-tabs" role="tablist" aria-label="素材分类">{([{id: 'markers', name: '标记'}, {id: 'segments', name: '路线分段'}, {id: 'information', name: '路线信息'}] as const).map(item => <button key={item.id} type="button" role="tab" id={`vm-${item.id}-${track.id}`} aria-controls={`vm-tabpanel-${track.id}`} aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.name}</button>)}</div>
        <div className="trk-vm-panel" role="tabpanel" id={`vm-tabpanel-${track.id}`} aria-labelledby={`vm-${tab}-${track.id}`}>
          <div className="trk-vm-list-tools"><span>勾选用于视频</span><button type="button" onClick={() => selectAll(true)} disabled={!canEdit}>全选</button><button type="button" onClick={() => selectAll(false)} disabled={!canEdit}>取消选择</button></div>
          {tab === 'markers' && <>
            <div className="trk-vm-list" aria-label="地点标记列表">{document?.markers.map(marker => <div key={marker.id} className={`trk-vm-row${marker.id === markerId ? ' is-active' : ''}`}><input type="checkbox" checked={marker.selected} aria-label={`用于视频：${labelName(marker.name, '未命名标记')}`} onChange={event => {const selected = event.target.checked; mutate(next => {const item = next.markers.find(item => item.id === marker.id); if (item) item.selected = selected})}} disabled={!canEdit}/><button type="button" onClick={() => selectMarker(marker.id)} disabled={busy}><span className="trk-vm-color-dot" style={{background: marker.color}}/>{labelName(marker.name, '未命名标记')}{marker.photo && <small>图片</small>}</button></div>)}{document && !document.markers.length && <p className="trk-vm-empty">当前没有地点。可在左侧沿真实路线添加标记。</p>}</div>
            {activeMarker && <fieldset disabled={!canEdit} className="trk-vm-fields"><legend>地点属性</legend><label>展示名称<input aria-label="标记名称" value={activeMarker.name} maxLength={160} onChange={event => patchMarker({name: event.target.value})}/></label><label>介绍说明<textarea aria-label="标记说明" value={activeMarker.description} maxLength={4000} rows={3} onChange={event => patchMarker({description: event.target.value})}/></label><label className="trk-vm-inline">颜色<input type="color" aria-label="标记颜色" value={activeMarker.color} onChange={event => patchMarker({color: event.target.value})}/></label><p className="trk-vm-coordinates">经度 {activeMarker.coordinates[0].toFixed(6)} · 纬度 {activeMarker.coordinates[1].toFixed(6)}<br/>对应轨迹点 {activeMarker.pointIndex}（从 0 开始）</p><div className="trk-vm-two"><label>文字横向偏移<input type="number" aria-label="文字横向偏移" min={-1200} max={1200} value={activeMarker.labelOffset?.x ?? 18} onChange={event => {const value = event.target.valueAsNumber; if (Number.isFinite(value)) patchMarker({labelOffset: {x: Math.max(-1200, Math.min(1200, value)), y: activeMarker.labelOffset?.y ?? -14}})}}/></label><label>文字纵向偏移<input type="number" aria-label="文字纵向偏移" min={-1200} max={1200} value={activeMarker.labelOffset?.y ?? -14} onChange={event => {const value = event.target.valueAsNumber; if (Number.isFinite(value)) patchMarker({labelOffset: {x: activeMarker.labelOffset?.x ?? 18, y: Math.max(-1200, Math.min(1200, value))}})}}/></label></div><p className="trk-vm-help">文字偏移仅影响二维排版，地点仍使用真实坐标。</p><button type="button" className="trk-vm-danger" onClick={() => {const id = activeMarker.id; mutate(next => {next.markers = next.markers.filter(item => item.id !== id)}); setMarkerId('')}}>删除这个标记</button></fieldset>}
            {activeMarker && <section className="trk-vm-photo-picker" aria-label="展示图片"><h3>展示图片</h3>{activeMarker.photo ? <div className="trk-vm-selected-photo"><img src={activeMarker.photo.dataUrl} alt={`${labelName(activeMarker.name, '地点')}的展示图片`} onError={() => setPhotoError('选中的图片无法显示，请重新选择图片')}/><button type="button" onClick={() => {mutate(next => {const marker = next.markers.find(item => item.id === activeMarker.id); if (marker) delete marker.photo}); setPhotoError('')}} disabled={!canEdit}>删除选图</button></div> : <p className="trk-vm-help">为这个地点选择一张展示图片。</p>}
              <div className="trk-vm-photo-candidates">{activeMarker.photoCandidates.map((url, index) => <div key={url}><span title={url}>{index + 1}. {shortPhotoName(url, index)}</span><button type="button" aria-label={`使用这张图片：${index + 1}`} onClick={() => void choosePhoto(url)} disabled={!canEdit || activeMarker.photo?.sourceUrl === url}>{activeMarker.photo?.sourceUrl === url ? '已选' : '使用这张'}</button></div>)}</div>
              <VideoResourceImagePicker key={track.id} trackId={track.id} disabled={!canEdit} onChoose={url=>void choosePhoto(url)}/>
              <label className="trk-vm-file-button">上传本地图片<input type="file" aria-label="上传展示图片" accept="image/png,image/jpeg,image/webp" disabled={!canEdit} onChange={event => {const file = event.target.files?.[0]; event.target.value = ''; if (file) void choosePhoto(file)}}/></label>{photoBusy && <p role="status">正在读取所选图片…</p>}{photoError && <p className="trk-vm-error" role="alert">{photoError}</p>}
            </section>}
          </>}
          {tab === 'segments' && <>
            <div className="trk-vm-list" aria-label="路线分段列表">{document?.segments.map(segment => <div key={segment.id} className={`trk-vm-row${segment.id === segmentId ? ' is-active' : ''}`}><input type="checkbox" checked={segment.selected} aria-label={`用于视频：${labelName(segment.name, '未命名分段')}`} disabled={!canEdit} onChange={event => {const selected = event.target.checked; mutate(next => {const item = next.segments.find(item => item.id === segment.id); if (item) item.selected = selected})}}/><button type="button" onClick={() => selectSegment(segment.id)} disabled={busy}><span className="trk-vm-color-dot" style={{background: segment.color}}/>{labelName(segment.name, '未命名分段')}<small>{segment.startIndex}–{segment.endIndex}</small></button></div>)}</div>
            {activeSegment && <fieldset className="trk-vm-fields" disabled={!canEdit || !geometryCompatible}><legend>分段属性</legend><label>分段名称<input aria-label="分段名称" value={activeSegment.name} maxLength={160} onChange={event => patchSegment({name: event.target.value})}/></label><label>分段介绍<textarea aria-label="分段介绍" value={activeSegment.description} maxLength={4000} rows={3} onChange={event => patchSegment({description: event.target.value})}/></label><label className="trk-vm-inline">颜色<input type="color" aria-label="分段颜色" value={activeSegment.color} onChange={event => patchSegment({color: event.target.value})}/></label><p className="trk-vm-coordinates">轨迹点 {activeSegment.startIndex}–{activeSegment.endIndex}（从 0 开始）{segmentMetrics && <><br/>{(segmentMetrics.distance / 1000).toFixed(2)} 公里 · 爬升 {Math.round(segmentMetrics.elevationGain)} 米</>}</p><label>拆分点序号<input type="number" aria-label="拆分点序号" value={pointIndex} min={activeSegment.startIndex + 1} max={activeSegment.endIndex - 1} step={1} onChange={event => {const value = event.target.valueAsNumber; if (Number.isInteger(value)) setPointIndex(value)}}/></label><div className="trk-vm-inline"><button type="button" onClick={split} disabled={pointIndex <= activeSegment.startIndex || pointIndex >= activeSegment.endIndex || (document?.segments.length || 0) >= 200}>在此拆分</button><button type="button" onClick={merge} disabled={!canMerge}>与下一段合并</button></div><p className="trk-vm-help">拆分保留真实路线顺序；原始断点两侧不会连接或合并。</p></fieldset>}
          </>}
          {tab === 'information' && <>
            <label className="trk-vm-title-input">视频标题<input aria-label="视频标题" value={document?.title || ''} maxLength={160} onChange={event => {const title = event.target.value; mutate(next => {next.title = title})}} disabled={!canEdit}/></label>
            <p className="trk-vm-help">统计来自当前真实轨迹，可调整展示文字。勾选后才会加入镜头。</p>
            <div className="trk-vm-information">{document?.information.map(item => <fieldset key={item.id} disabled={!canEdit}><legend><label><input type="checkbox" checked={item.selected} aria-label={`用于视频：${labelName(item.label, '未命名介绍')}`} onChange={event => {const selected = event.target.checked; mutate(next => {const info = next.information.find(value => value.id === item.id); if (info) info.selected = selected})}}/>{labelName(item.label, '未命名介绍')}</label></legend><label>信息名称<input aria-label={`介绍名称：${item.id}`} value={item.label} maxLength={80} onChange={event => {const label = event.target.value; mutate(next => {const info = next.information.find(value => value.id === item.id); if (info) info.label = label})}}/></label><label>展示文字<textarea aria-label={`介绍文字：${item.id}`} value={item.text} maxLength={2000} rows={2} onChange={event => {const text = event.target.value; mutate(next => {const info = next.information.find(value => value.id === item.id); if (info) info.text = text})}}/></label><button type="button" className="trk-vm-danger" onClick={() => mutate(next => {next.information = next.information.filter(value => value.id !== item.id)})}>删除此信息</button></fieldset>)}</div>
            <button type="button" onClick={() => mutate(next => next.information.push({id: newId(), label: '自定义介绍', text: '', selected: true}), '已添加自定义介绍')} disabled={!canEdit || (document?.information.length || 0) >= 30}>添加自定义介绍</button>
          </>}
        </div>
      </aside>
    </div>
    <footer className="trk-vm-footer"><span>素材单独保存 · 原始轨迹和点位保持原样</span><div><button type="button" onClick={() => setRebuildPrompt(true)} disabled={!canEdit}>从当前轨迹重新提取</button><button type="button" onClick={() => {if (document) download(`${clipboardSafeName(document.title || track.name)}-视频素材.json`, JSON.stringify(document, null, 2))}} disabled={!document || busy}>导出素材 JSON</button><label className="trk-vm-file-button">导入素材 JSON<input type="file" accept="application/json,.json" aria-label="导入素材 JSON" disabled={!canEdit} onChange={event => void importJson(event)}/></label></div></footer>
    {editorNavigation.dialog}
    {rebuildPrompt && <div className="trk-vm-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby={`vm-rebuild-${track.id}`} className="trk-vm-dialog" onKeyDown={event => dialogKeyboard(event, () => setRebuildPrompt(false))}><h3 id={`vm-rebuild-${track.id}`}>重新提取素材</h3><p>将当前真实轨迹、地点和已保存 SVG 标注重新带入。当前编辑可通过撤销恢复。</p><div><button type="button" autoFocus onClick={() => setRebuildPrompt(false)}>保留当前素材</button><button type="button" className="trk-vm-primary" onClick={rebuild} disabled={!canEdit}>确认重新提取</button></div></section></div>}
  </div>
}
