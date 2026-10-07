import {Output,WebMOutputFormat,BufferTarget,CanvasSource,canEncodeVideo} from 'mediabunny'
import type {GeoMotionProject} from '../track/geomotion.ts'
import type {GeoMotionSceneHandle} from './GeoMotionScene.tsx'
import {clipboardSafeName} from './util.ts'

export type GeoExportProgress={completed:number;total:number}
export interface GeoVideoExportOptions {
  project:GeoMotionProject
  scene:GeoMotionSceneHandle
  signal?:AbortSignal
  onProgress?:(progress:GeoExportProgress)=>void
}
const cancelled=()=>new DOMException('视频导出已取消','AbortError')
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw cancelled()}

/** Fixed timestamps, composed map/labels/credits and backpressure; no global MapLibre clock. */
export async function exportGeoMotionVideo({project,scene,signal,onProgress}:GeoVideoExportOptions):Promise<{blob:Blob;filename:string}> {
  check(signal)
  const document=structuredClone(project)
  const {width,height,fps,duration}=document
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>4096||height>4096||!Number.isFinite(fps)||fps<1||fps>60||!Number.isFinite(duration)||duration<=0||duration>300)throw new Error('导出参数无效：尺寸64–4096像素、帧率1–60、时长最多300秒')
  if(typeof VideoEncoder==='undefined'||!await canEncodeVideo('vp9',{width,height,bitrate:6_000_000}))throw new Error('当前浏览器不支持此尺寸的VP9编码，请使用新版浏览器或降低分辨率')
  check(signal)
  const total=Math.ceil(duration*fps)
  let release=()=>{},target:BufferTarget|null=null,output:Output|null=null
  let source:CanvasSource|null=null,complete=false
  try {
    release=scene.freezeConfiguration()
    target=new BufferTarget();output=new Output({format:new WebMOutputFormat(),target})
    check(signal)
    await scene.renderAt(document,0,signal)
    check(signal)
    const canvas=scene.getCaptureCanvas()
    if(canvas.width!==width||canvas.height!==height)throw new Error('镜头画布与导出尺寸不一致，请等待画面就绪')
    source=new CanvasSource(canvas,{codec:'vp9',bitrate:6_000_000,latencyMode:'quality',keyFrameInterval:2})
    output.addVideoTrack(source,{frameRate:fps})
    await output.start()
    check(signal)
    onProgress?.({completed:0,total})
    for(let index=0;index<total;index++){
      check(signal)
      if(index>0)await scene.renderAt(document,index/fps,signal)
      check(signal)
      await source.add(index/fps,Math.min(1/fps,duration-index/fps))
      check(signal)
      onProgress?.({completed:index+1,total})
    }
    check(signal)
    await output.finalize()
    check(signal)
    if(!target.buffer?.byteLength)throw new Error('编码器没有生成有效视频')
    complete=true
    return{blob:new Blob([target.buffer],{type:'video/webm'}),filename:`${clipboardSafeName(document.name||'轨迹镜头')}.webm`}
  } catch(reason){
    if(signal?.aborted)throw cancelled()
    throw reason
  } finally {
    // Awaited start/add/finalize settle before cancellation; the signal still aborts renderAt promptly.
    // Output owns its sources. CanvasSource.close() after cancel/finalize starts a second,
    // detached flush against an already closed codec in Mediabunny 1.24.2.
    try{if(output&&!complete)await output.cancel().catch(()=>{})}finally{release()}
  }
}
