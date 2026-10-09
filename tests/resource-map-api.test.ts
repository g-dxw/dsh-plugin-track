import {afterEach, describe, expect, it, vi} from 'vitest'
import {storeResourceMapImage} from '../src/client/resources-api.ts'
import {MAP_CAPTURE_MAX_BYTES, type ResourceMapView} from '../src/track/resources.ts'
import {API} from '../src/protocol.ts'

const requests: CaptureRequest[] = []
class CaptureRequest {
  method = ''; url = ''; headers: Record<string,string> = {}; upload = {}; body?: Blob
  status = 201; responseText = JSON.stringify({asset:{id:'saved-map'}})
  onload?: () => void; onerror?: () => void; onabort?: () => void
  constructor(){requests.push(this)}
  open(method:string,url:string){this.method=method;this.url=url}
  setRequestHeader(name:string,value:string){this.headers[name]=value}
  send(body:Blob){this.body=body}
}
afterEach(()=>{requests.splice(0);vi.unstubAllGlobals()})
function setup(){vi.stubGlobal('XMLHttpRequest',CaptureRequest);return new Blob(['png fixture'],{type:'image/png'})}

describe('map capture client upload',()=>{
  it('uploads selected map views as PNG bytes with the local write header and encoded track/image names',async()=>{
    const png=setup()
    for(const view of ['map','terrain','sandbox'] as ResourceMapView[]){
      const promise=storeResourceMapImage('track + 1','武功山/沙盘 ?#.png',view,png), request=requests.at(-1)!
      expect(request.method).toBe('POST');expect(request.body).toBe(png)
      expect(request.headers).toEqual({'x-cqai-track':'1','content-type':'image/png'})
      const url=new URL(request.url,'http://track.test')
      expect(url.pathname).toBe(API+'/resource-map-image')
      expect([...url.searchParams]).toEqual([['id','track + 1'],['name','武功山/沙盘 ?#.png'],['view',view]])
      request.onload?.();await expect(promise).resolves.toMatchObject({id:'saved-map'})
    }
  })
  it('rejects wrong modes, empty/non-PNG data and bytes over the reference limit before sending requests',()=>{
    const png=setup()
    expect(()=>storeResourceMapImage('track','map','invalid' as ResourceMapView,png)).toThrow('视图类型无效')
    for(const body of [new Blob([],{type:'image/png'}),new Blob(['jpeg'],{type:'image/jpeg'}),{type:'image/png',size:MAP_CAPTURE_MAX_BYTES+1} as Blob]){
      expect(()=>storeResourceMapImage('track','map','map',body)).toThrow('10 MiB')
    }
    expect(requests).toEqual([])
  })
  it('reports resource service failures so saving can be retried',async()=>{
    const png=setup(), promise=storeResourceMapImage('track','map','sandbox',png), request=requests[0]
    request.status=503;request.responseText=JSON.stringify({error:'资源库暂不可写'});request.onload?.()
    await expect(promise).rejects.toThrow('资源库暂不可写')
  })
})
