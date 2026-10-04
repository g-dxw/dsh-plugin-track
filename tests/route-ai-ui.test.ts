// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {RouteInsights} from '../src/client/RouteInsights.tsx'
import {AnimationStudio} from '../src/client/AnimationStudio.tsx'
import {editedMetrics} from '../src/track/edit.ts'
import {loadTextModels,analyzeRoute,generateAnimationScript} from '../src/client/text-ai.ts'
import {api} from '../src/client/util.ts'
import type {TrackRecord} from '../src/protocol.ts'
const renderer=vi.hoisted(()=>({props:null as Record<string,unknown>|null}))
vi.mock('../src/client/text-ai.ts',()=>({loadTextModels:vi.fn(),analyzeRoute:vi.fn(),generateAnimationScript:vi.fn()}))
vi.mock('../src/client/MapView.tsx',()=>({MapView:()=>createElement('div',{'data-testid':'map'})}))
vi.mock('../src/client/TrackAnimation.tsx',()=>({TrackAnimation:(props:Record<string,unknown>)=>{renderer.props=props;return createElement('div',{'data-testid':'animation'})}}))
vi.mock('../src/client/util.ts',async original=>({...await original<typeof import('../src/client/util.ts')>(),api:vi.fn()}))
const coordinates:TrackRecord['coordinates']=Array.from({length:120},(_,index)=>[119+index*.001,30,index%2?null:500,null])
const track:TrackRecord={id:'route',name:'测试路线',filename:'source.gpx',createdAt:'2026-10-01',bytes:100,format:'gpx',points:coordinates.length,coordinates,metrics:editedMetrics(coordinates)}
const analysis={summary:'已知路线摘要',difficulty:'中等，仅按里程参考',audience:['有徒步经验者'],equipment:['饮水'],checkpoints:['山口'],restPoints:['第 60 点需确认'],limitations:['路况待核实']}
const script={title:'路线镜头',shots:[{type:'overview' as const,duration:3,narration:'全景'},{type:'follow' as const,duration:3,narration:'沿线'},{type:'checkpoint' as const,duration:3,pointIndex:59,narration:'山口'}]}
let root:Root,node:HTMLDivElement
const onCancel=vi.fn()
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.clearAllMocks();localStorage.clear();renderer.props=null;node=document.createElement('div');document.body.append(node);root=createRoot(node)
 vi.mocked(loadTextModels).mockResolvedValue({models:[{id:'a',label:'模型 A'},{id:'b',label:'模型 B'}],available:true})
 vi.mocked(api).mockResolvedValue({annotations:[{id:'poi',pointIndex:59,label:'山口',kind:'checkin',color:'#7c3aed',photo:{dataUrl:'private photo'}}]})
 vi.mocked(analyzeRoute).mockResolvedValue(analysis);vi.mocked(generateAnimationScript).mockResolvedValue(script)
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
async function render(kind:'analysis'|'script'){await act(async()=>root.render(kind==='analysis'?createElement(RouteInsights,{track}):createElement(AnimationStudio,{track,basemap:'none',onBasemap:vi.fn(),onCancel})))}
function button(text:string){const found=[...node.querySelectorAll<HTMLButtonElement>('button')].find(el=>el.textContent===text);if(!found)throw new Error(text);return found}
async function click(text:string){await act(async()=>button(text).click())}
async function select(label:string,value:string){await act(async()=>{const el=node.querySelector<HTMLSelectElement>('select[aria-label="'+label+'"]')!;el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))})}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve}}
describe('explicit AI route analysis and script approval flow',()=>{
 it('requires model selection and does not generate by entering a detail',async()=>{
  await render('analysis');expect(button('生成路线分析').disabled).toBe(true);expect(analyzeRoute).not.toHaveBeenCalled();expect(api).not.toHaveBeenCalled()
 })
 it('sends bounded facts and labels, excluding files and private photographs',async()=>{
  await render('analysis');await select('路线分析模型','b');await click('生成路线分析')
  const[request,signal]=vi.mocked(analyzeRoute).mock.calls[0];expect(request.model).toBe('b');expect(signal).toBeInstanceOf(AbortSignal);expect(request.context.coordinates.length).toBeLessThanOrEqual(80)
  expect(request.context.annotations).toEqual([{pointIndex:59,label:'山口',kind:'checkin'}]);expect(JSON.stringify(request)).not.toContain('private photo');expect(request.context.elevationCoverage).toBe(.5)
  for(const label of ['打卡点','休息点','适合人群','所需装备','待核实与限制'])expect(node.textContent).toContain(label)
  expect(JSON.parse(localStorage.getItem('cqai-track.analysis.route')!)).toEqual(analysis)
 })
 it('retains an existing analysis if a later request fails',async()=>{
  await render('analysis');await select('路线分析模型','a');await click('生成路线分析');vi.mocked(analyzeRoute).mockRejectedValue(new Error('模型超时'));await click('生成路线分析')
  expect(node.textContent).toContain('模型超时');expect(node.textContent).toContain('已知路线摘要')
 })
 it('cancels the active request and ignores its late result',async()=>{
  const late=deferred<typeof analysis>();vi.mocked(analyzeRoute).mockReturnValue(late.promise);await render('analysis');await select('路线分析模型','a');await click('生成路线分析')
  const signal=vi.mocked(analyzeRoute).mock.calls[0][1]!;await click('取消分析');expect(signal.aborted).toBe(true);await act(async()=>late.resolve(analysis));expect(node.querySelector('[aria-label="路线分析结果"]')).toBeNull()
 })
 it('requires AI generation and explicit script adoption before opening the recorder',async()=>{
  await render('script');expect(renderer.props).toBeNull();expect(generateAnimationScript).not.toHaveBeenCalled();await select('动画脚本模型','a');await click('AI 生成录制脚本')
  expect(node.querySelector('[aria-label="动画镜头脚本"]')).not.toBeNull();expect(node.textContent).toContain('总时长 9 秒');expect(renderer.props).toBeNull()
  await click('采用脚本，进入播放与录制');expect(renderer.props!.script).toEqual(script.shots);expect(renderer.props!.track).toBe(track)
 })
 it('keeps an earlier script on AI failure and never fabricates one',async()=>{
  await render('script');await select('动画脚本模型','a');vi.mocked(generateAnimationScript).mockRejectedValue(new Error('JSON格式无效'));await click('AI 生成录制脚本')
  expect(renderer.props).toBeNull();expect(node.querySelector('[aria-label="动画镜头脚本"]')).toBeNull();expect(node.textContent).toContain('JSON格式无效')
  vi.mocked(generateAnimationScript).mockResolvedValue(script);await click('AI 生成录制脚本');vi.mocked(generateAnimationScript).mockRejectedValue(new Error('失败'));await click('AI 生成录制脚本');expect(node.textContent).toContain('路线镜头')
 })
 it('aborts text generation and model loading on page unmount',async()=>{
  const late=deferred<typeof script>();vi.mocked(generateAnimationScript).mockReturnValue(late.promise);await render('script');await select('动画脚本模型','a');await click('AI 生成录制脚本')
  const requestSignal=vi.mocked(generateAnimationScript).mock.calls[0][1]!,catalogSignal=vi.mocked(loadTextModels).mock.calls[0][0]!
  await act(async()=>root.unmount());root=createRoot(node);expect(requestSignal.aborted).toBe(true);expect(catalogSignal.aborted).toBe(true);await act(async()=>late.resolve(script));expect(renderer.props).toBeNull()
 })
})
describe('restored analysis cache validation',()=>{
 it('ignores malformed cached list members without losing the track detail UI',async()=>{
  localStorage.setItem('cqai-track.analysis.route',JSON.stringify({...analysis,checkpoints:[{}]}))
  await render('analysis');expect(node.querySelector('[aria-label="路线分析结果"]')).toBeNull();expect(button('生成路线分析')).not.toBeNull()
 })
})
describe('previously generated animation script cache',()=>{
 it('restores a valid reviewed script without paying for generation again',async()=>{
  localStorage.setItem('cqai-track.animation-script.route',JSON.stringify({version:1,script}))
  await render('script');expect(node.textContent).toContain('路线镜头');expect(generateAnimationScript).not.toHaveBeenCalled();expect(renderer.props).toBeNull()
  await click('采用脚本，进入播放与录制');expect(renderer.props!.script).toEqual(script.shots)
 })
 it('ignores malformed cached shots and allows fresh AI generation',async()=>{
  localStorage.setItem('cqai-track.animation-script.route',JSON.stringify({version:1,script:{...script,shots:[{type:'overview',duration:3,narration:{bad:'child'}},{type:'follow',duration:3}]}}))
  await render('script');expect(node.querySelector('[aria-label="动画镜头脚本"]')).toBeNull();expect(button('AI 生成录制脚本')).not.toBeNull()
 })
})