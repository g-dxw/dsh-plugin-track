/** An independent, data-driven MapLibre shot preview. Pitch is a flat-map view, not DEM terrain. */
import { useEffect, useRef, useState } from 'react'
import { AttributionControl, Map as MapLibreMap, type GeoJSONSource } from 'maplibre-gl'
import { basemapCredits, BLANK_STYLE, MAPTILER_LOGO_URL, styleFor, type BasemapId } from '../track/basemaps.ts'
import { sampleShotCase, type ShotCaseFrame, type ShotCasePlan } from '../track/shot-cases.ts'
import { TRACK_COLOR } from '../track/trail-layer.ts'
import { BasemapControls, MapCredits, useMapSettings } from './map-settings.tsx'
import { MAP_STYLE } from './maplibre-css.ts'

export interface ShotCaseMapProps {
  plan: ShotCasePlan
  progress: number
  basemap: BasemapId
  onBasemap: (value: BasemapId) => void
  onCanvas: (canvas: HTMLCanvasElement | null) => void
  onUnavailable: (message: string | null) => void
  onCaptureError?: (message: string | null) => void
  onCaptureFrame?: (progress: number) => void
  /** Requests a painted frame even when recording starts at an unchanged progress of zero. */
  captureRequest?: number
  disabled?: boolean
}
const FULL = 'cqai-shot-case-full'
const WALKED = 'cqai-shot-case-walked'
const POSITION = 'cqai-shot-case-position'
const TARGET = 'cqai-shot-case-target'
const SOURCES = [FULL, WALKED, POSITION, TARGET]
const PADDING = {top: 70, bottom: 150, left: 55, right: 55}
const MAX_LATITUDE = 85.051129
const clampProgress = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const coordinate = (value: readonly number[]): [number, number] => [value[0], Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, value[1]))]
const nearestWorld = (value: readonly number[], longitude: number): [number, number] => coordinate([value[0] + 360 * Math.round((longitude - value[0]) / 360), value[1]])
const samePoint = (a: readonly number[] | null, b: readonly number[] | null) => a === b || !!a && !!b && a[0] === b[0] && a[1] === b[1]
function centerPair(value: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1])) return [value[0], value[1]]
  if (typeof value === 'object' && value !== null) {
    const point = value as {lng?: number; lon?: number; lat?: number}
    const longitude = point.lng ?? point.lon
    if (Number.isFinite(longitude) && Number.isFinite(point.lat)) return [longitude!, point.lat!]
  }
  return [...fallback]
}
/** Fit padding offsets belong to the overview and fade out as a detail target fills the frame. */
function overviewWeight(plan: ShotCasePlan, frame: ShotCaseFrame): number {
  if (plan.id === 'route-draw' || plan.id === 'story-opening') return 1
  if (plan.id === 'point-hold' || plan.id === 'route-follow') return 0
  const elapsed = frame.progress * plan.duration
  let start = 0, index = plan.steps.length - 1, fraction = 1
  for (let step = 0; step < plan.steps.length; step++) {
    const duration = plan.steps[step].duration
    if (elapsed < start + duration || step === plan.steps.length - 1) {
      index = step; fraction = clampProgress((elapsed - start) / duration); break
    }
    start += duration
  }
  const local = fraction * fraction * (3 - 2 * fraction)
  if (plan.id === 'zoom-in') return index === 0 ? 1 : 1 - local
  if (plan.id === 'zoom-out' || plan.id === 'section-to-route') return index === 0 ? 0 : local
  return index < 2 ? 0 : local // Route introduction and local opening return to the full route.
}
interface AppliedFrame {
  plan: ShotCasePlan
  frame: ShotCaseFrame
  camera: {center: [number, number]; zoom: number; bearing: number; pitch: number}
  styleRevision: number
}
export function ShotCaseMap(props: ShotCaseMapProps) {
  const {settings} = useMapSettings()
  const savedConfig = useRef({settings, basemap: props.basemap})
  if (!props.disabled) savedConfig.current = {settings, basemap: props.basemap}
  const activeConfig = props.disabled ? savedConfig.current : {settings, basemap: props.basemap}
  const config = useRef(activeConfig); config.current = activeConfig
  const latest = useRef(props); latest.current = props
  const holder = useRef<HTMLDivElement>(null), captureHolder = useRef<HTMLDivElement>(null)
  const paint = useRef<(force?: boolean) => void>(() => {})
  const lock = useRef<() => void>(() => {})
  const [broken, setBroken] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [captureFailed, setCaptureFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [compositeReady, setCompositeReady] = useState(false)

  useEffect(() => {
    const container = holder.current, display = captureHolder.current
    if (!container || !display) return
    setBroken(false); setUnavailable(false); setCaptureFailed(false); setCompositeReady(false)
    latest.current.onCanvas(null); latest.current.onCaptureError?.(null)
    if (!document.querySelector('style[data-plugin="cqai-dsh-plugin-track"]')) {
      const style = document.createElement('style')
      style.dataset.plugin = 'cqai-dsh-plugin-track'; style.textContent = MAP_STYLE
      document.head.appendChild(style)
    }
    let created: MapLibreMap
    try {
      created = new MapLibreMap({
        container, style: BLANK_STYLE, attributionControl: false, dragRotate: false, maxPitch: 75,
        canvasContextAttributes: {preserveDrawingBuffer: true}, pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      })
    } catch {
      setUnavailable(true)
      latest.current.onUnavailable('这台设备没有可用的 WebGL，无法播放镜头案例；可重试地图。')
      return
    }
    latest.current.onUnavailable(null)
    created.touchZoomRotate.disableRotation()
    created.addControl(new AttributionControl({compact: true}))
    const mapCanvas = created.getCanvas(), output = document.createElement('canvas')
    output.className = 'trk-shot-case-composite'; output.setAttribute('aria-hidden', 'true'); output.style.visibility = 'hidden'
    display.appendChild(output)
    let context: CanvasRenderingContext2D | null = null
    try {context = output.getContext('2d')} catch { /* The native map remains usable. */ }
    let removed = false, updating = false, failedCapture = false, announced = false, fallback = false
    let awaitingPaint = false, forceRequested = false
    let applied: AppliedFrame | null = null, fullPlan: ShotCasePlan | null = null, styleRevision = 0
    let logo: HTMLImageElement | null = null, logoState: 'loading' | 'ready' | 'failed' | null = null
    let logoTimer: ReturnType<typeof setTimeout> | null = null, styleTimer: ReturnType<typeof setTimeout> | null = null
    let observer: ResizeObserver | null = null
    const clearLogo = () => {
      if (logoTimer !== null) clearTimeout(logoTimer)
      logoTimer = null
      if (logo) {logo.onload = null; logo.onerror = null}
      logo = null; logoState = null
    }
    const actualBasemap = (): BasemapId => fallback ? 'none' : config.current.basemap.startsWith('maptiler-') && !config.current.settings.maptilerKey.trim() ? 'vector' : config.current.basemap
    const failCapture = (message: string) => {
      if (removed || failedCapture) return
      failedCapture = true; announced = false; output.style.visibility = 'hidden'
      setCaptureFailed(true); setCompositeReady(false); latest.current.onCanvas(null); latest.current.onCaptureError?.(message)
    }
    const prepareLogo = () => {
      if (!actualBasemap().startsWith('maptiler-')) return true
      if (logoState === 'ready') return true
      if (logoState === 'failed') return false
      if (!logo) {
        logo = new Image(); logoState = 'loading'; logo.crossOrigin = 'anonymous'
        logo.onload = () => {
          if (logoTimer !== null) clearTimeout(logoTimer)
          logoTimer = null
          if (!removed) {logoState = 'ready'; created.triggerRepaint()}
        }
        const fail = () => {
          if (logoTimer !== null) clearTimeout(logoTimer)
          logoTimer = null
          if (removed) return
          logoState = 'failed'; failCapture('MapTiler 标志加载失败，案例暂不能录制；可重试地图或切换底图。')
        }
        logo.onerror = fail; logoTimer = setTimeout(fail, 10_000); logo.src = MAPTILER_LOGO_URL
      }
      return false
    }
    const desiredMatches = () => applied !== null && applied.plan === latest.current.plan
      && applied.frame.progress === clampProgress(latest.current.progress) && applied.styleRevision === styleRevision
    const sourcesReady = () => SOURCES.every(id => {
      const source = created.getSource(id) as GeoJSONSource | undefined
      return source && (typeof source.loaded !== 'function' || source.loaded())
        && (typeof created.isSourceLoaded !== 'function' || created.isSourceLoaded(id))
    })
    const cameraMatches = (camera: AppliedFrame['camera']) => {
      const center = created.getCenter(), close = (a: number, b: number) => Math.abs(a - b) < 0.00001
      const angle = ((created.getBearing() - camera.bearing + 540) % 360) - 180
      return close(nearestWorld([center.lng, center.lat], camera.center[0])[0], camera.center[0]) && close(center.lat, camera.center[1])
        && close(created.getZoom(), camera.zoom) && Math.abs(angle) < 0.00001 && close(created.getPitch(), camera.pitch)
    }
    const capture = (fromRender: boolean) => {
      // Progress may advance while workers paint. Capture the completed applied snapshot,
      // never mix it with newer desired labels, and never starve it by resubmitting GeoJSON.
      if (removed || updating || failedCapture || !applied || applied.plan !== latest.current.plan
        || applied.styleRevision !== styleRevision || !sourcesReady() || !cameraMatches(applied.camera)) return
      if (!context) {failCapture('浏览器无法生成案例视频画面，仍可查看地图；可重试地图。'); return}
      if (!prepareLogo()) return
      try {
        if (!mapCanvas.width || !mapCanvas.height) return
        if (output.width !== mapCanvas.width) output.width = mapCanvas.width
        if (output.height !== mapCanvas.height) output.height = mapCanvas.height
        context.drawImage(mapCanvas, 0, 0, output.width, output.height)
        burnLabels(context, output, created, applied, actualBasemap(), logoState === 'ready' ? logo : null, fallback)
        output.style.visibility = 'visible'
        if (!announced) {announced = true; setCompositeReady(true); latest.current.onCaptureError?.(null); latest.current.onCanvas(output)}
        // Recording endpoints additionally wait for provider tiles to finish.
        const progress = applied.frame.progress
        if (fromRender && (progress > 0 && progress < 1 || typeof created.areTilesLoaded !== 'function' || created.areTilesLoaded())) {
          latest.current.onCaptureFrame?.(progress)
        }
      } catch {failCapture('地图画面无法录制，可能是跨域或图形设备限制；仍可查看地图，请重试或切换底图。')}
    }
    const update = (force = false) => {
      if (force) forceRequested = true
      if (removed || updating || awaitingPaint || created.style?._loaded === false || !forceRequested && desiredMatches()) return
      updating = true
      try {
        ensureLayers(created, config.current.settings.routeColor || TRACK_COLOR)
        const plan = latest.current.plan, frame = sampleShotCase(plan, clampProgress(latest.current.progress))
        const [west, south, east, north] = plan.bounds
        const fit = created.cameraForBounds([west, coordinate([0, south])[1], east, coordinate([0, north])[1]], {padding: PADDING, maxZoom: 16, bearing: frame.camera.bearing})
        const fittedCenter = centerPair(fit?.center, plan.overviewCenter)
        const overview = overviewWeight(plan, frame)
        const offset = nearestWorld(fittedCenter, plan.overviewCenter[0])
        const camera = {
          center: coordinate([frame.camera.center[0] + (offset[0] - plan.overviewCenter[0]) * overview,
            frame.camera.center[1] + (offset[1] - plan.overviewCenter[1]) * overview]),
          zoom: Math.max(0, Math.min(22, (fit?.zoom ?? 12) + frame.camera.zoomOffset)),
          bearing: frame.camera.bearing, pitch: Math.max(0, Math.min(75, frame.camera.pitch)),
        }
        const changedPlan = fullPlan !== plan
        if (changedPlan) {
          ;(created.getSource(FULL) as GeoJSONSource).setData(linesFeature(plan.fullLines))
          fullPlan = plan
        }
        // Push/pull/hold shots change only the camera. Their unchanged route data
        // must not keep resetting GeoJSON workers on every animation frame.
        if (changedPlan || applied?.frame.routeProgress !== frame.routeProgress) {
          ;(created.getSource(WALKED) as GeoJSONSource).setData(linesFeature(frame.walkedLines))
        }
        if (changedPlan || !samePoint(applied?.frame.position ?? null, frame.position)) {
          ;(created.getSource(POSITION) as GeoJSONSource).setData(pointFeature(frame.position))
        }
        const nextTarget = frame.target ? nearestWorld(frame.target.coordinates, camera.center[0]) : null
        if (changedPlan || applied?.frame.target?.label !== frame.target?.label
          || !samePoint(applied?.frame.target?.coordinates ?? null, frame.target?.coordinates ?? null)) {
          ;(created.getSource(TARGET) as GeoJSONSource).setData(pointFeature(nextTarget, frame.target?.label))
        }
        applied = {plan, frame, camera, styleRevision}; awaitingPaint = true; forceRequested = false
        created.jumpTo(camera)
      } catch {applied = null; awaitingPaint = false; failCapture('镜头数据或相机绘制失败，请重试地图；没有生成可录制画面。')}
      finally {updating = false}
    }

    const changeStyle = (style: Parameters<MapLibreMap['setStyle']>[0]) => {
      styleRevision++; applied = null; fullPlan = null; awaitingPaint = false; forceRequested = false; announced = false; output.style.visibility = 'hidden'
      setCompositeReady(false)
      latest.current.onCanvas(null)
      created.setStyle(style)
    }
    const blankFallback = () => {
      if (removed || fallback) return
      fallback = true; clearLogo(); setBroken(true)
      if (styleTimer !== null) clearTimeout(styleTimer)
      styleTimer = null
      try {changeStyle(BLANK_STYLE)} catch {failCapture('纯色地图也无法初始化，请重试地图。')}
    }
    const styleLoaded = () => {if (!created.getLayer(TARGET) || !desiredMatches()) update(true)}
    const rendered = () => {

      if (removed || updating) return
      if (applied && sourcesReady() && cameraMatches(applied.camera)) {
        awaitingPaint = false
        capture(true)
      }
      // Apply at most one new snapshot after the last actual paint; intermediate
      // desired progress is coalesced instead of constantly canceling workers.
      const previous = applied
      update()
      if (applied !== previous) created.triggerRepaint()
    }
    const resourceError = (event: {sourceId?: string}) => {
      if (removed) return
      if (event?.sourceId && SOURCES.includes(event.sourceId)) {
        failCapture('案例路线数据加载失败，请重试地图后再录制。')
      } else if (actualBasemap() !== 'none') blankFallback()
      else if (!fallback) failCapture('地图资源无法绘制，请重试地图。')
    }
    const resize = () => {if (!removed) {created.resize(); update(true); created.triggerRepaint()}}
    const setLocked = () => {
      for (const handler of [created.dragPan, created.scrollZoom, created.boxZoom, created.doubleClickZoom, created.keyboard, created.touchZoomRotate, created.touchPitch]) {
        if (latest.current.disabled) handler.disable()
        else handler.enable()
      }
      created.touchZoomRotate.disableRotation()
    }
    const contextLost = (event: Event) => {
      event.preventDefault()
      if (removed) return
      dispose()
      setUnavailable(true); latest.current.onUnavailable('地图图形上下文已丢失，案例已暂停；可重试地图。')
    }
    const dispose = () => {
      if (removed) return
      removed = true
      paint.current = () => {}; lock.current = () => {}
      if (styleTimer !== null) clearTimeout(styleTimer)
      styleTimer = null; clearLogo(); observer?.disconnect()
      window.removeEventListener('resize', resize)
      mapCanvas.removeEventListener('webglcontextlost', contextLost)
      created.off('styledata', styleLoaded); created.off('load', styleLoaded); created.off('render', rendered); created.off('error', resourceError)
      latest.current.onCanvas(null); output.remove(); created.remove()
    }
    created.on('styledata', styleLoaded); created.on('load', styleLoaded); created.on('render', rendered); created.on('error', resourceError)
    mapCanvas.addEventListener('webglcontextlost', contextLost)
    window.addEventListener('resize', resize)
    if (typeof ResizeObserver !== 'undefined') {observer = new ResizeObserver(resize); observer.observe(container)}
    paint.current = (force = false) => {
      if (applied && applied.plan !== latest.current.plan && announced) {
        announced = false; output.style.visibility = 'hidden'; setCompositeReady(false); latest.current.onCanvas(null)
      }
      update(force); created.triggerRepaint()
    }
    lock.current = setLocked
    setLocked()
    try {changeStyle(styleFor(actualBasemap(), config.current.settings))} catch {blankFallback()}
    styleTimer = setTimeout(() => {
      styleTimer = null
      if (!removed && !fallback && actualBasemap() !== 'none'
        && (created.style?._loaded === false || !created.areTilesLoaded())) blankFallback()
    }, 15_000)
    return dispose
  }, [activeConfig.basemap, activeConfig.settings.maptilerKey, retry])

  useEffect(() => {paint.current(true)}, [props.plan, props.progress, props.captureRequest, activeConfig.settings.routeColor])
  useEffect(() => {lock.current()}, [props.disabled])
  const visibleBasemap = broken || unavailable ? 'none' : activeConfig.basemap.startsWith('maptiler-') && !activeConfig.settings.maptilerKey.trim() ? 'vector' : activeConfig.basemap
  return <div className="trk-shot-case-map trk-map-wrap">
    <style>{CASE_MAP_CSS}</style>
    <div className="trk-map" ref={holder} aria-label="镜头案例地图" />
    <div className="trk-shot-case-canvas" ref={captureHolder} />
    <div className="trk-shot-case-basemaps" role="group" aria-label="案例底图"><BasemapControls basemap={activeConfig.basemap} disabled={props.disabled || unavailable} onBasemap={next => {
      if (next === activeConfig.basemap) setRetry(value => value + 1)
      props.onBasemap(next)
    }} /></div>
    {!compositeReady && <MapCredits settings={activeConfig.settings} basemap={visibleBasemap} className="trk-shot-case-credits" />}
    {broken && !unavailable && <div className="trk-shot-case-message" role="status">底图加载失败，已显示纯色案例，仍可播放与录制。</div>}
    {(unavailable || captureFailed) && <div className="trk-shot-case-message" role="status">
      {unavailable ? '地图暂不可用。' : '案例捕获暂不可用，仍可查看地图。'}
      <button type="button" disabled={props.disabled} onClick={() => setRetry(value => value + 1)}>重试地图</button>
    </div>}
    <span className="trk-shot-case-flat-note">平面地图镜头示例；斜视不代表真实 3D 山体。</span>
  </div>
}
function linesFeature(lines: readonly (readonly [number, number][])[]): GeoJSON.FeatureCollection<GeoJSON.MultiLineString> {
  const coordinates = lines.filter(line => line.length >= 2).map(line => {
    const points = line.map(coordinate)
    return points
  })
  return {type: 'FeatureCollection', features: coordinates.length ? [{type: 'Feature', properties: {}, geometry: {type: 'MultiLineString', coordinates}}] : []}
}
function pointFeature(position: readonly [number, number] | null, label?: string): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {type: 'FeatureCollection', features: position ? [{type: 'Feature', properties: label ? {label} : {}, geometry: {type: 'Point', coordinates: coordinate(position)}}] : []}
}
function ensureLayers(map: MapLibreMap, color: string) {
  for (const id of SOURCES) if (!map.getSource(id)) map.addSource(id, {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  for (const [id, opacity, width] of [[FULL, 0.26, 4], [WALKED, 1, 5]] as const) if (!map.getLayer(id)) map.addLayer({
    id, source: id, type: 'line', layout: {'line-join': 'round', 'line-cap': 'round'}, paint: {'line-color': color, 'line-width': width, 'line-opacity': opacity},
  })
  for (const [id, pointColor, radius] of [[POSITION, color, 7], [TARGET, '#ffb020', 9]] as const) if (!map.getLayer(id)) map.addLayer({
    id, source: id, type: 'circle', paint: {'circle-color': pointColor, 'circle-radius': radius, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff'},
  })
  if (typeof map.setPaintProperty === 'function') {
    for (const [id, property] of [[FULL, 'line-color'], [WALKED, 'line-color'], [POSITION, 'circle-color']] as const) {
      if (typeof map.getPaintProperty !== 'function' || map.getPaintProperty(id, property) !== color) map.setPaintProperty(id, property, color)
    }
  }
}
function wrap(context: CanvasRenderingContext2D, text: string, width: number, maximum = Infinity): string[] {
  const lines: string[] = []; let line = ''
  for (const character of text) {
    if (line && (character === '\n' || context.measureText(line + character).width > width)) {lines.push(line); line = ''; if (lines.length === maximum) break}
    if (character !== '\n') line += character
  }
  if (line && lines.length < maximum) lines.push(line)
  return lines
}
/** The visible composite and recorded canvas share all labels and provider attribution. */
function burnLabels(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, map: MapLibreMap, applied: AppliedFrame, basemap: BasemapId, logo: HTMLImageElement | null, fallback: boolean) {
  const native = map.getCanvas(), scale = Math.max(1, Math.min(2, canvas.width / Math.max(1, native.clientWidth || canvas.width / (window.devicePixelRatio || 1))))
  const padding = 12 * scale, width = canvas.width - padding * 2
  context.textBaseline = 'middle'; context.textAlign = 'left'
  context.font = (12 * scale) + 'px sans-serif'
  const credits = wrap(context, basemapCredits(basemap).map(credit => credit.label).join(' · ') || '镜头案例 · 无底图', width)
  const creditsHeight = (credits.length * 17 + 14 + (logo ? 30 : 0)) * scale, top = canvas.height - creditsHeight
  context.font = (14 * scale) + 'px sans-serif'
  const captions = wrap(context, applied.frame.caption, width, 3), height = (captions.length * 21 + 32) * scale
  const mapTop = 46 * scale, mapBottom = top - height
  const target = applied.frame.target
  if (target?.label) {
    const position = map.project(nearestWorld(target.coordinates, applied.camera.center[0])), ratio = canvas.width / Math.max(1, native.clientWidth || canvas.width / (window.devicePixelRatio || 1))
    const px = position.x * ratio, py = position.y * ratio
    // An offscreen point must never turn into an apparently geolocated edge label.
    if (Number.isFinite(px) && Number.isFinite(py) && px >= 0 && px <= canvas.width && py >= mapTop && py < mapBottom) {
      context.font = '600 ' + (14 * scale) + 'px sans-serif'
      const labelWidth = Math.min(width, context.measureText(target.label).width + 16 * scale)
      const x = Math.max(padding, Math.min(canvas.width - labelWidth - padding, px + 12 * scale))
      const y = Math.max(mapTop, Math.min(mapBottom - 30 * scale, py - 30 * scale))
      context.fillStyle = '#17202bea'; context.fillRect(x, y, labelWidth, 30 * scale)
      context.fillStyle = '#ffffff'; context.fillText(target.label, x + 8 * scale, y + 15 * scale, labelWidth - 16 * scale)
    }
  }
  context.fillStyle = '#101723e8'; context.fillRect(0, 0, canvas.width, 46 * scale)
  context.font = '600 ' + (16 * scale) + 'px sans-serif'; context.fillStyle = '#ffffff'
  context.fillText('镜头案例 · ' + applied.plan.title, padding, 23 * scale, Math.max(1, width - 100 * scale))
  context.textAlign = 'right'; context.font = (13 * scale) + 'px sans-serif'
  context.fillText(Math.round(applied.frame.progress * 100) + '%', canvas.width - padding, 23 * scale); context.textAlign = 'left'
  context.font = (12 * scale) + 'px sans-serif'
  context.fillStyle = '#101723ed'; context.fillRect(0, top, canvas.width, creditsHeight)
  context.fillStyle = '#ffffff'; credits.forEach((line, index) => context.fillText(line, padding, top + (12 + index * 17) * scale))
  if (logo) {
    const logoWidth = 80 * scale, logoHeight = logoWidth * (logo.naturalHeight && logo.naturalWidth ? logo.naturalHeight / logo.naturalWidth : 20 / 67)
    const y = canvas.height - logoHeight - 5 * scale
    context.fillStyle = '#ffffff'; context.fillRect(padding - 3 * scale, y - 2 * scale, logoWidth + 6 * scale, logoHeight + 4 * scale)
    context.drawImage(logo, padding, y, logoWidth, logoHeight)
  }
  context.fillStyle = '#101723dc'; context.fillRect(0, top - height, canvas.width, height)
  context.fillStyle = '#ffd083'; context.font = '600 ' + (12 * scale) + 'px sans-serif'
  context.fillText('示例文案 · ' + applied.frame.stepLabel + (fallback ? ' · 纯色底图' : ''), padding, top - height + 16 * scale, width)
  context.fillStyle = '#ffffff'; context.font = (14 * scale) + 'px sans-serif'
  captions.forEach((line, index) => context.fillText(line, padding, top - height + (38 + index * 21) * scale))
}
const CASE_MAP_CSS = '.trk-shot-case-map{position:relative;width:100%;height:min(58vh,560px);min-height:360px;overflow:hidden;background:var(--trk-map-background)}'
  + '.trk-shot-case-map>.trk-map,.trk-shot-case-canvas,.trk-shot-case-composite{position:absolute;inset:0;width:100%;height:100%}.trk-shot-case-canvas{pointer-events:none;z-index:1}'
  + '.trk-shot-case-basemaps{position:absolute;top:52px;left:10px;right:10px;z-index:3}.trk-shot-case-credits{position:absolute;bottom:6px;right:10px;z-index:3}'
  + '.trk-shot-case-message{position:absolute;top:110px;left:12px;right:12px;z-index:4;padding:10px;background:var(--trk-overlay);color:var(--trk-overlay-text);border-radius:8px}.trk-shot-case-message button{margin-left:8px;min-height:44px}'
  + '.trk-shot-case-flat-note{position:absolute;bottom:72px;right:12px;z-index:2;max-width:75%;padding:3px 6px;background:var(--trk-overlay);color:var(--trk-overlay-text);font-size:11px;pointer-events:none}'
