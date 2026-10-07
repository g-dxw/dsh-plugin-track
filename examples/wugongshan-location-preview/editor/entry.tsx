/** The actual Track camera editor, using this self-contained demo's API/store. */
import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {GeoMotionEditor} from '../../../src/client/GeoMotionEditor.tsx'
import {MapSettingsProvider,useMapSettings} from '../../../src/client/map-settings.tsx'
import {TRACK_THEME_CSS} from '../../../src/client/theme.ts'
import {DEFAULT_MAP_SETTINGS,isBasemapId} from '../../../src/track/map-settings.ts'
import type {TrackRecord} from '../../../src/protocol.ts'

const requested=new URL(location.href).searchParams.get('basemap')
const initial=isBasemapId(requested)?requested:'satellite'
localStorage.setItem('cqai-track.basemap',initial)
localStorage.setItem('cqai-track.map-settings',JSON.stringify({...DEFAULT_MAP_SETTINGS,basemap:initial,terrainProvider:'mapterhorn',maptilerKey:'',tiandituKey:'',exaggeration:1}))
const style=`${TRACK_THEME_CSS}.trk{color:var(--trk-text);background:var(--trk-bg);font-family:inherit;box-sizing:border-box}.trk *{box-sizing:border-box}.trk button{cursor:pointer}.trk button:disabled{cursor:default}.trk-muted{color:var(--trk-muted);line-height:1.7}.trk-primary,.trk-secondary{border:1px solid var(--trk-border);background:var(--trk-surface);color:inherit;border-radius:var(--trk-radius-md);padding:9px 15px;text-decoration:none;white-space:nowrap}.trk-secondary:hover{background:var(--trk-hover)}.trk-primary{background:var(--trk-primary-bg);color:var(--trk-on-accent);border:0;font-weight:650}.camera-preview{padding:20px 24px 36px;max-width:1760px;margin:auto}.camera-preview-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;color:var(--trk-muted);font-size:12px}.camera-preview-bar strong{color:var(--trk-text)}.camera-preview-bar a{color:var(--trk-primary-bg)}@media(max-width:680px){.camera-preview{padding:12px 10px 24px}.camera-preview-bar{gap:8px}}`
function Preview(){
  const [track,setTrack]=useState<TrackRecord|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(true),[dark,setDark]=useState(false)
  const {settings,updateSettings}=useMapSettings()
  useEffect(()=>{
    const controller=new AbortController()
    void fetch('/preview/health',{signal:controller.signal}).then(response=>response.json()).then(async health=>{
      if(!health.ok)throw new Error('示例数据校验未通过，镜头编辑器尚未打开')
      const response=await fetch(`/api/cqai-track/track?id=${encodeURIComponent(health.trackId)}`,{signal:controller.signal})
      if(!response.ok)throw new Error('无法读取武功山示例数据')
      const value=await response.json()
      if(!controller.signal.aborted)setTrack(value)
    }).catch(reason=>{if(!controller.signal.aborted)setError(String(reason))})
    return()=>controller.abort()
  },[])
  function theme(){const next=!dark;setDark(next);document.body.classList.toggle('dark',next)}
  return <section className="trk"><style>{style}</style><main className="camera-preview">
    <div className="camera-preview-bar"><strong>武功山 SC02—SC04A · 3D 地图镜头</strong><span>区域定位 → 山体推进 → 路线总览 → 三段路况 → 萍乡火车站 → 龙山村入口</span><a href="/preview/project-download">下载已保存工程</a><button type="button" className="trk-secondary" onClick={theme}>{dark?'浅色主题':'深色主题'}</button></div>
    {error?<p role="alert">{error}</p>:!track?<p>正在读取武功山轨迹与镜头工程…</p>:open?<GeoMotionEditor track={track} basemap={settings.basemap} onBasemap={basemap=>updateSettings({basemap})} onCancel={()=>setOpen(false)} onCases={()=>setOpen(false)}/>:<div><p className="trk-muted">镜头工程已保留，可以继续编辑。</p><button type="button" className="trk-primary" onClick={()=>setOpen(true)}>重新打开镜头编辑器</button></div>}
  </main></section>
}
createRoot(document.getElementById('app')!).render(<MapSettingsProvider><Preview/></MapSettingsProvider>)
