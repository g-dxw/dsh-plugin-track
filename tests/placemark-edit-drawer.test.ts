// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn(async()=>{})}))
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
import { PlacemarkEditDrawer, type PlacemarkInfoPatch } from '../src/client/PlacemarkEditDrawer.tsx'
import type { TrackPlacemark } from '../src/protocol.ts'
import { placemarkPhotoUrl, PLACEMARK_PHOTO_ACCEPT, PLACEMARK_PHOTO_MAX_BYTES } from '../src/track/placemark-photos.ts'

const point: TrackPlacemark = {id:'kml-1', name:'牧场', description:'原说明', coordinates:[120,30], images:['https://example.com/one.jpg'], type:'风景点'}
const points = [point, {...point, id:'kml-2', images:['https://example.com/two.jpg']}]
let root: Root, node: HTMLDivElement
let onSave: ReturnType<typeof vi.fn<(patch: PlacemarkInfoPatch) => Promise<boolean>>>
let onClose: ReturnType<typeof vi.fn<() => void>>, onReturnFocus: ReturnType<typeof vi.fn<() => void>>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  node=document.createElement('div'); document.body.append(node); root=createRoot(node)
  onSave=vi.fn(async(_patch: PlacemarkInfoPatch)=>true); onClose=vi.fn(); onReturnFocus=vi.fn()
})
afterEach(async()=>{await act(async()=>root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()})
type DrawerOptions = Partial<Parameters<typeof PlacemarkEditDrawer>[0]>
async function render(value=point, saving=false, error='', options:DrawerOptions={}){await act(async()=>root.render(createElement(PlacemarkEditDrawer,{point:value,points,saving,error,onSave,onClose,onReturnFocus,...options})))}
function button(label:string){return Array.from(node.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===label||item.getAttribute('aria-label')===label)!}
async function input(label:string,value:string){
  const element=node.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`[aria-label="${label}"]`)!
  const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,value)
  await act(async()=>element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true})))
}
async function save(){await act(async()=>node.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))}
async function toggleType(label:string){await act(async()=>node.querySelector<HTMLInputElement>(`[aria-label="点位类型：${label}"]`)!.click())}

describe('placemark information drawer',()=>{
  it('opens with existing information, all preset types and focus on the name',async()=>{
    await render()
    expect(node.querySelector('dialog')!.open).toBe(true)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('标注名')
    expect(node.querySelector<HTMLTextAreaElement>('[aria-label="标注描述"]')!.value).toBe('原说明')
    expect(Array.from(node.querySelectorAll<HTMLInputElement>('.trk-placemark-edit-types input')).map(item=>item.getAttribute('aria-label'))).toEqual(['风景点','休息点','补给点','厕所','打卡点','起点','终点'].map(value=>`点位类型：${value}`))
    expect(node.querySelector<HTMLInputElement>('[aria-label="点位类型：风景点"]')!.checked).toBe(true)
    expect(button('保存点位').disabled).toBe(true)
  })
  it('saves blank captions, custom tags, image changes and map visibility together',async()=>{
    await render()
    await input('标注名','');await input('标注描述','')
    await toggleType('休息点');await input('自定义点位标签','  营地  ')
    await act(async()=>button('移除第 1 张图片').click())
    const visible=node.querySelector<HTMLInputElement>('.trk-placemark-edit-visibility input')!
    await act(async()=>visible.click())
    await save()
    expect(onSave).toHaveBeenCalledWith({name:'',description:'',type:['风景点','休息点','营地'],hidden:true,images:[]})
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(point.name).toBe('牧场');expect(point.images).toEqual(['https://example.com/one.jpg'])
  })
  it('offers existing route photos and accepts an added link without saving until confirmed',async()=>{
    await render()
    await act(async()=>button('选择轨迹图片 2').click())
    await input('第 1 张图片链接','https://example.com/updated.jpg')
    await input('添加图片链接','https://example.com/new.jpg')
    expect(onSave).not.toHaveBeenCalled()
    await save()
    expect(onSave.mock.calls[0][0].images).toEqual(['https://example.com/updated.jpg','https://example.com/two.jpg','https://example.com/new.jpg'])
  })
  it('rejects unsafe image links and oversized custom tags without calling save',async()=>{
    await render()
    await input('添加图片链接','javascript:alert(1)')
    await save()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('有效的 HTTP')
    expect(onSave).not.toHaveBeenCalled()
    await input('添加图片链接','');await input('自定义点位标签','长'.repeat(65))
    await save()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('最多 64 个字符')
    expect(onSave).not.toHaveBeenCalled()
  })
  it('adds custom tags with Enter, deduplicates existing types and supports removing all types',async()=>{
    await render()
    await input('自定义点位标签','  观景营地  ')
    const element=node.querySelector<HTMLInputElement>('[aria-label="自定义点位标签"]')!
    const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})
    await act(async()=>element.dispatchEvent(enter))
    expect(enter.defaultPrevented).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
    await input('自定义点位标签','观景营地');await act(async()=>button('添加标签').click())
    await input('自定义点位标签','风景点');await act(async()=>button('添加标签').click())
    expect(node.querySelectorAll('.trk-placemark-edit-tags>span')).toHaveLength(1)
    await input('自定义点位标签','日出');await act(async()=>button('添加标签').click())
    await act(async()=>button('移除标签 观景营地').click())
    await act(async()=>button('移除标签 日出').click())
    await toggleType('风景点')
    expect(node.textContent).toContain('未选择类型')
    await save()
    expect(onSave.mock.calls[0][0].type).toEqual([])
  })
  it('preserves multiple saved tags and limits new selections without dropping existing tags',async()=>{
    const saved=['风景点',...Array.from({length:19},(_,index)=>`自定义 ${index+1}`)]
    await render({...point,type:saved})
    expect(button('保存点位').disabled).toBe(true)
    expect(node.querySelectorAll('.trk-placemark-edit-tags>span')).toHaveLength(19)
    await toggleType('休息点')
    expect(node.querySelector<HTMLInputElement>('[aria-label="点位类型：休息点"]')!.checked).toBe(false)
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('最多添加 20 个')
    await input('自定义点位标签','第21个');await save()
    expect(onSave).not.toHaveBeenCalled()
    await input('自定义点位标签','');await input('标注名','新名称');await save()
    expect(onSave.mock.calls[0][0].type).toEqual(saved)
  })
  it('keeps an unsuccessful draft open and preserves it when cancelling discard',async()=>{
    onSave.mockResolvedValue(false)
    await render(point,false,'磁盘写入失败')
    await input('标注名','新名称');await save()
    expect(onClose).not.toHaveBeenCalled()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('磁盘写入失败')
    await act(async()=>button('取消').click())
    expect(node.textContent).toContain('还有未保存的修改')
    await act(async()=>button('继续编辑').click())
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('新名称')
    expect(onClose).not.toHaveBeenCalled()
  })
  it('requires explicit discard for Escape with a dirty draft and restores focus on unmount',async()=>{
    const trigger=document.createElement('button');document.body.append(trigger);trigger.focus()
    await render();await input('标注描述','修改中')
    await act(async()=>node.querySelector('dialog')!.dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true})))
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('继续编辑'))
    expect(node.querySelector('fieldset')!.disabled).toBe(true)
    expect(button('保存点位').disabled).toBe(true)
    await save()
    expect(onSave).not.toHaveBeenCalled()
    await act(async()=>button('放弃修改').click())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async()=>root.render(null))
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
  it('prevents duplicate submission or closing during a pending save and re-enables after failure',async()=>{
    let finish!:(value:boolean)=>void
    onSave.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}))
    await render();await input('标注名','修改中')
    await save();await save()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(node.querySelector('fieldset')!.disabled).toBe(true)
    expect(button('关闭点位编辑').disabled).toBe(true)
    await act(async()=>node.querySelector('dialog')!.dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true})))
    expect(onClose).not.toHaveBeenCalled()
    await act(async()=>finish(false))
    expect(node.querySelector('fieldset')!.disabled).toBe(false)
    expect(button('保存点位').disabled).toBe(false)
  })
})

const localPhoto = placemarkPhotoUrl('track-1', 'a'.repeat(64)+'.jpg')
const secondLocalPhoto = placemarkPhotoUrl('track-1', 'b'.repeat(64)+'.png')
function photo(name='风景.jpg', type='image/jpeg') {return new File(['image bytes'],name,{type})}
async function choosePhotos(files:File[]) {
  const element=node.querySelector<HTMLInputElement>('[aria-label="添加本地图片"]')!
  Object.defineProperty(element,'files',{value:files,configurable:true})
  await act(async()=>element.dispatchEvent(new Event('change',{bubbles:true})))
  expect(element.value).toBe('')
}

describe('local photos in the placemark drawer',()=>{
  it('previews local photos without editable internal URLs and mixes them with links and the route library',async()=>{
    const mixed={...point,images:[point.images[0],localPhoto]}
    await render(mixed,false,'',{points:[mixed,{...point,id:'kml-2',images:[secondLocalPhoto]}]})
    expect(node.querySelector<HTMLInputElement>('[aria-label="第 1 张图片链接"]')!.value).toBe(point.images[0])
    expect(node.querySelector('[aria-label="第 2 张图片链接"]')).toBeNull()
    expect(node.querySelector<HTMLImageElement>('[alt="点位图片 2"]')!.getAttribute('src')).toBe(localPhoto)
    expect(node.textContent).toContain('图片 2 · 本地图片')
    await act(async()=>button('选择轨迹图片 3').click())
    await input('第 1 张图片链接','https://example.com/updated.jpg')
    await act(async()=>button('移除第 2 张图片').click())
    expect(onSave).not.toHaveBeenCalled()
    await save()
    expect(onSave.mock.calls[0][0].images).toEqual(['https://example.com/updated.jpg',secondLocalPhoto])
  })
  it('adds a full upload batch only to the draft and preserves other fields until the user saves',async()=>{
    const upload=vi.fn<(file:File)=>Promise<string>>().mockResolvedValueOnce(localPhoto).mockResolvedValueOnce(secondLocalPhoto)
    const busy=vi.fn<(value:boolean)=>void>()
    await render(point,false,'',{onUploadPhoto:upload,onUploadBusyChange:busy})
    const fileInput=node.querySelector<HTMLInputElement>('[aria-label="添加本地图片"]')!
    expect(fileInput.multiple).toBe(true);expect(fileInput.accept).toBe(PLACEMARK_PHOTO_ACCEPT)
    await input('标注名','上传后的营地');await input('标注描述','保留未保存的说明');await input('自定义点位标签','日出')
    const files=[photo(),photo('营地.png','image/png')]
    await choosePhotos(files)
    expect(upload.mock.calls.map(call=>call[0])).toEqual(files)
    expect(busy.mock.calls.map(call=>call[0])).toEqual([true,false])
    expect(node.querySelectorAll('.trk-placemark-edit-image')).toHaveLength(3)
    expect(node.querySelector('[role="status"]')!.textContent).toContain('保存后关联')
    expect(node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!.value).toBe('上传后的营地')
    expect(onSave).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled()
    await act(async()=>button('取消').click())
    expect(node.textContent).toContain('还有未保存的修改')
    await act(async()=>button('继续编辑').click())
    await save()
    expect(onSave).toHaveBeenCalledWith({name:'上传后的营地',description:'保留未保存的说明',type:['风景点','日出'],hidden:false,images:[point.images[0],localPhoto,secondLocalPhoto]})
  })
  it('locks saving, closing, relocation, deletion and editing throughout a pending upload',async()=>{
    let finish!:(url:string)=>void
    const upload=vi.fn<(file:File)=>Promise<string>>(()=>new Promise(resolve=>{finish=resolve}))
    const onRelocate=vi.fn(),onDelete=vi.fn(),busy=vi.fn()
    await render(point,false,'',{onUploadPhoto:upload,onUploadBusyChange:busy,onRelocate,onDelete})
    await choosePhotos([photo()])
    expect(node.querySelector('fieldset')!.disabled).toBe(true)
    expect(node.querySelector('form')!.getAttribute('aria-busy')).toBe('true')
    for(const label of ['正在上传图片…','关闭点位编辑','取消','返回地图重新定位','删除标注点']) {
      expect(button(label).disabled).toBe(true)
      await act(async()=>button(label).click())
    }
    await save()
    await act(async()=>node.querySelector('dialog')!.dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true})))
    expect(onSave).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();expect(onRelocate).not.toHaveBeenCalled();expect(onDelete).not.toHaveBeenCalled()
    expect(node.querySelector('[role="status"]')!.textContent).toContain('1 / 1')
    await act(async()=>finish(localPhoto))
    expect(node.querySelector('fieldset')!.disabled).toBe(false)
    expect(button('保存点位').disabled).toBe(false)
    expect(busy.mock.calls.map(call=>call[0])).toEqual([true,false])
  })
  it('keeps the original image draft when a later upload fails and allows the same files to be retried',async()=>{
    const upload=vi.fn<(file:File)=>Promise<string>>().mockResolvedValueOnce(localPhoto).mockRejectedValueOnce(new Error('磁盘空间不足'))
      .mockResolvedValueOnce(localPhoto).mockResolvedValueOnce(secondLocalPhoto)
    const busy=vi.fn()
    await render(point,false,'',{onUploadPhoto:upload,onUploadBusyChange:busy})
    await input('标注描述','仍在编辑')
    const files=[photo(),photo('第二张.png','image/png')]
    await choosePhotos(files)
    expect(node.querySelectorAll('.trk-placemark-edit-image')).toHaveLength(1)
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('磁盘空间不足')
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('本次选择的图片未加入草稿')
    expect(node.querySelector<HTMLTextAreaElement>('[aria-label="标注描述"]')!.value).toBe('仍在编辑')
    expect(node.querySelector('fieldset')!.disabled).toBe(false);expect(onSave).not.toHaveBeenCalled()
    await choosePhotos(files)
    expect(upload).toHaveBeenCalledTimes(4)
    expect(node.querySelectorAll('.trk-placemark-edit-image')).toHaveLength(3)
    expect(node.querySelector('[role="alert"]')).toBeNull()
    expect(busy.mock.calls.map(call=>call[0])).toEqual([true,false,true,false])
    await save()
    expect(onSave.mock.calls[0][0].images).toEqual([point.images[0],localPhoto,secondLocalPhoto])
  })
  it.each(['size','svg','html'] as const)('validates the whole selection before uploading any file (%s)',async(kind)=>{
    const bad=kind==='svg'?photo('图.svg','image/svg+xml'):kind==='html'?photo('网页.html','text/html'):photo()
    if(kind==='size')Object.defineProperty(bad,'size',{value:PLACEMARK_PHOTO_MAX_BYTES+1})
    const upload=vi.fn<(file:File)=>Promise<string>>()
    const busy=vi.fn()
    await render(point,false,'',{onUploadPhoto:upload,onUploadBusyChange:busy})
    await choosePhotos([photo(),bad])
    expect(upload).not.toHaveBeenCalled();expect(busy).not.toHaveBeenCalled();expect(onSave).not.toHaveBeenCalled()
    expect(node.querySelectorAll('.trk-placemark-edit-image')).toHaveLength(1)
    expect(node.querySelector('[role="alert"]')!.textContent).toContain(kind==='size'?'20 MB':'不支持 SVG')
  })
  it('counts local files together with existing images and a pending remote link toward the 30-photo limit',async()=>{
    const many={...point,images:Array.from({length:28},(_,index)=>`https://example.com/${index}.jpg`)}
    const upload=vi.fn<(file:File)=>Promise<string>>()
    await render(many,false,'',{onUploadPhoto:upload})
    await input('添加图片链接','https://example.com/pending.jpg')
    await choosePhotos([photo(),photo('second.png','image/png')])
    expect(upload).not.toHaveBeenCalled()
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('最多关联 30 张')
    expect(node.querySelectorAll('.trk-placemark-edit-image')).toHaveLength(28)
    expect(node.querySelector<HTMLInputElement>('[aria-label="添加图片链接"]')!.value).toBe('https://example.com/pending.jpg')
  })
  it('releases the parent busy flag on unmount and does not upload the rest of the batch',async()=>{
    let finish!:(url:string)=>void
    const upload=vi.fn<(file:File)=>Promise<string>>(()=>new Promise(resolve=>{finish=resolve}))
    const busy=vi.fn()
    await render(point,false,'',{onUploadPhoto:upload,onUploadBusyChange:busy})
    await choosePhotos([photo(),photo('second.png','image/png')])
    await act(async()=>root.render(null))
    expect(busy.mock.calls.map(call=>call[0])).toEqual([true,false])
    await act(async()=>finish(localPhoto))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(busy.mock.calls.map(call=>call[0])).toEqual([true,false])
    expect(onSave).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled()
  })
})


it('previews cached thumbnails but saves raw image identities from the track library',async()=>{
 await render(point,false,'',{trackId:'track-1'})
 expect(node.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',point.images[0]))
 await act(async()=>button('选择轨迹图片 2').click());await save()
 expect(onSave.mock.calls[0][0].images).toEqual([point.images[0],points[1].images[0]])
})
