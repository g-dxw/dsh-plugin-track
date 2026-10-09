import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import { artCanvasSizeSaved, readAnnotations, readArtCanvasSize, readArtLayout, readArtRouteTransform, writeAnnotations } from '../src/annotations-store.ts'
import { readSource, readTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { API, type TrackPoint } from '../src/protocol.ts'
import { pointMetrics } from '../src/track/metrics.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'cqai-track-canvas-storage-'))) throw new Error('Invalid canvas fixture')
    rmSync(root, {recursive: true, force: true})
  }
})
function fixture() {
  const home=mkdtempSync(join(tmpdir(), 'cqai-track-canvas-storage-')); roots.push(home)
  const env={DSH_HOME: home}, points: TrackPoint[]=[[119,30,500,null],[119.01,30,550,null]]
  const track=writeTrack({filename:'original.gpx',name:'原始路线',source:'<gpx>原始内容</gpx>',points,metrics:pointMetrics(points)},env)
  const path=join(trackDir(track.id,env),'annotations.json')
  const annotations=[{id:'marker',pointIndex:0,label:'山口',color:'#7c3aed'}]
  return {home,env,points,track,path,annotations}
}

describe('annotation canvas dimensions', () => {
  it('reads a landscape default without adding canvas to legacy sidecars', () => {
    const {env,track,path,annotations}=fixture()
    expect(readArtCanvasSize(track.id,env)).toEqual({width:1200,height:900})
    expect(artCanvasSizeSaved(track.id,env)).toBe(false)
    writeAnnotations(track.id,annotations,env)
    const before=readFileSync(path,'utf8')
    expect(JSON.parse(before)).toEqual({version:1,annotations})
    expect(artCanvasSizeSaved(track.id,env)).toBe(false)
    expect(readArtCanvasSize(track.id,env)).toEqual({width:1200,height:900})
    expect(readFileSync(path,'utf8')).toBe(before)
    writeAnnotations(track.id,annotations,env)
    expect(readFileSync(path,'utf8')).toBe(before)
  })
  it('persists explicit dimensions and preserves them for older annotation writers', () => {
    const {env,track,path,annotations,points}=fixture(),canvas={width:1600,height:900},layout={title:{x:30,y:60}},route={x:20,y:-10,scale:.8}
    const original=readSource(track.id,env)!.body
    writeAnnotations(track.id,annotations,env,layout,route,canvas)
    expect(readArtCanvasSize(track.id,env)).toEqual(canvas)
    expect(artCanvasSizeSaved(track.id,env)).toBe(true)
    expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({version:1,annotations,layout,route,canvas})
    const updated=[{...annotations[0],label:'新山口'}]
    writeAnnotations(track.id,updated,env)
    expect(readArtCanvasSize(track.id,env)).toEqual(canvas)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readArtRouteTransform(track.id,env)).toEqual(route)
    expect(readAnnotations(track.id,env)).toEqual(updated)
    expect(readSource(track.id,env)!.body).toEqual(original)
    expect(readTrack(track.id,env)!.coordinates).toEqual(points)
    writeAnnotations(track.id,updated,env,undefined,undefined,{width:1200,height:900})
    expect(readArtCanvasSize(track.id,env)).toEqual({width:1200,height:900})
    expect(JSON.parse(readFileSync(path,'utf8')).canvas).toEqual({width:1200,height:900})
  })
  it('validates dimensions before overwriting any existing annotation data', () => {
    const {env,track,path,annotations}=fixture(),canvas={width:900,height:1200},layout={end:{x:400,y:300}},route={x:1,y:2,scale:1.5}
    writeAnnotations(track.id,annotations,env,layout,route,canvas)
    const before=readFileSync(path,'utf8')
    const invalid=[null,{},[],{width:239,height:900},{width:4097,height:900},{width:900,height:239},{width:900,height:4097},{width:900.5,height:900},{width:'900',height:900}]
    for (const value of invalid) {
      expect(()=>writeAnnotations(track.id,[{...annotations[0],label:'不得保存'}],env,{end:{x:1,y:2}},{x:0,y:0,scale:1},value)).toThrow()
      expect(readFileSync(path,'utf8')).toBe(before)
    }
    expect(readArtCanvasSize(track.id,env)).toEqual(canvas)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readArtRouteTransform(track.id,env)).toEqual(route)
    expect(readAnnotations(track.id,env)).toEqual(annotations)
    expect(()=>readArtCanvasSize('../../outside',env)).toThrow('轨迹不存在')
    expect(()=>artCanvasSizeSaved('../../outside',env)).toThrow('轨迹不存在')
    expect(()=>writeAnnotations('../../outside',annotations,env,undefined,undefined,canvas)).toThrow('轨迹不存在')
  })
  it('exposes dimensions through the real annotations HTTP endpoint and rejects invalid updates atomically', async () => {
    const {home,env,track,path,annotations,points}=fixture(),previousHome=process.env.DSH_HOME,ctx=new Context()
    process.env.DSH_HOME=home
    try {
      await ctx.plugin(WebServer,{host:'127.0.0.1',port:0})
      await ctx.plugin(plugin)
      const base=`http://127.0.0.1:${String(ctx.webServer.port)}${API}/annotations`
      const get=()=>fetch(`${base}?id=${encodeURIComponent(track.id)}`)
      const post=(body:unknown)=>fetch(base,{method:'POST',headers:{'x-cqai-track':'1','content-type':'application/json'},body:JSON.stringify(body)})
      expect(await (await get()).json()).toMatchObject({annotations:[],saved:false,canvas:{width:1200,height:900},canvasSaved:false})
      const canvas={width:1080,height:1920}
      const saved=await post({id:track.id,annotations,canvas})
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({annotations,canvas,canvasSaved:true})
      expect(await (await get()).json()).toMatchObject({annotations,saved:true,canvas,canvasSaved:true})
      const updated=[{...annotations[0],label:'只更新标注'}]
      expect(await (await post({id:track.id,annotations:updated})).json()).toMatchObject({annotations:updated,canvas,canvasSaved:true})
      const before=readFileSync(path,'utf8')
      expect((await post({id:track.id,annotations,canvas:{width:0,height:900}})).status).toBe(400)
      expect(readFileSync(path,'utf8')).toBe(before)
      expect(await (await get()).json()).toMatchObject({annotations:updated,saved:true,canvas,canvasSaved:true})
      expect(readSource(track.id,env)!.body.toString('utf8')).toBe('<gpx>原始内容</gpx>')
      expect(readTrack(track.id,env)!.coordinates).toEqual(points)
    } finally {
      await ctx.fiber.dispose()
      if (previousHome===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME=previousHome
    }
  })
})
