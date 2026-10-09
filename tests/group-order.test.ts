import { describe, expect, it } from 'vitest'
import type { PlacemarkGroup, TrackPlacemark } from '../src/protocol.ts'
import { moveGroupedPlacemark, placemarkOrderScope, shiftGroupedPlacemark } from '../src/client/group-order.ts'
import { placemarkListItems } from '../src/track/placemark-groups.ts'

const points: TrackPlacemark[] = ['a','b','c','d','e'].map(id => ({id,name:id,description:'',images:[],coordinates:[120,30]}))
const group: PlacemarkGroup = {id:'group-00000000-0000-0000-0000-000000000001',name:'营地',description:'',memberIds:['a','c'],coordinates:[120,30]}
describe('grouped point order', () => {
  it('projects nonadjacent members without rewriting the original order or numbers', () => {
    expect(placemarkListItems(points,[group]).map(item=>item.kind==='group'?`G${item.number}`:`${item.number}:${item.point.id}`)).toEqual(['G1','2:b','4:d','5:e'])
    expect(points.map(point=>point.id)).toEqual(['a','b','c','d','e'])
  })
  it('moves an entire group as one top-level row while retaining every point', () => {
    const result=moveGroupedPlacemark(points,[group],group.id,'d',true)
    expect(result).toEqual(['b','d','a','c','e'])
    expect(new Set(result)).toEqual(new Set(points.map(point=>point.id)))
  })
  it('moves a single top-level point around a whole group', () => {
    expect(moveGroupedPlacemark(points,[group],'e',group.id,false)).toEqual(['e','a','c','b','d'])
  })
  it('only replaces existing member slots for an internal move', () => {
    expect(moveGroupedPlacemark(points,[group],'c','a',false)).toEqual(['c','b','a','d','e'])
    expect(placemarkOrderScope(points,[group],'a')).toEqual(['a','c'])
  })
  it('does not change membership by dragging a child outside its group', () => {
    expect(moveGroupedPlacemark(points,[group],'a','b',true)).toBeNull()
    expect(moveGroupedPlacemark(points,[group],'b','a',true)).toBeNull()
    expect(moveGroupedPlacemark(points,[group],group.id,'a',true)).toBeNull()
    expect(group.memberIds).toEqual(['a','c'])
  })
  it('supports bounded keyboard movement separately inside groups and at the top level', () => {
    expect(shiftGroupedPlacemark(points,[group],'a',-1)).toBeNull()
    expect(shiftGroupedPlacemark(points,[group],'a',1)).toEqual(['c','b','a','d','e'])
    expect(shiftGroupedPlacemark(points,[group],group.id,1)).toEqual(['b','a','c','d','e'])
    expect(shiftGroupedPlacemark(points,[group],'e',1)).toBeNull()
  })
  it('retains ordinary reorder behavior for an ungrouped track', () => {
    expect(moveGroupedPlacemark(points,[],'a','c',true)).toEqual(['b','c','a','d','e'])
    expect(shiftGroupedPlacemark(points,[],'c',-1)).toEqual(['a','c','b','d','e'])
  })
  it('does not flatten nonadjacent members when the displayed order did not move', () => {
    expect(moveGroupedPlacemark(points,[group],'b',group.id,true)).toBeNull()
    expect(moveGroupedPlacemark(points,[group],group.id,'b',false)).toBeNull()
    expect(moveGroupedPlacemark(points,[group],'a','c',false)).toBeNull()
  })
})
