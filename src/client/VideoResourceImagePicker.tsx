import {useState} from 'react'
import type {ResourceAsset} from '../track/resources.ts'
import {loadResourceLibrary} from './resources-api.ts'

export function VideoResourceImagePicker({trackId,disabled,onChoose}:{trackId:string;disabled:boolean;onChoose:(url:string)=>void}) {
  const [assets,setAssets]=useState<ResourceAsset[]>([]),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function load(){setOpen(true);setBusy(true);setError('');try{const value=await loadResourceLibrary(trackId);setAssets(value.assets.filter(item=>item.kind==='image'&&item.status==='ready'&&!item.candidate&&!!item.sourceUrl))}catch(reason){setError(reason instanceof Error?reason.message:'资源图片读取失败')}finally{setBusy(false)}}
  return <div className="trk-vm-resource-picker"><button type="button" className="trk-secondary" disabled={disabled||busy} onClick={()=>{if(open)setOpen(false);else void load()}}>{busy?'正在读取资源…':open?'收起资源库图片':'从资源库选择图片'}</button>{open&&<div aria-label="资源库图片选择">{error&&<p role="alert" className="trk-vm-error">{error}<button type="button" disabled={disabled||busy} onClick={()=>void load()}>重试</button></p>}{!busy&&!error&&!assets.length&&<p className="trk-vm-help">资源库暂无已采用图片。请先导入图片或采用 AI 结果。</p>}{assets.map(asset=><div key={asset.id} style={{display:'flex',gap:8,alignItems:'center',marginTop:8}}><img src={asset.url} alt="" loading="lazy" style={{width:48,height:48,objectFit:'cover',borderRadius:6}}/><span style={{flex:1,overflowWrap:'anywhere'}}>{asset.name}</span><button type="button" aria-label={`使用资源图片：${asset.name}`} disabled={disabled} onClick={()=>onChoose(asset.sourceUrl!)}>使用</button></div>)}</div>}</div>
}
