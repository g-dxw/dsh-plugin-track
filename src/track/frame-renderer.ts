/** Shared by map playback and future canvas encoders; no recording library is required. */
import type { MapCredit } from './map-settings.ts'

export interface AnimationShot {
  type: 'overview' | 'follow' | 'checkpoint'
  duration: number
  pointIndex?: number
  narration?: string
}

export interface AnimationFrameState {
  progress: number
  elapsedMs: number
  shot?: AnimationShot
  shotIndex?: number
}

export interface TrackFrameRenderer {
  getCaptureCanvas(): HTMLCanvasElement | null
  /** Resolves after this frame's route sources and camera have actually been painted. */
  renderFrame(frame: AnimationFrameState, signal?: AbortSignal): Promise<void>
  getCredits?(): readonly MapCredit[]
}

export function frameAbortError(message = 'Frame rendering was cancelled'): DOMException {
  return new DOMException(message, 'AbortError')
}

/** A revision must match before it can acknowledge a frame; stale render events are ignored. */
export class FrameRenderCoordinator {
  private sequence = 0
  private pending: {revision: number; resolve: () => void; reject: (reason: unknown) => void; dispose: () => void} | null = null

  request(signal?: AbortSignal, timeoutMs = 10_000): {revision: number; promise: Promise<void>} {
    this.cancel(frameAbortError('A newer frame superseded this request'))
    const revision = ++this.sequence
    const promise = new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {reject(frameAbortError()); return}
      const abort = () => this.cancel(frameAbortError())
      const timer = setTimeout(() => this.cancel(new Error('The requested map frame did not finish rendering')), timeoutMs)
      const dispose = () => {clearTimeout(timer); signal?.removeEventListener('abort', abort)}
      this.pending = {revision, resolve, reject, dispose}
      signal?.addEventListener('abort', abort, {once: true})
    })
    return {revision, promise}
  }

  rendered(revision: number): void {
    const pending = this.pending
    if (!pending || pending.revision !== revision) return
    this.pending = null; pending.dispose(); pending.resolve()
  }

  cancel(reason: unknown = frameAbortError()): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null; pending.dispose(); pending.reject(reason)
  }
}
/** Structural interface implemented by SandboxRenderer; it does not encode video. */
export interface CanvasFrameSource {
  getCaptureCanvas(): HTMLCanvasElement | null
  renderFrame(): void
}
export interface SandboxFrameAdapterOptions {
  /** Apply elapsed time, route progress, shot camera and light before the synchronous draw. */
  applyFrame(frame: AnimationFrameState, signal: AbortSignal): void | Promise<void>
  /** Return a canvas with actual-source credits and any required provider logo burned in. */
  composeFrame(canvas: HTMLCanvasElement, frame: AnimationFrameState, credits: readonly MapCredit[], signal: AbortSignal): HTMLCanvasElement | Promise<HTMLCanvasElement>
  getCredits(): readonly MapCredit[]
  timeoutMs?: number
}

/** Internal preparation for a future Three.js recorder; no export UI or encoder is installed. */
export function createSandboxFrameAdapter(source: CanvasFrameSource, options: SandboxFrameAdapterOptions): TrackFrameRenderer & {dispose(): void} {
  const pending = new FrameRenderCoordinator()
  let disposed = false
  let sequence = 0
  let controller: AbortController | null = null
  let output: HTMLCanvasElement | null = null
  let paintedCredits: readonly MapCredit[] = []
  const adapter: TrackFrameRenderer & {dispose(): void} = {
    getCaptureCanvas: () => !disposed && source.getCaptureCanvas() ? output : null,
    getCredits: () => paintedCredits,
    renderFrame: (frame, signal) => {
      if (disposed || !source.getCaptureCanvas()) return Promise.reject(frameAbortError('The sandbox renderer was disposed'))
      if (signal?.aborted) return Promise.reject(frameAbortError())
      if (!Number.isFinite(frame.progress) || !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0) return Promise.reject(new RangeError('Invalid animation frame'))
      controller?.abort()
      const next = controller = new AbortController()
      const revision = ++sequence
      const abort = () => next.abort()
      signal?.addEventListener('abort', abort, {once: true})
      const request = pending.request(next.signal, options.timeoutMs)
      output = null
      const snapshot = {...frame, progress: Math.max(0, Math.min(1, frame.progress)), shot: frame.shot ? {...frame.shot} : undefined}
      const assertCurrent = () => {
        if (disposed || next.signal.aborted || revision !== sequence || !source.getCaptureCanvas()) throw frameAbortError('The sandbox frame was cancelled')
      }
      void (async () => {
        try {
          await options.applyFrame(snapshot, next.signal)
          assertCurrent()
          source.renderFrame()
          assertCurrent()
          const canvas = source.getCaptureCanvas()!
          const credits = options.getCredits().map(credit => ({...credit}))
          const composed = await options.composeFrame(canvas, snapshot, credits, next.signal)
          assertCurrent()
          output = composed; paintedCredits = credits
          pending.rendered(request.revision)
        } catch (reason) {
          // A failed old asynchronous hook cannot reject the current frame request.
          if (revision === sequence) pending.cancel(reason)
        }
      })()
      const cleanup = () => {signal?.removeEventListener('abort', abort); if (controller === next) controller = null}
      return request.promise.then(() => {cleanup()}, reason => {next.abort(); cleanup(); throw reason})
    },
    dispose: () => {
      if (disposed) return
      disposed = true; sequence++
      controller?.abort(); controller = null
      pending.cancel(frameAbortError('The sandbox frame adapter was disposed'))
      output = null; paintedCredits = []
    },
  }
  return adapter
}