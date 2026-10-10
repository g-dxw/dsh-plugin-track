// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn(async()=>{})}))
vi.mock('../src/client/useTrackPlacemarks.ts',async importOriginal=>({...await importOriginal<typeof import('../src/client/useTrackPlacemarks.ts')>(),loadTrackPlacemarkState:vi.fn(async (track:TrackRecord)=>({points:track.placemarks||[],groups:[]}))}))
vi.mock('../src/client/annotation-resource.ts',()=>({storeAnnotationImage:vi.fn(async()=>{})}))
vi.mock('../src/client/annotation-photo.ts',()=>({readAnnotationPhoto:vi.fn(),readLinkedAnnotationPhoto:vi.fn()}))
vi.mock('../src/client/util.ts',async importOriginal=>({...await importOriginal<typeof import('../src/client/util.ts')>(),api:vi.fn(),download:vi.fn()}))
import { TrackArt } from '../src/client/TrackArt.tsx'
import { loadTrackPlacemarkState } from '../src/client/useTrackPlacemarks.ts'
import { api, download } from '../src/client/util.ts'
import { storeAnnotationImage } from '../src/client/annotation-resource.ts'
import { editedMetrics } from '../src/track/edit.ts'
import type { TrackAnnotation } from '../src/track/annotations.ts'
import type { ArtStyles } from '../src/track/art-styles.ts'
import type { TrackRecord, TrackPlacemark, PlacemarkGroup } from '../src/protocol.ts'

const coordinates:TrackRecord['coordinates']=[[119.4,30.3,10,null],[119.5,30.4,null,null],[119.6,30.5,30,null]]
const track:TrackRecord={id:'styles-track',name:'旅行样式画布',filename:'original.gpx',format:'gpx',createdAt:'2026-10-01',bytes:100,points:3,coordinates,metrics:editedMetrics(coordinates)}
const photo='data:image/png;base64,cGljdHVyZQ=='
const points:TrackAnnotation[]=[
  {id:'a',pointIndex:0,label:'入口',color:'#7c3aed',visible:true,position:{x:150,y:250},photo:{dataUrl:photo,x:100,y:500}},
  {id:'b',pointIndex:1,label:'山口',color:'#2563eb',visible:true,position:{x:500,y:300}},
]
let root:Root,node:HTMLDivElement
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 0})
  vi.clearAllMocks()
  vi.mocked(storeAnnotationImage).mockReset().mockResolvedValue(undefined)
  vi.mocked(api).mockReset().mockResolvedValue({annotations:points,saved:true,styles:{}})
  vi.mocked(loadTrackPlacemarkState).mockReset().mockImplementation(async value=>({points:value.placemarks||[],groups:[]}))
  node=document.createElement('div');document.body.append(node);root=createRoot(node)
  vi.spyOn(SVGElement.prototype,'getBoundingClientRect').mockImplementation(function(this:SVGElement){return {left:0,top:0,width:1200,height:Number(this.getAttribute('height'))||1200,right:1200,bottom:1200,x:0,y:0,toJSON(){}}})
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function render(props:Partial<ComponentProps<typeof TrackArt>>={}) {await act(async()=>{root.render(createElement(TrackArt,{track,basemap:'none',onBasemap:vi.fn(),onCancel:vi.fn(),...props}));await new Promise(resolve=>setTimeout(resolve,5))})}
function button(text:string) {const value=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text);if(!value)throw new Error(`Missing button ${text}`);return value}
async function click(text:string) {await act(async()=>button(text).click())}
async function exportSvg() {
  const details=node.querySelector<HTMLDetailsElement>('.trk-art-export-options')!
  if(!details.open)await act(async()=>details.querySelector('summary')!.click())
  await click('导出 SVG')
}
async function labeledButton(label:string) {await act(async()=>{const value=node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);if(!value)throw new Error(`Missing button ${label}`);value.click()})}
async function select(id='a') {await act(async()=>node.querySelector<HTMLButtonElement>(`[data-point-id="${id}"]`)!.click())}
async function field(label:string,value:string) {
  const element=node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if(!element)throw new Error(`Missing input ${label}`)
  await act(async()=>element.focus())
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>element.blur())
}
function label(id='a') {return node.querySelector(`[data-annotation-id="${id}"] [data-art-style="label"]`)!}
function marker(id='a') {return node.querySelector(`[data-annotation-id="${id}"] [data-art-style="marker"]`)!}
function parse(svg:string) {return new DOMParser().parseFromString(svg,'image/svg+xml')}
function echoSave() {vi.mocked(api).mockImplementation(async(_action,data)=>data as never)}
function expectCoveredSidebar() {
  const sidebar=node.querySelector<HTMLElement>('.trk-art-sidebar')!
  expect(sidebar.getAttribute('aria-hidden')).toBe('true')
  for(const control of sidebar.querySelectorAll<HTMLElement>('button,input,select,summary')) {
    expect(control.matches(':disabled')||control.tabIndex<0,control.outerHTML).toBe(true)
  }
  const active=document.activeElement
  button('保存到资源库').focus()
  expect(document.activeElement).toBe(active)
  node.querySelector<HTMLInputElement>('[aria-label="画布宽度"]')!.focus()
  expect(document.activeElement).toBe(active)
}

describe('SVG editing unified and independent styles',()=>{
  it('applies global text and relative offsets while retaining independently styled labels',async()=>{
    vi.mocked(api).mockResolvedValue({annotations:[points[0],{...points[1],style:{textSize:36,textColor:'#990099'}}],saved:true})
    await render();const markerBefore=marker().outerHTML,original=JSON.stringify(track)
    await click('统一样式');await field('统一字号','24');await field('统一文字颜色值','#123456')
    await field('统一文字横向偏移','40');await field('统一文字纵向偏移','20')
    expect(label().getAttribute('font-size')).toBe('24');expect(label().getAttribute('fill')).toBe('#123456')
    expect(label('b').getAttribute('font-size')).toBe('36');expect(label('b').getAttribute('fill')).toBe('#990099')
    expect(label().getAttribute('x')).toBe('213.00');expect(label().getAttribute('y')).toBe('255.00')
    expect(marker().outerHTML).toBe(markerBefore);expect(JSON.stringify(track)).toBe(original)
    expect(node.querySelector('[data-art-text-id="title"] text')?.getAttribute('font-size')).toBe('24')
  })
  it('keeps a per-point override during global changes and resets each property to inheritance',async()=>{
    await render();await select();await field('当前点位字号','36');await field('当前点位文字颜色值','#cc2244')
    await click('完成编辑');await click('统一样式');await field('统一字号','22');await field('统一文字颜色值','#115577')
    expect(label().getAttribute('font-size')).toBe('36');expect(label().getAttribute('fill')).toBe('#cc2244')
    expect(label('b').getAttribute('font-size')).toBe('22');expect(label('b').getAttribute('fill')).toBe('#115577')
    await click('关闭');await select();await labeledButton('恢复当前点位字号')
    expect(label().getAttribute('font-size')).toBe('22');expect(label().getAttribute('fill')).toBe('#cc2244')
    await labeledButton('恢复当前点位文字颜色');expect(label().getAttribute('fill')).toBe('#115577')
  })
  it('adjusts title typography and position independently and restores global typography without moving it',async()=>{
    await render();await click('画布文字');await field('当前文字字号','40');await field('当前文字文字颜色值','#884422')
    await field('标题与统计横坐标','200');await field('标题与统计纵坐标','120')
    await click('关闭');await click('统一样式');await field('统一字号','26');await field('统一文字颜色值','#334455')
    const title=()=>node.querySelector('[data-art-text-id="title"] [data-art-style="title"]')!
    expect(title().getAttribute('font-size')).toBe('40');expect(title().getAttribute('fill')).toBe('#884422')
    expect(title().getAttribute('x')).toBe('200');expect(title().getAttribute('y')).toBe('120')
    await click('关闭');await click('画布文字');await click('恢复文字统一样式')
    expect(title().getAttribute('font-size')).toBe('26');expect(title().getAttribute('fill')).toBe('#334455')
    expect(title().getAttribute('x')).toBe('200');expect(title().getAttribute('y')).toBe('120')
  })
  it('stores style edits in undo and redo history and restores the initial clean state',async()=>{
    await render();expect(button('保存画布').disabled).toBe(true)
    await click('统一样式');await field('统一字号','30');await click('完成调整')
    expect(label().getAttribute('font-size')).toBe('30');expect(button('保存画布').disabled).toBe(false)
    await click('撤销');expect(label().getAttribute('font-size')).toBe('17');expect(button('保存画布').disabled).toBe(true)
    await click('重做');expect(label().getAttribute('font-size')).toBe('30');expect(button('保存画布').disabled).toBe(false)
  })
  it('saves global and local styles and restores both when reopening the canvas',async()=>{
    let stored={annotations:points,styles:{} as ArtStyles,saved:true}
    vi.mocked(api).mockImplementation(async(_action,data)=>{if(data){stored={...stored,...data as object};return stored as never}return stored as never})
    await render();await click('统一样式');await field('统一字号','25');await field('统一轨迹宽度','9')
    await click('关闭');await select();await field('当前点位字号','38');await click('完成编辑');await click('保存画布')
    expect(stored.styles).toMatchObject({defaults:{textSize:25},route:{width:9}})
    expect(stored.annotations[0].style).toMatchObject({textSize:38})
    expect(button('保存画布').disabled).toBe(true)
    await act(async()=>root.unmount());root=createRoot(node);await render()
    expect(label().getAttribute('font-size')).toBe('38');expect(label('b').getAttribute('font-size')).toBe('25')
    expect(node.querySelector('[data-route]')?.getAttribute('stroke-width')).toBe('9')
    expect(button('保存画布').disabled).toBe(true)
  })
  it('exports the current unsaved styles consistently to SVG and resource PNG snapshots',async()=>{
    await render();await click('统一样式');await field('统一字号','27');await field('统一文字颜色值','#234567')
    await field('统一轨迹颜色值','#00aa88');await field('统一轨迹宽度','10');await field('统一图片宽度','400');await field('统一图片圆角','20')
    await click('完成调整');await exportSvg();const exported=vi.mocked(download).mock.calls.at(-1)![1] as string
    await click('保存到资源库');expect(storeAnnotationImage).toHaveBeenCalledOnce()
    const snapshot=vi.mocked(storeAnnotationImage).mock.calls[0][0]
    expect(snapshot).toMatchObject({trackId:track.id,name:`${track.name}-SVG 标注.png`,svg:exported})
    const document=parse(snapshot.svg)
    expect(document.querySelector('[data-art-style="label"]')?.getAttribute('font-size')).toBe('27')
    expect(document.querySelector('[data-art-style="label"]')?.getAttribute('fill')).toBe('#234567')
    expect(document.querySelector('[data-route]')?.getAttribute('stroke')).toBe('#00aa88')
    expect(document.querySelector('[data-route]')?.getAttribute('stroke-width')).toBe('10')
    expect(document.querySelector('[data-art-style="photo-frame"]')?.getAttribute('width')).toBe('400')
    expect(document.querySelector('[data-art-style="photo-frame"]')?.getAttribute('rx')).toBe('20')
    expect(document.querySelector('[data-art-text-id],[data-art-text-hit]')).toBeNull()
    expect(vi.mocked(api).mock.calls.filter(([,data])=>data)).toHaveLength(0)
    expect(button('保存画布').disabled).toBe(false)
  })
  it('shows background edits immediately in the canvas, exports the same color and restores preview on undo',async()=>{
    await render();const scene=node.querySelector<HTMLElement>('.trk-art-scene')!
    expect(scene.style.backgroundColor).toBe('rgb(255, 253, 246)')
    await click('统一样式');await field('统一背景颜色值','#224466')
    expect(scene.style.backgroundColor).toBe('rgb(34, 68, 102)')
    expect(getComputedStyle(scene).backgroundColor).toBe('rgb(34, 68, 102)')
    await click('完成调整');await exportSvg()
    let exported=parse(vi.mocked(download).mock.calls.at(-1)![1] as string)
    expect(exported.querySelector('[data-art-layer="background"]')?.getAttribute('fill')).toBe('#224466')
    await click('撤销')
    expect(scene.style.backgroundColor).toBe('rgb(255, 253, 246)')
    expect(button('保存画布').disabled).toBe(true)
    await exportSvg()
    exported=parse(vi.mocked(download).mock.calls.at(-1)![1] as string)
    expect(exported.querySelector('[data-art-layer="background"]')?.getAttribute('fill')).toBe('#fffdf6')
    await click('重做');expect(scene.style.backgroundColor).toBe('rgb(34, 68, 102)')
  })
  it('accepts a negative group coordinate character by character and commits only after blur',async()=>{
    await render();await click('统一样式')
    const input=node.querySelector<HTMLInputElement>('[aria-label="整组轨迹横坐标"]')!
    const transform=()=>node.querySelector('[data-route-annotations]')!.getAttribute('transform')
    const original=transform()
    async function type(value:string) {await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
    await act(async()=>input.focus())
    for(const value of ['','-','-1','-12','-120']) {
      await type(value);expect(input.value).toBe(value);expect(transform()).toBe(original)
      expect(button('保存画布').disabled).toBe(true)
    }
    await act(async()=>input.blur())
    expect(transform()).toBe('translate(-120 0) scale(1)')
    expect(node.querySelector('.trk-art-files [role="status"]')?.textContent).toBe('未保存')
    expect(button('保存画布').matches(':disabled')).toBe(true)
    await act(async()=>input.focus());await type('');await act(async()=>input.blur())
    expect(input.getAttribute('aria-invalid')).toBe('true');expect(transform()).toBe('translate(-120 0) scale(1)')
    await act(async()=>input.focus());await type('-5')
    await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(node.querySelector<HTMLInputElement>('[aria-label="整组轨迹横坐标"]')?.value).toBe('-120')
    expect(transform()).toBe('translate(-120 0) scale(1)')
    echoSave();await click('完成调整');await click('保存画布')
    const payload=vi.mocked(api).mock.calls.at(-1)![1] as {route:{x:number;y:number;scale:number}}
    expect(payload.route).toEqual({x:-120,y:0,scale:1})
  })
  it('keeps fractional saved group coordinates unchanged when a rounded input is only focused and blurred',async()=>{
    const route={x:12.5,y:34.2,scale:1}
    vi.mocked(api).mockResolvedValue({annotations:points,saved:true,styles:{},route})
    await render();await click('统一样式')
    const transform=()=>node.querySelector('[data-route-annotations]')!.getAttribute('transform')
    expect(transform()).toBe('translate(12.5 34.2) scale(1)')
    for(const [name,rounded] of [['整组轨迹横坐标','13'],['整组轨迹纵坐标','34']]) {
      const input=node.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!
      expect(input.value).toBe(rounded)
      await act(async()=>input.focus());await act(async()=>input.blur())
      expect(transform()).toBe('translate(12.5 34.2) scale(1)')
      expect(button('保存画布').disabled).toBe(true)
    }
    expect(vi.mocked(api).mock.calls.filter(([,data])=>data)).toHaveLength(0)
  })
  it('keeps invalid numeric drafts out of artwork and allows a valid correction',async()=>{
    await render();await click('统一样式');await field('统一字号','0')
    expect(node.querySelector('[aria-label="统一字号"]')?.getAttribute('aria-invalid')).toBe('true')
    expect(label().getAttribute('font-size')).toBe('17');expect(button('保存画布').disabled).toBe(true)
    await field('统一字号','28');expect(label().getAttribute('font-size')).toBe('28')
    expect(node.querySelector('[aria-label="统一字号"]')?.getAttribute('aria-invalid')).toBe('false')
  })
  it('retains styles on hidden source members and grouped nodes during global edits and save',async()=>{
    const sources:TrackPlacemark[]=[{id:'b',name:'成员一',description:'',coordinates:[119.4,30.3],images:[]},{id:'c',name:'成员二',description:'',coordinates:[119.5,30.4],images:[]},{id:'hidden',name:'隐藏源点',description:'',coordinates:[119.6,30.5],images:[],hidden:true}]
    const group:PlacemarkGroup={id:'group-11111111-1111-4111-8111-111111111111',name:'营地分组',description:'分组',coordinates:[119.5,30.4],memberIds:['b','c']}
    const source=(id:string,style:TrackAnnotation['style']):TrackAnnotation=>({...points[1],id,sourceId:id,sourceCoordinates:[119.5,30.4],style})
    const stored=[source('b',{textSize:35,textColor:'#ff0000'}),source('hidden',{textSize:44}),source(group.id,{textColor:'#aa6600'})]
    vi.mocked(api).mockResolvedValue({annotations:stored,saved:true})
    vi.mocked(loadTrackPlacemarkState).mockResolvedValue({points:sources,groups:[group]})
    await render();expect(node.querySelector('[data-point-id="hidden"]')).toBeNull();expect(node.querySelector('[data-point-id="b"]')).toBeNull()
    await click('统一样式');await field('统一字号','23');await click('完成调整');echoSave();await click('保存画布')
    const payload=vi.mocked(api).mock.calls.at(-1)![1] as {annotations:TrackAnnotation[];styles:ArtStyles}
    expect(payload.styles).toMatchObject({defaults:{textSize:23}})
    expect(payload.annotations.find(item=>item.id==='b')?.style).toEqual(stored[0].style)
    expect(payload.annotations.find(item=>item.id==='hidden')?.style).toEqual(stored[1].style)
    expect(payload.annotations.find(item=>item.id===group.id)?.style).toEqual(stored[2].style)
    expect(label(group.id).getAttribute('font-size')).toBe('23');expect(label(group.id).getAttribute('fill')).toBe('#aa6600')
  })
  it('focuses the point drawer, removes covered sidebar controls from keyboard access and returns to its selected row',async()=>{
    await render()
    const row=node.querySelector<HTMLButtonElement>('[data-point-id="a"]')!
    await act(async()=>{
      for(const details of node.querySelectorAll<HTMLDetailsElement>('.trk-art-sidebar details'))details.open=true
      row.focus();row.click()
    })
    expect(document.activeElement).toBe(node.querySelector('[aria-label="点位名称"]'))
    expectCoveredSidebar()
    await click('完成编辑')
    expect(node.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(row)
    expect(row.tabIndex).toBe(0)
    expect(node.querySelector('.trk-art-sidebar')?.getAttribute('aria-hidden')).toBeNull()
    expect(button('保存到资源库').matches(':disabled')).toBe(false)
    expect(node.querySelector<HTMLElement>('.trk-art-export-options summary')!.tabIndex).toBe(0)
    expect(node.querySelector<HTMLElement>('.trk-art-canvas-settings summary')!.tabIndex).toBe(0)
  })
  it('returns focus to the stable toolbar trigger after closing the style or text drawer with Escape',async()=>{
    await render()
    for(const [name,initialFocus] of [
      ['统一样式','#trk-art-style-title'],
      ['画布文字','[aria-label="画布文字选择"]'],
    ]) {
      const trigger=button(name)
      await act(async()=>{trigger.focus();trigger.click()})
      expect(document.activeElement).toBe(node.querySelector(initialFocus))
      expectCoveredSidebar()
      await act(async()=>node.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
      expect(node.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(button('保存到资源库').matches(':disabled')).toBe(false)
    }
  })
})
