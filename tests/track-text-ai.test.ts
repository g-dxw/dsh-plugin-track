import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeRoute, generateAnimationScript, loadTextModels, validateRouteAIContext,
  type RouteAIContext, type RouteAIAnalysis, type AnimationScript, type TrackAIAccount,
} from '../src/ai.ts'
import { analyzeRoute as clientAnalyze, generateAnimationScript as clientScript, loadTextModels as clientModels } from '../src/client/text-ai.ts'

const CONTEXT: RouteAIContext = {
  name: '合成路线验收', pointCount: 10, distance: 1200, elevationGain: 100, elevationLoss: 20,
  elevationMin: 100, elevationMax: 180, duration: 120_000, elevationCoverage: 1, timestampCoverage: 1,
  coordinates: [{index:0,lon:119.4,lat:30.3,elevation:100},{index:9,lon:119.42,lat:30.32,elevation:180}],
  annotations: [{pointIndex:5,label:'已知观景点',kind:'checkin'}], restCandidates: [{startIndex:3,endIndex:4,duration:30_000}], userNotes:'路况未知',
}
const ANALYSIS: RouteAIAnalysis = {difficulty:'中等，仅依距离与爬升估计',audience:['有徒步经验的人'],equipment:['饮水与防晒'],checkpoints:['已知观景点'],restPoints:['第4到5点可能停留，需核实'],limitations:['不能从轨迹判断实时路况'],summary:'这是合成测试分析，未调用实际模型'}
const SCRIPT: AnimationScript = {title:'合成镜头验收',shots:[{type:'overview',duration:3,narration:'路线概览'},{type:'follow',duration:4},{type:'checkpoint',duration:3,pointIndex:5,narration:'已有标注点'}]}
const MODELS = [
  {id:'model-a',name:'文本 A',categories:['text'],supportedEndpointTypes:['openai']},
  {id:'model-b',name:'文本 B',categories:['text-multimodal'],supportedEndpointTypes:['openai']},
  {id:'image-only',name:'图片模型',categories:['image'],supportedEndpointTypes:['image-generation']},
]
const REQUEST = {model:'model-a',context:CONTEXT}
function json(value: unknown, status = 200): Response {return new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json'}})}
function completion(value: unknown, finish = 'stop'): Response {return json({choices:[{finish_reason:finish,message:{content:JSON.stringify(value)}}]})}
function account() {
  return {
    getStatus:vi.fn<TrackAIAccount['getStatus']>().mockResolvedValue({state:'signed-in'}),
    listModels:vi.fn<TrackAIAccount['listModels']>().mockResolvedValue({models:MODELS}),
    getDefaultModel:vi.fn<TrackAIAccount['getDefaultModel']>().mockResolvedValue({provider:'cqaiclub',model:'model-b'}),
    fetchAi:vi.fn<TrackAIAccount['fetchAi']>().mockResolvedValue(completion(ANALYSIS)),
  }
}
const fetchMock=vi.fn<typeof fetch>()
beforeEach(()=>{fetchMock.mockReset()})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})

describe('host text-model catalog',()=>{
  it('uses the CQAI safe catalog and configured default, without making any completion call',async()=>{
    const host=account()
    expect(await loadTextModels(host)).toEqual({models:[{id:'model-a',label:'文本 A'},{id:'model-b',label:'文本 B'}],defaultModel:'model-b',available:true})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('rejects a missing optional account service with HTTP 503',async()=>{
    await expect(loadTextModels()).rejects.toMatchObject({status:503,code:'ai-unavailable'})
    await expect(analyzeRoute(undefined,REQUEST)).rejects.toMatchObject({status:503})
  })
  it('keeps a multiple-model catalog unselected without a valid CQAI default',async()=>{
    const host=account();host.getDefaultModel.mockResolvedValue({provider:'external',model:'model-a'})
    expect(await loadTextModels(host)).not.toHaveProperty('defaultModel')
    host.getDefaultModel.mockResolvedValue({provider:'cqaiclub',model:'removed'})
    expect(await loadTextModels(host)).not.toHaveProperty('defaultModel')
  })
  it('permits a sole chat model and filters models using official endpoint/modalities semantics',async()=>{
    const host=account()
    host.listModels.mockResolvedValue({models:[MODELS[0],{id:'wrong-output',categories:['text'],supportedEndpointTypes:['openai'],architecture:{inputModalities:['text'],outputModalities:['image']}},{id:'wrong-endpoint',categories:['text'],supportedEndpointTypes:['responses']}],warning:'缓存目录'})
    expect(await loadTextModels(host)).toEqual({models:[{id:'model-a',label:'文本 A'}],defaultModel:'model-a',available:true,message:'缓存目录'})
  })
  it('reports signed-out and missing models without invoking completion',async()=>{
    const host=account();host.getStatus.mockResolvedValue({state:'signed-out'})
    expect(await loadTextModels(host)).toMatchObject({models:[],available:false,message:expect.stringContaining('登录')})
    expect(host.listModels).not.toHaveBeenCalled()
    host.getStatus.mockResolvedValue({state:'signed-in'});host.listModels.mockResolvedValue({models:[]})
    expect(await loadTextModels(host)).toMatchObject({available:false,message:expect.stringContaining('没有可用')})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
})

describe('bounded summary validation',()=>{
  it('strips GPX, check-in photos, and all unknown summary fields',()=>{
    const extended={...CONTEXT,source:'NEVER-SEND-GPX',photos:['NEVER-SEND-PHOTO'],coordinates:CONTEXT.coordinates.map(point=>({...point,secret:'NEVER-SEND-POINT'})),annotations:[{...CONTEXT.annotations[0],imageDataUrl:'NEVER-SEND-PHOTO'}]}
    expect(validateRouteAIContext(extended)).toEqual(CONTEXT)
  })
  it.each([
    {...CONTEXT,elevationCoverage:100}, {...CONTEXT,pointCount:1}, {...CONTEXT,coordinates:[]},
    {...CONTEXT,coordinates:[...CONTEXT.coordinates,CONTEXT.coordinates[0]]},
    {...CONTEXT,coordinates:[CONTEXT.coordinates[0],{...CONTEXT.coordinates[1],lat:91}]},
    {...CONTEXT,coordinates:Array(81).fill(CONTEXT.coordinates[0])},
    {...CONTEXT,annotations:[{pointIndex:10,label:'越界'}]},
    {...CONTEXT,restCandidates:[{startIndex:4,endIndex:3,duration:10}]},
    {...CONTEXT,userNotes:'a'.repeat(4001)},
  ])('refuses malformed or unbounded context before any model invocation',context=>{
    expect(()=>validateRouteAIContext(context)).toThrow()
  })
})

describe('host JSON analysis and scripts',()=>{
  it('makes one fixed chat-completion request with the explicit verified model and sanitized summary',async()=>{
    const host=account()
    expect(await analyzeRoute(host,{...REQUEST,context:{...CONTEXT,source:'NEVER-SEND-GPX'} as RouteAIContext})).toEqual(ANALYSIS)
    expect(host.fetchAi).toHaveBeenCalledOnce()
    const [path,init,signal]=host.fetchAi.mock.calls[0]
    expect(path).toBe('/v1/chat/completions')
    expect(init!.headers).toEqual({'content-type':'application/json'})
    const body=JSON.parse(init!.body as string)
    expect(body.model).toBe('model-a');expect(body.messages[0].role).toBe('system')
    expect(JSON.parse(body.messages[1].content)).toEqual(CONTEXT)
    expect(JSON.stringify(body)).not.toContain('NEVER-SEND-GPX')
    expect(signal).toBeInstanceOf(AbortSignal)
  })
  it('rejects an unavailable explicit model without falling back to a configured model',async()=>{
    const host=account()
    await expect(analyzeRoute(host,{...REQUEST,model:'removed'})).rejects.toMatchObject({status:400,code:'ai-model-unavailable'})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it.each([{summary:'missing all other fields'}, {...ANALYSIS,limitations:[]}, {...ANALYSIS,audience:'not-array'}])('rejects an incomplete analysis without inventing a result',async value=>{
    const host=account();host.fetchAi.mockResolvedValue(completion(value))
    await expect(analyzeRoute(host,REQUEST)).rejects.toMatchObject({status:502,code:'ai-invalid-result'})
  })
  it('supports a fenced JSON response but rejects prose, empty choices, and truncated output',async()=>{
    const host=account();host.fetchAi.mockResolvedValueOnce(json({choices:[{message:{content:'```json\n'+JSON.stringify(ANALYSIS)+'\n```'}}]}))
    expect(await analyzeRoute(host,REQUEST)).toEqual(ANALYSIS)
    host.fetchAi.mockResolvedValueOnce(json({choices:[{message:{content:'Sorry, here is a suggestion'}}]}))
    await expect(analyzeRoute(host,REQUEST)).rejects.toMatchObject({code:'ai-invalid-json'})
    host.fetchAi.mockResolvedValueOnce(json({choices:[]}))
    await expect(analyzeRoute(host,REQUEST)).rejects.toMatchObject({code:'ai-empty-response'})
    host.fetchAi.mockResolvedValueOnce(completion(ANALYSIS,'length'))
    await expect(analyzeRoute(host,REQUEST)).rejects.toMatchObject({code:'ai-incomplete-response'})
  })
  it('returns valid overview/follow/checkpoint scripts',async()=>{
    const host=account();host.fetchAi.mockResolvedValue(completion(SCRIPT))
    expect(await generateAnimationScript(host,REQUEST)).toEqual(SCRIPT)
  })
  it.each([
    {...SCRIPT,shots:[{type:'overview',duration:3}]},
    {...SCRIPT,shots:[{type:'overview',duration:2},{type:'follow',duration:4}]},
    {...SCRIPT,shots:[{type:'overview',duration:3},{type:'flight',duration:4}]},
    {...SCRIPT,shots:[{type:'overview',duration:3},{type:'follow',duration:4},{type:'checkpoint',duration:3}]},
    {...SCRIPT,shots:[{type:'overview',duration:3},{type:'follow',duration:4},{type:'checkpoint',duration:3,pointIndex:10}]},
    {...SCRIPT,shots:[{type:'overview',duration:3},{type:'follow',duration:4},{type:'checkpoint',duration:3,pointIndex:4}]},
    {...SCRIPT,shots:[{type:'overview',duration:3},{type:'checkpoint',duration:3,pointIndex:5}]},
    {...SCRIPT,shots:Array.from({length:7},(_,index)=>({type:index?'follow':'overview',duration:30}))},
    {...SCRIPT,shots:Array.from({length:13},(_,index)=>({type:index?'follow':'overview',duration:3}))},
  ])('refuses invalid scripts without repairing point indices or missing shots',async script=>{
    const host=account();host.fetchAi.mockResolvedValue(completion(script))
    await expect(generateAnimationScript(host,REQUEST)).rejects.toMatchObject({status:502,code:'ai-invalid-script'})
  })
  it('never exposes upstream or credential-bearing exception text',async()=>{
    const host=account();host.fetchAi.mockResolvedValueOnce(json({error:{message:'NEVER-EXPOSE-TOKEN'}},401))
    await expect(analyzeRoute(host,REQUEST)).rejects.toMatchObject({message:expect.not.stringContaining('NEVER-EXPOSE'),code:'ai-upstream-failed'})
    host.fetchAi.mockRejectedValueOnce(new Error('NEVER-EXPOSE-CREDENTIAL'))
    await expect(analyzeRoute(host,REQUEST)).rejects.toMatchObject({message:expect.not.stringContaining('NEVER-EXPOSE'),code:'ai-service-failed'})
  })
  it('enforces the total 60-second deadline even while account catalog discovery hangs',async()=>{
    vi.useFakeTimers();const host=account();host.getStatus.mockReturnValue(new Promise(()=>{}))
    const pending=loadTextModels(host)
    const rejected=expect(pending).rejects.toMatchObject({status:504,code:'ai-timeout'})
    await vi.advanceTimersByTimeAsync(60_001);await rejected
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('aborts an active model call and skips an already canceled request',async()=>{
    const host=account(),controller=new AbortController();host.fetchAi.mockReturnValue(new Promise(()=>{}))
    const pending=analyzeRoute(host,REQUEST,controller.signal)
    const rejected=expect(pending).rejects.toMatchObject({status:499,code:'ai-canceled'})
    await vi.waitFor(()=>expect(host.fetchAi).toHaveBeenCalledOnce())
    const forwarded=host.fetchAi.mock.calls[0][2]!
    controller.abort();await rejected;expect(forwarded.aborted).toBe(true)
    const second=account()
    await expect(analyzeRoute(second,REQUEST,controller.signal)).rejects.toMatchObject({code:'ai-canceled'})
    expect(second.getStatus).not.toHaveBeenCalled()
  })
})

describe('same-origin browser text adapter',()=>{
  beforeEach(()=>vi.stubGlobal('fetch',fetchMock))
  it('loads only the safe text catalog and respects a multiple-model catalog without a default',async()=>{
    fetchMock.mockResolvedValueOnce(json({models:[{id:'model-a',label:'文本 A'},{id:'model-b',label:'文本 B'}],available:true}))
    expect(await clientModels()).toEqual({models:[{id:'model-a',label:'文本 A'},{id:'model-b',label:'文本 B'}],available:true})
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/cqai-track/text-models')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({method:'GET',credentials:'same-origin'})
  })
  it('serializes an explicit analysis with marker header and without original source or photos',async()=>{
    fetchMock.mockResolvedValueOnce(json(ANALYSIS))
    const context={...CONTEXT,source:'NEVER-SEND-GPX',annotations:[{...CONTEXT.annotations[0],photoDataUrl:'NEVER-SEND-PHOTO'}]} as unknown as RouteAIContext
    expect(await clientAnalyze({...REQUEST,context})).toEqual(ANALYSIS)
    const [path,init]=fetchMock.mock.calls[0]
    expect(path).toBe('/api/cqai-track/analyze');expect(init!.headers).toEqual({'content-type':'application/json','x-cqai-track':'1'})
    const body=JSON.parse(init!.body as string);expect(body).toEqual(REQUEST)
    expect(JSON.stringify(body)).not.toContain('NEVER-SEND')
  })
  it('uses the animation-script action and validates a returned script',async()=>{
    fetchMock.mockResolvedValueOnce(json(SCRIPT))
    expect(await clientScript(REQUEST)).toEqual(SCRIPT)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/cqai-track/animation-script')
    fetchMock.mockResolvedValueOnce(json({...SCRIPT,shots:[{type:'overview',duration:3},{type:'checkpoint',duration:3,pointIndex:99}]}))
    await expect(clientScript(REQUEST)).rejects.toThrow('点序号无效')
  })
  it('rejects a legal-range checkpoint absent from sampled or annotated points',async()=>{
    fetchMock.mockResolvedValueOnce(json({...SCRIPT,shots:[{type:'overview',duration:3},{type:'follow',duration:4},{type:'checkpoint',duration:3,pointIndex:4}]}))
    await expect(clientScript(REQUEST)).rejects.toThrow('点序号无效')
  })
  it('reports an absent plugin, host failure, and malformed analysis while preserving caller results',async()=>{
    fetchMock.mockResolvedValueOnce(new Response('<html>fallback</html>',{status:404,headers:{'content-type':'text/html'}}))
    await expect(clientModels()).rejects.toThrow('服务暂未就绪')
    fetchMock.mockResolvedValueOnce(json({error:'模型尚未登录',code:'ai-models-unavailable'},503))
    await expect(clientAnalyze(REQUEST)).rejects.toThrow('模型尚未登录')
    fetchMock.mockResolvedValueOnce(json({difficulty:'unknown'}))
    await expect(clientAnalyze(REQUEST)).rejects.toThrow('数据不完整')
  })
  it('passes a cancelable signal and aborts without submitting an extra model request',async()=>{
    const controller=new AbortController()
    fetchMock.mockImplementation((_url,options)=>new Promise((_,reject)=>options!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})))
    const pending=clientAnalyze(REQUEST,controller.signal)
    const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
    controller.abort();await rejected;expect(fetchMock).toHaveBeenCalledOnce()
    await expect(clientScript(REQUEST,controller.signal)).rejects.toMatchObject({name:'AbortError'})
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('bounds a stalled browser request and refuses an empty model before fetching',async()=>{
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url,options)=>new Promise((_,reject)=>options!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})))
    const pending=clientAnalyze(REQUEST)
    const rejected=expect(pending).rejects.toThrow('响应超时')
    await vi.advanceTimersByTimeAsync(65_001);await rejected
    fetchMock.mockClear();await expect(clientAnalyze({...REQUEST,model:''})).rejects.toThrow('请选择文本模型');expect(fetchMock).not.toHaveBeenCalled()
  })
})


