// @vitest-environment jsdom
import { act,createElement,createRef,useState,type ComponentProps } from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
import {AnnotationCanvas,type AnnotationCanvasHandle} from '../src/client/AnnotationCanvas.tsx'
import {annotationAnchorPosition,artTextPosition,diagramCoordinates,trackSvg,validateAnnotations,type ArtCanvasSize,type ArtLayout,type TrackAnnotation} from '../src/track/annotations.ts'
import type {TrackPoint} from '../src/protocol.ts'
const points:TrackPoint[]=[[119,30,null,null],[119.01,30.01,null,null],[119.02,30,null,null]]
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fc8AAAAASUVORK5CYII='
let root:Root,node:HTMLDivElement,current:TrackAnnotation[],currentLayout:ArtLayout
type Options = Partial<Pick<ComponentProps<typeof AnnotationCanvas>,'trackId'|'onSelect'|'onPan'|'panning'|'managedPan'|'disabled'|'adding'|'onAdd'|'layout'|'onLayoutChange'|'onTextSelect'|'route'>>&{canvas?:ArtCanvasSize}
function Canvas({initial,layout:initialLayout={},onLayoutChange,canvas,...options}:{initial:TrackAnnotation[]}&Options){const[labels,setLabels]=useState(initial),[layout,setLayout]=useState(initialLayout);current=labels;currentLayout=layout;return createElement(AnnotationCanvas,{svg:trackSvg(points,{name:'路线',annotations:labels,layout,route:options.route,canvas,interactive:true}),points,annotations:labels,layout,onLayoutChange:next=>{setLayout(next);onLayoutChange?.(next)},onChange:setLabels,...options})}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);node=document.createElement('div');document.body.append(node);root=createRoot(node);vi.spyOn(SVGElement.prototype,'getBoundingClientRect').mockImplementation(()=>({left:0,top:0,width:1200,height:900,right:1200,bottom:900,x:0,y:0,toJSON(){}}))})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function render(initial:TrackAnnotation[],options:Options={}){await act(async()=>root.render(createElement(Canvas,{initial,...options})));const svg=node.querySelector('svg')!;vi.mocked(svg.getBoundingClientRect).mockReturnValue({left:0,top:0,width:1200,height:Number(svg.getAttribute('height')),right:1200,bottom:900,x:0,y:0,toJSON(){}})}
async function event(element:Element,type:string,x:number,y:number,id=1){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:id});element.dispatchEvent(event)})}
describe('same-canvas draggable route markers and check-in photos',()=>{
 it('moves a marker freely on the canvas without changing its source point or track coordinates',async()=>{
  const original=JSON.stringify(points);await render([{id:'marker',visible:true,pointIndex:0,label:'打卡',color:'#7c3aed',kind:'checkin'}])
  const marker=node.querySelector('[data-annotation-id]')!,coordinates=diagramCoordinates(points)
  await event(marker,'pointerdown',...coordinates[0]);await event(node.firstElementChild!,'pointermove',...coordinates[2]);await event(node.firstElementChild!,'pointerup',...coordinates[2])
  expect(current[0].pointIndex).toBe(0);expect(current[0].position).toEqual({x:coordinates[2][0],y:coordinates[2][1]});expect(current[0].kind).toBe('checkin');expect(JSON.stringify(points)).toBe(original)
 })
 it('cancels a pointer gesture without changing saved marker metadata',async()=>{
  await render([{id:'marker',visible:true,pointIndex:0,label:'休息',color:'#7c3aed',kind:'rest'}]);const marker=node.querySelector('[data-annotation-id]')!
  await event(marker,'pointerdown',100,200);await event(node.firstElementChild!,'pointermove',600,400);await event(node.firstElementChild!,'pointercancel',600,400)
  expect(current[0].pointIndex).toBe(0);expect(marker.getAttribute('transform')).toBeNull()
 })
 it('moves a local photo card inside the same SVG and exports the embedded image',async()=>{
  await render([{id:'marker',visible:true,pointIndex:1,label:'山口照片',color:'#7c3aed',photo:{dataUrl:image,x:60,y:690}}]);const photo=node.querySelector('[data-photo-id]')!
  await event(photo,'pointerdown',60,690);await event(node.firstElementChild!,'pointermove',160,740);await event(node.firstElementChild!,'pointerup',160,740)
  expect(current[0].photo).toEqual({dataUrl:image,x:160,y:740});expect(node.querySelector('image')?.getAttribute('href')).toBe(image);expect(node.querySelector('[data-connector-id]')?.getAttribute('pointer-events')).toBe('none')
  expect(Number(node.querySelector('svg')!.getAttribute('height'))).toBeGreaterThanOrEqual(940)
 })
 it('rejects remote or executable image references and excessive photo positions',()=>{
  const annotation={id:'marker',visible:true,pointIndex:1,label:'照片',color:'#7c3aed'}
  expect(()=>validateAnnotations([{...annotation,photo:{dataUrl:'https://example.com/photo.jpg'}}],3)).toThrow()
  expect(()=>validateAnnotations([{...annotation,photo:{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}}],3)).toThrow()
  expect(()=>validateAnnotations([{...annotation,photo:{dataUrl:image,x:999}}],3)).toThrow()
  expect(()=>trackSvg(points,{name:'路线',annotations:[{...annotation,label:'\ud800'}]})).toThrow()
 })
})
describe('independent pointer and focus-loss cancellation',()=>{
 it('keeps keyboard focus on the moved element for repeated arrow-key adjustments',async()=>{
  await render([{id:'marker',visible:true,pointIndex:0,label:'山口',color:'#7c3aed'}])
  const [x,y]=diagramCoordinates(points)[0]
  for(let index=0;index<2;index++)await act(async()=>{node.querySelector('[data-annotation-id]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))})
  expect(current[0].position).toEqual({x:x+6,y});expect(document.activeElement?.getAttribute('data-annotation-id')).toBe('marker')
 })
 it('updates photo connectors during the gesture and restores them on cancellation',async()=>{
  await render([{id:'marker',visible:true,pointIndex:1,label:'照片',color:'#7c3aed',photo:{dataUrl:image,x:60,y:690}}])
  const connector=node.querySelector('[data-connector-id]')!,original=connector.getAttribute('d'),canvas=node.firstElementChild!
  await event(node.querySelector('[data-photo-id]')!,'pointerdown',60,690);await event(canvas,'pointermove',160,740)
  expect(connector.getAttribute('d')).not.toBe(original)
  await event(canvas,'pointercancel',160,740);expect(connector.getAttribute('d')).toBe(original);expect(current[0].photo?.x).toBe(60)
 })
 it('ignores a second pointer and cancels focus loss without moving saved labels',async()=>{
  await render([{id:'marker',visible:true,pointIndex:0,label:'山口',color:'#7c3aed'}]);const marker=node.querySelector('[data-annotation-id]')!,coords=diagramCoordinates(points),canvas=node.firstElementChild!
  await event(marker,'pointerdown',...coords[0],7);await event(canvas,'pointermove',...coords[2],7);await event(canvas,'pointerup',...coords[1],8)
  expect(current[0].pointIndex).toBe(0);expect(marker.getAttribute('transform')).not.toBeNull()
  await act(async()=>window.dispatchEvent(new Event('blur')));expect(marker.getAttribute('transform')).toBeNull();await event(canvas,'pointerup',...coords[2],7);expect(current[0].pointIndex).toBe(0)
 })
})

describe('canvas tools and selection intent',()=>{
 const marker:TrackAnnotation={id:'marker',visible:true,pointIndex:0,label:'山口',color:'#7c3aed',photo:{dataUrl:image,x:60,y:690}}
 it('pans blank canvas in screen pixels without changing annotations',async()=>{
  const onPan=vi.fn(),onSelect=vi.fn();await render([marker],{onPan,onSelect})
  const original=JSON.stringify(current),canvas=node.firstElementChild!
  await event(node.querySelector('svg>rect')!,'pointerdown',400,450)
  await event(canvas,'pointermove',450,480);await event(canvas,'pointermove',470,470);await event(canvas,'pointerup',475,475)
  expect(onPan.mock.calls.map(call=>call[0])).toEqual([{x:50,y:30},{x:20,y:-10},{x:5,y:5}])
  expect(JSON.stringify(current)).toBe(original);expect(onSelect).not.toHaveBeenCalled()
 })
 it('uses the hand tool over markers and photos without moving or opening them',async()=>{
  const onPan=vi.fn(),onSelect=vi.fn();await render([marker],{onPan,onSelect,panning:true})
  const original=JSON.stringify(current),canvas=node.firstElementChild!
  for(const selector of ['[data-annotation-id]','[data-photo-id]']){
   await event(node.querySelector(selector)!,'pointerdown',100,200)
   await event(canvas,'pointermove',160,230);await event(canvas,'pointerup',160,230)
  }
  expect(onPan.mock.calls.map(call=>call[0])).toEqual([{x:60,y:30},{x:60,y:30}])
  expect(JSON.stringify(current)).toBe(original);expect(onSelect).not.toHaveBeenCalled()
 })
 it('opens a clicked marker while keeping a dragged marker in the canvas',async()=>{
  const onSelect=vi.fn();await render([marker],{onSelect})
  const coords=diagramCoordinates(points),canvas=node.firstElementChild!
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',...coords[0]);await event(canvas,'pointerup',...coords[0])
  expect(onSelect).toHaveBeenLastCalledWith('marker',{openEditor:true})
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',...coords[0]);await event(canvas,'pointermove',...coords[1]);await event(canvas,'pointerup',...coords[1])
  expect(onSelect).toHaveBeenLastCalledWith('marker',{openEditor:false})
  expect(current[0].position).toEqual({x:coords[1][0],y:coords[1][1]})
  expect(document.activeElement?.getAttribute('data-annotation-id')).toBe('marker')
 })
 it('converts scaled screen movement into SVG coordinates',async()=>{
  const onSelect=vi.fn();await render([marker],{onSelect})
  const svg=node.querySelector('svg')!,height=Number(svg.getAttribute('height')),[x,y]=diagramCoordinates(points)[0]
  vi.mocked(svg.getBoundingClientRect).mockReturnValue({left:20,top:30,width:600,height:height/2,right:620,bottom:30+height/2,x:20,y:30,toJSON(){}})
  const canvas=node.firstElementChild!
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',20+x/2,30+y/2)
  await event(canvas,'pointermove',20+x/2+50,30+y/2+25);await event(canvas,'pointerup',20+x/2+50,30+y/2+25)
  expect(current[0].position?.x).toBeCloseTo(x+100);expect(current[0].position?.y).toBeCloseTo(y+50)
 })
 it('cancels marker movement when the canvas becomes disabled',async()=>{
  const onSelect=vi.fn();await render([marker],{onSelect})
  const canvas=node.firstElementChild!,element=node.querySelector('[data-annotation-id]')!
  await event(element,'pointerdown',100,200);await event(canvas,'pointermove',160,260)
  expect(element.getAttribute('transform')).not.toBeNull()
  await render([marker],{onSelect,disabled:true})
  expect(element.getAttribute('transform')).toBeNull()
  await event(canvas,'pointerup',160,260);expect(current[0].position).toBeUndefined();expect(onSelect).not.toHaveBeenCalled()
 })
 it('ends pan gestures on cancellation, capture loss and window blur',async()=>{
  const onPan=vi.fn();await render([marker],{onPan,panning:true})
  const canvas=node.firstElementChild!
  for(const stop of ['pointercancel','lostpointercapture','blur']){
   await event(node.querySelector('svg>rect')!,'pointerdown',100,200)
   await event(canvas,'pointermove',120,210)
   if(stop==='blur')await act(async()=>window.dispatchEvent(new Event('blur')))
   else await event(canvas,stop,120,210)
   const calls=onPan.mock.calls.length
   await event(canvas,'pointermove',180,280);await event(canvas,'pointerup',180,280)
   expect(onPan).toHaveBeenCalledTimes(calls)
  }
  expect(current[0].position).toBeUndefined()
 })
 it('suppresses hand-tool additions and cancels a gesture when tools change',async()=>{
  const onPan=vi.fn(),onAdd=vi.fn();await render([marker],{onPan,onAdd,panning:true})
  const canvas=node.firstElementChild!
  await event(node.querySelector('svg>rect')!,'pointerdown',100,200);await event(canvas,'pointermove',120,210)
  await act(async()=>canvas.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:300,clientY:350})))
  expect(onAdd).not.toHaveBeenCalled()
  await render([marker],{onPan,onAdd,panning:false})
  await event(canvas,'pointermove',180,280);await event(canvas,'pointerup',180,280)
  expect(onPan).toHaveBeenCalledTimes(1)
 })
 it('keeps keyboard editing accessible outside the hand tool',async()=>{
  const onSelect=vi.fn();await render([marker],{onSelect})
  for(const key of ['Enter',' '])await act(async()=>node.querySelector('[data-annotation-id]')!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})))
  expect(onSelect).toHaveBeenLastCalledWith('marker',{openEditor:true})
  await render([marker],{onSelect,panning:true,onPan:vi.fn()})
  await act(async()=>node.querySelector('[data-annotation-id]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
  expect(current[0].position).toBeUndefined()
 })
})


describe('framework-managed viewport gesture ownership',()=>{
 it('excludes editable marker and photo groups from viewport panning while keeping marker movement',async()=>{
  const annotation:TrackAnnotation={id:'managed',pointIndex:1,label:'打卡',color:'#7c3aed',kind:'checkin',photo:{dataUrl:image,x:60,y:690}},onSelect=vi.fn()
  await render([annotation],{managedPan:true,onSelect})
  for(const selector of ['[data-annotation-id]','[data-photo-id]'])expect(node.querySelector(selector)?.classList.contains('trk-panzoom-exclude')).toBe(true)
  const [x,y]=diagramCoordinates(points)[1],canvas=node.firstElementChild!
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',x,y)
  await event(canvas,'pointermove',x+20,y+10);await event(canvas,'pointerup',x+20,y+10)
  expect(current[0].position).toEqual({x:x+20,y:y+10});expect(onSelect).toHaveBeenLastCalledWith('managed',{openEditor:false})
 })
 it('lets the framework own hand-mode pointer events without taking capture or changing annotations',async()=>{
  const annotation:TrackAnnotation={id:'managed',pointIndex:1,label:'打卡',color:'#7c3aed',kind:'checkin'},onSelect=vi.fn(),onPan=vi.fn()
  await render([annotation],{managedPan:true,panning:true,onSelect,onPan})
  const canvas=node.firstElementChild!,capture=vi.fn();Object.assign(canvas,{setPointerCapture:capture})
  const marker=node.querySelector('[data-annotation-id]')!,original=JSON.stringify(current)
  expect(marker.classList.contains('trk-panzoom-exclude')).toBe(false)
  const start=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:100,clientY:200});Object.defineProperty(start,'pointerId',{value:1})
  await act(async()=>marker.dispatchEvent(start));await event(canvas,'pointermove',150,240);await event(canvas,'pointerup',150,240)
  expect(start.defaultPrevented).toBe(false);expect(capture).not.toHaveBeenCalled();expect(onPan).not.toHaveBeenCalled();expect(onSelect).not.toHaveBeenCalled();expect(JSON.stringify(current)).toBe(original)
 })
})


describe('editable text outside the independent route layer',()=>{
 const annotation:TrackAnnotation={id:'outer',pointIndex:1,label:'打卡',color:'#7c3aed',kind:'checkin',photo:{dataUrl:image,x:60,y:690}}
 it('moves title and direction text independently in scaled scene coordinates without changing the route or point data',async()=>{
  const onLayoutChange=vi.fn(),onTextSelect=vi.fn();await render([annotation],{managedPan:true,onLayoutChange,onTextSelect})
  const originalRoute=node.querySelector('[data-route-layer]')!.outerHTML,originalAnnotations=JSON.stringify(current),svg=node.querySelector('svg')!,height=Number(svg.getAttribute('height'))
  vi.mocked(svg.getBoundingClientRect).mockReturnValue({left:20,top:30,width:600,height:height/2,right:620,bottom:30+height/2,x:20,y:30,toJSON(){}})
  const canvas=node.firstElementChild!,title=node.querySelector('[data-art-text-id="title"]')!,[tx,ty]=artTextPosition('title',points,[annotation])
  expect(title.classList.contains('trk-panzoom-exclude')).toBe(true)
  await event(title,'pointerdown',20+tx/2,30+ty/2);await event(canvas,'pointermove',20+tx/2+40,30+ty/2+30);await event(canvas,'pointerup',20+tx/2+40,30+ty/2+30)
  expect(currentLayout).toEqual({title:{x:tx+80,y:ty+60}});expect(onTextSelect).toHaveBeenLastCalledWith('title',{openEditor:false})
  const [nx,ny]=artTextPosition('north',points,[annotation],currentLayout),north=node.querySelector('[data-art-text-id="north"]')!
  await event(north,'pointerdown',20+nx/2,30+ny/2);await event(canvas,'pointermove',20+nx/2+20,30+ny/2-20);await event(canvas,'pointerup',20+nx/2+20,30+ny/2-20)
  expect(currentLayout).toEqual({title:{x:tx+80,y:ty+60},north:{x:nx+40,y:ny-40}})
  expect(onLayoutChange).toHaveBeenCalledTimes(2);expect(onTextSelect).toHaveBeenLastCalledWith('north',{openEditor:false})
  expect(node.querySelector('[data-route-layer]')!.outerHTML).toBe(originalRoute);expect(JSON.stringify(current)).toBe(originalAnnotations)
 })
 it('keeps focus for repeated text keyboard adjustments and opens text settings without adding a point',async()=>{
  const onTextSelect=vi.fn(),onAdd=vi.fn();await render([annotation],{onTextSelect,onAdd})
  for(const [key,shiftKey] of [['ArrowRight',false],['ArrowRight',false],['ArrowDown',true]] as const)await act(async()=>node.querySelector('[data-art-text-id="title"]')!.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey,bubbles:true})))
  expect(currentLayout.title).toEqual({x:56,y:72});expect(document.activeElement?.getAttribute('data-art-text-id')).toBe('title')
  for(const key of ['Enter',' '])await act(async()=>node.querySelector('[data-art-text-id="title"]')!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})))
  expect(onTextSelect).toHaveBeenLastCalledWith('title',{openEditor:true})
  await act(async()=>node.querySelector('[data-art-text-id="title"] text')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:56,clientY:72})))
  expect(onAdd).not.toHaveBeenCalled();expect(current).toEqual([annotation])
 })
 it('opens clicked text settings while a completed drag selects without opening a drawer',async()=>{
  const onTextSelect=vi.fn();await render([],{onTextSelect})
  await event(node.querySelector('[data-art-text-id="title"]')!,'pointerdown',50,62);await event(node.firstElementChild!,'pointerup',50,62)
  expect(onTextSelect).toHaveBeenLastCalledWith('title',{openEditor:true});expect(currentLayout).toEqual({})
 })
 it('restores text previews on cancellation, focus loss and Escape and ignores a second pointer',async()=>{
  const onLayoutChange=vi.fn(),onTextSelect=vi.fn();await render([annotation],{onLayoutChange,onTextSelect})
  const canvas=node.firstElementChild!,text=node.querySelector('[data-art-text-id="title"]')!
  for(const stop of ['pointercancel','lostpointercapture','blur','Escape']){
   await event(text,'pointerdown',50,62,7);await event(canvas,'pointermove',150,162,7);await event(canvas,'pointerup',150,162,8)
   expect(text.getAttribute('transform')).toBe('translate(100 100)')
   if(stop==='blur')await act(async()=>window.dispatchEvent(new Event('blur')))
   else if(stop==='Escape')await act(async()=>text.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
   else await event(canvas,stop,150,162,7)
   expect(text.getAttribute('transform')).toBeNull();await event(canvas,'pointerup',150,162,7)
  }
  expect(currentLayout).toEqual({});expect(onLayoutChange).not.toHaveBeenCalled();expect(onTextSelect).not.toHaveBeenCalled();expect(current).toEqual([annotation])
 })
 it('cancels text dragging when disabled and leaves hand-mode events to the viewport',async()=>{
  const onLayoutChange=vi.fn(),onTextSelect=vi.fn(),onAdd=vi.fn();await render([annotation],{managedPan:true,onLayoutChange,onTextSelect,onAdd})
  const canvas=node.firstElementChild!,text=node.querySelector('[data-art-text-id="title"]')!
  await event(text,'pointerdown',50,62);await event(canvas,'pointermove',150,162)
  await render([annotation],{managedPan:true,onLayoutChange,onTextSelect,onAdd,disabled:true});expect(text.getAttribute('transform')).toBeNull()
  await event(canvas,'pointerup',150,162);await act(async()=>node.querySelector('[data-art-text-id="title"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
  await render([annotation],{managedPan:true,onLayoutChange,onTextSelect,onAdd,panning:true})
  const handText=node.querySelector('[data-art-text-id="title"]')!,capture=vi.fn();Object.assign(canvas,{setPointerCapture:capture})
  expect(handText.classList.contains('trk-panzoom-exclude')).toBe(false)
  const start=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:50,clientY:62});Object.defineProperty(start,'pointerId',{value:1})
  await act(async()=>handText.dispatchEvent(start));await event(canvas,'pointermove',150,162);await event(canvas,'pointerup',150,162)
  await act(async()=>{handText.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));handText.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:50,clientY:62}))})
  expect(start.defaultPrevented).toBe(false);expect(capture).not.toHaveBeenCalled();expect(currentLayout).toEqual({});expect(current).toEqual([annotation])
  expect(onLayoutChange).not.toHaveBeenCalled();expect(onTextSelect).not.toHaveBeenCalled();expect(onAdd).not.toHaveBeenCalled()
 })
})


describe('route-linked coordinate handling',()=>{
 it('cancels an individual drag when the shared route camera changes, retaining photo bytes and positions',async()=>{
  const marker:TrackAnnotation={id:'live',visible:true,pointIndex:1,label:'山口',color:'#7c3aed',position:{x:400,y:300},photo:{dataUrl:image,x:50,y:600}}
  const ref=createRef<AnnotationCanvasHandle>(),onChange=vi.fn(),onSelect=vi.fn()
  await act(async()=>root.render(createElement(AnnotationCanvas,{ref,svg:trackSvg(points,{name:'路线',annotations:[marker],layer:'overlay',interactive:true}),points,annotations:[marker],onChange,onSelect})))
  const canvas=node.firstElementChild!,photo=node.querySelector('[data-photo-id]')!,connector=node.querySelector('[data-connector-id]')!,originalLine=connector.getAttribute('d'),sourceSvg=node.querySelector('svg')!
  await event(photo,'pointerdown',60,620);await event(canvas,'pointermove',90,640)
  expect(photo.getAttribute('transform')).not.toBeNull();expect(connector.getAttribute('d')).not.toBe(originalLine)
  await act(async()=>ref.current!.setRouteView({x:40,y:-20,scale:1.5}))
  expect(node.querySelector('svg')).toBe(sourceSvg);expect(node.querySelector('[data-photo-id]')).toBe(photo)
  expect(photo.getAttribute('transform')).toBeNull();expect(connector.getAttribute('d')).toBe(originalLine)
  await event(canvas,'pointerup',90,640)
  expect(onChange).not.toHaveBeenCalled();expect(onSelect).not.toHaveBeenCalled();expect(photo.querySelector('image')?.getAttribute('href')).toBe(image)
  expect(node.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(60 -30) scale(1.5)')
 })
 it('keeps a shared route transform when cancelling a local endpoint text drag',async()=>{
  const route={x:20,y:-10,scale:1.5},onLayoutChange=vi.fn()
  await render([],{route,onLayoutChange})
  const text=node.querySelector('[data-art-text-id="start"]')!,parent=text.closest('[data-route-annotations]')!,transform=parent.getAttribute('transform'),canvas=node.firstElementChild!
  await event(text,'pointerdown',400,300);await event(canvas,'pointermove',460,330)
  expect(text.getAttribute('transform')).toBe('translate(40 20)')
  await event(canvas,'pointercancel',460,330)
  expect(text.getAttribute('transform')).toBeNull();expect(parent.getAttribute('transform')).toBe(transform);expect(onLayoutChange).not.toHaveBeenCalled()
 })
})


it('paints a cached small source photo while drag updates retain the embedded bytes and raw URL',async()=>{
 const source='https://example.com/photo.jpg'
 await render([{id:'marker',visible:true,pointIndex:1,label:'照片',color:'#7c3aed',photo:{dataUrl:image,sourceUrl:source,x:60,y:690}}],{trackId:'track-1'})
 expect(node.querySelector('image')?.getAttribute('href')).toBe(placemarkPhotoThumbnailUrl('track-1',source))
 await event(node.querySelector('[data-photo-id]')!,'pointerdown',60,690)
 await event(node.firstElementChild!,'pointermove',160,740);await event(node.firstElementChild!,'pointerup',160,740)
 expect(current[0].photo).toEqual({dataUrl:image,sourceUrl:source,x:160,y:740})
 expect(node.querySelector('image')?.getAttribute('href')).toBe(placemarkPhotoThumbnailUrl('track-1',source))
})


describe('source anchor leaders during layout gestures',()=>{
 const marker:TrackAnnotation={id:'source-marker',sourceId:'kml-1',sourceCoordinates:[119.005,30.005],visible:true,pointIndex:0,label:'源点位',color:'#7c3aed',position:{x:400,y:300},photo:{dataUrl:image,x:60,y:690}}
 it('moves only the marker layout and both layout leaders while preserving its exact source anchor under a route transform',async()=>{
  const route={x:20,y:-10,scale:1.5},before=structuredClone({marker,points}),onSelect=vi.fn()
  await render([marker],{route,onSelect})
  const canvas=node.firstElementChild!,dot=node.querySelector('[data-annotation-anchor-id]')!,originalDot=dot.outerHTML,leader=node.querySelector('[data-anchor-connector-id]')!,photoLine=node.querySelector('[data-connector-id]')!,originalPhotoLine=photoLine.getAttribute('d'),[ax,ay]=annotationAnchorPosition(marker,points)
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',630,435)
  await event(canvas,'pointermove',690,465)
  expect(leader.getAttribute('d')).toBe(`M${ax.toFixed(2)},${ay.toFixed(2)} L440.00,320.00`)
  expect(dot.outerHTML).toBe(originalDot)
  expect(photoLine.getAttribute('d')).not.toBe(originalPhotoLine)
  await event(canvas,'pointerup',690,465)
  expect(current[0].position).toEqual({x:440,y:320})
  expect(current[0].sourceCoordinates).toEqual(marker.sourceCoordinates)
  expect(current[0].pointIndex).toBe(0)
  expect(current[0].photo).toEqual(marker.photo)
  expect(node.querySelector('[data-annotation-anchor-id]')!.outerHTML).toBe(originalDot)
  expect(node.querySelector('[data-anchor-connector-id]')?.getAttribute('d')).toBe(`M${ax.toFixed(2)},${ay.toFixed(2)} L440.00,320.00`)
  expect(node.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(30 -15) scale(1.5)')
  expect(onSelect).toHaveBeenLastCalledWith(marker.id,{openEditor:false})
  expect({marker,points}).toEqual(before)
 })

 it.each(['pointercancel','lostpointercapture','blur','Escape'])('restores the source leader and photo connector on %s without changing layout or coordinates',async stop=>{
  const onSelect=vi.fn();await render([marker],{onSelect})
  const canvas=node.firstElementChild!,element=node.querySelector('[data-annotation-id]')!,dot=node.querySelector('[data-annotation-anchor-id]')!,originalDot=dot.outerHTML,leader=node.querySelector('[data-anchor-connector-id]')!,originalLeader=leader.getAttribute('d'),photoLine=node.querySelector('[data-connector-id]')!,originalPhotoLine=photoLine.getAttribute('d'),before=structuredClone(current)
  await event(element,'pointerdown',400,300,7);await event(canvas,'pointermove',460,340,7)
  expect(element.getAttribute('transform')).toBe('translate(60 40)')
  expect(leader.getAttribute('d')).not.toBe(originalLeader)
  expect(photoLine.getAttribute('d')).not.toBe(originalPhotoLine)
  expect(dot.outerHTML).toBe(originalDot)
  if(stop==='blur')await act(async()=>window.dispatchEvent(new Event('blur')))
  else if(stop==='Escape')await act(async()=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  else await event(canvas,stop,460,340,7)
  expect(element.getAttribute('transform')).toBeNull()
  expect(leader.getAttribute('d')).toBe(originalLeader)
  expect(photoLine.getAttribute('d')).toBe(originalPhotoLine)
  expect(dot.outerHTML).toBe(originalDot)
  await event(canvas,'pointerup',460,340,7)
  expect(current).toEqual(before)
  expect(onSelect).not.toHaveBeenCalled()
 })

 it('updates keyboard marker layout leaders while photo dragging leaves the geographic leader unchanged',async()=>{
  await render([marker])
  const dot=node.querySelector('[data-annotation-anchor-id]')!.outerHTML,[ax,ay]=annotationAnchorPosition(marker,points)
  for(let count=0;count<2;count++)await act(async()=>node.querySelector('[data-annotation-id]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
  expect(current[0].position).toEqual({x:406,y:300})
  expect(current[0].sourceCoordinates).toEqual(marker.sourceCoordinates)
  expect(node.querySelector('[data-annotation-anchor-id]')!.outerHTML).toBe(dot)
  const leader=node.querySelector('[data-anchor-connector-id]')!,original=leader.getAttribute('d')
  expect(original).toBe(`M${ax.toFixed(2)},${ay.toFixed(2)} L406.00,300.00`)
  expect(document.activeElement?.getAttribute('data-annotation-id')).toBe(marker.id)
  await event(node.querySelector('[data-photo-id]')!,'pointerdown',60,690)
  await event(node.firstElementChild!,'pointermove',80,710)
  expect(leader.getAttribute('d')).toBe(original)
  await event(node.firstElementChild!,'pointerup',80,710)
  expect(current[0].photo).toEqual({...marker.photo,x:80,y:710})
  expect(node.querySelector('[data-anchor-connector-id]')?.getAttribute('d')).toBe(original)
  expect(node.querySelector('[data-annotation-anchor-id]')!.outerHTML).toBe(dot)
 })

 it('restores a marker leader when a live route camera change cancels its local drag',async()=>{
  const ref=createRef<AnnotationCanvasHandle>(),onChange=vi.fn(),onSelect=vi.fn()
  await act(async()=>root.render(createElement(AnnotationCanvas,{ref,svg:trackSvg(points,{name:'源位置',annotations:[marker],layer:'overlay',interactive:true}),points,annotations:[marker],onChange,onSelect})))
  const svg=node.querySelector('svg')!,height=Number(svg.getAttribute('height'))
  vi.mocked(svg.getBoundingClientRect).mockReturnValue({left:0,top:0,width:1200,height,right:1200,bottom:height,x:0,y:0,toJSON(){}})
  const canvas=node.firstElementChild!,element=node.querySelector('[data-annotation-id]')!,dot=node.querySelector('[data-annotation-anchor-id]')!,originalDot=dot.outerHTML,leader=node.querySelector('[data-anchor-connector-id]')!,originalLeader=leader.getAttribute('d')
  await event(element,'pointerdown',400,300);await event(canvas,'pointermove',460,340)
  expect(leader.getAttribute('d')).not.toBe(originalLeader)
  await act(async()=>ref.current!.setRouteView({x:40,y:-20,scale:1.5}))
  expect(element.getAttribute('transform')).toBeNull()
  expect(leader.getAttribute('d')).toBe(originalLeader)
  expect(dot.outerHTML).toBe(originalDot)
  expect(node.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(60 -30) scale(1.5)')
  await event(canvas,'pointerup',460,340)
  expect(onChange).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
 })
})


describe('pixel export dimensions independent of logical canvas interactions',()=>{
 it('uses the 1200 by 675 viewBox for marker dragging and double-click additions on a 1600 by 900 SVG',async()=>{
  const marker:TrackAnnotation={id:'sized-marker',visible:true,pointIndex:0,label:'宽画布',color:'#7c3aed',position:{x:300,y:225}},onAdd=vi.fn()
  await render([marker],{canvas:{width:1600,height:900},onAdd})
  const svg=node.querySelector('svg')!,canvas=node.firstElementChild!
  expect(svg.getAttribute('width')).toBe('1600');expect(svg.getAttribute('height')).toBe('900');expect(svg.getAttribute('viewBox')).toBe('0 0 1200 675')
  vi.mocked(svg.getBoundingClientRect).mockReturnValue({left:10,top:20,width:1600,height:900,right:1610,bottom:920,x:10,y:20,toJSON(){}})
  // Screen (400,300) represents the saved artwork position (300,225).
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',410,320)
  await event(canvas,'pointermove',570,400);await event(canvas,'pointerup',570,400)
  expect(current[0].position).toEqual({x:420,y:285});expect(current[0].pointIndex).toBe(0)
  await act(async()=>canvas.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:1210,clientY:620})))
  expect(onAdd).toHaveBeenLastCalledWith({x:900,y:450})
  expect(current[0].position).toEqual({x:420,y:285})
 })

 it('combines a small displayed viewport with route scaling without changing route-local marker semantics',async()=>{
  const marker:TrackAnnotation={id:'scaled-marker',visible:true,pointIndex:1,label:'缩小画布',color:'#7c3aed',position:{x:400,y:310}},route={x:20,y:-10,scale:.5}
  await render([marker],{canvas:{width:1200,height:900},route})
  const svg=node.querySelector('svg')!,canvas=node.firstElementChild!
  vi.mocked(svg.getBoundingClientRect).mockReturnValue({left:40,top:60,width:400,height:300,right:440,bottom:360,x:40,y:60,toJSON(){}})
  expect(node.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(10 -5) scale(0.5)')
  // The route-local marker (400,310) is artwork (210,150), then screen (110,110).
  await event(node.querySelector('[data-annotation-id]')!,'pointerdown',110,110)
  await event(canvas,'pointermove',140,125);await event(canvas,'pointerup',140,125)
  expect(current[0].position).toEqual({x:580,y:400})
  expect(current[0].pointIndex).toBe(1)
  expect(node.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(10 -5) scale(0.5)')
  expect(node.querySelector('[data-annotation-id] circle')?.getAttribute('cx')).toBe('580.00')
 })
})
