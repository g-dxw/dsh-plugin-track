import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { SHOT_CASES, buildShotCasePlan, type ShotCaseId, type ShotCaseParameters, type ShotCasePlan } from '../track/shot-cases.ts'
import { useTrackPlacemarks } from './useTrackPlacemarks.ts'
import { ShotCaseMap } from './ShotCaseMap.tsx'
import { clipboardSafeName, download } from './util.ts'

type Props = {track:TrackRecord;basemap:BasemapId;onBasemap:(id:BasemapId)=>void;onCancel:()=>void;onPlanning:()=>void;onEditing?:()=>void;onGeoMotion?:()=>void;onMaterials?:()=>void}
type RecordedCase = {caseId:ShotCaseId;parameters:ShotCaseParameters;summary:string[];targetDescription:string}
type Video = RecordedCase & {url:string;filename:string;caseTitle:string}
type Capture = RecordedCase & {recorder:MediaRecorder;stream:MediaStream;requestFrame:(()=>void)|null;chunks:Blob[];mime:string;filename:string;title:string;started:boolean;awaitingFinal:boolean;stopping:boolean;discard:boolean;released:boolean;timer:ReturnType<typeof setTimeout>|null;flushTimer:ReturnType<typeof setTimeout>|null;finalFlushing:boolean;awaitingExtraPaint:boolean;finalPaints:number}

/** A viewable camera vocabulary. Choosing, playing or recording a case never adopts a film script. */
export function ShotCaseLab(props:Props) {return <CaseWorkspace key={props.track.id} {...props}/>}
function CaseWorkspace({track,basemap,onBasemap,onCancel,onPlanning,onEditing,onGeoMotion,onMaterials}:Props) {
  const points = useTrackPlacemarks(track)
  const [caseId,setCaseId] = useState<ShotCaseId>('route-intro')
  const [parameters,setParameters] = useState<ShotCaseParameters>({duration:12,detailZoom:3,pitch:0,bearing:0,pointIndex:Math.floor(Math.max(0,track.coordinates.length-1)/2),startIndex:0,endIndex:Math.max(0,track.coordinates.length-1),caption:''})
  const [progress,setProgress] = useState(0), [playing,setPlaying] = useState(false)
  const [canvas,setCanvas] = useState<HTMLCanvasElement|null>(null), [mapError,setMapError] = useState<string|null>(null), [captureError,setCaptureError] = useState<string|null>(null)
  const [error,setError] = useState(''), [recording,setRecording] = useState(false), [recordStatus,setRecordStatus] = useState('')
  const [captureRequest,setCaptureRequest] = useState(0), [frozen,setFrozen] = useState<{plan:ShotCasePlan;basemap:BasemapId}|null>(null), [video,setVideo] = useState<Video|null>(null)
  const alive = useRef(true), frame = useRef<number|null>(null), currentProgress = useRef(0), capture = useRef<Capture|null>(null), videoURL = useRef<string|null>(null)
  const segmentsReady = Array.isArray(track.segmentStarts) || (points.routeReady && !!points.routeContext)
  const ready = points.editReady && !points.loading && !points.error && !points.stateError
  const visiblePoints = useMemo(()=>points.points.filter(point=>!point.hidden),[points.points])
  const sceneTrack = useMemo(()=>points.routeContext ? {...track,segmentStarts:points.routeContext.segmentStarts} : track,[track,points.routeContext])
  const built = useMemo(() => {
    if(!ready)return {plan:null,error:''}
    try{return {plan:buildShotCasePlan(sceneTrack,caseId,parameters,visiblePoints),error:''}}
    catch(reason){return {plan:null,error:message(reason)}}
  }, [ready,sceneTrack,caseId,parameters,visiblePoints])
  const plan = recording&&frozen?frozen.plan:built.plan
  const selected = SHOT_CASES.find(item=>item.id===caseId) || SHOT_CASES[0]
  const mime = useMemo(()=>typeof MediaRecorder==='undefined'?'':['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].find(type=>MediaRecorder.isTypeSupported(type))||'',[])
  const available = !!plan && !!canvas && !mapError
  const canRecord = available && segmentsReady && !!mime && typeof canvas?.captureStream==='function' && !captureError && !recording

  const stopFrames = useCallback(()=>{if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null}},[])
  const position = useCallback((value:number)=>{currentProgress.current=Math.max(0,Math.min(1,value));setProgress(currentProgress.current)},[])
  const release = useCallback((session:Capture)=>{
    if(session.timer!==null){clearTimeout(session.timer);session.timer=null}
    if(session.flushTimer!==null){clearTimeout(session.flushTimer);session.flushTimer=null}
    if(!session.released){session.released=true;for(const mediaTrack of session.stream.getTracks())mediaTrack.stop()}
  },[])
  const clearVideo = useCallback(()=>{if(videoURL.current)URL.revokeObjectURL(videoURL.current);videoURL.current=null;if(alive.current)setVideo(null)},[])
  const discardCapture = useCallback((reason='')=>{
    const session=capture.current;capture.current=null
    if(session){session.discard=true;session.recorder.ondataavailable=null;session.recorder.onstop=null;session.recorder.onerror=null;try{if(session.recorder.state!=='inactive')session.recorder.stop()}catch{/* still release every media track */}release(session)}
    stopFrames()
    if(alive.current){setPlaying(false);setRecording(false);setFrozen(null);setRecordStatus('');if(reason)setError(reason)}
  },[release,stopFrames])
  const finishCapture = useCallback((session:Capture)=>{
    release(session)
    if(!alive.current||session.discard||capture.current!==session)return
    capture.current=null;session.recorder.ondataavailable=null;session.recorder.onstop=null;session.recorder.onerror=null
    const blob=new Blob(session.chunks,{type:session.mime});session.chunks=[]
    setRecording(false);setFrozen(null);setRecordStatus('');setPlaying(false)
    if(!blob.size){setError('浏览器未生成视频内容，请重试录制。');return}
    try{clearVideo();const url=URL.createObjectURL(blob);videoURL.current=url;setVideo({url,filename:session.filename,caseTitle:session.title,caseId:session.caseId,parameters:{...session.parameters},summary:[...session.summary],targetDescription:session.targetDescription})}
    catch{setError('无法创建视频预览，请重试录制。')}
  },[release,clearVideo])
  const finishRecording = useCallback(()=>{
    const session=capture.current
    if(!session||session.stopping)return
    session.stopping=true;if(session.timer!==null){clearTimeout(session.timer);session.timer=null}
    setRecordStatus('正在生成案例视频…')
    try{session.recorder.stop()}catch(reason){discardCapture(`录制结束失败：${message(reason)}`)}
  },[discardCapture])
  useEffect(()=>{
    alive.current=true
    return()=>{alive.current=false;stopFrames();discardCapture();clearVideo()}
  },[stopFrames,discardCapture,clearVideo])
  useEffect(()=>{
    if(!playing||!plan||!available)return
    let last:number|null=null
    const tick=(now:number)=>{
      if(last===null){last=now;frame.current=requestAnimationFrame(tick);return}
      const next=Math.min(1,currentProgress.current+(now-last)/(plan.duration*1000));last=now
      if(next>=1){
        const session=capture.current
        if(session&&session.started&&!session.stopping){session.awaitingFinal=true;setRecordStatus('等待最后一帧画面…');session.timer=setTimeout(()=>{if(capture.current===session&&session.awaitingFinal)discardCapture('最后一帧地图加载超过 5 秒，已取消录制；可重试。')},5000)}
        position(1);setPlaying(false);frame.current=null;return
      }
      position(next);frame.current=requestAnimationFrame(tick)
    }
    frame.current=requestAnimationFrame(tick)
    return stopFrames
  },[playing,plan,available,position,stopFrames,discardCapture])
  const onCanvas = useCallback((value:HTMLCanvasElement|null)=>{if(!alive.current)return;setCanvas(value);if(!value&&capture.current)discardCapture('地图录制画布不可用，已取消录制。')},[discardCapture])
  const onUnavailable = useCallback((value:string|null)=>{if(!alive.current)return;setMapError(value);if(value){stopFrames();setPlaying(false);if(capture.current)discardCapture(`地图暂不可用：${value}`)}},[discardCapture,stopFrames])
  const onCaptureError = useCallback((value:string|null)=>{if(!alive.current)return;setCaptureError(value);if(value&&capture.current)discardCapture(value)},[discardCapture])
  const onCaptureFrame = useCallback((painted:number)=>{
    const session=capture.current
    if(!session||session.discard||session.stopping)return
    if(!session.started){
      if(painted!==0)return
      if(session.timer!==null){clearTimeout(session.timer);session.timer=null}
      try{session.recorder.start(1000);session.started=true;session.requestFrame?.();setRecordStatus('正在录制案例…');setPlaying(true)}catch(reason){discardCapture(`无法开始录制：${message(reason)}`)}
      return
    }
    try{session.requestFrame?.()}catch(reason){discardCapture(`无法捕获案例画面：${message(reason)}`);return}
    if(session.awaitingFinal&&painted===1){
      const requestExtraPaint=()=>{
        session.flushTimer=setTimeout(()=>{
          if(capture.current!==session||session.discard||session.stopping||!alive.current)return
          session.flushTimer=null;session.awaitingExtraPaint=true;setCaptureRequest(value=>value+1)
        },150)
      }
      if(!session.finalFlushing){session.finalFlushing=true;session.finalPaints=1;requestExtraPaint()}
      else if(session.awaitingExtraPaint){
        session.awaitingExtraPaint=false;session.finalPaints++
        if(session.finalPaints<3)requestExtraPaint()
        else session.flushTimer=setTimeout(()=>{if(capture.current===session&&!session.discard&&alive.current)finishRecording()},200)
      }
    }
  },[discardCapture,finishRecording])

  function reset(){stopFrames();setPlaying(false);position(0);setError('')}
  function changeCase(id:ShotCaseId){if(capture.current)return;reset();setCaseId(id)}
  function adjust(patch:Partial<ShotCaseParameters>){if(capture.current)return;reset();setParameters(current=>({...current,...patch}))}
  function jump(value:number){if(capture.current)return;stopFrames();setPlaying(false);position(value)}
  function playPause(){if(!available||capture.current)return;if(playing){stopFrames();setPlaying(false)}else{if(currentProgress.current>=1)position(0);setPlaying(true)}}
  function replay(){if(!available||capture.current)return;reset();setPlaying(true)}
  function startRecording(){
    if(!canRecord||!canvas||!plan||capture.current)return
    reset();clearVideo();let stream:MediaStream|null=null
    try{
      stream=canvas.captureStream(0)
      const manualTrack=stream.getVideoTracks()[0] as (MediaStreamTrack & {requestFrame?:()=>void})|undefined
      if(!manualTrack)throw new Error('没有可录制的视频轨道')
      const requestFrame=typeof manualTrack.requestFrame==='function'?()=>manualTrack.requestFrame!():null
      if(!requestFrame){
        for(const mediaTrack of stream.getTracks())mediaTrack.stop()
        stream=null
        stream=canvas.captureStream(30)
        if(!stream.getVideoTracks().length)throw new Error('没有可录制的视频轨道')
      }
      const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6_000_000})
      const definition=SHOT_CASES.find(item=>item.id===plan.id)!
      const targetDescription=definition.usesPoint?('目标：'+(plan.selectedTarget?.label||('轨迹点 '+(plan.parameters.pointIndex+1)))):definition.usesSection?('局部范围：第 '+(plan.parameters.startIndex+1)+'–'+(plan.parameters.endIndex+1)+' 个轨迹点'):'范围：整条路线'
      const session:Capture={recorder,stream,requestFrame,chunks:[],mime,caseId:plan.id,parameters:{...plan.parameters},summary:[...plan.summary],targetDescription,filename:`${clipboardSafeName(track.name)}-${clipboardSafeName(plan.title)}-案例.webm`,title:plan.title,started:false,awaitingFinal:false,stopping:false,discard:false,released:false,timer:null,flushTimer:null,finalFlushing:false,awaitingExtraPaint:false,finalPaints:0}
      capture.current=session
      recorder.ondataavailable=event=>{if(capture.current===session&&!session.discard&&event.data.size)session.chunks.push(event.data)}
      recorder.onstop=()=>finishCapture(session)
      recorder.onerror=()=>{if(capture.current===session)discardCapture('浏览器录制失败；参数保留，可重试。')}
      session.timer=setTimeout(()=>{if(capture.current===session&&!session.started)discardCapture('起始画面加载超过 5 秒，已取消录制；可重试。')},5000)
      setFrozen({plan,basemap});setRecording(true);setRecordStatus('等待起始画面…');setCaptureRequest(value=>value+1)
    }catch(reason){if(capture.current)discardCapture();else for(const mediaTrack of stream?.getTracks()||[])mediaTrack.stop();setError(`无法开始录制：${message(reason)}`)}
  }
  function leave(action:()=>void){stopFrames();discardCapture();clearVideo();action()}
  function exportConfig(){if(!plan||!segmentsReady||capture.current)return;download(`${clipboardSafeName(track.name)}-${caseId}-镜头案例.json`,JSON.stringify({schema:'cqai-track-shot-case@1',trackId:track.id,caseId,parameters,summary:plan.summary},null,2))}
  function exportVideoConfig(){if(!video||!segmentsReady)return;download(`${clipboardSafeName(track.name)}-${video.caseId}-录制参数.json`,JSON.stringify({schema:'cqai-track-shot-case@1',trackId:track.id,caseId:video.caseId,parameters:video.parameters,summary:video.summary},null,2))}
  const numeric=(value:string)=>value===''?NaN:Number(value)

  return <section className="trk-shot-lab" aria-label="镜头案例测试台"><style>{CASE_LAB_CSS}</style>
    <header className="trk-sc-header"><div><h2>镜头案例测试台</h2><p className="trk-muted">先观看怎么讲、怎么拍，再调整构图和节奏。选择或录制案例不代表采用到成片。</p></div><div className="trk-sc-actions">{onMaterials&&<button type="button" className="trk-primary" disabled={recording} onClick={()=>leave(onMaterials)}>二维素材准备</button>}{onGeoMotion&&<button type="button" className="trk-primary" disabled={recording} onClick={onGeoMotion}>地图镜头编辑</button>} {onEditing&&<button className="trk-primary" disabled={recording} onClick={()=>leave(onEditing)}>三维镜头编辑</button>}<button className="trk-secondary" onClick={()=>leave(onCancel)}>返回轨迹</button></div></header>
    <div className="trk-sc-catalog"><section aria-label="叙事组合案例"><h3>叙事组合案例 · 怎么讲</h3><div className="trk-sc-case-grid">{SHOT_CASES.filter(item=>item.category==='narrative').map(item=><button className={`trk-sc-case ${caseId===item.id?'selected':''}`} aria-pressed={caseId===item.id} key={item.id} data-case-id={item.id} disabled={recording} onClick={()=>changeCase(item.id)}><strong>{item.label}</strong><span>{item.description}</span><small>{item.sequence.join(' → ')}</small></button>)}</div></section>
      <section aria-label="基础地图镜头"><h3>基础地图镜头 · 怎么拍</h3><div className="trk-sc-case-grid">{SHOT_CASES.filter(item=>item.category==='shot').map(item=><button className={`trk-sc-case ${caseId===item.id?'selected':''}`} aria-pressed={caseId===item.id} key={item.id} data-case-id={item.id} disabled={recording} onClick={()=>changeCase(item.id)}><strong>{item.label}</strong><span>{item.description}</span></button>)}</div></section></div>
    {!ready&&<p role="status" className="trk-sc-notice">正在读取已保存的轨迹点位…</p>}
    {(points.error||points.stateError)&&<div className="trk-error" role="alert">{points.error||points.stateError}<button className="trk-secondary" disabled={recording} onClick={points.retry}>重新读取点位</button></div>}
    {!segmentsReady&&<div className="trk-sc-notice" role={points.routeError?'alert':'status'}>{points.routeError?<><p>原轨迹分段恢复失败：{points.routeError}。仍可预览，但路线连接关系尚未核对，暂不能录制或导出配置。</p><button className="trk-secondary" disabled={recording} onClick={points.retry}>重新读取分段信息</button></>:<p>正在恢复原轨迹分段，分段尚未核对。仍可预览，恢复完成后自动开放录制与配置导出。</p>}</div>}
    {(error||built.error||mapError)&&<div className="trk-error" role="alert">{error||built.error||mapError}</div>}
    <div className="trk-sc-workspace"><div className="trk-sc-preview-column">
      <div className="trk-sc-stage" role="group" aria-label="实际地图镜头预览">{plan?<ShotCaseMap plan={plan} progress={progress} basemap={recording&&frozen?frozen.basemap:basemap} onBasemap={id=>{if(!capture.current){reset();onBasemap(id)}}} onCanvas={onCanvas} onUnavailable={onUnavailable} onCaptureError={onCaptureError} onCaptureFrame={onCaptureFrame} captureRequest={captureRequest} disabled={recording}/>:<div className="trk-sc-placeholder">{built.error?'请调整参数后查看实际地图预览。':'读取完成后显示实际地图预览。'}</div>}</div>
      <div className="trk-sc-controls"><div className="trk-sc-actions"><button className="trk-primary" disabled={!available||recording} onClick={playPause}>{playing?'暂停':progress>0&&progress<1?'继续播放':'播放案例'}</button><button className="trk-secondary" disabled={!available||recording} onClick={replay}>重新播放</button><button className="trk-secondary" disabled={!available||recording} onClick={()=>jump(0)}>看起始画面</button><button className="trk-secondary" disabled={!available||recording} onClick={()=>jump(.5)}>看中间画面</button><button className="trk-secondary" disabled={!available||recording} onClick={()=>jump(1)}>看结束画面</button></div>
        <label className="trk-sc-progress">案例进度<input aria-label="案例进度" type="range" min={0} max={1000} value={Math.round(progress*1000)} disabled={!available||recording} onChange={event=>jump(Number(event.target.value)/1000)}/></label><output aria-label="案例播放状态">{Math.round(progress*100)}% · {Math.round(progress*(plan?.duration||parameters.duration)*10)/10} / {plan?.duration||parameters.duration} 秒{recording?` · ${recordStatus}`:playing?' · 正在播放':' · 已暂停'}</output>
      </div>
      {plan&&<article className="trk-sc-description" aria-label="当前案例镜头语言"><h3>{plan.title}</h3><ul>{(Array.isArray(plan.summary)?plan.summary:[plan.summary]).map((line,index)=><li key={index}>{line}</li>)}</ul><ol>{plan.steps.map((step,index)=><li key={index}>{step.label} · {Math.round(step.duration*10)/10} 秒</li>)}</ol>{plan.warnings.length>0&&<div className="trk-sc-notice"><strong>观看时需要注意</strong><ul>{plan.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}</article>}
    </div><aside className="trk-sc-parameters" aria-label="镜头案例参数"><h3>调整当前案例</h3><p className="trk-muted">参数修改会暂停播放并回到起始画面，可马上比较效果。</p><fieldset disabled={recording||!ready}><legend className="trk-sc-sr-only">案例参数</legend>
      <div className="trk-sc-fields"><label>案例时长（秒）<input aria-label="案例时长" type="number" min={3} max={60} step={1} value={Number.isFinite(parameters.duration)?parameters.duration:''} onChange={event=>adjust({duration:numeric(event.target.value)})}/></label><label>推近幅度（0–6）<input aria-label="推近幅度" type="number" min={0} max={6} step={.25} value={Number.isFinite(parameters.detailZoom)?parameters.detailZoom:''} onChange={event=>adjust({detailZoom:numeric(event.target.value)})}/></label><label>地图方向（度）<input aria-label="地图方向" type="number" min={-180} max={180} step={5} value={Number.isFinite(parameters.bearing)?parameters.bearing:''} onChange={event=>adjust({bearing:numeric(event.target.value)})}/></label><label>俯视倾斜（0–60°）<input aria-label="俯视倾斜" type="number" min={0} max={60} step={5} value={Number.isFinite(parameters.pitch)?parameters.pitch:''} onChange={event=>adjust({pitch:numeric(event.target.value)})}/></label></div>
      {selected.usesPoint&&<><label>目标位置<select aria-label="目标位置" value={parameters.placemarkId||'route-point'} onChange={event=>adjust({placemarkId:event.target.value==='route-point'?undefined:event.target.value})}><option value="route-point">手工选择轨迹点</option>{visiblePoints.map(point=><option key={point.id} value={point.id}>{point.name||'未命名点位'} · 独立点位</option>)}</select></label>{!parameters.placemarkId&&<label>目标轨迹点号（1–{track.coordinates.length}）<input aria-label="目标轨迹点号" type="number" min={1} max={track.coordinates.length} value={Number.isFinite(parameters.pointIndex)?parameters.pointIndex+1:''} onChange={event=>adjust({pointIndex:numeric(event.target.value)-1})}/></label>}</>}
      {selected.usesSection&&<div className="trk-sc-fields"><label>局部范围起点号<input aria-label="局部范围起点号" type="number" min={1} max={track.coordinates.length} value={Number.isFinite(parameters.startIndex)?parameters.startIndex+1:''} onChange={event=>adjust({startIndex:numeric(event.target.value)-1})}/></label><label>局部范围终点号<input aria-label="局部范围终点号" type="number" min={1} max={track.coordinates.length} value={Number.isFinite(parameters.endIndex)?parameters.endIndex+1:''} onChange={event=>adjust({endIndex:numeric(event.target.value)-1})}/></label></div>}
      <label>示例屏幕文案<textarea aria-label="示例屏幕文案" maxLength={600} value={parameters.caption} onChange={event=>adjust({caption:event.target.value})} placeholder="例如：先看整体路线，再聚焦这一段爬升。"/></label>
    </fieldset><p className="trk-muted">当前只展示地图镜头；倾斜视角不代表已生成真实 3D 地形。难度、补给和集合安排需要已核实资料，本页不会自动认定。</p>
      <div className="trk-sc-actions">{recording?<button className="trk-secondary" onClick={()=>discardCapture('已取消本次案例录制；参数保留。')}>取消录制</button>:<button className="trk-primary" disabled={!canRecord} onClick={startRecording}>录制当前案例 WebM</button>}<button className="trk-secondary" disabled={!plan||!segmentsReady||recording} onClick={exportConfig}>导出案例配置 JSON</button></div>
      <p className="trk-muted">案例录制从起始画面开始，到结束画面完成。录制期间参数和底图固定。</p>{!mime&&<p role="status">当前浏览器不支持 WebM 录制，仍可查看和播放案例。</p>}{captureError&&<p role="status" className="trk-sc-notice">{captureError}</p>}
    </aside></div>
    {video&&<article className="trk-sc-video" aria-label="已录制的镜头案例"><h3>{video.caseTitle} · 录制案例</h3><video controls preload="metadata" src={video.url} aria-label="录制案例视频"/><p aria-label="本次录制参数">本次录制参数：{video.parameters.duration} 秒 · 推近 {video.parameters.detailZoom} · 方向 {video.parameters.bearing}° · 倾斜 {video.parameters.pitch}° · {video.targetDescription}</p><p className="trk-muted">上方修改只更新预览，这段视频保留本次录制时的参数。案例视频供观看比较，还没有采用到成片。</p><div className="trk-sc-actions"><a className="trk-secondary" href={video.url} download={video.filename}>下载案例 WebM</a><button className="trk-secondary" disabled={!segmentsReady} onClick={exportVideoConfig}>导出此视频参数</button></div></article>}
    <footer className="trk-sc-footer"><p className="trk-muted">先把镜头语言看清楚；需要整理影片内容时，再进入脚本策划。</p><button className="trk-secondary" onClick={()=>leave(onPlanning)}>进入脚本策划（后续使用）</button></footer>
  </section>
}
function message(reason:unknown){return reason instanceof Error?reason.message:String(reason)}
const CASE_LAB_CSS=`
.trk-shot-lab{color:var(--trk-text);font:inherit;min-width:0;line-height:1.65}.trk-shot-lab *{box-sizing:border-box}.trk-shot-lab h2,.trk-shot-lab h3{margin:0 0 8px}.trk-shot-lab h2{font-size:calc(var(--trk-font-size)*1.5714)}.trk-shot-lab h3{font-size:1.05em}.trk-shot-lab p{margin:6px 0 12px;overflow-wrap:anywhere}.trk-shot-lab button:not(.maplibregl-ctrl-attrib-button),.trk-shot-lab .trk-sc-video a{min-height:44px;max-width:100%;white-space:normal;overflow-wrap:anywhere}.trk-shot-lab button:disabled{opacity:.5;cursor:not-allowed}.trk-sc-header{display:flex;justify-content:space-between;align-items:start;gap:16px;flex-wrap:wrap;margin-bottom:20px}.trk-sc-catalog{display:grid;gap:20px;margin:18px 0 24px}.trk-sc-case-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.trk-sc-case{display:flex;flex-direction:column;gap:5px;text-align:left;padding:13px 14px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface);color:var(--trk-text);font:inherit;cursor:pointer}.trk-sc-case strong{font-size:1em}.trk-sc-case span,.trk-sc-case small{font-size:.9em;color:var(--trk-muted)}.trk-sc-case:hover:not(:disabled){background:var(--trk-hover)}.trk-sc-case.selected{border-color:var(--trk-accent);background:var(--trk-active)}.trk-sc-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,31%);gap:20px;align-items:start}.trk-sc-preview-column{min-width:0}.trk-sc-stage{position:relative;min-width:0;overflow:hidden;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-map-background)}.trk-sc-placeholder{display:grid;place-items:center;padding:30px;min-height:340px;text-align:center;color:var(--trk-muted)}.trk-sc-controls{margin:14px 0}.trk-sc-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.trk-sc-progress{display:flex;flex-direction:column;gap:6px;margin:12px 0}.trk-sc-progress input{width:100%;min-height:44px;accent-color:var(--trk-accent)}.trk-sc-controls output{display:block;color:var(--trk-muted);font-size:.93em}.trk-sc-parameters{background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:16px;min-width:0}.trk-sc-parameters fieldset{border:0;padding:0;margin:14px 0;min-width:0}.trk-sc-parameters label{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0 0 12px}.trk-sc-parameters input,.trk-sc-parameters select,.trk-sc-parameters textarea{width:100%;min-height:44px;min-width:0;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);color:var(--trk-text);background:var(--trk-bg);font:inherit;padding:8px 10px}.trk-sc-parameters textarea{min-height:90px;resize:vertical}.trk-sc-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.trk-sc-description{margin:20px 0;padding:15px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface)}.trk-sc-description ul,.trk-sc-description ol{padding-left:22px;overflow-wrap:anywhere}.trk-sc-notice{padding:12px 14px;border:1px solid var(--trk-notice-border);border-radius:var(--trk-radius-sm);background:var(--trk-notice-bg);color:var(--trk-notice);margin:12px 0;overflow-wrap:anywhere}.trk-sc-video{margin:20px 0;padding:16px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md)}.trk-sc-video video{display:block;width:100%;max-height:520px;background:#111;border-radius:var(--trk-radius-sm)}.trk-sc-video a{display:inline-flex;align-items:center;text-decoration:none}.trk-sc-footer{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;padding:18px 0;border-top:1px solid var(--trk-border);margin-top:18px}.trk-sc-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}@container(max-width:880px){.trk-sc-workspace{grid-template-columns:minmax(0,1fr)}.trk-sc-case-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@container(max-width:480px){.trk-sc-case-grid{grid-template-columns:minmax(0,1fr)}.trk-sc-fields{grid-template-columns:minmax(0,1fr)}}@media(max-width:680px){.trk-sc-workspace{grid-template-columns:minmax(0,1fr)}.trk-sc-case-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:420px){.trk-sc-case-grid{grid-template-columns:minmax(0,1fr)}}
`








