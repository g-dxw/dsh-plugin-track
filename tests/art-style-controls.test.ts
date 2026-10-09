// @vitest-environment jsdom
import {act,createElement,useState} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {ElementStyleControls,GlobalStyleControls,TextStyleControls} from '../src/client/ArtStyleControls.tsx'
import {getArtElementStyle,getArtRouteStyle,getArtTextStyle,type ArtElementStyle,type ArtStyles,type ArtTextStyle} from '../src/track/art-styles.ts'

let root:Root,node:HTMLDivElement
const annotation={id:'style-point',pointIndex:0,label:'山顶',color:'#e65f55'}
const shared:ArtStyles={defaults:{textColor:'#123456',textSize:24,textOffsetX:35,markerRadius:20}}
const changed=vi.fn()
function ElementHarness({initial={},sections}: {initial?:ArtElementStyle;sections?:('text'|'number'|'marker'|'connector'|'photo')[]}) {const [value,setValue]=useState(initial);return createElement(ElementStyleControls,{value,effective:getArtElementStyle({...annotation,style:value},shared),scope:'当前点位',sections,onChange:next=>{changed(next);setValue(next)}})}
function GlobalHarness({initial={}}:{initial?:ArtStyles}) {const [value,setValue]=useState(initial);return createElement(GlobalStyleControls,{value,effectiveElement:getArtElementStyle(annotation,value),effectiveRoute:getArtRouteStyle(value),effectiveBackground:value.background??'#fffdf6',onChange:next=>{changed(next);setValue(next)}})}
function TextHarness({initial={}}:{initial?:ArtTextStyle}) {const [value,setValue]=useState(initial);return createElement(TextStyleControls,{value,effective:getArtTextStyle('title',{...shared,texts:{title:value}}),scope:'标题',onChange:next=>{changed(next);setValue(next)}})}
function input(label:string){return node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!}
function select(label:string){return node.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!}
function button(label:string){return [...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.getAttribute('aria-label')===label||item.textContent===label)!}
async function click(target:Element){await act(async()=>target.dispatchEvent(new MouseEvent('click',{bubbles:true})))}
async function edit(target:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(target,value);target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}))})}
async function blur(target:Element){await act(async()=>target.dispatchEvent(new FocusEvent('focusout',{bubbles:true})))}
async function enter(target:Element){await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})))}
async function render(element:Parameters<Root['render']>[0]){await act(async()=>root.render(element))}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);changed.mockClear();node=document.createElement('div');document.body.append(node);root=createRoot(node)})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})

describe('SVG artwork style controls',()=>{
  it('shows effective shared values and preserves inheritance when a number is merely focused and blurred',async()=>{
    await render(createElement(ElementHarness,{}));expect(input('当前点位字号').value).toBe('24');expect(input('当前点位文字颜色').value).toBe('#123456')
    expect(node.querySelector('[data-style-label="字号"]')?.getAttribute('data-style-inherited')).toBe('true');expect(button('恢复当前点位字号').disabled).toBe(true)
    await blur(input('当前点位字号'));expect(changed).not.toHaveBeenCalled()
  })
  it('commits an edited number once on blur while retaining other local settings, then follows the shared value on reset',async()=>{
    await render(createElement(ElementHarness,{initial:{markerRadius:32,textColor:'#998877'}}));await edit(input('当前点位字号'),'36');expect(changed).not.toHaveBeenCalled();await blur(input('当前点位字号'))
    expect(changed).toHaveBeenLastCalledWith({markerRadius:32,textColor:'#998877',textSize:36});expect(node.querySelector('[data-style-label="字号"]')?.getAttribute('data-style-inherited')).toBe('false')
    await click(button('恢复当前点位字号'));expect(changed).toHaveBeenLastCalledWith({markerRadius:32,textColor:'#998877'});expect(input('当前点位字号').value).toBe('24')
    await click(button('恢复当前点位文字颜色'));expect(changed).toHaveBeenLastCalledWith({markerRadius:32});expect(input('当前点位文字颜色').value).toBe('#123456')
  })
  it('keeps empty, intermediate and out-of-range numeric drafts without silently converting or clamping them',async()=>{
    await render(createElement(ElementHarness,{}));const size=input('当前点位字号');await edit(size,'');await blur(size);expect(changed).not.toHaveBeenCalled();expect(size.value).toBe('');expect(size.getAttribute('aria-invalid')).toBe('true')
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('8 至 120');await edit(size,'-');await enter(size);expect(changed).not.toHaveBeenCalled();await edit(size,'121');await blur(size);expect(changed).not.toHaveBeenCalled()
    await edit(size,'28.5');await enter(size);expect(changed).toHaveBeenCalledTimes(1);expect(changed).toHaveBeenLastCalledWith({textSize:28.5});await blur(size);expect(changed).toHaveBeenCalledTimes(1)
  })
  it('resets just the text section and independently changes photos, numbering and connector options',async()=>{
    await render(createElement(ElementHarness,{initial:{textColor:'#334455',textSize:40,textOffsetX:80,textOffsetY:-20,photoWidth:480,markerRadius:30}}));await click(button('此组跟随统一样式'));expect(changed).toHaveBeenLastCalledWith({photoWidth:480,markerRadius:30})
    const dash=select('当前点位连接线样式');await act(async()=>{dash.value='solid';dash.dispatchEvent(new Event('change',{bubbles:true}))});expect(changed).toHaveBeenLastCalledWith({photoWidth:480,markerRadius:30,connectorDash:'solid'})
    await edit(input('当前点位编号字号'),'20');await enter(input('当前点位编号字号'));expect(changed.mock.calls.at(-1)?.[0]).toEqual({photoWidth:480,markerRadius:30,connectorDash:'solid',numberSize:20})
  })
  it('clears only fixed-text overrides without removing their inherited font values',async()=>{
    await render(createElement(TextHarness,{initial:{textSize:44,textColor:'#abcdef',fontWeight:500}}));await click(button('恢复标题文字颜色'));expect(changed).toHaveBeenLastCalledWith({textSize:44,fontWeight:500});expect(input('标题文字颜色').value).toBe('#123456')
    await click(button('恢复文字统一样式'));expect(changed).toHaveBeenLastCalledWith({});expect(input('标题字号').value).toBe('24')
  })
  it('updates the shared element, route and background settings without losing local text overrides',async()=>{
    const initial:ArtStyles={texts:{title:{textSize:72}},defaults:{textSize:22},route:{width:8},background:'#aabbcc'};await render(createElement(GlobalHarness,{initial}));await edit(input('统一字号'),'32');await enter(input('统一字号'));expect(changed.mock.calls.at(-1)?.[0]).toEqual({...initial,defaults:{textSize:32}})
    await edit(input('统一轨迹宽度'),'12.5');await blur(input('统一轨迹宽度'));expect(changed.mock.calls.at(-1)?.[0].route.width).toBe(12.5)
    await edit(input('统一背景颜色值'),'transparent');await blur(input('统一背景颜色值'));expect(changed.mock.calls.at(-1)?.[0].background).toBe('transparent')
    await click(button('恢复统一默认样式'));expect(changed).toHaveBeenLastCalledWith({texts:{title:{textSize:72}}});expect(input('统一字号').value).toBe('17');expect(input('统一轨迹宽度').value).toBe('6')
  })
  it('does not publish invalid colors and supports exact alpha values from the color text field',async()=>{
    await render(createElement(ElementHarness,{}));await edit(input('当前点位文字颜色值'),'red');await blur(input('当前点位文字颜色值'));expect(changed).not.toHaveBeenCalled();expect(node.querySelector('[role="alert"]')?.textContent).toContain('十六进制颜色')
    await edit(input('当前点位文字颜色值'),'#aabbcc80');await enter(input('当前点位文字颜色值'));expect(changed).toHaveBeenLastCalledWith({textColor:'#aabbcc80'})
  })
  it('limits displayed sections and guards all editing controls while disabled',async()=>{
    const onChange=vi.fn(),onReset=vi.fn();await render(createElement(ElementStyleControls,{scope:'当前点位',value:{textSize:32},effective:getArtElementStyle(annotation,shared),sections:['text'],disabled:true,onChange,onReset}));expect(input('当前点位字号').disabled).toBe(true);expect(node.querySelector('[aria-label="当前点位图片宽度"]')).toBeNull()
    expect([...node.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button')].every(element=>element.disabled)).toBe(true);await click(button('当前点位全部跟随统一样式'));expect(onReset).not.toHaveBeenCalled();expect(onChange).not.toHaveBeenCalled()
  })
})
