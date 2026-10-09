import { useEffect,useRef,useState } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { RouteAIAnalysis } from '../ai.ts'
import type { TrackAnnotation } from '../track/annotations.ts'
import { routeAIContext } from '../track/route-context.ts'
import { api } from './util.ts'
import { analyzeRoute } from './text-ai.ts'
import { useTextModels } from './useTextModels.ts'

export function RouteInsights({track}: {track: TrackRecord}) {
  const {catalog,model,setModel,reload}=useTextModels()
  const[notes,setNotes]=useState(''),[result,setResult]=useState<RouteAIAnalysis|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const pending=useRef<AbortController|null>(null),key='cqai-track.analysis.'+track.id
  useEffect(()=>{
    try{const saved=JSON.parse(localStorage.getItem(key)||'null') as RouteAIAnalysis|null;if(saved&&typeof saved.summary==='string'&&saved.summary.length<=2000&&typeof saved.difficulty==='string'&&saved.difficulty.length<=300&&['audience','equipment','checkpoints','restPoints','limitations'].every(field=>{const list=saved[field as keyof RouteAIAnalysis];return Array.isArray(list)&&list.length<=20&&list.every(item=>typeof item==='string'&&item.length<=500)}))setResult(saved)}catch{/* old/unavailable storage does not block analysis */}
    return()=>pending.current?.abort()
  },[key])
  async function generate(){
    if(!model||busy)return
    const controller=new AbortController();pending.current=controller;setBusy(true);setError('')
    try{
      const stored=await api<{annotations:TrackAnnotation[]}>(`annotations?id=${encodeURIComponent(track.id)}`)
      if(controller.signal.aborted)return
      const found=await analyzeRoute({model,context:routeAIContext(track,stored.annotations,notes)},controller.signal)
      if(controller.signal.aborted)return
      setResult(found);try{localStorage.setItem(key,JSON.stringify(found))}catch{/* result remains visible */}
    }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'路线分析失败')}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  return <details className="trk-insights"><style>{INSIGHT_CSS}</style><summary>AI 路线分析 · 打卡点、难度、人群与装备</summary>
    <p className="trk-muted">结合轨迹基础数据、已保存点位和补充信息生成建议。未标注的厕所、补给和现场路况不能由轨迹确定；休息候选需核实。</p>
    <div className="trk-art-form"><label>分析模型<select aria-label="路线分析模型" value={model} disabled={busy} onChange={event=>setModel(event.target.value)}><option value="">请选择文本模型</option>{catalog?.models.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><button className="trk-secondary" disabled={busy} onClick={reload}>刷新分析模型</button></div>
    <label className="trk-insights-notes">已知路线信息<textarea aria-label="已知路线信息" maxLength={4000} value={notes} disabled={busy} onChange={event=>setNotes(event.target.value)} placeholder="活动类型、季节、路面、打卡点、休息点和设施；未知信息可以留空" /></label>
    {catalog&&!catalog.available&&<p className="trk-muted">{catalog.message||'文本模型暂不可用'}</p>}
    {error&&<div className="trk-error" role="alert">{error}，可重试；已有分析保留。</div>}
    <button className="trk-primary" disabled={busy||!catalog?.available||!model} onClick={()=>void generate()}>{busy?'正在分析…':'生成路线分析'}</button>
    {busy&&<button className="trk-secondary" onClick={()=>{pending.current?.abort();setBusy(false)}}>取消分析</button>}
    {result&&<article aria-label="路线分析结果"><p>{result.summary}</p><p><strong>难度参考：</strong>{result.difficulty}</p>{([['打卡点',result.checkpoints],['休息点',result.restPoints],['适合人群',result.audience],['所需装备',result.equipment],['待核实与限制',result.limitations]] as const).map(([title,items])=><div key={title}><h4>{title}</h4><ul>{items.map((item,index)=><li key={index}>{item}</li>)}</ul></div>)}</article>}
  </details>
}
const INSIGHT_CSS=`.trk-insights{color:var(--trk-text);background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:14px;margin-bottom:18px}.trk-insights summary{cursor:pointer;font-weight:600}.trk-insights select,.trk-insights textarea{font:inherit;color:var(--trk-text);background:var(--trk-bg);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:8px;max-width:100%;min-height:44px}.trk-insights-notes{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}.trk-insights textarea{width:100%;min-height:80px}.trk-insights label{display:flex;flex-direction:column;gap:6px}.trk-insights button{margin-right:8px;min-height:44px}.trk-insights h4{margin-bottom:8px}.trk-insights li{margin-bottom:5px;line-height:1.7}.trk-insights article{margin-top:18px}.trk-art-form{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:12px 0}`
