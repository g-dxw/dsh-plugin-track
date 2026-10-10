// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackEditor, type TrackEditorProps } from '../src/client/TrackEditor.tsx'
import type { EditorMapProps } from '../src/client/EditorMap.tsx'
import type { PlacemarkEditorState } from '../src/client/TrackOverview.tsx'
import { editedMetrics } from '../src/track/edit.ts'
import * as gpxExport from '../src/track/gpx-export.ts'
import { UPLOADS, type TrackInput, type TrackPoint, type TrackRecord } from '../src/protocol.ts'
import { api } from '../src/client/util.ts'
import type { TrackAnnotation } from '../src/track/annotations.ts'
vi.mock('../src/client/useTrackPlacemarks.ts',async importOriginal=>({...await importOriginal<typeof import('../src/client/useTrackPlacemarks.ts')>(),loadTrackPlacemarkState:vi.fn(async (track:TrackRecord)=>({points:track.placemarks||[],groups:[]}))}))


vi.mock('../src/client/util.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/util.ts')>(), api: vi.fn(),
}))

const mapState = vi.hoisted(() => ({latest: null as EditorMapProps | null}))
type PointEditorProps = {
  track: TrackRecord; onBusyChange?: (busy: boolean) => void; history?: object
  active?: boolean; deferSave?: boolean; onDraftStateChange?: (state: PlacemarkEditorState) => void
}
const pointEditorState = vi.hoisted(() => ({
  latest: null as PointEditorProps | null, draft: null as PlacemarkEditorState | null, mounts: 0, unmounts: 0,
}))
vi.mock('../src/client/TrackOverview.tsx', () => ({TrackPlacemarkEditor: (props: PointEditorProps) => {
  pointEditorState.latest = props
  useEffect(() => {
    pointEditorState.mounts++
    return () => {pointEditorState.unmounts++}
  }, [])
  useEffect(() => {props.onDraftStateChange?.(pointEditorState.draft!)}, [props.track.id, props.onDraftStateChange])
  return createElement('div', {'data-testid':'placemark-editor'})
}}))
vi.mock('../src/client/EditorMap.tsx', () => ({
  EditorMap: (props: EditorMapProps) => {
    mapState.latest = props
    return createElement('div', {'data-testid': 'editor-map'})
  },
}))

const SVG_POINT: TrackAnnotation = {id: 'svg-point', pointIndex: 1, label: '山口', color: '#7c3aed', visible: true}
const TIME = Date.parse('2026-09-20T01:00:00Z')
const POINTS: TrackPoint[] = [
  [119.44, 30.34, 100, TIME], [119.45, 30.35, 120, TIME + 60000],
  [119.46, 30.36, 160, TIME + 120000], [119.47, 30.37, 180, TIME + 180000],
]
function record(id = 'original', name = '山区轨迹', points = POINTS): TrackRecord {
  return {
    id, name, filename: name + '.kml', format: 'kml', createdAt: '2026-09-20T00:00:00Z',
    bytes: 1234, points: points.length, coordinates: points, metrics: editedMetrics(points),
  }
}
let root: Root
let container: HTMLDivElement
let props: TrackEditorProps

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {callback(0); return 0})
  mapState.latest = null
  pointEditorState.latest = null
  pointEditorState.mounts = 0
  pointEditorState.unmounts = 0
  pointEditorState.draft = {dirty: false, ready: true, save: vi.fn(async () => {
    pointEditorState.draft = {...pointEditorState.draft!, dirty: false}
    pointEditorState.latest?.onDraftStateChange?.(pointEditorState.draft)
    return true
  })}
  vi.mocked(api).mockReset().mockResolvedValue({annotations: [SVG_POINT], saved: true})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  props = {
    initial: record(), availableTracks: [], basemap: 'vector', onBasemap: vi.fn(),
    loadTrack: vi.fn(async () => record('library', '库中轨迹', [[120, 31, 200, TIME], [120.1, 31.1, 300, TIME + 60000]])),
    onSave: vi.fn(async () => {}), onCancel: vi.fn(),
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(overrides: Partial<TrackEditorProps> = {}) {
  props = {...props, ...overrides}
  await act(async () => root.render(createElement(TrackEditor, props)))
}
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === text)
  if (!found) throw new Error('Button not found: ' + text)
  return found
}
async function click(text: string) { await act(async () => button(text).click()) }
async function pointDraft(overrides: Partial<PlacemarkEditorState>) {
  await act(async () => {
    pointEditorState.draft = {...pointEditorState.draft!, ...overrides}
    pointEditorState.latest!.onDraftStateChange!(pointEditorState.draft)
  })
}
async function renderLine(overrides: Partial<TrackEditorProps> = {}) {
  await render(overrides)
  if (props.initial) await click('线路编辑')
}
async function tabKey(text: string, key: string) {
  await act(async () => {
    const tab = button(text)
    tab.focus()
    tab.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}))
  })
}
function field(label: string): HTMLInputElement { return container.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')! }
async function input(label: string, value: string) {
  await act(async () => {
    const element = field(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', {bubbles: true}))
  })
}
async function chooseLibrary(id: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="从轨迹库添加"]')!
    select.value = id
    select.dispatchEvent(new Event('change', {bubbles: true}))
  })
}
async function mapAction(action: (map: EditorMapProps) => void) {
  await act(async () => action(mapState.latest!))
}
async function shortcut(target: EventTarget = document, options: KeyboardEventInit = {key: 'z', ctrlKey: true}) {
  const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...options})
  await act(async () => target.dispatchEvent(event))
  return event
}
function activePoints(): TrackPoint[] {
  const latest = mapState.latest!
  return latest.parts.find(part => part.id === latest.activePartId)!.points
}
function savedInputs(call = 0): readonly TrackInput[] {
  return vi.mocked(props.onSave).mock.calls[call][0]
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no})
  return {promise, resolve, reject}
}

describe('track editor drafts and copy saving', () => {
  it('redoes line edits with Ctrl + Y while keeping native input and other focused controls untouched',async()=>{
    await renderLine()
    await mapAction(map=>map.onMovePoint(1,119.451,30.351))
    const draft=activePoints()
    button('线路编辑').focus()
    expect(document.activeElement).toBe(button('线路编辑'))
    await shortcut()
    expect(activePoints()).toBe(POINTS)
    await shortcut(document,{key:'y',ctrlKey:true})
    expect(activePoints()).toBe(draft)
    const name=field('当前轨迹名称');name.focus()
    expect(document.activeElement).toBe(name)
    for(const target of [name,document,document.body,document.documentElement]){
      expect((await shortcut(target)).defaultPrevented).toBe(false)
      expect((await shortcut(target,{key:'y',ctrlKey:true})).defaultPrevented).toBe(false)
      expect(activePoints()).toBe(draft)
      expect(document.activeElement).toBe(name)
    }
    const outside=document.createElement('button');document.body.append(outside);outside.focus()
    try{
      for(const target of [outside,document,document.body,document.documentElement]){
        expect((await shortcut(target)).defaultPrevented).toBe(false)
        expect((await shortcut(target,{key:'y',ctrlKey:true})).defaultPrevented).toBe(false)
        expect(activePoints()).toBe(draft)
        expect(document.activeElement).toBe(outside)
      }
    }finally{outside.remove()}
  })
  it('owns one point history across tab changes and creates a fresh history after exiting or changing track',async()=>{
    await render()
    const first=pointEditorState.latest!.history
    expect(first).toBeDefined()
    await click('线路编辑')
    await mapAction(map=>map.onMovePoint(1,119.451,30.351))
    const lineDraft=activePoints()
    await click('标注点编辑')
    expect(pointEditorState.latest!.history).toBe(first)
    await click('线路编辑')
    expect(activePoints()).toBe(lineDraft)
    await click('标注点编辑')
    expect(pointEditorState.latest!.history).toBe(first)
    await act(async()=>root.render(null))
    await render()
    const reopened=pointEditorState.latest!.history
    expect(reopened).toBeDefined()
    expect(reopened).not.toBe(first)
    await render({initial:record('other')})
    expect(pointEditorState.latest!.history).not.toBe(reopened)
  })
  it('opens existing tracks in point editing with SVG annotations between points and lines', async () => {
    await render()
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="编辑内容"] [role="tab"]'))
    expect(tabs.map(tab => tab.textContent)).toEqual(['标注点编辑', 'SVG 标注', '线路编辑'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1])
    expect(container.querySelector('[data-testid="placemark-editor"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="editor-map"]')).toBeNull()
    expect(pointEditorState.latest!.track).toBe(props.initial)
    expect(pointEditorState.latest!.deferSave).toBe(true)
    expect(pointEditorState.latest!.active).toBe(true)
    expect(button('返回轨迹').disabled).toBe(false)
    expect(button('保存标注点修改').disabled).toBe(true)
    expect(container.textContent).not.toContain('保存全部为 GPX 副本')
  })
  it('enables explicit point saving only for a ready dirty draft and never saves on local changes', async () => {
    await render()
    const save = pointEditorState.draft!.save
    await click('保存标注点修改')
    expect(save).not.toHaveBeenCalled()
    await pointDraft({dirty: true, ready: false})
    expect(button('保存标注点修改').disabled).toBe(true)
    await click('保存标注点修改')
    expect(save).not.toHaveBeenCalled()
    await pointDraft({ready: true})
    expect(button('保存标注点修改').disabled).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
    await click('保存标注点修改')
    expect(save).toHaveBeenCalledOnce()
    expect(props.onSave).not.toHaveBeenCalled()
  })
  it('keeps a dirty point pane mounted and inactive across other tabs without saving its draft', async () => {
    await render()
    const pane = container.querySelector('[data-testid="placemark-editor"]')
    const history = pointEditorState.latest!.history
    const save = pointEditorState.draft!.save
    await pointDraft({dirty: true})
    expect(button('标注点编辑').title).toBe('有未保存的修改')
    expect(button('标注点编辑').querySelector('svg')).not.toBeNull()
    for (const tab of ['SVG 标注', '线路编辑']) {
      await click(tab)
      expect(container.querySelector('[data-testid="placemark-editor"]')).toBe(pane)
      expect(pane?.closest('[hidden]')).not.toBeNull()
      expect(pointEditorState.latest!.active).toBe(false)
      expect(pointEditorState.latest!.history).toBe(history)
      expect(button('标注点编辑').title).toBe('有未保存的修改')
    }
    await click('标注点编辑')
    expect(container.querySelector('[data-testid="placemark-editor"]')).toBe(pane)
    expect(pane?.closest('[hidden]')).toBeNull()
    expect(pointEditorState.latest!.active).toBe(true)
    expect(pointEditorState.mounts).toBe(1)
    expect(pointEditorState.unmounts).toBe(0)
    expect(container.textContent).toContain('有未保存的标注点修改 · 切换 Tab 会保留草稿')
    expect(button('保存标注点修改').disabled).toBe(false)
    expect(save).not.toHaveBeenCalled()
    const unload = new Event('beforeunload', {cancelable: true})
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })
  it('asks before returning with a point draft and preserves it when editing continues', async () => {
    await render()
    await pointDraft({dirty: true})
    const save = pointEditorState.draft!.save
    await click('返回轨迹')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
    await click('继续编辑')
    expect(container.querySelector('.trk-editor-discard')).toBeNull()
    expect(button('保存标注点修改').disabled).toBe(false)
    expect(button('标注点编辑').title).toBe('有未保存的修改')
    await click('线路编辑')
    await click('取消编辑')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
    await click('放弃修改')
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
  })
  it('notifies the parent after a successful explicit point save and releases draft exit protection', async () => {
    const onPlacemarksSaved = vi.fn()
    await render({onPlacemarksSaved})
    await pointDraft({dirty: true})
    await click('保存标注点修改')
    expect(pointEditorState.draft!.save).toHaveBeenCalledOnce()
    expect(onPlacemarksSaved).toHaveBeenCalledOnce()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(button('保存标注点修改').disabled).toBe(true)
    expect(button('标注点编辑').title).toBe('')
    expect(container.textContent).toContain('标注点修改已保存。')
    const unload = new Event('beforeunload', {cancelable: true})
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    await click('返回轨迹')
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(container.querySelector('.trk-editor-discard')).toBeNull()
  })
  it('retains a point draft and permits retry when the save controller returns false', async () => {
    const onPlacemarksSaved = vi.fn()
    const save = vi.fn(async () => false)
    await render({onPlacemarksSaved})
    await pointDraft({dirty: true, save})
    await click('保存标注点修改')
    expect(save).toHaveBeenCalledOnce()
    expect(onPlacemarksSaved).not.toHaveBeenCalled()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(button('保存标注点修改').disabled).toBe(false)
    expect(button('标注点编辑').title).toBe('有未保存的修改')
    expect(container.textContent).toContain('有未保存的标注点修改')
    expect(container.textContent).not.toContain('标注点修改已保存。')
    await click('保存标注点修改')
    expect(save).toHaveBeenCalledTimes(2)
    await click('返回轨迹')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
  })
  it('locks tabs and return and rejects duplicate point commits until the save settles', async () => {
    const pending = deferred<boolean>()
    const save = vi.fn(() => pending.promise)
    await render()
    await pointDraft({dirty: true, save})
    await act(async () => {
      const commit = button('保存标注点修改')
      commit.click()
      commit.click()
    })
    expect(save).toHaveBeenCalledOnce()
    for (const label of ['标注点编辑', 'SVG 标注', '线路编辑', '正在处理点位…', '正在保存…']) expect(button(label).disabled).toBe(true)
    await tabKey('标注点编辑', 'End')
    expect(button('标注点编辑').getAttribute('aria-selected')).toBe('true')
    await click('正在处理点位…')
    expect(props.onCancel).not.toHaveBeenCalled()
    await act(async () => pending.resolve(false))
    for (const label of ['标注点编辑', 'SVG 标注', '线路编辑', '返回轨迹', '保存标注点修改']) expect(button(label).disabled).toBe(false)
    expect(button('标注点编辑').title).toBe('有未保存的修改')
  })
  it('keeps editing after a line copy save while preserving an unsaved point draft', async () => {
    const onPlacemarksSaved = vi.fn()
    await renderLine({onPlacemarksSaved})
    await pointDraft({dirty: true})
    const save = pointEditorState.draft!.save
    await mapAction(map => map.onMovePoint(1, 119.451, 30.351))
    await click('保存全部为 GPX 副本')
    expect(props.onSave).toHaveBeenCalledOnce()
    expect(vi.mocked(props.onSave).mock.calls[0][1]).toEqual({keepEditing: true})
    expect(save).not.toHaveBeenCalled()
    expect(onPlacemarksSaved).not.toHaveBeenCalled()
    expect(button('线路编辑').title).toBe('')
    expect(button('标注点编辑').title).toBe('有未保存的修改')
    await click('标注点编辑')
    expect(button('保存标注点修改').disabled).toBe(false)
    await click('返回轨迹')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
  })
  it('moves and focuses tabs with arrows, Home and End in their visible order', async () => {
    await render()
    await tabKey('标注点编辑', 'ArrowRight')
    expect(button('SVG 标注').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('SVG 标注'))
    expect(container.querySelector('.trk-art-board svg')).not.toBeNull()
    await tabKey('SVG 标注', 'ArrowRight')
    expect(button('线路编辑').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('线路编辑'))
    expect(container.querySelector('[data-testid="editor-map"]')).not.toBeNull()
    await tabKey('线路编辑', 'ArrowLeft')
    expect(button('SVG 标注').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('SVG 标注'))
    await tabKey('SVG 标注', 'ArrowLeft')
    expect(button('标注点编辑').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('标注点编辑'))
    await tabKey('标注点编辑', 'End')
    expect(button('线路编辑').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('线路编辑'))
    await tabKey('线路编辑', 'Home')
    expect(button('标注点编辑').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(button('标注点编辑'))
    await tabKey('标注点编辑', 'ArrowLeft')
    expect(document.activeElement).toBe(button('线路编辑'))
    await tabKey('线路编辑', 'ArrowRight')
    expect(document.activeElement).toBe(button('标注点编辑'))
  })
  it('places point editing inside the existing editor and preserves a line draft when switching', async () => {
    await renderLine();await mapAction(map=>map.onMovePoint(1,119.451,30.351))
    const draft=activePoints()
    await click('标注点编辑')
    expect(container.querySelector('[data-testid="placemark-editor"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="editor-map"]')).toBeNull()
    expect(pointEditorState.latest!.track).toBe(props.initial)
    expect(container.textContent).toContain('修改可实时预览，点击保存后生效。')
    expect(container.textContent).not.toContain('保存全部为 GPX 副本')
    button('标注点编辑').focus()
    await shortcut()
    await click('线路编辑');expect(activePoints()).toBe(draft)
    expect(button('撤销').disabled).toBe(false)
    expect(props.onSave).not.toHaveBeenCalled()
  })
  it('locks return and mode switches while point edits are being saved', async () => {
    await render()
    await act(async()=>pointEditorState.latest!.onBusyChange!(true))
    expect(button('正在处理点位…').disabled).toBe(true)
    expect(button('线路编辑').disabled).toBe(true)
    expect(button('标注点编辑').disabled).toBe(true)
    expect(button('SVG 标注').disabled).toBe(true)
    await tabKey('标注点编辑','End')
    expect(button('标注点编辑').getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-testid="placemark-editor"]')).not.toBeNull()
    await click('正在处理点位…');expect(props.onCancel).not.toHaveBeenCalled()
    await act(async()=>pointEditorState.latest!.onBusyChange!(false))
    await click('返回轨迹');expect(props.onCancel).toHaveBeenCalledOnce()
  })
  it('keeps new route creation on the existing line editor without imported point controls', async () => {
    await render({initial:null})
    expect(container.querySelector('[aria-label="编辑内容"]')).toBeNull()
    expect(container.querySelector('[data-testid="editor-map"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="placemark-editor"]')).toBeNull()
    expect(container.querySelector('.trk-art')).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })
  it('loads the SVG only when opened and preserves its real canvas, draft and undo history across tabs', async () => {
    await render()
    expect(api).not.toHaveBeenCalled()
    expect(container.querySelector('.trk-art')).toBeNull()
    await click('SVG 标注')
    expect(api).toHaveBeenCalledExactlyOnceWith('annotations?id=original')
    expect(container.querySelector('[data-testid="placemark-editor"]')?.closest('[hidden]')).not.toBeNull()
    expect(pointEditorState.latest!.active).toBe(false)
    expect(container.querySelector('[data-testid="editor-map"]')).toBeNull()
    expect(container.textContent).not.toContain('返回概览')
    const canvas = container.querySelector('.trk-art-overlay-canvas')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-point-id="svg-point"]')!.click())
    await input('点位名称', '牧场')
    await click('完成编辑')
    expect(canvas?.textContent).toContain('牧场')
    await click('标注点编辑')
    expect(container.querySelector('.trk-art-overlay-canvas')).toBe(canvas)
    expect(container.querySelector('.trk-art')?.closest('[hidden]')).not.toBeNull()
    await click('线路编辑')
    await mapAction(map => map.onMovePoint(1, 119.451, 30.351))
    const lineDraft = activePoints()
    await click('SVG 标注')
    expect(container.querySelector('.trk-art-overlay-canvas')).toBe(canvas)
    expect(container.querySelector('.trk-art')?.closest('[hidden]')).toBeNull()
    expect(canvas?.textContent).toContain('牧场')
    expect(api).toHaveBeenCalledTimes(1)
    await click('撤销')
    expect(canvas?.textContent).toContain('山口')
    await click('重做')
    expect(canvas?.textContent).toContain('牧场')
    await click('线路编辑')
    expect(activePoints()).toBe(lineDraft)
    expect(props.onSave).not.toHaveBeenCalled()
  })
  it('protects an unsaved SVG draft when leaving from another editor tab', async () => {
    await render()
    await click('SVG 标注')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-point-id="svg-point"]')!.click())
    await input('点位名称', '牧场')
    await click('完成编辑')
    await click('标注点编辑')
    await click('返回轨迹')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
    await click('继续编辑')
    await click('SVG 标注')
    expect(container.querySelector('svg[data-art-scene]')?.textContent).toContain('牧场')
    await click('返回轨迹')
    await click('放弃修改')
    expect(props.onCancel).toHaveBeenCalledOnce()
  })
  it('saves the SVG to annotation storage and releases exit protection without creating a GPX copy', async () => {
    await render()
    await click('SVG 标注')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-point-id="svg-point"]')!.click())
    await input('点位名称', '牧场')
    await click('完成编辑')
    vi.mocked(api).mockImplementation(async (_action, data) => ({
      annotations: (data as {annotations: TrackAnnotation[]}).annotations,
    }) as never)
    await click('保存画布')
    expect(api).toHaveBeenLastCalledWith('annotations', {canvas:{width:1200,height:900},id: 'original', annotations: [{...SVG_POINT, label: '牧场'}]})
    expect(props.onSave).not.toHaveBeenCalled()
    expect(button('保存画布').disabled).toBe(true)
    await click('返回轨迹')
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('还有未保存的修改')
  })
  it('locks all editor tabs and exit until the SVG save settles', async () => {
    await render()
    await click('SVG 标注')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-point-id="svg-point"]')!.click())
    await input('点位名称', '牧场')
    await click('完成编辑')
    const pending = deferred<{annotations: TrackAnnotation[]}>()
    vi.mocked(api).mockReturnValueOnce(pending.promise)
    await click('保存画布')
    for (const label of ['标注点编辑', 'SVG 标注', '线路编辑', '正在处理画布…']) expect(button(label).disabled).toBe(true)
    await tabKey('SVG 标注', 'End')
    expect(button('SVG 标注').getAttribute('aria-selected')).toBe('true')
    await click('正在处理画布…')
    expect(props.onCancel).not.toHaveBeenCalled()
    await act(async () => pending.resolve({annotations: [{...SVG_POINT, label: '牧场'}]}))
    for (const label of ['标注点编辑', 'SVG 标注', '线路编辑', '返回轨迹']) expect(button(label).disabled).toBe(false)
  })
  it('keeps the editor open and preserves the unsaved SVG when saving a line copy', async () => {
    await render()
    await click('SVG 标注')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-point-id="svg-point"]')!.click())
    await input('点位名称', '牧场')
    await click('完成编辑')
    const canvas = container.querySelector('.trk-art-overlay-canvas')
    await click('线路编辑')
    await mapAction(map => map.onMovePoint(1, 119.451, 30.351))
    await click('保存全部为 GPX 副本')
    expect(props.onSave).toHaveBeenCalledOnce()
    expect(vi.mocked(props.onSave).mock.calls[0][1]).toEqual({keepEditing: true})
    await click('SVG 标注')
    expect(container.querySelector('.trk-art-overlay-canvas')).toBe(canvas)
    expect(canvas?.textContent).toContain('牧场')
    expect(button('保存画布').disabled).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    await click('返回轨迹')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
  })
  it('protects a line draft when leaving from SVG annotation editing', async () => {
    await renderLine()
    await mapAction(map => map.onMovePoint(1, 119.451, 30.351))
    await click('SVG 标注')
    await click('返回轨迹')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
    await click('继续编辑')
    await click('线路编辑')
    expect(activePoints()[1]).toEqual([119.451, 30.351, null, null])
  })
  it('moves one original point without changing other tuple metadata or the imported record', async () => {
    const original = record()
    const before = JSON.stringify(original)
    await renderLine({initial: original})
    expect(field('当前轨迹名称').value).toBe('山区轨迹（编辑副本）')
    expect(activePoints()).toBe(original.coordinates)
    await mapAction(map => map.onMovePoint(1, 119.451, 30.351))
    const edited = activePoints()
    expect(edited[1]).toEqual([119.451, 30.351, null, null])
    expect(edited[0]).toBe(POINTS[0])
    expect(edited[2]).toBe(POINTS[2])
    expect(edited[3]).toBe(POINTS[3])
    await click('保存全部为 GPX 副本')
    expect(props.onSave).toHaveBeenCalledOnce()
    expect(vi.mocked(props.onSave).mock.calls[0]).toHaveLength(1)
    const [saved] = savedInputs()
    expect(saved.name).toBe('山区轨迹（编辑副本）')
    expect(saved.filename).toMatch(/编辑副本.*\.gpx$/u)
    expect(saved.filename).not.toBe(original.filename)
    expect(saved).not.toHaveProperty('id')
    expect(saved.points).toEqual(edited)
    expect(saved.source).toContain('<gpx version="1.1"')
    expect(saved.source).toContain('<time>2026-09-20T01:00:00.000Z</time>')
    expect(JSON.stringify(original)).toBe(before)
    expect(container.textContent).toContain('原轨迹和原文件保留')
  })

  it('offers point indices, step navigation and coordinate editing without WebGL', async () => {
    await renderLine()
    await input('点序号', '2')
    expect(mapState.latest!.selectedIndices).toEqual([1])
    await click('后一个点')
    expect(mapState.latest!.selectedIndices).toEqual([2])
    await click('前一个点')
    expect(mapState.latest!.selectedIndices).toEqual([1])
    await input('经度', '119.455')
    await input('纬度', '30.355')
    await click('应用坐标')
    expect(activePoints()[1]).toEqual([119.455, 30.355, null, null])
    await input('纬度', '91')
    await click('应用坐标')
    expect(container.textContent).toContain('有效经纬度')
    expect(activePoints()[1]).toEqual([119.455, 30.355, null, null])
  })

  it('splits at the selected index only after confirmation and saves both GPX copies', async () => {
    await renderLine()
    await click('拆分工具')
    await mapAction(map => map.onSelectPoint(1))
    expect(mapState.latest!.parts).toHaveLength(1)
    await click('在选中点拆分')
    expect(mapState.latest!.parts).toHaveLength(2)
    expect(mapState.latest!.parts.map(part => part.points.length)).toEqual([2, 3])
    expect(mapState.latest!.parts[0].name).toContain('第1段')
    expect(mapState.latest!.parts[1].name).toContain('第2段')
    await click('撤销')
    expect(mapState.latest!.parts).toHaveLength(1)
    expect(activePoints()).toBe(POINTS)
    await click('重做')
    expect(mapState.latest!.parts).toHaveLength(2)
    await click('保存全部为 GPX 副本')
    expect(savedInputs()).toHaveLength(2)
    expect(savedInputs().map(track => track.points.length)).toEqual([2, 3])
    expect(savedInputs()[0].points[1]).toEqual(POINTS[1])
    expect(savedInputs()[1].points[0]).toEqual(POINTS[1])
  })

  it('connects the two chosen endpoints while retaining their recorded metadata', async () => {
    await renderLine()
    await click('连接工具')
    await mapAction(map => map.onSelectPoint(3))
    await mapAction(map => map.onSelectPoint(0))
    expect(activePoints()).toHaveLength(4)
    expect(mapState.latest!.selectedIndices).toEqual([0, 3])
    await click('直线连接两点')
    expect(activePoints()).toEqual([POINTS[0], POINTS[3]])
    expect(activePoints()[0]).toBe(POINTS[0])
    await click('撤销')
    expect(activePoints()).toBe(POINTS)
    await click('重做')
    expect(activePoints()).toHaveLength(2)
  })

  it('loads a library draft, reorders it and merges in the visible list order', async () => {
    const library = record('library', '库中轨迹', [[120, 31, 200, TIME], [120.1, 31.1, 300, TIME + 60000]])
    await renderLine({availableTracks: [library]})
    await chooseLibrary('library')
    await click('添加为新段')
    expect(props.loadTrack).toHaveBeenCalledWith('library')
    expect(mapState.latest!.parts).toHaveLength(2)
    const up = container.querySelector<HTMLButtonElement>('button[aria-label="上移第 2 段"]')!
    await act(async () => up.click())
    expect(mapState.latest!.parts[0].name).toContain('库中轨迹')
    await click('按列表顺序合并全部')
    expect(mapState.latest!.parts).toHaveLength(1)
    expect(activePoints()).toEqual([...library.coordinates, ...POINTS])
    await click('保存全部为 GPX 副本')
    expect(savedInputs()).toHaveLength(1)
    expect(savedInputs()[0].points).toEqual([...library.coordinates, ...POINTS])
  })

  it('creates new null-metadata points and records one undo step for an entire freehand stroke', async () => {
    await renderLine({initial: null})
    expect(mapState.latest!.tool).toBe('draw')
    await click('保存全部为 GPX 副本')
    expect(props.onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('至少需要 2 个点')
    await mapAction(map => map.onAddPoint(119.44, 30.34))
    await mapAction(map => map.onAddPoint(119.45, 30.35))
    await click('手绘补线')
    await mapAction(map => map.onFreehand([[119.46, 30.36], [119.47, 30.37], [119.48, 30.38]]))
    expect(activePoints()).toHaveLength(5)
    expect(activePoints().every(point => point[2] === null && point[3] === null)).toBe(true)
    await click('撤销')
    expect(activePoints()).toHaveLength(2)
    await click('重做')
    expect(activePoints()).toHaveLength(5)
    await click('保存全部为 GPX 副本')
    expect(savedInputs()[0].points).toHaveLength(5)
    expect(savedInputs()[0].source).not.toContain('<ele>')
    expect(savedInputs()[0].source).not.toContain('<time>')
  })

  it('can hand-draw a replacement between two selected recorded points', async () => {
    await renderLine()
    await click('连接工具')
    await mapAction(map => map.onSelectPoint(0))
    await mapAction(map => map.onSelectPoint(3))
    await click('手绘补线')
    await mapAction(map => map.onFreehand([[119.445, 30.345], [119.465, 30.365]]))
    expect(activePoints()).toEqual([POINTS[0], [119.445, 30.345, null, null], [119.465, 30.365, null, null], POINTS[3]])
    await click('撤销')
    expect(activePoints()).toBe(POINTS)
  })

  it('supports insertion, deletion and reversing with reversible edits', async () => {
    await renderLine()
    await mapAction(map => map.onInsertPoint(2, 119.455, 30.355))
    expect(activePoints()[2]).toEqual([119.455, 30.355, null, null])
    expect(activePoints()[3]).toBe(POINTS[2])
    await click('删除选中点')
    expect(activePoints()).toEqual(POINTS)
    await click('反转当前段')
    expect(activePoints()).toEqual([...POINTS].reverse())
    await click('撤销')
    expect(activePoints()).toEqual(POINTS)
  })

  it('retains every split draft on atomic save failure and permits a complete retry', async () => {
    const onSave = vi.fn<TrackEditorProps['onSave']>().mockRejectedValueOnce(new Error('事务未提交')).mockResolvedValueOnce()
    await renderLine({onSave})
    await mapAction(map => map.onSelectPoint(2))
    await click('在选中点拆分')
    await input('当前轨迹名称', '修订山路')
    await click('保存全部为 GPX 副本')
    expect(container.textContent).toContain('保存失败，草稿已保留：事务未提交')
    const beforeRetry = mapState.latest!.parts
    expect(beforeRetry).toHaveLength(2)
    expect(beforeRetry[0].name).toBe('修订山路')
    expect(onSave.mock.calls[0][0]).toHaveLength(2)
    await click('保存全部为 GPX 副本')
    expect(onSave.mock.calls[1][0]).toEqual(onSave.mock.calls[0][0])
    expect(mapState.latest!.parts).toBe(beforeRetry)
    expect(container.textContent).not.toContain('保存失败')
  })

  it('locks all map edits and cancellation while an atomic save is pending', async () => {
    const pending = deferred<void>()
    const onSave = vi.fn(async () => pending.promise)
    await renderLine({onSave})
    await mapAction(map => map.onMovePoint(1, 119.451, 30.351))
    const draft = activePoints()
    await click('保存全部为 GPX 副本')
    expect(button('正在保存…').disabled).toBe(true)
    expect(button('取消编辑').disabled).toBe(true)
    expect(mapState.latest!.disabled).toBe(true)
    expect(button('标注点编辑').disabled).toBe(true)
    expect(button('SVG 标注').disabled).toBe(true)
    expect(button('线路编辑').disabled).toBe(true)
    await tabKey('线路编辑','Home')
    expect(button('线路编辑').getAttribute('aria-selected')).toBe('true')
    await click('取消编辑')
    await mapAction(map => map.onMovePoint(0, 120, 31))
    expect(activePoints()).toBe(draft)
    expect(props.onCancel).not.toHaveBeenCalled()
    await act(async () => pending.resolve())
    expect(button('保存全部为 GPX 副本').disabled).toBe(false)
    expect(mapState.latest!.disabled).toBe(false)
  })

  it('asks inline before discarding changed drafts and can continue editing', async () => {
    await renderLine()
    await mapAction(map => map.onMovePoint(0, 119.441, 30.341))
    await click('取消编辑')
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(container.textContent).toContain('还有未保存的修改')
    await click('继续编辑')
    expect(container.textContent).not.toContain('还有未保存的修改')
    expect(activePoints()[0]).toEqual([119.441, 30.341, null, null])
    await click('取消编辑')
    await click('放弃修改')
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('closes an unchanged draft directly without an extra confirmation', async () => {
    await renderLine()
    await click('取消编辑')
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('还有未保存的修改')
  })

  it('rejects an oversized GPX source before invoking the save protocol', async () => {
    await renderLine()
    vi.spyOn(gpxExport, 'editedTrackInput').mockReturnValue({
      name: '大轨迹', filename: '大轨迹.gpx', source: 'x'.repeat(UPLOADS.maxSourceBytes + 1),
      points: POINTS, metrics: editedMetrics(POINTS),
    })
    await click('保存全部为 GPX 副本')
    expect(props.onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('文件过大')
    expect(activePoints()).toBe(POINTS)
  })

  it('rejects an oversized atomic batch while preserving all its draft parts', async () => {
    await renderLine()
    await mapAction(map => map.onSelectPoint(1))
    await click('在选中点拆分')
    vi.spyOn(gpxExport, 'editedTrackInput').mockImplementation((points, {name}) => ({
      name, filename: name + '.gpx', source: 'x'.repeat(UPLOADS.maxSourceBytes - 100),
      points: points.map(point => [point[0], point[1], null, null]), metrics: editedMetrics(points),
      // Extra repeated metadata simulates the full serialized request budget,
      // independently of the per-file source limit.
      padding: 'x'.repeat(5 * 1024 * 1024),
    } as TrackInput))
    await click('保存全部为 GPX 副本')
    expect(props.onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('超过 24 MB')
    expect(mapState.latest!.parts).toHaveLength(2)
  })

  it('retains at most 50 undo gestures', async () => {
    await renderLine()
    for (let index = 1; index <= 53; index++) await mapAction(map => map.onMovePoint(0, 119.44 + index * 0.0001, 30.34))
    for (let index = 0; index < 50; index++) await click('撤销')
    expect(button('撤销').disabled).toBe(true)
    expect(activePoints()[0][0]).toBeCloseTo(119.4403)
    await click('重做')
    expect(activePoints()[0][0]).toBeCloseTo(119.4404)
  })

  it('caps retained point references on large tracks without discarding current metadata', async () => {
    const large = Array<TrackPoint>(500_000).fill([119.44, 30.34, 200, null])
    await renderLine({initial: record('large', '大轨迹', large)})
    for (let index = 1; index <= 4; index++) await mapAction(map => map.onMovePoint(0, 119.44 + index * 0.0001, 30.34))
    for (let index = 0; index < 3; index++) await click('撤销')
    expect(button('撤销').disabled).toBe(true)
    expect(activePoints()[0][0]).toBeCloseTo(119.4401)
    expect(activePoints()[1]).toBe(large[1])
    const draft = activePoints()
    await mapAction(map => map.onAddPoint(119.45, 30.35))
    expect(activePoints()).toBe(draft)
    expect(container.textContent).toContain('500,000')
  })
})


describe('route-associated SVG artwork and transforms across editor tabs',()=>{
 it('retains separate route and overlay elements, a route draft and its history across tabs until the canvas is saved',async()=>{
  await render();await click('SVG 标注');const route=container.querySelector<HTMLElement>('.trk-svg-canvas')!,overlay=container.querySelector('.trk-art-overlay-canvas')!,fixed=['title','north'].map(id=>overlay.querySelector(`[data-art-text-id="${id}"]`)!.outerHTML)
  expect(route).not.toBe(overlay);expect(route.querySelector('[data-art-text-id],[data-annotation-id]')).toBeNull()
  await act(async()=>{const select=container.querySelector<HTMLSelectElement>('[aria-label="轨迹缩放"]')!;select.value='150';select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(Number(route.dataset.viewScale)).toBe(1.5);expect(['title','north'].map(id=>overlay.querySelector(`[data-art-text-id="${id}"]`)!.outerHTML)).toEqual(fixed);expect(overlay.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(0 0) scale(1.5)');expect(button('保存画布').disabled).toBe(false)
  await click('标注点编辑');await click('返回轨迹');expect(props.onCancel).not.toHaveBeenCalled();expect(container.textContent).toContain('还有未保存的修改');await click('继续编辑');await click('线路编辑');await click('SVG 标注')
  expect(container.querySelector('.trk-svg-canvas')).toBe(route);expect(container.querySelector('.trk-art-overlay-canvas')).toBe(overlay);expect(Number(route.dataset.viewScale)).toBe(1.5);expect(['title','north'].map(id=>overlay.querySelector(`[data-art-text-id="${id}"]`)!.outerHTML)).toEqual(fixed);expect(overlay.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(0 0) scale(1.5)');expect(api).toHaveBeenCalledTimes(1)
  await click('撤销');expect(Number(route.dataset.viewScale)).toBe(1);expect(button('保存画布').disabled).toBe(true);await click('重做');expect(Number(route.dataset.viewScale)).toBe(1.5)
  vi.mocked(api).mockImplementation(async(_action,data)=>data as never);await click('保存画布');expect(api).toHaveBeenLastCalledWith('annotations',{canvas:{width:1200,height:900},id:'original',annotations:[SVG_POINT],route:{x:0,y:0,scale:1.5}});expect(props.onSave).not.toHaveBeenCalled()
  await click('返回轨迹');expect(props.onCancel).toHaveBeenCalledOnce()
 })
})
