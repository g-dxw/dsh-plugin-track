// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackPlacemark } from '../src/protocol.ts'
import { MapDisplayControls } from '../src/client/MapDisplayControls.tsx'
import { MapSettingsProvider, useMapSettings } from '../src/client/map-settings.tsx'
import { DEFAULT_MAP_SETTINGS, readMapSettings, writeMapSettings } from '../src/track/map-settings.ts'
import type { PlacemarkDisplayMode } from '../src/track/map-settings.ts'
import type { PlacemarkTypeFilter } from '../src/track/placemark-filter.ts'

const points: TrackPlacemark[] = [
  {id: 'view', name: '山顶', description: '', coordinates: [120, 30], images: [], type: ['风景', '水源']},
  {id: 'water', name: '溪流', description: '', coordinates: [120, 30], images: [], type: '水源'},
  {id: 'plain', name: '起点', description: '', coordinates: [120, 30], images: []},
]
let node: HTMLDivElement, root: Root
let state: ReturnType<typeof useMapSettings>
const typeChanged = vi.fn()
type SurfaceProps = {sandbox?: boolean; terrain?: boolean; disabled?: boolean; withFilter?: boolean; placemarks?: readonly TrackPlacemark[]; initialFilter?: PlacemarkTypeFilter}
const pointViews: SurfaceProps[] = [{}, {terrain: true}, {sandbox: true}]
const markerViews: SurfaceProps[] = [{terrain: true}, {sandbox: true}]
function Surface({sandbox = false, terrain = false, disabled = false, withFilter = true, placemarks = points, initialFilter = 'all'}: SurfaceProps) {
  state = useMapSettings()
  const [filter, setFilter] = useState<PlacemarkTypeFilter>(initialFilter)
  return createElement(MapDisplayControls, {placemarks, typeFilter: filter, sandbox, terrain, disabled,
    onTypeFilter: withFilter ? next => {typeChanged(next); setFilter(next)} : undefined})
}
async function render(props: SurfaceProps = {}) {
  await act(async () => root.render(createElement(MapSettingsProvider, {}, createElement(Surface, props))))
}
function trigger() {return node.querySelector<HTMLButtonElement>('[data-map-display-trigger]')!}
function panel() {return node.querySelector<HTMLElement>('[aria-label="标记点与路线设置"]')}
function color(name = '路线颜色') {return panel()!.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!}
function labelSize() {return panel()!.querySelector<HTMLInputElement>('input[aria-label="文字大小"]')!}
function labelSizeOutput() {return [...panel()!.querySelectorAll<HTMLOutputElement>('output')].find(output => output.htmlFor.contains(labelSize().id))!}
function labelHeight() {return panel()!.querySelector<HTMLInputElement>('input[aria-label="文字高度"]')!}
function labelHeightOutput() {return [...panel()!.querySelectorAll<HTMLOutputElement>('output')].find(output => output.htmlFor.contains(labelHeight().id))!}
function mode() {return panel()!.querySelector<HTMLSelectElement>('select[aria-label="显示模式"]')!}
function range(name: string) {return panel()!.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!}
function rangeOutput(name: string) {return [...panel()!.querySelectorAll<HTMLOutputElement>('output')].find(output => output.htmlFor.contains(range(name).id))!}
function pointChoice(name: '显示组内点位数量' | '显示名称') {return panel()!.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!}
function typeChecks() {return [...panel()!.querySelectorAll<HTMLInputElement>('input[data-placemark-type]')]}
function typeCheck(value: string) {return typeChecks().find(input => input.dataset.placemarkType === value)!}
function checkbox() {return panel()!.querySelector<HTMLInputElement>('input[aria-label="显示标记点"]')!}
async function click(element: HTMLElement) {await act(async () => element.click())}
async function changeColor(value: string, name = '路线颜色') {
  const input = color(name)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

async function changeLabelSize(value: number) {
  const input = labelSize()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

async function changeLabelHeight(value: number) {
  const input = labelHeight()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

async function changeMode(value: PlacemarkDisplayMode) {
  const select = mode()
  await act(async () => {select.value = value; select.dispatchEvent(new Event('change', {bubbles: true}))})
}
async function changeRange(name: string, value: number) {
  const input = range(name)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); vi.clearAllMocks()
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount())
  node.remove(); document.querySelectorAll('[data-map-test-outside]').forEach(element => element.remove())
  localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('map display dock controls', () => {
  it('keeps route color, counted multi-type selection, and marker visibility live in one accessible panel', async () => {
    const original = structuredClone(points)
    writeMapSettings({...DEFAULT_MAP_SETTINGS, routeColor: '#224466', sandboxPlacemarks: true})
    await render({sandbox: true})
    expect(trigger().getAttribute('aria-label')).toBe('标记点与路线')
    expect(trigger().title).toBe('标记点与路线')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(panel()).toBeNull()
    await click(trigger())
    const opened = panel()!
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(opened.id)
    expect(color().value).toBe('#224466')
    expect(opened.querySelector('output')?.textContent).toBe('#224466')
    expect(opened.querySelector('fieldset legend')?.textContent).toBe('标记点类型')
    expect(typeChecks().map(input => ({value: input.dataset.placemarkType, label: input.parentElement?.textContent}))).toEqual([
      {value: 'all', label: '全部类型（3）'}, {value: 'type:风景', label: '风景（1）'},
      {value: 'type:水源', label: '水源（2）'}, {value: 'untyped', label: '未分类（1）'},
    ])
    expect(typeChecks().every(input => input.checked)).toBe(true)
    await changeColor('#aa5533')
    expect(state.settings.routeColor).toBe('#aa5533')
    expect(readMapSettings().routeColor).toBe('#aa5533')
    expect(panel()).toBe(opened)
    expect(opened.querySelector('output')?.textContent).toBe('#aa5533')
    await click(typeCheck('all'))
    expect(typeChanged).toHaveBeenLastCalledWith([])
    expect(typeChecks().every(input => !input.checked)).toBe(true)
    await click(typeCheck('type:水源'))
    expect(typeChanged).toHaveBeenLastCalledWith(['type:水源'])
    await click(typeCheck('untyped'))
    expect(typeChanged).toHaveBeenLastCalledWith(['type:水源', 'untyped'])
    expect(typeCheck('all').checked).toBe(false)
    expect(typeCheck('all').indeterminate).toBe(true)
    expect(typeCheck('type:风景').checked).toBe(false)
    expect(typeCheck('type:水源').checked).toBe(true)
    expect(typeCheck('untyped').checked).toBe(true)
    await click(typeCheck('type:风景'))
    expect(typeChanged).toHaveBeenLastCalledWith('all')
    expect(typeChecks().every(input => input.checked)).toBe(true)
    expect(typeCheck('all').indeterminate).toBe(false)
    expect(panel()).toBe(opened)
    expect(checkbox().checked).toBe(true)
    await click(checkbox())
    expect(state.settings.sandboxPlacemarks).toBe(false)
    expect(readMapSettings().sandboxPlacemarks).toBe(false)
    expect(panel()).toBe(opened)
    expect(points).toEqual(original)
  })

  it('persists route, floating text, and connector colors independently in sandbox mode', async () => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, routeColor: '#224466', sandboxLabelColor: '#ffeecc', sandboxConnectorColor: '#337799'})
    await render({sandbox: true}); await click(trigger())
    const opened = panel()!
    expect([...opened.querySelectorAll('input[type=color]')].map(input => input.getAttribute('aria-label'))).toEqual(['路线颜色', '文字颜色', '连线颜色'])
    for (const name of ['路线颜色', '文字颜色', '连线颜色']) {
      expect(color(name).type).toBe('color')
      expect(opened.querySelector(`label[for="${color(name).id}"]`)?.textContent).toBe(name)
    }
    expect(color('文字颜色').value).toBe('#ffeecc')
    expect(color('连线颜色').value).toBe('#337799')
    await changeColor('#123456', '文字颜色')
    expect(state.settings).toEqual({...original, sandboxLabelColor: '#123456'})
    expect(readMapSettings()).toEqual(state.settings)
    await changeColor('#654321', '连线颜色')
    expect(state.settings).toEqual({...original, sandboxLabelColor: '#123456', sandboxConnectorColor: '#654321'})
    expect(readMapSettings()).toEqual(state.settings)
    await changeColor('#abcdef')
    expect(state.settings).toEqual({...original, routeColor: '#abcdef', sandboxLabelColor: '#123456', sandboxConnectorColor: '#654321'})
    expect(readMapSettings()).toEqual(state.settings)
    expect([...opened.querySelectorAll('.trk-map-display-color output')].map(output => output.textContent)).toEqual(['#abcdef', '#123456', '#654321'])
    expect(panel()).toBe(opened)
    expect(typeChanged).not.toHaveBeenCalled()
  })

  it('adjusts and persists text size live without changing colors, filters, or marker visibility', async () => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, routeColor: '#224466', sandboxLabelColor: '#ffeecc', sandboxConnectorColor: '#337799', sandboxPlacemarks: false})
    await render({sandbox: true}); await click(trigger())
    const opened = panel()!, input = labelSize()
    expect(input.type).toBe('range')
    expect(input.min).toBe('10'); expect(input.max).toBe('32'); expect(input.step).toBe('1')
    expect(input.value).toBe('16'); expect(input.getAttribute('aria-valuetext')).toBe('16 px')
    expect(opened.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('文字大小')
    expect(labelSizeOutput().htmlFor.contains(input.id)).toBe(true)
    expect(labelSizeOutput().textContent).toBe('16 px')
    await changeLabelSize(24)
    expect(state.settings).toEqual({...original, sandboxLabelSize: 24})
    expect(readMapSettings()).toEqual(state.settings)
    expect(input.value).toBe('24'); expect(input.getAttribute('aria-valuetext')).toBe('24 px')
    expect(labelSizeOutput().textContent).toBe('24 px')
    expect(typeChanged).not.toHaveBeenCalled(); expect(checkbox().checked).toBe(false)
    expect(panel()).toBe(opened)
    await act(async () => root.unmount())
    root = createRoot(node)
    await render({sandbox: true}); await click(trigger())
    expect(labelSize().value).toBe('24')
    expect(labelSizeOutput().textContent).toBe('24 px')
    expect(state.settings).toEqual({...original, sandboxLabelSize: 24})
  })

  it('adjusts and persists relative text height live with an accessible percentage without changing other preferences', async () => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, routeColor: '#224466', sandboxLabelColor: '#ffeecc', sandboxConnectorColor: '#337799', sandboxLabelSize: 24, sandboxPlacemarks: false})
    await render({sandbox: true}); await click(trigger())
    const opened = panel()!, input = labelHeight()
    expect(input.type).toBe('range')
    expect(input.min).toBe('0.2'); expect(input.max).toBe('3'); expect(input.step).toBe('0.1')
    expect(input.value).toBe('1'); expect(input.getAttribute('aria-valuetext')).toBe('默认高度的 100%')
    expect(opened.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('文字高度')
    expect(labelHeightOutput().htmlFor.contains(input.id)).toBe(true)
    expect(labelHeightOutput().textContent).toBe('100%')
    const description = document.getElementById(input.getAttribute('aria-describedby')!)!
    expect(opened.contains(description)).toBe(true)
    expect(description.textContent).toContain('文字与点位的距离')
    expect(description.textContent).toContain('100% 为默认高度')
    for (const [height, percentage] of [[.2, 20], [3, 300], [1.6, 160]]) {
      await changeLabelHeight(height)
      expect(state.settings).toEqual({...original, sandboxLabelHeight: height})
      expect(readMapSettings()).toEqual(state.settings)
      expect(input.value).toBe(String(height)); expect(input.getAttribute('aria-valuetext')).toBe(`默认高度的 ${percentage}%`)
      expect(labelHeightOutput().textContent).toBe(`${percentage}%`)
      expect(typeChanged).not.toHaveBeenCalled(); expect(checkbox().checked).toBe(false)
      expect(panel()).toBe(opened)
    }
    await act(async () => root.unmount())
    root = createRoot(node)
    await render({sandbox: true}); await click(trigger())
    expect(labelHeight().value).toBe('1.6')
    expect(labelHeightOutput().textContent).toBe('160%')
    expect(state.settings).toEqual({...original, sandboxLabelHeight: 1.6})
  })

  it('hides floating text controls in 2D and retains them across view switches', async () => {
    await render({sandbox: true}); await click(trigger())
    expect(color('文字颜色').value).toBe('#ffffff')
    expect(color('连线颜色').value).toBe('#ffffff')
    await changeColor('#123456', '文字颜色'); await changeColor('#654321', '连线颜色'); await changeLabelSize(22); await changeLabelHeight(1.8)
    const saved = readMapSettings()
    await render({sandbox: false})
    expect([...panel()!.querySelectorAll('input[type=color]')].map(input => input.getAttribute('aria-label'))).toEqual(['路线颜色', '点位颜色', '分组颜色'])
    expect(panel()!.querySelector('input[aria-label="文字大小"]')).toBeNull()
    expect(panel()!.querySelector('input[aria-label="文字高度"]')).toBeNull()
    expect(readMapSettings()).toEqual(saved)
    await render({sandbox: true})
    expect(color('文字颜色').value).toBe('#123456')
    expect(color('连线颜色').value).toBe('#654321')
    expect(labelSize().value).toBe('22')
    expect(labelSizeOutput().textContent).toBe('22 px')
    expect(labelHeight().value).toBe('1.8')
    expect(labelHeightOutput().textContent).toBe('180%')
    expect(state.settings).toEqual(saved)
    expect(readMapSettings()).toEqual(saved)
  })

  it('remembers terrain and sandbox display modes independently while 2D stays in point mode', async () => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, routeColor: '#224466', sandboxLabelColor: '#ffeecc', sandboxConnectorColor: '#337799', sandboxLabelHeight: 1.8})
    await render({terrain: true}); await click(trigger())
    const opened = panel()!, select = mode()
    expect(select.value).toBe('point')
    expect([...select.options].map(option => [option.value, option.textContent])).toEqual([['point', '点位模式'], ['marker', '标记模式']])
    expect(opened.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('显示模式')
    expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toContain('悬浮文字、虚线与小球')
    expect(range('点位大小').value).toBe('24')
    expect(opened.querySelector('input[aria-label="文字大小"]')).toBeNull()
    await changeMode('marker')
    expect(state.settings).toEqual({...original, terrainPlacemarkMode: 'marker'})
    expect(panel()).toBe(opened)
    expect(opened.querySelector('input[aria-label="点位大小"]')).toBeNull()
    expect(labelSize().value).toBe('16'); expect(labelHeight().value).toBe('1.8')
    expect(color('文字颜色').value).toBe('#ffeecc'); expect(color('连线颜色').value).toBe('#337799')
    await changeLabelSize(22)
    await render({sandbox: true})
    expect(mode().value).toBe('marker'); expect(labelSize().value).toBe('22')
    await changeMode('point')
    const saved = {...original, terrainPlacemarkMode: 'marker' as const, sandboxPlacemarkMode: 'point' as const, sandboxLabelSize: 22}
    expect(state.settings).toEqual(saved)
    expect(readMapSettings()).toEqual(saved)
    expect(range('点位大小').value).toBe('24')
    expect(panel()!.querySelector('input[aria-label="文字高度"]')).toBeNull()
    await render()
    expect(panel()!.querySelector('select[aria-label="显示模式"]')).toBeNull()
    expect(range('点位大小').value).toBe('24')
    expect(readMapSettings()).toEqual(saved)
    await render({terrain: true})
    expect(mode().value).toBe('marker'); expect(labelSize().value).toBe('22')
    await render({sandbox: true})
    expect(mode().value).toBe('point')
    expect(typeChanged).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(node)
    await render({sandbox: true}); await click(trigger())
    expect(mode().value).toBe('point')
    await render({terrain: true})
    expect(mode().value).toBe('marker'); expect(labelHeight().value).toBe('1.8')
    expect(state.settings).toEqual(saved)
  })

  it.each(pointViews)('edits shared numbered point and group styles live and persists them in point view %j', async view => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, sandboxPlacemarkMode: 'point', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, sandboxPlacemarks: false})
    await render(view); await click(trigger())
    const opened = panel()!, size = range('点位大小'), radius = range('点位圆角')
    expect(size.type).toBe('range'); expect(size.min).toBe('12'); expect(size.max).toBe('64'); expect(size.step).toBe('1')
    expect(size.value).toBe('24'); expect(size.getAttribute('aria-valuetext')).toBe('24 px'); expect(rangeOutput('点位大小').textContent).toBe('24 px')
    expect(radius.type).toBe('range'); expect(radius.min).toBe('0'); expect(radius.max).toBe('50'); expect(radius.step).toBe('1')
    expect(radius.value).toBe('50'); expect(radius.getAttribute('aria-valuetext')).toBe('50%'); expect(rangeOutput('点位圆角').textContent).toBe('50%')
    expect(document.getElementById(radius.getAttribute('aria-describedby')!)?.textContent).toBe('0% 为方形，50% 为圆形。')
    expect(color('点位颜色').value).toBe('#c83532'); expect(color('分组颜色').value).toBe('#2563eb')
    for (const name of ['点位大小', '点位圆角', '点位颜色', '分组颜色']) {
      const input = opened.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
      expect(opened.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(name)
    }
    for (const value of [12, 64, 37]) {
      await changeRange('点位大小', value)
      expect(state.settings).toEqual({...original, placemarkPointSize: value})
      expect(size.getAttribute('aria-valuetext')).toBe(`${value} px`); expect(rangeOutput('点位大小').textContent).toBe(`${value} px`)
    }
    for (const value of [0, 50, 17]) {
      await changeRange('点位圆角', value)
      expect(state.settings).toEqual({...original, placemarkPointSize: 37, placemarkPointRadius: value})
      expect(radius.getAttribute('aria-valuetext')).toBe(`${value}%`); expect(rangeOutput('点位圆角').textContent).toBe(`${value}%`)
    }
    await changeColor('#123456', '点位颜色'); await changeColor('#654321', '分组颜色')
    const saved = {...original, placemarkPointSize: 37, placemarkPointRadius: 17, placemarkPointColor: '#123456', placemarkGroupColor: '#654321'}
    expect(state.settings).toEqual(saved); expect(readMapSettings()).toEqual(saved)
    expect(typeChanged).not.toHaveBeenCalled(); expect(checkbox().checked).toBe(false); expect(panel()).toBe(opened)
    await act(async () => root.unmount())
    root = createRoot(node)
    await render(view); await click(trigger())
    expect(range('点位大小').value).toBe('37'); expect(range('点位圆角').value).toBe('17')
    expect(color('点位颜色').value).toBe('#123456'); expect(color('分组颜色').value).toBe('#654321')
    expect(state.settings).toEqual(saved)
  })

  it.each(pointViews)('toggles group counts and names independently, shares text styling, and persists point choices in view %j', async view => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, sandboxPlacemarkMode: 'point', sandboxLabelColor: '#ffeecc', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, sandboxConnectorColor: '#337799', sandboxPlacemarks: false})
    await render(view); await click(trigger())
    const opened = panel()!, count = pointChoice('显示组内点位数量'), name = pointChoice('显示名称')
    expect(count.type).toBe('checkbox'); expect(count.checked).toBe(true); expect(count.disabled).toBe(false)
    expect(name.type).toBe('checkbox'); expect(name.checked).toBe(false); expect(name.disabled).toBe(false)
    for (const [input, label] of [[count, '显示组内点位数量'], [name, '显示名称']] as const) {
      expect(input.parentElement?.tagName).toBe('LABEL'); expect(input.parentElement?.textContent).toBe(label)
    }
    expect(opened.querySelector('input[aria-label="文字颜色"]')).toBeNull()
    expect(opened.querySelector('input[aria-label="文字大小"]')).toBeNull()
    await click(count.parentElement!)
    expect(state.settings).toEqual({...original, placemarkPointShowCount: false})
    await click(name.parentElement!)
    expect(state.settings).toEqual({...original, placemarkPointShowCount: false, placemarkPointShowName: true})
    expect(color('文字颜色').value).toBe('#ffeecc'); expect(labelSize().value).toBe('22')
    expect(opened.querySelector('input[aria-label="文字高度"]')).toBeNull()
    expect(opened.querySelector('input[aria-label="连线颜色"]')).toBeNull()
    await changeColor('#123456', '文字颜色'); await changeLabelSize(24)
    const saved = {...original, placemarkPointShowCount: false, placemarkPointShowName: true, sandboxLabelColor: '#123456', sandboxLabelSize: 24}
    expect(state.settings).toEqual(saved); expect(readMapSettings()).toEqual(saved)
    await click(name)
    expect(opened.querySelector('input[aria-label="文字颜色"]')).toBeNull()
    expect(opened.querySelector('input[aria-label="文字大小"]')).toBeNull()
    expect(state.settings).toEqual({...saved, placemarkPointShowName: false})
    await click(name)
    expect(color('文字颜色').value).toBe('#123456'); expect(labelSize().value).toBe('24')
    expect(panel()).toBe(opened); expect(typeChanged).not.toHaveBeenCalled(); expect(checkbox().checked).toBe(false)
    await act(async () => root.unmount())
    root = createRoot(node)
    await render(view); await click(trigger())
    expect(pointChoice('显示组内点位数量').checked).toBe(false); expect(pointChoice('显示名称').checked).toBe(true)
    expect(color('文字颜色').value).toBe('#123456'); expect(labelSize().value).toBe('24')
    expect(state.settings).toEqual(saved)
  })

  it.each(markerViews)('keeps count and name switches in point mode and retains shared text settings across mode changes in view %j', async view => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'marker', placemarkPointShowCount: false, placemarkPointShowName: false, sandboxLabelColor: '#abcdef', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, sandboxConnectorColor: '#337799'})
    await render(view); await click(trigger())
    const opened = panel()!
    expect(opened.querySelector('input[aria-label="显示组内点位数量"]')).toBeNull()
    expect(opened.querySelector('input[aria-label="显示名称"]')).toBeNull()
    expect(color('文字颜色').value).toBe('#abcdef'); expect(labelSize().value).toBe('22')
    expect(labelHeight().value).toBe('1.8'); expect(color('连线颜色').value).toBe('#337799')
    await changeColor('#123456', '文字颜色'); await changeLabelSize(24)
    await changeMode('point')
    expect(pointChoice('显示组内点位数量').checked).toBe(false); expect(pointChoice('显示名称').checked).toBe(false)
    expect(opened.querySelector('input[aria-label="文字大小"]')).toBeNull()
    await click(pointChoice('显示名称'))
    expect(color('文字颜色').value).toBe('#123456'); expect(labelSize().value).toBe('24')
    expect(opened.querySelector('input[aria-label="文字高度"]')).toBeNull(); expect(opened.querySelector('input[aria-label="连线颜色"]')).toBeNull()
    await changeMode('marker')
    expect(opened.querySelector('input[aria-label="显示名称"]')).toBeNull()
    expect(labelSize().value).toBe('24'); expect(labelHeight().value).toBe('1.8')
    await changeMode('point')
    expect(pointChoice('显示组内点位数量').checked).toBe(false); expect(pointChoice('显示名称').checked).toBe(true)
    expect(state.settings).toEqual({...original, [view.sandbox ? 'sandboxPlacemarkMode' : 'terrainPlacemarkMode']: 'point', placemarkPointShowName: true, sandboxLabelColor: '#123456', sandboxLabelSize: 24})
    expect(readMapSettings()).toEqual(state.settings); expect(typeChanged).not.toHaveBeenCalled()
  })

  it.each(pointViews)('disables count, name, and enabled point-name text controls while retaining global visibility in view %j', async view => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, sandboxPlacemarkMode: 'point', placemarkPointShowCount: false, placemarkPointShowName: true})
    await render({...view, disabled: true}); await click(trigger())
    expect(pointChoice('显示组内点位数量').disabled).toBe(true); expect(pointChoice('显示名称').disabled).toBe(true)
    expect(color('文字颜色').disabled).toBe(true); expect(labelSize().disabled).toBe(true)
    await click(pointChoice('显示组内点位数量')); await click(pointChoice('显示名称'))
    await changeColor('#123456', '文字颜色'); await changeLabelSize(24)
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    expect(checkbox().disabled).toBe(false)
    await click(checkbox())
    expect(state.settings).toEqual({...original, sandboxPlacemarks: false})
  })

  it('shows point styling in 2D even when both 3D views remember marker mode', async () => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'marker', placemarkPointSize: 32, placemarkPointRadius: 0})
    await render(); await click(trigger())
    expect(panel()!.querySelector('select[aria-label="显示模式"]')).toBeNull()
    expect(range('点位大小').value).toBe('32'); expect(range('点位圆角').value).toBe('0')
    expect(panel()!.querySelector('input[aria-label="文字大小"]')).toBeNull()
    expect(state.settings).toEqual(original)
  })

  it.each(pointViews)('disables point styling and mode changes while leaving visibility usable in point view %j', async view => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, sandboxPlacemarkMode: 'point'})
    await render({...view, disabled: true}); await click(trigger())
    expect(range('点位大小').disabled).toBe(true); expect(range('点位圆角').disabled).toBe(true)
    expect(color('点位颜色').disabled).toBe(true); expect(color('分组颜色').disabled).toBe(true)
    if (view.terrain || view.sandbox) {expect(mode().disabled).toBe(true); await changeMode('marker')}
    await changeRange('点位大小', 40); await changeRange('点位圆角', 10)
    await changeColor('#123456', '点位颜色'); await changeColor('#654321', '分组颜色')
    expect(state.settings).toEqual(original); expect(typeChanged).not.toHaveBeenCalled()
    expect(checkbox().disabled).toBe(false)
    await click(checkbox())
    expect(state.settings).toEqual({...original, sandboxPlacemarks: false})
  })

  it('keeps a manually selected cyan connector matching the route after reloading the settings UI', async () => {
    await render({sandbox: true}); await click(trigger())
    expect(color().value).toBe('#1bb1a7')
    expect(color('连线颜色').value).toBe('#ffffff')
    await changeColor('#3dc5ff'); await changeColor('#3dc5ff', '连线颜色')
    expect(readMapSettings()).toMatchObject({routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff', sandboxMarkerPaletteVersion: 3})
    await act(async () => root.unmount())
    root = createRoot(node)
    await render({sandbox: true}); await click(trigger())
    expect(color().value).toBe('#3dc5ff')
    expect(color('连线颜色').value).toBe('#3dc5ff')
    expect(readMapSettings().sandboxConnectorColor).toBe('#3dc5ff')
  })

  it('excludes a category from all types, preserves the mixed state when reopened, and selects all from a partial selection', async () => {
    await render(); await click(trigger())
    expect(color().value).toBe('#1bb1a7')
    await click(typeCheck('type:风景'))
    expect(typeChanged).toHaveBeenLastCalledWith(['type:水源', 'untyped'])
    expect(typeCheck('all').indeterminate).toBe(true)
    await act(async () => typeCheck('type:水源').focus())
    await act(async () => typeCheck('type:水源').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})))
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    await click(trigger())
    expect(typeCheck('all').indeterminate).toBe(true)
    expect(typeCheck('type:风景').checked).toBe(false)
    await click(typeCheck('all'))
    expect(typeChanged).toHaveBeenLastCalledWith('all')
    expect(typeChecks().every(input => input.checked)).toBe(true)
    expect(typeCheck('all').indeterminate).toBe(false)
    expect(panel()).not.toBeNull()
  })

  it('closes with Escape or the explicit close button and restores trigger focus', async () => {
    await render(); await click(trigger())
    await act(async () => color().focus())
    const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
    await act(async () => color().dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(panel()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
    await click(trigger())
    await click(panel()!.querySelector<HTMLButtonElement>('[aria-label="关闭标记点与路线设置"]')!)
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('dismisses on outside pointer and focus while keeping field interactions inside the panel open', async () => {
    await render(); await click(trigger())
    const outside = document.createElement('button'); outside.dataset.mapTestOutside = ''; document.body.appendChild(outside)
    await act(async () => color().dispatchEvent(new Event('pointerdown', {bubbles: true})))
    expect(panel()).not.toBeNull()
    await act(async () => outside.dispatchEvent(new Event('pointerdown', {bubbles: true})))
    expect(panel()).toBeNull()
    await click(trigger())
    await act(async () => color().focus())
    expect(panel()).not.toBeNull()
    await act(async () => outside.focus())
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it.each(markerViews)('keeps global marker visibility usable during loading while disabling marker style and mode controls in view %j', async view => {
    const original = writeMapSettings({...DEFAULT_MAP_SETTINGS, terrainPlacemarkMode: 'marker'})
    await render({...view, disabled: true}); await click(trigger())
    expect(color().disabled).toBe(true)
    expect(mode().disabled).toBe(true)
    await changeMode('point')
    expect(state.settings).toEqual(original)
    expect(color('文字颜色').disabled).toBe(true)
    expect(color('连线颜色').disabled).toBe(true)
    expect(labelSize().disabled).toBe(true)
    expect(labelHeight().disabled).toBe(true)
    expect(typeChecks().every(input => input.disabled)).toBe(true)
    expect(checkbox().disabled).toBe(false)
    await changeColor('#aa5533'); await changeColor('#123456', '文字颜色'); await changeColor('#654321', '连线颜色'); await changeLabelSize(24); await changeLabelHeight(1.8); await click(typeCheck('type:水源'))
    expect(state.settings.routeColor).toBe(DEFAULT_MAP_SETTINGS.routeColor)
    expect(state.settings.sandboxLabelColor).toBe(DEFAULT_MAP_SETTINGS.sandboxLabelColor)
    expect(state.settings.sandboxConnectorColor).toBe(DEFAULT_MAP_SETTINGS.sandboxConnectorColor)
    expect(state.settings.sandboxLabelSize).toBe(DEFAULT_MAP_SETTINGS.sandboxLabelSize)
    expect(state.settings.sandboxLabelHeight).toBe(DEFAULT_MAP_SETTINGS.sandboxLabelHeight)
    expect(state.settings).toEqual(original)
    expect(typeChanged).not.toHaveBeenCalled()
    await click(checkbox())
    expect(state.settings.sandboxPlacemarks).toBe(false)
    expect(panel()).not.toBeNull()
    await render({sandbox: false, withFilter: false, placemarks: []})
    expect(panel()).not.toBeNull()
    expect(checkbox()).not.toBeNull()
    expect(checkbox().checked).toBe(false)
    expect(checkbox().disabled).toBe(false)
    expect(typeChecks().every(input => input.disabled)).toBe(true)
    expect(typeChecks().map(input => input.parentElement?.textContent)).toEqual(['全部类型（0）'])
    expect(color().disabled).toBe(false)
    await click(checkbox())
    expect(state.settings.sandboxPlacemarks).toBe(true)
    expect(panel()).not.toBeNull()
  })
})
