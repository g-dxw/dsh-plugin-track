// @vitest-environment jsdom
import { act, createElement, StrictMode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn(async()=>{})}))
import {placemarkPhotoThumbnailUrl,placemarkPhotoOriginalUrl} from '../src/track/placemark-photo-assets.ts'
import { TrackArt } from '../src/client/TrackArt.tsx'
import { editedMetrics } from '../src/track/edit.ts'
import {annotationPosition,artTextPosition,diagramCoordinates,type ArtLayout,type ArtRouteTransform,type TrackAnnotation} from '../src/track/annotations.ts'
import type { TrackRecord } from '../src/protocol.ts'
import { api, download } from '../src/client/util.ts'
import { readAnnotationPhoto, readLinkedAnnotationPhoto } from '../src/client/annotation-photo.ts'
vi.mock('../src/client/annotation-photo.ts',()=>({readAnnotationPhoto:vi.fn(),readLinkedAnnotationPhoto:vi.fn()}))
vi.mock('../src/client/util.ts',async importOriginal=>({...await importOriginal<typeof import('../src/client/util.ts')>(),api:vi.fn(),download:vi.fn()}))
const track:TrackRecord={id:'abc',name:'山口路线',filename:'original.gpx',format:'gpx',createdAt:'2026-10-01',bytes:100,points:3,
  coordinates:[[119.4,30.3,10,null],[119.5,30.4,null,null],[119.6,30.5,30,null]],metrics:editedMetrics([[119.4,30.3,10,null],[119.5,30.4,null,null],[119.6,30.5,30,null]])}
const image='data:image/png;base64,cGljdHVyZUE='
const point:TrackAnnotation={id:'a',pointIndex:1,label:'山口',color:'#7c3aed',visible:true,photo:{dataUrl:image,x:50,y:200}}
let root:Root,node:HTMLDivElement
const close=vi.fn()
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 0});vi.clearAllMocks();close.mockReset()
  vi.mocked(api).mockResolvedValue({annotations:[point],saved:true})
  vi.mocked(readAnnotationPhoto).mockResolvedValue(image);vi.mocked(readLinkedAnnotationPhoto).mockResolvedValue(image)
  node=document.createElement('div');document.body.append(node);root=createRoot(node)
  vi.spyOn(SVGElement.prototype,'getBoundingClientRect').mockImplementation(function(this:SVGElement){return {left:0,top:0,width:1200,height:Number(this.getAttribute('height'))||1200,right:1200,bottom:1200,x:0,y:0,toJSON(){}}})
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function render(value=track,strict=false,props:Partial<ComponentProps<typeof TrackArt>>={}){const element=createElement(TrackArt,{track:value,basemap:'none',onBasemap:vi.fn(),onCancel:close,...props});await act(async()=>{root.render(strict?createElement(StrictMode,null,element):element);await new Promise(resolve=>setTimeout(resolve,5))})}
function button(text:string){const found=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text);if(!found)throw new Error(text);return found}
async function click(text:string){await act(async()=>button(text).click())}
async function select(){await act(async()=>node.querySelector<HTMLButtonElement>('[data-point-id="a"]')!.click())}
async function input(label:string,value:string){await act(async()=>{const element=node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}))})}
async function add(){await click('添加点位');await click('添加到路线起点')}
async function upload(){await act(async()=>{const picker=node.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(picker,'files',{configurable:true,value:[new File(['photo'],'new-photo.png',{type:'image/png'})]});picker.dispatchEvent(new Event('change',{bubbles:true}))})}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}}
describe('SVG annotation workspace and point drawer',()=>{
  it('opens the SVG and right-hand list without a map or an AI form',async()=>{
    const original=JSON.stringify(track);await render()
    expect(node.querySelector('.trk-art-board svg')).not.toBeNull();expect(node.querySelector('.trk-art-sidebar [data-point-id]')).not.toBeNull()
    expect(node.querySelector('[role=dialog]')).toBeNull();expect(node.textContent).not.toContain('生图模型');expect(JSON.stringify(track)).toBe(original)
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('edits a point in a drawer and keeps its selected row and canvas changes after closing',async()=>{
    await render();await select();expect(node.querySelector('[role=dialog]')).not.toBeNull();expect(document.activeElement?.getAttribute('aria-label')).toBe('点位名称')
    await input('点位名称','牧场');expect(node.querySelector('svg[data-art-scene]')?.textContent).toContain('牧场')
    await click('完成编辑');expect(node.querySelector('[role=dialog]')).toBeNull();expect(node.querySelector('[data-point-id="a"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(button('保存画布').disabled).toBe(false)
  })
  it('adds a marker directly on the canvas and supports undo and redo',async()=>{
    vi.mocked(api).mockResolvedValue({annotations:[],saved:true});await render();await click('添加点位')
    await act(async()=>{const event=new MouseEvent('pointerup',{bubbles:true,button:0,clientX:700,clientY:450});Object.defineProperty(event,'pointerId',{value:1});node.querySelector('.trk-art-overlay-canvas')!.dispatchEvent(event)})
    expect(node.querySelectorAll('[data-point-id]')).toHaveLength(1);expect(node.querySelector('[role=dialog]')).not.toBeNull()
    await click('撤销');expect(node.querySelectorAll('[data-point-id]')).toHaveLength(0)
    await click('重做');expect(node.querySelectorAll('[data-point-id]')).toHaveLength(1)
  })
  it('saves layouts separately from the track and exports the same SVG without selection borders',async()=>{
    await render();await select();await input('点位名称','牧场');await input('点位横坐标','800')
    const saved={...point,label:'牧场',position:{x:800,y:expect.any(Number)}}
    vi.mocked(api).mockImplementation(async(_action,data)=>({annotations:(data as {annotations:TrackAnnotation[]}).annotations}) as never);await click('保存画布')
    expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[saved]});expect(button('保存画布').disabled).toBe(true)
    await click('导出 SVG');expect(download).toHaveBeenCalledWith('山口路线-轨迹标注.svg',expect.stringContaining(image),'image/svg+xml')
    expect(vi.mocked(download).mock.calls[0][1]).not.toContain('stroke="#ea793a"')
  })
  it('retains a failed save and requires a concrete discard action before leaving',async()=>{
    await render();await select();await input('点位名称','牧场');vi.mocked(api).mockRejectedValue(new Error('磁盘不可写'));await click('保存画布')
    expect(node.textContent).toContain('画布草稿已保留');expect(node.querySelector('svg[data-art-scene]')?.textContent).toContain('牧场')
    await click('返回概览');expect(close).not.toHaveBeenCalled();await click('继续编辑');await click('返回概览');await click('放弃草稿');expect(close).toHaveBeenCalledOnce()
  })
  it('locks unreadable saved annotations and allows retry without overwriting them',async()=>{
    vi.mocked(api).mockRejectedValue(new Error('损坏'));await render();expect(button('添加点位').disabled).toBe(true)
    vi.mocked(api).mockResolvedValue({annotations:[],saved:true});await click('重试读取点位');expect(button('添加点位').disabled).toBe(false)
  })
  it('keeps invalid empty names local and prevents saving until they are corrected',async()=>{
    await render();await select();await input('点位名称','')
    expect(button('保存画布').disabled).toBe(true);expect(button('完成编辑').disabled).toBe(true);expect(node.querySelector('svg[data-art-scene]')?.textContent).toContain('山口')
    await input('点位名称','牧场');expect(button('完成编辑').disabled).toBe(false)
  })
  it('loads a selected KML image into the card and preserves an existing photo position',async()=>{
    vi.mocked(api).mockResolvedValue({annotations:[{...point,imageUrls:['https://example.com/a.jpg']}],saved:true});await render();await select();await click('选择图片 1')
    expect(readLinkedAnnotationPhoto).toHaveBeenCalledWith('https://example.com/a.jpg',track.id)
    vi.mocked(api).mockImplementation(async(_action,data)=>({annotations:(data as {annotations:TrackAnnotation[]}).annotations}) as never);await click('保存画布')
    const payload=vi.mocked(api).mock.calls.at(-1)![1] as {annotations:TrackAnnotation[]}
    expect(payload.annotations[0].photo).toEqual({dataUrl:image,x:50,y:200,sourceUrl:'https://example.com/a.jpg'})
  })
  it('keeps the previous photo on a link failure and allows local upload',async()=>{
    vi.mocked(api).mockResolvedValue({annotations:[{...point,imageUrls:['https://example.com/a.jpg']}],saved:true});vi.mocked(readLinkedAnnotationPhoto).mockRejectedValue(new Error('加载失败'))
    await render();await select();await click('选择图片 1');expect(node.textContent).toContain('图片未添加');expect(node.querySelector('svg image')?.getAttribute('href')).toBe(image)
    await upload();expect(readAnnotationPhoto).toHaveBeenCalledOnce();expect(node.textContent).not.toContain('图片未添加')
  })
  it('keeps the canvas usable if a new photo exceeds the saved photo limit',async()=>{
    const existing=Array.from({length:20},(_,index)=>({...point,id:`photo-${index}`}))
    vi.mocked(api).mockResolvedValue({annotations:[...existing,{id:'no-photo',pointIndex:0,label:'新点位',color:'#7c3aed'}],saved:true})
    await render();await act(async()=>node.querySelector<HTMLButtonElement>('[data-point-id="no-photo"]')!.click());await upload()
    expect(node.textContent).toContain('最多 20 张');expect(node.querySelectorAll('svg image')).toHaveLength(20);expect(node.querySelector('[role=dialog]')).not.toBeNull()
  })
  it('initializes KML points once but respects a saved intentionally empty canvas',async()=>{
    const kml:TrackRecord={...track,format:'kml',placemarks:[{id:'kml-1',name:'牧场',coordinates:[119.5,30.4],description:'草地',images:['https://example.com/a.jpg']}]}
    vi.mocked(api).mockResolvedValue({annotations:[],saved:false});await render(kml);expect(node.querySelectorAll('[data-point-id]')).toHaveLength(1)
    await act(async()=>root.unmount());root=createRoot(node);vi.mocked(api).mockResolvedValue({annotations:[],saved:true});await render(kml);expect(node.querySelectorAll('[data-point-id]')).toHaveLength(0)
  })
  it('does not apply a stale initial read under StrictMode',async()=>{
    const first=deferred<{annotations:TrackAnnotation[]}>(),second=deferred<{annotations:TrackAnnotation[]}>();vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await render(track,true);await act(async()=>second.resolve({annotations:[]}));await add();await act(async()=>first.resolve({annotations:[point]}))
    expect(node.querySelectorAll('[data-point-id]')).toHaveLength(1);expect(node.querySelector('[data-point-id="a"]')).toBeNull()
  })
  it('closes the drawer with Escape without discarding the canvas draft',async()=>{
    await render();await select();await input('点位名称','牧场');await act(async()=>node.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(node.querySelector('[role=dialog]')).toBeNull();expect(node.querySelector('svg[data-art-scene]')?.textContent).toContain('牧场')
  })
})

describe('SVG annotations embedded in the track editor',()=>{
  it('lets the editor own navigation and unload protection and reports an empty-name draft',async()=>{
    const onStateChange=vi.fn(),listen=vi.spyOn(window,'addEventListener')
    await render(track,false,{embedded:true,onStateChange})
    expect(node.querySelector('h2')?.textContent).toBe('SVG 标注')
    expect(node.textContent).not.toContain('返回概览');expect(node.textContent).not.toContain('放弃草稿')
    expect(onStateChange).toHaveBeenLastCalledWith({dirty:false,busy:false})
    await select();expect(onStateChange).toHaveBeenCalledTimes(1)
    await input('点位名称','');expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:false})
    expect(listen.mock.calls.some(([name])=>name==='beforeunload')).toBe(false)
    await input('点位名称','山口');expect(onStateChange).toHaveBeenLastCalledWith({dirty:false,busy:false})
  })
  it('reports pending saves and resets the draft state only after a successful save',async()=>{
    const onStateChange=vi.fn(),pending=deferred<{annotations:TrackAnnotation[]}>()
    await render(track,false,{embedded:true,onStateChange});await select();await input('点位名称','牧场')
    vi.mocked(api).mockReturnValueOnce(pending.promise);await click('保存画布')
    expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:true})
    await act(async()=>pending.resolve({annotations:[{...point,label:'牧场'}]}))
    expect(onStateChange).toHaveBeenLastCalledWith({dirty:false,busy:false})
  })
  it('reports photo loading even while the canvas is hidden',async()=>{
    const onStateChange=vi.fn(),pending=deferred<string>()
    await render(track,false,{embedded:true,onStateChange});await select()
    vi.mocked(readAnnotationPhoto).mockReturnValueOnce(pending.promise);await upload()
    expect(onStateChange).toHaveBeenLastCalledWith({dirty:false,busy:true})
    await render(track,false,{embedded:true,active:false,onStateChange})
    await act(async()=>pending.resolve('data:image/png;base64,cGljdHVyZUI='))
    expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:false})
    expect(node.querySelector('svg image')?.getAttribute('href')).toBe('data:image/png;base64,cGljdHVyZUI=')
  })
  it('keeps the drawer draft and selected point across tabs without moving focus or handling hidden shortcuts',async()=>{
    const tab=document.createElement('button');tab.textContent='标注点';document.body.append(tab)
    try{
      const onStateChange=vi.fn()
      await render(track,false,{embedded:true,onStateChange});await select();await input('点位名称','')
      tab.focus();await render(track,false,{embedded:true,active:false,onStateChange})
      const previousSvg=node.querySelector('svg[data-art-scene]')!.outerHTML
      await act(async()=>{
        node.querySelector('[data-annotation-id="a"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))
        node.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
      })
      expect(node.querySelector('svg[data-art-scene]')!.outerHTML).toBe(previousSvg);expect(node.querySelector('[role=dialog]')).not.toBeNull()
      expect(document.activeElement).toBe(tab)
      await render(track,false,{embedded:true,active:true,onStateChange})
      expect(document.activeElement).toBe(tab)
      expect(node.querySelector<HTMLInputElement>('input[aria-label="点位名称"]')!.value).toBe('')
      expect(node.querySelector('[data-point-id="a"]')?.getAttribute('aria-pressed')).toBe('true')
      expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:false})
      await input('点位名称','牧场');await click('撤销');expect(node.querySelector('svg[data-art-scene]')?.textContent).toContain('山口')
    }finally{tab.remove()}
  })
})

describe('SVG point visibility and canvas navigation',()=>{
  async function choose(label:string,value:string){await act(async()=>{const element=node.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('change',{bubbles:true}))})}
  function displaySwitch(){return node.querySelector<HTMLButtonElement>('[role=switch][aria-label="在画布上显示"]')!}
  async function toggle(){await act(async()=>displaySwitch().click())}
  async function pointer(element:Element,type:string,x:number,y:number){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:7});element.dispatchEvent(event)})}
  it('keeps ordinary legacy points in the list while showing other types by default',async()=>{
    const ordinary={...point,visible:undefined},rest={...point,id:'rest',kind:'rest' as const,visible:undefined,photo:undefined},checkin={...point,id:'checkin',kind:'checkin' as const,visible:undefined,photo:undefined}
    vi.mocked(api).mockResolvedValue({annotations:[ordinary,rest,checkin],saved:true});await render()
    expect(node.querySelectorAll('[data-point-id]')).toHaveLength(3)
    expect(node.querySelector('[data-annotation-id="a"]')).toBeNull();expect(node.querySelector('[data-photo-id="a"]')).toBeNull()
    expect(node.querySelectorAll('[data-annotation-id]')).toHaveLength(2)
    expect(node.querySelector('[data-point-id="a"]')?.textContent).toContain('画布已隐藏')
    expect(button('保存画布').disabled).toBe(true)
    await select();expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    expect(node.querySelector('img')?.getAttribute('src')).toBe(image)
  })
  it('hides a point together with its photo and connector, supports undo and saves the choice',async()=>{
    await render();await select();await toggle()
    expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    expect(node.querySelector('[data-point-id="a"]')).not.toBeNull()
    for(const selector of ['[data-annotation-id="a"]','[data-photo-id="a"]','[data-connector-id="a"]'])expect(node.querySelector(selector)).toBeNull()
    await click('撤销');expect(node.querySelector('[data-photo-id="a"]')).not.toBeNull()
    await click('重做');expect(node.querySelector('[data-photo-id="a"]')).toBeNull()
    vi.mocked(api).mockImplementation(async(_action,data)=>({annotations:(data as {annotations:TrackAnnotation[]}).annotations}) as never)
    await click('保存画布');expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[{...point,visible:false}]})
    await click('导出 SVG');const exported=vi.mocked(download).mock.calls.at(-1)![1] as string
    expect(exported).not.toContain('data-annotation-id="a"');expect(exported).not.toContain(image)
  })
  it('follows type defaults until overridden and can restore those defaults',async()=>{
    vi.mocked(api).mockResolvedValue({annotations:[{...point,visible:undefined}],saved:true});await render();await select()
    expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    await choose('点位类型','checkin');expect(displaySwitch().getAttribute('aria-checked')).toBe('true')
    await choose('点位类型','note');expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    await toggle();expect(node.querySelector('[data-annotation-id="a"]')).not.toBeNull()
    await choose('点位类型','rest');await toggle();expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    await choose('点位类型','checkin');expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    await click('恢复类型默认');expect(displaySwitch().getAttribute('aria-checked')).toBe('true')
    vi.mocked(api).mockImplementation(async(_action,data)=>({annotations:(data as {annotations:TrackAnnotation[]}).annotations}) as never)
    await click('保存画布');const saved=(vi.mocked(api).mock.calls.at(-1)![1] as {annotations:TrackAnnotation[]}).annotations[0]
    expect(saved.kind).toBe('checkin');expect(saved).not.toHaveProperty('visible');expect(saved.photo).toEqual(point.photo)
  })
  it('adds an ordinary hidden point with an editor that can reveal it',async()=>{
    vi.mocked(api).mockResolvedValue({annotations:[],saved:true});await render();await add()
    expect(node.querySelectorAll('[data-point-id]')).toHaveLength(1);expect(node.querySelector('[role=dialog]')).not.toBeNull()
    expect(node.querySelectorAll('[data-annotation-id]')).toHaveLength(0)
    await toggle();expect(node.querySelectorAll('[data-annotation-id]')).toHaveLength(1)
  })
  it('moves the route and its attached artwork and records the route layout for saving, then resets it',async()=>{
    const onStateChange=vi.fn();await render(track,false,{embedded:true,onStateChange})
    const board=node.querySelector<HTMLDivElement>('.trk-art-board')!,scene=node.querySelector<HTMLDivElement>('.trk-art-route-view')!
    expect(board.scrollLeft).toBe(0);expect(board.scrollTop).toBe(0)
    await click('拖动轨迹');const canvas=node.querySelector('.trk-art-overlay-canvas')!,marker=node.querySelector('[data-annotation-id="a"]')!
    const names=typeof window.PointerEvent==='function'?['pointerdown','pointermove','pointerup']:['mousedown','mousemove','mouseup']
    await pointer(marker,names[0],100,100);await pointer(canvas,names[1],120,140);await pointer(canvas,names[2],120,140)
    expect(Number(scene.dataset.viewX)).toBe(20);expect(Number(scene.dataset.viewY)).toBe(40)
    expect(scene.style.transform).toContain('translate(20px, 40px)');expect(node.querySelector('[role=dialog]')).toBeNull()
    expect(button('保存画布').disabled).toBe(false);expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:false})
    await choose('轨迹缩放','150');await click('重置轨迹')
    expect(node.querySelector<HTMLSelectElement>('[aria-label="轨迹缩放"]')!.value).toBe('100')
    expect(Number(scene.dataset.viewX)).toBe(0);expect(Number(scene.dataset.viewY)).toBe(0);expect(Number(scene.dataset.viewScale)).toBe(1);expect(button('保存画布').disabled).toBe(true)
  })
  it('keeps a dragged marker selected without interrupting with its drawer',async()=>{
    await render();const canvas=node.querySelector('.trk-art-overlay-canvas')!,marker=node.querySelector('[data-annotation-id="a"]')!
    await pointer(marker,'pointerdown',300,300);await pointer(canvas,'pointermove',360,350);await pointer(canvas,'pointerup',360,350)
    expect(node.querySelector('[role=dialog]')).toBeNull();expect(node.querySelector('[data-point-id="a"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(button('保存画布').disabled).toBe(false)
    await select();expect(node.querySelector('[role=dialog]')).not.toBeNull()
  })
})


describe('independent route SVG and outer canvas text editing',()=>{
 async function chooseText(value:string){await act(async()=>{const element=node.querySelector<HTMLSelectElement>('[aria-label="画布文字选择"]')!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('change',{bubbles:true}))})}
 async function pointer(element:Element,type:string,x:number,y:number){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:7});element.dispatchEvent(event)})}
 function textXY(id:string){const text=node.querySelector(`[data-art-text-id="${id}"] text`)!;return {x:Number(text.getAttribute('x')),y:Number(text.getAttribute('y'))}}
 function echoSave(){vi.mocked(api).mockImplementation(async(_action,data)=>({annotations:(data as {annotations:TrackAnnotation[]}).annotations,layout:(data as {layout?:ArtLayout}).layout}) as never)}
 it('drags title and direction as outer objects without moving route, point, photo or camera',async()=>{
  await render();const route=node.querySelector('[data-route-layer]')!,routeMarkup=route.outerHTML,pointMarkup=node.querySelector('[data-annotation-id="a"]')!.outerHTML,photoMarkup=node.querySelector('[data-photo-id="a"]')!.outerHTML
  expect(route.querySelector('text')).toBeNull();expect(route.querySelector('[data-annotation-id]')).toBeNull();expect(node.querySelector('[data-art-text-id="title"]')!.closest('[data-route-layer]')).toBeNull()
  const canvas=node.querySelector('.trk-art-overlay-canvas')!,scene=node.querySelector<HTMLDivElement>('.trk-art-route-view')!,camera=scene.style.transform
  for(const [id,dx,dy] of [['title',100,80],['north',70,-40]] as const){const {x,y}=textXY(id);await pointer(node.querySelector(`[data-art-text-id="${id}"]`)!,'pointerdown',x,y);await pointer(canvas,'pointermove',x+dx,y+dy);await pointer(canvas,'pointerup',x+dx,y+dy);expect(textXY(id)).toEqual({x:x+dx,y:y+dy})}
  expect(node.querySelector('[role=dialog]')).toBeNull();expect(node.querySelector('[data-route-layer]')!.outerHTML).toBe(routeMarkup);expect(node.querySelector('[data-annotation-id="a"]')!.outerHTML).toBe(pointMarkup);expect(node.querySelector('[data-photo-id="a"]')!.outerHTML).toBe(photoMarkup);expect(scene.style.transform).toBe(camera)
  echoSave();await click('保存画布');expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[point],layout:{title:{x:150,y:142},north:textXY('north')}})
 })
 it('provides all outer text objects in a dedicated drawer and supports keyboard micro-adjustment',async()=>{
  await render();await click('画布文字');expect(node.querySelector('[role=dialog]')?.textContent).toContain('调整画布文字');expect(document.activeElement?.getAttribute('aria-label')).toBe('画布文字选择')
  expect([...node.querySelectorAll<HTMLSelectElement>('[aria-label="画布文字选择"] option')].map(option=>[option.value,option.textContent])).toEqual([['title','标题与统计'],['start','起点文字'],['end','终点文字'],['north','方向说明']])
  await input('标题与统计横坐标','250');await input('标题与统计纵坐标','160');expect(textXY('title')).toEqual({x:250,y:160})
  await chooseText('start');await input('起点文字横坐标','300');await chooseText('end');await input('终点文字横坐标','350');await chooseText('north');await input('方向说明横坐标','400');await click('完成调整')
  await act(async()=>node.querySelector('[data-art-text-id="title"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,shiftKey:true})))
  expect(textXY('title')).toEqual({x:260,y:160});expect(document.activeElement?.getAttribute('data-art-text-id')).toBe('title');expect(button('保存画布').disabled).toBe(false)
 })
 it('undoes and redoes point and text edits in one history without dropping either layer',async()=>{
  await render();const defaultTitle=textXY('title'),defaultNorth=textXY('north')
  await click('画布文字');await input('标题与统计横坐标','200');await click('完成调整');await select();await input('点位名称','牧场');await click('完成编辑');await click('画布文字');await chooseText('north');await input('方向说明横坐标','250');await click('完成调整')
  await click('撤销');expect(textXY('north')).toEqual(defaultNorth);expect(node.querySelector('[data-point-id="a"]')?.textContent).toContain('牧场');expect(textXY('title').x).toBe(200)
  await click('撤销');expect(node.querySelector('[data-point-id="a"]')?.textContent).toContain('山口');expect(textXY('title').x).toBe(200)
  await click('撤销');expect(textXY('title')).toEqual(defaultTitle);expect(button('保存画布').disabled).toBe(true)
  await click('重做');await click('重做');await click('重做');expect(textXY('title').x).toBe(200);expect(textXY('north').x).toBe(250);expect(node.querySelector('[data-point-id="a"]')?.textContent).toContain('牧场')
  echoSave();await click('保存画布');expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[{...point,label:'牧场'}],layout:{title:{x:200,y:defaultTitle.y},north:{x:250,y:defaultNorth.y}}})
 })
 it('loads stored layout, exports the same composed positions, and persists an intentional reset to defaults',async()=>{
  const layout:ArtLayout={title:{x:260,y:180},north:{x:370,y:840}};vi.mocked(api).mockResolvedValue({annotations:[point],layout,saved:true});await render()
  expect(textXY('title')).toEqual(layout.title);expect(textXY('north')).toEqual(layout.north);expect(button('保存画布').disabled).toBe(true)
  await click('导出 SVG');const exported=vi.mocked(download).mock.calls.at(-1)![1] as string,document=new DOMParser().parseFromString(exported,'image/svg+xml')
  expect(document.querySelector('[data-art-text-id="title"] text')?.getAttribute('x')).toBe('260');expect(document.querySelector('[data-art-text-id="north"] text')?.getAttribute('y')).toBe('840');expect(document.querySelector('[data-art-text-hit]')).toBeNull();expect(exported).not.toContain('stroke="#ea793a"');expect(exported).toContain(image)
  await click('画布文字');await click('恢复默认位置');await chooseText('north');await click('恢复默认位置');await click('完成调整');echoSave();await click('保存画布')
  expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[point],layout:{}});expect(button('保存画布').disabled).toBe(true)
  await act(async()=>root.unmount());root=createRoot(node);vi.mocked(api).mockResolvedValue({annotations:[point],layout:{},saved:true});await render()
  const [x,y]=artTextPosition('title',track.coordinates,[point]);expect(textXY('title')).toEqual({x,y});expect(button('保存画布').disabled).toBe(true)
 })
 it('exports a pure transparent route SVG independently of outer text, photos and points',async()=>{
  await render();await click('画布文字');await input('标题与统计横坐标','275');await click('完成调整');await click('导出轨迹 SVG')
  const call=vi.mocked(download).mock.calls.at(-1)!;expect(call[0]).toBe('山口路线-纯轨迹.svg');expect(call[2]).toBe('image/svg+xml')
  const pure=new DOMParser().parseFromString(call[1] as string,'image/svg+xml');expect(pure.querySelectorAll('[data-route]')).toHaveLength(1);expect(pure.querySelector('[data-route]')?.getAttribute('d')).toBe(node.querySelector('[data-route]')?.getAttribute('d'))
  expect(pure.querySelector('rect,image,text,[data-art-text-id],[data-annotation-id],[data-photo-id]')).toBeNull();expect(call[1]).not.toContain(image)
 })
})


describe('route transforms with associated artwork and fixed page text',()=>{
 async function zoom(value:string){await act(async()=>{const select=node.querySelector<HTMLSelectElement>('[aria-label="轨迹缩放"]')!;select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}))})}
 function fixedPageText(){return ['title','north'].map(id=>node.querySelector(`[data-art-text-id="${id}"]`)!.outerHTML)}
 function routeView():ArtRouteTransform{const route=node.querySelector<HTMLElement>('.trk-art-route-view')!;return {x:Number(route.dataset.viewX),y:Number(route.dataset.viewY),scale:Number(route.dataset.viewScale)}}
 async function pointer(element:Element,type:string,x:number,y:number){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:17});element.dispatchEvent(event)})}
 async function pan(dx:number,dy:number){await click('拖动轨迹');const overlay=node.querySelector('.trk-art-overlay-canvas')!,target=node.querySelector('[data-art-text-id="title"]')!,names=typeof window.PointerEvent==='function'?['pointerdown','pointermove','pointerup']:['mousedown','mousemove','mouseup'];await pointer(target,names[0],200,200);await pointer(overlay,names[1],200+dx,200+dy);await pointer(overlay,names[2],200+dx,200+dy);await click('选择 / 移动')}
 function echoSave(){vi.mocked(api).mockImplementation(async(_action,data)=>data as never)}
 it('transforms the route and associated artwork together while title and direction stay fixed',async()=>{
  await render();const fixed=fixedPageText(),route=node.querySelector<HTMLElement>('.trk-svg-canvas')!,originalPath=route.querySelector('[data-route]')!.getAttribute('d'),paper=node.querySelector<HTMLElement>('.trk-art-scene')!,overlays=node.querySelector<HTMLElement>('.trk-art-overlays')!
  expect(route.classList.contains('trk-art-route-view')).toBe(true);expect(route.querySelector('[data-art-text-id],[data-annotation-id],[data-photo-id]')).toBeNull();expect(overlays.contains(route)).toBe(false)
  await zoom('150');await pan(30,45)
  expect(routeView()).toEqual({x:20,y:30,scale:1.5});expect(route.style.transform).toBe('scale(1.5) translate(20px, 30px)')
  expect(paper.style.transform).toBe('');expect(overlays.style.transform).toBe('');expect(fixedPageText()).toEqual(fixed);expect(route.querySelector('[data-route]')!.getAttribute('d')).toBe(originalPath)
  expect(node.querySelector('[data-art-text-id="title"] text')?.getAttribute('font-size')).toBe('28');expect(node.querySelector('[data-art-text-id="north"] text')?.getAttribute('font-size')).toBe('13');expect(button('保存画布').disabled).toBe(false)
 })
 it('stores one route edit per gesture and restores the associated artwork on undo, redo, save and reopening',async()=>{
  const onStateChange=vi.fn();await render(track,false,{embedded:true,onStateChange});const fixed=fixedPageText()
  await zoom('150');await pan(30,45);expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:false})
  await click('撤销');expect(routeView()).toEqual({x:0,y:0,scale:1.5});await click('撤销');expect(routeView()).toEqual({x:0,y:0,scale:1});expect(button('保存画布').disabled).toBe(true);expect(button('撤销').disabled).toBe(true)
  await click('重做');await click('重做');const route=routeView();expect(route).toEqual({x:20,y:30,scale:1.5});echoSave();await click('保存画布')
  expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[point],route});expect(button('保存画布').disabled).toBe(true);expect(fixedPageText()).toEqual(fixed)
  await click('导出 SVG');const composed=new DOMParser().parseFromString(vi.mocked(download).mock.calls.at(-1)![1] as string,'image/svg+xml'),transformed=composed.querySelector('[data-route-transform]')!
  expect(transformed.getAttribute('transform')).toBe('translate(30 45) scale(1.5)');const attached=composed.querySelector('[data-route-annotations]')!;expect(attached.getAttribute('transform')).toBe(transformed.getAttribute('transform'));for(const selector of ['[data-art-text-id="start"]','[data-art-text-id="end"]','[data-annotation-id="a"]','[data-photo-id="a"]','[data-connector-id="a"]'])expect(composed.querySelector(selector)!.closest('[data-route-annotations]')).toBe(attached);for(const id of ['title','north'])expect(composed.querySelector(`[data-art-text-id="${id}"]`)!.closest('[data-route-transform],[data-route-annotations]')).toBeNull()
  await act(async()=>root.unmount());root=createRoot(node);vi.mocked(api).mockResolvedValue({annotations:[point],route,saved:true});await render()
  expect(routeView()).toEqual(route);expect(button('保存画布').disabled).toBe(true);expect(button('撤销').disabled).toBe(true);expect(fixedPageText()).toEqual(fixed)
 })
 it('drags an outer title in fixed canvas coordinates at 150% route zoom',async()=>{
  await render();await zoom('150');const route=routeView(),canvas=node.querySelector('.trk-art-overlay-canvas')!,title=node.querySelector('[data-art-text-id="title"]')!
  await pointer(title,'pointerdown',50,62);await pointer(canvas,'pointermove',110,102);await pointer(canvas,'pointerup',110,102)
  expect(node.querySelector('[data-art-text-id="title"] text')?.getAttribute('x')).toBe('110');expect(node.querySelector('[data-art-text-id="title"] text')?.getAttribute('y')).toBe('102');expect(routeView()).toEqual(route)
  echoSave();await click('保存画布');expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[point],layout:{title:{x:110,y:102}},route})
 })
 it('resets only the route and persists its default transform while keeping a stored text layout',async()=>{
  const route={x:20,y:30,scale:1.5},layout={title:{x:260,y:180},north:{x:370,y:840}};vi.mocked(api).mockResolvedValue({annotations:[point],route,layout,saved:true});await render();const fixed=fixedPageText()
  await click('重置轨迹');expect(routeView()).toEqual({x:0,y:0,scale:1});expect(fixedPageText()).toEqual(fixed);echoSave();await click('保存画布')
  expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[point],layout,route:{x:0,y:0,scale:1}});expect(button('保存画布').disabled).toBe(true)
  await act(async()=>root.unmount());root=createRoot(node);vi.mocked(api).mockResolvedValue({annotations:[point],layout,route:{x:0,y:0,scale:1},saved:true});await render();expect(routeView()).toEqual({x:0,y:0,scale:1});expect(fixedPageText()).toEqual(fixed)
 })
 it('maps a fixed-canvas double click back to the nearest source point after undo restores a loaded route transform',async()=>{
  const route={x:-200,y:-180,scale:1.5};vi.mocked(api).mockResolvedValue({annotations:[],route,saved:true});await render();await zoom('200');await click('撤销');expect(routeView()).toEqual(route)
  const [sourceX,sourceY]=diagramCoordinates(track.coordinates)[1],position={x:(sourceX+route.x)*route.scale,y:(sourceY+route.y)*route.scale}
  expect(position.x).toBeGreaterThan(24);expect(position.x).toBeLessThan(1176);expect(position.y).toBeGreaterThan(120)
  await act(async()=>node.querySelector('.trk-art-overlay-canvas')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:position.x,clientY:position.y})))
  expect(node.querySelectorAll('[data-point-id]')).toHaveLength(1);echoSave();await click('保存画布');const payload=vi.mocked(api).mock.calls.at(-1)![1] as {annotations:TrackAnnotation[];route:ArtRouteTransform}
  expect(payload.annotations[0].pointIndex).toBe(1);expect(payload.annotations[0].position).toEqual({x:sourceX,y:sourceY});expect(payload.route).toEqual(route);expect(track.coordinates[1]).toEqual([119.5,30.4,null,null])
 })
 it('synchronizes attached labels, markers, photos and connectors during a camera gesture before history commits',async()=>{
  vi.mocked(api).mockResolvedValue({annotations:[point],route:{x:0,y:0,scale:1.5},saved:true});const onStateChange=vi.fn();await render(track,false,{embedded:true,onStateChange});await click('拖动轨迹')
  const attached=node.querySelector('[data-route-annotations]')!,originalContents=attached.innerHTML,fixed=fixedPageText(),canvas=node.querySelector('.trk-art-overlay-canvas')!,names=typeof window.PointerEvent==='function'?['pointerdown','pointermove','pointerup']:['mousedown','mousemove','mouseup']
  for(const selector of ['[data-art-text-id="start"]','[data-art-text-id="end"]','[data-annotation-id="a"]','[data-photo-id="a"]','[data-connector-id="a"]'])expect(node.querySelector(selector)!.closest('[data-route-annotations]')).toBe(attached)
  await pointer(node.querySelector('[data-annotation-id="a"]')!,names[0],200,200);await pointer(canvas,names[1],230,245)
  expect(routeView()).toEqual({x:20,y:30,scale:1.5});expect(attached.getAttribute('transform')).toBe('translate(30 45) scale(1.5)');expect(attached.innerHTML).toBe(originalContents);expect(fixedPageText()).toEqual(fixed)
  expect(button('保存画布').disabled).toBe(true);expect(onStateChange).toHaveBeenLastCalledWith({dirty:false,busy:false})
  await pointer(canvas,names[2],230,245);expect(button('保存画布').disabled).toBe(false);expect(onStateChange).toHaveBeenLastCalledWith({dirty:true,busy:false});await click('撤销');expect(routeView()).toEqual({x:0,y:0,scale:1.5});expect(node.querySelector('[data-route-annotations]')!.getAttribute('transform')).toBe('translate(0 0) scale(1.5)');expect(button('撤销').disabled).toBe(true)
 })
 it('inverse-scales independent marker, photo and endpoint-text drags at 150% while preserving their route-local metadata',async()=>{
  const route={x:20,y:30,scale:1.5},layout={start:{x:300,y:400},end:{x:400,y:450}};vi.mocked(api).mockResolvedValue({annotations:[point],route,layout,saved:true});await render();const canvas=node.querySelector('.trk-art-overlay-canvas')!,originalPath=node.querySelector('[data-route]')!.getAttribute('d'),[mx,my]=annotationPosition(point,track.coordinates)
  async function drag(selector:string,x:number,y:number,dx:number,dy:number){const element=node.querySelector(selector)!,screenX=(x+route.x)*route.scale,screenY=(y+route.y)*route.scale;await pointer(element,'pointerdown',screenX,screenY);await pointer(canvas,'pointermove',screenX+dx,screenY+dy);expect(element.getAttribute('transform')).toBe(`translate(${dx/route.scale} ${dy/route.scale})`);await pointer(canvas,'pointerup',screenX+dx,screenY+dy)}
  await drag('[data-annotation-id="a"]',mx,my,30,15);await drag('[data-photo-id="a"]',50,200,45,30);await drag('[data-art-text-id="start"]',300,400,60,30);await drag('[data-art-text-id="end"]',400,450,-30,15)
  expect(routeView()).toEqual(route);expect(node.querySelector('[data-route]')!.getAttribute('d')).toBe(originalPath);echoSave();await click('保存画布')
  expect(api).toHaveBeenLastCalledWith('annotations',{id:track.id,annotations:[{...point,position:{x:mx+20,y:my+10},photo:{dataUrl:image,x:80,y:220}}],layout:{start:{x:340,y:420},end:{x:380,y:460}},route})
  await click('导出 SVG');const exported=new DOMParser().parseFromString(vi.mocked(download).mock.calls.at(-1)![1] as string,'image/svg+xml');expect(exported.querySelector('[data-route-annotations]')!.getAttribute('transform')).toBe('translate(30 45) scale(1.5)');expect(exported.querySelector('[data-photo-id="a"] rect')?.getAttribute('x')).toBe('80');expect(exported.querySelector('[data-art-text-id="start"] text')?.getAttribute('x')).toBe('340')
 })
 it('places a new visible marker at the clicked camera position and keeps its local position when the route moves again',async()=>{
  const route={x:-200,y:-180,scale:1.5};vi.mocked(api).mockResolvedValue({annotations:[],route,saved:true});await render();const [x,y]=diagramCoordinates(track.coordinates)[1],screen={x:(x+route.x)*route.scale,y:(y+route.y)*route.scale}
  await act(async()=>node.querySelector('.trk-art-overlay-canvas')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:screen.x,clientY:screen.y})));await act(async()=>node.querySelector<HTMLButtonElement>('[role=switch][aria-label="在画布上显示"]')!.click());await click('完成编辑')
  const marker=node.querySelector('[data-annotation-id]')!,circle=marker.querySelector('circle')!,local={x:Number(circle.getAttribute('cx')),y:Number(circle.getAttribute('cy'))},id=marker.getAttribute('data-annotation-id')!
  expect(Math.abs((local.x+route.x)*route.scale-screen.x)).toBeLessThan(.01);expect(Math.abs((local.y+route.y)*route.scale-screen.y)).toBeLessThan(.01)
  await pan(30,45);expect(routeView()).toEqual({x:route.x+20,y:route.y+30,scale:1.5});expect(node.querySelector(`[data-annotation-id="${id}"] circle`)?.getAttribute('cx')).toBe(circle.getAttribute('cx'));expect(node.querySelector(`[data-annotation-id="${id}"] circle`)?.getAttribute('cy')).toBe(circle.getAttribute('cy'))
  expect(node.querySelector('[data-route-annotations]')!.getAttribute('transform')).toBe('translate(-270 -225) scale(1.5)');echoSave();await click('保存画布');const payload=vi.mocked(api).mock.calls.at(-1)![1] as {annotations:TrackAnnotation[];route:ArtRouteTransform}
  expect(payload.annotations[0]).toMatchObject({id,pointIndex:1,visible:true,position:{x,y}});expect(payload.route).toEqual({x:-180,y:-150,scale:1.5})
 })

 it('merges the live camera into an immediate marker edit before the wheel debounce commits',async()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){const match=this.classList.contains('trk-art-route-view')?this.style.transform.match(/scale\(([^)]+)\) translate\(([^p]+)px, ([^p]+)px\)/):null,scale=match?Number(match[1]):1,x=match?Number(match[2])*scale:0,y=match?Number(match[3])*scale:0,width=1200*scale,height=1275*scale;return {left:x,top:y,width,height,right:x+width,bottom:y+height,x,y,toJSON(){}}})
  await render();vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  try{
   const board=node.querySelector('.trk-art-board')!,canvas=node.querySelector('.trk-art-overlay-canvas')!,[x,y]=annotationPosition(point,track.coordinates)
   for(let index=0;index<2;index++)await act(async()=>board.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:400,clientY:400,deltaY:-50})))
   const route=routeView();expect(route.scale).toBeGreaterThan(1);expect(button('保存画布').disabled).toBe(true)
   const start={x:(x+route.x)*route.scale,y:(y+route.y)*route.scale},marker=node.querySelector('[data-annotation-id="a"]')!
   await pointer(marker,'pointerdown',start.x,start.y);await pointer(canvas,'pointermove',start.x+20,start.y+10);await pointer(canvas,'pointerup',start.x+20,start.y+10)
   expect(routeView()).toEqual(route);expect(button('保存画布').disabled).toBe(false)
   await act(async()=>vi.advanceTimersByTimeAsync(160));await click('撤销');expect(routeView()).toEqual({x:0,y:0,scale:1});expect(button('保存画布').disabled).toBe(true);expect(button('撤销').disabled).toBe(true)
   await click('重做');expect(routeView()).toEqual(route);echoSave();await click('保存画布');const payload=vi.mocked(api).mock.calls.at(-1)![1] as {annotations:TrackAnnotation[];route:ArtRouteTransform}
   expect(payload.route).toEqual(route);expect(payload.annotations[0].position?.x).toBeCloseTo(x+20/route.scale,8);expect(payload.annotations[0].position?.y).toBeCloseTo(y+10/route.scale,8);expect(payload.annotations[0].photo).toEqual(point.photo)
  }finally{vi.useRealTimers()}
 })

})


it('displays a saved linked photo as a cached thumbnail and opens its cached original without changing the source',async()=>{
 const source='https://example.com/a.jpg'
 vi.mocked(api).mockResolvedValue({annotations:[{...point,imageUrls:[source],photo:{...point.photo!,sourceUrl:source}}],saved:true})
 await render();await select()
 expect(node.querySelector('svg image')?.getAttribute('href')).toBe(placemarkPhotoThumbnailUrl(track.id,source))
 expect(node.querySelector('.trk-selected-photo img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl(track.id,source))
 await click('查看原图')
 expect(node.querySelector('.trk-placemark-photo-viewer-image')?.getAttribute('src')).toBe(placemarkPhotoOriginalUrl(track.id,source))
 expect(button('保存画布').disabled).toBe(true)
})
