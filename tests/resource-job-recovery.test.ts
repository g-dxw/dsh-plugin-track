// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import type {ResourceAsset, ResourceJob} from '../src/track/resources.ts'
import {ImagegenError, loadTrackArtTask, submitResourceImage} from '../src/client/imagegen.ts'
import {saveResourceJob, storeResourceResult} from '../src/client/resources-api.ts'
import {resourceJobNeedsSync, syncResourceJob, useResourceJobs} from '../src/client/useResourceJobs.ts'
vi.mock('../src/client/imagegen.ts',async(importOriginal)=>{const actual=await importOriginal<typeof import('../src/client/imagegen.ts')>();return {...actual,loadTrackArtTask:vi.fn(),submitResourceImage:vi.fn(),cancelTrackArtTask:vi.fn()}})
vi.mock('../src/client/resources-api.ts',()=>({saveResourceJob:vi.fn(),storeResourceResult:vi.fn(),readResourceReference:vi.fn()}))
let root:Root|undefined
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();vi.mocked(saveResourceJob).mockImplementation(async(_trackId,job)=>job);(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true})
afterEach(async()=>{if(root){await act(async()=>root?.unmount());root=undefined}document.body.innerHTML=''})
const base=(id:string,patch:Partial<ResourceJob>={}):ResourceJob=>({id,trackId:'track-1',mode:'text',prompt:'山谷清晨',model:'测试模型',hostTaskId:'host-'+id,status:'running',resultAssetIds:[],resultsPersisted:false,createdAt:'2026-10-05T00:00:00.000Z',updatedAt:'2026-10-05T00:00:00.000Z',...patch})
const asset=(id:string)=>({id,kind:'image'} as ResourceAsset)

describe('AI resource recovery and intentional discard',()=>{
  it('does not resurrect deliberately discarded completed outputs after the last asset reference is removed',async()=>{
    const job=base('discarded',{status:'completed',resultsPersisted:true,resultAssetIds:[]})
    expect(resourceJobNeedsSync(job)).toBe(false)
    await syncResourceJob(job.trackId,job)
    expect(loadTrackArtTask).not.toHaveBeenCalled();expect(storeResourceResult).not.toHaveBeenCalled();expect(saveResourceJob).not.toHaveBeenCalled();expect(submitResourceImage).not.toHaveBeenCalled()
  })
  it('does not save outputs or change status when a canceled job is manually checked',async()=>{
    const job=base('canceled',{status:'canceled'})
    await syncResourceJob(job.trackId,job)
    expect(loadTrackArtTask).not.toHaveBeenCalled();expect(storeResourceResult).not.toHaveBeenCalled();expect(saveResourceJob).not.toHaveBeenCalled()
  })
  it('retries partial local persistence using the same host output and only declares completion after every result is stored',async()=>{
    const job=base('partial')
    vi.mocked(loadTrackArtTask).mockResolvedValue({status:'completed',images:[{dataUrl:'data:image/png;base64,first'},{dataUrl:'data:image/png;base64,second'}]})
    vi.mocked(storeResourceResult).mockResolvedValueOnce(asset('first')).mockRejectedValueOnce(new Error('磁盘暂不可写'))
    await syncResourceJob(job.trackId,job)
    const partial=vi.mocked(saveResourceJob).mock.calls.at(-1)![1]
    expect(partial).toMatchObject({status:'completed',resultAssetIds:['first'],resultsPersisted:false});expect(partial.error).toContain('结果保存失败');expect(resourceJobNeedsSync(partial)).toBe(true)
    vi.mocked(storeResourceResult).mockResolvedValueOnce(asset('first')).mockResolvedValueOnce(asset('second'))
    await syncResourceJob(job.trackId,partial)
    const complete=vi.mocked(saveResourceJob).mock.calls.at(-1)![1]
    expect(complete).toMatchObject({status:'completed',resultAssetIds:['first','second'],resultsPersisted:true});expect(complete.error).toBeUndefined();expect(resourceJobNeedsSync(complete)).toBe(false)
    expect(vi.mocked(loadTrackArtTask).mock.calls.map(call=>call[0])).toEqual([job.hostTaskId,job.hostTaskId]);expect(submitResourceImage).not.toHaveBeenCalled()
  })
  it('retains completed generation state when recovering missing local outputs encounters a query failure',async()=>{
    const job=base('completed-query',{status:'completed'})
    vi.mocked(loadTrackArtTask).mockRejectedValue(new ImagegenError('服务暂不可用','network-error'))
    await syncResourceJob(job.trackId,job)
    expect(saveResourceJob).toHaveBeenCalledWith(job.trackId,expect.objectContaining({status:'completed',resultsPersisted:false,resultAssetIds:[],error:expect.stringContaining('不会重复提交')}))
    expect(storeResourceResult).not.toHaveBeenCalled();expect(submitResourceImage).not.toHaveBeenCalled()
  })
  it('serializes overlapping recovery calls so one completed result is not persisted twice',async()=>{
    const job=base('locked')
    let finish!:(state:Awaited<ReturnType<typeof loadTrackArtTask>>)=>void
    vi.mocked(loadTrackArtTask).mockReturnValue(new Promise(resolve=>{finish=resolve}));vi.mocked(storeResourceResult).mockResolvedValue(asset('one'))
    const first=syncResourceJob(job.trackId,job),second=syncResourceJob(job.trackId,job)
    finish({status:'completed',images:[{dataUrl:'data:image/png;base64,one'}]});await Promise.all([first,second])
    expect(loadTrackArtTask).toHaveBeenCalledTimes(1);expect(storeResourceResult).toHaveBeenCalledTimes(1);expect(saveResourceJob).toHaveBeenCalledTimes(1)
  })
  it('catches interrupted submission persistence failures in the polling effect without an unhandled rejection or host resubmit',async()=>{
    vi.mocked(saveResourceJob).mockRejectedValue(new Error('资源服务离线'))
    const job=base('interrupted',{status:'submitting',hostTaskId:undefined})
    const node=document.createElement('div');document.body.append(node);root=createRoot(node)
    function Harness(){const jobs=useResourceJobs(job.trackId,[job],async()=>{});return createElement('p',null,jobs.error)}
    await act(async()=>{root!.render(createElement(Harness));await Promise.resolve()})
    expect(node.textContent).toContain('资源服务离线');expect(loadTrackArtTask).not.toHaveBeenCalled();expect(submitResourceImage).not.toHaveBeenCalled()
  })
})
