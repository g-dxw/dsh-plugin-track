import {describe,expect,it} from 'vitest'
import {createGeoMotionProject,geoEvaluate,geoSetLayerWindow,type GeoMotionProject} from '../src/track/geomotion.ts'
import {timelineRetimeWindow} from '../src/track/geomotion-timeline.ts'
import {keyframedTrack} from '../src/track/vendor/geomotion/document/index.ts'
import type {TrackRecord} from '../src/protocol.ts'
const track:TrackRecord={id:'timeline-window',name:'真实路线',filename:'route.gpx',format:'gpx',createdAt:'2026-10-04',bytes:80,points:3,
  coordinates:[[114.1,27.5,100,null],[114.11,27.51,120,null],[114.12,27.52,110,null]],
  metrics:{distance:4000,elevationGain:20,elevationLoss:10,duration:0,elevationMax:120,elevationMin:100,bbox:[114.1,27.5,114.12,27.52]}}
function project(){return createGeoMotionProject(track,[{id:'summit',name:'金顶',coordinates:[114.11,27.51],description:'',images:[]}]).document}
const route=(p:GeoMotionProject)=>Object.values(p.nodes).find(node=>node.type==='route')!
const marker=(p:GeoMotionProject)=>Object.values(p.nodes).find(node=>node.type==='marker')!
describe('timeline layer edits stay consistent with animation',()=>{
  it('moving a route takes its absolute progress keys along, with the same result at shifted playback time',()=>{
    const original=project(),id=route(original).id
    const cropped=geoSetLayerWindow(original,id,{in:2,out:10}),before=JSON.stringify(cropped)
    const moved=geoSetLayerWindow(cropped,id,{in:5,out:13})
    expect(route(moved)).toMatchObject({in:5,out:13,coords:route(original).coords})
    const oldProgress=route(cropped).progress,newProgress=route(moved).progress
    expect(oldProgress.kind).toBe('keyframed');expect(newProgress.kind).toBe('keyframed')
    if(oldProgress.kind==='keyframed'&&newProgress.kind==='keyframed')expect(newProgress.keys.map(key=>key.t)).toEqual(oldProgress.keys.map(key=>key.t+3))
    expect(geoEvaluate(moved,8).routes[0].progress).toBeCloseTo(geoEvaluate(cropped,5).routes[0].progress)
    expect(geoEvaluate(moved,8).routes[0].drawn).toEqual(geoEvaluate(cropped,5).routes[0].drawn)
    expect(JSON.stringify(cropped)).toBe(before);expect(moved.nodes[marker(original).id]).toEqual(marker(original))
  })
  it('trimming changes visible content bounds while preserving authored animation times',()=>{
    const original=project(),id=route(original).id,cropped=geoSetLayerWindow(original,id,{in:4,out:12})
    expect(route(cropped).progress).toEqual(route(original).progress)
    expect(geoEvaluate(cropped,3).routes[0].alpha).toBe(0)
    expect(geoEvaluate(cropped,7).routes[0].drawn).toEqual(geoEvaluate(original,7).routes[0].drawn)
    expect(geoEvaluate(cropped,13).routes[0].alpha).toBe(0)
  })
  it('moving an animated label retains key IDs and local behaviours without altering coordinates',()=>{
    const original=project(),point=marker(original);point.in=2;point.out=7
    point.size=keyframedTrack([{id:'size-a',t:2,value:5,easing:'linear'},{id:'size-b',t:7,value:10,easing:'linear'}])
    const before=structuredClone(original),moved=geoSetLayerWindow(original,point.id,{in:6,out:11}),after=marker(moved)
    expect(after.coord).toEqual(point.coord);expect(after.behaviours).toEqual(point.behaviours)
    if(after.size.kind==='keyframed')expect(after.size.keys.map(key=>[key.id,key.t])).toEqual([['size-a',6],['size-b',11]])
    expect(original).toEqual(before);expect(geoEvaluate(moved,8).markers[0].scale).toBeCloseTo(geoEvaluate(original,4).markers[0].scale)
  })
  it('keeps a snapped clip ending at the exact composition boundary despite floating-point shift noise',()=>{
    const original=project(),point=marker(original);point.in=2/24;point.out=4/24
    point.size=keyframedTrack([{id:'size-start',t:point.in,value:5,easing:'linear'},{id:'size-end',t:point.out,value:10,easing:'linear'}])
    const range=timelineRetimeWindow(point,30,'move',20,24)
    expect(range.out).toBe(20)
    const moved=geoSetLayerWindow(original,point.id,range),after=marker(moved)
    expect(after.in).toBe(range.in);expect(after.out).toBe(20)
    if(after.size.kind==='keyframed')expect(after.size.keys[1].t).toBeCloseTo(20)
    expect(geoEvaluate(moved,range.in).markers[0].alpha).toBeGreaterThan(0)
  })
  it('moves animation keys with a collapsed imported clip when the timeline normalizes it to one frame',()=>{
    const original=project(),line=route(original);line.in=2;line.out=2
    const range=timelineRetimeWindow(line,5,'move',20,30)
    const moved=geoSetLayerWindow(original,line.id,range,'move'),after=route(moved)
    expect(after.in).toBe(7);expect(after.out-after.in).toBeCloseTo(1/30)
    if(line.progress.kind==='keyframed'&&after.progress.kind==='keyframed')expect(after.progress.keys.map(key=>key.t)).toEqual(line.progress.keys.map(key=>key.t+5))
    expect(geoEvaluate(moved,7).routes[0].progress).toBeCloseTo(geoEvaluate(original,2).routes[0].progress)
  })
  it('rejects invalid bounds and locked layers, while no-op edits preserve the project identity',()=>{
    const original=project(),id=marker(original).id
    expect(geoSetLayerWindow(original,id,{in:0,out:20})).toBe(original)
    for(const range of [{in:-1,out:2},{in:4,out:3},{in:1,out:21},{in:NaN,out:2}])expect(()=>geoSetLayerWindow(original,id,range)).toThrow('片段时间')
    expect(geoSetLayerWindow(original,'missing',{in:0,out:2})).toBe(original)
    marker(original).locked=true;expect(()=>geoSetLayerWindow(original,id,{in:1,out:3})).toThrow('已锁定')
  })
})