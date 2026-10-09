// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadTrackPlacemarks, useTrackPlacemarks} from '../src/client/useTrackPlacemarks.ts'
import type {TrackPlacemark, TrackRecord} from '../src/protocol.ts'

vi.mock('../src/client/util.ts', () => ({api: vi.fn(async () => ({state: {version:1,revision:0,added:[],deletedIds:[],edits:[],order:null,groups:[],routeContext:null}}))}))

const SOURCE = '<kml><Document><Placemark><name></name><TimeStamp><when>2026-05-29T06:48:22Z</when></TimeStamp><Point><coordinates>120,30,501.59</coordinates></Point></Placemark></Document></kml>'
const LEGACY: TrackPlacemark = {id:'kml-1',name:'标注点 1',coordinates:[120,30],description:'保留说明',images:['https://example.com/saved.jpg']}
const OLD = {id:'old',format:'kml',placemarks:[LEGACY]} as TrackRecord
const COMPLETE: TrackPlacemark = {...LEGACY,name:'保留名称',elevation:null,time:null}
let fetchSource: ReturnType<typeof vi.fn>, root: Root | null, holder: HTMLDivElement | null
let result: ReturnType<typeof useTrackPlacemarks>
function Hook({track}:{track:TrackRecord}) {result=useTrackPlacemarks(track);return null}
async function render(track: TrackRecord) {
  if (!root) {holder=document.createElement('div');document.body.append(holder);root=createRoot(holder)}
  await act(async()=>root!.render(createElement(Hook,{track})))
}
function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(error:Error)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
beforeEach(()=>{
  root=null;holder=null
  fetchSource=vi.fn().mockRejectedValue(new Error('Unexpected source request'))
  vi.stubGlobal('fetch',fetchSource)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
})
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount())
  holder?.remove();vi.unstubAllGlobals()
})

describe('legacy point metadata restoration',()=>{
  it('restores the source title, elevation and own timestamp without replacing saved pictures or description',async()=>{
    fetchSource.mockResolvedValue(new Response(SOURCE))
    const restored=await loadTrackPlacemarks(OLD)
    expect(fetchSource).toHaveBeenCalledWith('/api/cqai-track/source?id=old',{signal:undefined})
    expect(restored).toEqual([{...LEGACY,name:'',elevation:501.59,time:Date.parse('2026-05-29T06:48:22Z')}])
  })

  it('leaves an explicitly saved empty point list untouched',async()=>{
    const points:TrackPlacemark[]=[]
    expect(await loadTrackPlacemarks({...OLD,placemarks:points})).toBe(points)
    expect(fetchSource).not.toHaveBeenCalled()
  })

  it('does not load source for records with explicit null metadata',async()=>{
    const points=[COMPLETE]
    expect(await loadTrackPlacemarks({...OLD,placemarks:points})).toBe(points)
    expect(fetchSource).not.toHaveBeenCalled()
  })

  it('does not load source for non-KML points',async()=>{
    expect(await loadTrackPlacemarks({...OLD,format:'gpx'})).toBe(OLD.placemarks)
    expect(fetchSource).not.toHaveBeenCalled()
  })

  it.each(['unavailable','network error','invalid XML'])('keeps old points when source recovery fails with %s',async failure=>{
    if(failure==='unavailable')fetchSource.mockResolvedValue(new Response('',{status:404}))
    else if(failure==='network error')fetchSource.mockRejectedValue(new Error('Disconnected'))
    else fetchSource.mockResolvedValue(new Response('<kml>'))
    expect(await loadTrackPlacemarks(OLD)).toBe(OLD.placemarks)
  })

  it.each(['<kml/>',SOURCE.replace('120,30,501.59','121,31,501.59')])('keeps unmatched saved points instead of erasing them',async source=>{
    fetchSource.mockResolvedValue(new Response(source))
    expect(await loadTrackPlacemarks(OLD)).toEqual(OLD.placemarks)
  })

  it('recovers a unique source location without changing the saved point id',async()=>{
    fetchSource.mockResolvedValue(new Response(SOURCE))
    const point={...LEGACY,id:'older-id'}
    const restored=await loadTrackPlacemarks({...OLD,placemarks:[point]})
    expect(restored[0]).toMatchObject({id:'older-id',name:'',elevation:501.59,time:Date.parse('2026-05-29T06:48:22Z')})
  })

  it('does not guess among duplicate locations with unrelated source ids',async()=>{
    fetchSource.mockResolvedValue(new Response(SOURCE.replace('</Document>','<Placemark><name>另一个点</name><Point><coordinates>120,30,600</coordinates></Point></Placemark></Document>')))
    const point={...LEGACY,id:'older-id'}
    expect(await loadTrackPlacemarks({...OLD,placemarks:[point]})).toEqual([point])
  })

  it('restores only old points in a list containing newer point metadata',async()=>{
    fetchSource.mockResolvedValue(new Response(SOURCE))
    const current={...COMPLETE,id:'new-point'}
    const restored=await loadTrackPlacemarks({...OLD,placemarks:[LEGACY,current]})
    expect(restored[0]).toMatchObject({name:'',elevation:501.59})
    expect(restored[1]).toBe(current)
  })

  it('still reports unavailable source when no old point list exists',async()=>{
    fetchSource.mockResolvedValue(new Response('',{status:404}))
    await expect(loadTrackPlacemarks({...OLD,placemarks:undefined})).rejects.toThrow('原 KML 文件无法读取')
  })
})

describe('point restoration remains safe across hook requests',()=>{
  it('keeps old markers visible while loading and after a failed source request',async()=>{
    const pending=deferred<Response>()
    fetchSource.mockReturnValue(pending.promise)
    await render(OLD)
    expect(result.loading).toBe(true)
    expect(result.points).toBe(OLD.placemarks)
    await act(async()=>{pending.reject(new Error('Disconnected'));await pending.promise.catch(()=>{})})
    expect(result.loading).toBe(false)
    expect(result.points).toBe(OLD.placemarks)
    expect(result.error).toBe('')
  })

  it('ignores a stale recovery after switching to a record with complete metadata',async()=>{
    const pending=deferred<Response>()
    fetchSource.mockReturnValue(pending.promise)
    await render(OLD)
    const signal=fetchSource.mock.calls[0][1].signal as AbortSignal
    const points=[COMPLETE]
    await render({...OLD,id:'new',placemarks:points})
    expect(signal.aborted).toBe(true)
    expect(result.points).toBe(points)
    await act(async()=>{pending.resolve(new Response(SOURCE));await pending.promise})
    expect(result.points).toBe(points)
    expect(result.loading).toBe(false)
    expect(result.error).toBe('')
  })
})
