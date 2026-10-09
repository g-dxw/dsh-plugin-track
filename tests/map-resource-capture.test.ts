// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {captureMapImage} from '../src/client/map-resource-capture.ts'
import {SVG_ANNOTATION_MAX_BYTES, SVG_ANNOTATION_MAX_PIXELS} from '../src/track/resources.ts'

const rect = (x = 10, y = 20, width = 400, height = 300): DOMRect => ({x, y, left:x, top:y, right:x + width, bottom:y + height, width, height, toJSON:()=>({})} as DOMRect)
function canvas(width = 800, height = 600, cssWidth = width / 2, cssHeight = height / 2): HTMLCanvasElement {
  const element = document.createElement('canvas'); element.width = width; element.height = height
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(10, 20, cssWidth, cssHeight)); document.body.append(element)
  return element
}
function png(size = 100): Blob {
  const value = new Blob(['map-png'], {type:'image/png'}); Object.defineProperty(value, 'size', {value:size}); return value
}
function part(className: string, text: string, bounds: DOMRect, css = ''): HTMLSpanElement {
  const value = document.createElement('span'); value.className = className; value.textContent = text
  value.style.cssText = `font:700 12px system-ui; color:white; background:#c83532; border:2px solid white; border-radius:12px; box-shadow:0 1px 4px #0003; ${css}`
  vi.spyOn(value, 'getBoundingClientRect').mockReturnValue(bounds)
  return value
}
function marker(label = 'G1'): {button:HTMLButtonElement; dot:HTMLSpanElement; count:HTMLSpanElement; name:HTMLSpanElement} {
  const button = document.createElement('button'); button.className = 'trk-map-placemark'; button.setAttribute('aria-pressed','true')
  const dot = part('trk-map-placemark-dot', label, rect(48, 78, 24, 24)), count = part('trk-map-placemark-count', '3', rect(66, 72, 15, 16))
  const name = part('trk-map-placemark-name', '山口 风景', rect(20, 52, 80, 22), 'background:transparent; border:0; font:600 16px/22px system-ui; text-shadow:-1px -1px 0 #123456, 1px 1px 0 #123456')
  button.append(dot, count, name); vi.spyOn(button,'getBoundingClientRect').mockReturnValue(rect(38,68,44,44)); document.body.append(button)
  return {button,dot,count,name}
}
let contexts: Array<Record<string, unknown>>, encoded: Array<{width:number;height:number;type?:string}>
let encode: (callback:BlobCallback, element:HTMLCanvasElement)=>void
let loadMode:'load'|'error'|'pending', images:TestImage[]
class TestImage {
  crossOrigin: string | null = null
  onload:(()=>void)|null=null; onerror:(()=>void)|null=null
  private source = ''
  constructor(){images.push(this)}
  set src(value:string){this.source=value;if(loadMode !== 'pending')queueMicrotask(()=>loadMode === 'error' ? this.onerror?.() : this.onload?.())}
  get src(){return this.source}
}
function context(): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  for (const method of ['beginPath','moveTo','lineTo','quadraticCurveTo','closePath','fill','fillRect','drawImage','save','restore','rect','clip','scale','translate','fillText','strokeText']) value[method]=vi.fn()
  value.measureText=vi.fn((text:string)=>({width:Array.from(text).length*7}))
  return value
}
beforeEach(()=>{
  contexts=[];encoded=[];images=[];loadMode='load';encode=callback=>callback(png())
  vi.stubGlobal('Image',TestImage)
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function(){const value=context();contexts.push(value);return value as unknown as CanvasRenderingContext2D})
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(this:HTMLCanvasElement,callback:BlobCallback,type?:string){encoded.push({width:this.width,height:this.height,type});encode(callback,this)})
})
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
const texts=(context:Record<string,unknown>)=>(context.fillText as ReturnType<typeof vi.fn>).mock.calls.map(([text])=>String(text))

describe('current map PNG capture',()=>{
  it('copies the complete retina map without cropping or including UI chrome',async()=>{
    const source=canvas(), result=await captureMapImage({canvas:source,credits:[]})
    expect(result.type).toBe('image/png');expect(encoded).toEqual([{width:800,height:600,type:'image/png'}])
    expect(contexts[0].drawImage).toHaveBeenCalledExactlyOnceWith(source,0,0,800,600)
    expect(contexts[1].drawImage).toHaveBeenCalledOnce()
    expect((contexts[1].drawImage as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toBe(source)
    expect(texts(contexts[0])).toEqual([])
  })
  it('composes visible DOM group badges, counts and names at CSS-relative map positions',async()=>{
    const source=canvas(), {button}=marker()
    await captureMapImage({canvas:source,markers:[button],credits:[]})
    expect(contexts[0].scale).toHaveBeenCalledWith(2,2)
    expect(contexts[0].fillText).toHaveBeenCalledWith('G1',50,70)
    expect(contexts[0].fillText).toHaveBeenCalledWith('3',63.5,60)
    expect(contexts[0].fillText).toHaveBeenCalledWith('山口 风景',50,43)
    expect(contexts[0].strokeText).toHaveBeenCalledWith('山口 风景',50,43)
    // The selected button remains unchanged, while only its children are painted.
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(contexts[0].quadraticCurveTo).toHaveBeenCalled()
    expect((contexts[0].fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
  })
  it('respects hidden counts/names and hidden, invisible or wholly offscreen markers',async()=>{
    const source=canvas(), shown=marker('visible'), hidden=marker('hidden'), invisible=marker('invisible'), outside=marker('outside')
    shown.count.hidden=true;shown.name.hidden=true;hidden.button.hidden=true;invisible.button.style.visibility='hidden'
    vi.mocked(outside.dot.getBoundingClientRect).mockReturnValue(rect(1000,1000,24,24));outside.count.hidden=true;outside.name.hidden=true
    await captureMapImage({canvas:source,markers:[shown.button,hidden.button,invisible.button,outside.button],credits:[]})
    expect(texts(contexts[0])).toEqual(['visible'])
  })
  it('keeps partly visible edge markers clipped to the map rather than moving them',async()=>{
    const source=canvas(), {button,dot,count,name}=marker('edge');count.hidden=true;name.hidden=true
    vi.mocked(dot.getBoundingClientRect).mockReturnValue(rect(0,10,24,24))
    await captureMapImage({canvas:source,markers:[button],credits:[]})
    expect(contexts[0].fillText).toHaveBeenCalledWith('edge',2,2)
    expect(contexts[0].rect).toHaveBeenCalledWith(0,0,800,600);expect(contexts[0].clip).toHaveBeenCalled()
  })
  it('appends complete wrapped, deduplicated attribution without covering map pixels',async()=>{
    const source=canvas(240,180,120,90), credits=[{label:'© OpenStreetMap contributors',url:'https://osm.org'},{label:'Mapterhorn terrain',url:'https://mapterhorn.com'}]
    await captureMapImage({canvas:source,credits:[...credits,credits[0]]})
    expect(encoded[0].width).toBe(240);expect(encoded[0].height).toBeGreaterThan(180)
    const rendered=texts(contexts[0]).join(' ').replace(/\s+/g,' ')
    expect(rendered).toContain('© OpenStreetMap contributors');expect(rendered).toContain('Mapterhorn terrain')
    expect(rendered.match(/OpenStreetMap/g)).toHaveLength(1)
    expect(contexts[0].drawImage).toHaveBeenCalledWith(source,0,0,240,180)
    expect(contexts[0].translate).toHaveBeenCalledWith(0,180)
  })
  it('retains the complete aspect ratio within 4096 dimensions and decoder pixel budget',async()=>{
    const source=canvas(12000,12000,6000,6000)
    await captureMapImage({canvas:source,credits:[{label:'© Map provider',url:'https://map.test'}]})
    const output=encoded[0]
    expect(output.width).toBeLessThanOrEqual(4096);expect(output.height).toBeLessThanOrEqual(4096)
    expect(output.width*output.height).toBeLessThanOrEqual(SVG_ANNOTATION_MAX_PIXELS)
    const draw=(contexts[0].drawImage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(draw).toHaveLength(5);expect(draw[3]).toBe(draw[4]);expect(output.height).toBeGreaterThan(output.width)
  })
  it('freezes map pixels and DOM badge text before asynchronous logo loading',async()=>{
    loadMode='pending';const source=canvas(), {button,dot}=marker('G1')
    const pending=captureMapImage({canvas:source,markers:[button],credits:[],maptilerLogo:'https://api.maptiler.com/resources/logo.svg'})
    expect(contexts[0].drawImage).toHaveBeenCalledWith(source,0,0,800,600)
    expect(texts(contexts[0])).toContain('G1');expect(encoded).toHaveLength(0)
    dot.textContent='changed';vi.mocked(source.getBoundingClientRect).mockReturnValue(rect(0,0,100,100))
    images[0].onload?.();await pending
    expect(texts(contexts[0])).not.toContain('changed')
    expect((contexts[0].drawImage as ReturnType<typeof vi.fn>).mock.calls.filter(([value])=>value===source)).toHaveLength(1)
    expect(images[0].crossOrigin).toBe('anonymous');expect(images[0].onload).toBeNull();expect(images[0].onerror).toBeNull()
    expect(contexts[0].drawImage).toHaveBeenCalledWith(images[0],12,612,134,40)
  })
  it('fits the complete official provider logo into a narrow map without cropping it',async()=>{
    await captureMapImage({canvas:canvas(104,160,52,80),credits:[],maptilerLogo:'https://api.maptiler.com/resources/logo.svg'})
    expect(contexts[0].drawImage).toHaveBeenCalledWith(images[0],12,172,80,20*40/67*2)
    expect(encoded[0].width).toBe(104);expect(encoded[0].height).toBeGreaterThan(160)
  })
  it('reduces oversized PNGs using the immutable snapshot, rather than recapturing a changed view',async()=>{
    let attempt=0;const source=canvas()
    encode=callback=>{source.width=1;source.height=1;callback(++attempt<3?png(SVG_ANNOTATION_MAX_BYTES+1):png())}
    await captureMapImage({canvas:source,credits:[]})
    expect(encoded.map(({width,height})=>[width,height])).toEqual([[800,600],[600,450],[450,337]])
    expect(contexts[0].drawImage).toHaveBeenCalledOnce();expect(contexts[1].drawImage).toHaveBeenCalledTimes(3)
  })
  it('rejects an image that remains over the resource size limit',async()=>{
    encode=callback=>callback(png(SVG_ANNOTATION_MAX_BYTES+1))
    await expect(captureMapImage({canvas:canvas(),credits:[]})).rejects.toThrow('超过 10 MiB')
    expect(encoded).toHaveLength(6)
  })
  it.each([null,new Blob([],{type:'image/png'})])('rejects missing or empty PNG output',async value=>{
    encode=callback=>callback(value)
    await expect(captureMapImage({canvas:canvas(),credits:[]})).rejects.toThrow('地图 PNG 生成失败')
  })
  it('rejects a non-PNG encoder result',async()=>{
    encode=callback=>callback(new Blob(['jpeg'],{type:'image/jpeg'}))
    await expect(captureMapImage({canvas:canvas(),credits:[]})).rejects.toThrow('未返回 PNG 格式')
  })
  it('reports unsupported canvas and zero-sized views before PNG encoding',async()=>{
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null)
    await expect(captureMapImage({canvas:canvas(),credits:[]})).rejects.toThrow('无法生成地图 PNG')
    await expect(captureMapImage({canvas:canvas(0,600),credits:[]})).rejects.toThrow('尚未就绪')
    await expect(captureMapImage({canvas:canvas(800,600,0,300),credits:[]})).rejects.toThrow('尚未就绪')
    expect(encoded).toHaveLength(0)
  })
  it('reports tainted provider images clearly and clears the encoder timer',async()=>{
    vi.useFakeTimers();encode=()=>{throw new DOMException('Tainted canvas','SecurityError')}
    await expect(captureMapImage({canvas:canvas(),credits:[]})).rejects.toThrow('地图素材不允许导出')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a missing official MapTiler logo and removes image callbacks',async()=>{
    loadMode='error'
    await expect(captureMapImage({canvas:canvas(),credits:[],maptilerLogo:'https://api.maptiler.com/resources/logo.svg'})).rejects.toThrow('MapTiler 标志加载失败')
    expect(encoded).toHaveLength(0);expect(images[0].onload).toBeNull();expect(images[0].onerror).toBeNull()
  })
  it('times out logo loading without leaving timers or callbacks',async()=>{
    vi.useFakeTimers();loadMode='pending'
    const pending=captureMapImage({canvas:canvas(),credits:[],maptilerLogo:'https://api.maptiler.com/resources/logo.svg'})
    const assertion=expect(pending).rejects.toThrow('MapTiler 标志加载超时')
    await vi.advanceTimersByTimeAsync(15001);await assertion
    expect(encoded).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);expect(images[0].onload).toBeNull()
  })
  it('times out a stalled PNG encoder and clears its timeout',async()=>{
    vi.useFakeTimers();encode=()=>{}
    const pending=captureMapImage({canvas:canvas(),credits:[]}), assertion=expect(pending).rejects.toThrow('地图 PNG 生成超时')
    await vi.advanceTimersByTimeAsync(15001);await assertion
    expect(encoded).toHaveLength(1);expect(vi.getTimerCount()).toBe(0)
  })
})
