import {Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent as ReactKeyboardEvent} from 'react'
import {timelineKeyCollision, timelineRetimeWindow, timelineSnapTime, timelineTicks, timelineTimeFromClient} from '../track/geomotion-timeline.ts'
import {GEOMOTION_TIMELINE_CSS} from './geomotion-timeline-css.ts'

export interface GeoMotionTimelineLayer {id: string; name: string; type: string; in: number; out: number; visible: boolean; locked?: boolean; visibilityLocked?: boolean}
export interface GeoMotionTimelineKey {id: string; t: number}
export interface GeoMotionTimelineKeyLane {id: string; name: string; keys: readonly GeoMotionTimelineKey[]}
export interface GeoMotionTimelineProps {
  duration: number; fps: number; time: number; keys: readonly GeoMotionTimelineKey[]; layers: readonly GeoMotionTimelineLayer[]
  keyLanes?: readonly GeoMotionTimelineKeyLane[]; selectedLaneId?: string; onSelectLane?: (id: string) => void
  selectedKeyId: string; selectedLayerId: string; playing: boolean; recording: boolean; disabled: boolean; editDisabled: boolean
  onSeek: (time: number) => void; onPlayPause: () => void; onSelectKey: (id: string, time: number, laneId?: string) => void
  onKeyTime: (id: string, time: number, laneId?: string) => void; onSelectLayer: (id: string) => void
  onLayerRange: (id: string, range: {in: number; out: number}, mode?: 'move' | 'start' | 'end') => void
  onToggleLayer: (id: string) => void; onAddKey: (laneId?: string) => void
}
type DragMode = 'seek' | 'key' | 'move' | 'start' | 'end'
type Drag = {mode: DragMode; id: string; laneId?: string; startX: number; plotLeft: number; plotWidth: number; originalTime: number; startValue: number; window?: {in: number; out: number}; moved: boolean; target: HTMLElement; pointerId: number}
type Ghost = {mode: DragMode; id: string; laneId?: string; time?: number; range?: {in: number; out: number}; collision?: boolean}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const scaleWithin = (value: number) => clamp(value, 1, 800)
const rounded = (value: number) => Number(value.toFixed(3))
const layerKind = (type: string) => type === 'route' ? '轨迹' : type === 'marker' ? '地名' : type === 'text' ? '字幕' : type === 'image' ? '图片' : type === 'shape' ? '区域' : type === 'source' ? '源轨迹' : '图层'
const validFps = (fps: number) => Number.isFinite(fps) && fps > 0 ? fps : 30
function clock(time: number, fps: number) {
  const rate = validFps(fps), frame = Math.round(time * rate), seconds = Math.floor(frame / rate)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}:${String(Math.round(frame - seconds * rate)).padStart(2, '0')}`
}

/** One time coordinate system governs independent key lanes and every layer. */
export function GeoMotionTimeline(props: GeoMotionTimelineProps) {
  const [snap, setSnap] = useState(true), [showHidden, setShowHidden] = useState(false)
  const [manualScale, setManualScale] = useState(50), [fit, setFit] = useState(true), [viewportWidth, setViewportWidth] = useState(900)
  const [ghost, setGhost] = useState<Ghost | null>(null), [notice, setNotice] = useState('')
  const pendingScroll = useRef<number | null>(null)
  const viewport = useRef<HTMLDivElement>(null), plot = useRef<HTMLDivElement>(null), dragging = useRef<Drag | null>(null)
  const latest = useRef(props), latestGhost = useRef(ghost), live = useRef(true)
  latest.current = props; latestGhost.current = ghost
  const gutter = viewportWidth < 500 ? 116 : 156
  const duration = Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 1
  const pxPerSecond = fit ? Math.max(.0001, viewportWidth - gutter - 18) / duration : manualScale
  const plotWidth = Math.max(1, duration * pxPerSecond)
  const ticks = useMemo(() => timelineTicks(duration, plotWidth), [duration, plotWidth])
  const layers = useMemo(() => props.layers.filter(layer => showHidden || layer.visible), [props.layers, showHidden])
  const keyLanes = props.keyLanes ?? [{id: 'camera', name: '相机', keys: props.keys}]
  const selectedLane = props.selectedLaneId ?? keyLanes[0]?.id
  const visibleRows = Math.max(1, layers.length + keyLanes.length)
  const readonlyLayer = (layer: GeoMotionTimelineLayer) => props.editDisabled || props.disabled || props.recording || layer.locked === true || layer.type === 'source'
  const keysInLane = (laneId?: string) => props.keyLanes?.find(lane => lane.id === laneId)?.keys ?? (props.keyLanes ? [] : props.keys)
  function selectKey(id: string, time: number, laneId?: string) {
    if (props.keyLanes) {if (laneId) props.onSelectLane?.(laneId); props.onSelectKey(id, time, laneId)}
    else props.onSelectKey(id, time)
  }
  function moveKey(id: string, time: number, laneId?: string) {
    if (props.keyLanes) props.onKeyTime(id, time, laneId)
    else props.onKeyTime(id, time)
  }

  function endCapture(drag: Drag) {
    try {if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId)} catch {/* Capture may already have been released by the browser. */}
  }
  function cancelDrag(message = '') {
    const drag = dragging.current
    dragging.current = null; latestGhost.current = null
    if (!live.current) return
    setGhost(null)
    if (drag) {endCapture(drag); latest.current.onSeek(drag.originalTime)}
    if (message) setNotice(message)
  }
  useEffect(() => {
    live.current = true
    const cancel = () => cancelDrag('已取消时间轴调整，原位置保留')
    const escape = (event: KeyboardEvent) => {if (event.key === 'Escape' && dragging.current) {event.preventDefault(); cancel()}}
    window.addEventListener('blur', cancel); window.addEventListener('keydown', escape)
    const resized = () => {const width = viewport.current?.clientWidth || viewport.current?.getBoundingClientRect().width; if (width && Number.isFinite(width)) setViewportWidth(width)}
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resized)
    if (viewport.current) observer?.observe(viewport.current)
    window.addEventListener('resize', resized); resized()
    return () => {
      live.current = false; const drag = dragging.current; dragging.current = null; if (drag) endCapture(drag)
      observer?.disconnect(); window.removeEventListener('resize', resized); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape)
    }
  }, [])
  useEffect(() => {
    if (dragging.current && (props.disabled || props.editDisabled || props.recording)) cancelDrag('时间轴已锁定，原位置保留')
  }, [props.disabled, props.editDisabled, props.recording])
  useEffect(() => {if (dragging.current) cancelDrag('时间轴比例已变化，原位置保留')}, [pxPerSecond, duration, props.fps])

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && viewport.current) {viewport.current.scrollLeft = pendingScroll.current; pendingScroll.current = null}
  }, [pxPerSecond, plotWidth])

  function timeFromPointer(clientX: number) {
    const rect = plot.current?.getBoundingClientRect()
    return rect ? timelineTimeFromClient(clientX, rect.left, rect.width, duration, props.fps, snap) : props.time
  }
  function begin(event: PointerEvent<HTMLElement>, mode: DragMode, id = '', startValue = props.time, window?: {in: number; out: number}, laneId?: string) {
    if (dragging.current || props.disabled || props.recording || mode !== 'seek' && props.editDisabled) return
    if (mode !== 'seek' && mode !== 'key') {const layer = props.layers.find(layer => layer.id === id); if (!layer || readonlyLayer(layer)) return}
    const rect = plot.current?.getBoundingClientRect()
    if (!rect?.width) return
    event.preventDefault(); event.stopPropagation(); setNotice('')
    const drag: Drag = {mode, id, laneId, startX: event.clientX, plotLeft: rect.left, plotWidth: rect.width, originalTime: props.time, startValue, window, moved: false, target: event.currentTarget, pointerId: event.pointerId}
    dragging.current = drag
    try {event.currentTarget.setPointerCapture?.(event.pointerId)} catch {/* Tests or an interrupted pointer may not support capture. */}
    if (mode === 'seek') props.onSeek(timeFromPointer(event.clientX))
    else if (mode === 'key') selectKey(id, startValue, laneId)
    else props.onSelectLayer(id)
  }
  function move(event: PointerEvent<HTMLElement>) {
    const drag = dragging.current
    if (!drag || event.pointerId !== drag.pointerId || props.disabled || props.recording || drag.mode !== 'seek' && props.editDisabled) return
    event.stopPropagation()
    if (drag.mode === 'seek') {props.onSeek(timeFromPointer(event.clientX)); return}
    const rect = plot.current?.getBoundingClientRect()
    if (!rect) return
    const pixelDelta = event.clientX - drag.startX - (rect.left - drag.plotLeft)
    const delta = pixelDelta / drag.plotWidth * duration
    if (Math.abs(pixelDelta) > 2) drag.moved = true
    let next: Ghost
    if (drag.mode === 'key') {
      const time = timelineSnapTime(drag.startValue + delta, props.fps, duration, snap)
      next = {mode: 'key', id: drag.id, laneId: drag.laneId, time, collision: timelineKeyCollision(drag.id, time, keysInLane(drag.laneId))}
      props.onSeek(time)
    } else {
      const range = timelineRetimeWindow(drag.window!, delta, drag.mode, duration, props.fps, snap)
      next = {mode: drag.mode, id: drag.id, range}
      props.onSeek(drag.mode === 'end' ? range.out : range.in)
    }
    latestGhost.current = next; setGhost(next)
  }
  function finish(event: PointerEvent<HTMLElement>) {
    const drag = dragging.current, preview = latestGhost.current
    if (!drag || event.pointerId !== drag.pointerId) return
    event.stopPropagation()
    dragging.current = null; latestGhost.current = null; setGhost(null); endCapture(drag)
    if (props.disabled || props.recording || props.editDisabled && drag.mode !== 'seek') {props.onSeek(drag.originalTime); return}
    if (drag.mode === 'seek') {props.onSeek(timeFromPointer(event.clientX)); return}
    if (!drag.moved || !preview) return
    if (drag.mode === 'key') {
      if (props.keyLanes && !props.keyLanes.some(lane => lane.id === drag.laneId && lane.keys.some(key => key.id === drag.id))) {props.onSeek(drag.originalTime); return}
      if (timelineKeyCollision(drag.id, preview.time!, keysInLane(drag.laneId))) {props.onSeek(drag.originalTime); setNotice('该时刻已有其他关键帧，已取消移动，原关键帧保留'); return}
      if (preview.time !== drag.startValue) {moveKey(drag.id, preview.time!, drag.laneId); setNotice(`关键帧已移动到 ${rounded(preview.time!)} 秒`)}
    } else if (preview.range && (preview.range.in !== drag.window!.in || preview.range.out !== drag.window!.out)) {
      props.onLayerRange(drag.id, preview.range, drag.mode); setNotice(`片段时间已调整为 ${rounded(preview.range.in)} – ${rounded(preview.range.out)} 秒`)
    }
  }
  const pointerHandlers = {onPointerMove: move, onPointerUp: finish, onPointerCancel: () => cancelDrag('已取消时间轴调整，原位置保留'), onLostPointerCapture: () => {if (dragging.current) cancelDrag('已取消时间轴调整，原位置保留')}}

  function keyKeyboard(event: ReactKeyboardEvent, key: GeoMotionTimelineKey, laneId: string) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || props.editDisabled || props.disabled || props.recording) return
    event.preventDefault(); event.stopPropagation()
    const time = timelineSnapTime(key.t + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / validFps(props.fps), props.fps, duration, snap)
    if (timelineKeyCollision(key.id, time, keysInLane(laneId))) {setNotice('该时刻已有其他关键帧，原关键帧保留'); return}
    if (time !== key.t) {selectKey(key.id, time, laneId); moveKey(key.id, time, laneId); props.onSeek(time)}
  }
  function layerKeyboard(event: ReactKeyboardEvent, layer: GeoMotionTimelineLayer, mode: 'move' | 'start' | 'end') {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || readonlyLayer(layer)) return
    event.preventDefault(); event.stopPropagation()
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / validFps(props.fps)
    const range = timelineRetimeWindow(layer, delta, mode, duration, props.fps, snap)
    if (range.in !== layer.in || range.out !== layer.out) {props.onSelectLayer(layer.id); props.onLayerRange(layer.id, range, mode); props.onSeek(mode === 'end' ? range.out : range.in)}
  }
  function zoom(value: number) {
    if (props.recording || dragging.current) return
    const element = viewport.current, scale = scaleWithin(value), visibleWidth = Math.max(1, (element?.clientWidth || viewportWidth) - gutter)
    const center = ((element?.scrollLeft || 0) + visibleWidth / 2) / pxPerSecond
    pendingScroll.current = Math.max(0, center * scale - visibleWidth / 2)
    setManualScale(scale); setFit(false)
  }
  function fitAll() {if (props.recording || dragging.current) return; pendingScroll.current = null; setFit(true); if (viewport.current) viewport.current.scrollLeft = 0}
  return <section className="trk-gm-timeline-modern" aria-label="镜头时间轴">
    <style>{GEOMOTION_TIMELINE_CSS}</style>
    <div className="trk-gm-tl-toolbar">
      <div className="trk-gm-tl-transport">
        <button type="button" disabled={props.disabled} onClick={props.onPlayPause}>{props.playing ? '暂停' : '播放'}</button>
        <button type="button" disabled={props.disabled} onClick={() => props.onSeek(0)} title="回到开头">回到开头</button>
        <label className="trk-gm-tl-time">时间<input aria-label="当前时间（秒）" type="number" min={0} max={duration} step={1 / validFps(props.fps)} value={rounded(props.time)} disabled={props.disabled} onChange={event => {const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) props.onSeek(timelineSnapTime(value, props.fps, duration, snap))}}/><span>秒</span></label>
        <output className="trk-gm-tl-clock" aria-label="镜头播放状态">{clock(props.time, props.fps)} / {clock(duration, props.fps)}{props.recording ? ' · 正在导出' : props.playing ? ' · 正在播放' : ''}</output>
      </div>
      <div className="trk-gm-tl-tools">
        <button type="button" disabled={props.editDisabled || props.disabled || !keyLanes.length} onClick={() => props.keyLanes ? props.onAddKey(selectedLane) : props.onAddKey()}>添加关键帧</button>
        <label className="trk-gm-tl-option"><input type="checkbox" aria-label="按帧吸附" checked={snap} disabled={props.recording || !!ghost} onChange={event => setSnap(event.currentTarget.checked)}/>按帧吸附</label>
        <label className="trk-gm-tl-option"><input type="checkbox" aria-label="显示隐藏图层" checked={showHidden} disabled={props.recording || !!ghost} onChange={event => setShowHidden(event.currentTarget.checked)}/>显示隐藏图层</label>
        <div className="trk-gm-tl-zoom" role="group" aria-label="时间轴缩放工具">
          <button type="button" aria-label="缩小时间轴" title="缩小时间轴" disabled={props.recording || !!ghost} onClick={() => zoom(pxPerSecond / 1.4)}>−</button>
          <input type="range" aria-label="时间轴缩放" min={Math.log(Math.min(1, pxPerSecond))} max={Math.log(Math.max(800, pxPerSecond))} step={.01} value={Math.log(pxPerSecond)} disabled={props.recording || !!ghost} onChange={event => zoom(Math.exp(Number(event.currentTarget.value)))}/>
          <button type="button" aria-label="放大时间轴" title="放大时间轴" disabled={props.recording || !!ghost} onClick={() => zoom(pxPerSecond * 1.4)}>＋</button>
          <button type="button" disabled={props.recording || !!ghost} onClick={fitAll}>适应全长</button>
        </div>
      </div>
    </div>
    <div ref={viewport} className="trk-gm-tl-scroll" aria-label="多轨时间轴" tabIndex={0}>
      <div className="trk-gm-tl-content" style={{gridTemplateColumns: `${gutter}px ${plotWidth}px`, width: gutter + plotWidth + 18, minHeight: 30 + visibleRows * 40}}>
        <div className="trk-gm-tl-label trk-gm-tl-ruler-label"><span>图层</span><small>{layers.length + keyLanes.length} 条轨道</small></div>
        <div ref={plot} className="trk-gm-tl-ruler" aria-label="时间刻度" onPointerDown={event => begin(event, 'seek')} {...pointerHandlers}>
          {ticks.map(tick => <div key={`${tick.time}:${tick.major}`} className={`trk-gm-tl-tick${tick.major ? ' is-major' : ''}${tick.time >= duration - .000001 ? ' is-endpoint' : ''}`} style={{left: tick.time * pxPerSecond}} aria-hidden="true">{tick.major && (tick.time === 0 || tick.time >= duration - .000001 || (duration - tick.time) * pxPerSecond >= 60) && <span>{tick.label}</span>}</div>)}
          <div className="trk-gm-tl-head-cap" style={{left: props.time * pxPerSecond}} aria-hidden="true"/>
        </div>
        {keyLanes.map(lane => <Fragment key={lane.id}>
          <div className={`trk-gm-tl-label${lane.id === 'camera' ? ' is-camera' : ''}`}><button type="button" onClick={() => props.onSelectLane ? props.onSelectLane(lane.id) : props.onSelectLayer(lane.id)} aria-pressed={props.keyLanes ? selectedLane === lane.id : props.selectedLayerId === lane.id}><span>{lane.name}</span><small>{lane.keys.length} 个关键帧</small></button></div>
          <div className={`trk-gm-key-track trk-gm-tl-row${lane.id === 'camera' ? ' is-camera' : ''}`} data-key-lane={lane.id} onPointerDown={event => begin(event, 'seek')} {...pointerHandlers}>
            {lane.keys.map(key => {
              const preview = ghost?.mode === 'key' && ghost.id === key.id && ghost.laneId === lane.id ? ghost : null, time = preview?.time ?? key.t
              return <button key={key.id} type="button" className={`trk-gm-key${time <= 0 ? ' is-first' : time >= duration ? ' is-last' : ''}${preview ? ' is-dragging' : ''}${preview?.collision ? ' is-collision' : ''}`} aria-label={`${lane.name}关键帧 ${rounded(time)} 秒`} aria-pressed={props.selectedKeyId === key.id && (!props.keyLanes || selectedLane === lane.id)} title={`${rounded(time)} 秒 · 选中后方向键移动一帧`} disabled={props.editDisabled || props.disabled} style={{left: time * pxPerSecond}} onPointerDown={event => begin(event, 'key', key.id, key.t, undefined, lane.id)} {...pointerHandlers} onClick={event => {if (!event.detail && !props.editDisabled) selectKey(key.id, key.t, lane.id)}} onKeyDown={event => keyKeyboard(event, key, lane.id)}><span aria-hidden="true"/></button>
            })}
          </div>
        </Fragment>)}
        {layers.map(layer => {
          const range = ghost?.id === layer.id && ghost.range ? ghost.range : layer, frozen = readonlyLayer(layer)
          const name = layer.name.trim() ? layer.name : `未命名${layerKind(layer.type)}`
          const color = layer.type === 'route' ? 'route' : layer.type === 'marker' ? 'marker' : layer.type === 'text' ? 'text' : 'other'
          const width = Math.max(3, (range.out - range.in) * pxPerSecond)
          return <Fragment key={layer.id}>
            <div className={`trk-gm-tl-label${props.selectedLayerId === layer.id ? ' is-selected' : ''}${!layer.visible ? ' is-hidden' : ''}`}>
              <label className="trk-gm-tl-eye" title={layer.visibilityLocked ? '此轨道不支持单独隐藏' : layer.visible ? '隐藏此图层' : '显示此图层'}><input type="checkbox" aria-label={`显示图层：${name}`} checked={layer.visible} disabled={frozen || layer.visibilityLocked} onChange={() => {if (!layer.visibilityLocked) props.onToggleLayer(layer.id)}}/></label>
              <button type="button" className="trk-gm-tl-layer-name" aria-label={`选择图层：${name}`} aria-pressed={props.selectedLayerId === layer.id} onClick={() => props.onSelectLayer(layer.id)} title={`${name} · ${layerKind(layer.type)}${layer.locked ? ' · 已锁定' : ''}`}><span className={`trk-gm-tl-color is-${color}`} aria-hidden="true"/><span className="trk-gm-tl-name-text">{name}</span>{layer.locked && <small>锁定</small>}</button>
            </div>
            <div className={`trk-gm-tl-row${props.selectedLayerId === layer.id ? ' is-selected' : ''}`} onPointerDown={event => begin(event, 'seek')} {...pointerHandlers}>
              <div className={`trk-gm-tl-clip is-${color}${!layer.visible ? ' is-hidden' : ''}${ghost?.range && ghost.id === layer.id ? ' is-dragging' : ''}${frozen ? ' is-locked' : ''}${width < 24 ? ' is-short' : ''}`} style={{left: range.in * pxPerSecond, width}} title={`${name} · ${rounded(range.in)} – ${rounded(range.out)} 秒`}>
                <button type="button" className="trk-gm-tl-clip-body" aria-label={`移动片段：${name}`} disabled={frozen} onPointerDown={event => begin(event, 'move', layer.id, layer.in, {in: layer.in, out: layer.out})} {...pointerHandlers} onClick={event => {if (!event.detail) props.onSelectLayer(layer.id)}} onKeyDown={event => layerKeyboard(event, layer, 'move')}><span>{name}</span></button>
                <button type="button" className="trk-gm-tl-trim is-start" aria-label={`调整入点：${name}`} title={`入点 ${rounded(range.in)} 秒`} disabled={frozen} onPointerDown={event => begin(event, 'start', layer.id, layer.in, {in: layer.in, out: layer.out})} {...pointerHandlers} onKeyDown={event => layerKeyboard(event, layer, 'start')}><span aria-hidden="true"/></button>
                <button type="button" className="trk-gm-tl-trim is-end" aria-label={`调整出点：${name}`} title={`出点 ${rounded(range.out)} 秒`} disabled={frozen} onPointerDown={event => begin(event, 'end', layer.id, layer.out, {in: layer.in, out: layer.out})} {...pointerHandlers} onKeyDown={event => layerKeyboard(event, layer, 'end')}><span aria-hidden="true"/></button>
              </div>
            </div>
          </Fragment>
        })}
        {ticks.filter(tick => tick.major).map(tick => <div key={`grid:${tick.time}`} className="trk-gm-tl-gridline" style={{left: gutter + tick.time * pxPerSecond}} aria-hidden="true"/>)}
        <div className="trk-gm-tl-playhead" style={{left: gutter + props.time * pxPerSecond}} aria-hidden="true"/>
      </div>
    </div>
    <div className="trk-gm-tl-status"><span role="status" aria-live="polite">{notice || (ghost?.collision ? '该时刻已有其他关键帧，松开会取消移动' : '拖动片段移动，拖动两端裁剪；方向键移动一帧，Shift 移动十帧。')}</span><span>{validFps(props.fps)} 帧 / 秒</span></div>
  </section>
}
