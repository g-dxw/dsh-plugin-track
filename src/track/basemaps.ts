/**
 * Base maps the panel can swap between, plus the offline fallback style.
 *
 * Every URL here is https on purpose: the app itself is served over
 * `http://127.0.0.1`, so a plain-http tile endpoint would be refused as mixed
 * content. None of them needs an API key.
 *
 * "无底图" is not a degraded afterthought — it is what makes the panel honest
 * offline. The track is drawn into a style that touches no network at all, and
 * a basemap is only ever an addition on top of it (see MapView).
 */
import type { StyleSpecification } from 'maplibre-gl'
import openfreemap from './basemap/openfreemap.json'

export type BasemapId = 'vector' | 'terrain' | 'none'

export interface BasemapOption {
  id: BasemapId
  label: string
  /** Attribution owed to the tile provider, shown by MapLibre's control. */
  attribution?: string
}

export const BASEMAP_OPTIONS: readonly BasemapOption[] = [
  {
    id: 'vector',
    label: '矢量',
    attribution:
      '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
  },
  {
    id: 'terrain',
    label: '地形',
    attribution:
      '&copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org" target="_blank">OpenTopoMap</a> (CC-BY-SA)',
  },
  {id: 'none', label: '无底图'},
]

export const DEFAULT_BASEMAP: BasemapId = 'vector'

/** OpenFreeMap planet vector tiles; upstream's `ofm.json` with the MapTiler sprite dropped. */
export const VECTOR_STYLE = openfreemap as unknown as StyleSpecification

/**
 * OpenTopoMap raster terrain.
 * Only 17 zoom levels exist upstream; past that MapLibre over-zooms the z17 tile.
 */
export const TERRAIN_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    opentopomap: {
      type: 'raster',
      tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 17,
      attribution:
        '&copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org" target="_blank">OpenTopoMap</a> (CC-BY-SA)',
    },
  },
  layers: [{id: 'opentopomap', type: 'raster', source: 'opentopomap'}],
}

/**
 * The offline style. A single background layer, which is what the track is
 * drawn never to depend on.
 */
export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{id: 'cqai-track-background', type: 'background', paint: {'background-color': '#eef1f5'}}],
}

export function styleFor(basemap: BasemapId): StyleSpecification {
  if (basemap === 'vector') return VECTOR_STYLE
  if (basemap === 'terrain') return TERRAIN_STYLE
  return BLANK_STYLE
}
