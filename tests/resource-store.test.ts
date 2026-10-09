import sharp from 'sharp'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {Readable} from 'node:stream'
import type {IncomingMessage} from 'node:http'
import {writeTrack, trackDir} from '../src/artifacts.ts'
import {writePlacemarkPhoto} from '../src/placemark-photos-store.ts'
import {localPlacemarkPhoto} from '../src/track/placemark-photos.ts'
import {writePlacemarkEdits} from '../src/placemark-edits-store.ts'
import {readResources, uploadResource, updateResource, removeResource, upsertResourceJob, resourceFile} from '../src/resource-store.ts'
import type {TrackInput} from '../src/protocol.ts'
import {SVG_ANNOTATION_MAX_BYTES, RESOURCE_MAP_VIEW_LABELS, type ResourceMapView} from '../src/track/resources.ts'

const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) {if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-resource-store-')) throw new Error('Unexpected resource fixture'); rmSync(root,{recursive:true,force:true})}})
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const WAV = Buffer.alloc(84)
WAV.write('RIFF'); WAV.writeUInt32LE(76,4); WAV.write('WAVE',8); WAV.write('fmt ',12); WAV.writeUInt32LE(16,16); WAV.writeUInt16LE(1,20); WAV.writeUInt16LE(1,22); WAV.writeUInt32LE(8000,24); WAV.writeUInt32LE(16000,28); WAV.writeUInt16LE(2,32); WAV.writeUInt16LE(16,34); WAV.write('data',36); WAV.writeUInt32LE(40,40)
const input: TrackInput = {filename:'original.gpx',source:'<gpx>retained source</gpx>',points:[[120,30,100,null],[120.01,30,110,null]],metrics:{distance:1000,elevationGain:10,elevationLoss:0,duration:0,elevationMax:110,elevationMin:100,bbox:[120,30,120.01,30]},placemarks:[{id:'point-1',name:'营地',coordinates:[120,30],description:'',images:[]}]}
function fixture() {const root=mkdtempSync(join(tmpdir(),'cqai-resource-store-'));roots.push(root);const env={...process.env,DSH_HOME:root},track=writeTrack(input,env);return {env,id:track.id,dir:trackDir(track.id,env)}}
function request(bytes: Buffer, mime: string): IncomingMessage {const stream=Readable.from([bytes.subarray(0,10),bytes.subarray(10,60),bytes.subarray(60)]) as unknown as IncomingMessage;stream.headers={'content-type':mime};return stream}

describe('independent track resource store',()=>{
  it('streams and deduplicates media while retaining original route/source bytes and metadata after reopen',async()=>{
    const {env,id,dir}=fixture(), before=['track.json','source.gpx'].map(file=>readFileSync(join(dir,file)))
    const audio=await uploadResource(id,request(WAV,'audio/wav'),{name:'营地环境声',kind:'audio'},env)
    expect(audio.kind).toBe('audio');expect(audio.bytes).toBe(WAV.length);expect(audio.sourceUrl).toBeUndefined()
    expect((await uploadResource(id,request(WAV,'audio/wav'),{name:'重复录音',kind:'audio'},env)).id).toBe(audio.id)
    const updated=updateResource(id,audio.id,{tags:['营地','夜晚'],metadata:{duration:.0025,sampleRate:8000,channels:1},videoRole:'ambient'},env)
    expect(updated.usages).toMatchObject([{kind:'video',id:'selected-materials'}])
    expect(readResources(id,env).assets[0]).toMatchObject({id:audio.id,name:'营地环境声',videoRole:'ambient',metadata:{duration:.0025}})
    expect(()=>removeResource(id,audio.id,env)).toThrow('仍被')
    updateResource(id,audio.id,{videoRole:null,name:'真实环境声'},env)
    expect(readResources(id,env).assets[0].usages).toEqual([])
    const file=await resourceFile(id,audio.id,env);expect(readFileSync(file.path!)).toEqual(WAV)
    removeResource(id,audio.id,env);expect(readResources(id,env).assets).toEqual([])
    expect(readdirSync(join(dir,'media'))).toEqual([])
    for(let i=0;i<before.length;i++)expect(readFileSync(join(dir,['track.json','source.gpx'][i]))).toEqual(before[i])
  })
  it('aggregates current local/link photos without moving originals and protects live point references',()=>{
    const {env,id,dir}=fixture(), source='https://photos.example/camp.png',local=writePlacemarkPhoto(id,PNG,'image/png',env).url
    writePlacemarkEdits(id,[{id:'point-1',images:[local,source]}],env)
    const assets=readResources(id,env).assets;expect(assets).toHaveLength(2)
    const photo=assets.find(asset=>asset.sourceUrl===local)!;expect(photo).toMatchObject({kind:'image',status:'ready',usages:[{kind:'placemark',id:'point-1',name:'营地'}]})
    expect(assets.find(asset=>asset.sourceUrl===source)).toMatchObject({status:'pending',source:'existing-photo'})
    updateResource(id,photo.id,{name:'营地原照片',tags:['原图']},env)
    expect(()=>removeResource(id,photo.id,env)).toThrow('仍被')
    writePlacemarkEdits(id,[{id:'point-1',images:[]}],env);removeResource(id,photo.id,env)
    expect(readdirSync(join(dir,'placemark-photos'))).toHaveLength(1)
    expect(readResources(id,env).assets.some(asset=>asset.id===photo.id)).toBe(false)
  })
  it('marks missing saved local photos unavailable without fetching existing remote photo links',()=>{
    const {id,env,dir}=fixture(),local=writePlacemarkPhoto(id,PNG,'image/png',env).url,remote='https://photos.example/camp.png'
    writePlacemarkEdits(id,[{id:'point-1',images:[local,remote]}],env)
    const file=join(dir,'placemark-photos',localPlacemarkPhoto(local)!.filename),original=readFileSync(file),fetch=vi.spyOn(globalThis,'fetch')
    try {
      unlinkSync(file)
      const assets=readResources(id,env).assets
      expect(assets.find(asset=>asset.sourceUrl===local)).toMatchObject({source:'existing-photo',status:'error',error:'图片原始文件不存在或内容已改变'})
      expect(assets.find(asset=>asset.sourceUrl===remote)?.status).toBe('pending')
      expect(fetch).not.toHaveBeenCalled()
      writeFileSync(file,original)
      const recovered=readResources(id,env).assets.find(asset=>asset.sourceUrl===local)!
      expect(recovered.status).toBe('ready');expect(recovered.error).toBeUndefined()
    } finally {fetch.mockRestore()}
  })
  it('freezes submitted job ownership, stores local candidates once, and retains result metadata across task updates',async()=>{
    const {env,id,dir}=fixture(), original=await uploadResource(id,request(PNG,'image/png'),{name:'原照片',kind:'image'},env)
    const job={id:'job-1',trackId:id,sourceAssetId:original.id,mode:'edit',prompt:'只改善曝光，保留场景',model:'已选模型',status:'submitting',resultsPersisted:false}
    expect(upsertResourceJob(id,job,env)).toMatchObject({resultAssetIds:[],status:'submitting'})
    const queued=upsertResourceJob(id,{...job,status:'queued',hostTaskId:'host-1'},env)
    upsertResourceJob(id,{...queued,status:'unknown',error:'查询暂时失败'},env)
    expect(upsertResourceJob(id,{...queued,status:'running'},env).error).toBeUndefined()
    expect(()=>upsertResourceJob(id,{...queued,prompt:'改变地形'},env)).toThrow('不能改写')
    expect(()=>upsertResourceJob(id,{...queued,trackId:'different'},env)).toThrow('信息无效')
    expect(()=>upsertResourceJob(id,{...queued,hostTaskId:'host-2'},env)).toThrow('不能改写')
    const result=await uploadResource(id,request(PNG,'image/png'),{name:'自然调色候选',kind:'image',jobId:job.id,parentAssetId:original.id},env)
    expect(result).toMatchObject({candidate:true,source:'ai-edit',parentAssetId:original.id,jobId:job.id,sourceUrl:original.sourceUrl})
    expect((await uploadResource(id,request(PNG,'image/png'),{name:'同一结果重试',jobId:job.id},env)).id).toBe(result.id)
    expect(readdirSync(join(dir,'placemark-photos'))).toHaveLength(1)
    const complete=upsertResourceJob(id,{...queued,status:'completed',resultAssetIds:[],resultsPersisted:true},env);expect(complete.resultAssetIds).toEqual([result.id])
    updateResource(id,result.id,{candidate:false},env);expect(readResources(id,env).assets.find(asset=>asset.id===result.id)?.candidate).toBe(false)
    removeResource(id,result.id,env);expect(readResources(id,env).jobs[0].resultAssetIds).toEqual([]);expect(readResources(id,env).jobs[0].resultsPersisted).toBe(true)
  })
  it('rejects nonmedia, wrong media types, cross-track AI sources and unsafe identifiers without registering assets',async()=>{
    const {env,id,dir}=fixture()
    await expect(uploadResource(id,request(PNG,'video/mp4'),{name:'错误格式',kind:'video'},env)).rejects.toThrow('不匹配')
    await expect(uploadResource(id,request(Buffer.from('<script>alert(1)</script>'),'audio/mpeg'),{name:'脚本',kind:'audio'},env)).rejects.toThrow('不匹配')
    expect(()=>updateResource(id,'../../outside',{},env)).toThrow('编号无效')
    expect(()=>upsertResourceJob(id,{id:'job-2',trackId:id,sourceAssetId:'missing',mode:'edit',prompt:'调整',model:'模型',status:'queued'},env)).toThrow('不存在')
    expect(readResources(id,env).assets).toEqual([]);expect(readdirSync(join(dir,'media'))).toEqual([])
  })

  it('stores annotation PNG snapshots independently from imported and AI images and deduplicates matching snapshots after reopen',async()=>{
    const {env,id,dir}=fixture(), before=['track.json','source.gpx'].map(file=>readFileSync(join(dir,file)))
    const imported=await uploadResource(id,request(PNG,'image/png'),{name:'普通导入图片',kind:'image'},env)
    const snapshot=await uploadResource(id,request(PNG,'image/png'),{name:'营地-SVG 标注.png',kind:'image',annotation:true},env)
    expect(snapshot).toMatchObject({source:'svg-annotation',candidate:false,tags:['SVG标注'],status:'ready',mime:'image/png',metadata:{width:1,height:1}})
    expect(snapshot.id).not.toBe(imported.id);expect(snapshot.sourceUrl).toBe(imported.sourceUrl)
    const repeated=await Promise.all([1,2,3].map(()=>uploadResource(id,request(PNG,'image/png'),{name:'保存重试',annotation:true},env)))
    expect(repeated.map(asset=>asset.id)).toEqual([snapshot.id,snapshot.id,snapshot.id])
    expect((await uploadResource(id,request(PNG,'image/png'),{name:'再次导入',kind:'image'},env)).id).toBe(imported.id)
    const job=upsertResourceJob(id,{id:'job-annotation',trackId:id,mode:'edit',sourceAssetId:snapshot.id,prompt:'用轨迹标注图生成旅行海报',model:'image-model',status:'queued'},env)
    const result=await uploadResource(id,request(PNG,'image/png'),{name:'生成结果',jobId:job.id},env)
    expect(result.id).not.toBe(snapshot.id);expect(result.source).toBe('ai-edit')
    expect(readResources(id,env).assets).toHaveLength(3)
    expect(readResources(id,env).assets.find(asset=>asset.id===snapshot.id)?.metadata).toEqual({width:1,height:1})
    expect((await resourceFile(id,snapshot.id,env)).body).toEqual(PNG)
    expect(readdirSync(join(dir,'placemark-photos'))).toHaveLength(1);expect(readdirSync(join(dir,'media'))).toEqual([])
    for(let i=0;i<before.length;i++)expect(readFileSync(join(dir,['track.json','source.gpx'][i]))).toEqual(before[i])
  })
  it('keeps changed annotation snapshots immutable, scoped to their track and protected while used by a running task',async()=>{
    const {env,id}=fixture(), first=await uploadResource(id,request(PNG,'image/png'),{name:'标注初版',annotation:true},env)
    upsertResourceJob(id,{id:'job-original-annotation',trackId:id,mode:'edit',sourceAssetId:first.id,prompt:'根据标注图重绘',model:'image-model',status:'running'},env)
    const changedPNG=await sharp({create:{width:2,height:2,channels:3,background:'#2980b9'}}).png().toBuffer()
    const changed=await uploadResource(id,request(changedPNG,'image/png'),{name:'标注调整版',annotation:true},env)
    expect(changed.id).not.toBe(first.id);expect(changed.metadata).toEqual({width:2,height:2})
    expect((await resourceFile(id,first.id,env)).body).toEqual(PNG)
    expect(readResources(id,env).jobs[0].sourceAssetId).toBe(first.id)
    expect(()=>removeResource(id,first.id,env)).toThrow('未结束')
    const other=writeTrack({...input,filename:'other.gpx'},env)
    const otherSnapshot=await uploadResource(other.id,request(PNG,'image/png'),{name:'另一轨迹的标注',annotation:true},env)
    expect(otherSnapshot.trackId).toBe(other.id);expect(otherSnapshot.sourceUrl).not.toBe(first.sourceUrl)
    await expect(resourceFile(other.id,first.id,env)).rejects.toMatchObject({status:404})
    removeResource(id,changed.id,env)
    const restored=await uploadResource(id,request(changedPNG,'image/png'),{name:'再次保存标注',annotation:true},env)
    expect(restored.id).not.toBe(changed.id);expect(restored.status).toBe('ready')
    expect(readResources(id,env).assets.map(asset=>asset.id)).toEqual([first.id,restored.id])
  })
  it('rejects invalid, oversized or non-PNG annotation snapshots before registering image bytes and cleans temporary uploads',async()=>{
    const {env,id,dir}=fixture()
    const jpeg=await sharp({create:{width:1,height:1,channels:3,background:'#000'}}).jpeg().toBuffer()
    await expect(uploadResource(id,request(jpeg,'image/jpeg'),{name:'错误格式',annotation:true},env)).rejects.toMatchObject({status:415})
    await expect(uploadResource(id,request(PNG.subarray(0,33),'image/png'),{name:'破损PNG',annotation:true},env)).rejects.toMatchObject({status:415})
    const huge=Buffer.from(PNG);huge.writeUInt32BE(100000,16);huge.writeUInt32BE(100000,20)
    await expect(uploadResource(id,request(huge,'image/png'),{name:'像素过大',annotation:true},env)).rejects.toMatchObject({status:413})
    await expect(uploadResource(id,request(Buffer.concat([PNG,Buffer.alloc(SVG_ANNOTATION_MAX_BYTES)]),'image/png'),{name:'字节过大',annotation:true},env)).rejects.toMatchObject({status:413})
    await expect(uploadResource(id,request(PNG,'image/png'),{name:'任务混用',annotation:true,jobId:'unknown'},env)).rejects.toThrow('独立 PNG')
    expect(readResources(id,env).assets).toEqual([]);expect(readdirSync(join(dir,'media'))).toEqual([])
    expect(()=>readdirSync(join(dir,'placemark-photos'))).toThrow()
  })
  it('stores each map view as a separate immutable PNG and deduplicates retries independently of edited names and tags',async()=>{
    const {env,id,dir}=fixture(), before=['track.json','source.gpx'].map(file=>readFileSync(join(dir,file)))
    const captures=[]
    for(const mapView of ['map','terrain','sandbox'] as ResourceMapView[]){
      const capture=await uploadResource(id,request(PNG,'image/png'),{name:`营地-${RESOURCE_MAP_VIEW_LABELS[mapView]}.png`,mapView},env)
      expect(capture).toMatchObject({trackId:id,source:'map-capture',mapView,kind:'image',mime:'image/png',candidate:false,tags:[RESOURCE_MAP_VIEW_LABELS[mapView]],metadata:{width:1,height:1}})
      captures.push(capture)
      updateResource(id,capture.id,{name:'已编辑的名称',tags:['封面']},env)
      const retries=await Promise.all([1,2].map(()=>uploadResource(id,request(PNG,'image/png'),{name:'重试',mapView},env)))
      expect(retries.map(asset=>asset.id)).toEqual([capture.id,capture.id])
    }
    expect(new Set(captures.map(asset=>asset.id)).size).toBe(3)
    expect(new Set(captures.map(asset=>asset.sourceUrl)).size).toBe(1)
    const imported=await uploadResource(id,request(PNG,'image/png'),{name:'普通 PNG',kind:'image'},env)
    const annotation=await uploadResource(id,request(PNG,'image/png'),{name:'SVG PNG',annotation:true},env)
    expect(captures.some(asset=>asset.id===imported.id||asset.id===annotation.id)).toBe(false)
    expect(imported.source).toBe('upload');expect(annotation.source).toBe('svg-annotation')
    expect(readResources(id,env).assets).toHaveLength(5)
    for(const capture of captures)expect((await resourceFile(id,capture.id,env)).body).toEqual(PNG)
    expect(readdirSync(join(dir,'placemark-photos'))).toHaveLength(1);expect(readdirSync(join(dir,'media'))).toEqual([])
    for(let i=0;i<before.length;i++)expect(readFileSync(join(dir,['track.json','source.gpx'][i]))).toEqual(before[i])
  })
  it('keeps changed map images and track scopes separate while original captures remain usable by AI tasks',async()=>{
    const {env,id}=fixture(), first=await uploadResource(id,request(PNG,'image/png'),{name:'沙盘初版',mapView:'sandbox'},env)
    upsertResourceJob(id,{id:'job-map-reference',trackId:id,mode:'edit',sourceAssetId:first.id,prompt:'按沙盘生成旅行海报',model:'image-model',status:'running'},env)
    const changedPNG=await sharp({create:{width:2,height:3,channels:3,background:'#2980b9'}}).png().toBuffer()
    const changed=await uploadResource(id,request(changedPNG,'image/png'),{name:'沙盘新视角',mapView:'sandbox'},env)
    expect(changed.id).not.toBe(first.id);expect(changed.metadata).toEqual({width:2,height:3})
    expect((await resourceFile(id,first.id,env)).body).toEqual(PNG)
    expect(()=>removeResource(id,first.id,env)).toThrow('未结束')
    const other=writeTrack({...input,filename:'other-map.gpx'},env)
    const otherMap=await uploadResource(other.id,request(PNG,'image/png'),{name:'另一轨迹的地图',mapView:'sandbox'},env)
    expect(otherMap.trackId).toBe(other.id);expect(otherMap.sourceUrl).not.toBe(first.sourceUrl)
    await expect(resourceFile(other.id,first.id,env)).rejects.toMatchObject({status:404})
    expect(readResources(id,env).jobs[0].sourceAssetId).toBe(first.id)
  })
  it('rejects invalid modes, mixed ownership, broken PNGs and oversized map captures without registering files',async()=>{
    const {env,id,dir}=fixture()
    await expect(uploadResource(id,request(PNG,'image/png'),{name:'错误模式',mapView:'__proto__' as ResourceMapView},env)).rejects.toThrow('视图类型无效')
    for(const options of [{mapView:'map',annotation:true},{mapView:'map',jobId:'unknown'},{mapView:'map',parentAssetId:'unknown'},{mapView:'map',kind:'video'}] as const){
      await expect(uploadResource(id,request(PNG,'image/png'),{name:'混用',...options},env)).rejects.toThrow('独立 PNG')
    }
    for(const mapView of ['map','terrain','sandbox'] as ResourceMapView[]){
      await expect(uploadResource(id,request(PNG.subarray(0,33),'image/png'),{name:'损坏',mapView},env)).rejects.toMatchObject({status:415})
      await expect(uploadResource(id,request(WAV,'audio/wav'),{name:'非 PNG',mapView},env)).rejects.toMatchObject({status:415})
    }
    const huge=Buffer.from(PNG);huge.writeUInt32BE(100000,16);huge.writeUInt32BE(100000,20)
    await expect(uploadResource(id,request(huge,'image/png'),{name:'像素过大',mapView:'map'},env)).rejects.toMatchObject({status:413})
    await expect(uploadResource(id,request(Buffer.concat([PNG,Buffer.alloc(SVG_ANNOTATION_MAX_BYTES)]),'image/png'),{name:'字节过大',mapView:'terrain'},env)).rejects.toMatchObject({status:413})
    expect(readResources(id,env).assets).toEqual([]);expect(readdirSync(join(dir,'media'))).toEqual([])
    expect(()=>readdirSync(join(dir,'placemark-photos'))).toThrow()
  })

})


