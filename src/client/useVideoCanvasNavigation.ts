import {useCallback, useEffect, useMemo, useRef, useState, type FocusEventHandler, type KeyboardEventHandler, type MouseEventHandler, type PointerEventHandler, type RefObject} from 'react'

export type VideoCanvasMode = 'select' | 'pan' | 'add' | 'point'
export interface VideoCanvasView {zoom: number; x: number; y: number}
export interface VideoCanvasNavigationOptions {
  viewport: RefObject<HTMLDivElement>
  mode: VideoCanvasMode
  disabled: boolean
  canNavigate: () => boolean
}
export interface VideoCanvasNavigationHandlers {
  onPointerDownCapture: PointerEventHandler<HTMLDivElement>
  onPointerMove: PointerEventHandler<HTMLDivElement>
  onPointerUp: PointerEventHandler<HTMLDivElement>
  onPointerCancel: PointerEventHandler<HTMLDivElement>
  onLostPointerCapture: PointerEventHandler<HTMLDivElement>
  onClickCapture: MouseEventHandler<HTMLDivElement>
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
  onKeyUp: KeyboardEventHandler<HTMLDivElement>
  onBlur: FocusEventHandler<HTMLDivElement>
}
type Point = {clientX: number; clientY: number}
type PanGesture = {kind: 'pan'; pointerId: number; start: Point; view: VideoCanvasView; moved: boolean}
type PinchGesture = {kind: 'pinch'; ids: [number, number]; midpoint: Point; distance: number; view: VideoCanvasView; moved: boolean}
type Gesture = PanGesture | PinchGesture
const initialView = (): VideoCanvasView => ({zoom: 100, x: 0, y: 0})
const clampZoom = (value: number) => Math.max(50, Math.min(800, value))
const isEditing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]')
const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,button,a,[role="button"],[contenteditable="true"],[contenteditable=""],text,circle,.trk-vm-route-hit')
const midpoint = (a: Point, b: Point): Point => ({clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2})
const distance = (a: Point, b: Point) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)

/** Navigation changes only the canvas view; it never writes geographic or material data. */
export function useVideoCanvasNavigation(options: VideoCanvasNavigationOptions) {
  const [view, setView] = useState<VideoCanvasView>(initialView)
  const [panning, setPanning] = useState(false)
  const latestOptions = useRef(options); latestOptions.current = options
  const currentView = useRef(view), active = useRef<Gesture | null>(null), alive = useRef(true)
  const spaceHeld = useRef(false), pointers = useRef(new Map<number, Point>()), captured = useRef(new Set<number>())
  const pendingTouches = useRef(new Map<number, {start: Point; dragged: boolean}>())
  const suppressClick = useRef(false), suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentPanning = useRef(false)
  const permitted = useCallback(() => {
    if (latestOptions.current.disabled || !alive.current) return false
    try {return latestOptions.current.canNavigate()} catch {return false}
  }, [])
  const publish = useCallback((next: VideoCanvasView) => {
    if (!alive.current || ![next.zoom, next.x, next.y].every(Number.isFinite)) return
    const previous = currentView.current
    if (previous.zoom === next.zoom && previous.x === next.x && previous.y === next.y) return
    currentView.current = next; setView(next)
  }, [])
  const markPanning = useCallback((next: boolean) => {
    if (currentPanning.current === next) return
    currentPanning.current = next; if (alive.current) setPanning(next)
  }, [])
  const blockClick = useCallback((hold = false) => {
    suppressClick.current = true
    if (suppressTimer.current !== null) clearTimeout(suppressTimer.current)
    suppressTimer.current = hold ? null : setTimeout(() => {suppressClick.current = false; suppressTimer.current = null}, 250)
  }, [])
  const release = useCallback((id: number) => {
    captured.current.delete(id)
    const element = latestOptions.current.viewport.current
    try {if (element?.hasPointerCapture?.(id)) element.releasePointerCapture(id)} catch { /* A cancelled pointer may already have lost capture. */ }
  }, [])
  const stop = useCallback((suppress = false) => {
    const previous = active.current
    active.current = null; pointers.current.clear(); pendingTouches.current.clear(); spaceHeld.current = false; markPanning(false)
    const ids = [...captured.current]; captured.current.clear(); ids.forEach(release)
    if (suppress && (previous?.moved || suppressClick.current)) blockClick()
    else if (!suppress) {
      suppressClick.current = false
      if (suppressTimer.current !== null) clearTimeout(suppressTimer.current)
      suppressTimer.current = null
    }
  }, [blockClick, markPanning, release])
  const capture = useCallback((id: number) => {
    const element = latestOptions.current.viewport.current
    if (!element) return
    try {element.setPointerCapture?.(id); captured.current.add(id)} catch { /* Detached pointers are cancelled by the regular release path. */ }
  }, [])
  const center = useCallback(() => {
    const element = latestOptions.current.viewport.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2}
  }, [])
  const zoomAt = useCallback((zoom: number, point?: Point) => {
    if (!Number.isFinite(zoom) || !permitted()) return
    const previous = currentView.current, nextZoom = clampZoom(zoom), origin = center()
    if (!origin || nextZoom === previous.zoom) return
    const anchor = point || origin, x = anchor.clientX - origin.clientX, y = anchor.clientY - origin.clientY, ratio = nextZoom / previous.zoom
    publish({zoom: nextZoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio})
  }, [center, permitted, publish])
  const panBy = useCallback((x: number, y: number) => {
    if (!permitted() || !Number.isFinite(x) || !Number.isFinite(y)) return
    const previous = currentView.current; publish({...previous, x: previous.x + x, y: previous.y + y})
  }, [permitted, publish])
  const reset = useCallback(() => {
    if (!permitted()) return
    stop(true); publish(initialView())
  }, [permitted, publish, stop])

  const onPointerDownCapture: PointerEventHandler<HTMLDivElement> = useCallback(event => {
    if (!permitted() || isEditing(event.target)) return
    // A fresh gesture must not inherit a preceding drag's short-lived click guard.
    if (!active.current && !pointers.current.size && suppressTimer.current !== null) {
      clearTimeout(suppressTimer.current); suppressTimer.current = null; suppressClick.current = false
    }
    const point = {clientX: event.clientX, clientY: event.clientY}, touch = event.pointerType === 'touch'
    if (touch) {
      pointers.current.set(event.pointerId, point); pendingTouches.current.set(event.pointerId, {start: point, dragged: false})
      if (pointers.current.size >= 2) {
        if (active.current?.kind === 'pinch') {event.preventDefault(); event.stopPropagation(); return}
        const entries = [...pointers.current.entries()].slice(0, 2), [idA, pointA] = entries[0], [idB, pointB] = entries[1]
        const previous = active.current
        active.current = {kind: 'pinch', ids: [idA, idB], midpoint: midpoint(pointA, pointB), distance: Math.max(1, distance(pointA, pointB)), view: {...currentView.current}, moved: previous?.moved || false}
        blockClick(true); capture(idA); capture(idB); markPanning(true)
        event.preventDefault(); event.stopPropagation(); return
      }
    }
    if (active.current || event.button === 2) return
    const {mode} = latestOptions.current
    const forced = mode === 'pan' || event.button === 1 || spaceHeld.current
    const allowed = forced || mode === 'select' && event.button === 0 && !isControl(event.target)
    if (!allowed || (event.button !== 0 && event.button !== 1)) return
    active.current = {kind: 'pan', pointerId: event.pointerId, start: point, view: {...currentView.current}, moved: false}
    capture(event.pointerId); markPanning(true)
    latestOptions.current.viewport.current?.focus({preventScroll: true})
    event.preventDefault(); event.stopPropagation()
  }, [blockClick, capture, markPanning, permitted])
  const onPointerMove: PointerEventHandler<HTMLDivElement> = useCallback(event => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, {clientX: event.clientX, clientY: event.clientY})
    const gesture = active.current
    if (!gesture) {
      const pending = pendingTouches.current.get(event.pointerId), {mode} = latestOptions.current
      if (!pending || (mode !== 'add' && mode !== 'point')) return
      if (!permitted()) {stop(true); return}
      if (pending.dragged || distance(pending.start, {clientX: event.clientX, clientY: event.clientY}) > 3) {
        pending.dragged = true; blockClick(true)
        event.preventDefault(); event.stopPropagation()
      }
      return
    }
    if (!permitted()) {stop(true); return}
    if (gesture.kind === 'pan') {
      if (gesture.pointerId !== event.pointerId) return
      const dx = event.clientX - gesture.start.clientX, dy = event.clientY - gesture.start.clientY
      if (!gesture.moved && Math.hypot(dx, dy) <= 3) return
      gesture.moved = true; blockClick(true); publish({...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy})
    } else {
      if (!gesture.ids.includes(event.pointerId)) return
      const a = pointers.current.get(gesture.ids[0]), b = pointers.current.get(gesture.ids[1]), origin = center()
      if (!a || !b || !origin) return
      const nextMidpoint = midpoint(a, b), nextDistance = distance(a, b), nextZoom = clampZoom(gesture.view.zoom * nextDistance / gesture.distance)
      if (Math.abs(nextDistance - gesture.distance) > 3 || distance(nextMidpoint, gesture.midpoint) > 3) gesture.moved = true
      const ratio = nextZoom / gesture.view.zoom, anchorX = gesture.midpoint.clientX - origin.clientX, anchorY = gesture.midpoint.clientY - origin.clientY
      publish({zoom: nextZoom, x: nextMidpoint.clientX - origin.clientX - (anchorX - gesture.view.x) * ratio, y: nextMidpoint.clientY - origin.clientY - (anchorY - gesture.view.y) * ratio})
      blockClick(true)
    }
    event.preventDefault(); event.stopPropagation()
  }, [blockClick, center, permitted, publish, stop])
  const onPointerUp: PointerEventHandler<HTMLDivElement> = useCallback(event => {
    const gesture = active.current, wasTouch = pointers.current.delete(event.pointerId)
    const pending = pendingTouches.current.get(event.pointerId), {mode} = latestOptions.current
    pendingTouches.current.delete(event.pointerId)
    if (!gesture && pending && (mode === 'add' || mode === 'point') && (pending.dragged || distance(pending.start, {clientX: event.clientX, clientY: event.clientY}) > 3)) blockClick(pointers.current.size > 0)
    if (!gesture) {release(event.pointerId); if (wasTouch && !pointers.current.size && suppressClick.current) blockClick(); return}
    if (gesture.kind === 'pan' && gesture.pointerId !== event.pointerId || gesture.kind === 'pinch' && !gesture.ids.includes(event.pointerId)) return
    active.current = null; markPanning(false); release(event.pointerId)
    if (gesture.kind === 'pinch') {
      // Keep the remaining finger captured until release so a pinch cannot turn into an add-point tap.
      blockClick(pointers.current.size > 0)
    } else if (gesture.moved) blockClick()
    else if (wasTouch && !pointers.current.size && suppressClick.current) blockClick()
    event.stopPropagation()
  }, [blockClick, markPanning, release])
  const onPointerCancel: PointerEventHandler<HTMLDivElement> = useCallback(event => {
    const gesture = active.current
    if (!gesture) {pointers.current.delete(event.pointerId); pendingTouches.current.delete(event.pointerId); release(event.pointerId); if (!pointers.current.size && suppressClick.current) blockClick(); return}
    if (gesture.kind === 'pan' && gesture.pointerId !== event.pointerId || gesture.kind === 'pinch' && !gesture.ids.includes(event.pointerId)) return
    stop(true)
  }, [blockClick, release, stop])
  const onLostPointerCapture: PointerEventHandler<HTMLDivElement> = useCallback(event => {
    if (!captured.current.has(event.pointerId)) return
    captured.current.delete(event.pointerId)
    const gesture = active.current
    if (gesture && (gesture.kind === 'pan' ? gesture.pointerId === event.pointerId : gesture.ids.includes(event.pointerId))) stop(true)
    else {
      pointers.current.delete(event.pointerId); pendingTouches.current.delete(event.pointerId)
      if (!pointers.current.size && suppressClick.current) blockClick()
    }
  }, [blockClick, stop])
  const onClickCapture: MouseEventHandler<HTMLDivElement> = useCallback(event => {
    if (!suppressClick.current) return
    event.preventDefault(); event.stopPropagation(); if (pointers.current.size || active.current) return; suppressClick.current = false
    if (suppressTimer.current !== null) {clearTimeout(suppressTimer.current); suppressTimer.current = null}
  }, [])
  const onKeyDown: KeyboardEventHandler<HTMLDivElement> = useCallback(event => {
    if (event.key === 'Escape') {if (active.current || spaceHeld.current) {stop(true); event.preventDefault(); event.stopPropagation()} return}
    const element = latestOptions.current.viewport.current
    if (!element || globalThis.document.activeElement !== element || isEditing(event.target) || !permitted() || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.code === 'Space' || event.key === ' ') {spaceHeld.current = true; event.preventDefault(); event.stopPropagation(); return}
    const amount = event.shiftKey ? 120 : 40
    if (event.key === 'ArrowLeft') panBy(-amount, 0)
    else if (event.key === 'ArrowRight') panBy(amount, 0)
    else if (event.key === 'ArrowUp') panBy(0, -amount)
    else if (event.key === 'ArrowDown') panBy(0, amount)
    else if (event.key === '+' || event.key === '=') zoomAt(currentView.current.zoom * 1.2)
    else if (event.key === '-') zoomAt(currentView.current.zoom / 1.2)
    else if (event.key === '0') reset()
    else return
    event.preventDefault(); event.stopPropagation()
  }, [panBy, permitted, reset, stop, zoomAt])
  const onKeyUp: KeyboardEventHandler<HTMLDivElement> = useCallback(event => {
    if (event.code !== 'Space' && event.key !== ' ') return
    const held = spaceHeld.current; spaceHeld.current = false
    if (held && !isEditing(event.target)) {event.preventDefault(); event.stopPropagation()}
  }, [])
  const onBlur: FocusEventHandler<HTMLDivElement> = useCallback(event => {
    const element = latestOptions.current.viewport.current
    if (event.relatedTarget instanceof Node && element?.contains(event.relatedTarget)) return
    stop(true)
  }, [stop])
  useEffect(() => {
    alive.current = true
    const element = options.viewport.current
    if (!element) return () => {alive.current = false; stop()}
    const wheel = (event: WheelEvent) => {
      if (!permitted() || isEditing(event.target) || active.current || !event.deltaY) return
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, element.clientHeight) : 1)
      if (!Number.isFinite(pixels)) return
      event.preventDefault()
      zoomAt(currentView.current.zoom * Math.exp(-Math.max(-240, Math.min(240, pixels)) * .002), {clientX: event.clientX, clientY: event.clientY})
    }
    const cancel = () => stop(true)
    const clearPendingTouch = (event: PointerEvent) => {
      if (!active.current && !captured.current.has(event.pointerId)) {
        const existed = pointers.current.delete(event.pointerId); pendingTouches.current.delete(event.pointerId)
        if (existed && !pointers.current.size && suppressClick.current) blockClick()
      }
    }
    element.addEventListener('wheel', wheel, {passive: false}); window.addEventListener('blur', cancel)
    window.addEventListener('pointerup', clearPendingTouch); window.addEventListener('pointercancel', clearPendingTouch)
    return () => {
      alive.current = false; stop()
      if (suppressTimer.current !== null) clearTimeout(suppressTimer.current)
      suppressTimer.current = null; suppressClick.current = false
      element.removeEventListener('wheel', wheel); window.removeEventListener('blur', cancel)
      window.removeEventListener('pointerup', clearPendingTouch); window.removeEventListener('pointercancel', clearPendingTouch)
    }
  }, [options.viewport, permitted, stop, zoomAt, blockClick])
  useEffect(() => {stop(true)}, [options.mode, options.disabled, stop])
  const handlers = useMemo<VideoCanvasNavigationHandlers>(() => ({onPointerDownCapture, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onClickCapture, onKeyDown, onKeyUp, onBlur}), [onPointerDownCapture, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onClickCapture, onKeyDown, onKeyUp, onBlur])
  return {view, zoomAt, reset, panBy, panning, handlers}
}
