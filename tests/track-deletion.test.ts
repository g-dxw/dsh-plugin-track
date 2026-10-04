// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackPanel } from '../src/client/TrackPanel.tsx'
import { useTracks, type TracksState } from '../src/client/useTracks.ts'
import { api } from '../src/client/util.ts'
import { editedMetrics } from '../src/track/edit.ts'
import type { TrackRecord } from '../src/protocol.ts'

vi.mock('../src/client/util.ts', async original => ({...await original<typeof import('../src/client/util.ts')>(), api: vi.fn()}))
vi.mock('../src/client/TrackOverview.tsx', () => ({TrackOverview: () => null}))
vi.mock('../src/client/TrackEditor.tsx', () => ({TrackEditor: () => null}))
vi.mock('../src/client/TrackArt.tsx', () => ({TrackArt: () => null}))
vi.mock('../src/client/AnimationStudio.tsx', () => ({AnimationStudio: () => null}))
vi.mock('../src/client/ElevationChart.tsx', () => ({ElevationChart: () => null}))

const coordinates: TrackRecord['coordinates'] = [[120,30,null,null],[120.01,30,null,null]]
const tracks: TrackRecord[] = ['峨眉山', '武功山反穿'].map((name, index) => ({
  id: `track-${index}`, name, filename: `${name}.kml`, format: 'kml', createdAt: '2026-10-01',
  coordinates, bytes: 100, points: coordinates.length, metrics: editedMetrics(coordinates),
}))
let node: HTMLDivElement, root: Root, state: TracksState
function Hook() { state = useTracks(); return null }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no})
  return {promise, resolve, reject}
}
function deletes() { return vi.mocked(api).mock.calls.filter(call => call[2] === 'DELETE') }
function button(text: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function rowDelete(name = '峨眉山') { return node.querySelector<HTMLButtonElement>(`button[aria-label="删除轨迹：${name}"]`)! }
async function click(element: HTMLElement) { await act(async () => element.click()) }
async function render(hook = false) { await act(async () => root.render(createElement(hook ? Hook : TrackPanel))) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks(); localStorage.clear()
  vi.mocked(api).mockImplementation(async (action, _data, method) => {
    if (method === 'DELETE') return {ok: true} as never
    if (action === 'tracks') return tracks as never
    return tracks.find(track => action.endsWith(`id=${track.id}`)) as never
  })
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); localStorage.clear() })

describe('deleting from the list and detail', () => {
  it('opens a named confirmation without opening the track or deleting it; cancel restores focus', async () => {
    await render()
    const remove = rowDelete(); remove.focus(); await click(remove)
    const dialog = node.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('峨眉山')
    expect(dialog.textContent).toContain('电脑上的原始文件')
    expect(document.activeElement).toBe(button('取消'))
    expect(vi.mocked(api).mock.calls.some(call => call[0].startsWith('track?'))).toBe(false)
    expect(deletes()).toHaveLength(0)
    await click(button('取消'))
    expect(node.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(remove)
    expect(rowDelete()).not.toBeNull()
    expect(deletes()).toHaveLength(0)
  })

  it('contains keyboard focus and supports Escape without deleting', async () => {
    await render(); rowDelete().focus(); await click(rowDelete())
    const dialog = node.querySelector<HTMLElement>('[role="alertdialog"]')!
    await act(async () => button('取消').dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true, bubbles: true, cancelable: true})))
    expect(document.activeElement).toBe(button('确认删除'))
    await act(async () => button('确认删除').dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true})))
    expect(document.activeElement).toBe(button('取消'))
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    expect(node.querySelector('[role="alertdialog"]')).toBeNull()
    expect(deletes()).toHaveLength(0)
  })

  it('removes only the confirmed track and its script caches and reports success', async () => {
    await render()
    localStorage.setItem('cqai-track.animation-script.track-0', 'script-a')
    localStorage.setItem('cqai-track.animation-script.track-1', 'script-b')
    localStorage.setItem('cqai-track.video-script.track-0', 'video-a')
    localStorage.setItem('cqai-track.video-script.track-1', 'video-b')
    await click(rowDelete()); await click(button('确认删除'))
    expect(deletes()).toEqual([['track?id=track-0', {}, 'DELETE']])
    expect(rowDelete()).toBeNull(); expect(rowDelete('武功山反穿')).not.toBeNull()
    expect(node.querySelector('[role="alertdialog"]')).toBeNull()
    expect(node.textContent).toContain('轨迹已删除')
    expect(localStorage.getItem('cqai-track.animation-script.track-0')).toBeNull()
    expect(localStorage.getItem('cqai-track.animation-script.track-1')).toBe('script-b')
    expect(localStorage.getItem('cqai-track.video-script.track-0')).toBeNull()
    expect(localStorage.getItem('cqai-track.video-script.track-1')).toBe('video-b')
    expect(document.activeElement).toBe(node.querySelector('h1'))
  })

  it('retains the track and cache on failure and allows retry', async () => {
    await render(); localStorage.setItem('cqai-track.animation-script.track-0', 'script')
    await click(rowDelete()); vi.mocked(api).mockRejectedValueOnce(new Error('磁盘不可写'))
    await click(button('确认删除'))
    expect(node.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toBe('磁盘不可写')
    expect(rowDelete()).not.toBeNull()
    expect(localStorage.getItem('cqai-track.animation-script.track-0')).toBe('script')
    await click(button('确认删除'))
    expect(deletes()).toHaveLength(2)
    expect(rowDelete()).toBeNull()
    expect(node.querySelector('[role="alertdialog"]')).toBeNull()
    expect(node.textContent).not.toContain('磁盘不可写')
  })

  it('disables dialog actions while deleting and sends only one request', async () => {
    await render(); await click(rowDelete())
    const pending = deferred<unknown>()
    vi.mocked(api).mockImplementationOnce(() => pending.promise as never)
    await click(button('确认删除'))
    expect(button('正在删除…').disabled).toBe(true); expect(button('取消').disabled).toBe(true)
    expect(document.activeElement).toBe(node.querySelector('[role="alertdialog"]'))
    await click(button('正在删除…')); await click(button('取消'))
    expect(deletes()).toHaveLength(1)
    await act(async () => {pending.resolve({ok: true}); await pending.promise})
    expect(rowDelete()).toBeNull()
  })

  it('uses the same confirmation in detail and returns to the list after deletion', async () => {
    await render()
    await click(node.querySelector<HTMLButtonElement>('button[aria-label="打开轨迹：峨眉山"]')!)
    expect(node.querySelector('h2')?.textContent).toBe('峨眉山')
    await click(button('删除')); expect(node.querySelector('[role="alertdialog"]')).not.toBeNull()
    await click(button('确认删除'))
    expect(node.querySelector('.trk-detail')).toBeNull()
    expect(rowDelete('武功山反穿')).not.toBeNull()
  })
})

describe('delete request races', () => {
  it('deduplicates simultaneous DELETE calls', async () => {
    await render(true)
    const pending = deferred<unknown>(); vi.mocked(api).mockImplementationOnce(() => pending.promise as never)
    let first!: Promise<boolean>, second!: Promise<boolean>
    await act(async () => {first = state.remove('track-0'); second = state.remove('track-0')})
    expect(first).toBe(second); expect(deletes()).toHaveLength(1)
    await act(async () => {pending.resolve({ok: true}); expect(await first).toBe(true)})
    expect(state.list.map(track => track.id)).toEqual(['track-1'])
  })

  it('ignores delayed list and detail results for a successfully deleted track', async () => {
    await render(true)
    const list = deferred<unknown>(), detail = deferred<unknown>()
    vi.mocked(api).mockImplementation((action, _data, method) => {
      if (method === 'DELETE') return Promise.resolve({ok: true}) as never
      return (action === 'tracks' ? list.promise : detail.promise) as never
    })
    await act(async () => {state.refresh(); state.openTrack('track-0'); expect(await state.remove('track-0')).toBe(true)})
    await act(async () => {list.resolve(tracks); detail.resolve(tracks[0]); await Promise.all([list.promise, detail.promise])})
    expect(state.open).toBeNull(); expect(state.list.map(track => track.id)).toEqual(['track-1'])
  })

  it('does not cancel another track opening when deleting the first one', async () => {
    await render(true)
    const detail = deferred<unknown>()
    vi.mocked(api).mockImplementation((_action, _data, method) => (method === 'DELETE' ? Promise.resolve({ok: true}) : detail.promise) as never)
    await act(async () => {state.openTrack('track-1'); expect(await state.remove('track-0')).toBe(true)})
    await act(async () => {detail.resolve(tracks[1]); await detail.promise})
    expect(state.open?.id).toBe('track-1')
  })

  it('ignores stale detail errors after deleting that track', async () => {
    await render(true)
    const detail = deferred<unknown>()
    vi.mocked(api).mockImplementation((_action, _data, method) => (method === 'DELETE' ? Promise.resolve({ok: true}) : detail.promise) as never)
    await act(async () => {state.openTrack('track-0'); expect(await state.remove('track-0')).toBe(true)})
    await act(async () => {detail.reject(new Error('轨迹不存在')); await detail.promise.catch(() => {})})
    expect(state.error).toBe(''); expect(state.open).toBeNull()
  })

  it('does not revive a deleted legacy track when its delayed source finishes loading', async () => {
    const {calculationVersion: _version, ...metrics} = tracks[0].metrics
    const legacy: TrackRecord = {...tracks[0], metrics}
    vi.mocked(api).mockImplementation(async (action, _data, method) => {
      if (method === 'DELETE') return {ok: true} as never
      if (action === 'tracks') return [legacy, tracks[1]] as never
      return (action.endsWith(`id=${legacy.id}`) ? legacy : tracks[1]) as never
    })
    const source = deferred<Response>()
    const fetchSource = vi.fn(() => source.promise)
    vi.stubGlobal('fetch', fetchSource)
    await render(true)
    await act(async () => state.openTrack(legacy.id))
    expect(fetchSource).toHaveBeenCalledWith('/api/cqai-track/source?id=track-0')
    expect(state.open).toBeNull()
    await act(async () => {expect(await state.remove(legacy.id)).toBe(true)})
    await act(async () => {
      source.resolve(new Response('<kml><Document><Placemark><LineString><coordinates>120,30 120.01,30</coordinates></LineString></Placemark></Document></kml>'))
      await source.promise
    })
    expect(state.open).toBeNull()
    expect(state.list.map(track => track.id)).toEqual(['track-1'])
    expect(state.note).toBe('轨迹已删除。')
    expect(state.error).toBe('')
  })

  it('ignores delayed legacy hydration after opening another track or closing the detail', async () => {
    const {calculationVersion: _version, ...metrics} = tracks[0].metrics
    const legacy: TrackRecord = {...tracks[0], metrics}
    vi.mocked(api).mockImplementation(async action => {
      if (action === 'tracks') return [legacy, tracks[1]] as never
      return (action.endsWith(`id=${legacy.id}`) ? legacy : tracks[1]) as never
    })
    const fetchSource = vi.fn<() => Promise<Response>>()
    vi.stubGlobal('fetch', fetchSource)
    await render(true)
    for (const destination of ['another track', 'closed detail']) {
      const source = deferred<Response>()
      fetchSource.mockReturnValueOnce(source.promise)
      await act(async () => state.openTrack(legacy.id))
      expect(fetchSource).toHaveBeenLastCalledWith('/api/cqai-track/source?id=track-0')
      await act(async () => {
        if (destination === 'another track') state.openTrack('track-1')
        else state.closeTrack()
      })
      const expectedOpen = destination === 'another track' ? 'track-1' : undefined
      expect(state.open?.id).toBe(expectedOpen)
      await act(async () => {
        source.resolve(new Response('<kml><Document><Placemark><LineString><coordinates>120,30 120.01,30</coordinates></LineString></Placemark></Document></kml>'))
        await source.promise
      })
      expect(state.open?.id).toBe(expectedOpen)
      expect(state.list.find(track => track.id === legacy.id)?.metrics.calculationVersion).toBeUndefined()
      expect(state.error).toBe('')
    }
    expect(fetchSource).toHaveBeenCalledTimes(2)
  })
})
