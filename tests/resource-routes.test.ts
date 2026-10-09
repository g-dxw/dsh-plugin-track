import {Context} from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {afterEach, describe, expect, it} from 'vitest'
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {request} from 'node:http'
import * as plugin from '../src/index.ts'
import {writeTrack, trackDir} from '../src/artifacts.ts'
import {API, type TrackInput} from '../src/protocol.ts'
import {RESOURCE_LIMITS, SVG_ANNOTATION_MAX_BYTES, RESOURCE_MAP_VIEW_LABELS, type ResourceMapView, type ResourceAsset} from '../src/track/resources.ts'
import {resourceRange} from '../src/resource-routes.ts'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0)){if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('cqai-resource-routes-'))throw new Error('Unexpected resource fixture');rmSync(root,{recursive:true,force:true})}})
const input:TrackInput={filename:'original.gpx',source:'<gpx>original</gpx>',points:[[120,30,100,null],[120.01,30,110,null]],metrics:{distance:1000,elevationGain:10,elevationLoss:0,duration:0,elevationMax:110,elevationMin:100,bbox:[120,30,120.01,30]}}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
const MP4=Buffer.alloc(96);MP4.writeUInt32BE(24,0);MP4.write('ftyp',4);MP4.write('isom',8);MP4.write('isom',16);MP4.write('mp42',20);MP4.writeUInt32BE(72,24);MP4.write('mdat',28)
async function withServer(run:(base:string,id:string,dir:string)=>Promise<void>){const root=mkdtempSync(join(tmpdir(),'cqai-resource-routes-'));roots.push(root);const previous=process.env.DSH_HOME;process.env.DSH_HOME=root;const ctx=new Context();try{const {id}=writeTrack(input);await ctx.plugin(WebServer,{host:'127.0.0.1',port:0});await ctx.plugin(plugin);await run(`http://127.0.0.1:${ctx.webServer.port}`,id,trackDir(id))}finally{await ctx.fiber.dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous}}
function post(base:string,path:string,body:unknown){return fetch(base+API+'/'+path,{method:'POST',headers:{'x-cqai-track':'1','content-type':'application/json'},body:JSON.stringify(body)})}
function upload(base:string,id:string,bytes:Buffer,mime:string,kind:string){return fetch(`${base}${API}/resource-upload?id=${id}&name=${encodeURIComponent('山路原素材')}&kind=${kind}`,{method:'POST',headers:{'x-cqai-track':'1','content-type':mime},body:new Uint8Array(bytes)})}
function declaredOversize(url:string,size:number,mime='video/mp4'):Promise<number>{return new Promise((resolveStatus,reject)=>{const req=request(url,{method:'POST',headers:{'x-cqai-track':'1','content-length':String(size),'content-type':mime}},res=>{res.resume();res.on('end',()=>resolveStatus(res.statusCode!));res.on('error',reject)});req.on('error',reject);req.end()})}

describe('resource HTTP transport',()=>{
  it('serves streamed video bytes with seekable GET/HEAD, exact lengths and bounded/suffix range semantics',async()=>withServer(async(base,id)=>{
    const response=await upload(base,id,MP4,'video/mp4','video');expect(response.status).toBe(201);const {asset}=await response.json() as {asset:ResourceAsset}
    const full=await fetch(base+asset.url);expect(full.status).toBe(200);expect(full.headers.get('accept-ranges')).toBe('bytes');expect(full.headers.get('x-content-type-options')).toBe('nosniff');expect(Buffer.from(await full.arrayBuffer())).toEqual(MP4)
    const head=await fetch(base+asset.url,{method:'HEAD'});expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBe(String(MP4.length));expect((await head.arrayBuffer()).byteLength).toBe(0)
    for(const [range,start,end] of [['bytes=4-11',4,11],['bytes=80-',80,95],['bytes=-8',88,95],['bytes=90-999',90,95]] as const){const partial=await fetch(base+asset.url,{headers:{range}});expect(partial.status).toBe(206);expect(partial.headers.get('content-range')).toBe(`bytes ${start}-${end}/${MP4.length}`);expect(Buffer.from(await partial.arrayBuffer())).toEqual(MP4.subarray(start,end+1))}
    for(const range of ['bytes=100-','bytes=10-2','bytes=0-1,4-5','bytes=-0','words=1-2']){const invalid=await fetch(base+asset.url,{headers:{range}});expect(invalid.status).toBe(416);expect(invalid.headers.get('content-range')).toBe(`bytes */${MP4.length}`)}
  }),30000)
  it('enforces origin/write gates, indexes all three kinds independently and protects selected video roles until released',async()=>withServer(async(base,id,dir)=>{
    const address=`${base}${API}/resource-upload?id=${id}&name=test&kind=image`
    expect((await fetch(address,{method:'POST',headers:{'content-type':'image/png'},body:PNG})).status).toBe(403)
    expect((await fetch(address,{method:'POST',headers:{'x-cqai-track':'1',origin:'https://evil.example'},body:PNG})).status).toBe(403)
    const {asset}=await (await upload(base,id,PNG,'image/png','image')).json() as {asset:ResourceAsset};expect(asset.sourceUrl).toContain('/placemark-photo?')
    expect((await fetch(base+asset.url,{headers:{origin:'https://evil.example'}})).status).toBe(403)
    expect((await fetch(base+asset.url+'&&assetId=wrong')).status).toBe(400)
    const update=await post(base,`resource-update?id=${id}`,{assetId:asset.id,patch:{name:'封面候选',tags:['封面'],videoRole:'image-insert'}});expect(update.status).toBe(200)
    const remove=()=>fetch(`${base}${API}/resource?id=${id}&assetId=${asset.id}`,{method:'DELETE',headers:{'x-cqai-track':'1'}})
    expect((await remove()).status).toBe(409)
    expect((await post(base,`resource-update?id=${id}`,{assetId:asset.id,patch:{videoRole:null}})).status).toBe(200);expect((await remove()).status).toBe(200)
    expect((await fetch(base+asset.url)).status).toBe(404)
    expect(readdirSync(join(dir,'placemark-photos'))).toHaveLength(1)
    expect((await post(base,`resource-update?id=${id}`,{assetId:'missing',patch:{filename:'../../outside'}})).status).toBe(400)
  }),30000)
  it('rejects declared oversized media before creating uploads and ignores unsafe client filenames',async()=>withServer(async(base,id,dir)=>{
    expect(await declaredOversize(`${base}${API}/resource-upload?id=${id}&kind=video&name=test`,RESOURCE_LIMITS.video+1)).toBe(413)
    expect(existsSync(join(dir,'media'))).toBe(false)
    const uploadURL=`${base}${API}/resource-upload?id=${id}&kind=video&name=${encodeURIComponent('../../outside.mp4')}`
    expect((await fetch(uploadURL,{method:'POST',headers:{'x-cqai-track':'1','content-type':'video/mp4'},body:MP4})).status).toBe(201)
    expect(readdirSync(join(dir,'media')).every(file=>/^[a-f0-9]{64}\.mp4$/u.test(file))).toBe(true)
    expect((await fetch(`${base}${API}/resource-file?id=${id}&assetId=..%2Foutside`)).status).toBe(400)
    expect((await fetch(`${base}${API}/resources?id=missing`)).status).toBe(404)
  }),30000)
  it('validates range arithmetic without unsafe integers',()=>{expect(resourceRange(undefined,30)).toBeNull();expect(resourceRange('bytes=-500',30)).toEqual({start:0,end:29});expect(()=>resourceRange('bytes=9007199254740993-',30)).toThrow('范围无效');expect(()=>resourceRange('bytes=0-',0)).toThrow('范围无效')})

  it('adds a PNG annotation resource after saving the canvas, deduplicates retries, and serves the original image for later references',async()=>withServer(async(base,id,dir)=>{
    const before=['track.json','source.gpx'].map(file=>readFileSync(join(dir,file)))
    const save=await post(base,'annotations',{id,annotations:[{id:'manual-1',pointIndex:0,label:'起点',color:'#7c3aed',visible:true}],layout:{title:{x:80,y:100}},route:{x:25,y:30,scale:1.5}})
    expect(save.status).toBe(200)
    const annotations=readFileSync(join(dir,'annotations.json'))
    const address=`${base}${API}/resource-annotation?id=${id}&name=${encodeURIComponent('营地-SVG 标注.png')}`
    const upload=()=>fetch(address,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/png'},body:PNG})
    const response=await upload();expect(response.status).toBe(201)
    const {asset}=await response.json() as {asset:ResourceAsset}
    expect(asset).toMatchObject({name:'营地-SVG 标注.png',source:'svg-annotation',kind:'image',candidate:false,tags:['SVG标注'],metadata:{width:1,height:1}})
    expect((await (await upload()).json() as {asset:ResourceAsset}).asset.id).toBe(asset.id)
    const image=await fetch(base+asset.url);expect(image.headers.get('content-type')).toBe('image/png');expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
    expect((await fetch(base+asset.url,{method:'HEAD'})).headers.get('content-length')).toBe(String(PNG.length))
    const library=await (await fetch(`${base}${API}/resources?id=${id}`)).json() as {assets:ResourceAsset[]}
    expect(library.assets).toHaveLength(1);expect(library.assets[0].id).toBe(asset.id)
    expect(readFileSync(join(dir,'annotations.json'))).toEqual(annotations)
    for(let i=0;i<before.length;i++)expect(readFileSync(join(dir,['track.json','source.gpx'][i]))).toEqual(before[i])
  }),30000)
  it('keeps annotation upload behind existing local write gates and rejects spoofed format, repeated or unexpected query parameters',async()=>withServer(async(base,id,dir)=>{
    const address=`${base}${API}/resource-annotation?id=${id}`
    expect((await fetch(address,{method:'POST',headers:{'content-type':'image/png'},body:PNG})).status).toBe(403)
    expect((await fetch(address,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/png',origin:'https://evil.example'},body:PNG})).status).toBe(403)
    for(const suffix of ['&id='+id,'&name=a&name=b','&kind=video','&jobId=job-1','&source=ai-edit'])expect((await fetch(address+suffix,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/png'},body:PNG})).status).toBe(400)
    expect((await fetch(address,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/jpeg'},body:PNG})).status).toBe(415)
    expect((await fetch(address,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/png'},body:PNG.subarray(0,33)})).status).toBe(415)
    expect((await fetch(address,{method:'GET'})).status).toBe(405)
    expect((await fetch(`${base}${API}/resource-annotation?id=missing`,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/png'},body:PNG})).status).toBe(404)
    expect((await (await fetch(`${base}${API}/resources?id=${id}`)).json() as {assets:ResourceAsset[]}).assets).toEqual([])
    expect(readdirSync(join(dir,'media'))).toEqual([])
    expect(existsSync(join(dir,'placemark-photos'))).toBe(false)
  }),30000)
  it('rejects a declared annotation PNG exceeding the AI reference size before creating upload files',async()=>withServer(async(base,id,dir)=>{
    expect(await declaredOversize(`${base}${API}/resource-annotation?id=${id}`,SVG_ANNOTATION_MAX_BYTES+1,'image/png')).toBe(413)
    expect(existsSync(join(dir,'media'))).toBe(false);expect(existsSync(join(dir,'placemark-photos'))).toBe(false)
  }),30000)
  it('saves each selected map view as a track PNG with persistent metadata and independent retry deduplication',async()=>withServer(async(base,id,dir)=>{
    const before=['track.json','source.gpx'].map(file=>readFileSync(join(dir,file))), ids=[]
    for(const view of ['map','terrain','sandbox'] as ResourceMapView[]){
      const address=`${base}${API}/resource-map-image?id=${id}&view=${view}`
      const upload=()=>fetch(address,{method:'POST',headers:{'x-cqai-track':'1','content-type':'image/png'},body:PNG})
      const response=await upload();expect(response.status).toBe(201)
      const {asset}=await response.json() as {asset:ResourceAsset};ids.push(asset.id)
      expect(asset).toMatchObject({name:`${RESOURCE_MAP_VIEW_LABELS[view]}.png`,trackId:id,source:'map-capture',mapView:view,tags:[RESOURCE_MAP_VIEW_LABELS[view]],metadata:{width:1,height:1}})
      expect((await (await upload()).json() as {asset:ResourceAsset}).asset.id).toBe(asset.id)
      const image=await fetch(base+asset.url);expect(image.headers.get('content-type')).toBe('image/png');expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
    }
    expect(new Set(ids).size).toBe(3)
    const library=await (await fetch(`${base}${API}/resources?id=${id}`)).json() as {assets:ResourceAsset[]}
    expect(library.assets).toHaveLength(3)
    expect(library.assets.map(asset=>asset.mapView)).toEqual(['map','terrain','sandbox'])
    for(let i=0;i<before.length;i++)expect(readFileSync(join(dir,['track.json','source.gpx'][i]))).toEqual(before[i])
  }),30000)
  it('keeps map capture uploads behind local write gates and rejects missing modes, malformed queries and invalid content',async()=>withServer(async(base,id,dir)=>{
    const address=`${base}${API}/resource-map-image?id=${id}&view=map`
    const upload=(url:string,headers:Record<string,string>={'x-cqai-track':'1','content-type':'image/png'},body:Buffer=PNG)=>fetch(url,{method:'POST',headers,body})
    expect((await upload(address,{'content-type':'image/png'})).status).toBe(403)
    expect((await upload(address,{'x-cqai-track':'1','content-type':'image/png',origin:'https://evil.example'})).status).toBe(403)
    for(const query of [`id=${id}`,`id=${id}&view=invalid`,`id=${id}&view=map&view=terrain`,`id=${id}&view=map&id=${id}`,`id=${id}&view=map&name=a&name=b`,`id=${id}&view=map&jobId=unknown`,`id=${id}&view=map&kind=video`,`id=${id}&view=map&source=ai-edit`]){
      expect((await upload(`${base}${API}/resource-map-image?${query}`)).status).toBe(400)
    }
    expect((await upload(address,{'x-cqai-track':'1','content-type':'image/jpeg'})).status).toBe(415)
    expect((await upload(address,undefined,PNG.subarray(0,33))).status).toBe(415)
    expect((await fetch(address)).status).toBe(405)
    expect((await upload(`${base}${API}/resource-map-image?id=missing&view=map`)).status).toBe(404)
    expect((await (await fetch(`${base}${API}/resources?id=${id}`)).json() as {assets:ResourceAsset[]}).assets).toEqual([])
    expect(readdirSync(join(dir,'media'))).toEqual([]);expect(existsSync(join(dir,'placemark-photos'))).toBe(false)
  }),30000)
  it('rejects declared map PNGs over 10 MiB before opening upload files',async()=>withServer(async(base,id,dir)=>{
    for(const view of ['map','terrain','sandbox'])expect(await declaredOversize(`${base}${API}/resource-map-image?id=${id}&view=${view}`,SVG_ANNOTATION_MAX_BYTES+1,'image/png')).toBe(413)
    expect(existsSync(join(dir,'media'))).toBe(false);expect(existsSync(join(dir,'placemark-photos'))).toBe(false)
  }),30000)

})
