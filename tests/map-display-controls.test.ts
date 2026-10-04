// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackPlacemark } from '../src/protocol.ts'
import { MapDisplayControls } from '../src/client/MapDisplayControls.tsx'
import { MapSettingsProvider, useMapSettings } from '../src/client/map-settings.tsx'
import { DEFAULT_MAP_SETTINGS, readMapSettings, writeMapSettings } from '../src/track/map-settings.ts'
import type { PlacemarkTypeFilter } from '../src/track/placemark-filter.ts'

const points: TrackPlacemark[] = [
  {id: 'view', name: '山顶', description: '', coordinates: [120, 30], images: [], type: ['风景', '水源']},
  {id: 'water', name: '溪流', description: '', coordinates: [120, 30], images: [], type: '水源'},
  {id: 'plain', name: '起点', description: '', coordinates: [120, 30], images: []},
]
let node: HTMLDivElement, root: Root
let state: ReturnType<typeof useMapSettings>
const typeChanged = vi.fn()
type SurfaceProps = {sandbox?: boolean; disabled?: boolean; withFilter?: boolean; placemarks?: readonly TrackPlacemark[]; initialFilter?: PlacemarkTypeFilter}
function Surface({sandbox = false, disabled = false, withFilter = true, placemarks = points, initialFilter = 'all'}: SurfaceProps) {
  state = useMapSettings()
  const [filter, setFilter] = useState<PlacemarkTypeFilter>(initialFilter)
  return createElement(MapDisplayControls, {placemarks, typeFilter: filter, sandbox, disabled,
    onTypeFilter: withFilter ? next => {typeChanged(next); setFilter(next)} : undefined})
}
async function render(props: SurfaceProps = {}) {
  await act(async () => root.render(createElement(MapSettingsProvider, {}, createElement(Surface, props))))
}
function trigger() {return node.querySelector<HTMLButtonElement>('[data-map-display-trigger]')!}
function panel() {return node.querySelector<HTMLElement>('[aria-label="标记点与路线设置"]')}
function color() {return panel()!.querySelector<HTMLInputElement>('input[aria-label="路线颜色"]')!}
function typeChecks() {return [...panel()!.querySelectorAll<HTMLInputElement>('input[data-placemark-type]')]}
function typeCheck(value: string) {return typeChecks().find(input => input.dataset.placemarkType === value)!}
function checkbox() {return panel()!.querySelector<HTMLInputElement>('input[aria-label="显示标记点"]')!}
async function click(element: HTMLElement) {await act(async () => element.click())}
async function changeColor(value: string) {
  const input = color()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
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

  it('excludes a category from all types, preserves the mixed state when reopened, and selects all from a partial selection', async () => {
    await render(); await click(trigger())
    expect(color().value).toBe('#3dc5ff')
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

  it('keeps global marker visibility usable in every view during loading and disables only route edits and type controls', async () => {
    await render({sandbox: true, disabled: true}); await click(trigger())
    expect(color().disabled).toBe(true)
    expect(typeChecks().every(input => input.disabled)).toBe(true)
    expect(checkbox().disabled).toBe(false)
    await changeColor('#aa5533'); await click(typeCheck('type:水源'))
    expect(state.settings.routeColor).toBe(DEFAULT_MAP_SETTINGS.routeColor)
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
