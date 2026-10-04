// @vitest-environment jsdom
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEM_SOURCE, isSandboxDEMError, sampleSandbox, sampleSandboxDetached, readDecodedDEMElevation } from '../src/track/sandbox/sampling.ts'
import { TRACK_CASING, TRACK_END, TRACK_LINE, TRACK_START } from '../src/track/trail-layer.ts'
import type { TrackPoint } from '../src/protocol.ts'

import { DEFAULT_MAP_SETTINGS } from '../src/track/map-settings.ts'
import { BLANK_STYLE } from '../src/track/basemaps.ts'

const detachedRuntime = vi.hoisted(() => ({map: null as unknown, create: vi.fn()}))
vi.mock('maplibre-gl', () => ({
  Map: vi.fn(function(options: unknown) {
    detachedRuntime.create(options)
    return detachedRuntime.map
  }),
}))

const POINTS: TrackPoint[] = [[120, 30, null, null], [120.02, 30.01, null, null]]
const LAYERS = [TRACK_CASING, TRACK_LINE, TRACK_START, TRACK_END]
type Listener = (event: unknown) => void

function makeMap() {
  const listeners = new Map<string, Set<Listener>>()
  const sources = new Map<string, {id: string}>()
  const layouts = new Map<string, unknown>([[TRACK_CASING, undefined], [TRACK_LINE, 'visible'], [TRACK_START, 'none'], [TRACK_END, 'visible']])
  const original = {center: [118, 28] as [number, number], zoom: 8, pitch: 25, bearing: 12, padding: {top: 6, left: 7, bottom: 8, right: 9}}
  const previousTerrain = {source: 'previous-dem', exaggeration: 2}
  const state = {camera: {...original}, terrain: previousTerrain as typeof previousTerrain | null, loaded: false, tilesLoaded: true, autoPaint: true, elevation: 600 as number | null}
  const fire = (type: string, event: unknown = {}) => {
    for (const listener of [...listeners.get(type) ?? []]) listener(event)
  }
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = 3200
  sourceCanvas.height = 1600
  Object.defineProperties(sourceCanvas, {clientWidth: {value: 800}, clientHeight: {value: 400}})
  const calls = {
    style: {},
    isStyleLoaded: vi.fn(() => true),
    setStyle: vi.fn(() => {}),
    resize: vi.fn(),
    remove: vi.fn(() => fire('remove')),

    getStyle: vi.fn(() => ({version: 8, sources: {}, layers: []})),
    getCenter: vi.fn(() => ({lng: state.camera.center[0], lat: state.camera.center[1]})),
    getZoom: vi.fn(() => state.camera.zoom),
    getPitch: vi.fn(() => state.camera.pitch),
    getBearing: vi.fn(() => state.camera.bearing),
    getPadding: vi.fn(() => state.camera.padding),
    getTerrain: vi.fn(() => state.terrain),
    setTerrain: vi.fn((terrain: typeof state.terrain) => {state.terrain = terrain}),
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string) => {sources.set(id, {id})}),
    removeSource: vi.fn((id: string) => {sources.delete(id)}),
    getLayer: vi.fn((id: string) => LAYERS.includes(id) ? {id} : undefined),
    getLayoutProperty: vi.fn((id: string) => layouts.get(id)),
    setLayoutProperty: vi.fn((id: string, _property: string, value: unknown) => {layouts.set(id, value)}),
    fitBounds: vi.fn(() => {state.camera = {...state.camera, center: [120, 30], pitch: 0, bearing: 0, zoom: 13}}),
    jumpTo: vi.fn((camera: typeof original) => {state.camera = camera}),
    isSourceLoaded: vi.fn(() => state.loaded),
    areTilesLoaded: vi.fn(() => state.tilesLoaded),
    queryTerrainElevation: vi.fn(() => state.loaded ? state.elevation : 0),
    triggerRepaint: vi.fn(() => {if (state.autoPaint) void Promise.resolve().then(() => fire('render'))}),
    getCanvas: vi.fn(() => sourceCanvas),
    project: vi.fn((point: number[]) => ({x: point[0] < 120 ? 20 : 780, y: point[1] > 30 ? 20 : 380})),
    on: vi.fn((event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    }),
    off: vi.fn((event: string, listener: Listener) => {listeners.get(event)?.delete(listener)}),
  }
  const loadDEM = (loaded = true) => {
    state.loaded = loaded
    fire('sourcedata', {sourceId: DEM_SOURCE, isSourceLoaded: loaded, tile: {state: 'loaded', dem: {}, tileID: {canonical: {z: 0, x: 0, y: 0}}}})
  }
  const assertRestored = () => {
    expect(state.camera).toEqual(original)
    expect(state.terrain).toEqual(previousTerrain)
    expect([...layouts.values()]).toEqual([undefined, 'visible', 'none', 'visible'])
    expect(sources.has(DEM_SOURCE)).toBe(false)
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  }
  return {map: calls as unknown as MapLibreMap, calls, state, layouts, listeners, sources, fire, loadDEM, assertRestored}
}

async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve() }
async function settle<T>(result: Promise<T>): Promise<T> {
  let outcome: {value: T} | {reason: unknown} | undefined
  void result.then(value => {outcome = {value}}, reason => {outcome = {reason}})
  await flush()
  // Advance only short tasks and optional texture waits, never the DEM deadline.
  for (let step = 0; !outcome && step < 4; step++) await vi.advanceTimersByTimeAsync(1000)
  if (!outcome) throw new Error('Sampling did not settle within short timer steps')
  if ('reason' in outcome) throw outcome.reason
  return outcome.value
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('sandbox DEM sampling transaction', () => {
  it('requires a successfully decoded DEM tile, not metadata, generic idle or numeric zeros', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    fake.state.loaded = true
    fake.fire('sourcedata', {sourceId: DEM_SOURCE, sourceDataType: 'metadata', isSourceLoaded: true})
    fake.fire('idle')
    await flush()
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.loadDEM()
    const sampled = await settle(result)
    expect(sampled.terrain.elevations).toHaveLength(sampled.terrain.columns * sampled.terrain.rows)
    expect(sampled.terrain.elevations.every(elevation => elevation === 600)).toBe(true)
    expect(sampled.texture).toBeNull()
    expect(sampled.textureUnavailable).toBe(false)
    expect(fake.calls.addSource).toHaveBeenCalledWith(DEM_SOURCE, expect.objectContaining({type: 'raster-dem', tileSize: 512, encoding: 'terrarium', maxzoom: 12, bounds: sampled.terrain.bounds}))
    expect(fake.calls.setTerrain).toHaveBeenCalledWith({source: DEM_SOURCE, exaggeration: 1})
    expect(fake.calls.fitBounds).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({maxZoom: 14, pitch: 0, bearing: 0, duration: 0}))
    fake.assertRestored()
  })

  it('accepts real sea-level zeros after DEM readiness and never reads file elevation', async () => {
    const fake = makeMap()
    fake.state.elevation = 0
    const result = sampleSandbox(fake.map, [[120, 30, 1900, null], [120.02, 30.01, 2200, null]], {signal: new AbortController().signal, textureEnabled: false})
    fake.loadDEM(false)
    await flush()
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.state.loaded = true
    fake.fire('render')
    expect((await settle(result)).terrain.elevations.every(elevation => elevation === 0)).toBe(true)
    fake.assertRestored()
  })

  it('rejects DEM errors even when failed requests leave the source marked loaded', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('地形高程加载失败')
    fake.state.loaded = true
    fake.fire('error', {tile: {source: {id: DEM_SOURCE}}, error: new Error('HTTP 404')})
    await rejected
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.assertRestored()
  })

  it('keeps successful terrain when a basemap tile fails', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: true})
    fake.fire('error', {sourceId: 'basemap', error: new Error('Offline image')})
    fake.loadDEM()
    const sampled = await settle(result)
    expect(sampled.terrain.elevations[0]).toBe(600)
    expect(sampled.texture).toBeNull()
    expect(sampled.textureUnavailable).toBe(true)
    expect(fake.calls.setLayoutProperty).not.toHaveBeenCalledWith(TRACK_LINE, 'visibility', 'none')
    fake.assertRestored()
  })

  it('captures a cropped texture after hiding all track layers and turning terrain off, capped to the standard 2048 pixel budget', async () => {
    const fake = makeMap()
    const drawImage = vi.fn(() => {
      expect([...fake.layouts.values()]).toEqual(['none', 'none', 'none', 'none'])
      expect(fake.state.terrain).toBeNull()
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D)
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: true})
    fake.loadDEM()
    const sampled = await settle(result)
    expect(sampled.texture?.width).toBe(2048)
    expect(sampled.texture?.height).toBe(970)
    expect(sampled.textureUnavailable).toBe(false)
    expect(drawImage).toHaveBeenCalledTimes(1)
    fake.assertRestored()
  })

  it('degrades a tainted canvas or missing 2D context to a terrain model', async () => {
    const fake = makeMap()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {throw new Error('Canvas unavailable')})
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: true})
    fake.loadDEM()
    expect(await settle(result)).toMatchObject({texture: null, textureUnavailable: true})
    fake.assertRestored()
  })

  it('gives stalled basemap tiles a bounded grace period and still returns real terrain', async () => {
    const fake = makeMap()
    fake.state.tilesLoaded = false
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: true})
    fake.loadDEM()
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await settle(result)).toMatchObject({texture: null, textureUnavailable: true})
    fake.assertRestored()
  })

  it('accepts decoded DEM arriving after ten seconds but before the thirty-second network deadline', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    let completed = false
    void result.then(() => {completed = true}, () => {completed = true})
    await vi.advanceTimersByTimeAsync(12_000)
    expect(completed).toBe(false)
    expect(fake.sources.has(DEM_SOURCE)).toBe(true)
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.loadDEM()
    const sampled = await settle(result)
    expect(sampled.terrain.elevations).toHaveLength(sampled.terrain.rows * sampled.terrain.columns)
    expect(sampled.terrain.elevations.every(elevation => elevation === 600)).toBe(true)
    fake.assertRestored()
  })

  it('lets ready DEM sampling finish beyond the network deadline without a false timeout', async () => {
    const fake = makeMap()
    fake.state.autoPaint = false
    const started = Date.now()
    const result = sampleSandbox(fake.map, POINTS, {
      signal: new AbortController().signal, textureEnabled: false, settings: {...DEFAULT_MAP_SETTINGS, quality: 'fine'},
    })
    // Attach a rejection observer before advancing across the old deadline.
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.loadDEM(); await flush()
    expect(fake.calls.queryTerrainElevation.mock.calls.length).toBeGreaterThan(256)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(Date.now() - started).toBeGreaterThan(30_000)
    const sampled = await settle(result)
    expect(sampled.terrain.elevations).toHaveLength(sampled.terrain.rows * sampled.terrain.columns)
    expect(sampled.terrain.elevations.every(elevation => elevation === 600)).toBe(true)
    fake.assertRestored()
  })

  it('samples every grid point when MapLibre render events stop after decoded DEM is ready', async () => {
    const fake = makeMap()
    fake.state.autoPaint = false
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    fake.loadDEM()
    const sampled = await settle(result)
    expect(sampled.terrain.elevations).toHaveLength(sampled.terrain.rows * sampled.terrain.columns)
    expect(fake.calls.queryTerrainElevation).toHaveBeenCalledTimes(sampled.terrain.elevations.length)
    expect(sampled.terrain.elevations.every(elevation => elevation === 600)).toBe(true)
    expect(sampled.textureUnavailable).toBe(false)
    fake.assertRestored()
  })

  it('returns completed DEM after exactly one second without a final texture render frame', async () => {
    const fake = makeMap()
    fake.state.autoPaint = false
    let texturePaintAt: number | undefined
    fake.calls.triggerRepaint.mockImplementation(() => {
      if (fake.state.terrain === null) texturePaintAt = Date.now()
    })
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D)
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: true})
    let completed = false
    void result.then(() => {completed = true}, () => {completed = true})
    fake.loadDEM(); await flush(); await vi.advanceTimersByTimeAsync(100)
    expect(texturePaintAt).toBeDefined()
    expect(completed).toBe(false)
    expect([...fake.layouts.values()]).toEqual(['none', 'none', 'none', 'none'])
    const remaining = 1000 - (Date.now() - texturePaintAt!)
    expect(remaining).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(remaining - 1)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const sampled = await settle(result)
    expect(completed).toBe(true)
    expect(sampled).toMatchObject({texture: null, textureUnavailable: true})
    expect(sampled.terrain.elevations).toHaveLength(sampled.terrain.rows * sampled.terrain.columns)
    expect(sampled.terrain.elevations.every(elevation => elevation === 600)).toBe(true)
    expect(drawImage).not.toHaveBeenCalled()
    fake.assertRestored()
  })

  it('times out pending DEM data after exactly 30 seconds and cleans every resource', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('地形高程加载超过 30 秒，请检查网络或切换高程来源后重试')
    await vi.advanceTimersByTimeAsync(29999)
    expect(fake.sources.has(DEM_SOURCE)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    fake.assertRestored()
  })

  it('restores synchronously on external cancellation before late data or paints can run', async () => {
    const fake = makeMap()
    const controller = new AbortController()
    const result = sampleSandbox(fake.map, POINTS, {signal: controller.signal, textureEnabled: false})
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'})
    controller.abort()
    fake.assertRestored()
    const count = fake.calls.jumpTo.mock.calls.length
    fake.loadDEM()
    await rejected
    await flush()
    expect(fake.calls.jumpTo).toHaveBeenCalledTimes(count)
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
  })

  it('restores all layers synchronously when cancelled during the texture paint', async () => {
    const fake = makeMap()
    const controller = new AbortController()
    const result = sampleSandbox(fake.map, POINTS, {signal: controller.signal, textureEnabled: true})
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'})
    fake.calls.triggerRepaint.mockImplementation(() => {
      if (fake.state.terrain === null) return
      void Promise.resolve().then(() => fake.fire('render'))
    })
    fake.loadDEM()
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect([...fake.layouts.values()]).toEqual(['none', 'none', 'none', 'none'])
    controller.abort()
    fake.assertRestored()
    await rejected
  })

  it('does not restore an old camera, terrain or source into a replacement style', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('地图样式已切换')
    fake.calls.style = {}
    fake.sources.clear()
    fake.fire('styledata')
    await rejected
    expect(fake.calls.jumpTo).not.toHaveBeenCalled()
    expect(fake.calls.removeSource).not.toHaveBeenCalled()
    expect([...fake.listeners.values()].every(set => set.size === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels without map mutations after MapLibre is removed', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'})
    fake.fire('remove')
    await rejected
    expect(fake.calls.jumpTo).not.toHaveBeenCalled()
    expect(fake.calls.removeSource).not.toHaveBeenCalled()
    expect([...fake.listeners.values()].every(set => set.size === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects decoded DEM events with malformed canonical tile metadata', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('地形瓦片坐标无效')
    fake.state.loaded = true
    fake.fire('sourcedata', {sourceId: DEM_SOURCE, isSourceLoaded: true, tile: {state: 'loaded', dem: {}}})
    await rejected
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.assertRestored()
  })
  it('rejects partial silent tile failures instead of converting missing DEM to sea-level holes', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('地形高程不完整')
    fake.state.loaded = true
    // This decoded tile covers a different area; MapLibre may otherwise report
    // the source complete after adjacent 404s without emitting an error.
    fake.fire('sourcedata', {sourceId: DEM_SOURCE, isSourceLoaded: true, tile: {state: 'loaded', dem: {}, tileID: {canonical: {z: 12, x: 3410, y: 1687}}}})
    await rejected
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.assertRestored()
  })
  it('rejects incomplete elevation coverage rather than inventing a flat model', async () => {
    const fake = makeMap()
    fake.state.elevation = null
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('地形高程不完整')
    fake.loadDEM()
    await rejected
    fake.assertRestored()
  })

  it('rejects a pre-aborted operation before borrowing the map', async () => {
    const fake = makeMap()
    const controller = new AbortController()
    controller.abort()
    await expect(sampleSandbox(fake.map, POINTS, {signal: controller.signal, textureEnabled: false})).rejects.toMatchObject({name: 'AbortError'})
    expect(fake.calls.addSource).not.toHaveBeenCalled()
    expect(fake.calls.fitBounds).not.toHaveBeenCalled()
  })
})

describe('DEM source error identity', () => {
  it('finds the source id in public and nested source errors without mistaking basemap errors', () => {
    expect(isSandboxDEMError({sourceId: DEM_SOURCE})).toBe(true)
    expect(isSandboxDEMError({source: {id: DEM_SOURCE}})).toBe(true)
    expect(isSandboxDEMError({error: {cause: {tile: {source: DEM_SOURCE}}}})).toBe(true)
    expect(isSandboxDEMError({sourceId: 'basemap'})).toBe(false)
    expect(isSandboxDEMError(new Error('Offline'))).toBe(false)
    expect(isSandboxDEMError(null)).toBe(false)
    const cycle: {cause?: unknown} = {}
    cycle.cause = cycle
    expect(isSandboxDEMError(cycle)).toBe(false)
  })
})



describe('provider-aware and detached sandbox sampling', () => {
  it('accepts MapTiler z14 DEM metadata and samples raw metres with its encoding', async () => {
    const fake = makeMap()
    const settings = {...DEFAULT_MAP_SETTINGS, terrainProvider: 'maptiler' as const, maptilerKey: 'private-key', quality: 'eco' as const}
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false, settings})
    fake.state.loaded = true
    const longitude = (120 + 180) / 360 * 2 ** 14
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + 30 * Math.PI / 360)) / Math.PI) / 2 * 2 ** 14
    // A world-covering decoded parent plus a legitimate high-zoom MapTiler tile.
    fake.loadDEM()
    fake.fire('sourcedata', {sourceId: DEM_SOURCE, tile: {state: 'loaded', dem: {}, tileID: {canonical: {z: 14, x: Math.floor(longitude), y: Math.floor(y)}}}})
    const sampled = await settle(result)
    expect(Math.max(sampled.terrain.columns, sampled.terrain.rows)).toBe(96)
    expect(fake.calls.addSource).toHaveBeenCalledWith(DEM_SOURCE, expect.objectContaining({
      encoding: 'mapbox', maxzoom: 14, url: expect.stringContaining('terrain-rgb-v2/tiles.json'),
    }))
    expect(fake.calls.setTerrain).toHaveBeenCalledWith({source: DEM_SOURCE, exaggeration: 1})
    fake.assertRestored()
  })

  it('aborts asynchronously while a fine grid batch is yielded and cancels its remaining task', async () => {
    const fake = makeMap()
    fake.state.autoPaint = false
    const controller = new AbortController()
    const result = sampleSandbox(fake.map, POINTS, {
      signal: controller.signal, textureEnabled: false, settings: {...DEFAULT_MAP_SETTINGS, quality: 'fine'},
    })
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'})
    fake.loadDEM(); await flush()
    const sampledBeforeAbort = fake.calls.queryTerrainElevation.mock.calls.length
    expect(sampledBeforeAbort).toBeGreaterThan(256)
    expect(sampledBeforeAbort).toBeLessThan(256 * 256)
    expect(vi.getTimerCount()).toBe(1)
    await Promise.resolve().then(() => {controller.abort(); fake.assertRestored()})
    await rejected
    fake.loadDEM(); fake.fire('render')
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.calls.queryTerrainElevation).toHaveBeenCalledTimes(sampledBeforeAbort)
    fake.assertRestored()
  })

  it('owns and releases an OSM-free sampler without touching a mounted map', async () => {
    const sampler = makeMap()
    const mounted = makeMap()
    detachedRuntime.map = sampler.map
    detachedRuntime.create.mockClear()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const result = sampleSandboxDetached(POINTS, {
      signal: new AbortController().signal, textureEnabled: true, settings: {...DEFAULT_MAP_SETTINGS, basemap: 'osm'},
    })
    await flush()
    expect(detachedRuntime.create).toHaveBeenCalledWith(expect.objectContaining({
      style: BLANK_STYLE, pixelRatio: 1, interactive: false,
    }))
    sampler.loadDEM()
    expect(await settle(result)).toMatchObject({texture: null, textureUnavailable: false})
    expect(sampler.calls.remove).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.trk-sandbox-sampler')).toBeNull()
    expect(mounted.calls.addSource).not.toHaveBeenCalled()
    expect(mounted.calls.fitBounds).not.toHaveBeenCalled()
    expect([...sampler.listeners.values()].every(set => set.size === 0)).toBe(true)
  })

  it('releases the detached sampler after the thirty-second DEM timeout and ignores late events', async () => {
    const sampler = makeMap()
    detachedRuntime.map = sampler.map
    const result = sampleSandboxDetached(POINTS, {
      signal: new AbortController().signal, textureEnabled: false, settings: {...DEFAULT_MAP_SETTINGS},
    })
    const rejected = expect(result).rejects.toThrow('地形高程加载超过 30 秒，请检查网络或切换高程来源后重试')
    await flush()
    expect(document.querySelector('.trk-sandbox-sampler')).not.toBeNull()
    expect(sampler.sources.has(DEM_SOURCE)).toBe(true)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(sampler.calls.remove).not.toHaveBeenCalled()
    expect(document.querySelector('.trk-sandbox-sampler')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(sampler.calls.remove).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.trk-sandbox-sampler')).toBeNull()
    sampler.assertRestored()
    sampler.loadDEM(); sampler.fire('render')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sampler.calls.queryTerrainElevation).not.toHaveBeenCalled()
    expect(sampler.calls.remove).toHaveBeenCalledTimes(1)
    sampler.assertRestored()
  })

  it('cleans the detached map, style listeners and timer after abort during style loading', async () => {
    const sampler = makeMap()
    sampler.calls.isStyleLoaded.mockReturnValue(false)
    detachedRuntime.map = sampler.map
    const controller = new AbortController()
    const result = sampleSandboxDetached(POINTS, {
      signal: controller.signal, textureEnabled: false, settings: {...DEFAULT_MAP_SETTINGS},
    })
    const rejected = expect(result).rejects.toMatchObject({name: 'AbortError'})
    await flush()
    expect(document.querySelector('.trk-sandbox-sampler')).not.toBeNull()
    controller.abort()
    await rejected
    expect(sampler.calls.remove).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.trk-sandbox-sampler')).toBeNull()
    expect([...sampler.listeners.values()].every(set => set.size === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses a real fine texture viewport but clamps dimensions to GPU capability', async () => {
    const sampler = makeMap()
    detachedRuntime.map = sampler.map
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => {
      if (kind === '2d') return {drawImage} as unknown as CanvasRenderingContext2D
      return {
        MAX_VIEWPORT_DIMS: 1, MAX_TEXTURE_SIZE: 2, MAX_RENDERBUFFER_SIZE: 3,
        getParameter: (parameter: number) => parameter === 1 ? new Int32Array([2048, 2048]) : 2048,
      } as unknown as WebGL2RenderingContext
    })
    const result = sampleSandboxDetached(POINTS, {
      signal: new AbortController().signal, textureEnabled: true,
      settings: {...DEFAULT_MAP_SETTINGS, quality: 'fine'},
    })
    await flush()
    const configuration = detachedRuntime.create.mock.calls.at(-1)![0] as {container: HTMLDivElement}
    expect(Math.max(parseInt(configuration.container.style.width), parseInt(configuration.container.style.height))).toBe(2048)
    expect(sampler.calls.resize).toHaveBeenCalled()
    sampler.loadDEM()
    expect((await settle(result)).texture).not.toBeNull()
    expect(sampler.calls.remove).toHaveBeenCalledTimes(1)
  })
})

describe('decoded DEM interpolation', () => {
  it('reads raw decoded metres without repeatedly computing MapLibre covering tiles', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {
      signal: new AbortController().signal, textureEnabled: false, settings: {...DEFAULT_MAP_SETTINGS, quality: 'eco'},
    })
    fake.state.loaded = true
    const get = vi.fn((x: number, y: number) => 200 + x * 0.3 + y * 0.5)
    fake.fire('sourcedata', {sourceId: DEM_SOURCE, tile: {
      state: 'loaded', dem: {dim: 512, get}, tileID: {canonical: {z: 0, x: 0, y: 0}},
    }})
    const sampled = await settle(result)
    const northWest = sampled.terrain.bounds
    const x = (northWest[0] + 180) / 360 * 512
    const latitude = northWest[3] * Math.PI / 180
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2 * 512
    expect(sampled.terrain.elevations[0]).toBeCloseTo(200 + x * 0.3 + y * 0.5, 9)
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(sampled.terrain.rows * sampled.terrain.columns * 4)
    fake.assertRestored()
  })

  it('interpolates source pixels and reads east/south border without exceeding DEMData bounds', () => {
    const tile = {z: 0, x: 0, y: 0, dem: {dim: 2, get: (x: number, y: number) => {
      if (x < 0 || y < 0 || x > 2 || y > 2) throw new Error('outside DEM border')
      return 100 + 10 * x + 20 * y
    }}}
    expect(readDecodedDEMElevation(tile, [0, 0])).toBe(130)
    expect(readDecodedDEMElevation(tile, [180, 0])).toBe(140)
    expect(readDecodedDEMElevation(tile, [-180, -85.051129])).toBe(140)
    expect(readDecodedDEMElevation(tile, [180, 85.051129])).toBe(120)
    expect(readDecodedDEMElevation({...tile, dem: {}}, [0, 0])).toBeNull()
  })

  it('rejects corrupt decoded elevations rather than fabricating a zero surface', async () => {
    const fake = makeMap()
    const result = sampleSandbox(fake.map, POINTS, {signal: new AbortController().signal, textureEnabled: false})
    const rejected = expect(result).rejects.toThrow('高程不完整')
    fake.state.loaded = true
    fake.fire('sourcedata', {sourceId: DEM_SOURCE, tile: {
      state: 'loaded', dem: {dim: 512, get: () => NaN}, tileID: {canonical: {z: 0, x: 0, y: 0}},
    }})
    await rejected
    expect(fake.calls.queryTerrainElevation).not.toHaveBeenCalled()
    fake.assertRestored()
  })
})
