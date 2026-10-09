import {afterEach, describe, expect, it} from 'vitest'
import sharp from 'sharp'
import {mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {Readable} from 'node:stream'
import type {IncomingMessage} from 'node:http'
import {trackDir, writeTrack} from '../src/artifacts.ts'
import {localPlacemarkPhoto} from '../src/track/placemark-photos.ts'
import {readResources, removeResource, ResourceError, updateResource, uploadResource, upsertResourceJob} from '../src/resource-store.ts'
import type {TrackInput} from '../src/protocol.ts'
import type {ResourceJobReference, ResourceJobSettings} from '../src/track/resources.ts'

const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) {if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-resource-snapshots-')) throw new Error('Unexpected resource fixture'); rmSync(root,{recursive:true,force:true})}})
const input: TrackInput = {filename:'original.gpx',source:'<gpx>original route</gpx>',points:[[120,30,100,null],[120.01,30,110,null]],metrics:{distance:1000,elevationGain:10,elevationLoss:0,duration:0,elevationMax:110,elevationMin:100,bbox:[120,30,120.01,30]},placemarks:[]}
const settings: ResourceJobSettings = {size:'16:9',quality:'2k',n:2,detail:'high'}
function fixture() {const root=mkdtempSync(join(tmpdir(),'cqai-resource-snapshots-'));roots.push(root);const env={...process.env,DSH_HOME:root},track=writeTrack(input,env);return {env,id:track.id,dir:trackDir(track.id,env)}}
function request(body: Buffer, mime='image/png'): IncomingMessage {const req=Readable.from([body]) as unknown as IncomingMessage;req.headers={'content-type':mime};return req}
async function photo(id:string,env:NodeJS.ProcessEnv,name:string,color:string) {const body=await sharp({create:{width:2,height:2,channels:3,background:color}}).png().toBuffer();return uploadResource(id,request(body),{name,kind:'image'},env)}
function job(id:string,trackId:string,extra:Record<string,unknown>={}) {return {id,trackId,mode:'edit',prompt:'保留路线现场\n改善自然光线',model:'image-model',status:'submitting',resultsPersisted:false,...extra}}
function rejects(action:()=>unknown,status:number) {try {action();throw new Error('Expected resource validation failure')} catch(error) {expect(error).toBeInstanceOf(ResourceError);expect((error as ResourceError).status).toBe(status)}}

describe('immutable AI workspace input snapshots',()=>{
  it('persists ordered roles, original/submitted prompts, settings and provenance with the first subject as primary',async()=>{
    const {id,env}=fixture(),subject=await photo(id,env,'登山者','#447744'),second=await photo(id,env,'营地','#448888'),effect=await photo(id,env,'日落光效','#ee9944')
    const original=upsertResourceJob(id,job('historical-text',id,{mode:'text',prompt:'早晨山间薄雾',status:'completed'}),env)
    const references:ResourceJobReference[]=[{assetId:effect.id,role:'effect',name:effect.name},{assetId:subject.id,role:'subject',name:subject.name},{assetId:second.id,role:'subject',name:second.name}]
    const created=upsertResourceJob(id,job('multi-reference',id,{references,settings,submittedPrompt:'保留路线现场\n改善自然光线\n参考图1提供效果，参考图2和3提供主体',restoredFromJobId:original.id}),env)
    expect(created).toMatchObject({sourceAssetId:subject.id,references,settings,restoredFromJobId:original.id})
    expect(created.prompt).not.toBe(created.submittedPrompt)
    const queued=upsertResourceJob(id,{...created,status:'queued',hostTaskId:'host-multi'},env)
    const {references:ignoredReferences,settings:ignoredSettings,submittedPrompt:ignoredSubmitted,restoredFromJobId:ignoredOrigin,...oldCaller}=queued
    void ignoredReferences;void ignoredSettings;void ignoredSubmitted;void ignoredOrigin
    const running=upsertResourceJob(id,{...oldCaller,status:'running'},env)
    expect(running).toMatchObject({references,settings,submittedPrompt:created.submittedPrompt,restoredFromJobId:original.id,hostTaskId:'host-multi'})
    updateResource(id,subject.id,{name:'改名后登山者'},env)
    expect(readResources(id,env).jobs.find(item=>item.id===created.id)).toMatchObject({references,settings,prompt:created.prompt,submittedPrompt:created.submittedPrompt})
  })
  it('rejects snapshot changes to order, roles, names, settings, prompts and restore ancestry',async()=>{
    const {id,env}=fixture(),a=await photo(id,env,'主体','#112233'),b=await photo(id,env,'效果','#554433')
    upsertResourceJob(id,job('history-a',id,{mode:'text',status:'completed'}),env)
    upsertResourceJob(id,job('history-b',id,{mode:'text',status:'completed'}),env)
    const references:ResourceJobReference[]=[{assetId:a.id,role:'subject',name:a.name},{assetId:b.id,role:'effect',name:b.name}]
    const saved=upsertResourceJob(id,job('frozen',id,{references,settings,submittedPrompt:'实际提交提示词',restoredFromJobId:'history-a'}),env)
    const patches=[
      {references:[references[1],references[0]]},
      {references:[{...references[0],role:'effect'},references[1]]},
      {references:[{...references[0],name:'篡改来源名称'},references[1]]},
      {references:[references[0]]},
      {settings:{...settings,n:3}},
      {submittedPrompt:'改变提交内容'},
      {prompt:'改变用户输入'},
      {restoredFromJobId:'history-b'},
      {model:'another-model'},
    ]
    for(const patch of patches)rejects(()=>upsertResourceJob(id,{...saved,...patch},env),409)
    expect(readResources(id,env).jobs.find(item=>item.id===saved.id)).toEqual(saved)
  })
  it('accepts effect-only edit and text without references while rejecting inconsistent modes or primary identity',async()=>{
    const {id,env}=fixture(),effect=await photo(id,env,'胶片光效','#778899')
    const references:ResourceJobReference[]=[{assetId:effect.id,role:'effect',name:effect.name}]
    expect(upsertResourceJob(id,job('effect-only',id,{references,settings}),env)).toMatchObject({mode:'edit',sourceAssetId:effect.id,references})
    expect(upsertResourceJob(id,job('pure-text',id,{mode:'text',references:[],settings}),env)).toMatchObject({mode:'text',references:[]})
    rejects(()=>upsertResourceJob(id,job('text-with-ref',id,{mode:'text',references}),env),400)
    rejects(()=>upsertResourceJob(id,job('text-with-legacy',id,{mode:'text',sourceAssetId:effect.id}),env),400)
    rejects(()=>upsertResourceJob(id,job('empty-edit',id,{references:[]}),env),400)
    rejects(()=>upsertResourceJob(id,job('wrong-primary',id,{references,sourceAssetId:'different'}),env),409)
  })
  it('rejects missing, cross-track, non-image and duplicate references plus malformed snapshot settings',async()=>{
    const {id,env}=fixture(),a=await photo(id,env,'本轨迹图片','#114422'),other=writeTrack(input,env),foreign=await photo(other.id,env,'另一轨迹','#aa4477')
    const wav=Buffer.alloc(44);wav.write('RIFF');wav.writeUInt32LE(36,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36)
    const audio=await uploadResource(id,request(wav,'audio/wav'),{name:'环境声',kind:'audio'},env)
    for(const assetId of ['missing',foreign.id])rejects(()=>upsertResourceJob(id,job('invalid-ref',id,{references:[{assetId,role:'subject'}]}),env),404)
    rejects(()=>upsertResourceJob(id,job('audio-ref',id,{references:[{assetId:audio.id,role:'effect'}]}),env),400)
    for(const roles of [['subject','subject'],['subject','effect']])rejects(()=>upsertResourceJob(id,job('duplicate',id,{references:roles.map(role=>({assetId:a.id,role}))}),env),400)
    rejects(()=>upsertResourceJob(id,job('bad-role',id,{references:[{assetId:a.id,role:'background'}]}),env),400)
    for(const n of [0,5,1.5])rejects(()=>upsertResourceJob(id,job('bad-settings',id,{references:[{assetId:a.id,role:'subject'}],settings:{...settings,n}}),env),400)
    rejects(()=>upsertResourceJob(id,job('missing-settings',id,{references:[{assetId:a.id,role:'subject'}],settings:{n:1}}),env),400)
    rejects(()=>upsertResourceJob(id,job('missing-history',id,{references:[{assetId:a.id,role:'subject'}],restoredFromJobId:'no-job'}),env),404)
    expect(readResources(id,env).jobs).toEqual([])
  })
  it('protects every active subject/effect reference and releases them after the job terminates',async()=>{
    const {id,env}=fixture(),a=await photo(id,env,'主体A','#112211'),b=await photo(id,env,'主体B','#334433'),effect=await photo(id,env,'效果','#667766')
    const saved=upsertResourceJob(id,job('active',id,{status:'unknown',references:[{assetId:a.id,role:'subject'},{assetId:b.id,role:'subject'},{assetId:effect.id,role:'effect'}]}),env)
    for(const asset of [a,b,effect])rejects(()=>removeResource(id,asset.id,env),409)
    upsertResourceJob(id,{...saved,status:'failed',error:'模型拒绝请求'},env)
    for(const asset of [a,b,effect])removeResource(id,asset.id,env)
    expect(readResources(id,env).assets).toEqual([])
    rejects(()=>upsertResourceJob(id,{...saved,status:'submitting'},env),409)
    expect(readResources(id,env).jobs[0].references).toHaveLength(3)
  })
  it('syncs completed historical jobs after source deletion and keeps derivative lineage without accepting new invalid jobs',async()=>{
    const {id,env}=fixture(),subject=await photo(id,env,'旧主体','#221144'),effect=await photo(id,env,'旧效果','#553377')
    const saved=upsertResourceJob(id,job('completed-history',id,{references:[{assetId:effect.id,role:'effect',name:effect.name},{assetId:subject.id,role:'subject',name:subject.name}],settings,submittedPrompt:'提交内容',status:'completed'}),env)
    removeResource(id,subject.id,env);removeResource(id,effect.id,env)
    expect(upsertResourceJob(id,{...saved,status:'completed',error:'下载结果暂时失败'},env)).toMatchObject({sourceAssetId:subject.id,references:saved.references,error:'下载结果暂时失败'})
    const body=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer()
    const result=await uploadResource(id,request(body),{name:'延迟下载候选',jobId:saved.id,parentAssetId:subject.id},env)
    expect(result).toMatchObject({parentAssetId:subject.id,jobId:saved.id,source:'ai-edit',candidate:true})
    expect(upsertResourceJob(id,{...saved,status:'completed',resultsPersisted:true},env)).toMatchObject({resultsPersisted:true,resultAssetIds:[result.id]})
    rejects(()=>upsertResourceJob(id,{...saved,id:'new-from-missing',status:'submitting',restoredFromJobId:saved.id},env),404)
    expect(readResources(id,env).jobs[0].error).toBeUndefined()
  })
  it('keeps legacy one-photo records readable and syncable after their source is removed',async()=>{
    const {id,env}=fixture(),source=await photo(id,env,'旧版照片','#99aaaa')
    const old=upsertResourceJob(id,job('legacy',id,{sourceAssetId:source.id,status:'completed'}),env)
    expect(old.references).toBeUndefined();expect(old.settings).toBeUndefined();expect(old.submittedPrompt).toBeUndefined()
    removeResource(id,source.id,env)
    expect(readResources(id,env).jobs[0]).toMatchObject(old)
    expect(upsertResourceJob(id,{...old,error:'稍后重试下载'},env)).toMatchObject({sourceAssetId:source.id,status:'completed'})
    rejects(()=>upsertResourceJob(id,job('new-legacy',id,{sourceAssetId:source.id}),env),404)
  })
  it('reports missing/corrupted local sources before submission while keeping historical snapshots recoverable',async()=>{
    const {id,env,dir}=fixture(),source=await photo(id,env,'本地原图','#445511')
    const saved=upsertResourceJob(id,job('local-history',id,{references:[{assetId:source.id,role:'subject',name:source.name}],status:'completed'}),env)
    const local=localPlacemarkPhoto(source.sourceUrl)!,path=join(dir,'placemark-photos',local.filename),original=readFileSync(path)
    unlinkSync(path)
    expect(readResources(id,env).assets[0]).toMatchObject({id:source.id,status:'error',error:'图片原始文件不存在或内容已改变'})
    rejects(()=>upsertResourceJob(id,job('missing-new',id,{references:saved.references}),env),409)
    expect(upsertResourceJob(id,{...saved,error:'结果暂待下载'},env)).toMatchObject({status:'completed',references:saved.references})
    updateResource(id,source.id,{name:'待补回照片'},env)
    writeFileSync(path,original)
    expect(readResources(id,env).assets[0]).toMatchObject({id:source.id,status:'ready',name:'待补回照片'})
    expect(readResources(id,env).assets[0].error).toBeUndefined()
    writeFileSync(path,Buffer.concat([original,Buffer.from('modified')]))
    expect(readResources(id,env).assets[0].status).toBe('error')
    expect(readResources(id,env).jobs[0].references).toEqual(saved.references)
  })
  it('rejects corrupt persisted reference snapshots without resolving deleted historical files',async()=>{
    const {id,env,dir}=fixture(),source=await photo(id,env,'历史来源','#bbccaa')
    const saved=upsertResourceJob(id,job('corrupt',id,{references:[{assetId:source.id,role:'subject'}],status:'completed'}),env)
    removeResource(id,source.id,env)
    expect(readResources(id,env).jobs[0]).toMatchObject(saved)
    const path=join(dir,'resources.json'),index=JSON.parse(readFileSync(path,'utf8'))
    index.jobs[0].references.push({...index.jobs[0].references[0],role:'effect'})
    writeFileSync(path,JSON.stringify(index))
    rejects(()=>readResources(id,env),500)
  })
})



