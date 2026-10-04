// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {TrackVideoScript} from '../src/client/TrackVideoScript.tsx'
import {api} from '../src/client/util.ts'
import {useTextModels} from '../src/client/useTextModels.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord} from '../src/protocol.ts'
vi.mock('../src/client/ShotCaseLab.tsx',()=>({ShotCaseLab:({onPlanning}:{onPlanning:()=>void})=>createElement('section',{'aria-label':'镜头案例'},createElement('p',null,'案例可观看，不代表成片采用'),createElement('button',{onClick:onPlanning},'进入脚本策划（后续使用）'))}))
vi.mock('../src/client/useTextModels.ts',()=>({useTextModels:vi.fn(()=>({catalog:{available:false,models:[]},model:'',setModel:vi.fn(),reload:vi.fn()}))}))
vi.mock('../src/client/useTrackPlacemarks.ts',()=>({useTrackPlacemarks:()=>({points:[],loading:false,editReady:true,error:'',stateError:'',retry:vi.fn()})}))
vi.mock('../src/client/MapView.tsx',()=>({MapView:()=>null}))
vi.mock('../src/client/util.ts',async original=>({...await original<typeof import('../src/client/util.ts')>(),api:vi.fn()}))
const coordinates:TrackRecord['coordinates']=[[120,30,100,null],[120.01,30,150,null]]
const track:TrackRecord={id:'workspace',name:'示例数据',format:'gpx',filename:'test.gpx',createdAt:'2026-10-02',bytes:80,points:2,coordinates,metrics:editedMetrics(coordinates)}
let node:HTMLDivElement,root:Root
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();vi.mocked(api).mockResolvedValue({annotations:[]});node=document.createElement('div');document.body.append(node);root=createRoot(node)})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
it('opens cases first and defers script analysis and model catalog until entering planning explicitly',async()=>{
 await act(async()=>root.render(createElement(TrackVideoScript,{track,basemap:'none',onBasemap:vi.fn(),onCancel:vi.fn()})))
 expect(node.querySelector('[aria-label="镜头案例"]')).not.toBeNull()
 expect(api).not.toHaveBeenCalled();expect(useTextModels).not.toHaveBeenCalled()
 await act(async()=>node.querySelector('button')!.click())
 expect(node.textContent).toContain('分析信息与选题')
 expect(api).toHaveBeenCalledWith('annotations?id=workspace')
 const back=[...node.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='返回镜头案例')!
 await act(async()=>back.click())
 expect(node.querySelector('[aria-label="镜头案例"]')).not.toBeNull()
})
