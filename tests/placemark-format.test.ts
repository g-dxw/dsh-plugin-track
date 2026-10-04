import {describe,expect,it} from 'vitest'
import {formatPlacemarkTime} from '../src/track/placemark-format.ts'

describe('point time source labels',()=>{
  it('keeps plain imported times and adds an explicit estimate label for derived reference time',()=>{
    const time=Date.parse('2026-01-01T00:00:00Z')
    expect(formatPlacemarkTime(time,'track')).toBe(formatPlacemarkTime(time))
    expect(formatPlacemarkTime(time,'estimated')).toBe(`${formatPlacemarkTime(time)}（估算）`)
  })
  it('shows unknown calculated time while preserving blank legacy values',()=>{
    expect(formatPlacemarkTime(null,'unknown')).toBe('时间未知')
    expect(formatPlacemarkTime(undefined,'unknown')).toBe('时间未知')
    expect(formatPlacemarkTime(null)).toBe('')
    expect(formatPlacemarkTime(NaN)).toBe('')
    expect(formatPlacemarkTime(0,'track')).not.toBe('')
  })
})
