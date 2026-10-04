// @vitest-environment jsdom
import { act,createElement,createRef,type ComponentProps } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest'
import { ArtCanvasViewport,type ArtCanvasViewportHandle } from '../src/client/ArtCanvasViewport.tsx'
import type { ArtRouteTransform } from '../src/track/annotations.ts'

let root:Root,node:HTMLDivElement,handle:ReturnType<typeof createRef<ArtCanvasViewportHandle>>,layoutWidth:number,resizeCallbacks:(()=>void)[]
type Props=Omit<ComponentProps<typeof ArtCanvasViewport>,'ref'|'children'|'overlay'>
const events=typeof window.PointerEvent==='function'?{down:'pointerdown',move:'pointermove',up:'pointerup'}:typeof window.TouchEvent==='function'?{down:'touchstart',move:'touchmove',up:'touchend'}:{down:'mousedown',move:'mousemove',up:'mouseup'}
function board(){return node.querySelector<HTMLDivElement>('.trk-art-board')!}
function camera(){return node.querySelector<HTMLDivElement>('.trk-art-route-view')!}
function view(){return handle.current!.getView()}
function near(actual:ArtRouteTransform,expected:ArtRouteTransform){expect(actual.x).toBeCloseTo(expected.x,7);expect(actual.y).toBeCloseTo(expected.y,7);expect(actual.scale).toBeCloseTo(expected.scale,7)}
async function painted(){await act(async()=>vi.advanceTimersByTime(20))}
async function render(props:Props={},exclude=true){await act(async()=>root.render(createElement(ArtCanvasViewport,{...props,ref:handle,
  children:createElement('svg',{width:1200,height:750,'data-route-svg':'route'},createElement('path',{'data-route':'route',d:'M 10 10 L 500 300'})),
  overlay:createElement('svg',{width:1200,height:750,'data-overlay-svg':'overlay'},createElement('g',{'data-marker':'marker',className:exclude?'trk-panzoom-exclude':undefined,tabIndex:0},createElement('circle',{cx:400,cy:200,r:20}),createElement('text',{x:430,y:200,fontSize:17},'固定标注')),createElement('g',{'data-photo':'photo',className:exclude?'trk-panzoom-exclude':undefined},createElement('image',{x:30,y:450,width:320,height:200,href:'data:image/png;base64,fixture'})))
})));await painted()}
async function pointer(target:EventTarget,type:string,x:number,y:number,id=1){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});Object.defineProperty(event,'pointerId',{value:id});target.dispatchEvent(event)});await painted()}
async function drag(target:EventTarget,dx:number,dy:number){await pointer(target,events.down,200,180);await pointer(document,events.move,200+dx,180+dy);await pointer(document,events.up,200+dx,180+dy)}
async function wheel(deltaY=-100,x=400,y=300){await act(async()=>board().dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:x,clientY:y,deltaY})));await painted()}
async function key(target:Element,key:string){await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));await painted()}
beforeEach(()=>{
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);layoutWidth=800;resizeCallbacks=[]
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>window.setTimeout(()=>callback(performance.now()),0));vi.stubGlobal('cancelAnimationFrame',(id:number)=>window.clearTimeout(id))
  vi.stubGlobal('ResizeObserver',class {constructor(callback:ResizeObserverCallback){resizeCallbacks.push(()=>callback([],this as unknown as ResizeObserver))}observe(){}unobserve(){}disconnect(){}})
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('trk-art-route-view')||this.classList.contains('trk-art-scene')?layoutWidth:800})
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('trk-art-route-view')||this.classList.contains('trk-art-scene')?layoutWidth*750/1200:600})
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){const isRoute=this.classList.contains('trk-art-route-view'),match=isRoute?this.style.transform.match(/scale\(([^)]+)\) translate\(([^p]+)px, ([^p]+)px\)/):null,scale=match?Number(match[1]):1,x=match?Number(match[2])*scale:0,y=match?Number(match[3])*scale:0,width=layoutWidth*scale,height=(this.classList.contains('trk-art-board')?600:layoutWidth*750/1200)*scale;return{left:x,top:y,x,y,width,height,right:x+width,bottom:y+height,toJSON(){}}})
  node=document.createElement('div');document.body.append(node);root=createRoot(node);handle=createRef<ArtCanvasViewportHandle>()
})
afterEach(async()=>{await act(async()=>root.unmount());await painted();node.remove();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})

describe('Panzoom transforms the route object inside a fixed artwork',()=>{
  it('keeps the paper, text, markers and photos outside the transformed route object',async()=>{
    await render();const paper=node.querySelector<HTMLElement>('.trk-art-scene')!,overlays=node.querySelector<HTMLElement>('.trk-art-overlays')!,original=overlays.innerHTML
    expect(camera().querySelector('[data-route]')).not.toBeNull();expect(camera().querySelector('[data-marker],[data-photo],text,image')).toBeNull()
    expect(overlays.querySelector('[data-overlay-svg]')).not.toBeNull();expect(paper.children[0]).toBe(camera());expect(paper.children[1]).toBe(overlays)
    await act(async()=>handle.current!.zoom(2));await painted();await drag(board(),40,30)
    expect(paper.style.transform).toBe('');expect(overlays.style.transform).toBe('');expect(overlays.innerHTML).toBe(original)
    expect(camera().style.transform).toBe('scale(2) translate(20px, 15px)');expect(camera().style.transformOrigin).toBe('0 0')
    expect(overlays.querySelector('text')!.getAttribute('font-size')).toBe('17')
  })
  it('pans freely in every direction at 100 percent using normalized SVG units',async()=>{
    await render();near(view(),{x:0,y:0,scale:1})
    for(const [dx,dy] of [[40,0],[-80,0],[0,50],[0,-100]]){
      const before=view();await drag(board(),dx,dy);near(view(),{x:before.x+dx*1.5,y:before.y+dy*1.5,scale:1})
      expect(board().scrollLeft).toBe(0);expect(board().scrollTop).toBe(0)
    }
    expect(camera().style.transform).toBe('scale(1) translate(-40px, -50px)');expect(Number(camera().dataset.viewX)).toBe(-60)
  })
  it('can pan from surrounding fixed artwork even when the route is smaller than its frame',async()=>{
    await render();await act(async()=>handle.current!.zoom(.75));await painted()
    expect(camera().getBoundingClientRect().width).toBeLessThan(board().getBoundingClientRect().width)
    await drag(board(),60,45);near(view(),{x:120,y:90,scale:.75})
    await drag(board(),-120,-90);near(view(),{x:-120,y:-90,scale:.75})
  })
  it('leaves overlay marker events for editing and lets the hand tool move only the route over those same markers',async()=>{
    await render();const original=node.querySelector('.trk-art-overlays')!.innerHTML
    await drag(node.querySelector('circle')!,40,50);near(view(),{x:0,y:0,scale:1})
    await render({panning:true},false);const fixed=node.querySelector('.trk-art-overlays')!.innerHTML
    await drag(node.querySelector('circle')!,40,50);near(view(),{x:60,y:75,scale:1})
    expect(node.querySelector('.trk-art-overlays')!.innerHTML).toBe(fixed);expect(original).toContain('固定标注')
  })
  it('restores controlled saved views and undo without feeding programmatic changes back as edits',async()=>{
    const onViewChange=vi.fn(),onViewCommit=vi.fn(),saved={x:120,y:60,scale:1.5}
    await render({view:saved,onViewChange,onViewCommit});near(view(),saved);expect(camera().style.transform).toBe('scale(1.5) translate(80px, 40px)')
    await render({view:{x:0,y:0,scale:1},onViewChange,onViewCommit});near(view(),{x:0,y:0,scale:1})
    await render({view:saved,onViewChange,onViewCommit});near(view(),saved)
    expect(onViewChange).not.toHaveBeenCalled();expect(onViewCommit).not.toHaveBeenCalled()
    await act(async()=>root.unmount());root=createRoot(node);handle=createRef<ArtCanvasViewportHandle>();await render({view:saved,onViewChange,onViewCommit});near(view(),saved)
    expect(onViewCommit).not.toHaveBeenCalled()
  })
  it('preserves normalized placement during responsive resize without creating an edit',async()=>{
    const saved={x:120,y:60,scale:1.5},onViewCommit=vi.fn(),onViewChange=vi.fn()
    await render({view:saved,onViewCommit,onViewChange});const oldText=node.querySelector('.trk-art-overlays text')!.outerHTML
    layoutWidth=400;await act(async()=>resizeCallbacks.forEach(callback=>callback()));await painted()
    near(view(),saved);expect(camera().style.transform).toBe('scale(1.5) translate(40px, 20px)')
    expect(node.querySelector('.trk-art-overlays text')!.outerHTML).toBe(oldText);expect(onViewCommit).not.toHaveBeenCalled();expect(onViewChange).not.toHaveBeenCalled()
  })
  it('emits continuous preview changes and exactly one commit at the end of a drag',async()=>{
    const onViewChange=vi.fn(),onViewCommit=vi.fn();await render({onViewChange,onViewCommit})
    await pointer(board(),events.down,200,180);await pointer(document,events.move,220,190);await pointer(document,events.move,240,210)
    expect(onViewChange).toHaveBeenCalledTimes(2);expect(onViewCommit).not.toHaveBeenCalled()
    await pointer(document,events.up,240,210);expect(onViewCommit).toHaveBeenCalledTimes(1);near(onViewCommit.mock.calls[0][0],{x:60,y:45,scale:1})
    await pointer(document,events.up,240,210);expect(onViewCommit).toHaveBeenCalledTimes(1)
  })
  it('anchors wheel zoom to the pointer for the top-left route origin and debounces its history commit',async()=>{
    const onViewCommit=vi.fn(),onViewChange=vi.fn();await render({view:{x:40,y:30,scale:1},onViewCommit,onViewChange})
    const before=view(),q={x:600,y:450},routePoint={x:q.x/before.scale-before.x,y:q.y/before.scale-before.y}
    await wheel();const after=view();expect(after.scale).toBeGreaterThan(1)
    expect(after.scale*(routePoint.x+after.x)).toBeCloseTo(q.x,7);expect(after.scale*(routePoint.y+after.y)).toBeCloseTo(q.y,7)
    await wheel();expect(onViewChange).toHaveBeenCalledTimes(2);expect(onViewCommit).not.toHaveBeenCalled()
    await act(async()=>vi.advanceTimersByTime(100));expect(onViewCommit).not.toHaveBeenCalled()
    await act(async()=>vi.advanceTimersByTime(60));expect(onViewCommit).toHaveBeenCalledTimes(1);near(onViewCommit.mock.calls[0][0],view())
  })
  it('keeps the native pinch focus correct and commits only when both pointers have ended',async()=>{
    const onViewCommit=vi.fn();await render({onViewCommit})
    await pointer(board(),events.down,200,240,1);await pointer(board(),events.down,400,240,2)
    const before=view(),q={x:350*1.5,y:240*1.5};await pointer(document,events.move,500,240,2)
    const after=view();expect(after.scale).toBeGreaterThan(1)
    expect(after.scale*(q.x/before.scale-before.x+after.x)).toBeCloseTo(q.x,7)
    expect(after.scale*(q.y/before.scale-before.y+after.y)).toBeCloseTo(q.y,7)
    await pointer(document,events.up,200,240,1);expect(onViewCommit).not.toHaveBeenCalled()
    await pointer(document,events.up,500,240,2);expect(onViewCommit).toHaveBeenCalledTimes(1)
  })
  it('freezes pointer, wheel, keyboard and ref controls while disabled or adding without swallowing additions',async()=>{
    const onViewCommit=vi.fn();await render({onViewCommit});await drag(board(),20,10)
    for(const guard of [{disabled:true},{adding:true}]){
      await render({...guard,onViewCommit});const before=view(),count=onViewCommit.mock.calls.length
      await drag(board(),60,60);await wheel();await key(board(),'ArrowRight')
      await act(async()=>{handle.current!.zoom(2);handle.current!.pan({x:20,y:30});handle.current!.reset()});await painted()
      near(view(),before);expect(onViewCommit).toHaveBeenCalledTimes(count)
      const event=new MouseEvent(events.down,{bubbles:true,cancelable:true,clientX:200,clientY:180});board().dispatchEvent(event);expect(event.defaultPrevented).toBe(false)
    }
  })
  it('provides screen-pixel keyboard and API controls with immediate commits and respects scale bounds',async()=>{
    const onViewCommit=vi.fn();await render({onViewCommit});await act(async()=>handle.current!.zoom(2));expect(onViewCommit).toHaveBeenCalledTimes(1);await painted()
    await act(async()=>handle.current!.pan({x:40,y:60}));await painted();near(view(),{x:30,y:45,scale:2})
    await key(board(),'ArrowRight');expect(view().x).toBe(48)
    const count=onViewCommit.mock.calls.length;await key(node.querySelector('[data-marker]')!,'ArrowRight');expect(onViewCommit).toHaveBeenCalledTimes(count)
    await act(async()=>handle.current!.zoom(9));await painted();expect(view().scale).toBe(4)
    const atMax=onViewCommit.mock.calls.length;await act(async()=>handle.current!.zoom(9));await painted();expect(onViewCommit).toHaveBeenCalledTimes(atMax)
    await act(async()=>handle.current!.zoom(.01));await painted();expect(view().scale).toBe(.25)
    await act(async()=>handle.current!.reset());await painted();near(view(),{x:0,y:0,scale:1})
  })
  it('preserves placement across children changes and cancels a drag on blur',async()=>{
    const onViewCommit=vi.fn();await render({onViewCommit});await pointer(board(),events.down,200,180);await pointer(document,events.move,230,200)
    await act(async()=>window.dispatchEvent(new Event('blur')));expect(onViewCommit).toHaveBeenCalledTimes(1)
    const before=view();await render({onViewCommit},false);near(view(),before)
    await pointer(document,events.move,300,300);near(view(),before)
  })
  it('cleans up pointer, wheel debounce and resize callbacks without committing after unmount',async()=>{
    const onViewCommit=vi.fn(),onViewChange=vi.fn();await render({onViewCommit,onViewChange});await wheel()
    const viewport=board(),route=camera(),oldTransform=route.style.transform,count=onViewChange.mock.calls.length
    await act(async()=>root.unmount());await act(async()=>vi.runAllTimers())
    expect(onViewCommit).not.toHaveBeenCalled();expect(onViewChange).toHaveBeenCalledTimes(count)
    viewport.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100}));document.dispatchEvent(new MouseEvent(events.move,{bubbles:true,clientX:200,clientY:200}));window.dispatchEvent(new Event('blur'))
    await painted();expect(route.style.transform).toBe(oldTransform);expect(onViewCommit).not.toHaveBeenCalled()
  })
})
