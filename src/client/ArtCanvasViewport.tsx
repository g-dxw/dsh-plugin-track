import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ReactNode } from 'react'
import Panzoom, { type PanzoomObject } from '@panzoom/panzoom'
import type { ArtRouteTransform } from '../track/annotations.ts'

export type ArtCanvasViewportHandle = {
  zoom:(scale:number)=>void
  pan:(delta:{x:number;y:number})=>void
  reset:()=>void
  getView:()=>ArtRouteTransform
}
type ArtCanvasViewportProps = {
  children:ReactNode
  overlay?:ReactNode
  view?:ArtRouteTransform
  disabled?:boolean
  panning?:boolean
  adding?:boolean
  onViewChange?:(view:ArtRouteTransform)=>void
  onViewCommit?:(view:ArtRouteTransform)=>void
  onScaleChange?:(scale:number)=>void
}
const initialView:ArtRouteTransform={x:0,y:0,scale:1}
function validView(view:ArtRouteTransform=initialView):ArtRouteTransform {return{x:Number.isFinite(view.x)?view.x:0,y:Number.isFinite(view.y)?view.y:0,scale:Math.max(.25,Math.min(4,Number.isFinite(view.scale)?view.scale:1))}}
function sameView(a:ArtRouteTransform,b:ArtRouteTransform) {return Math.abs(a.x-b.x)<1e-8&&Math.abs(a.y-b.y)<1e-8&&Math.abs(a.scale-b.scale)<1e-8}

export const ArtCanvasViewport=forwardRef<ArtCanvasViewportHandle,ArtCanvasViewportProps>(function ArtCanvasViewport({children,overlay,view,disabled=false,panning=false,adding=false,onViewChange,onViewCommit,onScaleChange},ref) {
  const board=useRef<HTMLDivElement>(null),scene=useRef<HTMLDivElement>(null),route=useRef<HTMLDivElement>(null),camera=useRef<PanzoomObject|null>(null)
  const frozen=useRef(disabled||adding),callbacks=useRef({onViewChange,onViewCommit,onScaleChange}),cssUnit=useRef(1),snapshot=useRef(validView(view))
  const controller=useRef<{apply:(view:ArtRouteTransform)=>void;stop:(commit:boolean)=>void;notify:(before:ArtRouteTransform,commit:boolean)=>void}|null>(null)
  frozen.current=disabled||adding;callbacks.current={onViewChange,onViewCommit,onScaleChange}
  function getView():ArtRouteTransform {
    const current=camera.current;if(!current)return{...snapshot.current}
    const {x,y}=current.getPan();return{x:x/cssUnit.current,y:y/cssUnit.current,scale:current.getScale()}
  }
  function action(change:(current:PanzoomObject)=>void) {
    const current=camera.current;if(!current||frozen.current)return
    controller.current?.stop(false);const before=getView();change(current);controller.current?.notify(before,true)
  }
  function pan(delta:{x:number;y:number}) {if(Number.isFinite(delta.x)&&Number.isFinite(delta.y))action(current=>current.pan(delta.x/current.getScale(),delta.y/current.getScale(),{relative:true,animate:false}))}
  useImperativeHandle(ref,()=>({
    zoom(scale){if(Number.isFinite(scale)&&scale>0)action(current=>current.zoom(scale,{animate:false}))},pan,
    reset(){action(current=>current.reset({animate:false,startX:0,startY:0,startScale:1}))},getView
  }),[])
  useLayoutEffect(()=>{
    const viewport=board.current!,paper=scene.current!,content=route.current!
    let alive=true,lastScale=NaN,current:PanzoomObject,wheelTimer:ReturnType<typeof setTimeout>|undefined,wheelStart:ArtRouteTransform|null=null,gestureStart:ArtRouteTransform|null=null
    const pointers=new Map<number,PointerEvent>()
    function measureWidth() {const width=content.offsetWidth||content.getBoundingClientRect().width/(current?.getScale()||snapshot.current.scale);return width>0?width:null}
    cssUnit.current=(measureWidth()||1200)/1200
    function paint() {
      if(!alive||!current)return
      const {x,y}=current.getPan(),scale=current.getScale(),next=getView()
      content.style.transform=`scale(${scale}) translate(${x}px, ${y}px)`
      content.dataset.viewX=String(next.x);content.dataset.viewY=String(next.y);content.dataset.viewScale=String(scale)
      snapshot.current=next
      if(scale!==lastScale){lastScale=scale;callbacks.current.onScaleChange?.(scale)}
    }
    const start=snapshot.current
    current=Panzoom(content,{
      canvas:true,noBind:true,animate:false,origin:'0 0',panOnlyWhenZoomed:false,minScale:.25,maxScale:4,
      startX:start.x*cssUnit.current,startY:start.y*cssUnit.current,startScale:start.scale,
      excludeClass:'trk-panzoom-exclude',disablePan:frozen.current,disableZoom:frozen.current,
      cursor:panning?'grab':'default',overflow:'hidden',setTransform(){paint()}
    })
    camera.current=current
    function notify(before:ArtRouteTransform,commit:boolean) {
      const next=getView();snapshot.current=next
      if(sameView(before,next))return
      callbacks.current.onViewChange?.({...next})
      if(commit)callbacks.current.onViewCommit?.({...next})
    }
    function finishWheel(commit:boolean) {
      if(wheelTimer!==undefined)clearTimeout(wheelTimer)
      wheelTimer=undefined;const before=wheelStart;wheelStart=null
      if(commit&&before&&!sameView(before,getView()))callbacks.current.onViewCommit?.(getView())
    }
    // Panzoom's HTML focal calculations assume a centered origin. Shift only its
    // event coordinates so our route object can use the artwork's top-left origin.
    function positioned(event:PointerEvent):PointerEvent {
      const scale=current.getScale(),rect=content.getBoundingClientRect(),dx=(content.offsetWidth||rect.width/scale)/2,dy=(content.offsetHeight||rect.height/scale)/2
      const touches=(event as unknown as TouchEvent).touches
      return {pointerId:event.pointerId,target:event.target,button:event.button,clientX:event.clientX+dx,clientY:event.clientY+dy,
        ...(touches?{touches:Array.from(touches,touch=>({clientX:touch.clientX+dx,clientY:touch.clientY+dy}))}:{}),
        preventDefault:()=>event.preventDefault(),stopPropagation:()=>event.stopPropagation()} as unknown as PointerEvent
    }
    function endGesture(commit:boolean) {
      for(const pointer of pointers.values())current.handleUp(positioned(pointer))
      pointers.clear();const before=gestureStart;gestureStart=null
      if(commit&&before&&!sameView(before,getView()))callbacks.current.onViewCommit?.(getView())
    }
    function stop(commit:boolean) {endGesture(commit);finishWheel(commit)}
    function apply(next:ArtRouteTransform) {
      next=validView(next)
      current.setOptions({startX:next.x*cssUnit.current,startY:next.y*cssUnit.current,startScale:next.scale})
      current.zoom(next.scale,{force:true,silent:true,animate:false})
      current.pan(next.x*cssUnit.current,next.y*cssUnit.current,{force:true,silent:true,relative:false,animate:false})
      paint()
    }
    function down(event:Event) {
      const pointer=event as PointerEvent,target=event.target as Element|null
      if(frozen.current||(typeof pointer.button==='number'&&pointer.button!==0)||target?.closest?.('.trk-panzoom-exclude'))return
      finishWheel(true);if(!pointers.size)gestureStart=getView()
      pointers.set(pointer.pointerId,pointer);current.handleDown(positioned(pointer))
    }
    function move(event:Event) {
      const pointer=event as PointerEvent
      if(frozen.current||!pointers.has(pointer.pointerId))return
      const before=getView();pointers.set(pointer.pointerId,pointer);current.handleMove(positioned(pointer));notify(before,false)
    }
    function up(event:Event) {
      const pointer=event as PointerEvent;if(!pointers.has(pointer.pointerId))return
      current.handleUp(positioned(pointer));pointers.delete(pointer.pointerId)
      if(!pointers.size){const before=gestureStart;gestureStart=null;if(before&&!sameView(before,getView()))callbacks.current.onViewCommit?.(getView())}
    }
    function wheel(event:WheelEvent) {
      if(frozen.current||(!event.deltaX&&!event.deltaY))return
      endGesture(true);if(!wheelStart)wheelStart=getView()
      const before=getView(),point=positioned(event as unknown as PointerEvent)
      current.zoomWithWheel({clientX:point.clientX,clientY:point.clientY,deltaX:event.deltaX,deltaY:event.deltaY,preventDefault:()=>event.preventDefault()} as WheelEvent)
      notify(before,false)
      if(wheelTimer!==undefined)clearTimeout(wheelTimer)
      wheelTimer=setTimeout(()=>finishWheel(true),150)
    }
    function resized() {
      const width=measureWidth();if(!width||Math.abs(width/1200-cssUnit.current)<1e-8)return
      const before=getView();cssUnit.current=width/1200;apply(before)
      // Rebase a gesture without converting a responsive layout change into an edit.
      for(const pointer of pointers.values())current.handleDown(positioned(pointer))
    }
    function blur(){stop(true)}
    const downEvents=current.eventNames.down.split(' '),moveEvents=current.eventNames.move.split(' '),upEvents=current.eventNames.up.split(' ')
    for(const name of downEvents)viewport.addEventListener(name,down)
    for(const name of moveEvents)document.addEventListener(name,move,{passive:true})
    for(const name of upEvents)document.addEventListener(name,up,{passive:true})
    content.addEventListener('panzoomchange',paint)
    viewport.addEventListener('wheel',wheel,{passive:false});window.addEventListener('blur',blur)
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(resized):null
    observer?.observe(paper);observer?.observe(content)
    window.addEventListener('resize',resized)
    controller.current={apply,stop,notify};paint()
    return()=>{
      alive=false;stop(false);observer?.disconnect()
      for(const name of downEvents)viewport.removeEventListener(name,down)
      for(const name of moveEvents)document.removeEventListener(name,move)
      for(const name of upEvents)document.removeEventListener(name,up)
      content.removeEventListener('panzoomchange',paint);viewport.removeEventListener('wheel',wheel)
      window.removeEventListener('blur',blur);window.removeEventListener('resize',resized)
      current.destroy();current.resetStyle();camera.current=null;controller.current=null
    }
  },[])
  useLayoutEffect(()=>{
    controller.current?.stop(true)
    camera.current?.setOptions({disablePan:disabled||adding,disableZoom:disabled||adding,cursor:panning?'grab':'default'})
  },[disabled,adding,panning])
  useLayoutEffect(()=>{
    if(view&&!sameView(validView(view),getView())){controller.current?.stop(false);controller.current?.apply(view)}
  },[view?.x,view?.y,view?.scale])
  return <div ref={board} className="trk-art-board" role="group" aria-label="SVG 画布视图" tabIndex={disabled?-1:0} onKeyDown={event=>{
    if(event.target!==event.currentTarget||frozen.current)return
    const step=event.shiftKey?60:24,directions:Record<string,{x:number;y:number}>={ArrowLeft:{x:-step,y:0},ArrowRight:{x:step,y:0},ArrowUp:{x:0,y:-step},ArrowDown:{x:0,y:step}}
    const delta=directions[event.key];if(!delta)return
    event.preventDefault();pan(delta)
  }}><div ref={scene} className="trk-art-scene"><div ref={route} className="trk-svg-canvas trk-art-route-view">{children}</div><div className="trk-art-overlays">{overlay}</div></div></div>
})
