// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn(async()=>{})}))
import { TrackOverview, TrackPlacemarkEditor } from '../src/client/TrackOverview.tsx'
import { TrackEditor } from '../src/client/TrackEditor.tsx'
import type { EditorMapProps } from '../src/client/EditorMap.tsx'
import type { MapView } from '../src/client/MapView.tsx'
import type { ElevationChart } from '../src/client/ElevationChart.tsx'
import type { PlacemarkGroup, TrackRecord } from '../src/protocol.ts'
import { formatPlacemarkTime } from '../src/track/placemark-format.ts'
import {placemarkPhotoUrl} from '../src/track/placemark-photos.ts'
import type { PlacemarkStateDocument, PlacemarkStateData } from '../src/track/placemark-state.ts'
import type { PlacemarkEdit } from '../src/track/placemark-edits.ts'
const map=vi.hoisted(()=>({current:null as Parameters<typeof MapView>[0]|null}))
const profile=vi.hoisted(()=>({current:null as Parameters<typeof ElevationChart>[0]|null}))
const lineMap=vi.hoisted(()=>({current:null as EditorMapProps|null}))
const service=vi.hoisted(()=>({api:vi.fn(),orders:new Map<string,string[]|null>(),edits:new Map<string,PlacemarkEdit[]>(),groups:new Map<string,PlacemarkGroup[]>(),states:new Map<string,PlacemarkStateDocument>(),failure:'',wait:null as Promise<void>|null}))
vi.mock('../src/client/MapView.tsx',()=>({MapView:(props:Parameters<typeof MapView>[0])=>{map.current=props;return createElement('div',{'data-map':true})}}))
vi.mock('../src/client/ElevationChart.tsx',()=>({ElevationChart:(props:Parameters<typeof ElevationChart>[0])=>{profile.current=props;return createElement('div',{'data-profile':true})}}))
vi.mock('../src/client/EditorMap.tsx',()=>({EditorMap:(props:EditorMapProps)=>{lineMap.current=props;return createElement('div',{'data-line-map':true})}}))
vi.mock('../src/client/util.ts',async importOriginal=>({...await importOriginal<typeof import('../src/client/util.ts')>(),api:service.api}))
const track={id:'kml',format:'kml',name:'路线',metrics:{elevationMax:520},segmentStarts:[0],coordinates:[[120,30,500,null],[120.1,30.1,520,null]],placemarks:[{id:'kml-1',name:'牧场',coordinates:[120,30],elevation:501.59,time:Date.parse('2026-05-29T06:48:22Z'),description:'草地',images:['https://example.com/one.jpg','https://example.com/two.jpg']},{id:'kml-2',name:'山口',coordinates:[120.1,30.1],elevation:null,time:null,description:'',images:[]}]} as TrackRecord
let root:Root,node:HTMLDivElement, currentFixture=track
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  currentFixture=track;service.states.clear();service.orders.clear();service.edits.clear();service.groups.clear();service.failure='';service.wait=null;service.api.mockReset()
  service.api.mockImplementation(async(action:string,data?:{id:string;revision:number;data:PlacemarkStateData})=>{
    if(data===undefined){
      const id=new URLSearchParams(action.split('?')[1]).get('id')!
      return {state:service.states.get(id)||{version:1,revision:0,added:[],deletedIds:[],order:service.orders.get(id)||null,edits:service.edits.get(id)||[],groups:service.groups.get(id)||[],routeContext:{segmentStarts:[0],references:currentFixture.placemarks||[]}}}
    }
    if(service.wait)await service.wait
    if(service.failure)throw new Error(service.failure)
    if(action==='placemark-state'){
      const state={...structuredClone(data.data),version:1 as const,revision:(service.states.get(data.id)?.revision||0)+1}
      service.states.set(data.id,state);service.orders.set(data.id,state.order);service.edits.set(data.id,state.edits);service.groups.set(data.id,state.groups)
      return {state}
    }
    throw new Error('Unexpected action: '+action)
  })
  node=document.createElement('div');document.body.append(node);root=createRoot(node)
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
async function render(value=track,onBusyChange?:(busy:boolean)=>void){currentFixture=value;await act(async()=>root.render(createElement(TrackPlacemarkEditor,{track:value,basemap:'none',onBasemap:vi.fn(),onBusyChange})))}
function rows(){return Array.from(node.querySelectorAll<HTMLButtonElement>('[data-placemark-id]'))}
function ids(){return rows().map(row=>row.dataset.placemarkId)}
function button(label:string){return Array.from(node.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.getAttribute('aria-label')===label||button.textContent===label)!}
async function press(row:HTMLElement,key:string,altKey=true){await act(async()=>row.dispatchEvent(new KeyboardEvent('keydown',{key,altKey,bubbles:true,cancelable:true})))}
function transfer(){
  const data=new Map<string,string>()
  return {effectAllowed:'none',dropEffect:'none',get types(){return [...data.keys()]},setData:(type:string,value:string)=>data.set(type,value),getData:(type:string)=>data.get(type)||''}
}
async function drag(element:HTMLElement,type:string,data:ReturnType<typeof transfer>,clientY=0){
  const event=new Event(type,{bubbles:true,cancelable:true})
  Object.defineProperties(event,{dataTransfer:{value:data},clientY:{value:clientY}})
  await act(async()=>element.dispatchEvent(event))
  return event
}
async function pointer(element:HTMLElement,type:string,x:number,y:number){
  const event=new Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:1,button:0,clientX:x,clientY:y})
  await act(async()=>element.dispatchEvent(event));return event
}
function orderedFixture(){return {...track,placemarks:[
  {...track.placemarks![0],id:'late',name:'较晚',time:2000},
  {...track.placemarks![1],id:'untimed',name:'无时间'},
  {...track.placemarks![0],id:'early',name:'较早',time:1000,images:['https://example.com/early.jpg']}
]}}
async function editInput(label:string,value:string){
  const element=node.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`[aria-label="${label}"]`)!
  const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,value)
  await act(async()=>element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true})))
}
function typeCheckbox(label:string){return node.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="点位类型：${label}"]`)!}
async function toggleType(label:string){await act(async()=>typeCheckbox(label).click())}
async function saveDrawer(){await act(async()=>node.querySelector('dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))}
async function shortcut(target:EventTarget=document,options:KeyboardEventInit={key:'z',ctrlKey:true}){
  const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options})
  await act(async()=>target.dispatchEvent(event))
  return event
}
function focusEditorControl(){
  const control=rows()[0]||button('线路编辑')
  control.focus()
  expect(document.activeElement).toBe(control)
}
function pointSnapshot(){return structuredClone({ids:ids(),points:map.current!.placemarks})}
function writes(){return service.api.mock.calls.filter(([,data])=>data!==undefined)}
async function renderEditor(){await act(async()=>root.render(createElement(TrackEditor,{initial:track,availableTracks:[],basemap:'none',onBasemap:vi.fn(),loadTrack:async()=>track,onSave:vi.fn(async()=>{}),onCancel:vi.fn()})))}
function groupingFixture():TrackRecord{return {...track,placemarks:[
  {...track.placemarks![0],time:1000},
  {...track.placemarks![1],time:2000},
  {...track.placemarks![0],id:'kml-3',name:'观景台',time:3000,coordinates:[120.03,30.03],images:['https://example.com/view.jpg'],type:['风景点','打卡点']},
  {...track.placemarks![0],id:'kml-4',name:'休息站',time:4000,coordinates:[120.04,30.04],images:['https://example.com/rest.jpg'],type:'休息点'},
  {...track.placemarks![1],id:'kml-5',name:'补给站',time:5000,coordinates:[120.05,30.05]},
  {...track.placemarks![1],id:'kml-6',name:'终点',time:6000,coordinates:[120.1,30.1]},
]}}
function groupingRecords():PlacemarkGroup[]{return [
  {id:'group-00000000-0000-4000-8000-000000000001',name:'风景组',description:'两处风景',memberIds:['kml-1','kml-3'],coordinates:[120.03,30.03],cover:{pointId:'kml-3',imageUrl:'https://example.com/view.jpg'}},
  {id:'group-00000000-0000-4000-8000-000000000002',name:'休息组',description:'休息和终点',memberIds:['kml-4','kml-6'],coordinates:[120.04,30.04],cover:{pointId:'kml-4',imageUrl:'https://example.com/rest.jpg'}},
]}
function rowById(id:string){return rows().find(row=>row.dataset.placemarkId===id)!}
function pointRow(number:number){return rows().find(row=>row.dataset.placemarkKind==='point'&&row.querySelector('.trk-overview-number')?.textContent===String(number))!}
function groupChecked(){return Array.from(node.querySelectorAll<HTMLButtonElement>('.trk-overview-row-checked [data-placemark-kind="point"]')).map(row=>Number(row.querySelector('.trk-overview-number')!.textContent)).sort((a,b)=>a-b)}
async function selectionClick(target:HTMLElement,shiftKey=false){await act(async()=>target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,shiftKey})))}
async function selectionToggle(target:HTMLElement,shiftKey=false){await act(async()=>target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:!shiftKey,shiftKey})))}
async function pointMenu(target:HTMLElement){await act(async()=>target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:120})))}
async function createSelectedGroup(){
  const first=node.querySelector<HTMLButtonElement>('.trk-overview-row-checked [data-placemark-kind="point"]')!
  await pointMenu(first)
  await act(async()=>button(`打组（${groupChecked().length}）`).click())
}
async function selectForGroup(...numbers:number[]){
  for(const number of numbers)await selectionToggle(pointRow(number))
  await createSelectedGroup()
}

describe('placemark grouping integration',()=>{
  it('selects directly with Ctrl and Cmd clicks, keeps right-click selection intact, and cancels menus without saving',async()=>{
    await render(groupingFixture())
    await selectionClick(rowById('kml-1'))
    await act(async()=>rowById('kml-3').dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true,cancelable:true})))
    await act(async()=>rowById('kml-5').dispatchEvent(new MouseEvent('click',{metaKey:true,bubbles:true,cancelable:true})))
    expect(groupChecked()).toEqual([1,3,5]);expect(button('选择打组')).toBeUndefined()
    await pointMenu(rowById('kml-3'));expect(groupChecked()).toEqual([1,3,5])
    expect(node.querySelector('[role="menu"]')).not.toBeNull();expect(document.activeElement).toBe(button('打组（3）'))
    await shortcut(document,{key:'Escape'})
    expect(node.querySelector('[role="menu"]')).toBeNull();expect(groupChecked()).toEqual([1,3,5])
    await pointMenu(rowById('kml-5'));await act(async()=>document.body.dispatchEvent(new Event('pointerdown',{bubbles:true})))
    expect(node.querySelector('[role="menu"]')).toBeNull();expect(writes()).toHaveLength(0)
    await pointMenu(rowById('kml-2'));expect(groupChecked()).toEqual([2]);expect(button('打组（1）').disabled).toBe(true)
  })
  it('opens a keyboard context menu, navigates its actions and groups immediately with Enter',async()=>{
    await render(groupingFixture());await selectionToggle(pointRow(1));await selectionToggle(pointRow(3))
    await shortcut(rowById('kml-3'),{key:'F10',shiftKey:true})
    expect(document.activeElement).toBe(button('打组（2）'))
    await shortcut(document.activeElement!,{key:'ArrowDown'});expect(document.activeElement).toBe(button('删除所选标注点（2）'))
    await shortcut(document.activeElement!,{key:'ArrowUp'});expect(document.activeElement).toBe(button('打组（2）'))
    await act(async()=>button('打组（2）').click())
    expect(node.querySelector('[role="menu"]')).toBeNull();expect(node.querySelector('dialog')).toBeNull()
    expect(service.groups.get(track.id)![0].memberIds).toEqual(['kml-1','kml-3'])
    expect(writes()).toHaveLength(1)
  })
  it('does not start a photo gesture when Ctrl or Shift clicking a row thumbnail for selection',async()=>{
    await render(groupingFixture());await selectionClick(rowById('kml-1'))
    const thumbnail=rowById('kml-3').querySelector<HTMLElement>('.trk-overview-thumbnail')!
    const pointer=new MouseEvent('pointerdown',{button:0,ctrlKey:true,bubbles:true,cancelable:true})
    await act(async()=>thumbnail.dispatchEvent(pointer));expect(pointer.defaultPrevented).toBe(false)
    await act(async()=>thumbnail.dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true,cancelable:true})))
    expect(groupChecked()).toEqual([1,3]);expect(writes()).toHaveLength(0)
    await act(async()=>thumbnail.dispatchEvent(new MouseEvent('pointerdown',{button:0,shiftKey:true,bubbles:true,cancelable:true})))
    await selectionClick(rowById('kml-5').querySelector<HTMLElement>('.trk-overview-thumbnail')!,true)
    expect(groupChecked()).toEqual([1,3,4,5])
  })
  it('selects and deselects forward and reverse Shift ranges without moving the anchor or losing selections outside the range',async()=>{
    await render(groupingFixture())
    await selectionToggle(pointRow(6));await selectionToggle(pointRow(2));await selectionToggle(pointRow(4),true)
    expect(groupChecked()).toEqual([2,3,4,6])
    await selectionToggle(pointRow(5),true)
    expect(groupChecked()).toEqual([2,3,4,5,6])
    await selectionToggle(pointRow(4),true)
    expect(groupChecked()).toEqual([5,6])
    await selectionToggle(pointRow(1),true)
    expect(groupChecked()).toEqual([1,2,5,6])
    await pointMenu(rowById('kml-1'));expect(button('打组（4）').disabled).toBe(false)
    expect(writes()).toHaveLength(0)
  })
  it('shares the Shift anchor between Ctrl clicks, Shift clicks and keyboard activation including expanded grouped children for deletion',async()=>{
    const value=groupingFixture();value.placemarks![3].hidden=true;service.groups.set(value.id,[groupingRecords()[0]])
    await render(value);await act(async()=>button('展开标记点组 G1').click())
    await selectionToggle(pointRow(2));await selectionClick(rowById('kml-3'),true)
    await selectionClick(rowById('kml-5'),true)
    expect(groupChecked()).toEqual([2,3,4,5])
    expect(groupChecked()).not.toContain(1);expect(groupChecked()).toContain(3)
    const event=new KeyboardEvent('keydown',{key:' ',shiftKey:true,bubbles:true,cancelable:true})
    await act(async()=>rowById('kml-6').dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true);expect(groupChecked()).toEqual([2,3,4,5,6])
    await act(async()=>rowById('kml-6').dispatchEvent(new KeyboardEvent('keydown',{key:' ',shiftKey:true,repeat:true,bubbles:true,cancelable:true})))
    expect(groupChecked()).toEqual([2,3,4,5,6])
    await pointMenu(rowById('kml-3'));expect(button('打组（5）').disabled).toBe(true)
    await act(async()=>button('取消选择').click());await selectionToggle(pointRow(2));await selectionToggle(pointRow(4));await selectionToggle(pointRow(5));await selectionToggle(pointRow(6))
    await createSelectedGroup()
    expect(service.groups.get(value.id)![1].memberIds).toEqual(['kml-2','kml-4','kml-5','kml-6'])
    expect(writes()).toHaveLength(1)
  })
  it('uses the current manual point order for Shift row selection and keeps it when creating a group',async()=>{
    const value=groupingFixture(),order=['kml-6','kml-2','kml-5','kml-1','kml-4','kml-3'];service.orders.set(value.id,order)
    await render(value)
    await selectionClick(rowById('kml-5'));await selectionClick(rowById('kml-4'),true)
    expect(groupChecked()).toEqual([3,4,5])
    await createSelectedGroup()
    expect(service.groups.get(value.id)![0].memberIds).toEqual(['kml-5','kml-1','kml-4'])
    expect(service.orders.get(value.id)).toEqual(order)
  })
  it('starts a fresh Shift anchor after cancelling selection or changing tracks, and falls back to a single point with no anchor',async()=>{
    const value=groupingFixture();await render(value)
    await selectionToggle(pointRow(3),true);expect(groupChecked()).toEqual([3])
    await selectionToggle(pointRow(5),true);expect(groupChecked()).toEqual([3,4,5])
    await pointMenu(rowById('kml-3'));await act(async()=>button('取消选择').click())
    await selectionToggle(pointRow(6),true);expect(groupChecked()).toEqual([6])
    await render({...value,id:'other-track'})
    expect(groupChecked()).toEqual([])
    await selectionToggle(pointRow(1),true)
    expect(groupChecked()).toEqual([1]);expect(writes()).toHaveLength(0)
  })
  it('clears selection and the range anchor after successfully creating a group',async()=>{
    await render(groupingFixture())
    await selectionToggle(pointRow(1));await selectionToggle(pointRow(2),true)
    await createSelectedGroup()
    expect(pointRow(1)).toBeUndefined();expect(groupChecked()).toEqual([])
    await selectionToggle(pointRow(6),true)
    expect(groupChecked()).toEqual([6]);expect(writes()).toHaveLength(1)
  })
  it('creates a collapsed group immediately from the right-click menu, links all views and persists one undoable step without a creation drawer',async()=>{
    const value=groupingFixture(),before=JSON.stringify(value)
    await render(value)
    await selectForGroup(1,3)
    expect(node.querySelector('dialog')).toBeNull()
    expect(button('选择打组')).toBeUndefined()
    expect(button('撤销').disabled).toBe(false)
    const saved=service.groups.get(value.id)![0]
    expect(saved.id).toMatch(/^group-/)
    expect(saved.memberIds).toEqual(['kml-1','kml-3'])
    expect(saved.coordinates).toEqual(value.placemarks![0].coordinates)
    expect(saved.cover).toEqual({pointId:'kml-1',imageUrl:'https://example.com/one.jpg'})
    expect(node.querySelector('dialog')).toBeNull()
    expect(ids()).toEqual([saved.id,'kml-2','kml-4','kml-5','kml-6'])
    expect(button('展开标记点组 G1').getAttribute('aria-expanded')).toBe('false')
    expect(map.current!.selectedPlacemark).toBe(saved.id)
    expect(profile.current!.selectedPlacemark).toBe('kml-1')
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(JSON.stringify(value)).toBe(before)
    await act(async()=>button('撤销').click())
    expect(service.groups.get(value.id)).toEqual([])
    expect(ids()).toEqual(value.placemarks!.map(point=>point.id))
    expect(map.current!.placemarkGroups).toEqual([])
    await act(async()=>button('重做').click())
    expect(service.groups.get(value.id)).toEqual([saved])
    expect(map.current!.placemarkGroups).toEqual([saved])
    expect(writes().map(([action])=>action)).toEqual(['placemark-state','placemark-state','placemark-state'])
    expect(service.edits.get(value.id)).toEqual([])
  })
  it('retains selection after failed direct grouping, retries without advancing history, and reopens the saved group for editing',async()=>{
    const value=groupingFixture()
    await render(value);service.failure='分组磁盘写入失败';await selectForGroup(1,3)
    expect(node.querySelector('dialog')).toBeNull()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('分组磁盘写入失败')
    expect(groupChecked()).toEqual([1,3])
    expect(map.current!.placemarkGroups).toEqual([])
    expect(ids()).toEqual(value.placemarks!.map(point=>point.id))
    expect(button('撤销').disabled).toBe(true)
    service.failure='';await createSelectedGroup()
    const saved=service.groups.get(value.id)![0]
    await act(async()=>button('编辑标记点组 G1').click());await editInput('分组名称','重试组');await editInput('分组描述','保留成员和封面');await saveDrawer()
    await act(async()=>root.render(null));await render(value)
    expect(map.current!.placemarkGroups![0].id).toBe(saved.id)
    expect(button('撤销').disabled).toBe(true)
    await act(async()=>button('编辑标记点组 G1').click())
    expect(node.querySelector<HTMLInputElement>('[aria-label="分组名称"]')!.value).toBe('重试组')
    expect(node.querySelector<HTMLTextAreaElement>('[aria-label="分组描述"]')!.value).toBe('保留成员和封面')
    expect(node.querySelector('[data-group-member-id="kml-1"]')).not.toBeNull()
  })
  it('retains multi-selection if a group is clicked while direct grouping is pending and later fails',async()=>{
    const value=groupingFixture(),group=groupingRecords()[0];service.groups.set(value.id,[group]);await render(value)
    await selectionToggle(pointRow(2));await selectionToggle(pointRow(5))
    let finish!:()=>void;service.wait=new Promise<void>(resolve=>{finish=resolve});service.failure='待保存分组失败'
    await createSelectedGroup()
    expect(node.textContent).toContain('已选择 2 个点');expect(button('撤销').disabled).toBe(true)
    await selectionClick(rowById(group.id))
    expect(node.textContent).toContain('已选择 2 个点')
    await act(async()=>finish());service.wait=null
    expect(groupChecked()).toEqual([2,5]);expect(service.groups.get(value.id)).toEqual([group])
    expect(button('撤销').disabled).toBe(true)
  })
  it('blocks multi-selection, right-click grouping and ordering during a map gesture',async()=>{
    await render(groupingFixture());await selectionToggle(pointRow(1));await selectionToggle(pointRow(3))
    await act(async()=>map.current!.onPlacemarkDragChange!(true))
    expect(button('编辑标注点 2').disabled).toBe(true)
    await selectionClick(rowById('kml-5'),true);expect(groupChecked()).toEqual([1,3])
    await pointMenu(rowById('kml-1'));expect(node.querySelector('[role="menu"]')).toBeNull()
    await press(rowById('kml-1'),'ArrowDown')
    const data=transfer();expect((await drag(rowById('kml-1'),'dragstart',data)).defaultPrevented).toBe(true)
    expect(writes()).toHaveLength(0)
    await act(async()=>map.current!.onPlacemarkDragChange!(false));await createSelectedGroup()
    expect(service.groups.get(track.id)![0].memberIds).toEqual(['kml-1','kml-3'])
  })
  it('expands the exact parent for map or profile child selection and retains flat leaf numbering across all three views',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups)
    await render(value)
    expect(ids()).toEqual([groups[0].id,'kml-2',groups[1].id,'kml-5'])
    expect(rowById('kml-2').getAttribute('aria-label')).toMatch(/^标注点 2，/)
    expect(rowById('kml-5').getAttribute('aria-label')).toMatch(/^标注点 5，/)
    await act(async()=>map.current!.onSelectPlacemark!('kml-3'))
    expect(button('收起标记点组 G1').getAttribute('aria-expanded')).toBe('true')
    expect(rowById('kml-3').getAttribute('aria-label')).toMatch(/^标注点 3，/)
    expect(rowById('kml-3').getAttribute('aria-pressed')).toBe('true')
    expect(profile.current!.selectedPlacemark).toBe('kml-3')
    await act(async()=>profile.current!.onSelectPlacemark!('kml-6'))
    expect(button('收起标记点组 G2').getAttribute('aria-expanded')).toBe('true')
    expect(rowById('kml-6').getAttribute('aria-label')).toMatch(/^标注点 6，/)
    expect(map.current!.selectedPlacemark).toBe('kml-6')
    expect(rowById(groups[1].id).getAttribute('aria-pressed')).toBe('true')
    await act(async()=>button('收起标记点组 G2').click())
    expect(rowById('kml-6')).toBeUndefined()
    await act(async()=>profile.current!.onSelectPlacemark!('kml-6'))
    expect(button('收起标记点组 G2').getAttribute('aria-expanded')).toBe('true')
    expect(rowById('kml-6').getAttribute('aria-pressed')).toBe('true')
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(writes()).toHaveLength(0)
  })
  it('moves only group coordinates along the route, keeps cover and all child tuples intact, and can undo and retry a failed move',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups)
    await render(value)
    const before=structuredClone(map.current!.placemarks)
    await act(async()=>map.current!.onMovePlacemark!(groups[0].id,[120.07,30.08]))
    const moved=service.groups.get(value.id)![0]
    expect(moved.coordinates).not.toEqual(groups[0].coordinates)
    expect(moved.cover).toEqual(groups[0].cover)
    expect(moved.memberIds).toEqual(groups[0].memberIds)
    expect(map.current!.placemarks).toEqual(before)
    expect(service.edits.get(value.id)).toEqual([])
    await act(async()=>button('撤销').click())
    expect(service.groups.get(value.id)).toEqual(groups)
    service.failure='组位置未保存';await act(async()=>map.current!.onMovePlacemark!(groups[0].id,[120.07,30.08]))
    expect(map.current!.placemarkGroups).toEqual(groups)
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('组位置未保存')
    expect(button('重做').disabled).toBe(false)
    service.failure='';await act(async()=>button('重做').click())
    expect(service.groups.get(value.id)![0]).toEqual(moved)
  })
  it('keeps original child visibility when hiding the group, edits members to a single retained child and dissolves reversibly',async()=>{
    const value=groupingFixture(),groups=groupingRecords();value.placemarks![2].hidden=true;service.groups.set(value.id,groups)
    await render(value)
    const before=structuredClone(map.current!.placemarks)
    await act(async()=>button('隐藏标记点组 G1').click())
    expect(service.groups.get(value.id)![0].hidden).toBe(true)
    expect(map.current!.placemarks).toEqual(before)
    await act(async()=>button('撤销').click())
    expect(service.groups.get(value.id)![0].hidden).toBeUndefined()
    await act(async()=>button('编辑标记点组 G1').click())
    await act(async()=>button('移出分组成员：3 观景台').click())
    await saveDrawer()
    expect(service.groups.get(value.id)!.find(group=>group.id===groups[0].id)!.memberIds).toEqual(['kml-1'])
    expect(rowById('kml-3').getAttribute('aria-label')).toContain('已在地图隐藏')
    await act(async()=>button('编辑标记点组 G1').click())
    service.failure='不能解散';await act(async()=>button('解散分组').click())
    expect(node.querySelector('dialog')).not.toBeNull()
    expect(service.groups.get(value.id)!.find(group=>group.id===groups[0].id)!.memberIds).toEqual(['kml-1'])
    service.failure='';await act(async()=>button('解散分组').click())
    expect(service.groups.get(value.id)).toEqual([groups[1]])
    expect(rowById('kml-1')).toBeDefined()
    expect(map.current!.placemarks).toEqual(before)
    await act(async()=>button('撤销').click())
    expect(service.groups.get(value.id)!.find(group=>group.id===groups[0].id)!.memberIds).toEqual(['kml-1'])
    await act(async()=>button('撤销').click())
    expect(service.groups.get(value.id)).toEqual(groups)
    expect(map.current!.placemarks).toEqual(before)
  })
  it('adds an external point dropped in the center of a group in one undoable write, preserving cover, position, order and unresolved members',async()=>{
    const value=groupingFixture(),group={...groupingRecords()[0],hidden:true,memberIds:['kml-1','kml-3','not_restored']};value.placemarks![1].type='补给点'
    service.groups.set(value.id,[group]);await render(value)
    const before=pointSnapshot(),target=rowById(group.id),data=transfer()
    vi.spyOn(target,'getBoundingClientRect').mockReturnValue({top:100,bottom:200,height:100,left:0,right:240,width:240,x:0,y:100,toJSON(){}})
    await drag(rowById('kml-2'),'dragstart',data)
    expect((await drag(target,'dragover',data,150)).defaultPrevented).toBe(true)
    expect(node.querySelector('[data-group-id]')!.classList.contains('trk-overview-group-drop-target')).toBe(true)
    expect(node.textContent).toContain('松开加入分组')
    await drag(target,'drop',data,150)
    expect(service.groups.get(value.id)![0]).toEqual({...group,memberIds:['kml-1','kml-2','kml-3','not_restored']})
    expect(map.current!.placemarks).toEqual(before.points)
    expect(service.orders.get(value.id)).toBeNull();expect(service.edits.get(value.id)).toEqual([])
    expect(rowById(group.id).textContent).toContain('补给点')
    expect(button('收起标记点组 G1').getAttribute('aria-expanded')).toBe('true')
    expect(map.current!.selectedPlacemark).toBe('kml-2');expect(profile.current!.selectedPlacemark).toBe('kml-2')
    expect(writes().map(([action])=>action)).toEqual(['placemark-state'])
    await act(async()=>button('撤销').click());expect(service.groups.get(value.id)).toEqual([group])
    await act(async()=>button('重做').click());expect(service.groups.get(value.id)![0].memberIds).toEqual(['kml-1','kml-2','kml-3','not_restored'])
  })
  it('keeps group edge drops as sorting, accepts an external point on an expanded child center and rolls back failed membership saves',async()=>{
    const value=groupingFixture(),group=groupingRecords()[0];service.groups.set(value.id,[group]);await render(value)
    const target=rowById(group.id)
    vi.spyOn(target,'getBoundingClientRect').mockReturnValue({top:100,bottom:200,height:100,left:0,right:240,width:240,x:0,y:100,toJSON(){}})
    const sorting=transfer();await drag(rowById('kml-5'),'dragstart',sorting)
    await drag(target,'dragover',sorting,105);expect(node.querySelector('.trk-overview-group-drop-target')).toBeNull()
    await drag(target,'drop',sorting,105)
    expect(writes().map(([action])=>action)).toEqual(['placemark-state']);expect(service.groups.get(value.id)).toEqual([group])
    await act(async()=>button('撤销').click());await act(async()=>button('展开标记点组 G1').click())
    const child=rowById('kml-3');vi.spyOn(child,'getBoundingClientRect').mockReturnValue({top:100,bottom:200,height:100,left:0,right:240,width:240,x:0,y:100,toJSON(){}})
    const failed=transfer();service.failure='成员保存失败';await drag(rowById('kml-2'),'dragstart',failed);await drag(child,'dragover',failed,150);await drag(child,'drop',failed,150)
    expect(service.groups.get(value.id)).toEqual([group]);expect(map.current!.placemarkGroups).toEqual([group])
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('成员保存失败');expect(button('撤销').disabled).toBe(true)
    service.failure='';const retry=transfer();await drag(rowById('kml-2'),'dragstart',retry);await drag(child,'drop',retry,150)
    expect(service.groups.get(value.id)![0].memberIds).toEqual(['kml-1','kml-2','kml-3'])
    expect(button('撤销').disabled).toBe(false)
  })
  it('joins a group through its pointer drag handle once, suppresses native dragging and duplicate capture release, and unlocks after saving',async()=>{
    const value=groupingFixture(),group=groupingRecords()[0],onBusyChange=vi.fn();service.groups.set(value.id,[group]);await render(value,onBusyChange)
    const source=rowById('kml-2'),handle=source.querySelector<HTMLElement>('.trk-overview-drag-handle')!,target=rowById(group.id),original=document.elementFromPoint
    document.elementFromPoint=vi.fn(()=>target)
    Object.assign(handle,{setPointerCapture:vi.fn(),releasePointerCapture:vi.fn(()=>{const event=new Event('lostpointercapture',{bubbles:true});Object.assign(event,{pointerId:1});handle.dispatchEvent(event)})})
    vi.spyOn(target,'getBoundingClientRect').mockReturnValue({top:100,bottom:200,height:100,left:0,right:240,width:240,x:0,y:100,toJSON(){}})
    try{
      expect((await pointer(handle,'pointerdown',20,20)).defaultPrevented).toBe(true)
      expect(onBusyChange).toHaveBeenLastCalledWith(true);expect(map.current!.placemarkEditingDisabled).toBe(true)
      expect((await drag(source,'dragstart',transfer())).defaultPrevented).toBe(true)
      await pointer(handle,'pointermove',120,150);expect(node.textContent).toContain('松开加入分组')
      await pointer(handle,'pointerup',120,150)
      expect(service.groups.get(value.id)![0].memberIds).toEqual(['kml-1','kml-2','kml-3'])
      expect(writes()).toHaveLength(1);expect(onBusyChange).toHaveBeenLastCalledWith(false)
      expect(node.querySelector('.trk-overview-group-drop-target')).toBeNull()
      await selectionClick(rowById('kml-2'));expect(groupChecked()).toEqual([])
    }finally{document.elementFromPoint=original}
  })
  it.each(['no-move','cancel','capture-lost','blur','track-change'])('cancels a pointer ordering gesture without saving on %s',async ending=>{
    const value=groupingFixture(),group=groupingRecords()[0];service.groups.set(value.id,[group]);await render(value)
    const handle=rowById('kml-2').querySelector<HTMLElement>('.trk-overview-drag-handle')!,target=rowById(group.id),original=document.elementFromPoint
    document.elementFromPoint=vi.fn(()=>target);vi.spyOn(target,'getBoundingClientRect').mockReturnValue({top:100,bottom:200,height:100,left:0,right:240,width:240,x:0,y:100,toJSON(){}})
    try{
      await pointer(handle,'pointerdown',20,20)
      if(ending!=='no-move')await pointer(handle,'pointermove',120,150)
      if(ending==='no-move')await pointer(handle,'pointerup',21,21)
      if(ending==='cancel')await pointer(handle,'pointercancel',120,150)
      if(ending==='capture-lost')await pointer(handle,'lostpointercapture',120,150)
      if(ending==='blur')await act(async()=>window.dispatchEvent(new Event('blur')))
      if(ending==='track-change')await render({...value,id:'next-track'})
      await pointer(handle,'pointerup',120,150)
      expect(writes()).toHaveLength(0);expect(service.groups.get(value.id)).toEqual([group])
      expect(node.querySelector('.trk-overview-group-drop-target')).toBeNull()
    }finally{document.elementFromPoint=original}
  })
  it('locks time reset and photo transfer controls throughout a pointer ordering gesture without interrupting legitimate photo movement afterwards',async()=>{
    const value=groupingFixture();service.orders.set(value.id,value.placemarks!.map(point=>point.id));await render(value)
    await selectionClick(rowById('kml-1'));await act(async()=>button('选择第 1 张照片，可拖到其他点位').click());await editInput('照片移动到点位','kml-2')
    expect(button('恢复时间排序').disabled).toBe(false);expect(button('移动照片').disabled).toBe(false)
    const handle=rowById('kml-1').querySelector<HTMLElement>('.trk-overview-drag-handle')!
    await pointer(handle,'pointerdown',20,20)
    expect(button('恢复时间排序').disabled).toBe(true);expect(button('移动照片').disabled).toBe(true)
    await act(async()=>{button('恢复时间排序').click();button('移动照片').click()});expect(writes()).toHaveLength(0)
    await pointer(handle,'pointercancel',20,20)
    expect(button('恢复时间排序').disabled).toBe(false);expect(button('移动照片').disabled).toBe(false)
    await act(async()=>button('移动照片').click());expect(writes().map(([action])=>action)).toEqual(['placemark-state'])
  })
  it('sorts top-level groups as complete rows, recomputes G labels and leaf numbers, retains selection and restores time order with undo',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups)
    await render(value);await act(async()=>rowById(groups[0].id).click());await act(async()=>button('收起标记点组 G1').click())
    await press(rowById(groups[0].id),'ArrowDown');await press(rowById(groups[0].id),'ArrowDown')
    expect(service.orders.get(value.id)).toEqual(['kml-2','kml-4','kml-6','kml-1','kml-3','kml-5'])
    expect(ids()).toEqual(['kml-2',groups[1].id,groups[0].id,'kml-5'])
    expect(rowById(groups[1].id).getAttribute('aria-label')).toBe('标记点组 G1：休息组')
    expect(rowById(groups[0].id).getAttribute('aria-label')).toBe('标记点组 G2：风景组')
    expect(map.current!.selectedPlacemark).toBe(groups[0].id)
    expect(profile.current!.selectedPlacemark).toBe('kml-3')
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(profile.current!.placemarks!.map(point=>point.id)).toEqual(service.orders.get(value.id))
    expect(rowById('kml-2').getAttribute('aria-label')).toMatch(/^标注点 1，/)
    expect(rowById('kml-5').getAttribute('aria-label')).toMatch(/^标注点 6，/)
    expect(service.groups.get(value.id)).toEqual(groups)
    await act(async()=>button('恢复时间排序').click())
    expect(service.orders.get(value.id)).toBeNull()
    expect(ids()).toEqual([groups[0].id,'kml-2',groups[1].id,'kml-5'])
    await act(async()=>button('撤销').click())
    expect(service.orders.get(value.id)).toEqual(['kml-2','kml-4','kml-6','kml-1','kml-3','kml-5'])
  })
  it('reorders children only in their existing flat slots, rejects cross-group and child-to-top drops, and rolls back failed sorting',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups)
    await render(value);await act(async()=>button('展开标记点组 G1').click());await act(async()=>button('展开标记点组 G2').click())
    await press(rowById('kml-3'),'ArrowUp')
    expect(service.orders.get(value.id)).toEqual(['kml-3','kml-2','kml-1','kml-4','kml-5','kml-6'])
    expect(map.current!.placemarks![1].id).toBe('kml-2')
    const count=writes().length
    for(const target of ['kml-4','kml-2']){
      const data=transfer();await drag(rowById('kml-3'),'dragstart',data)
      expect((await drag(rowById(target),'dragover',data)).defaultPrevented).toBe(false)
      await drag(rowById(target),'drop',data);await drag(rowById('kml-3'),'dragend',data)
    }
    expect(writes()).toHaveLength(count)
    expect(service.groups.get(value.id)).toEqual(groups)
    service.failure='排序失败';await press(rowById('kml-1'),'ArrowUp')
    expect(service.orders.get(value.id)).toEqual(['kml-3','kml-2','kml-1','kml-4','kml-5','kml-6'])
    expect(profile.current!.placemarks!.map(point=>point.id)).toEqual(service.orders.get(value.id))
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('排序失败')
    service.failure='';await act(async()=>button('撤销').click())
    expect(service.orders.get(value.id)).toBeNull()
  })
  it('locks the photo movement controls while selecting ungrouped points',async()=>{
    const value=groupingFixture();service.groups.set(value.id,groupingRecords())
    await render(value)
    await act(async()=>map.current!.onSelectPlacemark!('kml-3'))
    await act(async()=>button('选择第 1 张照片，可拖到其他点位').click())
    const target=node.querySelector<HTMLSelectElement>('[aria-label="照片移动到点位"]')!
    await act(async()=>{target.value='kml-2';target.dispatchEvent(new Event('change',{bubbles:true}))})
    expect(button('移动照片').disabled).toBe(false)
    await selectionToggle(pointRow(2));await selectionToggle(pointRow(5))
    expect(button('选择第 1 张照片，可拖到其他点位').disabled).toBe(true)
    expect(target.disabled).toBe(true)
    expect(button('移动照片').disabled).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it('prevents group photos and grouped children from being mistaken for ungrouped selection or photo-drop targets',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups)
    await render(value);await act(async()=>button('展开标记点组 G1').click())
    expect(button('编辑标注点 1').disabled).toBe(false);expect(button('编辑标注点 2').disabled).toBe(false)
    await selectionClick(rowById('kml-1'),true);expect(groupChecked()).toEqual([1])
    const data=transfer();data.setData('text/x-cqai-track-photo',JSON.stringify({pointId:'kml-1',url:'https://example.com/one.jpg'}))
    expect((await drag(rowById(groups[1].id),'dragover',data)).defaultPrevented).toBe(false)
    await drag(rowById(groups[1].id),'drop',data)
    expect(writes()).toHaveLength(0)
    expect(map.current!.placemarks).toEqual(value.placemarks)
  })
  it('fails closed during group loading and on errors, exposes retry, and locks parent switching while a group save is pending',async()=>{
    const value=groupingFixture(),groups=groupingRecords(),implementation=service.api.getMockImplementation()!
    let release!:(value:unknown)=>void
    service.api.mockImplementation((action:string,data?:unknown)=>action.startsWith('placemark-state')&&data===undefined?new Promise(resolve=>{release=resolve}):implementation(action,data))
    const onBusyChange=vi.fn();await render(value,onBusyChange)
    expect(map.current!.placemarks).toEqual([]);expect(map.current!.placemarkGroups).toEqual([]);expect(ids()).toEqual([])
    expect(node.textContent).toContain('正在读取分组')
    expect(node.querySelector('.trk-overview-row-actions')).toBeNull()
    expect(button('选择打组')).toBeUndefined()
    await act(async()=>release({state:{version:1,revision:0,added:[],deletedIds:[],edits:[],order:null,groups,routeContext:{segmentStarts:[0],references:value.placemarks}}}));service.groups.set(value.id,groups);service.api.mockImplementation(implementation)
    let finish!:()=>void;service.wait=new Promise<void>(resolve=>{finish=resolve})
    await act(async()=>button('隐藏标记点组 G1').click())
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    expect(map.current!.placemarkEditingDisabled).toBe(true);expect(button('撤销').disabled).toBe(true)
    await act(async()=>finish());service.wait=null
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    await act(async()=>root.render(null))
    service.api.mockImplementation(async(action:string,data?:unknown)=>{if(action.startsWith('placemark-state')&&data===undefined)throw new Error('分组不可读');return implementation(action,data)})
    await render(value)
    expect(ids()).toEqual([]);expect(map.current!.placemarks).toEqual([]);expect(map.current!.placemarkGroups).toEqual([])
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('分组不可读')
    expect(button('重试读取分组')).toBeDefined()
    service.api.mockImplementation(implementation);await act(async()=>button('重试读取分组').click())
    expect(ids()).not.toEqual([]);expect(map.current!.placemarkGroups).toEqual(service.groups.get(value.id))
  })
})

describe('placemark editor session undo and redo',()=>{
  it.each(['sort','time-reset','move','photo','visibility','drawer'] as const)('records %s as one persisted undo step and restores every affected point on redo',async operation=>{
    if(operation==='time-reset')service.orders.set(track.id,['kml-2','kml-1'])
    await render()
    expect(button('撤销').disabled).toBe(true)
    expect(button('重做').disabled).toBe(true)
    const before=pointSnapshot()
    if(operation==='sort')await press(rows()[0],'ArrowDown')
    if(operation==='time-reset')await act(async()=>button('恢复时间排序').click())
    if(operation==='move')await act(async()=>map.current!.onMovePlacemark!('kml-1',[120.05,30.05]))
    if(operation==='photo'){
      await act(async()=>rows()[0].click())
      await act(async()=>button('选择第 1 张照片，可拖到其他点位').click())
      await editInput('照片移动到点位','kml-2')
      await act(async()=>button('移动照片').click())
    }
    if(operation==='visibility')await act(async()=>button('隐藏标注点 1').click())
    if(operation==='drawer'){
      await act(async()=>button('编辑标注点 1').click())
      await editInput('标注名','修正营地');await editInput('标注描述','整次保存作为一步')
      await toggleType('风景点');await toggleType('休息点')
      await act(async()=>button('移除第 2 张图片').click())
      await saveDrawer()
    }
    const after=pointSnapshot()
    expect(after).not.toEqual(before)
    expect(button('撤销').disabled).toBe(false)
    await act(async()=>button('撤销').click())
    expect(pointSnapshot()).toEqual(before)
    expect(button('撤销').disabled).toBe(true)
    expect(button('重做').disabled).toBe(false)
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    await act(async()=>button('重做').click())
    expect(pointSnapshot()).toEqual(after)
    expect(button('重做').disabled).toBe(true)
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(writes()).toHaveLength(3)
  })
  it('supports Ctrl and Command shortcuts, clears redo after a new action, and resets history on reentry',async()=>{
    await render()
    await act(async()=>button('隐藏标注点 1').click())
    expect(node.textContent).toContain('Ctrl')
    focusEditorControl()
    await shortcut(document,{key:'z',ctrlKey:true})
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
    await shortcut(document,{key:'z',metaKey:true,shiftKey:true})
    expect(map.current!.placemarks![0].hidden).toBe(true)
    await shortcut(document,{key:'z',metaKey:true})
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
    await shortcut(document,{key:'y',ctrlKey:true})
    expect(map.current!.placemarks![0].hidden).toBe(true)
    await shortcut()
    expect(node.textContent).toContain('已撤销上一步修改')
    await act(async()=>map.current!.onMovePlacemark!('kml-1',[120.05,30.05]))
    expect(button('重做').disabled).toBe(true)
    expect(node.textContent).not.toContain('已撤销上一步修改')
    const saved=pointSnapshot()
    await act(async()=>root.render(null))
    await render()
    expect(pointSnapshot()).toEqual(saved)
    expect(button('撤销').disabled).toBe(true)
    expect(button('重做').disabled).toBe(true)
  })
  it('preserves native text undo in input, textarea, select and contenteditable without changing points',async()=>{
    await render();await act(async()=>button('隐藏标注点 1').click())
    const saved=pointSnapshot(),count=writes().length
    for(const tag of ['input','textarea','select','div']){
      const field=document.createElement(tag)
      if(tag==='div'){field.setAttribute('contenteditable','true');field.tabIndex=0}
      node.querySelector('.trk-placemark-editor')!.append(field);field.focus()
      expect(document.activeElement).toBe(field)
      expect((await shortcut(field)).defaultPrevented).toBe(false)
      expect((await shortcut(field,{key:'z',ctrlKey:true,shiftKey:true})).defaultPrevented).toBe(false)
      for(const target of [document,document.body,document.documentElement]){
        expect((await shortcut(target)).defaultPrevented).toBe(false)
        expect((await shortcut(target,{key:'z',ctrlKey:true,shiftKey:true})).defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(field)
      }
      expect(pointSnapshot()).toEqual(saved)
      expect(writes()).toHaveLength(count)
      field.remove()
    }
    const outside=document.createElement('button');document.body.append(outside);outside.focus()
    try{
      expect((await shortcut(outside)).defaultPrevented).toBe(false)
      for(const target of [document,document.body,document.documentElement]){
        expect((await shortcut(target)).defaultPrevented).toBe(false)
        expect((await shortcut(target,{key:'y',ctrlKey:true})).defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(outside)
      }
      expect(pointSnapshot()).toEqual(saved)
      expect(writes()).toHaveLength(count)
    }finally{outside.remove()}
    focusEditorControl()
    for(const options of [{key:'z',ctrlKey:true,altKey:true},{key:'z',ctrlKey:true,isComposing:true}]){
      expect((await shortcut(document,options)).defaultPrevented).toBe(false)
      expect(pointSnapshot()).toEqual(saved)
    }
    const prevented=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});prevented.preventDefault()
    await act(async()=>document.dispatchEvent(prevented))
    expect(pointSnapshot()).toEqual(saved)
    expect(writes()).toHaveLength(count)
  })
  it('blocks background history while an edit drawer or a native image dialog is open',async()=>{
    await render();await act(async()=>button('隐藏标注点 1').click())
    const saved=pointSnapshot(),count=writes().length
    await act(async()=>button('编辑标注点 1').click())
    expect(button('撤销').disabled).toBe(true)
    await editInput('标注名','未保存文字')
    const field=node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!
    expect((await shortcut(field)).defaultPrevented).toBe(false)
    await shortcut(document)
    expect(pointSnapshot()).toEqual(saved)
    expect(writes()).toHaveLength(count)
    await act(async()=>button('取消').click())
    await act(async()=>button('放弃修改').click())
    focusEditorControl()
    const dialog=document.createElement('dialog');dialog.setAttribute('open','');node.append(dialog)
    await shortcut()
    expect(pointSnapshot()).toEqual(saved)
    expect(writes()).toHaveLength(count)
    dialog.remove()
    await shortcut()
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
  })
  it('keeps failed writes out of history and allows retrying a failed undo without consuming its step',async()=>{
    await render()
    service.failure='写入失败'
    await act(async()=>button('隐藏标注点 1').click())
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
    expect(button('撤销').disabled).toBe(true)
    expect(button('重做').disabled).toBe(true)
    service.failure=''
    await act(async()=>button('隐藏标注点 1').click())
    service.failure='撤销写入失败'
    await act(async()=>button('撤销').click())
    expect(map.current!.placemarks![0].hidden).toBe(true)
    expect(button('撤销').disabled).toBe(false)
    expect(button('重做').disabled).toBe(true)
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('撤销写入失败')
    service.failure=''
    await act(async()=>button('撤销').click())
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
    expect(button('撤销').disabled).toBe(true)
    expect(button('重做').disabled).toBe(false)
    service.failure='新修改保存失败'
    await act(async()=>map.current!.onMovePlacemark!('kml-1',[120.05,30.05]))
    expect(button('重做').disabled).toBe(false)
    service.failure=''
    await act(async()=>button('重做').click())
    expect(map.current!.placemarks![0].hidden).toBe(true)
  })
  it('blocks buttons and keyboard during a write and during an unfinished photo or ordering drag',async()=>{
    await render();await act(async()=>button('隐藏标注点 1').click())
    let finish!:()=>void
    service.wait=new Promise<void>(resolve=>{finish=resolve})
    await act(async()=>map.current!.onMovePlacemark!('kml-1',[120.05,30.05]))
    expect(button('撤销').disabled).toBe(true)
    const count=writes().length
    focusEditorControl()
    await shortcut()
    await shortcut(document,{key:'y',ctrlKey:true})
    expect(writes()).toHaveLength(count)
    await act(async()=>finish());service.wait=null
    const saved=pointSnapshot(),data=transfer(),row=rows()[0]
    await drag(row,'dragstart',data)
    expect(button('撤销').disabled).toBe(true)
    await shortcut();expect(pointSnapshot()).toEqual(saved)
    await drag(row,'dragend',data)
    expect(button('撤销').disabled).toBe(false)
    const thumbnail=rows()[0].querySelector<HTMLElement>('.trk-overview-thumbnail')!
    const pointer=async(type:string,x:number)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:1,button:0,clientX:x,clientY:80});await act(async()=>thumbnail.dispatchEvent(event))}
    const original=document.elementFromPoint;document.elementFromPoint=vi.fn(()=>rows()[1])
    try{
      await pointer('pointerdown',10);await pointer('pointermove',80)
      expect(button('撤销').disabled).toBe(true)
      await shortcut();expect(pointSnapshot()).toEqual(saved)
      await pointer('pointercancel',80)
      expect(button('撤销').disabled).toBe(false)
    }finally{document.elementFromPoint=original}
    await act(async()=>map.current!.onPlacemarkDragChange!(true))
    expect(button('撤销').disabled).toBe(true)
    await shortcut();expect(pointSnapshot()).toEqual(saved)
    await act(async()=>map.current!.onPlacemarkDragChange!(false))
    expect(button('撤销').disabled).toBe(false)
    expect(writes()).toHaveLength(count)
  })
  it('keeps point history and line history independent across tab remounts',async()=>{
    await renderEditor()
    await act(async()=>button('隐藏标注点 1').click())
    await act(async()=>button('线路编辑').click())
    await act(async()=>lineMap.current!.onMovePoint(1,120.095,30.095))
    const lineDraft=lineMap.current!.parts[0].points
    await act(async()=>button('标注点编辑').click())
    expect(map.current!.placemarks![0].hidden).toBe(true)
    expect(button('撤销').disabled).toBe(false)
    focusEditorControl()
    await shortcut()
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
    await act(async()=>button('线路编辑').click())
    expect(lineMap.current!.parts[0].points).toBe(lineDraft)
    focusEditorControl()
    await shortcut()
    expect(lineMap.current!.parts[0].points).toBe(track.coordinates)
    await act(async()=>button('标注点编辑').click())
    expect(button('重做').disabled).toBe(false)
    focusEditorControl()
    await shortcut(document,{key:'y',ctrlKey:true})
    expect(map.current!.placemarks![0].hidden).toBe(true)
    await act(async()=>button('线路编辑').click())
    expect(lineMap.current!.parts[0].points).toBe(track.coordinates)
    expect(button('重做').disabled).toBe(false)
    focusEditorControl()
    await shortcut(document,{key:'y',ctrlKey:true})
    expect(lineMap.current!.parts[0].points).toBe(lineDraft)
    await act(async()=>button('标注点编辑').click())
    expect(map.current!.placemarks![0].hidden).toBe(true)
  })
  it('retains saved changes but exposes no history controls or keyboard handler in the read-only overview',async()=>{
    await render();await act(async()=>button('隐藏标注点 1').click())
    const saved=pointSnapshot(),count=writes().length
    await act(async()=>root.render(createElement(TrackOverview,{track,basemap:'none',onBasemap:vi.fn()})))
    expect(pointSnapshot()).toEqual(saved)
    expect(button('撤销')).toBeUndefined()
    expect(button('重做')).toBeUndefined()
    focusEditorControl()
    await shortcut()
    expect(pointSnapshot()).toEqual(saved)
    expect(writes()).toHaveLength(count)
  })
})
describe('placemark information editing and visibility',()=>{
  it('opens the same drawer from the map callback and independent list edit buttons',async()=>{
    await render()
    expect(node.querySelector('button button')).toBeNull()
    await act(async()=>map.current!.onEditPlacemark!('kml-1'))
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('牧场')
    await act(async()=>button('取消').click())
    await act(async()=>button('编辑标注点 2').click())
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('山口')
    expect(map.current!.selectedPlacemark).toBe('kml-2')
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
  })
  it('saves two presets and multiple custom labels, preserves them on reopening, and clears classification explicitly',async()=>{
    await render()
    await act(async()=>button('编辑标注点 1').click())
    await editInput('标注名','营地');await editInput('标注描述','可以休息')
    await toggleType('风景点');await toggleType('休息点')
    await editInput('自定义点位标签','露营点')
    await act(async()=>button('添加标签').click())
    await editInput('自定义点位标签','摄影点')
    const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})
    await act(async()=>node.querySelector<HTMLInputElement>('[aria-label="自定义点位标签"]')!.dispatchEvent(enter))
    expect(enter.defaultPrevented).toBe(true)
    expect(node.querySelector('dialog')).not.toBeNull()
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
    expect(button('移除标签 露营点')).toBeDefined()
    expect(button('移除标签 摄影点')).toBeDefined()
    await saveDrawer()
    expect(node.querySelector('dialog')).toBeNull()
    const labels=['风景点','休息点','露营点','摄影点']
    expect(map.current!.placemarks![0]).toMatchObject({name:'营地',description:'可以休息',time:track.placemarks![0].time,images:track.placemarks![0].images})
    expect(map.current!.placemarks![0].type).toEqual(expect.arrayContaining(labels))
    expect(map.current!.placemarks![0].type).toHaveLength(4)
    expect(service.edits.get('kml')!.find(edit=>edit.id==='kml-1')!.type).toEqual(expect.arrayContaining(labels))
    for(const label of labels)expect(rows()[0].textContent).toContain(label)
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    await render({...track,id:'other',placemarks:[]});await render()
    expect(map.current!.placemarks![0].name).toBe('营地')
    expect(map.current!.placemarks![0].type).toEqual(expect.arrayContaining(labels))
    await act(async()=>button('编辑标注点 1').click())
    expect(typeCheckbox('风景点').checked).toBe(true)
    expect(typeCheckbox('休息点').checked).toBe(true)
    expect(button('移除标签 露营点')).toBeDefined()
    expect(button('移除标签 摄影点')).toBeDefined()
    await toggleType('风景点');await toggleType('休息点')
    await act(async()=>button('移除标签 露营点').click())
    await act(async()=>button('移除标签 摄影点').click())
    await saveDrawer()
    expect(map.current!.placemarks![0].type).toEqual([])
    expect(service.edits.get('kml')!.find(edit=>edit.id==='kml-1')!.type).toEqual([])
    expect(map.current!.placemarks![0].name).toBe('营地')
    await render({...track,id:'other',placemarks:[]});await render()
    await act(async()=>button('编辑标注点 1').click())
    expect(node.querySelectorAll('input[aria-label^="点位类型："]:checked')).toHaveLength(0)
    expect(button('移除标签 露营点')).toBeUndefined()
    expect(button('移除标签 摄影点')).toBeUndefined()
    expect(track.placemarks![0].name).toBe('牧场')
    expect(track.placemarks![0].type).toBeUndefined()
  })
  it.each(['风景点','旧标签'])('initializes the legacy string type %s without losing it when adding another label',async legacy=>{
    service.edits.set('kml',[{id:'kml-1',type:legacy}])
    await render()
    expect(map.current!.placemarks![0].type).toBe(legacy)
    await act(async()=>button('编辑标注点 1').click())
    if(legacy==='风景点')expect(typeCheckbox(legacy).checked).toBe(true)
    else expect(button(`移除标签 ${legacy}`)).toBeDefined()
    await toggleType('休息点')
    await saveDrawer()
    expect(map.current!.placemarks![0].type).toEqual(expect.arrayContaining([legacy,'休息点']))
    expect(map.current!.placemarks![0].type).toHaveLength(2)
    expect(service.edits.get('kml')!.find(edit=>edit.id==='kml-1')!.type).toEqual(expect.arrayContaining([legacy,'休息点']))
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(map.current!.placemarks![0].coordinates).toEqual(track.placemarks![0].coordinates)
    expect(map.current!.placemarks![0].images).toEqual(track.placemarks![0].images)
  })
  it('keeps hidden points in the list with the same numbering and supports restoring their map visibility',async()=>{
    await render()
    await act(async()=>button('隐藏标注点 1').click())
    expect(ids()).toEqual(['kml-1','kml-2'])
    expect(map.current!.placemarks![0].hidden).toBe(true)
    expect(rows()[0].closest('.trk-overview-row')!.classList.contains('trk-overview-row-hidden')).toBe(true)
    expect(rows()[0].textContent).toContain('已隐藏')
    expect(button('显示标注点 1').disabled).toBe(false)
    await render({...track,id:'other',placemarks:[]});await render()
    expect(map.current!.placemarks![0].hidden).toBe(true)
    await act(async()=>button('编辑标注点 1').click())
    await toggleType('补给点')
    await saveDrawer()
    expect(map.current!.placemarks![0].hidden).toBe(true)
    expect(map.current!.placemarks![0].type).toEqual(['补给点'])
    await act(async()=>button('显示标注点 1').click())
    expect(map.current!.placemarks![0].hidden).toBe(false)
    expect(map.current!.placemarks![0].type).toEqual(['补给点'])
    expect(rows()[0].closest('.trk-overview-row')!.classList.contains('trk-overview-row-hidden')).toBe(false)
    expect(rows().map(row=>row.querySelector('.trk-overview-number')!.textContent)).toEqual(['1','2'])
  })
  it('rolls back a visibility failure and disables independent controls while saving',async()=>{
    let finish!:()=>void
    service.wait=new Promise<void>(resolve=>{finish=resolve});service.failure='保存失败'
    await render()
    await act(async()=>button('隐藏标注点 1').click())
    expect(button('编辑标注点 1').disabled).toBe(true)
    expect(button('显示标注点 1').disabled).toBe(true)
    expect(map.current!.placemarks![0].hidden).toBe(true)
    await act(async()=>finish())
    expect(map.current!.placemarks![0].hidden).toBeUndefined()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('保存失败')
    expect(button('隐藏标注点 1').disabled).toBe(false)
  })
})
describe('placemark editor point ordering',()=>{
  it('keeps retry actions inside the editor and blocks changes until saved point data is read successfully',async()=>{
    const implementation=service.api.getMockImplementation()!
    service.api.mockImplementation(async()=>{throw new Error('接口不存在')})
    await render()
    expect(button('重试读取分组')).toBeDefined()
    expect(ids()).toEqual([])
    expect(rows().every(row=>!row.draggable)).toBe(true)
    expect(map.current!.placemarkEditingDisabled).toBe(true)
    expect(button('撤销').disabled).toBe(true)
    expect(button('重做').disabled).toBe(true)
    button('重试读取分组').focus()
    await shortcut()
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
    service.api.mockImplementation(implementation)
    await act(async()=>button('重试读取分组').click())
    expect(node.textContent).not.toContain('接口不存在')
    expect(button('重试读取排序')).toBeUndefined()
    expect(button('重试读取编辑')).toBeUndefined()
    expect(rows().every(row=>row.draggable)).toBe(true)
    expect(map.current!.placemarkEditingDisabled).toBe(false)
  })
  it('reports saving and editing to its parent and resets busy state on unmount',async()=>{
    const onBusyChange=vi.fn()
    let finish!:()=>void
    service.wait=new Promise<void>(resolve=>{finish=resolve})
    await render(track,onBusyChange)
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    await press(rows()[0],'ArrowDown')
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    await act(async()=>finish())
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    service.wait=new Promise<void>(resolve=>{finish=resolve})
    await act(async()=>map.current!.onMovePlacemark!('kml-1',[120.05,30.05]))
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    await act(async()=>root.render(null))
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    await act(async()=>finish())
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })
  it('starts in chronological order and keeps map, list and profile numbering together',async()=>{
    await render(orderedFixture())
    expect(ids()).toEqual(['early','late','untimed'])
    expect(node.textContent).toContain('时间排序')
    expect(button('恢复时间排序').disabled).toBe(true)
    expect(map.current!.placemarks!.map(point=>point.id)).toEqual(ids())
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(rows().map(row=>row.querySelector('.trk-overview-number')!.textContent)).toEqual(['1','2','3'])
  })
  it('moves with Alt + arrows using stable IDs without changing the selected point or its data',async()=>{
    const value=orderedFixture()
    await render(value)
    const late=rows()[1]
    await act(async()=>late.click())
    await press(late,'ArrowUp')
    expect(service.api).toHaveBeenCalledWith('placemark-state',expect.objectContaining({id:'kml',data:expect.objectContaining({order:['late','early','untimed']})}))
    expect(ids()).toEqual(['late','early','untimed'])
    expect(map.current!.selectedPlacemark).toBe('late')
    expect(profile.current!.selectedPlacemark).toBe('late')
    expect(map.current!.placemarks![0]).toEqual(value.placemarks[0])
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(rows()[0].getAttribute('aria-label')).toMatch(/^标注点 1，较晚/)
    expect(node.textContent).toContain('手动排序')
    await act(async()=>button('下移选中点位').click())
    expect(ids()).toEqual(['early','late','untimed'])
    expect(map.current!.selectedPlacemark).toBe('late')
  })
  it('reads a persisted manual order and restores chronological order explicitly',async()=>{
    service.orders.set('kml',['untimed','late','early'])
    await render(orderedFixture())
    expect(ids()).toEqual(['untimed','late','early'])
    await act(async()=>rows()[1].click())
    await act(async()=>button('恢复时间排序').click())
    expect(service.api).toHaveBeenCalledWith('placemark-state',expect.objectContaining({id:'kml',data:expect.objectContaining({order:null})}))
    expect(ids()).toEqual(['early','late','untimed'])
    expect(map.current!.selectedPlacemark).toBe('late')
    expect(button('恢复时间排序').disabled).toBe(true)
    await press(rows()[0],'ArrowDown')
    await render({...track,id:'other',placemarks:[]})
    await render(orderedFixture())
    expect(ids()).toEqual(['late','early','untimed'])
    expect(map.current!.selectedPlacemark).toBeNull()
  })
  it('shows an insertion line, scrolls during dragging, and suppresses its trailing click',async()=>{
    await render(orderedFixture())
    const data=transfer(),source=rows()[0],target=rows()[1]
    const list=node.querySelector<HTMLDivElement>('.trk-overview-list')!
    vi.spyOn(list,'getBoundingClientRect').mockReturnValue({top:0,bottom:100} as DOMRect)
    await drag(source,'dragstart',data)
    expect(data.getData('text/x-cqai-track-placemark-order')).toBe('early')
    await drag(target,'dragover',data,95)
    expect(target.classList.contains('trk-overview-insert-after')).toBe(true)
    expect(list.scrollTop).toBe(14)
    await drag(target,'drop',data,95)
    await drag(source,'dragend',data)
    expect(ids()).toEqual(['late','early','untimed'])
    expect(node.querySelector('.trk-overview-insert-after')).toBeNull()
    await act(async()=>rows()[0].click())
    expect(map.current!.selectedPlacemark).toBeNull()
    await act(async()=>rows()[0].dispatchEvent(new Event('pointerdown',{bubbles:true})))
    await act(async()=>rows()[0].click())
    expect(map.current!.selectedPlacemark).toBe('late')
    expect(node.querySelector('button button')).toBeNull()
  })
  it('disables all edits while saving and rolls back a failed reorder clearly',async()=>{
    let finish!:()=>void
    service.wait=new Promise<void>(resolve=>{finish=resolve});service.failure='磁盘写入失败'
    await render(orderedFixture())
    await act(async()=>rows()[1].click())
    await press(rows()[1],'ArrowUp')
    expect(ids()).toEqual(['late','early','untimed'])
    expect(node.textContent).toContain('正在保存…')
    expect(rows().every(row=>!row.draggable)).toBe(true)
    expect(button('下移选中点位').disabled).toBe(true)
    expect(map.current!.placemarkEditingDisabled).toBe(true)
    await press(rows()[0],'ArrowDown')
    expect(service.api.mock.calls.filter(([action,data])=>action==='placemark-state'&&data!==undefined)).toHaveLength(1)
    await act(async()=>finish())
    expect(ids()).toEqual(['early','late','untimed'])
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('已恢复原顺序：磁盘写入失败')
    expect(map.current!.selectedPlacemark).toBe('late')
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
  })
})

describe('placemark editor photo association and point movement',()=>{
  it('moves a photo with a captured pointer and cancels an interrupted gesture without saving',async()=>{
    await render()
    const thumbnail=rows()[0].querySelector<HTMLElement>('.trk-overview-thumbnail')!,target=rows()[1]
    const original=document.elementFromPoint
    document.elementFromPoint=vi.fn(()=>target)
    const pointer=async(type:string,x:number)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:1,button:0,clientX:x,clientY:80});await act(async()=>thumbnail.dispatchEvent(event))}
    try{
      await pointer('pointerdown',10);await pointer('pointermove',80)
      expect(target.classList.contains('trk-overview-photo-target')).toBe(true)
      expect(node.querySelector('.trk-overview-photo-ghost')).not.toBeNull()
      await pointer('pointercancel',80)
      expect(service.api.mock.calls.some(([action,data])=>action==='placemark-state'&&data!==undefined)).toBe(false)
      await pointer('pointerdown',10);await pointer('pointermove',80);await pointer('pointerup',80)
      expect(service.api.mock.calls.filter(([action,data])=>action==='placemark-state'&&data!==undefined)).toHaveLength(1)
      expect(map.current!.selectedPlacemark).toBe('kml-2')
      expect(node.querySelector('.trk-overview-photo-ghost')).toBeNull()
      expect(service.states.get(track.id)!.order).toBeNull()
    }finally{document.elementFromPoint=original}
  })
  it('moves a dragged thumbnail to a point without triggering ordering or changing metadata',async()=>{
    await render()
    const data=transfer(),source=rows()[0],target=rows()[1]
    const image=source.querySelector<HTMLImageElement>('img')!
    expect(image.draggable).toBe(false)
    expect(image.style.pointerEvents).toBe('none')
    await drag(image.parentElement!,'dragstart',data)
    expect(JSON.parse(data.getData('text/x-cqai-track-photo'))).toEqual({pointId:'kml-1',url:'https://example.com/one.jpg'})
    expect(data.getData('text/x-cqai-track-placemark-order')).toBe('')
    await drag(target,'dragover',data)
    expect(target.classList.contains('trk-overview-photo-target')).toBe(true)
    await drag(target,'drop',data)
    expect(service.states.get(track.id)!.order).toBeNull()
    expect(map.current!.selectedPlacemark).toBe('kml-2')
    expect(profile.current!.selectedPlacemark).toBe('kml-2')
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    const [first,second]=map.current!.placemarks!
    expect(first).toEqual({...track.placemarks![0],images:['https://example.com/two.jpg']})
    expect(second).toEqual({...track.placemarks![1],images:['https://example.com/one.jpg']})
    expect(ids()).toEqual(['kml-1','kml-2'])
  })
  it('offers every photo and a keyboard or touch alternative using target IDs',async()=>{
    await render()
    await act(async()=>rows()[0].click())
    const strip=node.querySelector('.trk-overview-photo-strip')!
    expect(strip.querySelectorAll('button')).toHaveLength(2)
    await act(async()=>button('选择第 2 张照片，可拖到其他点位').click())
    const select=node.querySelector<HTMLSelectElement>('[aria-label="照片移动到点位"]')!
    expect(select.disabled).toBe(false)
    expect(select.querySelector('option[value="kml-2"]')!.textContent).toBe('2 · 山口')
    await act(async()=>{select.value='kml-2';select.dispatchEvent(new Event('change',{bubbles:true}))})
    await act(async()=>button('移动照片').click())
    expect(map.current!.placemarks![0].images).toEqual(['https://example.com/one.jpg'])
    expect(map.current!.placemarks![1].images).toEqual(['https://example.com/two.jpg'])
    expect(map.current!.selectedPlacemark).toBe('kml-2')
    expect(service.api).toHaveBeenCalledWith('placemark-state',expect.objectContaining({id:'kml',data:expect.objectContaining({edits:[{id:'kml-1',images:['https://example.com/one.jpg']},{id:'kml-2',images:['https://example.com/two.jpg']}]})}))
  })
  it('keeps the original selection and images when a photo move cannot be saved',async()=>{
    service.failure='图片调整写入失败'
    await render()
    await act(async()=>rows()[0].click())
    const data=transfer()
    await drag(rows()[0].querySelector<HTMLElement>('.trk-overview-thumbnail')!,'dragstart',data)
    await drag(rows()[1],'drop',data)
    expect(map.current!.selectedPlacemark).toBe('kml-1')
    expect(map.current!.placemarks).toEqual(track.placemarks)
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('点位调整未保存，已恢复：图片调整写入失败')
  })
  it('rejects a forged photo drag that does not belong to the stated point',async()=>{
    await render()
    const data=transfer()
    data.setData('text/x-cqai-track-photo',JSON.stringify({pointId:'kml-1',url:'https://example.com/unknown.jpg'}))
    await drag(rows()[1],'drop',data)
    expect(service.api.mock.calls.some(([action,data])=>action==='placemark-state'&&data!==undefined)).toBe(false)
    expect(map.current!.placemarks).toEqual(track.placemarks)
  })
  it('shares moved marker coordinates with the list and profile while keeping point identity',async()=>{
    await render()
    await act(async()=>rows()[0].click())
    await act(async()=>map.current!.onMovePlacemark!('kml-1',[120.05,30.05]))
    expect(service.api.mock.calls.some(([action,data])=>action==='placemark-state'&&data!==undefined)).toBe(true)
    const point=map.current!.placemarks![0]
    expect(point.id).toBe('kml-1')
    expect(point.coordinates[0]).toBeCloseTo(120.05,4)
    expect(point.coordinates[1]).toBeCloseTo(30.05,4)
    expect(point.elevation).toBeCloseTo(510,2)
    expect(point.time).toBeNull();expect(point.timeSource).toBe('unknown');expect(point.routePosition).toBeDefined()
    expect(point.images).toEqual(track.placemarks![0].images)
    expect(map.current!.selectedPlacemark).toBe('kml-1')
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(rows()[0].textContent).toContain('海拔 510 m')
  })
})


describe('placemark creation and deletion transactions',()=>{
  const timed=()=>({...track,coordinates:[[120,30,500,1000],[120.1,30.1,520,3000]]} as TrackRecord)
  async function newAt(coordinates:[number,number]){
    await act(async()=>button('新增标注').click())
    expect(map.current!.onPickPlacemark).toBeDefined()
    await act(async()=>map.current!.onPickPlacemark!(coordinates))
  }
  it('creates only on save with computed location, keeps relocated information and restores one undo step',async()=>{
    await render(timed())
    await newAt([120.05,30.05])
    expect(writes()).toHaveLength(0);expect(ids()).toHaveLength(2)
    expect(node.querySelector('dialog')!.textContent).toContain('新增标注')
    await editInput('标注名','新增风景');await editInput('标注描述','沿途风景');await toggleType('风景点');await toggleType('打卡点')
    await act(async()=>button('返回地图重新定位').click())
    expect(node.querySelector('dialog')).toBeNull();expect(map.current!.onPickPlacemark).toBeDefined()
    await act(async()=>map.current!.onPickPlacemark!([120.075,30.075]))
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('新增风景')
    await saveDrawer()
    expect(writes()).toHaveLength(1)
    const added=service.states.get(track.id)!.added[0]
    expect(added.id).toMatch(/^local-/);expect(added.name).toBe('新增风景');expect(added.type).toEqual(['风景点','打卡点'])
    expect(added.coordinates[0]).toBeCloseTo(120.075,4);expect(added.elevation).toBeCloseTo(515,2);expect(added.time).toBeCloseTo(2500,0);expect(added.timeSource).toBe('track')
    expect(ids()).toHaveLength(3);expect(profile.current!.placemarks!.some(point=>point.id===added.id)).toBe(true)
    await act(async()=>button('撤销').click());expect(service.states.get(track.id)!.added).toEqual([]);expect(ids()).toHaveLength(2)
    await act(async()=>button('重做').click());expect(service.states.get(track.id)!.added[0]).toEqual(added)
  })
  it('cancels a blank creation without any saved or listed point',async()=>{
    await render(timed());await newAt([120.05,30.05])
    await act(async()=>button('取消').click())
    expect(node.querySelector('dialog')).toBeNull();expect(ids()).toHaveLength(2);expect(map.current!.onPickPlacemark).toBeUndefined();expect(writes()).toHaveLength(0)
  })
  it('shows estimated times from fixed original references and lets empty information be created',async()=>{
    const value={...track,placemarks:track.placemarks!.map((point,index)=>({...point,time:index?3000:1000}))}
    await render(value);await newAt([120.05,30.05])
    expect(node.querySelector('dialog')!.textContent).toContain('估算')
    await saveDrawer()
    const point=service.states.get(track.id)!.added[0]
    expect(point.name).toBe('');expect(point.timeSource).toBe('estimated');expect(point.time).toBeCloseTo(2000,0)
  })
  it('keeps one draft marker during a pending creation and retains it after a failed save',async()=>{
    await render(timed());await newAt([120.05,30.05]);await editInput('标注名','等待创建')
    const draftId=map.current!.placemarks!.find(point=>point.id.startsWith('local-'))!.id
    let finish!:()=>void;service.wait=new Promise<void>(resolve=>{finish=resolve});service.failure='创建写入失败'
    await saveDrawer()
    expect(map.current!.placemarks!.filter(point=>point.id===draftId)).toHaveLength(1)
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('等待创建')
    await act(async()=>finish());service.wait=null
    expect(map.current!.placemarks!.filter(point=>point.id===draftId)).toHaveLength(1)
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('等待创建')
    expect(ids()).toHaveLength(2);expect(node.textContent).toContain('创建写入失败')
    service.failure='';await saveDrawer()
    expect(service.states.get(track.id)!.added[0].id).toBe(draftId)
    expect(map.current!.placemarks!.filter(point=>point.id===draftId)).toHaveLength(1)
    await act(async()=>button('撤销').click());expect(ids()).toHaveLength(2);expect(button('撤销').disabled).toBe(true)
  })
  it('appends a new point after the manual order without changing existing order',async()=>{
    service.orders.set(track.id,['kml-2','kml-1']);await render(timed());await newAt([120.05,30.05]);await saveDrawer()
    const state=service.states.get(track.id)!
    expect(state.order).toEqual(['kml-2','kml-1',state.added[0].id]);expect(ids()).toEqual(state.order)
  })
  it('deletes expanded group children and a leaf atomically and undo restores cover, order and metadata',async()=>{
    const value=groupingFixture(),group=groupingRecords()[0],order=value.placemarks!.map(point=>point.id)
    service.groups.set(value.id,[group]);service.orders.set(value.id,order)
    await render(value);await act(async()=>button('展开标记点组 G1').click())
    await selectionToggle(pointRow(3));await selectionToggle(pointRow(2));await pointMenu(rowById('kml-3'))
    expect(button('打组（2）').disabled).toBe(true)
    await act(async()=>button('删除所选标注点（2）').click())
    expect(node.querySelector('dialog')!.textContent).toContain('观景台');expect(writes()).toHaveLength(0)
    await act(async()=>button('取消').click());expect(groupChecked()).toEqual([2,3]);expect(writes()).toHaveLength(0)
    await pointMenu(rowById('kml-3'));await act(async()=>button('删除所选标注点（2）').click());await act(async()=>button('确认删除').click())
    const state=service.states.get(value.id)!
    expect(writes()).toHaveLength(1);expect(state.deletedIds).toEqual(['kml-2','kml-3']);expect(state.order).toEqual(order.filter(id=>!['kml-2','kml-3'].includes(id)))
    expect(state.groups[0].memberIds).toEqual(['kml-1']);expect(state.groups[0].cover).toEqual({pointId:'kml-1',imageUrl:'https://example.com/one.jpg'});expect(state.groups[0].coordinates).toEqual(group.coordinates)
    expect(map.current!.placemarks!.some(point=>point.id==='kml-3')).toBe(false);expect(profile.current!.placemarks!.some(point=>point.id==='kml-3')).toBe(false)
    await act(async()=>button('撤销').click());expect(service.states.get(value.id)!.groups).toEqual([group]);expect(service.states.get(value.id)!.order).toEqual(order);expect(service.states.get(value.id)!.deletedIds).toEqual([])
  })
  it('retains the delete confirmation and drawer draft on failure then retries without leaking an undo step',async()=>{
    await render();await act(async()=>button('编辑标注点 1').click());await editInput('标注名','尚未保存的名称')
    await act(async()=>button('删除标注点').click())
    let finish!:()=>void;service.wait=new Promise<void>(resolve=>{finish=resolve});service.failure='磁盘不可写'
    const drawer=node.querySelector('dialog')!
    await act(async()=>button('确认删除').click())
    expect(map.current!.placemarks).toHaveLength(1)
    expect(node.querySelectorAll('dialog')).toHaveLength(2);expect(drawer.isConnected).toBe(true)
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('尚未保存的名称')
    expect(map.current!.selectedPlacemark).toBe('kml-1')
    await act(async()=>finish());service.wait=null
    expect(node.querySelectorAll('dialog')).toHaveLength(2);expect(node.textContent).toContain('磁盘不可写')
    expect(map.current!.placemarks).toHaveLength(2);expect(map.current!.selectedPlacemark).toBe('kml-1')
    service.failure='';await act(async()=>button('取消').click())
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('尚未保存的名称')
    await act(async()=>button('删除标注点').click());await act(async()=>button('确认删除').click())
    expect(node.querySelector('dialog')).toBeNull();expect(map.current!.placemarks).toHaveLength(1)
    await act(async()=>button('撤销').click());expect(map.current!.placemarks).toHaveLength(2);expect(map.current!.placemarks![0].name).toBe('牧场');expect(button('撤销').disabled).toBe(true)
  })
  it('retains an open drawer draft if a revision conflict refresh reveals an externally deleted point',async()=>{
    await render();await act(async()=>button('编辑标注点 1').click());await editInput('标注名','外部删除后保留的草稿')
    const drawer=node.querySelector('dialog')!,implementation=service.api.getMockImplementation()!
    service.api.mockImplementation(async(action:string,data?:{id:string;revision:number;data:PlacemarkStateData})=>{
      if(data){
        service.states.set(track.id,{version:1,revision:1,added:[],deletedIds:['kml-1'],edits:[],order:null,groups:[],routeContext:{segmentStarts:[0],references:track.placemarks!}})
        throw Object.assign(new Error('版本冲突'),{status:409})
      }
      return implementation(action,data)
    })
    await saveDrawer()
    expect(drawer.isConnected).toBe(true);expect(map.current!.placemarks).toHaveLength(1)
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('外部删除后保留的草稿')
    expect(drawer.textContent).toContain('此点已被其他操作删除');expect(button('保存点位').disabled).toBe(true)
    expect(button('删除标注点')).toBeUndefined()
    expect(writes()).toHaveLength(1)
    await act(async()=>button('取消').click());await act(async()=>button('放弃修改').click())
    expect(node.querySelector('dialog')).toBeNull();expect(map.current!.placemarks).toHaveLength(1);expect(writes()).toHaveLength(1)
  })
  it('asks which return pass to use and preserves the selected anchor in map and profile',async()=>{
    const value={...track,coordinates:[[120,30,500,1000],[120.1,30,520,3000],[120,30,500,5000]]} as TrackRecord
    await render(value);await newAt([120.05,30])
    expect(node.querySelector('dialog')!.textContent).toContain('选择经过位置')
    await act(async()=>button('选择第 2 次经过').click());await saveDrawer()
    const added=service.states.get(value.id)!.added[0]
    expect(added.routePosition!.startIndex).toBe(1);expect(added.time).toBeCloseTo(4000,0)
    expect(profile.current!.placemarks!.find(point=>point.id===added.id)!.routePosition).toEqual(added.routePosition)
  })
  it('keeps local uploads as an unsaved mixed-image draft, locks parent navigation, and restores saved associations',async()=>{
    const localUrl=placemarkPhotoUrl(track.id,'f'.repeat(64)+'.png'),onBusy=vi.fn()
    let uploaded!:(response:Response)=>void
    const fetchPhoto=vi.fn(()=>new Promise<Response>(resolve=>{uploaded=resolve}))
    vi.stubGlobal('fetch',fetchPhoto)
    await render(track,onBusy);await act(async()=>button('编辑标注点 1').click())
    await editInput('标注名','本地与链接混合')
    const file=new File(['local image bytes'],'本地风景.png',{type:'image/png'})
    const fileInput=node.querySelector<HTMLInputElement>('[aria-label="添加本地图片"]')!
    Object.defineProperty(fileInput,'files',{configurable:true,value:[file]})
    await act(async()=>fileInput.dispatchEvent(new Event('change',{bubbles:true})))
    expect(onBusy).toHaveBeenLastCalledWith(true);expect(writes()).toHaveLength(0)
    expect(button('关闭点位编辑').disabled).toBe(true);expect(node.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled).toBe(true)
    expect(fetchPhoto).toHaveBeenCalledWith('/api/cqai-track/placemark-photos?id=kml',expect.objectContaining({method:'POST',body:file}))
    await act(async()=>uploaded(new Response(JSON.stringify({url:localUrl}),{status:201,headers:{'content-type':'application/json'}})))
    expect(onBusy).toHaveBeenLastCalledWith(false);expect(writes()).toHaveLength(0)
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('本地与链接混合')
    expect(node.textContent).toContain('本地图片');expect(node.querySelector('[aria-label="第 3 张图片链接"]')).toBeNull()
    await saveDrawer()
    const expected=[...track.placemarks![0].images,localUrl]
    expect(map.current!.placemarks![0].images).toEqual(expected);expect(writes()).toHaveLength(1)
    await act(async()=>button('撤销').click());expect(map.current!.placemarks![0].images).toEqual(track.placemarks![0].images)
    await act(async()=>button('重做').click());expect(map.current!.placemarks![0].images).toEqual(expected)
    await act(async()=>root.render(null));await render()
    expect(map.current!.placemarks![0].images).toEqual(expected);expect(map.current!.placemarks![0].name).toBe('本地与链接混合')
  })
  it('attaches a local photo to a newly located point only when creation is saved',async()=>{
    const localUrl=placemarkPhotoUrl(track.id,'e'.repeat(64)+'.jpg')
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({url:localUrl}),{status:201,headers:{'content-type':'application/json'}})))
    await render(timed());await newAt([120.05,30.05])
    const fileInput=node.querySelector<HTMLInputElement>('[aria-label="添加本地图片"]')!
    Object.defineProperty(fileInput,'files',{configurable:true,value:[new File(['jpg bytes'],'照片.jpg',{type:'image/jpeg'})]})
    await act(async()=>fileInput.dispatchEvent(new Event('change',{bubbles:true})))
    expect(writes()).toHaveLength(0);expect(ids()).toHaveLength(2)
    await saveDrawer()
    const added=service.states.get(track.id)!.added[0]
    expect(added.id.startsWith('local-')).toBe(true);expect(added.images).toEqual([localUrl]);expect(added.timeSource).toBe('track')
    await act(async()=>button('撤销').click());expect(ids()).toHaveLength(2)
    await act(async()=>button('重做').click());expect(map.current!.placemarks!.find(point=>point.id===added.id)!.images).toEqual([localUrl])
  })
  it('allows deleting every point and keeps the route and statistics unchanged after re-entering',async()=>{
    await render();await selectionToggle(pointRow(1));await selectionToggle(pointRow(2));await pointMenu(rows()[0]);await act(async()=>button('删除所选标注点（2）').click());await act(async()=>button('确认删除').click())
    expect(map.current!.placemarks).toEqual([]);expect(map.current!.points).toEqual(track.coordinates);expect(node.textContent).toContain('没有标注点')
    await act(async()=>root.render(null));await render();expect(map.current!.placemarks).toEqual([]);expect(profile.current!.placemarks).toEqual([])
  })
})


describe('merging existing placemark groups',()=>{
  function selectedGroups(){return Array.from(node.querySelectorAll<HTMLButtonElement>('.trk-overview-row-checked [data-placemark-kind="group"]')).map(row=>row.dataset.placemarkId)}
  it('merges Ctrl/Cmd selected groups in list order, persists once and supports undo/redo',async()=>{
    const value=groupingFixture(),groups=groupingRecords(),original=structuredClone(value.placemarks),order=value.placemarks!.map(point=>point.id)
    service.groups.set(value.id,groups);service.orders.set(value.id,order);await render(value)
    await selectionToggle(rowById(groups[1].id))
    await act(async()=>rowById(groups[0].id).dispatchEvent(new MouseEvent('click',{metaKey:true,bubbles:true,cancelable:true})))
    expect(selectedGroups()).toEqual(groups.map(group=>group.id));expect(button('合并分组').disabled).toBe(false)
    await pointMenu(rowById(groups[1].id))
    expect(selectedGroups()).toEqual(groups.map(group=>group.id));expect(document.activeElement).toBe(button('合并分组（2）'))
    expect(button('删除所选标注点（2）')).toBeUndefined()
    await act(async()=>button('合并分组（2）').click())
    const merged=service.groups.get(value.id)![0]
    expect(service.groups.get(value.id)).toHaveLength(1);expect(merged.id).toBe(groups[0].id);expect(merged.name).toBe(groups[0].name)
    expect(merged.description).toBe('两处风景\n\n休息和终点');expect(merged.memberIds).toEqual(['kml-1','kml-3','kml-4','kml-6'])
    expect(merged.coordinates).toEqual(value.placemarks![3].coordinates);expect(merged.cover).toEqual(groups[0].cover)
    expect(map.current!.placemarks).toEqual(original);expect(service.states.get(value.id)!.order).toEqual(order)
    expect(writes()).toHaveLength(1);expect(selectedGroups()).toEqual([]);expect(document.activeElement).toBe(rowById(merged.id))
    await act(async()=>button('撤销').click());expect(service.groups.get(value.id)).toEqual(groups)
    await act(async()=>button('重做').click());expect(service.groups.get(value.id)).toEqual([merged])
  })
  it('uses Shift and keyboard group selection, leaves unrelated groups intact, and keeps expanded children',async()=>{
    const value=groupingFixture(),groups=groupingRecords(),third={...groups[1],id:'group-00000000-0000-4000-8000-000000000003',name:'补给组',description:'补给',memberIds:['kml-2','kml-5'],cover:undefined}
    service.groups.set(value.id,[...groups,third]);await render(value)
    await selectionToggle(rowById(groups[0].id))
    await shortcut(rowById(groups[1].id),{key:' ',shiftKey:true})
    expect(selectedGroups()).toEqual([groups[0].id,third.id,groups[1].id])
    await shortcut(rowById(third.id),{key:'Enter',ctrlKey:true})
    expect(selectedGroups()).toEqual(groups.map(group=>group.id))
    await act(async()=>button('展开标记点组 G1').click())
    expect(map.current!.expandedPlacemarkGroups?.has(groups[0].id)).toBe(true)
    await act(async()=>button('合并分组').click())
    expect(service.groups.get(value.id)).toHaveLength(2);expect(service.groups.get(value.id)![1]).toEqual(third)
    expect(map.current!.expandedPlacemarkGroups?.has(groups[0].id)).toBe(true)
    expect(map.current!.expandedPlacemarkGroups?.has(groups[1].id)).toBe(false)
    expect(ids()).toContain('kml-6')
  })
  it('locks merge for mixed group/point selection and during map gestures',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups);await render(value)
    await selectionToggle(rowById(groups[0].id));await selectionToggle(rowById(groups[1].id));await selectionToggle(rowById('kml-2'))
    expect(button('合并分组').disabled).toBe(true)
    await pointMenu(rowById(groups[0].id));expect(button('合并分组（2）').disabled).toBe(true)
    await shortcut(document,{key:'Escape'});await selectionToggle(rowById('kml-2'))
    await act(async()=>map.current!.onPlacemarkDragChange!(true));expect(button('合并分组').disabled).toBe(true)
    await selectionToggle(rowById(groups[0].id));expect(selectedGroups()).toEqual(groups.map(group=>group.id))
    await act(async()=>map.current!.onPlacemarkDragChange!(false));expect(button('合并分组').disabled).toBe(false)
    expect(writes()).toHaveLength(0)
  })
  it('rolls back failed saving and retains group selection for retry',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups);await render(value)
    await selectionToggle(rowById(groups[0].id));await selectionToggle(rowById(groups[1].id));service.failure='合并保存失败'
    await act(async()=>button('合并分组').click())
    expect(map.current!.placemarkGroups).toEqual(groups);expect(service.groups.get(value.id)).toEqual(groups)
    expect(selectedGroups()).toEqual(groups.map(group=>group.id));expect(node.textContent).toContain('合并保存失败')
    service.failure='';await act(async()=>button('合并分组').click());expect(service.groups.get(value.id)).toHaveLength(1)
  })
  it('rejects oversized combined descriptions without saving or losing text',async()=>{
    const value=groupingFixture(),groups=groupingRecords().map(group=>({...group,description:'长'.repeat(6000)}))
    service.groups.set(value.id,groups);await render(value)
    await selectionToggle(rowById(groups[0].id));await selectionToggle(rowById(groups[1].id));await act(async()=>button('合并分组').click())
    expect(writes()).toHaveLength(0);expect(node.querySelector('[role="alert"]')!.textContent).toContain('10000')
    expect(service.groups.get(value.id)).toEqual(groups);expect(selectedGroups()).toEqual(groups.map(group=>group.id))
  })
  it('clicking a group row toggles child expansion in both the list and map without saving',async()=>{
    const value=groupingFixture(),groups=groupingRecords();service.groups.set(value.id,groups);await render(value)
    expect(map.current!.expandedPlacemarkGroups?.size).toBe(0)
    await selectionClick(rowById(groups[0].id));expect(ids()).toContain('kml-1');expect(map.current!.expandedPlacemarkGroups?.has(groups[0].id)).toBe(true)
    await selectionClick(rowById(groups[0].id));expect(ids()).not.toContain('kml-1');expect(map.current!.expandedPlacemarkGroups?.has(groups[0].id)).toBe(false)
    expect(writes()).toHaveLength(0)
  })
})
