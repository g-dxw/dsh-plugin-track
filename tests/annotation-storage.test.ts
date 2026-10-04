import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTrack, readSource, readTrack, trackDir } from '../src/artifacts.ts'
import { readAnnotations, readArtLayout, readArtRouteTransform, writeAnnotations } from '../src/annotations-store.ts'
import { pointMetrics } from '../src/track/metrics.ts'
import type { TrackPoint } from '../src/protocol.ts'
import { annotationVisible } from '../src/track/annotations.ts'
const directories: string[] = []
afterEach(() => {for (const path of directories.splice(0)) {if (!path.startsWith(join(tmpdir(), 'cqai-track-annotation-'))) throw new Error('Invalid annotation fixture'); rmSync(path, {recursive: true, force: true})}})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-track-annotation-')); directories.push(home)
  const env = {DSH_HOME: home}
  const points: TrackPoint[] = [[119, 30, 500, null], [119.01, 30, null, null]]
  const track = writeTrack({filename: 'original.gpx', name: '原文件', source: '<gpx>原始内容</gpx>', points, metrics: pointMetrics(points)}, env)
  return {env, track, points}
}
describe('annotation sidecars', () => {
  it('saves and reloads route transforms independently while preserving older array-only writers', () => {
    const {env,track,points}=fixture(),annotations=[{id:'point',pointIndex:0,label:'点位',color:'#7c3aed'}],layout={title:{x:200,y:160}},route={x:-100,y:240,scale:.75},original=readSource(track.id,env)!.body
    expect(readArtRouteTransform(track.id,env)).toEqual({x:0,y:0,scale:1})
    writeAnnotations(track.id,annotations,env,layout,route)
    expect(readArtRouteTransform(track.id,env)).toEqual(route)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readAnnotations(track.id,env)).toEqual(annotations)
    const updated=[{...annotations[0],label:'修改文字'}]
    writeAnnotations(track.id,updated,env)
    expect(readArtRouteTransform(track.id,env)).toEqual(route)
    expect(JSON.parse(readFileSync(join(trackDir(track.id,env),'annotations.json'),'utf8'))).toEqual({version:1,annotations:updated,layout,route})
    expect(readSource(track.id,env)!.body).toEqual(original)
    expect(readTrack(track.id,env)!.coordinates).toEqual(points)
  })
  it('validates route, layout and annotation edits before mutating their shared sidecar', () => {
    const {env,track}=fixture(),annotations=[{id:'point',pointIndex:0,label:'点位',color:'#7c3aed'}],layout={end:{x:500,y:400}},route={x:10,y:20,scale:1.5}
    writeAnnotations(track.id,annotations,env,layout,route)
    const path=join(trackDir(track.id,env),'annotations.json'),before=readFileSync(path,'utf8')
    expect(()=>writeAnnotations(track.id,[{...annotations[0],label:'不应保存'}],env,{end:{x:1,y:2}},{x:0,y:0,scale:5})).toThrow('轨迹图层变换无效')
    expect(()=>writeAnnotations(track.id,annotations,env,{unknown:{x:1,y:2}},{x:0,y:0,scale:1})).toThrow('画布文字布局无效')
    expect(()=>writeAnnotations(track.id,[{...annotations[0],pointIndex:100}],env,{}, {x:0,y:0,scale:1})).toThrow('标注点序号无效')
    expect(readFileSync(path,'utf8')).toBe(before)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readArtRouteTransform(track.id,env)).toEqual(route)
    expect(readAnnotations(track.id,env)).toEqual(annotations)
  })
  it('omits the default route transform and restores legacy bytes after camera reset', () => {
    const {env,track}=fixture(),annotations=[{id:'point',pointIndex:0,label:'旧点位',color:'#7c3aed'}],path=join(trackDir(track.id,env),'annotations.json')
    writeAnnotations(track.id,annotations,env)
    const legacy=JSON.stringify({version:1,annotations})
    expect(readArtRouteTransform(track.id,env)).toEqual({x:0,y:0,scale:1})
    expect(readFileSync(path,'utf8')).toBe(legacy)
    writeAnnotations(track.id,annotations,env,undefined,{x:30,y:-40,scale:2})
    expect(readArtRouteTransform(track.id,env)).toEqual({x:30,y:-40,scale:2})
    writeAnnotations(track.id,annotations,env,undefined,{x:0,y:0,scale:1})
    expect(readArtRouteTransform(track.id,env)).toEqual({x:0,y:0,scale:1})
    expect(readFileSync(path,'utf8')).toBe(legacy)
    expect(()=>readArtRouteTransform('../../outside',env)).toThrow('轨迹不存在')
  })

  it('saves text layout atomically alongside annotations and preserves it for older array-only writers', () => {
    const {env,track}=fixture(),annotations=[{id:'point',pointIndex:0,label:'点位',color:'#7c3aed'}],layout={title:{x:200,y:160},north:{x:500,y:700}}
    expect(readArtLayout(track.id,env)).toEqual({})
    expect(writeAnnotations(track.id,annotations,env,layout)).toEqual(annotations)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readAnnotations(track.id,env)).toEqual(annotations)
    const updated=[{...annotations[0],label:'修改标注'}]
    writeAnnotations(track.id,updated,env)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readAnnotations(track.id,env)).toEqual(updated)
    expect(JSON.parse(readFileSync(join(trackDir(track.id,env),'annotations.json'),'utf8'))).toEqual({version:1,annotations:updated,layout})
  })
  it('rejects invalid layout or annotations without changing either saved value', () => {
    const {env,track}=fixture(),annotations=[{id:'point',pointIndex:0,label:'点位',color:'#7c3aed'}],layout={start:{x:300,y:400}}
    writeAnnotations(track.id,annotations,env,layout)
    const path=join(trackDir(track.id,env),'annotations.json'),before=readFileSync(path,'utf8')
    expect(()=>writeAnnotations(track.id,[{...annotations[0],label:'不应保存'}],env,{unknown:{x:1,y:2}})).toThrow('画布文字布局无效')
    expect(()=>writeAnnotations(track.id,[{...annotations[0],pointIndex:100}],env,{start:{x:1,y:2}})).toThrow('标注点序号无效')
    expect(readFileSync(path,'utf8')).toBe(before)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readAnnotations(track.id,env)).toEqual(annotations)
  })
  it('keeps the original version 1 byte shape for absent or reset text layouts', () => {
    const {env,track}=fixture(),annotations=[{id:'point',pointIndex:0,label:'旧点位',color:'#7c3aed'}],path=join(trackDir(track.id,env),'annotations.json')
    writeAnnotations(track.id,annotations,env)
    expect(readFileSync(path,'utf8')).toBe(JSON.stringify({version:1,annotations}))
    expect(readArtLayout(track.id,env)).toEqual({})
    writeAnnotations(track.id,annotations,env,{title:{x:100,y:200}})
    writeAnnotations(track.id,annotations,env,{})
    expect(readFileSync(path,'utf8')).toBe(JSON.stringify({version:1,annotations}))
    expect(readArtLayout(track.id,env)).toEqual({})
    expect(()=>readArtLayout('../../outside',env)).toThrow('轨迹不存在')
  })

  it('stores and reloads point labels without rewriting the original or coordinates', () => {
    const {env, track, points} = fixture()
    const original = readSource(track.id, env)!.body
    expect(readAnnotations(track.id, env)).toEqual([])
    const annotations = [{id: 'poi-1', pointIndex: 1, label: '山口', color: '#7c3aed'}]
    expect(writeAnnotations(track.id, annotations, env)).toEqual(annotations)
    expect(readAnnotations(track.id, env)).toEqual(annotations)
    expect(readSource(track.id, env)!.body).toEqual(original)
    expect(readTrack(track.id, env)!.coordinates).toEqual(points)
    expect(JSON.parse(readFileSync(join(trackDir(track.id, env), 'annotations.json'), 'utf8')).version).toBe(1)
  })
  it('rejects invalid edits while retaining the last saved labels', () => {
    const {env, track} = fixture()
    const annotations = [{id: 'poi-1', pointIndex: 0, label: '起点', color: '#7c3aed'}]
    writeAnnotations(track.id, annotations, env)
    expect(() => writeAnnotations(track.id, [{...annotations[0], pointIndex: 999}], env)).toThrow()
    expect(readAnnotations(track.id, env)).toEqual(annotations)
  })
  it('does not permit labels to be read or written outside a real track', () => {
    const {env} = fixture()
    expect(() => readAnnotations('../../outside', env)).toThrow('轨迹不存在')
    expect(() => writeAnnotations('../../outside', [], env)).toThrow('轨迹不存在')
  })
  it('persists explicit visibility overrides and keeps type defaults optional', () => {
    const {env,track}=fixture()
    const annotations=[
      {id:'ordinary',pointIndex:0,label:'显示普通点',color:'#7c3aed',kind:'note' as const,visible:true},
      {id:'checkin',pointIndex:1,label:'隐藏打卡点',color:'#0f766e',kind:'checkin' as const,visible:false},
      {id:'rest',pointIndex:0,label:'默认休息点',color:'#2563eb',kind:'rest' as const},
    ]
    expect(writeAnnotations(track.id,annotations,env)).toEqual(annotations)
    const restored=readAnnotations(track.id,env)
    expect(restored).toEqual(annotations)
    expect(restored.map(annotationVisible)).toEqual([true,false,true])
    expect(restored[2]).not.toHaveProperty('visible')
    expect(()=>writeAnnotations(track.id,[{...annotations[0],visible:'false'}],env)).toThrow('标注显示设置无效')
    expect(readAnnotations(track.id,env)).toEqual(annotations)
  })
  it('reads older visibility-free sidecars without changing their stored content', () => {
    const {env,track}=fixture()
    writeAnnotations(track.id,[{id:'legacy',pointIndex:0,label:'旧普通标注',color:'#7c3aed'}],env)
    const path=join(trackDir(track.id,env),'annotations.json'),before=readFileSync(path,'utf8')
    const restored=readAnnotations(track.id,env)
    expect(restored[0]).not.toHaveProperty('visible')
    expect(annotationVisible(restored[0])).toBe(false)
    expect(readFileSync(path,'utf8')).toBe(before)
  })
})
