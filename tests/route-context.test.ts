import {describe,it,expect} from 'vitest'
import {routeAIContext} from '../src/track/route-context.ts'
import {validateRouteAIContext} from '../src/ai.ts'
import {editedMetrics} from '../src/track/edit.ts'
import type {TrackRecord} from '../src/protocol.ts'
describe('bounded route summaries for text models',()=>{
 it('uses valid original indices and strips source files and photos while retaining known facts',()=>{
  const points:TrackRecord['coordinates']=Array.from({length:1000},(_,index)=>[119,30,index%2?null:500,index*1000])
  const track:TrackRecord={id:'source',filename:'track.gpx',format:'gpx',name:'山'.repeat(1000),bytes:100,createdAt:'2026-10-01',points:points.length,coordinates:points,metrics:editedMetrics(points)}
  const annotations=[{id:'a',pointIndex:50,label:'山口',color:'#7c3aed',kind:'checkin' as const,photo:{dataUrl:'private image'}}]
  const context=routeAIContext(track,annotations,'known context')
  expect(context.name.length).toBe(160);expect(context.coordinates.length).toBe(80);expect(context.coordinates[0].index).toBe(0);expect(context.coordinates.at(-1)!.index).toBe(999)
  expect(context.elevationCoverage).toBe(.5);expect(context.timestampCoverage).toBe(1);expect(JSON.stringify(context)).not.toContain('private image');expect(context.annotations).toEqual([{pointIndex:50,label:'山口',kind:'checkin'}])
  expect(()=>validateRouteAIContext(context)).not.toThrow();expect(context.userNotes).toBe('known context')
 })
})