// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapSettingsProvider, MapViewSettingsControls, useMapSettings, type MapViewSettingsMode } from '../src/client/map-settings.tsx'
import { SandboxLightingControls } from '../src/client/SandboxLightingControls.tsx'
import { DEFAULT_MAP_SETTINGS, DEFAULT_SANDBOX_COLORS, readMapSettings, sanitizeMapSettings, writeMapSettings } from '../src/track/map-settings.ts'

let node: HTMLDivElement, root: Root
let state: ReturnType<typeof useMapSettings>

function Surface({ mode, lighting = false }: { mode: MapViewSettingsMode; lighting?: boolean }) {
  state = useMapSettings()
  return createElement('div', {}, createElement(MapViewSettingsControls, { mode }),
    lighting && createElement(SandboxLightingControls))
}
async function render(mode: MapViewSettingsMode, standalone = false, lighting = false) {
  const controls = createElement(Surface, { mode, lighting })
  await act(async () => root.render(standalone ? controls : createElement(MapSettingsProvider, {}, controls)))
}
function button(name: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(element =>
    (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  if (!found) throw new Error(`Missing button ${name}`)
  return found
}
function dialog() {
  const found = node.querySelector<HTMLElement>('[role="dialog"]')
  if (!found) throw new Error('Missing view settings dialog')
  return found
}
function input(name: string) {
  const found = dialog().querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)
  if (!found) throw new Error(`Missing view setting ${name}`)
  return found
}
function quality() { return dialog().querySelector<HTMLSelectElement>('select[aria-label="沙盘质量"]')! }
function background() { return dialog().querySelector<HTMLSelectElement>('select[aria-label="背景模式"]')! }
async function selectBackground(value: 'solid' | 'environment') {
  const element = background()
  if (!element) throw new Error('Missing sandbox background mode')
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function click(element: HTMLElement) { await act(async () => element.click()) }
async function inputValue(name: string, value: number | string) {
  const element = input(name)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value))
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function selectQuality(value: 'eco' | 'standard' | 'fine') {
  await act(async () => { quality().value = value; quality().dispatchEvent(new Event('change', { bubbles: true })) })
}
function seededPreferences(shadows = false) {
  return writeMapSettings(sanitizeMapSettings({
    basemap: 'maptiler-outdoor', maptilerKey: 'scope-test-key', tiandituKey: 'tianditu-scope-test-key', terrainProvider: 'maptiler',
    exaggeration: 2.35, quality: 'fine', buildings: true,
    sandboxColors: {sides: '#2468ac', background: '#102030'},
    sandboxBackground: 'environment',
    sandboxPlacemarks: false,
    lighting: { azimuth: 147, elevation: 57, intensity: 3.4, ambient: 1.15, shadows },
  }))
}
function assertNoGlobalFields() {
  expect(dialog().querySelector('input[type="password"],input[type="text"]')).toBeNull()
  expect([...dialog().querySelectorAll('label')].some(element =>
    ['地图源', 'MapTiler Key', '天地图 API Key', '高程来源'].some(label => element.textContent?.startsWith(label)))).toBe(false)
  expect([...dialog().querySelectorAll('button')].some(element => element.textContent === '连接测试')).toBe(false)
}

describe('map view settings scopes', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear()
    node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    node.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it('offers only exaggeration and buildings for the native 3D view', async () => {
    await render('terrain'); await click(button('3D 地图设置'))
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)?.textContent).toBe('3D 地图设置')
    expect([...dialog().querySelectorAll('input')].map(element => element.getAttribute('aria-label'))).toEqual(['地形倍率', '显示 3D 建筑'])
    expect(dialog().querySelector('select')).toBeNull()
    assertNoGlobalFields()
  })

  it('offers sandbox exaggeration, quality, colors and background without marker visibility, lighting, buildings or global services', async () => {
    await render('sandbox'); await click(button('3D 沙盘设置'))
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)?.textContent).toBe('3D 沙盘设置')
    expect(new Set([...dialog().querySelectorAll('input')].map(element => element.getAttribute('aria-label')))).toEqual(
      new Set(['地形倍率', '侧壁颜色', '背景颜色']))
    expect(input('侧壁颜色').type).toBe('color'); expect(input('背景颜色').type).toBe('color')
    expect(dialog().querySelectorAll('select')).toHaveLength(2)
    expect([...background().options].map(option => ({value: option.value, label: option.textContent}))).toEqual([
      {value: 'solid', label: '纯色背景'}, {value: 'environment', label: '球形环境光'},
    ])
    expect(background().value).toBe('solid')
    expect(quality()).not.toBeNull()
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull()
    expect([...dialog().querySelectorAll('button')].some(element => element.textContent === '恢复默认光影')).toBe(false)
    assertNoGlobalFields()
  })

  it.each(['terrain', 'sandbox'] as const)('discards %s drafts on close and restores focus to its gear', async mode => {
    const original = seededPreferences()
    // Exercise both the shared Provider and the standalone local dialog paths.
    await render(mode, mode === 'sandbox')
    const opener = button(mode === 'terrain' ? '3D 地图设置' : '3D 沙盘设置')
    opener.focus(); await click(opener)
    expect(document.activeElement).toBe(input('地形倍率'))
    await inputValue('地形倍率', 2.8)
    if (mode === 'terrain') await click(input('显示 3D 建筑'))
    else {
      await selectQuality('eco'); await selectBackground('solid')
      await inputValue('侧壁颜色', '#123456'); await inputValue('背景颜色', '#654321')
    }
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    if (mode === 'terrain') await click(button('取消'))
    else await act(async () => input('地形倍率').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(node.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
  })

  it('applies sandbox drafts on save while preserving external marker toggles, services, buildings and lighting', async () => {
    const original = seededPreferences()
    await render('sandbox'); await click(button('3D 沙盘设置'))
    await inputValue('地形倍率', 2.8); await selectQuality('standard'); await selectBackground('solid')
    await inputValue('侧壁颜色', '#123456'); await inputValue('背景颜色', '#654321')
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    // A toolbar toggle while this dialog is open must survive its older draft.
    await act(async () => state.updateSettings({sandboxPlacemarks: true}))
    expect(state.settings).toEqual({...original, sandboxPlacemarks: true})
    expect(readMapSettings()).toEqual(state.settings)
    await click(button('保存应用'))
    expect(state.settings).toEqual({
      ...original, exaggeration: 2.8, quality: 'standard', sandboxColors: {sides: '#123456', background: '#654321'},
      sandboxBackground: 'solid', sandboxPlacemarks: true,
    })
    expect(readMapSettings()).toEqual(state.settings)
    expect(node.querySelector('[role="dialog"]')).toBeNull()
  })

  it('restores sandbox gear defaults while preserving marker visibility, services, buildings and lighting', async () => {
    const original = seededPreferences()
    await render('sandbox'); await click(button('3D 沙盘设置')); await click(button('恢复默认'))
    expect(Number(input('地形倍率').value)).toBe(DEFAULT_MAP_SETTINGS.exaggeration)
    expect(quality().value).toBe(DEFAULT_MAP_SETTINGS.quality)
    expect(background().value).toBe(DEFAULT_MAP_SETTINGS.sandboxBackground)
    expect(input('侧壁颜色').value).toBe(DEFAULT_SANDBOX_COLORS.sides)
    expect(input('背景颜色').value).toBe(DEFAULT_SANDBOX_COLORS.background)
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    await click(button('保存应用'))
    expect(state.settings).toEqual({
      ...original, exaggeration: DEFAULT_MAP_SETTINGS.exaggeration, quality: DEFAULT_MAP_SETTINGS.quality,
      sandboxColors: DEFAULT_SANDBOX_COLORS, sandboxBackground: DEFAULT_MAP_SETTINGS.sandboxBackground,
    })
    expect(readMapSettings()).toEqual(state.settings)
  })

  it('applies native 3D drafts without changing global services, sandbox quality, colors, background mode, marker visibility or lighting', async () => {
    const original = seededPreferences()
    await render('terrain'); await click(button('3D 地图设置'))
    await inputValue('地形倍率', 1.85); await click(input('显示 3D 建筑'))
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    await click(button('保存应用'))
    expect(state.settings).toEqual({ ...original, exaggeration: 1.85, buildings: false })
    expect(readMapSettings()).toEqual(state.settings)
  })

  it('restores only native 3D defaults while preserving global services, sandbox quality, colors, background mode, marker visibility and lighting', async () => {
    const original = seededPreferences()
    await render('terrain'); await click(button('3D 地图设置')); await click(button('恢复默认'))
    expect(Number(input('地形倍率').value)).toBe(DEFAULT_MAP_SETTINGS.exaggeration)
    expect(input('显示 3D 建筑').checked).toBe(DEFAULT_MAP_SETTINGS.buildings)
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    await click(button('保存应用'))
    expect(state.settings).toEqual({
      ...original, exaggeration: DEFAULT_MAP_SETTINGS.exaggeration, buildings: DEFAULT_MAP_SETTINGS.buildings,
    })
    expect(readMapSettings()).toEqual(state.settings)
  })

  it('preserves the sun panel shadow preference through gear quality changes from eco back to standard', async () => {
    const original = seededPreferences(true)
    await render('sandbox', false, true)
    const shadow = () => node.querySelector<HTMLInputElement>('.trk-lighting-panel input[aria-label="地形阴影"]')!
    await click(button('光影'))
    expect(shadow().checked).toBe(true); expect(shadow().disabled).toBe(false)
    await click(button('关闭光影面板'))

    await click(button('3D 沙盘设置')); await selectQuality('eco')
    expect(readMapSettings()).toEqual(original)
    await click(button('保存应用'))
    expect(state.settings).toEqual({ ...original, quality: 'eco' })
    expect(readMapSettings().lighting).toEqual(original.lighting)
    await click(button('光影'))
    expect(shadow().disabled).toBe(true); expect(shadow().checked).toBe(false)
    expect(readMapSettings().lighting.shadows).toBe(true)
    await click(button('关闭光影面板'))

    await click(button('3D 沙盘设置')); await selectQuality('standard')
    expect(readMapSettings().quality).toBe('eco')
    await click(button('保存应用'))
    await click(button('光影'))
    expect(shadow().disabled).toBe(false); expect(shadow().checked).toBe(true)
    expect(state.settings).toEqual({ ...original, quality: 'standard' })
    expect(readMapSettings()).toEqual(state.settings)
  })
})
