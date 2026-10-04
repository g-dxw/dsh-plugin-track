import { File as NodeFile } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API } from '../src/protocol.ts'
import { uploadPlacemarkPhoto, validatePlacemarkPhotoFile } from '../src/client/placemark-photo.ts'
import { placemarkPhotoUrl, PLACEMARK_PHOTO_MAX_BYTES } from '../src/track/placemark-photos.ts'

const localUrl=placemarkPhotoUrl('track-1','a'.repeat(64)+'.jpg')
function photo(name='日出.jpg',type='image/jpeg'):File {return new NodeFile(['image bytes'],name,{type}) as unknown as File}
function json(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})

describe('local placemark photo upload client',()=>{
  it('posts original binary bytes with the write guard and returns a stable local reference',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(json({url:localUrl}))
    vi.stubGlobal('fetch',send)
    const file=photo()
    expect(await uploadPlacemarkPhoto('track-1',file)).toBe(localUrl)
    expect(send).toHaveBeenCalledWith(API+'/placemark-photos?id=track-1',{
      method:'POST',credentials:'same-origin',headers:{'content-type':'image/jpeg','x-cqai-track':'1'},body:file,
    })
  })
  it('allows an empty MIME type for server byte detection',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(json({url:localUrl}))
    vi.stubGlobal('fetch',send)
    const file=photo('image','')
    await uploadPlacemarkPhoto('track-1',file)
    expect(send.mock.calls[0][1]?.headers).toEqual({'content-type':'application/octet-stream','x-cqai-track':'1'})
    expect(send.mock.calls[0][1]?.body).toBe(file)
  })
  it.each(['size','empty','svg','html','other'] as const)('rejects unsuitable selections before calling the server (%s)',async(kind)=>{
    const file=kind==='svg'?photo('图.svg','image/svg+xml'):kind==='html'?photo('网页.html','text/html'):kind==='other'?photo('文档.pdf','application/pdf'):photo()
    if(kind==='size')Object.defineProperty(file,'size',{value:PLACEMARK_PHOTO_MAX_BYTES+1})
    if(kind==='empty')Object.defineProperty(file,'size',{value:0})
    const send=vi.fn<typeof fetch>();vi.stubGlobal('fetch',send)
    await expect(uploadPlacemarkPhoto('track-1',file)).rejects.toThrow(kind==='size'?'20 MB':kind==='empty'?'为空':'请选择 JPEG')
    expect(send).not.toHaveBeenCalled()
  })
  it('accepts the 20 MB boundary and rejects active files even when their declared type claims JPEG',()=>{
    const boundary=photo();Object.defineProperty(boundary,'size',{value:PLACEMARK_PHOTO_MAX_BYTES})
    expect(()=>validatePlacemarkPhotoFile(boundary)).not.toThrow()
    expect(()=>validatePlacemarkPhotoFile(photo('spoof.svg','image/jpeg'))).toThrow('不支持 SVG')
    expect(()=>validatePlacemarkPhotoFile(photo('spoof.html','image/jpeg'))).toThrow('不支持 SVG')
  })
  it('preserves actionable backend errors',async()=>{
    vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockResolvedValue(json({error:'图片格式与内容不匹配，请重新导出图片'},415)))
    await expect(uploadPlacemarkPhoto('track-1',photo())).rejects.toThrow('图片格式与内容不匹配，请重新导出图片')
  })
  it('reports connection and service startup failures clearly',async()=>{
    const send=vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('<html>host</html>',{status:404,headers:{'content-type':'text/html'}}))
    vi.stubGlobal('fetch',send)
    await expect(uploadPlacemarkPhoto('track-1',photo())).rejects.toThrow('检查连接后重试')
    await expect(uploadPlacemarkPhoto('track-1',photo())).rejects.toThrow('重启应用')
  })
  it.each([
    {url:placemarkPhotoUrl('other-track','a'.repeat(64)+'.jpg')},
    {url:'https://example.com/image.jpg'},
    {url:'blob:local-preview'},
    {url:API+'/placemark-photo?id=track-1&photo=../../secret.jpg'},
    {url:localUrl+'&extra=1'},
    {},
  ])('rejects returned URLs outside this track local storage (%j)',async(result)=>{
    vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockResolvedValue(json(result)))
    await expect(uploadPlacemarkPhoto('track-1',photo())).rejects.toThrow('本地图片地址无效')
  })
  it('rejects invalid track IDs before uploading',async()=>{
    const send=vi.fn<typeof fetch>();vi.stubGlobal('fetch',send)
    await expect(uploadPlacemarkPhoto('../outside',photo())).rejects.toThrow('编号无效')
    expect(send).not.toHaveBeenCalled()
  })
})
