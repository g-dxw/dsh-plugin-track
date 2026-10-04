import { describe, expect, it } from 'vitest'
import { chronologicalPlacemarks, isPlacemarkOrder, orderedPlacemarks } from '../src/track/placemark-order.ts'
import type { TrackPlacemark } from '../src/protocol.ts'
const point = (id: string, time?: number | null): TrackPlacemark => ({id, time, name:id, description:'', images:[], coordinates:[120,30]})

describe('point chronological and manual ordering', () => {
  it('sorts by own timestamps regardless of source order and start/end names', () => {
    const points = [point('起点',100),point('终点',400),point('照片',200)]
    expect(chronologicalPlacemarks(points).map(point => point.id)).toEqual(['起点','照片','终点'])
    expect(points.map(point => point.id)).toEqual(['起点','终点','照片'])
    expect(chronologicalPlacemarks([point('照片',500),point('终点',400)]).map(point => point.id)).toEqual(['终点','照片'])
  })
  it('preserves equal time order and places invalid or absent dates last in original order', () => {
    const points = [point('missing'),point('equal-a',0),point('invalid',NaN),point('equal-b',0),point('null',null),point('out-of-range',9e15)]
    expect(chronologicalPlacemarks(points).map(point => point.id)).toEqual(['equal-a','equal-b','missing','invalid','null','out-of-range'])
  })
  it('keeps source point identity and already sorted array references', () => {
    const points = [point('first',0),point('last',1)]
    expect(chronologicalPlacemarks(points)).toBe(points)
    const reversed = orderedPlacemarks(points,['last','first'])
    expect(reversed[0]).toBe(points[1])
  })
  it('honors manual order and appends new points chronologically without duplicates or unknown IDs', () => {
    const points = [point('a',100),point('b',200),point('c',50),point('d',null)]
    expect(orderedPlacemarks(points,['b','deleted','a','b']).map(point => point.id)).toEqual(['b','a','c','d'])
    expect(orderedPlacemarks(points,null).map(point => point.id)).toEqual(['c','a','b','d'])
  })
  it.each([undefined,{},['a','a'],[''],['a'.repeat(201)],[42]])('rejects invalid saved orders %j', value => expect(isPlacemarkOrder(value)).toBe(false))
})
