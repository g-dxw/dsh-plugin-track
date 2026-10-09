/** Editable Three.js shots: interaction and recording share the same composed frame. */
import {useEffect, useRef, useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import {basemapCredits, MAPTILER_LOGO_URL, OSM_CREDIT, terrainProviderFor, type BasemapId} from '../track/basemaps.ts'
import type {MapCredit, MapSettings} from '../track/map-settings.ts'
import {evaluateShotEditorFrame, type ShotEditorFrame, type ShotEditorPlan} from '../track/shot-editor.ts'
import {SandboxRenderer} from '../track/sandbox/renderer.ts'
import {sampleSandboxDetached, type SamplingResult} from '../track/sandbox/sampling.ts'
import type {SandboxCameraState, TerrainGrid} from '../track/sandbox/types.ts'

const WIDTH = 1280, HEIGHT = 720
const FONT = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
const EMPTY_FRAME: ShotEditorFrame = {camera: null, routeProgress: 1, labels: [], caption: ''}

export interface ShotEditorSceneHandle {
  sceneFingerprint: string
  getCameraState(): SandboxCameraState | null
  applyCameraState(state: SandboxCameraState): void
  renderAt(plan: ShotEditorPlan, time: number): void
  getCaptureCanvas(): HTMLCanvasElement | null
  resetView(): void
}
export interface ShotEditorSceneProps {
  track: TrackRecord
  settings: MapSettings
  plan: ShotEditorPlan | null
  time: number
  locked: boolean
  onReady(handle: ShotEditorSceneHandle | null): void
  onStatus(text: string): void
  onError(text: string): void
}

type Box = {x: number; y: number; width: number; height: number}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width + 10 && a.x + a.width + 10 > b.x
  && a.y < b.y + b.height + 10 && a.y + a.height + 10 > b.y
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Scene coordinates change with DEM geometry; credentials never enter saved plans. */
function sceneFingerprint(trackId: string, terrain: TerrainGrid, settings: MapSettings, actualBasemap: BasemapId): string {
  const values = JSON.stringify({trackId, bounds: terrain.bounds, grid: [terrain.columns, terrain.rows],
    metres: [terrain.widthMeters, terrain.depthMeters], exaggeration: settings.exaggeration,
    provider: terrainProviderFor(settings).id, quality: settings.quality, requestedBasemap: settings.basemap, actualBasemap})
  let first = 2166136261, second = 3335557771
  for (let index = 0; index < values.length; index++) {
    first = Math.imul(first ^ values.charCodeAt(index), 16777619)
    second = Math.imul(second ^ values.charCodeAt(index), 2246822519)
  }
  return `scene1-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}
function fittedText(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text
  const characters = Array.from(text)
  while (characters.length && context.measureText(characters.join('') + '…').width > width) characters.pop()
  return characters.join('') + '…'
}
function wrappedText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/u)) {
    let current = ''
    for (const character of paragraph) {
      if (current && context.measureText(current + character).width > width) {lines.push(current); current = ''}
      current += character
    }
    if (current) lines.push(current)
  }
  return lines
}
function strokedText(context: CanvasRenderingContext2D, text: string, x: number, y: number,
  color = '#f9f8ee', stroke = 5): void {
  context.lineJoin = 'round'; context.lineWidth = stroke; context.strokeStyle = '#071b24dd'
  context.strokeText(text, x, y); context.fillStyle = color; context.fillText(text, x, y)
}
function actualCredits(settings: MapSettings, basemap: BasemapId): MapCredit[] {
  const provider = terrainProviderFor(settings)
  const credits = [OSM_CREDIT, ...basemapCredits(basemap), ...provider.credits]
  return credits.filter((credit, index) => credits.findIndex(item => item.label === credit.label && item.url === credit.url) === index)
}

export function ShotEditorScene(props: ShotEditorSceneProps) {
  const latest = useRef(props); latest.current = props
  const holder = useRef<HTMLDivElement>(null), terrainHolder = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null), film = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<SandboxRenderer | null>(null)
  const seek = useRef<(plan: ShotEditorPlan | null, time: number) => void>(() => {})
  const updateSettings = useRef<() => void>(() => {})
  const redraw = useRef<() => void>(() => {})
  const [ready, setReady] = useState(false)
  // Only inputs that change the sampled surface restart the detached DEM/texture sampler.
  const samplingKey = JSON.stringify([props.settings.basemap, props.settings.quality,
    props.settings.terrainProvider, props.settings.maptilerKey])

  useEffect(() => {
    const container = terrainHolder.current, display = overlay.current, output = film.current
    if (!container || !display || !output) return
    const overlayContext = display.getContext('2d'), filmContext = output.getContext('2d')
    setReady(false); latest.current.onReady(null); latest.current.onError('')
    latest.current.onStatus('正在准备真实地形与底图…')
    display.width = output.width = WIDTH; display.height = output.height = HEIGHT
    overlayContext?.clearRect(0, 0, WIDTH, HEIGHT); filmContext?.clearRect(0, 0, WIDTH, HEIGHT)
    const controller = new AbortController()
    let disposed = false, created: SandboxRenderer | null = null, sampled: SamplingResult | null = null
    let stopFrames: (() => void) | null = null, observer: ResizeObserver | null = null, resizeFrame = 0
    let currentFrame: ShotEditorFrame = EMPTY_FRAME, currentPlan: ShotEditorPlan | null = null
    let fingerprint = '', revision = 0, builtExaggeration = latest.current.settings.exaggeration
    let captured = false, validated = false, captureError = '', actualBasemap: BasemapId = 'none'
    let credits: MapCredit[] = [], logo: HTMLImageElement | null = null
    let logoState: 'unneeded' | 'loading' | 'ready' | 'failed' = 'unneeded'
    let logoTimer: ReturnType<typeof setTimeout> | null = null

    const reportError = (message: string) => {
      if (disposed || message === captureError) return
      captureError = message; latest.current.onError(message)
    }
    const paint = () => {
      if (disposed || !created || !overlayContext || !filmContext) return
      const source = created.getCaptureCanvas()
      if (!source?.width || !source.height || !container.clientWidth || !container.clientHeight) return
      try {
        const context = overlayContext
        context.clearRect(0, 0, WIDTH, HEIGHT)
        const shade = context.createLinearGradient(0, 0, 0, HEIGHT)
        shade.addColorStop(0, '#05131d88'); shade.addColorStop(.23, '#05131d00')
        shade.addColorStop(.72, '#05131d00'); shade.addColorStop(1, '#05131dbb')
        context.fillStyle = shade; context.fillRect(0, 0, WIDTH, HEIGHT)
        context.textAlign = 'left'; context.font = `600 36px ${FONT}`
        const title = fittedText(context, currentPlan?.title || latest.current.track.name, WIDTH - 84)
        strokedText(context, title, 40, 66)
        const occupied: Box[] = [{x: 28, y: 22, width: context.measureText(title).width + 32, height: 64}]
        context.font = `600 25px ${FONT}`
        for (const label of currentFrame.labels) {
          const point = created.projectCoordinates(label.coordinates, 30)
          if (!point.visible) continue
          const x = point.x / container.clientWidth * WIDTH, y = point.y / container.clientHeight * HEIGHT
          const text = fittedText(context, label.name, 300), width = context.measureText(text).width + 24
          const candidates = [[-width / 2, -64], [18, -56], [-width - 18, -56], [-width / 2, 24],
            [-width / 2, -104], [18, 34], [-width - 18, 34]].map(([dx, dy]) => ({
              x: clamp(x + dx, 28, WIDTH - width - 28), y: clamp(y + dy, 104, HEIGHT - 184), width, height: 38,
            }))
          const box = candidates.find(candidate => !occupied.some(other => overlaps(candidate, other)))
          if (!box) continue
          occupied.push(box)
          context.strokeStyle = '#9cebd8'; context.lineWidth = 1.7
          context.beginPath(); context.moveTo(x, y)
          context.lineTo(clamp(x, box.x + 10, box.x + box.width - 10), y < box.y ? box.y : box.y + box.height)
          context.stroke(); context.beginPath(); context.arc(x, y, 4.2, 0, Math.PI * 2)
          context.fillStyle = currentPlan?.routeColor || latest.current.settings.routeColor; context.fill()
          strokedText(context, text, box.x + 12, box.y + 28, '#ffe48d', 5)
        }
        if (currentFrame.caption) {
          context.font = `25px ${FONT}`; context.textAlign = 'center'
          const lines = wrappedText(context, currentFrame.caption, WIDTH - 160).slice(0, 4)
          lines.forEach((line, index) => strokedText(context, line, WIDTH / 2, HEIGHT - 102 - (lines.length - index - 1) * 34))
        }
        context.textAlign = 'left'; context.font = `12px ${FONT}`
        const provider = terrainProviderFor(latest.current.settings)
        const creditText = [`Map data ${OSM_CREDIT.label}`, `DEM ${provider.credits.map(credit => credit.label).join(', ')}`,
          ...credits.filter(credit => credit.url !== OSM_CREDIT.url && !provider.credits.some(item => item.url === credit.url))
            .map(credit => credit.label)].join('  ·  ')
        const activeLogo = logoState === 'ready' ? logo : null
        const creditWidth = WIDTH - 80 - (activeLogo ? 104 : 0)
        const creditLines = wrappedText(context, creditText, creditWidth).slice(0, 3)
        creditLines.forEach((line, index) => strokedText(context, line, 40,
          HEIGHT - 24 - (creditLines.length - index - 1) * 17, '#eef4f0', 3))
        if (activeLogo) {
          const width = 87, height = width * (activeLogo.naturalHeight / activeLogo.naturalWidth || 20 / 67)
          context.fillStyle = '#ffffff'; context.fillRect(WIDTH - 133, HEIGHT - height - 29, width + 8, height + 6)
          context.drawImage(activeLogo, WIDTH - 129, HEIGHT - height - 26, width, height)
        }
        filmContext.clearRect(0, 0, WIDTH, HEIGHT)
        filmContext.drawImage(source, 0, 0, WIDTH, HEIGHT); filmContext.drawImage(display, 0, 0)
        if (!validated && logoState !== 'loading') {output.toDataURL('image/png'); validated = true}
        captured = logoState !== 'loading' && logoState !== 'failed'
      } catch {
        captured = false
        reportError('三维画面无法合成录制，可能是跨域或图形设备限制；可以重试或切换底图。')
      }
    }
    const interactionFrame = (apply: () => void) => {
      if (!created || disposed) return
      created.setInteractionEnabled(false)
      try {apply(); created.renderFrame()}
      finally {created.setInteractionEnabled(!latest.current.locked)}
    }
    const renderAt = (plan: ShotEditorPlan | null, time: number) => {
      if (!created || disposed) return
      if (plan && (plan.trackId !== latest.current.track.id || plan.sceneFingerprint !== fingerprint)) {
        throw new Error('镜头草稿与当前三维场景不一致，请重新建立镜头。')
      }
      const frame = plan ? evaluateShotEditorFrame(plan, time) : EMPTY_FRAME
      currentPlan = plan; currentFrame = frame
      interactionFrame(() => {
        if (frame.camera) created!.applyCameraState(frame.camera)
        created!.updateRouteColor(plan?.routeColor || latest.current.settings.routeColor)
        created!.setRouteProgress(frame.routeProgress)
      })
    }
    const announceHandle = () => {
      if (!created || !sampled || disposed) return
      const generation = ++revision
      fingerprint = sceneFingerprint(latest.current.track.id, sampled.terrain, latest.current.settings, actualBasemap)
      const valid = () => !disposed && generation === revision && created !== null
      const handle: ShotEditorSceneHandle = {
        sceneFingerprint: fingerprint,
        getCameraState: () => valid() ? created!.getCameraState() : null,
        applyCameraState: state => {if (valid()) interactionFrame(() => created!.applyCameraState(state))},
        renderAt: (plan, time) => {if (valid()) renderAt(plan, time)},
        getCaptureCanvas: () => valid() && captured ? output : null,
        resetView: () => {if (valid()) interactionFrame(() => created!.resetView())},
      }
      setReady(true); latest.current.onReady(handle)
    }
    const syncSettings = () => {
      if (!created || !sampled || disposed) return
      const settings = latest.current.settings
      if (builtExaggeration !== settings.exaggeration) {
        const camera = created.getCameraState()
        latest.current.onReady(null); setReady(false)
        currentPlan = null; currentFrame = EMPTY_FRAME; captured = false
        created.build(sampled.terrain, latest.current.track.coordinates, sampled.texture, {
          quality: settings.quality, exaggeration: settings.exaggeration, segmentStarts: latest.current.track.segmentStarts,
          routeColor: settings.routeColor, lighting: settings.lighting, colors: settings.sandboxColors, background: settings.sandboxBackground,
        })
        builtExaggeration = settings.exaggeration
        interactionFrame(() => {if (camera) created!.applyCameraState(camera)})
        announceHandle()
      } else {
        created.updateRouteColor(currentPlan?.routeColor || settings.routeColor)
        created.updateLighting(settings.lighting); created.updateColors(settings.sandboxColors)
        created.updateBackground(settings.sandboxBackground); created.renderFrame()
      }
    }
    seek.current = (plan, time) => {try {renderAt(plan, time)} catch (error) {reportError(error instanceof Error ? error.message : '镜头预览失败，请重试。')}}
    updateSettings.current = () => {try {syncSettings()} catch (error) {reportError(error instanceof Error ? error.message : '三维设置更新失败，请重试。')}}
    redraw.current = paint

    const isLogoLoading = () => logoState === 'loading'
    const prepareLogo = () => {
      if (!credits.some(credit => credit.url.includes('maptiler.com'))) return
      logoState = 'loading'; logo = new Image(); logo.crossOrigin = 'anonymous'
      const fail = () => {
        if (logoTimer !== null) clearTimeout(logoTimer)
        logoTimer = null
        if (disposed) return
        logoState = 'failed'; captured = false
        reportError('MapTiler 标志加载失败，暂不能录制；请重试或切换底图。')
      }
      logo.onload = () => {
        if (logoTimer !== null) clearTimeout(logoTimer)
        logoTimer = null
        if (disposed) return
        logoState = 'ready'; validated = false; paint()
        latest.current.onStatus('三维场景已就绪，可拖动调整视角。')
      }
      logo.onerror = fail; logoTimer = setTimeout(fail, 10_000); logo.src = MAPTILER_LOGO_URL
    }
    void (async () => {
      try {
        if (!overlayContext || !filmContext) throw new Error('浏览器无法生成镜头画面，请重试。')
        const settings = latest.current.settings
        sampled = await sampleSandboxDetached(latest.current.track.coordinates, {signal: controller.signal, settings, textureEnabled: true})
        if (disposed || controller.signal.aborted) return
        const chosen = settings.basemap.startsWith('maptiler-') && !settings.maptilerKey.trim() ? 'vector' : settings.basemap
        actualBasemap = sampled.texture && !sampled.textureUnavailable ? chosen : 'none'
        credits = actualCredits(latest.current.settings, actualBasemap)
        prepareLogo()
        created = new SandboxRenderer(container, () => {
          if (disposed) return
          revision++; renderer.current = null; captured = false; setReady(false); latest.current.onReady(null)
          reportError('三维图形上下文已中断，请重新打开镜头编辑器。')
        })
        renderer.current = created
        const terrainCanvas = created.getCaptureCanvas()
        if (terrainCanvas) {terrainCanvas.style.width = '100%'; terrainCanvas.style.height = '100%'; terrainCanvas.style.display = 'block'}
        stopFrames = created.onFrameRendered(paint)
        created.build(sampled.terrain, latest.current.track.coordinates, sampled.texture, {
          quality: latest.current.settings.quality, exaggeration: latest.current.settings.exaggeration,
          segmentStarts: latest.current.track.segmentStarts, routeColor: latest.current.settings.routeColor,
          lighting: latest.current.settings.lighting, colors: latest.current.settings.sandboxColors,
          background: latest.current.settings.sandboxBackground,
        })
        builtExaggeration = latest.current.settings.exaggeration
        created.setInteractionEnabled(!latest.current.locked); created.renderFrame()
        announceHandle()
        const plan = latest.current.plan
        if (plan?.sceneFingerprint === fingerprint) renderAt(plan, latest.current.time)
        latest.current.onStatus(sampled.textureUnavailable ? '真实地形已就绪；底图暂不可用，可继续调整视角或切换底图。'
          : chosen === 'osm' ? '真实地形已就绪；此底图使用地形配色，可拖动调整视角。'
          : isLogoLoading() ? '三维场景已就绪，正在准备来源标志…' : '三维场景已就绪，可拖动调整视角。')
        observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame)
          resizeFrame = requestAnimationFrame(() => {resizeFrame = 0; if (!disposed) created?.renderFrame()})
        })
        observer?.observe(container)
        void document.fonts?.ready.then(() => {if (!disposed) paint()})
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        captured = false; revision++; setReady(false); latest.current.onReady(null)
        latest.current.onStatus('三维场景未就绪。')
        reportError(error instanceof Error ? error.message : '真实地形加载失败，请重试。')
        stopFrames?.(); stopFrames = null; created?.dispose(); created = null; renderer.current = null
      }
    })()
    return () => {
      disposed = true; revision++; controller.abort(); setReady(false)
      seek.current = () => {}; updateSettings.current = () => {}; redraw.current = () => {}
      latest.current.onReady(null)
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      if (logoTimer !== null) clearTimeout(logoTimer)
      if (logo) {logo.onload = null; logo.onerror = null}
      observer?.disconnect(); stopFrames?.(); created?.dispose()
      if (renderer.current === created) renderer.current = null
    }
  }, [props.track.id, props.track.coordinates, props.track.segmentStarts, samplingKey])

  // Seeking is intentionally separate from ordinary parent renders and manual orbiting.
  useEffect(() => {seek.current(props.plan, props.time)}, [props.plan, props.time])
  useEffect(() => {renderer.current?.setInteractionEnabled(!props.locked)}, [props.locked])
  useEffect(() => {updateSettings.current()}, [props.settings.exaggeration, props.settings.routeColor,
    props.settings.lighting.azimuth, props.settings.lighting.elevation, props.settings.lighting.intensity,
    props.settings.lighting.ambient, props.settings.lighting.shadows, props.settings.sandboxColors.sides,
    props.settings.sandboxColors.background, props.settings.sandboxBackground])
  useEffect(() => {redraw.current()}, [props.track.name])

  return <div ref={holder} className="trk-shot-editor-scene" data-testid="shot-editor-scene" data-ready={ready ? 'true' : 'false'}
    aria-label="可调整视角的三维镜头画面" style={{position: 'relative', width: '100%', aspectRatio: '16 / 9',
      overflow: 'hidden', borderRadius: 8, background: 'var(--trk-bg-subtle)', isolation: 'isolate'}}>
    <div ref={terrainHolder} style={{position: 'absolute', inset: 0, touchAction: 'none'}} />
    <canvas ref={overlay} width={WIDTH} height={HEIGHT} aria-hidden="true"
      style={{position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none'}} />
    <canvas ref={film} width={WIDTH} height={HEIGHT} aria-hidden="true"
      style={{position: 'absolute', left: -100000, top: 0, width: WIDTH, height: HEIGHT, pointerEvents: 'none', visibility: 'hidden'}} />
  </div>
}


