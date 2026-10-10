// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {PlacemarkGroup, TrackPlacemark, TrackRecord} from '../src/protocol.ts'
import {useTrackPlacemarks} from '../src/client/useTrackPlacemarks.ts'
import {createPlacemarkHistory, type PlacemarkHistory} from '../src/client/placemark-history.ts'
import {preparePlacemarkPhotoCache} from '../src/client/placemark-photo-cache.ts'
import {api} from '../src/client/util.ts'
import {validatePlacemarkStateData, type PlacemarkState, type PlacemarkStateData} from '../src/track/placemark-state.ts'
vi.mock('../src/client/util.ts', () => ({api: vi.fn()}))
vi.mock('../src/client/placemark-photo-cache.ts', () => ({preparePlacemarkPhotoCache: vi.fn(async () => {})}))

const track = {id: 'draft-track', filename: 'route.kml', format: 'kml', segmentStarts: [0],
  coordinates: [[120, 30, 100, 100], [120.01, 30, 200, 200]], placemarks: [
    {id: 'start', name: '起点', description: '', images: ['https://example.com/photo.jpg'], coordinates: [120, 30], elevation: 100, time: 100},
    {id: 'photo', name: '照片点', description: '', images: [], coordinates: [120.005, 30], elevation: 150, time: 150},
    {id: 'end', name: '终点', description: '', images: [], coordinates: [120.01, 30], elevation: 200, time: 200},
  ]} as TrackRecord
const newId = 'local-00000000-0000-0000-0000-000000000001'
const group: PlacemarkGroup = {id: 'group-00000000-0000-0000-0000-000000000001', name: '照片组', description: '',
  memberIds: ['photo', 'end'], coordinates: [120.005, 30], cover: {pointId: 'photo', imageUrl: 'https://example.com/photo.jpg'}}
function document(data: Partial<PlacemarkStateData> = {}, revision = 7): PlacemarkState {
  return {version: 1, revision, added: [], deletedIds: [], edits: [], order: null, groups: [], routeContext: null, ...data}
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes}); return {promise, resolve}}
const states = new Map<string, PlacemarkState>()
let root: Root, node: HTMLDivElement, result: ReturnType<typeof useTrackPlacemarks>, history: PlacemarkHistory
function Hook({value, store}: {value: TrackRecord; store: PlacemarkHistory}) {result = useTrackPlacemarks(value, store, {deferSave: true}); return null}
async function render(value = track, store = history) {await act(async () => root.render(createElement(Hook, {value, store})))}
async function remount(value = track, store = history) {await act(async () => root.unmount()); root = createRoot(node); await render(value, store)}
const writes = () => vi.mocked(api).mock.calls.filter(call => call[1] !== undefined)
const point = (id: string) => result.points.find(item => item.id === id)!
const data = () => (writes().at(-1)![1] as {data: PlacemarkStateData}).data
const revision = () => (writes().at(-1)![1] as {revision: number}).revision
const created = (): TrackPlacemark => ({id: newId, name: '新增风景', description: '', images: [], coordinates: [0, 0],
  elevation: null, time: null, routePosition: {startIndex: 0, endIndex: 1, fraction: .25}})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); states.clear(); states.set(track.id, document())
  vi.mocked(api).mockImplementation(async (action, body) => {
    if (!action.startsWith('placemark-state')) throw new Error(`Unexpected endpoint: ${action}`)
    const request = body as {id: string; revision: number; data: PlacemarkStateData} | undefined
    const id = request?.id || new URL(`https://test/${action}`).searchParams.get('id')!
    let saved = states.get(id) || document()
    if (request) {
      if (request.revision !== saved.revision) throw Object.assign(new Error('版本冲突'), {status: 409})
      saved = document(validatePlacemarkStateData(request.data), saved.revision + 1); states.set(id, saved)
    }
    return {state: structuredClone(saved)} as never
  })
  history = createPlacemarkHistory(track.id); node = globalThis.document.createElement('div'); globalThis.document.body.append(node); root = createRoot(node)
})
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals()})

describe('explicit placemark draft saving', () => {
  it('stages every mutation and local undo/redo before one complete atomic save at the original revision', async () => {
    const original = structuredClone(track); await render(); expect(result.dirty).toBe(false)
    await act(async () => {
      expect(await result.updatePoint('start', {name: '新名称', description: '介绍', hidden: true, type: ['营地']})).toBe(true)
      expect(await result.movePhoto('start', 'photo', 'https://example.com/photo.jpg')).toBe(true)
      expect(await result.createPoint(created())).toBe(true)
      expect(await result.movePoint('photo', [120.0075, 30.002])).toBe(true)
      expect(await result.movePointTo(newId, {coordinates: [0, 0], elevation: null, time: null, timeSource: 'unknown', distance: 0, partIndex: 0, offset: 0, routePosition: {startIndex: 0, endIndex: 1, fraction: .4}})).toBe(true)
      expect(await result.saveGroups([group])).toBe(true)
      expect(await result.moveGroup(group.id, [120.008, 30.001])).toBe(true)
      expect(await result.saveOrder([newId, 'end', 'photo', 'start'])).toBe(true)
      expect(await result.deletePoints(['end'])).toBe(true)
      expect(await result.undo()).toBe(true); expect(await result.redo()).toBe(true)
    })
    expect(writes()).toHaveLength(0); expect(preparePlacemarkPhotoCache).not.toHaveBeenCalled(); expect(track).toEqual(original)
    expect(result.dirty).toBe(true); expect(result.groups[0].memberIds).toEqual(['photo']); expect(result.saving).toBe(false)
    const step = history.peek('undo'); await act(async () => expect(await result.saveDraft()).toBe(true))
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe('placemark-state'); expect(revision()).toBe(7)
    expect(data()).toMatchObject({deletedIds: ['end'], order: [newId, 'photo', 'start'], added: [{id: newId, coordinates: [120.0025, 30]}]})
    expect(data().edits.find(edit => edit.id === newId)).toMatchObject({coordinates: [120.004, 30]})
    expect(data().edits.find(edit => edit.id === 'start')).toMatchObject({name: '新名称', hidden: true, images: []})
    expect(data().edits.find(edit => edit.id === 'photo')).toMatchObject({images: ['https://example.com/photo.jpg']})
    expect(data().routeContext).toEqual({segmentStarts: [0], references: original.placemarks})
    expect(result.dirty).toBe(false); expect(history.peek('undo')).toBe(step)
  })
  it('makes undo/redo local after saving and uses the newly accepted revision for the next explicit save', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '保存的名称'})).toBe(true))
    const step = history.peek('undo'); await act(async () => expect(await result.saveDraft()).toBe(true))
    expect(history.peek('undo')).toBe(step); expect(states.get(track.id)!.revision).toBe(8)
    await act(async () => expect(await result.undo()).toBe(true)); expect(point('start').name).toBe('起点'); expect(result.dirty).toBe(true); expect(writes()).toHaveLength(1)
    await act(async () => expect(await result.redo()).toBe(true)); expect(result.dirty).toBe(false); expect(writes()).toHaveLength(1)
    await act(async () => expect(await result.undo()).toBe(true)); await act(async () => expect(await result.saveDraft()).toBe(true))
    expect(writes()).toHaveLength(2); expect(revision()).toBe(8); expect(states.get(track.id)!.revision).toBe(9); expect(result.dirty).toBe(false)
  })
  it('skips a clean save after undoing to baseline and retains redo after a no-op', async () => {
    await render(); await act(async () => {
      expect(await result.updatePoint('start', {name: '草稿'})).toBe(true); expect(await result.undo()).toBe(true)
      expect(await result.updatePoint('start', {name: '起点'})).toBe(true)
    })
    expect(result.dirty).toBe(false); expect(result.canRedo).toBe(true)
    await act(async () => expect(await result.saveDraft()).toBe(true)); expect(writes()).toHaveLength(0)
  })
  it('discards or abandons unsaved edits without changing persisted state', async () => {
    const before = structuredClone(states.get(track.id)); await render()
    await act(async () => expect(await result.deletePoints(['start'])).toBe(true)); expect(result.dirty).toBe(true)
    await act(async () => result.discardDraft()); expect(result.dirty).toBe(false); expect(point('start').name).toBe('起点'); expect(result.canUndo).toBe(false)
    await act(async () => expect(await result.updatePoint('photo', {name: '离开即放弃'})).toBe(true)); await remount()
    expect(point('photo').name).toBe('照片点'); expect(result.dirty).toBe(false); expect(result.canUndo).toBe(false)
    expect(writes()).toHaveLength(0); expect(states.get(track.id)).toEqual(before)
  })
  it('retains draft and history after failure and retries only with its original baseline revision', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '本地草稿'})).toBe(true))
    const step = history.peek('undo'); vi.mocked(api).mockRejectedValueOnce(new Error('磁盘不可写'))
    await act(async () => expect(await result.saveDraft()).toBe(false))
    expect(point('start').name).toBe('本地草稿'); expect(result.dirty).toBe(true); expect(result.stateError).toContain('磁盘不可写'); expect(history.peek('undo')).toBe(step)
    await act(async () => expect(await result.saveDraft()).toBe(true)); expect(writes()).toHaveLength(2); expect(revision()).toBe(7)
  })
  it.each(['外部名称', '本地草稿'])('keeps revision and local history after a 409 even when the remote name is %s', async remoteName => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '本地草稿'})).toBe(true))
    const step = history.peek('undo'); states.set(track.id, document({edits: [{id: 'start', name: remoteName}]}, 8))
    await act(async () => expect(await result.saveDraft()).toBe(false))
    expect(point('start').name).toBe('本地草稿'); expect(result.dirty).toBe(true); expect(result.stateError).toContain('其他操作更新'); expect(history.peek('undo')).toBe(step)
    await act(async () => expect(await result.saveDraft()).toBe(false))
    expect(revision()).toBe(7); expect(writes()).toHaveLength(2); expect(states.get(track.id)!.revision).toBe(8)
  })
  it('deduplicates repeated explicit saves and locks mutations while the transaction is pending', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '草稿'})).toBe(true))
    const pending = deferred<{state: PlacemarkState}>(); vi.mocked(api).mockReturnValueOnce(pending.promise as never)
    let first!: Promise<boolean>, second!: Promise<boolean>
    await act(async () => {
      first = result.saveDraft(); second = result.saveDraft(); expect(second).toBe(first)
      expect(await result.updatePoint('photo', {name: '不能重叠'})).toBe(false); expect(await result.undo()).toBe(false); result.discardDraft()
    })
    expect(writes()).toHaveLength(1); expect(result.saving).toBe(true); expect(result.dirty).toBe(true)
    await act(async () => {states.set(track.id, document(data(), 8)); pending.resolve({state: states.get(track.id)!}); expect(await first).toBe(true); expect(await second).toBe(true)})
    expect(result.dirty).toBe(false); expect(result.saving).toBe(false); expect(point('photo').name).toBe('照片点')
  })
  it('preserves dirty state across retry and same-id props updates instead of silently rebasing', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '不能丢失'})).toBe(true))
    states.set(track.id, document({edits: [{id: 'start', name: '其他窗口'}]}, 8)); const reads = vi.mocked(api).mock.calls.length
    await act(async () => result.retry()); await render({...track, placemarks: structuredClone(track.placemarks)})
    expect(vi.mocked(api).mock.calls).toHaveLength(reads); expect(point('start').name).toBe('不能丢失'); expect(result.dirty).toBe(true)
    await act(async () => expect(await result.updatePoint('photo', {name: '继续编辑'})).toBe(true))
    await act(async () => expect(await result.saveDraft()).toBe(false)); expect(revision()).toBe(7); expect(point('photo').name).toBe('继续编辑')
  })
  it('resumes only read-only route recovery when dirty props refresh interrupts the original source read', async () => {
    const first = deferred<Response>(), second = deferred<Response>(), source = '<gpx><trk><trkseg><trkpt lat="30" lon="120"/><trkpt lat="30" lon="120.01"/></trkseg></trk></gpx>'
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise))
    const value = {...track, format: 'gpx' as const, filename: 'route.gpx', segmentStarts: undefined}; await render(value)
    expect(result.routeReady).toBe(false); await act(async () => expect(await result.updatePoint('start', {name: '保留的草稿'})).toBe(true))
    await render({...value, placemarks: structuredClone(value.placemarks)}); expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => {first.resolve(new Response(source)); second.resolve(new Response(source))})
    expect(result.routeReady).toBe(true); expect(point('start').name).toBe('保留的草稿'); expect(result.dirty).toBe(true)
    await act(async () => expect(await result.movePoint('photo', [120.007, 30])).toBe(true)); expect(writes()).toHaveLength(0)
  })
  it('checks an interrupted save without adding another history step or POST', async () => {
    await render(); await act(async () => expect(await result.deletePoints(['end'])).toBe(true))
    const base = vi.mocked(api).getMockImplementation()!, step = history.peek('undo')
    vi.mocked(api).mockImplementationOnce(async (action, body) => {await base(action, body); throw new Error('响应中断')})
      .mockRejectedValueOnce(new Error('核对暂时断线'))
    await act(async () => expect(await result.saveDraft()).toBe(false))
    expect(result.dirty).toBe(true); expect(result.stateError).toContain('尚未确定'); expect(result.canUndo).toBe(false)
    await act(async () => expect(await result.saveDraft()).toBe(true))
    expect(writes()).toHaveLength(1); expect(result.dirty).toBe(false); expect(history.peek('undo')).toBe(step)
  })
  it('verifies an uncertain failure against the original baseline before another explicit POST', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '待保存'})).toBe(true))
    vi.mocked(api).mockRejectedValueOnce(new Error('连接断开')).mockRejectedValueOnce(new Error('核对失败'))
    await act(async () => expect(await result.saveDraft()).toBe(false))
    await act(async () => expect(await result.updatePoint('photo', {name: '尚未允许编辑'})).toBe(false))
    await act(async () => expect(await result.saveDraft()).toBe(true))
    expect(writes()).toHaveLength(2); expect(revision()).toBe(7); expect(point('start').name).toBe('待保存'); expect(result.dirty).toBe(false)
  })
  it('accepts the pending save after same-track props change without losing its local session', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '草稿'})).toBe(true))
    const pending = deferred<{state: PlacemarkState}>(); vi.mocked(api).mockReturnValueOnce(pending.promise as never); let saving!: Promise<boolean>
    await act(async () => {saving = result.saveDraft()}); await render({...track, placemarks: structuredClone(track.placemarks)})
    expect(result.dirty).toBe(true); expect(result.saving).toBe(true)
    await act(async () => {states.set(track.id, document(data(), 8)); pending.resolve({state: states.get(track.id)!}); expect(await saving).toBe(true)})
    expect(result.dirty).toBe(false); expect(point('start').name).toBe('草稿'); expect(result.saving).toBe(false); expect(writes()).toHaveLength(1)
  })
  it('keeps reopened readers waiting for an explicit save and verifies its outcome after unmount', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '已授权保存'})).toBe(true))
    const pending = deferred<{state: PlacemarkState}>(); vi.mocked(api).mockReturnValueOnce(pending.promise as never); let saving!: Promise<boolean>
    await act(async () => {saving = result.saveDraft()}); await remount(); expect(result.editReady).toBe(false)
    await act(async () => {states.set(track.id, document(data(), 8)); pending.resolve({state: states.get(track.id)!}); expect(await saving).toBe(false)})
    expect(result.editReady).toBe(true); expect(point('start').name).toBe('已授权保存'); expect(result.dirty).toBe(false); expect(result.canUndo).toBe(true); expect(writes()).toHaveLength(1)
  })
  it('does not publish a stale save into another track or its history', async () => {
    await render(); await act(async () => expect(await result.updatePoint('start', {name: '旧轨迹草稿'})).toBe(true))
    const pending = deferred<{state: PlacemarkState}>(); vi.mocked(api).mockReturnValueOnce(pending.promise as never); let saving!: Promise<boolean>
    await act(async () => {saving = result.saveDraft()}); const other = {...track, id: 'other-track'}; await render(other, createPlacemarkHistory(other.id))
    await act(async () => {states.set(track.id, document(data(), 8)); pending.resolve({state: states.get(track.id)!}); expect(await saving).toBe(false)})
    expect(point('start').name).toBe('起点'); expect(result.dirty).toBe(false); expect(result.canUndo).toBe(false); expect(result.saving).toBe(false)
  })
})
