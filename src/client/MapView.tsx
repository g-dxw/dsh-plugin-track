/**
 * The map: the track first, a basemap second.
 *
 * The order is the whole offline story. The map is built on `BLANK_STYLE` — one
 * background layer, no sources — and the track is drawn into it before a single
 * byte of network is touched, so opening a stored track draws the line, the two
 * end markers and the fit-to-bounds with no requests at all. A basemap is only
 * ever `setStyle` on top of that, and when it fails the failure lands on the
 * style, not on the track.
 *
 * `setStyle` clears every custom source and layer, so the track is re-added by
 * the `styledata` handler. That handler has to exist for the basemap swap
 * anyway, which is why a blank start and a vector basemap are one code path
 * rather than two.
 *
 * If WebGL is unavailable the constructor throws, and the track is drawn as a
 * plain SVG polyline instead: no basemap and no panning, but the shape of the
 * walk is still on screen. The elevation chart is unaffected either way.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AttributionControl, LngLatBounds, Map as MapLibreMap, NavigationControl } from 'maplibre-gl'
import { BASEMAP_OPTIONS, BLANK_STYLE, styleFor, type BasemapId } from '../track/basemaps.ts'
import { addTrack, TRACK_COLOR, toGeoJSON, type TrackGeoJSON } from '../track/trail-layer.ts'
import { writeBasemap } from './util.ts'
import { MAP_STYLE } from './maplibre-css.ts'
import type { TrackPoint } from '../protocol.ts'

export function MapView({points, name, basemap, onBasemap}: {
  points: readonly TrackPoint[]
  name: string
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const data = useRef<TrackGeoJSON | null>(null)
  const chosen = useRef<BasemapId>(basemap)
  const [basemapBroken, setBasemapBroken] = useState(false)
  const [noWebGL, setNoWebGL] = useState(false)

  const geojson = useMemo(() => toGeoJSON(points), [points])
  const bounds = useMemo(() => boundsOf(points), [points])

  // Built once; the track and the basemap are pushed in by the effects below,
  // because both change without the map itself being rebuilt.
  useEffect(() => {
    const container = holder.current
    if (!container) return
    mountStyle()

    let created: MapLibreMap
    try {
      created = new MapLibreMap({
        container,
        style: BLANK_STYLE,
        attributionControl: false,
        // A track card is not a navigation surface: rotation stays off, and the
        // compass goes with it.
        dragRotate: false,
      })
    } catch {
      setNoWebGL(true)
      return
    }
    created.touchZoomRotate.disableRotation()
    created.addControl(new NavigationControl({showCompass: false}), 'top-right')
    created.addControl(new AttributionControl({compact: true}))

    // Every style load — the blank one, and each basemap after it — wipes the
    // sources and layers, so the track is put back here rather than after
    // `setStyle` resolves. `addTrack` is idempotent and skips itself while a
    // style is still diffing, so being called early is harmless.
    created.on('styledata', () => {
      if (data.current) addTrack(created, data.current)
    })
    // A basemap that cannot be reached reports through the same channel as a
    // broken tile, so both end up in the same place: say so, and drop back to
    // the style the track does not depend on. Clicking the basemap again retries.
    created.on('error', () => {
      if (chosen.current === 'none') return
      setBasemapBroken(true)
      try {
        created.setStyle(BLANK_STYLE)
      } catch {
        // A style swap already in flight cannot be interrupted; the next
        // `styledata` restores the track regardless.
      }
    })

    if (bounds) created.fitBounds(bounds, {padding: 48, duration: 0})
    map.current = created

    return () => {
      created.remove()
      map.current = null
    }
  }, [])

  // New data, into whatever source the current style holds. Drawing is not
  // network-bound, so this works in the blank style too.
  useEffect(() => {
    const created = map.current
    if (!created) return
    data.current = geojson
    addTrack(created, geojson)
    if (bounds) created.fitBounds(bounds, {padding: 48, duration: 0})
  }, [geojson, bounds])

  // A basemap swap is a style swap. `none` is the same call with the style that
  // needs no network, which keeps the switch honest rather than special-cased.
  useEffect(() => {
    const created = map.current
    if (!created) return
    chosen.current = basemap
    setBasemapBroken(false)
    created.setStyle(styleFor(basemap))
  }, [basemap])

  return (
    <div className="trk-map-wrap">
      <div className="trk-map" ref={holder} />
      {noWebGL && <TrackOutline points={points} />}
      <div className="trk-base">
        {BASEMAP_OPTIONS.map(option => (
          <button
            key={option.id}
            className="trk-basebtn"
            aria-pressed={basemap === option.id}
            onClick={() => { writeBasemap(option.id); onBasemap(option.id) }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {basemapBroken && <div className="trk-note">底图需要联网，当前只显示轨迹线</div>}
      {noWebGL && <div className="trk-note">这台设备没有可用的 WebGL，已改为绘制轨迹轮廓</div>}
      <div className="trk-maptitle" title={name}>{name}</div>
    </div>
  )
}

/**
 * The no-WebGL fallback: the same path projected into an SVG viewBox.
 *
 * Longitude maps straight across and latitude is flipped, because the viewBox
 * grows downwards and the world does not. Nothing else about the track changes.
 */
function TrackOutline({points}: {points: readonly TrackPoint[]}) {
  const box = boundsOf(points)
  if (!box) return null
  const west = box.getWest()
  const south = box.getSouth()
  const spanLon = Math.max(box.getEast() - west, 1e-6)
  const spanLat = Math.max(box.getNorth() - south, 1e-6)
  const path = points
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map(point => `${((point[0] - west) / spanLon).toFixed(4)},${(1 - (point[1] - south) / spanLat).toFixed(4)}`)
    .join(' ')
  return (
    <svg className="trk-outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="轨迹轮廓">
      <polyline points={path} fill="none" stroke={TRACK_COLOR} strokeWidth="0.004" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Fold MapLibre's stylesheet into the document, once, with the plugin's own
 * marker attribute so the rules can be found and are attributable.
 */
let styleMounted = false
function mountStyle(): void {
  if (styleMounted || document.querySelector('style[data-plugin="cqai-dsh-plugin-track"]')) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin', 'cqai-dsh-plugin-track')
  style.textContent = MAP_STYLE
  document.head.appendChild(style)
  styleMounted = true
}

/** The track's extent, skipping anything that is not a coordinate. */
function boundsOf(points: readonly TrackPoint[]): LngLatBounds | null {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null
  return new LngLatBounds([minLon, minLat], [maxLon, maxLat])
}
