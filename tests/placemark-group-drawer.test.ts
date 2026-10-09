// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
import { PlacemarkGroupDrawer, type PlacemarkGroupDrawerProps } from '../src/client/PlacemarkGroupDrawer.tsx'
import type { PlacemarkGroup, TrackPlacemark } from '../src/protocol.ts'

const points: TrackPlacemark[] = [
  {id:'p1',name:'牧场',description:'原说明',coordinates:[120,30],images:['https://example.com/a.jpg','https://example.com/a.jpg'],type:['风景点','打卡点']},
  {id:'p2',name:'山口',description:'',coordinates:[120.1,30.1],images:['https://example.com/b.jpg'],type:'风景点'},
  {id:'p3',name:'营地',description:'',coordinates:[120.2,30.2],images:['https://example.com/hidden.jpg'],type:['休息点','自定义'],hidden:true},
  {id:'p4',name:'其他组成员',description:'',coordinates:[120.3,30.3],images:['https://example.com/other.jpg']},
  {id:'p5',name:'无图点',description:'',coordinates:[120.4,30.4],images:['javascript:alert(1)']},
]
const group: PlacemarkGroup = {id:'group-00000000-0000-4000-8000-000000000001',name:'沿途风景',description:'原组说明',memberIds:['p1','p2','p3'],coordinates:[119.9,29.9],cover:{pointId:'p1',imageUrl:'https://example.com/a.jpg'}}
const other: PlacemarkGroup = {...group,id:'group-00000000-0000-4000-8000-000000000002',name:'补给站',memberIds:['p4']}
let root: Root, node: HTMLDivElement, props: PlacemarkGroupDrawerProps
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  node=document.createElement('div');document.body.append(node);root=createRoot(node)
  props={group,groups:[group,other],points,saving:false,error:'',onSave:vi.fn(async()=>true),onDissolve:vi.fn(async()=>true),onClose:vi.fn(),onReturnFocus:vi.fn()}
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function render(overrides:Partial<PlacemarkGroupDrawerProps>={}){props={...props,...overrides};await act(async()=>root.render(createElement(PlacemarkGroupDrawer,props)))}
function button(label:string){return Array.from(node.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label||item.getAttribute('aria-label')===label)!}
function member(number:number){return node.querySelector<HTMLButtonElement>(`[aria-label^="移出分组成员：${number}"]`)!}
async function toggle(number:number){await act(async()=>member(number).click())}
async function input(label:string,value:string){
  const element=node.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,value)
  await act(async()=>element.dispatchEvent(new Event('input',{bubbles:true})))
}
async function save(){await act(async()=>node.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))}
async function cancel(){const event=new Event('cancel',{bubbles:true,cancelable:true});await act(async()=>node.querySelector('dialog')!.dispatchEvent(event));return event}
function saved(){return vi.mocked(props.onSave).mock.calls[0][0]}

describe('placemark group drawer',()=>{
  it('retains unresolved legacy members when renaming and shows their preserved IDs without removable controls',async()=>{
    const legacy={...group,memberIds:['legacy-a','p1','legacy-b','p2']}
    await render({group:legacy})
    const status=node.querySelector('.trk-placemark-group-unresolved')!
    expect(status.textContent).toContain('2 个成员尚未恢复')
    expect(status.textContent).toContain('legacy-a');expect(status.textContent).toContain('legacy-b')
    expect(status.textContent).toContain('不可移除')
    expect(status.querySelector('input,button')).toBeNull()
    expect(button('保存分组').disabled).toBe(true)
    await input('分组名称','旧组新名称');await save()
    expect(saved().memberIds).toEqual(['p1','p2','legacy-a','legacy-b'])
    expect(saved().coordinates).toEqual(legacy.coordinates)
    expect(saved().cover).toEqual(legacy.cover)
    expect(legacy.memberIds).toEqual(['legacy-a','p1','legacy-b','p2'])
  })
  it('keeps unresolved members unique when all recovered members are removed',async()=>{
    await render({group:{...group,memberIds:['p1','legacy-a','p2']}})
    await toggle(1);await toggle(2)
    await save()
    expect(saved().memberIds).toEqual(['legacy-a'])
    expect(new Set(saved().memberIds).size).toBe(saved().memberIds.length)
    expect(saved().memberIds).not.toContain('p4')
    expect(saved()).not.toHaveProperty('cover')
    expect(saved().coordinates).toEqual(group.coordinates)
  })
  it('allows metadata edits with only unresolved members and retains their stored cover instead of deleting the group or photo reference',async()=>{
    const legacy={...group,memberIds:['legacy-a'],cover:{pointId:'legacy-a',imageUrl:'https://example.com/legacy.jpg'}}
    await render({group:legacy})
    expect(node.textContent).toContain('封面来源点尚未恢复')
    expect(node.querySelectorAll('[aria-label^="分组封面："]')).toHaveLength(0)
    await input('分组描述','仅修改描述');await save()
    expect(saved()).toEqual({...legacy,description:'仅修改描述',hidden:false})
    expect(props.onClose).toHaveBeenCalledOnce()
  })
  it('keeps an unresolved cover on known-member edits and replaces it only after an explicit photo choice',async()=>{
    const legacy={...group,memberIds:['p1','legacy-a','p2'],cover:{pointId:'legacy-a',imageUrl:'https://example.com/legacy.jpg'}}
    await render({group:legacy})
    expect(button('分组封面：1 牧场 图片 1').getAttribute('aria-pressed')).toBe('false')
    await toggle(2);await input('分组描述','保留旧封面');await save()
    expect(saved().memberIds).toEqual(['p1','legacy-a'])
    expect(saved().cover).toEqual(legacy.cover)
    vi.mocked(props.onSave).mockClear()
    await act(async()=>button('分组封面：1 牧场 图片 1').click());await save()
    expect(saved().cover).toEqual(group.cover)
    expect(saved().memberIds).toEqual(['p1','legacy-a'])
    expect(saved().coordinates).toEqual(legacy.coordinates)
  })
  it('turns a restored legacy member into an editable selected member without duplicating or forgetting its identity',async()=>{
    const legacy={...group,memberIds:['p1','legacy-a']}
    await render({group:legacy})
    const restored={...points[1],id:'legacy-a',name:'已恢复山口'}
    await render({points:[points[0],restored,...points.slice(2)]})
    expect(node.querySelector('.trk-placemark-group-unresolved')).toBeNull()
    expect(member(2).getAttribute('aria-label')).toBe('移出分组成员：2 已恢复山口')
    await input('分组名称','恢复后的分组');await save()
    expect(saved().memberIds).toEqual(['p1','legacy-a'])
    vi.mocked(props.onSave).mockClear();await toggle(2);await save()
    expect(saved().memberIds).toEqual(['p1'])
  })
  it('retains a valid hidden-child cover on metadata and unrelated member edits instead of persisting the visible slideshow fallback',async()=>{
    const hiddenCover={...group,cover:{pointId:'p3',imageUrl:'https://example.com/hidden.jpg'}}
    await render({group:hiddenCover})
    expect(button('分组封面：3 营地 图片 1，已在地图隐藏').getAttribute('aria-pressed')).toBe('true')
    expect(button('分组封面：1 牧场 图片 1').getAttribute('aria-pressed')).toBe('false')
    await input('分组名称','仍保留营地封面');await input('分组描述','仅改元信息');await toggle(2)
    await save()
    expect(saved().cover).toEqual(hiddenCover.cover)
    expect(saved().coordinates).toEqual(hiddenCover.coordinates)
    expect(saved().memberIds).toEqual(['p1','p3'])
    expect(points[2].hidden).toBe(true)
    vi.mocked(props.onSave).mockClear()
    await render({points:points.map(point=>point.id==='p3'?{...point,hidden:false}:point)})
    expect(button('分组封面：3 营地 图片 1').getAttribute('aria-pressed')).toBe('true')
    await input('分组描述','成员恢复显示');await save()
    expect(saved().cover).toEqual(hiddenCover.cover)
    expect(saved().coordinates).toEqual(hiddenCover.coordinates)
  })
  it('lets a hidden child photo be the explicitly chosen creation cover and uses its original coordinates',async()=>{
    await render({creating:true,group:{...group,memberIds:['p1','p3']}})
    await act(async()=>button('分组封面：3 营地 图片 1，已在地图隐藏').click())
    await save()
    expect(saved().cover).toEqual({pointId:'p3',imageUrl:'https://example.com/hidden.jpg'})
    expect(saved().coordinates).toEqual(points[2].coordinates)
    expect(saved().memberIds).toEqual(['p1','p3'])
    expect(points[2].hidden).toBe(true)
  })
  it('falls back to the first valid member image only when the stored cover image disappears, preserving the group location',async()=>{
    const hiddenCover={...group,cover:{pointId:'p3',imageUrl:'https://example.com/hidden.jpg'}}
    await render({group:hiddenCover})
    await render({points:points.map(point=>point.id==='p3'?{...point,images:[]}:point)})
    expect(button('分组封面：1 牧场 图片 1').getAttribute('aria-pressed')).toBe('true')
    await input('分组描述','封面原图已移除');await save()
    expect(saved().cover).toEqual(group.cover)
    expect(saved().memberIds).toEqual(group.memberIds)
    expect(saved().coordinates).toEqual(hiddenCover.coordinates)
  })
  it('shows only current members in point order with thumbnails and read-only aggregate types',async()=>{
    await render()
    expect(node.querySelector('dialog')!.open).toBe(true)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('分组名称')
    expect(node.querySelector<HTMLTextAreaElement>('[aria-label="分组描述"]')!.value).toBe('原组说明')
    expect(Array.from(node.querySelectorAll<HTMLButtonElement>('[aria-label^="移出分组成员："]')).map(item=>item.getAttribute('aria-label'))).toEqual(['1 牧场','2 山口','3 营地'].map(label=>`移出分组成员：${label}`))
    expect(member(4)).toBeNull();expect(member(5)).toBeNull()
    const memberList=node.querySelector('.trk-placemark-group-members')!
    expect(memberList.querySelector('input[type="checkbox"]')).toBeNull()
    expect(Array.from(memberList.querySelectorAll('img')).map(item=>item.getAttribute('src'))).toEqual(['https://example.com/a.jpg','https://example.com/b.jpg','https://example.com/hidden.jpg'])
    expect(member(3).closest('.trk-placemark-group-member')!.classList.contains('is-hidden')).toBe(true)
    expect(member(3).closest('.trk-placemark-group-member')!.textContent).toContain('已在地图隐藏')
    const types=node.querySelector('[aria-label="分组类型"]')!
    expect(Array.from(types.querySelectorAll('.trk-placemark-group-types>span')).map(item=>item.textContent)).toEqual(['风景点','打卡点','休息点','自定义'])
    expect(types.querySelector('input')).toBeNull()
    expect(node.querySelectorAll('[aria-label^="分组封面："]')).toHaveLength(3)
    expect(node.querySelector('[src="https://example.com/hidden.jpg"]')).not.toBeNull()
    expect(button('分组封面：3 营地 图片 1，已在地图隐藏').textContent).toContain('已隐藏')
    expect(button('保存分组').disabled).toBe(true)
  })
  it('creates at the final cover point and saves group metadata without changing source points',async()=>{
    const before=JSON.stringify(points)
    await render({creating:true,group:{...group,memberIds:['p1','p2']},onDissolve:undefined})
    await input('分组名称','  新风景组  ');await input('分组描述','一起欣赏')
    await act(async()=>button('分组封面：2 山口 图片 1').click())
    await act(async()=>node.querySelector<HTMLInputElement>('[aria-label="在地图上显示分组"]')!.click())
    await save()
    expect(saved()).toEqual({...group,name:'新风景组',description:'一起欣赏',memberIds:['p1','p2'],coordinates:points[1].coordinates,cover:{pointId:'p2',imageUrl:'https://example.com/b.jpg'},hidden:true})
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(JSON.stringify(points)).toBe(before)
    expect(button('解散分组')).toBeUndefined()
  })
  it('creates a group without images at the first member in the current point order and omits cover',async()=>{
    const noImages=points.map(point=>({...point,images:[]}))
    await render({creating:true,group:{...group,memberIds:['p2','p1']},points:[noImages[1],noImages[0],...noImages.slice(2)]})
    expect(node.textContent).toContain('没有图片')
    await save()
    expect(saved().memberIds).toEqual(['p2','p1'])
    expect(saved().coordinates).toEqual(points[1].coordinates)
    expect(saved()).not.toHaveProperty('cover')
  })
  it('keeps an edited group location when selecting another cover and uses the first available photo after removing its owner',async()=>{
    await render()
    await act(async()=>button('分组封面：2 山口 图片 1').click())
    await save()
    expect(saved().coordinates).toEqual(group.coordinates)
    expect(saved().cover?.pointId).toBe('p2')
    expect(group.cover?.pointId).toBe('p1')
    vi.mocked(props.onSave).mockClear();vi.mocked(props.onClose).mockClear()
    await toggle(2)
    expect(button('分组封面：1 牧场 图片 1').getAttribute('aria-pressed')).toBe('true')
    await save()
    expect(saved().memberIds).toEqual(['p1','p3'])
    expect(saved().cover).toEqual(group.cover)
    expect(saved().coordinates).toEqual(group.coordinates)
  })
  it('keeps external and other-group points out of the drawer, with current members following the point order',async()=>{
    await render({points:[points[4],...points.slice(0,4)]})
    expect(member(1)).toBeNull();expect(member(5)).toBeNull()
    expect(Array.from(node.querySelectorAll('[data-group-member-id]')).map(item=>item.getAttribute('data-group-member-id'))).toEqual(['p1','p2','p3'])
    expect(node.querySelector('[src="https://example.com/other.jpg"]')).toBeNull()
    await input('分组名称','只改组名')
    await save()
    expect(saved().memberIds).toEqual(['p1','p2','p3'])
    expect(saved().memberIds).not.toContain('p4')
    expect(other.memberIds).toEqual(['p4'])
  })
  it('renders member metadata and a numbered thumbnail without inventing titles for unnamed points',async()=>{
    const metadataPoints=points.map(point=>point.id==='p1'?{...point,elevation:1234.6,time:Date.UTC(2026,9,1,1,2,3)}:point.id==='p2'?{...point,name:'',images:[]}:point)
    await render({points:metadataPoints})
    const first=node.querySelector('[data-group-member-id="p1"]')!,unnamed=node.querySelector('[data-group-member-id="p2"]')!
    expect(first.textContent).toContain('海拔 1235 m')
    expect(first.textContent).toContain('2026-10-01')
    expect(first.textContent).toContain('02:03')
    expect(first.querySelector('.trk-placemark-group-member-number')!.textContent).toBe('1')
    expect(unnamed.querySelector('strong')).toBeNull()
    expect(unnamed.querySelector('img')).toBeNull()
    expect(unnamed.querySelector('.trk-placemark-group-member-number')!.textContent).toBe('2')
    expect(unnamed.querySelector('button')!.getAttribute('aria-label')).toBe('移出分组成员：2')
  })
  it('keeps member removal and its derived cover/type changes in the draft until saved, so discard leaves persisted data untouched',async()=>{
    const before=JSON.stringify({group,points})
    await render();await toggle(1)
    expect(node.querySelector('[data-group-member-id="p1"]')).toBeNull()
    expect(button('分组封面：2 山口 图片 1').getAttribute('aria-pressed')).toBe('true')
    expect(node.querySelector('[aria-label="分组类型"]')!.textContent).not.toContain('打卡点')
    expect(props.onSave).not.toHaveBeenCalled()
    await act(async()=>button('取消').click());await act(async()=>button('放弃修改').click())
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(JSON.stringify({group,points})).toBe(before)
  })
  it('requires two members to create, allows one when editing and rejects an empty group',async()=>{
    await render({creating:true,group:{...group,memberIds:['p1']}})
    await save()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('至少选择 2')
    await act(async()=>root.render(null));vi.mocked(props.onSave).mockClear()
    await render({creating:true,group:{...group,memberIds:['p1','p2']}});await save()
    expect(saved().memberIds).toEqual(['p1','p2'])
    await act(async()=>root.render(null));vi.mocked(props.onSave).mockClear()
    await render({creating:false,group:{...group,memberIds:['p1','p2']}})
    await toggle(2);await save()
    expect(saved().memberIds).toEqual(['p1'])
    vi.mocked(props.onSave).mockClear()
    await toggle(1);await save()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('至少保留 1')
  })
  it('preserves a hidden-member photo and clears cover only after its member is removed, retaining all other types',async()=>{
    await render({group:{...group,memberIds:[...group.memberIds,'p5']}})
    await toggle(1);await toggle(2)
    expect(node.querySelectorAll('[aria-label^="分组封面："]')).toHaveLength(1)
    expect(node.querySelector('[aria-label="分组类型"]')!.textContent).toContain('自定义')
    await save()
    expect(saved().memberIds).toEqual(['p3','p5'])
    expect(saved().cover).toEqual({pointId:'p3',imageUrl:'https://example.com/hidden.jpg'})
    expect(saved().coordinates).toEqual(group.coordinates)
    vi.mocked(props.onSave).mockClear();await toggle(3);await save()
    expect(saved().memberIds).toEqual(['p5'])
    expect(saved()).not.toHaveProperty('cover')
    expect(saved().coordinates).toEqual(group.coordinates)
  })
  it('validates required names without submitting',async()=>{
    await render();await input('分组名称','   ');await save()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('请输入分组名称')
  })
  it('keeps a failed draft and errors visible, and retries without losing member or cover changes',async()=>{
    vi.mocked(props.onSave).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await render({error:'磁盘写入失败'})
    await input('分组名称','新的组');await toggle(3);await act(async()=>button('分组封面：2 山口 图片 1').click())
    await save()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('磁盘写入失败')
    await render({error:''});await save()
    expect(vi.mocked(props.onSave).mock.calls[1][0]).toEqual(vi.mocked(props.onSave).mock.calls[0][0])
    expect(props.onClose).toHaveBeenCalledOnce()
  })
  it('requires explicit dirty-draft discard for Escape and focuses the confirmation without resubmitting',async()=>{
    await render();await input('分组描述','未保存说明')
    expect((await cancel()).defaultPrevented).toBe(true)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('继续编辑'))
    expect(node.querySelector('fieldset')!.disabled).toBe(true)
    expect(button('解散分组').disabled).toBe(true)
    await save();expect(props.onSave).not.toHaveBeenCalled()
    await cancel();expect(props.onClose).not.toHaveBeenCalled()
    await act(async()=>button('继续编辑').click())
    expect(node.querySelector<HTMLTextAreaElement>('[aria-label="分组描述"]')!.value).toBe('未保存说明')
    await cancel();await act(async()=>button('放弃修改').click())
    expect(props.onClose).toHaveBeenCalledOnce()
  })
  it('traps keyboard focus, restores the trigger and calls the fallback when it is gone',async()=>{
    const trigger=document.createElement('button');document.body.append(trigger);trigger.focus()
    await render({creating:true})
    const first=button('关闭分组编辑'),last=button('创建分组')
    first.focus();const reverse=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})
    await act(async()=>first.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true);expect(document.activeElement).toBe(last)
    const forward=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})
    await act(async()=>last.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true);expect(document.activeElement).toBe(first)
    await act(async()=>root.render(null));expect(document.activeElement).toBe(trigger)
    trigger.focus();await render();trigger.remove()
    await act(async()=>root.render(null));expect(props.onReturnFocus).toHaveBeenCalledOnce()
  })
  it('locks duplicate submission and dismissal until saving finishes, then preserves a failed draft',async()=>{
    let finish!:(value:boolean)=>void
    vi.mocked(props.onSave).mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}))
    await render();await input('分组名称','保存中')
    await save();await save();await cancel()
    expect(props.onSave).toHaveBeenCalledOnce()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(node.querySelector('fieldset')!.disabled).toBe(true)
    expect(button('关闭分组编辑').disabled).toBe(true)
    expect(button('解散分组').disabled).toBe(true)
    await act(async()=>finish(false))
    expect(node.querySelector('fieldset')!.disabled).toBe(false)
    expect(button('保存分组').disabled).toBe(false)
  })
  it('locks controls while the parent is saving and refuses synthetic submit or dissolve',async()=>{
    await render({saving:true})
    await save();await cancel();await act(async()=>button('解散分组').click())
    expect(props.onSave).not.toHaveBeenCalled();expect(props.onDissolve).not.toHaveBeenCalled();expect(props.onClose).not.toHaveBeenCalled()
  })
  it('dissolves directly without saving child changes, retaining failed groups for retry and locking the pending operation',async()=>{
    let finish!:(value:boolean)=>void
    vi.mocked(props.onDissolve!).mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve})).mockResolvedValueOnce(true)
    const before=JSON.stringify({group,points})
    await render({error:'解散写入失败'})
    await act(async()=>button('解散分组').click());await act(async()=>button('解散分组').click());await cancel()
    expect(props.onDissolve).toHaveBeenCalledOnce()
    expect(props.onSave).not.toHaveBeenCalled();expect(props.onClose).not.toHaveBeenCalled()
    await act(async()=>finish(false))
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('解散写入失败')
    await render({error:''});await act(async()=>button('解散分组').click())
    expect(props.onDissolve).toHaveBeenCalledTimes(2);expect(props.onClose).toHaveBeenCalledOnce()
    expect(JSON.stringify({group,points})).toBe(before)
  })
  it('keeps other photos selectable when a thumbnail fails and never renders unsafe URL schemes',async()=>{
    await render()
    await act(async()=>node.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(node.textContent).toContain('图片未加载')
    expect(node.querySelector('[src^="javascript:"]')).toBeNull()
    await act(async()=>button('分组封面：2 山口 图片 1').click())
    expect(button('分组封面：2 山口 图片 1').getAttribute('aria-pressed')).toBe('true')
  })
})


it('previews cached member photos but saves the original URL as the selected cover',async()=>{
 await render({trackId:'track-1'})
 expect(node.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',points[0].images[0]))
 await act(async()=>button('分组封面：2 山口 图片 1').click());await save()
 expect(saved().cover).toEqual({pointId:'p2',imageUrl:points[1].images[0]})
})
