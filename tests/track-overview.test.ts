// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
import { TrackOverview, TrackPlacemarkEditor } from '../src/client/TrackOverview.tsx'
import { MAP_SETTINGS_KEY, readMapSettings, writeMapSettings } from '../src/track/map-settings.ts'

import type { MapView } from '../src/client/MapView.tsx'
import type { ElevationChart } from '../src/client/ElevationChart.tsx'
import type { PlacemarkGroup, TrackRecord } from '../src/protocol.ts'
import { formatPlacemarkTime } from '../src/track/placemark-format.ts'
import type { PlacemarkEdit } from '../src/track/placemark-edits.ts'
const map=vi.hoisted(()=>({current:null as Parameters<typeof MapView>[0]|null}))
const profile=vi.hoisted(()=>({current:null as Parameters<typeof ElevationChart>[0]|null}))
const service=vi.hoisted(()=>({api:vi.fn(),orders:new Map<string,string[]|null>(),edits:new Map<string,PlacemarkEdit[]>(),groups:new Map<string,PlacemarkGroup[]>(),failure:'',wait:null as Promise<void>|null}))
vi.mock('../src/client/MapView.tsx',()=>({MapView:(props:Parameters<typeof MapView>[0])=>{map.current=props;return createElement('div',{'data-map':true})}}))
vi.mock('../src/client/ElevationChart.tsx',()=>({ElevationChart:(props:Parameters<typeof ElevationChart>[0])=>{profile.current=props;return createElement('div',{'data-profile':true})}}))
vi.mock('../src/client/util.ts',async importOriginal=>({...await importOriginal<typeof import('../src/client/util.ts')>(),api:service.api}))
const track={id:'kml',format:'kml',name:'路线',metrics:{elevationMax:520},segmentStarts:[0],coordinates:[[120,30,500,null],[120.1,30.1,520,null]],placemarks:[{id:'kml-1',name:'牧场',coordinates:[120,30],elevation:501.59,time:Date.parse('2026-05-29T06:48:22Z'),description:'草地',images:['https://example.com/one.jpg','https://example.com/two.jpg']},{id:'kml-2',name:'山口',coordinates:[120.1,30.1],elevation:null,time:null,description:'',images:[]}]} as TrackRecord
let root:Root,node:HTMLDivElement,currentFixture=track
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  localStorage.clear();service.orders.clear();service.edits.clear();service.groups.clear();service.failure='';service.wait=null;service.api.mockReset()
  service.api.mockImplementation(async(action:string,data?:unknown)=>{
    if(data!==undefined)throw new Error('Read-only overview must not save')
    const id=new URLSearchParams(action.split('?')[1]).get('id')!
    return {state:{version:1,revision:0,added:[],deletedIds:[],order:service.orders.get(id)||null,edits:service.edits.get(id)||[],groups:service.groups.get(id)||[],routeContext:{segmentStarts:[0],references:currentFixture.placemarks||[]}}}
  })
  node=document.createElement('div');document.body.append(node);root=createRoot(node)
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
async function render(value=track){currentFixture=value;await act(async()=>root.render(createElement(TrackOverview,{track:value,basemap:'none',onBasemap:vi.fn()})))}
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
function orderedFixture(){return {...track,placemarks:[
  {...track.placemarks![0],id:'late',name:'较晚',time:2000},
  {...track.placemarks![1],id:'untimed',name:'无时间'},
  {...track.placemarks![0],id:'early',name:'较早',time:1000,images:['https://example.com/early.jpg']}
]}}
describe('overview point list and map selection',()=>{
  it('shares point data and selection between the elevation profile, map and list',async()=>{
    await render()
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    await act(async()=>profile.current!.onSelectPlacemark!('kml-1'))
    expect(map.current!.selectedPlacemark).toBe('kml-1')
    expect(node.querySelector('[data-placemark-id="kml-1"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async()=>map.current!.onSelectPlacemark!('kml-2'))
    expect(profile.current!.selectedPlacemark).toBe('kml-2')
    await act(async()=>map.current!.onClosePlacemark!())
    expect(profile.current!.selectedPlacemark).toBeNull()
  })
  it('keeps the missing elevation notice without replacing it with waypoint elevations',async()=>{
    await render({...track,metrics:{...track.metrics,elevationMax:null}})
    expect(node.querySelector('[data-profile]')).toBeNull()
    expect(node.textContent).toContain('这条轨迹没有海拔数据，没有剖面可画。')
    expect(node.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
  })
  it('shows all KML points beside the map and shares selection in both directions',async()=>{
    await render();expect(node.querySelectorAll('[data-placemark-id]')).toHaveLength(2)
    await act(async()=>node.querySelector<HTMLButtonElement>('[data-placemark-id="kml-1"]')!.click())
    expect(map.current!.selectedPlacemark).toBe('kml-1')
    await act(async()=>map.current!.onSelectPlacemark!('kml-2'))
    expect(node.querySelector('[data-placemark-id="kml-2"]')?.getAttribute('aria-pressed')).toBe('true')
  })
  it('opens selection from the map and clears it when point details are closed',async()=>{
    await render();expect(node.querySelectorAll('img')).toHaveLength(1)
    await act(async()=>map.current!.onSelectPlacemark!('kml-1'))
    expect(node.querySelector('[data-placemark-id="kml-1"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async()=>map.current!.onClosePlacemark!())
    expect(map.current!.selectedPlacemark).toBeNull()
    expect(node.querySelector('[data-placemark-id="kml-1"]')?.getAttribute('aria-pressed')).toBe('false')
  })
  it('keeps the map available for a track with no annotations',async()=>{
    await render({...track,placemarks:[]});expect(node.textContent).toContain('这条轨迹没有标注点');expect(node.querySelector('[data-map]')).not.toBeNull()
  })
  it('shows a lazy thumbnail, altitude and point timestamp in the list',async()=>{
    await render()
    const row=node.querySelector('[data-placemark-id="kml-1"]')!
    const image=row.querySelector('img')!
    expect(image.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl(track.id,'https://example.com/one.jpg'))
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(row.textContent).toContain('海拔 502 m')
    expect(row.textContent).toContain(formatPlacemarkTime(track.placemarks![0].time))
    expect(row.textContent).toContain('2 张')
    const empty=node.querySelector('[data-placemark-id="kml-2"]')!
    expect(empty.textContent).not.toContain('海拔')
    expect(empty.querySelector('.trk-overview-time')).toBeNull()
  })
  it('keeps an unnamed photo point selectable without inventing a caption',async()=>{
    const point={...track.placemarks![0],name:'',description:''}
    await render({...track,placemarks:[point]})
    const row=node.querySelector<HTMLButtonElement>('[data-placemark-id="kml-1"]')!
    expect(row.querySelector('strong')).toBeNull()
    expect(row.textContent).not.toMatch(/标注点|暂无说明/)
    expect(row.querySelector('img')).not.toBeNull()
    await act(async()=>row.click())
    expect(map.current!.selectedPlacemark).toBe('kml-1')
  })
  it('keeps thumbnail failure isolated and still opens the point',async()=>{
    await render()
    const row=node.querySelector<HTMLButtonElement>('[data-placemark-id="kml-1"]')!
    await act(async()=>row.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(row.textContent).toContain('图片未加载')
    expect(row.textContent).toContain('海拔 502 m')
    await act(async()=>row.click())
    expect(map.current!.selectedPlacemark).toBe('kml-1')
  })
  it('shows selected point types as separate normalized badges with legacy string compatibility',async()=>{
    await render({...track,placemarks:[
      {...track.placemarks![0],type:[' 风景 ','补给点','风景',' ', '<img src=x onerror=alert(1)>']},
      {...track.placemarks![1],type:'  打卡点  '},
    ]})
    const first=rows()[0],second=rows()[1]
    expect([...first.querySelectorAll('.trk-overview-point-type')].map(badge=>badge.textContent))
      .toEqual(['风景','补给点','<img src=x onerror=alert(1)>'])
    expect([...second.querySelectorAll('.trk-overview-point-type')].map(badge=>badge.textContent)).toEqual(['打卡点'])
    expect(first.querySelector('[onerror]')).toBeNull()
    expect(first.querySelectorAll('img')).toHaveLength(1)
    expect(first.getAttribute('aria-label')).toContain('风景，补给点')
    expect(map.current!.onMovePlacemark).toBeUndefined()
    await act(async()=>first.click())
    expect(map.current!.selectedPlacemark).toBe('kml-1')
  })
  it('keeps an unnamed typed point untitled and omits cleared type labels',async()=>{
    await render({...track,placemarks:[
      {...track.placemarks![0],name:'',type:['营地','水源']},
      {...track.placemarks![1],type:[]},
    ]})
    expect(rows()[0].querySelector('strong')).toBeNull()
    expect([...rows()[0].querySelectorAll('.trk-overview-point-type')].map(badge=>badge.textContent)).toEqual(['营地','水源'])
    expect(rows()[1].querySelector('.trk-overview-point-types, .trk-overview-point-type')).toBeNull()
  })
})

describe('read-only overview with saved placemark changes',()=>{
  it('locks annotation display and provides a read retry when unified state is unavailable',async()=>{
    service.api.mockImplementation(async()=>{throw new Error('接口不存在')})
    await render(orderedFixture())
    expect(ids()).toEqual([]);expect(map.current!.placemarks).toEqual([]);expect(profile.current!.placemarks).toEqual([])
    expect(button('重试读取分组')).toBeDefined()
    expect(node.querySelector('[draggable="true"]')).toBeNull()
    expect(node.querySelector('.trk-group-selection,.trk-overview-row-actions,.trk-placemark-history')).toBeNull()
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
  })

  it('displays the saved order, position and photos with the same numbering in all three views',async()=>{
    service.orders.set('kml',['kml-2','kml-1'])
    service.edits.set('kml',[{id:'kml-1',coordinates:[120.05,30.05],elevation:510,images:['https://example.com/moved.jpg']}])
    await render()
    expect(ids()).toEqual(['kml-2','kml-1'])
    expect(rows().map(row=>row.querySelector('.trk-overview-number')!.textContent)).toEqual(['1','2'])
    expect(map.current!.placemarks!.map(point=>point.id)).toEqual(ids())
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(map.current!.placemarks![1]).toEqual({...track.placemarks![0],coordinates:[120.05,30.05],elevation:510,images:['https://example.com/moved.jpg']})
    expect(rows()[1].textContent).toContain('海拔 510 m')
    expect(rows()[1].querySelector('img')!.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl(track.id,'https://example.com/moved.jpg'))
    await act(async()=>rows()[1].click())
    expect(map.current!.selectedPlacemark).toBe('kml-1')
    expect(profile.current!.selectedPlacemark).toBe('kml-1')
  })
  it('has no edit controls, draggable rows or images, or map movement callback',async()=>{
    await render()
    await act(async()=>rows()[0].click())
    expect(node.querySelector('.trk-overview-order')).toBeNull()
    expect(node.querySelector('.trk-overview-order-controls')).toBeNull()
    expect(node.querySelector('.trk-overview-drag-handle')).toBeNull()
    expect(node.querySelector('.trk-overview-photo-editor')).toBeNull()
    expect(node.querySelector('[draggable="true"]')).toBeNull()
    expect(map.current!.onMovePlacemark).toBeUndefined()
    expect(map.current!.placemarkEditingDisabled).toBeUndefined()
    const data=transfer()
    data.setData('text/x-cqai-track-photo',JSON.stringify({pointId:'kml-1',url:'https://example.com/one.jpg'}))
    await press(rows()[0],'ArrowDown')
    await drag(rows()[0],'dragstart',data)
    await drag(rows()[1],'drop',data)
    expect(ids()).toEqual(['kml-1','kml-2'])
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
  })
  it('shows chronological order when no saved manual order exists',async()=>{
    await render(orderedFixture())
    expect(ids()).toEqual(['early','late','untimed'])
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(node.querySelector('.trk-overview-order')).toBeNull()
  })
})

describe('read-only overview of persisted groups',()=>{
  it('shows a collapsed persisted group and exact child selection without exposing any processing controls',async()=>{
    const group:PlacemarkGroup={id:'group-00000000-0000-4000-8000-000000000001',name:'同一段风景',description:'保存过的分组',memberIds:['kml-1','kml-2'],coordinates:[120.05,30.05],cover:{pointId:'kml-1',imageUrl:'https://example.com/two.jpg'}}
    service.groups.set(track.id,[group]);await render()
    expect(ids()).toEqual([group.id])
    expect(rows()[0].getAttribute('aria-label')).toBe('标记点组 G1：同一段风景')
    expect(map.current!.placemarkGroups).toEqual([group])
    expect(map.current!.expandedPlacemarkGroups?.size).toBe(0)
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    await act(async()=>rows()[0].click())
    expect(map.current!.selectedPlacemark).toBe(group.id)
    expect(profile.current!.selectedPlacemark).toBe('kml-1')
    await act(async()=>map.current!.onSelectPlacemark!('kml-2'))
    expect(button('收起标记点组 G1').getAttribute('aria-expanded')).toBe('true')
    expect(ids()).toEqual([group.id,'kml-1','kml-2'])
    expect(rows()[2].getAttribute('aria-label')).toMatch(/^标注点 2，/)
    expect(rows()[2].getAttribute('aria-pressed')).toBe('true')
    expect(profile.current!.selectedPlacemark).toBe('kml-2')
    expect(map.current!.expandedPlacemarkGroups?.has(group.id)).toBe(true)
    await act(async()=>button('收起标记点组 G1').click())
    expect(map.current!.expandedPlacemarkGroups?.has(group.id)).toBe(false)
    expect(ids()).toEqual([group.id])
    expect(node.querySelector('.trk-group-selection,.trk-overview-row-actions,.trk-overview-drag-handle,.trk-placemark-history')).toBeNull()
    expect(node.querySelector('[draggable="true"]')).toBeNull()
    expect(map.current!.onMovePlacemark).toBeUndefined();expect(map.current!.onEditPlacemark).toBeUndefined()
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
  })
  it('hides incomplete group data during loading, reports a group read error and retries from the same stored result',async()=>{
    const implementation=service.api.getMockImplementation()!
    let finish!:(value:unknown)=>void
    service.api.mockImplementation((action:string,data?:unknown)=>action.startsWith('placemark-state')?new Promise(resolve=>{finish=resolve}):implementation(action,data))
    await render()
    expect(ids()).toEqual([]);expect(map.current!.placemarks).toEqual([]);expect(map.current!.placemarkGroups).toEqual([])
    expect(node.textContent).toContain('正在读取分组')
    await act(async()=>finish({state:{version:1,revision:0,added:[],deletedIds:[],edits:[],order:null,groups:[],routeContext:{segmentStarts:[0],references:track.placemarks}}}));expect(ids()).toEqual(['kml-1','kml-2'])
    await act(async()=>root.render(null))
    service.api.mockImplementation(async(action:string,data?:unknown)=>{if(action.startsWith('placemark-state'))throw new Error('分组读取失败');return implementation(action,data)})
    await render()
    expect(ids()).toEqual([]);expect(map.current!.placemarks).toEqual([])
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('分组读取失败')
    expect(button('重试读取分组')).toBeDefined()
    service.api.mockImplementation(implementation);await act(async()=>button('重试读取分组').click())
    expect(ids()).toEqual(['kml-1','kml-2']);expect(button('重试读取分组')).toBeUndefined()
    expect(service.api.mock.calls.every(([,data])=>data===undefined)).toBe(true)
  })
})


async function changeTypeFilter(value: NonNullable<Parameters<typeof MapView>[0]['placemarkTypeFilter']>) {
  const callback = map.current?.onPlacemarkTypeFilterChange
  if (!callback) throw new Error('Missing map type filter callback')
  await act(async () => callback(value))
}
function typedFixture(): TrackRecord {
  return {...track, placemarks: [
    {...track.placemarks![0], type: ['风景', '水源']},
    {...track.placemarks![1], type: '水源', images: ['https://example.com/water.jpg']},
    {...track.placemarks![1], id: 'kml-3', name: '无类型', type: [], images: []},
  ]}
}

describe('overview route color and type controls', () => {
  it('filters multiple labels and unclassified points, preserves numbering and map arrays, and clears old selection', async () => {
    await render(typedFixture())
    const original = map.current!.placemarks
    await act(async () => rows()[1].click())
    expect(map.current!.selectedPlacemark).toBe('kml-2')
    await changeTypeFilter('type:风景')
    expect(ids()).toEqual(['kml-1'])
    expect(map.current!.placemarks).toBe(original)
    expect(map.current!.placemarkTypeFilter).toBe('type:风景')
    expect(map.current!.selectedPlacemark).toBeNull()
    expect(profile.current!.placemarks).toBe(original)
    expect(profile.current!.placemarkTypeFilter).toBe('type:风景')
    expect(node.querySelector('.trk-overview-points h3')?.textContent).toContain('1 / 3')
    await changeTypeFilter('type:水源')
    expect(ids()).toEqual(['kml-1', 'kml-2'])
    await changeTypeFilter('untyped')
    expect(ids()).toEqual(['kml-3'])
    expect(rows()[0].querySelector('.trk-overview-number')?.textContent).toBe('3')
    await changeTypeFilter(['type:风景', 'untyped'])
    expect(ids()).toEqual(['kml-1', 'kml-3'])
    expect(rows().map(row => row.querySelector('.trk-overview-number')?.textContent)).toEqual(['1', '3'])
    expect(map.current!.placemarkTypeFilter).toEqual(['type:风景', 'untyped'])
    expect(profile.current!.placemarkTypeFilter).toEqual(['type:风景', 'untyped'])
    await changeTypeFilter(['type:风景', 'type:水源'])
    expect(ids()).toEqual(['kml-1', 'kml-2'])
    expect(node.querySelector('.trk-overview-points h3')?.textContent).toContain('2 / 3')
    await act(async () => profile.current!.onSelectPlacemark!('kml-2'))
    await changeTypeFilter([])
    expect(ids()).toEqual([])
    expect(map.current!.placemarkTypeFilter).toEqual([])
    expect(profile.current!.placemarkTypeFilter).toEqual([])
    expect(map.current!.selectedPlacemark).toBeNull()
    expect(profile.current!.selectedPlacemark).toBeNull()
    expect(map.current!.placemarks).toBe(original)
    expect(profile.current!.placemarks).toBe(original)
    expect(node.querySelector('.trk-overview-points h3')?.textContent).toContain('0 / 3')
    await changeTypeFilter('all')
    expect(ids()).toEqual(['kml-1', 'kml-2', 'kml-3'])
    expect(profile.current!.placemarks).toBe(map.current!.placemarks)
    expect(service.api.mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })

  it('uses matching group members for covers, badges and counts while keeping original groups and child numbers', async () => {
    const group: PlacemarkGroup = {id: 'group-00000000-0000-4000-8000-000000000001', name: '分组', description: '', memberIds: ['kml-1', 'kml-2'], coordinates: [120, 30], cover: {pointId: 'kml-1', imageUrl: 'https://example.com/one.jpg'}}
    service.groups.set(track.id, [group])
    const fixture = typedFixture()
    fixture.placemarks![1].type = '营地'
    await render(fixture)
    const originalGroups = map.current!.placemarkGroups
    await changeTypeFilter('type:营地')
    expect(ids()).toEqual([group.id])
    expect(rows()[0].textContent).toContain('1 个子点')
    expect(rows()[0].querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl(track.id,'https://example.com/water.jpg'))
    expect([...rows()[0].querySelectorAll('.trk-overview-point-type')].map(badge => badge.textContent)).toEqual(['营地'])
    expect(map.current!.placemarkGroups).toBe(originalGroups)
    expect(originalGroups).toEqual([group])
    await act(async () => rows()[0].click())
    expect(profile.current!.selectedPlacemark).toBe('kml-2')
    expect(button('收起标记点组 G1').getAttribute('aria-expanded')).toBe('true')
    expect(ids()).toEqual([group.id, 'kml-2'])
    expect(rows()[1].querySelector('.trk-overview-number')?.textContent).toBe('2')
    await changeTypeFilter(['type:风景', 'type:营地'])
    expect(ids()).toEqual([group.id, 'kml-1', 'kml-2'])
    expect(rows()[0].textContent).toContain('2 个子点')
    expect(rows().slice(1).map(row => row.querySelector('.trk-overview-number')?.textContent)).toEqual(['1', '2'])
    expect(map.current!.placemarkGroups).toBe(originalGroups)
  })

  it('resets filters for another track and falls back to all when an edited type disappears', async () => {
    await render(typedFixture())
    await changeTypeFilter('type:风景')
    await act(async () => rows()[0].click())
    await render({...typedFixture(), id: 'next'})
    expect(map.current!.placemarkTypeFilter).toBe('all')
    expect(map.current!.selectedPlacemark).toBeNull()
    await changeTypeFilter('type:风景')
    await act(async () => profile.current!.onSelectPlacemark!('kml-1'))
    const withoutType = {...typedFixture(), id: 'next', placemarks: typedFixture().placemarks!.map(point => ({...point, type: []}))}
    await render(withoutType)
    expect(map.current!.placemarkTypeFilter).toBe('all')
    expect(map.current!.selectedPlacemark).toBeNull()
    expect(ids()).toEqual(['kml-1', 'kml-2', 'kml-3'])
    await render({...typedFixture(), id: 'next'})
    await changeTypeFilter(['type:风景', 'untyped'])
    await render(withoutType)
    expect(map.current!.placemarkTypeFilter).toEqual(['untyped'])
    expect(profile.current!.placemarkTypeFilter).toEqual(['untyped'])
    expect(ids()).toEqual(['kml-1', 'kml-2', 'kml-3'])
    await render({...typedFixture(), id: 'next', placemarks: typedFixture().placemarks!.map(point => ({...point, type: '水源'}))})
    expect(map.current!.placemarkTypeFilter).toEqual([])
    expect(profile.current!.placemarkTypeFilter).toEqual([])
    expect(ids()).toEqual([])
  })

  it('restricts Shift selection to displayed points and locks controls during map gestures', async () => {
    currentFixture = typedFixture()
    currentFixture.placemarks![1].type = '营地'
    currentFixture.placemarks![2].type = '水源'
    await act(async () => root.render(createElement(TrackPlacemarkEditor, {track: currentFixture, basemap: 'none', onBasemap: vi.fn()})))
    await changeTypeFilter('type:水源')
    expect(ids()).toEqual(['kml-1', 'kml-3'])
    await act(async () => rows()[0].click())
    await act(async () => rows()[1].dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true})))
    expect(node.textContent).toContain('已选择 2 个点')
    expect(node.querySelectorAll('.trk-overview-row-checked')).toHaveLength(2)
    await act(async () => map.current!.onPlacemarkDragChange!(true))
    expect(map.current!.placemarkDisplayControlsDisabled).toBe(true)
    await act(async () => map.current!.onPlacemarkDragChange!(false))
    expect(map.current!.placemarkDisplayControlsDisabled).toBe(false)
    expect(service.api.mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })

  it('delegates display controls to the map while keeping the point sidebar focused on its list', async () => {
    await render(typedFixture())
    const sidebar = node.querySelector('.trk-overview-points')!
    expect(sidebar.querySelector('[aria-label="路线颜色"]')).toBeNull()
    expect(sidebar.querySelector('[aria-label="标记点类型"]')).toBeNull()
    expect(sidebar.querySelector('.trk-overview-display-controls')).toBeNull()
    expect(map.current!.onPlacemarkTypeFilterChange).toEqual(expect.any(Function))
    expect(map.current!.placemarkTypeFilter).toBe('all')
    expect(map.current!.placemarkDisplayControlsDisabled).toBe(false)
    expect(map.current!.placemarks).toBe(profile.current!.placemarks)
    expect(service.api.mock.calls.every(([, data]) => data === undefined)).toBe(true)
  })

  it('disables partial-list sorting and photo transfers while keeping editing available and clears checked/context selection', async () => {
    currentFixture = typedFixture()
    service.orders.set(track.id, ['kml-1', 'kml-2', 'kml-3'])
    await act(async () => root.render(createElement(TrackPlacemarkEditor, {track: currentFixture, basemap: 'none', onBasemap: vi.fn()})))
    await act(async () => rows()[0].click())
    expect(node.textContent).toContain('已选择 1 个点')
    await press(rows()[0], 'ContextMenu', false)
    expect(node.querySelector('.trk-placemark-context-menu')).not.toBeNull()
    await changeTypeFilter('type:水源')
    expect(node.querySelector('.trk-placemark-context-menu')).toBeNull()
    expect(node.textContent).toContain('已选择 0 个点')
    expect(map.current!.selectedPlacemark).toBeNull()
    expect(rows().every(row => row.getAttribute('draggable') === 'false')).toBe(true)
    expect(button('恢复时间排序').disabled).toBe(true)
    expect(button('上移选中点位').disabled).toBe(true)
    expect(button('下移选中点位').disabled).toBe(true)
    expect(button('编辑标注点 1').disabled).toBe(false)
    expect(map.current!.placemarkEditingDisabled).toBe(false)
    const before = service.api.mock.calls.length
    await press(rows()[0], 'ArrowDown')
    expect(service.api.mock.calls.length).toBe(before)
    await act(async () => rows()[0].click())
    expect(node.querySelector<HTMLButtonElement>('.trk-overview-photo-choice')!.disabled).toBe(true)
    await act(async () => {
      const preferences = writeMapSettings({...readMapSettings(), sandboxPlacemarks: false})
      window.dispatchEvent(new StorageEvent('storage', {key: MAP_SETTINGS_KEY, newValue: JSON.stringify(preferences)}))
    })
    expect(readMapSettings().sandboxPlacemarks).toBe(false)
    await act(async () => button('新增标注').click())
    expect(readMapSettings().sandboxPlacemarks).toBe(true)
    expect(map.current!.placemarkTypeFilter).toBe('all')
    expect(map.current!.placemarkDisplayControlsDisabled).toBe(true)
    await act(async () => button('取消新增').click())
    expect(map.current!.placemarkDisplayControlsDisabled).toBe(false)
  })
})


it('uses cached overview thumbnails and gives the map the stable track id',async()=>{
 await render()
 expect(node.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl(track.id,track.placemarks![0].images[0]))
 expect(map.current?.trackId).toBe(track.id)
})
