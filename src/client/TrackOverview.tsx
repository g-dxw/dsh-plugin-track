import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { TrackRecord, TrackPlacemark, PlacemarkGroup } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { MapView, type MapResourceCaptureControls } from './MapView.tsx'
import { useMapSettings } from './map-settings.tsx'
import { ElevationChart } from './ElevationChart.tsx'
import { useTrackPlacemarks } from './useTrackPlacemarks.ts'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'
import { placemarkTypes } from '../track/placemark-edits.ts'
import { formatPlacemarkElevation, formatPlacemarkTime, placemarkTitle } from '../track/placemark-format.ts'
import { locatePlacemarkCandidates, type LocatedPlacemark } from '../track/placemark-location.ts'
import { PlacemarkDeleteDialog, PlacemarkLocationDialog } from './PlacemarkDialogs.tsx'
import { PlacemarkEditDrawer } from './PlacemarkEditDrawer.tsx'
import {uploadPlacemarkPhoto} from './placemark-photo.ts'
import { createPlacemarkHistory, type PlacemarkHistory } from './placemark-history.ts'
import { editorHistoryShortcut, shortcutInsideEditor } from './editor-shortcuts.ts'
import { groupCoverPhoto, groupHidden, groupMembers, groupTypes, mergePlacemarkGroups } from '../track/placemark-groups.ts'
import { ALL_PLACEMARK_TYPES, filteredPlacemarkListItems, isAllPlacemarkTypes, matchesPlacemarkType, placemarkTypeOptions, placemarkTypeValues, type PlacemarkTypeFilter } from '../track/placemark-filter.ts'
import { PlacemarkGroupDrawer } from './PlacemarkGroupDrawer.tsx'
import { PlacemarkContextMenu } from './PlacemarkContextMenu.tsx'
import { moveGroupedPlacemark, placemarkOrderScope, shiftGroupedPlacemark } from './group-order.ts'

type PlacemarkViewProps={track:TrackRecord;basemap:BasemapId;onBasemap:(next:BasemapId)=>void;onPhotoAI?:(sourceUrl:string)=>void;refreshToken?:number}

export function TrackOverview(props:PlacemarkViewProps) {
  return <PlacemarkView {...props} editable={false}/>
}

export interface PlacemarkEditorState {dirty:boolean;ready:boolean;save:()=>Promise<boolean>}
type PlacemarkEditorProps={onBusyChange?:(busy:boolean)=>void;history?:PlacemarkHistory;deferSave?:boolean;active?:boolean;onDraftStateChange?:(state:PlacemarkEditorState)=>void}

export function TrackPlacemarkEditor(props:PlacemarkViewProps&PlacemarkEditorProps) {
  const ownHistory=useMemo(()=>createPlacemarkHistory(props.track.id),[props.track.id])
  return <PlacemarkView {...props} history={props.history||ownHistory} editable/>
}

function PlacemarkView({track,basemap,onBasemap,editable,onBusyChange,history,onPhotoAI,refreshToken,deferSave=false,active=true,onDraftStateChange}:PlacemarkViewProps&PlacemarkEditorProps&{editable:boolean}) {
  const {points,loading,error,stateError,retry,manualOrder,orderReady,saving,orderError,saveOrder,editing,editReady,editError,movePhoto,movePoint,updatePoint,canUndo,canRedo,undo,redo,groups,groupReady,groupError,grouping,saveGroups,moveGroup,routeReady,routeError,routeContext,createPoint,deletePoints,movePointTo,dirty=false,saveDraft}=useTrackPlacemarks(track,history,{deferSave:editable&&deferSave})
  const [capture,setCapture]=useState<MapResourceCaptureControls|null>(null)
  const saveDraftRef=useRef(saveDraft);saveDraftRef.current=saveDraft
  const save=useCallback(()=>saveDraftRef.current?.()||Promise.resolve(false),[])
  const draftReady=orderReady&&editReady&&groupReady&&!loading&&!error
  useEffect(()=>{onDraftStateChange?.({dirty,ready:!!draftReady,save})},[dirty,draftReady,save,onDraftStateChange])
  const lastRefresh=useRef(refreshToken)
  useEffect(()=>{if(lastRefresh.current!==refreshToken){lastRefresh.current=refreshToken;retry()}},[refreshToken,retry])
  const {settings,updateSettings}=useMapSettings()
  const [typeFilter,setTypeFilter]=useState<PlacemarkTypeFilter>(ALL_PLACEMARK_TYPES)
  const typeOptions=useMemo(()=>placemarkTypeOptions(points),[points])
  const activeTypeFilter=useMemo<PlacemarkTypeFilter>(()=>{
    if(isAllPlacemarkTypes(typeFilter))return ALL_PLACEMARK_TYPES
    if(typeof typeFilter==='string')return typeOptions.some(option=>option.value===typeFilter)?typeFilter:ALL_PLACEMARK_TYPES
    const values=placemarkTypeValues(typeFilter)
    const remaining=values.filter(value=>typeOptions.some(option=>option.value===value))
    return remaining.length===values.length?typeFilter:remaining
  },[typeFilter,typeOptions])
  const filterActive=!isAllPlacemarkTypes(activeTypeFilter)
  const filteredPoints=useMemo(()=>filterActive?points.filter(point=>matchesPlacemarkType(point,activeTypeFilter)):points,[points,activeTypeFilter,filterActive])
  const [newDraft,setNewDraft]=useState<TrackPlacemark|null>(null)
  const [uploadingPhotos,setUploadingPhotos]=useState(false)
  const [locating,setLocating]=useState(false)
  const [newOpen,setNewOpen]=useState(false)
  const [locationChoice,setLocationChoice]=useState<{id:string|null;candidates:LocatedPlacemark[]}|null>(null)
  const [deleteRequest,setDeleteRequest]=useState<TrackPlacemark[]|null>(null)
  const [locationMessage,setLocationMessage]=useState('')
  const addButton=useRef<HTMLButtonElement>(null)
  const [selected,setSelected]=useState<string|null>(null)
  const [drawerId,setDrawerId]=useState<string|null>(null)
  const [drawerSnapshot,setDrawerSnapshot]=useState<TrackPlacemark|null>(null)
  const [groupDraft,setGroupDraft]=useState<{group:PlacemarkGroup;creating:boolean}|null>(null)
  const [checked,setChecked]=useState<string[]>([])
  const [mergeError,setMergeError]=useState('')
  const [contextMenu,setContextMenu]=useState<{x:number;y:number}|null>(null)
  const [groupTarget,setGroupTarget]=useState<string|null>(null)
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set())
  const [insertion,setInsertion]=useState<{id:string;after:boolean}|null>(null)
  const [photoTarget,setPhotoTarget]=useState<string|null>(null)
  const [selectedPhoto,setSelectedPhoto]=useState('')
  const [moveTarget,setMoveTarget]=useState('')
  const [photoGhost,setPhotoGhost]=useState<{url:string;x:number;y:number}|null>(null)
  const [gestureActive,setGestureActive]=useState(false)
  const [mapDragging,setMapDragging]=useState(false)
  const [historyMessage,setHistoryMessage]=useState('')
  const surface=useRef<HTMLDivElement>(null)
  const mapGesture=useRef(false)
  const dragging=useRef<{kind:'order';id:string}|{kind:'photo';pointId:string;url:string}|null>(null)
  const photoGesture=useRef<{pointer:number;source:HTMLElement;pointId:string;url:string;x:number;y:number;moved:boolean;select:()=>void}|null>(null)
  const orderGesture=useRef<{pointer:number;source:HTMLElement;id:string;x:number;y:number;moved:boolean}|null>(null)
  const suppressClick=useRef(false)
  const selectionAnchor=useRef<string|null>(null)
  const pendingFocus=useRef<string|null>(null)
  const list=useRef<HTMLDivElement>(null)
  const stage=useRef<HTMLDivElement>(null)
  const busy=saving||editing||grouping||uploadingPhotos
  const editDisabled=!editable||!editReady||!orderReady||!groupReady||busy||loading||!!error
  const interactionDisabled=editDisabled||!!drawerId||!!groupDraft||locating||!!newDraft||!!locationChoice||!!deleteRequest
  const orderDisabled=interactionDisabled||filterActive
  const selectionDisabled=interactionDisabled||gestureActive||mapDragging
  const photoDisabled=interactionDisabled||checked.length>1||filterActive
  const filterDisabled=busy||loading||!groupReady||!!error||gestureActive||mapDragging||!!drawerId||!!groupDraft||locating||!!newDraft||!!locationChoice||!!deleteRequest
  const historyDisabled=interactionDisabled||!!contextMenu||gestureActive||mapDragging
  const groupedIds=useMemo(()=>new Set(groups.flatMap(group=>group.memberIds)),[groups])
  const items=useMemo(()=>filteredPlacemarkListItems(points,groups,activeTypeFilter),[points,groups,activeTypeFilter])
  const checkedGroups=items.flatMap(item=>item.kind==='group'&&checked.includes(item.group.id)?[item.group]:[])
  const canMerge=checkedGroups.length>=2&&checkedGroups.length===checked.length
  const displayedGroups=filterActive?items.filter(item=>item.kind==='group').length:groups.length
  const selectedGroup=groups.find(group=>group.id===selected)
  const profileSelected=selectedGroup?(groupCoverPhoto(selectedGroup,filteredPoints)?.point.id||groupMembers(selectedGroup,filteredPoints).find(point=>!point.hidden)?.id||null):selected
  const selectedScope=selected?placemarkOrderScope(points,groups,selected):[]
  const scopeIndex=selected?selectedScope.indexOf(selected):-1
  const selectedIndex=points.findIndex(point=>point.id===selected)
  const selectedPoint=points[selectedIndex]
  const drawerPoint=points.find(point=>point.id===drawerId)||(drawerSnapshot?.id===drawerId?drawerSnapshot:null)
  const drawerUnavailable=!!drawerPoint&&!busy&&!points.some(point=>point.id===drawerPoint.id)
  const photos=selectedPoint?.images.map(imageLink).filter((url):url is string=>!!url)||[]
  useEffect(()=>{setTypeFilter(ALL_PLACEMARK_TYPES);setUploadingPhotos(false);setNewDraft(null);setLocating(false);setNewOpen(false);setLocationChoice(null);setDeleteRequest(null);setLocationMessage('');setSelected(null);setDrawerId(null);setDrawerSnapshot(null);setGroupDraft(null);setChecked([]);setMergeError('');setContextMenu(null);setGroupTarget(null);selectionAnchor.current=null;pendingFocus.current=null;setExpanded(new Set());setInsertion(null);setPhotoTarget(null);setPhotoGhost(null);setGestureActive(false);setMapDragging(false);setHistoryMessage('');dragging.current=null;photoGesture.current=null;orderGesture.current=null;mapGesture.current=false;suppressClick.current=false},[track.id])
  useEffect(()=>{
    const release=()=>{const gestures=[photoGesture.current,orderGesture.current];photoGesture.current=null;orderGesture.current=null;for(const gesture of gestures)if(gesture)try{gesture.source.releasePointerCapture(gesture.pointer)}catch{}}
    const cancel=()=>{release();clearDrag()}
    window.addEventListener('blur',cancel)
    return()=>{window.removeEventListener('blur',cancel);release()}
  },[track.id])
  useEffect(()=>{
    const container=list.current
    if(!selected||!container||container.clientHeight<=0)return
    const row=Array.from(container.querySelectorAll<HTMLElement>('[data-placemark-id]')).find(item=>item.dataset.placemarkId===selected)
    if(!row)return
    const bounds=container.getBoundingClientRect(),rowBounds=row.getBoundingClientRect()
    if(bounds.height<=0||rowBounds.height<=0)return
    const top=bounds.top+container.clientTop,bottom=top+container.clientHeight
    // Keep selection visible inside the list without scrolling its ancestors.
    if(rowBounds.top<top)container.scrollTop+=rowBounds.top-top
    else if(rowBounds.bottom>bottom)container.scrollTop+=rowBounds.bottom-bottom
  },[selected,expanded])
  useEffect(()=>{const parent=groups.find(group=>group.memberIds.includes(selected||''));if(parent)setExpanded(current=>current.has(parent.id)?current:new Set([...current,parent.id]))},[selected,groups])
  useEffect(()=>{if(!busy)setChecked(current=>{const next=current.filter(id=>points.some(point=>point.id===id)||groups.some(group=>group.id===id));return next.length===current.length?current:next})},[points,groups,busy])
  useEffect(()=>{if(selectionDisabled)setContextMenu(null)},[selectionDisabled])
  useEffect(()=>{const id=pendingFocus.current;if(active&&!busy&&id){const row=Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-placemark-id]')||[]).find(item=>item.dataset.placemarkId===id);if(row){pendingFocus.current=null;row.focus({preventScroll:true})}}},[active,busy,groups,expanded])
  useEffect(()=>{if(!busy&&selected&&groupReady&&!groups.some(group=>group.id===selected)&&!points.some(point=>point.id===selected))setSelected(null)},[selected,groups,points,groupReady,busy])
  useEffect(()=>{if(typeFilter!==activeTypeFilter){setTypeFilter(activeTypeFilter);clearSelection();setSelected(null)}},[typeFilter,activeTypeFilter])
  useEffect(()=>{
    if(!filterActive||busy||!groupReady||!selected)return
    const group=groups.find(item=>item.id===selected)
    if(group?!groupMembers(group,filteredPoints).length:!filteredPoints.some(point=>point.id===selected)){clearSelection();setSelected(null)}
  },[selected,filteredPoints,groups,filterActive,busy,groupReady])
  useEffect(()=>{setSelectedPhoto('');setMoveTarget('')},[selected])
  useEffect(()=>{if(selectedPhoto&&!photos.includes(selectedPhoto))setSelectedPhoto('')},[photos.join('\n'),selectedPhoto])
  useEffect(()=>{onBusyChange?.(busy||!!capture?.busy||gestureActive||mapDragging||locating||!!newDraft||!!locationChoice||!!deleteRequest||(deferSave&&(!!drawerId||!!groupDraft)))},[busy,capture?.busy,gestureActive,mapDragging,locating,newDraft,locationChoice,deleteRequest,deferSave,drawerId,groupDraft,onBusyChange])
  useEffect(()=>()=>onBusyChange?.(false),[onBusyChange])
  useEffect(()=>history?.subscribe(()=>setHistoryMessage('')),[history])
  useEffect(()=>{
    if(!editable||!active)return
    function keyboard(event:globalThis.KeyboardEvent){
      const action=editorHistoryShortcut(event)
      const editor=surface.current?.closest<HTMLElement>('.trk-editor')||surface.current
      if(!action||!shortcutInsideEditor(event,editor))return
      event.preventDefault()
      if(historyDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
      void restoreHistory(action)
    }
    document.addEventListener('keydown',keyboard)
    return()=>document.removeEventListener('keydown',keyboard)
  },[editable,active,historyDisabled,undo,redo])
  async function restoreHistory(action:'undo'|'redo'){
    if(historyDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current||document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'))return
    setHistoryMessage('')
    if(await (action==='undo'?undo():redo()))setHistoryMessage(action==='undo'?'已撤销上一步修改':'已重做上一步修改')
  }
  function cancelNew(){setNewDraft(null);setNewOpen(false);setLocating(false);setLocationChoice(null);setLocationMessage('');addButton.current?.focus()}
  function beginNew(){
    if(selectionDisabled||!routeReady)return
    setTypeFilter(ALL_PLACEMARK_TYPES);if(!settings.sandboxPlacemarks)updateSettings({sandboxPlacemarks:true});clearSelection();setSelected(null);setLocationMessage('');setLocating(true)
  }
  function applyLocation(id:string|null,location:LocatedPlacemark){
    setLocationChoice(null);setLocationMessage('')
    if(id){void movePointTo(id,location);return}
    const {coordinates,elevation,time,timeSource,routePosition}=location
    setNewDraft(previous=>({...previous,id:previous?.id||'local-'+crypto.randomUUID(),name:previous?.name||'',description:previous?.description||'',images:previous?.images||[],type:previous?.type||[],hidden:previous?.hidden||false,coordinates,elevation,time,timeSource,routePosition}))
    setLocating(false);setNewOpen(true)
  }
  function pickLocation(coordinates:[number,number],id:string|null=null){
    if(!routeReady||!routeContext||busy||(!id&&!locating))return
    setLocationMessage('')
    try{
      const candidates=locatePlacemarkCandidates(track.coordinates,routeContext,coordinates)
      if(!candidates.length){setLocationMessage('轨迹没有可对应的位置');return}
      if(candidates.length>1)setLocationChoice({id,candidates})
      else applyLocation(id,candidates[0])
    }catch(reason){setLocationMessage(reason instanceof Error?reason.message:'定位失败')}
  }
  function requestDelete(ids:string[],fromDrawer=false){
    if(editDisabled||(!fromDrawer&&selectionDisabled)||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    const targets=points.filter(point=>ids.includes(point.id)).map(point=>({...point,name:placemarkTitle(point)||'标注点 '+(points.indexOf(point)+1)}))
    if(targets.length){setContextMenu(null);setDeleteRequest(targets)}
  }
  async function confirmDelete(){
    if(!deleteRequest||busy)return false
    const ids=deleteRequest.map(point=>point.id),saved=await deletePoints(ids)
    if(saved){setDeleteRequest(null);clearSelection();if(drawerId&&ids.includes(drawerId))setDrawerId(null);if(selected&&ids.includes(selected))setSelected(null);setHistoryMessage('已删除 '+ids.length+' 个标注点，可撤销')}
    return saved
  }
  useEffect(()=>{
    if(!locating)return
    const cancel=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();cancelNew()}}
    document.addEventListener('keydown',cancel)
    return()=>document.removeEventListener('keydown',cancel)
  },[locating])
  function clearDrag(){dragging.current=null;setGestureActive(false);setInsertion(null);setPhotoTarget(null);setGroupTarget(null);setPhotoGhost(null)}
  function mapDragChange(value:boolean){mapGesture.current=value;setMapDragging(value)}
  function selectPlacemark(id:string){
    const parent=groups.find(group=>group.memberIds.includes(id))
    if(parent)setExpanded(current=>current.has(parent.id)?current:new Set([...current,parent.id]))
    setSelected(id)
  }
  function editPoint(id:string){if(selectionDisabled||orderGesture.current||photoGesture.current||mapGesture.current)return;clearDrag();setSelected(id);const group=groups.find(item=>item.id===id);if(group)setGroupDraft({group,creating:false});else {setDrawerSnapshot(points.find(point=>point.id===id)||null);setDrawerId(id)}}
  function toggleExpanded(id:string){if(editable&&selectionDisabled)return;setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next})}
  function toggleChecked(id:string,shiftKey=false){
    if(selectionDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    const targetGroup=groups.some(group=>group.id===id)
    const candidates=targetGroup?items.flatMap(item=>item.kind==='group'?[item.group.id]:[]):points.filter(point=>matchesPlacemarkType(point,activeTypeFilter)&&(!groupedIds.has(point.id)||Array.from(list.current?.querySelectorAll<HTMLElement>('[data-placemark-id]')||[]).some(row=>row.dataset.placemarkId===point.id))).map(point=>point.id)
    const targetIndex=candidates.indexOf(id)
    if(targetIndex<0)return
    const anchor=selectionAnchor.current
    const anchorIndex=anchor?candidates.indexOf(anchor):-1
    const range=shiftKey&&anchorIndex>=0?candidates.slice(Math.min(anchorIndex,targetIndex),Math.max(anchorIndex,targetIndex)+1):[id]
    if(!shiftKey||anchorIndex<0)selectionAnchor.current=id
    setMergeError('')
    setChecked(current=>{
      const next=new Set(current)
      const selecting=!next.has(id)
      for(const value of range){if(selecting)next.add(value);else next.delete(value)}
      return [...next]
    })
  }
  function clearSelection(){setMergeError('');setChecked([]);selectionAnchor.current=null;setContextMenu(null)}
  function changeTypeFilter(value:PlacemarkTypeFilter){
    if(filterDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    setTypeFilter(value);clearSelection();setSelected(null);pendingFocus.current=null
  }
  function selectPointFromList(id:string,event?:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean}){
    if(!editable){setSelected(id);return}
    if(event?.shiftKey||event?.ctrlKey||event?.metaKey){toggleChecked(id,event.shiftKey);return}
    if(!selectionDisabled){setChecked([id]);selectionAnchor.current=id}
    setSelected(id)
  }
  function selectGroupFromList(id:string,event:MouseEvent<HTMLButtonElement>){
    if(suppressClick.current){suppressClick.current=false;return}
    if(editable&&(event.shiftKey||event.ctrlKey||event.metaKey)){toggleChecked(id,event.shiftKey);return}
    if(editable){if(selectionDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return;setChecked([id]);selectionAnchor.current=id;setMergeError('')}
    setSelected(id);toggleExpanded(id)
  }
  async function mergeSelectedGroups(){
    if(selectionDisabled||!canMerge||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    setContextMenu(null);setMergeError('')
    try{
      const next=mergePlacemarkGroups(checkedGroups,points),mergedIds=new Set(checkedGroups.map(group=>group.id))
      const saved=await saveGroups(groups.flatMap(group=>group.id===next.id?[next]:mergedIds.has(group.id)?[]:[group]))
      if(saved){setSelected(next.id);clearSelection();pendingFocus.current=next.id;setExpanded(current=>{const result=new Set([...current].filter(id=>!mergedIds.has(id)));if(checkedGroups.some(group=>current.has(group.id)))result.add(next.id);return result});setHistoryMessage('已合并 '+checkedGroups.length+' 个分组，可撤销')}
    }catch(reason){setMergeError(reason instanceof Error?reason.message:'分组合并失败，请重试')}
  }
  function openPointMenu(event:MouseEvent<HTMLDivElement>){
    if(selectionDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    const row=event.target instanceof Element?(event.target.closest<HTMLElement>('[data-placemark-id]')||event.target.closest('.trk-overview-row')?.querySelector<HTMLElement>('[data-placemark-id]')):null
    const id=row?.dataset.placemarkId
    if(id&&!points.some(point=>point.id===id)&&!groups.some(group=>group.id===id))return
    if(id&&!checked.includes(id)){setChecked([id]);selectionAnchor.current=id}
    if(!id&&!checked.length)return
    event.preventDefault();row?.focus({preventScroll:true});setContextMenu({x:event.clientX,y:event.clientY})
  }
  async function createGroup(){
    if(selectionDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current||checked.length<2||checked.some(id=>groupedIds.has(id)||groups.some(group=>group.id===id)))return
    const memberIds=points.filter(point=>checked.includes(point.id)&&!groupedIds.has(point.id)).map(point=>point.id)
    if(memberIds.length<2)return
    const first=points.find(point=>point.id===memberIds[0])!
    const group:PlacemarkGroup={id:`group-${crypto.randomUUID()}`,name:`标记点组 ${groups.length+1}`,description:'',memberIds,coordinates:[...first.coordinates]}
    const photo=groupCoverPhoto(group,points)
    if(photo){group.cover={pointId:photo.point.id,imageUrl:photo.url};group.coordinates=[...photo.point.coordinates]}
    setContextMenu(null)
    await saveGroup(group)
  }
  async function saveGroup(next:PlacemarkGroup){
    if(editDisabled)return false
    const saved=await saveGroups([...groups.filter(group=>group.id!==next.id),next])
    if(saved){setSelected(next.id);clearSelection();pendingFocus.current=next.id;setExpanded(current=>{const result=new Set(current);if(!groups.some(group=>group.id===next.id))result.delete(next.id);return result})}
    return saved
  }
  async function dissolveGroup(id:string){
    if(editDisabled)return false
    const saved=await saveGroups(groups.filter(group=>group.id!==id))
    if(saved){if(selected===id)setSelected(null);setExpanded(current=>{const next=new Set(current);next.delete(id);return next})}
    return saved
  }
  async function toggleGroupHidden(group:PlacemarkGroup){
    if(selectionDisabled)return
    if(await saveGroups(groups.map(item=>item.id===group.id?{...item,hidden:!item.hidden}:item))&&!group.hidden&&(selected===group.id||group.memberIds.includes(selected||'')))setSelected(null)
  }
  async function toggleHidden(point:TrackPlacemark){
    if(selectionDisabled)return
    if(await updatePoint(point.id,{hidden:!point.hidden})&&selected===point.id&&!point.hidden)setSelected(null)
  }
  function startOrder(event:DragEvent<HTMLButtonElement>,id:string){
    if(event.target instanceof Element&&event.target.closest('.trk-overview-thumbnail'))return
    if(orderDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current){event.preventDefault();return}
    setContextMenu(null);dragging.current={kind:'order',id};setGestureActive(true);suppressClick.current=true
    event.dataTransfer.effectAllowed='move';event.dataTransfer.setData(ORDER_TYPE,id)
  }
  function startPhoto(event:DragEvent<HTMLElement>,pointId:string,url:string){
    if(photoGesture.current||orderGesture.current||mapGesture.current){event.preventDefault();return}
    if(photoDisabled){event.preventDefault();return}
    dragging.current={kind:'photo',pointId,url};setGestureActive(true);suppressClick.current=true
    event.dataTransfer.effectAllowed='move';event.dataTransfer.setData(PHOTO_TYPE,JSON.stringify({pointId,url}))
  }
  function joiningGroupAt(id:string,y:number,bounds:DOMRect):PlacemarkGroup|undefined{
    const source=dragging.current
    if(source?.kind!=='order'||groupedIds.has(source.id)||!points.some(point=>point.id===source.id))return
    const group=groups.find(item=>item.id===id||item.memberIds.includes(id))
    if(!group)return
    const edge=Math.min(18,bounds.height*.2)
    return bounds.height>0&&y>bounds.top+edge&&y<bounds.bottom-edge?group:undefined
  }
  async function addGroupMember(group:PlacemarkGroup,id:string){
    if(orderDisabled||groupedIds.has(id)||!points.some(point=>point.id===id))return
    const memberIds=[...group.memberIds,id]
    const added=new Set(memberIds),known=new Set(points.map(point=>point.id))
    const next={...group,memberIds:[...points.filter(point=>added.has(point.id)).map(point=>point.id),...memberIds.filter(value=>!known.has(value))]}
    if(await saveGroups(groups.map(item=>item.id===group.id?next:item))){setExpanded(current=>new Set([...current,group.id]));setSelected(id);clearSelection();pendingFocus.current=id}
  }
  function dragOver(event:DragEvent<HTMLButtonElement>,id:string){
    const photo=dragging.current?.kind==='photo'||Array.from(event.dataTransfer.types).includes(PHOTO_TYPE)
    if(photo?(photoDisabled||!points.some(point=>point.id===id)):orderDisabled)return
    if(!photo&&dragging.current?.kind!=='order')return
    const join=!photo?joiningGroupAt(id,event.clientY,event.currentTarget.getBoundingClientRect()):undefined
    if(join){event.preventDefault();event.dataTransfer.dropEffect='move';setGroupTarget(join.id);setInsertion(null);setPhotoTarget(null);return}
    setGroupTarget(null)
    if(!photo&&dragging.current?.kind==='order'&&!placemarkOrderScope(points,groups,dragging.current.id).includes(id))return
    event.preventDefault();event.dataTransfer.dropEffect='move'
    if(photo){setPhotoTarget(id);setInsertion(null)}
    else {const bounds=event.currentTarget.getBoundingClientRect();setInsertion({id,after:event.clientY>bounds.top+bounds.height/2});setPhotoTarget(null)}
  }
  function orderPointerDown(event:PointerEvent<HTMLElement>,id:string){
    if(orderDisabled||event.button!==0||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    event.preventDefault();event.stopPropagation();setContextMenu(null);suppressClick.current=false
    orderGesture.current={pointer:event.pointerId,source:event.currentTarget,id,x:event.clientX,y:event.clientY,moved:false}
    setGestureActive(true)
    try{event.currentTarget.setPointerCapture(event.pointerId)}catch{}
  }
  function orderPointerTarget(event:PointerEvent<HTMLElement>){
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLButtonElement>('.trk-overview-point')
    return target&&list.current?.contains(target)?target:null
  }
  function orderPointerMove(event:PointerEvent<HTMLElement>){
    const gesture=orderGesture.current
    if(!gesture||gesture.pointer!==event.pointerId||orderDisabled)return
    if(!gesture.moved&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<5)return
    gesture.moved=true;suppressClick.current=true;dragging.current={kind:'order',id:gesture.id}
    event.preventDefault();event.stopPropagation()
    const target=orderPointerTarget(event),id=target?.dataset.placemarkId
    const bounds=target?.getBoundingClientRect(),join=id&&bounds?joiningGroupAt(id,event.clientY,bounds):undefined
    setGroupTarget(join?.id||null);setPhotoTarget(null)
    setInsertion(!join&&id&&bounds&&placemarkOrderScope(points,groups,gesture.id).includes(id)?{id,after:event.clientY>bounds.top+bounds.height/2}:null)
    if(list.current){const rect=list.current.getBoundingClientRect();if(event.clientX>=rect.left&&event.clientX<=rect.right){if(event.clientY<rect.top+36)list.current.scrollTop-=14;else if(event.clientY>rect.bottom-36)list.current.scrollTop+=14}}
  }
  function orderPointerEnd(event:PointerEvent<HTMLElement>,cancelled=false){
    const gesture=orderGesture.current
    if(!gesture||gesture.pointer!==event.pointerId)return
    const target=!cancelled&&gesture.moved?orderPointerTarget(event):null,id=target?.dataset.placemarkId,bounds=target?.getBoundingClientRect()
    const join=id&&bounds?joiningGroupAt(id,event.clientY,bounds):undefined
    const order=id&&bounds&&!join?moveGroupedPlacemark(points,groups,gesture.id,id,event.clientY>bounds.top+bounds.height/2):null
    orderGesture.current=null
    try{gesture.source.releasePointerCapture(gesture.pointer)}catch{}
    clearDrag()
    if(cancelled||orderDisabled)return
    if(!gesture.moved){selectPlacemark(gesture.id);return}
    event.preventDefault();event.stopPropagation()
    if(join)void addGroupMember(join,gesture.id)
    else if(order)void saveOrder(order)
  }
  function orderPointerEvents(id:string):OrderPointerEvents|undefined{return editable?{onPointerDown:event=>orderPointerDown(event,id),onPointerMove:orderPointerMove,onPointerUp:orderPointerEnd,onPointerCancel:event=>orderPointerEnd(event,true),onLostPointerCapture:event=>orderPointerEnd(event,true)}:undefined}
  function scrollDuringDrag(event:DragEvent<HTMLDivElement>){
    if(!dragging.current||!list.current)return
    const bounds=list.current.getBoundingClientRect()
    if(event.clientY<bounds.top+36)list.current.scrollTop-=14
    else if(event.clientY>bounds.bottom-36)list.current.scrollTop+=14
  }
  async function transferPhoto(sourceId:string,targetId:string,url:string){
    if(photoDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current||sourceId===targetId||!points.some(point=>point.id===targetId))return
    if(await movePhoto(sourceId,targetId,url)){setSelected(targetId);setSelectedPhoto('');setMoveTarget('')}
  }
  function photoPointerDown(event:PointerEvent<HTMLElement>,pointId:string,url:string,select:()=>void){
    if(photoDisabled||event.shiftKey||event.ctrlKey||event.metaKey||event.button!==0||photoGesture.current||orderGesture.current||mapGesture.current)return
    event.preventDefault();event.stopPropagation()
    photoGesture.current={pointer:event.pointerId,source:event.currentTarget,pointId,url,x:event.clientX,y:event.clientY,moved:false,select}
    setGestureActive(true)
    try{event.currentTarget.setPointerCapture(event.pointerId)}catch{}
  }
  function photoPointerMove(event:PointerEvent<HTMLElement>){
    const gesture=photoGesture.current
    if(!gesture||gesture.pointer!==event.pointerId||editDisabled)return
    if(!gesture.moved&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<5)return
    gesture.moved=true;suppressClick.current=true
    setPhotoGhost({url:gesture.url,x:event.clientX+12,y:event.clientY+12})
    event.preventDefault();event.stopPropagation()
    dragging.current={kind:'photo',pointId:gesture.pointId,url:gesture.url}
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLButtonElement>('.trk-overview-point[data-placemark-kind="point"]')
    setPhotoTarget(target&&list.current?.contains(target)?target.dataset.placemarkId||null:null)
    if(list.current){const bounds=list.current.getBoundingClientRect();if(event.clientX>=bounds.left&&event.clientX<=bounds.right){
      if(event.clientY<bounds.top+36)list.current.scrollTop-=14
      else if(event.clientY>bounds.bottom-36)list.current.scrollTop+=14
    }}
  }
  function photoPointerEnd(event:PointerEvent<HTMLElement>,cancelled=false){
    const gesture=photoGesture.current
    if(!gesture||gesture.pointer!==event.pointerId)return
    photoGesture.current=null
    try{gesture.source.releasePointerCapture(event.pointerId)}catch{}
    clearDrag()
    if(cancelled||editDisabled)return
    if(!gesture.moved){gesture.select();return}
    event.preventDefault();event.stopPropagation()
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLButtonElement>('.trk-overview-point[data-placemark-kind="point"]')
    if(target&&list.current?.contains(target)&&target.dataset.placemarkId)void transferPhoto(gesture.pointId,target.dataset.placemarkId,gesture.url)
  }
  function drop(event:DragEvent<HTMLButtonElement>,targetId:string){
    const active=dragging.current
    const encoded=event.dataTransfer.getData(PHOTO_TYPE)
    if(active?.kind==='photo'||encoded){
      event.preventDefault()
      let photo:unknown=active?.kind==='photo'?active:null
      if(!photo)try{photo=JSON.parse(encoded)}catch{}
      clearDrag()
      if(isPhotoTransfer(photo)&&points.some(point=>point.id===photo.pointId&&point.images.some(url=>imageLink(url)===photo.url)))void transferPhoto(photo.pointId,targetId,photo.url)
      return
    }
    if(!active||active.kind!=='order'||orderDisabled)return
    event.preventDefault()
    const join=joiningGroupAt(targetId,event.clientY,event.currentTarget.getBoundingClientRect())
    if(join){clearDrag();void addGroupMember(join,active.id);return}
    const bounds=event.currentTarget.getBoundingClientRect()
    const after=event.clientY>bounds.top+bounds.height/2
    clearDrag()
    if(active.id===targetId)return
    const ids=moveGroupedPlacemark(points,groups,active.id,targetId,after)
    if(ids&&ids.some((id,index)=>id!==points[index]?.id))void saveOrder(ids)
  }
  function shift(id:string,direction:-1|1){
    if(orderDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return
    const ids=shiftGroupedPlacemark(points,groups,id,direction)
    if(ids&&ids.some((value,index)=>value!==points[index]?.id))void saveOrder(ids)
  }
  function restoreTimeOrder(){if(orderDisabled||selectionDisabled||dragging.current||photoGesture.current||orderGesture.current||mapGesture.current)return;void saveOrder(null)}
  function rowKeyDown(event:KeyboardEvent<HTMLButtonElement>,id:string){
    if(editable&&(points.some(point=>point.id===id)||groups.some(group=>group.id===id))&&(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)){
      event.preventDefault();if(selectionDisabled)return
      if(!checked.includes(id)){setChecked([id]);selectionAnchor.current=id}
      const bounds=event.currentTarget.getBoundingClientRect();setContextMenu({x:bounds.left+16,y:bounds.bottom})
    }
    else if(editable&&(event.shiftKey||event.ctrlKey||event.metaKey)&&(points.some(point=>point.id===id)||groups.some(group=>group.id===id))&&(event.key==='Enter'||event.key===' ')){event.preventDefault();suppressClick.current=false;if(!event.repeat)toggleChecked(id,event.shiftKey)}
    else if(event.altKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')){event.preventDefault();shift(id,event.key==='ArrowUp'?-1:1)}
    else if(event.key==='Enter'||event.key===' ')suppressClick.current=false
  }
  function renderPoint(point:TrackPlacemark,number:number){
    return <PointRow trackId={track.id} key={point.id} point={point} index={number-1} selected={selected===point.id}
      editable={editable} draggable={editable?!orderDisabled:undefined} photoDraggable={!photoDisabled} insertion={insertion?.id===point.id?(insertion.after?'after':'before'):null} photoTarget={photoTarget===point.id}
      selection={editable?{checked:checked.includes(point.id)}:undefined}
      actionsDisabled={selectionDisabled} onEdit={editable?()=>editPoint(point.id):undefined} onToggleHidden={editable?()=>{void toggleHidden(point)}:undefined}
      onSelect={event=>{if(suppressClick.current){suppressClick.current=false;return}selectPointFromList(point.id,event)}} onPointerDown={editable?()=>{suppressClick.current=false}:undefined} onKeyDown={editable?event=>rowKeyDown(event,point.id):undefined}
      onDragStart={editable?event=>startOrder(event,point.id):undefined} onDragOver={editable?event=>dragOver(event,point.id):undefined} onDrop={editable?event=>drop(event,point.id):undefined} onDragEnd={editable?clearDrag:undefined} onPhotoDragStart={editable?(event,url)=>startPhoto(event,point.id,url):undefined}
      orderPointerEvents={orderPointerEvents(point.id)}
      photoPointerEvents={editable?{onPointerDown:(event,url)=>photoPointerDown(event,point.id,url,()=>selectPointFromList(point.id)),onPointerMove:photoPointerMove,onPointerUp:photoPointerEnd,onPointerCancel:event=>photoPointerEnd(event,true),onLostPointerCapture:event=>photoPointerEnd(event,true)}:undefined}/>
  }
  return <div ref={surface} className={editable?'trk-placemark-editor':undefined}><style>{OVERVIEW_CSS}</style>
    {editable&&<div className="trk-placemark-toolbar">
    {editable&&<div className="trk-placemark-history" aria-label="标注点编辑历史"><div role="group" aria-label="撤销与重做">
      <button type="button" className="trk-secondary" disabled={historyDisabled||!canUndo} aria-keyshortcuts="Control+z Meta+z" title="撤销（Ctrl+Z）" onClick={()=>{void restoreHistory('undo')}}>撤销</button>
      <button type="button" className="trk-secondary" disabled={historyDisabled||!canRedo} aria-keyshortcuts="Control+Shift+z Meta+Shift+z Control+y" title="重做（Ctrl+Shift+Z / Ctrl+Y）" onClick={()=>{void restoreHistory('redo')}}>重做</button></div>
      <span className="trk-muted" role="status">{historyMessage}</span>
    </div>}
    {editable&&<div className="trk-group-selection" aria-label="标记点打组">
      <button ref={addButton} type="button" className="trk-secondary" disabled={selectionDisabled||!routeReady} onClick={beginNew}>新增标注</button>
      {(locating||newDraft)&&<button type="button" className="trk-secondary" disabled={busy} onClick={cancelNew}>取消新增</button>}
      <span className="trk-muted" role="status">已选择 {checkedGroups.length?`${checkedGroups.length} 个组${checked.length>checkedGroups.length?` · ${checked.length-checkedGroups.length} 个点`:''}`:`${checked.length} 个点`}</span><button type="button" className="trk-secondary" disabled={selectionDisabled||!canMerge} onClick={()=>{void mergeSelectedGroups()}} title="按列表顺序保留第一个分组名称，合并描述">合并分组</button>
    </div>}
    <details className="trk-placemark-help"><summary>操作提示</summary><div><p>Ctrl+Z 撤销 · Ctrl+Shift+Z / Ctrl+Y 重做</p><p>Ctrl / Cmd 点击多选 · Shift 连选</p><p>右键打组、合并或删除；拖点位到组内加入。</p><p>拖动点位排序，或用 Alt + ↑ / ↓ 调整顺序。</p></div></details>
    </div>}
    {mergeError&&<div className="trk-error" role="alert">{mergeError}</div>}
    {editable&&deferSave&&stateError&&<div className="trk-error" role="alert">{stateError}</div>}
    {contextMenu&&<PlacemarkContextMenu {...contextMenu} count={checked.length} disabled={selectionDisabled} groupDisabled={checked.some(id=>groupedIds.has(id)||groups.some(group=>group.id===id))} mergeCount={checkedGroups.length} onMerge={checkedGroups.length?()=>{void mergeSelectedGroups()}:undefined} onDelete={checkedGroups.length?undefined:()=>requestDelete(checked)} onGroup={()=>{void createGroup()}} onClear={clearSelection} onClose={()=>setContextMenu(null)}/>}
    {editable&&(locating||locationMessage||routeError)&&<div className={locationMessage||routeError?'trk-error':'trk-muted'} role="status">{locationMessage||routeError||'点击地图选择标注位置，将自动吸附到轨迹；Escape 取消新增。'}</div>}
    {photoGhost&&<img className="trk-overview-photo-ghost" src={placemarkPhotoThumbnailUrl(track.id, photoGhost.url)} alt="" aria-hidden="true" referrerPolicy="no-referrer" style={{position:'fixed',left:photoGhost.x,top:photoGhost.y,width:58,height:66,objectFit:'cover',pointerEvents:'none',zIndex:40,opacity:.85,borderRadius:6}}/>}<div className={`trk-overview${editable?' trk-placemark-editing':''}`}>
    <div className="trk-stage" ref={stage}><MapView onResourceCaptureChange={setCapture} trackId={track.id} placemarkTypeFilter={activeTypeFilter} onPlacemarkTypeFilterChange={changeTypeFilter} placemarkDisplayControlsDisabled={filterDisabled} segmentStarts={routeContext?.segmentStarts||track.segmentStarts} onPickPlacemark={editable&&locating&&!locationChoice?coordinates=>pickLocation(coordinates):undefined} points={track.coordinates} name={track.name} basemap={basemap} onBasemap={onBasemap} placemarks={groupReady?(newDraft&&!points.some(point=>point.id===newDraft.id)?[...points,newDraft]:points):[]} placemarkGroups={groupReady?groups:[]} expandedPlacemarkGroups={expanded} selectedPlacemark={newDraft?.id||selected} onSelectPlacemark={selectPlacemark} onClosePlacemark={()=>setSelected(null)} {...(editable?{onMovePlacemark:(id:string,coordinates:[number,number])=>{if(groups.some(group=>group.id===id))void moveGroup(id,coordinates);else pickLocation(coordinates,id)},onEditPlacemark:editPoint,onPlacemarkDragChange:mapDragChange,placemarkEditingDisabled:interactionDisabled||checked.length>1||gestureActive||!routeReady}:{})}/></div>
    <aside className="trk-overview-points" aria-label="轨迹标注点"><header><div className="trk-overview-capture" aria-label="地图画面保存">
      <button type="button" className="trk-secondary" disabled={!capture||capture.disabled||(deferSave&&dirty)||(editable&&interactionDisabled)} title={deferSave&&dirty?'请先保存标注点修改，再保存地图画面':capture?.disabledReason||undefined} onClick={()=>{void capture?.save()}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>{capture?.busy?'正在保存画面…':'保存到资源库'}</button>
      <small className="trk-muted">{deferSave&&dirty?'先保存标注点修改，再保存地图画面':'保存当前地图视角为图片'}</small>
      {capture?.notice&&<div className="trk-overview-capture-feedback" role="status">{capture.notice}</div>}
      {capture?.error&&<div className="trk-error" role="alert">{capture.error}{capture.retryAvailable&&<button type="button" className="trk-secondary" disabled={capture.busy} onClick={()=>{void capture.retry()}}>重试保存</button>}</div>}
    </div><h3>标注点 <small>{filterActive?`${filteredPoints.length} / ${points.length}`:points.length}{displayedGroups?` · ${displayedGroups} 个组`:''}</small></h3><span className="trk-muted">点击查看地点与图片</span>
      {editable&&<><div className="trk-overview-order"><span role="status">{busy?(deferSave?'正在处理…':'正在保存…'):orderReady?(manualOrder?'手动排序':'时间排序'):'正在读取排序…'}</span><button className="trk-secondary" disabled={orderDisabled||selectionDisabled||!manualOrder} title={filterActive?'选择全部类型后可排序':undefined} onClick={restoreTimeOrder}>恢复时间排序</button></div>
      <div className="trk-overview-order-controls"><span className="trk-muted">{filterActive?'选择全部类型后可排序':'拖动点位排序 · Alt + ↑ / ↓'}</span><button className="trk-secondary" aria-label="上移选中点位" disabled={orderDisabled||selectionDisabled||scopeIndex<=0} onClick={()=>selected&&shift(selected,-1)}>↑</button><button className="trk-secondary" aria-label="下移选中点位" disabled={orderDisabled||selectionDisabled||scopeIndex<0||scopeIndex>=selectedScope.length-1} onClick={()=>selected&&shift(selected,1)}>↓</button></div></>}
      {editable&&orderError&&<div className="trk-error" role="alert">{orderError}{!orderReady&&<button className="trk-secondary" onClick={retry}>重试读取排序</button>}</div>}
      {editable&&editError&&<div className="trk-error" role="alert">{editError}{!editReady&&<button className="trk-secondary" onClick={retry}>重试读取编辑</button>}</div>}
      {groupError&&<div className="trk-error" role="alert">{groupError}{!groupReady&&<button className="trk-secondary" onClick={retry}>重试读取分组</button>}</div>}
    </header>
      <div className="trk-overview-list" ref={list} onContextMenu={editable?openPointMenu:undefined} onDragOver={editable?scrollDuringDrag:undefined} onDragLeave={editable?event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget)){setInsertion(null);setPhotoTarget(null);setGroupTarget(null)}}:undefined}>
        {loading?<p className="trk-muted" role="status">正在读取标注点…</p>:error?<div className="trk-error" role="alert">{error}<button className="trk-secondary" onClick={retry}>重试读取</button></div>:!groupReady?(groupError?null:<p className="trk-muted" role="status">正在读取分组…</p>):points.length?items.map(item=>item.kind==='point'?renderPoint(item.point,item.number):<section className={`trk-overview-group${groupTarget===item.group.id?' trk-overview-group-drop-target':''}`} key={item.group.id} data-group-id={item.group.id}>
          <GroupRow trackId={track.id} group={item.group} number={item.number} points={item.members} selected={selected===item.group.id||item.group.memberIds.includes(selected||'')} checked={checked.includes(item.group.id)} expanded={expanded.has(item.group.id)} editable={editable} disabled={selectionDisabled} draggable={editable?!orderDisabled:undefined} joining={groupTarget===item.group.id}
            insertion={insertion?.id===item.group.id?(insertion.after?'after':'before'):null} onExpand={()=>toggleExpanded(item.group.id)} onSelect={event=>selectGroupFromList(item.group.id,event)}
            onEdit={()=>editPoint(item.group.id)} onToggleHidden={()=>{void toggleGroupHidden(item.group)}} onKeyDown={editable?event=>rowKeyDown(event,item.group.id):undefined} onPointerDown={()=>{suppressClick.current=false}}
            onDragStart={editable?event=>startOrder(event,item.group.id):undefined} onDragOver={editable?event=>dragOver(event,item.group.id):undefined} onDrop={editable?event=>drop(event,item.group.id):undefined} onDragEnd={editable?clearDrag:undefined} orderPointerEvents={orderPointerEvents(item.group.id)}/>
          <div id={`children-${item.group.id}`} hidden={!expanded.has(item.group.id)} className="trk-overview-group-children" aria-label={`${item.group.name}的子标记点`}>{expanded.has(item.group.id)&&item.members.map(point=>renderPoint(point,points.indexOf(point)+1))}</div>
        </section>):<div className="trk-overview-empty">这条轨迹没有标注点</div>}
        {groupReady&&!loading&&!error&&points.length>0&&!items.length&&<div className="trk-overview-empty">这个类型没有标记点</div>}
      </div>
      {editable&&selectedPoint&&photos.length>0&&<div className="trk-overview-photo-editor" aria-label="移动点位照片"><span className="trk-muted">拖照片到点位，或选照片后移动</span><div className="trk-overview-photo-strip">{photos.map((url,index)=><button key={url} className="trk-overview-photo-choice" aria-label={`选择第 ${index+1} 张照片，可拖到其他点位`} aria-pressed={selectedPhoto===url} disabled={photoDisabled} draggable={false} style={{touchAction:photoDisabled?undefined:'none'}} onPointerDown={event=>photoPointerDown(event,selectedPoint.id,url,()=>setSelectedPhoto(url))} onPointerMove={photoPointerMove} onPointerUp={photoPointerEnd} onPointerCancel={event=>photoPointerEnd(event,true)} onLostPointerCapture={event=>photoPointerEnd(event,true)} onClick={()=>setSelectedPhoto(url)} onDragStart={event=>startPhoto(event,selectedPoint.id,url)} onDragEnd={clearDrag}><PointThumbnail trackId={track.id} url={url} name={`第 ${index+1} 张照片`} draggable={!photoDisabled}/></button>)}</div>
        <label>移动到点位<select aria-label="照片移动到点位" value={moveTarget} disabled={photoDisabled||selectionDisabled||!selectedPhoto} onChange={event=>setMoveTarget(event.target.value)}><option value="">选择目标点位</option>{points.map((point,index)=>point.id!==selectedPoint.id&&<option key={point.id} value={point.id}>{index+1}{placemarkTitle(point)?` · ${placemarkTitle(point)}`:''}</option>)}</select></label>
        <button className="trk-secondary" disabled={photoDisabled||selectionDisabled||!selectedPhoto||!moveTarget} onClick={()=>{void transferPhoto(selectedPoint.id,moveTarget,selectedPhoto)}}>移动照片</button>
      </div>}
      {!editable&&onPhotoAI&&selectedPoint&&<div className="trk-overview-photo-editor" aria-label="点位照片 AI 图片创作">{photos.length?photos.map((url,index)=><button type="button" key={url} className="trk-secondary" onClick={()=>onPhotoAI(url)}>用第 {index+1} 张照片创作</button>):<span className="trk-muted">此点位还没有照片，请先在标注点编辑中添加照片。</span>}</div>}
    </aside>
  </div>
    {track.metrics.elevationMax !== null
      ? <ElevationChart segmentStarts={routeContext?.segmentStarts||track.segmentStarts} points={track.coordinates} name={track.name || track.filename} placemarks={groupReady?points:[]} placemarkTypeFilter={activeTypeFilter} selectedPlacemark={profileSelected} onSelectPlacemark={id=>{selectPlacemark(id);stage.current?.scrollIntoView?.({block:'nearest'})}}/>
      : <div className="trk-empty">这条轨迹没有海拔数据，没有剖面可画。</div>}
    {editable&&drawerPoint&&<PlacemarkEditDrawer trackId={track.id} key={`${track.id}:${drawerPoint.id}`} point={drawerPoint} points={points} deferSave={deferSave} saving={busy} error={editError} unavailable={drawerUnavailable}
      onUploadPhoto={file=>uploadPlacemarkPhoto(track.id,file)} onUploadBusyChange={setUploadingPhotos}
      onDelete={drawerUnavailable?undefined:()=>requestDelete([drawerPoint.id],true)} onSave={patch=>updatePoint(drawerPoint.id,patch)} onClose={()=>setDrawerId(null)}
      onReturnFocus={()=>Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-placemark-id]')||[]).find(row=>row.dataset.placemarkId===drawerPoint.id)?.focus()}/>}
    {editable&&newDraft&&newOpen&&<PlacemarkEditDrawer trackId={track.id} key={newDraft.id} point={newDraft} points={points} creating deferSave={deferSave} saving={busy} error={editError}
      onUploadPhoto={file=>uploadPlacemarkPhoto(track.id,file)} onUploadBusyChange={setUploadingPhotos}
      onSave={async patch=>{const saved=await createPoint({...newDraft,...patch});if(saved){setSelected(newDraft.id);setNewDraft(null);setNewOpen(false);setHistoryMessage('已新增标注，可撤销')}return saved}}
      onRelocate={patch=>{setNewDraft({...newDraft,...patch});setNewOpen(false);setLocating(true)}} onClose={cancelNew} onReturnFocus={()=>addButton.current?.focus()}/>}
    {editable&&locationChoice&&<PlacemarkLocationDialog candidates={locationChoice.candidates} onChoose={location=>applyLocation(locationChoice.id,location)} onCancel={()=>setLocationChoice(null)}/>}
    {editable&&deleteRequest&&<PlacemarkDeleteDialog points={deleteRequest} saving={busy} error={editError} onConfirm={confirmDelete} onCancel={()=>setDeleteRequest(null)}/>}
    {editable&&groupDraft&&<PlacemarkGroupDrawer trackId={track.id} key={`${track.id}:${groupDraft.group.id}`} group={groupDraft.group} groups={groups} points={points} creating={groupDraft.creating} deferSave={deferSave} saving={busy} error={groupError}
      onSave={saveGroup} onDissolve={groupDraft.creating?undefined:()=>dissolveGroup(groupDraft.group.id)} onClose={()=>setGroupDraft(null)}
      onReturnFocus={()=>{const row=Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-placemark-id]')||[]).find(item=>item.dataset.placemarkId===groupDraft.group.id);if(row)row.focus();else list.current?.querySelector<HTMLButtonElement>('[data-placemark-id]')?.focus()}}/>}
  </div>
}

const ORDER_TYPE='text/x-cqai-track-placemark-order'
const PHOTO_TYPE='text/x-cqai-track-photo'
function isPhotoTransfer(value:unknown):value is {pointId:string;url:string}{return !!value&&typeof value==='object'&&typeof (value as {pointId?:unknown}).pointId==='string'&&typeof (value as {url?:unknown}).url==='string'}
type PhotoPointerEvents={onPointerDown:(event:PointerEvent<HTMLElement>,url:string)=>void;onPointerMove:(event:PointerEvent<HTMLElement>)=>void;onPointerUp:(event:PointerEvent<HTMLElement>)=>void;onPointerCancel:(event:PointerEvent<HTMLElement>)=>void;onLostPointerCapture:(event:PointerEvent<HTMLElement>)=>void}
type OrderPointerEvents={onPointerDown:(event:PointerEvent<HTMLElement>)=>void;onPointerMove:(event:PointerEvent<HTMLElement>)=>void;onPointerUp:(event:PointerEvent<HTMLElement>)=>void;onPointerCancel:(event:PointerEvent<HTMLElement>)=>void;onLostPointerCapture:(event:PointerEvent<HTMLElement>)=>void}
type RowOrderEvents={onPointerDown?:()=>void;onKeyDown?:(event:KeyboardEvent<HTMLButtonElement>)=>void;onDragStart?:(event:DragEvent<HTMLButtonElement>)=>void;onDragOver?:(event:DragEvent<HTMLButtonElement>)=>void;onDrop?:(event:DragEvent<HTMLButtonElement>)=>void;onDragEnd?:()=>void;orderPointerEvents?:OrderPointerEvents}
function GroupRow({group,number,trackId,points,selected,checked,expanded,editable,disabled,draggable,insertion,joining,onExpand,onSelect,onEdit,onToggleHidden,orderPointerEvents,...events}:{group:PlacemarkGroup;number:number;trackId:string;points:TrackPlacemark[];selected:boolean;checked:boolean;expanded:boolean;editable:boolean;disabled:boolean;draggable?:boolean;insertion:'before'|'after'|null;joining:boolean;onExpand:()=>void;onSelect:(event:MouseEvent<HTMLButtonElement>)=>void;onEdit:()=>void;onToggleHidden:()=>void}&RowOrderEvents){
  const cover=groupCoverPhoto(group,points),types=groupTypes(group,points),members=groupMembers(group,points),hidden=groupHidden(group,points)
  return <div className={`trk-overview-row trk-overview-group-row${checked?' trk-overview-row-checked':''}${hidden?' trk-overview-row-hidden':''}`}>
    <button type="button" className={`trk-overview-point trk-overview-group-point${insertion?` trk-overview-insert-${insertion}`:''}`} data-placemark-id={group.id} data-placemark-kind="group" aria-label={`标记点组 G${number}：${group.name}`} aria-pressed={selected} aria-expanded={expanded} aria-controls={`children-${group.id}`} onClick={onSelect} draggable={draggable} {...events}>
      {editable&&<span className="trk-overview-drag-handle" aria-hidden="true" style={{touchAction:'none'}} {...orderPointerEvents}>⋮⋮</span>}
      <span className={`trk-overview-thumbnail trk-overview-group-thumbnail${cover?'':' trk-overview-thumbnail-empty'}`}>
        {cover&&<PointThumbnail trackId={trackId} key={cover.url} url={cover.url} name={group.name}/>}<span className="trk-overview-number">G{number}</span>
      </span><span className="trk-overview-point-text"><strong>{group.name}</strong><small>{members.length} 个子点</small>
        {types.length>0&&<span className="trk-overview-point-types">{types.map(type=><small key={type} className="trk-overview-point-type">{type}</small>)}</span>}
        {hidden&&<small>{group.hidden?'组已隐藏':'子点全部隐藏'}</small>}
        {joining&&<small className="trk-overview-group-join-hint" role="status">松开加入分组</small>}
      </span>
    </button><div className={`trk-overview-group-actions${editable?' trk-overview-row-actions':''}`}>
      {editable&&<><button type="button" aria-label={`编辑标记点组 G${number}`} title="编辑分组" disabled={disabled} onClick={onEdit}><EditIcon/></button>
      <button type="button" aria-label={`${group.hidden?'显示':'隐藏'}标记点组 G${number}`} title={group.hidden?'在地图上显示组':'在地图上隐藏组'} aria-pressed={!!group.hidden} disabled={disabled} onClick={onToggleHidden}><VisibilityIcon hidden={!!group.hidden}/></button></>}
      <button type="button" className="trk-overview-group-expand" aria-label={`${expanded?'收起':'展开'}标记点组 G${number}`} title={expanded?'收起子点':'展开子点'} aria-expanded={expanded} aria-controls={`children-${group.id}`} disabled={editable&&disabled} onClick={onExpand}><ChevronIcon expanded={expanded}/></button>
    </div>
  </div>
}
function ChevronIcon({expanded}:{expanded:boolean}){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={expanded?'m6 9 6 6 6-6':'m9 6 6 6-6 6'}/></svg>}
function PointRow({point,index,trackId,selected,onSelect,editable,draggable,photoDraggable,insertion,photoTarget,photoPointerEvents,actionsDisabled,onEdit,onToggleHidden,selection,orderPointerEvents,...events}:{point:TrackPlacemark;index:number;trackId:string;selected:boolean;onSelect:(event:MouseEvent<HTMLButtonElement>)=>void;editable:boolean;draggable?:boolean;photoDraggable:boolean;insertion:'before'|'after'|null;photoTarget:boolean;actionsDisabled:boolean;onEdit?:()=>void;onToggleHidden?:()=>void;onPhotoDragStart?:(event:DragEvent<HTMLElement>,url:string)=>void;photoPointerEvents?:PhotoPointerEvents;selection?:{checked:boolean}}&RowOrderEvents) {
  const title = placemarkTitle(point)
  const types = placemarkTypes(point)
  const elevation = formatPlacemarkElevation(point.elevation)
  const time = formatPlacemarkTime(point.time,point.timeSource)
  const url = point.images[0] ? imageLink(point.images[0]) : null
  return <div className={`trk-overview-row${point.hidden?' trk-overview-row-hidden':''}${selection?.checked?' trk-overview-row-checked':''}`}><button data-placemark-id={point.id} data-placemark-kind="point" aria-label={[`标注点 ${index+1}`,title,...types,elevation,time,point.hidden?'已在地图隐藏':''].filter(Boolean).join('，')}
    aria-pressed={selected} className={`trk-overview-point${insertion?` trk-overview-insert-${insertion}`:''}${photoTarget?' trk-overview-photo-target':''}`} onClick={onSelect} draggable={draggable} onPointerDown={events.onPointerDown} onKeyDown={events.onKeyDown} onDragStart={events.onDragStart} onDragOver={events.onDragOver} onDrop={events.onDrop} onDragEnd={events.onDragEnd}>
    {editable&&<span className="trk-overview-drag-handle" aria-hidden="true" style={{touchAction:'none'}} {...orderPointerEvents}>⋮⋮</span>}
    <span className={`trk-overview-thumbnail${url?'':' trk-overview-thumbnail-empty'}`} draggable={editable?false:undefined} onDragStart={editable?event=>url&&events.onPhotoDragStart?.(event,url):undefined} onDragEnd={events.onDragEnd} title={editable&&url?'拖动照片到其他点位':undefined}
      style={{touchAction:editable&&url?'none':undefined,cursor:editable&&url?'move':undefined}}
      onPointerDown={url?event=>photoPointerEvents?.onPointerDown(event,url):undefined} onPointerMove={photoPointerEvents?.onPointerMove} onPointerUp={photoPointerEvents?.onPointerUp} onPointerCancel={photoPointerEvents?.onPointerCancel} onLostPointerCapture={photoPointerEvents?.onLostPointerCapture}>
      {url&&<PointThumbnail trackId={trackId} key={url} url={url} name={title||`点位 ${index+1}`} draggable={photoDraggable}/>}
      <span className="trk-overview-number">{index+1}</span>
      {point.images.length>1&&<span className="trk-overview-photo-count">{point.images.length} 张</span>}
    </span>
    <span className="trk-overview-point-text">
      {title&&<strong>{title}</strong>}
      {types.length>0&&<span className="trk-overview-point-types">{types.map(type=><small key={type} className="trk-overview-point-type">{type}</small>)}</span>}
      {elevation&&<small>{elevation}</small>}
      {time&&<small className="trk-overview-time">{time}</small>}
      {point.hidden&&<small className="trk-overview-hidden-label">已隐藏</small>}
    </span>
  </button>{editable&&<div className="trk-overview-row-actions">
    <button type="button" aria-label={`编辑标注点 ${index+1}`} title="编辑点位信息" disabled={actionsDisabled} onClick={onEdit}><EditIcon/></button>
    <button type="button" aria-label={`${point.hidden?'显示':'隐藏'}标注点 ${index+1}`} title={point.hidden?'在地图上显示':'在地图上隐藏'} aria-pressed={!!point.hidden} disabled={actionsDisabled} onClick={onToggleHidden}><VisibilityIcon hidden={!!point.hidden}/></button>
  </div>}</div>
}

function EditIcon(){return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>}
function VisibilityIcon({hidden}:{hidden:boolean}){return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{hidden?<><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.5 5.5A10.5 10.5 0 0 1 12 5c5 0 9 7 9 7a18 18 0 0 1-3 3.8M6 6.8A21 21 0 0 0 3 12s4 7 9 7a10 10 0 0 0 5-1.6"/></>:<><path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="2.7"/></>}</svg>}

function PointThumbnail({url,name,trackId,draggable=false}:{url:string;name:string;trackId:string;draggable?:boolean}) {
  const [failed,setFailed] = useState(false)
  return failed ? <span className="trk-overview-thumbnail-error">图片未加载</span>
    : <img src={placemarkPhotoThumbnailUrl(trackId, url)} alt={`${name}缩略图`} draggable={false} style={{pointerEvents:draggable?'none':undefined}} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>
}
const OVERVIEW_CSS=`
.trk-placemark-toolbar{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;margin-bottom:8px}.trk-placemark-toolbar .trk-placemark-history,.trk-placemark-toolbar .trk-group-selection{margin:0}.trk-placemark-history>span:empty{display:none}.trk-placemark-help{margin-left:auto;font-size:calc(var(--trk-font-size)*.8571);color:var(--trk-muted)}.trk-placemark-help summary{min-height:var(--trk-control-height,32px);padding:5px 9px;cursor:pointer;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-surface);display:flex;align-items:center;gap:8px;list-style:none}.trk-placemark-help summary:after{content:'⌄';font-size:14px}.trk-placemark-help summary:hover{background:var(--trk-hover)}.trk-placemark-help summary:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-placemark-help>div{position:absolute;right:0;top:100%;z-index:8;width:320px;max-width:100%;padding:10px;background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);box-shadow:0 8px 24px var(--trk-shadow);color:var(--trk-text)}.trk-placemark-help p{margin:6px 0;line-height:1.6}

.trk-overview-capture{display:grid;gap:7px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid var(--trk-border)}.trk-overview-capture>button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:var(--trk-control-height,32px)}.trk-overview-capture small{line-height:1.5;font-size:calc(var(--trk-font-size)*.8571)}.trk-overview-capture-feedback{font-size:calc(var(--trk-font-size)*.8571);line-height:1.5;overflow-wrap:anywhere;color:var(--trk-notice)}.trk-overview-capture .trk-error{margin:0}.trk-overview-capture .trk-error button{margin-top:8px;width:100%}


.trk-overview-group-actions{display:flex;flex-direction:column;justify-content:center;flex:none;gap:2px}.trk-overview .trk-overview-group-actions .trk-overview-group-expand{display:grid;place-items:center;align-self:center;width:28px;height:28px;min-width:28px;min-height:28px;margin:0;padding:3px;border:0;background:transparent;box-shadow:none;color:var(--trk-muted);cursor:pointer}.trk-overview-group-expand:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-overview .trk-overview-group-actions .trk-overview-group-expand:hover{color:var(--trk-text);background:var(--trk-hover)}.trk-overview-group-drop-target{outline:2px solid var(--trk-accent);outline-offset:-2px;border-radius:var(--trk-radius-md);background:var(--trk-active)}.trk-overview-group-join-hint{color:var(--trk-accent)!important;font-weight:600}.trk-overview-row-checked .trk-overview-point{background:var(--trk-active);border-color:var(--trk-focus)}
.trk-group-selection{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin-bottom:8px;font-size:.857em}.trk-group-selection button{min-height:var(--trk-control-height,32px);font:inherit}.trk-overview-group-expand{display:grid;place-items:center;align-self:center;flex:none;min-width:44px;min-height:var(--trk-control-height,32px);padding:3px;border:0;border-radius:var(--trk-radius-sm);background:transparent;color:var(--trk-text);cursor:pointer}.trk-overview-group-expand:hover{background:var(--trk-hover)}.trk-overview-group-row{gap:0}.trk-overview-group-row .trk-overview-point{gap:7px;padding:8px 4px}.trk-overview-thumbnail.trk-overview-group-thumbnail .trk-overview-number{background:var(--trk-accent);color:var(--trk-on-accent);border-radius:7px;min-width:24px}.trk-overview-group-children{margin-left:16px;padding-left:6px;border-left:2px solid var(--trk-border)}.trk-overview-group-children[hidden]{display:none}
.trk-placemark-history{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;margin-bottom:8px;font-size:.857em}.trk-placemark-history>div{display:flex;gap:8px}.trk-placemark-history button{min-height:var(--trk-control-height,32px);min-width:64px;font:inherit;cursor:pointer}.trk-placemark-history button:disabled{opacity:.45;cursor:not-allowed}.trk-placemark-history button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-placemark-history span{line-height:1.6}
.trk-overview-point-types{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;min-width:0}.trk-overview-point-types .trk-overview-point-type{max-width:100%;margin:0;overflow-wrap:anywhere}
.trk-overview-row{display:flex;align-items:stretch;gap:0;margin-bottom:0;border-bottom:1px solid var(--trk-border);min-width:0}.trk-overview-row .trk-overview-point{flex:1;min-width:0;margin:0}.trk-overview-row-hidden .trk-overview-point{opacity:.5}.trk-overview-hidden-label{font-size:11px}.trk-overview-point-type{display:inline-block!important;font-size:11px;border:1px solid var(--trk-border);border-radius:4px;padding:1px 4px}.trk-placemark-editing .trk-overview-row-actions{display:flex;flex-direction:row;align-items:center;justify-content:center;gap:0;flex:none}.trk-placemark-editing .trk-overview-row-actions button{display:grid;place-items:center;min-width:var(--trk-control-height,32px);min-height:var(--trk-control-height,32px);padding:5px;border:0;background:transparent;color:var(--trk-muted);border-radius:var(--trk-radius-sm)}.trk-placemark-editing .trk-overview-row-actions button:hover:not(:disabled){background:var(--trk-hover);color:var(--trk-text)}.trk-placemark-editing .trk-overview-row-actions button[aria-pressed=true]{color:var(--trk-accent);background:transparent}
.trk-overview.trk-placemark-editing .trk-stage{height:clamp(540px,68vh,760px)}.trk-placemark-editing .trk-overview-points{max-height:clamp(540px,68vh,760px)}.trk-placemark-editing .trk-overview-points>header,.trk-placemark-editing .trk-overview-photo-editor{flex-shrink:0}.trk-editor .trk-overview-photo-editor label{flex-direction:row;margin:0}
.trk-overview{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:0;margin-bottom:10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);overflow:hidden;background:var(--trk-surface)}.trk-overview .trk-stage{border:0;border-radius:0;margin:0;min-width:0;height:clamp(420px,58vh,700px)}.trk-overview-points{display:flex;flex-direction:column;border-left:1px solid var(--trk-border);min-height:0;max-height:clamp(420px,58vh,700px)}.trk-overview-points header{padding:10px;border-bottom:1px solid var(--trk-border)}.trk-overview-points h3{margin:0 0 6px;font-size:1em}.trk-overview-points h3 small{color:var(--trk-muted);font-weight:400}.trk-overview-list{padding:0;flex:1;min-height:100px;overflow:auto}.trk-overview-point{display:flex;align-items:center;gap:8px;width:100%;border:1px solid transparent;border-radius:var(--trk-radius-md);background:transparent;color:inherit;text-align:left;padding:8px;margin-bottom:0;min-height:48px}.trk-overview-point:hover{background:var(--trk-hover)}.trk-overview-point[aria-pressed=true]{background:var(--trk-active);border-color:var(--trk-border)}.trk-overview-point strong{display:block;overflow-wrap:anywhere}.trk-overview-point small{display:block;color:var(--trk-muted);margin-top:2px}.trk-overview-number{border:1px solid var(--trk-border);border-radius:50%;width:30px;height:30px;display:grid;place-items:center;flex-shrink:0}.trk-overview-info{padding:10px;border-top:1px solid var(--trk-border);max-height:55%;overflow:auto}.trk-overview-info p{white-space:pre-wrap;font-size:.9286em;line-height:1.6;color:var(--trk-muted);overflow-wrap:anywhere}.trk-overview-photos{display:grid;gap:6px;margin-top:12px}.trk-overview-photos img{width:100%;height:auto;border-radius:var(--trk-radius-sm)}.trk-overview-empty{padding:30px 12px;text-align:center;color:var(--trk-muted)}.trk-overview-image-error{display:grid;gap:8px;color:var(--trk-muted);font-size:.857em}
@container(max-width:650px){.trk-overview{grid-template-columns:1fr}.trk-overview-points{border-left:0;border-top:1px solid var(--trk-border);max-height:380px}.trk-overview .trk-stage{height:420px}.trk-overview-info{max-height:230px}}
.trk-overview-point{gap:6px;min-height:48px;padding:4px 8px;align-items:center}.trk-overview-thumbnail{position:relative;display:grid;place-items:center;flex:none;width:36px;height:40px;border-radius:var(--trk-radius-sm);overflow:hidden;background:var(--trk-hover)}.trk-overview-thumbnail img{display:block;width:100%;height:100%;object-fit:cover}.trk-overview-thumbnail .trk-overview-number{position:absolute;top:3px;left:3px;width:20px;height:20px;border:0;background:var(--trk-overlay);color:var(--trk-text);font-size:11px}.trk-overview-thumbnail-empty{background:transparent}.trk-overview-thumbnail-empty .trk-overview-number{position:static;width:30px;height:30px;border:1px solid var(--trk-border);font-size:inherit}.trk-overview-photo-count{position:absolute;right:3px;bottom:3px;border-radius:3px;padding:1px 4px;background:var(--trk-overlay);color:var(--trk-overlay-text);font-size:10px}.trk-overview-point-text{min-width:0;flex:1}.trk-overview-time{font-size:.857em;line-height:1.4;white-space:normal;overflow-wrap:anywhere}.trk-overview-thumbnail-error{padding:4px;text-align:center;font-size:11px;color:var(--trk-muted)}
.trk-overview-order,.trk-overview-order-controls{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:.857em}.trk-overview-order span,.trk-overview-order-controls span{flex:1}.trk-overview-order button{font-size:inherit;padding:5px 7px}.trk-overview-order-controls button{min-width:30px;min-height:30px;padding:3px}.trk-overview-points header .trk-error{font-size:.857em;margin-top:6px;overflow-wrap:anywhere}.trk-overview-drag-handle{font-size:12px;color:var(--trk-muted);flex:none;cursor:grab}.trk-overview-point[draggable=true]{cursor:grab}.trk-overview-thumbnail[draggable=true]{cursor:move}.trk-overview-point{position:relative}.trk-overview-point.trk-overview-insert-before:before,.trk-overview-point.trk-overview-insert-after:after{content:'';position:absolute;height:3px;background:var(--trk-accent);left:0;right:0;border-radius:2px;pointer-events:none}.trk-overview-insert-before:before{top:-4px}.trk-overview-insert-after:after{bottom:-4px}.trk-overview-point.trk-overview-photo-target{outline:2px solid var(--trk-accent);outline-offset:-2px}.trk-overview-photo-editor{padding:10px;border-top:1px solid var(--trk-border);display:grid;gap:8px;font-size:.857em}.trk-overview-photo-strip{display:flex;gap:6px;overflow:auto;max-height:72px}.trk-overview-photo-choice{flex:none;width:56px;height:62px;padding:2px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:transparent}.trk-overview-photo-choice[aria-pressed=true]{outline:2px solid var(--trk-accent);outline-offset:-2px}.trk-overview-photo-choice img{width:100%;height:100%;object-fit:cover;display:block;border-radius:3px}.trk-overview-photo-editor label{display:flex;align-items:center;gap:8px}.trk-overview-photo-editor select{flex:1;min-width:0;padding:5px;background:var(--trk-surface);color:inherit;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm)}

.trk-placemark-toolbar{padding:8px;border:1px solid var(--trk-border);border-bottom:0;background:var(--trk-surface);margin-bottom:0}.trk-placemark-history>div,.trk-group-selection{gap:6px}.trk-overview-point{border-left:2px solid transparent;border-radius:0;font-size:var(--trk-ui-font-size,13px)}.trk-overview-point[aria-pressed=true],.trk-overview-row-checked .trk-overview-point{border-color:transparent;border-left-color:var(--trk-accent)}.trk-overview-point-text{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 6px}.trk-overview-point-text>strong{flex-basis:100%;font-weight:600;font-size:var(--trk-ui-font-size,13px);line-height:1.4}.trk-overview-point-text>small{display:inline;font-size:11px;line-height:1.4;margin:0}.trk-overview-point-types{margin-top:0}.trk-overview-point-types .trk-overview-point-type{font-size:10px;line-height:1.4;padding:0 3px}.trk-overview-group-actions{flex-direction:row;align-items:center;gap:0}.trk-overview .trk-overview-group-actions .trk-overview-group-expand{width:var(--trk-control-height,32px);height:var(--trk-control-height,32px);min-width:var(--trk-control-height,32px);min-height:var(--trk-control-height,32px)}.trk-overview-group-children{margin-left:12px;padding-left:2px;border-left-width:1px}.trk-overview-points h3{min-height:28px;display:flex;align-items:center;gap:6px;margin:0}.trk-overview-points>header>span{font-size:11px}.trk-overview-capture{gap:4px}.trk-overview-photo-editor select{min-height:var(--trk-input-height,30px)}.trk-overview-photo-editor>button{min-height:var(--trk-control-height,32px)}
@container(max-width:750px){.trk-overview-row-actions button,.trk-overview .trk-overview-group-actions .trk-overview-group-expand{min-width:44px;min-height:44px}.trk-overview-point{min-height:48px}.trk-overview-points header{padding:8px 10px}.trk-overview-capture>button,.trk-placemark-help summary,.trk-placemark-history button,.trk-group-selection button,.trk-overview-order-controls button{min-height:44px}}
@media(pointer:coarse){.trk-overview-row-actions button,.trk-overview .trk-overview-group-actions .trk-overview-group-expand{min-width:44px;min-height:44px}.trk-placemark-help summary,.trk-placemark-history button,.trk-group-selection button,.trk-overview-order-controls button{min-height:44px}}
`
