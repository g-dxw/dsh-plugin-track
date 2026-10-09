// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {OpenMontagePlanning} from '../src/client/OpenMontagePlanning.tsx'
import {api, download} from '../src/client/util.ts'
import {ensureOpenMontageAgentSession, openOpenMontageProjectDrawer, sendOpenMontageAgentMessage} from '../src/client/openmontage-agent.ts'
import {observeOpenMontageBoardTheme, observeOpenMontageBoardVisibility, syncOpenMontageBoardTheme, syncOpenMontageBoardVisibility} from '../src/client/openmontage-board-theme.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord} from '../src/protocol.ts'
import type {OpenMontageConnection, OpenMontageState, OpenMontageShotScope, OpenMontageEditor} from '../src/track/openmontage.ts'
import type {EditorNavigationHandle} from '../src/client/editor-navigation.tsx'
import type {TrackAgentServicesReader} from '../src/client/useTrackAgentDrawer.ts'
import type {TrackAgentServices} from '../src/client/track-agent-session.ts'
vi.mock('../src/client/util.ts', async original=>({...await original<typeof import('../src/client/util.ts')>(),api:vi.fn(),download:vi.fn()}))
vi.mock('../src/client/openmontage-agent.ts',async original=>({...await original<typeof import('../src/client/openmontage-agent.ts')>(),ensureOpenMontageAgentSession:vi.fn(),openOpenMontageProjectDrawer:vi.fn(),sendOpenMontageAgentMessage:vi.fn()}))
vi.mock('../src/client/openmontage-board-theme.ts',()=>({observeOpenMontageBoardTheme:vi.fn(()=>vi.fn()),observeOpenMontageBoardVisibility:vi.fn(()=>vi.fn()),syncOpenMontageBoardTheme:vi.fn(),syncOpenMontageBoardVisibility:vi.fn()}))
const coords:TrackRecord['coordinates']=[[114,27,100,null],[114.01,27.01,200,null]]
const track:TrackRecord={id:'fixture',name:'武功山示例',format:'gpx',filename:'a.gpx',createdAt:'2026-10-09',bytes:90,points:2,coordinates:coords,metrics:editedMetrics(coords)}
const connection:OpenMontageConnection={ready:true,issues:[],settings:{sourceDirectory:'E:\\workspace\\project\\OpenMontage',pythonPath:'python'},projectsDirectory:'isolated'}
const project={projectId:'om-first',trackId:track.id,title:'独立策划',createdAt:'now',updatedAt:'now',workspace:'isolated/om-first',sessionId:null,pipeline:'hybrid' as const}
const shot={shotId:'shot-a',sceneId:'SC01',editor:'map' as const,purpose:'位置介绍',description:'省份到线路',startSeconds:0,endSeconds:4,requiredAssets:[],scope:{projectId:project.projectId,shotId:'shot-a',sceneId:'SC01',scenePlanDigest:'digest'},takes:[]}
let state:OpenMontageState, node:HTMLDivElement,root:Root,nav:EditorNavigationHandle|null,onOpenShot:ReturnType<typeof vi.fn<(scope:OpenMontageShotScope,editor:OpenMontageEditor)=>void>>,sources:FakeEventSource[]
class FakeEventSource {onmessage:(()=>void)|null=null;close=vi.fn();addEventListener=vi.fn();constructor(public url:string){sources.push(this)}}
let agentServices:TrackAgentServices
const getServices:TrackAgentServicesReader=()=>({...agentServices})
async function render(active=true,services?:TrackAgentServicesReader){await act(async()=>root.render(createElement(OpenMontagePlanning,{track,active,getAgentServices:services,onKeepSession:vi.fn(),onRegister:value=>{nav=value},onOpenShot})))}
async function click(label:string){const button=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label);expect(button).toBeDefined();await act(async()=>button!.click())}
async function clickPrefix(label:string){const button=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.startsWith(label));expect(button).toBeDefined();await act(async()=>button!.click())}
async function inputValue(selector:string,value:string){await act(async()=>{const field=node.querySelector<HTMLInputElement>(selector)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}))})}
async function select(value:string){await act(async()=>{const input=node.querySelector<HTMLSelectElement>('[aria-label="SC01 制作方式"]')!;input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}))})}
beforeEach(()=>{
 vi.clearAllMocks();sources=[];vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('EventSource',FakeEventSource);localStorage.clear();nav=null;onOpenShot=vi.fn()
 agentServices={sessions:{retain:vi.fn()}} as unknown as TrackAgentServices
 state={project,boardUrl:'http://127.0.0.1:49000/p/om-first',board:{storyboard:{scenes:[{id:'SC01',description:'位置介绍',duration_seconds:4,required_assets:[{type:'video',source:'record',description:'地图录制'}]}]}},stages:[{stage:'scene_plan',status:'completed',digest:'digest',approved:true}],currentStage:'assets',scenePlanDigest:'digest',canProduce:true,shots:[],issues:[]}
 vi.mocked(api).mockImplementation(async(action,payload)=>{
  if(action==='openmontage-settings')return {...connection,settings:payload||connection.settings}
  if(action.startsWith('openmontage-projects?'))return {projects:[project]}
  if(action.startsWith('openmontage-state?'))return structuredClone(state)
  if(action==='openmontage-projects')return {project:{...project,projectId:'om-second'}}
  if(action==='openmontage-shot')return {shot,state:{...state,shots:[shot]}}
  throw new Error(action)
 })
 vi.mocked(ensureOpenMontageAgentSession).mockResolvedValue({trackId:'fixture',projectId:project.projectId,sessionId:'native-session',workspaceId:'workspace',path:'isolated',initialPrompt:'read guide',environment:{}})
 vi.mocked(openOpenMontageProjectDrawer).mockResolvedValue({open:true,panelId:'cqai-track',entityId:project.projectId,requestId:'drawer',sessionId:'native-session',title:'test',side:'left',mode:'simple'})
 vi.mocked(sendOpenMontageAgentMessage).mockImplementation(async(_services,session,_text,options)=>({status:'accepted',sessionId:session.sessionId,requestId:options.requestId}))
 node=document.createElement('div');document.body.append(node);root=createRoot(node)
})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();localStorage.clear()})
it('embeds the actual board URL without creating a project or starting AI on entry',async()=>{
 await render();expect(node.querySelector('iframe')?.getAttribute('src')).toBe(state.boardUrl);expect(sources).toHaveLength(1)
 expect(ensureOpenMontageAgentSession).not.toHaveBeenCalled();expect(sendOpenMontageAgentMessage).not.toHaveBeenCalled();expect(api).not.toHaveBeenCalledWith('openmontage-projects',expect.anything())
 expect(node.textContent).toContain('原生 Desktop Agent')
})
it('unmounts the iframe and closes events while inactive, then reconnects on return',async()=>{
 await render();await render(false);expect(node.querySelector('iframe')).toBeNull();expect(sources[0].close).toHaveBeenCalledOnce();await render();expect(node.querySelector('iframe')).not.toBeNull();expect(sources).toHaveLength(2)
})
it('opens a separate native drawer and sends scoped work only on the explicit continue action',async()=>{
 await render(true,getServices);await click('打开项目 Agent');expect(openOpenMontageProjectDrawer).toHaveBeenCalledOnce();expect(sendOpenMontageAgentMessage).not.toHaveBeenCalled()
 await click('开始 / 继续策划');expect(sendOpenMontageAgentMessage).toHaveBeenCalledOnce();expect(vi.mocked(sendOpenMontageAgentMessage).mock.calls[0][2]).toContain('分别提交审阅并等待我在对话中确认');expect(node.textContent).toContain('阶段成果以看板文件为准')
})
it('binds a confirmed scene before opening the chosen editor and honors the non-editor choice',async()=>{
 await render();await select('sandbox');await click('进入镜头编辑');expect(api).toHaveBeenCalledWith('openmontage-shot',{trackId:track.id,projectId:project.projectId,sceneId:'SC01',editor:'sandbox',expectedScenePlanDigest:'digest'});expect(onOpenShot).toHaveBeenCalledWith(shot.scope,'sandbox')
 await select('none');expect([...node.querySelectorAll('button')].some(button=>button.textContent==='进入镜头编辑')).toBe(false)
})
it('blocks production until all prerequisite approvals are valid',async()=>{
 state.canProduce=false;state.issues=['分镜需重新确认'];await render();await select('map');expect([...node.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='进入镜头编辑')?.disabled).toBe(true);expect(onOpenShot).not.toHaveBeenCalled()
})
it('shows native selected visual and audio resources for scenes that use existing material',async()=>{
 state.board.storyboard={scenes:[{id:'SC03',description:'用户提供的风景素材',visual:{id:'photo-one',type:'image',path:'assets/image/wugongshan.jpg',exists:true},audio:[{id:'sound-one',type:'audio',path:'assets/audio/ambient.wav',exists:false}]}]}
 await render();expect(node.textContent).toContain('已选素材');expect(node.textContent).toContain('图片 · wugongshan.jpg');expect(node.textContent).toContain('音频 · ambient.wav · 文件缺失');expect(onOpenShot).not.toHaveBeenCalled()
})
it('keeps connection edits after failed saves and requires the common leave decision',async()=>{
 await render();await click('连接设置');await act(async()=>{const field=node.querySelector<HTMLInputElement>('.trk-om-config input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'new/source');field.dispatchEvent(new Event('input',{bubbles:true}))})
 const leave=vi.fn();await act(async()=>nav!.requestLeave(leave));expect(node.querySelector('[role=dialog]')).not.toBeNull()
 vi.mocked(api).mockRejectedValueOnce(new Error('无法保存'));await click('保存后继续');expect(leave).not.toHaveBeenCalled();expect(node.querySelector<HTMLInputElement>('.trk-om-config input')!.value).toBe('new/source');await click('放弃本次修改');expect(leave).toHaveBeenCalledOnce();expect(node.querySelector<HTMLInputElement>('.trk-om-config input')!.value).toBe(connection.settings.sourceDirectory)
})
it('keeps old browser drafts available as exact backups and never converts or writes them',async()=>{
 const raw='{"old":"original"}';localStorage.setItem('cqai-track.video-script.fixture',raw);await render();await click('下载旧草稿备份');expect(download).toHaveBeenCalledWith(expect.stringContaining('旧版脚本'),raw);expect(localStorage.getItem('cqai-track.video-script.fixture')).toBe(raw)
})
it('shows concrete connection issues and refuses to embed a non-loopback URL',async()=>{
 state.boardUrl='https://unexpected.example/p/om-first';await render();expect(node.querySelector('iframe')).toBeNull()
})
it('reuses the request identity after an unknown Agent acceptance instead of sending another prompt',async()=>{
 vi.mocked(sendOpenMontageAgentMessage).mockRejectedValueOnce(new Error('接受状态未知'));await render(true,getServices);await click('开始 / 继续策划');await click('开始 / 继续策划')
 const calls=vi.mocked(sendOpenMontageAgentMessage).mock.calls;expect(calls).toHaveLength(2);expect(calls[0][2]).toBe(calls[1][2]);expect(calls[0][3].requestId).toBe(calls[1][3].requestId)
})
it('does not resend late native acceptance after cancellation, unmount and explicit reentry',async()=>{
 const actual=await vi.importActual<typeof import('../src/client/openmontage-agent.ts')>('../src/client/openmontage-agent.ts')
 let accepted!:()=>void;const pendingAcceptance=new Promise<void>(resolve=>{accepted=resolve}),nativeSend=vi.fn(async(_text:string)=>{}).mockReturnValueOnce(pendingAcceptance)
 agentServices={sessions:{list:{getSnapshot:()=>({phase:'ready',ids:['native-session'],byId:{'native-session':{}}}),subscribe:()=>()=>{}},refresh:vi.fn(async()=>{}),create:vi.fn(async()=>{throw new Error('Unexpected new session')}),scope:()=>({conversation:{send:nativeSend}})},
  workspaces:{list:{getSnapshot:()=>({phase:'ready',items:[{workspaceId:'workspace',sessionIds:['native-session']}],archivedSessionIds:[]}),subscribe:()=>()=>{}},create:vi.fn(async()=>({workspaceId:'workspace'}))},
  uiWorkspace:{openSession:vi.fn()},layout:{selectPanel:vi.fn()},api:async<T>(action:string,data:unknown):Promise<T>=>{const input=data as {trackId:string;projectId:string;sessionId:string};return(action==='openmontage-agent-workspace'?{...input,path:'isolated',sessionId:'native-session',environment:{},initialPrompt:'original guide'}:{sessionId:input.sessionId}) as T}}
 vi.mocked(ensureOpenMontageAgentSession).mockImplementation(actual.ensureOpenMontageAgentSession);vi.mocked(sendOpenMontageAgentMessage).mockImplementation(actual.sendOpenMontageAgentMessage)
 await render(true,getServices);expect(nativeSend).not.toHaveBeenCalled();await click('开始 / 继续策划');expect(nativeSend).toHaveBeenCalledOnce()
 const original=vi.mocked(sendOpenMontageAgentMessage).mock.calls[0];await click('取消等待');await act(async()=>root.unmount());root=createRoot(node)
 await act(async()=>accepted());await render(true,getServices);expect(nativeSend).toHaveBeenCalledOnce()
 await click('开始 / 继续策划');const retry=vi.mocked(sendOpenMontageAgentMessage).mock.calls[1]
 expect(retry[2]).toBe(original[2]);expect(retry[3].requestId).toBe(original[3].requestId);expect(nativeSend).toHaveBeenCalledOnce();expect(node.textContent).toContain('要求已发送到项目 Agent')
 await click('开始 / 继续策划');expect(nativeSend).toHaveBeenCalledTimes(2);expect(vi.mocked(sendOpenMontageAgentMessage).mock.calls[2][3].requestId).not.toBe(original[3].requestId)
})
it('keeps non-cancellable writes busy and offers no cancel-wait escape during project creation',async()=>{
 let finish!:(value:unknown)=>void;vi.mocked(api).mockImplementationOnce(()=>Promise.resolve(connection));await render()
 const normal=vi.mocked(api).getMockImplementation()!;vi.mocked(api).mockImplementation((action,payload)=>action==='openmontage-projects'?new Promise(resolve=>{finish=resolve}):normal(action,payload))
 await click('新建项目');await click('创建项目');expect([...node.querySelectorAll('button')].some(button=>button.textContent==='取消等待')).toBe(false);expect(nav?.busy).toBe(true)
 await act(async()=>finish({project:{...project,projectId:'om-second'}}));expect(nav?.busy).toBe(false)
})
it('reveals project creation only on demand and preserves the exact project title API',async()=>{
 await render();expect(node.querySelector('#trk-om-new-project')).toBeNull();await click('新建项目');expect(api).not.toHaveBeenCalledWith('openmontage-projects',expect.anything())
 await inputValue('#trk-om-new-project input','  新的武功山策划  ');await click('创建项目')
 expect(api).toHaveBeenCalledWith('openmontage-projects',{trackId:'fixture',title:'新的武功山策划'});expect(node.querySelector('#trk-om-new-project')).toBeNull()
 expect(node.querySelector<HTMLSelectElement>('.trk-om-projects select')?.value).toBe('om-second');expect(sendOpenMontageAgentMessage).not.toHaveBeenCalled()
})
it('explains disabled Agent controls and keeps connection details collapsed when ready',async()=>{
 await render();expect(node.querySelector('#trk-om-config')).toBeNull()
 const button=[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent==='开始 / 继续策划')!
 expect(button.disabled).toBe(true);expect(button.title).toContain('原生 Desktop Agent');expect(button.getAttribute('aria-describedby')).toBe('trk-om-agent-help');expect(node.querySelector('#trk-om-agent-help')?.textContent).toContain('当前浏览器可查看成果')
 expect(node.querySelector('.trk-om-connection')?.textContent).toBe('本地已连接')
})
it('keeps the same iframe and event stream while focusing, hiding the list and switching mobile panels',async()=>{
 await render();const iframe=node.querySelector('iframe'),eventSource=sources[0]
 await click('收起镜头清单');expect(node.querySelector('.trk-om')?.getAttribute('data-show-shots')).toBe('false');expect(node.querySelector('iframe')).toBe(iframe)
 await click('显示镜头清单');await clickPrefix('镜头清单（');expect(node.querySelector('.trk-om')?.getAttribute('data-mobile-panel')).toBe('shots');expect(node.querySelector('iframe')).toBe(iframe)
 await click('专注看板');expect(node.querySelector('.trk-om')?.getAttribute('data-focus')).toBe('true');expect(node.querySelector('.trk-om')?.getAttribute('data-mobile-panel')).toBe('board');expect(node.querySelector('iframe')).toBe(iframe)
 await click('退出专注');expect(node.querySelector('iframe')).toBe(iframe);expect(sources).toHaveLength(1);expect(eventSource.close).not.toHaveBeenCalled();expect(sendOpenMontageAgentMessage).not.toHaveBeenCalled()
})
it('syncs board visibility for layout changes and loading, and releases both observers on leaving',async()=>{
 await render();const iframe=node.querySelector('iframe')!,themeCleanup=vi.mocked(observeOpenMontageBoardTheme).mock.results[0].value,visibilityCleanup=vi.mocked(observeOpenMontageBoardVisibility).mock.results[0].value
 expect(observeOpenMontageBoardVisibility).toHaveBeenCalledWith(iframe);vi.mocked(syncOpenMontageBoardVisibility).mockClear()
 await clickPrefix('镜头清单（');expect(syncOpenMontageBoardVisibility).toHaveBeenCalledWith(iframe);vi.mocked(syncOpenMontageBoardVisibility).mockClear()
 await click('专注看板');expect(syncOpenMontageBoardVisibility).toHaveBeenCalledWith(iframe)
 await act(async()=>iframe.dispatchEvent(new Event('load')));expect(syncOpenMontageBoardTheme).toHaveBeenCalledWith(iframe,node.querySelector('.trk-om'));expect(syncOpenMontageBoardVisibility).toHaveBeenLastCalledWith(iframe)
 expect(node.querySelector('iframe')).toBe(iframe);await render(false);expect(themeCleanup).toHaveBeenCalledOnce();expect(visibilityCleanup).toHaveBeenCalledOnce()
})
it('filters and searches only the shot list while retaining narration, editor choices and native board',async()=>{
 state.board.storyboard={scenes:[{id:'SC01',description:'省份位置地图',duration_seconds:4,narration:'江西与湖南之间'},{id:'SC02',description:'山脊介绍',duration_seconds:7},{id:'SC03',description:'自带风景',visual:{id:'photo',type:'image',exists:true,path:'user.jpg'}}]}
 state.shots=[{...shot,takes:[{takeId:'take-one',shotId:shot.shotId,sceneId:'SC01',editor:'map',scenePlanDigest:'digest',projectRevision:'revision',sha256:'sha',bytes:100,mime:'video/webm',width:1280,height:720,duration:4,createdAt:'now',path:'record.webm',url:'/record.webm'}]}]
 await render();const iframe=node.querySelector('iframe');expect(node.querySelectorAll('.trk-om-shot-list article')).toHaveLength(3)
 await select('sandbox');await clickPrefix('待制作 ');expect([...node.querySelectorAll('.trk-om-shot-list article')].map(item=>item.getAttribute('aria-label'))).toEqual(['SC02 镜头'])
 await clickPrefix('已回填 ');expect(node.querySelectorAll('.trk-om-shot-list article')).toHaveLength(1);expect(node.querySelector<HTMLSelectElement>('[aria-label="SC01 制作方式"]')?.value).toBe('sandbox')
 await inputValue('.trk-om-shot-search input','湖南');expect(node.querySelectorAll('.trk-om-shot-list article')).toHaveLength(1)
 const narration=node.querySelector('.trk-om-shot-list details')!;expect(narration.textContent).toContain('江西与湖南之间');expect(narration.hasAttribute('open')).toBe(false)
 await inputValue('.trk-om-shot-search input','不存在的镜头');expect(node.textContent).toContain('没有匹配的镜头');await click('清除筛选');expect(node.querySelectorAll('.trk-om-shot-list article')).toHaveLength(3)
 expect(node.querySelector('iframe')).toBe(iframe);expect(sources).toHaveLength(1)
})
it('distinguishes submitted artifacts from human approval and directs review to the conversation',async()=>{
 state.stages=[{stage:'idea',status:'completed',digest:'idea',approved:false},{stage:'script',status:'pending',digest:null,approved:false},{stage:'scene_plan',status:'pending',digest:null,approved:false}];state.canProduce=false;state.currentStage='idea'
 await render();const stages=[...node.querySelectorAll('.trk-om-progress li')];expect(stages).toHaveLength(3);expect(stages[0].getAttribute('data-approved')).toBe('false');expect(stages[0].textContent).toContain('已提交');expect(stages[0].getAttribute('aria-current')).toBe('step')
 expect(node.querySelector('.trk-om-next')?.textContent).toContain('在 Agent 对话中继续需求与大纲');expect(node.querySelector('.trk-om-next')?.textContent).toContain('0/3 已确认')
 state.stages[0].status='awaiting_human';await click('刷新成果');expect(node.querySelector('.trk-om-next')?.textContent).toContain('再到 Agent 对话中确认')
 expect(ensureOpenMontageAgentSession).not.toHaveBeenCalled()
})
