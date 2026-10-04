/** A separate animation map keeps playback out of the detail map's 2D/3D lifecycle. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AttributionControl, Map as MapLibreMap, NavigationControl, type GeoJSONSource } from 'maplibre-gl'
import { basemapCredits, BLANK_STYLE, MAPTILER_LOGO_URL, styleFor, type BasemapId } from '../track/basemaps.ts'
import { createPlaybackPath, samplePlayback, type PlaybackPath } from '../track/playback.ts'
import { FrameRenderCoordinator, frameAbortError, type AnimationFrameState, type AnimationShot, type TrackFrameRenderer } from '../track/frame-renderer.ts'
import type { TrackPoint } from '../protocol.ts'
import { TRACK_COLOR } from '../track/trail-layer.ts'
import { BasemapControls, MapCredits, useMapSettings } from './map-settings.tsx'
import { MAP_STYLE } from './maplibre-css.ts'

export type { AnimationShot } from '../track/frame-renderer.ts'
export interface AnimationMapProps {
  points: readonly TrackPoint[]
  name: string
  progress: number
  elapsedMs?: number
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
  onCanvas: (canvas: HTMLCanvasElement | null) => void
  onUnavailable: (message: string | null) => void
  onCaptureError?: (message: string | null) => void
  onCaptureFrame?: (progress: number) => void
  onFrameRenderer?: (renderer: TrackFrameRenderer | null) => void
  captureRequest?: number
  disabledBasemap?: boolean
  shot?: AnimationShot
  shotIndex?: number
}
const FULL = 'cqai-track-animation-full'
const WALKED = 'cqai-track-animation-walked'
const POSITION = 'cqai-track-animation-position'
const MAXIMUM_DISPLAY_POINTS = 5000
const MAXIMUM_LATITUDE = 85.051129
// Keep overview endpoints clear of the title, narration and wrapped credits in the video.
const OVERVIEW_PADDING = {top: 60, bottom: 110, left: 55, right: 55}

export function AnimationMap(props: AnimationMapProps) {
  const {settings} = useMapSettings()
  // A recording keeps its provider/key stable even if another view edits the shared settings.
  const savedConfig = useRef({settings, basemap: props.basemap})
  if (!props.disabledBasemap) savedConfig.current = {settings, basemap: props.basemap}
  const activeConfig = props.disabledBasemap ? savedConfig.current : {settings, basemap: props.basemap}
  const config = useRef(activeConfig)
  config.current = activeConfig
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const latest = useRef(props)
  latest.current = props
  const path = useMemo(() => createPlaybackPath(props.points), [props.points])
  const currentPath = useRef(path)
  currentPath.current = path
  const paint = useRef<(resetExplicit?: boolean) => void>(() => {})
  const composite = useRef<() => void>(() => {})
  const cancelPending = useRef<(reason?: unknown) => void>(() => {})
  const renderer = useRef<TrackFrameRenderer | null>(null)
  const failed = useRef(false)
  const [broken, setBroken] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const container = holder.current
    if (!container) return
    if (!document.querySelector('style[data-plugin="cqai-dsh-plugin-track"]')) {
      const style = document.createElement('style')
      style.dataset.plugin = 'cqai-dsh-plugin-track'
      style.textContent = MAP_STYLE
      document.head.appendChild(style)
    }
    let created: MapLibreMap
    try {
      created = new MapLibreMap({container, style: BLANK_STYLE, attributionControl: false, dragRotate: false,
        canvasContextAttributes: {preserveDrawingBuffer: true}, pixelRatio: Math.min(window.devicePixelRatio || 1, 2)})
    } catch {
      setUnavailable(true)
      latest.current.onUnavailable('这台设备没有可用的 WebGL，无法播放地图动画或导出视频。')
      return
    }
    map.current = created
    latest.current.onUnavailable(null)
    created.touchZoomRotate.disableRotation()
    created.addControl(new NavigationControl({showCompass: false}), 'top-right')
    created.addControl(new AttributionControl({compact: true}))
    const output = document.createElement('canvas')
    const pending = new FrameRenderCoordinator()
    let context: CanvasRenderingContext2D | null = null
    let captureFailed = false
    let announced = false
    let removed = false
    let updating = false
    let explicit: {frame: AnimationFrameState; revision: number} | null = null
    let applied: {frame: AnimationFrameState; revision: number; points: readonly TrackPoint[]} | null = null
    let lastShot: AnimationShot | undefined
    let lastShotIndex: number | undefined
    let logo: HTMLImageElement | null = null
    let logoState: 'loading' | 'ready' | 'failed' | null = null
    let logoTimer: ReturnType<typeof setTimeout> | null = null
    try { context = output.getContext('2d') } catch { /* playback can still work without a recorder canvas */ }
    const desiredFrame = (): AnimationFrameState => explicit?.frame ?? {
      progress: latest.current.progress, elapsedMs: latest.current.elapsedMs ?? 0,
      shot: latest.current.shot, shotIndex: latest.current.shotIndex,
    }
    const credits = () => basemapCredits(removed || failed.current ? 'none' : config.current.basemap)
    const hasLogo = () => !failed.current && config.current.basemap.startsWith('maptiler-')
    const prepareLogo = () => {
      if (!hasLogo()) return true
      if (logoState === 'ready') return true
      if (logoState === 'failed') return false
      if (!logo) {
        logo = new Image(); logoState = 'loading'; logo.crossOrigin = 'anonymous'
        logo.onload = () => {
          if (logoTimer !== null) clearTimeout(logoTimer)
          logoTimer = null
          if (!removed) {logoState = 'ready'; created.triggerRepaint()}
        }
        const logoError = () => {
          if (logoTimer !== null) clearTimeout(logoTimer)
          logoTimer = null
          if (removed) return
          logoState = 'failed'
          if (!hasLogo()) return
          pending.cancel(new Error('MapTiler logo could not be loaded for capture'))
          latest.current.onCaptureError?.('MapTiler 标志加载失败，暂不能录制；可重试底图或切换地图源。')
        }
        logo.onerror = logoError
        logoTimer = setTimeout(logoError, 10_000)
        logo.src = MAPTILER_LOGO_URL
      }
      return false
    }
    const sourcesReady = () => [FULL, WALKED, POSITION].every(id => {
      const current = source(created, id)
      return current && (typeof current.loaded !== 'function' || current.loaded())
        && (typeof created.isSourceLoaded !== 'function' || created.isSourceLoaded(id))
    })
    const capture = (fromRender = false) => {
      if (removed || updating || captureFailed || !applied) return
      if (!context) {
        captureFailed = true
        pending.cancel(new Error('A capture canvas is unavailable'))
        latest.current.onCaptureError?.('浏览器无法生成视频画面，仍可播放地图动画。')
        return
      }
      if (!prepareLogo()) return
      const wanted = desiredFrame()
      // React may publish a new progress before its effect updates the GeoJSON.
      // Only the data snapshot actually submitted to the map may acknowledge a frame.
      const matches = applied.points === currentPath.current.points && applied.frame.progress === wanted.progress
        && applied.frame.shot === wanted.shot && applied.frame.shotIndex === wanted.shotIndex
        && applied.revision === (explicit?.revision ?? 0)
      try {
        const mapCanvas = created.getCanvas()
        if (!mapCanvas.width || !mapCanvas.height) return
        if (output.width !== mapCanvas.width) output.width = mapCanvas.width
        if (output.height !== mapCanvas.height) output.height = mapCanvas.height
        context.drawImage(mapCanvas, 0, 0, output.width, output.height)
        burnLabels(context, output, latest.current.name, applied.frame.progress,
          failed.current ? 'none' : config.current.basemap, applied.frame.shot?.narration, hasLogo() ? logo : null)
        if (!announced) {
          announced = true
          latest.current.onCaptureError?.(null)
          latest.current.onCanvas(output)
        }
        if (!hasLogo()) latest.current.onCaptureError?.(null)
        if (fromRender && matches && sourcesReady()) {
          latest.current.onCaptureFrame?.(applied.frame.progress)
          // Future offline encoders also wait for visible map tiles, unlike real-time playback.
          if (typeof created.areTilesLoaded !== 'function' || created.areTilesLoaded()) pending.rendered(applied.revision)
        }
      } catch {
        captureFailed = true
        pending.cancel(new Error('The map canvas could not be captured'))
        latest.current.onCanvas(null)
        latest.current.onCaptureError?.('地图画面无法录制，可能是跨域或图形设备限制；仍可播放地图动画。')
      }
    }
    const update = () => {
      if (removed || updating || created.style?._loaded === false) return
      updating = true
      try {
        ensureLayers(created)
        const activePath = currentPath.current
        const frame = {...desiredFrame()}
        applied = {frame, revision: explicit?.revision ?? 0, points: activePath.points}
        const full = source(created, FULL)
        if (full && (full as GeoJSONSource & {animationPoints?: readonly TrackPoint[]}).animationPoints !== activePath.points) {
          full.setData(lineFeature(displayLine(activePath, activePath.points.length - 1)))
          ;(full as GeoJSONSource & {animationPoints?: readonly TrackPoint[]}).animationPoints = activePath.points
        }
        const sample = samplePlayback(activePath, frame.progress)
        source(created, WALKED)?.setData(lineFeature(displayLine(activePath, sample.index, sample.position)))
        source(created, POSITION)?.setData({type: 'FeatureCollection', features: sample.position ? [{
          type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: coordinate(sample.position)},
        }] : []})
        if (frame.shot && activePath.points.length) {
          const changedShot = lastShot !== frame.shot || lastShotIndex !== frame.shotIndex
          if (frame.shot.type === 'overview') {if (changedShot || explicit) fitPath(created, activePath)}
          else if ((frame.shot.type === 'checkpoint' && changedShot) || frame.shot.type === 'follow') {
            const index = Math.max(0, Math.min(activePath.points.length - 1, frame.shot.pointIndex ?? sample.index))
            const center = frame.shot.type === 'follow' ? sample.position : activePath.points[index]
            if (center) created.jumpTo({center: coordinate(center), ...(changedShot ? {zoom: frame.shot.type === 'checkpoint' ? 15 : 14} : {})})
          }
        }
        lastShot = frame.shot; lastShotIndex = frame.shotIndex
      } catch (reason) {pending.cancel(reason)}
      finally { updating = false }
    }
    const style = () => {if (!created.getLayer(POSITION)) update()}
    const rendered = () => capture(true)
    const error = (event: {sourceId?: string}) => {
      if (removed) return
      pending.cancel(new Error('A map resource failed while rendering the requested frame'))
      if (event?.sourceId && [FULL, WALKED, POSITION].includes(event.sourceId)) {
        applied = null; announced = false
        latest.current.onCanvas(null)
        latest.current.onCaptureError?.('轨迹画面更新失败，仍可播放；请切换底图后重试录制。')
        return
      }
      if (failed.current || config.current.basemap === 'none') return
      failed.current = true; applied = null
      setBroken(true)
      try { created.setStyle(BLANK_STYLE) } catch { /* retry remains available */ }
    }
    const canvas = created.getCanvas()
    const contextLost = (event: Event) => {
      event.preventDefault()
      if (removed) return
      removed = true
      pending.cancel(new Error('The map graphics context was lost'))
      canvas.removeEventListener('webglcontextlost', contextLost)
      latest.current.onCanvas(null)
      latest.current.onFrameRenderer?.(null)
      renderer.current = null
      latest.current.onUnavailable('地图图形上下文已丢失，动画已暂停。请退出后重新打开。')
      setUnavailable(true)
      created.remove(); map.current = null
    }
    canvas.addEventListener('webglcontextlost', contextLost)
    created.on('styledata', style); created.on('load', update); created.on('render', rendered); created.on('error', error)
    paint.current = (resetExplicit = false) => {
      if (resetExplicit && explicit) {pending.cancel(frameAbortError('Playback changed the requested frame')); explicit = null}
      update()
    }
    composite.current = () => capture()
    cancelPending.current = reason => {
      pending.cancel(reason); explicit = null; applied = null; announced = false
      latest.current.onCanvas(null)
      if (logoState === 'failed') {if (logo) {logo.onload = null; logo.onerror = null}; logo = null; logoState = null}
    }
    const adapter: TrackFrameRenderer = {
      getCaptureCanvas: () => !removed && !captureFailed && announced && (!hasLogo() || logoState === 'ready') ? output : null,
      getCredits: credits,
      renderFrame: (frame, signal) => {
        if (removed) return Promise.reject(frameAbortError('The map renderer was disposed'))
        if (signal?.aborted) return Promise.reject(frameAbortError())
        if (!Number.isFinite(frame.progress) || !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0) return Promise.reject(new RangeError('Invalid animation frame'))
        if (captureFailed || !context || hasLogo() && logoState === 'failed') return Promise.reject(new Error('A capture canvas is unavailable'))
        const request = pending.request(signal)
        explicit = {revision: request.revision, frame: {...frame, progress: Math.max(0, Math.min(1, frame.progress))}}
        // Force shot camera construction for independent, out-of-order frame requests.
        lastShot = undefined; lastShotIndex = undefined
        update(); created.triggerRepaint()
        return request.promise
      },
    }
    renderer.current = adapter
    latest.current.onFrameRenderer?.(adapter)
    return () => {
      pending.cancel(frameAbortError('The map renderer was disposed'))
      paint.current = () => {}; composite.current = () => {}; cancelPending.current = () => {}
      renderer.current = null
      latest.current.onFrameRenderer?.(null); latest.current.onCanvas(null)
      if (logoTimer !== null) clearTimeout(logoTimer)
      if (logo) {logo.onload = null; logo.onerror = null}
      canvas.removeEventListener('webglcontextlost', contextLost)
      created.off('styledata', style); created.off('load', update); created.off('render', rendered); created.off('error', error)
      if (!removed) {removed = true; created.remove()}
      map.current = null
    }
  }, [])

  useEffect(() => {
    const created = map.current
    if (!created) return
    cancelPending.current(frameAbortError('The basemap changed'))
    failed.current = false; setBroken(false)
    created.setStyle(styleFor(activeConfig.basemap, activeConfig.settings))
  }, [activeConfig.basemap, activeConfig.settings.maptilerKey, retry])
  useEffect(() => {
    const created = map.current
    if (!created) return
    fitPath(created, path)
    paint.current(true)
  }, [path])
  useEffect(() => {paint.current(true)}, [props.progress, props.shot, props.shotIndex])
  useEffect(() => {map.current?.triggerRepaint()}, [props.captureRequest])
  useEffect(() => {composite.current()}, [props.name])
  useEffect(() => {
    props.onFrameRenderer?.(renderer.current)
  }, [props.onFrameRenderer])

  return <div className="trk-animation-map trk-map-wrap">
    <div className="trk-map" ref={holder} aria-label="轨迹动画地图" />
    <div className="trk-animation-basemaps" role="group" aria-label="动画底图">
      <BasemapControls basemap={activeConfig.basemap} disabled={props.disabledBasemap || unavailable} onBasemap={next => {
        if (next === activeConfig.basemap) setRetry(value => value + 1)
        props.onBasemap(next)
      }} />
    </div>
    <MapCredits settings={activeConfig.settings} basemap={broken || unavailable ? 'none' : activeConfig.basemap} className="trk-animation-credits" />
    {broken && !unavailable && <div className="trk-animation-map-note" role="status">底图加载失败，已显示纯色轨迹，仍可播放和录制；点击底图按钮可重试。</div>}
    {unavailable && <div className="trk-animation-map-note" role="status">WebGL 不可用，无法显示动画地图。</div>}
  </div>
}
function coordinate(point: TrackPoint): [number, number] {
  return [point[0], Math.max(-MAXIMUM_LATITUDE, Math.min(MAXIMUM_LATITUDE, point[1]))]
}
function displayLine(path: PlaybackPath, end: number, position?: TrackPoint | null): [number, number][] {
  if (end < 0 || !path.points.length) return []
  const points: [number, number][] = []
  const stride = Math.max(1, Math.ceil(end / (MAXIMUM_DISPLAY_POINTS - 3)))
  for (let index = 0; index < end; index += stride) points.push(coordinate(path.points[index]))
  points.push(coordinate(path.points[end]))
  if (position && (position[0] !== path.points[end][0] || position[1] !== path.points[end][1])) points.push(coordinate(position))
  if (points.length === 1) points.push([...points[0]])
  return points
}
function fitPath(map: MapLibreMap, path: PlaybackPath): void {
  if (!path.points.length) return
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const point of path.points) {
    const [lon, lat] = coordinate(point)
    west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat)
  }
  map.fitBounds([[west, south], [east, north]], {padding: OVERVIEW_PADDING, duration: 0, maxZoom: 16})
}
function lineFeature(coordinates: [number, number][]): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {type: 'FeatureCollection', features: coordinates.length >= 2 ? [{type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates}}] : []}
}
function source(map: MapLibreMap, id: string): GeoJSONSource | undefined { return map.getSource(id) as GeoJSONSource | undefined }
function ensureLayers(map: MapLibreMap): void {
  for (const id of [FULL, WALKED, POSITION]) if (!map.getSource(id)) map.addSource(id, {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  if (!map.getLayer(FULL)) map.addLayer({id: FULL, source: FULL, type: 'line', layout: {'line-join': 'round', 'line-cap': 'round'}, paint: {'line-color': TRACK_COLOR, 'line-width': 4, 'line-opacity': 0.25}})
  if (!map.getLayer(WALKED)) map.addLayer({id: WALKED, source: WALKED, type: 'line', layout: {'line-join': 'round', 'line-cap': 'round'}, paint: {'line-color': TRACK_COLOR, 'line-width': 5}})
  if (!map.getLayer(POSITION)) map.addLayer({id: POSITION, source: POSITION, type: 'circle', paint: {'circle-color': TRACK_COLOR, 'circle-radius': 8, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff'}})
}
/** Text is painted into the recorded canvas, rather than added as a DOM overlay. */
function burnLabels(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, name: string, progress: number, basemap: BasemapId, narration?: string, logo?: HTMLImageElement | null): void {
  const scale = Math.max(1, Math.min(2, canvas.width / Math.max(1, canvas.clientWidth || canvas.width / (window.devicePixelRatio || 1))))
  const padding = 12 * scale
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  context.textBaseline = 'middle'; context.textAlign = 'left'
  context.fillStyle = '#0c0c10dc'; context.fillRect(0, 0, canvas.width, 44 * scale)
  context.font = `600 ${16 * scale}px sans-serif`; context.fillStyle = '#ffffff'
  context.fillText(name, padding, 22 * scale, Math.max(1, canvas.width - 150 * scale))
  context.font = `${13 * scale}px sans-serif`; context.textAlign = 'right'
  context.fillText(`轨迹动画 · ${percent}%`, canvas.width - padding, 22 * scale)
  context.textAlign = 'left'; context.font = `${12 * scale}px sans-serif`
  const credits = basemapCredits(basemap).map(credit => credit.label).join(' · ') || '轨迹动画 · 无底图'
  const lines: string[] = []
  let line = ''
  for (const character of credits) {
    if (line && context.measureText(line + character).width > canvas.width - padding * 2) {lines.push(line); line = ''}
    line += character
  }
  if (line) lines.push(line)
  const height = (lines.length * 17 + 16 + (logo ? 30 : 0)) * scale
  const top = canvas.height - height
  context.fillStyle = '#0c0c10e6'; context.fillRect(0, top, canvas.width, height)
  context.fillStyle = '#f5f3ff'
  lines.forEach((text, index) => context.fillText(text, padding, top + (13 + index * 17) * scale))
  if (logo) {
    // The official 67 × 20 SVG has black lettering on a transparent background.
    const width = 80 * scale
    const height = width * (logo.naturalHeight && logo.naturalWidth ? logo.naturalHeight / logo.naturalWidth : 20 / 67)
    const left = padding, top = canvas.height - height - 5 * scale
    context.fillStyle = '#ffffff'; context.fillRect(left - 3 * scale, top - 2 * scale, width + 6 * scale, height + 4 * scale)
    context.drawImage(logo, left, top, width, height)
  }
  if (narration?.trim()) {
    context.fillStyle = '#0c0c10d9'; context.fillRect(0, top - 40 * scale, canvas.width, 36 * scale)
    context.fillStyle = '#ffffff'; context.font = `${14 * scale}px sans-serif`
    context.fillText(narration.trim(), padding, top - 22 * scale, Math.max(1, canvas.width - padding * 2))
  }
  context.fillStyle = '#ffffff40'; context.fillRect(0, top - 4 * scale, canvas.width, 4 * scale)
  context.fillStyle = TRACK_COLOR; context.fillRect(0, top - 4 * scale, canvas.width * percent / 100, 4 * scale)
}




