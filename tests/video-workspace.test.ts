// @vitest-environment jsdom
import {act,createElement,useEffect,useState} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {TrackVideoScript} from '../src/client/TrackVideoScript.tsx'
import {api} from '../src/client/util.ts'
import {useTextModels} from '../src/client/useTextModels.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord} from '../src/protocol.ts'
import type {EditorNavigationHandle} from '../src/client/editor-navigation.tsx'
import type {ShotCaptureStore} from '../src/client/shot-capture-store.ts'
import {freezeShotResult} from '../src/client/shot-result-bridge.tsx'
const state=vi.hoisted(()=>({mapLeave:vi.fn((next:()=>void)=>next()),sandboxLeave:vi.fn((next:()=>void)=>next()),busy:false,captureStore:null as ShotCaptureStore|null}))
type EditorProps={active?:boolean;onRegister?:(handle:EditorNavigationHandle|null)=>void;captureStore?:ShotCaptureStore}
function MockEditor({active,onRegister,kind,captureStore}:{active?:boolean;onRegister?:EditorProps['onRegister'];kind:'map'|'sandbox';captureStore?:ShotCaptureStore}) {
 if(captureStore)state.captureStore=captureStore
 const [count,setCount]=useState(0)
 useEffect(()=>{if(!active)return;onRegister?.({requestLeave:kind==='map'?state.mapLeave:state.sandboxLeave,busy:state.busy});return()=>onRegister?.(null)},[active,onRegister,kind])
 return createElement('section',{'aria-label':kind==='map'?'地图编辑器':'沙盘编辑器'},active?createElement('div',{'data-renderer':kind}):null,createElement('button',{onClick:()=>setCount(value=>value+1)},`编辑次数 ${count}`))
}
vi.mock('../src/client/GeoMotionEditor.tsx',()=>({GeoMotionEditor:(props:EditorProps)=>createElement(MockEditor,{...props,kind:'map'})}))
vi.mock('../src/client/ShotEditor.tsx',()=>({ShotEditor:(props:EditorProps)=>createElement(MockEditor,{...props,kind:'sandbox'})}))
vi.mock('../src/client/VideoMaterialPrep.tsx',()=>({VideoMaterialPrep:({onCompose}:{onCompose:(document:unknown)=>void})=>createElement('section',{'aria-label':'素材准备编辑器'},createElement('button',{onClick:()=>onCompose({version:1,trackId:'workspace'})},'用所选素材编排镜头'))}))
vi.mock('../src/client/useTextModels.ts',()=>({useTextModels:vi.fn(()=>({catalog:{available:false,models:[]},model:'',setModel:vi.fn(),reload:vi.fn()}))}))
vi.mock('../src/client/useTrackPlacemarks.ts',()=>({useTrackPlacemarks:()=>({points:[],groups:[],loading:false,editReady:true,error:'',stateError:'',retry:vi.fn()})}))
vi.mock('../src/client/MapView.tsx',()=>({MapView:()=>null}))
vi.mock('../src/client/util.ts',async original=>({...await original<typeof import('../src/client/util.ts')>(),api:vi.fn()}))
const coordinates:TrackRecord['coordinates']=[[120,30,100,null],[120.01,30,150,null]]
const track:TrackRecord={id:'workspace',name:'示例数据',format:'gpx',filename:'test.gpx',createdAt:'2026-10-02',bytes:80,points:2,coordinates,metrics:editedMetrics(coordinates)}
let node:HTMLDivElement,root:Root
beforeEach(()=>{vi.clearAllMocks();state.mapLeave.mockImplementation(next=>next());state.sandboxLeave.mockImplementation(next=>next());state.busy=false;vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();vi.mocked(api).mockImplementation(async action=>action==='openmontage-settings'?{ready:false,settings:{sourceDirectory:'local',pythonPath:'python'},issues:['缺少本地连接'],projectsDirectory:'isolated'}:action.startsWith('openmontage-projects')?{projects:[]}:{annotations:[],assets:[]});node=document.createElement('div');document.body.append(node);root=createRoot(node)})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
async function render(){await act(async()=>root.render(createElement(TrackVideoScript,{track,basemap:'none',onBasemap:vi.fn(),onCancel:vi.fn()})))}
async function click(label:string,role?:string){const button=[...node.querySelectorAll<HTMLButtonElement>(role?`[role=${role}]`:'button')].find(value=>value.textContent===label)!;expect(button).toBeDefined();await act(async()=>button.click())}
it('opens map editing first and defers resources, analysis and model catalog until their tabs are visited',async()=>{
 await render()
 expect(node.querySelector('[data-renderer=map]')).not.toBeNull();expect(node.querySelector('[aria-label="沙盘编辑器"]')).toBeNull()
 expect([...node.querySelectorAll('[role=tab]')].map(value=>value.textContent)).toEqual(['素材准备','脚本策划','镜头编辑'])
 expect(api).not.toHaveBeenCalled();expect(useTextModels).not.toHaveBeenCalled();expect(node.textContent).not.toContain('镜头案例')
 await click('脚本策划','tab');expect(node.textContent).toContain('OpenMontage');expect(api).toHaveBeenCalledWith('openmontage-settings');expect(useTextModels).not.toHaveBeenCalled()
 expect(node.querySelector('[data-renderer=map]')).toBeNull()
 await click('素材准备','tab');expect(api).toHaveBeenCalledWith('resources?id=workspace');expect(node.querySelector('[aria-label="素材准备编辑器"]')).not.toBeNull()
})
it('owns one capture cache across editors and releases its retained bytes when the video workspace closes',async()=>{
 await render();const cache=state.captureStore!,scope={projectId:'project-a',shotId:'shot-a',sceneId:'SC03',scenePlanDigest:'confirmed-1'},identity=freezeShotResult(track.id,scope,'revision-1','map')!,blob=new Blob(['workspace capture'])
 cache.set({blob,identity,filename:'capture.webm'});await click('3D 沙盘');expect(state.captureStore).toBe(cache);expect(cache.get(track.id,scope,'map')!.blob).toBe(blob)
 await act(async()=>root.unmount());expect(cache.get(track.id,scope,'map')).toBeUndefined();root=createRoot(node)
})
it('retains each editor state but mounts only the active renderer when switching scenes and tabs',async()=>{
 await render();await click('编辑次数 0');await click('3D 沙盘');expect(state.mapLeave).toHaveBeenCalled()
 expect(node.querySelector('[data-renderer=map]')).toBeNull();expect(node.querySelector('[data-renderer=sandbox]')).not.toBeNull()
 const sandbox=node.querySelector('[aria-label="沙盘编辑器"] button') as HTMLButtonElement;await act(async()=>sandbox.click())
 await click('地图');expect(state.sandboxLeave).toHaveBeenCalled();expect(node.querySelector('[aria-label="地图编辑器"]')?.textContent).toContain('编辑次数 1')
 await click('3D 沙盘');expect(node.querySelector('[aria-label="沙盘编辑器"]')?.textContent).toContain('编辑次数 1')
 await click('素材准备','tab');expect(node.querySelector('[data-renderer]')).toBeNull()
 await click('用所选素材编排镜头');expect(node.querySelector('[data-renderer=map]')).not.toBeNull()
})
it('waits for the active editor navigation guard before changing scene or tab',async()=>{
 let resume:(()=>void)|undefined;state.mapLeave.mockImplementation(next=>{resume=next})
 await render();await click('3D 沙盘');expect(node.querySelector('[data-renderer=map]')).not.toBeNull();expect(node.querySelector('[data-renderer=sandbox]')).toBeNull()
 await act(async()=>resume!());expect(node.querySelector('[data-renderer=sandbox]')).not.toBeNull()
})
it('disables page and scene navigation while the active editor is busy',async()=>{
 state.busy=true;await render()
 expect([...node.querySelectorAll<HTMLButtonElement>('.trk-video-navigation button,.trk-video-scenes button')].every(button=>button.disabled)).toBe(true)
})
it('supports keyboard tab navigation through the same leave guard',async()=>{
 await render();const tab=node.querySelector<HTMLButtonElement>('#trk-video-editing-tab')!
 await act(async()=>tab.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})))
 expect(state.mapLeave).toHaveBeenCalled();expect(node.querySelector('#trk-video-materials-tab')?.getAttribute('aria-selected')).toBe('true')
 expect(document.activeElement?.id).toBe('trk-video-materials-tab')
})
