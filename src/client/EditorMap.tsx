/** MapLibre editing surface; draft tuples stay in the React editor until a gesture finishes. */
import { useEffect, useRef, useState } from 'react'
import { AttributionControl, Map as MapLibreMap, NavigationControl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import { BLANK_STYLE, styleFor, type BasemapId } from '../track/basemaps.ts'
import type { EditPart } from '../track/edit.ts'
import type { TrackPoint } from '../protocol.ts'
import { TRACK_COLOR } from '../track/trail-layer.ts'
import { BasemapControls, MapCredits, useMapSettings } from './map-settings.tsx'
import { MAP_STYLE } from './maplibre-css.ts'

export type EditorTool = 'select' | 'draw' | 'freehand' | 'insert' | 'split' | 'connect'
export interface EditorMapProps {
  parts: readonly EditPart[]
  activePartId: string
  selectedIndices: readonly number[]
  tool: EditorTool
  basemap: BasemapId
  onBasemap: (value: BasemapId) => void
  onSelectPoint: (index: number) => void
  onMovePoint: (index: number, lon: number, lat: number) => void
  onAddPoint: (lon: number, lat: number) => void
  onInsertPoint: (index: number, lon: number, lat: number) => void
  onFreehand: (points: readonly [number, number][]) => void
  disabled?: boolean
  readOnly?: boolean
}
const LINES = 'cqai-track-edit-lines'
const HANDLES = 'cqai-track-edit-handles'
const PREVIEW = 'cqai-track-edit-preview'

export function EditorMap(props: EditorMapProps) {
  const {settings} = useMapSettings()
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const cancelGesture = useRef<() => void>(() => {})
  const latest = useRef(props)
  latest.current = props
  const [noWebGL, setNoWebGL] = useState(false)
  const [broken, setBroken] = useState(false)
  const active = props.parts.find(part => part.id === props.activePartId)

  useEffect(() => {
    const container = holder.current
    if (!container) return
    if (!document.querySelector('style[data-plugin="cqai-dsh-plugin-track"]')) {
      const css = document.createElement('style')
      css.dataset.plugin = 'cqai-dsh-plugin-track'
      css.textContent = MAP_STYLE
      document.head.appendChild(css)
    }
    let created: MapLibreMap
    try {
      created = new MapLibreMap({container, style: BLANK_STYLE, attributionControl: false, dragRotate: false})
    } catch { setNoWebGL(true); return }
    map.current = created
    created.touchZoomRotate.disableRotation()
    created.addControl(new NavigationControl({showCompass: false}), 'top-right')
    created.addControl(new AttributionControl({compact: true}))
    let gesture: {originPartId: string; originPoints: readonly TrackPoint[]; originTool: EditorTool; originReadOnly: boolean; index: number | null; start: [number, number]; last: [number, number]; pixels: [number, number]; points: [number, number][]; moved: boolean} | null = null
    let suppressedClick: {until: number; x: number; y: number} | null = null
    const paint = () => {
      if (!created.getStyle()?.layers) return
      ensureLayers(created)
      const current = latest.current
      const lines: GeoJSON.Feature<GeoJSON.LineString>[] = current.parts.filter(part => part.points.length >= 2).map(part => ({
        type: 'Feature', properties: {active: part.id === current.activePartId},
        geometry: {type: 'LineString', coordinates: part.points.map(point => [point[0], point[1]])},
      }))
      source(created, LINES)?.setData({type: 'FeatureCollection', features: lines})
      paintHandles(created, current)
    }
    const endGesture = (commit: boolean) => {
      const previous = gesture
      gesture = null
      created.dragPan.enable()
      created.getCanvas().style.cursor = latest.current.tool === 'select' ? '' : 'crosshair'
      source(created, PREVIEW)?.setData({type: 'FeatureCollection', features: []})
      if (!previous) return
      const pixel = created.project(previous.last)
      suppressedClick = previous.moved || previous.index === null ? {until: performance.now() + 200, x: pixel.x, y: pixel.y} : null
      const current = latest.current
      const currentPoints = current.parts.find(part => part.id === current.activePartId)?.points
      if (!commit || current.disabled || current.readOnly
        || previous.originPartId !== current.activePartId || previous.originPoints !== currentPoints
        || previous.originTool !== current.tool || previous.originReadOnly !== Boolean(current.readOnly)) return
      if (previous.index !== null) {
        latest.current.onSelectPoint(previous.index)
        if (previous.moved) latest.current.onMovePoint(previous.index, previous.last[0], previous.last[1])
      } else if (previous.points.length >= 2) latest.current.onFreehand(previous.points)
    }
    const updateGesture = (event: MouseEvent) => {
      if (!gesture) return
      const rect = created.getCanvas().getBoundingClientRect()
      const pixel: [number, number] = [event.clientX - rect.left, event.clientY - rect.top]
      if (Math.hypot(pixel[0] - gesture.pixels[0], pixel[1] - gesture.pixels[1]) < 4) return
      const coordinate = created.unproject(pixel)
      if (!validCoordinate(coordinate.lng, coordinate.lat)) return
      gesture.last = [coordinate.lng, coordinate.lat]
      gesture.moved = true
      if (gesture.index === null) {
        gesture.pixels = pixel
        if (gesture.points.length < 10000) gesture.points.push(gesture.last)
        source(created, PREVIEW)?.setData({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: gesture.points}})
      } else {
        source(created, PREVIEW)?.setData({type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: gesture.last}})
      }
    }
    const cancel = () => endGesture(false)
    cancelGesture.current = cancel
    const mouseUp = () => endGesture(true)
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') endGesture(false) }
    const down = (event: MapMouseEvent) => {
      const current = latest.current
      if (current.disabled || current.readOnly || event.originalEvent.button !== 0) return
      const origin = current.parts.find(part => part.id === current.activePartId)
      if (!origin) return
      const identity = {originPartId: origin.id, originPoints: origin.points, originTool: current.tool, originReadOnly: Boolean(current.readOnly)}
      if (current.tool === 'freehand') {
        event.preventDefault()
        created.dragPan.disable()
        const start: [number, number] = [event.lngLat.lng, event.lngLat.lat]
        gesture = {...identity, index: null, start, last: start, pixels: [event.point.x, event.point.y], points: [start], moved: false}
        return
      }
      if (current.tool !== 'select' || current.readOnly) return
      const hit = created.getLayer(HANDLES) ? created.queryRenderedFeatures(event.point, {layers: [HANDLES]})[0] : undefined
      const index = hit ? Number(hit.properties?.index) : NaN
      if (!Number.isInteger(index)) return
      event.preventDefault()
      created.dragPan.disable()
      const point = current.parts.find(part => part.id === current.activePartId)?.points[index]
      if (!point) { created.dragPan.enable(); return }
      const start: [number, number] = [point[0], point[1]]
      gesture = {...identity, index, start, last: start, pixels: [event.point.x, event.point.y], points: [], moved: false}
      created.getCanvas().style.cursor = 'grabbing'
    }
    const click = (event: MapMouseEvent) => {
      const suppressed = suppressedClick
      suppressedClick = null
      if (suppressed && performance.now() <= suppressed.until && Math.hypot(event.point.x - suppressed.x, event.point.y - suppressed.y) < 5) return
      const current = latest.current
      if (current.disabled || current.tool === 'freehand') return
      const points = current.parts.find(part => part.id === current.activePartId)?.points ?? []
      if (!validCoordinate(event.lngLat.lng, event.lngLat.lat)) return
      if (current.tool === 'draw') { current.onAddPoint(event.lngLat.lng, event.lngLat.lat); return }
      if (current.tool === 'insert') {
        const segment = nearestSegment(created, points, event.point.x, event.point.y)
        if (segment !== null) current.onInsertPoint(segment + 1, event.lngLat.lng, event.lngLat.lat)
        return
      }
      const index = nearestPoint(created, points, event.point.x, event.point.y)
      if (index !== null) current.onSelectPoint(index)
    }
    const moveEnd = () => paintHandles(created, latest.current)
    const error = () => {
      if (latest.current.basemap === 'none') return
      setBroken(true)
      if (!created.getStyle()?.sources || Object.keys(created.getStyle().sources).every(id => id.startsWith('cqai-track-edit-'))) return
      try { created.setStyle(BLANK_STYLE) } catch { /* retain draft and numeric point editor */ }
    }
    created.on('styledata', () => { if (!created.getLayer(LINES)) paint() })
    created.on('moveend', moveEnd)
    created.on('mousedown', down)
    created.on('click', click)
    created.on('error', error)
    document.addEventListener('mousemove', updateGesture)
    document.addEventListener('mouseup', mouseUp)
    document.addEventListener('keydown', keyDown)
    window.addEventListener('blur', cancel)
    const points = latest.current.parts.flatMap(part => part.points)
    if (points.length) {
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
      for (const point of points) {west = Math.min(west, point[0]); east = Math.max(east, point[0]); south = Math.min(south, point[1]); north = Math.max(north, point[1])}
      if ([west, south, east, north].every(Number.isFinite)) created.fitBounds([[west, south], [east, north]], {padding: 50, duration: 0, maxZoom: 17})
    } else created.jumpTo({center: [119.44, 30.33], zoom: 12})
    return () => {
      endGesture(false)
      cancelGesture.current = () => {}
      window.removeEventListener('blur', cancel)
      document.removeEventListener('mousemove', updateGesture)
      document.removeEventListener('mouseup', mouseUp)
      document.removeEventListener('keydown', keyDown)
      created.remove()
      map.current = null
    }
  }, [])

  // A gesture belongs to one immutable points array and one tool. Prop changes
  // can arrive while the pointer is held (undo, part selection, async loading).
  useEffect(() => {cancelGesture.current()}, [props.activePartId, active?.points, props.tool, props.disabled, props.readOnly])
  useEffect(() => {
    const created = map.current
    if (!created) return
    setBroken(false)
    created.setStyle(styleFor(props.basemap, settings))
  }, [props.basemap, settings.maptilerKey])
  useEffect(() => {
    const created = map.current
    if (!created || !created.getStyle()?.layers) return
    ensureLayers(created)
    source(created, LINES)?.setData({type: 'FeatureCollection', features: props.parts.filter(part => part.points.length >= 2).map(part => ({
      type: 'Feature', properties: {active: part.id === props.activePartId}, geometry: {type: 'LineString', coordinates: part.points.map(point => [point[0], point[1]])},
    }))})
    paintHandles(created, props)
    created.getCanvas().style.cursor = props.tool === 'select' ? '' : 'crosshair'
  }, [props.parts, props.activePartId, props.selectedIndices, props.tool])

  return <div className="trk-edit-map" style={{position: 'relative', height: 'clamp(360px,55vh,640px)', borderRadius: 'var(--trk-radius-md)', overflow: 'hidden', background: 'var(--trk-map-background)'}}>
    <div ref={holder} style={{position: 'absolute', inset: 0}} />
    <div role="group" aria-label="编辑底图" style={{position: 'absolute', top: 10, left: 10, right: 50, display: 'flex', flexWrap: 'wrap', gap: 6, pointerEvents: 'none'}}>
      <BasemapControls basemap={props.basemap} onBasemap={value => {if (value === props.basemap) {setBroken(false); map.current?.setStyle(styleFor(value, settings))} props.onBasemap(value)}} disabled={props.disabled} className="trk-edit-basemap-controls" />
    </div>
    {!noWebGL && !broken && <MapCredits basemap={props.basemap} />}
    {(broken || noWebGL) && <div role="status" className="trk-note">{noWebGL ? '图形地图不可用，仍可用点序号与坐标表单编辑轨迹。' : '底图暂不可用，轨迹编辑仍可使用。'}</div>}
    {!noWebGL && active?.points.length === 0 && <div style={{position: 'absolute', bottom: 16, left: 12, right: 12, background: 'var(--trk-overlay)', color: 'var(--trk-overlay-text)', padding: 10, borderRadius: 'var(--trk-radius-sm)', pointerEvents: 'none'}}>选择「连点绘制」后点击地图，或选择「手绘补线」按住鼠标画线。</div>}
  </div>
}

function source(map: MapLibreMap, id: string): GeoJSONSource | undefined { return map.getSource(id) as GeoJSONSource | undefined }
function ensureLayers(map: MapLibreMap) {
  if ((map.style as { _loaded?: boolean } | undefined)?._loaded === false) return
  if (!map.getSource(LINES)) map.addSource(LINES, {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  if (!map.getLayer(LINES)) map.addLayer({id: LINES, type: 'line', source: LINES, layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': ['case', ['get', 'active'], TRACK_COLOR, '#808090'], 'line-width': ['case', ['get', 'active'], 4, 2]}})
  for (const id of [HANDLES, PREVIEW]) if (!map.getSource(id)) map.addSource(id, {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  if (!map.getLayer(HANDLES)) map.addLayer({id: HANDLES, type: 'circle', source: HANDLES, paint: {'circle-radius': ['case', ['get', 'selected'], 7, 4], 'circle-color': ['case', ['get', 'selected'], '#ffd166', TRACK_COLOR], 'circle-stroke-color': '#151517', 'circle-stroke-width': 2}})
  if (!map.getLayer(PREVIEW + '-line')) map.addLayer({id: PREVIEW + '-line', type: 'line', source: PREVIEW, filter: ['==', ['geometry-type'], 'LineString'], paint: {'line-color': '#ffd166', 'line-width': 4}})
  if (!map.getLayer(PREVIEW + '-point')) map.addLayer({id: PREVIEW + '-point', type: 'circle', source: PREVIEW, filter: ['==', ['geometry-type'], 'Point'], paint: {'circle-color': '#ffd166', 'circle-radius': 7}})
}
function paintHandles(map: MapLibreMap, props: EditorMapProps) {
  const points = props.parts.find(part => part.id === props.activePartId)?.points ?? []
  const selected = new Set(props.selectedIndices)
  const bounds = map.getBounds()
  const visible: number[] = []
  for (let index = 0; index < points.length; index += 1) if (bounds.contains([points[index][0], points[index][1]])) visible.push(index)
  const stride = Math.max(1, Math.ceil(visible.length / 500))
  const indices = new Set(visible.filter((_index, offset) => offset % stride === 0))
  for (const index of selected) if (points[index]) indices.add(index)
  if (points.length) {indices.add(0); indices.add(points.length - 1)}
  source(map, HANDLES)?.setData({type: 'FeatureCollection', features: [...indices].map(index => ({type: 'Feature', properties: {index, selected: selected.has(index)}, geometry: {type: 'Point', coordinates: [points[index][0], points[index][1]]}}))})
}
function nearestPoint(map: MapLibreMap, points: readonly TrackPoint[], x: number, y: number): number | null {
  let distance = 18, found: number | null = null
  for (let index = 0; index < points.length; index += 1) {const pixel = map.project([points[index][0], points[index][1]]); const next = Math.hypot(pixel.x - x, pixel.y - y); if (next <= distance) {distance = next; found = index}}
  return found
}
function nearestSegment(map: MapLibreMap, points: readonly TrackPoint[], x: number, y: number): number | null {
  let distance = 24, found: number | null = null
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = map.project([points[index][0], points[index][1]]), b = map.project([points[index + 1][0], points[index + 1][1]])
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const next = Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
    if (next <= distance) {distance = next; found = index}
  }
  return found
}
function validCoordinate(lon: number, lat: number) { return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -85.051129 && lat <= 85.051129 }
