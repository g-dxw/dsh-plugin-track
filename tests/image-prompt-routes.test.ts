import {Context} from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {request as httpRequest} from 'node:http'
import * as plugin from '../src/index.ts'
import {writeTrack} from '../src/artifacts.ts'
import {API, type TrackInput} from '../src/protocol.ts'
import type {TrackAIAccount} from '../src/ai.ts'
import {IMAGE_PROMPT_LIMITS} from '../src/track/image-prompt.ts'

const roots:string[]=[]
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0)){if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('cqai-image-prompt-routes-'))throw new Error('Unexpected optimization route fixture');rmSync(root,{recursive:true,force:true})}})
const input:TrackInput={filename:'original.gpx',source:'<gpx>original</gpx>',points:[[120,30,null,null],[120.01,30,null,null]],metrics:{distance:1000,elevationGain:0,elevationLoss:0,duration:0,elevationMax:null,elevationMin:null,bbox:[120,30,120.01,30]}}
function host(){return{getStatus:vi.fn<TrackAIAccount['getStatus']>().mockResolvedValue({state:'signed-in'}),listModels:vi.fn<TrackAIAccount['listModels']>().mockResolvedValue({models:[{id:'text',name:'Text',categories:['text'],supportedEndpointTypes:['openai']},{id:'vision',name:'Vision',categories:['text-multimodal'],supportedEndpointTypes:['openai'],architecture:{inputModalities:['text','image'],outputModalities:['text']}}]}),getDefaultModel:vi.fn<TrackAIAccount['getDefaultModel']>().mockResolvedValue({provider:'cqai',model:'text'}),fetchAi:vi.fn<TrackAIAccount['fetchAi']>().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({prompt:'根据当前轨迹优化的画面要求',changes:['适配已有路线资料']})}}]}),{headers:{'content-type':'application/json'}}))}}
async function withServer(run:(base:string,id:string,account:ReturnType<typeof host>)=>Promise<void>){const root=mkdtempSync(join(tmpdir(),'cqai-image-prompt-routes-'));roots.push(root);const previous=process.env.DSH_HOME;process.env.DSH_HOME=root;const ctx=new Context(),account=host(),get=ctx.get.bind(ctx);vi.spyOn(ctx,'get').mockImplementation(((name:string)=>name==='dsnAccount'?account:get(name)) as typeof ctx.get);try{const{id}=writeTrack(input);await ctx.plugin(WebServer,{host:'127.0.0.1',port:0});await ctx.plugin(plugin);await run(`http://127.0.0.1:${ctx.webServer.port}`,id,account)}finally{await ctx.fiber.dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous}}
function post(base:string,id:string,value:unknown,extra:Record<string,string>={}){return fetch(`${base}${API}/resource-prompt-optimize?id=${id}`,{method:'POST',headers:{'x-cqai-track':'1','content-type':'application/json',...extra},body:JSON.stringify(value)})}
const body={model:'text',prompt:'以山间徒步旅程为主题',requirements:'保留真实地貌',references:[]}

describe('prompt optimization HTTP integration',()=>{
  it('loads the safe modality catalog and accepts one explicit optimization without changing legacy catalogs',async()=>withServer(async(base,id,account)=>{
    const catalog=await fetch(base+API+'/resource-prompt-models');expect(catalog.status).toBe(200);expect(await catalog.json()).toMatchObject({models:[{id:'text',supportsVision:false},{id:'vision',supportsVision:true}],defaultModel:'text',available:true})
    const old=await(await fetch(base+API+'/text-models')).json();expect(old.models).toEqual([{id:'text',label:'Text'},{id:'vision',label:'Vision'}]);expect(account.fetchAi).not.toHaveBeenCalled()
    const response=await post(base,id,body);expect(response.status).toBe(200);expect(await response.json()).toEqual({prompt:'根据当前轨迹优化的画面要求',changes:['适配已有路线资料']});expect(account.fetchAi).toHaveBeenCalledOnce()
  }),30000)
  it('enforces existing loopback/origin/write gates and rejects unowned references before any completion',async()=>withServer(async(base,id,account)=>{
    const url=`${base}${API}/resource-prompt-optimize?id=${id}`
    expect((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(403)
    expect((await post(base,id,body,{origin:'https://invalid.example'})).status).toBe(403)
    expect((await post(base,id,{...body,references:[{assetId:'missing',role:'subject'}]})).status).toBe(404)
    expect((await post(base,'missing',body)).status).toBe(404)
    expect((await post(base,id,{...body,imageUrl:'https://invalid.example/image'})).status).toBe(400)
    expect(account.fetchAi).not.toHaveBeenCalled()
  }),30000)
  it('returns a bounded 413 before catalog or model access when optimization JSON is oversized',async()=>withServer(async(base,id,account)=>{
    const response=await post(base,id,{...body,prompt:'x'.repeat(IMAGE_PROMPT_LIMITS.requestBytes)})
    expect(response.status).toBe(413);expect(await response.json()).toMatchObject({error:expect.stringContaining('128 KiB')})
    expect(account.getStatus).not.toHaveBeenCalled();expect(account.fetchAi).not.toHaveBeenCalled()
  }),30000)
  it('forwards a client disconnect to an active account completion',async()=>withServer(async(base,id,account)=>{
    account.fetchAi.mockReturnValue(new Promise(()=>{}))
    const req=httpRequest(`${base}${API}/resource-prompt-optimize?id=${id}`,{method:'POST',headers:{'x-cqai-track':'1','content-type':'application/json'}},res=>res.resume())
    req.on('error',()=>{});req.end(JSON.stringify(body))
    await vi.waitFor(()=>expect(account.fetchAi).toHaveBeenCalledOnce());const signal=account.fetchAi.mock.calls[0][2]!
    req.destroy();await vi.waitFor(()=>expect(signal.aborted).toBe(true))
  }),30000)
})
