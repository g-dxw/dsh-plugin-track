// @vitest-environment jsdom
import {act,createElement,useEffect} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {ShotCaseLab} from '../src/client/ShotCaseLab.tsx'
import {SHOT_CASES,type ShotCasePlan} from '../src/track/shot-cases.ts'
import type {TrackRecord,TrackPlacemark} from '../src/protocol.ts'
import {editedMetrics} from '../src/track/edit.ts'
import {download} from '../src/client/util.ts'

type MapProps={plan:ShotCasePlan;progress:number;basemap:string;disabled:boolean;onCanvas:(value:HTMLCanvasElement|null)=>void;onCaptureFrame:(value:number)=>void;onUnavailable:(value:string|null)=>void;onCaptureError:(value:string|null)=>void;onBasemap:(value:string)=>void;captureRequest:number}
const state=vi.hoisted(()=>({ready:true,manualFrames:true,points:[] as TrackPlacemark[],segmentStarts:[0] as number[]|null,routeError:'',retry:vi.fn(),mapProps:null as MapProps|null}))
vi.mock('../src/client/useTrackPlacemarks.ts',()=>({useTrackPlacemarks:()=>({points:state.points,loading:!state.ready,editReady:state.ready,error:'',stateError:'',retry:state.retry,routeReady:!!state.segmentStarts,routeContext:state.segmentStarts?{segmentStarts:state.segmentStarts,references:[]}:null,routeError:state.routeError})}))
vi.mock('../src/client/ShotCaseMap.tsx',()=>({ShotCaseMap:(props:MapProps)=>{state.mapProps=props;useEffect(()=>{const canvas=document.createElement('canvas');props.onCanvas(canvas);return()=>props.onCanvas(null)},[props.onCanvas]);return createElement('div',{'data-testid':'shot-map'})}}))
vi.mock('../src/client/util.ts',async original=>({...await original<typeof import('../src/client/util.ts')>(),download:vi.fn()}))
const coordinates:TrackRecord['coordinates']=[[101,31,3000,null],[101.01,31.01,3200,null],[101.2,31.2,3400,null],[101.21,31.21,3100,null]]
const track:TrackRecord={id:'cases',name:'测试轨迹',format:'gpx',filename:'test.gpx',createdAt:'2026-10-02',bytes:80,points:4,coordinates,metrics:editedMetrics(coordinates)}
const place:TrackPlacemark={id:'peak',name:'独立山峰',coordinates:[100.8,31.4],description:'待核实峰名',images:[]}
const onCancel=vi.fn(),onPlanning=vi.fn(),onBasemap=vi.fn()
let node:HTMLDivElement,root:Root,recorders:FakeRecorder[],streams:{stop:ReturnType<typeof vi.fn>;requestFrame?:ReturnType<typeof vi.fn>}[],captureRates:number[],frames:Map<number,FrameRequestCallback>,nextFrame:number
let captureDescriptor:PropertyDescriptor|undefined,createURLDescriptor:PropertyDescriptor|undefined,revokeURLDescriptor:PropertyDescriptor|undefined
let createURL:ReturnType<typeof vi.fn>,revokeURL:ReturnType<typeof vi.fn>
class FakeRecorder {
 static isTypeSupported=vi.fn(()=>true)
 state:RecordingState='inactive';mimeType:string
 ondataavailable:((event:BlobEvent)=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null
 start=vi.fn(()=>{this.state='recording'})
 stop=vi.fn(()=>{this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['real-case-video'],{type:this.mimeType})} as BlobEvent);this.onstop?.()})})
 constructor(_stream:MediaStream,options:MediaRecorderOptions){this.mimeType=options.mimeType||'';recorders.push(this)}
}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('MediaRecorder',FakeRecorder);state.ready=true;state.manualFrames=true;state.points=[];state.segmentStarts=[0];state.routeError='';state.mapProps=null;recorders=[];streams=[];captureRates=[];frames=new Map();nextFrame=1
 vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{const id=nextFrame++;frames.set(id,callback);return id}));vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>frames.delete(id)))
 captureDescriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'captureStream');createURLDescriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL');revokeURLDescriptor=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL')
 Object.defineProperty(HTMLCanvasElement.prototype,'captureStream',{configurable:true,value:(rate:number)=>{captureRates.push(rate);const mediaTrack={stop:vi.fn(),...(state.manualFrames?{requestFrame:vi.fn()}: {})};streams.push(mediaTrack);return {getTracks:()=>[mediaTrack],getVideoTracks:()=>[mediaTrack]} as unknown as MediaStream}})
 createURL=vi.fn(()=>`blob:case-${createURL.mock.calls.length}`);revokeURL=vi.fn();Object.defineProperty(URL,'createObjectURL',{configurable:true,value:createURL});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revokeURL})
 node=document.createElement('div');document.body.append(node);root=createRoot(node)
})
afterEach(async()=>{
 await act(async()=>root.unmount());node.remove()
 for(const [target,key,descriptor] of [[HTMLCanvasElement.prototype,'captureStream',captureDescriptor],[URL,'createObjectURL',createURLDescriptor],[URL,'revokeObjectURL',revokeURLDescriptor]] as const){if(descriptor)Object.defineProperty(target,key,descriptor);else Reflect.deleteProperty(target,key)}
 vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks()
})
async function render(value=track){await act(async()=>root.render(createElement(ShotCaseLab,{track:value,basemap:'none',onBasemap,onCancel,onPlanning})))}
function button(text:string){const found=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text);if(!found)throw new Error(`Missing button ${text}`);return found}
async function click(text:string){await act(async()=>button(text).click())}
async function choose(id:string){const definition=SHOT_CASES.find(item=>item.id===id)!;const found=[...node.querySelectorAll<HTMLButtonElement>('.trk-sc-case')].find(item=>item.querySelector('strong')?.textContent===definition.label)!;await act(async()=>found.click())}
async function edit(label:string,value:string){await act(async()=>{const input=node.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
async function select(label:string,value:string){await act(async()=>{const item=node.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;item.value=value;item.dispatchEvent(new Event('change',{bubbles:true}))})}
async function frame(now:number){const callbacks=[...frames.values()];frames.clear();await act(async()=>{for(const callback of callbacks)callback(now)})}

describe('viewable shot cases without film adoption',()=>{
 it('opens narrative and basic examples directly without AI or a confirmation gate',async()=>{
  await render();expect(node.querySelectorAll('.trk-sc-case')).toHaveLength(9);expect(state.mapProps!.plan.id).toBe('route-intro');expect(node.textContent).toContain('不代表采用到成片');expect(node.textContent).toContain('怎么讲');expect(node.textContent).toContain('怎么拍');expect(node.textContent).not.toContain('确认采用');expect(onPlanning).not.toHaveBeenCalled()
  await choose('story-opening');expect(state.mapProps!.plan.id).toBe('story-opening');expect(onPlanning).not.toHaveBeenCalled();await click('进入脚本策划（后续使用）');expect(onPlanning).toHaveBeenCalledTimes(1)
 })
 it('pauses and returns to start when parameters or example type change',async()=>{
  await render();await click('看中间画面');expect(state.mapProps!.progress).toBe(.5);await edit('案例时长','8');expect(state.mapProps!.progress).toBe(0);expect(state.mapProps!.plan.duration).toBe(8)
  await click('播放案例');await frame(1000);await frame(3000);expect(state.mapProps!.progress).toBeGreaterThan(0);await choose('zoom-in');expect(state.mapProps!.progress).toBe(0);expect(node.textContent).toContain('已暂停');expect(frames.size).toBe(0)
 })
 it('pauses ordinary preview immediately when the map becomes unavailable',async()=>{
  await render();await click('播放案例');await frame(1000);await frame(3000);const previous=state.mapProps!.progress;expect(previous).toBeGreaterThan(0);expect(node.querySelector('[aria-label="案例播放状态"]')?.textContent).toContain('正在播放')
  await act(async()=>state.mapProps!.onUnavailable('WebGL 上下文已丢失，已暂停'));expect(node.querySelector('[aria-label="案例播放状态"]')?.textContent).toContain('已暂停');expect(node.querySelector('[aria-label="案例播放状态"]')?.textContent).not.toContain('正在播放');expect(frames.size).toBe(0);expect(state.mapProps!.progress).toBe(previous);expect(button('继续播放').disabled).toBe(true)
 })
 it('uses a visible independent point and hides suppressed locations',async()=>{
  state.points=[place,{...place,id:'hidden',name:'隐藏点',hidden:true}];await render();await choose('point-hold');await select('目标位置','peak');expect(state.mapProps!.plan.selectedTarget?.coordinates).toEqual(place.coordinates);expect(state.mapProps!.plan.selectedTarget?.label).toBe(place.name);expect(node.querySelector('select[aria-label="目标位置"]')?.textContent).not.toContain('隐藏点')
  await select('目标位置','route-point');await edit('目标轨迹点号','2');expect(state.mapProps!.plan.selectedTarget?.coordinates).toEqual(coordinates[1].slice(0,2))
 })
 it('preserves restored segment boundaries and explains failed source recovery',async()=>{
  state.segmentStarts=[0,2];await render();expect(state.mapProps!.plan.fullLines).toHaveLength(2);await choose('section-to-route');await edit('局部范围起点号','1');await edit('局部范围终点号','2');expect(state.mapProps!.plan.sectionLines).toHaveLength(1)
  state.segmentStarts=null;state.routeError='原始文件不存在';await render();expect(node.textContent).toContain('原轨迹分段恢复失败');expect(node.textContent).toContain('原始文件不存在')
 })
 it('blocks recording and configuration export until legacy segments recover and permits retry after failure',async()=>{
  state.segmentStarts=null;await render();expect(state.mapProps).not.toBeNull();expect(node.textContent).toContain('分段尚未核对');expect(button('录制当前案例 WebM').disabled).toBe(true);expect(button('导出案例配置 JSON').disabled).toBe(true)
  state.segmentStarts=[0,2];await render();expect(state.mapProps!.plan.fullLines).toHaveLength(2);expect(button('录制当前案例 WebM').disabled).toBe(false);expect(button('导出案例配置 JSON').disabled).toBe(false)
  state.segmentStarts=null;state.routeError='原始文件读取失败';await render();expect(button('录制当前案例 WebM').disabled).toBe(true);await click('重新读取分段信息');expect(state.retry).toHaveBeenCalledTimes(1)
  state.routeError='';state.segmentStarts=[0,2];await render();expect(button('录制当前案例 WebM').disabled).toBe(false)
  state.segmentStarts=null;await render({...track,segmentStarts:[]});expect(button('录制当前案例 WebM').disabled).toBe(false);expect(button('导出案例配置 JSON').disabled).toBe(false)
 })
 it('exports only the case identity, parameters and summary rather than source coordinates',async()=>{
  await render();await edit('示例屏幕文案','看看这条路线');await click('导出案例配置 JSON');const exported=JSON.parse(vi.mocked(download).mock.calls[0][1]);expect(exported).toMatchObject({schema:'cqai-track-shot-case@1',trackId:track.id,caseId:'route-intro',parameters:{caption:'看看这条路线'}});expect(exported.coordinates).toBeUndefined();expect(exported.fullLines).toBeUndefined();expect(exported.confirmed).toBeUndefined()
 })
 it('records from a truly painted start, freezes edits, waits for the painted last frame and releases tracks',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});await render();await click('看中间画面');await click('录制当前案例 WebM');expect(state.mapProps!.progress).toBe(0);expect(recorders[0].start).not.toHaveBeenCalled();expect(node.querySelector<HTMLInputElement>('[aria-label="案例时长"]')!.matches(':disabled')).toBe(true);expect(state.mapProps!.disabled).toBe(true)
  await act(async()=>state.mapProps!.onCaptureFrame(0));expect(recorders[0].start).toHaveBeenCalledTimes(1);expect(captureRates).toEqual([0]);expect(recorders[0].mimeType).toBe('video/webm;codecs=vp8');expect(streams[0].requestFrame).toHaveBeenCalledTimes(1);await act(async()=>state.mapProps!.onCaptureFrame(.3));expect(streams[0].requestFrame).toHaveBeenCalledTimes(2);await frame(1000);await frame(13000);expect(state.mapProps!.progress).toBe(1);expect(recorders[0].stop).not.toHaveBeenCalled()
  await act(async()=>state.mapProps!.onCaptureFrame(1));expect(streams[0].requestFrame).toHaveBeenCalledTimes(3);const initialRequest=state.mapProps!.captureRequest
  await act(async()=>vi.advanceTimersByTime(150));expect(state.mapProps!.captureRequest).toBe(initialRequest+1);expect(recorders[0].stop).not.toHaveBeenCalled();await act(async()=>state.mapProps!.onCaptureFrame(1));expect(streams[0].requestFrame).toHaveBeenCalledTimes(4)
  await act(async()=>vi.advanceTimersByTime(150));expect(state.mapProps!.captureRequest).toBe(initialRequest+2);expect(recorders[0].stop).not.toHaveBeenCalled();await act(async()=>state.mapProps!.onCaptureFrame(1));expect(streams[0].requestFrame).toHaveBeenCalledTimes(5)
  await act(async()=>vi.advanceTimersByTime(199));expect(recorders[0].stop).not.toHaveBeenCalled();await act(async()=>vi.advanceTimersByTime(1));expect(recorders[0].stop).toHaveBeenCalledTimes(1);expect(streams[0].stop).toHaveBeenCalledTimes(1);expect(node.querySelector('video')?.getAttribute('src')).toBe('blob:case-1');expect(node.querySelector('a[download]')?.textContent).toBe('下载案例 WebM')
  await edit('案例时长','6');expect(state.mapProps!.plan.duration).toBe(6);expect(node.querySelector('[aria-label="本次录制参数"]')?.textContent).toContain('12 秒');await click('导出此视频参数');const recordedConfig=JSON.parse(vi.mocked(download).mock.calls[0][1]);expect(recordedConfig.parameters.duration).toBe(12);expect(recordedConfig.caseId).toBe('route-intro');expect(recordedConfig.coordinates).toBeUndefined();expect(node.querySelector('video')?.getAttribute('src')).toBe('blob:case-1')
  await act(async()=>root.unmount());root=createRoot(node);expect(revokeURL).toHaveBeenCalledWith('blob:case-1')
 })
 it('waits for both explicit final redraws and times out if the final flush stops painting',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});await render();await click('录制当前案例 WebM');await act(async()=>state.mapProps!.onCaptureFrame(0));await frame(1000);await frame(13000);await act(async()=>state.mapProps!.onCaptureFrame(1));const initialRequest=state.mapProps!.captureRequest
  await act(async()=>state.mapProps!.onCaptureFrame(1));await act(async()=>vi.advanceTimersByTime(150));expect(state.mapProps!.captureRequest).toBe(initialRequest+1);await act(async()=>state.mapProps!.onCaptureFrame(1));await act(async()=>vi.advanceTimersByTime(150));expect(state.mapProps!.captureRequest).toBe(initialRequest+2)
  await act(async()=>vi.advanceTimersByTime(500));expect(recorders[0].stop).not.toHaveBeenCalled();expect(createURL).not.toHaveBeenCalled();await act(async()=>vi.advanceTimersByTime(4200));expect(recorders[0].stop).toHaveBeenCalledTimes(1);expect(streams[0].stop).toHaveBeenCalledTimes(1);expect(node.textContent).toContain('最后一帧地图加载超过 5 秒');expect(createURL).not.toHaveBeenCalled()
 })
 it('releases the probe stream and falls back to 30 fps when requestFrame is unavailable',async()=>{
  state.manualFrames=false;await render();await click('录制当前案例 WebM');expect(captureRates).toEqual([0,30]);expect(streams[0].stop).toHaveBeenCalledTimes(1);expect(streams[1].stop).not.toHaveBeenCalled();await act(async()=>state.mapProps!.onCaptureFrame(0));expect(recorders[0].start).toHaveBeenCalledTimes(1);await act(async()=>state.mapProps!.onCaptureFrame(.5));await click('取消录制');expect(streams[0].stop).toHaveBeenCalledTimes(1);expect(streams[1].stop).toHaveBeenCalledTimes(1);expect(createURL).not.toHaveBeenCalled()
 })
 it('cancels unfinished recording on return or unmount and ignores stale completion',async()=>{
  await render();await click('录制当前案例 WebM');await act(async()=>state.mapProps!.onCaptureFrame(0));const lateData=recorders[0].ondataavailable!,lateStop=recorders[0].onstop!
  await click('返回轨迹');expect(streams[0].stop).toHaveBeenCalledTimes(1);expect(recorders[0].stop).toHaveBeenCalledTimes(1);expect(onCancel).toHaveBeenCalledTimes(1)
  await act(async()=>{lateData({data:new Blob(['late-video'])} as BlobEvent);lateStop()});expect(createURL).not.toHaveBeenCalled();expect(node.querySelector('video')).toBeNull()
  await click('录制当前案例 WebM');await act(async()=>state.mapProps!.onCaptureFrame(0));await act(async()=>root.unmount());root=createRoot(node);expect(streams[1].stop).toHaveBeenCalledTimes(1);expect(recorders[1].stop).toHaveBeenCalledTimes(1);expect(frames.size).toBe(0)
 })
})








