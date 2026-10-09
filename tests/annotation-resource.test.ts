// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {renderAnnotationPng, storeAnnotationImage} from '../src/client/annotation-resource.ts'
import {storeResourceAnnotation} from '../src/client/resources-api.ts'
import {SVG_ANNOTATION_MAX_BYTES} from '../src/track/resources.ts'

vi.mock('../src/client/resources-api.ts',()=>({storeResourceAnnotation:vi.fn(async()=>({id:'snapshot-asset'}))}))

const scene=(width=1200,height=1800)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="100" y="100">山口路线</text></svg>`
function png(size=100):Blob {
  const value=new Blob(['png-fixture'],{type:'image/png'})
  Object.defineProperty(value,'size',{value:size})
  return value
}
let loadMode:'load'|'error'|'pending'
let images:TestImage[]
class TestImage {
  onload:(()=>void)|null=null
  onerror:(()=>void)|null=null
  private source=''
  constructor(){images.push(this)}
  set src(value:string){this.source=value;if(loadMode!=='pending')queueMicrotask(()=>loadMode==='error'?this.onerror?.():this.onload?.())}
  get src(){return this.source}
}
let createUrl:ReturnType<typeof vi.fn<(object:Blob|MediaSource)=>string>>, revokeUrl:ReturnType<typeof vi.fn<(url:string)=>void>>, draw:ReturnType<typeof vi.fn>
let encoded:Array<{width:number;height:number;type:string|undefined}>
let encode:(callback:BlobCallback,canvas:HTMLCanvasElement)=>void
beforeEach(()=>{
  vi.clearAllMocks();loadMode='load';images=[];encoded=[]
  vi.mocked(storeResourceAnnotation).mockReset().mockResolvedValue({id:'snapshot-asset'} as never)
  createUrl=vi.fn<(object:Blob|MediaSource)=>string>(()=>'blob:annotation-test');revokeUrl=vi.fn<(url:string)=>void>();draw=vi.fn()
  vi.stubGlobal('Image',TestImage)
  vi.stubGlobal('URL',class extends URL {static createObjectURL(object:Blob|MediaSource):string {return String(createUrl(object))};static revokeObjectURL(url:string):void {revokeUrl(url)}})
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D)
  encode=callback=>callback(png())
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(this:HTMLCanvasElement,callback:BlobCallback,type?:string){
    encoded.push({width:this.width,height:this.height,type});encode(callback,this)
  })
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})

describe('SVG annotation PNG resource snapshot',()=>{
  it('exports the complete portrait composition at twice its artwork resolution',async()=>{
    const result=await renderAnnotationPng(scene())
    expect(result.type).toBe('image/png')
    expect(encoded).toEqual([{width:2400,height:3600,type:'image/png'}])
    // Five-argument drawing fits the whole SVG; it never crops a source rectangle.
    expect(draw).toHaveBeenCalledExactlyOnceWith(images[0],0,0,2400,3600)
    const svgBlob=createUrl.mock.calls[0][0] as Blob
    expect(svgBlob.type).toBe('image/svg+xml')
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:annotation-test')
    expect(images[0].onload).toBeNull();expect(images[0].onerror).toBeNull()
  })
  it('fits a long composition inside 4096 pixels while retaining its entire aspect ratio',async()=>{
    await renderAnnotationPng(scene(1200,8000))
    expect(encoded).toEqual([{width:614,height:4096,type:'image/png'}])
    expect(draw).toHaveBeenCalledExactlyOnceWith(images[0],0,0,614,4096)
  })
  it('keeps dense square artwork within the server image decoder pixel budget',async()=>{
    await renderAnnotationPng(scene(8000,8000))
    expect(encoded).toEqual([{width:4000,height:4000,type:'image/png'}])
    expect(draw).toHaveBeenCalledExactlyOnceWith(images[0],0,0,4000,4000)
  })
  it('reduces resolution until a large PNG can be used directly as an AI reference',async()=>{
    const usable=png(SVG_ANNOTATION_MAX_BYTES)
    let attempt=0
    encode=callback=>callback(++attempt<3?png(SVG_ANNOTATION_MAX_BYTES+1):usable)
    const result=await renderAnnotationPng(scene(1000,1000))
    expect(result).toBe(usable)
    expect(encoded.map(({width,height})=>[width,height])).toEqual([[2000,2000],[1500,1500],[1125,1125]])
    expect(revokeUrl).toHaveBeenCalledOnce()
  })
  it('rejects a PNG that remains too large and cleans up its temporary SVG',async()=>{
    encode=callback=>callback(png(SVG_ANNOTATION_MAX_BYTES+1))
    await expect(renderAnnotationPng(scene())).rejects.toThrow('超过 10 MiB')
    expect(encoded.length).toBeGreaterThan(1);expect(encoded.length).toBeLessThanOrEqual(6)
    expect(encoded.at(-1)!.width).toBeLessThan(encoded[0].width)
    expect(revokeUrl).toHaveBeenCalledOnce()
  })
  it.each([null,new Blob([],{type:'image/png'})])('rejects an absent or empty encoded PNG',async value=>{
    encode=callback=>callback(value)
    await expect(renderAnnotationPng(scene())).rejects.toThrow('PNG 标注图生成失败')
    expect(revokeUrl).toHaveBeenCalledOnce()
  })
  it('rejects a browser encoder that returns another image format',async()=>{
    encode=callback=>callback(new Blob(['jpeg'],{type:'image/jpeg'}))
    await expect(renderAnnotationPng(scene())).rejects.toThrow('未返回 PNG 格式')
    expect(revokeUrl).toHaveBeenCalledOnce()
  })
  it('rejects unsupported or failing canvas rendering without retaining its URL',async()=>{
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null)
    await expect(renderAnnotationPng(scene())).rejects.toThrow('无法生成 PNG')
    expect(revokeUrl).toHaveBeenCalledOnce()
    draw.mockImplementationOnce(()=>{throw new Error('绘图失败')})
    await expect(renderAnnotationPng(scene())).rejects.toThrow('绘图失败')
    expect(revokeUrl).toHaveBeenCalledTimes(2)
  })
  it('rejects image decoding failure and removes the image listeners',async()=>{
    loadMode='error'
    await expect(renderAnnotationPng(scene())).rejects.toThrow('无法转换为图片')
    expect(revokeUrl).toHaveBeenCalledOnce()
    expect(images[0].onload).toBeNull();expect(images[0].onerror).toBeNull()
  })
  it('times out a stalled SVG image load and releases its temporary URL',async()=>{
    vi.useFakeTimers();loadMode='pending'
    const pending=renderAnnotationPng(scene())
    const assertion=expect(pending).rejects.toThrow('转换超时')
    await vi.advanceTimersByTimeAsync(15001);await assertion
    expect(encoded).toHaveLength(0);expect(revokeUrl).toHaveBeenCalledOnce()
    expect(images[0].onload).toBeNull();expect(images[0].onerror).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out a stalled PNG encoder and clears every conversion timer',async()=>{
    vi.useFakeTimers();encode=()=>{}
    const pending=renderAnnotationPng(scene())
    const assertion=expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(15001);await assertion
    expect(encoded).toHaveLength(1);expect(revokeUrl).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([scene(0,100),scene(100,-1),scene(NaN,100),scene(10001,100),'<svg width="1200" height="1800"><broken>', '<html width="100" height="100"/>'])('rejects invalid SVG dimensions before allocating an image URL',async svg=>{
    await expect(renderAnnotationPng(svg)).rejects.toThrow('标注画布尺寸无效')
    expect(createUrl).not.toHaveBeenCalled();expect(draw).not.toHaveBeenCalled()
  })
  it('uploads the generated PNG to the captured track and preserves its given name',async()=>{
    const result=png(250)
    encode=callback=>callback(result)
    await storeAnnotationImage({trackId:'wugongshan-2026',name:'武功山-轨迹标注.png',svg:scene()})
    expect(encoded).toEqual([{width:1200,height:1800,type:'image/png'}])
    expect(storeResourceAnnotation).toHaveBeenCalledExactlyOnceWith('wugongshan-2026','武功山-轨迹标注.png',result)
    expect(result.type).toBe('image/png')
  })
  it('propagates resource storage failures so the saved artwork can offer an explicit retry',async()=>{
    vi.mocked(storeResourceAnnotation).mockRejectedValueOnce(new Error('资源库磁盘不可写'))
    await expect(storeAnnotationImage({trackId:'abc',name:'山口.png',svg:scene()})).rejects.toThrow('资源库磁盘不可写')
    expect(revokeUrl).toHaveBeenCalledOnce()
  })
})
