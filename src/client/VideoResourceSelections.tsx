import {useEffect,useState} from 'react'
import type {ResourceAsset,ResourceVideoRole} from '../track/resources.ts'
import {loadResourceLibrary} from './resources-api.ts'
import {download,clipboardSafeName} from './util.ts'

const names:Record<ResourceVideoRole,string>={'image-insert':'图片插图','travel-video':'旅程片段',ambient:'环境声',narration:'旁白',music:'背景音乐','sound-effect':'音效'}
/** Chosen external media remain a reusable list until the video timeline supports them. */
export function VideoResourceSelections({trackId,trackName}:{trackId:string;trackName:string}) {
  const [assets,setAssets]=useState<ResourceAsset[]>([]),[error,setError]=useState(''),[open,setOpen]=useState(false),[attempt,setAttempt]=useState(0)
  useEffect(()=>{let active=true;void loadResourceLibrary(trackId).then(value=>{if(active){setAssets((value.assets||[]).filter(item=>item.videoRole&&!item.candidate&&item.status==='ready'));setError('')}}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'视频素材清单读取失败')});return()=>{active=false}},[trackId,attempt])
  return <details className="trk-video-resources" open={open} onToggle={event=>setOpen(event.currentTarget.open)} style={{margin:'12px 0',border:'1px solid var(--trk-border)',borderRadius:12,padding:12}}>
    <summary>资源库选用素材 · {assets.length} 项</summary>
    <p className="trk-muted">这里保存视频用途与素材来源。图片可在二维素材准备中选用；外部视频和音频目前支持预览与清单导出，尚未进入合成时间轴。</p>
    {error&&<p role="alert" className="trk-error">{error}<button type="button" className="trk-secondary" onClick={()=>setAttempt(value=>value+1)}>重读素材清单</button></p>}
    {open&&<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,220px),1fr))',gap:12}}>{assets.map(asset=><article key={asset.id} style={{minWidth:0}}><strong>{asset.name}</strong><p className="trk-muted">{names[asset.videoRole!]}</p>{asset.kind==='image'?<img src={asset.url} alt={asset.name} loading="lazy" style={{width:'100%',maxHeight:160,objectFit:'contain'}}/>:asset.kind==='video'?<video src={asset.url} controls preload="none" style={{width:'100%',maxHeight:200}}/>:<audio src={asset.url} controls preload="none" style={{width:'100%'}}/>}</article>)}</div>}
    {!error&&!assets.length&&<p className="trk-muted">在轨迹资源库中选择素材，再点击“用于视频”。</p>}
    <button type="button" className="trk-secondary" disabled={!assets.length} onClick={()=>download(`${clipboardSafeName(trackName)}-视频资源清单.json`,JSON.stringify({schema:'cqai-track-video-resource-list@1',trackId,resources:assets.map(({id,name,kind,url,sourceUrl,videoRole,metadata})=>({id,name,kind,url,sourceUrl,videoRole,metadata}))},null,2),'application/json')}>导出视频资源清单</button>
  </details>
}
