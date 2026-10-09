import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { annotationAnchorConnector, annotationAnchorPosition, annotationPhotoLayouts, annotationPosition, artTextPosition, photoConnector, type ArtLayout, type ArtRouteTransform, type ArtTextId, type TrackAnnotation } from '../track/annotations.ts'
import type { TrackPoint } from '../protocol.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'
import {getArtElementStyle, type ArtStyles} from '../track/art-styles.ts'

type ElementGesture = {kind:'element';id:string;photo:boolean;startX:number;startY:number;x:number;y:number;group:SVGGElement;pointer:number;connector:SVGPathElement|null;originalLine:string|null;anchorConnector:SVGPathElement|null;originalAnchorLine:string|null;moved:boolean}
type PanGesture = {kind:'pan';x:number;y:number;pointer:number}
type TextGesture = {kind:'text';id:ArtTextId;routeBound:boolean;startX:number;startY:number;x:number;y:number;group:SVGGElement;pointer:number;moved:boolean}
const editableSelector='[data-annotation-id],[data-photo-id],[data-art-text-id]'
type Gesture = ElementGesture | TextGesture | PanGesture
export type AnnotationCanvasHandle = {setRouteView:(view:ArtRouteTransform)=>void}
const initialRoute:ArtRouteTransform={x:0,y:0,scale:1}
type AnnotationCanvasProps = {
  trackId?:string
  svg:string;points:readonly TrackPoint[];annotations:readonly TrackAnnotation[]
  onChange:(annotations:TrackAnnotation[])=>void;onSelect?:(id:string,options?:{openEditor?:boolean})=>void
  onAdd?:(position:{x:number;y:number})=>void;onPan?:(delta:{x:number;y:number})=>void
  layout?:ArtLayout;route?:ArtRouteTransform;styles?:ArtStyles;onLayoutChange?:(layout:ArtLayout)=>void;onTextSelect?:(id:ArtTextId,options?:{openEditor?:boolean})=>void
  adding?:boolean;panning?:boolean;disabled?:boolean;managedPan?:boolean
}
export const AnnotationCanvas=forwardRef<AnnotationCanvasHandle,AnnotationCanvasProps>(function AnnotationCanvas({svg,points,trackId,annotations,onChange,onSelect,onAdd,onPan,layout={},route=initialRoute,styles={},onLayoutChange,onTextSelect,adding=false,panning=false,disabled=false,managedPan=false},ref) {
  const gesture=useRef<Gesture|null>(null),routeView=useRef(route)
  const container=useRef<HTMLDivElement>(null),keyboardTarget=useRef<{id:string;kind:'photo'|'annotation'|'art-text'}|null>(null)
  useLayoutEffect(()=>{
    const target=keyboardTarget.current;if(!target)return
    keyboardTarget.current=null
    const element=container.current?.querySelector(`[data-${target.kind}-id="${target.id}"]`) as HTMLElement|null
    element?.focus?.({preventScroll:true})
  },[svg])
  useLayoutEffect(()=>{
    if(!trackId)return
    for(const group of container.current?.querySelectorAll<SVGGElement>('[data-photo-id]')??[]){
      const source=annotations.find(item=>item.id===group.dataset.photoId)?.photo?.sourceUrl
      if(source)group.querySelector('image')?.setAttribute('href',placemarkPhotoThumbnailUrl(trackId,source))
    }
  },[svg,annotations,trackId])
  useLayoutEffect(()=>{container.current?.querySelectorAll(editableSelector).forEach(element=>element.classList.toggle('trk-panzoom-exclude',managedPan&&!panning))},[svg,panning,managedPan])
  const cancel=()=>{
    const current=gesture.current
    gesture.current=null
    if(current&&current.kind!=='pan'){
      current.group.removeAttribute('transform')
      if(current.kind==='element'&&current.connector&&current.originalLine)current.connector.setAttribute('d',current.originalLine)
      if(current.kind==='element'&&current.anchorConnector&&current.originalAnchorLine)current.anchorConnector.setAttribute('d',current.originalAnchorLine)
    }
    if(current)try{container.current?.releasePointerCapture(current.pointer)}catch{/* optional capture support */}
  }
  const setRouteView=(view:ArtRouteTransform)=>{
    const previous=routeView.current
    if(gesture.current && gesture.current.kind!=='pan' && (previous.x!==view.x||previous.y!==view.y||previous.scale!==view.scale))cancel()
    routeView.current=view
    container.current?.querySelector('[data-route-annotations]')?.setAttribute('transform',`translate(${view.x*view.scale} ${view.y*view.scale}) scale(${view.scale})`)
  }
  // Paint the shared annotation group without reparsing embedded photos on every pan frame.
  useImperativeHandle(ref,()=>({setRouteView}),[])
  useLayoutEffect(()=>{setRouteView(route)},[svg,route.x,route.y,route.scale])
  useEffect(()=>{window.addEventListener('blur',cancel);return()=>{cancel();window.removeEventListener('blur',cancel)}},[])
  useEffect(()=>{cancel()},[disabled,panning,adding,svg,managedPan])
  const coordinates=(event:React.PointerEvent<HTMLDivElement>|React.MouseEvent<HTMLDivElement>,routeBound=false)=>{
    const image=event.currentTarget.querySelector('svg')!,rect=image.getBoundingClientRect()
    const viewBox=image.getAttribute('viewBox')?.trim().split(/[ ,]+/u).map(Number)
    const width=viewBox?.[2]??Number(image.getAttribute('width')),height=viewBox?.[3]??Number(image.getAttribute('height'))
    const position={x:(event.clientX-rect.left)*width/Math.max(1,rect.width),y:(event.clientY-rect.top)*height/Math.max(1,rect.height)}
    const view=routeView.current
    return routeBound?{x:position.x/view.scale-view.x,y:position.y/view.scale-view.y}:position
  }
  const photoMaxX=(id:string)=>Math.min(880,Math.max(0,1200-getArtElementStyle(annotations.find(item=>item.id===id)!,styles).photoWidth))
  const move=(id:string,photo:boolean,x:number,y:number)=>onChange(annotations.map(item=>item.id!==id?item:photo?{...item,photo:{...item.photo!,x,y}}:{...item,position:{x,y}}))
  const pan=(current:PanGesture,event:React.PointerEvent<HTMLDivElement>)=>{
    const delta={x:event.clientX-current.x,y:event.clientY-current.y}
    current.x=event.clientX;current.y=event.clientY
    if(delta.x||delta.y)onPan?.(delta)
  }
  return <div ref={container} className={`trk-art-overlay-canvas${adding?' trk-svg-adding':''}${panning?' trk-svg-panning':''}`} aria-label="轨迹标注画布" style={{touchAction:'none',cursor:panning?'grab':undefined}}
    onPointerDown={event=>{
      if(disabled||event.button!==0||gesture.current||(adding&&!panning)||managedPan&&panning)return
      const group=(event.target as Element).closest<SVGGElement>(editableSelector)
      if(panning||(!group&&onPan)){
        gesture.current={kind:'pan',x:event.clientX,y:event.clientY,pointer:event.pointerId}
      }else{
        if(!group)return
        if(group.dataset.artTextId){
          if(!onLayoutChange)return
          const id=group.dataset.artTextId as ArtTextId,routeBound=id==='start'||id==='end',start=coordinates(event,routeBound),[x,y]=artTextPosition(id,points,annotations,layout,styles)
          gesture.current={kind:'text',id,routeBound,startX:start.x,startY:start.y,x,y,group,pointer:event.pointerId,moved:false}
        }else{
        const id=group.dataset.annotationId||group.dataset.photoId!,annotation=annotations.find(item=>item.id===id)
        if(!annotation)return
        const start=coordinates(event,true),photo=Boolean(group.dataset.photoId),layout=annotationPhotoLayouts(annotations,points,styles).find(item=>item.annotation.id===id)
        const [x,y]=photo?[layout!.x,layout!.y]:annotationPosition(annotation,points)
        const connector=event.currentTarget.querySelector<SVGPathElement>(`[data-connector-id="${id}"]`)
        const anchorConnector=photo?null:event.currentTarget.querySelector<SVGPathElement>(`[data-anchor-connector-id="${id}"]`)
        gesture.current={kind:'element',id,photo,startX:start.x,startY:start.y,x,y,group,pointer:event.pointerId,connector,originalLine:connector?.getAttribute('d')??null,anchorConnector,originalAnchorLine:anchorConnector?.getAttribute('d')??null,moved:false}
        }
      }
      event.preventDefault();try{event.currentTarget.setPointerCapture(event.pointerId)}catch{/* optional capture support */}
    }}
    onPointerMove={event=>{
      if(disabled){cancel();return}
      const current=gesture.current;if(!current||current.pointer!==event.pointerId)return
      if(current.kind==='pan'){pan(current,event);return}
      const position=coordinates(event,current.kind==='element'||current.routeBound),dx=position.x-current.startX,dy=position.y-current.startY
      current.moved=current.moved||Math.hypot(dx,dy)>3
      current.group.setAttribute('transform',`translate(${dx} ${dy})`)
      if(current.kind==='element'&&current.connector){
        const annotation=annotations.find(item=>item.id===current.id)!,layout=annotationPhotoLayouts(annotations,points,styles).find(item=>item.annotation.id===current.id)!
        const [mx,my]=annotationPosition(annotation,points)
        current.connector.setAttribute('d',current.photo?photoConnector(mx,my,current.x+dx,current.y+dy,layout.width,layout.height):photoConnector(current.x+dx,current.y+dy,layout.x,layout.y,layout.width,layout.height))
      }
      if(current.kind==='element'&&current.anchorConnector){
        const annotation=annotations.find(item=>item.id===current.id)!,[ax,ay]=annotationAnchorPosition(annotation,points)
        current.anchorConnector.setAttribute('d',annotationAnchorConnector(ax,ay,current.x+dx,current.y+dy))
      }
    }}
    onPointerUp={event=>{
      if(disabled){cancel();return}
      const current=gesture.current
      if(current?.pointer===event.pointerId&&current.kind==='pan'){pan(current,event);cancel();return}
      if(adding&&!panning&&event.button===0){onAdd?.(coordinates(event));return}
      if(!current||current.pointer!==event.pointerId||current.kind==='pan')return
      const position=coordinates(event,current.kind==='element'||current.routeBound),dx=position.x-current.startX,dy=position.y-current.startY
      const moved=current.moved||Math.hypot(dx,dy)>3
      cancel()
      if(moved){keyboardTarget.current={id:current.id,kind:current.kind==='text'?'art-text':current.photo?'photo':'annotation'};(current.group as unknown as HTMLElement).focus?.({preventScroll:true})}
      if(current.kind==='text'){
        if(Math.hypot(dx,dy)>3)onLayoutChange?.({...layout,[current.id]:{x:Math.max(0,Math.min(1200,current.x+dx)),y:Math.max(0,Math.min(9000,current.y+dy))}})
        onTextSelect?.(current.id,{openEditor:!moved});return
      }
      if(Math.hypot(dx,dy)>3)move(current.id,current.photo,Math.max(current.photo?0:24,Math.min(current.photo?photoMaxX(current.id):1176,current.x+dx)),Math.max(current.photo?0:120,Math.min(9000,current.y+dy)))
      onSelect?.(current.id,{openEditor:!moved})
    }}
    onDoubleClick={event=>{if(!disabled&&!adding&&!panning&&!(event.target as Element).closest(editableSelector))onAdd?.(coordinates(event))}}
    onPointerCancel={event=>{if(gesture.current?.pointer===event.pointerId)cancel()}}
    onLostPointerCapture={event=>{if(gesture.current?.pointer===event.pointerId)cancel()}}
    onKeyDown={event=>{
      if(disabled)return
      if(event.key==='Escape'){cancel();return}
      const group=(event.target as Element).closest<SVGGElement>(editableSelector),id=group?.dataset.annotationId||group?.dataset.photoId
      const textId=group?.dataset.artTextId as ArtTextId|undefined
      if(!id&&!textId)return
      if(event.key==='Enter'||event.key===' '){event.preventDefault();if(textId)onTextSelect?.(textId,{openEditor:true});else onSelect?.(id!,{openEditor:true});return}
      if(panning)return
      const delta=event.shiftKey?10:3,step:Record<string,[number,number]>={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]}
      if(!step[event.key])return
      event.preventDefault()
      if(textId){
        const [x,y]=artTextPosition(textId,points,annotations,layout,styles),[dx,dy]=step[event.key]
        keyboardTarget.current={id:textId,kind:'art-text'}
        onLayoutChange?.({...layout,[textId]:{x:Math.max(0,Math.min(1200,x+dx)),y:Math.max(0,Math.min(9000,y+dy))}});return
      }
      const annotation=annotations.find(item=>item.id===id)!,photo=Boolean(group?.dataset.photoId),photoLayout=annotationPhotoLayouts(annotations,points,styles).find(item=>item.annotation.id===id)
      const [x,y]=photo?[photoLayout!.x,photoLayout!.y]:annotationPosition(annotation,points),[dx,dy]=step[event.key]
      keyboardTarget.current={id:id!,kind:photo?'photo':'annotation'}
      move(id!,photo,Math.max(photo?0:24,Math.min(photo?photoMaxX(id!):1176,x+dx)),Math.max(photo?0:120,Math.min(9000,y+dy)))
    }}
    dangerouslySetInnerHTML={{__html:svg}} />
})
