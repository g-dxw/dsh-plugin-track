/**
 * The panel body: import, list, detail.
 *
 * One state machine in three parts, driven by what `useTracks` holds and by
 * whether the user has asked to open anything. Everything that decides what a
 * track *means* lives in `useTracks` and `track/`; this file is the part that
 * decides where it sits on screen.
 */
import { useEffect, useRef, useState } from 'react'
import { useTracks } from './useTracks.ts'
import { MapView } from './MapView.tsx'
import { ElevationChart } from './ElevationChart.tsx'
import { download, clipboardSafeName, readBasemap } from './util.ts'
import { toGeoJSONText } from '../track/export.ts'
import { clipTitle } from '../track/title.ts'
import { API, type TrackRecord, type TrackSummary } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { formatBytes, formatDateTime, formatDistance, formatDuration, formatElevation } from '../track/format.ts'

const ACCEPT = '.gpx,.kml,.tcx'

export function TrackPanel() {
  const tracks = useTracks()
  const [basemap, setBasemap] = useState<BasemapId>(() => readBasemap())
  const [dragging, setDragging] = useState(false)
  const picking = useRef<HTMLInputElement>(null)

  return (
    <section className="trk" data-cqai-track-main="">
      <style>{css}</style>
      <div className="trk-wrap">
        <header className="trk-head">
          <div>
            <h1>轨迹</h1>
            <p className="trk-muted">导入 GPX / KML / TCX，看轨迹线、海拔剖面和里程。轨迹与剖面不联网也能看；只有底图瓦片需要联网。</p>
          </div>
          <div className="trk-head-actions">
            {tracks.open && <button className="trk-secondary" onClick={tracks.closeTrack}>返回列表</button>}
            <button className="trk-secondary" onClick={() => void tracks.refresh()}>刷新</button>
          </div>
        </header>

        {tracks.error && <div className="trk-error">{tracks.error}</div>}
        {tracks.note && <div className="trk-progress">{tracks.note}</div>}

        {tracks.open
          ? <TrackDetail track={tracks.open} basemap={basemap} onBasemap={setBasemap} onRemove={() => void tracks.remove(tracks.open!.id)} />
          : <>
            <div
              className={dragging ? 'trk-drop trk-dropping' : 'trk-drop'}
              onDragOver={event => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => {
                event.preventDefault()
                setDragging(false)
                tracks.importFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <strong>把轨迹文件拖到这里</strong>
              <span className="trk-muted">支持 GPX、KML、TCX，单个文件上限 8 MB</span>
              <button className="trk-primary" onClick={() => picking.current?.click()}>选择文件</button>
              <input
                ref={picking}
                type="file"
                accept={ACCEPT}
                multiple
                hidden
                onChange={event => {
                  tracks.importFiles(Array.from(event.target.files ?? []))
                  event.target.value = ''
                }}
              />
            </div>
            {tracks.list.length
              ? <div className="trk-list">
                {tracks.list.map(item => <TrackRow key={item.id} track={item} onOpen={() => tracks.openTrack(item.id)} />)}
              </div>
              : <div className="trk-empty">还没有轨迹。导入一条 GPX，看它在地图上的样子。</div>}
          </>}
      </div>
    </section>
  )
}

function TrackRow({track, onOpen}: {track: TrackSummary; onOpen: () => void}) {
  return (
    <button className="trk-row" onClick={onOpen}>
      <span className="trk-row-main">
        <strong>{clipTitle(track.name, track.filename)}</strong>
        <small>{formatDateTime(track.createdAt)} · {track.filename}</small>
      </span>
      <span className="trk-row-stats">
        <span>{formatDistance(track.metrics.distance)}</span>
        <span>{track.metrics.elevationGain > 0 ? formatElevation(track.metrics.elevationGain) : '—'}</span>
        <span>{formatDuration(track.metrics.duration)}</span>
      </span>
    </button>
  )
}

function TrackDetail({track, basemap, onBasemap, onRemove}: {
  track: TrackRecord
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  // The chart needs elevations to plot; a file without them gets the note
  // instead of an axis with no line on it.
  const hasElevation = track.metrics.elevationMax !== null

  // Deleting a track is one click away from opening it, so it asks once.
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  return (
    <div className="trk-detail">
      <div className="trk-detail-head">
        <div>
          <h2>{clipTitle(track.name, track.filename)}</h2>
          <p className="trk-muted">{track.filename} · {formatBytes(track.bytes)} · {track.points.toLocaleString('zh-CN')} 个点 · {formatDateTime(track.createdAt)}</p>
        </div>
        <div className="trk-detail-actions">
          <a className="trk-secondary" href={`${API}/source?id=${encodeURIComponent(track.id)}`} download={track.filename}>导出原文件</a>
          <button className="trk-secondary" onClick={() => download(`${clipboardSafeName(clipTitle(track.name, track.filename))}.geojson`, toGeoJSONText(track.coordinates, {name: track.name || track.filename}))}>导出 GeoJSON</button>
          <button
            className={confirming ? 'trk-danger' : 'trk-secondary'}
            onClick={() => { if (confirming) onRemove(); else setConfirming(true) }}
          >
            {confirming ? '确认删除？' : '删除'}
          </button>
        </div>
      </div>

      <div className="trk-stats">
        <Stat label="距离" value={formatDistance(track.metrics.distance)} />
        <Stat label="累计爬升" value={formatElevation(track.metrics.elevationGain)} />
        <Stat label="累计下降" value={formatElevation(track.metrics.elevationLoss)} />
        <Stat label="时长" value={formatDuration(track.metrics.duration)} />
        <Stat label="最高点" value={formatElevation(track.metrics.elevationMax)} />
        <Stat label="最低点" value={formatElevation(track.metrics.elevationMin)} />
      </div>

      {/* The map is the one part that can die, and it dies in its own
          constructor when WebGL is missing — `MapView` catches that and draws a
          plain outline instead, so the card is never empty and the layout never
          has to depend on the map being there. */}
      <div className="trk-stage">
        <MapView points={track.coordinates} name={clipTitle(track.name, track.filename)} basemap={basemap} onBasemap={onBasemap} />
      </div>

      {hasElevation
        ? <ElevationChart points={track.coordinates} name={track.name || track.filename} />
        : <div className="trk-empty">这条轨迹没有海拔数据，没有剖面可画。</div>}
    </div>
  )
}

function Stat({label, value}: {label: string; value: string}) {
  return <div className="trk-stat"><small>{label}</small><strong>{value}</strong></div>
}

/** Inline rather than an icon library: one less thing for the bundle to carry. */
export function TrackIcon({size = 20}: {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 18c2.5-6 4-9 6-9s2.5 4 4.5 4S17 6 21 6" />
      <circle cx="3" cy="18" r="1.6" />
      <circle cx="21" cy="6" r="1.6" />
    </svg>
  )
}

/** Same palette as the publisher and video panels, so the three read as siblings. */
const css = `
.trk{height:100%;overflow:auto;color:var(--foreground,#ededf0);background:var(--background,#151517);font-family:inherit;container-type:inline-size;box-sizing:border-box}.trk *{box-sizing:border-box}.trk button,.trk input{font:inherit}.trk button{cursor:pointer}.trk-wrap{max-width:1260px;padding:28px 32px 48px;margin:auto}.trk-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:22px}.trk-head h1{font-size:26px;margin:0 0 8px;font-weight:700;letter-spacing:-1px}.trk-head-actions,.trk-detail-actions{display:flex;gap:8px;flex-wrap:wrap}.trk-muted{font-size:13px;color:#9b9ba4;line-height:1.7;margin:0}.trk-secondary,.trk-danger,.trk-primary{border:1px solid #ffffff24;background:#ffffff05;color:inherit;border-radius:9px;padding:9px 15px;text-decoration:none;font-size:13px;white-space:nowrap}.trk-secondary:hover{background:#ffffff0d}.trk-primary{background:#b8a1ff;color:#191123;border:0;font-weight:650;box-shadow:0 3px 18px #9b7bf322;padding:11px 20px}.trk-danger{border-color:#ff666655;background:#ff666618;color:#ffbcbc}.trk-error{color:#ffb6b6;background:#ff666614;border:1px solid #ff66662a;border-radius:9px;padding:12px;margin-bottom:16px;white-space:pre-wrap;font-size:13px}.trk-progress{color:#cfbcff;background:#a78bfa14;border:1px solid #a78bfa30;border-radius:9px;padding:12px;margin-bottom:16px;font-size:13px}.trk-drop{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;border:1px dashed #ffffff30;border-radius:14px;padding:34px 20px;background:#ffffff02;margin-bottom:22px}.trk-drop strong{font-size:15px;font-weight:600}.trk-dropping{border-color:#a78bfa;background:#a78bfa12}.trk-list{display:grid;gap:10px}.trk-row{display:flex;width:100%;align-items:center;justify-content:space-between;gap:16px;text-align:left;padding:15px;border:1px solid #ffffff1c;border-radius:10px;background:#ffffff04;color:inherit}.trk-row:hover{border-color:#a78bfa55}.trk-row strong{display:block;font-size:14px;margin-bottom:5px}.trk-row small{color:#90909b}.trk-row-stats{display:flex;gap:16px;font-size:13px;color:#c3c3cc;white-space:nowrap}.trk-empty{text-align:center;padding:40px 20px;border:1px dashed #ffffff22;border-radius:12px;color:#9f9fa9;font-size:13px;line-height:1.9}.trk-detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:18px}.trk-detail-head h2{margin:0 0 8px;font-size:20px;font-weight:650}.trk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px}.trk-stat{border:1px solid #ffffff17;background:#ffffff03;border-radius:12px;padding:14px}.trk-stat small{display:block;color:#90909b;font-size:12px;margin-bottom:7px}.trk-stat strong{font-size:17px;font-weight:650}.trk-stage{position:relative;height:clamp(320px,52vh,620px);border:1px solid #ffffff17;border-radius:14px;overflow:hidden;background:#eef1f5;margin-bottom:18px}.trk-map-wrap{position:relative;height:100%}.trk-map{position:absolute;inset:0}.trk-map canvas{outline:none}.trk-outline{position:absolute;inset:0;width:100%;height:100%;padding:12px}.trk-base{position:absolute;top:10px;left:10px;display:flex;gap:6px;background:#0c0c10cc;backdrop-filter:blur(6px);border:1px solid #ffffff1f;border-radius:9px;padding:4px;z-index:2}.trk-basebtn{border:0;background:none;color:#c9c9d2;border-radius:6px;padding:6px 12px;font-size:12px}.trk-basebtn[aria-pressed=true]{background:#a78bfa2e;color:#e0d6ff}.trk-note{position:absolute;bottom:10px;left:10px;right:10px;background:#0c0c10d9;border:1px solid #ffffff1f;border-radius:9px;padding:9px 12px;font-size:12px;color:#cfcfd8;z-index:2}.trk-maptitle{position:absolute;top:12px;right:12px;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#0c0c10b8;border-radius:8px;padding:6px 10px;font-size:12px;color:#d8d8e0;z-index:1}.trk-chart{border:1px solid #ffffff17;border-radius:14px;background:#ffffff03;padding:8px;height:260px}
@container(max-width:750px){.trk-wrap{padding:22px 18px}.trk-head{flex-direction:column}.trk-row{flex-direction:column;align-items:flex-start}.trk-row-stats{gap:12px;flex-wrap:wrap}.trk-detail-head{flex-direction:column}}
`
