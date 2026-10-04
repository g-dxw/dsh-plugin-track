// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn(async()=>{})}))
import { useTrackPlacemarks } from '../src/client/useTrackPlacemarks.ts'
import { api } from '../src/client/util.ts'
import type { TrackRecord, TrackPlacemark, PlacemarkGroup } from '../src/protocol.ts'
import { createPlacemarkHistory, type PlacemarkHistory } from '../src/client/placemark-history.ts'
import { validatePlacemarkStateData, type PlacemarkState, type PlacemarkStateData } from '../src/track/placemark-state.ts'
import { derivePlacemarkLocation } from '../src/track/placemark-location.ts'
import { groupTypes, groupPhotos } from '../src/track/placemark-groups.ts'
vi.mock('../src/client/util.ts', () => ({api: vi.fn()}))
const track = {id:'track',filename:'route.kml',format:'kml',segmentStarts:[0],coordinates:[[120,30,100,100],[120.01,30,200,200]],placemarks:[
  {id:'start',name:'起点',description:'',images:['https://example.com/a.jpg'],coordinates:[120,30],elevation:100,time:100},
  {id:'end',name:'终点',description:'',images:[],coordinates:[120.01,30],elevation:200,time:400},
  {id:'photo',name:'',description:'',images:[],coordinates:[120.005,30],elevation:150,time:200},
]} as TrackRecord
const group:PlacemarkGroup={id:'group-00000000-0000-0000-0000-000000000001',name:'风景组',description:'组说明',memberIds:['photo','start'],coordinates:[120.005,30],cover:{pointId:'start',imageUrl:'https://example.com/a.jpg'}}
const newId='local-00000000-0000-0000-0000-000000000001'
let root:Root,node:HTMLDivElement,result:ReturnType<typeof useTrackPlacemarks>
function Hook({value,history}:{value:TrackRecord;history?:PlacemarkHistory}){result=useTrackPlacemarks(value,history);return null}
async function render(value=track,history?:PlacemarkHistory){await act(async()=>root.render(createElement(Hook,{value,history})))}
async function remount(value=track,history?:PlacemarkHistory){await act(async()=>root.unmount());root=createRoot(node);await render(value,history)}
const ids=()=>result.points.map(point=>point.id)
const point=(id:string)=>result.points.find(item=>item.id===id)!
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function doc(data:Partial<PlacemarkStateData>={},revision=0):PlacemarkState{return {version:1,revision,added:[],deletedIds:[],edits:[],order:null,groups:[],routeContext:null,...data}}
function persistentState(initial:Partial<PlacemarkStateData>={}){
  let stored=doc(initial)
  vi.mocked(api).mockImplementation(async(action,body)=>{
    if(!action.startsWith('placemark-state'))throw new Error(`Unexpected ${action}`)
    if(body){const request=body as {revision:number;data:PlacemarkStateData};if(request.revision!==stored.revision)throw Object.assign(new Error('版本冲突'),{status:409});stored={version:1,revision:stored.revision+1,...validatePlacemarkStateData(request.data)}}
    return {state:structuredClone(stored)} as never
  })
  return {get value(){return stored},set value(value:PlacemarkState){stored=value}}
}
const writes=()=>vi.mocked(api).mock.calls.filter(call=>call[1]!==undefined)
const lastData=()=>((writes().at(-1)![1] as {data:PlacemarkStateData}).data)
const created=(fraction=.25):TrackPlacemark=>({id:newId,name:'新增风景',description:'描述',images:['https://example.com/new.jpg'],type:['风景点'],coordinates:[0,0],elevation:null,time:null,timeSource:'unknown',routePosition:{startIndex:0,endIndex:1,fraction}})
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.clearAllMocks();persistentState();node=document.createElement('div');document.body.append(node);root=createRoot(node)})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})

describe('unified point arrangements',()=>{
  it('uses time by default, saves manual order, and restores chronological order',async()=>{
    await render();expect(ids()).toEqual(['start','photo','end'])
    await act(async()=>expect(await result.saveOrder(['end','start','photo'])).toBe(true));expect(ids()).toEqual(['end','start','photo']);expect(result.manualOrder).toBe(true)
    expect(writes()[0][0]).toBe('placemark-state');expect(lastData().order).toEqual(['end','start','photo'])
    await act(async()=>expect(await result.saveOrder(null)).toBe(true));expect(ids()).toEqual(['start','photo','end']);expect(result.manualOrder).toBe(false)
  })
  it('recovers saved order, point adjustments and groups together on reopen',async()=>{
    persistentState({order:['end','photo','start'],edits:[{id:'photo',images:['https://example.com/a.jpg']},{id:'start',images:[]}],groups:[group]})
    await render();expect(ids()).toEqual(['end','photo','start']);expect(point('photo').images).toEqual(['https://example.com/a.jpg']);expect(point('start').images).toEqual([]);expect(result.groups).toEqual([group])
    expect(api).toHaveBeenCalledOnce();expect(api).toHaveBeenCalledWith('placemark-state?id=track')
  })
  it('moves a photo in one atomic snapshot without changing either point metadata',async()=>{
    await render();await act(async()=>expect(await result.movePhoto('start','photo','https://example.com/a.jpg')).toBe(true))
    expect(lastData().edits).toEqual([{id:'start',images:[]},{id:'photo',images:['https://example.com/a.jpg']}]);expect(writes()).toHaveLength(1)
    expect(point('photo')).toMatchObject({time:200,coordinates:[120.005,30],elevation:150});expect(track.placemarks![0].images).toHaveLength(1)
  })
  it('snaps a marker and recalculates time, altitude and stable attachment',async()=>{
    await render();await act(async()=>expect(await result.movePoint('photo',[120.008,30.005])).toBe(true))
    expect(point('photo').coordinates[0]).toBeCloseTo(120.008);expect(point('photo').coordinates[1]).toBe(30);expect(point('photo').elevation).toBeCloseTo(180);expect(point('photo').time).toBeCloseTo(180)
    expect(point('photo').timeSource).toBe('track');expect(point('photo').routePosition?.fraction).toBeCloseTo(.8);expect(track.placemarks![2].time).toBe(200)
  })
  it('rolls both photo changes back on write failure and allows retry',async()=>{
    await render();vi.mocked(api).mockRejectedValueOnce(new Error('磁盘不可写'))
    await act(async()=>expect(await result.movePhoto('start','photo','https://example.com/a.jpg')).toBe(false));expect(result.editError).toContain('磁盘不可写');expect(point('start').images).toHaveLength(1);expect(point('photo').images).toHaveLength(0)
    await act(async()=>expect(await result.movePhoto('start','photo','https://example.com/a.jpg')).toBe(true));expect(result.editError).toBe('')
  })
  it('rolls order back on failure and blocks overlapping writes',async()=>{
    await render();const pending=deferred<never>();vi.mocked(api).mockReturnValueOnce(pending.promise);let save!:Promise<boolean>
    await act(async()=>{save=result.saveOrder(['end','start','photo']);expect(await result.movePhoto('start','photo','https://example.com/a.jpg')).toBe(false)})
    expect(result.saving).toBe(true);expect(ids()).toEqual(['end','start','photo'])
    await act(async()=>{pending.reject(new Error('写入失败'));expect(await save).toBe(false)});expect(ids()).toEqual(['start','photo','end']);expect(result.orderError).toContain('已恢复原顺序')
  })
  it('locks all state operations after unreadable state and retries explicitly',async()=>{
    vi.mocked(api).mockRejectedValueOnce(new Error('读取失败'));await render();expect(result.groupReady).toBe(false);expect(result.orderReady).toBe(false);expect(result.editReady).toBe(false);expect(result.stateError).toBe('读取失败')
    await act(async()=>{expect(await result.saveOrder(['end','start','photo'])).toBe(false);expect(await result.deletePoints(['start'])).toBe(false);expect(await result.updatePoint('start',{name:'不可写'})).toBe(false)})
    expect(writes()).toHaveLength(0);await act(async()=>result.retry());expect(result.groupReady).toBe(true);expect(result.stateError).toBe('')
  })
  it('ignores delayed write results after switching tracks',async()=>{
    await render();const pending=deferred<{state:PlacemarkState}>();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.saveOrder(['end','start','photo'])});await render({...track,id:'other'});expect(ids()).toEqual(['start','photo','end'])
    await act(async()=>{pending.resolve({state:doc({order:['end','start','photo']},1)});expect(await save).toBe(false)});expect(ids()).toEqual(['start','photo','end']);expect(result.saving).toBe(false)
  })
  it('waits for unmounted writes before reopening and saving the same track',async()=>{
    const stored=persistentState(),pending=deferred<{state:PlacemarkState}>();await render();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let oldWrite!:Promise<boolean>
    await act(async()=>{oldWrite=result.saveOrder(['end','start','photo'])});await remount();expect(result.orderReady).toBe(false);await act(async()=>expect(await result.saveOrder(['photo','start','end'])).toBe(false));expect(writes()).toHaveLength(1)
    await act(async()=>{stored.value=doc({order:['end','start','photo']},1);pending.resolve({state:stored.value});expect(await oldWrite).toBe(false)});expect(result.orderReady).toBe(true);expect(ids()).toEqual(['end','start','photo'])
    await act(async()=>expect(await result.saveOrder(['photo','start','end'])).toBe(true));expect(stored.value.order).toEqual(['photo','start','end'])
  })
  it('saves information, empty text and visibility across reopen retaining position and pictures',async()=>{
    const stored=persistentState();await render();await act(async()=>expect(await result.movePoint('photo',[120.008,30])).toBe(true));const before=structuredClone(point('photo'))
    await act(async()=>expect(await result.updatePoint('photo',{name:'山口',description:'一行\n二行',type:'营地',hidden:true,images:['https://example.com/new.jpg']})).toBe(true));const changed=structuredClone(point('photo'))
    expect(changed).toMatchObject({name:'山口',hidden:true,time:before.time,routePosition:before.routePosition});await remount();expect(point('photo')).toEqual(changed)
    await act(async()=>expect(await result.updatePoint('photo',{name:'',description:'',type:'',hidden:false})).toBe(true));await remount();expect(point('photo')).toMatchObject({name:'',description:'',type:'',hidden:false,images:['https://example.com/new.jpg'],time:before.time});expect(stored.value.revision).toBe(3)
  })
  it('retains saved name and type when a later patch only replaces pictures',async()=>{
    await render();await act(async()=>expect(await result.updatePoint('start',{name:'已修改',type:'补给',hidden:true})).toBe(true));await act(async()=>expect(await result.updatePoint('start',{images:[],hidden:false})).toBe(true))
    expect(point('start')).toMatchObject({name:'已修改',type:'补给',hidden:false,images:[],time:100});expect(lastData().edits).toEqual([{id:'start',name:'已修改',type:'补给',hidden:false,images:[]}])
  })
  it('normalizes multi-select types and clearing across reopen without losing other changes',async()=>{
    persistentState({order:['end','photo','start'],edits:[{id:'photo',type:'旧类型',name:'旧名称',images:['https://example.com/saved.jpg']}]});await render();await act(async()=>expect(await result.movePoint('photo',[120.008,30])).toBe(true))
    const types=[' 风景点 ','补给点','风景点'];await act(async()=>expect(await result.updatePoint('photo',{type:types,description:'说明',hidden:true})).toBe(true));const saved=structuredClone(point('photo'));expect(saved.type).toEqual(['风景点','补给点']);expect(types).toEqual([' 风景点 ','补给点','风景点']);await remount();expect(point('photo')).toEqual(saved)
    await act(async()=>expect(await result.updatePoint('photo',{type:[]})).toBe(true));await remount();expect(point('photo')).toEqual({...saved,type:[]});expect(ids()).toEqual(['end','photo','start'])
  })
  it('rolls a rejected type write back and permits retry',async()=>{
    await render();await act(async()=>expect(await result.updatePoint('start',{type:['风景点'],name:'已保存'})).toBe(true));const saved=structuredClone(point('start'));vi.mocked(api).mockRejectedValueOnce(new Error('无法写入'))
    await act(async()=>expect(await result.updatePoint('start',{type:['营地']})).toBe(false));expect(point('start')).toEqual(saved);await act(async()=>expect(await result.updatePoint('start',{type:[]})).toBe(true));expect(result.editError).toBe('')
  })
  it('rolls optimistic point information back when its write fails',async()=>{
    await render();const pending=deferred<never>();vi.mocked(api).mockReturnValueOnce(pending.promise);let save!:Promise<boolean>
    await act(async()=>{save=result.updatePoint('start',{name:'待保存',hidden:true,images:[]})});expect(result.editing).toBe(true);expect(point('start').hidden).toBe(true)
    await act(async()=>{pending.reject(new Error('不可写'));expect(await save).toBe(false)});expect(point('start')).toEqual(track.placemarks![0]);expect(result.editError).toContain('已恢复');expect(result.editing).toBe(false)
  })
  it('rejects invalid information and unknown IDs without a POST',async()=>{
    await render();for(const patch of [{name:42},{description:'说'.repeat(10001)},{type:['a',42]},{hidden:1}])await act(async()=>expect(await result.updatePoint('start',patch as never)).toBe(false))
    await act(async()=>expect(await result.updatePoint('missing',{name:'名称'})).toBe(false));expect(writes()).toHaveLength(0);expect(point('start')).toEqual(track.placemarks![0])
  })
  it('shares one write lock across all mutations and history',async()=>{
    await render(track,createPlacemarkHistory(track.id));const pending=deferred<{state:PlacemarkState}>();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.updatePoint('start',{hidden:true});expect(await result.saveOrder(['end','photo','start'])).toBe(false);expect(await result.movePoint('photo',[120.008,30])).toBe(false);expect(await result.createPoint(created())).toBe(false);expect(await result.deletePoints(['end'])).toBe(false);expect(await result.saveGroups([group])).toBe(false);expect(await result.undo()).toBe(false)})
    expect(writes()).toHaveLength(1);await act(async()=>{pending.resolve({state:doc(lastData(),1)});expect(await save).toBe(true)})
  })
  it('waits for pending information when remounted',async()=>{
    const stored=persistentState(),pending=deferred<{state:PlacemarkState}>();await render();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.updatePoint('start',{name:'旧实例',hidden:true})});await remount();expect(result.editReady).toBe(false);await act(async()=>expect(await result.updatePoint('start',{name:'不能抢先'})).toBe(false))
    await act(async()=>{stored.value=doc(lastData(),1);pending.resolve({state:stored.value});expect(await save).toBe(false)});expect(point('start').name).toBe('旧实例');await act(async()=>expect(await result.updatePoint('start',{name:'新实例'})).toBe(true));expect(point('start').name).toBe('新实例')
  })
  it('applies saved information after source metadata recovery without changing its baseline',async()=>{
    const pending=deferred<Response>();vi.stubGlobal('fetch',vi.fn().mockReturnValue(pending.promise));persistentState({edits:[{id:'start',name:'保存名称',hidden:true}]})
    const legacy={...track,placemarks:track.placemarks!.map(item=>item.id==='start'?{...item,elevation:undefined,time:undefined}:item)};await render(legacy);expect(result.loading).toBe(true)
    await act(async()=>{pending.resolve(new Response('<kml><Document><Placemark><Point><coordinates>120,30,101</coordinates></Point><TimeStamp><when>2026-01-01T00:00:00Z</when></TimeStamp></Placemark></Document></kml>'));await pending.promise});expect(point('start').name).toBe('保存名称');expect(point('start').hidden).toBe(true)
  })
  it('does not create history without the owning session',async()=>{await render();await act(async()=>expect(await result.updatePoint('start',{name:'名称'})).toBe(true));expect(result.canUndo).toBe(false);await act(async()=>expect(await result.undo()).toBe(false))})
  it('undoes and redoes mixed complete snapshots through the single endpoint',async()=>{
    await render(track,createPlacemarkHistory(track.id));const original=structuredClone(result.points)
    await act(async()=>expect(await result.updatePoint('start',{name:'新名称'})).toBe(true));await act(async()=>expect(await result.saveOrder(['end','photo','start'])).toBe(true));await act(async()=>expect(await result.movePhoto('start','photo','https://example.com/a.jpg')).toBe(true));await act(async()=>expect(await result.saveGroups([group])).toBe(true));const final={points:structuredClone(result.points),groups:structuredClone(result.groups)}
    for(let index=0;index<4;index++)await act(async()=>expect(await result.undo()).toBe(true));expect(result.points).toEqual(original);expect(result.groups).toEqual([]);expect(result.canUndo).toBe(false)
    for(let index=0;index<4;index++)await act(async()=>expect(await result.redo()).toBe(true));expect(result.points).toEqual(final.points);expect(result.groups).toEqual(final.groups);expect(writes().every(call=>call[0]==='placemark-state')).toBe(true)
  })
  it('skips no-op and failed writes without clearing redo',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>expect(await result.updatePoint('start',{name:'新名称'})).toBe(true));await act(async()=>expect(await result.undo()).toBe(true));const count=writes().length
    await act(async()=>{expect(await result.updatePoint('start',{name:'起点'})).toBe(true);expect(await result.saveOrder(null)).toBe(true);expect(await result.saveGroups([])).toBe(true)});expect(writes()).toHaveLength(count);expect(result.canRedo).toBe(true)
    vi.mocked(api).mockRejectedValueOnce(new Error('写入失败'));await act(async()=>expect(await result.updatePoint('start',{hidden:true})).toBe(false));expect(result.canRedo).toBe(true)
  })
  it('restores a partial legacy order through undo without requiring every recovered ID',async()=>{
    persistentState({order:['end','missing']});await render(track,createPlacemarkHistory(track.id));expect(ids()).toEqual(['end','start','photo']);await act(async()=>expect(await result.saveOrder(['start','photo','end'])).toBe(true));await act(async()=>expect(await result.undo()).toBe(true));expect(lastData().order).toEqual(['end','missing'])
  })
  it('retains undo and redo after failed history saves',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>expect(await result.updatePoint('start',{name:'已保存'})).toBe(true));vi.mocked(api).mockRejectedValueOnce(new Error('不能撤销'))
    await act(async()=>expect(await result.undo()).toBe(false));expect(result.canUndo).toBe(true);expect(point('start').name).toBe('已保存');await act(async()=>expect(await result.undo()).toBe(true));vi.mocked(api).mockRejectedValueOnce(new Error('不能重做'));await act(async()=>expect(await result.redo()).toBe(false));expect(result.canRedo).toBe(true)
  })
  it('uses fresh snapshots for sequential calls within one tick',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>{expect(await result.updatePoint('start',{name:'名称'})).toBe(true);expect(await result.updatePoint('start',{hidden:true})).toBe(true);expect(await result.undo()).toBe(true);expect(await result.updatePoint('photo',{name:'另一点'})).toBe(true)})
    expect(point('start').name).toBe('名称');expect(point('start').hidden).toBeUndefined();expect(point('photo').name).toBe('另一点');expect(result.canRedo).toBe(false)
  })
  it('retains session history across unmount but starts fresh with a new session',async()=>{
    const history=createPlacemarkHistory(track.id);await render(track,history);await act(async()=>expect(await result.updatePoint('start',{name:'保存'})).toBe(true));await remount(track,history);expect(result.canUndo).toBe(true);await remount(track,createPlacemarkHistory(track.id));expect(result.canUndo).toBe(false)
  })
  it('preserves matching history on retry and invalidates externally changed state',async()=>{
    const stored=persistentState(),history=createPlacemarkHistory(track.id);await render(track,history);await act(async()=>expect(await result.updatePoint('start',{name:'保存'})).toBe(true));await act(async()=>result.retry());expect(result.canUndo).toBe(true)
    stored.value=doc({...stored.value,groups:[group]},stored.value.revision+1);await act(async()=>result.retry());expect(result.canUndo).toBe(false);expect(result.groups).toEqual([group])
  })
  it('records pending successful writes while their editor is unmounted',async()=>{
    const stored=persistentState(),history=createPlacemarkHistory(track.id),pending=deferred<{state:PlacemarkState}>();await render(track,history);vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.updatePoint('start',{name:'迟到保存'})});await remount(track,history);expect(result.editReady).toBe(false)
    await act(async()=>{stored.value=doc(lastData(),1);pending.resolve({state:stored.value});expect(await save).toBe(false)});expect(result.canUndo).toBe(true);expect(point('start').name).toBe('迟到保存')
  })
  it('moves history after pending undo while unmounted',async()=>{
    const stored=persistentState(),history=createPlacemarkHistory(track.id);await render(track,history);await act(async()=>expect(await result.updatePoint('start',{name:'名称'})).toBe(true));const pending=deferred<{state:PlacemarkState}>();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.undo()});await remount(track,history);await act(async()=>{stored.value=doc(lastData(),2);pending.resolve({state:stored.value});expect(await save).toBe(false)});expect(point('start').name).toBe('起点');expect(result.canRedo).toBe(true);expect(result.canUndo).toBe(false)
  })
  it('isolates late writes to their original history and ignores mismatched sessions',async()=>{
    const first=createPlacemarkHistory(track.id),second=createPlacemarkHistory('other');await render(track,first);const pending=deferred<{state:PlacemarkState}>();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.updatePoint('start',{name:'原轨迹'})});const data=lastData();await render({...track,id:'other'},second);await act(async()=>{pending.resolve({state:doc(data,1)});expect(await save).toBe(false)});expect(first.getSnapshot().canUndo).toBe(true);expect(second.getSnapshot().canUndo).toBe(false);expect(point('start').name).toBe('起点');await render(track,second);expect(result.canUndo).toBe(false)
  })
  it('creates, moves and dissolves groups retaining leaves and flat order',async()=>{
    await render(track,createPlacemarkHistory(track.id));const leaves=structuredClone(result.points);await act(async()=>expect(await result.saveGroups([group])).toBe(true));await act(async()=>expect(await result.moveGroup(group.id,[120.008,30.005])).toBe(true));expect(result.groups[0].coordinates[0]).toBeCloseTo(120.008);expect(result.groups[0].coordinates[1]).toBe(30);expect(result.points).toEqual(leaves)
    await act(async()=>expect(await result.saveGroups([])).toBe(true));expect(result.groups).toEqual([]);await act(async()=>expect(await result.undo()).toBe(true));expect(result.groups).toHaveLength(1)
  })
  it('reopens groups and point edits and invalidates externally changed groups',async()=>{
    const stored=persistentState({groups:[group],edits:[{id:'start',type:['风景点']},{id:'photo',type:['补给点']}]});const history=createPlacemarkHistory(track.id);await render(track,history);expect(groupTypes(group,result.points)).toEqual(['风景点','补给点']);await act(async()=>expect(await result.saveGroups([{...group,name:'修改组'}])).toBe(true));await remount(track,history);expect(result.groups[0].name).toBe('修改组');expect(result.canUndo).toBe(true)
    stored.value=doc({...stored.value,groups:[group]},stored.value.revision+1);await act(async()=>result.retry());expect(result.canUndo).toBe(false)
  })
  it('uses current snapshots for same-tick grouping, edits and history',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>{expect(await result.saveGroups([group])).toBe(true);expect(await result.updatePoint('start',{hidden:true,type:['营地']})).toBe(true);expect(await result.undo()).toBe(true)})
    expect(result.groups).toEqual([group]);expect(point('start').hidden).toBeUndefined();expect(groupPhotos(group,result.points)).toHaveLength(1)
  })
  it('retains group and history on failed save or undo and allows retry',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>expect(await result.saveGroups([group])).toBe(true));vi.mocked(api).mockRejectedValueOnce(new Error('不能保存'));await act(async()=>expect(await result.saveGroups([])).toBe(false));expect(result.groups).toEqual([group]);vi.mocked(api).mockRejectedValueOnce(new Error('不能撤销'));await act(async()=>expect(await result.undo()).toBe(false));expect(result.canUndo).toBe(true);await act(async()=>expect(await result.undo()).toBe(true));expect(result.groups).toEqual([])
  })
  it('shares the grouping lock with child edits, sorting, transfers and deletion',async()=>{
    await render();const pending=deferred<{state:PlacemarkState}>();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.saveGroups([group]);expect(await result.updatePoint('start',{name:'不会覆盖'})).toBe(false);expect(await result.deletePoints(['start'])).toBe(false);expect(await result.movePhoto('start','photo','https://example.com/a.jpg')).toBe(false);expect(await result.moveGroup(group.id,[120,30])).toBe(false)})
    expect(result.grouping).toBe(true);await act(async()=>{pending.resolve({state:doc(lastData(),1)});expect(await save).toBe(true)});expect(result.grouping).toBe(false)
  })
  it('does not fall back to legacy endpoints when the state interface is missing',async()=>{
    vi.mocked(api).mockRejectedValueOnce(new Error('接口不存在'));await render();expect(result.groupReady).toBe(false);expect(result.groupError).toContain('接口不存在');expect(vi.mocked(api).mock.calls.every(call=>call[0].startsWith('placemark-state'))).toBe(true)
    await act(async()=>result.retry());expect(result.groupReady).toBe(true)
  })
  it('rejects duplicate membership, nested IDs and invalid group coordinates before saving',async()=>{
    await render();await act(async()=>expect(await result.saveGroups([group])).toBe(true));vi.mocked(api).mockClear()
    for(const invalid of [[group,{...group,id:'group-00000000-0000-0000-0000-000000000002'}],[{...group,memberIds:[]}],[{...group,memberIds:[group.id],cover:undefined}],[{...group,cover:{pointId:'end',imageUrl:'https://example.com/a.jpg'}}]])await act(async()=>expect(await result.saveGroups(invalid)).toBe(false))
    await act(async()=>expect(await result.moveGroup(group.id,[181,30])).toBe(false));expect(writes()).toHaveLength(0);expect(result.groups).toEqual([group]);await act(async()=>expect(await result.saveGroups([{...group,memberIds:['start']}])).toBe(true))
  })
  it('keeps pending group writes in session and ignores stale reads after switching tracks',async()=>{
    const stored=persistentState(),history=createPlacemarkHistory(track.id);await render(track,history);const pending=deferred<{state:PlacemarkState}>();vi.mocked(api).mockReturnValueOnce(pending.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.saveGroups([group])});await remount(track,history);expect(result.groupReady).toBe(false);await act(async()=>{stored.value=doc(lastData(),1);pending.resolve({state:stored.value});expect(await save).toBe(false)});expect(result.groups).toEqual([group]);expect(result.canUndo).toBe(true)
    const late=deferred<{state:PlacemarkState}>();vi.mocked(api).mockImplementation(async action=>action.endsWith('id=track')?late.promise as never:{state:doc()} as never);await act(async()=>result.retry());await render({...track,id:'other'},createPlacemarkHistory('other'));await act(async()=>{late.resolve({state:stored.value});await late.promise});expect(result.groups).toEqual([])
  })
  it('rejects invalid save responses unless reread confirms the write',async()=>{
    await render(track,createPlacemarkHistory(track.id));vi.mocked(api).mockResolvedValueOnce({state:{groups:null}} as never);await act(async()=>expect(await result.saveGroups([group])).toBe(false));expect(result.groups).toEqual([]);expect(result.canUndo).toBe(false);expect(result.groupError).toContain('未保存')
  })
})

describe('point lifetimes, conflicts and route context',()=>{
  it('creates derived coordinates, time, altitude and one immutable undo step',async()=>{
    const stored=persistentState(),history=createPlacemarkHistory(track.id);await render(track,history);await act(async()=>expect(await result.createPoint(created())).toBe(true));expect(point(newId).coordinates[0]).toBeCloseTo(120.0025);expect(point(newId)).toMatchObject({elevation:125,time:125,timeSource:'track'});expect(stored.value.routeContext).toEqual({segmentStarts:[0],references:track.placemarks});expect(ids()).toEqual(['start',newId,'photo','end'])
    await act(async()=>expect(await result.undo()).toBe(true));expect(ids()).toEqual(['start','photo','end']);expect(stored.value.routeContext).not.toBeNull();await act(async()=>expect(await result.redo()).toBe(true));expect(point(newId).time).toBe(125)
  })
  it('appends new points to manual order including recovered unsorted IDs',async()=>{
    persistentState({order:['end']});await render();await act(async()=>expect(await result.createPoint(created())).toBe(true));expect(ids()).toEqual(['end','start','photo',newId]);expect(lastData().order).toEqual(ids())
  })
  it('saves local edits and stable anchor across refresh',async()=>{
    await render();await act(async()=>expect(await result.createPoint(created())).toBe(true));await act(async()=>expect(await result.updatePoint(newId,{name:'新名',hidden:true,images:[]})).toBe(true));await remount();expect(point(newId)).toMatchObject({name:'新名',hidden:true,images:[],time:125,routePosition:{startIndex:0,endIndex:1,fraction:.25}})
  })
  it('rejects missing attachment, malformed local IDs and duplicate creation without writing',async()=>{
    await render();await act(async()=>{expect(await result.createPoint({...created(),routePosition:undefined})).toBe(false);expect(await result.createPoint({...created(),id:'not-local'})).toBe(false)});expect(writes()).toHaveLength(0);await act(async()=>expect(await result.createPoint(created())).toBe(true));const count=writes().length;await act(async()=>expect(await result.createPoint(created())).toBe(false));expect(writes()).toHaveLength(count)
  })
  it('deletes originals without source resurrection and restores by undo',async()=>{
    const stored=persistentState(),history=createPlacemarkHistory(track.id);await render(track,history);await act(async()=>expect(await result.deletePoints(['start'])).toBe(true));expect(stored.value.deletedIds).toEqual(['start']);expect(ids()).toEqual(['photo','end']);await remount(track,history);expect(ids()).toEqual(['photo','end']);await act(async()=>expect(await result.undo()).toBe(true));expect(point('start')).toEqual(track.placemarks![0]);await act(async()=>expect(await result.redo()).toBe(true));expect(ids()).toEqual(['photo','end'])
  })
  it('batch deletes members and cover in one snapshot restoring edits, order and pictures',async()=>{
    persistentState({groups:[group],order:['end','start','photo'],edits:[{id:'start',name:'编辑名称',type:['营地']},{id:'photo',images:['https://example.com/b.jpg']}]});await render(track,createPlacemarkHistory(track.id));const before=structuredClone(result.points)
    await act(async()=>expect(await result.deletePoints(['start','photo'])).toBe(true));expect(ids()).toEqual(['end']);expect(result.groups).toEqual([]);expect(lastData().edits).toEqual([]);expect(lastData().order).toEqual(['end']);expect(writes()).toHaveLength(1)
    await act(async()=>expect(await result.undo()).toBe(true));expect(result.points).toEqual(before);expect(result.groups).toEqual([group]);await act(async()=>expect(await result.redo()).toBe(true));expect(ids()).toEqual(['end'])
  })
  it('deleting cover chooses remaining visible image and preserves group position',async()=>{
    persistentState({groups:[group],edits:[{id:'photo',images:['https://example.com/b.jpg']}]});await render();await act(async()=>expect(await result.deletePoints(['start'])).toBe(true));expect(result.groups[0]).toMatchObject({memberIds:['photo'],coordinates:group.coordinates,cover:{pointId:'photo',imageUrl:'https://example.com/b.jpg'}})
  })
  it('clears cover when only hidden member images remain',async()=>{
    persistentState({groups:[group],edits:[{id:'photo',hidden:true,images:['https://example.com/b.jpg']}]});await render();await act(async()=>expect(await result.deletePoints(['start'])).toBe(true));expect(result.groups[0].cover).toBeUndefined();expect(result.groups[0].memberIds).toEqual(['photo'])
  })
  it('deletes local points without tombstones and supports undo then repeated deletion',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>expect(await result.createPoint(created())).toBe(true));await act(async()=>expect(await result.deletePoints([newId])).toBe(true));expect(lastData().added).toEqual([]);expect(lastData().deletedIds).toEqual([]);await act(async()=>expect(await result.undo()).toBe(true));expect(point(newId)).toBeDefined();await act(async()=>expect(await result.deletePoints([newId])).toBe(true));expect(result.canRedo).toBe(false)
  })
  it('can delete every point without altering track coordinates or metrics',async()=>{
    const before=structuredClone(track);await render();await act(async()=>expect(await result.deletePoints(ids())).toBe(true));expect(result.points).toEqual([]);expect(track).toEqual(before);expect(lastData().deletedIds).toHaveLength(3)
  })
  it('no-op deletes preserve redo without a request',async()=>{
    await render(track,createPlacemarkHistory(track.id));await act(async()=>expect(await result.updatePoint('start',{name:'新名'})).toBe(true));await act(async()=>expect(await result.undo()).toBe(true));const count=writes().length;await act(async()=>expect(await result.deletePoints(['missing'])).toBe(true));expect(writes()).toHaveLength(count);expect(result.canRedo).toBe(true)
  })
  it('rolls failed creation and deletion back without history movement',async()=>{
    await render(track,createPlacemarkHistory(track.id));vi.mocked(api).mockRejectedValueOnce(new Error('失败'));await act(async()=>expect(await result.createPoint(created())).toBe(false));expect(ids()).toEqual(['start','photo','end']);expect(result.canUndo).toBe(false)
    vi.mocked(api).mockRejectedValueOnce(new Error('失败'));await act(async()=>expect(await result.deletePoints(['start'])).toBe(false));expect(point('start')).toBeDefined();expect(result.canUndo).toBe(false)
  })
  it('refreshes baseline after conflict without applying requested draft or adding history',async()=>{
    const stored=persistentState();await render(track,createPlacemarkHistory(track.id));stored.value=doc({edits:[{id:'start',name:'其他窗口名称'}]},1)
    await act(async()=>expect(await result.updatePoint('start',{name:'我的草稿'})).toBe(false));expect(point('start').name).toBe('其他窗口名称');expect(result.editError).toContain('草稿保留');expect(result.canUndo).toBe(false)
    await act(async()=>expect(await result.updatePoint('start',{name:'我的草稿'})).toBe(true));expect(point('start').name).toBe('我的草稿');expect((writes().at(-1)![1] as {revision:number}).revision).toBe(1)
  })
  it('does not mistake identical concurrent state for its own write after 409',async()=>{
    const stored=persistentState();await render(track,createPlacemarkHistory(track.id));stored.value=doc({edits:[{id:'start',name:'同名'}]},1);await act(async()=>expect(await result.updatePoint('start',{name:'同名'})).toBe(false));expect(result.canUndo).toBe(false);expect(point('start').name).toBe('同名')
  })
  it('confirms interrupted POST by reread and records one step',async()=>{
    const stored=persistentState(),base=vi.mocked(api).getMockImplementation()!;await render(track,createPlacemarkHistory(track.id));vi.mocked(api).mockImplementationOnce(async(action,body)=>{await base(action,body);throw new Error('连接中断')})
    await act(async()=>expect(await result.deletePoints(['start'])).toBe(true));expect(ids()).toEqual(['photo','end']);expect(stored.value.revision).toBe(1);expect(result.canUndo).toBe(true);expect(result.editError).toBe('');expect(writes()).toHaveLength(1)
  })
  it('locks unverifiable save results instead of allowing stale overwrite',async()=>{
    await render();vi.mocked(api).mockRejectedValueOnce(new Error('断线')).mockRejectedValueOnce(new Error('仍断线'));await act(async()=>expect(await result.deletePoints(['start'])).toBe(false));expect(point('start')).toBeDefined();expect(result.groupReady).toBe(false);expect(result.stateError).toContain('尚未确定');await act(async()=>expect(await result.updatePoint('start',{name:'不能写'})).toBe(false));expect(writes()).toHaveLength(1)
    await act(async()=>result.retry());expect(result.groupReady).toBe(true)
  })
  it('keeps remounted reader waiting during interrupted-write verification',async()=>{
    const stored=persistentState(),base=vi.mocked(api).getMockImplementation()!,verify=deferred<{state:PlacemarkState}>();await render();vi.mocked(api).mockImplementationOnce(async(action,body)=>{await base(action,body);throw new Error('断线')}).mockReturnValueOnce(verify.promise as never);let save!:Promise<boolean>
    await act(async()=>{save=result.deletePoints(['start'])});await remount();expect(result.editReady).toBe(false)
    await act(async()=>{verify.resolve({state:stored.value});expect(await save).toBe(false)});expect(result.editReady).toBe(true);expect(ids()).toEqual(['photo','end'])
  })
  it('locks corrupt state without legacy fallback or writes',async()=>{
    vi.mocked(api).mockResolvedValueOnce({state:{version:1,revision:3,groups:[]}} as never);await render();expect(result.groupReady).toBe(false);await act(async()=>expect(await result.deletePoints(['start'])).toBe(false));expect(writes()).toHaveLength(0);expect(vi.mocked(api).mock.calls.every(call=>call[0].startsWith('placemark-state'))).toBe(true)
  })
  it('restores segments from matching source ignoring altitude and time differences',async()=>{
    const source='<gpx><trk><trkseg><trkpt lat="30" lon="120"><ele>999</ele></trkpt></trkseg><trkseg><trkpt lat="30" lon="120.01"><ele>888</ele></trkpt></trkseg></trk></gpx>'
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(source)));await render({...track,filename:'route.gpx',format:'gpx',segmentStarts:undefined});expect(result.routeReady).toBe(true);expect(result.routeContext?.segmentStarts).toEqual([0,1]);expect(result.routeContext?.references).toEqual([])
  })
  it('failed recovery blocks new and moved points but permits information and deletion',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('源文件失败')));await render({...track,segmentStarts:undefined});expect(result.routeReady).toBe(false);expect(result.routeError).toContain('源文件失败');await act(async()=>{expect(await result.createPoint(created())).toBe(false);expect(await result.movePoint('photo',[120.008,30])).toBe(false);expect(await result.updatePoint('start',{name:'仍可编辑'})).toBe(true);expect(await result.deletePoints(['photo'])).toBe(true)})
    expect(point('start').name).toBe('仍可编辑');expect(ids()).toEqual(['start','end'])
  })
  it('refuses mismatched source lon/lat recovery',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<kml><Document><Placemark><LineString><coordinates>121,30,100 121.01,30,200</coordinates></LineString></Placemark></Document></kml>')));await render({...track,segmentStarts:undefined});expect(result.routeReady).toBe(false);expect(result.routeError).toContain('坐标不一致')
  })
  it('reads saved fixed context without source after originals were deleted',async()=>{
    const context={segmentStarts:[0],references:track.placemarks!};persistentState({routeContext:context,deletedIds:['start','end']});const source=vi.fn().mockRejectedValue(new Error('不应读取'));vi.stubGlobal('fetch',source);await render({...track,segmentStarts:undefined});expect(result.routeReady).toBe(true);expect(result.routeContext).toEqual(context);expect(source).not.toHaveBeenCalled()
  })
  it('requires passage choice for overlaps and persists selected stable position',async()=>{
    const loop={...track,coordinates:[[120,30,100,100],[120.01,30,200,200],[120,30,300,300]] as TrackRecord['coordinates']};await render(loop,createPlacemarkHistory(track.id));await act(async()=>expect(await result.movePoint('photo',[120.005,30])).toBe(false));expect(result.editError).toContain('多次经过');expect(writes()).toHaveLength(0)
    const location=derivePlacemarkLocation(loop.coordinates,result.routeContext!,{startIndex:1,endIndex:2,fraction:.5});await act(async()=>expect(await result.movePointTo('photo',location)).toBe(true));expect(point('photo')).toMatchObject({time:250,elevation:250,routePosition:{startIndex:1,endIndex:2,fraction:.5}})
  })
  it('recomputes rather than trusts caller altitude and timestamp',async()=>{
    await render();const location=derivePlacemarkLocation(track.coordinates,result.routeContext!,{startIndex:0,endIndex:1,fraction:.5});await act(async()=>expect(await result.movePointTo('photo',{...location,elevation:999,time:999,coordinates:[0,0]})).toBe(true));expect(point('photo').coordinates[0]).toBeCloseTo(120.005);expect(point('photo')).toMatchObject({elevation:150,time:150,timeSource:'track'})
  })
  it('fixes estimation references through hide, delete and movement without recursion',async()=>{
    const untimed={...track,coordinates:[[120,30,100,null],[120.01,30,200,null]] as TrackRecord['coordinates']};await render(untimed);const baseline=structuredClone(result.routeContext)
    await act(async()=>expect(await result.updatePoint('start',{hidden:true})).toBe(true));await act(async()=>expect(await result.deletePoints(['end'])).toBe(true));await act(async()=>expect(await result.movePoint('start',[120.002,30])).toBe(true));await act(async()=>expect(await result.createPoint(created(.75))).toBe(true));expect(result.routeContext).toEqual(baseline);expect(point(newId)).toMatchObject({time:300,timeSource:'estimated'})
  })
})
