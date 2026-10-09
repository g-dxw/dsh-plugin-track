import {afterEach, describe, expect, it, vi} from 'vitest'
import sharp from 'sharp'
import {createHash} from 'node:crypto'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {Readable} from 'node:stream'
import type {IncomingMessage} from 'node:http'
import {readTrack, trackDir, writeTrack} from '../src/artifacts.ts'
import {completeTrackText, loadImagePromptModels, loadTextModels, type TrackAIAccount} from '../src/ai.ts'
import {optimizeImagePrompt, validateImagePromptRequest, validateImagePromptResult} from '../src/image-prompt-ai.ts'
import {uploadResource, readResources} from '../src/resource-store.ts'
import {readPlacemarkState, writePlacemarkState} from '../src/placemark-state-store.ts'
import {writePlacemarkPhoto} from '../src/placemark-photos-store.ts'
import {localPlacemarkPhoto} from '../src/track/placemark-photos.ts'
import type {TrackInput} from '../src/protocol.ts'
import {IMAGE_PROMPT_LIMITS, IMAGE_PROMPT_TIMEOUT_MS, type ImagePromptOptimizationRequest} from '../src/track/image-prompt.ts'

vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>()
  return {...actual,readFileSync:vi.fn(actual.readFileSync)}
})
const roots: string[] = []
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0)){if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('cqai-image-prompt-'))throw new Error('Unexpected optimization fixture');rmSync(root,{recursive:true,force:true})}})
const input:TrackInput={name:'用户保存的路线名',filename:'route.gpx',source:'NEVER-SEND-ORIGINAL-GPX',points:[[120,30,null,null],[120.01,30,110,1000]],metrics:{distance:1000,elevationGain:10,elevationLoss:0,duration:1000,elevationMax:110,elevationMin:100,bbox:[120,30,120.01,30]},placemarks:[{id:'point-1',name:'旧点位名',description:'旧的导入说明',coordinates:[120,30],images:[]},{id:'point-2',name:'已删除标注',description:'NEVER-SEND-DELETED-POINT',coordinates:[120.01,30],images:[]}]}
function fixture(){const root=mkdtempSync(join(tmpdir(),'cqai-image-prompt-'));roots.push(root);const env={...process.env,DSH_HOME:root},track=writeTrack(input,env);return{env,id:track.id,dir:trackDir(track.id,env)}}
function request(body:Buffer,mime='image/png'):IncomingMessage{const req=Readable.from([body]) as unknown as IncomingMessage;req.headers={'content-type':mime};return req}
async function image(id:string,env:NodeJS.ProcessEnv,name:string,color:string,width=2,height=2){const body=await sharp({create:{width,height,channels:3,background:color}}).png().toBuffer();return uploadResource(id,request(body),{name,kind:'image'},env)}
const models=[
  {id:'text-only',name:'文字模型',categories:['text'],supportedEndpointTypes:['openai'],architecture:{inputModalities:['text'],outputModalities:['text']}},
  {id:'vision',name:'图片理解模型',categories:['text-multimodal'],supportedEndpointTypes:['openai'],architecture:{inputModalities:['text','image'],outputModalities:['text']}},
  {id:'legacy-vision',categories:['text-multimodal'],supportedEndpointTypes:['openai']},
  {id:'contradictory',categories:['text-multimodal'],supportedEndpointTypes:['openai'],architecture:{inputModalities:['text'],outputModalities:['text']}},
  {id:'image-only',categories:['image'],supportedEndpointTypes:['openai'],architecture:{inputModalities:['text','image'],outputModalities:['image']}},
]
function completion(value:unknown,finish='stop'){return new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content:JSON.stringify(value)}}]}),{headers:{'content-type':'application/json'}})}
function account(){return{getStatus:vi.fn<TrackAIAccount['getStatus']>().mockResolvedValue({state:'signed-in'}),listModels:vi.fn<TrackAIAccount['listModels']>().mockResolvedValue({models}),getDefaultModel:vi.fn<TrackAIAccount['getDefaultModel']>().mockResolvedValue({provider:'cqai',model:'text-only'}),fetchAi:vi.fn<TrackAIAccount['fetchAi']>().mockResolvedValue(completion({prompt:'以当前徒步照片为主体，保留路线现场，参考效果图的暖色光影。',changes:['适配当前主体并保留风格目标']}))}}
function base(extra:Partial<ImagePromptOptimizationRequest>={}):ImagePromptOptimizationRequest{return{model:'vision',prompt:'模板要求：保留人物与自然山景，暖色光影。',requirements:'不新增人物，避免夸张天空。',references:[],...extra}}
function body(host:ReturnType<typeof account>){return JSON.parse(host.fetchAi.mock.calls[0][1]!.body as string)}

describe('prompt optimization model catalog',()=>{
  it('exposes official verified vision capability without changing the legacy text catalog',async()=>{
    const host=account(),catalog=await loadImagePromptModels(host)
    expect(catalog).toEqual({models:[{id:'text-only',label:'文字模型',supportsVision:false},{id:'vision',label:'图片理解模型',supportsVision:true},{id:'legacy-vision',label:'legacy-vision',supportsVision:true},{id:'contradictory',label:'contradictory',supportsVision:false}],defaultModel:'text-only',available:true})
    expect((await loadTextModels(host)).models).toEqual(catalog.models.map(({id,label})=>({id,label})))
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('does not fall back to a model name when modality evidence contradicts or is absent',async()=>{
    const host=account();host.listModels.mockResolvedValue({models:[{id:'gpt-vision-assumed',categories:['text'],supportedEndpointTypes:['openai']}]});host.getDefaultModel.mockResolvedValue({provider:'cqai',model:'gpt-vision-assumed'})
    expect((await loadImagePromptModels(host)).models[0].supportsVision).toBe(false)
    host.getStatus.mockResolvedValue({state:'signed-out'})
    expect(await loadImagePromptModels(host)).toMatchObject({models:[],available:false})
  })
})

describe('authoritative multimodal prompt adaptation',()=>{
  it('sends every real resized reference in exact order with edited point/group evidence and preserves all stored files',async()=>{
    const {id,env,dir}=fixture(),effect=await image(id,env,'效果图','#ee3311',4200,2100),subject=await image(id,env,'主体图','#117733',3200,3200)
    const previous=readPlacemarkState(id,env),groupId='group-11111111-1111-4111-8111-111111111111'
    writePlacemarkState(id,previous.revision,{...previous,deletedIds:['point-2'],edits:[{id:'point-1',name:'更新后点位名',description:'<p>用户标注的营地</p><script>NEVER-SEND-SCRIPT</script>',images:[subject.sourceUrl!]}],groups:[{id:groupId,name:'用户营地组',description:'<b>用户保存的分组说明</b>',coordinates:[120,30],memberIds:['point-1'],cover:{pointId:'point-1',imageUrl:subject.sourceUrl!}}]},env)
    const files=['track.json','source.gpx','resources.json','placemark-state.json'],before=files.map(name=>readFileSync(join(dir,name)))
    const host=account(),result=await optimizeImagePrompt(host,id,base({references:[{assetId:effect.id,role:'effect'},{assetId:subject.id,role:'subject'}]}),undefined,env)
    expect(result.changes).toHaveLength(1);expect(host.fetchAi).toHaveBeenCalledOnce()
    const call=body(host);expect(host.fetchAi.mock.calls[0][0]).toBe('/v1/chat/completions');expect(call.model).toBe('vision')
    const content=call.messages[1].content,context=JSON.parse(content[0].text)
    expect(content).toHaveLength(3);expect(context.references.map((item:{number:number;assetId:string;role:string})=>({number:item.number,assetId:item.assetId,role:item.role}))).toEqual([{number:1,assetId:effect.id,role:'effect'},{number:2,assetId:subject.id,role:'subject'}])
    expect(context.references[1]).toMatchObject({linkedPoints:[{id:'point-1',name:'更新后点位名',description:'用户标注的营地',labelSource:'user-saved-annotation'}],linkedGroups:[{id:groupId,name:'用户营地组',description:'用户保存的分组说明'}]})
    expect(context.track).toMatchObject({name:'用户保存的路线名',metrics:{distanceMeters:1000,durationMilliseconds:1000},dataCoverage:{elevation:.5,timestamps:.5}})
    expect(JSON.stringify(call)).not.toContain('NEVER-SEND-');expect(context.references[0]).not.toHaveProperty('sourceUrl');expect(context.track).not.toHaveProperty('coordinates')
    const red=Buffer.from(content[1].image_url.url.split(',')[1],'base64'),green=Buffer.from(content[2].image_url.url.split(',')[1],'base64')
    expect(await sharp(red).metadata()).toMatchObject({format:'jpeg',width:1280,height:640});expect(await sharp(green).metadata()).toMatchObject({format:'jpeg',width:1280,height:1280})
    const redPixels=await sharp(red).raw().toBuffer(),greenPixels=await sharp(green).raw().toBuffer();expect(redPixels[0]).toBeGreaterThan(redPixels[1]);expect(greenPixels[1]).toBeGreaterThan(greenPixels[0])
    expect((await sharp(red).metadata()).exif).toBeUndefined()
    for(let index=0;index<files.length;index++)expect(readFileSync(join(dir,files[index]))).toEqual(before[index])
  })
  it('reads only selected originals and never opens unrelated picture bytes during optimization',async()=>{
    const {id,env,dir}=fixture(),selected=await image(id,env,'所选主体','#994433'),unrelated=await image(id,env,'无关私有照片','#112244'),host=account()
    const unrelatedPath=join(dir,'placemark-photos',localPlacemarkPhoto(unrelated.sourceUrl)!.filename),selectedPath=join(dir,'placemark-photos',localPlacemarkPhoto(selected.sourceUrl)!.filename)
    vi.mocked(readFileSync).mockClear()
    await optimizeImagePrompt(host,id,base({references:[{assetId:selected.id,role:'subject'}]}),undefined,env)
    const paths=vi.mocked(readFileSync).mock.calls.map(([path])=>String(path))
    expect(paths).toContain(selectedPath);expect(paths).not.toContain(unrelatedPath)
    expect(body(host).messages[1].content).toHaveLength(2)
  })
  it('can adapt without photos through an ordinary text model and does not claim image analysis',async()=>{
    const {id,env}=fixture(),host=account()
    await optimizeImagePrompt(host,id,base({model:'text-only'}),undefined,env)
    const call=body(host);expect(typeof call.messages[1].content).toBe('string');expect(JSON.parse(call.messages[1].content).references).toEqual([])
    expect(call.messages[0].content).toContain('没有参考图时');expect(readResources(id,env).jobs).toEqual([])
  })
  it('analyzes all five selected references and explicitly rejects a sixth instead of dropping it',async()=>{
    const {id,env}=fixture(),assets=await Promise.all(['#ee1111','#11ee11','#1111ee','#aaaa11','#11aaaa'].map((color,index)=>image(id,env,'参考'+index,color))),host=account()
    const references=assets.map((asset,index)=>({assetId:asset.id,role:index<3 ? 'subject' as const:'effect' as const}))
    await optimizeImagePrompt(host,id,base({references}),undefined,env)
    expect(body(host).messages[1].content).toHaveLength(6)
    host.fetchAi.mockClear()
    await expect(optimizeImagePrompt(host,id,base({references:[...references,{assetId:'sixth',role:'subject'}]}),undefined,env)).rejects.toMatchObject({status:400})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('requires official vision evidence whenever pixels are present and never falls back to another model',async()=>{
    const {id,env}=fixture(),photo=await image(id,env,'主体','#884422'),host=account()
    for(const model of ['text-only','contradictory'])await expect(optimizeImagePrompt(host,id,base({model,references:[{assetId:photo.id,role:'subject'}]}),undefined,env)).rejects.toMatchObject({status:400,code:'ai-vision-unavailable'})
    await expect(optimizeImagePrompt(host,id,base({model:'missing'}),undefined,env)).rejects.toMatchObject({code:'ai-model-unavailable'})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('rejects missing, foreign, non-image and unreadable selected resources before any model call',async()=>{
    const {id,env,dir}=fixture(),photo=await image(id,env,'主体','#884466'),other=writeTrack(input,env),foreign=await image(other.id,env,'异轨迹','#446688'),host=account()
    for(const assetId of ['missing',foreign.id])await expect(optimizeImagePrompt(host,id,base({references:[{assetId,role:'subject'}]}),undefined,env)).rejects.toMatchObject({status:404})
    const mp4=Buffer.alloc(32);mp4.writeUInt32BE(24,0);mp4.write('ftyp',4);mp4.write('isom',8);mp4.write('isom',16)
    const video=await uploadResource(id,request(mp4,'video/mp4'),{name:'视频',kind:'video'},env)
    await expect(optimizeImagePrompt(host,id,base({references:[{assetId:video.id,role:'effect'}]}),undefined,env)).rejects.toMatchObject({status:400})
    const validPng=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer(),corrupt=await uploadResource(id,request(validPng.subarray(0,33)),{name:'无法解码的头部',kind:'image'},env)
    await expect(optimizeImagePrompt(host,id,base({references:[{assetId:photo.id,role:'subject'},{assetId:corrupt.id,role:'effect'}]}),undefined,env)).rejects.toMatchObject({status:409,code:'image-prompt-reference-unavailable'})
    unlinkSync(join(dir,'placemark-photos',localPlacemarkPhoto(photo.sourceUrl)!.filename))
    await expect(optimizeImagePrompt(host,id,base({references:[{assetId:photo.id,role:'subject'}]}),undefined,env)).rejects.toMatchObject({status:409})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('uses already cached original remote pixels rather than arbitrary client media URLs',async()=>{
    const {id,env,dir}=fixture(),source='https://photos.example/saved.png',imageBytes=await sharp({create:{width:40,height:20,channels:3,background:'#888822'}}).png().toBuffer(),local=writePlacemarkPhoto(id,imageBytes,'image/png',env).url
    const state=readPlacemarkState(id,env);writePlacemarkState(id,state.revision,{...state,edits:[{id:'point-1',images:[source]}]},env)
    const records=join(dir,'placemark-photo-assets');mkdirSync(records,{recursive:true});writeFileSync(join(records,createHash('sha256').update(source).digest('hex')+'.json'),JSON.stringify({version:1,source,status:'ready',originalFilename:localPlacemarkPhoto(local)!.filename}))
    const asset=readResources(id,env).assets[0],host=account(),fetch=vi.spyOn(globalThis,'fetch')
    await optimizeImagePrompt(host,id,base({references:[{assetId:asset.id,role:'subject'}]}),undefined,env)
    expect(fetch).not.toHaveBeenCalled();expect(body(host).messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/u)
    await expect(optimizeImagePrompt(host,id,{...base(),imageUrl:'https://evil.example/image'},undefined,env)).rejects.toMatchObject({status:400})
    expect(host.fetchAi).toHaveBeenCalledOnce()
  })
})

describe('bounded request/result and cancellation',()=>{
  it('rejects malformed or oversized requests without source URLs or duplicate references',()=>{
    for(const value of [{...base(),prompt:'a'.repeat(20001)},{...base(),requirements:'a'.repeat(4001)},{...base(),model:'a'.repeat(201)},{...base(),references:[{assetId:'../../file',role:'subject'}]},{...base(),references:[{assetId:'asset',role:'subject',url:'https://invalid'}]},{...base(),references:[{assetId:'asset',role:'subject'},{assetId:'asset',role:'effect'}]}])expect(()=>validateImagePromptRequest(value)).toThrow()
    expect(validateImagePromptRequest(base())).toEqual(base())
  })
  it('validates final prompts and change explanations without inventing fallback results',async()=>{
    expect(validateImagePromptResult({prompt:'改写后的提示词'})).toEqual({prompt:'改写后的提示词',changes:[]})
    for(const value of [{prompt:''},{prompt:'x'.repeat(IMAGE_PROMPT_LIMITS.prompt+1)},{prompt:'data:image/png;base64,AA=='},{prompt:'ok',changes:'invalid'},{prompt:'ok',changes:Array(9).fill('item')},{prompt:'ok',changes:['x'.repeat(241)]}])expect(()=>validateImagePromptResult(value)).toThrow()
    const {id,env}=fixture(),host=account();host.fetchAi.mockResolvedValue(completion({prompt:'ok'},'length'))
    await expect(optimizeImagePrompt(host,id,base(),undefined,env)).rejects.toMatchObject({code:'ai-incomplete-response'})
    host.fetchAi.mockRejectedValue(new Error('NEVER-EXPOSE-CREDENTIAL'))
    await expect(optimizeImagePrompt(host,id,base(),undefined,env)).rejects.toMatchObject({code:'ai-service-failed',message:expect.not.stringContaining('NEVER-EXPOSE')})
  })
  it('keeps the 60-second account discovery deadline without invoking a model',async()=>{
    vi.useFakeTimers();const {id,env}=fixture(),host=account();host.getStatus.mockReturnValue(new Promise(()=>{}))
    const pending=optimizeImagePrompt(host,id,base(),undefined,env),rejected=expect(pending).rejects.toMatchObject({status:504,code:'ai-timeout'})
    await vi.advanceTimersByTimeAsync(60001);await rejected;expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('allows a real photo-based model response after 90 seconds without aborting or repeating the request',async()=>{
    const {id,env,dir}=fixture(),photo=await image(id,env,'主体参考','#447755'),host=account(),value={prompt:'保留参考照片中的主体与旅行现场，调整光线。',changes:['根据真实参考照片调整']}
    const files=['track.json','source.gpx','resources.json'],before=files.map(name=>readFileSync(join(dir,name)))
    vi.useFakeTimers()
    let finish!: (response:Response)=>void
    host.fetchAi.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const pending=optimizeImagePrompt(host,id,base({references:[{assetId:photo.id,role:'subject'}]}),undefined,env)
    await vi.waitFor(()=>expect(host.fetchAi).toHaveBeenCalledOnce())
    const forwarded=host.fetchAi.mock.calls[0][2]!
    await vi.advanceTimersByTimeAsync(90_000)
    expect(forwarded.aborted).toBe(false);expect(host.fetchAi).toHaveBeenCalledOnce()
    finish(completion(value));await expect(pending).resolves.toEqual(value)
    expect(body(host).messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/u)
    expect(forwarded.aborted).toBe(false);expect(vi.getTimerCount()).toBe(0)
    for(let index=0;index<files.length;index++)expect(readFileSync(join(dir,files[index]))).toEqual(before[index])
  })
  it('stops a hung model after five minutes and discards its late result without another call',async()=>{
    const {id,env}=fixture(),host=account()
    expect(IMAGE_PROMPT_TIMEOUT_MS).toBe(300_000)
    vi.useFakeTimers();const started=Date.now()
    let finish!: (response:Response)=>void,outcome='pending'
    host.fetchAi.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const pending=optimizeImagePrompt(host,id,base(),undefined,env)
    void pending.then(()=>{outcome='resolved'},()=>{outcome='rejected'})
    const rejected=expect(pending).rejects.toMatchObject({status:504,code:'ai-timeout',message:expect.stringContaining('5 分钟')})
    await vi.waitFor(()=>expect(host.fetchAi).toHaveBeenCalledOnce())
    const forwarded=host.fetchAi.mock.calls[0][2]!
    await vi.advanceTimersByTimeAsync(IMAGE_PROMPT_TIMEOUT_MS-1-(Date.now()-started))
    expect(forwarded.aborted).toBe(false);expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1);await rejected
    expect(forwarded.aborted).toBe(true);expect(outcome).toBe('rejected')
    finish(completion({prompt:'超时后迟到的结果',changes:[]}));await Promise.resolve();await Promise.resolve()
    expect(outcome).toBe('rejected');expect(host.fetchAi).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })
  it('retains the default 60-second budget for ordinary shared text completions',async()=>{
    const host=account();vi.useFakeTimers();const started=Date.now()
    host.fetchAi.mockReturnValue(new Promise(()=>{}))
    const pending=completeTrackText(host,'text-only',{summary:'轨迹摘要'},'仅返回 JSON')
    const rejected=expect(pending).rejects.toMatchObject({status:504,code:'ai-timeout'})
    await vi.waitFor(()=>expect(host.fetchAi).toHaveBeenCalledOnce())
    const forwarded=host.fetchAi.mock.calls[0][2]!
    await vi.advanceTimersByTimeAsync(59_999-(Date.now()-started))
    expect(forwarded.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1);await rejected
    expect(forwarded.aborted).toBe(true);expect(host.fetchAi).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels active completion and skips an already-canceled request',async()=>{
    const {id,env}=fixture(),host=account(),controller=new AbortController();host.fetchAi.mockReturnValue(new Promise(()=>{}))
    const pending=optimizeImagePrompt(host,id,base(),controller.signal,env),rejected=expect(pending).rejects.toMatchObject({status:499,code:'ai-canceled'})
    await vi.waitFor(()=>expect(host.fetchAi).toHaveBeenCalledOnce());const forwarded=host.fetchAi.mock.calls[0][2]!
    controller.abort();await rejected;expect(forwarded.aborted).toBe(true)
    const unused=account();await expect(optimizeImagePrompt(unused,id,base(),controller.signal,env)).rejects.toMatchObject({code:'ai-canceled'});expect(unused.getStatus).not.toHaveBeenCalled()
    expect(readTrack(id,env)?.name).toBe(input.name)
  })
})

