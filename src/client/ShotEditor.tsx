import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { groupHidden, placemarkListItems } from '../track/placemark-groups.ts'
import { sanitizeLighting, sanitizeSandboxColors, type MapSettings, type SandboxLighting } from '../track/map-settings.ts'
import { createShotEditorPlan, evaluateShotEditorFrame, parseShotEditorPlan, shotEditorTrackFingerprint, type ShotEditorPlan } from '../track/shot-editor.ts'
import type { SandboxCameraState } from '../track/sandbox/types.ts'
import { useTrackPlacemarks } from './useTrackPlacemarks.ts'
import { useMapSettings, BasemapControls } from './map-settings.tsx'
import { ShotEditorScene, type ShotEditorSceneHandle } from './ShotEditorScene.tsx'
import { clipboardSafeName, download } from './util.ts'

type Props = {track:TrackRecord;basemap:BasemapId;onBasemap:(id:BasemapId)=>void;onCancel:()=>void;onCases:()=>void}
type Appearance = Pick<MapSettings,'lighting'|'sandboxColors'|'sandboxBackground'>
type Saved = {schema:'cqai-track-shot-editor@1';plan:ShotEditorPlan;appearance:Appearance}
type Capture = {recorder:MediaRecorder;stream:MediaStream;chunks:Blob[];mime:string;plan:ShotEditorPlan;appearance:Appearance;discard:boolean;requestFrame:(()=>void)|null;timer:ReturnType<typeof setTimeout>|null}
type Recorded = {url:string;filename:string;saved:Saved}
const message = (reason:unknown) => reason instanceof Error ? reason.message : String(reason)
const clamp = (value:number,min:number,max:number) => Math.max(min,Math.min(max,value))
const rounded = (value:number) => Math.round(value*100)/100
const uid = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
const envelope = (plan:ShotEditorPlan,appearance:Appearance):Saved => ({schema:'cqai-track-shot-editor@1',plan,appearance})

/** Independent executable camera draft; route/source state and formal scripts are never written here. */
export function ShotEditor(props:Props) {return <EditorWorkspace key={props.track.id} {...props}/>}
function EditorWorkspace({track,basemap,onBasemap,onCancel,onCases}:Props) {
  const placemarks = useTrackPlacemarks(track)
  const {settings:preferences} = useMapSettings()
  const [appearance,setAppearance] = useState<Appearance>(()=>({lighting:{...preferences.lighting},sandboxColors:{...preferences.sandboxColors},sandboxBackground:preferences.sandboxBackground}))
  const [plan,setPlan] = useState<ShotEditorPlan|null>(null), [time,setTime] = useState(0)
  const [playing,setPlaying] = useState(false), [recording,setRecording] = useState(false)
  const [scene,setScene] = useState<ShotEditorSceneHandle|null>(null), [status,setStatus] = useState('正在读取轨迹与点位…')
  const [error,setError] = useState(''), [notice,setNotice] = useState(''), [saveStatus,setSaveStatus] = useState('尚未保存')
  const [selected,setSelected] = useState(''), [labelSource,setLabelSource] = useState('')
  const [past,setPast] = useState<ShotEditorPlan[]>([]), [video,setVideo] = useState<Recorded|null>(null)
  const latest = useRef(plan), currentScene = useRef(scene), currentAppearance = useRef(appearance)
  latest.current=plan;currentScene.current=scene;currentAppearance.current=appearance
  const alive = useRef(true), frame = useRef<number|null>(null), capture = useRef<Capture|null>(null)
  const initialized = useRef(false), pending = useRef<unknown>(null), persist = useRef(false), importRequest = useRef(0), videoURL = useRef<string|null>(null)
  const key = `cqai-track.shot-editor.${track.id}`
  const sceneTrack = useMemo(()=>placemarks.routeContext ? {...track,segmentStarts:placemarks.routeContext.segmentStarts} : track,[track,placemarks.routeContext])
  const ready = placemarks.editReady && !placemarks.loading && !placemarks.error && !placemarks.stateError && Array.isArray(sceneTrack.segmentStarts)
  const fingerprint = useMemo(()=>shotEditorTrackFingerprint(sceneTrack.coordinates,sceneTrack.segmentStarts || [0]),[sceneTrack.coordinates,sceneTrack.segmentStarts])
  const settings = useMemo(()=>({...preferences,...appearance,basemap,routeColor:plan?.routeColor || preferences.routeColor}),[preferences,appearance,basemap,plan?.routeColor])
  const candidates = useMemo(()=>placemarkListItems(placemarks.points,placemarks.groups).flatMap(item=>{
    if(item.kind==='group')return groupHidden(item.group,placemarks.points)?[]:[{sourceId:`group:${item.group.id}`,name:item.group.name,coordinates:item.group.coordinates}]
    return item.point.hidden||!item.point.name?[]:[{sourceId:item.point.id,name:item.point.name,coordinates:item.point.coordinates}]
  }),[placemarks.points,placemarks.groups])
  const evaluated = useMemo(()=>plan?evaluateShotEditorFrame(plan,time):null,[plan,time])
  const active = plan?.cameraKeyframes.find(item=>item.id===selected) || plan?.cameraKeyframes[0]
  const locked = playing || recording
  const validScene = !!scene && !!plan && plan.fingerprint===fingerprint && plan.sceneFingerprint===scene.sceneFingerprint
  const mime = useMemo(()=>typeof MediaRecorder==='undefined'?'':['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].find(type=>MediaRecorder.isTypeSupported(type)) || '',[])

  function save(value:ShotEditorPlan,look:Appearance=currentAppearance.current) {
    try{localStorage.setItem(key,JSON.stringify(envelope(value,look)));setSaveStatus('已保存在此浏览器')}
    catch{setSaveStatus('浏览器存储不可用，请导出 JSON 备份')}
  }
  useEffect(()=>{
    try {
      const text=localStorage.getItem(key)
      if(text){
        const saved=JSON.parse(text) as Partial<Saved>
        pending.current=saved.plan
        if(saved.appearance)setAppearance({lighting:sanitizeLighting(saved.appearance.lighting),sandboxColors:sanitizeSandboxColors(saved.appearance.sandboxColors),sandboxBackground:saved.appearance.sandboxBackground==='environment'?'environment':'solid'})
      }
    }catch{setNotice('原草稿格式无效，已保留缓存；编辑或手动保存后会建立新草稿。')}
  },[key])
  useEffect(()=>{if(plan&&persist.current)save(plan,appearance)},[plan,appearance])

  const stopFrames = useCallback(()=>{
    if(frame.current!==null)cancelAnimationFrame(frame.current)
    frame.current=null
  },[])
  const cancelCapture = useCallback((reason='')=>{
    stopFrames()
    const session=capture.current;capture.current=null
    if(session){
      session.discard=true
      if(session.timer!==null)clearTimeout(session.timer)
      session.recorder.ondataavailable=null;session.recorder.onstop=null;session.recorder.onerror=null
      try{if(session.recorder.state!=='inactive')session.recorder.stop()}catch{/* release even after recorder failure */}
      session.stream.getTracks().forEach(item=>item.stop())
    }
    if(alive.current){setPlaying(false);setRecording(false);if(reason)setError(reason)}
  },[stopFrames])
  useEffect(()=>{
    alive.current=true
    return()=>{alive.current=false;cancelCapture();if(videoURL.current)URL.revokeObjectURL(videoURL.current)}
  },[cancelCapture,stopFrames])
  const sceneReady = useCallback((handle:ShotEditorSceneHandle|null)=>{
    currentScene.current=handle;setScene(handle)
    if(!handle){importRequest.current++;stopFrames();setPlaying(false);if(capture.current)cancelCapture('三维场景已改变，本次录制已取消。');return}
    setError('');setStatus('三维场景已就绪')
  },[cancelCapture,stopFrames])
  useEffect(()=>{
    if(!scene||!ready)return
    if(initialized.current){
      if(latest.current?.sceneFingerprint!==scene.sceneFingerprint)setNotice('底图或地形设置已变化。点击“重新建立镜头”使用此场景，原草稿保留。')
      return
    }
    initialized.current=true
    const saved=parseShotEditorPlan(pending.current,track.id)
    const camera=scene.getCameraState()
    if(!camera){setError('无法读取三维相机');return}
    let initial=createShotEditorPlan({trackId:track.id,fingerprint,sceneFingerprint:scene.sceneFingerprint,title:track.name,camera})
    initial={...initial,routeColor:preferences.routeColor,labels:candidates.filter(item=>item.sourceId.startsWith('group:')).slice(0,3).map((item,index)=>({...item,id:uid(),from:rounded(index*initial.duration/5),to:initial.duration}))}
    if(saved&&saved.fingerprint===fingerprint&&saved.sceneFingerprint===scene.sceneFingerprint){
      initial=saved;persist.current=false;setSaveStatus('已恢复此浏览器的镜头草稿');setNotice('')
    }else if(pending.current)setNotice('原草稿与当前轨迹或三维场景不一致，已保留缓存；编辑或手动保存后会建立新草稿。')
    latest.current=initial;setPlan(initial);setSelected(initial.cameraKeyframes[0]?.id || '')
  },[scene,ready,fingerprint,track.id,track.name,candidates,preferences.routeColor])

  useEffect(()=>{
    if(!playing||!validScene||!plan||!scene)return
    const session=capture.current, frozen=session?.plan || plan
    const started=performance.now(), startTime=session?0:time
    let lastDraw=-Infinity
    const tick=(now:number)=>{
      if(!alive.current)return
      const next=Math.min(frozen.duration,startTime+(now-started)/1000)
      if(now-lastDraw>=1000/30||next>=frozen.duration){
        lastDraw=now
        try{scene.renderAt(frozen,next);session?.requestFrame?.()}catch(reason){cancelCapture(`画面渲染失败：${message(reason)}`);return}
        setTime(next)
      }
      if(next>=frozen.duration){
        frame.current=null;setPlaying(false)
        if(session&&capture.current===session){
          session.timer=setTimeout(()=>{
            if(capture.current!==session)return
            try{session.requestFrame?.();session.recorder.stop()}catch(reason){cancelCapture(message(reason))}
          },150)
        }
        return
      }
      frame.current=requestAnimationFrame(tick)
    }
    frame.current=requestAnimationFrame(tick)
    return stopFrames
  },[playing,validScene,scene,cancelCapture,stopFrames])

  function pause(){stopFrames();setPlaying(false)}
  function seek(value:number){if(recording||!plan)return;pause();setTime(clamp(value,0,plan.duration));scene?.renderAt(plan,clamp(value,0,plan.duration))}
  function change(next:ShotEditorPlan){
    if(recording||capture.current||!alive.current)return
    const valid=parseShotEditorPlan(next,track.id)
    if(!valid){setError('参数无效：时间必须在镜头内，关键帧不能重叠。');return}
    pause();setError('');persist.current=true
    if(latest.current)setPast(items=>[...items,latest.current!].slice(-30))
    latest.current=valid;setPlan(valid);setTime(value=>Math.min(value,valid.duration))
  }
  function captureView(){
    const camera=scene?.getCameraState()
    if(!camera||!plan||!validScene)return
    const found=plan.cameraKeyframes.find(item=>Math.abs(item.time-time)<.02)
    const entry={id:found?.id || uid(),time:rounded(time),camera,easing:found?.easing || 'smooth' as const}
    change({...plan,cameraKeyframes:[...plan.cameraKeyframes.filter(item=>item.id!==found?.id),entry].sort((a,b)=>a.time-b.time)});setSelected(entry.id)
  }
  function cameraPatch(camera:SandboxCameraState){if(active&&plan)change({...plan,cameraKeyframes:plan.cameraKeyframes.map(item=>item.id===active.id?{...item,camera}:item)})}
  function duration(value:number){
    if(!plan||!Number.isFinite(value))return
    const next=clamp(value,3,120), scale=next/plan.duration
    change({...plan,duration:next,cameraKeyframes:plan.cameraKeyframes.map(item=>({...item,time:rounded(item.time*scale)})),routeKeyframes:plan.routeKeyframes.map(item=>({...item,time:rounded(item.time*scale)})),labels:plan.labels.map(item=>({...item,from:rounded(item.from*scale),to:rounded(item.to*scale)})),caption:{...plan.caption,from:rounded(plan.caption.from*scale),to:rounded(plan.caption.to*scale)}})
  }
  function reset(){
    const camera=scene?.getCameraState()
    if(!camera||!scene)return
    change({...createShotEditorPlan({trackId:track.id,fingerprint,sceneFingerprint:scene.sceneFingerprint,title:track.name,camera}),routeColor:settings.routeColor})
    setTime(0);setNotice('已按当前场景建立新镜头。')
  }
  function addLabel(){
    if(!plan)return
    const item=candidates.find(item=>item.sourceId===(labelSource||candidates.find(candidate=>!plan.labels.some(label=>label.sourceId===candidate.sourceId))?.sourceId))
    if(item&&!plan.labels.some(label=>label.sourceId===item.sourceId)){change({...plan,labels:[...plan.labels,{...item,id:uid(),from:rounded(time),to:plan.duration}]});setLabelSource('')}
  }
  function patchLabel(id:string,patch:Partial<ShotEditorPlan['labels'][number]>){if(plan)change({...plan,labels:plan.labels.map(item=>item.id===id?{...item,...patch}:item)})}
  function appearancePatch(patch:Partial<Appearance>){if(capture.current||!alive.current)return;pause();persist.current=true;setAppearance(value=>({...value,...patch}))}
  function lightingPatch(patch:Partial<SandboxLighting>){appearancePatch({lighting:sanitizeLighting({...appearance.lighting,...patch})})}
  function exportPlan(saved:Saved|undefined=plan?envelope(plan,appearance):undefined){if(saved)download(`${clipboardSafeName(track.name)}-三维镜头.json`,JSON.stringify(saved,null,2))}
  async function importPlan(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];event.target.value=''
    if(!file||!scene)return
    if(file.size>2_000_000){setError('镜头配置不能超过 2 MB');return}
    try{
      const request=++importRequest.current, expectedPlan=latest.current, expectedScene=scene
      const contents=await file.text()
      if(!alive.current||request!==importRequest.current)return
      if(capture.current||currentScene.current!==expectedScene||latest.current!==expectedPlan){setError('读取文件期间镜头或场景已变化，导入已取消，请重试。');return}
      const raw=JSON.parse(contents) as Partial<Saved>
      const next=parseShotEditorPlan(raw.plan,track.id)
      if(!next||next.fingerprint!==fingerprint||next.sceneFingerprint!==scene.sceneFingerprint)throw new Error('配置与当前轨迹或三维场景不一致，请使用相同轨迹、底图和地形设置。')
      change(next);setSelected(next.cameraKeyframes[0]?.id || '');setTime(0)
      if(raw.appearance)appearancePatch({lighting:sanitizeLighting(raw.appearance.lighting),sandboxColors:sanitizeSandboxColors(raw.appearance.sandboxColors),sandboxBackground:raw.appearance.sandboxBackground==='environment'?'environment':'solid'})
      setNotice('已导入镜头配置')
    }catch(reason){setError(message(reason))}
  }
  function record(){
    if(!validScene||!plan||!scene||!mime||capture.current||recording)return
    importRequest.current++
    pause();setError('')
    let stream:MediaStream|null=null
    try{
      const frozen=structuredClone(plan), look=structuredClone(appearance)
      scene.renderAt(frozen,0)
      const canvas=scene.getCaptureCanvas()
      if(!canvas?.captureStream)throw new Error('当前浏览器不支持画布录制')
      stream=canvas.captureStream(30)
      const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6_000_000})
      const session:Capture={recorder,stream,chunks:[],mime,plan:frozen,appearance:look,discard:false,requestFrame:null,timer:null}
      capture.current=session
      recorder.ondataavailable=event=>{if(event.data.size&&!session.discard)session.chunks.push(event.data)}
      recorder.onerror=()=>cancelCapture('浏览器录制失败，请重试')
      recorder.onstop=()=>{
        session.stream.getTracks().forEach(item=>item.stop())
        if(session.timer!==null)clearTimeout(session.timer)
        if(session.discard||!alive.current||capture.current!==session)return
        capture.current=null;setRecording(false);setPlaying(false)
        const blob=new Blob(session.chunks,{type:session.mime})
        if(!blob.size){setError('未生成视频内容，请重试');return}
        if(videoURL.current)URL.revokeObjectURL(videoURL.current)
        const url=URL.createObjectURL(blob);videoURL.current=url
        setVideo({url,filename:`${clipboardSafeName(track.name)}-三维镜头.webm`,saved:envelope(session.plan,session.appearance)})
      }
      recorder.start(250);setTime(0);setRecording(true);setPlaying(true)
    }catch(reason){stream?.getTracks().forEach(item=>item.stop());capture.current=null;setError(message(reason))}
  }

  return <section className="trk-shot-editor" aria-label="三维镜头编辑器"><style>{EDITOR_CSS}</style>
    <header className="trk-se-header"><div><h2>三维镜头编辑器</h2><p className="trk-muted">拖动三维画面构图，保存视角，再安排镜头与路线的时间。</p></div><div className="trk-se-actions"><button className="trk-secondary" disabled={recording} onClick={()=>{pause();onCases()}}>返回镜头案例</button><button className="trk-secondary" disabled={recording} onClick={()=>{pause();onCancel()}}>返回轨迹</button></div></header>
    {notice&&<p role="status" className="trk-se-notice">{notice}</p>}
    {(error||placemarks.error||placemarks.stateError)&&<p role="alert" className="trk-se-error">{error||placemarks.error||placemarks.stateError}</p>}
    <div className="trk-se-layout"><div className="trk-se-main">
      <div className="trk-se-stage">{ready?<ShotEditorScene track={sceneTrack} settings={settings} plan={validScene?plan:null} time={time} locked={locked} onReady={sceneReady} onStatus={setStatus} onError={setError}/>:<div className="trk-se-loading">正在读取轨迹与分段信息…</div>}</div>
      <p className="trk-muted" role="status" data-testid="shot-editor-status">{status} · 拖动旋转，滚轮缩放，右键拖动平移。视角修改后点击“保存当前视角”。</p>
      <div className="trk-se-actions"><button className="trk-primary" disabled={!validScene||recording} onClick={()=>{if(playing){pause();return}if(plan&&time>=plan.duration)setTime(0);setPlaying(true)}}>{playing?'暂停预览':'播放镜头'}</button><button className="trk-secondary" disabled={!validScene||locked} onClick={captureView}>保存当前视角</button><button className="trk-secondary" disabled={!scene||locked} onClick={()=>scene?.resetView()}>重置构图</button></div>
      <label className="trk-se-scrub">镜头时间轴<input aria-label="镜头时间轴" type="range" min={0} max={plan?.duration||20} step={.01} value={time} disabled={!validScene||recording} onChange={event=>seek(Number(event.target.value))}/></label>
      <div className="trk-se-time"><label>当前时间（秒）<input aria-label="当前时间" type="number" min={0} max={plan?.duration||20} step={.1} value={rounded(time)} disabled={!validScene||recording} onChange={event=>seek(Number(event.target.value))}/></label><output aria-label="镜头播放状态">{rounded(time)} / {plan?.duration||20} 秒 · {recording?'正在录制':playing?'正在播放':'已暂停'} · 路线 {Math.round((evaluated?.routeProgress||0)*100)}%</output></div>
      <section className="trk-se-block" aria-label="相机关键帧"><h3>相机关键帧</h3><p className="trk-muted">点击时间点查看构图。时间输入支持精确调整，缓动控制这一帧到下一帧的运动。</p>
        <div className="trk-se-ticks">{plan?.cameraKeyframes.map(item=><button className="trk-secondary" key={item.id} disabled={locked||!validScene} aria-pressed={active?.id===item.id} onClick={()=>{setSelected(item.id);seek(item.time)}}>{rounded(item.time)} 秒</button>)}</div>
        {active&&plan&&<fieldset disabled={locked||!validScene}><legend>选中关键帧</legend><div className="trk-se-fields">
          <label>时间（秒）<input aria-label="关键帧时间" type="number" min={0} max={plan.duration} step={.1} value={active.time} onChange={event=>change({...plan,cameraKeyframes:plan.cameraKeyframes.map(item=>item.id===active.id?{...item,time:Number(event.target.value)}:item).sort((a,b)=>a.time-b.time)})}/></label>
          <label>缓动<select aria-label="关键帧缓动" value={active.easing} onChange={event=>change({...plan,cameraKeyframes:plan.cameraKeyframes.map(item=>item.id===active.id?{...item,easing:event.target.value as 'linear'|'smooth'}:item)})}><option value="smooth">平滑</option><option value="linear">匀速</option></select></label>
          <label>视野角度（度）<input aria-label="相机视野角度" type="number" min={20} max={85} step={1} value={rounded(active.camera.fov)} onChange={event=>cameraPatch({...active.camera,fov:Number(event.target.value)})}/></label>
          <label>绕山方向（度）<input aria-label="相机方向" type="number" min={-360} max={360} step={5} value={rounded(cameraAngles(active.camera).azimuth)} onChange={event=>cameraPatch(cameraOrbit(active.camera,{azimuth:Number(event.target.value)}))}/></label>
          <label>俯仰（度）<input aria-label="相机俯仰" type="number" min={5} max={85} step={5} value={rounded(cameraAngles(active.camera).elevation)} onChange={event=>cameraPatch(cameraOrbit(active.camera,{elevation:clamp(Number(event.target.value),5,85)}))}/></label>
          <label>距离（米）<input aria-label="相机距离" type="number" min={1} max={1_000_000} step={100} value={rounded(cameraAngles(active.camera).distance)} onChange={event=>cameraPatch(cameraOrbit(active.camera,{distance:clamp(Number(event.target.value),1,1_000_000)}))}/></label>
        </div><button className="trk-secondary" disabled={plan.cameraKeyframes.length<=1} onClick={()=>change({...plan,cameraKeyframes:plan.cameraKeyframes.filter(item=>item.id!==active.id)})}>删除此关键帧</button></fieldset>}
      </section>
      <section className="trk-se-block" aria-label="路线关键帧"><h3>路线显现时间</h3><p className="trk-muted">路线进度独立于相机，保留原轨迹分段。</p><fieldset disabled={locked||!validScene}>{plan?.routeKeyframes.map((item,index)=><div className="trk-se-route-row" key={item.id}><label>时间（秒）<input aria-label={`路线关键帧 ${index+1} 时间`} type="number" min={0} max={plan.duration} step={.1} value={item.time} onChange={event=>change({...plan,routeKeyframes:plan.routeKeyframes.map(entry=>entry.id===item.id?{...entry,time:Number(event.target.value)}:entry).sort((a,b)=>a.time-b.time)})}/></label><label>路线（%）<input aria-label={`路线关键帧 ${index+1} 进度`} type="number" min={0} max={100} step={1} value={Math.round(item.progress*100)} onChange={event=>change({...plan,routeKeyframes:plan.routeKeyframes.map(entry=>entry.id===item.id?{...entry,progress:Number(event.target.value)/100}:entry)})}/></label><button className="trk-secondary" aria-label={`删除路线关键帧 ${index+1}`} disabled={plan.routeKeyframes.length<=1} onClick={()=>change({...plan,routeKeyframes:plan.routeKeyframes.filter(entry=>entry.id!==item.id)})}>删除</button></div>)}
        <button className="trk-secondary" disabled={!plan||!!plan.routeKeyframes.some(item=>Math.abs(item.time-time)<.02)} onClick={()=>{if(plan)change({...plan,routeKeyframes:[...plan.routeKeyframes,{id:uid(),time:rounded(time),progress:evaluated?.routeProgress||0}].sort((a,b)=>a.time-b.time)})}}>在当前时间添加路线关键帧</button></fieldset></section>
    </div><aside className="trk-se-sidebar" aria-label="镜头参数"><fieldset disabled={locked||!validScene}><legend>画面与节奏</legend>
      <label>画面标题<input aria-label="画面标题" maxLength={120} value={plan?.title||''} onChange={event=>{if(plan)change({...plan,title:event.target.value})}}/></label>
      <div className="trk-se-fields"><label>总时长（秒）<input aria-label="镜头总时长" type="number" min={3} max={120} value={plan?.duration||20} onChange={event=>duration(Number(event.target.value))}/></label><label>路线颜色<input aria-label="路线颜色" type="color" value={plan?.routeColor||settings.routeColor} onChange={event=>{if(plan)change({...plan,routeColor:event.target.value})}}/></label></div><p className="trk-muted">调整时长会同比缩放各元素的时间。</p>
      <label>字幕<textarea aria-label="镜头字幕" maxLength={600} value={plan?.caption.text||''} placeholder="输入这段镜头要说的话" onChange={event=>{if(plan)change({...plan,caption:{...plan.caption,text:event.target.value}})}}/></label>
      <div className="trk-se-fields"><label>字幕出现（秒）<input aria-label="字幕出现时间" type="number" min={0} max={plan?.duration||20} step={.1} value={plan?.caption.from||0} onChange={event=>{if(plan)change({...plan,caption:{...plan.caption,from:Number(event.target.value)}})}}/></label><label>字幕结束（秒）<input aria-label="字幕结束时间" type="number" min={0} max={plan?.duration||20} step={.1} value={plan?.caption.to||0} onChange={event=>{if(plan)change({...plan,caption:{...plan.caption,to:Number(event.target.value)}})}}/></label></div>
    </fieldset>
    <fieldset disabled={locked||!validScene}><legend>地名标注</legend><div className="trk-se-actions"><select aria-label="添加地名" value={labelSource||candidates.find(item=>!plan?.labels.some(label=>label.sourceId===item.sourceId))?.sourceId||''} onChange={event=>setLabelSource(event.target.value)}>{candidates.filter(item=>!plan?.labels.some(label=>label.sourceId===item.sourceId)).map(item=><option key={item.sourceId} value={item.sourceId}>{item.name}</option>)}</select><button className="trk-secondary" disabled={!candidates.some(item=>!plan?.labels.some(label=>label.sourceId===item.sourceId))} onClick={addLabel}>添加</button></div>
      {plan?.labels.map(item=><article className="trk-se-label" key={item.id}><label>显示名称<input aria-label={`地名 ${item.sourceId}`} maxLength={80} value={item.name} onChange={event=>patchLabel(item.id,{name:event.target.value})}/></label><div className="trk-se-fields"><label>出现（秒）<input aria-label={`${item.name} 出现时间`} type="number" min={0} max={plan.duration} step={.1} value={item.from} onChange={event=>patchLabel(item.id,{from:Number(event.target.value)})}/></label><label>结束（秒）<input aria-label={`${item.name} 结束时间`} type="number" min={0} max={plan.duration} step={.1} value={item.to} onChange={event=>patchLabel(item.id,{to:Number(event.target.value)})}/></label></div><button className="trk-secondary" onClick={()=>change({...plan,labels:plan.labels.filter(label=>label.id!==item.id)})}>移除此地名</button></article>)}
    </fieldset>
    <fieldset disabled={locked||!scene}><legend>场景光照</legend><label>背景<select aria-label="场景背景" value={appearance.sandboxBackground} onChange={event=>appearancePatch({sandboxBackground:event.target.value as Appearance['sandboxBackground']})}><option value="solid">纯色</option><option value="environment">环境天空</option></select></label><label>背景颜色<input aria-label="场景背景颜色" type="color" value={appearance.sandboxColors.background} onChange={event=>appearancePatch({sandboxColors:{...appearance.sandboxColors,background:event.target.value}})}/></label>
      <div className="trk-se-fields"><label>太阳方向（度）<input aria-label="太阳方向" type="number" min={0} max={360} step={5} value={appearance.lighting.azimuth} onChange={event=>lightingPatch({azimuth:Number(event.target.value)})}/></label><label>太阳高度（度）<input aria-label="太阳高度" type="number" min={5} max={85} step={5} value={appearance.lighting.elevation} onChange={event=>lightingPatch({elevation:Number(event.target.value)})}/></label><label>太阳亮度<input aria-label="太阳亮度" type="number" min={0} max={5} step={.1} value={appearance.lighting.intensity} onChange={event=>lightingPatch({intensity:Number(event.target.value)})}/></label><label>环境亮度<input aria-label="环境亮度" type="number" min={0} max={2} step={.1} value={appearance.lighting.ambient} onChange={event=>lightingPatch({ambient:Number(event.target.value)})}/></label></div>
    </fieldset><BasemapControls className="trk-se-basemaps" basemap={basemap} onBasemap={value=>{pause();onBasemap(value)}} disabled={locked}/><p className="trk-muted">更换底图会重新加载场景，之后可重新建立镜头。</p>
    </aside></div>
    <footer className="trk-se-footer"><div className="trk-se-actions"><button className="trk-secondary" disabled={!plan||locked} onClick={()=>{if(plan){persist.current=true;save(plan)}}}>保存草稿</button><button className="trk-secondary" disabled={!plan||locked} onClick={()=>exportPlan()}>导出镜头 JSON</button><label className="trk-secondary trk-se-import">导入镜头 JSON<input aria-label="导入镜头 JSON" type="file" accept=".json,application/json" disabled={!scene||locked} onChange={event=>void importPlan(event)}/></label><button className="trk-secondary" disabled={!past.length||locked} onClick={()=>{const next=past.at(-1);if(next){pause();latest.current=next;setPlan(next);setPast(items=>items.slice(0,-1));setTime(value=>Math.min(value,next.duration))}}}>撤销镜头修改</button><button className="trk-secondary" disabled={!scene||locked} onClick={reset}>重新建立镜头</button>{recording?<button className="trk-secondary" onClick={()=>cancelCapture('已取消录制，镜头草稿保留。')}>取消录制</button>:<button className="trk-primary" disabled={!validScene||!mime||playing} onClick={record}>录制镜头 WebM</button>}</div><p className="trk-muted" aria-label="镜头草稿保存状态">{saveStatus} · 录制为 1280 × 720 WebM，目标 30 fps，实际帧率随设备负载变化，当前版本为无声地图镜头。</p></footer>
    {!mime&&<p role="status">当前浏览器不支持 WebM 录制，仍可编辑和导出镜头配置。</p>}
    {video&&<article className="trk-se-block" aria-label="录制镜头结果"><h3>录制结果 · {video.saved.plan.duration} 秒</h3><video aria-label="三维镜头录制视频" controls preload="metadata" src={video.url}/><div className="trk-se-actions"><a className="trk-primary" href={video.url} download={video.filename}>下载镜头 WebM</a><button className="trk-secondary" onClick={()=>exportPlan(video.saved)}>导出本次录制参数</button></div></article>}
  </section>
}
function cameraAngles(camera:SandboxCameraState){
  const delta=camera.position.map((value,index)=>value-camera.target[index])
  return {distance:Math.hypot(...delta),azimuth:Math.atan2(delta[0],delta[2])*180/Math.PI,elevation:Math.atan2(delta[1],Math.hypot(delta[0],delta[2]))*180/Math.PI}
}
function cameraOrbit(camera:SandboxCameraState,patch:Partial<ReturnType<typeof cameraAngles>>):SandboxCameraState{
  const values={...cameraAngles(camera),...patch}, azimuth=values.azimuth*Math.PI/180, elevation=values.elevation*Math.PI/180
  return {...camera,position:[camera.target[0]+values.distance*Math.cos(elevation)*Math.sin(azimuth),camera.target[1]+values.distance*Math.sin(elevation),camera.target[2]+values.distance*Math.cos(elevation)*Math.cos(azimuth)]}
}
const EDITOR_CSS = `
.trk-shot-editor{container-type:inline-size;color:var(--trk-text);font:inherit;max-width:1600px;margin:auto}.trk-se-header,.trk-se-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:16px 0}.trk-se-header h2{margin:0}.trk-se-header p{margin:8px 0}.trk-se-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(285px,32%);gap:20px;align-items:start}.trk-se-main{min-width:0}.trk-se-stage{aspect-ratio:16/9;overflow:hidden;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface)}.trk-se-loading{height:100%;display:grid;place-items:center;color:var(--trk-muted)}.trk-se-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.trk-shot-editor button,.trk-se-import,.trk-shot-editor a{min-height:44px;font:inherit;border-radius:var(--trk-radius-sm);padding:8px 12px}.trk-shot-editor button:disabled{opacity:.5;cursor:not-allowed}.trk-shot-editor button[aria-pressed=true]{outline:2px solid var(--trk-accent);outline-offset:-2px}.trk-shot-editor label{display:flex;flex-direction:column;gap:5px;min-width:0}.trk-shot-editor input,.trk-shot-editor select,.trk-shot-editor textarea{min-width:0;max-width:100%;width:100%;min-height:44px;padding:8px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:var(--trk-text);font:inherit;box-sizing:border-box}.trk-shot-editor input[type=color]{padding:5px}.trk-shot-editor input[type=range]{padding:0;border:0;accent-color:var(--trk-accent)}.trk-shot-editor textarea{min-height:88px;resize:vertical}.trk-shot-editor fieldset{border:0;margin:12px 0;padding:0;min-width:0}.trk-shot-editor legend{font-weight:600;padding:0;margin-bottom:12px}.trk-se-sidebar{min-width:0;border:1px solid var(--trk-border);background:var(--trk-surface);padding:16px;border-radius:var(--trk-radius-md)}.trk-se-sidebar label{margin-bottom:12px}.trk-se-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.trk-se-block{padding:16px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-surface);margin:18px 0}.trk-se-block h3{margin:0 0 12px}.trk-se-ticks{display:flex;flex-wrap:wrap;gap:8px}.trk-se-ticks button{min-width:70px}.trk-se-scrub{margin:14px 0}.trk-se-time{display:flex;gap:16px;align-items:end;flex-wrap:wrap}.trk-se-time label{width:140px}.trk-se-time output{padding-bottom:12px;color:var(--trk-muted)}.trk-se-route-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:12px;align-items:end;margin-bottom:12px}.trk-se-label{border-bottom:1px solid var(--trk-border);padding:12px 0}.trk-se-notice{background:var(--trk-notice-bg);color:var(--trk-notice);border:1px solid var(--trk-notice-border);padding:12px;border-radius:var(--trk-radius-sm);overflow-wrap:anywhere}.trk-se-error{background:var(--trk-surface);color:var(--trk-danger);padding:12px;border:1px solid var(--trk-danger);border-radius:var(--trk-radius-sm)}.trk-se-footer{border-top:1px solid var(--trk-border)}.trk-se-footer p{width:100%}.trk-se-import{cursor:pointer;position:relative}.trk-se-import input{position:absolute;inset:0;opacity:0;cursor:pointer}.trk-se-import:focus-within{outline:2px solid var(--trk-focus)}.trk-se-import:has(input:disabled){opacity:.5;cursor:not-allowed}.trk-se-block video{display:block;width:100%;max-height:600px;background:#111;margin:12px 0}.trk-shot-editor .trk-muted{font-size:.92em;line-height:1.6;overflow-wrap:anywhere}@container(max-width:880px){.trk-se-layout{grid-template-columns:minmax(0,1fr)}}@container(max-width:420px){.trk-se-fields{grid-template-columns:minmax(0,1fr)}.trk-se-sidebar{padding:12px}.trk-se-route-row{gap:8px}}@media(max-width:700px){.trk-se-layout{grid-template-columns:minmax(0,1fr)}}
`
