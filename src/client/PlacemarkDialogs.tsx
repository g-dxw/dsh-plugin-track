import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { TrackPlacemark } from '../protocol.ts'
import type { LocatedPlacemark } from '../track/placemark-location.ts'
import { formatPlacemarkElevation, formatPlacemarkTime, placemarkTitle } from '../track/placemark-format.ts'

function useModal(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null, element=ref.current!
    if(typeof element.showModal==='function')element.showModal();else element.setAttribute('open','')
    element.querySelector<HTMLButtonElement>('button')?.focus()
    return()=>{if(element.open&&typeof element.close==='function')element.close();if(previous?.isConnected)previous.focus()}
  },[])
}
export function PlacemarkDeleteDialog({points,saving,error,onConfirm,onCancel}:{points:readonly TrackPlacemark[];saving:boolean;error:string;onConfirm:()=>Promise<boolean>;onCancel:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null), title=useId(),pending=useRef(false)
  const [submitting,setSubmitting]=useState(false),[failed,setFailed]=useState(false)
  useModal(dialog)
  const locked=saving||submitting
  async function confirm(){
    if(locked||pending.current)return
    pending.current=true;setSubmitting(true);setFailed(false)
    try{if(!await onConfirm())setFailed(true)}finally{pending.current=false;setSubmitting(false)}
  }
  return <dialog ref={dialog} aria-labelledby={title} aria-modal="true" className="trk-placemark-confirm" onCancel={event=>{event.preventDefault();if(!locked)onCancel()}}>
    <style>{DIALOG_CSS}</style><h3 id={title}>删除 {points.length} 个标注点？</h3>
    <p>将同时移除地图、列表和海拔图中的标注，保留原始轨迹和图片；删除后可撤销。</p>
    <ul>{points.map((point,index)=><li key={point.id}>{placemarkTitle(point)||'标注点 '+(index+1)}</li>)}</ul>
    {failed&&<p className="trk-error" role="alert">{error||'删除未保存，请重试'}</p>}
    <footer><button type="button" className="trk-secondary" disabled={locked} onClick={onCancel}>取消</button>
      <button type="button" className="trk-secondary trk-delete" disabled={locked} onClick={()=>void confirm()}>{locked?'正在删除…':'确认删除'}</button></footer>
  </dialog>
}
export function PlacemarkLocationDialog({candidates,onChoose,onCancel}:{candidates:readonly LocatedPlacemark[];onChoose:(location:LocatedPlacemark)=>void;onCancel:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),title=useId()
  useModal(dialog)
  return <dialog ref={dialog} aria-labelledby={title} aria-modal="true" className="trk-placemark-confirm" onCancel={event=>{event.preventDefault();onCancel()}}>
    <style>{DIALOG_CSS}</style><h3 id={title}>选择经过位置</h3><p>此处对应多个轨迹位置，请选择要关联的一次经过。</p>
    <div className="trk-location-candidates">{candidates.map((location,index)=>{
      const point={...location,id:'candidate',name:'',description:'',images:[]}
      return <button type="button" className="trk-secondary" key={index} onClick={()=>onChoose(location)} aria-label={'选择第 '+(index+1)+' 次经过'}>
        <strong>{index+1} · {(location.distance/1000).toFixed(2)} km</strong><span>海拔 {formatPlacemarkElevation(point.elevation)}</span>
        <span>{formatPlacemarkTime(point.time,point.timeSource)||'未知（缺少可靠时间数据）'}</span>
      </button>
    })}</div><footer><button type="button" className="trk-secondary" onClick={onCancel}>取消定位</button></footer>
  </dialog>
}
const DIALOG_CSS = '.trk-placemark-confirm{width:min(460px,calc(100vw - 32px));max-height:calc(100dvh - 40px);box-sizing:border-box;overflow:auto;padding:20px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface);color:var(--trk-text);font:inherit}.trk-placemark-confirm::backdrop{background:rgba(0,0,0,.2)}.trk-placemark-confirm h3{margin:0}.trk-placemark-confirm p{font-size:.9286em;line-height:1.6}.trk-placemark-confirm ul{max-height:200px;overflow:auto;padding-left:24px}.trk-placemark-confirm footer{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}.trk-placemark-confirm button{min-height:40px;font:inherit}.trk-placemark-confirm button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-location-candidates{display:grid;gap:10px}.trk-location-candidates button{display:grid;gap:4px;text-align:left}'
