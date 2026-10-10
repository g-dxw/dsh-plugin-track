import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { groupHidden, placemarkListItems } from '../track/placemark-groups.ts'
import { sanitizeLighting, type MapSettings, type SandboxLighting } from '../track/map-settings.ts'
import { createShotEditorPlan, evaluateShotEditorFrame, parseShotEditorPlan, shotEditorTrackFingerprint, type ShotEditorPlan } from '../track/shot-editor.ts'
import {parseShotEditorProject,retimeShotEditorKey,resizeShotEditorDuration} from '../track/shot-editor-workspace.ts'
import {SHOT_EDITOR_PROJECT_MAX_BYTES,type ShotEditorProjectEnvelope} from '../track/shot-editor-project-types.ts'
import {ShotProjectBackup,ShotWorkbench,ShotWorkbenchToolbar} from './ShotWorkbench.tsx'
import {GeoMotionTimeline} from './GeoMotionTimeline.tsx'
import {EditorConfirmationDialog,useEditorNavigation,type EditorNavigationHandle} from './editor-navigation.tsx'
import type { SandboxCameraState } from '../track/sandbox/types.ts'
import { useTrackPlacemarks } from './useTrackPlacemarks.ts'
import { useMapSettings, BasemapControls } from './map-settings.tsx'
import { ShotEditorScene, type ShotEditorSceneHandle } from './ShotEditorScene.tsx'
import { api, clipboardSafeName, download } from './util.ts'
import {shotProjectKey, shotScopeQuery, type OpenMontageEditorScope} from '../track/shot-project-scope.ts'
import {assertShotCaptureApproval, freezeShotResult, ShotResultUpload, type ShotResultIdentity, type ShotUploadState} from './shot-result-bridge.tsx'
import type {ShotCaptureStore} from './shot-capture-store.ts'

type Props = {track:TrackRecord;basemap:BasemapId;onBasemap:(id:BasemapId)=>void;onCancel:()=>void;onCases?:()=>void;active?:boolean;onRegister?:(handle:EditorNavigationHandle|null)=>void;scope?:OpenMontageEditorScope;onShotResult?:()=>void;captureStore?:ShotCaptureStore}
type Appearance = Pick<MapSettings,'lighting'|'sandboxColors'|'sandboxBackground'>
type Saved = {schema:'cqai-track-shot-editor@1';plan:ShotEditorPlan;appearance:Appearance}
type Capture = {recorder:MediaRecorder;stream:MediaStream;chunks:Blob[];mime:string;plan:ShotEditorPlan;appearance:Appearance;discard:boolean;requestFrame:(()=>void)|null;timer:ReturnType<typeof setTimeout>|null;identity?:ShotResultIdentity}
type Recorded = {url:string;filename:string;saved:Saved;blob:Blob;identity?:ShotResultIdentity;uploadState?:ShotUploadState}
type PreparingCapture = {scene:ShotEditorSceneHandle;plan:ShotEditorPlan;appearance:Appearance;frame:number|null;started:number;size:string;stable:number;attempts:number;identity?:ShotResultIdentity;authorization:AbortController}
type Reply={project:ShotEditorProjectEnvelope|null}
const pendingSaves=new Map<string,Promise<Reply>>()
const message = (reason:unknown) => reason instanceof Error ? reason.message : String(reason)
const clamp = (value:number,min:number,max:number) => Math.max(min,Math.min(max,value))
const rounded = (value:number) => Math.round(value*100)/100
const uid = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
const envelope = (plan:ShotEditorPlan,appearance:Appearance):Saved => ({schema:'cqai-track-shot-editor@1',plan,appearance})

/** Independent executable camera draft; route/source state and formal scripts are never written here. */
export function ShotEditor(props:Props) {return <EditorWorkspace key={shotProjectKey(props.track.id,props.scope)} {...props}/>}
function EditorWorkspace({track,basemap,onBasemap,onCancel,active:isActive=true,onRegister,scope,onShotResult,captureStore}:Props) {
  const placemarks = useTrackPlacemarks(track,undefined,{preparePhotos:false})
  const {settings:preferences} = useMapSettings()
  const [appearance,setAppearance] = useState<Appearance>(()=>({lighting:{...preferences.lighting},sandboxColors:{...preferences.sandboxColors},sandboxBackground:preferences.sandboxBackground}))
  const [plan,setPlan] = useState<ShotEditorPlan|null>(null), [time,setTime] = useState(0)
  const [playing,setPlaying] = useState(false), [recording,setRecording] = useState(false), [preparing,setPreparing] = useState(false)
  const [scene,setScene] = useState<ShotEditorSceneHandle|null>(null), [status,setStatus] = useState('正在读取轨迹与点位…')
  const [error,setError] = useState(''), [sceneError,setSceneError] = useState(''), [notice,setNotice] = useState(''), [saveStatus,setSaveStatus] = useState('尚未保存')
  const [selected,setSelected] = useState(''), [labelSource,setLabelSource] = useState('')
  const [past,setPast] = useState<Saved[]>([]), [future,setFuture] = useState<Saved[]>([]), [video,setVideo] = useState<Recorded|null>(null)
  const [uploading,setUploading] = useState(false)
  const workspaceKey = shotProjectKey(track.id,scope)
  const latest = useRef(plan), currentScene = useRef(scene), currentAppearance = useRef(appearance)
  latest.current=plan;currentScene.current=scene;currentAppearance.current=appearance
  const alive = useRef(true), frame = useRef<number|null>(null), capture = useRef<Capture|null>(null), preparingCapture=useRef<PreparingCapture|null>(null), currentActive=useRef(isActive)
  currentActive.current=isActive
  const initialized = useRef(false), importRequest = useRef(0), videoURL = useRef<string|null>(null)
  const key = `cqai-track.shot-editor.${track.id}`
  const [loadState,setLoadState]=useState<'loading'|'ready'|'error'>('loading'),[loadAttempt,setLoadAttempt]=useState(0),[saving,setSaving]=useState(false),[savedText,setSavedText]=useState('')
  const [confirmReset,setConfirmReset]=useState(false)
  const [panel,setPanel]=useState<'layers'|'preview'|'properties'>('preview'),[selectedLayer,setSelectedLayer]=useState('camera'),[selectedRoute,setSelectedRoute]=useState('')
  const workspace=useRef<HTMLDivElement>(null),revision=useRef<string|null>(null),savingRef=useRef(false),initialDraft=useRef<Saved|null>(null),confirmed=useRef<Saved|null>(null),rawBackup=useRef<unknown>(null)
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
  const locked = playing || recording || preparing || saving || uploading || confirmReset
  const dirty=!!plan&&JSON.stringify(envelope(plan,appearance))!==savedText
  const validScene = loadState==='ready' && !!scene && !!plan && plan.fingerprint===fingerprint && plan.sceneFingerprint===scene.sceneFingerprint
  const mime = useMemo(()=>typeof MediaRecorder==='undefined'?'':['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].find(type=>MediaRecorder.isTypeSupported(type)) || '',[])

  function restore(value:Saved){latest.current=value.plan;currentAppearance.current=value.appearance;setPlan(value.plan);setAppearance(value.appearance);setSelected(value.plan.cameraKeyframes[0]?.id||'');setSelectedRoute(value.plan.routeKeyframes[0]?.id||'');setTime(0)}
  useEffect(()=>{
    let live=true
    setLoadState('loading');setError('');setSaveStatus('正在读取沙盘工程…')
    const load=async()=>{
      await pendingSaves.get(workspaceKey)?.catch(()=>{})
      const reply=await api<Reply>('shot-editor-project?id='+encodeURIComponent(track.id)+shotScopeQuery(scope))
      if(!live)return
      if(!reply||typeof reply!=='object'||!Object.hasOwn(reply,'project')||reply.project===undefined)throw new Error('服务端未确认沙盘工程读取结果，当前工程未改动')
      let value:Saved|null=null
      if(reply.project){
        rawBackup.current=reply.project;value=parseShotEditorProject(reply.project,track.id)
        if(!value||typeof reply.project.revision!=='string'||!reply.project.revision)throw new Error('已保存的沙盘工程无法识别，原工程已保留，请导出备份')
        revision.current=reply.project.revision;confirmed.current=structuredClone(value);setSavedText(JSON.stringify(value));setSaveStatus('已恢复轨迹工作区的沙盘工程')
      }else{
        let text:string|null=null
        if(!scope)try{text=localStorage.getItem(key)}catch{/* workspace saving does not require browser storage */}
        if(text){
          if(text.length>SHOT_EDITOR_PROJECT_MAX_BYTES){rawBackup.current=text;throw new Error('旧浏览器草稿超过 2 MB，缓存已保留，请导出备份')}
          rawBackup.current=text;const raw:unknown=JSON.parse(text);rawBackup.current=raw;value=parseShotEditorProject(raw,track.id)
          if(!value)throw new Error('旧浏览器草稿无法识别，缓存已保留，请导出备份')
          setSaveStatus('已恢复旧浏览器草稿，请保存到轨迹工作区');setNotice('旧浏览器缓存保持原样；点击保存工程后写入轨迹工作区。')
        }else setSaveStatus('新沙盘工程，尚未保存')
        revision.current=null;confirmed.current=null;setSavedText('')
      }
      initialized.current=!!value
      if(value){restore(value);initialDraft.current=structuredClone(value)}
      setPast([]);setFuture([]);setLoadState('ready')
    }
    void load().catch(reason=>{if(live){setLoadState('error');setError(message(reason));setSaveStatus('读取失败，原工程已保留')}})
    return()=>{live=false}
  },[workspaceKey,loadAttempt])
  async function saveProject():Promise<boolean>{
    if(!latest.current||loadState!=='ready'||savingRef.current||capture.current||preparingCapture.current||uploading)return false
    importRequest.current++
    pause();savingRef.current=true;setSaving(true);setError('');setSaveStatus('正在保存沙盘工程…')
    const snapshot=structuredClone(envelope(latest.current,currentAppearance.current)),expectedRevision=revision.current
    const operation=api<Reply>('shot-editor-project',{id:track.id,project:snapshot,expectedRevision,...(scope?{projectId:scope.projectId,shotId:scope.shotId}:{})});pendingSaves.set(workspaceKey,operation)
    try{
      const result=await operation,value=result.project&&parseShotEditorProject(result.project,track.id)
      if(!result.project||!value||typeof result.project.revision!=='string'||!result.project.revision||result.project.revision===expectedRevision||JSON.stringify(value)!==JSON.stringify(snapshot))throw new Error('服务端未确认当前沙盘工程已保存')
      if(alive.current){revision.current=result.project.revision;confirmed.current=structuredClone(snapshot);initialDraft.current=structuredClone(snapshot);setSavedText(JSON.stringify(snapshot));setSaveStatus('已保存到轨迹工作区');setNotice('')}
      return true
    }catch(reason){if(alive.current){const conflict=reason&&typeof reason==='object'&&'status' in reason&&reason.status===409;setError(conflict?'工程已被其他窗口更新，当前编辑保留。请导出 JSON 备份后重新读取。':message(reason));setSaveStatus('保存失败，当前编辑仍保留')}return false}
    finally{if(pendingSaves.get(workspaceKey)===operation)pendingSaves.delete(workspaceKey);savingRef.current=false;if(alive.current)setSaving(false)}
  }
  function discard(){pause();const value=confirmed.current||initialDraft.current;if(value){restore(structuredClone(value));setSavedText(JSON.stringify(value))}setPast([]);setFuture([]);setError('');setSaveStatus(revision.current?'已恢复已保存工程':'草稿已恢复，尚未保存到轨迹工作区')}
  const navigation=useEditorNavigation({active:isActive,dirty,busy:recording||preparing||saving||uploading||confirmReset,save:saveProject,discard,onRegister})

  const stopFrames = useCallback(()=>{
    if(frame.current!==null)cancelAnimationFrame(frame.current)
    frame.current=null
  },[])
  const cancelCapture = useCallback((reason='')=>{
    stopFrames()
    const preparation=preparingCapture.current;preparingCapture.current=null
    preparation?.authorization.abort()
    if(preparation?.frame!=null)cancelAnimationFrame(preparation.frame)
    const session=capture.current;capture.current=null
    if(session){
      session.discard=true
      if(session.timer!==null)clearTimeout(session.timer)
      session.recorder.ondataavailable=null;session.recorder.onstop=null;session.recorder.onerror=null
      try{if(session.recorder.state!=='inactive')session.recorder.stop()}catch{/* release even after recorder failure */}
      session.stream.getTracks().forEach(item=>item.stop())
    }
    if(alive.current){setPlaying(false);setRecording(false);setPreparing(false);if(reason)setError(reason)}
  },[stopFrames])
  useEffect(()=>{
    alive.current=true
    return()=>{alive.current=false;cancelCapture();if(videoURL.current)URL.revokeObjectURL(videoURL.current)}
  },[cancelCapture,stopFrames])
  useEffect(()=>{
    if(!scope||!captureStore)return
    const retained=captureStore.get(track.id,scope,'sandbox')
    if(!retained?.saved)return
    const url=URL.createObjectURL(retained.blob);videoURL.current=url
    setVideo({...retained,url,saved:retained.saved})
  },[workspaceKey,captureStore])
  const sceneReady = useCallback((handle:ShotEditorSceneHandle|null)=>{
    currentScene.current=handle;setScene(handle)
    if(!handle){importRequest.current++;stopFrames();setPlaying(false);if(capture.current||preparingCapture.current)cancelCapture('三维场景已改变，本次录制已取消。');return}
    if(preparingCapture.current&&preparingCapture.current.scene!==handle)cancelCapture('三维场景已改变，本次录制准备已取消。')
    setSceneError('');setStatus('三维场景已就绪')
  },[cancelCapture,stopFrames])
  useEffect(()=>{
    if(!scene||!ready||loadState!=='ready')return
    if(initialized.current){
      if(latest.current&&(latest.current.fingerprint!==fingerprint||latest.current.sceneFingerprint!==scene.sceneFingerprint))setNotice('原草稿与当前轨迹或三维场景不一致，原关键帧保留。可导出备份，或明确重新建立镜头。')
      return
    }
    const camera=scene.getCameraState()
    if(!camera){setError('无法读取三维相机');return}
    initialized.current=true
    let initial=createShotEditorPlan({trackId:track.id,fingerprint,sceneFingerprint:scene.sceneFingerprint,title:track.name,camera})
    initial={...initial,routeColor:preferences.routeColor,labels:candidates.filter(item=>item.sourceId.startsWith('group:')).slice(0,3).map((item,index)=>({...item,id:uid(),from:rounded(index*initial.duration/5),to:initial.duration}))}
    const value=envelope(initial,currentAppearance.current);restore(value);initialDraft.current=structuredClone(value)
  },[scene,ready,loadState,fingerprint,track.id,track.name,candidates,preferences.routeColor])
  useEffect(()=>{if(!isActive){pause();setConfirmReset(false);if(capture.current||preparingCapture.current)cancelCapture('已停止隐藏页面的录制，镜头草稿保留。')}},[isActive])

  useEffect(()=>{
    if(!isActive||!playing||!validScene||!plan||!scene)return
    const session=capture.current, frozen=session?.plan || plan
    const started=performance.now(), startTime=session?0:time
    let lastDraw=-Infinity
    const tick=(now:number)=>{
      if(!alive.current)return
      const next=clamp(startTime+(now-started)/1000,0,frozen.duration)
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
  },[playing,validScene,scene,isActive,cancelCapture,stopFrames])

  function pause(){stopFrames();setPlaying(false)}
  function seek(value:number){if(recording||preparingCapture.current||savingRef.current||!plan||!Number.isFinite(value))return;pause();setTime(clamp(value,0,plan.duration));scene?.renderAt(plan,clamp(value,0,plan.duration))}
  function change(next:ShotEditorPlan,look:Appearance=currentAppearance.current){
    if(recording||savingRef.current||capture.current||preparingCapture.current||!alive.current)return
    const valid=parseShotEditorPlan(next,track.id)
    if(!valid){setError('参数无效：时间必须在镜头内，关键帧不能重叠。');return}
    const value=parseShotEditorProject(envelope(valid,look),track.id)
    if(!value){setError('场景外观参数无效');return}
    if(latest.current&&JSON.stringify(envelope(latest.current,currentAppearance.current))===JSON.stringify(value))return
    const previous=latest.current?structuredClone(envelope(latest.current,currentAppearance.current)):null
    pause();setError('');if(previous)setPast(items=>[...items.slice(-59),previous]);setFuture([])
    latest.current=valid;currentAppearance.current=value.appearance;setPlan(valid);setAppearance(value.appearance);setTime(value=>Math.min(value,valid.duration));setSaveStatus('有未保存的镜头修改')
  }
  function captureView(){
    const camera=scene?.getCameraState()
    if(!camera||!plan||!validScene)return
    const found=plan.cameraKeyframes.find(item=>Math.abs(item.time-time)<1e-8)
    const entry={id:found?.id || uid(),time,camera,easing:found?.easing || 'smooth' as const}
    change({...plan,cameraKeyframes:[...plan.cameraKeyframes.filter(item=>item.id!==found?.id),entry].sort((a,b)=>a.time-b.time)});setSelected(entry.id);setSelectedLayer('camera');setPanel('properties')
  }
  function cameraPatch(camera:SandboxCameraState){if(active&&plan)change({...plan,cameraKeyframes:plan.cameraKeyframes.map(item=>item.id===active.id?{...item,camera}:item)})}
  function duration(value:number){if(plan)try{change(resizeShotEditorDuration(plan,value))}catch(reason){setError(message(reason))}}
  function history(direction:'undo'|'redo'){
    if(locked||!latest.current)return
    const stack=direction==='undo'?past:future,value=stack.at(-1);if(!value)return
    const previous=structuredClone(envelope(latest.current,currentAppearance.current));pause();restore(structuredClone(value))
    setSaveStatus(revision.current&&JSON.stringify(value)===savedText?'已恢复已保存工程':'当前编辑尚未保存')
    if(direction==='undo'){setPast(stack.slice(0,-1));setFuture(items=>[...items,previous])}else{setFuture(stack.slice(0,-1));setPast(items=>[...items,previous])}
  }
  function retime(lane:string|undefined,id:string,t:number){if(plan)try{change(retimeShotEditorKey(plan,lane==='route'?'route':'camera',id,t));seek(t)}catch(reason){setNotice(message(reason))}}
  function addRouteKey(){if(plan&&!plan.routeKeyframes.some(key=>Math.abs(key.time-time)<1e-8)){const id=uid();change({...plan,routeKeyframes:[...plan.routeKeyframes,{id,time,progress:evaluated?.routeProgress||0}].sort((a,b)=>a.time-b.time)});setSelectedRoute(id);setSelectedLayer('route')}}
  function reset(){
    const camera=scene?.getCameraState()
    if(!camera||!scene)return
    change({...createShotEditorPlan({trackId:track.id,fingerprint,sceneFingerprint:scene.sceneFingerprint,title:track.name,camera}),routeColor:settings.routeColor})
    setTime(0);setSelectedLayer('camera');setConfirmReset(false);setNotice('已按当前场景建立新镜头，原关键帧可通过撤销恢复；保存前不会更改原工程文件。')
  }
  function addLabel(){
    if(!plan)return
    const item=candidates.find(item=>item.sourceId===(labelSource||candidates.find(candidate=>!plan.labels.some(label=>label.sourceId===candidate.sourceId))?.sourceId))
    if(item&&!plan.labels.some(label=>label.sourceId===item.sourceId)){change({...plan,labels:[...plan.labels,{...item,id:uid(),from:rounded(time),to:plan.duration}]});setLabelSource('')}
  }
  function patchLabel(id:string,patch:Partial<ShotEditorPlan['labels'][number]>){if(plan)change({...plan,labels:plan.labels.map(item=>item.id===id?{...item,...patch}:item)})}
  function appearancePatch(patch:Partial<Appearance>){if(latest.current&&!locked)change(latest.current,{...currentAppearance.current,...patch})}
  function lightingPatch(patch:Partial<SandboxLighting>){appearancePatch({lighting:sanitizeLighting({...appearance.lighting,...patch})})}
  function exportPlan(saved:unknown=plan?envelope(plan,appearance):rawBackup.current){if(saved)download(`${clipboardSafeName(track.name)}-三维镜头.json`,typeof saved==='string'?saved:JSON.stringify(saved,null,2))}
  async function importPlan(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];event.target.value=''
    if(!file||locked||loadState!=='ready')return
    if(file.size>SHOT_EDITOR_PROJECT_MAX_BYTES){setError('镜头配置不能超过 2 MB');return}
    try{
      const request=++importRequest.current, expectedPlan=latest.current, expectedScene=scene
      const contents=await file.text()
      if(!alive.current||request!==importRequest.current)return
      if(capture.current||currentScene.current!==expectedScene||latest.current!==expectedPlan){setError('读取文件期间镜头或场景已变化，导入已取消，请重试。');return}
      const imported=parseShotEditorProject(JSON.parse(contents),track.id)
      if(!imported)throw new Error('镜头配置格式无效或属于其他轨迹')
      change(imported.plan,imported.appearance);setSelected(imported.plan.cameraKeyframes[0]?.id||'');setTime(0)
      setNotice(imported.plan.fingerprint!==fingerprint||imported.plan.sceneFingerprint!==scene?.sceneFingerprint?'导入的原关键帧已保留，当前场景不匹配，可导出备份或明确重新建立镜头。':'已导入镜头配置，请保存工程')
    }catch(reason){setError(message(reason))}
  }
  function record(){
    if(!isActive||!validScene||!plan||!scene||!mime||capture.current||preparingCapture.current||recording||saving||uploading||confirmReset)return
    if(scope&&(dirty||!revision.current)){setError('请先保存当前分镜的镜头工程，再输出视频');return}
    let identity:ShotResultIdentity|undefined
    try{identity=freezeShotResult(track.id,scope,revision.current,'sandbox')}catch(reason){setError(message(reason));return}
    importRequest.current++
    pause();setError('');setPanel('preview');setPreparing(true)
    const preparation:PreparingCapture={scene,plan:structuredClone(plan),appearance:structuredClone(appearance),frame:null,started:performance.now(),size:'',stable:0,attempts:0,identity,authorization:new AbortController()}
    preparingCapture.current=preparation
    const settle=(now:number)=>{
      preparation.frame=null
      if(!alive.current||preparingCapture.current!==preparation)return
      if(!currentActive.current||currentScene.current!==preparation.scene){cancelCapture('三维场景已改变，本次录制准备已取消。');return}
      const stage=workspace.current?.querySelector<HTMLElement>('.trk-se-stage'),rect=stage?.getBoundingClientRect()
      const terrain=stage?.querySelector<HTMLCanvasElement>('.trk-sandbox-canvas')
      const usable=!!rect&&rect.width>1&&rect.height>1&&(!terrain||terrain.width>1&&terrain.height>1)
      const size=usable?`${rect.width}:${rect.height}:${terrain?.width||0}:${terrain?.height||0}`:''
      preparation.attempts++
      preparation.stable=usable?(size===preparation.size?preparation.stable+1:1):0;preparation.size=size
      if(preparation.stable>=2){
        preparingCapture.current=null;setPreparing(false)
        startCapture(preparation)
        return
      }
      if(now-preparation.started>=3000||preparation.attempts>=120){cancelCapture('三维画布布局尚未就绪，录制未开始。请保持预览可见后重试。');return}
      preparation.frame=requestAnimationFrame(settle)
    }
    const beginLayout=()=>{if(!alive.current||preparingCapture.current!==preparation||preparation.authorization.signal.aborted)return;preparation.started=performance.now();preparation.frame=requestAnimationFrame(settle)}
    if(identity)void assertShotCaptureApproval(identity,preparation.authorization.signal).then(beginLayout).catch(reason=>{if(alive.current&&preparingCapture.current===preparation&&!preparation.authorization.signal.aborted)cancelCapture(message(reason))})
    else beginLayout()
  }
  function startCapture(preparation:PreparingCapture){
    let stream:MediaStream|null=null
    try{
      const frozen=preparation.plan,look=preparation.appearance
      preparation.scene.renderAt(frozen,0)
      const canvas=preparation.scene.getCaptureCanvas()
      if(!canvas?.captureStream)throw new Error('当前浏览器不支持画布录制')
      stream=canvas.captureStream(30)
      const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6_000_000})
      const session:Capture={recorder,stream,chunks:[],mime,plan:frozen,appearance:look,discard:false,requestFrame:null,timer:null,identity:preparation.identity}
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
        const filename=`${clipboardSafeName(track.name)}-三维镜头.webm`,saved=envelope(session.plan,session.appearance)
        if(session.identity)captureStore?.set({blob,filename,saved,identity:session.identity})
        setVideo({url,filename,saved,blob,identity:session.identity})
      }
      recorder.start(250);setTime(0);setRecording(true);setPlaying(true)
    }catch(reason){stream?.getTracks().forEach(item=>item.stop());capture.current=null;setError(message(reason))}
  }


  function playPause(){if(!isActive||!validScene||recording||preparingCapture.current||saving||uploading)return;if(playing){pause();return}if(plan&&time>=plan.duration)setTime(0);setPlaying(true)}
  function keyboard(event:KeyboardEvent<HTMLDivElement>){
    if(!isActive||event.defaultPrevented||confirmReset||uploading)return
    const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase()
    if(command&&key==='s'){event.preventDefault();void saveProject();return}
    if(event.target instanceof HTMLElement&&event.target.closest('input,textarea,select,[contenteditable=true]'))return
    if(command&&(key==='z'||key==='y')){event.preventDefault();history(key==='y'||event.shiftKey?'redo':'undo');return}
    if(command||event.altKey)return
    if(event.target instanceof HTMLElement&&event.target.closest('button,a,summary'))return
    if(key==='k'){event.preventDefault();if(!locked)captureView()}
    if(event.code==='Space'||event.key===' '){event.preventDefault();playPause()}
  }
  function selectLayer(id:string){if(recording||preparingCapture.current)return;setSelectedLayer(id);setPanel('properties')}
  const selectedLane=selectedLayer==='route'?'route':'camera'
  const keyLanes=plan?[{id:'camera',name:'相机',keys:plan.cameraKeyframes.map(key=>({id:key.id,t:key.time}))},{id:'route',name:'路线进度',keys:plan.routeKeyframes.map(key=>({id:key.id,t:key.time}))}]:[]
  const clips=plan?[...plan.labels.map(label=>({id:'label:'+label.id,name:label.name,type:'marker',in:label.from,out:label.to,visible:true,visibilityLocked:true})),{id:'caption',name:'字幕',type:'text',in:plan.caption.from,out:plan.caption.to,visible:true,visibilityLocked:true}]:[]
  const timeline=<GeoMotionTimeline duration={plan?.duration||20} fps={30} time={time} keys={[]} keyLanes={keyLanes} layers={clips} selectedLaneId={selectedLane}
    selectedKeyId={selectedLane==='route'?selectedRoute:selected} selectedLayerId={selectedLayer} playing={playing} recording={recording}
    disabled={!validScene||recording||preparing||saving||uploading} editDisabled={locked||!validScene} onSeek={seek} onPlayPause={playPause}
    onSelectLane={selectLayer} onSelectKey={(id,t,lane)=>{selectLayer(lane||'camera');if(lane==='route')setSelectedRoute(id);else setSelected(id);seek(t)}}
    onKeyTime={(id,t,lane)=>retime(lane,id,t)} onSelectLayer={selectLayer} onAddKey={lane=>lane==='route'?addRouteKey():captureView()}
    onLayerRange={(id,range)=>{if(!plan)return;if(id==='caption')change({...plan,caption:{...plan.caption,from:range.in,to:range.out}});else patchLabel(id.slice(6),{from:range.in,to:range.out})}} onToggleLayer={()=>{}}/>
  const fileTools=<><ShotProjectBackup trackId={track.id} scene="sandbox" scope={scope} disabled={recording||preparing||saving||uploading}/><button disabled={!plan&&!rawBackup.current||recording||preparing||saving} onClick={()=>exportPlan()}>导出镜头 JSON</button>
    <label className={`trk-gm-file${locked||loadState!=='ready'?' is-disabled':''}`}>导入镜头 JSON<input aria-label="导入镜头 JSON" type="file" accept=".json,application/json" disabled={locked||loadState!=='ready'} onChange={event=>void importPlan(event)}/></label>
    <button disabled={!scene||locked||loadState!=='ready'} onClick={()=>{pause();setConfirmReset(true)}}>重新建立镜头</button></>
  const toolbar=<ShotWorkbenchToolbar fileTools={fileTools}><button className="trk-gm-primary" disabled={!plan||locked||loadState!=='ready'||!dirty&&revision.current!==null} onClick={()=>void saveProject()}>{saving?'正在保存…':'保存工程'}</button>
    <button disabled={!past.length||locked} onClick={()=>history('undo')}>撤销</button><button disabled={!future.length||locked} onClick={()=>history('redo')}>重做</button>
    <button disabled={!validScene||locked} onClick={captureView}>保存当前视角</button>
    {recording||preparing?<button onClick={()=>cancelCapture('已取消录制，镜头草稿保留。')}>取消录制</button>:<button disabled={!validScene||!mime||playing||saving||uploading||confirmReset||!!scope&&(dirty||revision.current===null)} onClick={record}>录制镜头 WebM</button>}</ShotWorkbenchToolbar>
  return <ShotWorkbench className="trk-shot-editor" workspaceRef={workspace} onKeyDown={keyboard} panel={panel} context={<>三维沙盘 · {track.name}{scope&&<> · 分镜 {scope.sceneId}</>}</>}
    status={<span aria-label="镜头工程保存状态">{saveStatus}</span>} dirty={dirty} navigation={<button disabled={recording||preparing||saving||uploading} onClick={()=>navigation.requestLeave(onCancel)}>返回轨迹</button>}
    toolbar={toolbar} timeline={timeline} dialog={<>{navigation.dialog}{confirmReset&&isActive&&<EditorConfirmationDialog title="重新建立三维镜头？" description="这会替换当前镜头与关键帧。请先导出 JSON 备份；确认后仍可撤销，保存前不会更改原工程文件。" confirmLabel="确认重新建立" onConfirm={reset} onCancel={()=>setConfirmReset(false)}/>}</>} footer={<><span>Ctrl/⌘ S 保存 · Ctrl/⌘ Z 撤销 · K 保存视角 · 空格播放</span><span>WebM · 1280 × 720 · 30 fps · 无声</span></>}>
    <style>{EDITOR_CSS}</style>
    {notice&&<p role="status" className="trk-gm-notice">{notice}</p>}
    {(error||placemarks.error||placemarks.stateError)&&<div role="alert" className="trk-gm-alert"><span>{error||placemarks.error||placemarks.stateError}</span>{error&&<button disabled={locked} onClick={()=>loadState==='error'?setLoadAttempt(value=>value+1):navigation.requestLeave(()=>setLoadAttempt(value=>value+1))}>{loadState==='error'?'重新读取工程':'重新读取已保存工程'}</button>}</div>}
    {sceneError&&<p role="alert" className="trk-gm-alert">{sceneError}</p>}
    <div className="trk-gm-panel-tabs" aria-label="工作区视图">{(['layers','preview','properties'] as const).map(id=><button key={id} disabled={recording||preparing} aria-pressed={panel===id} onClick={()=>setPanel(id)}>{id==='layers'?'图层':id==='preview'?'预览':'属性'}</button>)}</div>
    <div className="trk-gm-workspace">
      <aside className="trk-gm-layers" aria-label="镜头图层"><h3>图层</h3><div className="trk-gm-layer-list">
        <button className="trk-gm-layer" aria-pressed={selectedLayer==='camera'} onClick={()=>selectLayer('camera')}><span>相机</span><small>{plan?.cameraKeyframes.length||0} 个关键帧</small></button>
        <button className="trk-gm-layer" aria-pressed={selectedLayer==='route'} onClick={()=>selectLayer('route')}><span>路线进度</span><small>{plan?.routeKeyframes.length||0} 个关键帧 · 独立时间</small></button>
        {plan?.labels.map(label=><button className="trk-gm-layer" key={label.id} aria-pressed={selectedLayer==='label:'+label.id} onClick={()=>selectLayer('label:'+label.id)}><span>{label.name}</span><small>地名 · {rounded(label.from)} – {rounded(label.to)} 秒</small></button>)}
        <button className="trk-gm-layer" aria-pressed={selectedLayer==='caption'} onClick={()=>selectLayer('caption')}><span>字幕</span><small>{rounded(plan?.caption.from||0)} – {rounded(plan?.caption.to||0)} 秒</small></button>
      </div><fieldset disabled={locked||!validScene}><legend>添加地名</legend><select aria-label="添加地名" value={labelSource||candidates.find(item=>!plan?.labels.some(label=>label.sourceId===item.sourceId))?.sourceId||''} onChange={event=>setLabelSource(event.target.value)}>{candidates.filter(item=>!plan?.labels.some(label=>label.sourceId===item.sourceId)).map(item=><option key={item.sourceId} value={item.sourceId}>{item.name}</option>)}</select><button disabled={!candidates.some(item=>!plan?.labels.some(label=>label.sourceId===item.sourceId))} onClick={addLabel}>添加</button></fieldset></aside>
      <main className="trk-gm-preview" aria-label="三维镜头预览"><div className={`trk-se-stage${recording?' is-recording':''}`}>{isActive&&ready&&loadState==='ready'?<ShotEditorScene track={sceneTrack} settings={settings} plan={validScene?plan:null} time={time} locked={locked} onReady={sceneReady} onStatus={setStatus} onError={setSceneError}/>:<div className="trk-se-loading">{!isActive?'三维预览已暂停':loadState==='error'?'请重新读取工程':'正在读取轨迹与沙盘工程…'}</div>}</div>
        <p className="trk-gm-preview-help" role="status" data-testid="shot-editor-status">{preparing?'正在准备录制画布，请保持预览可见…':status} · 拖动旋转，滚轮缩放，右键拖动平移。</p>
        <div className="trk-gm-actions"><button disabled={!validScene||recording||preparing||saving} onClick={playPause}>{playing?'暂停预览':'播放镜头'}</button><button disabled={!scene||locked} onClick={()=>scene?.resetView()}>重置构图</button></div>
        <div className="trk-se-time"><label>当前时间（秒）<input aria-label="当前时间" type="number" min={0} max={plan?.duration||20} step={.1} value={rounded(time)} disabled={!validScene||recording||preparing||saving} onChange={event=>seek(Number(event.target.value))}/></label><output aria-label="三维镜头播放状态">{rounded(time)} / {plan?.duration||20} 秒 · {preparing?'准备录制':recording?'正在录制':playing?'正在播放':'已暂停'} · 路线 {Math.round((evaluated?.routeProgress||0)*100)}%</output></div>
        {!mime&&<p role="status">当前浏览器不支持 WebM 录制，仍可编辑和导出镜头配置。</p>}
        {video&&<article className="trk-gm-video" aria-label="录制镜头结果"><h3>录制结果 · {video.saved.plan.duration} 秒</h3><video aria-label="三维镜头录制视频" controls preload="metadata" src={video.url}/><div className="trk-gm-actions"><a href={video.url} download={video.filename}>下载镜头 WebM</a><button onClick={()=>exportPlan(video.saved)}>导出本次录制参数</button></div>{video.identity&&<ShotResultUpload key={video.identity.takeId} blob={video.blob} identity={video.identity} scope={scope} revision={revision.current} dirty={dirty} active={isActive} disabled={recording||preparing||saving||playing} onBusy={setUploading} onUploaded={onShotResult} initialState={video.uploadState} onState={state=>captureStore?.updateUpload(video.identity!,state)}/>}</article>}
      </main>
      <aside className="trk-gm-properties" aria-label="镜头参数"><h3>属性</h3>
        {selectedLayer==='camera'&&<>      <section className="trk-se-block" aria-label="相机关键帧"><h3>相机关键帧</h3><p className="trk-muted">点击时间点查看构图。时间输入支持精确调整，缓动控制这一帧到下一帧的运动。</p>
        <div className="trk-se-ticks">{plan?.cameraKeyframes.map(item=><button className="trk-secondary" key={item.id} disabled={locked||!validScene} aria-pressed={active?.id===item.id} onClick={()=>{setSelected(item.id);seek(item.time)}}>{rounded(item.time)} 秒</button>)}</div>
        {active&&plan&&<fieldset disabled={locked||!validScene}><legend>选中关键帧</legend><div className="trk-se-fields">
          <label>时间（秒）<input aria-label="关键帧时间" type="number" min={0} max={plan.duration} step={.1} value={active.time} onChange={event=>retime('camera',active.id,Number(event.target.value))}/></label>
          <label>缓动<select aria-label="关键帧缓动" value={active.easing} onChange={event=>change({...plan,cameraKeyframes:plan.cameraKeyframes.map(item=>item.id===active.id?{...item,easing:event.target.value as 'linear'|'smooth'}:item)})}><option value="smooth">平滑</option><option value="linear">匀速</option></select></label>
          <label>视野角度（度）<input aria-label="相机视野角度" type="number" min={20} max={85} step={1} value={rounded(active.camera.fov)} onChange={event=>cameraPatch({...active.camera,fov:Number(event.target.value)})}/></label>
          <label>绕山方向（度）<input aria-label="相机方向" type="number" min={-360} max={360} step={5} value={rounded(cameraAngles(active.camera).azimuth)} onChange={event=>cameraPatch(cameraOrbit(active.camera,{azimuth:Number(event.target.value)}))}/></label>
          <label>俯仰（度）<input aria-label="相机俯仰" type="number" min={5} max={85} step={5} value={rounded(cameraAngles(active.camera).elevation)} onChange={event=>cameraPatch(cameraOrbit(active.camera,{elevation:clamp(Number(event.target.value),5,85)}))}/></label>
          <label>距离（米）<input aria-label="相机距离" type="number" min={1} max={1_000_000} step={100} value={rounded(cameraAngles(active.camera).distance)} onChange={event=>cameraPatch(cameraOrbit(active.camera,{distance:clamp(Number(event.target.value),1,1_000_000)}))}/></label>
        </div><button className="trk-secondary" disabled={plan.cameraKeyframes.length<=1} onClick={()=>change({...plan,cameraKeyframes:plan.cameraKeyframes.filter(item=>item.id!==active.id)})}>删除此关键帧</button></fieldset>}
      </section>
</>}
        {selectedLayer==='route'&&<>      <section className="trk-se-block" aria-label="路线关键帧"><h3>路线显现时间</h3><p className="trk-muted">路线进度独立于相机，保留原轨迹分段。</p><fieldset disabled={locked||!validScene}>{plan?.routeKeyframes.map((item,index)=><div className="trk-se-route-row" key={item.id}><label>时间（秒）<input aria-label={`路线关键帧 ${index+1} 时间`} type="number" min={0} max={plan.duration} step={.1} value={item.time} onChange={event=>retime('route',item.id,Number(event.target.value))}/></label><label>路线（%）<input aria-label={`路线关键帧 ${index+1} 进度`} type="number" min={0} max={100} step={1} value={Math.round(item.progress*100)} onChange={event=>change({...plan,routeKeyframes:plan.routeKeyframes.map(entry=>entry.id===item.id?{...entry,progress:Number(event.target.value)/100}:entry)})}/></label><button className="trk-secondary" aria-label={`删除路线关键帧 ${index+1}`} disabled={plan.routeKeyframes.length<=1} onClick={()=>change({...plan,routeKeyframes:plan.routeKeyframes.filter(entry=>entry.id!==item.id)})}>删除</button></div>)}
        <button className="trk-secondary" disabled={!plan||!!plan.routeKeyframes.some(item=>Math.abs(item.time-time)<.02)} onClick={addRouteKey}>在当前时间添加路线关键帧</button></fieldset></section>
</>}
        <fieldset disabled={locked||!validScene}><legend>画面与节奏</legend>
      <label>画面标题<input aria-label="画面标题" maxLength={160} value={plan?.title||''} onChange={event=>{if(plan)change({...plan,title:event.target.value})}}/></label>
      <div className="trk-se-fields"><label>总时长（秒）<input aria-label="镜头总时长" type="number" min={1} max={1800} value={plan?.duration||20} onChange={event=>duration(Number(event.target.value))}/></label><label>路线颜色<input aria-label="路线颜色" type="color" value={plan?.routeColor||settings.routeColor} onChange={event=>{if(plan)change({...plan,routeColor:event.target.value})}}/></label></div><p className="trk-muted">调整时长会同比缩放各元素的时间。</p>
      <label>字幕<textarea aria-label="镜头字幕" maxLength={1200} value={plan?.caption.text||''} placeholder="输入这段镜头要说的话" onChange={event=>{if(plan)change({...plan,caption:{...plan.caption,text:event.target.value}})}}/></label>
      <div className="trk-se-fields"><label>字幕出现（秒）<input aria-label="字幕出现时间" type="number" min={0} max={plan?.duration||20} step={.1} value={plan?.caption.from||0} onChange={event=>{if(plan)change({...plan,caption:{...plan.caption,from:Number(event.target.value)}})}}/></label><label>字幕结束（秒）<input aria-label="字幕结束时间" type="number" min={0} max={plan?.duration||20} step={.1} value={plan?.caption.to||0} onChange={event=>{if(plan)change({...plan,caption:{...plan.caption,to:Number(event.target.value)}})}}/></label></div>
    </fieldset>
    <fieldset disabled={locked||!validScene}><legend>地名标注</legend>
      {plan?.labels.map(item=><article className="trk-se-label" key={item.id}><label>显示名称<input aria-label={`地名 ${item.sourceId}`} maxLength={160} value={item.name} onChange={event=>patchLabel(item.id,{name:event.target.value})}/></label><div className="trk-se-fields"><label>出现（秒）<input aria-label={`${item.name} 出现时间`} type="number" min={0} max={plan.duration} step={.1} value={item.from} onChange={event=>patchLabel(item.id,{from:Number(event.target.value)})}/></label><label>结束（秒）<input aria-label={`${item.name} 结束时间`} type="number" min={0} max={plan.duration} step={.1} value={item.to} onChange={event=>patchLabel(item.id,{to:Number(event.target.value)})}/></label></div><button className="trk-secondary" onClick={()=>change({...plan,labels:plan.labels.filter(label=>label.id!==item.id)})}>移除此地名</button></article>)}
    </fieldset>
    <fieldset disabled={locked||!validScene}><legend>场景光照</legend><label>背景<select aria-label="场景背景" value={appearance.sandboxBackground} onChange={event=>appearancePatch({sandboxBackground:event.target.value as Appearance['sandboxBackground']})}><option value="solid">纯色</option><option value="environment">环境天空</option></select></label><label>背景颜色<input aria-label="场景背景颜色" type="color" value={appearance.sandboxColors.background} onChange={event=>appearancePatch({sandboxColors:{...appearance.sandboxColors,background:event.target.value}})}/></label>
      <div className="trk-se-fields"><label>太阳方向（度）<input aria-label="太阳方向" type="number" min={0} max={360} step={5} value={appearance.lighting.azimuth} onChange={event=>lightingPatch({azimuth:Number(event.target.value)})}/></label><label>太阳高度（度）<input aria-label="太阳高度" type="number" min={5} max={85} step={5} value={appearance.lighting.elevation} onChange={event=>lightingPatch({elevation:Number(event.target.value)})}/></label><label>太阳亮度<input aria-label="太阳亮度" type="number" min={0} max={5} step={.1} value={appearance.lighting.intensity} onChange={event=>lightingPatch({intensity:Number(event.target.value)})}/></label><label>环境亮度<input aria-label="环境亮度" type="number" min={0} max={2} step={.1} value={appearance.lighting.ambient} onChange={event=>lightingPatch({ambient:Number(event.target.value)})}/></label></div>
    </fieldset><BasemapControls className="trk-se-basemaps" basemap={basemap} onBasemap={value=>{pause();onBasemap(value)}} disabled={locked}/><p className="trk-muted">更换底图会重新加载场景；原工程保留，如不匹配可先导出备份。</p>

      </aside>
    </div>
  </ShotWorkbench>
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
.trk-shot-editor .trk-se-stage{aspect-ratio:16/9;overflow:hidden;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);background:var(--trk-map-background);min-width:0}
.trk-shot-editor .trk-se-stage.is-recording{pointer-events:none}.trk-shot-editor .trk-se-stage>div{height:100%;width:100%}.trk-shot-editor .trk-se-loading{display:grid;place-items:center;min-height:220px;padding:20px;text-align:center;color:var(--trk-muted)}
.trk-shot-editor .trk-se-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--trk-gm-gap)}.trk-shot-editor .trk-se-block{display:flex;flex-direction:column;gap:var(--trk-gm-gap);min-width:0}.trk-shot-editor .trk-se-ticks,.trk-shot-editor .trk-se-actions{display:flex;gap:var(--trk-gm-gap);flex-wrap:wrap;align-items:center}.trk-shot-editor .trk-se-ticks button{min-width:60px}.trk-shot-editor .trk-se-time{display:flex;gap:var(--trk-gm-gap);align-items:end;flex-wrap:wrap;font-size:var(--trk-ui-label-size,12px)}.trk-shot-editor .trk-se-time label{width:120px}.trk-shot-editor .trk-se-time output{color:var(--trk-muted);padding-bottom:10px;overflow-wrap:anywhere}
.trk-shot-editor .trk-se-route-row{display:flex;flex-direction:column;gap:var(--trk-gm-gap);border-bottom:1px solid var(--trk-border);padding-bottom:var(--trk-gm-gap)}.trk-shot-editor .trk-se-label{display:flex;flex-direction:column;gap:var(--trk-gm-gap);border-bottom:1px solid var(--trk-border);padding-bottom:var(--trk-gm-gap)}.trk-shot-editor .trk-muted{font-size:var(--trk-ui-label-size,12px);line-height:1.6;overflow-wrap:anywhere}.trk-shot-editor textarea{min-height:88px;resize:vertical}.trk-shot-editor .trk-se-basemaps{min-width:0}.trk-shot-editor .trk-gm-properties>fieldset{border-top:1px solid var(--trk-border);padding-top:var(--trk-gm-gap)}
@container geomotion (max-width:500px){.trk-shot-editor .trk-se-fields{grid-template-columns:minmax(0,1fr)}}
/* The sandbox retains its renderer and uses the map editor's visual language. */
.trk-shot-editor{font-size:var(--trk-ui-font-size,13px)}
.trk-shot-editor button,.trk-shot-editor .trk-gm-file,.trk-shot-editor .trk-se-video a{min-height:var(--trk-control-height,32px);padding:4px 9px;border-radius:var(--trk-radius-sm,5px);font-size:var(--trk-ui-label-size,12px)}
.trk-shot-editor input:not([type=checkbox]):not([type=file]),.trk-shot-editor select,.trk-shot-editor textarea{min-height:var(--trk-input-height,30px);padding:4px 7px;border-radius:var(--trk-radius-sm,5px);font-size:var(--trk-ui-font-size,13px)}
.trk-shot-editor textarea{min-height:88px}.trk-shot-editor input[type=color]{width:48px;padding:2px}.trk-shot-editor label,.trk-shot-editor legend{font-size:var(--trk-ui-label-size,12px)}
.trk-shot-editor .trk-gm-layers>h3,.trk-shot-editor .trk-gm-properties>h3{min-height:36px;display:flex;align-items:center;margin:-10px -10px 0;padding:7px 10px;border-bottom:1px solid var(--trk-border);font-size:var(--trk-ui-label-size,12px)}
.trk-shot-editor .trk-gm-layer-list{gap:0}.trk-shot-editor .trk-gm-layer{border:0;border-bottom:1px solid var(--trk-border);border-radius:0;min-height:var(--trk-control-height,32px)}
.trk-shot-editor .trk-se-block>h3{min-height:36px;display:flex;align-items:center;border-bottom:1px solid var(--trk-border);font-size:var(--trk-ui-label-size,12px)}
.trk-shot-editor .trk-se-stage{border-radius:var(--trk-radius-md,6px)}.trk-shot-editor .trk-se-ticks{gap:6px}.trk-shot-editor .trk-se-ticks button{min-width:48px}.trk-shot-editor .trk-se-fields{gap:8px}.trk-shot-editor .trk-se-route-row,.trk-shot-editor .trk-se-label{gap:8px;padding-bottom:8px}.trk-shot-editor .trk-se-time output{padding-bottom:6px}
.trk-shot-editor .trk-se-video{min-width:0;padding:10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md,6px);background:var(--trk-surface)}.trk-shot-editor .trk-se-video h3{font-size:var(--trk-ui-label-size,12px)}.trk-shot-editor .trk-se-video video{display:block;width:100%;max-height:360px;border-radius:var(--trk-radius-sm,5px)}.trk-shot-editor .trk-se-video a{display:inline-flex;align-items:center;border:1px solid var(--trk-border);background:var(--trk-surface);color:var(--trk-text);text-decoration:none}
@container geomotion (max-width:850px){.trk-shot-editor button,.trk-shot-editor .trk-gm-file,.trk-shot-editor .trk-se-video a{min-height:44px}.trk-shot-editor input:not([type=checkbox]):not([type=file]),.trk-shot-editor select,.trk-shot-editor textarea{min-height:40px}.trk-shot-editor textarea{min-height:88px}.trk-shot-editor .trk-se-ticks,.trk-shot-editor .trk-se-actions{gap:8px}.trk-shot-editor .trk-gm-layer{min-height:44px}}
`
