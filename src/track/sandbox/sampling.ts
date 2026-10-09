import type { Map as MapLibreMap, MapSourceDataEvent, StyleSpecification } from 'maplibre-gl'
import type { TrackPoint } from '../../protocol.ts'
import { TRACK_CASING, TRACK_END, TRACK_LINE, TRACK_START } from '../trail-layer.ts'
import { BLANK_STYLE, styleFor, terrainProviderFor } from '../basemaps.ts'
import { DEFAULT_MAP_SETTINGS, type MapSettings, type SandboxQuality } from '../map-settings.ts'
import { createTerrainGrid, gridCoordinate, mercatorY, sandboxBounds, SANDBOX_QUALITY_BUDGETS } from './coordinates.ts'
import type { TerrainGrid } from './types.ts'

export const DEM_SOURCE = 'cqai-track-terrain-dem'
const TRACK_LAYERS = [TRACK_CASING, TRACK_LINE, TRACK_START, TRACK_END]
const DEM_DEADLINE_MS = 30_000
const TEXTURE_PAINT_MS = 1000


export type SamplingResult = { terrain: TerrainGrid; texture: HTMLCanvasElement | null; textureUnavailable: boolean }
type SourceEvent = Partial<MapSourceDataEvent> & { tile?: { state?: string; dem?: unknown; source?: unknown } }

/** MapLibre source errors may put the source id on the event, tile, or nested error. */
export function isSandboxDEMError(event: unknown): boolean {
  const visited = new Set<unknown>()
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return false
    visited.add(value)
    const candidate = value as Record<string, unknown>
    if (candidate.sourceId === DEM_SOURCE || candidate.source === DEM_SOURCE || candidate.id === DEM_SOURCE) return true
    return ['source', 'tile', 'error', 'cause'].some(key => inspect(candidate[key], depth + 1))
  }
  return inspect(event, 0)
}

/**
 * Borrow the mounted 2D map as a DEM sampler and texture camera. Every exit
 * restores it immediately, including external aborts while an await is pending.
 */
export function sampleSandbox(map: MapLibreMap, points: readonly TrackPoint[], options: {
  signal: AbortSignal
  textureEnabled: boolean
  settings?: MapSettings
  /** Detached maps fill their own viewport; mounted transaction compatibility keeps 24px. */
  padding?: number
  maxZoom?: number
}): Promise<SamplingResult> {
  if (options.signal.aborted) return Promise.reject(abortError())
  const bounds = sandboxBounds(points)
  if (!bounds) return Promise.reject(new Error('这条轨迹暂时无法生成沙盘地形'))
  if (!map.getStyle()) return Promise.reject(new Error('地图正在初始化，请稍后重试'))
  if (map.getSource(DEM_SOURCE)) return Promise.reject(new Error('沙盘地形仍在生成，请稍后重试'))

  const style = map.style
  const center = map.getCenter()
  const camera = { center: [center.lng, center.lat] as [number, number], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: { ...map.getPadding() } }
  const previousTerrain = map.getTerrain()
  const settings = options.settings ?? DEFAULT_MAP_SETTINGS
  const provider = terrainProviderFor(settings)
  const terrain = createTerrainGrid(bounds, settings.quality)
  const visibility = new Map<string, unknown>()
  let ownedSource: ReturnType<MapLibreMap['getSource']>
  let sourceAdded = false
  let active = true
  let removed = false
  let successfulDEMTile = false
  const decodedTiles = new Map<string, DecodedTile>()
  let textureUnavailable = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const cancelWaits = new Set<() => void>()

  return new Promise<SamplingResult>((resolve, reject) => {
    const sameStyle = () => !removed && map.style === style
    const sameSource = () => sameStyle() && (!ownedSource || map.getSource(DEM_SOURCE) === ownedSource)
    const assertActive = () => {
      if (!active) throw abortError()
      if (!sameSource()) throw new Error('地图样式已切换，请重新生成沙盘')
    }
    const restore = () => {
      if (deadline !== undefined) clearTimeout(deadline)
      options.signal.removeEventListener('abort', aborted)
      map.off('error', error)
      map.off('sourcedata', sourceData)
      map.off('styledata', styleData)
      map.off('remove', mapRemoved)
      for (const cancel of [...cancelWaits]) cancel()
      // Never let an old transaction restore terrain or camera into a new style.
      if (!sameSource()) return
      attempt(() => map.setTerrain(previousTerrain))
      for (const [id, prior] of visibility) {
        attempt(() => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', prior)
        })
      }
      attempt(() => map.jumpTo(camera))
      if (sourceAdded && map.getSource(DEM_SOURCE)) attempt(() => map.removeSource(DEM_SOURCE))
      attempt(() => map.triggerRepaint())
    }
    const finish = (result?: SamplingResult, reason?: unknown) => {
      if (!active) return
      active = false
      restore()
      if (result) resolve(result)
      else reject(reason)
    }
    const aborted = () => finish(undefined, abortError())
    const error = (event: unknown) => {
      if (!active) return
      if (isSandboxDEMError(event)) finish(undefined, new Error('地形高程加载失败，请检查网络后重试'))
      else textureUnavailable = true
    }
    const sourceData = (event: SourceEvent) => {
      if (event.sourceId !== DEM_SOURCE) return
      // isSourceLoaded alone also becomes true after failed or empty requests.
      // A decoded DEM tile is the evidence that real elevation data arrived.
      if (event.tile?.state === 'loaded' && event.tile.dem) {
        const tile = event.tile.tileID?.canonical
        if (!tile || ![tile.z, tile.x, tile.y].every(Number.isInteger) || tile.z < 0 || tile.z > provider.maxzoom
          || tile.x < 0 || tile.x >= 2 ** tile.z || tile.y < 0 || tile.y >= 2 ** tile.z) {
          finish(undefined, new Error('地形瓦片坐标无效，请重新生成沙盘'))
          return
        }
        successfulDEMTile = true
        decodedTiles.set(`${tile.z}/${tile.x}/${tile.y}`, {...tile, dem: event.tile.dem})
      }
    }
    const styleData = () => {
      if (active && !sameSource()) finish(undefined, new Error('地图样式已切换，请重新生成沙盘'))
    }
    const mapRemoved = () => {
      removed = true
      finish(undefined, abortError())
    }

    /** Each wait unregisters on normal completion as well as synchronous abort. */
    const waitUntil = (events: string[], ready: (event?: unknown) => boolean, repaint = false, timeout?: number): Promise<boolean> => {
      assertActive()
      if (ready()) return Promise.resolve(true)
      return new Promise<boolean>((done, fail) => {
        let pending = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          pending = false
          for (const name of events) map.off(name, check)
          cancelWaits.delete(cancel)
          if (timer !== undefined) clearTimeout(timer)
        }
        const cancel = () => {
          if (!pending) return
          cleanup()
          fail(abortError())
        }
        const check = (event?: unknown) => {
          if (!pending) return
          try {
            assertActive()
            if (!ready(event)) return
            cleanup()
            done(true)
          } catch (reason) {
            cleanup()
            fail(reason)
          }
        }
        cancelWaits.add(cancel)
        for (const name of events) map.on(name, check)
        if (timeout !== undefined) timer = setTimeout(() => {
          if (!pending) return
          cleanup()
          done(false)
        }, timeout)
        if (repaint) map.triggerRepaint()
      })
    }
    // Yield CPU sampling without requiring another full-resolution WebGL frame.
    // Track the task so external aborts also cancel its timer synchronously.
    const yieldSampling = () => new Promise<void>((done, fail) => {
      assertActive()
      const cancel = () => {
        clearTimeout(timer)
        cancelWaits.delete(cancel)
        fail(abortError())
      }
      const timer = setTimeout(() => {
        cancelWaits.delete(cancel)
        try { assertActive(); done() } catch (reason) { fail(reason) }
      }, 0)
      cancelWaits.add(cancel)
    })

    const run = async () => {
      map.on('error', error)
      map.on('sourcedata', sourceData)
      map.on('styledata', styleData)
      map.on('remove', mapRemoved)
      options.signal.addEventListener('abort', aborted, { once: true })
      deadline = setTimeout(() => finish(undefined, new Error('地形高程加载超过 30 秒，请检查网络或切换高程来源后重试')), DEM_DEADLINE_MS)
      // Save layer visibility before any map event can interrupt the transaction.
      for (const id of TRACK_LAYERS) {
        if (map.getLayer(id)) visibility.set(id, map.getLayoutProperty(id, 'visibility'))
      }
      sourceAdded = true
      map.addSource(DEM_SOURCE, {
        type: 'raster-dem',
        ...(provider.url ? {url: provider.url} : {tiles: provider.tiles}),
        tileSize: provider.tileSize,
        encoding: provider.encoding,
        maxzoom: provider.maxzoom,
        bounds,
        attribution: provider.credits.map(credit => `<a href="${credit.url}" target="_blank" rel="noopener noreferrer">${credit.label}</a>`).join(' | '),
      })
      ownedSource = map.getSource(DEM_SOURCE)
      assertActive()
      map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: options.padding ?? 24, maxZoom: options.maxZoom ?? provider.maxzoom + 2, pitch: 0, bearing: 0, duration: 0 })
      // queryTerrainElevation includes this exaggeration. Keep raw metres here.
      map.setTerrain({ source: DEM_SOURCE, exaggeration: 1 })
      await waitUntil(['sourcedata', 'render'], () => successfulDEMTile && map.isSourceLoaded(DEM_SOURCE), true)
      assertActive()
      // The network budget ends once decoded elevation is ready. Sampling and
      // optional imagery must not turn successful DEM into a network timeout.
      clearTimeout(deadline)
      deadline = undefined
      const coverage = [...decodedTiles.values()].sort((a, b) => b.z - a.z)
      for (let row = 0; row < terrain.rows; row++) {
        assertActive()
        // Keep cancellation and UI responsive even when map paints are throttled.
        if (row > 0 && row % 16 === 0) await yieldSampling()
        assertActive()
        for (let column = 0; column < terrain.columns; column++) {
          if (!active || options.signal.aborted) throw abortError()
          const coordinate = gridCoordinate(column, row, terrain)
          // MapLibre suppresses 404 errors while trying parents, and its query
          // returns zero for missing DEM. Check decoded tile coverage so that
          // a partially failed source cannot invent sea-level holes in a hill.
          const tile = coverage.find(tile => {
            const scale = 2 ** tile.z
            const x = (coordinate[0] + 180) / 360 * scale
            const y = mercatorY(coordinate[1]) * scale
            return x >= tile.x - 1e-8 && x <= tile.x + 1 + 1e-8 && y >= tile.y - 1e-8 && y <= tile.y + 1 + 1e-8
          })
          if (!tile) throw new Error('这片区域的地形高程不完整，请重试')
          const elevation = readDecodedDEMElevation(tile, coordinate) ?? map.queryTerrainElevation(coordinate)
          if (elevation === null || !Number.isFinite(elevation)) throw new Error('这片区域的地形高程不完整，请重试')
          terrain.elevations.push(elevation)
        }
      }
      let texture: HTMLCanvasElement | null = null
      if (options.textureEnabled && !textureUnavailable) {
        // Give optional basemap imagery a bounded grace period. A stalled image
        // must not throw away a DEM model that has already loaded successfully.
        const ready = await waitUntil(['idle', 'sourcedata', 'render'], () => textureUnavailable || map.areTilesLoaded(), true, 1000)
        assertActive()
        if (ready && !textureUnavailable) {
          try {
            for (const id of visibility.keys()) map.setLayoutProperty(id, 'visibility', 'none')
            map.setTerrain(null)
            const painted = await waitUntil(['render'], event => event !== undefined, true, TEXTURE_PAINT_MS)
            assertActive()
            if (painted && !textureUnavailable) texture = copyTexture(map, bounds, settings.quality)
          } catch (reason) {
            assertActive()
            textureUnavailable = true
          }
        }
        if (!texture) textureUnavailable = true
      }
      assertActive()
      finish({ terrain, texture, textureUnavailable: options.textureEnabled && textureUnavailable })
    }
    void run().catch(reason => finish(undefined, reason))
  })
}

function copyTexture(map: MapLibreMap, bounds: TerrainGrid['bounds'], quality: SandboxQuality): HTMLCanvasElement | null {
  const source = map.getCanvas()
  if (!source.clientWidth || !source.clientHeight) return null
  const northWest = map.project([bounds[0], bounds[3]])
  const southEast = map.project([bounds[2], bounds[1]])
  const left = Math.max(0, Math.min(northWest.x, southEast.x))
  const top = Math.max(0, Math.min(northWest.y, southEast.y))
  const right = Math.min(source.clientWidth, Math.max(northWest.x, southEast.x))
  const bottom = Math.min(source.clientHeight, Math.max(northWest.y, southEast.y))
  if (right <= left || bottom <= top) return null
  const scaleX = source.width / source.clientWidth
  const scaleY = source.height / source.clientHeight
  const width = (right - left) * scaleX
  const height = (bottom - top) * scaleY
  const scale = Math.min(1, SANDBOX_QUALITY_BUDGETS[quality].texture / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(source, left * scaleX, top * scaleY, width, height, 0, 0, canvas.width, canvas.height)
  return canvas
}

function abortError(): DOMException { return new DOMException('沙盘生成已取消', 'AbortError') }
function attempt(action: () => void): void { try { action() } catch { /* Disposed map or replaced style. */ } }




export interface DetachedSandboxOptions {
  signal: AbortSignal
  settings: MapSettings
  textureEnabled: boolean
  style?: StyleSpecification | string
}

/**
 * Own a short-lived offscreen MapLibre camera at actual texture resolution.
 * No camera, terrain source, style, or layer on the visible map is borrowed.
 */
export async function sampleSandboxDetached(points: readonly TrackPoint[], options: DetachedSandboxOptions): Promise<SamplingResult> {
  if (options.signal.aborted) throw abortError()
  const bounds = sandboxBounds(points)
  if (!bounds) throw new Error('这条轨迹暂时无法生成沙盘地形')
  const terrain = createTerrainGrid(bounds, options.settings.quality)
  const textureRequested = options.textureEnabled && options.settings.basemap !== 'none' && options.settings.basemap !== 'osm'
  const budget = SANDBOX_QUALITY_BUDGETS[options.settings.quality].texture
  const container = document.createElement('div')
  container.className = 'trk-sandbox-sampler'
  container.setAttribute('aria-hidden', 'true')
  const resizeContainer = (size: number) => {
    const longest = Math.max(terrain.widthMeters, terrain.depthMeters)
    const width = Math.max(1, Math.round(terrain.widthMeters / longest * size))
    const height = Math.max(1, Math.round(terrain.depthMeters / longest * size))
    container.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;pointer-events:none;opacity:0`
  }
  resizeContainer(textureRequested ? budget : Math.min(1024, budget))
  document.body.appendChild(container)
  let map: MapLibreMap | null = null
  let textureFailed = false
  try {
    const {Map} = await import('maplibre-gl')
    if (options.signal.aborted) throw abortError()
    // An OSM choice always uses a blank sampler: no hidden public OSM requests.
    map = new Map({
      container, style: textureRequested ? options.style ?? styleFor(options.settings.basemap, options.settings) : BLANK_STYLE,
      bounds: [[bounds[0], bounds[1]], [bounds[2], bounds[3]]], fitBoundsOptions: {padding: 0, maxZoom: 22},
      interactive: false, attributionControl: false, trackResize: false, pixelRatio: 1,
      maxCanvasSize: [budget, budget], fadeDuration: 0,
      canvasContextAttributes: {antialias: true, preserveDrawingBuffer: true},
    })
    const loaded = await waitForSamplerStyle(map, options.signal)
    if (!loaded) {
      textureFailed = textureRequested
      map.setStyle(BLANK_STYLE)
      if (!await waitForSamplerStyle(map, options.signal)) throw new Error('沙盘采样地图初始化失败，请重试')
    }
    if (textureRequested && !textureFailed) {
      try {
        const canvas = map.getCanvas()
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
        if (gl) {
          const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
          const limits = [budget, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), viewport?.[0], viewport?.[1]]
            .filter((limit): limit is number => typeof limit === 'number' && Number.isFinite(limit) && limit > 0)
          resizeContainer(Math.min(...limits))
          map.resize()
        }
      } catch {
        textureFailed = true
      }
    }
    const result = await sampleSandbox(map, points, {
      signal: options.signal, settings: options.settings, textureEnabled: textureRequested && !textureFailed,
      padding: 0, maxZoom: 22,
    })
    return {...result, textureUnavailable: result.textureUnavailable || textureFailed}
  } finally {
    try { map?.remove() } finally { container.remove() }
  }
}

/** Style failures degrade imagery; DEM failures remain an explicit error. */
function waitForSamplerStyle(map: MapLibreMap, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(abortError())
  if (map.isStyleLoaded()) return Promise.resolve(true)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (ready: boolean, error?: DOMException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      map.off('style.load', loaded)
      map.off('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(ready)
    }
    const loaded = () => finish(true)
    const failed = () => finish(false)
    const aborted = () => finish(false, abortError())
    const timer = setTimeout(() => finish(false), 5000)
    map.on('style.load', loaded)
    map.on('error', failed)
    signal.addEventListener('abort', aborted, {once: true})
    // Handle styles that completed between the first readiness check and listeners.
    if (map.isStyleLoaded()) finish(true)
  })
}

interface DecodedDEM {dim: number; get(x: number, y: number): number}
type DecodedTile = {z: number; x: number; y: number; dem?: unknown}

/**
 * Match MapLibre's native DEM bilinear interpolation in raw metres. Reading a
 * decoded tile avoids queryTerrainElevation recomputing coveringTiles per point.
 */
export function readDecodedDEMElevation(tile: DecodedTile, coordinate: [number, number]): number | null {
  const dem = tile.dem as Partial<DecodedDEM> | undefined
  if (!dem || !Number.isInteger(dem.dim) || !dem.dim || dem.dim < 1 || typeof dem.get !== 'function') return null
  const scale = 2 ** tile.z
  const x = Math.max(0, Math.min(1, (coordinate[0] + 180) / 360 * scale - tile.x)) * dem.dim
  const y = Math.max(0, Math.min(1, mercatorY(coordinate[1]) * scale - tile.y)) * dem.dim
  // DEMData carries one backfilled border pixel at dim. At the east/south edge
  // use the last interior cell plus that border, never an out-of-range dim + 1.
  const cx = Math.min(dem.dim - 1, Math.floor(x))
  const cy = Math.min(dem.dim - 1, Math.floor(y))
  const tx = x - cx
  const ty = y - cy
  return dem.get(cx, cy) * (1 - tx) * (1 - ty)
    + dem.get(cx + 1, cy) * tx * (1 - ty)
    + dem.get(cx, cy + 1) * (1 - tx) * ty
    + dem.get(cx + 1, cy + 1) * tx * ty
}
