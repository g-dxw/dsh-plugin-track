import {useEffect,useRef,useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {ResourceAsset} from '../track/resources.ts'
import {imageLink} from '../track/placemarks.ts'
import {useTrackPlacemarks} from './useTrackPlacemarks.ts'

export function appendedResourcePhotos(existing:readonly string[], source:string):string[] {
  const normalized=imageLink(source)
  if(!normalized)throw new Error('此资源尚未保存为可用点位图片')
  const next=[...new Set([...existing,normalized])]
  if(next.length>30)throw new Error('每个标注点最多 30 张照片，请先整理已有照片')
  return next
}

export function ResourceUseDialog({track,asset,onClose,onSaved}:{track:TrackRecord;asset:ResourceAsset;onClose:()=>void;onSaved:()=>void}) {
  const points=useTrackPlacemarks(track,undefined,{preparePhotos:false})
  const [target,setTarget]=useState(asset.usages.find(item=>item.kind==='placemark')?.id||'')
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  const dialog=useRef<HTMLDivElement>(null),busyRef=useRef(false)
  useEffect(()=>{const previous=document.activeElement as HTMLElement;dialog.current?.querySelector<HTMLElement>('button')?.focus();return()=>{if(previous?.isConnected)previous.focus()}},[])
  async function save() {
    if(busyRef.current)return
    const point=points.points.find(item=>item.id===target)
    if(!point){setError('请选择仍存在的标注点');return}
    try {
      if(asset.kind!=='image'||asset.trackId!==track.id)throw new Error('资源不属于当前轨迹或不是图片')
      const images=appendedResourcePhotos(point.images,asset.sourceUrl||'')
      busyRef.current=true;setBusy(true);setError('')
      if(await points.updatePoint(point.id,{images}))onSaved()
      else setError('点位图片未保存，请检查提示或重新读取后重试')
    }catch(reason){setError(reason instanceof Error?reason.message:'添加点位照片失败')}
    finally{busyRef.current=false;setBusy(false)}
  }
  return <div className="trk-delete-overlay"><div ref={dialog} className="trk-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="trk-resource-use-title" onKeyDown={event=>{
    if(event.key==='Escape'&&!busyRef.current){event.stopPropagation();onClose()}
    if(event.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)')||[]);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
  }}>
    <h2 id="trk-resource-use-title">添加到标注点</h2><p>{asset.name}</p><p className="trk-muted">保留原照片，追加这张图片。点位位置与名称保持不变。</p>
    <label>目标点位<select aria-label="资源目标点位" value={target} disabled={busy||points.loading||!points.editReady} onChange={event=>setTarget(event.target.value)}><option value="">请选择标注点</option>{points.points.map((point,index)=><option key={point.id} value={point.id}>{index+1} · {point.name||'未命名点位'}{point.hidden?'（已隐藏）':''}</option>)}</select></label>
    {!points.loading&&points.editReady&&!points.points.length&&<p className="trk-muted">此轨迹还没有标注点，请先在轨迹编辑中添加。</p>}
    {(error||points.error||points.stateError||points.editError)&&<p className="trk-error" role="alert">{error||points.error||points.stateError||points.editError}</p>}
    {(points.error||points.stateError)&&<button type="button" className="trk-secondary" disabled={busy} onClick={points.retry}>重新读取点位</button>}
    <footer style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:20}}><button type="button" className="trk-secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="trk-primary" disabled={busy||points.loading||!points.editReady||!target} onClick={()=>void save()}>{busy?'正在保存…':'添加照片'}</button></footer>
  </div></div>
}
