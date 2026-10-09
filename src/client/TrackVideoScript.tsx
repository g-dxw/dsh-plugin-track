import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TrackPlacemark, TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { validateAnnotations, type TrackAnnotation } from '../track/annotations.ts'
import { analyzeVideoScript, createVideoScriptDraft, validateVideoScriptDraft, videoScriptMarkdown } from '../track/video-script.ts'
import { MAX_VIDEO_SHOTS, type VideoSceneCandidate, type VideoScriptAnalysis, type VideoScriptDraft, type VideoScriptShot, type VideoScriptSuggestion } from '../track/video-script-types.ts'
import { generateVideoScript } from './video-script-ai.ts'
import { useTrackPlacemarks } from './useTrackPlacemarks.ts'
import { useTextModels } from './useTextModels.ts'
import { MapView } from './MapView.tsx'
import { ShotEditor } from './ShotEditor.tsx'
import { GeoMotionEditor } from './GeoMotionEditor.tsx'
import { VideoMaterialPrep } from './VideoMaterialPrep.tsx'
import { VideoResourceSelections } from './VideoResourceSelections.tsx'
import type { VideoMaterialsDocument } from '../track/video-materials.ts'
import { api, clipboardSafeName, download } from './util.ts'
import { useEditorNavigation, type EditorNavigationHandle } from './editor-navigation.tsx'
import { VIDEO_WORKSPACE_CSS } from './video-workspace-css.ts'
import {OpenMontagePlanning} from './OpenMontagePlanning.tsx'
import type {OpenMontageEditor, OpenMontageShotScope} from '../track/openmontage.ts'
import type {TrackAgentServicesReader} from './useTrackAgentDrawer.ts'
import {createShotCaptureStore} from './shot-capture-store.ts'

type Props = {track:TrackRecord; basemap:BasemapId; onBasemap:(id:BasemapId)=>void; onCancel:()=>void; getAgentServices?:TrackAgentServicesReader; onKeepSession?:(sessionId:string,signal?:AbortSignal)=>Promise<void>}
type History = {past:VideoScriptDraft[]; future:VideoScriptDraft[]}
type Suggestion = {value:VideoScriptSuggestion; revision:number; fingerprint:string}

/** This workspace plans editable scenes; it never starts the recorder or an AI request on entry. */
export function TrackVideoScript(props:Props) {return <TrackVideoWorkspace key={props.track.id} {...props} />}
function TrackVideoWorkspace(props:Props) {
  const [captureStore] = useState(createShotCaptureStore)
  useEffect(() => () => captureStore.clear(), [captureStore])
  const [mode,setMode] = useState<'planning'|'editing'|'materials'>('editing')
  const [scene,setScene] = useState<'map'|'sandbox'>('map')
  const [visited,setVisited] = useState({map:true,sandbox:false,materials:false,planning:false})
  const [preparedMaterials,setPreparedMaterials] = useState<VideoMaterialsDocument|null>(null)
  const [scopes,setScopes] = useState<Record<OpenMontageEditor,OpenMontageShotScope|null>>({map:null,sandbox:null})
  const [planningRefresh,setPlanningRefresh] = useState(0)
  const [mapNavigation,setMapNavigation] = useState<EditorNavigationHandle|null>(null)
  const [sandboxNavigation,setSandboxNavigation] = useState<EditorNavigationHandle|null>(null)
  const [materialNavigation,setMaterialNavigation] = useState<EditorNavigationHandle|null>(null)
  const [scriptNavigation,setScriptNavigation] = useState<EditorNavigationHandle|null>(null)
  const registerMap = useCallback((value:EditorNavigationHandle|null)=>setMapNavigation(value),[])
  const registerSandbox = useCallback((value:EditorNavigationHandle|null)=>setSandboxNavigation(value),[])
  const registerMaterials = useCallback((value:EditorNavigationHandle|null)=>setMaterialNavigation(value),[])
  const registerScript = useCallback((value:EditorNavigationHandle|null)=>setScriptNavigation(value),[])
  const current = mode==='materials'?materialNavigation:mode==='planning'?scriptNavigation:scene==='map'?mapNavigation:sandboxNavigation
  function activate(next:typeof mode,kind=scene) {
    setMode(next);setScene(kind)
    setVisited(value=>({...value,[next==='editing'?kind:next]:true}))
  }
  function navigate(next:typeof mode,kind=scene) {
    if(mode===next&&(next!=='editing'||scene===kind))return
    const change=()=>activate(next,kind)
    if(current)current.requestLeave(change);else change()
  }
  function leave() {if(current)current.requestLeave(props.onCancel);else props.onCancel()}
  function openShot(scope:OpenMontageShotScope,editor:OpenMontageEditor) {setScopes(value=>({...value,[editor]:scope}));activate('editing',editor)}
  function resetScope() {const change=()=>setScopes(value=>({...value,[scene]:null}));if(current)current.requestLeave(change);else change()}
  const scope=scopes[scene]
  const editorKey=(kind:OpenMontageEditor)=>`${props.track.id}:${scopes[kind]?.projectId||'track'}:${scopes[kind]?.shotId||'singleton'}`
  const shotResult=()=>setPlanningRefresh(value=>value+1)
  const tabs=[{id:'materials',name:'素材准备'},{id:'planning',name:'脚本策划'},{id:'editing',name:'镜头编辑'}] as const
  return <section className="trk-video-workspace" aria-label="轨迹视频制作">
    <style>{VIDEO_WORKSPACE_CSS}</style>
    <div className="trk-video-navigation"><nav role="tablist" aria-label="视频制作内容">{tabs.map(tab=><button key={tab.id} type="button" role="tab" id={`trk-video-${tab.id}-tab`} aria-controls={`trk-video-${tab.id}-panel`} aria-selected={mode===tab.id} tabIndex={mode===tab.id?0:-1} disabled={current?.busy} onClick={()=>navigate(tab.id)} onKeyDown={event=>{
      const index=tabs.findIndex(value=>value.id===tab.id)
      const next=event.key==='ArrowRight'?tabs[(index+1)%tabs.length]:event.key==='ArrowLeft'?tabs[(index+tabs.length-1)%tabs.length]:event.key==='Home'?tabs[0]:event.key==='End'?tabs[tabs.length-1]:null
      if(next){event.preventDefault();navigate(next.id);globalThis.document.getElementById(`trk-video-${next.id}-tab`)?.focus()}
    }}>{tab.name}</button>)}</nav><button type="button" className="trk-secondary" disabled={current?.busy} onClick={leave}>返回轨迹</button></div>
    <div role="tabpanel" id="trk-video-editing-panel" aria-labelledby="trk-video-editing-tab" hidden={mode!=='editing'}>
      <div className="trk-video-scenes" role="group" aria-label="镜头场景"><span>场景</span><button type="button" aria-pressed={scene==='map'} disabled={current?.busy} onClick={()=>navigate('editing','map')}>地图</button><button type="button" aria-pressed={scene==='sandbox'} disabled={current?.busy} onClick={()=>navigate('editing','sandbox')}>3D 沙盘</button></div>
      {scope&&<div className="trk-video-shot-scope" role="status">项目分镜：{scope.sceneId}<button type="button" disabled={current?.busy} onClick={()=>navigate('planning')}>返回策划看板</button><button type="button" disabled={current?.busy} onClick={resetScope}>打开独立轨迹镜头</button></div>}
      <div hidden={scene!=='map'}>{visited.map&&<GeoMotionEditor {...props} key={editorKey('map')} scope={scopes.map??undefined} captureStore={captureStore} onShotResult={shotResult} onCancel={scopes.map?()=>activate('planning'):props.onCancel} active={mode==='editing'&&scene==='map'} onRegister={registerMap} preparedMaterials={!scopes.map?preparedMaterials??undefined:undefined} onMaterials={()=>activate('materials')} />}</div>
      <div hidden={scene!=='sandbox'}>{visited.sandbox&&<ShotEditor {...props} key={editorKey('sandbox')} scope={scopes.sandbox??undefined} captureStore={captureStore} onShotResult={shotResult} onCancel={scopes.sandbox?()=>activate('planning'):props.onCancel} active={mode==='editing'&&scene==='sandbox'} onRegister={registerSandbox} />}</div>
    </div>
    <div role="tabpanel" id="trk-video-materials-panel" aria-labelledby="trk-video-materials-tab" hidden={mode!=='materials'}>{visited.materials&&<><VideoResourceSelections trackId={props.track.id} trackName={props.track.name}/><VideoMaterialPrep track={props.track} active={mode==='materials'} onRegister={registerMaterials} onBack={()=>activate('editing')} onCompose={document=>{setPreparedMaterials(document);setScopes(value=>({...value,map:null}));activate('editing','map')}} /></>}</div>
    <div role="tabpanel" id="trk-video-planning-panel" aria-labelledby="trk-video-planning-tab" hidden={mode!=='planning'}>{visited.planning&&<OpenMontagePlanning track={props.track} active={mode==='planning'} getAgentServices={props.getAgentServices} onKeepSession={props.onKeepSession} refreshKey={planningRefresh} onRegister={registerScript} onOpenShot={openShot} />}</div>
  </section>
}
type PlanningProps = Props & {onBack?:()=>void;active?:boolean;onRegister?:(value:EditorNavigationHandle|null)=>void}
export function TrackVideoScriptPlanning(props:PlanningProps) {return <VideoScriptWorkspace key={props.track.id} {...props} />}
function VideoScriptWorkspace({track,basemap,onBasemap,onCancel,onBack,active=true,onRegister}:PlanningProps) {
  const placemarks = useTrackPlacemarks(track)
  const {catalog,model,setModel,reload} = useTextModels()
  const [annotations,setAnnotations] = useState<TrackAnnotation[]>([])
  const [annotationReady,setAnnotationReady] = useState(false), [annotationError,setAnnotationError] = useState(''), [readAttempt,setReadAttempt] = useState(0)
  const [analysis,setAnalysis] = useState<VideoScriptAnalysis|null>(null), [analysisRequested,setAnalysisRequested] = useState(true)
  const [analysisError,setAnalysisError] = useState(''), [selectedIds,setSelectedIds] = useState<string[]>([])
  const [step,setStep] = useState<'information'|'script'>('information'), [draft,setDraft] = useState<VideoScriptDraft|null>(null)
  const [notes,setNotes] = useState(''), [activeShotId,setActiveShotId] = useState<string|null>(null), [selectedPlacemark,setSelectedPlacemark] = useState<string|null>(null)
  const [locatedCandidate,setLocatedCandidate] = useState<string|null>(null), [replaceRequested,setReplaceRequested] = useState(false)
  const [history,setHistory] = useState<History>({past:[],future:[]})
  const [saveState,setSaveState] = useState('尚未建立脚本草稿'), [cacheNotice,setCacheNotice] = useState('')
  const [busy,setBusy] = useState(false), [aiError,setAIError] = useState(''), [suggestion,setSuggestion] = useState<Suggestion|null>(null)
  const [editNotice,setEditNotice] = useState('')
  const [cachedBaseline,setCachedBaseline] = useState('')
  const restored = useRef(false), alive = useRef(true), pending = useRef<AbortController|null>(null), requestId = useRef(0), revision = useRef(0)
  const latestDraft = useRef(draft); latestDraft.current = draft
  const latestAnalysis = useRef(analysis); latestAnalysis.current = analysis
  const key = `cqai-track.video-script.${track.id}`
  const sourcesReady = annotationReady && !placemarks.loading && placemarks.editReady && !placemarks.error && !placemarks.stateError

  useEffect(() => {
    alive.current = true
    return () => {alive.current=false; requestId.current++; pending.current?.abort()}
  }, [])
  useEffect(() => {
    let current = true
    setAnnotationReady(false); setAnnotationError('')
    void api<{annotations:TrackAnnotation[]}>(`annotations?id=${encodeURIComponent(track.id)}`).then(result => {
      const found = validateAnnotations(result.annotations, track.coordinates.length)
      if(current){setAnnotations(found);setAnnotationReady(true)}
    }).catch(reason => {if(current)setAnnotationError(message(reason))})
    return () => {current=false}
  }, [track.id,track.coordinates.length,readAttempt])
  useEffect(() => {
    if(!sourcesReady || !analysisRequested)return
    try {
      const found = analyzeVideoScript(track,annotations,placemarks.points)
      setAnalysis(found);setAnalysisError('');setAnalysisRequested(false);setLocatedCandidate(null);setSelectedPlacemark(null)
      if(!restored.current){
        restored.current=true
        try {
          const stored = localStorage.getItem(key)
          if(stored){
            const parsed = JSON.parse(stored) as unknown
            const saved = parsed && typeof parsed==='object' && 'draft' in parsed ? (parsed as {draft:unknown}).draft : parsed
            const valid = validateVideoScriptDraft(saved,found)
            setDraft(valid);setNotes(valid.notes);setSelectedIds([...new Set(valid.shots.map(shot=>shot.candidateId))]);setActiveShotId(valid.shots[0]?.id||null)
            setSaveState('已恢复此浏览器保存的草稿');setCacheNotice('已恢复脚本草稿，可继续修改或重新选题。')
          }
        } catch {
          setCacheNotice('原缓存与当前轨迹或点位不一致，或格式无效；已保留原缓存。确认选题并建立新稿后才会替换。')
        }
      }else{
        setSelectedIds(current=>current.filter(id=>found.candidates.some(candidate=>candidate.id===id&&candidate.readiness==='ready')))
        if(latestDraft.current && latestDraft.current.fingerprint!==found.fingerprint)setCacheNotice('轨迹或点位分析已变化，原草稿保留。请重新确认选题并建立新稿，才能保存和导出。')
      }
    } catch(reason){setAnalysisError(message(reason));setAnalysisRequested(false)}
  }, [sourcesReady,analysisRequested,track,annotations,placemarks.points,key])
  const draftCurrent = !!draft && !!analysis && draft.fingerprint===analysis.fingerprint
  const validationError = useMemo(() => {
    if(!draft||!analysis)return ''
    try{validateVideoScriptDraft(draft,analysis);return ''}catch(reason){return message(reason)}
  }, [draft,analysis])
  useEffect(() => {
    if(!draft||!analysis||!draftCurrent)return
    if(validationError){setSaveState(`修改尚未保存：${validationError}`);return}
    try {localStorage.setItem(key,JSON.stringify({version:1,draft:validateVideoScriptDraft(draft,analysis)}));setCachedBaseline(JSON.stringify(draft));setSaveState('已自动保存在此浏览器')}
    catch {setSaveState('浏览器存储不可用，当前修改仅在页面中保留；请导出备份。')}
  }, [draft,analysis,draftCurrent,validationError,key])
  const navigation = useEditorNavigation({active,dirty:!!draft&&JSON.stringify(draft)!==cachedBaseline,busy,save:async()=>{
    if(!draft||!analysis||!draftCurrent||validationError)return false
    try{localStorage.setItem(key,JSON.stringify({version:1,draft:validateVideoScriptDraft(draft,analysis)}));setCachedBaseline(JSON.stringify(draft));setSaveState('已保存在此浏览器');return true}
    catch{setSaveState('浏览器存储不可用，请导出备份。');return false}
  },discard:()=>{const previous=cachedBaseline?JSON.parse(cachedBaseline) as VideoScriptDraft:null;latestDraft.current=previous;setDraft(previous);setNotes(previous?.notes||'');setActiveShotId(previous?.shots[0]?.id||null);setSelectedIds(previous?.shots.map(shot=>shot.candidateId)||[]);setStep(previous?'script':'information');setHistory({past:[],future:[]})},onRegister})
  const activeShot = draft?.shots.find(shot=>shot.id===activeShotId) || draft?.shots[0]
  const activeCandidate = analysis?.candidates.find(candidate=>candidate.id===(step==='script'?activeShot?.candidateId:locatedCandidate))
  const previewPoint = useMemo<TrackPlacemark|null>(() => {
    const target = step==='script'?activeShot?.target:activeCandidate?.target
    if(!target)return null
    if(target.placemarkId&&placemarks.points.some(point=>point.id===target.placemarkId))return null
    const coordinates = target.coordinates || (target.pointIndex===undefined?undefined:track.coordinates[target.pointIndex]?.slice(0,2) as [number,number]|undefined)
    return coordinates?{id:'video-script-target',name:step==='script'?(activeShot?.title||'镜头目标'):(activeCandidate?.title||'选题目标'),coordinates,description:'当前镜头的目标位置；地图用于选题定位。',images:[]}:null
  }, [step,activeShot,activeCandidate,placemarks.points,track.coordinates])
  const mapPoints = useMemo(()=>previewPoint?[...placemarks.points,previewPoint]:placemarks.points,[previewPoint,placemarks.points])
  const targetId = previewPoint?.id || (step==='script'?activeShot?.target?.placemarkId:activeCandidate?.target?.placemarkId)
  const selectedCandidates = analysis?.candidates.filter(candidate=>selectedIds.includes(candidate.id)&&candidate.readiness==='ready') || []
  const confirmedCount = draft?.shots.filter(shot=>shot.confirmed).length||0
  const totalDuration = draft?.shots.reduce((total,shot)=>total+(Number.isFinite(shot.duration)?shot.duration:0),0)||0

  function clearProposal() {requestId.current++;pending.current?.abort();pending.current=null;setBusy(false);setSuggestion(null);setAIError('')}
  function commit(next:VideoScriptDraft,notice='') {
    const previous=latestDraft.current
    clearProposal();revision.current++
    if(previous)setHistory(current=>({past:[...current.past,previous].slice(-30),future:[]}))
    latestDraft.current=next;setDraft(next);setEditNotice(notice)
  }
  function patchShot(id:string,patch:Partial<VideoScriptShot>) {
    if(!draft||!draftCurrent)return
    setSelectedPlacemark(null)
    commit({...draft,shots:draft.shots.map(shot=>shot.id===id?{...shot,...patch,confirmed:false}:shot)},'镜头已修改，需要重新确认。')
  }
  function establish() {
    if(!analysis||selectedCandidates.length<1||selectedCandidates.length>MAX_VIDEO_SHOTS)return
    try{
      const next=createVideoScriptDraft(analysis,selectedCandidates.map(candidate=>candidate.id),notes)
      commit(next,'已按选题建立草稿，请逐镜检查画面和文案。');setActiveShotId(next.shots[0]?.id||null);setCacheNotice('');setReplaceRequested(false);setStep('script')
    }catch(reason){setAnalysisError(message(reason))}
  }
  function build() {if(draft){setReplaceRequested(true);return}establish()}
  function toggleCandidate(id:string) {
    setReplaceRequested(false)
    setSelectedIds(current=>current.includes(id)?current.filter(value=>value!==id):current.length<MAX_VIDEO_SHOTS?[...current,id]:current)
  }
  function replay(direction:'undo'|'redo') {
    if(!draft)return
    const entries=direction==='undo'?history.past:history.future, next=entries.at(-1)
    if(!next)return
    clearProposal();revision.current++
    setHistory(direction==='undo'?{past:history.past.slice(0,-1),future:[...history.future,draft]}:{past:[...history.past,draft],future:history.future.slice(0,-1)})
    latestDraft.current=next;setDraft(next);setNotes(next.notes);setActiveShotId(next.shots[0]?.id||null);setEditNotice(direction==='undo'?'已撤销最近修改。':'已恢复最近修改。')
  }
  function moveShot(index:number,direction:-1|1) {
    if(!draft||!draftCurrent)return
    const other=index+direction;if(other<0||other>=draft.shots.length)return
    const shots=[...draft.shots];[shots[index],shots[other]]=[shots[other],shots[index]]
    commit({...draft,shots},'镜头顺序已调整。')
  }
  function removeShot(id:string) {
    if(!draft||!draftCurrent||draft.shots.length<=1)return
    const shots=draft.shots.filter(shot=>shot.id!==id);commit({...draft,shots},'镜头已删除，可撤销。');if(activeShotId===id)setActiveShotId(shots[0]?.id||null)
  }
  function confirmShot(id:string) {
    if(!draft||!draftCurrent||validationError)return
    commit({...draft,shots:draft.shots.map(shot=>shot.id===id?{...shot,confirmed:true}:shot)},'已确认当前镜头；再次编辑会重新标记为待确认。')
  }
  function locate(candidate:VideoSceneCandidate) {setLocatedCandidate(candidate.id);setSelectedPlacemark(candidate.target?.placemarkId||'video-script-target')}
  async function askAI() {
    if(!analysis||!draft||!draftCurrent||!model||busy||validationError)return
    const candidates = draft.shots.map(shot=>analysis.candidates.find(candidate=>candidate.id===shot.candidateId)).filter((candidate):candidate is VideoSceneCandidate=>!!candidate&&candidate.readiness==='ready')
    const controller=new AbortController(), current=++requestId.current, baseRevision=revision.current, fingerprint=analysis.fingerprint
    pending.current=controller;setBusy(true);setAIError('');setSuggestion(null)
    try {
      const value=await generateVideoScript({model,analysis:{trackName:analysis.trackName,pointCount:analysis.pointCount,fingerprint,summary:analysis.summary,limitations:analysis.limitations},candidates,userNotes:notes},controller.signal)
      if(!alive.current||controller.signal.aborted||current!==requestId.current||revision.current!==baseRevision||latestAnalysis.current?.fingerprint!==fingerprint)return
      validateVideoScriptDraft({...draft,title:value.title,shots:value.shots.map(shot=>({...shot,confirmed:false}))},analysis)
      setSuggestion({value,revision:baseRevision,fingerprint})
    }catch(reason){if(alive.current&&!controller.signal.aborted&&current===requestId.current)setAIError(message(reason))}
    finally{if(alive.current&&current===requestId.current){pending.current=null;setBusy(false)}}
  }
  function adoptAI() {
    if(!suggestion||!draft||!analysis||suggestion.revision!==revision.current||suggestion.fingerprint!==analysis.fingerprint)return
    try{
      const next=validateVideoScriptDraft({...draft,title:suggestion.value.title,notes,shots:suggestion.value.shots.map(shot=>({...shot,confirmed:false}))},analysis)
      commit(next,'已采用 AI 建议，所有镜头需要重新确认；可撤销恢复人工草稿。');setActiveShotId(next.shots[0]?.id||null)
    }catch(reason){setAIError(message(reason))}
  }
  function exportDraft(kind:'json'|'markdown') {
    if(!draft||!analysis||!draftCurrent||validationError)return
    const valid=validateVideoScriptDraft(draft,analysis),filename=clipboardSafeName(valid.title)
    download(`${filename}.${kind==='json'?'json':'md'}`,kind==='json'?JSON.stringify({schema:'cqai-track-video-script@1',analysis,draft:valid},null,2):videoScriptMarkdown(valid,analysis),kind==='json'?'application/json':'text/markdown')
  }

  return <section className="trk-video-script" aria-label="轨迹视频脚本制作台"><style>{VIDEO_SCRIPT_CSS}</style>
    {navigation.dialog}
    <header className="trk-vs-header"><div><h2>轨迹视频脚本</h2><p className="trk-muted">先看轨迹能讲什么，再选择镜头、编辑脚本并逐镜确认。</p></div><div className="trk-vs-actions">{onBack&&<button className="trk-secondary" disabled={busy} onClick={()=>navigation.requestLeave(onBack)}>返回镜头编辑</button>}<button className="trk-secondary" disabled={busy} onClick={()=>navigation.requestLeave(onCancel)}>返回轨迹</button></div></header>
    <VideoResourceSelections trackId={track.id} trackName={track.name}/>
    <nav className="trk-vs-steps" aria-label="脚本制作步骤"><button className={step==='information'?'trk-primary':'trk-secondary'} aria-current={step==='information'?'step':undefined} onClick={()=>{setStep('information');setReplaceRequested(false)}}>1 · 分析信息与选题</button><button className={step==='script'?'trk-primary':'trk-secondary'} aria-current={step==='script'?'step':undefined} disabled={!draft} onClick={()=>setStep('script')}>2 · 镜头与脚本审阅</button></nav>
    <div className="trk-vs-map">{active&&<MapView trackId={track.id} points={track.coordinates} segmentStarts={track.segmentStarts} name={track.name} basemap={basemap} onBasemap={onBasemap} placemarks={mapPoints} selectedPlacemark={selectedPlacemark} onSelectPlacemark={setSelectedPlacemark} onClosePlacemark={()=>setSelectedPlacemark(null)} placemarkEditingDisabled />}</div>
    <p className="trk-muted trk-vs-map-note">地图用于核对轨迹和选题位置；下方是镜头计划，实际运镜视频尚未生成。</p>
    <p className="trk-vs-save" role="status" aria-live="polite">{saveState}</p>
    {cacheNotice&&<p className="trk-vs-notice">{cacheNotice}</p>}
    {(!sourcesReady||analysisRequested)&&<div className="trk-vs-notice" role="status">正在读取已保存的轨迹点位与标注，完成后进行本地信息分析。</div>}
    {(annotationError||placemarks.error||placemarks.stateError||analysisError)&&<div className="trk-error" role="alert">{annotationError||placemarks.error||placemarks.stateError||analysisError}<button className="trk-secondary" onClick={()=>{setAnnotationReady(false);setAnalysisError('');setReplaceRequested(false);placemarks.retry();setReadAttempt(value=>value+1);setAnalysisRequested(true)}}>重新读取并分析</button></div>}
    {analysis&&step==='information'&&<>
      <div className="trk-vs-section-head"><div><h3>这条轨迹可以拆出哪些内容</h3><p className="trk-muted">分析依据来自当前轨迹、已保存点位和标注；待补充内容不会自动进入脚本。</p></div><button className="trk-secondary" disabled={!sourcesReady||analysisRequested} onClick={()=>{clearProposal();setAnnotationReady(false);setAnalysisError('');setReplaceRequested(false);placemarks.retry();setReadAttempt(value=>value+1);setAnalysisRequested(true)}}>重新读取并分析</button></div>
      <ul className="trk-vs-summary" aria-label="轨迹分析摘要">{analysis.summary.map((line,index)=><li key={index}>{line}</li>)}</ul>
      {analysis.limitations.length>0&&<details className="trk-vs-limits" open><summary>分析范围与待核实信息</summary><ul>{analysis.limitations.map((line,index)=><li key={index}>{line}</li>)}</ul></details>}
      <div className="trk-vs-candidates">{analysis.candidates.map(candidate=><article className={`trk-vs-candidate ${candidate.readiness==='needs-info'?'needs-info':''}`} key={candidate.id} data-candidate-id={candidate.id}>
        <div className="trk-vs-card-title"><label className="trk-vs-check"><input type="checkbox" aria-label={`选择选题：${candidate.title}`} checked={selectedIds.includes(candidate.id)} disabled={candidate.readiness!=='ready'||!sourcesReady||analysisRequested||(!selectedIds.includes(candidate.id)&&selectedIds.length>=MAX_VIDEO_SHOTS)} onChange={()=>toggleCandidate(candidate.id)}/><strong>{candidate.title}</strong></label><span className="trk-vs-badge">{candidate.readiness==='ready'?'可采用':'待补充'}</span></div>
        <dl><dt>已知事实</dt><dd>{candidate.facts.length?candidate.facts.map((fact,index)=><p key={index}>{fact}</p>):'当前数据不能直接确认。'}</dd><dt>依据</dt><dd>{candidate.evidence.map((source,index)=><p key={index}>{source}</p>)}</dd><dt>画面建议</dt><dd>{candidate.visual}</dd><dt>运镜建议</dt><dd>{candidate.camera||'采用后可补充运镜。'}</dd>{candidate.missing.length>0&&<><dt>需要补充</dt><dd className="trk-vs-missing">{candidate.missing.map((item,index)=><p key={index}>{item}</p>)}</dd></>}</dl>
        {candidate.target&&<button className="trk-secondary" onClick={()=>locate(candidate)} aria-label={`地图定位：${candidate.title}`}>在地图上定位</button>}
      </article>)}</div>
      <label className="trk-vs-notes">影片目标与补充要求<textarea aria-label="影片目标与补充要求" maxLength={4000} value={notes} onChange={event=>{clearProposal();setNotes(event.target.value)}} placeholder="例如：介绍路线与周围地形；先全景，再讲湖泊和爬升。不确定的山名先保留待核实。"/></label>
      <div className="trk-vs-actions"><span>已选择 {selectedIds.length} / {MAX_VIDEO_SHOTS} 个内容镜头</span><button className="trk-primary" disabled={!sourcesReady||analysisRequested||selectedCandidates.length<1||selectedCandidates.length>MAX_VIDEO_SHOTS} onClick={build}>确认选题，建立脚本草稿</button>{draft&&<button className="trk-secondary" onClick={()=>setStep('script')}>继续编辑现有草稿</button>}</div>
      {replaceRequested&&<div className="trk-vs-notice" role="alert"><p>采用新选题会替换当前草稿的镜头和人工修改。原稿可通过撤销恢复。</p><div className="trk-vs-actions"><button className="trk-primary" onClick={establish}>采用新选题，替换草稿</button><button className="trk-secondary" onClick={()=>{setReplaceRequested(false);setStep('script')}}>保留现有草稿</button></div></div>}
    </>}
    {analysis&&draft&&step==='script'&&<>
      <div className="trk-vs-section-head"><div><h3>逐镜审阅与修改</h3><p>共 {draft.shots.length} 镜 · 计划时长 {totalDuration} 秒 · 已确认 {confirmedCount} / {draft.shots.length}</p></div><div className="trk-vs-actions"><button className="trk-secondary" disabled={!history.past.length} onClick={()=>replay('undo')}>撤销最近修改</button><button className="trk-secondary" disabled={!history.future.length} onClick={()=>replay('redo')}>恢复最近修改</button></div></div>
      {!draftCurrent&&<div className="trk-vs-notice" role="alert">当前草稿与重新分析结果不一致。请返回选题并明确建立新稿；原草稿不会被自动覆盖。</div>}
      {validationError&&<p className="trk-error" role="alert">{validationError}</p>}
      <label>影片标题<input aria-label="影片标题" maxLength={160} disabled={!draftCurrent} value={draft.title} onChange={event=>commit({...draft,title:event.target.value})}/></label>
      <div className="trk-vs-editor-layout"><ol className="trk-vs-shot-list" aria-label="脚本镜头列表">{draft.shots.map((shot,index)=><li key={shot.id} data-shot-id={shot.id} className={activeShot?.id===shot.id?'active':''}><button className="trk-vs-shot-select" onClick={()=>{setActiveShotId(shot.id);setSelectedPlacemark(null)}} aria-pressed={activeShot?.id===shot.id}><span>{index+1}. {shot.title}</span><small>{shot.duration} 秒 · {shot.confirmed?'已确认':'待确认'}</small></button><div className="trk-vs-shot-tools"><button className="trk-secondary" aria-label={`上移镜头 ${index+1}`} disabled={!draftCurrent||index===0} onClick={()=>moveShot(index,-1)}>上移</button><button className="trk-secondary" aria-label={`下移镜头 ${index+1}`} disabled={!draftCurrent||index===draft.shots.length-1} onClick={()=>moveShot(index,1)}>下移</button><button className="trk-secondary" aria-label={`删除镜头 ${index+1}`} disabled={!draftCurrent||draft.shots.length<=1} onClick={()=>removeShot(shot.id)}>删除</button></div></li>)}</ol>
        {activeShot&&<article className="trk-vs-shot-editor" aria-label="当前镜头脚本"><h4>镜头 {draft.shots.findIndex(shot=>shot.id===activeShot.id)+1} · {activeShot.confirmed?'已确认':'待确认'}</h4>
          {activeCandidate&&<details><summary>查看该镜头的事实依据</summary><ul>{[...activeCandidate.facts,...activeCandidate.evidence,...activeCandidate.missing].map((line,index)=><li key={index}>{line}</li>)}</ul></details>}
          <div className="trk-vs-actions">{targetId&&<button className="trk-secondary" onClick={()=>setSelectedPlacemark(targetId)}>在地图上定位当前镜头</button>}</div><fieldset disabled={!draftCurrent}><legend className="trk-vs-sr-only">当前镜头的可编辑字段</legend>
            <div className="trk-vs-fields"><label>镜头标题<input aria-label="镜头标题" maxLength={160} value={activeShot.title} onChange={event=>patchShot(activeShot.id,{title:event.target.value})}/></label><label>镜头时长（秒，3–120）<input aria-label="镜头时长" type="number" min={3} max={120} value={Number.isFinite(activeShot.duration)?activeShot.duration:''} onChange={event=>patchShot(activeShot.id,{duration:event.target.valueAsNumber})}/></label></div>
            <label>画面内容<textarea aria-label="画面内容" maxLength={1600} value={activeShot.visual} onChange={event=>patchShot(activeShot.id,{visual:event.target.value})}/></label>
            <label>相机与运镜<textarea aria-label="相机与运镜" maxLength={1000} value={activeShot.camera} onChange={event=>patchShot(activeShot.id,{camera:event.target.value})}/></label>
            <label>对应旁白脚本<textarea aria-label="对应旁白脚本" maxLength={1200} value={activeShot.narration} onChange={event=>patchShot(activeShot.id,{narration:event.target.value})}/></label>
            <label>屏幕文字<textarea aria-label="屏幕文字" maxLength={600} value={activeShot.onScreenText} onChange={event=>patchShot(activeShot.id,{onScreenText:event.target.value})}/></label>
            <label>所需素材（每行一项）<textarea aria-label="所需素材" maxLength={15000} value={activeShot.materials.join('\n')} onChange={event=>patchShot(activeShot.id,{materials:event.target.value.split('\n')})}/></label>
          </fieldset>
          <p className="trk-muted">确认的是这一镜头的计划与文案。实际地图运镜、配音和片段制作留到后续阶段。</p><button className="trk-primary" disabled={!draftCurrent||!!validationError||activeShot.confirmed} onClick={()=>confirmShot(activeShot.id)}>{activeShot.confirmed?'当前镜头已确认':'确认当前镜头'}</button>
        </article>}
      </div>
      {editNotice&&<p role="status" aria-live="polite" className="trk-vs-notice">{editNotice}</p>}
      <details className="trk-vs-ai"><summary>可选：让 AI 提出脚本文案建议</summary><p className="trk-muted">点击后发送路线摘要、已选镜头的事实与文字说明、目标坐标和补充要求。不会发送完整轨迹、原始文件或照片。结果先供审阅，采用后才修改草稿。</p>
        <div className="trk-vs-actions"><label>脚本文案模型<select aria-label="脚本文案模型" value={model} disabled={busy} onChange={event=>{clearProposal();setModel(event.target.value)}}><option value="">请选择文本模型</option>{catalog?.models.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><button className="trk-secondary" onClick={reload} disabled={busy}>刷新模型</button></div>
        <label>影片目标与补充要求<textarea aria-label="脚本文案补充要求" maxLength={4000} disabled={!draftCurrent} value={notes} onChange={event=>{setNotes(event.target.value);commit({...draft,notes:event.target.value})}}/></label>
        {catalog&&!catalog.available&&<p className="trk-muted">{catalog.message||'文本模型暂不可用；仍可手工编辑脚本。'}</p>}
        <div className="trk-vs-actions"><button className="trk-secondary" disabled={!draftCurrent||!!validationError||!model||!catalog?.available||busy} onClick={()=>void askAI()}>{busy?'正在生成建议…':'AI 提出脚本建议'}</button>{busy&&<button className="trk-secondary" onClick={clearProposal}>取消 AI 建议</button>}</div>
        {aiError&&<p className="trk-error" role="alert">{aiError}；人工草稿保留，可重试。</p>}
        {suggestion&&<article className="trk-vs-ai-proposal" aria-label="待采用的 AI 建议"><h4>建议：{suggestion.value.title}</h4><ol>{suggestion.value.shots.map(shot=><li key={shot.id}><strong>{shot.title} · {shot.duration} 秒</strong><p>{shot.visual}</p><p>运镜：{shot.camera}</p><p>旁白：{shot.narration||'无旁白'}</p><p>屏幕文字：{shot.onScreenText||'无'}</p></li>)}</ol><div className="trk-vs-actions"><button className="trk-primary" onClick={adoptAI}>采用 AI 建议</button><button className="trk-secondary" onClick={()=>setSuggestion(null)}>保留人工草稿</button></div></article>}
      </details>
      <div className="trk-vs-actions trk-vs-export"><button className="trk-secondary" onClick={()=>setStep('information')}>返回选题</button><button className="trk-secondary" disabled={!draftCurrent||!!validationError} onClick={()=>exportDraft('json')}>导出脚本 JSON</button><button className="trk-secondary" disabled={!draftCurrent||!!validationError} onClick={()=>exportDraft('markdown')}>导出脚本 Markdown</button><span className="trk-muted">{confirmedCount===draft.shots.length?'全部镜头计划已确认。':'未确认镜头会在导出中保留待确认状态。'}</span></div>
    </>}
  </section>
}
function message(reason:unknown):string {return reason instanceof Error?reason.message:'操作失败，请重试'}
const VIDEO_SCRIPT_CSS=`
.trk-video-script{color:var(--trk-text);font:inherit;min-width:0;line-height:1.6}.trk-video-script *{box-sizing:border-box}.trk-vs-header,.trk-vs-section-head{display:flex;align-items:start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}.trk-video-script h2,.trk-video-script h3,.trk-video-script h4{margin:0 0 8px}.trk-video-script h2{font-size:calc(var(--trk-font-size)*1.5714)}.trk-video-script p{margin:6px 0 10px;overflow-wrap:anywhere}.trk-video-script button{min-height:44px;max-width:100%;white-space:normal;overflow-wrap:anywhere}.trk-video-script label{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}.trk-video-script input:not([type=checkbox]),.trk-video-script textarea,.trk-video-script select{width:100%;min-width:0;min-height:44px;padding:9px 11px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);font:inherit;color:var(--trk-text);background:var(--trk-bg)}.trk-video-script textarea{min-height:85px;resize:vertical}.trk-video-script input[type=checkbox]{width:19px;height:19px;flex:none;accent-color:var(--trk-accent)}.trk-video-script input:disabled,.trk-video-script textarea:disabled{opacity:.65}.trk-video-script fieldset{border:0;padding:0;margin:16px 0;min-width:0}.trk-vs-steps,.trk-vs-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.trk-vs-steps{margin-bottom:16px}.trk-vs-map{height:310px;min-height:240px;overflow:hidden;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md)}.trk-vs-map>.trk-map-wrap{height:100%;min-height:0}.trk-vs-map-note{font-size:.92em}.trk-vs-save{font-size:.92em;color:var(--trk-muted)}.trk-vs-notice{padding:12px 14px;border:1px solid var(--trk-notice-border);background:var(--trk-notice-bg);color:var(--trk-notice);border-radius:var(--trk-radius-sm);margin:12px 0;overflow-wrap:anywhere}.trk-vs-summary{display:flex;gap:8px;flex-wrap:wrap;list-style:none;padding:0}.trk-vs-summary li{padding:8px 12px;border:1px solid var(--trk-border);background:var(--trk-surface);border-radius:var(--trk-radius-sm)}.trk-vs-limits{margin:16px 0}.trk-video-script summary{cursor:pointer;min-height:44px;padding:9px 0;font-weight:600}.trk-video-script li{overflow-wrap:anywhere}.trk-vs-candidates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:18px 0}.trk-vs-candidate,.trk-vs-shot-editor,.trk-vs-ai{background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);padding:16px;min-width:0}.trk-vs-candidate.needs-info{border-style:dashed}.trk-vs-card-title{display:flex;justify-content:space-between;align-items:start;gap:12px}.trk-video-script .trk-vs-check{flex-direction:row;align-items:start;gap:10px;min-height:44px;margin-bottom:4px;cursor:pointer}.trk-vs-check strong{overflow-wrap:anywhere}.trk-vs-badge{font-size:.85em;white-space:nowrap;border:1px solid var(--trk-border);border-radius:20px;padding:2px 9px;color:var(--trk-muted)}.trk-vs-candidate dl{margin:8px 0 16px}.trk-vs-candidate dt{font-size:.9em;color:var(--trk-muted);margin:12px 0 2px}.trk-vs-candidate dd{margin:0;overflow-wrap:anywhere}.trk-vs-candidate dd p{margin:2px 0}.trk-vs-missing{color:var(--trk-warning)}.trk-vs-notes{margin:18px 0}.trk-vs-editor-layout{display:grid;grid-template-columns:minmax(220px,30%) minmax(0,1fr);gap:18px;margin:18px 0}.trk-vs-shot-list{list-style:none;margin:0;padding:0;align-self:start;display:grid;gap:10px}.trk-vs-shot-list li{border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:10px;min-width:0}.trk-vs-shot-list li.active{border-color:var(--trk-accent);background:var(--trk-hover)}.trk-vs-shot-select{display:flex;width:100%;flex-direction:column;text-align:left;gap:4px;padding:6px;background:transparent;border:0;color:var(--trk-text);font:inherit;cursor:pointer}.trk-vs-shot-select small{color:var(--trk-muted)}.trk-vs-shot-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.trk-vs-shot-tools button{flex:1;padding:6px}.trk-vs-fields{display:grid;grid-template-columns:minmax(0,1fr) 180px;gap:12px}.trk-vs-ai{margin:18px 0}.trk-vs-ai .trk-vs-actions label{min-width:200px;flex:1;max-width:450px}.trk-vs-ai-proposal{margin:14px 0;padding:14px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm)}.trk-vs-ai-proposal li{margin-bottom:16px}.trk-vs-export{margin:20px 0}.trk-vs-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.trk-video-script .trk-error button{margin-left:12px}@media(max-width:800px){.trk-vs-candidates,.trk-vs-editor-layout{grid-template-columns:minmax(0,1fr)}.trk-vs-map{height:270px}.trk-vs-shot-list{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.trk-vs-fields,.trk-vs-shot-list{grid-template-columns:minmax(0,1fr)}.trk-vs-steps button{flex:1}.trk-vs-candidate,.trk-vs-shot-editor,.trk-vs-ai{padding:12px}.trk-vs-map{height:240px}}
`
