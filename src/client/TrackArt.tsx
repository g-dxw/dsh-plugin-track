import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { ANNOTATION_COLORS, ANNOTATION_KINDS, ART_TEXT_LABELS, artTextPosition, annotationPhotoLayouts, annotationPosition, annotationTextColor, annotationVisible, annotationsFromPlacemarks, diagramCoordinates, routeCanvasSvg, routeSvg, trackSvg, validateAnnotations, validateArtLayout, validateArtRouteTransform, type ArtRouteTransform, type ArtLayout, type ArtTextId, type AnnotationKind, type TrackAnnotation } from '../track/annotations.ts'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'
import { PlacemarkPhotoViewer } from './PlacemarkPhotoViewer.tsx'
import { usePlacemarkPhotoThumbnail } from './usePlacemarkPhotoThumbnail.ts'
import { AnnotationCanvas, type AnnotationCanvasHandle } from './AnnotationCanvas.tsx'
import { ArtCanvasViewport, type ArtCanvasViewportHandle } from './ArtCanvasViewport.tsx'
import { readAnnotationPhoto, readLinkedAnnotationPhoto } from './annotation-photo.ts'
import { loadTrackPlacemarks } from './useTrackPlacemarks.ts'
import { api, clipboardSafeName, download } from './util.ts'

type ArtDraft = {annotations:TrackAnnotation[];layout:ArtLayout;route:ArtRouteTransform}
type History = {past:ArtDraft[];present:ArtDraft;future:ArtDraft[]}
const emptyDraft=():ArtDraft=>({annotations:[],layout:{},route:validateArtRouteTransform(undefined)})
export type TrackArtState = {dirty:boolean;busy:boolean}
export function TrackArt({track,onCancel,embedded=false,active:isActive=true,onStateChange}: {track:TrackRecord;basemap:BasemapId;onBasemap:(next:BasemapId)=>void;onCancel:()=>void;embedded?:boolean;active?:boolean;onStateChange?:(state:TrackArtState)=>void}) {
  const [history,setHistory]=useState<History>({past:[],present:emptyDraft(),future:[]})
  const {annotations,layout,route}=history.present
  const latestAnnotations=useRef(annotations);latestAnnotations.current=annotations
  const [baseline,setBaseline]=useState(JSON.stringify(emptyDraft())),[ready,setReady]=useState(false),[loading,setLoading]=useState(false)
  const [largePhoto,setLargePhoto]=useState<{url:string;name:string}|null>(null)
  const [selectedId,setSelectedId]=useState<string|null>(null),[drawer,setDrawer]=useState(false),[adding,setAdding]=useState(false)
  const [selectedTextId,setSelectedTextId]=useState<ArtTextId|null>(null),[textDrawer,setTextDrawer]=useState(false)
  const textSelect=useRef<HTMLSelectElement>(null)
  const [name,setName]=useState(''),[link,setLink]=useState(''),[saving,setSaving]=useState(false),[photoBusy,setPhotoBusy]=useState(false)
  const [error,setError]=useState(''),[photoError,setPhotoError]=useState(''),[note,setNote]=useState(''),[discard,setDiscard]=useState(false),[zoom,setZoom]=useState(100),[canvasTool,setCanvasTool]=useState<'select'|'pan'>('select')
  const alive=useRef(true),generation=useRef(0),nameInput=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null),drawerElement=useRef<HTMLElement>(null),previousFocus=useRef<HTMLElement|null>(null)
  const isActiveRef=useRef(isActive),stateChangeRef=useRef(onStateChange);isActiveRef.current=isActive;stateChangeRef.current=onStateChange
  const camera=useRef<ArtCanvasViewportHandle>(null),overlay=useRef<AnnotationCanvasHandle>(null),routePreview=useRef(route)
  const active=annotations.find(item=>item.id===selectedId)
  const visibleCount=annotations.filter(annotationVisible).length
  const dirty=JSON.stringify(history.present)!==baseline
  const nameInvalid=drawer&&active&&(!name.trim()||Array.from(name).length>80)
  const draftDirty=dirty||Boolean(nameInvalid),busy=saving||photoBusy
  const drawing=useMemo(()=>{
    try{return {svg:trackSvg(track.coordinates,{name:track.name,annotations,layout,route,theme:'paper',selectedId,selectedTextId,interactive:true,layer:'overlay'}),routeSvg:routeCanvasSvg(track.coordinates,{theme:'paper'}),error:''}}
    catch(reason){return {svg:'',routeSvg:'',error:message(reason)}}
  },[track.coordinates,track.name,annotations,layout,route,selectedId,selectedTextId])

  async function loadAnnotations() {
    const current=++generation.current;setLoading(true);setReady(false);setError('')
    try{
      const result=await api<{annotations:TrackAnnotation[];layout?:ArtLayout;route?:ArtRouteTransform;saved?:boolean}>(`annotations?id=${encodeURIComponent(track.id)}`)
      let next=validateAnnotations(result.annotations,track.coordinates.length),hint=''
      const nextLayout=validateArtLayout(result.layout),nextRoute=validateArtRouteTransform(result.route),stored=JSON.stringify({annotations:next,layout:nextLayout,route:nextRoute})
      if(!next.length&&!result.saved){
        const placemarks=await loadTrackPlacemarks(track)
        next=validateAnnotations(annotationsFromPlacemarks(placemarks,track.coordinates),track.coordinates.length)
        if(next.length)hint=`已带入 ${next.length} 个 KML 点位，可选择图片并调整画布。${placemarks.length>100?'画布最多 100 个点位，其余仍可在概览查看。':''}`
      }
      if(!alive.current||current!==generation.current)return
      routePreview.current=nextRoute;setHistory({past:[],present:{annotations:next,layout:nextLayout,route:nextRoute},future:[]});setBaseline(stored);setReady(true);setNote(hint)
    }catch(reason){if(alive.current&&current===generation.current)setError('读取点位失败：'+message(reason))}
    finally{if(alive.current&&current===generation.current)setLoading(false)}
  }
  useEffect(()=>{alive.current=true;void loadAnnotations();return()=>{alive.current=false;generation.current++}},[track.id])
  useEffect(()=>{setName(active?.label||'')},[selectedId,active?.label])
  useEffect(()=>{setLink('');setPhotoError('')},[selectedId])
  useEffect(()=>{stateChangeRef.current?.({dirty:draftDirty,busy})},[draftDirty,busy])
  useEffect(()=>{
    if((!drawer&&!textDrawer)||!isActiveRef.current)return
    previousFocus.current=document.activeElement as HTMLElement
    if(textDrawer)textSelect.current?.focus();else nameInput.current?.focus()
    return()=>{const target=previousFocus.current;if(isActiveRef.current&&target?.isConnected)target.focus()}
  },[drawer,textDrawer,selectedId,selectedTextId])
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

  function commit(next:TrackAnnotation[],nextLayout:ArtLayout=layout,nextRoute:ArtRouteTransform=camera.current?.getView()??route) {
    if(!ready||saving||photoBusy)return
    try{
      const valid:ArtDraft={annotations:validateAnnotations(next,track.coordinates.length),layout:validateArtLayout(nextLayout),route:validateArtRouteTransform(nextRoute)}
      setHistory(current=>JSON.stringify(current.present)===JSON.stringify(valid)?current:{past:[...current.past,current.present].slice(-40),present:valid,future:[]});setError('');setNote('')
    }catch(reason){setError(message(reason))}
  }
  function update(patch:Partial<TrackAnnotation>) {if(active)commit(annotations.map(item=>item.id===active.id?{...item,...patch}:item))}
  function select(id:string,options?:{openEditor?:boolean}) {setSelectedTextId(null);setTextDrawer(false);setSelectedId(id);setName(annotations.find(item=>item.id===id)?.label||'');setDrawer(options?.openEditor!==false);setAdding(false);setError('');setPhotoError('')}
  function selectText(id:ArtTextId,options?:{openEditor?:boolean}) {setSelectedTextId(id);setSelectedId(null);setDrawer(false);setTextDrawer(options?.openEditor!==false);setAdding(false);setError('');setPhotoError('')}
  function closeDrawer() {setDrawer(false);setTextDrawer(false);setPhotoError('')}
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
      if(!latestAnnotations.current.some(item=>item.id===id))return
      const next=latestAnnotations.current.map(item=>item.id===id?{...item,photo:{...item.photo,dataUrl,...(typeof file==='string'?{sourceUrl:file}:{sourceUrl:undefined})}}:item)
      const layout=annotationPhotoLayouts(next,track.coordinates).find(item=>item.annotation.id===id)!
      const normalized=validateAnnotations(next.map(item=>item.id===id?{...item,photo:{...item.photo!,x:layout.x,y:layout.y}}:item),track.coordinates.length)
      setHistory(current=>({past:[...current.past,current.present].slice(-40),present:{...current.present,annotations:normalized},future:[]}))
    }catch(reason){if(alive.current)setPhotoError('图片未添加：'+message(reason)+'。可尝试上传本地图片。')}
    finally{if(alive.current)setPhotoBusy(false)}
  }
  async function save() {
    if(!ready||saving||photoBusy||nameInvalid)return
    setSaving(true);setError('')
    try{
      const stored=JSON.parse(baseline) as ArtDraft,currentRoute=validateArtRouteTransform(camera.current?.getView()??routePreview.current)
      const withLayout=Object.keys(layout).length>0||Object.keys(stored.layout).length>0,withRoute=JSON.stringify(currentRoute)!==JSON.stringify(emptyDraft().route)||JSON.stringify(stored.route)!==JSON.stringify(emptyDraft().route)
      const result=await api<{annotations:TrackAnnotation[];layout?:ArtLayout;route?:ArtRouteTransform}>('annotations',{id:track.id,annotations,...(withLayout?{layout}:{}),...(withRoute?{route:currentRoute}:{})})
      if(alive.current){const next:ArtDraft={annotations:validateAnnotations(result.annotations,track.coordinates.length),layout:validateArtLayout(result.layout??layout),route:validateArtRouteTransform(result.route??currentRoute)};setHistory(current=>({...current,present:next}));setBaseline(JSON.stringify(next));setNote('画布已保存。')}
    }catch(reason){if(alive.current)setError('保存失败，画布草稿已保留：'+message(reason))}
    finally{if(alive.current)setSaving(false)}
  }
  function undo() {setHistory(current=>current.past.length?{past:current.past.slice(0,-1),present:current.past.at(-1)!,future:[current.present,...current.future]}:current);closeDrawer();setAdding(false)}
  function redo() {setHistory(current=>current.future.length?{past:[...current.past,current.present],present:current.future[0],future:current.future.slice(1)}:current);closeDrawer();setAdding(false)}
  function remove() {if(!active)return;commit(annotations.filter(item=>item.id!==active.id));closeDrawer();setSelectedId(null)}
  const disabled=!ready||saving||photoBusy
  const textPosition=selectedTextId?artTextPosition(selectedTextId,track.coordinates,annotations,layout):[0,0]
  const textLabel=ART_TEXT_LABELS.find(item=>item.id===selectedTextId)?.label||''
  const markerPosition=active?annotationPosition(active,track.coordinates):[0,0]
  const photoPosition=active?.photo?annotationPhotoLayouts(annotations,track.coordinates).find(item=>item.annotation.id===active.id):null
  return <section className="trk-art" onKeyDownCapture={event=>{if(!isActive){event.preventDefault();event.stopPropagation()}}}>
    <style>{ART_CSS}</style>
    <header className="trk-art-head"><div><h2>{embedded?'SVG 标注':'轨迹标注'}</h2><p className="trk-muted">{track.name} · 在画布上添加点位，点位与照片随轨迹移动，标题和方向说明独立排版。</p></div><div className="trk-art-actions">
      {!embedded&&<button className="trk-secondary" disabled={saving||photoBusy} onClick={()=>dirty?setDiscard(true):onCancel()}>返回概览</button>}
      <button className="trk-secondary" disabled={disabled||!drawing.svg||Boolean(nameInvalid)} onClick={()=>download(`${clipboardSafeName(track.name)}-轨迹标注.svg`,trackSvg(track.coordinates,{name:track.name,annotations,layout,route:camera.current?.getView()??routePreview.current,theme:'paper'}),'image/svg+xml')}>导出 SVG</button>
      <button className="trk-secondary" disabled={disabled||!drawing.svg} onClick={()=>download(`${clipboardSafeName(track.name)}-纯轨迹.svg`,routeSvg(track.coordinates,{theme:'paper'}),'image/svg+xml')}>导出轨迹 SVG</button>
      <button className="trk-primary" disabled={disabled||!dirty||Boolean(nameInvalid)} onClick={()=>void save()}>{saving?'保存中…':'保存画布'}</button>
    </div></header>
    {!embedded&&discard&&<div className="trk-progress" role="alert">画布有未保存的修改。<button className="trk-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button className="trk-secondary" onClick={onCancel}>放弃草稿</button></div>}
    {error&&<div className="trk-error" role="alert">{error}{!ready&&<button className="trk-secondary" disabled={loading} onClick={()=>void loadAnnotations()}>重试读取点位</button>}</div>}
    {note&&<p className="trk-muted" role="status">{note}</p>}
    <div className="trk-art-toolbar" role="group" aria-label="画布工具">
      <button className="trk-secondary" disabled={disabled} aria-pressed={canvasTool==='select'&&!adding} onClick={()=>{setCanvasTool('select');setAdding(false)}}>选择 / 移动</button>
      <button className="trk-secondary" disabled={disabled} aria-pressed={canvasTool==='pan'} onClick={()=>{setCanvasTool('pan');setAdding(false);closeDrawer()}}>拖动轨迹</button>
      <button className="trk-secondary" disabled={disabled} aria-pressed={textDrawer} onClick={()=>{setCanvasTool('select');selectText(selectedTextId||'title')}}>画布文字</button>
      <button className="trk-secondary" disabled={disabled||annotations.length>=100} aria-pressed={adding} onClick={startAdd}>添加点位</button>
      <button className="trk-secondary" disabled={disabled||!history.past.length} onClick={undo}>撤销</button><button className="trk-secondary" disabled={disabled||!history.future.length} onClick={redo}>重做</button>
      <label>轨迹缩放<select aria-label="轨迹缩放" disabled={disabled} value={zoom} onChange={event=>camera.current?.zoom(Number(event.target.value)/100)}>{[...new Set([25,50,75,100,125,150,200,400,zoom])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value}%</option>)}</select></label>
      <button className="trk-secondary" disabled={disabled} onClick={resetView}>重置轨迹</button>
      {adding&&<><button className="trk-secondary" onClick={()=>add(routePosition(0))} disabled={disabled}>添加到路线起点</button><button className="trk-secondary" onClick={()=>{setAdding(false);setNote('')}}>取消添加</button></>}
      <span className="trk-muted">拖动文字、标记或照片调整位置 · 拖动空白区域移动轨迹 · 双击添加点位 · 方向键微调</span>
    </div>
    <div className="trk-art-workspace">
      <ArtCanvasViewport ref={camera} view={route} disabled={disabled||!isActive} panning={canvasTool==='pan'} adding={adding} onViewChange={view=>{routePreview.current=view;overlay.current?.setRouteView(view)}} onViewCommit={view=>commit(annotations,layout,view)} onScaleChange={scale=>setZoom(Math.round(scale*100))} overlay={drawing.error?<div className="trk-error">{drawing.error}</div>:<AnnotationCanvas trackId={track.id} ref={overlay} route={route} svg={drawing.svg} points={track.coordinates} annotations={annotations} layout={layout} onLayoutChange={next=>commit(annotations,next)} onTextSelect={selectText} onChange={commit} onSelect={select} onAdd={add} adding={adding} panning={canvasTool==='pan'} managedPan disabled={disabled||!isActive}/>}>
        {drawing.routeSvg&&<div dangerouslySetInnerHTML={{__html:drawing.routeSvg}}/>}
      </ArtCanvasViewport>
      <aside className="trk-art-sidebar" aria-label="标记点位" aria-hidden={drawer||textDrawer||undefined}>
        <div className="trk-art-sidebar-head"><h3>标记点位 <small>{visibleCount} / {annotations.length} 显示</small></h3><button className="trk-secondary" tabIndex={drawer||textDrawer?-1:0} disabled={disabled||annotations.length>=100} onClick={startAdd}>＋ 添加</button></div>
        <div className="trk-art-point-list" ref={list}>
          {loading?<p className="trk-muted" role="status">正在读取点位…</p>:annotations.length?annotations.map((item,index)=><button key={item.id} data-point-id={item.id} tabIndex={drawer||textDrawer?-1:0} className="trk-art-point" aria-pressed={selectedId===item.id} disabled={disabled} onClick={()=>select(item.id)}><span className="trk-point-number" style={{background:item.color,color:annotationTextColor(item.color)}}>{index+1}</span><span><strong>{item.label}</strong><small>{annotationVisible(item)?'画布已显示':'画布已隐藏'} · {item.photo?annotationVisible(item)?'已展示照片':'照片随点位隐藏':item.imageUrls?.length?`${item.imageUrls.length} 张可选图片`:'未添加图片'}</small></span><span aria-hidden="true">›</span></button>):<div className="trk-art-empty">还没有标记点位<br/>点击「添加点位」，在左侧画布放置标记。</div>}
        </div><p className="trk-muted trk-art-sidebar-footer">所有点位均保留在列表中。点击点位可设置显示或隐藏，布局保存后可继续编辑。</p>
      </aside>
      {drawer&&active&&<aside ref={drawerElement} role="dialog" aria-labelledby="trk-point-title" className="trk-point-drawer" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeDrawer()}}}>
        <header><div><small>点位 {annotations.indexOf(active)+1}</small><h3 id="trk-point-title">编辑点位</h3></div><button className="trk-secondary" onClick={closeDrawer}>关闭</button></header>
        <fieldset disabled={saving||photoBusy}><label>名称<input ref={nameInput} aria-label="点位名称" aria-invalid={Boolean(nameInvalid)} maxLength={80} value={name} onChange={event=>{const value=event.target.value;setName(value);if(value.trim())update({label:value})}}/></label>
          {nameInvalid&&<p className="trk-error" role="alert">请输入 1 至 80 个字符的点位名称</p>}
          <label>类型<select aria-label="点位类型" value={active.kind||'note'} onChange={event=>update({kind:event.target.value as AnnotationKind})}>{ANNOTATION_KINDS.map(kind=><option key={kind.id} value={kind.id}>{kind.label}</option>)}</select></label>
          <div className="trk-point-visibility"><span>画布显示</span><button type="button" className="trk-secondary" role="switch" aria-label="在画布上显示" aria-checked={annotationVisible(active)} onClick={()=>update({visible:!annotationVisible(active)})}>{annotationVisible(active)?'显示':'隐藏'}</button></div>
          <div className="trk-point-visibility-default"><p className="trk-muted">普通标注默认隐藏，其他类型默认显示。</p><button type="button" className="trk-secondary" disabled={active.visible===undefined} onClick={()=>update({visible:undefined})}>恢复类型默认</button></div>
          <label>标记颜色<input type="color" aria-label="标记颜色" value={active.color} onChange={event=>update({color:event.target.value})}/></label>
          <label>说明<textarea aria-label="点位说明" maxLength={4000} value={active.description||''} onChange={event=>update({description:event.target.value})}/></label>
          <div className="trk-point-photo-head"><strong>图片</strong><label className="trk-secondary trk-upload">上传图片<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传点位图片" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void attach(file)}}/></label></div>
          {active.photo&&<figure className="trk-selected-photo"><img src={active.photo.sourceUrl?placemarkPhotoThumbnailUrl(track.id,active.photo.sourceUrl):active.photo.dataUrl} alt={`${active.label} · 画布照片`}/><figcaption>当前画布照片 {active.photo.sourceUrl&&<button type="button" className="trk-secondary" onClick={()=>setLargePhoto({url:active.photo!.sourceUrl!,name:active.label})}>查看原图</button>}<button type="button" className="trk-secondary" onClick={()=>update({photo:undefined})}>移除照片</button></figcaption></figure>}
          {Boolean(active.imageUrls?.length)&&<div className="trk-linked-photos">{active.imageUrls!.map((url,index)=><LinkedPhoto trackId={track.id} key={url} url={url} index={index} selected={active.photo?.sourceUrl===url} onChoose={()=>void attach(url)}/>)}</div>}
          <label>添加图片链接<input type="url" aria-label="图片链接" value={link} placeholder="https://…" onChange={event=>setLink(event.target.value)}/></label><button className="trk-secondary" disabled={!imageLink(link)} onClick={()=>{const url=imageLink(link)!;update({imageUrls:[...new Set([...(active.imageUrls||[]),url])]});void attach(url);setLink('')}}>加载并选择图片</button>
          <details><summary>画布位置</summary><PositionFields label="点位" x={markerPosition[0]} y={markerPosition[1]} maxX={1176} onChange={(x,y)=>update({position:{x,y}})}/>{photoPosition&&<PositionFields label="照片" x={photoPosition.x} y={photoPosition.y} maxX={880} onChange={(x,y)=>update({photo:{...active.photo!,x,y}})}/>}</details>
        </fieldset>
        {photoBusy&&<p role="status" className="trk-muted">正在加载图片…</p>}{photoError&&<p className="trk-error" role="alert">{photoError}</p>}
        <footer><button className="trk-danger" disabled={disabled} onClick={remove}>删除点位</button><button className="trk-primary" disabled={disabled||Boolean(nameInvalid)} onClick={closeDrawer}>完成编辑</button></footer>
      </aside>}
      {textDrawer&&selectedTextId&&<aside role="dialog" aria-labelledby="trk-art-text-title" className="trk-point-drawer" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeDrawer()}}}>
        <header><div><small>{selectedTextId==='start'||selectedTextId==='end'?'轨迹文字':'外层画布'}</small><h3 id="trk-art-text-title">调整画布文字</h3></div><button className="trk-secondary" onClick={closeDrawer}>关闭</button></header>
        <fieldset disabled={disabled}><label>文字对象<select ref={textSelect} aria-label="画布文字选择" value={selectedTextId} onChange={event=>selectText(event.target.value as ArtTextId)}>{ART_TEXT_LABELS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <p className="trk-muted">{selectedTextId==='start'||selectedTextId==='end'?'起终点文字随轨迹一起移动和缩放，可单独拖动或填写坐标调整相对位置。':'文字的位置和字号保持独立，可拖动或填写坐标调整。'}选中文字后，也可用方向键微调。</p>
          <PositionFields label={textLabel} x={textPosition[0]} y={textPosition[1]} maxX={1200} onChange={(x,y)=>commit(annotations,{...layout,[selectedTextId]:{x,y}})}/>
          <button className="trk-secondary" disabled={!layout[selectedTextId]} onClick={resetTextPosition}>恢复默认位置</button>
        </fieldset><footer><button className="trk-primary" disabled={disabled} onClick={closeDrawer}>完成调整</button></footer>
      </aside>}
    </div>
    {largePhoto&&<PlacemarkPhotoViewer trackId={track.id} url={largePhoto.url} name={largePhoto.name} onClose={()=>setLargePhoto(null)}/>}
  </section>
}
function LinkedPhoto({url,index,trackId,selected,onChoose}:{url:string;index:number;trackId:string;selected:boolean;onChoose:()=>void}) {
  const photo=usePlacemarkPhotoThumbnail(trackId,imageLink(url))
  return <div className="trk-linked-photo">{photo.failed?<div className="trk-photo-failed" role="status">图片 {index+1} 加载失败<button className="trk-secondary" onClick={photo.retry}>重试图片</button></div>:photo.url?<img src={photo.url} alt={`链接图片 ${index+1}`} decoding="async" loading="lazy" referrerPolicy="no-referrer" onError={photo.onError}/>:<div className="trk-photo-failed" role="status">正在加载图片…</div>}<button className="trk-secondary" aria-pressed={selected} onClick={onChoose}>{selected?'已选为画布照片':`选择图片 ${index+1}`}</button></div>
}
function PositionFields({label,x,y,maxX,onChange}:{label:string;x:number;y:number;maxX:number;onChange:(x:number,y:number)=>void}) {
  return <div className="trk-position-fields"><label>{label}横坐标<input type="number" aria-label={`${label}横坐标`} min={0} max={maxX} value={Math.round(x)} onChange={event=>{const value=Number(event.target.value);if(value>=0&&value<=maxX)onChange(value,y)}}/></label><label>{label}纵坐标<input type="number" aria-label={`${label}纵坐标`} min={0} max={9000} value={Math.round(y)} onChange={event=>{const value=Number(event.target.value);if(value>=0&&value<=9000)onChange(x,value)}}/></label></div>
}
function message(reason:unknown):string {return reason instanceof Error?reason.message:'操作失败'}
const ART_CSS=`
.trk-art-overlay-canvas [tabindex]:focus-visible{outline:3px solid var(--trk-focus);outline-offset:4px}
.trk-point-drawer>header{position:sticky;top:0;z-index:2}
@container(max-width:560px){.trk-art-workspace .trk-point-drawer{position:fixed;top:0;bottom:0;right:0;max-height:100%;width:min(380px,100%)}}
@media(max-height:700px){.trk-art-workspace .trk-point-drawer{position:fixed;top:0;bottom:0;right:0;max-height:100%}}
.trk-point-visibility{display:flex;align-items:center;justify-content:space-between;gap:12px}.trk-point-visibility [role=switch]{min-width:80px}.trk-point-visibility [aria-checked=true]{background:var(--trk-active);border-color:var(--trk-accent)}.trk-point-visibility-default{display:grid;gap:8px}.trk-point-visibility-default button{justify-self:start}
.trk-art{position:relative}.trk-art-head,.trk-art-actions,.trk-art-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.trk-art-head{justify-content:space-between;margin-bottom:16px}.trk-art h2{margin:0 0 6px}.trk-art-toolbar{padding:12px 0}.trk-art-toolbar label{display:flex;align-items:center;gap:8px}.trk-art button,.trk-art select,.trk-art input:not([type=color]){min-height:44px}.trk-art-workspace{display:grid;grid-template-columns:minmax(0,1fr) 280px;position:relative;min-height:540px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);overflow:hidden;background:var(--trk-surface)}.trk-art-scene{position:relative;width:100%;background:#fffdf6;box-shadow:0 4px 24px var(--trk-shadow);border-radius:4px;overflow:hidden}.trk-art-route-view{position:absolute;inset:0 auto auto 0;width:100%;transform-origin:0 0;touch-action:none}.trk-art-overlays{position:relative;pointer-events:none}.trk-art-overlay-canvas{width:100%;touch-action:none;pointer-events:none}.trk-art-overlay-canvas>svg{display:block;width:100%;height:auto}.trk-art-overlay-canvas [data-art-layer=background],.trk-art-overlay-canvas [data-annotation-id],.trk-art-overlay-canvas [data-photo-id],.trk-art-overlay-canvas [data-art-text-id]{pointer-events:all}.trk-art-board{position:relative;height:auto;min-height:clamp(540px,72vh,960px);overflow:hidden;background:var(--trk-map-background);padding:18px}.trk-svg-canvas svg{display:block;width:100%;height:auto}.trk-svg-canvas{overflow:visible}.trk-svg-adding,.trk-svg-adding [style]{cursor:crosshair!important}.trk-art-sidebar{display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--trk-border)}.trk-art-sidebar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px;border-bottom:1px solid var(--trk-border)}.trk-art-sidebar-head h3{margin:0;font-size:1em}.trk-art-sidebar-head small{color:var(--trk-muted);font-weight:400}.trk-art-point-list{padding:10px;overflow:auto;flex:1;max-height:65vh}.trk-art-point{display:flex;align-items:center;gap:12px;width:100%;padding:12px;text-align:left;border:1px solid transparent;border-radius:var(--trk-radius-md);color:inherit;background:transparent;margin-bottom:4px}.trk-art-point:hover{background:var(--trk-hover)}.trk-art-point[aria-pressed=true]{background:var(--trk-active);border-color:var(--trk-border)}.trk-art-point>span:nth-child(2){flex:1;min-width:0}.trk-art-point strong{display:block;overflow-wrap:anywhere}.trk-art-point small{display:block;color:var(--trk-muted);margin-top:5px}.trk-point-number{display:grid;place-items:center;color:#fff;width:30px;height:30px;border-radius:50%;flex-shrink:0}.trk-art-sidebar-footer{padding:16px;border-top:1px solid var(--trk-border)}.trk-art-empty{padding:32px 12px;text-align:center;color:var(--trk-muted);line-height:1.8}.trk-point-drawer{position:absolute;right:0;top:0;bottom:0;width:min(380px,100%);background:var(--trk-surface);box-shadow:-12px 0 40px var(--trk-shadow);border-left:1px solid var(--trk-border);display:flex;flex-direction:column;z-index:5;overflow:auto;animation:trk-drawer-enter .18s ease-out}.trk-point-drawer>header,.trk-point-drawer>footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:18px;flex-shrink:0;background:var(--trk-surface)}.trk-point-drawer>header{border-bottom:1px solid var(--trk-border)}.trk-point-drawer h3{margin:4px 0 0}.trk-point-drawer header small{color:var(--trk-muted)}.trk-point-drawer>footer{border-top:1px solid var(--trk-border);position:sticky;bottom:0;margin-top:auto}.trk-point-drawer fieldset{border:0;padding:18px;margin:0;min-width:0;display:grid;gap:16px}.trk-point-drawer label{display:grid;gap:7px;font-size:.9286em}.trk-art input,.trk-art select,.trk-art textarea{border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:inherit;padding:9px;font:inherit;min-width:0;max-width:100%}.trk-art textarea{resize:vertical;min-height:72px}.trk-art input[type=color]{width:64px;height:40px;padding:4px}.trk-point-photo-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.trk-upload{position:relative;cursor:pointer;overflow:hidden}.trk-upload input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.trk-selected-photo{margin:0}.trk-selected-photo img{width:100%;height:160px;object-fit:contain;background:var(--trk-map-background);border-radius:var(--trk-radius-sm)}.trk-selected-photo figcaption{display:flex;align-items:center;justify-content:space-between;font-size:.857em;margin-top:8px}.trk-linked-photos{display:grid;grid-template-columns:1fr 1fr;gap:10px}.trk-linked-photo img,.trk-photo-failed{width:100%;height:100px;object-fit:cover;border-radius:var(--trk-radius-sm);background:var(--trk-map-background)}.trk-linked-photo button{width:100%;padding:8px 4px;font-size:.857em;white-space:normal}.trk-photo-failed{display:grid;place-items:center;font-size:.857em}.trk-position-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.trk-art button:disabled{opacity:.5;cursor:not-allowed}.trk-art details summary{cursor:pointer;padding:10px 0}.trk-art .trk-progress button{margin-left:8px}
@keyframes trk-drawer-enter{from{transform:translateX(30px);opacity:0}to{transform:translateX(0);opacity:1}}@media(prefers-reduced-motion:reduce){.trk-point-drawer{animation:none}}
@container(max-width:760px){.trk-art-workspace{grid-template-columns:minmax(0,1fr) 220px}.trk-art-board{padding:10px}.trk-art-toolbar>span{width:100%}}@container(max-width:560px){.trk-art-workspace{grid-template-columns:1fr}.trk-art-sidebar{border-left:0;border-top:1px solid var(--trk-border)}.trk-art-point-list{max-height:240px}.trk-art-board{height:auto;min-height:480px}.trk-point-drawer{position:absolute;width:min(380px,100%)}.trk-art-head{align-items:flex-start}.trk-art-actions{width:100%}}
`

