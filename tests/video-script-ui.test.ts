// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {TrackVideoScriptPlanning as TrackVideoScript} from '../src/client/TrackVideoScript.tsx'
import {analyzeVideoScript,createVideoScriptDraft} from '../src/track/video-script.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord,TrackPlacemark} from '../src/protocol.ts'
import type {VideoScriptSuggestion} from '../src/track/video-script-types.ts'
import {generateVideoScript} from '../src/client/video-script-ai.ts'
import {api,download} from '../src/client/util.ts'

const state=vi.hoisted(()=>({ready:true,points:[] as TrackPlacemark[],retry:vi.fn(),mapProps:null as Record<string,unknown>|null}))
vi.mock('../src/client/useTrackPlacemarks.ts',()=>({useTrackPlacemarks:()=>({points:state.points,loading:!state.ready,editReady:state.ready,error:'',stateError:'',retry:state.retry})}))
vi.mock('../src/client/useTextModels.ts',()=>({useTextModels:()=>({catalog:{available:true,models:[{id:'model',label:'模型'}]},model:'model',setModel:vi.fn(),reload:vi.fn()})}))
vi.mock('../src/client/video-script-ai.ts',()=>({generateVideoScript:vi.fn()}))
vi.mock('../src/client/MapView.tsx',()=>({MapView:(props:Record<string,unknown>)=>{state.mapProps=props;return createElement('div',{'data-testid':'map'})}}))
vi.mock('../src/client/util.ts',async original=>({...await original<typeof import('../src/client/util.ts')>(),api:vi.fn(),download:vi.fn()}))
const coordinates:TrackRecord['coordinates']=[[101,31,3000,null],[101.01,31.01,3200,null],[101.02,31.02,3400,null],[101.03,31.03,3100,null]]
const track:TrackRecord={id:'test',name:'测试轨迹',format:'gpx',filename:'test.gpx',createdAt:'2026-10-02',bytes:80,points:4,coordinates,segmentStarts:[0],metrics:editedMetrics(coordinates)}
let root:Root,node:HTMLDivElement
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();state.ready=true;state.points=[];state.mapProps=null;vi.mocked(api).mockResolvedValue({annotations:[]});node=document.createElement('div');document.body.append(node);root=createRoot(node)})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
async function render(){await act(async()=>root.render(createElement(TrackVideoScript,{track,basemap:'none',onBasemap:vi.fn(),onCancel:vi.fn()})))}
function button(text:string){const found=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text);if(!found)throw new Error(`Button missing: ${text}`);return found}
async function click(text:string){await act(async()=>button(text).click())}
async function pick(index=0){const choices=[...node.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter(item=>!item.disabled);await act(async()=>choices[index].click())}
async function build(){await pick();await click('确认选题，建立脚本草稿')}
async function edit(label:string,value:string){await act(async()=>{const input=node.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;const setter=Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!;setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
function cached(){return JSON.parse(localStorage.getItem('cqai-track.video-script.test')!).draft}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}}
function suggestion():VideoScriptSuggestion {const analysis=analyzeVideoScript(track,[],[]),draft=createVideoScriptDraft(analysis,[analysis.candidates.find(candidate=>candidate.readiness==='ready')!.id],'');return {title:'AI 建议标题',shots:draft.shots.map(shot=>({...shot,narration:'AI 新旁白',confirmed:false}))}}

describe('route video script review workspace',()=>{
  it('waits for saved point state, never calls AI on entry, and blocks missing information',async()=>{
    state.ready=false;await render();expect(node.textContent).toContain('正在读取');expect(node.querySelector('[data-candidate-id]')).toBeNull();expect(generateVideoScript).not.toHaveBeenCalled()
    state.ready=true;await render();expect(node.querySelectorAll('[data-candidate-id]').length).toBeGreaterThan(0);expect(node.textContent).toContain('需要补充');expect([...node.querySelectorAll<HTMLInputElement>('.needs-info input')].every(item=>item.disabled)).toBe(true);expect(button('确认选题，建立脚本草稿').disabled).toBe(true)
  })
  it('persists explicit selection and invalidates confirmation when the shot changes, with undo',async()=>{
    await render();await build();expect(cached().shots[0].confirmed).toBe(false);await click('确认当前镜头');expect(cached().shots[0].confirmed).toBe(true)
    await edit('对应旁白脚本','人工新旁白');expect(cached().shots[0].narration).toBe('人工新旁白');expect(cached().shots[0].confirmed).toBe(false)
    await click('撤销最近修改');expect(cached().shots[0].confirmed).toBe(true);await click('恢复最近修改');expect(cached().shots[0].confirmed).toBe(false)
    await edit('镜头时长','2');expect(node.textContent).toContain('修改尚未保存');expect(button('确认当前镜头').disabled).toBe(true);expect(cached().shots[0].duration).not.toBe(2)
  })
  it('keeps AI output separate until adoption and requires fresh confirmation',async()=>{
    await render();await build();await click('确认当前镜头');vi.mocked(generateVideoScript).mockResolvedValue(suggestion());await click('AI 提出脚本建议')
    expect(cached().title).not.toBe('AI 建议标题');expect(node.querySelector('[aria-label="待采用的 AI 建议"]')).not.toBeNull();await click('采用 AI 建议');expect(cached().title).toBe('AI 建议标题');expect(cached().shots[0].confirmed).toBe(false)
    await click('撤销最近修改');expect(cached().shots[0].confirmed).toBe(true)
  })
  it('cancels and discards late AI output after human editing and on unmount',async()=>{
    const late=deferred<VideoScriptSuggestion>();vi.mocked(generateVideoScript).mockReturnValue(late.promise);await render();await build();await click('AI 提出脚本建议');const signal=vi.mocked(generateVideoScript).mock.calls[0][1]!
    await edit('对应旁白脚本','继续人工编辑');expect(signal.aborted).toBe(true);await act(async()=>late.resolve(suggestion()));expect(node.querySelector('[aria-label="待采用的 AI 建议"]')).toBeNull();expect(cached().shots[0].narration).toBe('继续人工编辑')
    const second=deferred<VideoScriptSuggestion>();vi.mocked(generateVideoScript).mockReturnValue(second.promise);await click('AI 提出脚本建议');const secondSignal=vi.mocked(generateVideoScript).mock.calls[1][1]!;await act(async()=>root.unmount());root=createRoot(node);expect(secondSignal.aborted).toBe(true);await act(async()=>second.resolve(suggestion()));expect(node.textContent).toBe('')
  })
  it('retains a human draft on AI failure and exports the analysis plus confirmation state',async()=>{
    await render();await build();await edit('对应旁白脚本','人工旁白');vi.mocked(generateVideoScript).mockRejectedValue(new Error('模型超时'));await click('AI 提出脚本建议');expect(node.textContent).toContain('模型超时');expect(cached().shots[0].narration).toBe('人工旁白')
    await click('导出脚本 JSON');const content=JSON.parse(vi.mocked(download).mock.calls[0][1]);expect(content.schema).toBe('cqai-track-video-script@1');expect(content.analysis.trackId).toBe(track.id);expect(content.draft.shots[0].confirmed).toBe(false)
    await click('导出脚本 Markdown');expect(vi.mocked(download).mock.calls[1][2]).toBe('text/markdown')
  })
  it('retains invalid or stale cached text until explicit creation of a new draft',async()=>{
    const old='{"version":1,"draft":{"fingerprint":"stale","title":"旧草稿"}}';localStorage.setItem('cqai-track.video-script.test',old);await render();expect(node.textContent).toContain('已保留原缓存');expect(localStorage.getItem('cqai-track.video-script.test')).toBe(old);await build();expect(localStorage.getItem('cqai-track.video-script.test')).not.toBe(old)
  })
  it('requires a separate replacement action after reselecting scenes and restores the old draft with undo',async()=>{
    await render();await build();await edit('对应旁白脚本','保留我的文案');await click('返回选题');await pick(1);await click('确认选题，建立脚本草稿');expect(node.textContent).toContain('采用新选题会替换');expect(cached().shots[0].narration).toBe('保留我的文案')
    await click('采用新选题，替换草稿');expect(cached().shots).toHaveLength(2);await click('撤销最近修改');expect(cached().shots).toHaveLength(1);expect(cached().shots[0].narration).toBe('保留我的文案')
  })
})
