import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {generateVideoScript} from '../src/client/video-script-ai.ts'
import {analyzeVideoScript,createVideoScriptDraft} from '../src/track/video-script.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord} from '../src/protocol.ts'
import type {VideoScriptRequest} from '../src/track/video-script-types.ts'
const coordinates:TrackRecord['coordinates']=[[120,30,100,null],[120.01,30,150,null],[120.02,30,180,null]]
const track:TrackRecord={id:'test-video',name:'合成路线',format:'gpx',filename:'test.gpx',createdAt:'2026-10-02',bytes:100,points:3,coordinates,metrics:editedMetrics(coordinates)}
const analysis=analyzeVideoScript(track)
const candidates=analysis.candidates.filter(scene=>scene.id==='high-point')
const request:VideoScriptRequest={model:'model-a',analysis:{trackName:analysis.trackName,pointCount:analysis.pointCount,fingerprint:analysis.fingerprint,summary:analysis.summary,limitations:analysis.limitations},candidates,userNotes:'保留未知信息'}
const draft=createVideoScriptDraft(analysis,candidates.map(scene=>scene.id))
const suggestion={title:'测试单镜脚本',shots:draft.shots}
const fetchMock=vi.fn<typeof fetch>()
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
beforeEach(()=>{fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock)})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
describe('video script browser boundary',()=>{
 it('permits one scene and submits selected bounded facts without source files or photo links',async()=>{
  fetchMock.mockResolvedValue(json(suggestion))
  const extended={...request,source:'NEVER-SEND-GPX',photos:['NEVER-SEND-PHOTO'],analysis:{...request.analysis,coordinates:track.coordinates},candidates:request.candidates.map(scene=>({...scene,images:['NEVER-SEND-PHOTO']}))}
  expect(await generateVideoScript(extended)).toEqual(suggestion)
  const [url,init]=fetchMock.mock.calls[0]
  expect(url).toBe('/api/cqai-track/video-script')
  expect(init?.headers).toEqual({'content-type':'application/json','x-cqai-track':'1'})
  expect(init?.credentials).toBe('same-origin')
  const payload=JSON.parse(init?.body as string)
  expect(payload).toEqual(request)
  expect(JSON.stringify(payload)).not.toContain('NEVER-SEND')
 })
 it('refuses missing models, pending scenes and duplicates before sending',async()=>{
  await expect(generateVideoScript({...request,model:''})).rejects.toThrow('模型')
  await expect(generateVideoScript({...request,candidates:analysis.candidates.filter(scene=>scene.kind==='surrounding-peaks')})).rejects.toThrow('资料完整')
  await expect(generateVideoScript({...request,candidates:[candidates[0],candidates[0]]})).rejects.toThrow('资料完整')
  expect(fetchMock).not.toHaveBeenCalled()
 })
 it.each([
  {...suggestion,shots:[]},
  {...suggestion,shots:suggestion.shots.map(shot=>({...shot,confirmed:true}))},
  {...suggestion,shots:suggestion.shots.map(shot=>({...shot,target:{pointIndex:0,coordinates:[120,30]}}))},
  {...suggestion,shots:suggestion.shots.map(shot=>({...shot,candidateId:'unknown'}))},
 ])('rejects stale or model-invented identity, target, confirmation and scene count',async value=>{
  fetchMock.mockResolvedValue(json(value))
  await expect(generateVideoScript(request)).rejects.toThrow()
 })
 it('keeps readable server failures and non-JSON service restart guidance',async()=>{
  fetchMock.mockResolvedValueOnce(json({error:'请登录 CQAI 账号'},401))
  await expect(generateVideoScript(request)).rejects.toThrow('请登录')
  fetchMock.mockResolvedValueOnce(new Response('<html>server startup</html>',{headers:{'content-type':'text/html'}}))
  await expect(generateVideoScript(request)).rejects.toThrow('重启插件')
 })
 it('aborts a request and refuses a late result even if fetch ignores cancellation',async()=>{
  let resolve!:(response:Response)=>void
  fetchMock.mockImplementation(()=>new Promise(yes=>{resolve=yes}))
  const controller=new AbortController()
  const result=generateVideoScript(request,controller.signal)
  const caught=expect(result).rejects.toMatchObject({name:'AbortError'})
  controller.abort();resolve(json(suggestion));await caught
  expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
 })
 it('times out a stalled model without accepting its late response',async()=>{
  vi.useFakeTimers()
  let resolve!:(response:Response)=>void
  fetchMock.mockImplementation(()=>new Promise(yes=>{resolve=yes}))
  const result=generateVideoScript(request)
  const caught=expect(result).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(65_000)
  resolve(json(suggestion));await caught
  expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
 })
})
