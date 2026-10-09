/**
 * The panel body: import, list, detail.
 *
 * One state machine in three parts, driven by what `useTracks` holds and by
 * whether the user has asked to open anything. Everything that decides what a
 * track *means* lives in `useTracks` and `track/`; this file is the part that
 * decides where it sits on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageAgentContext } from './ImageAgentActions.tsx'
import { addImageToTrackDraft } from './image-agent-draft.ts'
import { ResourceLibrary } from './ResourceLibrary.tsx'
import { ResourceImageWorkspace } from './ResourceImageWorkspace.tsx'
import { ResourceImageHistory } from './ResourceImageHistory.tsx'
import { ResourceUseDialog } from './ResourceUseDialog.tsx'
import type { ResourceAsset, ResourceJob } from '../track/resources.ts'
import { useTracks } from './useTracks.ts'
import { useTrackAgentDrawer, type TrackAgentServicesReader } from './useTrackAgentDrawer.ts'
import {TrackAgentProjectRetentions} from './track-agent-projects.ts'
import { TRACK_THEME_CSS } from './theme.ts'
import { TrackOverview } from './TrackOverview.tsx'
import { TrackEditor } from './TrackEditor.tsx'
import { AnimationStudio } from './AnimationStudio.tsx'
import { TrackVideoScript } from './TrackVideoScript.tsx'
import { DeleteTrackDialog } from './DeleteTrackDialog.tsx'
import { MapSettingsProvider, useMapSettings } from './map-settings.tsx'
import { api, download, clipboardSafeName } from './util.ts'
import { toGeoJSONText } from '../track/export.ts'
import { clipTitle } from '../track/title.ts'
import { API, type TrackRecord, type TrackSummary } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { formatAverageSpeed, formatBytes, formatDateTime, formatDistance, formatDuration, formatElevation } from '../track/format.ts'

const ACCEPT = '.gpx,.kml,.tcx'

export function TrackPanel(props: {getAgentServices?: TrackAgentServicesReader} = {}) {
  return <MapSettingsProvider><TrackPanelBody {...props} /></MapSettingsProvider>
}

function TrackPanelBody({getAgentServices}: {getAgentServices?: TrackAgentServicesReader}) {
  const projectRetentions = useRef(new TrackAgentProjectRetentions())
  useEffect(()=>()=>projectRetentions.current.releaseAll(),[])
  const keepProjectSession = useCallback(async(sessionId:string,signal?:AbortSignal)=>{
    const services=getAgentServices?.()
    if(!services?.sessions.retain)throw new Error('当前宿主未提供项目 Agent 会话保留能力')
    await projectRetentions.current.hold(services.sessions,sessionId,signal)
  },[getAgentServices])
  const tracks = useTracks()
  const {settings, updateSettings, openSettings} = useMapSettings()
  const basemap = settings.basemap
  const setBasemap = (value: BasemapId) => updateSettings({basemap: value})
  const [dragging, setDragging] = useState(false)
  const [editor, setEditor] = useState<{initial: TrackRecord | null} | null>(null)
  const [animation, setAnimation] = useState<TrackRecord | null>(null)
  const [videoScript, setVideoScript] = useState<TrackRecord | null>(null)
  const [resources, setResources] = useState<{track:TrackRecord;initialAssetUrl?:string}|null>(null)
  const [resourcePage, setResourcePage] = useState<'library'|'create'|'history'>('library')
  const [historyBack, setHistoryBack] = useState<'library'|'create'>('library')
  const [createInput, setCreateInput] = useState<{assetIds?:string[];assetUrl?:string;token:string}|null>(null)
  const [restoreTask, setRestoreTask] = useState<{job:ResourceJob;resultAssetId?:string;token:string}>()
  const [useResource, setUseResource] = useState<ResourceAsset|null>(null)
  const [resourceRefresh, setResourceRefresh] = useState(0)
  const [pointRefresh, setPointRefresh] = useState(0)
  const detailScroll = useRef(0)
  const panel = useRef<HTMLElement>(null)
  function openResources(track:TrackRecord, initialAssetUrl?:string) {
    detailScroll.current=panel.current?.scrollTop||0
    setResources({track,initialAssetUrl})
    setResourcePage(initialAssetUrl?'create':'library')
    setCreateInput(initialAssetUrl?{assetUrl:initialAssetUrl,token:crypto.randomUUID()}:null)
    setRestoreTask(undefined)
    requestAnimationFrame(()=>{if(panel.current)panel.current.scrollTop=0})
  }
  function openImageCreation(assetIds?:string[]) {
    setCreateInput({assetIds,token:crypto.randomUUID()});setRestoreTask(undefined);setResourcePage('create')
    requestAnimationFrame(()=>{if(panel.current)panel.current.scrollTop=0})
  }
  function openImageHistory() {
    setHistoryBack(resourcePage==='create'?'create':'library');setResourcePage('history')
    requestAnimationFrame(()=>{if(panel.current)panel.current.scrollTop=0})
  }
  function restoreImageTask(job:ResourceJob,resultAssetId?:string) {
    setRestoreTask({job,resultAssetId,token:crypto.randomUUID()});setResourcePage('create')
    requestAnimationFrame(()=>{if(panel.current)panel.current.scrollTop=0})
  }
  function closeResources() {
    setUseResource(null)
    setResources(null)
    requestAnimationFrame(()=>{if(panel.current)panel.current.scrollTop=detailScroll.current})
  }
  const picking = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<TrackSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deletingNow = useRef(false)
  const agentTrack = editor ? editor.initial : animation || videoScript || resources?.track || tracks.open
  const agentScope = agentTrack?.id ?? null
  const currentAgentScope = useRef(agentScope); currentAgentScope.current = agentScope
  const agent = useTrackAgentDrawer({
    page: editor ? editor.initial ? 'edit' : 'new' : animation ? 'animation' : videoScript ? 'video-script' : resources ? resourcePage==='create'?'image-create':resourcePage==='history'?'image-history':'resources' : tracks.open ? 'overview' : 'library',
    track: agentTrack, trackCount: tracks.list.length, library: tracks.list,
  }, getAgentServices)

  function requestDelete(track: TrackSummary) {
    tracks.clearError()
    setDeleteTarget(track)
  }

  async function confirmDelete() {
    if (!deleteTarget || deletingNow.current) return
    deletingNow.current = true
    setDeleting(true)
    try { if (await tracks.remove(deleteTarget.id)) setDeleteTarget(null) }
    finally { deletingNow.current = false; setDeleting(false) }
  }

  const imageAgent = {
    trackId: agentScope,
    available: agent.available && !!getAgentServices?.()?.conversation && typeof getAgentServices?.()?.sessions.scope === 'function',
    async addFile(file: File, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted()
      const targetScope = agentScope
      if (currentAgentScope.current !== targetScope) throw new Error('当前轨迹已切换，请重新添加图片。')
      const session = await agent.show(signal)
      signal.throwIfAborted()
      if (currentAgentScope.current !== targetScope) throw new Error('当前轨迹已切换，请重新添加图片。')
      if (!session) throw new Error('Agent 对话尚未就绪，请稍后重试。')
      const services = getAgentServices?.()
      if (!services?.conversation || !services.sessions.scope) throw new Error('当前宿主暂不支持添加图片到 Agent。')
      addImageToTrackDraft(services.conversation, session.sessionId, file, {scope: id => services.sessions.scope!(id)})
    },
  }

  return (
    <ImageAgentContext.Provider value={imageAgent}><section ref={panel} className="trk" data-cqai-track-main="" data-resource-page={resources ? true : undefined}>
      <style>{css}</style>
      <div className="trk-wrap" aria-hidden={deleteTarget ? true : undefined}>
        <header className="trk-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>轨迹</h1>
            <p className="trk-muted">导入 GPX / KML / TCX，看轨迹线、海拔剖面和里程。轨迹与剖面不联网也能看；底图瓦片和 3D 沙盘的区域高程需要联网。</p>
          </div>
          <div className="trk-head-actions">
            <button type="button" className="trk-secondary" onClick={openSettings}>地图设置</button>
            <button type="button" className="trk-secondary" aria-pressed={agent.open} aria-controls="desktop-agent-drawer"
              disabled={!agent.available} aria-disabled={agent.busy || undefined} aria-busy={agent.busy || undefined}
              title={!agent.available ? '当前布局需要支持左侧 Agent 的 Desktop 扩展布局' : undefined}
              onClick={() => void agent.toggle()}>{agent.busy ? '正在打开 Agent…' : agent.open ? '收起 Agent' : 'Agent'}</button>
            {!editor && !animation && !videoScript && !resources && <button className="trk-secondary" onClick={() => setEditor({initial: null})}>新建路线</button>}
            {tracks.open && !editor && !animation && !videoScript && !resources && <button className="trk-secondary" onClick={tracks.closeTrack}>返回列表</button>}
            <button className="trk-secondary" onClick={() => void tracks.refresh()}>刷新</button>
          </div>
        </header>

        {agent.error && <div className="trk-error" role="alert">{agent.error}</div>}
        {tracks.error && <div className="trk-error">{tracks.error}</div>}
        {tracks.note && <div className="trk-progress">{tracks.note}</div>}

        {editor
          ? <TrackEditor key={editor.initial?.id ?? 'new'} initial={editor.initial} availableTracks={tracks.list} basemap={basemap} onBasemap={setBasemap}
              loadTrack={id => api<TrackRecord>(`track?id=${encodeURIComponent(id)}`)}
              onSave={async (inputs, options) => {await tracks.saveEdited(inputs); if (!options?.keepEditing) setEditor(null)}} onCancel={() => setEditor(null)} />
          : videoScript ? <TrackVideoScript key={videoScript.id} track={videoScript} basemap={basemap} onBasemap={setBasemap} onCancel={()=>setVideoScript(null)} getAgentServices={getAgentServices} onKeepSession={keepProjectSession} />
          : animation ? <AnimationStudio key={animation.id} track={animation} basemap={basemap} onBasemap={setBasemap} onCancel={()=>setAnimation(null)} />
          : tracks.open ? null
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
                {tracks.list.map(item => <TrackRow key={item.id} track={item} onOpen={() => tracks.openTrack(item.id)} onRemove={() => requestDelete(item)} />)}
              </div>
              : <div className="trk-empty">还没有轨迹。导入一条 GPX，看它在地图上的样子。</div>}
          </>}
        {tracks.open&&<div hidden={Boolean(resources||editor||videoScript||animation)}><TrackDetail track={tracks.open} basemap={basemap} onBasemap={setBasemap} onRemove={() => requestDelete(tracks.open!)} onEdit={() => setEditor({initial: tracks.open})} onAnimation={()=>setAnimation(tracks.open)} onVideoScript={()=>setVideoScript(tracks.open)} onResources={url=>openResources(tracks.open!,url)} refreshToken={pointRefresh} /></div>}
        <div hidden={Boolean(editor||videoScript||animation)}>
          {resources&&<>
                <div hidden={resourcePage!=='library'}><ResourceLibrary key={resources.track.id} track={resources.track} onBack={closeResources} onCreate={openImageCreation} onHistory={openImageHistory} onUseImage={asset=>setUseResource(asset)} onVideo={()=>setVideoScript(resources.track)} reloadToken={resourceRefresh}/></div>
                {(createInput||restoreTask)&&<div hidden={resourcePage!=='create'}><ResourceImageWorkspace key={`${resources.track.id}:${createInput?.token||'history'}`} track={resources.track} initialAssetIds={createInput?.assetIds} initialAssetUrl={createInput?.assetUrl} restore={restoreTask} onBack={()=>{setResourcePage('library');setResourceRefresh(value=>value+1)}} onHistory={openImageHistory} onUseImage={asset=>setUseResource(asset)} onVideo={()=>setVideoScript(resources.track)} reloadToken={resourceRefresh}/></div>}
                {resourcePage==='history'&&<ResourceImageHistory track={resources.track} backLabel={historyBack==='create'?'返回 AI 创作':'返回资源库'} onBack={()=>setResourcePage(historyBack)} onRestore={restoreImageTask}/>}
              </>}
              {resources&&useResource&&<ResourceUseDialog track={resources.track} asset={useResource} onClose={()=>setUseResource(null)} onSaved={()=>{setUseResource(null);setPointRefresh(value=>value+1);setResourceRefresh(value=>value+1)}}/>}
        </div>
      </div>
      {deleteTarget && <DeleteTrackDialog track={deleteTarget} busy={deleting} error={tracks.error} fallbackFocus={heading.current}
        onCancel={() => {if (!deletingNow.current) {setDeleteTarget(null); tracks.clearError()}}} onConfirm={() => void confirmDelete()} />}
    </section></ImageAgentContext.Provider>
  )
}

function TrackRow({track, onOpen, onRemove}: {track: TrackSummary; onOpen: () => void; onRemove: () => void}) {
  const title = clipTitle(track.name, track.filename)
  return (
    <article className="trk-row">
      <button className="trk-row-open" onClick={onOpen} aria-label={`打开轨迹：${title}`}>
      <span className="trk-row-main">
        <strong>{title}</strong>
        <small>{formatDateTime(track.createdAt)} · {track.filename}</small>
      </span>
      <span className="trk-row-stats">
        <span>{formatDistance(track.metrics.distance)}</span>
        <span>{track.metrics.elevationGain > 0 ? formatElevation(track.metrics.elevationGain) : '—'}</span>
        <span>{formatDuration(track.metrics.duration)}</span>
      </span>
      </button>
      <button className="trk-danger trk-row-delete" aria-label={`删除轨迹：${title}`} onClick={onRemove}>删除</button>
    </article>
  )
}

function TrackDetail({track, basemap, onBasemap, onRemove, onEdit, onAnimation, onVideoScript, onResources, refreshToken}: {
  track: TrackRecord
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
  onRemove: () => void
  onEdit: () => void
  onAnimation: () => void
  onVideoScript: () => void
  onResources: (sourceUrl?:string) => void
  refreshToken?: number
}) {
  return (
    <div className="trk-detail">
      <div className="trk-detail-head">
        <div>
          <h2>{clipTitle(track.name, track.filename)}</h2>
          <p className="trk-muted">{track.filename} · {formatBytes(track.bytes)} · {track.points.toLocaleString('zh-CN')} 个点 · {formatDateTime(track.createdAt)}</p>
        </div>
        <div className="trk-detail-actions">
          <button className="trk-primary" onClick={()=>onResources()}>资源库</button>
          <button className="trk-secondary" onClick={onEdit}>编辑当前轨迹</button>
          <button className="trk-secondary" onClick={onVideoScript}>轨迹视频制作</button>
          <button className="trk-secondary" onClick={onAnimation}>轨迹动画录制</button>
          <a className="trk-secondary" href={`${API}/source?id=${encodeURIComponent(track.id)}`} download={track.filename}>导出原文件</a>
          <button className="trk-secondary" onClick={() => download(`${clipboardSafeName(clipTitle(track.name, track.filename))}.geojson`, toGeoJSONText(track.coordinates, {name: track.name || track.filename}))}>导出 GeoJSON</button>
          <button className="trk-danger" onClick={onRemove}>删除</button>
        </div>
      </div>

      <div className="trk-stats">
        <Stat label="距离" value={formatDistance(track.metrics.distance)} />
        <Stat label="累计爬升" value={formatElevation(track.metrics.elevationGain)} />
        <Stat label="累计下降" value={formatElevation(track.metrics.elevationLoss)} />
        <Stat label="时长" value={formatDuration(track.metrics.duration)} />
        <Stat label="运动均速" value={formatAverageSpeed(track.metrics.distance, track.metrics.duration)} />
        <Stat label="最高点" value={formatElevation(track.metrics.elevationMax)} />
        <Stat label="最低点" value={formatElevation(track.metrics.elevationMin)} />
      </div>

      {/* The map is the one part that can die, and it dies in its own
          constructor when WebGL is missing — `MapView` catches that and draws a
          plain outline instead, so the card is never empty and the layout never
          has to depend on the map being there. */}
      <TrackOverview key={track.id} track={track} basemap={basemap} onBasemap={onBasemap} onPhotoAI={onResources} refreshToken={refreshToken} />

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
${TRACK_THEME_CSS}
.trk[data-resource-page=true]>.trk-wrap{max-width:none}.trk[data-resource-page=true]>.trk-wrap>.trk-head{display:none}
.trk{height:100%;overflow:auto;color:var(--trk-text);background:var(--trk-bg);font-family:inherit;container-type:inline-size;box-sizing:border-box}.trk *{box-sizing:border-box}.trk button,.trk input{font:inherit}.trk button{cursor:pointer}.trk-wrap{max-width:1260px;padding:28px 32px 48px;margin:auto}.trk-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:22px}.trk-head h1{font-size:calc(var(--trk-font-size)*1.8571);margin:0 0 8px;font-weight:700;letter-spacing:-1px}.trk-head-actions,.trk-detail-actions{display:flex;gap:8px;flex-wrap:wrap}.trk-muted{font-size:calc(var(--trk-font-size)*0.9286);color:var(--trk-muted);line-height:1.7;margin:0}.trk-secondary,.trk-danger,.trk-primary{border:1px solid var(--trk-border);background:var(--trk-surface);color:inherit;border-radius:var(--trk-radius-md);padding:9px 15px;text-decoration:none;font-size:calc(var(--trk-font-size)*0.9286);white-space:nowrap}.trk-secondary:hover{background:var(--trk-hover)}.trk-primary{background:var(--trk-primary-bg);color:var(--trk-on-accent);border:0;font-weight:650;box-shadow:0 3px 18px var(--trk-shadow);padding:11px 20px}.trk-danger{border-color:var(--trk-danger-border);background:var(--trk-danger-bg);color:var(--trk-danger)}.trk-error{color:var(--trk-danger);background:var(--trk-danger-bg);border:1px solid var(--trk-danger-border);border-radius:var(--trk-radius-md);padding:12px;margin-bottom:16px;white-space:pre-wrap;font-size:calc(var(--trk-font-size)*0.9286)}.trk-progress{color:var(--trk-notice);background:var(--trk-notice-bg);border:1px solid var(--trk-notice-border);border-radius:var(--trk-radius-md);padding:12px;margin-bottom:16px;font-size:calc(var(--trk-font-size)*0.9286)}.trk-drop{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;border:1px dashed var(--trk-border);border-radius:var(--trk-radius-lg);padding:34px 20px;background:var(--trk-surface);margin-bottom:22px}.trk-drop strong{font-size:calc(var(--trk-font-size)*1.0714);font-weight:600}.trk-dropping{border-color:var(--trk-accent);background:var(--trk-active)}.trk-list{display:grid;gap:10px}.trk-row{display:flex;width:100%;align-items:center;justify-content:space-between;gap:16px;text-align:left;padding:15px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface);color:inherit}.trk-row:hover{border-color:var(--trk-accent)}.trk-row strong{display:block;font-size:calc(var(--trk-font-size)*1);margin-bottom:5px}.trk-row small{color:var(--trk-muted)}.trk-row-stats{display:flex;gap:16px;font-size:calc(var(--trk-font-size)*0.9286);color:var(--trk-muted);white-space:nowrap}.trk-empty{text-align:center;padding:40px 20px;border:1px dashed var(--trk-border);border-radius:var(--trk-radius-md);color:var(--trk-muted);font-size:calc(var(--trk-font-size)*0.9286);line-height:1.9}.trk-detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:18px}.trk-detail-head h2{margin:0 0 8px;font-size:calc(var(--trk-font-size)*1.4286);font-weight:650}.trk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px}.trk-stat{border:1px solid var(--trk-border);background:var(--trk-surface);border-radius:var(--trk-radius-md);padding:14px}.trk-stat small{display:block;color:var(--trk-muted);font-size:calc(var(--trk-font-size)*0.8571);margin-bottom:7px}.trk-stat strong{font-size:calc(var(--trk-font-size)*1.2143);font-weight:650}.trk-stage{position:relative;height:clamp(320px,52vh,620px);border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);overflow:hidden;background:var(--trk-map-background);margin-bottom:18px}.trk-map-wrap{position:relative;height:100%}.trk-map{position:absolute;inset:0}.trk-map canvas{outline:none}.trk-outline{position:absolute;inset:0;width:100%;height:100%;padding:12px}.trk-base{position:absolute;top:10px;left:10px;display:flex;gap:6px;background:var(--trk-overlay);backdrop-filter:blur(6px);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:4px;z-index:2}.trk-basebtn{border:0;background:none;color:var(--trk-text);border-radius:var(--trk-radius-sm);padding:6px 12px;font-size:calc(var(--trk-font-size)*0.8571)}.trk-basebtn[aria-pressed=true]{background:var(--trk-active);color:var(--trk-text)}.trk-note{position:absolute;bottom:10px;left:10px;right:10px;background:var(--trk-overlay);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:9px 12px;font-size:calc(var(--trk-font-size)*0.8571);color:var(--trk-text);z-index:2}.trk-maptitle{position:absolute;top:12px;right:12px;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--trk-overlay);border-radius:var(--trk-radius-sm);padding:6px 10px;font-size:calc(var(--trk-font-size)*0.8571);color:var(--trk-text);z-index:1}.trk-chart{border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);background:var(--trk-surface);padding:8px;height:260px}
.trk-row{padding:0;gap:8px}.trk-row-open{display:flex;flex:1;min-width:0;align-items:center;justify-content:space-between;gap:16px;text-align:left;padding:15px;border:0;border-radius:var(--trk-radius-md);background:transparent;color:inherit}.trk-row-main{min-width:0;overflow-wrap:anywhere}.trk-row-delete{margin-right:12px;min-height:44px;flex-shrink:0}.trk button:focus-visible{outline:2px solid var(--trk-accent);outline-offset:3px}.trk button:disabled{cursor:default;opacity:.6}.trk-delete-overlay{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.38);display:grid;place-items:center;padding:20px;overflow:auto}.trk-delete-dialog{width:min(100%,480px);max-height:100%;overflow:auto;padding:24px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);background:var(--trk-surface);color:var(--trk-text);box-shadow:0 14px 60px var(--trk-shadow)}.trk-delete-dialog h2{margin:0 0 16px;font-size:calc(var(--trk-font-size)*1.4286)}.trk-delete-dialog p{line-height:1.8;overflow-wrap:anywhere}.trk-delete-name{font-weight:650;margin:0 0 8px}.trk-delete-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:22px}.trk-delete-actions button{min-height:44px;min-width:84px}
@container(max-width:750px){.trk-wrap{padding:22px 18px}.trk-head{flex-direction:column}.trk-row{flex-direction:row;align-items:center}.trk-row-open{flex-direction:column;align-items:flex-start;gap:10px}.trk-row-stats{gap:12px;flex-wrap:wrap;white-space:normal}.trk-detail-head{flex-direction:column}.trk-delete-dialog{padding:20px}}
`
