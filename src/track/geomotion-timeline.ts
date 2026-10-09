/** Pure time geometry shared by all tracks in the editing timeline. */
export interface TimelineTick {time: number; label: string; major: boolean}
export interface TimelineWindow {in: number; out: number}
export type TimelineWindowMode = 'move' | 'start' | 'end'

const finite = (value: number) => typeof value === 'number' && Number.isFinite(value)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
// A billion seconds is already decades; the bound keeps frame arithmetic finite for corrupt inputs.
const safeDuration = (value: number) => finite(value) && value > 0 ? Math.min(value, 1e9) : 0
const safeFps = (value: number) => finite(value) && value > 0 ? Math.min(value, 1000) : 30
/** Clean conversion noise in frame space; frame indices never accumulate repeated decimal seconds. */
const clean = (value: number) => value === 0 ? 0 : Number(value.toPrecision(14))

export function timelineSnapTime(time: number, fps: number, duration: number, snap = true): number {
  const end = safeDuration(duration), rate = safeFps(fps)
  const value = time === Infinity ? end : finite(time) ? clamp(time, 0, end) : 0
  if (!snap || !end) return value
  return clamp(Math.round(value * rate) / rate, 0, end)
}

/** Pass the actual content plot's bounding rect, whose left already includes horizontal scrolling. */
export function timelineTimeFromClient(clientX: number, plotLeft: number, plotWidth: number, duration: number, fps: number, snap = true): number {
  const end = safeDuration(duration)
  if (!finite(clientX) || !finite(plotLeft) || !finite(plotWidth) || plotWidth <= 0 || !end) return 0
  const proportion = clamp((clientX - plotLeft) / plotWidth, 0, 1)
  return timelineSnapTime(proportion * end, fps, end, snap)
}

/** Nearest 1/2/5 interval, rather than writing a separate tick count for each zoom level. */
function niceInterval(target: number): number {
  if (!finite(target) || target <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(target))
  if (!power) return target
  const fraction = target / power
  const multiple = fraction < Math.sqrt(2) ? 1 : fraction < Math.sqrt(10) ? 2 : fraction < Math.sqrt(50) ? 5 : 10
  return multiple * power
}
function labelAt(time: number, duration: number, interval: number, endpoint = false): string {
  const digits = clamp(Math.ceil(-Math.log10(interval)), 0, 6)
  const displayed = Number(time.toFixed(endpoint ? Math.max(3, digits) : digits))
  if (duration < 60) return `${displayed}秒`
  const minutes = Math.floor(displayed / 60)
  const seconds = Number((displayed - minutes * 60).toFixed(endpoint ? Math.max(3, digits) : digits))
  const secondsText = String(seconds)
  return `${minutes}:${seconds < 10 ? '0' : ''}${secondsText}`
}

/** About 60 px between major labels; minor marks stay >=12 px and total DOM is bounded. */
export function timelineTicks(duration: number, plotWidth: number): TimelineTick[] {
  const end = safeDuration(duration)
  if (!end) return [{time: 0, label: '0秒', major: true}]
  const width = finite(plotWidth) && plotWidth > 0 ? plotWidth : 60
  const desiredMajorCount = clamp(width / 60, 1, 180)
  const target = end / desiredMajorCount
  const majorStep = target >= 60 ? niceInterval(target / 60) * 60 : niceInterval(target)
  const majorPixels = majorStep / end * width
  let divisions = majorPixels / 5 >= 12 ? 5 : majorPixels / 2 >= 12 ? 2 : 1
  if (end / (majorStep / divisions) > 480) divisions = divisions === 5 ? 2 : 1
  if (end / (majorStep / divisions) > 480) divisions = 1
  const step = majorStep / divisions, count = Math.min(480, Math.floor(end / step + 1e-9))
  const ticks: TimelineTick[] = []
  for (let index = 0; index <= count; index++) {
    const time = clean(index * step)
    if (time > end) break
    const major = index % divisions === 0
    ticks.push({time, label: major ? labelAt(time, end, majorStep) : '', major})
  }
  const tolerance = Math.max(end, 1) * Number.EPSILON * 16
  if (Math.abs((ticks.at(-1)?.time ?? 0) - end) <= tolerance) {
    const last = ticks[ticks.length - 1]
    last.time = end; last.major = true; last.label = labelAt(end, end, majorStep, true)
  } else {
    // Avoid a crowded regular label next to the exact duration label.
    while (ticks.length > 1 && (end - ticks[ticks.length - 1].time) / end * width < 40) ticks.pop()
    ticks.push({time: end, label: labelAt(end, end, majorStep, true), major: true})
  }
  return ticks
}

/**
 * Normalize invalid/reversed/collapsed windows before moving or trimming them. An entire
 * clip shorter than one frame is the only smaller valid window. Moves preserve normalized
 * span, even when an imported window is not aligned to frames; trims change one edge only.
 */
export function timelineRetimeWindow(window: TimelineWindow, delta: number, mode: TimelineWindowMode, duration: number, fps: number, snap = true): TimelineWindow {
  const end = safeDuration(duration), rate = safeFps(fps)
  if (!end) return {in: 0, out: 0}
  const maxFrame = clean(end * rate), minimumSpan = Math.min(1, maxFrame)
  let start = clean(clamp(finite(window?.in) ? window.in : 0, 0, end) * rate)
  let finish = clean(clamp(finite(window?.out) ? window.out : start / rate, 0, end) * rate)
  if (finish < start) finish = start
  if (finish - start < minimumSpan) {
    finish = Math.min(maxFrame, clean(start + minimumSpan))
    start = Math.max(0, clean(finish - minimumSpan))
  }
  const shift = finite(delta) ? delta * rate : 0
  const desired = (value: number) => snap ? Math.round(value + shift) : clean(value + shift)
  if (mode === 'start') {
    start = clamp(desired(start), 0, clean(finish - minimumSpan))
  } else if (mode === 'end') {
    finish = clamp(desired(finish), clean(start + minimumSpan), maxFrame)
  } else {
    const span = clean(finish - start)
    start = clamp(desired(start), 0, clean(maxFrame - span))
    finish = clean(start + span)
  }
  const seconds = (frame: number) => snap ? frame / rate : clean(frame / rate)
  return {in: clamp(seconds(start), 0, end), out: clamp(seconds(finish), 0, end)}
}

/** Match geoSetCameraKey merging tolerance so an imported off-frame key is never swallowed. */
export function timelineKeyCollision(id: string, time: number, keys: readonly {id: string; t: number}[]): boolean {
  if (!finite(time)) return false
  return keys.some(key => key.id !== id && finite(key.t)
    && Math.abs(key.t - time) < .000001 + Number.EPSILON * 16 * Math.max(1, Math.abs(time), Math.abs(key.t)))
}