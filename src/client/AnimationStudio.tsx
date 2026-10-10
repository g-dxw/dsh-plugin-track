import { useEffect,useRef,useState } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import type { AnimationScript } from '../ai.ts'
import type { TrackAnnotation } from '../track/annotations.ts'
import { routeAIContext } from '../track/route-context.ts'
import { api } from './util.ts'
import { generateAnimationScript } from './text-ai.ts'
import { useTextModels } from './useTextModels.ts'
import { TrackAnimation } from './TrackAnimation.tsx'
import { MapView } from './MapView.tsx'

export function AnimationStudio({track,basemap,onBasemap,onCancel}: {track:TrackRecord;basemap:BasemapId;onBasemap:(value:BasemapId)=>void;onCancel:()=>void}) {
  const {catalog,model,setModel,reload}=useTextModels()
  const[notes,setNotes]=useState(''),[script,setScript]=useState<AnimationScript|null>(null),[adopted,setAdopted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const pending=useRef<AbortController|null>(null),key='cqai-track.animation-script.'+track.id
  useEffect(()=>{
    try{const saved=JSON.parse(localStorage.getItem(key)||'null') as {version?:number;script?:unknown}|null;if(saved?.version===1&&isStoredScript(saved.script,track.coordinates.length))setScript(saved.script)}catch{/* ignore unavailable or malformed cache */}
    return()=>pending.current?.abort()
  },[key,track.coordinates.length])
  async function generate(){
    if(!model||busy)return
    const controller=new AbortController();pending.current=controller;setBusy(true);setError('')
    try{
      const stored=await api<{annotations:TrackAnnotation[]}>(`annotations?id=${encodeURIComponent(track.id)}`)
      if(controller.signal.aborted)return
      const found=await generateAnimationScript({model,context:routeAIContext(track,stored.annotations,notes)},controller.signal)
      if(!controller.signal.aborted){setScript(found);setAdopted(false);try{localStorage.setItem(key,JSON.stringify({version:1,script:found}))}catch{/* script remains available in this page */}}
    }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'生成动画脚本失败')}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  if(adopted&&script)return <TrackAnimation key={JSON.stringify(script)} track={track} basemap={basemap} onBasemap={onBasemap} script={script.shots} backLabel="返回镜头脚本" onCancel={()=>setAdopted(false)} />
  return <section className="trk-animation-studio" aria-label="AI 轨迹动画脚本"><style>{STUDIO_CSS}</style>
    <header><div><h2>轨迹动画录制</h2><p className="trk-muted">先用 AI 生成镜头脚本，审阅后沿脚本播放并导出 WebM 视频。</p></div><button className="trk-secondary" onClick={onCancel}>返回轨迹</button></header>
    <div className="trk-stage"><MapView trackId={track.id} points={track.coordinates} name={track.name} basemap={basemap} onBasemap={onBasemap}/></div>
    <div className="trk-art-form"><label>脚本模型<select aria-label="动画脚本模型" value={model} disabled={busy} onChange={event=>setModel(event.target.value)}><option value="">请选择文本模型</option>{catalog?.models.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><button className="trk-secondary" disabled={busy} onClick={reload}>刷新脚本模型</button></div>
    <label>镜头要求<textarea aria-label="动画镜头要求" maxLength={4000} value={notes} disabled={busy} onChange={event=>setNotes(event.target.value)} placeholder="例如：开场全景，沿线跟随，停留山口打卡点，结尾全景；不会录制真人定位" /></label>
    <p className="trk-muted">生成脚本只发送基础统计、最多 80 个路线采样点、已保存标注与镜头要求。视频包含地图、行进轨迹、字幕和地图署名；本次先支持全景、跟随和点位聚焦三种镜头。</p>
    {catalog&&!catalog.available&&<p className="trk-error">{catalog.message||'文本模型不可用，请启用账号服务后重试'}</p>}
    {error&&<div className="trk-error" role="alert">{error}，可重试；已有脚本保留。</div>}
    <div className="trk-art-form"><button className="trk-primary" disabled={busy||!catalog?.available||!model} onClick={()=>void generate()}>{busy?'正在生成脚本…':'AI 生成录制脚本'}</button>{busy&&<button className="trk-secondary" onClick={()=>{pending.current?.abort();setBusy(false)}}>取消生成脚本</button>}</div>
    {script&&<article aria-label="动画镜头脚本"><h3>{script.title}</h3><ol>{script.shots.map((shot,index)=><li key={index}><strong>{['overview','follow','checkpoint'].includes(shot.type)?{overview:'全景',follow:'沿线跟随',checkpoint:'点位聚焦'}[shot.type]:shot.type}</strong> · {shot.duration} 秒{shot.pointIndex===undefined?'':` · 第 ${shot.pointIndex+1} 个轨迹点`}<p>{shot.narration}</p></li>)}</ol><p>总时长 {script.shots.reduce((total,shot)=>total+shot.duration,0)} 秒</p><button className="trk-primary" onClick={()=>setAdopted(true)}>采用脚本，进入播放与录制</button></article>}
  </section>
}
function isStoredScript(value:unknown,pointCount:number):value is AnimationScript {
  if(!value||typeof value!=='object')return false
  const script=value as AnimationScript
  return typeof script.title==='string'&&script.title.length<=160&&Array.isArray(script.shots)&&script.shots.length>=2&&script.shots.length<=12&&script.shots.every(shot=>shot&&['overview','follow','checkpoint'].includes(shot.type)&&Number.isFinite(shot.duration)&&shot.duration>=3&&shot.duration<=30&&(shot.narration===undefined||typeof shot.narration==='string'&&shot.narration.length<=600)&&(shot.type!=='checkpoint'||Number.isInteger(shot.pointIndex)&&shot.pointIndex!>=0&&shot.pointIndex!<pointCount))&&script.shots.some(shot=>shot.type==='overview')&&script.shots.some(shot=>shot.type==='follow')&&script.shots.reduce((total,shot)=>total+shot.duration,0)<=180
}
const STUDIO_CSS=`.trk-animation-studio{color:var(--trk-text);font:inherit;font-size:var(--trk-ui-font-size,13px);min-width:0}.trk-animation-studio header{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;margin-bottom:0;padding:8px 10px;border:1px solid var(--trk-border);border-bottom:0;background:var(--trk-surface)}.trk-animation-studio h2{margin-top:0;font-size:16px;margin:0}.trk-animation-studio label{display:flex;flex-direction:column;gap:5px;font-size:var(--trk-ui-label-size,12px)}.trk-animation-studio textarea{width:100%;min-height:88px;font:inherit;color:var(--trk-text);background:var(--trk-bg);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:6px 8px;font-size:var(--trk-ui-label-size,12px)}.trk-animation-studio select{font:inherit;color:var(--trk-text);background:var(--trk-bg);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:4px 7px;min-height:var(--trk-input-height,30px);max-width:100%;font-size:var(--trk-ui-label-size,12px)}.trk-animation-studio button{min-height:var(--trk-control-height,32px);padding:5px 9px;font-size:var(--trk-ui-label-size,12px)}.trk-animation-studio li{margin-bottom:0;padding:8px 0;border-bottom:1px solid var(--trk-border)}.trk-animation-studio li p{margin:5px 0;color:var(--trk-muted);line-height:1.6}.trk-art-form{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0}
.trk-animation-studio .trk-stage{border:1px solid var(--trk-border);border-radius:0;margin:0;overflow:hidden}.trk-animation-studio>article{border:1px solid var(--trk-border);padding:10px;margin-top:8px}.trk-animation-studio>article h3{font-size:14px;margin:0}.trk-animation-studio>article ol{margin:0;padding-left:20px}.trk-animation-studio>p{font-size:var(--trk-ui-label-size,12px);line-height:1.5;margin:8px 0}.trk-animation-studio button:focus-visible,.trk-animation-studio select:focus-visible,.trk-animation-studio textarea:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
@container(max-width:760px){.trk-animation-studio button{min-height:44px}.trk-animation-studio select{min-height:40px}.trk-animation-studio header{align-items:flex-start}}
@media(pointer:coarse){.trk-animation-studio button{min-height:44px}.trk-animation-studio select{min-height:40px}.trk-animation-studio header{align-items:flex-start}}
`
