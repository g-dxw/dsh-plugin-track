import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSandboxFrameAdapter, FrameRenderCoordinator } from '../src/track/frame-renderer.ts'

afterEach(() => vi.useRealTimers())

describe('frame render request lifecycle', () => {
  it('ignores stale revisions and acknowledges only the requested one', async () => {
    const queue = new FrameRenderCoordinator()
    const first = queue.request()
    const previous = first.promise.catch(reason => reason)
    const second = queue.request()
    expect((await previous).name).toBe('AbortError')
    let complete = false
    const finished = second.promise.then(() => {complete = true})
    queue.rendered(first.revision); await Promise.resolve()
    expect(complete).toBe(false)
    queue.rendered(second.revision); await finished
    expect(complete).toBe(true)
  })

  it('rejects an already aborted signal and does not retain its timer', async () => {
    vi.useFakeTimers()
    const queue = new FrameRenderCoordinator()
    const signal = AbortSignal.abort()
    await expect(queue.request(signal).promise).rejects.toHaveProperty('name', 'AbortError')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes abort handlers and timers after successful completion', async () => {
    vi.useFakeTimers()
    const queue = new FrameRenderCoordinator()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const request = queue.request(controller.signal)
    queue.rendered(request.revision)
    await request.promise
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledOnce()
    controller.abort()
    const next = queue.request(); queue.rendered(next.revision)
    await expect(next.promise).resolves.toBeUndefined()
  })

  it('rejects on cancellation or timeout and frees the pending resources', async () => {
    vi.useFakeTimers()
    const queue = new FrameRenderCoordinator()
    const first = queue.request()
    const cancelled = first.promise.catch(reason => reason)
    queue.cancel(new Error('Renderer disposed'))
    expect((await cancelled).message).toBe('Renderer disposed'); expect(vi.getTimerCount()).toBe(0)
    const second = queue.request(undefined, 50)
    const timedOut = second.promise.catch(reason => reason)
    await vi.advanceTimersByTimeAsync(50)
    expect((await timedOut).message).toContain('did not finish rendering')
    expect(vi.getTimerCount()).toBe(0)
  })
})
function sandboxFixture(applyFrame = vi.fn(async () => {})) {
  const canvas = {width: 640, height: 480} as HTMLCanvasElement
  const composed = {width: 640, height: 480} as HTMLCanvasElement
  let available: HTMLCanvasElement | null = canvas
  const source = {getCaptureCanvas: () => available, renderFrame: vi.fn()}
  const composeFrame = vi.fn(() => composed)
  const credit = {label: 'Actual DEM', url: 'https://example.com/dem'}
  const adapter = createSandboxFrameAdapter(source, {applyFrame, composeFrame, getCredits: () => [credit]})
  return {adapter, source, applyFrame, composeFrame, canvas, composed, credit, disposeSource: () => {available = null}}
}

describe('prepared sandbox frame adapter', () => {
  it('applies timeline state, renders synchronously and composes credits before exposing capture output', async () => {
    const fixture = sandboxFixture()
    expect(fixture.adapter.getCaptureCanvas()).toBeNull()
    const frame = {progress: 0.5, elapsedMs: 15_000, shot: {type: 'overview' as const, duration: 3}}
    await fixture.adapter.renderFrame(frame)
    expect(fixture.applyFrame).toHaveBeenCalledWith(frame, expect.any(AbortSignal))
    expect(fixture.source.renderFrame).toHaveBeenCalledOnce()
    expect(fixture.composeFrame).toHaveBeenCalledWith(fixture.canvas, frame, [fixture.credit], expect.any(AbortSignal))
    expect(fixture.adapter.getCaptureCanvas()).toBe(fixture.composed)
    expect(fixture.adapter.getCredits?.()).toEqual([fixture.credit])
    expect(fixture.applyFrame.mock.invocationCallOrder[0]).toBeLessThan(fixture.source.renderFrame.mock.invocationCallOrder[0])
    expect(fixture.source.renderFrame.mock.invocationCallOrder[0]).toBeLessThan(fixture.composeFrame.mock.invocationCallOrder[0])
    fixture.adapter.dispose(); expect(fixture.adapter.getCaptureCanvas()).toBeNull()
  })

  it('rejects a cancelled asynchronous frame and prevents it from drawing over a newer one', async () => {
    let release!: () => void
    let first = true
    const fixture = sandboxFixture(vi.fn(async () => {if (first) {first = false; await new Promise<void>(resolve => {release = resolve})}}))
    const old = fixture.adapter.renderFrame({progress: 0.25, elapsedMs: 7500}).catch(reason => reason)
    await fixture.adapter.renderFrame({progress: 0.75, elapsedMs: 22_500})
    expect((await old).name).toBe('AbortError')
    release(); await Promise.resolve(); await Promise.resolve()
    expect(fixture.source.renderFrame).toHaveBeenCalledOnce()
    expect(fixture.adapter.getCaptureCanvas()).toBe(fixture.composed)
    fixture.adapter.dispose()
  })

  it('supports abort, bounded hook waiting and disposal without introducing a video encoder', async () => {
    vi.useFakeTimers()
    const fixture = sandboxFixture(vi.fn(() => new Promise<void>(() => {})))
    const controller = new AbortController()
    const abort = fixture.adapter.renderFrame({progress: 0, elapsedMs: 0}, controller.signal).catch(reason => reason)
    controller.abort(); expect((await abort).name).toBe('AbortError')
    const timeout = fixture.adapter.renderFrame({progress: 0.2, elapsedMs: 6000}).catch(reason => reason)
    await vi.advanceTimersByTimeAsync(10_001)
    expect((await timeout).message).toContain('did not finish rendering')
    const disposed = fixture.adapter.renderFrame({progress: 0.3, elapsedMs: 9000}).catch(reason => reason)
    fixture.adapter.dispose()
    expect((await disposed).name).toBe('AbortError'); expect(vi.getTimerCount()).toBe(0)
    await expect(fixture.adapter.renderFrame({progress: 1, elapsedMs: 30_000})).rejects.toHaveProperty('name', 'AbortError')
    expect(fixture.source.renderFrame).not.toHaveBeenCalled()
  })

  it('rejects when the underlying renderer disappears and propagates compositor errors', async () => {
    const fixture = sandboxFixture()
    fixture.composeFrame.mockImplementation(() => {throw new Error('Credits could not be composed')})
    await expect(fixture.adapter.renderFrame({progress: 0.5, elapsedMs: 15_000})).rejects.toThrow('Credits could not be composed')
    expect(fixture.adapter.getCaptureCanvas()).toBeNull()
    fixture.disposeSource()
    await expect(fixture.adapter.renderFrame({progress: 0, elapsedMs: 0})).rejects.toHaveProperty('name', 'AbortError')
    fixture.adapter.dispose()
  })
})