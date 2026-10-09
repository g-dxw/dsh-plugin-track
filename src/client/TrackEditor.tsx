/** Local immutable track drafts. Saving creates GPX copies; imported files stay intact. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { byteLength, UPLOADS, validateUpload, type TrackInput, type TrackPoint, type TrackRecord, type TrackSummary } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import {
  connectPoints, deletePoint, editedMetrics, insertPoint, joinPoints, movePoint,
  reversePoints, splitPoints, type EditPart,
} from '../track/edit.ts'
import { editedTrackInput } from '../track/gpx-export.ts'
import { formatDistance, formatElevation } from '../track/format.ts'
import { EditorMap, type EditorTool } from './EditorMap.tsx'
import { TrackPlacemarkEditor } from './TrackOverview.tsx'
import { TrackArt, type TrackArtState } from './TrackArt.tsx'
import { createPlacemarkHistory } from './placemark-history.ts'
import { editorHistoryShortcut, shortcutInsideEditor } from './editor-shortcuts.ts'

export interface TrackEditorProps {
  initial: TrackRecord | null
  availableTracks: readonly TrackSummary[]
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
  loadTrack: (id: string) => Promise<TrackRecord>
  onSave: (inputs: readonly TrackInput[], options?: {keepEditing?: boolean}) => Promise<void>
  onCancel: () => void
}

type Snapshot = {parts: EditPart[]; activePartId: string}
type History = {present: Snapshot; past: Snapshot[]; future: Snapshot[]}
const EDIT_MODES = [{id: 'points', label: '标注点编辑'}, {id: 'art', label: 'SVG 标注'}, {id: 'line', label: '线路编辑'}] as const
type EditorMode = typeof EDIT_MODES[number]['id']
const MAXIMUM_HISTORY_STEPS = 50
const MAXIMUM_POINT_REFERENCES = 2_000_000
const TOOLS: {id: EditorTool; label: string}[] = [
  {id: 'select', label: '选择 / 移动'}, {id: 'draw', label: '连点绘制'},
  {id: 'freehand', label: '手绘补线'}, {id: 'insert', label: '在线插点'},
  {id: 'split', label: '拆分工具'}, {id: 'connect', label: '连接工具'},
]

function copyName(track: TrackRecord): string {
  const name = track.name.trim() || track.filename.replace(/\.[^.]+$/u, '') || '轨迹'
  return name + '（编辑副本）'
}
function initialDraft(initial: TrackRecord | null): Snapshot {
  return {parts: [{id: 'draft-0', name: initial ? copyName(initial) : '手绘轨迹', points: initial?.coordinates ?? []}], activePartId: 'draft-0'}
}
function pointReferences(snapshot: Snapshot): number {
  return snapshot.parts.reduce((total, part) => total + part.points.length, 0)
}
function boundedPast(past: Snapshot[], present: Snapshot): Snapshot[] {
  const retained = past.slice(-MAXIMUM_HISTORY_STEPS)
  let count = pointReferences(present) + retained.reduce((total, snapshot) => total + pointReferences(snapshot), 0)
  while (retained.length && count > MAXIMUM_POINT_REFERENCES) count -= pointReferences(retained.shift()!)
  return retained
}
function changedPart(snapshot: Snapshot, transform: (part: EditPart) => EditPart): Snapshot {
  return {...snapshot, parts: snapshot.parts.map(part => part.id === snapshot.activePartId ? transform(part) : part)}
}
function validCoordinate(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -85.051129 && lat <= 85.051129
}

/** A pointer gesture arrives from EditorMap once, on mouse-up, rather than per move. */
export function TrackEditor(props: TrackEditorProps) {
  const editor = useRef<HTMLElement>(null)
  const placemarkHistory = useMemo(() => createPlacemarkHistory(props.initial?.id || ''), [props.initial?.id])
  const [mode, setMode] = useState<EditorMode>(() => props.initial ? 'points' : 'line')
  const [artVisited, setArtVisited] = useState(false)
  const [artState, setArtState] = useState<TrackArtState>({dirty: false, busy: false})
  const modeRef = useRef(mode); modeRef.current = mode
  const [placemarkBusy, setPlacemarkBusy] = useState(false)
  const [history, setHistory] = useState<History>(() => ({present: initialDraft(props.initial), past: [], future: []}))
  const historyRef = useRef(history)
  const baseline = useRef(history.present.parts)
  const nextId = useRef(1)
  const alive = useRef(true)
  const request = useRef(0)
  const locked = useRef(false)
  const [saving, setSaving] = useState(false)
  const [loadingTrack, setLoadingTrack] = useState(false)
  const [tool, setTool] = useState<EditorTool>(props.initial ? 'select' : 'draw')
  const [selected, setSelected] = useState<number[]>([])
  const active = history.present.parts.find(part => part.id === history.present.activePartId)!
  const [nameInput, setNameInput] = useState(active.name)
  const [longitude, setLongitude] = useState('')
  const [latitude, setLatitude] = useState('')
  const [libraryId, setLibraryId] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const busy = saving || loadingTrack || placemarkBusy || artState.busy
  const selectedIndex = selected.length ? selected[selected.length - 1] : null
  const point = selectedIndex === null ? undefined : active.points[selectedIndex]
  const metrics = useMemo(() => editedMetrics(active.points), [active.points])
  const dirty = history.present.parts !== baseline.current || nameInput.trim() !== active.name
  const hasDraft = dirty || artState.dirty
  useEffect(() => {
    if (!hasDraft) return
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = ''}
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasDraft])
  function changeMode(next: EditorMode) {
    if (busy || locked.current) return
    if (next === 'art') setArtVisited(true)
    setMode(next); setConfirmDiscard(false)
  }

  useEffect(() => {
    alive.current = true
    return () => {alive.current = false; request.current += 1}
  }, [])
  useEffect(() => {setNameInput(active.name)}, [active.id, active.name])
  useEffect(() => {
    setLongitude(point ? String(point[0]) : '')
    setLatitude(point ? String(point[1]) : '')
  }, [selectedIndex, point?.[0], point?.[1]])

  function publish(next: History) {
    historyRef.current = next
    setHistory(next)
  }
  function withName(snapshot: Snapshot): Snapshot {
    const name = nameInput.trim()
    const part = snapshot.parts.find(candidate => candidate.id === snapshot.activePartId)!
    if (!name || name === part.name) return snapshot
    return changedPart(snapshot, current => ({...current, name}))
  }
  function commit(transform: (snapshot: Snapshot) => Snapshot): Snapshot | null {
    if (locked.current) return null
    try {
      const previous = historyRef.current
      const next = transform(withName(previous.present))
      if (pointReferences(next) > MAXIMUM_POINT_REFERENCES) throw new Error('草稿最多容纳 2,000,000 个点，请先减少分段或分别编辑。')
      if (next.parts.some(part => part.points.length > UPLOADS.maxPoints)) throw new Error('每条轨迹最多 500,000 个点，请先拆分。')
      if (next === previous.present) return next
      publish({present: next, past: boundedPast([...previous.past, previous.present], next), future: []})
      setError(''); setNote(''); setConfirmDiscard(false)
      return next
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    }
  }
  function undo() {
    if (locked.current) return
    const previous = historyRef.current
    const next = previous.past[previous.past.length - 1]
    if (!next) return
    publish({present: next, past: previous.past.slice(0, -1), future: [previous.present, ...previous.future]})
    setSelected([]); setError(''); setNote(''); setConfirmDiscard(false)
  }
  function redo() {
    if (locked.current) return
    const previous = historyRef.current
    const next = previous.future[0]
    if (!next) return
    publish({present: next, past: [...previous.past, previous.present], future: previous.future.slice(1)})
    setSelected([]); setError(''); setNote(''); setConfirmDiscard(false)
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (modeRef.current !== 'line') return
      const action = editorHistoryShortcut(event)
      if (!action || !shortcutInsideEditor(event, editor.current)) return
      event.preventDefault()
      if (locked.current) return
      if (action === 'redo') redo()
      else undo()
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [])

  function rename() {
    if (!nameInput.trim()) {setNameInput(active.name); setError('轨迹名称不能为空'); return}
    commit(snapshot => snapshot)
  }
  function selectPart(id: string) {
    if (locked.current) return
    const updated = commit(snapshot => snapshot)
    if (!updated) return
    publish({...historyRef.current, present: {...updated, activePartId: id}})
    setSelected([]); setConfirmDiscard(false)
  }
  function selectPoint(index: number) {
    if (locked.current || !Number.isInteger(index) || !active.points[index]) return
    setSelected(previous => tool === 'connect' && previous.length === 1 && previous[0] !== index
      ? [previous[0], index].sort((a, b) => a - b)
      : [index])
    setError('')
  }
  function changePoint(index: number, lon: number, lat: number) {
    if (!validCoordinate(lon, lat)) {setError('请输入有效经纬度：经度 −180 到 180，纬度 −85.051129 到 85.051129。'); return}
    if (commit(snapshot => changedPart(snapshot, part => ({...part, points: movePoint(part.points, index, lon, lat)})))) setSelected([index])
  }
  function appendPoint(lon: number, lat: number) {
    if (!validCoordinate(lon, lat)) {setError('新点的经纬度无效'); return}
    const updated = commit(snapshot => changedPart(snapshot, part => ({...part, points: insertPoint(part.points, part.points.length, lon, lat)})))
    if (updated) setSelected([updated.parts.find(part => part.id === updated.activePartId)!.points.length - 1])
  }
  function addBetween(index: number, lon: number, lat: number) {
    if (commit(snapshot => changedPart(snapshot, part => ({...part, points: insertPoint(part.points, index, lon, lat)})))) setSelected([index])
  }
  function freehand(coordinates: readonly [number, number][]) {
    if (coordinates.length < 2) return
    if (coordinates.some(([lon, lat]) => !validCoordinate(lon, lat))) {setError('手绘点的经纬度无效'); return}
    const via: TrackPoint[] = coordinates.map(([lon, lat]) => [lon, lat, null, null])
    const updated = commit(snapshot => changedPart(snapshot, part => ({
      ...part,
      points: selected.length === 2
        ? connectPoints(part.points, selected[0], selected[1], via)
        : [...part.points, ...via],
    })))
    if (updated) setSelected([])
  }
  function removePoint() {
    if (selectedIndex === null) return
    const updated = commit(snapshot => changedPart(snapshot, part => ({...part, points: deletePoint(part.points, selectedIndex)})))
    if (updated) {
      const length = updated.parts.find(part => part.id === updated.activePartId)!.points.length
      setSelected(length ? [Math.min(selectedIndex, length - 1)] : [])
    }
  }
  function split() {
    if (selectedIndex === null) return
    const updated = commit(snapshot => {
      const current = snapshot.parts.find(part => part.id === snapshot.activePartId)!
      const [first, second] = splitPoints(current.points, selectedIndex)
      const parts: EditPart[] = [
        {id: 'draft-' + nextId.current++, name: current.name + ' · 第1段', points: first},
        {id: 'draft-' + nextId.current++, name: current.name + ' · 第2段', points: second},
      ]
      return {parts: snapshot.parts.flatMap(part => part.id === current.id ? parts : [part]), activePartId: parts[0].id}
    })
    if (updated) {setSelected([]); setTool('select')}
  }
  function connect() {
    if (selected.length !== 2) return
    if (commit(snapshot => changedPart(snapshot, part => ({...part, points: connectPoints(part.points, selected[0], selected[1])})))) {
      setSelected([]); setTool('select')
    }
  }
  function reorder(index: number, direction: number) {
    commit(snapshot => {
      const target = index + direction
      if (target < 0 || target >= snapshot.parts.length) return snapshot
      const parts = [...snapshot.parts]
      ;[parts[index], parts[target]] = [parts[target], parts[index]]
      return {...snapshot, parts}
    })
  }
  function merge() {
    const updated = commit(snapshot => {
      if (snapshot.parts.length < 2) return snapshot
      const part: EditPart = {id: 'draft-' + nextId.current++, name: snapshot.parts[0].name + '（合并）', points: joinPoints(snapshot.parts.map(candidate => candidate.points))}
      return {parts: [part], activePartId: part.id}
    })
    if (updated) {setSelected([]); setTool('select')}
  }
  async function addLibraryTrack() {
    if (!libraryId || locked.current) return
    const id = libraryId
    const token = ++request.current
    locked.current = true; setLoadingTrack(true); setError(''); setNote('')
    try {
      const track = await props.loadTrack(id)
      if (!alive.current || token !== request.current) return
      locked.current = false
      const part: EditPart = {id: 'draft-' + nextId.current++, name: copyName(track), points: track.coordinates}
      const updated = commit(snapshot => ({parts: [...snapshot.parts, part], activePartId: part.id}))
      if (updated) {setSelected([]); setLibraryId('')}
    } catch (reason) {
      if (alive.current && token === request.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (alive.current && token === request.current) {locked.current = false; setLoadingTrack(false)}
    }
  }
  async function save() {
    if (locked.current) return
    if (!nameInput.trim()) {setError('轨迹名称不能为空'); return}
    const draft = commit(snapshot => snapshot)
    if (!draft) return
    locked.current = true; setSaving(true); setError(''); setNote(''); setConfirmDiscard(false)
    try {
      const inputs = draft.parts.map(part => {
        if (part.points.length < 2) throw new Error('「' + part.name + '」至少需要 2 个点才能保存。')
        if (part.points.length > UPLOADS.maxPoints) throw new Error('「' + part.name + '」超过 500,000 个点，请先拆分。')
        const input = editedTrackInput(part.points, {name: part.name})
        const invalid = validateUpload(input.filename, input.source)
        if (invalid) throw new Error('「' + part.name + '」：' + invalid)
        return input
      })
      if (byteLength(JSON.stringify({tracks: inputs})) > UPLOADS.maxRequestBytes) throw new Error('保存内容超过 24 MB，请先减少轨迹点或分批编辑。')
      if (artState.dirty) await props.onSave(inputs, {keepEditing: true})
      else await props.onSave(inputs)
      if (alive.current) {
        baseline.current = draft.parts
        publish({present: draft, past: [], future: []})
        setNote('已保存 ' + inputs.length + ' 份 GPX 副本，原轨迹和原文件保留。')
      }
    } catch (reason) {
      if (alive.current) setError('保存失败，草稿已保留：' + (reason instanceof Error ? reason.message : String(reason)))
    } finally {
      if (alive.current) {locked.current = false; setSaving(false)}
    }
  }
  function cancel() {
    if (locked.current || busy) return
    if (hasDraft) setConfirmDiscard(true)
    else props.onCancel()
  }

  const canSplit = selectedIndex !== null && selectedIndex > 0 && selectedIndex < active.points.length - 1
  const canConnect = selected.length === 2
  const instruction = tool === 'connect'
    ? (canConnect ? '已选择第 ' + (selected[0] + 1) + ' 与第 ' + (selected[1] + 1) + ' 个点。直线连接会替换两点之间的轨迹。' : '依次选择两个轨迹点，再点击「直线连接两点」。')
    : tool === 'split' ? '选择一个内部轨迹点，再点击「在选中点拆分」，两段都会保留拆分点。'
    : tool === 'freehand' ? (canConnect ? '按住鼠标绘制补线，松开后替换两个选中点之间的轨迹。' : '按住鼠标绘制，松开后追加到当前段末尾。')
    : tool === 'insert' ? '点击轨迹线段插入新点。'
    : tool === 'draw' ? '点击地图追加轨迹点。新点没有海拔或录制时间。'
    : '点击选点；拖动地图上的点，或用下方坐标表单修正位置。'

  return <section ref={editor} className="trk-editor" aria-label="轨迹编辑器">
    <style>{EDITOR_CSS}</style>
    <header className="trk-editor-head">
      <div><h2>{props.initial ? '编辑轨迹' : '新建轨迹'}</h2><p>{mode === 'points' ? '调整标注点顺序、照片关联与位置。修改自动保存到当前轨迹。' : mode === 'art' ? '在 SVG 画布上编辑标注、照片与排版，保存后可继续编辑。' : '手动修线、拆分和合并。保存为新的 GPX 副本，原轨迹保留。'}</p></div>
      <div className="trk-editor-actions">
        {mode === 'line' && <><button type="button" disabled={busy || !history.past.length} aria-keyshortcuts="Control+z Meta+z" title="撤销（Ctrl+Z）" onClick={undo}>撤销</button>
        <button type="button" disabled={busy || !history.future.length} aria-keyshortcuts="Control+Shift+z Meta+Shift+z Control+y" title="重做（Ctrl+Shift+Z / Ctrl+Y）" onClick={redo}>重做</button></>}
        <button type="button" disabled={busy} onClick={cancel}>{mode !== 'line' ? (placemarkBusy ? '正在处理点位…' : artState.busy ? '正在处理画布…' : '返回轨迹') : '取消编辑'}</button>
        {mode === 'line' && <button type="button" className="trk-editor-save" disabled={busy} onClick={() => void save()}>{saving ? '正在保存…' : '保存全部为 GPX 副本'}</button>}
      </div>
    </header>
    {props.initial && <div className="trk-editor-tabs" role="tablist" aria-label="编辑内容">
      {EDIT_MODES.map(({id: value, label}) => <button key={value} type="button" role="tab" id={`trk-edit-${value}-tab`} data-edit-mode={value}
        aria-selected={mode === value} aria-controls={`trk-edit-${value}-panel`} tabIndex={mode === value ? 0 : -1} disabled={busy}
        onClick={() => changeMode(value)} onKeyDown={event => {
          if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || busy) return
          event.preventDefault()
          const index = EDIT_MODES.findIndex(option => option.id === value)
          const next = event.key === 'Home' ? EDIT_MODES[0].id : event.key === 'End' ? EDIT_MODES.at(-1)!.id
            : EDIT_MODES[(index + (event.key === 'ArrowRight' ? 1 : -1) + EDIT_MODES.length) % EDIT_MODES.length].id
          changeMode(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-edit-mode="${next}"]`)?.focus()
        }}>{label}</button>)}
    </div>}
    {mode === 'line' && error && <div className="trk-editor-error" role="alert">{error}</div>}
    {mode === 'line' && note && <div className="trk-editor-note" role="status">{note}</div>}
    {confirmDiscard && <div className="trk-editor-discard" role="alert">
      <span>还有未保存的修改。放弃后这些草稿修改不会保留。</span>
      <button type="button" disabled={busy} onClick={() => props.onCancel()}>放弃修改</button>
      <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)}>继续编辑</button>
    </div>}
    {mode === 'points' && props.initial && <div role="tabpanel" id="trk-edit-points-panel" aria-labelledby="trk-edit-points-tab">
      <TrackPlacemarkEditor track={props.initial} basemap={props.basemap} onBasemap={props.onBasemap} onBusyChange={setPlacemarkBusy} history={placemarkHistory}/>
    </div>}
    {artVisited && props.initial && <div role="tabpanel" id="trk-edit-art-panel" aria-labelledby="trk-edit-art-tab" hidden={mode !== 'art'}>
      <TrackArt key={props.initial.id} track={props.initial} basemap={props.basemap} onBasemap={props.onBasemap} onCancel={cancel}
        embedded active={mode === 'art'} onStateChange={setArtState}/>
    </div>}
    {mode === 'line' && <fieldset className="trk-editor-body" disabled={busy} role={props.initial ? 'tabpanel' : undefined} id="trk-edit-line-panel" aria-labelledby={props.initial ? 'trk-edit-line-tab' : undefined}>
      <div className="trk-editor-tools" role="group" aria-label="轨迹编辑工具">
        {TOOLS.map(option => <button key={option.id} type="button" aria-pressed={tool === option.id} onClick={() => {setTool(option.id); setError('')}}>{option.label}</button>)}
      </div>
      <p className="trk-editor-instruction" role="status">{loadingTrack ? '正在加载库中的轨迹…' : instruction}</p>
      <EditorMap parts={history.present.parts} activePartId={active.id} selectedIndices={selected} tool={tool} basemap={props.basemap}
        onBasemap={next => {if (!locked.current) props.onBasemap(next)}} disabled={busy}
        onSelectPoint={selectPoint} onMovePoint={changePoint} onAddPoint={appendPoint} onInsertPoint={addBetween} onFreehand={freehand} />
      <div className="trk-editor-grid">
        <div className="trk-editor-parts">
          <h3>轨迹分段 · {history.present.parts.length}</h3>
          <div role="tablist" aria-label="轨迹分段">
            {history.present.parts.map((part, index) => <div className="trk-editor-part" key={part.id}>
              <button type="button" role="tab" aria-selected={part.id === active.id} onClick={() => selectPart(part.id)}>{index + 1}. {part.name}<small>{part.points.length.toLocaleString('zh-CN')} 个点</small></button>
              <button type="button" aria-label={'上移第 ' + (index + 1) + ' 段'} disabled={index === 0} onClick={() => reorder(index, -1)}>↑</button>
              <button type="button" aria-label={'下移第 ' + (index + 1) + ' 段'} disabled={index === history.present.parts.length - 1} onClick={() => reorder(index, 1)}>↓</button>
            </div>)}
          </div>
          <p>合并按列表从上到下连接；用上下箭头调整顺序。</p>
          <button type="button" disabled={history.present.parts.length < 2} onClick={merge}>按列表顺序合并全部</button>
          <label>从轨迹库添加<select aria-label="从轨迹库添加" value={libraryId} onChange={event => setLibraryId(event.target.value)}>
            <option value="">请选择轨迹</option>
            {props.availableTracks.map(track => <option key={track.id} value={track.id}>{track.name || track.filename} · {track.points.toLocaleString('zh-CN')} 个点</option>)}
          </select></label>
          <button type="button" disabled={!libraryId} onClick={() => void addLibraryTrack()}>{loadingTrack ? '正在加载…' : '添加为新段'}</button>
        </div>
        <div className="trk-editor-points">
          <label>当前轨迹名称<input aria-label="当前轨迹名称" value={nameInput} maxLength={160} onChange={event => setNameInput(event.target.value)} onBlur={rename} onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); rename()}}} /></label>
          <p className="trk-editor-metrics">{active.points.length.toLocaleString('zh-CN')} 个点 · {formatDistance(metrics.distance)} · 爬升 {formatElevation(metrics.elevationGain)}</p>
          <div className="trk-editor-position">
            <button type="button" aria-label="选择前一个点" disabled={selectedIndex === null || selectedIndex === 0} onClick={() => setSelected([selectedIndex! - 1])}>前一个点</button>
            <label>点序号<input aria-label="点序号" type="number" min={1} max={Math.max(1, active.points.length)} value={selectedIndex === null ? '' : selectedIndex + 1} disabled={!active.points.length} placeholder="选择点" onChange={event => selectPoint(event.target.valueAsNumber - 1)} /></label>
            <button type="button" aria-label="选择后一个点" disabled={selectedIndex === null || selectedIndex >= active.points.length - 1} onClick={() => setSelected([selectedIndex! + 1])}>后一个点</button>
          </div>
          {point && <p className="trk-editor-point-meta">第 {selectedIndex! + 1} / {active.points.length} 个点 · 海拔 {point[2] === null ? '无数据' : formatElevation(point[2])} · 时间 {point[3] === null ? '无数据' : new Date(point[3]).toLocaleString('zh-CN')}</p>}
          <form className="trk-editor-coordinates" onSubmit={event => {
            event.preventDefault()
            if (selectedIndex === null) return
            if (!longitude.trim() || !latitude.trim()) {setError('请输入经度和纬度'); return}
            changePoint(selectedIndex, Number(longitude), Number(latitude))
          }}>
            <label>经度<input aria-label="经度" inputMode="decimal" value={longitude} disabled={!point} onChange={event => setLongitude(event.target.value)} /></label>
            <label>纬度<input aria-label="纬度" inputMode="decimal" value={latitude} disabled={!point} onChange={event => setLatitude(event.target.value)} /></label>
            <button type="submit" disabled={!point}>应用坐标</button>
          </form>
          <div className="trk-editor-actions">
            <button type="button" disabled={!point} onClick={removePoint}>删除选中点</button>
            <button type="button" disabled={active.points.length < 2} onClick={() => {if (commit(snapshot => changedPart(snapshot, part => ({...part, points: reversePoints(part.points)})))) setSelected([])}}>反转当前段</button>
            <button type="button" disabled={!canSplit} onClick={split}>在选中点拆分</button>
            <button type="button" disabled={!canConnect} onClick={connect}>直线连接两点</button>
          </div>
          <p>移动、新增及手绘的点不保留原海拔和时间；其他点仍保留导入数据。</p>
          {active.points.length < 2 && <p className="trk-editor-validation">当前段至少需要 2 个点才能保存。</p>}
        </div>
      </div>
    </fieldset>}
  </section>
}

const EDITOR_CSS = `
.trk-editor .trk-profile-marker{border:2px solid white;border-radius:50%;background:#c83532;color:white;font:700 11px/1 system-ui,sans-serif}.trk-editor .trk-profile-marker-group{border-radius:14px;padding:0 4px;font-size:10px}.trk-editor .trk-profile-marker:hover:not(:disabled){background:#c83532}.trk-editor .trk-profile-marker-selected,.trk-editor .trk-profile-marker-selected:hover:not(:disabled){background:#98221f}
.trk-editor-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.trk-editor-tabs button[aria-selected=true]{border-color:var(--trk-accent);background:var(--trk-active)}.trk-editor .trk-map-placemark{min-height:32px;padding:0;border:0;border-radius:50%;background:transparent}.trk-editor .trk-map-placemark:hover:not(:disabled){background:transparent}.trk-editor .trk-profile-marker{min-height:26px;padding:0}.trk-editor .trk-overview-point{border:1px solid transparent;min-height:82px;padding:9px}.trk-editor .trk-overview-point[aria-pressed=true]{border-color:var(--trk-border)}.trk-editor .trk-overview-photo-choice{min-height:62px;padding:2px}
.trk-editor [role=tabpanel][hidden]{display:none}.trk-editor{color:var(--trk-text);font:inherit}.trk-editor *{box-sizing:border-box}.trk-editor h2{margin:0 0 8px;font-size:calc(var(--trk-font-size)*1.5714)}.trk-editor h3{margin:0 0 12px;font-size:calc(var(--trk-font-size)*1.0714)}.trk-editor :where(.trk-editor-head p,.trk-editor-body > p,.trk-editor-parts > p,.trk-editor-points > p){font-size:calc(var(--trk-font-size)*0.9286);line-height:1.7;margin:8px 0;color:var(--trk-muted)}.trk-editor button,.trk-editor input,.trk-editor select{font:inherit;font-size:calc(var(--trk-font-size)*0.9286);min-height:44px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);color:var(--trk-text);background:var(--trk-surface);padding:9px 12px}.trk-editor button{cursor:pointer}.trk-editor button:hover:not(:disabled){background:var(--trk-hover)}.trk-editor button:disabled{opacity:.45;cursor:not-allowed}.trk-editor button:focus-visible,.trk-editor input:focus-visible,.trk-editor select:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-editor button[aria-pressed=true],.trk-editor button[aria-selected=true]{border-color:var(--trk-accent);background:var(--trk-active)}.trk-editor label{display:flex;flex-direction:column;gap:6px;font-size:calc(var(--trk-font-size)*0.8571);margin:12px 0}.trk-editor input,.trk-editor select{width:100%;min-width:0;background:var(--trk-bg)}.trk-editor option{background:var(--trk-bg)}.trk-editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}.trk-editor-actions,.trk-editor-tools{display:flex;gap:8px;flex-wrap:wrap}.trk-editor .trk-editor-save:hover:not(:disabled){background:var(--trk-primary-bg);color:var(--trk-on-accent)}.trk-editor .trk-editor-save{background:var(--trk-primary-bg);color:var(--trk-on-accent);border-color:var(--trk-accent);font-weight:650}.trk-editor-body{padding:0;border:0;margin:0;min-width:0}.trk-editor-instruction{min-height:22px}.trk-editor-grid{display:grid;grid-template-columns:minmax(220px,.7fr) minmax(300px,1.3fr);gap:18px;margin-top:18px}.trk-editor-parts,.trk-editor-points{background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:14px;min-width:0}.trk-editor-part{display:flex;gap:6px;margin:6px 0;align-items:stretch}.trk-editor-part>button[role=tab]{flex:1;min-width:0;overflow-wrap:anywhere;text-align:left}.trk-editor-part small{display:block;color:var(--trk-muted);margin-top:4px}.trk-editor-part>button:not([role=tab]){width:44px;flex-shrink:0;padding:8px}.trk-editor-parts>button{width:100%}.trk-editor-position{display:flex;gap:8px;align-items:flex-end}.trk-editor-position label{margin:0;flex:1;min-width:70px}.trk-editor-position>button{flex-shrink:0}.trk-editor-coordinates{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:flex-end;margin-bottom:12px}.trk-editor-coordinates label{margin:0}.trk-editor-error,.trk-editor-note,.trk-editor-discard{font-size:calc(var(--trk-font-size)*0.9286);line-height:1.7;padding:12px;border-radius:var(--trk-radius-md);margin-bottom:12px;border:1px solid var(--trk-danger-border);background:var(--trk-danger-bg);color:var(--trk-danger);white-space:pre-wrap}.trk-editor-note{background:var(--trk-notice-bg);border-color:var(--trk-notice-border);color:var(--trk-notice)}.trk-editor-discard{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.trk-editor-discard span{flex:1;min-width:220px}.trk-editor .trk-editor-validation{color:var(--trk-danger)}.trk-editor-body:disabled .trk-edit-map{pointer-events:none}
@container(max-width:750px){.trk-editor-head{flex-direction:column}.trk-editor-grid{grid-template-columns:1fr}.trk-editor-actions{width:100%}.trk-editor-head .trk-editor-actions button{flex:1}.trk-editor-coordinates{grid-template-columns:1fr 1fr}.trk-editor-coordinates button{grid-column:1/-1}.trk-editor-position{flex-wrap:wrap}.trk-editor-position label{min-width:110px}}
@media(max-width:600px){.trk-editor-head{flex-direction:column}.trk-editor-grid{grid-template-columns:1fr}.trk-editor-coordinates{grid-template-columns:1fr 1fr}.trk-editor-coordinates button{grid-column:1/-1}}
@media(forced-colors:active){.trk-editor button,.trk-editor input,.trk-editor select{border-color:var(--trk-border);background:var(--trk-bg);color:var(--trk-text)}.trk-editor button[aria-pressed=true],.trk-editor button[aria-selected=true]{border:2px solid var(--trk-focus)}.trk-editor-error,.trk-editor-note,.trk-editor-discard{background:var(--trk-bg);color:var(--trk-text);border-color:var(--trk-border)}}
`


