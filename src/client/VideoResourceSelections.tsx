import {useEffect,useState} from 'react'
import type {ResourceAsset,ResourceVideoRole} from '../track/resources.ts'
import {loadResourceLibrary} from './resources-api.ts'
import {download,clipboardSafeName} from './util.ts'

const names:Record<ResourceVideoRole,string>={'image-insert':'图片插图','travel-video':'旅程片段',ambient:'环境声',narration:'旁白',music:'背景音乐','sound-effect':'音效'}
/** Chosen external media remain a reusable list until the video timeline supports them. */
export function VideoResourceSelections({trackId,trackName}:{trackId:string;trackName:string}) {
  const [assets,setAssets]=useState<ResourceAsset[]>([]),[error,setError]=useState(''),[open,setOpen]=useState(false),[attempt,setAttempt]=useState(0)
  useEffect(()=>{let active=true;void loadResourceLibrary(trackId).then(value=>{if(active){setAssets((value.assets||[]).filter(item=>item.videoRole&&!item.candidate&&item.status==='ready'));setError('')}}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'视频素材清单读取失败')});return()=>{active=false}},[trackId,attempt])
  return <details className="trk-video-resources" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>资源库选用素材 · {assets.length} 项</summary><style>{VIDEO_RESOURCE_SELECTIONS_CSS}</style>
    <p className="trk-muted">这里保存视频用途与素材来源。图片可在二维素材准备中选用；外部视频和音频目前支持预览与清单导出，尚未进入合成时间轴。</p>
    {error&&<p role="alert" className="trk-error">{error}<button type="button" className="trk-secondary" onClick={()=>setAttempt(value=>value+1)}>重读素材清单</button></p>}
    {open&&<div className="trk-video-resource-grid">{assets.map(asset=><article key={asset.id} className="trk-video-resource-item"><strong>{asset.name}</strong><p className="trk-muted">{names[asset.videoRole!]}</p>{asset.kind==='image'?<img src={asset.url} alt={asset.name} loading="lazy" className="trk-video-resource-image"/>:asset.kind==='video'?<video src={asset.url} controls preload="none" className="trk-video-resource-video"/>:<audio src={asset.url} controls preload="none" className="trk-video-resource-audio"/>}</article>)}</div>}
    {!error&&!assets.length&&<p className="trk-muted">在轨迹资源库中选择素材，再点击“用于视频”。</p>}
    <button type="button" className="trk-secondary" disabled={!assets.length} onClick={()=>download(`${clipboardSafeName(trackName)}-视频资源清单.json`,JSON.stringify({schema:'cqai-track-video-resource-list@1',trackId,resources:assets.map(({id,name,kind,url,sourceUrl,videoRole,metadata})=>({id,name,kind,url,sourceUrl,videoRole,metadata}))},null,2),'application/json')}>导出视频资源清单</button>
  </details>
}

const VIDEO_RESOURCE_SELECTIONS_CSS=`
.trk-video-resources{container-type:inline-size;container-name:video-resources;margin:0;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md,6px);background:var(--trk-surface);color:var(--trk-text);font-size:var(--trk-ui-font-size,13px);min-width:0;overflow:hidden}
.trk-video-resources>summary{min-height:36px;padding:7px 10px;font-size:var(--trk-ui-label-size,12px);font-weight:600;cursor:pointer}.trk-video-resources[open]>summary{border-bottom:1px solid var(--trk-border)}
.trk-video-resources>p{margin:8px 10px;line-height:1.5;overflow-wrap:anywhere}.trk-video-resources>button{margin:8px 10px;min-height:var(--trk-control-height,32px);font-size:var(--trk-ui-label-size,12px);padding:4px 9px;border-radius:var(--trk-radius-sm,5px)}
.trk-video-resource-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:0}.trk-video-resource-item{min-width:0;padding:10px;border-top:1px solid var(--trk-border);border-right:1px solid var(--trk-border)}.trk-video-resource-item strong{overflow-wrap:anywhere;font-size:var(--trk-ui-font-size,13px)}.trk-video-resource-item p{font-size:var(--trk-ui-label-size,12px);margin:5px 0;color:var(--trk-muted)}
.trk-video-resource-image{width:100%;max-height:160px;object-fit:contain}.trk-video-resource-video{width:100%;max-height:200px}.trk-video-resource-audio{width:100%;min-width:0}
.trk-video-resources :focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
@container video-resources (max-width:720px){.trk-video-resources>summary,.trk-video-resources>button{min-height:44px}}
`
