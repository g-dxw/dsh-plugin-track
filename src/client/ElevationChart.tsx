/**
 * The elevation profile, wrapped for React and for our own colour scheme.
 *
 * The ported `ElevationProfile` owns a `<canvas>` it appends to a container div
 * itself, and repaints that same canvas on every `setData` — so the lifecycle
 * here is "create one chart per container, feed it data, destroy the instance
 * with the container", rather than anything the element can drive.
 *
 * The chart reads its times out of `properties.coordinateProperties.times`
 * (the @tmcw/togeojson convention), which is exactly what `trackFeatureCollection`
 * writes, so a track is handed to it in its export shape and nothing is
 * reshaped in between.
 *
 * It touches no network: chart.js and the point array are all it needs, which
 * is why the profile still draws when the basemap cannot.
 */
import { useEffect, useRef } from 'react'
import { ElevationProfile } from '../track/vendor/elevation-profile/elevationprofile.ts'
import { trackFeatureCollection } from '../track/export.ts'
import { TRACK_COLOR } from '../track/trail-layer.ts'
import type { TrackPoint } from '../protocol.ts'

export function ElevationChart({points, name}: {points: readonly TrackPoint[]; name: string}) {
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = holder.current
    if (!container) return
    const profile = new ElevationProfile(container, {
      // One card, one accent: the line and the fill are the track line's own
      // colour at two opacities, so the map and the chart read as one thing.
      profileLineColor: TRACK_COLOR,
      profileBackgroundColor: `${TRACK_COLOR}33`,
      labelColor: '#8f8f9a',
      elevationGridColor: '#ffffff14',
      crosshairColor: '#ffffff40',
      tooltipBackgroundColor: '#0c0c10ee',
      tooltipTextColor: '#ececf1',
    })
    // No elevation in the file means no profile to draw — `setData` would have
    // nothing to plot, and the caller has already decided not to mount us.
    void profile.setData(trackFeatureCollection(points, {name, includeEndpoints: false}))
    return () => {
      profile.chart.destroy()
      container.replaceChildren()
    }
  }, [points, name])

  return <div className="trk-chart" ref={holder} />
}
