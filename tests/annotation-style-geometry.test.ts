// @vitest-environment jsdom
import {act,createElement,useState} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {AnnotationCanvas} from '../src/client/AnnotationCanvas.tsx'
import {trackSvg,type TrackAnnotation} from '../src/track/annotations.ts'
import type {ArtElementStyle,ArtStyles} from '../src/track/art-styles.ts'
import type {TrackPoint} from '../src/protocol.ts'

const points:TrackPoint[]=[[119,30,null,null],[119.01,30.01,null,null],[119.02,30,null,null]]
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fc8AAAAASUVORK5CYII='
const styles:ArtStyles={defaults:{photoWidth:480,photoHeight:300}}
let root:Root,node:HTMLDivElement,current:TrackAnnotation[]
function Canvas({initial,appearance=styles}:{initial:TrackAnnotation[];appearance?:ArtStyles}) {
  const [annotations,setAnnotations]=useState(initial);current=annotations
  return createElement(AnnotationCanvas,{svg:trackSvg(points,{name:'配图尺寸验证',annotations,styles:appearance,canvas:{width:1200,height:900},interactive:true}),points,annotations,styles:appearance,onChange:setAnnotations})
}
function annotation(patch:Partial<TrackAnnotation>={}):TrackAnnotation {return {id:'styled-point',pointIndex:1,label:'山口',visible:true,color:'#7c3aed',position:{x:850,y:500},photo:{dataUrl:image,x:100,y:150},...patch}}
function canvas(){return node.firstElementChild!}
function photo(){return node.querySelector<SVGGElement>('[data-photo-id="styled-point"]')!}
function marker(){return node.querySelector<SVGGElement>('[data-annotation-id="styled-point"]')!}
function connector(){return node.querySelector<SVGPathElement>('[data-connector-id="styled-point"]')!}
async function render(initial:TrackAnnotation[],appearance=styles){await act(async()=>root.render(createElement(Canvas,{initial,appearance})))}
async function pointer(element:Element,type:string,x:number,y:number){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});element.dispatchEvent(event)})}
async function key(element:Element,key:string,shiftKey=false){await act(async()=>element.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true})))}
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);node=document.createElement('div');document.body.append(node);root=createRoot(node)
  vi.spyOn(SVGElement.prototype,'getBoundingClientRect').mockImplementation(()=>({left:0,top:0,width:1200,height:900,right:1200,bottom:900,x:0,y:0,toJSON(){}}))
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})

describe('SVG annotation interactions respect styled photo geometry',()=>{
  it('uses the 480 by 300 frame for the initial connector, the live photo-drag preview and the committed connector',async()=>{
    await render([annotation()]);const frame=photo().querySelector('[data-art-style="photo-frame"]')!
    expect(frame.getAttribute('width')).toBe('480');expect(frame.getAttribute('height')).toBe('300');expect(connector().getAttribute('d')).toBe('M850.00,500.00 L580.00,450.00')
    await pointer(photo(),'pointerdown',100,150);await pointer(canvas(),'pointermove',200,200)
    expect(connector().getAttribute('d')).toBe('M850.00,500.00 L680.00,500.00');expect(current[0].photo).toEqual({dataUrl:image,x:100,y:150})
    await pointer(canvas(),'pointerup',200,200)
    expect(current[0].photo).toEqual({dataUrl:image,x:200,y:200});expect(connector().getAttribute('d')).toBe('M850.00,500.00 L680.00,500.00')
  })
  it('recomputes the styled frame edge after keyboard movement in both directions and keeps photo focus',async()=>{
    await render([annotation()]);await key(photo(),'ArrowRight',true)
    expect(current[0].photo).toEqual({dataUrl:image,x:110,y:150});expect(connector().getAttribute('d')).toBe('M850.00,500.00 L590.00,450.00')
    await key(photo(),'ArrowDown',true)
    expect(current[0].photo).toEqual({dataUrl:image,x:110,y:160});expect(connector().getAttribute('d')).toBe('M850.00,500.00 L590.00,460.00');expect(document.activeElement?.getAttribute('data-photo-id')).toBe('styled-point')
  })
  it('clamps a dragged 480-unit-wide photo to x 720 so its right edge stays at 1200',async()=>{
    await render([annotation()]);await pointer(photo(),'pointerdown',100,150);await pointer(canvas(),'pointermove',1100,150);await pointer(canvas(),'pointerup',1100,150)
    expect(current[0].photo).toEqual({dataUrl:image,x:720,y:150});const frame=photo().querySelector('[data-art-style="photo-frame"]')!
    expect(Number(frame.getAttribute('x'))+Number(frame.getAttribute('width'))).toBe(1200);expect(connector().getAttribute('d')).toBe('M850.00,500.00 L850.00,450.00')
  })
  it('uses the same 720 limit for repeated keyboard edits instead of the legacy 880 bound',async()=>{
    await render([annotation({photo:{dataUrl:image,x:718,y:200},position:{x:1000,y:800}})]);await key(photo(),'ArrowRight')
    expect(current[0].photo?.x).toBe(720);expect(connector().getAttribute('d')).toBe('M1000.00,800.00 L1000.00,500.00')
    await key(photo(),'ArrowRight',true);expect(current[0].photo?.x).toBe(720);await key(photo(),'ArrowLeft');expect(current[0].photo?.x).toBe(717)
  })
  it('retains every local style override when dragging and keyboard-moving its marker, with connectors still using shared photo dimensions',async()=>{
    const local:ArtElementStyle={textColor:'#1b4d36',textSize:31,fontWeight:500,markerRadius:27,textOffsetX:-12,textOffsetY:8,connectorWidth:3,photoFit:'contain'},initial=annotation({style:local}),sourcePoints=JSON.stringify(points)
    await render([initial]);await pointer(marker(),'pointerdown',850,500);await pointer(canvas(),'pointermove',750,450)
    expect(connector().getAttribute('d')).toBe('M750.00,450.00 L580.00,450.00');await pointer(canvas(),'pointerup',750,450)
    expect(current[0].position).toEqual({x:750,y:450});expect(current[0].style).toEqual(local);expect(current[0].color).toBe('#7c3aed');expect(current[0].pointIndex).toBe(1)
    await key(marker(),'ArrowDown',true);expect(current[0].position).toEqual({x:750,y:460});expect(current[0].style).toEqual(local);expect(connector().getAttribute('d')).toBe('M750.00,460.00 L580.00,450.00')
    expect(current[0].photo).toEqual(initial.photo);expect(initial.style).toEqual(local);expect(initial.position).toEqual({x:850,y:500});expect(JSON.stringify(points)).toBe(sourcePoints)
  })
})
