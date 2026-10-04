// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BasemapControls } from '../src/client/map-settings.tsx'
import { BASEMAP_OPTIONS, type BasemapId } from '../src/track/basemaps.ts'
import { readMapSettings, sanitizeMapSettings, writeMapSettings } from '../src/track/map-settings.ts'

let node: HTMLDivElement, root: Root

function Controls({ initial = 'vector', onBasemap, disabled = false, layout = 'dock', viewSettings }: {
  initial?: BasemapId
  onBasemap: (value: BasemapId) => void
  disabled?: boolean
  layout?: 'toolbar' | 'dock'
  viewSettings?: ReactNode
}) {
  const [basemap, setBasemap] = useState(initial)
  return createElement(BasemapControls, {
    basemap, disabled, layout, viewSettings,
    onBasemap: value => { setBasemap(value); onBasemap(value) },
  })
}

function button(name: string, scope: ParentNode = node) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(element =>
    (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  if (!found) throw new Error(`Missing button ${name}`)
  return found
}
function panel(scope: ParentNode = node) {
  const found = scope.querySelector<HTMLElement>('[role="region"][aria-label="地图图层"]')
  if (!found) throw new Error('Missing map layers panel')
  return found
}
function radio(value: BasemapId, scope: ParentNode = panel()) {
  const label = BASEMAP_OPTIONS.find(option => option.id === value)!.label
  const found = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(element =>
    [...(element.labels ?? [])].some(parent => parent.textContent?.trim().startsWith(label)))
  if (!found) throw new Error(`Missing native basemap radio ${value}`)
  return found
}
async function click(element: HTMLElement) { await act(async () => element.click()) }

describe('map tools dock', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    localStorage.clear()
    node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    node.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it('keeps the existing toolbar when layout is omitted', async () => {
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(BasemapControls, { basemap: 'vector', onBasemap })))
    expect(node.querySelector('[role="group"][aria-label="底图"]')).not.toBeNull()
    expect(node.querySelector('[role="group"][aria-label="地图工具"]')).toBeNull()
    expect([...node.querySelectorAll('button')].some(element => ['设置', '地图设置'].includes(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''))).toBe(false)
    await click(button('卫星'))
    expect(onBasemap).toHaveBeenCalledWith('satellite')
    expect(readMapSettings().basemap).toBe('satellite')
  })

  it('opens labelled native choices, applies a choice immediately, and keeps the panel open for retry', async () => {
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(Controls, { initial: 'terrain', onBasemap })))
    expect(node.querySelector('[role="group"][aria-label="地图工具"]')).not.toBeNull()
    const trigger = button('地图图层')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(node.querySelector('[role="region"][aria-label="地图图层"]')).toBeNull()
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(panel().id)
    expect(panel().id).not.toBe('')
    for (const option of BASEMAP_OPTIONS) {
      expect([...radio(option.id).labels!].some(label => label.textContent?.includes(option.label))).toBe(true)
    }
    expect(radio('terrain').checked).toBe(true)
    await click(radio('satellite'))
    expect(onBasemap).toHaveBeenLastCalledWith('satellite')
    expect(readMapSettings().basemap).toBe('satellite')
    expect(radio('satellite').checked).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await click(button('重新加载当前底图', panel()))
    expect(onBasemap.mock.calls).toEqual([['satellite'], ['satellite']])
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes with Escape or its close button and restores focus to the layer trigger', async () => {
    await act(async () => root.render(createElement(Controls, { onBasemap: vi.fn() })))
    const trigger = button('地图图层')
    trigger.focus(); await click(trigger); radio('vector').focus()
    await act(async () => radio('vector').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(node.querySelector('[role="region"][aria-label="地图图层"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await click(trigger); button('关闭地图图层').focus(); await click(button('关闭地图图层'))
    expect(node.querySelector('[role="region"][aria-label="地图图层"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses on an outside pointer press without taking focus from the outside target', async () => {
    await act(async () => root.render(createElement('div', {},
      createElement(Controls, { onBasemap: vi.fn() }),
      createElement('button', { type: 'button' }, '地图外操作'))))
    await click(button('地图图层'))
    const outside = button('地图外操作'); outside.focus()
    await act(async () => outside.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(node.querySelector('[role="region"][aria-label="地图图层"]')).toBeNull()
    expect(button('地图图层').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(outside)
  })

  it('has no default gear or global settings entry in the dock or layer panel', async () => {
    await act(async () => root.render(createElement(Controls, { onBasemap: vi.fn() })))
    const dock = node.querySelector<HTMLElement>('[role="group"][aria-label="地图工具"]')!
    expect([...dock.querySelectorAll('button')].map(element => element.getAttribute('aria-label'))).toEqual(['地图图层'])
    expect(node.querySelector('button[aria-label="地图设置"]')).toBeNull()
    await click(button('地图图层'))
    expect([...node.querySelectorAll('button')].some(element => ['设置', '地图设置'].includes(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''))).toBe(false)
    expect(node.querySelector('[role="dialog"]')).toBeNull()
  })

  it('hosts caller-provided view settings without opening global settings or changing the selected layer', async () => {
    const openViewSettings = vi.fn(), onBasemap = vi.fn()
    const before = readMapSettings()
    const viewSettings = createElement('button', {
      type: 'button', 'aria-label': '沙盘视图设置', onClick: openViewSettings,
    }, '视图')
    await act(async () => root.render(createElement(Controls, { onBasemap, viewSettings })))
    const localSettings = button('沙盘视图设置')
    expect(node.querySelector('[role="group"][aria-label="地图工具"]')!.contains(localSettings)).toBe(true)
    await click(localSettings)
    expect(openViewSettings).toHaveBeenCalledOnce()
    expect(onBasemap).not.toHaveBeenCalled()
    expect(readMapSettings()).toEqual(before)
    expect(node.querySelector('[role="dialog"]')).toBeNull()
    expect(node.querySelector('button[aria-label="地图设置"]')).toBeNull()
  })

  it('prevents keyless MapTiler selection and enables it when a key is available', async () => {
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(Controls, { onBasemap })))
    await click(button('地图图层'))
    for (const option of BASEMAP_OPTIONS.filter(option => option.requiresKey)) {
      expect(radio(option.id).disabled).toBe(true)
      await click(radio(option.id))
    }
    expect(onBasemap).not.toHaveBeenCalled()
    expect(readMapSettings().basemap).toBe('vector')
    await act(async () => writeMapSettings(sanitizeMapSettings({ maptilerKey: 'test-key' })))
    await act(async () => root.render(createElement(Controls, { key: 'with-key', onBasemap })))
    await click(button('地图图层'))
    for (const option of BASEMAP_OPTIONS.filter(option => option.requiresKey)) expect(radio(option.id).disabled).toBe(false)
    await click(radio('maptiler-outdoor'))
    expect(onBasemap).toHaveBeenLastCalledWith('maptiler-outdoor')
    expect(readMapSettings().basemap).toBe('maptiler-outdoor')
  })

  it('disables every dock operation during capture, including an already open panel', async () => {
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(Controls, { onBasemap })))
    await click(button('地图图层'))
    await act(async () => root.render(createElement(Controls, { onBasemap, disabled: true })))
    expect(button('地图图层').disabled).toBe(true)
    expect(node.querySelector('button[aria-label="地图设置"]')).toBeNull()
    expect([...node.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input[type="radio"]')].every(element => element.disabled)).toBe(true)
    await click(button('地图图层'))
    expect(node.querySelector('[role="dialog"]')).toBeNull()
    expect(onBasemap).not.toHaveBeenCalled()
  })

  it('keeps each dock selection independent while switching between its layer panels', async () => {
    const firstChange = vi.fn(), secondChange = vi.fn()
    await act(async () => root.render(createElement('div', {},
      createElement('section', { 'data-test-dock': 'first' }, createElement(Controls, { onBasemap: firstChange })),
      createElement('section', { 'data-test-dock': 'second' }, createElement(Controls, { initial: 'terrain', onBasemap: secondChange })))))
    const first = node.querySelector<HTMLElement>('[data-test-dock="first"]')!
    const second = node.querySelector<HTMLElement>('[data-test-dock="second"]')!
    const firstTrigger = button('地图图层', first), secondTrigger = button('地图图层', second)
    const firstPanelId = firstTrigger.getAttribute('aria-controls'), secondPanelId = secondTrigger.getAttribute('aria-controls')
    expect(firstPanelId).toBeTruthy(); expect(secondPanelId).toBeTruthy()
    expect(firstPanelId).not.toBe(secondPanelId)

    await click(firstTrigger)
    expect(panel(first).id).toBe(firstPanelId)
    await click(radio('satellite', first))
    expect(radio('satellite', first).checked).toBe(true)
    expect(firstChange.mock.calls).toEqual([['satellite']])
    expect(secondChange).not.toHaveBeenCalled()

    await click(secondTrigger)
    expect(first.querySelector('[role="region"][aria-label="地图图层"]')).toBeNull()
    expect(firstTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(panel(second).id).toBe(secondPanelId)
    expect(radio('terrain', second).checked).toBe(true)
    expect(secondChange).not.toHaveBeenCalled()
    await click(radio('none', second))
    expect(radio('none', second).checked).toBe(true)
    expect(secondChange.mock.calls).toEqual([['none']])

    await click(firstTrigger)
    expect(second.querySelector('[role="region"][aria-label="地图图层"]')).toBeNull()
    expect(radio('satellite', first).checked).toBe(true)
    expect(firstChange.mock.calls).toEqual([['satellite']])
    expect(secondChange.mock.calls).toEqual([['none']])
    await click(secondTrigger)
    expect(radio('none', second).checked).toBe(true)
    expect(firstChange.mock.calls).toEqual([['satellite']])
    expect(secondChange.mock.calls).toEqual([['none']])
  })
})
