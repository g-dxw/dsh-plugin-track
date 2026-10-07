import {describe, expect, it} from 'vitest'
import {timelineKeyCollision, timelineRetimeWindow, timelineSnapTime, timelineTicks, timelineTimeFromClient} from '../src/track/geomotion-timeline.ts'

describe('frame based timeline time geometry', () => {
  it('snaps 24 and 30 fps to frame indices and clamps to the real duration', () => {
    expect(timelineSnapTime(1.02, 30, 20)).toBe(31 / 30)
    expect(timelineSnapTime(1.02, 24, 20)).toBe(1)
    expect(timelineSnapTime(1.031, 24, 20)).toBe(25 / 24)
    expect(timelineSnapTime(-10, 30, 20)).toBe(0)
    expect(timelineSnapTime(200, 30, 20)).toBe(20)
    expect(timelineSnapTime(1.012, 30, 1.012)).toBe(1)
    expect(timelineSnapTime(1.026, 30, 1.026)).toBe(1.026)
    expect(timelineSnapTime(.123456, 30, 20, false)).toBe(.123456)
    expect(timelineSnapTime(.1, 29.97, 20)).toBe(3 / 29.97)
  })

  it('maps ruler, clips and keys with the same actual content rect after scrolling', () => {
    expect(timelineTimeFromClient(600, 100, 1000, 20, 30)).toBe(10)
    // Content starts 400px to the left of the viewport after a scroll, not at the viewport edge.
    expect(timelineTimeFromClient(100, -400, 1000, 20, 30)).toBe(10)
    expect(timelineTimeFromClient(121, -400, 1000, 20, 24)).toBe(10.416666666666666)
    expect(timelineTimeFromClient(121, -400, 1000, 20, 24, false)).toBe(10.42)
    expect(timelineTimeFromClient(-900, -400, 1000, 20, 30)).toBe(0)
    expect(timelineTimeFromClient(1200, -400, 1000, 20, 30)).toBe(20)
    expect(timelineTimeFromClient(100, 0, 4000, 3600, 30)).toBe(90)
  })

  it('never produces NaN for invalid geometry or time inputs', () => {
    for (const value of [NaN, Infinity, -Infinity, 0, -20]) {
      expect(Number.isFinite(timelineSnapTime(value, value, value))).toBe(true)
      expect(Number.isFinite(timelineTimeFromClient(value, value, value, value, value))).toBe(true)
    }
    expect(timelineSnapTime(Infinity, 30, 20)).toBe(20)
    expect(timelineSnapTime(NaN, NaN, 20)).toBe(0)
    expect(timelineSnapTime(.12, 0, 20)).toBe(4 / 30)
    expect(timelineTimeFromClient(10, 0, 0, 20, 30)).toBe(0)
  })
})

describe('smart timeline tick density', () => {
  it('creates ascending bounded marks and exact endpoints for short, long and zoomed plots', () => {
    for (const [duration, width] of [[.5, 600], [20, 600], [123.456, 1300], [300, 600], [3600, 1400], [60, 1000000], [20, 0]]) {
      const ticks = timelineTicks(duration, width)
      expect(ticks[0]).toMatchObject({time: 0, major: true})
      expect(ticks.at(-1)).toMatchObject({time: duration, major: true})
      expect(ticks.length).toBeLessThanOrEqual(482)
      expect(ticks.every((tick, index) => Number.isFinite(tick.time) && tick.time >= 0 && tick.time <= duration && (!index || tick.time > ticks[index - 1].time))).toBe(true)
      expect(ticks.filter(tick => tick.major).every(tick => !!tick.label)).toBe(true)
      expect(ticks.filter(tick => !tick.major).every(tick => tick.label === '')).toBe(true)
    }
  })

  it('uses useful 1/2/5 major intervals and minutes for long clips without crowded labels', () => {
    const short = timelineTicks(20, 600)
    expect(short.filter(tick => tick.major).map(tick => tick.time)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    expect(short.find(tick => tick.time === 2)?.label).toBe('2秒')
    const long = timelineTicks(300, 600)
    expect(long.some(tick => tick.major && tick.label === '1:00')).toBe(true)
    expect(long.at(-1)?.label).toBe('5:00')
    const regular = short.filter(tick => tick.major)
    expect(regular[1].time / 20 * 600).toBe(60)
    const fractional = timelineTicks(1.003, 1000)
    expect(fractional.at(-1)?.label).toBe('1.003秒')
    expect(timelineTicks(NaN, NaN)).toEqual([{time: 0, label: '0秒', major: true}])
  })
})

describe('clip movement and trimming', () => {
  it('moves windows as one span and stops at each boundary without growing them', () => {
    const source = {in: 2, out: 5}
    expect(timelineRetimeWindow(source, 100, 'move', 10, 30)).toEqual({in: 7, out: 10})
    expect(timelineRetimeWindow(source, -100, 'move', 10, 30)).toEqual({in: 0, out: 3})
    expect(timelineRetimeWindow(source, .02, 'move', 10, 30)).toEqual({in: 61 / 30, out: 151 / 30})
    expect(timelineRetimeWindow(source, .02, 'move', 10, 24)).toEqual(source)
    expect(timelineRetimeWindow(source, .02, 'move', 10, 24, false)).toEqual({in: 2.02, out: 5.02})
    expect(source).toEqual({in: 2, out: 5})
  })

  it('trims only one boundary and enforces a full frame without crossing the other', () => {
    expect(timelineRetimeWindow({in: 2, out: 5}, 100, 'start', 10, 30)).toEqual({in: 149 / 30, out: 5})
    expect(timelineRetimeWindow({in: 2, out: 5}, -100, 'end', 10, 24)).toEqual({in: 2, out: 49 / 24})
    expect(timelineRetimeWindow({in: 2, out: 5}, -100, 'start', 10, 30)).toEqual({in: 0, out: 5})
    expect(timelineRetimeWindow({in: 2, out: 5}, 100, 'end', 10, 30)).toEqual({in: 2, out: 10})
    expect(timelineRetimeWindow({in: 2, out: 5}, .017, 'end', 10, 30)).toEqual({in: 2, out: 151 / 30})
    expect(timelineRetimeWindow({in: 2, out: 5}, .017, 'end', 10, 30, false)).toEqual({in: 2, out: 5.017})
  })

  it('normalizes collapsed, reversed and subframe windows explicitly and accommodates subframe total durations', () => {
    expect(timelineRetimeWindow({in: 2, out: 2}, 0, 'move', 10, 30)).toEqual({in: 2, out: 61 / 30})
    expect(timelineRetimeWindow({in: 10, out: 10}, 0, 'move', 10, 30)).toEqual({in: 299 / 30, out: 10})
    expect(timelineRetimeWindow({in: 8, out: 2}, 0, 'end', 10, 30)).toEqual({in: 8, out: 241 / 30})
    expect(timelineRetimeWindow({in: 1, out: 1.001}, 0, 'move', 10, 24)).toEqual({in: 1, out: 25 / 24})
    expect(timelineRetimeWindow({in: 0, out: 0}, 0, 'move', .01, 30)).toEqual({in: 0, out: .01})
    expect(timelineRetimeWindow({in: NaN, out: Infinity}, NaN, 'move', 10, NaN)).toEqual({in: 0, out: 1 / 30})
    expect(timelineRetimeWindow({in: 1, out: 2}, 1, 'move', -10, 30)).toEqual({in: 0, out: 0})
  })

  it('does not accumulate duration drift after thousands of moves at 24, 30 or fractional fps', () => {
    for (const fps of [24, 30, 29.97]) {
      const initial = timelineSnapTime(1, fps, 300)
      let value = {in: initial, out: initial + 2.45}
      const span = value.out - value.in
      for (let index = 0; index < 10000; index++) {
        const next = timelineRetimeWindow(value, (index < 5000 ? 1 : -1) / fps, 'move', 300, fps)
        expect(next.out - next.in).toBeCloseTo(span, 10)
        value = next
      }
      expect(value.in).toBeCloseTo(initial, 8)
      expect(value.out).toBeCloseTo(initial + 2.45, 8)
    }
  })

  it('preserves off-frame imported span while snapping its moved start and uses the pointerdown baseline', () => {
    const source = {in: .123, out: 1.234}
    const moved = timelineRetimeWindow(source, .31, 'move', 20, 30)
    expect(moved.in).toBe(13 / 30)
    expect(moved.out - moved.in).toBeCloseTo(1.111, 12)
    const end = timelineRetimeWindow(source, .32, 'move', 20, 30)
    expect(end).toEqual(moved)
    const clamped = timelineRetimeWindow(source, 100, 'move', 20, 30)
    expect(clamped.out).toBe(20)
    expect(clamped.out - clamped.in).toBeCloseTo(1.111, 12)
  })
})

describe('keyframe occupied time', () => {
  it('protects non-grid imported keys within the document editor merge tolerance', () => {
    const imported = [{id: 'imported', t: 4.123456}, {id: 'moving', t: 7.123456}]
    const original = JSON.stringify(imported)
    expect(timelineKeyCollision('moving', 4.1234563, imported)).toBe(true)
    expect(timelineKeyCollision('moving', 4.1234557, imported)).toBe(true)
    expect(timelineKeyCollision('moving', 4.123466, imported)).toBe(false)
    expect(timelineKeyCollision('imported', 4.1234563, imported)).toBe(false)
    expect(JSON.stringify(imported)).toBe(original)
  })
  it('allows the selected key and rejects another key at the same authored instant', () => {
    const keys = [{id: 'self', t: 1}, {id: 'other', t: 2}, {id: 'fractional', t: .3}]
    expect(timelineKeyCollision('self', 1, keys)).toBe(false)
    expect(timelineKeyCollision('self', 2, keys)).toBe(true)
    expect(timelineKeyCollision('new', .1 + .2, keys)).toBe(true)
    expect(timelineKeyCollision('new', .30001, keys)).toBe(false)
    expect(timelineKeyCollision('new', NaN, keys)).toBe(false)
    expect(timelineKeyCollision('self', 1, [])).toBe(false)
    expect(keys).toEqual([{id: 'self', t: 1}, {id: 'other', t: 2}, {id: 'fractional', t: .3}])
  })
})