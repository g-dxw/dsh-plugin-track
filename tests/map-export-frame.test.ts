import {afterEach, describe, expect, it, vi} from 'vitest'
import type {Map as MapLibreMap} from 'maplibre-gl'
import {waitForMapCaptureFrame} from '../src/client/map-export-frame.ts'

function fakeMap() {
  const handlers = new Set<() => void>()
  const state = {style: true, tiles: true, moving: false}
  const map = {on: vi.fn((_event: string, callback: () => void) => handlers.add(callback)), off: vi.fn((_event: string, callback: () => void) => handlers.delete(callback)),
    isStyleLoaded: () => state.style, areTilesLoaded: () => state.tiles, isMoving: () => state.moving, triggerRepaint: vi.fn()}
  return {map: map as unknown as MapLibreMap, state, handlers, emit: () => [...handlers].forEach(callback => callback()), repaint: map.triggerRepaint}
}
afterEach(() => vi.useRealTimers())
describe('current map capture frame', () => {
  it('requests a new frame and waits for its style, tiles and camera to settle', async () => {
    const fake = fakeMap(), controller = new AbortController()
    fake.state.tiles = false
    let done = false
    const promise = waitForMapCaptureFrame(fake.map, controller.signal).then(() => {done = true})
    expect(fake.repaint).toHaveBeenCalledOnce()
    fake.emit(); await Promise.resolve(); expect(done).toBe(false)
    fake.state.tiles = true; fake.state.moving = true
    fake.emit(); await Promise.resolve(); expect(done).toBe(false)
    fake.state.moving = false; fake.state.style = false
    fake.emit(); await Promise.resolve(); expect(done).toBe(false)
    fake.state.style = true; fake.emit(); await promise
    expect(done).toBe(true); expect(fake.handlers.size).toBe(0)
  })
  it('cancels on view change and removes its listener', async () => {
    const fake = fakeMap(), controller = new AbortController()
    const promise = waitForMapCaptureFrame(fake.map, controller.signal)
    controller.abort(new Error('视图已变化'))
    await expect(promise).rejects.toThrow('视图已变化')
    expect(fake.handlers.size).toBe(0)
  })
  it('does not subscribe or repaint when already canceled', async () => {
    const fake = fakeMap(), controller = new AbortController()
    controller.abort(new Error('导出已取消'))
    await expect(waitForMapCaptureFrame(fake.map, controller.signal)).rejects.toThrow('导出已取消')
    expect(fake.handlers.size).toBe(0); expect(fake.repaint).not.toHaveBeenCalled()
  })
  it('bounds network waits and releases listeners on timeout', async () => {
    vi.useFakeTimers()
    const fake = fakeMap(), controller = new AbortController()
    const promise = expect(waitForMapCaptureFrame(fake.map, controller.signal, 100)).rejects.toThrow('地图仍在加载')
    await vi.advanceTimersByTimeAsync(100); await promise
    expect(fake.handlers.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans up after repaint fails', async () => {
    const fake = fakeMap()
    fake.repaint.mockImplementation(() => {throw new Error('context lost')})
    await expect(waitForMapCaptureFrame(fake.map, new AbortController().signal)).rejects.toThrow('地图暂时无法读取')
    expect(fake.handlers.size).toBe(0)
  })
})
