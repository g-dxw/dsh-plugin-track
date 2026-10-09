// @vitest-environment jsdom
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn(async()=>{})}))
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
import {svgToPng} from '../src/client/svg-preview.ts'
import {readAnnotationPhoto,readLinkedAnnotationPhoto} from '../src/client/annotation-photo.ts'
class TestImage {
  static all:TestImage[]=[];onload:(()=>void)|null=null;onerror:(()=>void)|null=null;naturalWidth=2400;naturalHeight=1600;width=2400;height=1600;_src=''
  constructor(){TestImage.all.push(this)}
  set src(value:string){this._src=value;queueMicrotask(()=>this.onload?.())}get src(){return this._src}
}
beforeEach(()=>{TestImage.all=[];vi.stubGlobal('Image',TestImage);Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:owned')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn(),fillRect:vi.fn(),fillStyle:''} as unknown as CanvasRenderingContext2D);vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockImplementation(type=>'data:'+type+';base64,cGljdHVyZQ==')})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
describe('bounded SVG and photo references',()=>{
 it('loads only a selected public image link and normalizes it for an offline SVG',async()=>{
  const send=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}}));vi.stubGlobal('fetch',send)
  await expect(readLinkedAnnotationPhoto('https://example.com/photo.png')).resolves.toContain('image/jpeg')
  expect(send).toHaveBeenCalledWith('https://example.com/photo.png',{credentials:'omit',signal:expect.any(AbortSignal)})
 })
 it('refuses non-image links and an oversized streamed response before creating temporary image resources',async()=>{
  const send=vi.fn().mockResolvedValue(new Response(new Uint8Array(8*1024*1024+1),{headers:{'content-type':'image/png'}}));vi.stubGlobal('fetch',send)
  await expect(readLinkedAnnotationPhoto('javascript:alert(1)')).rejects.toThrow('HTTP')
  expect(send).not.toHaveBeenCalled()
  await expect(readLinkedAnnotationPhoto('https://example.com/photo.png')).rejects.toThrow('8 MB');expect(URL.createObjectURL).not.toHaveBeenCalled()
 })
 it('returns an actionable error when a selected image link fails',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('gone',{status:404})))
  await expect(readLinkedAnnotationPhoto('https://example.com/photo.jpg')).rejects.toThrow('上传本地图片')
 })
 it('bounds the generated reference dimensions and releases temporary URLs and image handlers',async()=>{
  const observed:HTMLCanvasElement[]=[];vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(function(this:HTMLCanvasElement){observed.push(this);return 'data:image/png;base64,cGljdHVyZQ=='})
  await expect(svgToPng('<svg/>',1536)).resolves.toContain('image/png');expect(observed[0].width).toBe(1536);expect(observed[0].height).toBe(1024)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned');expect(TestImage.all[0].onload).toBeNull();expect(TestImage.all[0].onerror).toBeNull()
 })
 it('normalizes local photos to JPEG and bounds their long side',async()=>{
  const observed:HTMLCanvasElement[]=[];vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(function(this:HTMLCanvasElement,type){observed.push(this);return 'data:'+type+';base64,cGljdHVyZQ=='})
  await expect(readAnnotationPhoto(new File(['photo'],'picture.webp',{type:'image/webp'}))).resolves.toContain('image/jpeg')
  expect(observed[0].width).toBe(1024);expect(observed[0].height).toBe(683);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned')
 })
 it('rejects executable and oversized original uploads before creating a URL',async()=>{
  await expect(readAnnotationPhoto(new File(['<svg/>'],'evil.svg',{type:'image/svg+xml'}))).rejects.toThrow('PNG')
  await expect(readAnnotationPhoto(new File([new Uint8Array(8*1024*1024+1)],'large.png',{type:'image/png'}))).rejects.toThrow('8 MB')
  expect(URL.createObjectURL).not.toHaveBeenCalled()
 })
 it('cleans up when Canvas cannot produce the reference',async()=>{
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);await expect(svgToPng('<svg/>')).rejects.toThrow('无法生成参考图')
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned');expect(TestImage.all[0].onerror).toBeNull()
 })
})


it('embeds a cached small photo using same-origin credentials instead of fetching the remote original',async()=>{
 const send=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}}));vi.stubGlobal('fetch',send)
 await expect(readLinkedAnnotationPhoto('https://example.com/photo.jpg','track-1')).resolves.toContain('image/jpeg')
 expect(send).toHaveBeenCalledWith(placemarkPhotoThumbnailUrl('track-1','https://example.com/photo.jpg'),{credentials:'same-origin',signal:expect.any(AbortSignal)})
})
