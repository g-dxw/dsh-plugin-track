/** The existing offline map, with an on-demand Three.js terrain view. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl'
import { BLANK_STYLE, styleFor, basemapCredits, terrainProviderFor, MAPTILER_LOGO_URL, type BasemapId } from '../track/basemaps.ts'
import { addTrack, updateTrackColor, TRACK_COLOR, TRACK_LINE, toGeoJSON, type TrackGeoJSON } from '../track/trail-layer.ts'
import { SandboxRenderer } from '../track/sandbox/renderer.ts'
import { MapFloatingPlacemarkLayer } from '../track/map-floating-placemarks.ts'
import type { SandboxPlacemark } from '../track/sandbox/types.ts'
import { isSandboxDEMError, sampleSandboxDetached } from '../track/sandbox/sampling.ts'
import { configureMapTerrain, isMapTerrainError } from '../track/map-terrain.ts'
import { useMapSettings, BasemapControls, MapCredits, MapViewSettingsControls } from './map-settings.tsx'
import { SandboxLightingControls } from './SandboxLightingControls.tsx'
import { MapDisplayControls } from './MapDisplayControls.tsx'
import { MAP_STYLE } from './maplibre-css.ts'
import type { TrackPoint, TrackPlacemark, PlacemarkGroup } from '../protocol.ts'
import { createPlacemarkDetails, createPlacemarkGroupDetails, type PlacemarkGroupPhoto } from './placemark-details.ts'
import { PlacemarkPhotoViewer } from './PlacemarkPhotoViewer.tsx'
import { placemarkTitle } from '../track/placemark-format.ts'
import { groupCoverPhoto, groupHidden, groupPhotos } from '../track/placemark-groups.ts'
import { filteredPlacemarkListItems, isAllPlacemarkTypes, matchesPlacemarkType, type PlacemarkTypeFilter } from '../track/placemark-filter.ts'

import {captureMapImage} from './map-resource-capture.ts'
import {waitForMapCaptureFrame} from './map-export-frame.ts'
import {storeResourceMapImage} from './resources-api.ts'
import {RESOURCE_MAP_VIEW_LABELS, type ResourceMapView} from '../track/resources.ts'

type MapViewMode = ResourceMapView
type MapImageSnapshot = {trackId: string; name: string; view: ResourceMapView; png: Blob}
type CameraState = {center: [number, number]; zoom: number; pitch: number; bearing: number}
type Sampling = {controller: AbortController; basemapFailed: boolean}

const NO_PLACEMARKS: readonly TrackPlacemark[] = []
const NO_GROUPS: readonly PlacemarkGroup[] = []
const NO_EXPANDED_GROUPS: ReadonlySet<string> = new Set()
type MapPlacemark = TrackPlacemark & {markerLabel: string; groupCount?: number}
export function MapView({points, name, trackId, basemap, onBasemap, placemarks = NO_PLACEMARKS, placemarkGroups = NO_GROUPS, expandedPlacemarkGroups = NO_EXPANDED_GROUPS, placemarkTypeFilter = 'all', onPlacemarkTypeFilterChange, placemarkDisplayControlsDisabled = false, selectedPlacemark = null, onSelectPlacemark, onClosePlacemark, onMovePlacemark, onEditPlacemark, onPlacemarkDragChange, placemarkEditingDisabled = false, segmentStarts, onPickPlacemark}: {
  points: readonly TrackPoint[]
  trackId?: string
  segmentStarts?: readonly number[]
  onPickPlacemark?: (coordinates:[number,number])=>void
  name: string
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
  placemarks?: readonly TrackPlacemark[]
  placemarkGroups?: readonly PlacemarkGroup[]
  expandedPlacemarkGroups?: ReadonlySet<string>
  placemarkTypeFilter?: PlacemarkTypeFilter
  onPlacemarkTypeFilterChange?: (next: PlacemarkTypeFilter) => void
  placemarkDisplayControlsDisabled?: boolean
  selectedPlacemark?: string | null
  onSelectPlacemark?: (id: string) => void
  onClosePlacemark?: () => void
  onMovePlacemark?: (id: string, coordinates: [number, number]) => void
  onEditPlacemark?: (id: string) => void
  onPlacemarkDragChange?: (active: boolean) => void
  placemarkEditingDisabled?: boolean
}) {
  const {settings} = useMapSettings()
  const liveSettings = useRef(settings); liveSettings.current = settings
  const pickPlacemark=useRef(onPickPlacemark);pickPlacemark.current=onPickPlacemark
  useEffect(()=>{if(onPickPlacemark)selectView('map')},[!!onPickPlacemark])
  const holder = useRef<HTMLDivElement>(null)
  const sandboxHolder = useRef<HTMLDivElement>(null)
  const detailsHolder = useRef<HTMLDivElement>(null)
  const closeDetails = useRef<(() => void) | null>(null)
  const backgroundPress = useRef<{x: number; y: number; moved: boolean} | null>(null)
  const [detailsViewport, setDetailsViewport] = useState({width: 460, height: 420})
  useEffect(() => {
    const pane = detailsHolder.current?.parentElement
    if (!pane) return
    const measure = () => {
      const rect = pane.getBoundingClientRect()
      const width = pane.clientWidth || rect.width || 460, height = pane.clientHeight || rect.height || 420
      setDetailsViewport(previous => previous.width === width && previous.height === height ? previous : {width, height})
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(pane)
    window.addEventListener('resize', measure)
    return () => {observer?.disconnect(); window.removeEventListener('resize', measure)}
  }, [])
  const nativeNavigation = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tools = toolbar.current, wrapper = tools?.parentElement
    if (!tools || !wrapper) return
    const measure = () => wrapper.style.setProperty('--trk-map-toolbar-bottom', `${tools.offsetTop + tools.offsetHeight + 10}px`)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(tools)
    return () => observer?.disconnect()
  }, [])
  const map = useRef<MapLibreMap | null>(null)
  const renderer = useRef<SandboxRenderer | null>(null)
  const floatingPlacemarks = useRef<MapFloatingPlacemarkLayer | null>(null)
  const sampling = useRef<Sampling | null>(null)
  const data = useRef<TrackGeoJSON | null>(null)
  const requestedData = useRef<TrackGeoJSON | null>(null)
  const chosen = useRef<BasemapId>(basemap)
  const basemapUnavailable = useRef(false)
  const [basemapBroken, setBasemapBroken] = useState(false)
  const [noWebGL, setNoWebGL] = useState(false)
  const [view, setView] = useState<MapViewMode>('map')
  const nativeMode = useRef<'map' | 'terrain'>('map')
  if (view !== 'sandbox') nativeMode.current = view
  const cameras = useRef<Partial<Record<'map' | 'terrain', CameraState>>>({})
  const syncTerrain = useRef<() => void>(() => {})
  const syncingTerrain = useRef(false)
  const [terrainError, setTerrainError] = useState<string | null>(null)
  const [hasSandboxTexture, setHasSandboxTexture] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sandboxError, setSandboxError] = useState<string | null>(null)
  const [textureUnavailable, setTextureUnavailable] = useState(false)
  const [basemapRetry, setBasemapRetry] = useState(0)
  const [markerRevision, setMarkerRevision] = useState(0)
  const markers = useRef<{id: string; marker: Marker; button: HTMLButtonElement}[]>([])
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNotice, setExportNotice] = useState('')
  const [exportError, setExportError] = useState('')
  const [pendingExport, setPendingExport] = useState<MapImageSnapshot | null>(null)
  const exportEpoch = useRef(0)
  const exportTask = useRef<{epoch: number; controller: AbortController; capturing: boolean} | null>(null)
  const exportView = useRef({trackId, view, basemap, settings})
  exportView.current = {trackId, view, basemap, settings}
  useEffect(() => {
    exportEpoch.current++
    exportTask.current?.controller.abort(new Error('轨迹已变化，请重新导出'))
    exportTask.current = null
    setExportBusy(false); setExportNotice(''); setExportError(''); setPendingExport(null)
    return () => {
      exportEpoch.current++
      exportTask.current?.controller.abort(new Error('导出已取消'))
      exportTask.current = null
    }
  }, [trackId])
  useEffect(() => {
    if (exportTask.current?.capturing) exportTask.current.controller.abort(new Error('地图视图已变化，请重新导出'))
  }, [view, basemap, settings, points, segmentStarts])

  async function saveMapImage(retry?: MapImageSnapshot) {
    if (!trackId || exportTask.current || (retry && retry.trackId !== trackId)) return
    if (!retry && (onPickPlacemark || noWebGL || (view === 'sandbox' && (loading || sandboxError)))) return
    const epoch = exportEpoch.current, captured = exportView.current
    const task = {epoch, controller: new AbortController(), capturing: !retry}
    exportTask.current = task
    setExportBusy(true); setExportNotice(''); setExportError('')
    let snapshot = retry
    const current = () => exportEpoch.current === epoch && exportTask.current === task
    try {
      if (!snapshot) {
        let canvas: HTMLCanvasElement | null
        if (captured.view === 'sandbox') {
          const sandbox = renderer.current
          if (!sandbox) throw new Error('沙盘尚未加载完成，请稍后重试')
          sandbox.renderFrame()
          canvas = sandbox.getCaptureCanvas()
        } else {
          const native = map.current
          if (!native) throw new Error('地图尚未加载完成，请稍后重试')
          await waitForMapCaptureFrame(native, task.controller.signal)
          canvas = native.getCanvas()
        }
        if (!current() || task.controller.signal.aborted) throw task.controller.signal.reason ?? new Error('导出已取消')
        const latest = exportView.current
        if (latest.trackId !== captured.trackId || latest.view !== captured.view || latest.basemap !== captured.basemap || latest.settings !== captured.settings) throw new Error('地图视图已变化，请重新导出')
        if (!canvas) throw new Error('当前视图无法生成图片，请重新导出')
        const effectiveBasemap = captured.basemap.startsWith('maptiler-') && !captured.settings.maptilerKey ? 'vector' : captured.basemap
        const texture = captured.view === 'sandbox' ? hasSandboxTexture : !basemapUnavailable.current
        const credits = [...(texture ? basemapCredits(effectiveBasemap) : []), ...(captured.view !== 'map' ? terrainProviderFor(captured.settings).credits : [])]
          .filter((credit, index, list) => list.findIndex(item => item.url === credit.url && item.label === credit.label) === index)
        // captureMapImage copies the view synchronously before encoding or loading credits.
        const pngTask = captureMapImage({canvas, markers: captured.view === 'sandbox' ? [] : markers.current.map(item => item.button), credits,
          background: captured.view === 'sandbox' ? captured.settings.sandboxColors.background : '#eef1f5',
          maptilerLogo: credits.some(credit => credit.url.includes('maptiler.com')) ? MAPTILER_LOGO_URL : undefined})
        task.capturing = false
        const png = await pngTask
        if (!current()) return
        snapshot = {trackId: trackId, name: `${name} · ${RESOURCE_MAP_VIEW_LABELS[captured.view]}`, view: captured.view, png}
      }
      setPendingExport(snapshot)
      await storeResourceMapImage(snapshot.trackId, snapshot.name, snapshot.view, snapshot.png)
      if (current()) {setPendingExport(null); setExportNotice(`${RESOURCE_MAP_VIEW_LABELS[snapshot.view]}已保存到资源库`)}
    } catch (error) {
      if (current()) {
        setPendingExport(snapshot ?? null)
        setExportError(error instanceof Error ? error.message : '图片保存失败，请重试')
      }
    } finally {
      if (current()) {exportTask.current = null; setExportBusy(false)}
    }
  }

  const selectPlacemark = useRef(onSelectPlacemark)
  selectPlacemark.current = onSelectPlacemark
  const closePlacemark = useRef(onClosePlacemark)
  closePlacemark.current = onClosePlacemark
  const movePlacemark = useRef(onMovePlacemark)
  movePlacemark.current = onMovePlacemark
  const editPlacemark = useRef(onEditPlacemark)
  editPlacemark.current = onEditPlacemark
  const placemarkEditable = Boolean(onEditPlacemark)
  const placemarkMovable = Boolean(onMovePlacemark) && !placemarkEditingDisabled && settings.sandboxPlacemarks && view === 'map'
  const movable = useRef(placemarkMovable)
  movable.current = placemarkMovable
  const dragging = useRef<string | null>(null)
  const pressedPlacemark = useRef<string | null>(null)
  const dragChange = useRef(onPlacemarkDragChange); dragChange.current = onPlacemarkDragChange
  const [draggingPlacemark, setDraggingPlacemark] = useState<string | null>(null)
  const keyboardPlacemark = useRef<string | null>(null)
  const [largePhoto, setLargePhoto] = useState<{url: string; name: string; selectionId: string; groupId?: string; pointId?: string} | null>(null)
  const largePhotoRef = useRef(largePhoto); largePhotoRef.current = largePhoto
  const previousLargeGroup = useRef<string | undefined>()
  const groupPhoto = useRef(new Map<string, PlacemarkGroupPhoto>())
  const browsedGroups = useRef(new Set<string>())
  const openPhotoGroup = useRef<string | null>(null)
  const openGroupCover = useRef<string | null>(null)
  const popupSelection = useRef<string | null>(null)
  const groupControlFocus = useRef<string | null>(null)
  const [groupPhotoRevision, setGroupPhotoRevision] = useState(0)
  const selectMarker = useRef<(id: string) => void>(() => {})
  selectMarker.current = id => {
    if (placemarkGroups.some(group => group.id === id)) {
      groupPhoto.current.delete(id); browsedGroups.current.delete(id)
      groupControlFocus.current = null; setGroupPhotoRevision(value => value + 1)
    }
    selectPlacemark.current?.(id)
  }
  const filteredPlacemarks = useMemo(() => isAllPlacemarkTypes(placemarkTypeFilter) ? placemarks : placemarks.filter(point => matchesPlacemarkType(point, placemarkTypeFilter)), [placemarks, placemarkTypeFilter])
  const selectedGroup = placemarkGroups.find(group => group.id === selectedPlacemark
    || (!expandedPlacemarkGroups.has(group.id) && group.memberIds.includes(selectedPlacemark ?? '')))
  const mapPlacemarks = useMemo<MapPlacemark[]>(() => {
    if (!settings.sandboxPlacemarks) return []
    const pointNumbers = new Map(placemarks.map((point, index) => [point.id, index + 1]))
    return filteredPlacemarkListItems(placemarks, placemarkGroups, placemarkTypeFilter).flatMap<MapPlacemark>(item => {
      if (item.kind === 'point') return item.point.hidden ? [] : [{...item.point, markerLabel: String(item.number)}]
      const group = item.group
      if (groupHidden(group, item.members)) return []
      const groupMarker: MapPlacemark = {id: group.id, name: group.name, description: group.description,
        coordinates: group.coordinates, images: [], markerLabel: `G${item.number}`, groupCount: item.members.length}
      const children = expandedPlacemarkGroups.has(group.id) ? item.members.filter(point => !point.hidden)
        .map(point => ({...point, markerLabel: String(pointNumbers.get(point.id))})) : []
      return [groupMarker, ...children]
    })
  }, [placemarks, placemarkGroups, expandedPlacemarkGroups, placemarkTypeFilter, settings.sandboxPlacemarks])
  const selectedMarkerCandidate = selectedGroup?.id ?? selectedPlacemark
  const selectedMarkerId = (selectedGroup?.id === selectedPlacemark || filteredPlacemarks.some(point => point.id === selectedPlacemark))
    && mapPlacemarks.some(point => point.id === selectedMarkerCandidate) ? selectedMarkerCandidate : null
  const sandboxMarkers = useMemo<SandboxPlacemark[]>(() => mapPlacemarks.map(point => ({
    id: point.id, coordinates: point.coordinates, label: point.markerLabel,
    title: placemarkTitle(point), groupCount: point.groupCount,
  })), [mapPlacemarks])
  const liveSandboxMarkers = useRef(sandboxMarkers); liveSandboxMarkers.current = sandboxMarkers
  const liveSelectedMarker = useRef(selectedMarkerId); liveSelectedMarker.current = selectedMarkerId
  useEffect(() => {
    setLargePhoto(previous => {
      if (!previous || !selectedMarkerId || !settings.sandboxPlacemarks) return null
      if (!previous.groupId) return previous.selectionId === selectedPlacemark && filteredPlacemarks.some(point => point.id === selectedPlacemark && !point.hidden && point.images.includes(previous.url)) ? previous : null
      const group = placemarkGroups.find(group => group.id === previous.groupId)
      return group && selectedGroup?.id === group.id && !groupHidden(group, filteredPlacemarks)
        && groupPhotos(group, filteredPlacemarks).some(photo => photo.point.id === previous.pointId && photo.url === previous.url) ? previous : null
    })
  }, [selectedPlacemark, selectedMarkerId, view, filteredPlacemarks, placemarkGroups, settings.sandboxPlacemarks])
  useEffect(() => {
    const previous = previousLargeGroup.current; previousLargeGroup.current = largePhoto?.groupId
    if (!largePhoto && previous && previous === selectedGroup?.id) holder.current?.parentElement
      ?.querySelector<HTMLButtonElement>('.trk-placemark-group-details .trk-placemark-details-view')?.focus({preventScroll:true})
  }, [largePhoto])

  const geojson = useMemo(() => toGeoJSON(points,segmentStarts), [points,segmentStarts])
  const bounds = useMemo(() => boundsOf(points), [points])

  function stopSandbox() {
    // Abort restores the sampler's temporary map state synchronously, before a
    // following setStyle or fitBounds can install a different track/style.
    sampling.current?.controller.abort()
    sampling.current = null
    renderer.current?.dispose()
    renderer.current = null
  }

  function selectView(next: MapViewMode) {
    if (next === view) return
    const created = map.current
    if (created && typeof created.getCenter === 'function' && typeof created.getZoom === 'function') {
      const center = created.getCenter()
      cameras.current[nativeMode.current] = {center: [center.lng, center.lat], zoom: created.getZoom(),
        pitch: created.getPitch?.() ?? 0, bearing: created.getBearing?.() ?? 0}
      if (next !== 'sandbox') {
        const saved = cameras.current[next]
        created.jumpTo?.(saved || {pitch: next === 'terrain' ? 60 : 0, bearing: 0})
      }
    }
    stopSandbox()
    setSandboxError(null)
    setTerrainError(null)
    setTextureUnavailable(false)
    setLoading(false)
    requestedData.current = next === 'sandbox' ? geojson : null
    setView(next)
  }

  syncTerrain.current = () => {
    const created = map.current
    if (!created || syncingTerrain.current) return
    syncingTerrain.current = true
    try {
      configureMapTerrain(created, liveSettings.current, nativeMode.current === 'terrain',
        basemapUnavailable.current ? 'none' : chosen.current)
    } catch {
      if (nativeMode.current === 'terrain') {
        nativeMode.current = 'map'
        setView('map')
        setTerrainError('3D 地形暂时不可用，已返回二维地图，可切换 3D 地图重试。')
        try { configureMapTerrain(created, liveSettings.current, false, chosen.current) } catch { /* wait for next style */ }
      }
    } finally { syncingTerrain.current = false }
  }


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
        dragRotate: false,
        maxPitch: 85,
        // The visible canvas remains available for snapshots.
        canvasContextAttributes: {preserveDrawingBuffer: true},
      })
    } catch {
      setNoWebGL(true)
      return
    }
    created.touchZoomRotate.disableRotation()
    created.addControl(new NavigationControl({showCompass: true, visualizePitch: true}), 'top-right')
    // Keep MapLibre's control registered for its event handling and disposal,
    // while placing the existing DOM in the shared React tool column.
    const navigation = container.querySelector<HTMLElement>('.maplibregl-ctrl-top-right .maplibregl-ctrl-group')
    if (navigation) nativeNavigation.current?.appendChild(navigation)
    created.on('styledata', () => {
      // A style swap drops all custom layers. Do not keep resubmitting identical
      // GeoJSON during every terrain/style event while sampling is in progress.
      if (data.current && !created.getLayer(TRACK_LINE)) addTrack(created, data.current, liveSettings.current.routeColor)
      syncTerrain.current()
    })
    created.on('zoomend', () => syncTerrain.current())
    created.on('error', event => {
      if (isMapTerrainError(event)) {
        if (nativeMode.current !== 'terrain') return
        nativeMode.current = 'map'; setView('map')
        setTerrainError('地形高程加载失败，已返回二维地图；检查连接后可切换 3D 地图重试。')
        try { configureMapTerrain(created, liveSettings.current, false, chosen.current); created.jumpTo({pitch: 0, bearing: 0}) } catch { /* style swap */ }
        return
      }
      // Independent sandbox DEM errors cannot erase the main map.
      if (isSandboxDEMError(event) || chosen.current === 'none') return
      basemapUnavailable.current = true
      setBasemapBroken(true)
      try { created.setStyle(BLANK_STYLE) } catch { /* a style swap is already in flight */ }
    })
    if (bounds) created.fitBounds(bounds, {padding: 48, duration: 0})
    created.on('click',event=>{
      if(pickPlacemark.current){const coordinates=validPlacemarkPosition(event.lngLat.lng,event.lngLat.lat);if(coordinates)pickPlacemark.current(coordinates)}
    })
    map.current = created
    return () => {
      stopSandbox()
      floatingPlacemarks.current?.dispose(); floatingPlacemarks.current = null
      map.current = null
      created.remove()
    }
  }, [])

  useEffect(() => {
    stopSandbox()
    requestedData.current = null
    nativeMode.current = 'map'
    cameras.current = {}
    setView('map')
    setLoading(false)
    setSandboxError(null)
    setTextureUnavailable(false)
    const created = map.current
    if (!created) return
    data.current = geojson
    addTrack(created, geojson, liveSettings.current.routeColor)
    if (bounds) created.fitBounds(bounds, {padding: 48, duration: 0})
  }, [geojson, bounds])

  useEffect(() => {
    stopSandbox()
    const created = map.current
    if (!created) return
    chosen.current = basemap
    basemapUnavailable.current = false
    setBasemapBroken(false)
    // Public OSM tiles are only loaded while the interactive map is visible.
    created.setStyle(styleFor(basemap === 'osm' && view === 'sandbox' ? 'none' : basemap, settings))
  }, [basemap, basemapRetry, settings.maptilerKey, basemap === 'osm' && view === 'sandbox'])

  useEffect(() => {
    syncTerrain.current()
    const created = map.current
    if (!created || view === 'sandbox') return
    const enabled = view === 'terrain'
    if (enabled) {
      created.dragRotate?.enable(); created.touchZoomRotate.enableRotation?.(); created.touchPitch?.enable()
      created.keyboard?.enableRotation()
    } else {
      created.dragRotate?.disable(); created.touchZoomRotate.disableRotation(); created.touchPitch?.disable()
      created.keyboard?.disableRotation()
      if ((created.getPitch?.() ?? 0) !== 0) created.jumpTo?.({pitch: 0, bearing: 0})
    }
  }, [view, basemap, settings.terrainProvider, settings.maptilerKey, settings.exaggeration, settings.buildings])

  useEffect(() => {
    if (map.current) updateTrackColor(map.current, settings.routeColor)
    renderer.current?.updateRouteColor?.(settings.routeColor)
  }, [settings.routeColor])
  useEffect(() => { renderer.current?.updateLighting?.(settings.lighting) }, [settings.lighting])
  useEffect(() => { renderer.current?.updateColors?.(settings.sandboxColors) }, [settings.sandboxColors])
  useEffect(() => { renderer.current?.updateBackground?.(settings.sandboxBackground) }, [settings.sandboxBackground])
  useEffect(() => {
    renderer.current?.updatePlacemarks?.(sandboxMarkers, {visible: settings.sandboxPlacemarks, mode: settings.sandboxPlacemarkMode,
      pointSize: settings.placemarkPointSize, pointColor: settings.placemarkPointColor, groupColor: settings.placemarkGroupColor, pointRadius: settings.placemarkPointRadius,
      pointShowCount: settings.placemarkPointShowCount, pointShowName: settings.placemarkPointShowName,
      selectedId: selectedMarkerId, labelColor: settings.sandboxLabelColor, labelSize: settings.sandboxLabelSize, labelHeight: settings.sandboxLabelHeight, connectorColor: settings.sandboxConnectorColor, onSelect: id => selectMarker.current(id)})
  }, [sandboxMarkers, selectedMarkerId, settings.sandboxPlacemarks, settings.sandboxLabelColor, settings.sandboxLabelSize, settings.sandboxLabelHeight, settings.sandboxConnectorColor, settings.sandboxPlacemarkMode, settings.placemarkPointSize, settings.placemarkPointColor, settings.placemarkGroupColor, settings.placemarkPointRadius, settings.placemarkPointShowCount, settings.placemarkPointShowName])


  useEffect(() => {
    const created = map.current, container = holder.current
    if (!created || !container) return
    const enabled = view === 'terrain' && settings.terrainPlacemarkMode === 'marker' && settings.sandboxPlacemarks
    if (enabled && !floatingPlacemarks.current) floatingPlacemarks.current = new MapFloatingPlacemarkLayer(created, container)
    floatingPlacemarks.current?.update(sandboxMarkers, {visible: enabled, selectedId: selectedMarkerId,
      labelColor: settings.sandboxLabelColor, labelSize: settings.sandboxLabelSize, labelHeight: settings.sandboxLabelHeight,
      connectorColor: settings.sandboxConnectorColor, onSelect: id => selectMarker.current(id)})
  }, [view, sandboxMarkers, selectedMarkerId, settings.terrainPlacemarkMode, settings.sandboxPlacemarks,
    settings.sandboxLabelColor, settings.sandboxLabelSize, settings.sandboxLabelHeight, settings.sandboxConnectorColor])


  useEffect(() => {
    const created = map.current
    if (!created) return
    markers.current = mapPlacemarks.map(point => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = `trk-map-placemark${point.groupCount !== undefined ? ' trk-map-placemark-group' : ''}`
      const dot = document.createElement('span')
      dot.className = 'trk-map-placemark-dot'; dot.textContent = point.markerLabel
      button.appendChild(dot)
      if (point.groupCount !== undefined) {const count = document.createElement('span'); count.className = 'trk-map-placemark-count'; count.textContent = String(point.groupCount); button.append(count)}
      const title = placemarkTitle(point)
      if (title) {const name = document.createElement('span'); name.className = 'trk-map-placemark-name'; name.textContent = title; button.append(name)}
      button.setAttribute('aria-label', point.groupCount !== undefined ? `标记组 ${point.markerLabel}${title ? `：${title}` : ''}，${point.groupCount} 个子点` : title ? `标注点 ${point.markerLabel}：${title}` : `标注点 ${point.markerLabel}`)
      button.dataset.placemarkId = point.id
      let suppressClickUntil = 0
      button.addEventListener('pointerdown', event => {
        if (!movable.current || event.button !== 0) return
        pressedPlacemark.current = point.id; dragChange.current?.(true)
      })
      button.addEventListener('click', event => {
        event.stopPropagation()
        if (dragging.current === point.id || (event.detail > 0 && Date.now() < suppressClickUntil)) {
          event.preventDefault(); return
        }
        keyboardPlacemark.current = null
        selectMarker.current(point.id)
      })
      const marker = new Marker({element: button, draggable: movable.current}).setLngLat(point.coordinates).addTo(created)
      marker.on('dragstart', () => {
        if (!movable.current) return
        keyboardPlacemark.current = null
        dragging.current = point.id; setDraggingPlacemark(point.id); setLargePhoto(null)
        dragChange.current?.(true)
      })
      marker.on('dragend', () => {
        if (dragging.current !== point.id) return
        dragging.current = null; pressedPlacemark.current = null; setDraggingPlacemark(null); suppressClickUntil = Date.now() + 350
        if (!movable.current) {marker.setLngLat(point.coordinates); dragChange.current?.(false); return}
        const position = marker.getLngLat()
        const coordinates = validPlacemarkPosition(position.lng, position.lat)
        // The parent publishes the snapped/saved position. A no-op or rejected
        // move must not leave MapLibre at its transient unsnapped coordinates.
        marker.setLngLat(point.coordinates)
        if (coordinates) {
          movePlacemark.current?.(point.id, coordinates)
          selectPlacemark.current?.(point.id)
        } else marker.setLngLat(point.coordinates)
        dragChange.current?.(false)
      })
      button.addEventListener('keydown', event => {
        const step = placemarkKeyStep(event.key)
        if (!event.altKey || !step || !movePlacemark.current) return
        event.preventDefault(); event.stopPropagation()
        if (!movable.current) return
        const pixel = created.project(marker.getLngLat())
        const position = created.unproject([pixel.x + step[0], pixel.y + step[1]])
        const coordinates = validPlacemarkPosition(position.lng, position.lat)
        if (coordinates) {
          keyboardPlacemark.current = point.id
          movePlacemark.current?.(point.id, coordinates)
          selectPlacemark.current?.(point.id)
        }
      })
      return {id: point.id, marker, button}
    })
    const releasePress = () => {
      if (dragging.current || !pressedPlacemark.current) return
      pressedPlacemark.current = null; dragChange.current?.(false)
    }
    const cancelDrag = () => {
      const id = dragging.current || pressedPlacemark.current
      if (!id) return
      dragging.current = null; pressedPlacemark.current = null; setDraggingPlacemark(null)
      const item = markers.current.find(item => item.id === id), point = mapPlacemarks.find(point => point.id === id)
      // A cancelled MapLibre marker retains private drag state after remove().
      // Rebuild fresh markers instead of reusing the interrupted instance.
      if (item && point) {item.marker.setLngLat(point.coordinates); item.marker.remove(); setMarkerRevision(value => value + 1)}
      dragChange.current?.(false)
    }
    window.addEventListener('pointerup', releasePress)
    window.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('blur', cancelDrag)
    return () => {
      window.removeEventListener('pointerup', releasePress)
      window.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('blur', cancelDrag)
      markers.current.forEach(item => item.marker.remove()); markers.current = []
      if (dragging.current || pressedPlacemark.current) {dragging.current = null; pressedPlacemark.current = null; setDraggingPlacemark(null); dragChange.current?.(false)}
    }
  }, [mapPlacemarks, markerRevision])

  useEffect(() => {
    markers.current.forEach(({button}) => {
      const count = button.querySelector<HTMLElement>('.trk-map-placemark-count')
      if (count) count.hidden = !settings.placemarkPointShowCount
      const name = button.querySelector<HTMLElement>('.trk-map-placemark-name')
      if (name) name.hidden = !settings.placemarkPointShowName
      button.dataset.pointShowCount = String(settings.placemarkPointShowCount)
    })
  }, [mapPlacemarks, markerRevision, settings.placemarkPointShowCount, settings.placemarkPointShowName])

  useEffect(() => {
    markers.current.forEach(item => {
      item.marker.setDraggable(placemarkMovable)
      item.button.dataset.placemarkDraggable = String(placemarkMovable)
      const point = mapPlacemarks.find(point => point.id === item.id)
      const title = point ? placemarkTitle(point) : ''
      item.button.title = placemarkMovable ? `${title ? title + ' · ' : ''}拖动或 Alt+方向键修正位置` : title
      if (placemarkMovable) item.button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown')
      else item.button.removeAttribute('aria-keyshortcuts')
      if (!placemarkMovable && dragging.current === item.id && point) item.marker.setLngLat(point.coordinates)
    })
    if (!placemarkMovable && (dragging.current || pressedPlacemark.current)) {dragging.current = null; pressedPlacemark.current = null; setDraggingPlacemark(null); dragChange.current?.(false)}
  }, [placemarkMovable, mapPlacemarks])

  useEffect(() => {
    markers.current.forEach(item => item.button.setAttribute('aria-pressed', String(item.id === selectedMarkerId)))
  }, [selectedMarkerId, mapPlacemarks])

  useEffect(() => {
    closeDetails.current = null
    const container = detailsHolder.current
    if (!container) return
    const previousSelection = popupSelection.current; popupSelection.current = selectedPlacemark
    const point = placemarks.find(item => item.id === selectedPlacemark), group = selectedGroup
    const groupId = group?.id ?? null
    const cover = group ? groupCoverPhoto(group, filteredPlacemarks) : undefined
    const coverKey = JSON.stringify(cover ? [cover.point.id, cover.url] : [])
    if (openPhotoGroup.current !== groupId) {
      for (const id of [openPhotoGroup.current, groupId]) if (id) {groupPhoto.current.delete(id); browsedGroups.current.delete(id)}
      openPhotoGroup.current = groupId; openGroupCover.current = coverKey
    }
    // An external child selection starts at that child's photo. Local carousel
    // navigation keeps its own slide without selecting or expanding the child.
    const changedChild = Boolean(point && previousSelection !== selectedPlacemark)
    if (group && changedChild) browsedGroups.current.delete(group.id)
    if (group && selectedPlacemark === group.id && (group.memberIds.includes(previousSelection ?? '')
      || (openGroupCover.current !== coverKey && !browsedGroups.current.has(group.id)))) {
      groupPhoto.current.delete(group.id)
    }
    openGroupCover.current = coverKey
    if (keyboardPlacemark.current !== selectedMarkerId) keyboardPlacemark.current = null
    if (!selectedMarkerId || (!group && (!point || point.hidden)) || (point && !matchesPlacemarkType(point, placemarkTypeFilter))
      || (group && groupHidden(group, filteredPlacemarks)) || !settings.sandboxPlacemarks || (view === 'sandbox' && loading) || draggingPlacemark) return
    const targetId = group?.id ?? point!.id, keepMarkerFocus = keyboardPlacemark.current === targetId
    const close = () => {
      if (!detailsHolder.current) return
      if (group) {groupPhoto.current.delete(group.id); browsedGroups.current.delete(group.id); openPhotoGroup.current = null; openGroupCover.current = null}
      closePlacemark.current?.()
      if (view === 'sandbox') Array.from(sandboxHolder.current?.querySelectorAll<HTMLButtonElement>('[data-sandbox-placemark]') ?? [])
        .find(marker => marker.dataset.sandboxPlacemark === targetId)?.focus({preventScroll: true})
      else if (noWebGL) Array.from(container.parentElement?.querySelectorAll<SVGGElement>('[data-outline-placemark]') ?? [])
        .find(marker => marker.getAttribute('data-outline-placemark') === targetId)?.focus({preventScroll: true})
      else if (view === 'terrain' && liveSettings.current.terrainPlacemarkMode === 'marker') floatingPlacemarks.current?.getButton(targetId)?.focus({preventScroll: true})
      else markers.current.find(item => item.id === targetId)?.button.focus({preventScroll: true})
    }
    closeDetails.current = close
    const {width: paneWidth, height: paneHeight} = detailsViewport
    const maxWidth = Math.max(1, Math.min(420, paneWidth - 32)), maxHeight = Math.max(72, paneHeight - 32)
    const options = {trackId, maxWidth, maxHeight,
      onEdit: placemarkEditable ? () => editPlacemark.current?.(targetId) : undefined, editDisabled: placemarkEditingDisabled}
    const photos = group ? groupPhotos(group, filteredPlacemarks) : []
    const remembered = group ? groupPhoto.current.get(group.id) : undefined
    const childPhoto = point ? photos.find(photo => photo.point.id === point.id) : undefined
    const active = group ? changedChild ? childPhoto
      : photos.find(photo => photo.point.id === remembered?.pointId && photo.url === remembered.url)
        ?? childPhoto ?? (point ? undefined : cover) : undefined
    if (group && active) groupPhoto.current.set(group.id, {pointId: active.point.id, url: active.url})
    else if (group && changedChild) groupPhoto.current.delete(group.id)
    const contents = group ? createPlacemarkGroupDetails(group, filteredPlacemarks, close, {...options,
      selectedPointId: point?.id, selectedPhoto: active ? {pointId: active.point.id, url: active.url} : undefined,
      onChangePhoto: (photo, focusLabel) => {
        groupPhoto.current.set(group.id, photo); browsedGroups.current.add(group.id)
        groupControlFocus.current = focusLabel ?? null; setGroupPhotoRevision(value => value + 1)
      },
      onViewImage: (url, index) => setLargePhoto({url, name: placemarkTitle(photos[index].point), selectionId: selectedPlacemark!, groupId: group.id, pointId: photos[index].point.id}),
    }) : createPlacemarkDetails(point!, close, {...options,
      onViewImage: url => setLargePhoto({url, name: placemarkTitle(point!), selectionId: point!.id})})
    contents.style.maxHeight = `${maxHeight}px`
    container.replaceChildren(contents)
    const preserveToolFocus = Boolean(container.parentElement?.querySelector('.trk-map-dock')?.contains(document.activeElement))
    const label = groupControlFocus.current; groupControlFocus.current = null
    if (keepMarkerFocus) {
      if (noWebGL) Array.from(container.parentElement?.querySelectorAll<SVGGElement>('[data-outline-placemark]') ?? [])
        .find(marker => marker.getAttribute('data-outline-placemark') === targetId)?.focus({preventScroll: true})
      else markers.current.find(item => item.id === targetId)?.button.focus({preventScroll: true})
      keyboardPlacemark.current = null
    } else if (!largePhotoRef.current && !preserveToolFocus) {
      (label ? contents.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
        : contents.querySelector<HTMLButtonElement>('.trk-placemark-details-close'))?.focus({preventScroll: true})
    }
    return () => {closeDetails.current = null; container.replaceChildren()}
  }, [trackId, selectedPlacemark, selectedMarkerId, placemarks, filteredPlacemarks, placemarkTypeFilter, placemarkGroups, noWebGL,
    view, draggingPlacemark, placemarkEditable, placemarkEditingDisabled, groupPhotoRevision, settings.sandboxPlacemarks, loading,
    detailsViewport.width, detailsViewport.height])

  useEffect(() => {
    if (view !== 'sandbox' || requestedData.current !== geojson) return
    const created = map.current
    const container = sandboxHolder.current
    if (!created || !container) return
    let cancelled = false
    const pending: Sampling = {controller: new AbortController(), basemapFailed: false}
    sampling.current = pending
    setLoading(true)
    setSandboxError(null)
    setTextureUnavailable(false)

    const knownTextureFailure = basemap !== 'none' && basemapUnavailable.current
    setHasSandboxTexture(false)
    void sampleSandboxDetached(points, {
      signal: pending.controller.signal,
      settings: {...settings, basemap},
      textureEnabled: basemap !== 'none' && basemap !== 'osm' && !knownTextureFailure,
    }).then(result => {
      if (cancelled || pending.controller.signal.aborted) return
      const next = new SandboxRenderer(container, () => {
        if (cancelled) return
        renderer.current = null
        requestedData.current = null
        setLoading(false)
        setView('map')
        setSandboxError('3D 沙盘的图形上下文已丢失，已返回二维地图，可重试沙盘。')
      })
      try { next.build(result.terrain, points, result.texture, {quality: settings.quality, exaggeration: settings.exaggeration,
        routeColor: liveSettings.current.routeColor, lighting: liveSettings.current.lighting, colors: liveSettings.current.sandboxColors, background: liveSettings.current.sandboxBackground, segmentStarts}) }
      catch (error) { next.dispose(); throw error }
      renderer.current = next
      next.updatePlacemarks?.(liveSandboxMarkers.current, {visible: liveSettings.current.sandboxPlacemarks, mode: liveSettings.current.sandboxPlacemarkMode,
        pointSize: liveSettings.current.placemarkPointSize, pointColor: liveSettings.current.placemarkPointColor, groupColor: liveSettings.current.placemarkGroupColor, pointRadius: liveSettings.current.placemarkPointRadius,
        pointShowCount: liveSettings.current.placemarkPointShowCount, pointShowName: liveSettings.current.placemarkPointShowName,
        selectedId: liveSelectedMarker.current, labelColor: liveSettings.current.sandboxLabelColor, labelSize: liveSettings.current.sandboxLabelSize, labelHeight: liveSettings.current.sandboxLabelHeight, connectorColor: liveSettings.current.sandboxConnectorColor, onSelect: id => selectMarker.current(id)})
      setHasSandboxTexture(!!result.texture && !result.textureUnavailable)
      setTextureUnavailable(result.textureUnavailable || knownTextureFailure)
      setLoading(false)
    }).catch(error => {
      if (cancelled || pending.controller.signal.aborted) return
      setLoading(false)
      requestedData.current = null
      setView('map')
      const reason = error instanceof Error ? error.message : String(error)
      setSandboxError(`3D 沙盘暂时不可用：${reason}`)
    }).finally(() => {
      if (sampling.current !== pending) return
      sampling.current = null
    })

    return () => {
      cancelled = true
      pending.controller.abort()
      if (sampling.current === pending) sampling.current = null
      renderer.current?.dispose()
      renderer.current = null
    }
  }, [view, geojson, basemap, basemapRetry, settings.terrainProvider, settings.maptilerKey, settings.quality, settings.exaggeration])

  const sandboxVisible = view === 'sandbox'
  const viewerGroup = placemarkGroups.find(group => group.id === largePhoto?.groupId)
  const viewerPhotos = viewerGroup ? groupPhotos(viewerGroup, filteredPlacemarks) : []
  const viewerIndex = viewerPhotos.findIndex(photo => photo.point.id === largePhoto?.pointId && photo.url === largePhoto.url)
  return (
    <div className={`trk-map-wrap${sandboxVisible ? ' trk-sandbox-active' : ''}`} data-track-map-view={view}
      onPointerDown={event => {backgroundPress.current = {x: event.clientX, y: event.clientY, moved: false}}}
      onPointerMove={event => {const press = backgroundPress.current; if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true}}
      onPointerCancel={() => {backgroundPress.current = null}}
      onClick={event => {
        if (backgroundPress.current?.moved || onPickPlacemark || !(event.target instanceof Element)) return
        if (event.target.closest('button,a,input,select,[data-outline-placemark],[data-sandbox-placemark],.trk-map-floating-placemark')) return
        if (event.target.closest('.trk-map,.trk-outline,.trk-sandbox')) closeDetails.current?.()
      }}
      data-placemark-mode={sandboxVisible ? settings.sandboxPlacemarkMode : view === 'terrain' ? settings.terrainPlacemarkMode : 'point'}
      style={{'--trk-point-size': `${settings.placemarkPointSize}px`, '--trk-point-hit-size': `${Math.max(44, settings.placemarkPointSize + 8)}px`,
        '--trk-point-radius': `${settings.placemarkPointRadius}%`, '--trk-point-corner-radius': `${settings.placemarkPointSize * settings.placemarkPointRadius / 100}px`,
        '--trk-point-name-color': settings.sandboxLabelColor, '--trk-point-name-stroke': placemarkInk(settings.sandboxLabelColor), '--trk-point-name-size': `${settings.sandboxLabelSize}px`,
        '--trk-group-badge-shadow': settings.placemarkPointRadius === 50 ? '0 1px 4px #0003' : '3px 3px 0 var(--trk-group-shadow,#a9c4ff)', '--trk-point-color': settings.placemarkPointColor, '--trk-group-color': settings.placemarkGroupColor,
        '--trk-point-ink': placemarkInk(settings.placemarkPointColor), '--trk-group-ink': placemarkInk(settings.placemarkGroupColor),
        '--trk-point-font-size': `${Math.max(9, Math.round(settings.placemarkPointSize * 11 / 24))}px`,
        '--trk-group-font-size': `${Math.max(9, Math.round(settings.placemarkPointSize * 10 / 24))}px`,
        '--trk-group-shadow': settings.placemarkGroupColor === '#2563eb' ? '#a9c4ff' : settings.placemarkGroupColor} as CSSProperties}>
      <div className="trk-map" ref={holder} aria-hidden={sandboxVisible || undefined} />
      {noWebGL && <TrackOutline routeColor={settings.routeColor} segmentStarts={segmentStarts} onPick={onPickPlacemark} points={points} placemarks={mapPlacemarks} selected={selectedMarkerId} onSelect={id => {if (dragging.current || keyboardPlacemark.current === id) selectPlacemark.current?.(id); else selectMarker.current(id)}}
        pointSize={settings.placemarkPointSize} pointColor={settings.placemarkPointColor} groupColor={settings.placemarkGroupColor} pointRadius={settings.placemarkPointRadius}
        pointShowCount={settings.placemarkPointShowCount} pointShowName={settings.placemarkPointShowName} labelColor={settings.sandboxLabelColor} labelSize={settings.sandboxLabelSize}
        onMove={onMovePlacemark} disabled={!placemarkMovable} onKeyboardMove={id=>{keyboardPlacemark.current=id}}
        onDragging={id=>{dragging.current=id;setDraggingPlacemark(id);dragChange.current?.(!!id);if(id){keyboardPlacemark.current=null;setLargePhoto(null)}}} />}
      {onPickPlacemark&&<div className="trk-map-drag-hint trk-map-position-hint"><span>点击地图定位，自动吸附到轨迹</span><button type="button" className="trk-secondary" onClick={()=>{const center=map.current?.getCenter();if(center)onPickPlacemark([center.lng,center.lat]);else if(bounds)onPickPlacemark([(bounds.getWest()+bounds.getEast())/2,(bounds.getSouth()+bounds.getNorth())/2])}}>使用地图中心位置</button></div>}
      {largePhoto && <PlacemarkPhotoViewer trackId={trackId} url={largePhoto.url} name={largePhoto.name} onClose={()=>setLargePhoto(null)}
        {...(viewerGroup ? {gallery: viewerPhotos.map(photo=>({url:photo.url,name:placemarkTitle(photo.point)})), selectedIndex: Math.max(0,viewerIndex),
          onSelectImage: (index:number) => {
            const photo=viewerPhotos[index]; if(!photo)return
            groupPhoto.current.set(viewerGroup.id,{pointId:photo.point.id,url:photo.url})
            setLargePhoto({url:photo.url,name:placemarkTitle(photo.point),selectionId:photo.point.id,groupId:viewerGroup.id,pointId:photo.point.id})
            browsedGroups.current.add(viewerGroup.id); setGroupPhotoRevision(value=>value+1)
          }} : {})}/>}
      <div className="trk-sandbox" ref={sandboxHolder} style={{backgroundColor: settings.sandboxColors.background}} aria-label="3D 地形沙盘" aria-hidden={!sandboxVisible} />
      <div className="trk-map-details" ref={detailsHolder}
        hidden={!selectedMarkerId || !settings.sandboxPlacemarks || Boolean(draggingPlacemark) || (sandboxVisible && loading)}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} />
      <style>{SANDBOX_CSS}</style>
      <div className="trk-map-toolbar" ref={toolbar}>
        <div className="trk-view-tabs" role="group" aria-label="地图视图">
          <button type="button" aria-pressed={view === 'map'} data-track-view="map" onClick={() => selectView('map')}>二维地图</button>
          <button type="button" aria-pressed={view === 'terrain'} data-track-view="terrain" disabled={noWebGL || !!onPickPlacemark} onClick={() => selectView('terrain')}>3D 地图</button>
          <button type="button" aria-pressed={sandboxVisible} data-track-view="sandbox" disabled={noWebGL || !!onPickPlacemark} title={noWebGL ? '当前设备没有可用的 WebGL' : '查看区域地形和贴地轨迹'} onClick={() => selectView('sandbox')}>3D 沙盘</button>
        </div>
        {trackId && <div className="trk-map-export-tools">
          <button type="button" className="trk-map-export-button" disabled={exportBusy || noWebGL || !!onPickPlacemark || (sandboxVisible && (loading || !!sandboxError))}
            title={noWebGL ? '当前设备没有可用的 WebGL，无法导出地图图片' : onPickPlacemark ? '完成地图定位后可导出图片' : '将当前视角保存为 PNG 图片'} onClick={() => void saveMapImage()}>{exportBusy ? '保存中…' : '保存到资源库'}</button>
          {exportNotice && <span className="trk-map-export-notice" role="status">{exportNotice}</span>}
          {exportError && <div className="trk-map-export-notice" role="alert"><span>{exportError}</span>{pendingExport && <button type="button" disabled={exportBusy} onClick={() => void saveMapImage(pendingExport)}>重试保存</button>}</div>}
        </div>}
      </div>
      <BasemapControls layout="dock" basemap={basemap} viewSettings={view !== 'map' && <MapViewSettingsControls key={view} mode={view} />} mapControls={<>
        <div ref={nativeNavigation} className="trk-map-native-navigation" hidden={sandboxVisible} />
        {sandboxVisible ? <>
          <button type="button" aria-label="放大沙盘" title="放大沙盘" disabled={loading} onClick={() => renderer.current?.zoomIn()}>＋</button>
          <button type="button" aria-label="缩小沙盘" title="缩小沙盘" disabled={loading} onClick={() => renderer.current?.zoomOut()}>－</button>
          <button type="button" aria-label="重置沙盘视角" title="重置沙盘视角" disabled={loading} onClick={() => renderer.current?.resetView()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7"/></svg><span className="trk-map-control-label">重置视角</span>
          </button>
          {!loading && <SandboxLightingControls dock />}
        </> : view === 'terrain' && <button type="button" aria-label="重置 3D 视角" title="重置 3D 视角" onClick={() => {
          const created=map.current;if(!created)return
          if(bounds)created.fitBounds(bounds,{padding:48,duration:0,pitch:60,bearing:0});else created.jumpTo({pitch:60,bearing:0})
        }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7"/></svg><span className="trk-map-control-label">重置 3D 视角</span></button>}
        <MapDisplayControls placemarks={placemarks} typeFilter={placemarkTypeFilter} onTypeFilter={onPlacemarkTypeFilterChange}
          disabled={placemarkDisplayControlsDisabled} sandbox={sandboxVisible} terrain={view === 'terrain'} />
      </>} onBasemap={next => {
        stopSandbox()
        if (basemap === next) setBasemapRetry(value => value + 1)
        onBasemap(next)
      }}/>

      {terrainError && <div className="trk-note" role="status">{terrainError}</div>}
      {sandboxVisible && loading && <div className="trk-sandbox-loading" style={{backgroundColor: settings.sandboxColors.background}} role="status" aria-live="polite">
        <strong>正在生成 3D 沙盘</strong><span>加载区域高程和地图贴图…</span>
      </div>}
      {sandboxError && <div className="trk-note trk-sandbox-error" role="status">
        <span>{sandboxError}</span><button type="button" onClick={() => selectView('sandbox')}>重试沙盘</button>
      </div>}
      {!sandboxError && !sandboxVisible && basemapBroken && <div className="trk-note">底图需要联网，当前只显示轨迹线</div>}
      {noWebGL && <div className="trk-note">这台设备没有可用的 WebGL，已改为绘制轨迹轮廓</div>}
      {(!sandboxVisible || !loading) && <details key={view} className="trk-sandbox-footer" onKeyDown={event => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus({preventScroll: true})
        }
      }}>
        <summary aria-label="地图信息" title="地图信息"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></summary>
        <div className="trk-sandbox-info">
          {sandboxVisible ? <>
            <div className="trk-sandbox-hint">拖动旋转 · 右键拖动平移 · 滚轮缩放{basemap === 'osm' ? ' · OSM 标准图仅用于交互查看；切换矢量或 MapTiler 可使用地图纹理' : textureUnavailable ? ' · 底图不可用，已显示地形着色' : ''}</div>
            <MapCredits className="trk-sandbox-attribution" basemap={basemap} terrain texture={hasSandboxTexture}/>
          </> : <>
            <div className="trk-maptitle" title={name}>{name}</div>
            {!onPickPlacemark && onMovePlacemark && mapPlacemarks.length > 0 && <div className="trk-map-drag-hint">{placemarkEditingDisabled ? '点位位置暂不可编辑' : '拖动标记或 Alt+方向键修正位置'}</div>}
            <MapCredits placement="inline" className="trk-map-extra-credits" basemap={noWebGL || basemapBroken ? 'none' : basemap} terrain={view === 'terrain'}/>
          </>}
        </div>
      </details>}
    </div>
  )
}

type OutlineDrag = {id: string; pointer: number; startX: number; startY: number; x: number; y: number}
type OutlineScreenLinear = {a: number; b: number; c: number; d: number}
type OutlineScreenTransform = OutlineScreenLinear & {e: number; f: number}
function outlineScreenTransform(svg: SVGSVGElement): OutlineScreenTransform | null {
  try {
    const matrix = svg.getScreenCTM?.()
    if (matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)
      && Number.isFinite(matrix.a * matrix.d - matrix.b * matrix.c) && matrix.a * matrix.d - matrix.b * matrix.c !== 0) {
      return {a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f}
    }
  } catch { /* Older SVG implementations can require a content-box fallback. */ }
  const rect = svg.getBoundingClientRect(), style = getComputedStyle(svg)
  const px = (value: string) => Number.parseFloat(value) || 0
  const left = px(style.paddingLeft) + px(style.borderLeftWidth), right = px(style.paddingRight) + px(style.borderRightWidth)
  const top = px(style.paddingTop) + px(style.borderTopWidth), bottom = px(style.paddingBottom) + px(style.borderBottomWidth)
  const width = rect.width - left - right, height = rect.height - top - bottom
  const scale = Math.min(width / 1000, height / 700)
  if (![width, height, scale, rect.left, rect.top].every(Number.isFinite) || scale <= 0) return null
  return {a: scale, b: 0, c: 0, d: scale,
    e: rect.left + left + (width - 1000 * scale) / 2, f: rect.top + top + (height - 700 * scale) / 2}
}
function outlineLocalDelta(frame: OutlineScreenLinear, x: number, y: number) {
  const determinant = frame.a * frame.d - frame.b * frame.c
  return {x: (frame.d * x - frame.c * y) / determinant, y: (frame.a * y - frame.b * x) / determinant}
}
function TrackOutline({routeColor = TRACK_COLOR, pointSize = 24, pointColor = '#c83532', groupColor = '#2563eb', pointRadius = 50, pointShowCount = true, pointShowName = false, labelColor = '#ffffff', labelSize = 16, points, placemarks, selected, onSelect, onMove, disabled, onDragging, onKeyboardMove,segmentStarts,onPick}: {
  segmentStarts?:readonly number[];onPick?:(coordinates:[number,number])=>void
  points: readonly TrackPoint[]; placemarks: readonly MapPlacemark[]; selected: string | null
  onSelect?: (id: string) => void; onMove?: (id: string, coordinates: [number, number]) => void
  routeColor?: string
  pointSize?: number; pointColor?: string; groupColor?: string; pointRadius?: number; pointShowCount?: boolean; pointShowName?: boolean; labelColor?: string; labelSize?: number
  disabled: boolean; onDragging: (id: string | null) => void
  onKeyboardMove: (id: string) => void
}) {
  const canvas = useRef<SVGSVGElement | null>(null)
  const [screenFrame, setScreenFrame] = useState<OutlineScreenLinear>({a: 1, b: 0, c: 0, d: 1})
  useEffect(() => {
    const svg = canvas.current
    if (!svg) return
    const resize = () => {
      const frame = outlineScreenTransform(svg) ?? {a: 1, b: 0, c: 0, d: 1}
      setScreenFrame(previous => previous.a === frame.a && previous.b === frame.b && previous.c === frame.c && previous.d === frame.d ? previous : frame)
    }
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(svg)
    window.addEventListener('resize', resize)
    return () => {observer?.disconnect(); window.removeEventListener('resize', resize)}
  }, [points, placemarks])
  const gesture = useRef<OutlineDrag | null>(null)
  const suppressClickUntil = useRef(0)
  const [live, setLive] = useState<{id: string; x: number; y: number} | null>(null)
  const cancel = () => {
    if (!gesture.current) return
    gesture.current = null; setLive(null); onDragging(null)
  }
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {cancelRef.current()}, [disabled, points, placemarks])
  useEffect(() => {
    const blur = () => cancelRef.current()
    window.addEventListener('blur', blur)
    return () => {window.removeEventListener('blur', blur); cancelRef.current()}
  }, [])
  // Keep the outline and its inverse interaction coordinates in one local
  // longitude frame, so a short dateline crossing does not span the world.
  const origin=points.find(point=>Number.isFinite(point[0])&&Number.isFinite(point[1]))?.[0]??0
  const longitude=(value:number)=>origin+(((value-origin+180)%360+360)%360-180)
  const outlineBounds=points.map(point=>[longitude(point[0]),point[1],point[2],point[3]] as TrackPoint)
  const box = boundsOf([...outlineBounds,...placemarks.filter(point => !point.hidden).map(point=>[longitude(point.coordinates[0]),point.coordinates[1],null,null] as TrackPoint)])
  if (!box) return null
  const west = box.getWest()
  const south = box.getSouth()
  const spanLon = Math.max(box.getEast() - west, 1e-6)
  const spanLat = Math.max(box.getNorth() - south, 1e-6)
  const pixel = ([lon,lat]: readonly [number,number,...unknown[]]) => [80 + (longitude(lon)-west)/spanLon*840, 120 + (1-(lat-south)/spanLat)*460]
  const canvasPosition = (event: {currentTarget:SVGSVGElement;clientX:number;clientY:number}) => {
    const frame = outlineScreenTransform(event.currentTarget)
    return frame ? outlineLocalDelta(frame, event.clientX - frame.e, event.clientY - frame.f) : null
  }
  const inverseX = outlineLocalDelta(screenFrame, 1, 0), inverseY = outlineLocalDelta(screenFrame, 0, 1)
  const displayTransform = screenFrame.b === 0 && screenFrame.c === 0 && screenFrame.a === screenFrame.d
    ? `scale(${1 / screenFrame.a})` : `matrix(${inverseX.x} ${inverseX.y} ${inverseY.x} ${inverseY.y} 0 0)`
  const outlineGeometry=toGeoJSON(points,segmentStarts??[0]).line.geometry
  const parts=outlineGeometry.type==='MultiLineString'?outlineGeometry.coordinates:[outlineGeometry.coordinates]
  const paths=parts.map(part=>part.map(point=>pixel([point[0],point[1]]).join(',')).join(' '))
  return <svg ref={canvas} className="trk-outline" viewBox="0 0 1000 700" aria-label="轨迹轮廓"
    onClick={event=>{if(onPick){const position=canvasPosition(event);if(position){const coordinates=validPlacemarkPosition(west+(position.x-80)/840*spanLon,south+(1-(position.y-120)/460)*spanLat);if(coordinates)onPick(coordinates)}}}}
    onPointerDown={event => {
      if (disabled || !onMove || gesture.current || event.button !== 0) return
      const group = (event.target as Element).closest<SVGGElement>('[data-outline-placemark]')
      const point = placemarks.find(point => point.id === group?.dataset.outlinePlacemark)
      const position = canvasPosition(event)
      if (!point || !position) return
      const [x, y] = pixel(point.coordinates)
      gesture.current = {id: point.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: x - position.x, y: y - position.y}
      onDragging(point.id)
      event.preventDefault(); event.stopPropagation()
      try {event.currentTarget.setPointerCapture(event.pointerId)} catch { /* capture is optional on older SVG implementations */ }
    }}
    onPointerMove={event => {
      const current = gesture.current
      if (!current || current.pointer !== event.pointerId || disabled) return
      const position = canvasPosition(event)
      if (!position || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) return
      event.preventDefault(); event.stopPropagation()
      setLive({id: current.id, x: position.x + current.x, y: position.y + current.y}); onDragging(current.id)
    }}
    onPointerUp={event => {
      const current = gesture.current
      if (!current || current.pointer !== event.pointerId) return
      const position = canvasPosition(event)
      const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 3
      if (!disabled && onMove && position && moved) {
        event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = Date.now() + 350
        const coordinates = validPlacemarkPosition(west + (position.x + current.x - 80) / 840 * spanLon,
          south + (1 - (position.y + current.y - 120) / 460) * spanLat)
        if (coordinates) {onMove(current.id, coordinates); onSelect?.(current.id)}
      }
      cancel()
      try {event.currentTarget.releasePointerCapture(event.pointerId)} catch { /* capture may already be released */ }
    }}
    onPointerCancel={event => {if (gesture.current?.pointer === event.pointerId) cancel()}}
    onLostPointerCapture={event => {if (gesture.current?.pointer === event.pointerId) cancel()}}
    onKeyDown={event => {if (event.key === 'Escape') cancel()}}>
    <>{paths.map((path,index)=><polyline key={index} points={path} fill="none" stroke={routeColor} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />)}</>
    {placemarks.map(point=>{
      if (point.hidden) return null
      const [x,y] = live?.id === point.id ? [live.x, live.y] : pixel(point.coordinates)
      const title = placemarkTitle(point), canMove = Boolean(onMove) && !disabled
      return <g key={point.id} data-outline-placemark={point.id} data-placemark-id={point.id} data-placemark-draggable={canMove}
        role="button" tabIndex={0} aria-label={point.groupCount!==undefined?`标记组 ${point.markerLabel}${title?`：${title}`:''}，${point.groupCount} 个子点`:title?`标注点 ${point.markerLabel}：${title}`:`标注点 ${point.markerLabel}`} aria-pressed={selected===point.id}
        onClick={event=>{event.stopPropagation();if(event.detail>0&&Date.now()<suppressClickUntil.current){event.preventDefault();return}onSelect?.(point.id)}}
        aria-keyshortcuts={canMove ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined}
        onKeyDown={event=>{
          if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect?.(point.id);return}
          const step = placemarkKeyStep(event.key)
          if (!event.altKey || !step || !onMove) return
          event.preventDefault(); event.stopPropagation()
          if (disabled) return
          const svg = event.currentTarget.ownerSVGElement
          const frame = svg ? outlineScreenTransform(svg) : null
          const delta = frame ? outlineLocalDelta(frame, step[0], step[1]) : {x: step[0], y: step[1]}
          const coordinates = validPlacemarkPosition(west + (x + delta.x - 80) / 840 * spanLon,
            south + (1 - (y + delta.y - 120) / 460) * spanLat)
          if (coordinates) {onKeyboardMove(point.id); onMove(point.id, coordinates); onSelect?.(point.id)}
        }}
        style={{cursor:live?.id===point.id?'grabbing':canMove?'grab':'pointer',touchAction:canMove?'none':undefined}}>
        <title>{canMove ? `${title ? title + ' · ' : ''}拖动或 Alt+方向键修正位置` : title}</title>
        {/* Compensate only display geometry; the geographic anchor and drag frame stay unchanged. */}
        <g data-point-visual transform={`translate(${x} ${y}) ${displayTransform} translate(${-x} ${-y})`}>
        <circle data-point-hit cx={x} cy={y} r={Math.max(22, pointSize / 2 + 4)} fill="transparent"/>
        {point.groupCount!==undefined && pointRadius < 50 && <rect x={x-pointSize/2+3} y={y-pointSize/2+3} width={pointSize} height={pointSize}
          rx={pointSize * pointRadius / 100} fill={groupColor === '#2563eb' ? '#a9c4ff' : groupColor}/>}
        <rect data-point-badge x={x-pointSize/2} y={y-pointSize/2} width={pointSize} height={pointSize} rx={pointSize * pointRadius / 100} ry={pointSize * pointRadius / 100}
          fill={point.groupCount!==undefined ? groupColor : pointColor} stroke={selected===point.id?'var(--trk-focus)':'white'} strokeWidth={selected===point.id?3:2}/>
        {point.groupCount!==undefined && pointShowCount && <g data-point-count>
          <circle cx={x+pointSize/2+2} cy={y-pointSize/2-1} r={8} fill={groupColor} stroke="white"/>
          <text x={x+pointSize/2+2} y={y-pointSize/2+2} textAnchor="middle" fill={placemarkInk(groupColor)} fontSize={9}>{point.groupCount}</text>
        </g>}
        {pointShowName && title && <foreignObject data-point-name x={x-124} y={y-pointSize/2-(point.groupCount!==undefined && pointShowCount ? 9 : 0)-4-labelSize*2.75} width={248} height={labelSize*2.75}>
          <div className="trk-outline-point-name-wrap"><span className="trk-outline-point-name" style={{color:labelColor,fontSize:labelSize}}>{title}</span></div>
        </foreignObject>}
        <text x={x} y={y+4} textAnchor="middle" fill={placemarkInk(point.groupCount!==undefined ? groupColor : pointColor)}
          fontSize={Math.max(9, Math.round(pointSize * (point.groupCount!==undefined ? 10 : 11) / 24))}>{point.markerLabel}</text>
        </g>
      </g>
    })}
  </svg>
}

function validPlacemarkPosition(lng: number, lat: number): [number, number] | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat < -90 || lat > 90) return null
  return [lng >= -180 && lng <= 180 ? lng : ((lng + 180) % 360 + 360) % 360 - 180, lat]
}

function placemarkKeyStep(key: string): [number, number] | null {
  switch (key) {
    case 'ArrowLeft': return [-20, 0]
    case 'ArrowRight': return [20, 0]
    case 'ArrowUp': return [0, -20]
    case 'ArrowDown': return [0, 20]
    default: return null
  }
}

function placemarkInk(color: string): string {
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#000000' : '#ffffff'
}

let styleMounted = false
function mountStyle(): void {
  if (styleMounted || document.querySelector('style[data-plugin="cqai-dsh-plugin-track"]')) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin', 'cqai-dsh-plugin-track')
  style.textContent = MAP_STYLE
  document.head.appendChild(style)
  styleMounted = true
}

function boundsOf(points: readonly TrackPoint[]): LngLatBounds | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    minLon = Math.min(minLon, lon); minLat = Math.min(minLat, lat)
    maxLon = Math.max(maxLon, lon); maxLat = Math.max(maxLat, lat)
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null
  return new LngLatBounds([minLon, minLat], [maxLon, maxLat])
}

const SANDBOX_CSS = `
.trk-map-details{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:7;width:max-content;max-width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:hidden;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface);color:var(--trk-text);box-shadow:0 4px 16px #0003;pointer-events:auto;overscroll-behavior:contain}.trk-map-details:empty,.trk-map-details[hidden]{display:none}.trk-map-details>.trk-placemark-details,.trk-map-details>.trk-placemark-group-details{max-width:100%;box-sizing:border-box}.trk-map-details .trk-placemark-details-close{min-width:44px;min-height:44px}.trk-map-wrap .trk-map-details .trk-placemark-details-carousel button,.trk-map-wrap .trk-map-details .trk-placemark-details-actions button{min-width:44px;min-height:44px}.trk-map-details .trk-placemark-details-title{padding-right:44px}
.trk-map-position-hint{display:flex;align-items:center;gap:8px}.trk-map-position-hint button{pointer-events:auto;min-height:36px;font:inherit}
.trk-map-wrap .trk-placemark-group-details{overflow:hidden}.trk-placemark-group-details>.trk-placemark-details{display:flex;flex-direction:column;max-width:100%;max-height:inherit;overflow:hidden}.trk-placemark-group-details .trk-placemark-details-photos{flex-shrink:0}.trk-placemark-group-details .trk-placemark-details-body{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;overflow:hidden}.trk-placemark-group-details .trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-body{overflow:hidden}.trk-placemark-group-info-scroll{min-width:0;min-height:0;flex:1 1 auto;overflow-x:hidden;overflow-y:auto}.trk-placemark-group-details .trk-placemark-details-carousel,.trk-placemark-group-details .trk-placemark-details-actions{flex-shrink:0}.trk-map-details .trk-placemark-group-details>.trk-placemark-details:not(.trk-placemark-details-photo-overlay){overflow-y:auto;overscroll-behavior:contain}.trk-map-details .trk-placemark-group-details>.trk-placemark-details:not(.trk-placemark-details-photo-overlay) .trk-placemark-details-body{min-height:136px;box-sizing:border-box}.trk-map-details .trk-placemark-group-info-scroll{overscroll-behavior:contain}
.trk-map-placemark-group .trk-map-placemark-dot{background:var(--trk-group-color,#2563eb);color:var(--trk-group-ink,white);border-radius:var(--trk-point-corner-radius,var(--trk-point-radius,50%));box-shadow:var(--trk-group-badge-shadow,0 1px 4px #0003);font-size:var(--trk-group-font-size,10px)}.trk-map-placemark-count{position:absolute;top:calc((var(--trk-point-hit-size,44px) - var(--trk-point-size,24px))/2 - 7px);right:calc((var(--trk-point-hit-size,44px) - var(--trk-point-size,24px))/2 - 9px);min-width:15px;box-sizing:border-box;border:1px solid white;border-radius:9px;padding:1px 3px;background:var(--trk-group-color,#2563eb);color:var(--trk-group-ink,white);font:700 9px/12px system-ui,sans-serif;pointer-events:none}
.trk-map-placemark-name{position:absolute;left:50%;bottom:calc((var(--trk-point-hit-size,44px) + var(--trk-point-size,24px))/2 + 4px);width:max-content;max-width:248px;transform:translateX(-50%);color:var(--trk-point-name-color,white);font:600 var(--trk-point-name-size,16px)/1.375 var(--trk-font-family,system-ui,sans-serif);text-align:center;text-shadow:-1px -1px 0 var(--trk-point-name-stroke,#1a2029),1px -1px 0 var(--trk-point-name-stroke,#1a2029),-1px 1px 0 var(--trk-point-name-stroke,#1a2029),1px 1px 0 var(--trk-point-name-stroke,#1a2029);white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.trk-map-placemark-group[data-point-show-count=true] .trk-map-placemark-name{bottom:calc((var(--trk-point-hit-size,44px) + var(--trk-point-size,24px))/2 + 13px)}.trk-map-placemark-name[hidden],.trk-map-placemark-count[hidden]{display:none}.trk-outline-point-name-wrap{height:100%;display:flex;align-items:flex-end;justify-content:center}.trk-outline-point-name{max-width:100%;font:600 16px/1.375 var(--trk-font-family,system-ui,sans-serif);text-align:center;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;text-shadow:-1px -1px 0 var(--trk-point-name-stroke,#1a2029),1px -1px 0 var(--trk-point-name-stroke,#1a2029),-1px 1px 0 var(--trk-point-name-stroke,#1a2029),1px 1px 0 var(--trk-point-name-stroke,#1a2029)}
.trk-placemark-group-details{max-width:100%;overflow:auto;border-radius:var(--trk-radius-md)}.trk-placemark-details-member{margin:0 0 6px;font-size:.9286em;overflow-wrap:anywhere}.trk-placemark-details-group-info .trk-placemark-details-title{margin-bottom:6px}.trk-placemark-details-carousel{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}.trk-map-wrap .trk-placemark-details-carousel button{width:36px;min-height:36px;padding:4px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:inherit;font:inherit;cursor:pointer}.trk-map-wrap .trk-placemark-details-photo-overlay .trk-placemark-details-carousel button{background:#ffffff20;border-color:#ffffff66}.trk-map-wrap .trk-placemark-details-carousel button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-placemark-photo-viewer-carousel{display:flex;align-items:center;justify-content:center;gap:20px;flex-shrink:0}.trk-map-wrap .trk-placemark-photo-viewer-carousel button{min-width:44px;min-height:44px;padding:6px 12px;border:1px solid #ffffff55;border-radius:8px;background:#ffffff15;color:white;font:inherit;cursor:pointer}.trk-map-wrap .trk-placemark-photo-viewer-carousel button:focus-visible{outline:2px solid white;outline-offset:2px}
.trk-placemark-details-types{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 8px}.trk-placemark-details-types .trk-placemark-details-type{margin:0}
.trk-map-placemark{width:var(--trk-point-hit-size,44px);height:var(--trk-point-hit-size,44px);display:grid;place-items:center;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer}.trk-map-placemark-dot{width:var(--trk-point-size,24px);height:var(--trk-point-size,24px);box-sizing:border-box;display:grid;place-items:center;border-radius:var(--trk-point-corner-radius,var(--trk-point-radius,50%));border:2px solid white;background:var(--trk-point-color,#c83532);color:var(--trk-point-ink,white);font:700 var(--trk-point-font-size,11px)/1 system-ui,sans-serif;box-shadow:0 1px 4px #0003;pointer-events:none}.trk-map-placemark[aria-pressed=true] .trk-map-placemark-dot,.trk-map-placemark:focus-visible .trk-map-placemark-dot{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-map-placemark[aria-pressed=true]{z-index:1}.trk-sandbox-active .trk-map-placemark,.trk-map-wrap[data-track-map-view=terrain][data-placemark-mode=marker] .trk-map-placemark{visibility:hidden}
.trk-map-placemark[data-placemark-draggable=true]{cursor:grab;touch-action:none}.trk-map-placemark[data-placemark-draggable=true]:active{cursor:grabbing}.trk-map-drag-hint{position:absolute;bottom:9px;left:10px;max-width:calc(100% - 20px);box-sizing:border-box;padding:4px 7px;border-radius:var(--trk-radius-sm);background:var(--trk-overlay);color:var(--trk-text);font-size:.786em;pointer-events:none;z-index:2}
.trk-placemark-details{width:264px;max-width:calc(100vw - 48px);max-height:290px;overflow:auto;padding:12px;box-sizing:border-box;font:var(--trk-font-size)/1.5 var(--trk-font-family,system-ui,sans-serif);color:var(--trk-text);background:var(--trk-surface);border-radius:var(--trk-radius-md)}.trk-placemark-details-header{display:flex;align-items:start;gap:8px;justify-content:space-between}.trk-placemark-details-title{margin:0;font-size:1em;overflow-wrap:anywhere}.trk-placemark-details-close{min-width:28px;min-height:28px;flex-shrink:0;cursor:pointer;border:0;border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:inherit;font:inherit}.trk-placemark-details-close:focus-visible,.trk-placemark-details-retry:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-placemark-details-description{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;color:var(--trk-muted)}.trk-placemark-details-photos{display:grid;gap:10px;margin-top:10px}.trk-placemark-details-photo img{display:block;width:100%;height:auto;min-height:80px;object-fit:contain;border-radius:var(--trk-radius-sm)}.trk-placemark-details-empty,.trk-placemark-details-error{margin:8px 0;color:var(--trk-muted);font-size:.9286em}.trk-placemark-details-retry{display:block;margin-top:6px;padding:5px 8px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:inherit;cursor:pointer}.trk-outline g[role=button]:focus-visible{outline:2px solid var(--trk-focus)}
.trk-map-native-navigation .maplibregl-ctrl-group{margin:0;background:transparent;box-shadow:none;border-radius:0}.trk-map-dock .trk-map-native-navigation .maplibregl-ctrl-group button{width:44px;height:44px;min-height:44px;padding:0}.trk-map-native-navigation .maplibregl-ctrl-group button:first-child{border-top-left-radius:var(--trk-radius-sm);border-top-right-radius:var(--trk-radius-sm)}
.trk-map-toolbar{position:absolute;top:10px;left:10px;right:64px;display:flex;gap:8px;flex-wrap:wrap;pointer-events:none;z-index:4}
.trk-placemark-details{position:relative;width:auto;padding:0;max-height:none;overflow:auto}.trk-placemark-details-close{position:absolute;top:8px;right:8px;z-index:2;box-shadow:0 1px 6px #0003;background:var(--trk-overlay)}.trk-placemark-details-photos{margin:0;gap:8px}.trk-placemark-details-photo{margin:0}.trk-placemark-details-photo img{aspect-ratio:auto;min-height:0;max-width:100%;width:auto;height:auto;object-fit:contain;border-radius:0;margin:auto}.trk-placemark-details-photo-button{display:block;width:100%;margin:0;padding:0;border:0;background:transparent;cursor:zoom-in}.trk-placemark-details-photo-button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:-3px}.trk-placemark-details-body{padding:10px 12px}.trk-placemark-details-title{margin:0 0 7px}.trk-placemark-details-description{margin:0 0 8px}.trk-placemark-details-metadata{display:grid;gap:5px;margin:0;color:var(--trk-muted);font-size:.857em}.trk-placemark-details-metadata-item{margin:0;display:flex;flex-wrap:wrap;gap:4px;overflow-wrap:anywhere}.trk-placemark-details-metadata-label{flex-shrink:0}.trk-placemark-details-metadata-value{min-width:0;overflow-wrap:anywhere}.trk-placemark-details-view{display:block;width:100%;min-height:36px;margin-top:10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:var(--trk-text);font:inherit;cursor:zoom-in}.trk-placemark-details-view:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay{overflow:hidden}.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-body{position:absolute;bottom:0;left:0;right:0;box-sizing:border-box;max-height:100%;overflow:auto;padding:36px 12px 12px;background:linear-gradient(transparent,rgba(0,0,0,.2) 36px,rgba(0,0,0,.2));color:#fff;text-shadow:0 1px 3px #0009}.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-description,.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-metadata{color:#fffffff0}.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-view{border-color:#ffffff66;background:#ffffff20;color:white;backdrop-filter:blur(8px)}.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-view:hover{background:#ffffff35}.trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-view:focus-visible{outline-color:white}
.trk-placemark-details-type{display:inline-flex;max-width:100%;box-sizing:border-box;margin:0 0 8px;padding:2px 6px;border:1px solid currentColor;border-radius:var(--trk-radius-sm);font-size:.786em;line-height:1.5;overflow-wrap:anywhere}.trk-placemark-details-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.trk-map-wrap .trk-placemark-details-actions button{display:block;flex:1 1 70px;min-width:0;width:auto;min-height:36px;margin:0;padding:6px 8px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:var(--trk-text);font:inherit;cursor:pointer}.trk-map-wrap .trk-placemark-details-actions .trk-placemark-details-view{cursor:zoom-in}.trk-map-wrap .trk-placemark-details-actions button:disabled{opacity:.45;cursor:not-allowed}.trk-map-wrap .trk-placemark-details-actions button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-map-wrap .trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-actions button{border-color:#ffffff66;background:#ffffff20;color:white;backdrop-filter:blur(8px)}.trk-map-wrap .trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-actions button:hover:not(:disabled){background:#ffffff35}.trk-map-wrap .trk-placemark-details-with-photos.trk-placemark-details-photo-overlay .trk-placemark-details-actions button:focus-visible{outline-color:white}
.trk-placemark-photo-viewer{box-sizing:border-box;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:16px;border:0;background:#13161deF;color:white;overflow:hidden}.trk-placemark-photo-viewer::backdrop{background:#000b}.trk-placemark-photo-viewer[open]{display:flex;flex-direction:column;gap:12px}.trk-placemark-photo-viewer-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-shrink:0}.trk-placemark-photo-viewer-title{margin:0;font-size:1rem;overflow-wrap:anywhere}.trk-placemark-photo-viewer-close,.trk-placemark-photo-viewer-retry{border:1px solid #ffffff55;border-radius:8px;background:#ffffff15;color:white;min-height:40px;padding:8px 14px;cursor:pointer;font:inherit}.trk-placemark-photo-viewer-close{margin-left:auto}.trk-placemark-photo-viewer-close:focus-visible,.trk-placemark-photo-viewer-retry:focus-visible{outline:2px solid white;outline-offset:3px}.trk-placemark-photo-viewer-image{display:block;flex:1;min-height:0;width:100%;height:calc(100% - 64px);object-fit:contain}.trk-placemark-photo-viewer-error{margin:auto;text-align:center;display:grid;gap:12px}
.trk-map-export-tools{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;pointer-events:auto;max-width:100%}.trk-map-export-button,.trk-map-export-notice{box-sizing:border-box;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-overlay);color:var(--trk-text);font:inherit}.trk-map-export-button{min-height:44px;padding:8px 12px;cursor:pointer}.trk-map-export-button:hover:not(:disabled){background:var(--trk-hover)}.trk-map-export-button:disabled{opacity:.45;cursor:not-allowed}.trk-map-export-notice{max-width:100%;padding:9px 12px;overflow-wrap:anywhere;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:calc(var(--trk-font-size)*.9286)}.trk-map-export-notice button{min-height:44px;padding:6px 10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:var(--trk-text);font:inherit;cursor:pointer}
.trk-map-toolbar .trk-base{position:static;max-width:100%;flex-wrap:wrap;pointer-events:auto}.trk-view-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:4px;background:var(--trk-overlay);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);pointer-events:auto}
.trk-view-tabs button,.trk-sandbox-controls button,.trk-sandbox-error button,.trk-map-settings-button{min-height:44px;border:0;border-radius:var(--trk-radius-sm);background:transparent;color:var(--trk-text);padding:8px 12px;font:inherit;font-size:calc(var(--trk-font-size)*0.9286);cursor:pointer}
.trk-view-tabs button[aria-pressed=true]{background:var(--trk-active);color:var(--trk-text)}.trk-view-tabs button:disabled{opacity:.45;cursor:not-allowed}.trk-map-toolbar button:focus-visible,.trk-sandbox-controls button:focus-visible,.trk-sandbox-error button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-map-toolbar .trk-basebtn{min-height:44px}.trk-map-extra-credits{position:absolute;right:0;bottom:0;z-index:2;max-width:100%;padding:3px 8px;background:var(--trk-overlay);font-size:11px;color:var(--trk-text)}.trk-map-extra-credits a{color:inherit}.trk-sandbox{position:absolute;inset:0;z-index:2;display:none;background:var(--trk-bg)}.trk-sandbox-active .trk-sandbox{display:block}.trk-sandbox canvas{display:block;width:100%;height:100%;touch-action:none}
.trk-sandbox-active .trk-map{visibility:hidden;pointer-events:none}.trk-sandbox-active .trk-maptitle{display:none}.trk-map-wrap:not(.trk-sandbox-active) .trk-maptitle{top:auto;bottom:35px;right:10px;pointer-events:none}
.trk-sandbox-controls{position:absolute;right:10px;top:var(--trk-map-toolbar-bottom,82px);display:flex;gap:4px;background:var(--trk-overlay);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:4px;z-index:4}.trk-sandbox-active .trk-sandbox-controls{padding-right:64px}.trk-native-controls{right:54px}.trk-sandbox-controls button:hover,.trk-sandbox-error button:hover{background:var(--trk-active)}
.trk-sandbox-loading{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--trk-text);background:var(--trk-bg)}.trk-sandbox-loading strong,.trk-sandbox-loading span{background:var(--trk-overlay);padding:6px 10px;border-radius:var(--trk-radius-sm)}
.trk-sandbox-loading span{font-size:calc(var(--trk-font-size)*0.9286);color:var(--trk-muted)}
.trk-map-floating-placemarks{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}.trk-map-floating-placemark{position:absolute;min-width:44px;min-height:44px;padding:0;border:0;background:transparent;color:transparent;pointer-events:auto;cursor:pointer;transform:translate(-50%,-100%)}.trk-map-floating-placemark[hidden]{display:none}.trk-map-floating-placemark:focus-visible,.trk-map-floating-placemark[aria-pressed=true]{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-sandbox-placemarks{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1}.trk-sandbox-placemark{position:absolute;box-sizing:border-box;min-width:44px;min-height:44px;padding:0;margin:0;border:0;border-radius:4px;background:transparent;pointer-events:auto;cursor:pointer;color:transparent;font:600 16px/1.375 var(--trk-font-family,system-ui,sans-serif);transform:translate(-50%,-100%)}.trk-sandbox-placemark[hidden]{display:none}.trk-sandbox-placemark[aria-pressed=true],.trk-sandbox-placemark:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-sandbox-footer{position:absolute;left:10px;right:10px;bottom:10px;min-height:44px;z-index:3;pointer-events:none}.trk-sandbox-footer summary{position:absolute;right:0;bottom:0;display:grid;place-items:center;list-style:none;width:44px;height:44px;cursor:pointer;pointer-events:auto;background:var(--trk-overlay);color:var(--trk-overlay-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm)}.trk-sandbox-footer summary::-webkit-details-marker{display:none}.trk-sandbox-footer summary svg{width:20px;height:20px}.trk-sandbox-footer summary:hover{background:var(--trk-hover)}.trk-sandbox-footer summary:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-sandbox-info{width:fit-content;max-width:100%;margin:0 0 52px auto;padding:8px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-overlay);pointer-events:auto}.trk-sandbox-hint{margin:0 0 4px;padding:7px 10px;border-radius:var(--trk-radius-sm);background:var(--trk-overlay);color:var(--trk-text);font-size:calc(var(--trk-font-size)*0.8571);pointer-events:none}
.trk-sandbox-info .trk-maptitle,.trk-sandbox-info .trk-map-drag-hint{position:static;max-width:100%;margin-bottom:4px}.trk-sandbox-info .trk-map-extra-credits{max-width:100%}
.trk-sandbox-attribution{width:fit-content;max-width:100%;margin-left:auto;box-sizing:border-box;pointer-events:auto;padding:3px 8px;background:var(--trk-overlay);color:var(--trk-text);font-size:calc(var(--trk-font-size)*0.7857)}.trk-sandbox-attribution a{color:inherit}.trk-sandbox-error{z-index:4;display:flex;gap:10px;align-items:center;justify-content:space-between}.trk-sandbox-error button{flex-shrink:0;background:var(--trk-active)}
@container(max-width:500px){.trk-map-toolbar{gap:5px}.trk-map-toolbar .trk-basebtn{padding:6px 9px}.trk-sandbox-hint{font-size:calc(var(--trk-font-size)*0.7857)}}
@media(forced-colors:active){.trk-view-tabs,.trk-sandbox-controls{background:Canvas;border-color:ButtonText}.trk-view-tabs button,.trk-sandbox-controls button,.trk-sandbox-error button{color:ButtonText}.trk-view-tabs button[aria-pressed=true]{border:2px solid Highlight}.trk-sandbox-hint,.trk-sandbox-attribution{background:Canvas;color:CanvasText}}
`
