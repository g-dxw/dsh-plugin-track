/**
 * One elevation profile per container. Theme changes repaint that same chart
 * without reloading its data or replacing its zoom and cursor state.
 */
import { Chart } from 'chart.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ElevationProfile, type ElevationProfileOptions } from '../track/vendor/elevation-profile/elevationprofile.ts'
import { trackFeatureCollection } from '../track/export.ts'
import { TRACK_COLOR } from '../track/trail-layer.ts'
import { observeTrackTheme, readTrackThemeColors, type TrackThemeColors } from './theme.ts'
import type { TrackPoint, TrackPlacemark } from '../protocol.ts'
import { projectProfilePlacemarks } from '../track/profile-placemarks.ts'
import { ALL_PLACEMARK_TYPES, isAllPlacemarkTypes, matchesPlacemarkType, type PlacemarkTypeFilter } from '../track/placemark-filter.ts'
import { createProfilePlacemarkOverlay, type ProfileOverlayData } from './profile-placemark-overlay.ts'

type ProfileTheme = TrackThemeColors & {fontSize: number}
type ProfileOverlay = ReturnType<typeof createProfilePlacemarkOverlay>
type ProfileInstance = {profile: ElevationProfile; theme: ProfileTheme; fail: () => void; overlay: ProfileOverlay}
const NO_PLACEMARKS: readonly TrackPlacemark[] = []

function readProfileTheme(container: HTMLElement): ProfileTheme {
  const hostFontSize = Number.parseFloat(container.ownerDocument.defaultView?.getComputedStyle(container).fontSize || '')
  return {...readTrackThemeColors(container), fontSize: Number.isFinite(hostFontSize) && hostFontSize > 0 ? hostFontSize * 12 / 14 : 12}
}
function profileOptions(theme: ProfileTheme): ElevationProfileOptions {
  return {
    profileLineColor: TRACK_COLOR,
    profileBackgroundColor: TRACK_COLOR + '33',
    labelColor: theme.label,
    elevationGridColor: theme.grid,
    distanceGridColor: theme.grid,
    crosshairColor: theme.crosshair,
    tooltipBackgroundColor: theme.tooltipBackground,
    tooltipTextColor: theme.tooltipText,
    fontSize: theme.fontSize,
  }
}
function sameTheme(previous: ProfileTheme, next: ProfileTheme): boolean {
  return previous.label === next.label && previous.grid === next.grid && previous.crosshair === next.crosshair
    && previous.tooltipBackground === next.tooltipBackground && previous.tooltipText === next.tooltipText && previous.fontSize === next.fontSize
}
/** toggleTheme leaves tooltip, x-grid and typography options to its wrapper. */
function applyProfileTheme(profile: ElevationProfile, theme: ProfileTheme): void {
  const options = profile.chart.options
  for (const axis of [options.scales?.x, options.scales?.y]) {
    if (axis?.ticks) {
      const font = axis.ticks.font
      axis.ticks.font = {...(font && typeof font === 'object' ? font : {}), size: theme.fontSize}
    }
    if (axis?.grid) {
      axis.grid.color = theme.grid
      axis.grid.tickColor = theme.grid
    }
    if (axis?.border) axis.border.color = theme.grid
  }
  const tooltip = options.plugins?.tooltip
  if (tooltip) {
    tooltip.backgroundColor = theme.tooltipBackground
    tooltip.bodyColor = theme.tooltipText
    tooltip.titleColor = theme.tooltipText
    tooltip.footerColor = theme.tooltipText
    for (const key of ['bodyFont', 'titleFont', 'footerFont'] as const) {
      const font = tooltip[key]
      tooltip[key] = {...(font && typeof font === 'object' ? font : {}), size: theme.fontSize}
    }
  }
  // Vendor chart.update() is non-animated and does not change scale limits.
  // Keep its slope gradient, datasets, callbacks and plugin state untouched.
  profile.toggleTheme(profileOptions(theme))
}

export function ElevationChart({points, name, placemarks = NO_PLACEMARKS, selectedPlacemark = null, onSelectPlacemark,segmentStarts,placemarkTypeFilter = ALL_PLACEMARK_TYPES}: {
  segmentStarts?:readonly number[]; placemarkTypeFilter?: PlacemarkTypeFilter;
  points: readonly TrackPoint[]; name: string; placemarks?: readonly TrackPlacemark[];
  selectedPlacemark?: string | null; onSelectPlacemark?: (id: string) => void;
}) {
  const holder = useRef<HTMLDivElement>(null)
  const instance = useRef<ProfileInstance | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // The exported curve skips malformed fixes; project against that same order.
  const profilePoints = useMemo(() => points.filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1])), [points])
  const placements = useMemo(() => {
    const indices=new Map<number,number>()
    let curveIndex=0
    points.forEach((point,index)=>{if(Number.isFinite(point[0])&&Number.isFinite(point[1]))indices.set(index,curveIndex++)})
    return projectProfilePlacemarks(points,placemarks,segmentStarts).flatMap(placement=>{
      const startIndex=indices.get(placement.startIndex),endIndex=indices.get(placement.endIndex)
      return startIndex===undefined||endIndex===undefined?[]:[{...placement,startIndex,endIndex}]
    })
  }, [points, placemarks,segmentStarts])
  const displayPlacements = useMemo(() => {
    if (isAllPlacemarkTypes(placemarkTypeFilter)) return placements
    const matchingIds = new Set(placemarks.filter(point => matchesPlacemarkType(point, placemarkTypeFilter)).map(point => point.id))
    return placements.filter(placement => matchingIds.has(placement.id))
  }, [placements, placemarks, placemarkTypeFilter])
  const overlayData = useRef<ProfileOverlayData>({placements: displayPlacements, placemarks, selected: selectedPlacemark, onSelect: onSelectPlacemark})
  overlayData.current = {placements: displayPlacements, placemarks, selected: selectedPlacemark, onSelect: onSelectPlacemark}

  useEffect(() => {
    const container = holder.current
    if (!container) return
    let active = true
    let profile: ElevationProfile | undefined
    let overlay: ProfileOverlay | undefined
    setFailed(false)

    const dispose = () => {
      const canvases = Array.from(container.querySelectorAll('canvas'))
      const current = profile
      profile = undefined
      overlay?.destroy()
      overlay = undefined
      if (instance.current?.profile === current) instance.current = null
      if (current) {
        try {current.destroy()} catch {
          // The registry below also finds a chart left by a failed teardown.
        }
      }
      const charts = new Set<Pick<Chart, 'destroy'>>()
      // A constructor may register its Chart before the first draw fails.
      for (const canvas of canvases) {
        const chart = Chart.getChart(canvas)
        if (chart) charts.add(chart)
      }
      for (const chart of charts) {
        try {chart.destroy()} catch {
          // A partially initialized chart must not take down the detail panel.
        }
      }
      container.replaceChildren()
    }
    const fail = () => {
      if (!active) return
      dispose()
      setFailed(true)
    }

    try {
      // Read at creation, including retries after the host has changed theme.
      const theme = readProfileTheme(container)
      // The vendor constructor writes a Chart.js global font default. Keep
      // host typography scoped to this profile, including failed construction.
      const originalFontSize = Chart.defaults.font.size
      try {profile = new ElevationProfile(container, profileOptions(theme))}
      finally {Chart.defaults.font.size = originalFontSize}
      applyProfileTheme(profile, theme)
      overlay = createProfilePlacemarkOverlay(container, profile.chart, overlayData.current)
      instance.current = {profile, theme, fail, overlay}
      void profile.setData(trackFeatureCollection(profilePoints, {name, includeEndpoints: false})).then(() => {
        if (active) overlay?.draw()
      }).catch(fail)
    } catch {
      fail()
    }
    return () => {
      active = false
      dispose()
    }
  }, [profilePoints, name, attempt])

  useEffect(() => {instance.current?.overlay.update(overlayData.current)}, [displayPlacements, placemarks, selectedPlacemark, onSelectPlacemark])

  useEffect(() => {
    const container = holder.current
    if (!container) return
    let active = true
    const stop = observeTrackTheme(container, () => {
      if (!active) return
      const current = instance.current
      if (!current) return
      try {
        const theme = readProfileTheme(container)
        if (sameTheme(current.theme, theme)) return
        applyProfileTheme(current.profile, theme)
        current.theme = theme
      } catch {current.fail()}
    })
    return () => {active = false; stop()}
  }, [])

  return (
    <div className="trk-chart" style={{position: 'relative'}}>
      <div ref={holder} style={{position: 'relative', width: '100%', height: '100%'}} />
      {failed && <div role="alert" style={{
        position: 'absolute', inset: 8, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12,
        padding: 16, textAlign: 'center', fontSize: '0.93em',
      }}>
        <span>海拔剖面暂时无法显示，可继续查看轨迹和统计。</span>
        <button className="trk-secondary" onClick={() => setAttempt(value => value + 1)}>重试剖面</button>
      </div>}
    </div>
  )
}
