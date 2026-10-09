import type { Map as MapLibreMap } from 'maplibre-gl'
import { describe, expect, it, vi } from 'vitest'
import {
  addTrack, styleIsReady, toGeoJSON, updateTrackColor, TRACK_COLOR,
  TRACK_CASING, TRACK_END, TRACK_ENDS_SOURCE, TRACK_LINE, TRACK_SOURCE, TRACK_START,
} from '../src/track/trail-layer.ts'

const DATA = toGeoJSON([[120, 30, 100, null], [120.01, 30.006, 120, null], [120.02, 30.01, 110, null]])
const LAYERS = [TRACK_CASING, TRACK_LINE, TRACK_START, TRACK_END]
type Layer = Parameters<MapLibreMap['addLayer']>[0]
type Source = {data: GeoJSON.GeoJSON; setData: ReturnType<typeof vi.fn>}

/** Model the distinction between an initialized style and pending GeoJSON data. */
function pendingMap(initialized = true, loaded = true) {
  const sources = new Map<string, Source>()
  const layers = new Map<string, Layer>()
  const state = {initialized, loaded}
  const map = {
    style: {},
    getStyle: vi.fn(() => state.initialized ? {version: 8, sources: {}, layers: []} : undefined),
    isStyleLoaded: vi.fn(() => state.initialized && state.loaded),
    getSource: vi.fn((id: string) => sources.get(id)),
    getLayer: vi.fn((id: string) => layers.get(id)),
    addSource: vi.fn((id: string, specification: {data: GeoJSON.GeoJSON}) => {
      if (!state.initialized) throw new Error('Style is not done loading.')
      if (sources.has(id)) throw new Error(`Source ${id} already exists`)
      const source: Source = {
        data: specification.data,
        setData: vi.fn((data: GeoJSON.GeoJSON) => { source.data = data; state.loaded = false }),
      }
      sources.set(id, source)
      // Real MapLibre now waits for its worker to process the new GeoJSON.
      state.loaded = false
    }),
    addLayer: vi.fn((layer: Layer) => {
      if (!state.initialized) throw new Error('Style is not done loading.')
      if ('source' in layer && typeof layer.source === 'string' && !sources.has(layer.source)) {
        throw new Error(`Source ${layer.source} is missing`)
      }
      layers.set(layer.id, layer)
    }),
    setPaintProperty: vi.fn((id: string, property: string, value: string) => {
      const layer = layers.get(id)
      if (!layer || !('paint' in layer)) throw new Error(`Paint layer ${id} is missing`)
      Object.assign(layer.paint!, {[property]: value})
    }),
    removeLayer: vi.fn((id: string) => { layers.delete(id) }),
  }
  return {map: map as unknown as MapLibreMap, calls: map, state, sources, layers}
}

describe('track rendering while sources load', () => {
  it('adds both sources and all layers even after the first source becomes pending', () => {
    const {map, sources, layers} = pendingMap()
    expect(map.isStyleLoaded()).toBe(true)

    addTrack(map, DATA)

    expect(map.isStyleLoaded()).toBe(false)
    expect([...sources.keys()]).toEqual([TRACK_SOURCE, TRACK_ENDS_SOURCE])
    expect([...layers.keys()]).toEqual(LAYERS)
    expect(sources.get(TRACK_SOURCE)?.data).toBe(DATA.line)
    expect(sources.get(TRACK_ENDS_SOURCE)?.data).toBe(DATA.ends)
  })

  it('waits only for style initialization, including a new basemap with pending tiles', () => {
    const {map, calls, state, layers} = pendingMap(false, false)
    expect(styleIsReady(map)).toBe(false)
    addTrack(map, DATA)
    expect(calls.addSource).not.toHaveBeenCalled()
    expect(calls.addLayer).not.toHaveBeenCalled()

    state.initialized = true
    expect(map.isStyleLoaded()).toBe(false)
    expect(styleIsReady(map)).toBe(true)
    addTrack(map, DATA)
    expect([...layers.keys()]).toEqual(LAYERS)
  })

  it('refreshes data without rebuilding layers and restores the track after a style reset', () => {
    const {map, calls, sources, layers} = pendingMap()
    addTrack(map, DATA)
    const changed = toGeoJSON([[120.1, 30.1, 100, null], [120.2, 30.2, 120, null]])
    addTrack(map, changed)
    expect(calls.addSource).toHaveBeenCalledTimes(2)
    expect(calls.addLayer).toHaveBeenCalledTimes(4)
    expect(calls.removeLayer).not.toHaveBeenCalled()
    expect(sources.get(TRACK_SOURCE)?.data).toBe(changed.line)
    expect(sources.get(TRACK_ENDS_SOURCE)?.data).toBe(changed.ends)

    sources.clear()
    layers.clear()
    addTrack(map, changed)
    expect(calls.addSource).toHaveBeenCalledTimes(4)
    expect(calls.addLayer).toHaveBeenCalledTimes(8)
    expect([...layers.keys()]).toEqual(LAYERS)
  })
})

describe('live track color', () => {
  it('keeps the default stroke and applies an explicit color when adding all layers', () => {
    const defaults = pendingMap()
    addTrack(defaults.map, DATA)
    expect((defaults.layers.get(TRACK_LINE) as {paint: {'line-color': string}}).paint['line-color']).toBe(TRACK_COLOR)
    const chosen = pendingMap()
    addTrack(chosen.map, DATA, '#20a080')
    expect((chosen.layers.get(TRACK_LINE) as {paint: {'line-color': string}}).paint['line-color']).toBe('#20a080')
    expect((chosen.layers.get(TRACK_CASING) as {paint: {'line-color': string}}).paint['line-color']).toBe('#00000066')
    expect((chosen.layers.get(TRACK_START) as {paint: {'circle-color': string}}).paint['circle-color']).toBe('#4ade80')
    expect((chosen.layers.get(TRACK_END) as {paint: {'circle-color': string}}).paint['circle-color']).toBe('#f87171')
  })

  it('updates an existing stroke during data refresh and retains the selected color after a style reset', () => {
    const {map, calls, sources, layers} = pendingMap()
    addTrack(map, DATA, '#20a080')
    const stroke = layers.get(TRACK_LINE)
    addTrack(map, DATA, '#dd7700')
    expect(layers.get(TRACK_LINE)).toBe(stroke)
    expect(calls.setPaintProperty).toHaveBeenLastCalledWith(TRACK_LINE, 'line-color', '#dd7700')
    expect(calls.addLayer).toHaveBeenCalledTimes(4)
    sources.clear()
    layers.clear()
    addTrack(map, DATA, '#dd7700')
    expect((layers.get(TRACK_LINE) as {paint: {'line-color': string}}).paint['line-color']).toBe('#dd7700')
  })

  it('changes only stroke paint while GeoJSON remains pending without replacing sources, layers or endpoint colors', () => {
    const {map, calls, sources, layers} = pendingMap()
    addTrack(map, DATA)
    const originalLayers = [...layers.values()]
    const line = sources.get(TRACK_SOURCE)!, ends = sources.get(TRACK_ENDS_SOURCE)!
    expect(map.isStyleLoaded()).toBe(false)
    updateTrackColor(map, '#3355aa')
    expect(calls.setPaintProperty).toHaveBeenCalledTimes(1)
    expect(calls.setPaintProperty).toHaveBeenCalledWith(TRACK_LINE, 'line-color', '#3355aa')
    expect(line.setData).not.toHaveBeenCalled()
    expect(ends.setData).not.toHaveBeenCalled()
    expect(line.data).toBe(DATA.line)
    expect(ends.data).toBe(DATA.ends)
    expect([...layers.values()]).toEqual(originalLayers)
    expect(calls.addSource).toHaveBeenCalledTimes(2)
    expect(calls.addLayer).toHaveBeenCalledTimes(4)
    expect(calls.removeLayer).not.toHaveBeenCalled()
  })

  it('does nothing before the stroke exists or after its style is removed', () => {
    const {map, calls} = pendingMap(false, false)
    expect(() => updateTrackColor(map, '#3355aa')).not.toThrow()
    expect(calls.setPaintProperty).not.toHaveBeenCalled()
    expect(calls.addSource).not.toHaveBeenCalled()
    expect(calls.addLayer).not.toHaveBeenCalled()
    const removed = pendingMap()
    addTrack(removed.map, DATA)
    removed.layers.clear()
    updateTrackColor(removed.map, '#3355aa')
    expect(removed.calls.setPaintProperty).not.toHaveBeenCalled()
    expect(removed.calls.addSource).toHaveBeenCalledTimes(2)
    expect(removed.calls.addLayer).toHaveBeenCalledTimes(4)
  })
})
