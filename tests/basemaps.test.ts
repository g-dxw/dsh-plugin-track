// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBasemap, writeBasemap } from '../src/client/util.ts'
import {
  BASEMAP_OPTIONS, BLANK_STYLE, DEFAULT_BASEMAP, SATELLITE_STYLE, TERRAIN_STYLE,
  VECTOR_STYLE, styleFor, type BasemapId,
} from '../src/track/basemaps.ts'

const BASEMAP_KEY = 'cqai-track.basemap'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('basemap persistence', () => {
  it.each(['vector', 'terrain', 'satellite', 'none'] satisfies BasemapId[])('restores the selected %s style', basemap => {
    writeBasemap(basemap)
    expect(localStorage.getItem(BASEMAP_KEY)).toBe(basemap)
    expect(readBasemap()).toBe(basemap)
  })

  it.each([null, '', 'Satellite', 'satellite ', 'unsupported'])('falls back to vector for invalid storage %j', stored => {
    if (stored !== null) localStorage.setItem(BASEMAP_KEY, stored)
    expect(DEFAULT_BASEMAP).toBe('vector')
    expect(readBasemap()).toBe(DEFAULT_BASEMAP)
  })

  it('falls back when storage access is denied and tolerates failed writes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    expect(readBasemap()).toBe(DEFAULT_BASEMAP)
    expect(() => writeBasemap('satellite')).not.toThrow()
  })
})

describe('satellite raster style', () => {
  it('exposes the satellite option without changing existing styles or the default', () => {
    expect(BASEMAP_OPTIONS.find(option => option.id === 'satellite')?.label).toBe('卫星')
    expect(styleFor('satellite')).toBe(SATELLITE_STYLE)
    expect(styleFor('vector')).toBe(VECTOR_STYLE)
    expect(styleFor('terrain')).toBe(TERRAIN_STYLE)
    expect(styleFor('none')).toBe(BLANK_STYLE)
    expect(DEFAULT_BASEMAP).toBe('vector')
  })

  it('uses HTTPS Esri image tiles in server z/y/x order with 256-pixel tiles', () => {
    const source = Object.values(SATELLITE_STYLE.sources).find(candidate => candidate.type === 'raster')
    if (!source || source.type !== 'raster') throw new Error('Satellite style must contain a raster source')
    expect(source.tileSize).toBe(256)
    expect(source.tiles).toHaveLength(1)
    expect(source.tiles![0]).toMatch(/^https:\/\/[^/]+\/.+\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/u)
  })

  it('overzooms the last imagery level instead of hiding the layer beyond zoom 19', () => {
    const sourceEntry = Object.entries(SATELLITE_STYLE.sources).find(([, source]) => source.type === 'raster')
    if (!sourceEntry || sourceEntry[1].type !== 'raster') throw new Error('Satellite style must contain a raster source')
    const [id, source] = sourceEntry
    expect(source.maxzoom).toBe(19)
    const layer = SATELLITE_STYLE.layers.find(candidate => candidate.type === 'raster' && candidate.source === id)
    expect(layer).toBeDefined()
    expect(layer!.maxzoom ?? 24).toBeGreaterThan(19)
  })

  it('credits satellite data providers rather than unrelated map providers', () => {
    const source = Object.values(SATELLITE_STYLE.sources).find(candidate => candidate.type === 'raster')
    if (!source || source.type !== 'raster') throw new Error('Satellite style must contain a raster source')
    for (const credit of ['Esri', 'Vantor', 'Earthstar', 'GIS']) expect(source.attribution).toContain(credit)
    expect(source.attribution).not.toMatch(/OpenStreetMap|OpenTopoMap|OpenMapTiles/u)
  })
})
