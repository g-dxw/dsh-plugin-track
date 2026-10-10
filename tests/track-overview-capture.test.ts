// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackOverview, TrackPlacemarkEditor, type PlacemarkEditorState } from '../src/client/TrackOverview.tsx'
import type { MapView, MapResourceCaptureControls } from '../src/client/MapView.tsx'
import type { TrackPoint, TrackRecord } from '../src/protocol.ts'
import type { PlacemarkStateData, PlacemarkStateDocument } from '../src/track/placemark-state.ts'
import { editedMetrics } from '../src/track/edit.ts'

const map = vi.hoisted(() => ({current: null as Parameters<typeof MapView>[0] | null}))
const service = vi.hoisted(() => ({
  api: vi.fn(), states: new Map<string, PlacemarkStateDocument>(),
  wait: null as Promise<void> | null, failure: '',
}))
vi.mock('../src/client/MapView.tsx', () => ({
  MapView: (props: Parameters<typeof MapView>[0]) => {
    map.current = props
    return createElement('div', {'data-map': true})
  },
}))
vi.mock('../src/client/ElevationChart.tsx', () => ({
  ElevationChart: () => createElement('div', {'data-profile': true}),
}))
vi.mock('../src/client/placemark-photo-cache.ts', () => ({preparePlacemarkPhotoCache: vi.fn(async () => {})}))
vi.mock('../src/client/util.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/util.ts')>(), api: service.api,
}))

const coordinates: TrackPoint[] = [[120, 30, 500, null], [120.1, 30.1, 520, null]]
const track: TrackRecord = {
  id: 'overview-capture', name: '截图测试路线', format: 'kml', filename: 'route.kml',
  createdAt: '2026-10-09T00:00:00Z', bytes: 80, points: coordinates.length,
  segmentStarts: [0], coordinates, metrics: editedMetrics(coordinates),
  placemarks: [
    {id: 'point-a', name: '牧场', coordinates: [120, 30], elevation: 500, time: null, description: '草地', images: []},
    {id: 'point-b', name: '山口', coordinates: [120.1, 30.1], elevation: 520, time: null, description: '', images: []},
  ],
}
let node: HTMLDivElement, root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  map.current = null
  service.states.clear(); service.wait = null; service.failure = ''; service.api.mockReset()
  service.api.mockImplementation(async (action: string, data?: {id: string; revision: number; data: PlacemarkStateData}) => {
    if (data === undefined && action.startsWith('placemark-state?')) {
      const id = new URLSearchParams(action.split('?')[1]).get('id')!
      return {state: service.states.get(id) || {
        version: 1, revision: 0, added: [], deletedIds: [], edits: [], order: null, groups: [],
        routeContext: {segmentStarts: [0], references: track.placemarks},
      }}
    }
    if (action === 'placemark-state' && data) {
      if (service.wait) await service.wait
      if (service.failure) throw new Error(service.failure)
      const state: PlacemarkStateDocument = {...structuredClone(data.data), version: 1, revision: data.revision + 1}
      service.states.set(data.id, state)
      return {state}
    }
    throw new Error('Unexpected action: ' + action)
  })
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount())
  node.remove(); vi.unstubAllGlobals()
})

function controls(overrides: Partial<MapResourceCaptureControls> = {}): MapResourceCaptureControls {
  return {
    busy: false, disabled: false, disabledReason: '', notice: '', error: '', retryAvailable: false,
    save: vi.fn(async () => {}), retry: vi.fn(async () => {}), ...overrides,
  }
}
async function render(editable = false, onDraftStateChange?: (state: PlacemarkEditorState) => void) {
  const props = {track, basemap: 'none' as const, onBasemap: vi.fn()}
  await act(async () => root.render(editable
    ? createElement(TrackPlacemarkEditor, {...props, deferSave: true, onDraftStateChange})
    : createElement(TrackOverview, props)))
}
async function publishCapture(value: MapResourceCaptureControls | null) {
  expect(map.current?.onResourceCaptureChange).toBeTypeOf('function')
  await act(async () => map.current!.onResourceCaptureChange!(value))
}
function button(label: string) {
  const found = Array.from(node.querySelectorAll<HTMLButtonElement>('button'))
    .find(element => element.getAttribute('aria-label') === label || element.textContent === label)
  expect(found, `button: ${label}`).toBeDefined()
  return found!
}
function capturePanel() {return node.querySelector<HTMLElement>('[aria-label="地图画面保存"]')!}
function writes() {return service.api.mock.calls.filter(([, data]) => data !== undefined)}
async function applyDraftName(name: string) {
  await act(async () => button('编辑标注点 1').click())
  const input = node.querySelector<HTMLInputElement>('[aria-label="标注名"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name)
  await act(async () => input.dispatchEvent(new Event('input', {bubbles: true})))
  await act(async () => node.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})))
  expect(node.querySelector('dialog')).toBeNull()
}

describe('map resource capture in the placemark sidebar', () => {
  it.each([false, true])('places capture in the sidebar header and calls the controller (editable: %s)', async editable => {
    await render(editable)
    const control = controls()
    await publishCapture(control)
    const save = button('保存到资源库')
    expect(save.closest('aside[aria-label="轨迹标注点"] > header')).not.toBeNull()
    expect(save.closest('.trk-stage')).toBeNull()
    expect(node.querySelector('.trk-stage [aria-label="地图画面保存"]')).toBeNull()
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(control.save).toHaveBeenCalledOnce()
    expect(control.retry).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(0)
  })

  it('disables capture before the map publishes a controller and after it releases one', async () => {
    await render()
    expect(button('保存到资源库').disabled).toBe(true)
    await publishCapture(controls())
    expect(button('保存到资源库').disabled).toBe(false)
    await publishCapture(null)
    expect(button('保存到资源库').disabled).toBe(true)
  })

  it('shows the current capture disabled reason and busy label without invoking disabled actions', async () => {
    await render()
    const control = controls({disabled: true, disabledReason: '等待 3D 沙盘加载完成后再保存'})
    await publishCapture(control)
    expect(button('保存到资源库').title).toBe(control.disabledReason)
    expect(button('保存到资源库').disabled).toBe(true)
    await act(async () => button('保存到资源库').click())
    expect(control.save).not.toHaveBeenCalled()
    await publishCapture({...control, busy: true, disabledReason: '正在保存地图图片，请稍候'})
    expect(button('正在保存画面…').disabled).toBe(true)
    expect(button('正在保存画面…').title).toBe('正在保存地图图片，请稍候')
    await act(async () => button('正在保存画面…').click())
    expect(control.save).not.toHaveBeenCalled()
  })

  it('places success and failure feedback next to the sidebar capture action', async () => {
    await render()
    await publishCapture(controls({notice: '已保存到资源库'}))
    expect(capturePanel().querySelector('[role="status"]')?.textContent).toBe('已保存到资源库')
    expect(capturePanel().querySelector('[role="alert"]')).toBeNull()
    await publishCapture(controls({error: '上传失败，已保留截图', retryAvailable: false}))
    expect(capturePanel().querySelector('[role="status"]')).toBeNull()
    expect(capturePanel().querySelector('[role="alert"]')?.textContent).toBe('上传失败，已保留截图')
    expect(Array.from(capturePanel().querySelectorAll('button')).map(element => element.textContent)).not.toContain('重试保存')
  })

  it('uses the existing PNG retry action when a new capture is unavailable, disabling retry only while busy', async () => {
    await render()
    const originalPNG = new Blob(['original-view'], {type: 'image/png'})
    const upload = vi.fn(async (_png: Blob) => {})
    const control = controls({
      disabled: true, disabledReason: '等待 3D 沙盘加载完成后再保存',
      error: '上传失败，已保留截图', retryAvailable: true,
      retry: vi.fn(async () => {await upload(originalPNG)}),
    })
    await publishCapture(control)
    expect(button('保存到资源库').disabled).toBe(true)
    expect(button('重试保存').disabled).toBe(false)
    await act(async () => button('重试保存').click())
    expect(control.retry).toHaveBeenCalledOnce()
    expect(control.save).not.toHaveBeenCalled()
    expect(upload.mock.calls[0][0]).toBe(originalPNG)
    await publishCapture({...control, busy: true})
    expect(button('重试保存').disabled).toBe(true)
    await act(async () => button('重试保存').click())
    expect(control.retry).toHaveBeenCalledOnce()
    await publishCapture({...control, disabledReason: '当前设备没有可用的 WebGL，无法导出地图图片'})
    await act(async () => button('重试保存').click())
    expect(upload.mock.calls[1][0]).toBe(originalPNG)
    expect(control.save).not.toHaveBeenCalled()
  })

  it('blocks new capture for a real manual placemark draft until its delayed state save succeeds', async () => {
    const draft = vi.fn<(state: PlacemarkEditorState) => void>()
    const before = structuredClone(track)
    await render(true, draft)
    const control = controls({error: '之前的 PNG 上传失败', retryAvailable: true})
    await publishCapture(control)
    expect(draft.mock.lastCall![0]).toMatchObject({dirty: false, ready: true})
    expect(button('保存到资源库').disabled).toBe(false)
    await applyDraftName('牧场新名称')
    expect(map.current!.placemarks![0].name).toBe('牧场新名称')
    expect(draft.mock.lastCall![0]).toMatchObject({dirty: true, ready: true})
    expect(writes()).toHaveLength(0)
    expect(button('保存到资源库').disabled).toBe(true)
    expect(button('保存到资源库').title).toBe('请先保存标注点修改，再保存地图画面')
    expect(capturePanel().textContent).toContain('先保存标注点修改，再保存地图画面')
    expect(button('重试保存').disabled).toBe(false)
    await act(async () => button('重试保存').click())
    expect(control.retry).toHaveBeenCalledOnce()
    await act(async () => button('保存到资源库').click())
    expect(control.save).not.toHaveBeenCalled()
    let release!: () => void
    service.wait = new Promise<void>(resolve => {release = resolve})
    let saved!: Promise<boolean>
    await act(async () => {saved = draft.mock.lastCall![0].save(); await Promise.resolve()})
    expect(button('保存到资源库').disabled).toBe(true)
    expect(button('重试保存').disabled).toBe(false)
    expect(draft.mock.lastCall![0].dirty).toBe(true)
    expect(service.states.size).toBe(0)
    await act(async () => {release(); expect(await saved).toBe(true)})
    expect(draft.mock.lastCall![0]).toMatchObject({dirty: false, ready: true})
    expect(service.states.get(track.id)).toMatchObject({revision: 1, edits: [{id: 'point-a', name: '牧场新名称'}]})
    expect(writes()).toHaveLength(1)
    expect(button('保存到资源库').disabled).toBe(false)
    expect(button('保存到资源库').title).toBe('')
    await act(async () => button('保存到资源库').click())
    expect(control.save).toHaveBeenCalledOnce()
    expect(track).toEqual(before)
  })

  it('keeps capture blocked after an unconfirmed manual save and restores it after the draft is saved', async () => {
    const draft = vi.fn<(state: PlacemarkEditorState) => void>()
    await render(true, draft)
    const control = controls()
    await publishCapture(control)
    await applyDraftName('尚未保存的牧场')
    service.failure = '状态保存失败'
    await act(async () => {expect(await draft.mock.lastCall![0].save()).toBe(false)})
    expect(draft.mock.lastCall![0].dirty).toBe(true)
    expect(button('保存到资源库').disabled).toBe(true)
    expect(map.current!.placemarks![0].name).toBe('尚未保存的牧场')
    await act(async () => button('保存到资源库').click())
    expect(control.save).not.toHaveBeenCalled()
    service.failure = ''
    await act(async () => {expect(await draft.mock.lastCall![0].save()).toBe(true)})
    expect(draft.mock.lastCall![0].dirty).toBe(false)
    expect(button('保存到资源库').disabled).toBe(false)
  })
})
