import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { ANNOTATION_COLORS, ANNOTATION_KINDS, ART_TEXT_LABELS, artTextPosition, annotationPhotoLayouts, annotationPosition, annotationTextColor, annotationVisible, diagramCoordinates, routeCanvasSvg, routeSvg, trackSvg, validateAnnotations, validateArtLayout, validateArtRouteTransform, validateArtCanvasSize, fitArtRouteToCanvas, type ArtCanvasSize, type ArtRouteTransform, type ArtLayout, type ArtTextId, type AnnotationKind, type TrackAnnotation } from '../track/annotations.ts'
import { placemarkTypes } from '../track/placemark-edits.ts'
import { formatPlacemarkCoordinates, formatPlacemarkElevation, formatPlacemarkTime } from '../track/placemark-format.ts'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'
import { PlacemarkPhotoViewer } from './PlacemarkPhotoViewer.tsx'
import { usePlacemarkPhotoThumbnail } from './usePlacemarkPhotoThumbnail.ts'
import { AnnotationCanvas, type AnnotationCanvasHandle } from './AnnotationCanvas.tsx'
import { ArtCanvasViewport, type ArtCanvasViewportHandle } from './ArtCanvasViewport.tsx'
import { readAnnotationPhoto, readLinkedAnnotationPhoto } from './annotation-photo.ts'
import { loadTrackPlacemarkState } from './useTrackPlacemarks.ts'
import { annotationPlacemarkNodes, initialPlacemarkAnnotations, projectPlacemarkAnnotations, mergePlacemarkAnnotationEdits, type AnnotationPlacemarkState } from '../track/annotation-placemarks.ts'
import { api, clipboardSafeName, download } from './util.ts'
import {storeAnnotationImage, type AnnotationImageSnapshot} from './annotation-resource.ts'
import {getArtElementStyle, getArtTextStyle, getArtRouteStyle, getArtBackground, validateArtStyles, type ArtStyles} from '../track/art-styles.ts'
import {ElementStyleControls, TextStyleControls, GlobalStyleControls} from './ArtStyleControls.tsx'

const CANVAS_PRESETS=[{id:'4:3',label:'4:3 横版',width:1200,height:900},{id:'1:1',label:'1:1 方形',width:1200,height:1200},{id:'16:9',label:'16:9 宽屏',width:1600,height:900},{id:'3:4',label:'3:4 竖版',width:900,height:1200},{id:'9:16',label:'9:16 竖屏',width:900,height:1600}]
type ArtDraft = {annotations:TrackAnnotation[];layout:ArtLayout;route:ArtRouteTransform;canvas:ArtCanvasSize;styles:ArtStyles}
type History = {past:ArtDraft[];present:ArtDraft;future:ArtDraft[]}
const emptyDraft=():ArtDraft=>({annotations:[],layout:{},route:validateArtRouteTransform(undefined),canvas:validateArtCanvasSize(undefined),styles:validateArtStyles(undefined)})
export type TrackArtState = {dirty:boolean;busy:boolean}
export function TrackArt({track,onCancel,embedded=false,active:isActive=true,onStateChange}: {track:TrackRecord;basemap:BasemapId;onBasemap:(next:BasemapId)=>void;onCancel:()=>void;embedded?:boolean;active?:boolean;onStateChange?:(state:TrackArtState)=>void}) {
  const [history,setHistory]=useState<History>({past:[],present:emptyDraft(),future:[]})
  const {annotations,layout,route,canvas,styles}=history.present
  const latestAnnotations=useRef(annotations);latestAnnotations.current=annotations
  const [sourceState,setSourceState]=useState<AnnotationPlacemarkState|null>(null),[sourceLoading,setSourceLoading]=useState(false),[sourceError,setSourceError]=useState('')
  const sourceGeneration=useRef(0)
  const displayedAnnotations=useMemo(()=>sourceState?projectPlacemarkAnnotations(annotations,sourceState,track.coordinates):[],[annotations,sourceState,track.coordinates])
  const latestDisplayed=useRef(displayedAnnotations);latestDisplayed.current=displayedAnnotations
  const [baseline,setBaseline]=useState(JSON.stringify(emptyDraft())),[ready,setReady]=useState(false),[loading,setLoading]=useState(false)
  const [largePhoto,setLargePhoto]=useState<{url:string;name:string}|null>(null)
  const [selectedId,setSelectedId]=useState<string|null>(null),[drawer,setDrawer]=useState(false),[adding,setAdding]=useState(false)
  const [selectedTextId,setSelectedTextId]=useState<ArtTextId|null>(null),[textDrawer,setTextDrawer]=useState(false)
  const textSelect=useRef<HTMLSelectElement>(null)
  const [styleDrawer,setStyleDrawer]=useState(false)
  const styleHeading=useRef<HTMLHeadingElement>(null)
  const [name,setName]=useState(''),[link,setLink]=useState(''),[saving,setSaving]=useState(false),[savingTarget,setSavingTarget]=useState<'canvas'|'image'|null>(null),[photoBusy,setPhotoBusy]=useState(false)
  const [error,setError]=useState(''),[photoError,setPhotoError]=useState(''),[note,setNote]=useState(''),[discard,setDiscard]=useState(false),[zoom,setZoom]=useState(100),[canvasTool,setCanvasTool]=useState<'select'|'pan'>('select')
  const [pendingImage,setPendingImage]=useState<AnnotationImageSnapshot|null>(null)
  const [widthDraft,setWidthDraft]=useState('1200'),[heightDraft,setHeightDraft]=useState('900'),[sizeError,setSizeError]=useState('')
  const saveInFlight=useRef<number|null>(null)
  const alive=useRef(true),generation=useRef(0),nameInput=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null),drawerElement=useRef<HTMLElement>(null),previousFocus=useRef<HTMLElement|null>(null)
  const isActiveRef=useRef(isActive),stateChangeRef=useRef(onStateChange);isActiveRef.current=isActive;stateChangeRef.current=onStateChange
  const camera=useRef<ArtCanvasViewportHandle>(null),overlay=useRef<AnnotationCanvasHandle>(null),routePreview=useRef(route)
  const active=displayedAnnotations.find(item=>item.id===selectedId)
  const defaultElementStyle=getArtElementStyle({id:'style-default',pointIndex:0,label:'',color:ANNOTATION_COLORS[0]},styles)
  const activeStyle=active?getArtElementStyle(active,styles):null
  const sourceNode=useMemo(()=>active?.sourceId&&sourceState?annotationPlacemarkNodes(sourceState).find(node=>node.id===active.sourceId):undefined,[active?.sourceId,sourceState])
  const sourceTypes=sourceNode?placemarkTypes(sourceNode).join(' · '):''
  const visibleCount=displayedAnnotations.filter(annotationVisible).length
  const dirty=JSON.stringify(history.present)!==baseline
  const nameInvalid=drawer&&active&&!active.sourceId&&(!name.trim()||Array.from(name).length>80)
  const draftDirty=dirty||Boolean(nameInvalid),busy=saving||photoBusy
  const drawing=useMemo(()=>{
    try{return {svg:trackSvg(track.coordinates,{name:track.name,annotations:sourceLoading||sourceError?[]:displayedAnnotations,layout,route,canvas,styles,theme:'paper',selectedId,selectedTextId,interactive:true,layer:'overlay'}),routeSvg:routeCanvasSvg(track.coordinates,{theme:'paper',styles}),error:''}}
    catch(reason){return {svg:'',routeSvg:'',error:message(reason)}}
  },[track.coordinates,track.name,displayedAnnotations,layout,route,canvas,styles,selectedId,selectedTextId,sourceLoading,sourceError])

  async function loadAnnotations() {
    const current=++generation.current;setLoading(true);setReady(false);setError('');setSourceState(null);setSourceError('');setPendingImage(null);setSaving(false);setSavingTarget(null);saveInFlight.current=null
    try{
      const [result,source]=await Promise.all([api<{annotations:TrackAnnotation[];layout?:ArtLayout;route?:ArtRouteTransform;canvas?:ArtCanvasSize;canvasSaved?:boolean;saved?:boolean;styles?:ArtStyles}>(`annotations?id=${encodeURIComponent(track.id)}`),loadTrackPlacemarkState(track)])
      let next=validateAnnotations(result.annotations,track.coordinates.length),hint=''
      const nextLayout=validateArtLayout(result.layout),nextCanvas=validateArtCanvasSize(result.canvas),nextStyles=validateArtStyles(result.styles)
      let nextRoute=validateArtRouteTransform(result.route)
      const stored=JSON.stringify({annotations:next,layout:nextLayout,route:nextRoute,canvas:nextCanvas,styles:nextStyles})
      if(!next.length&&!result.saved){
        next=validateAnnotations(initialPlacemarkAnnotations(source,track.coordinates),track.coordinates.length)
        if(next.length)hint=`已带入 ${next.length} 个显示点位，分组仅展示分组节点，可选择图片并调整画布。`
      }
      if(result.canvasSaved===false||result.saved===false)nextRoute=fitArtRouteToCanvas(track.coordinates,projectPlacemarkAnnotations(next,source,track.coordinates),nextCanvas,nextStyles)
      if(!alive.current||current!==generation.current)return
      setSourceState(source);routePreview.current=nextRoute;setHistory({past:[],present:{annotations:next,layout:nextLayout,route:nextRoute,canvas:nextCanvas,styles:nextStyles},future:[]});setBaseline(stored);setReady(true);setNote(hint)
    }catch(reason){if(alive.current&&current===generation.current)setError('读取点位失败：'+message(reason))}
    finally{if(alive.current&&current===generation.current)setLoading(false)}
  }
  useEffect(()=>{alive.current=true;void loadAnnotations();return()=>{alive.current=false;generation.current++}},[track.id])
  async function refreshSource() {
    const current=++sourceGeneration.current;setSourceLoading(true);setSourceError('')
    try {const source=await loadTrackPlacemarkState(track);if(alive.current&&current===sourceGeneration.current)setSourceState(source)}
    catch(reason) {if(alive.current&&current===sourceGeneration.current)setSourceError('读取点位显示状态失败：'+message(reason))}
    finally {if(alive.current&&current===sourceGeneration.current)setSourceLoading(false)}
  }
  useEffect(()=>{
    if(!isActive||!ready)return
    void refreshSource()
    return()=>{sourceGeneration.current++}
  },[track.id,isActive,ready])
  useEffect(()=>{setWidthDraft(String(canvas.width));setHeightDraft(String(canvas.height));setSizeError('')},[canvas.width,canvas.height])
  useEffect(()=>{setName(active?.label||'')},[selectedId,active?.label])
  useEffect(()=>{setLink('');setPhotoError('')},[selectedId])
  useEffect(()=>{stateChangeRef.current?.({dirty:draftDirty,busy})},[draftDirty,busy])
  useEffect(()=>{
    if((!drawer&&!textDrawer&&!styleDrawer)||!isActiveRef.current)return
    previousFocus.current=document.activeElement as HTMLElement
    if(styleDrawer)styleHeading.current?.focus();else if(textDrawer)textSelect.current?.focus();else nameInput.current?.focus()
    return()=>{const target=previousFocus.current;if(isActiveRef.current&&target?.isConnected)target.focus()}
  },[drawer,textDrawer,styleDrawer,selectedId,selectedTextId])
  useEffect(()=>{
    if(!selectedId||!isActiveRef.current)return
    const row=list.current?.querySelector<HTMLElement>(`[data-point-id="${selectedId}"]`)
    row?.scrollIntoView?.({block:'nearest'})
  },[selectedId])
  useEffect(()=>{
    if(embedded||!dirty)return
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)
  },[dirty,embedded])

  function commit(next:TrackAnnotation[],nextLayout:ArtLayout=layout,nextRoute:ArtRouteTransform=camera.current?.getView()??route,nextCanvas:ArtCanvasSize=canvas,nextStyles:ArtStyles=styles) {
    if(!ready||saving||photoBusy)return
    try{
      const valid:ArtDraft={annotations:validateAnnotations(next,track.coordinates.length),layout:validateArtLayout(nextLayout),route:validateArtRouteTransform(nextRoute),canvas:validateArtCanvasSize(nextCanvas),styles:validateArtStyles(nextStyles)}
      setHistory(current=>JSON.stringify(current.present)===JSON.stringify(valid)?current:{past:[...current.past,current.present].slice(-40),present:valid,future:[]});setError('');setNote('')
    }catch(reason){setError(message(reason))}
  }
  function commitDisplayed(next:TrackAnnotation[],nextLayout:ArtLayout=layout,nextRoute:ArtRouteTransform=camera.current?.getView()??route) {
    commit(mergePlacemarkAnnotationEdits(annotations,displayedAnnotations,next),nextLayout,nextRoute)
  }
  function update(patch:Partial<TrackAnnotation>) {
    if(!active)return
    // Linked information is edited in the point editor; these controls only change artwork.
    const {label,description,imageUrls,sourceId,sourceCoordinates,pointIndex,kind,...presentation}=patch
    const allowed=active.sourceId?presentation:patch
    commitDisplayed(displayedAnnotations.map(item=>item.id===active.id?{...item,...allowed}:item))
  }
  function select(id:string,options?:{openEditor?:boolean}) {setStyleDrawer(false);setSelectedTextId(null);setTextDrawer(false);setSelectedId(id);setName(displayedAnnotations.find(item=>item.id===id)?.label||'');setDrawer(options?.openEditor!==false);setAdding(false);setError('');setPhotoError('')}
  function selectText(id:ArtTextId,options?:{openEditor?:boolean}) {setStyleDrawer(false);setSelectedTextId(id);setSelectedId(null);setDrawer(false);setTextDrawer(options?.openEditor!==false);setAdding(false);setError('');setPhotoError('')}
  function closeDrawer() {setDrawer(false);setTextDrawer(false);setStyleDrawer(false);setPhotoError('')}
  function resetTextPosition() {if(!selectedTextId)return;const next={...layout};delete next[selectedTextId];commit(annotations,next)}
  function startAdd() {setCanvasTool('select');setAdding(true);closeDrawer();setSelectedTextId(null);setError('');setNote('在左侧画布点击位置，放置新点位。普通标注默认隐藏，可在点位编辑中开启显示。')}
  function resetView() {camera.current?.reset();setZoom(100)}
  function routePosition(index:number) {const [x,y]=diagramCoordinates(track.coordinates)[index],view=camera.current?.getView()??routePreview.current;return {x:(x+view.x)*view.scale,y:(y+view.y)*view.scale}}
  function add(position:{x:number;y:number}) {
    if(!ready||saving||annotations.length>=100)return
    const projected=diagramCoordinates(track.coordinates),view=camera.current?.getView()??routePreview.current,source={x:position.x/view.scale-view.x,y:position.y/view.scale-view.y};let pointIndex=0,distance=Infinity
    projected.forEach(([x,y],index)=>{const next=Math.hypot(source.x-x,source.y-y);if(next<distance){distance=next;pointIndex=index}})
    const id=crypto.randomUUID()
    commit([...annotations,{id,pointIndex,label:`点位 ${annotations.length+1}`,color:ANNOTATION_COLORS[0],position:{x:Math.max(24,Math.min(1176,source.x)),y:Math.max(120,Math.min(9000,source.y))}}])
    select(id)
  }
  async function attach(file:File|string) {
    if(!active||photoBusy||saving)return
    const id=active.id;setPhotoBusy(true);setPhotoError('')
    try{
      const dataUrl=typeof file==='string'?await readLinkedAnnotationPhoto(file, track.id):await readAnnotationPhoto(file)
      if(!alive.current)return
      if(!latestDisplayed.current.some(item=>item.id===id))return
      const next=latestDisplayed.current.map(item=>item.id===id?{...item,photo:{...item.photo,dataUrl,...(typeof file==='string'?{sourceUrl:file}:{sourceUrl:undefined})}}:item)
      const layout=annotationPhotoLayouts(next,track.coordinates,styles).find(item=>item.annotation.id===id)!
      const normalized=validateAnnotations(next.map(item=>item.id===id?{...item,photo:{...item.photo!,x:layout.x,y:layout.y}}:item),track.coordinates.length)
      const merged=validateAnnotations(mergePlacemarkAnnotationEdits(latestAnnotations.current,latestDisplayed.current,normalized),track.coordinates.length)
      setHistory(current=>({past:[...current.past,current.present].slice(-40),present:{...current.present,annotations:merged},future:[]}))
    }catch(reason){if(alive.current)setPhotoError('图片未添加：'+message(reason)+'。可尝试上传本地图片。')}
    finally{if(alive.current)setPhotoBusy(false)}
  }
  function exportArtwork() {
    return trackSvg(track.coordinates,{name:track.name,annotations:displayedAnnotations,layout,route:camera.current?.getView()??routePreview.current,canvas,styles,theme:'paper',annotationsOnly:true})
  }
  function applyCanvas(next:ArtCanvasSize) {
    try {
      const size=validateArtCanvasSize(next),fitted=fitArtRouteToCanvas(track.coordinates,displayedAnnotations,size,styles)
      commit(annotations,layout,fitted,size);setSizeError('')
    }catch(reason){setSizeError(message(reason))}
  }
  async function addSavedImage(snapshot:AnnotationImageSnapshot,current:number) {
    try {
      await storeAnnotationImage(snapshot)
      if(alive.current&&current===generation.current){setPendingImage(null);setNote('PNG 标注图已保存到资源库。')}
    } catch(reason) {
      if(alive.current&&current===generation.current){setPendingImage(snapshot);setError('PNG 标注图未保存到资源库：'+message(reason));setNote('')}
    }
  }
  async function saveImageToLibrary(snapshot?:AnnotationImageSnapshot) {
    if(!ready||!sourceState||sourceLoading||sourceError||saveInFlight.current!==null||saving||photoBusy||nameInvalid)return
    const current=generation.current
    saveInFlight.current=current;setSaving(true);setSavingTarget('image');setError('');setNote('')
    try {
      const image=snapshot??{trackId:track.id,name:`${clipboardSafeName(track.name)}-SVG 标注.png`,svg:exportArtwork()}
      await addSavedImage(image,current)
    }catch(reason){if(alive.current&&current===generation.current)setError('PNG 标注图未保存到资源库：'+message(reason))}
    finally{if(saveInFlight.current===current)saveInFlight.current=null;if(alive.current&&current===generation.current)setSaving(false)}
  }
  async function save() {
    if(!ready||!sourceState||sourceLoading||sourceError||saveInFlight.current!==null||saving||photoBusy||nameInvalid)return
    const current=generation.current
    saveInFlight.current=current;setSaving(true);setSavingTarget('canvas');setError('');setNote('')
    try{
      const stored=JSON.parse(baseline) as ArtDraft,currentRoute=validateArtRouteTransform(camera.current?.getView()??routePreview.current)
      const withLayout=Object.keys(layout).length>0||Object.keys(stored.layout).length>0,withRoute=JSON.stringify(currentRoute)!==JSON.stringify(emptyDraft().route)||JSON.stringify(stored.route)!==JSON.stringify(emptyDraft().route)
      const savedAnnotations=validateAnnotations(mergePlacemarkAnnotationEdits(annotations,displayedAnnotations,displayedAnnotations),track.coordinates.length)
      const result=await api<{annotations:TrackAnnotation[];layout?:ArtLayout;route?:ArtRouteTransform;canvas?:ArtCanvasSize;styles?:ArtStyles}>('annotations',{id:track.id,annotations:savedAnnotations,canvas,...(Object.keys(styles).length||Object.keys(stored.styles??{}).length?{styles}:{}),...(withLayout?{layout}:{}),...(withRoute?{route:currentRoute}:{})})
      const next:ArtDraft={annotations:validateAnnotations(result.annotations,track.coordinates.length),layout:validateArtLayout(result.layout??layout),route:validateArtRouteTransform(result.route??currentRoute),canvas:validateArtCanvasSize(result.canvas??canvas),styles:validateArtStyles(result.styles??styles)}
      if(alive.current&&current===generation.current){setHistory(value=>({...value,present:next}));setBaseline(JSON.stringify(next));setNote('画布已保存；可点击「保存到资源库」添加 PNG 标注图。')}
    }catch(reason){if(alive.current&&current===generation.current)setError('保存失败，画布草稿已保留：'+message(reason))}
    finally{if(saveInFlight.current===current)saveInFlight.current=null;if(alive.current&&current===generation.current)setSaving(false)}
  }
  function undo() {setHistory(current=>current.past.length?{past:current.past.slice(0,-1),present:current.past.at(-1)!,future:[current.present,...current.future]}:current);closeDrawer();setAdding(false)}
  function redo() {setHistory(current=>current.future.length?{past:[...current.past,current.present],present:current.future[0],future:current.future.slice(1)}:current);closeDrawer();setAdding(false)}
  function remove() {
    if(!active)return
    const group=sourceState?.groups.find(group=>group.id===active.sourceId)
    const removed=new Set([active.id,...(group?.memberIds||[])])
    commit(annotations.filter(item=>!removed.has(item.id)&&!removed.has(item.sourceId||'')))
    closeDrawer();setSelectedId(null)
  }
  const disabled=!ready||!sourceState||sourceLoading||Boolean(sourceError)||saving||photoBusy
  const textPosition=selectedTextId?artTextPosition(selectedTextId,track.coordinates,displayedAnnotations,layout,styles):[0,0]
  const textLabel=ART_TEXT_LABELS.find(item=>item.id===selectedTextId)?.label||''
  const markerPosition=active?annotationPosition(active,track.coordinates):[0,0]
  const photoPosition=active?.photo?annotationPhotoLayouts(displayedAnnotations,track.coordinates,styles).find(item=>item.annotation.id===active.id):null
  return <section className="trk-art" onKeyDownCapture={event=>{if(!isActive){event.preventDefault();event.stopPropagation()}}}>
    <style>{ART_CSS}</style>
    <header className="trk-art-head"><div><h2>{embedded?'SVG 标注':'轨迹标注'}</h2><p className="trk-muted">{track.name} · 点位信息同步自「标注点编辑」，在此调整标记样式、排版位置和图片布局；画布保存与 PNG 资源入库分别操作。</p></div><div className="trk-art-actions">
      {!embedded&&<button className="trk-secondary" disabled={saving||photoBusy} onClick={()=>dirty?setDiscard(true):onCancel()}>返回概览</button>}
      <button className="trk-secondary" disabled={disabled||!drawing.svg||Boolean(nameInvalid)} onClick={()=>download(`${clipboardSafeName(track.name)}-轨迹标注.svg`,exportArtwork(),'image/svg+xml')}>导出 SVG</button>
      <button className="trk-secondary" disabled={disabled||!drawing.svg} onClick={()=>download(`${clipboardSafeName(track.name)}-纯轨迹.svg`,routeSvg(track.coordinates,{theme:'paper',styles}),'image/svg+xml')}>导出轨迹 SVG</button>
      <button className="trk-secondary" disabled={disabled||!drawing.svg||Boolean(nameInvalid)} onClick={()=>void saveImageToLibrary()}>{saving&&savingTarget==='image'?'入库中…':'保存到资源库'}</button>
      <button className="trk-primary" disabled={disabled||!dirty||Boolean(nameInvalid)} onClick={()=>void save()}>{saving&&savingTarget==='canvas'?'保存中…':'保存画布'}</button>
    </div></header>
    {!embedded&&discard&&<div className="trk-progress" role="alert">画布有未保存的修改。<button className="trk-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button className="trk-secondary" onClick={onCancel}>放弃草稿</button></div>}
    {error&&<div className="trk-error" role="alert">{error}{!ready&&<button className="trk-secondary" disabled={loading} onClick={()=>void loadAnnotations()}>重试读取点位</button>}</div>}
    {pendingImage&&<div className="trk-progress" role="status">上次导出的 PNG 尚未加入资源库。<button className="trk-secondary" disabled={saving||photoBusy} onClick={()=>void saveImageToLibrary(pendingImage)}>重试添加 PNG</button></div>}
    {sourceError&&<div className="trk-error" role="alert">{sourceError}<button className="trk-secondary" onClick={()=>void refreshSource()} disabled={sourceLoading}>重试读取点位</button></div>}
    {note&&<p className="trk-muted" role="status">{note}</p>}
    <div className="trk-art-size" role="group" aria-label="画布设置">
      <label>画布比例<select aria-label="画布比例" disabled={disabled} value={CANVAS_PRESETS.find(item=>Math.abs(item.width/item.height-canvas.width/canvas.height)<.002)?.id??'custom'} onChange={event=>{const preset=CANVAS_PRESETS.find(item=>item.id===event.target.value);if(preset)applyCanvas({width:preset.width,height:preset.height})}}>{CANVAS_PRESETS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">自定义</option></select></label>
      <label>宽度<input aria-label="画布宽度" type="number" min={240} max={4096} step={1} value={widthDraft} disabled={disabled} onChange={event=>setWidthDraft(event.target.value)}/></label>
      <label>高度<input aria-label="画布高度" type="number" min={240} max={4096} step={1} value={heightDraft} disabled={disabled} onChange={event=>setHeightDraft(event.target.value)}/></label>
      <button className="trk-secondary" disabled={disabled} onClick={()=>applyCanvas({width:Number(widthDraft),height:Number(heightDraft)})}>应用尺寸</button>
      <button className="trk-secondary" disabled={disabled} onClick={()=>applyCanvas(canvas)}>适配画布</button><span className="trk-muted">{canvas.width} × {canvas.height} px</span>
    </div>
    {sizeError&&<p className="trk-error" role="alert">{sizeError}</p>}
    <p className="trk-muted trk-art-export-note">导出与资源库图片仅保留轨迹线、标记、配图和连接线。</p>
    <div className="trk-art-toolbar" role="group" aria-label="画布工具">
      <button className="trk-secondary" disabled={disabled} aria-pressed={canvasTool==='select'&&!adding} onClick={()=>{setCanvasTool('select');setAdding(false)}}>选择 / 移动</button>
      <button className="trk-secondary" disabled={disabled} aria-pressed={canvasTool==='pan'} onClick={()=>{setCanvasTool('pan');setAdding(false);closeDrawer()}}>拖动轨迹</button>
      <button className="trk-secondary" disabled={disabled} aria-pressed={styleDrawer} onClick={()=>{closeDrawer();setStyleDrawer(true);setAdding(false);setCanvasTool('select')}}>统一样式</button>
      <button className="trk-secondary" disabled={disabled} aria-pressed={textDrawer} onClick={()=>{setCanvasTool('select');selectText(selectedTextId||'title')}}>画布文字</button>
      <button className="trk-secondary" disabled={disabled||annotations.length>=100} aria-pressed={adding} onClick={startAdd}>添加点位</button>
      <button className="trk-secondary" disabled={disabled||!history.past.length} onClick={undo}>撤销</button><button className="trk-secondary" disabled={disabled||!history.future.length} onClick={redo}>重做</button>
      <label>轨迹缩放<select aria-label="轨迹缩放" disabled={disabled} value={zoom} onChange={event=>camera.current?.zoom(Number(event.target.value)/100)}>{[...new Set([25,50,75,100,125,150,200,400,zoom])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value}%</option>)}</select></label>
      <button className="trk-secondary" disabled={disabled} onClick={resetView}>重置轨迹</button>
      {adding&&<><button className="trk-secondary" onClick={()=>add(routePosition(0))} disabled={disabled}>添加到路线起点</button><button className="trk-secondary" onClick={()=>{setAdding(false);setNote('')}}>取消添加</button></>}
      <span className="trk-muted">拖动文字、标记或照片调整位置 · 拖动空白区域移动轨迹 · 双击添加点位 · 方向键微调</span>
    </div>
    <div className="trk-art-workspace">
      <ArtCanvasViewport ref={camera} background={getArtBackground(styles)} aspectRatio={canvas.width/canvas.height} view={route} disabled={disabled||!isActive} panning={canvasTool==='pan'} adding={adding} onViewChange={view=>{routePreview.current=view;overlay.current?.setRouteView(view)}} onViewCommit={view=>commit(annotations,layout,view)} onScaleChange={scale=>setZoom(Math.round(scale*10000)/100)} overlay={drawing.error?<div className="trk-error">{drawing.error}</div>:<AnnotationCanvas trackId={track.id} ref={overlay} route={route} svg={drawing.svg} points={track.coordinates} annotations={displayedAnnotations} layout={layout} styles={styles} onLayoutChange={next=>commit(annotations,next)} onTextSelect={selectText} onChange={commitDisplayed} onSelect={select} onAdd={add} adding={adding} panning={canvasTool==='pan'} managedPan disabled={disabled||!isActive}/>}>
        {drawing.routeSvg&&<div dangerouslySetInnerHTML={{__html:drawing.routeSvg}}/>}
      </ArtCanvasViewport>
      <aside className="trk-art-sidebar" aria-label="标记点位" aria-hidden={drawer||textDrawer||styleDrawer||undefined}>
        <div className="trk-art-sidebar-head"><h3>标记点位 <small>{visibleCount} / {displayedAnnotations.length} 显示</small></h3><button className="trk-secondary" tabIndex={drawer||textDrawer||styleDrawer?-1:0} disabled={disabled||annotations.length>=100} onClick={startAdd}>＋ 添加</button></div>
        <div className="trk-art-point-list" ref={list}>
          {loading||sourceLoading?<p className="trk-muted" role="status">正在读取点位…</p>:sourceError?<p className="trk-muted">点位显示状态未读取，请重试。</p>:displayedAnnotations.length?displayedAnnotations.map((item,index)=><button key={item.id} data-point-id={item.id} tabIndex={drawer||textDrawer||styleDrawer?-1:0} className="trk-art-point" aria-pressed={selectedId===item.id} disabled={disabled} onClick={()=>select(item.id)}><span className="trk-point-number" style={{background:getArtElementStyle(item,styles).markerColor,color:getArtElementStyle(item,styles).numberColor}}>{index+1}</span><span><strong>{item.label}</strong><small>{annotationVisible(item)?'画布已显示':'画布已隐藏'} · {item.photo?annotationVisible(item)?'已展示照片':'照片随点位隐藏':item.imageUrls?.length?`${item.imageUrls.length} 张可选图片`:'未添加图片'}</small></span><span aria-hidden="true">›</span></button>):<div className="trk-art-empty">还没有标记点位<br/>点击「添加点位」，在左侧画布放置标记。</div>}
        </div><p className="trk-muted trk-art-sidebar-footer">点位显示与标注点编辑一致，分组仅展示分组节点。点击点位可调整画布显示与布局。</p>
      </aside>
      {drawer&&active&&<aside ref={drawerElement} role="dialog" aria-labelledby="trk-point-title" className="trk-point-drawer" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeDrawer()}}}>
        <header><div><small>点位 {displayedAnnotations.indexOf(active)+1}</small><h3 id="trk-point-title">{active.sourceId?'调整样式与布局':'编辑点位'}</h3></div><button className="trk-secondary" onClick={closeDrawer}>关闭</button></header>
        <fieldset disabled={disabled}><label>名称<input ref={nameInput} aria-label="点位名称" aria-invalid={Boolean(nameInvalid)} readOnly={Boolean(active.sourceId)} maxLength={active.sourceId?160:80} value={name} onChange={event=>{if(active.sourceId)return;const value=event.target.value;setName(value);if(value.trim())update({label:value})}}/></label>
          {nameInvalid&&<p className="trk-error" role="alert">请输入 1 至 80 个字符的点位名称</p>}
          {active.sourceId?<><p className="trk-muted">名称、说明、照片来源和真实位置在「标注点编辑」中修改，此处自动同步。</p><label>类型<input aria-label="点位类型" readOnly value={sourceTypes||'未设置'}/></label>{sourceNode&&<p className="trk-muted" data-source-coordinates="">{formatPlacemarkCoordinates(sourceNode.coordinates)}{sourceNode.elevation!=null&&` · ${formatPlacemarkElevation(sourceNode.elevation)}`}{sourceNode.time!=null&&` · ${formatPlacemarkTime(sourceNode.time,sourceNode.timeSource)}`}</p>}</>:<label>类型<select aria-label="点位类型" value={active.kind||'note'} onChange={event=>update({kind:event.target.value as AnnotationKind})}>{ANNOTATION_KINDS.map(kind=><option key={kind.id} value={kind.id}>{kind.label}</option>)}</select></label>}
          <div className="trk-point-visibility"><span>画布显示</span><button type="button" className="trk-secondary" role="switch" aria-label="在画布上显示" aria-checked={annotationVisible(active)} onClick={()=>update({visible:!annotationVisible(active)})}>{annotationVisible(active)?'显示':'隐藏'}</button></div>
          <div className="trk-point-visibility-default"><p className="trk-muted">{active.sourceId?'来源点位默认显示，可单独隐藏画布标注。':'普通标注默认隐藏，其他类型默认显示。'}</p><button type="button" className="trk-secondary" disabled={active.visible===undefined} onClick={()=>update({visible:undefined})}>{active.sourceId?'恢复来源默认':'恢复类型默认'}</button></div>
          <ElementStyleControls key={active.id} value={active.style??{}} effective={activeStyle!} scope="当前点位" disabled={disabled} sections={['text','number','marker','connector',...(active.photo?['photo' as const]:[])]}
            onChange={next=>update({style:next})} onReset={()=>update({style:undefined,color:ANNOTATION_COLORS[0]})}/>

          <label>说明<textarea aria-label="点位说明" readOnly={Boolean(active.sourceId)} maxLength={active.sourceId?10000:4000} value={active.description||''} onChange={event=>update({description:event.target.value})}/></label>
          <div className="trk-point-photo-head"><strong>图片布局</strong>{!active.sourceId&&<label className="trk-secondary trk-upload">上传图片<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传点位图片" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void attach(file)}}/></label>}</div>
          {active.photo&&<figure className="trk-selected-photo"><img src={active.photo.sourceUrl?placemarkPhotoThumbnailUrl(track.id,active.photo.sourceUrl):active.photo.dataUrl} alt={`${active.label} · 画布照片`}/><figcaption>当前画布照片 {active.photo.sourceUrl&&<button type="button" className="trk-secondary" onClick={()=>setLargePhoto({url:active.photo!.sourceUrl!,name:active.label})}>查看原图</button>}<button type="button" className="trk-secondary" onClick={()=>update({photo:undefined})}>移除照片</button></figcaption></figure>}
          {Boolean(active.imageUrls?.length)&&<div className="trk-linked-photos">{active.imageUrls!.map((url,index)=><LinkedPhoto trackId={track.id} key={url} url={url} index={index} selected={active.photo?.sourceUrl===url} onChoose={()=>void attach(url)}/>)}</div>}
          {!active.sourceId&&<><label>添加图片链接<input type="url" aria-label="图片链接" value={link} placeholder="https://…" onChange={event=>setLink(event.target.value)}/></label><button className="trk-secondary" disabled={!imageLink(link)} onClick={()=>{const url=imageLink(link)!;update({imageUrls:[...new Set([...(active.imageUrls||[]),url])]});void attach(url);setLink('')}}>加载并选择图片</button></>}
          <details><summary>排版位置与图片布局</summary>{active.sourceId&&<><p className="trk-muted">调整画布排版时，真实点位保持不变，引线连接到轨迹上的真实位置。</p><button className="trk-secondary" disabled={!active.position} onClick={()=>update({position:undefined})}>标记回到真实位置</button></>}<PositionFields label="点位" x={markerPosition[0]} y={markerPosition[1]} maxX={1176} onChange={(x,y)=>update({position:{x,y}})}/>{photoPosition&&<PositionFields label="照片" x={photoPosition.x} y={photoPosition.y} maxX={Math.min(880,Math.max(0,1200-(activeStyle?.photoWidth??320)))} onChange={(x,y)=>update({photo:{...active.photo!,x,y}})}/>}</details>
        </fieldset>
        {photoBusy&&<p role="status" className="trk-muted">正在加载图片…</p>}{photoError&&<p className="trk-error" role="alert">{photoError}</p>}
        <footer><button className="trk-danger" disabled={disabled} onClick={remove}>{active.sourceId?'移除画布标注':'删除点位'}</button><button className="trk-primary" disabled={disabled||Boolean(nameInvalid)} onClick={closeDrawer}>完成编辑</button></footer>
      </aside>}
      {textDrawer&&selectedTextId&&<aside role="dialog" aria-labelledby="trk-art-text-title" className="trk-point-drawer" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeDrawer()}}}>
        <header><div><small>{selectedTextId==='start'||selectedTextId==='end'?'轨迹文字':'外层画布'}</small><h3 id="trk-art-text-title">调整画布文字</h3></div><button className="trk-secondary" onClick={closeDrawer}>关闭</button></header>
        <fieldset disabled={disabled}><label>文字对象<select ref={textSelect} aria-label="画布文字选择" value={selectedTextId} onChange={event=>selectText(event.target.value as ArtTextId)}>{ART_TEXT_LABELS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <p className="trk-muted">{selectedTextId==='start'||selectedTextId==='end'?'起终点文字随轨迹一起移动和缩放，可单独拖动或填写坐标调整相对位置。':'文字的位置和字号保持独立，可拖动或填写坐标调整。'}选中文字后，也可用方向键微调。</p>
          <TextStyleControls key={selectedTextId} value={styles.texts?.[selectedTextId]??{}} effective={getArtTextStyle(selectedTextId,styles)} scope="当前文字" disabled={disabled}
            onChange={next=>commit(annotations,layout,route,canvas,{...styles,texts:{...styles.texts,[selectedTextId]:next}})}/>
          <PositionFields label={textLabel} x={textPosition[0]} y={textPosition[1]} maxX={1200} onChange={(x,y)=>commit(annotations,{...layout,[selectedTextId]:{x,y}})}/>
          <button className="trk-secondary" disabled={!layout[selectedTextId]} onClick={resetTextPosition}>恢复默认位置</button>
        </fieldset><footer><button className="trk-primary" disabled={disabled} onClick={closeDrawer}>完成调整</button></footer>
      </aside>}
      {styleDrawer&&<aside role="dialog" aria-labelledby="trk-art-style-title" className="trk-point-drawer trk-art-style-drawer" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeDrawer()}}}>
        <header><div><small>整张画布</small><h3 ref={styleHeading} tabIndex={-1} id="trk-art-style-title">统一样式</h3></div><button type="button" className="trk-secondary" onClick={closeDrawer}>关闭</button></header>
        <fieldset disabled={disabled}>
          <GlobalStyleControls key={track.id} value={styles} effectiveElement={defaultElementStyle} effectiveRoute={getArtRouteStyle(styles)} effectiveBackground={getArtBackground(styles)} disabled={disabled}
            onChange={next=>commit(annotations,layout,route,canvas,next)}/>
          <details><summary>整组位置</summary><p className="trk-muted">轨迹、点位和配图统一移动，起终点文字跟随轨迹；标题和方向说明在「画布文字」中单独调整。</p>
            <PositionFields deferred key={track.id} label="整组轨迹" x={route.x} y={route.y} min={-10000} maxX={10000} maxY={10000} onChange={(x,y)=>commit(annotations,layout,{...route,x,y})}/>
          </details>
          <button type="button" className="trk-secondary" disabled={disabled||(!annotations.some(item=>item.style||item.color!==ANNOTATION_COLORS[0])&&!Object.keys(styles.texts??{}).length)} onClick={()=>commit(annotations.map(item=>({...item,style:undefined,color:ANNOTATION_COLORS[0]})),layout,route,canvas,{...styles,texts:undefined})}>让所有元素跟随统一样式</button>
          <p className="trk-muted">清除单独的文字、标记、连线和配图样式；已调整的点位与图片坐标保留。操作可撤销。</p>
        </fieldset><footer><button type="button" className="trk-primary" disabled={disabled} onClick={closeDrawer}>完成调整</button></footer>
      </aside>}
    </div>
    {largePhoto&&<PlacemarkPhotoViewer trackId={track.id} url={largePhoto.url} name={largePhoto.name} onClose={()=>setLargePhoto(null)}/>}
  </section>
}
function LinkedPhoto({url,index,trackId,selected,onChoose}:{url:string;index:number;trackId:string;selected:boolean;onChoose:()=>void}) {
  const photo=usePlacemarkPhotoThumbnail(trackId,imageLink(url))
  return <div className="trk-linked-photo">{photo.failed?<div className="trk-photo-failed" role="status">图片 {index+1} 加载失败<button className="trk-secondary" onClick={photo.retry}>重试图片</button></div>:photo.url?<img src={photo.url} alt={`链接图片 ${index+1}`} decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={photo.onError}/>:<div className="trk-photo-failed" role="status">正在加载图片…</div>}<button className="trk-secondary" aria-pressed={selected} onClick={onChoose}>{selected?'已选为画布照片':`选择图片 ${index+1}`}</button></div>
}
function PositionFields({label,x,y,maxX,min=0,maxY=9000,deferred=false,onChange}:{label:string;x:number;y:number;maxX:number;min?:number;maxY?:number;deferred?:boolean;onChange:(x:number,y:number)=>void}) {
  const [draft,setDraft]=useState({x:String(Math.round(x)),y:String(Math.round(y))}),[errors,setErrors]=useState({x:'',y:''}),[edited,setEdited]=useState({x:false,y:false})
  useEffect(()=>{setDraft({x:String(Math.round(x)),y:String(Math.round(y))});setErrors({x:'',y:''});setEdited({x:false,y:false})},[x,y,label])
  function field(axis:'x'|'y',name:string,value:number,max:number) {
    function commit(raw:string) {if(deferred&&!edited[axis])return;const next=Number(raw);if(!raw.trim()||!Number.isFinite(next)||next<min||next>max){if(deferred)setErrors(current=>({...current,[axis]:`请输入 ${min} 至 ${max} 的坐标`}));return}setErrors(current=>({...current,[axis]:''}));setEdited(current=>({...current,[axis]:false}));if(next!==value)onChange(axis==='x'?next:x,axis==='y'?next:y)}
    return <label>{name}<input type={deferred?'text':'number'} inputMode="decimal" aria-label={name} aria-invalid={deferred&&!!errors[axis]} min={min} max={max} value={deferred?draft[axis]:Math.round(value)} onChange={event=>{if(deferred){setDraft(current=>({...current,[axis]:event.target.value}));setEdited(current=>({...current,[axis]:true}));setErrors(current=>({...current,[axis]:''}))}else commit(event.target.value)}} onBlur={()=>{if(deferred)commit(draft[axis])}} onKeyDown={event=>{if(deferred&&event.key==='Enter'){event.preventDefault();commit(draft[axis])}else if(deferred&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setDraft(current=>({...current,[axis]:String(Math.round(value))}));setEdited(current=>({...current,[axis]:false}));setErrors(current=>({...current,[axis]:''}))}}}/>{deferred&&errors[axis]&&<small role="alert" className="trk-error">{errors[axis]}</small>}</label>
  }
  return <div className="trk-position-fields">{field('x',`${label}横坐标`,x,maxX)}{field('y',`${label}纵坐标`,y,maxY)}</div>
}
function message(reason:unknown):string {return reason instanceof Error?reason.message:'操作失败'}
const ART_CSS=`
.trk-art-overlay-canvas [tabindex]:focus-visible{outline:3px solid var(--trk-focus);outline-offset:4px}
.trk-point-drawer>header{position:sticky;top:0;z-index:2}
@container(max-width:560px){.trk-art-workspace .trk-point-drawer{position:fixed;top:0;bottom:0;right:0;max-height:100%;width:min(380px,100%)}}
@media(max-height:700px){.trk-art-workspace .trk-point-drawer{position:fixed;top:0;bottom:0;right:0;max-height:100%}}
.trk-point-visibility{display:flex;align-items:center;justify-content:space-between;gap:12px}.trk-point-visibility [role=switch]{min-width:80px}.trk-point-visibility [aria-checked=true]{background:var(--trk-active);border-color:var(--trk-accent)}.trk-point-visibility-default{display:grid;gap:8px}.trk-point-visibility-default button{justify-self:start}
.trk-art{position:relative}.trk-art-head,.trk-art-actions,.trk-art-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.trk-art-head{justify-content:space-between;margin-bottom:16px}.trk-art h2{margin:0 0 6px}.trk-art-toolbar{padding:12px 0}.trk-art-toolbar label{display:flex;align-items:center;gap:8px}.trk-art button,.trk-art select,.trk-art input:not([type=color]){min-height:44px}.trk-art-workspace{display:grid;grid-template-columns:minmax(0,1fr) 280px;position:relative;min-height:420px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);overflow:hidden;background:var(--trk-surface)}.trk-art-scene{position:relative;flex-shrink:0;width:min(100%,calc(clamp(320px,56vh,640px) * var(--trk-art-ratio,1.333333)));background:#fffdf6;box-shadow:0 4px 24px var(--trk-shadow);border-radius:4px;overflow:hidden}.trk-art-route-view{position:absolute;inset:0 auto auto 0;width:100%;transform-origin:0 0;touch-action:none}.trk-art-overlays{position:relative;pointer-events:none}.trk-art-overlay-canvas{width:100%;touch-action:none;pointer-events:none}.trk-art-overlay-canvas>svg{display:block;width:100%;height:auto}.trk-art-overlay-canvas [data-art-layer=background],.trk-art-overlay-canvas [data-annotation-id],.trk-art-overlay-canvas [data-photo-id],.trk-art-overlay-canvas [data-art-text-id]{pointer-events:all}.trk-art-board{position:relative;display:flex;align-items:center;justify-content:center;height:auto;min-height:clamp(360px,56vh,680px);overflow:hidden;background:var(--trk-map-background);padding:18px}.trk-svg-canvas svg{display:block;width:100%;height:auto}.trk-svg-canvas{overflow:visible}.trk-svg-adding,.trk-svg-adding [style]{cursor:crosshair!important}.trk-art-sidebar{display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--trk-border)}.trk-art-sidebar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px;border-bottom:1px solid var(--trk-border)}.trk-art-sidebar-head h3{margin:0;font-size:1em}.trk-art-sidebar-head small{color:var(--trk-muted);font-weight:400}.trk-art-point-list{padding:10px;overflow:auto;flex:1;max-height:65vh}.trk-art-point{display:flex;align-items:center;gap:12px;width:100%;padding:12px;text-align:left;border:1px solid transparent;border-radius:var(--trk-radius-md);color:inherit;background:transparent;margin-bottom:4px}.trk-art-point:hover{background:var(--trk-hover)}.trk-art-point[aria-pressed=true]{background:var(--trk-active);border-color:var(--trk-border)}.trk-art-point>span:nth-child(2){flex:1;min-width:0}.trk-art-point strong{display:block;overflow-wrap:anywhere}.trk-art-point small{display:block;color:var(--trk-muted);margin-top:5px}.trk-point-number{display:grid;place-items:center;color:#fff;width:30px;height:30px;border-radius:50%;flex-shrink:0}.trk-art-sidebar-footer{padding:16px;border-top:1px solid var(--trk-border)}.trk-art-empty{padding:32px 12px;text-align:center;color:var(--trk-muted);line-height:1.8}.trk-point-drawer{position:absolute;right:0;top:0;bottom:0;width:min(380px,100%);background:var(--trk-surface);box-shadow:-12px 0 40px var(--trk-shadow);border-left:1px solid var(--trk-border);display:flex;flex-direction:column;z-index:5;overflow:auto;animation:trk-drawer-enter .18s ease-out}.trk-point-drawer>header,.trk-point-drawer>footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:18px;flex-shrink:0;background:var(--trk-surface)}.trk-point-drawer>header{border-bottom:1px solid var(--trk-border)}.trk-point-drawer h3{margin:4px 0 0}.trk-point-drawer header small{color:var(--trk-muted)}.trk-point-drawer>footer{border-top:1px solid var(--trk-border);position:sticky;bottom:0;margin-top:auto}.trk-point-drawer fieldset{border:0;padding:18px;margin:0;min-width:0;display:grid;gap:16px}.trk-point-drawer label{display:grid;gap:7px;font-size:.9286em}.trk-art input,.trk-art select,.trk-art textarea{border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:inherit;padding:9px;font:inherit;min-width:0;max-width:100%}.trk-art textarea{resize:vertical;min-height:72px}.trk-art input[type=color]{width:64px;height:40px;padding:4px}.trk-point-photo-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.trk-upload{position:relative;cursor:pointer;overflow:hidden}.trk-upload input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.trk-selected-photo{margin:0}.trk-selected-photo img{width:100%;height:160px;object-fit:contain;background:var(--trk-map-background);border-radius:var(--trk-radius-sm)}.trk-selected-photo figcaption{display:flex;align-items:center;justify-content:space-between;font-size:.857em;margin-top:8px}.trk-linked-photos{display:grid;grid-template-columns:1fr 1fr;gap:10px}.trk-linked-photo img,.trk-photo-failed{width:100%;height:100px;object-fit:cover;border-radius:var(--trk-radius-sm);background:var(--trk-map-background)}.trk-linked-photo button{width:100%;padding:8px 4px;font-size:.857em;white-space:normal}.trk-photo-failed{display:grid;place-items:center;font-size:.857em}.trk-position-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.trk-art button:disabled{opacity:.5;cursor:not-allowed}.trk-art details summary{cursor:pointer;padding:10px 0}.trk-art .trk-progress button{margin-left:8px}
.trk-art-size{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 0}.trk-art-size label{display:flex;align-items:center;gap:6px}.trk-art-size input{width:88px}.trk-art-export-note{margin:0 0 4px}
@keyframes trk-drawer-enter{from{transform:translateX(30px);opacity:0}to{transform:translateX(0);opacity:1}}@media(prefers-reduced-motion:reduce){.trk-point-drawer{animation:none}}
@container(max-width:760px){.trk-art-workspace{grid-template-columns:minmax(0,1fr) 220px}.trk-art-board{padding:10px}.trk-art-toolbar>span{width:100%}}@container(max-width:560px){.trk-art-workspace{grid-template-columns:1fr}.trk-art-sidebar{border-left:0;border-top:1px solid var(--trk-border)}.trk-art-point-list{max-height:240px}.trk-art-board{height:auto;min-height:360px}.trk-point-drawer{position:absolute;width:min(380px,100%)}.trk-art-head{align-items:flex-start}.trk-art-actions{width:100%}}
`

