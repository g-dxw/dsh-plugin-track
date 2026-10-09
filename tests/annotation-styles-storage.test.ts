import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import { readAnnotations, readArtCanvasSize, readArtLayout, readArtRouteTransform, readArtStyles, writeAnnotations } from '../src/annotations-store.ts'
import { readSource, readTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { API, type TrackPoint } from '../src/protocol.ts'
import { pointMetrics } from '../src/track/metrics.ts'
import type { ArtStyles } from '../src/track/art-styles.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'cqai-track-styles-storage-'))) throw new Error('Invalid styles fixture')
    rmSync(root, {recursive: true, force: true})
  }
})
function fixture() {
  const home=mkdtempSync(join(tmpdir(), 'cqai-track-styles-storage-')); roots.push(home)
  const env={DSH_HOME: home}, points: TrackPoint[]=[[119,30,500,null],[119.01,30,550,null]]
  const track=writeTrack({filename:'original.gpx',name:'原始路线',source:'<gpx>原始内容</gpx>',points,metrics:pointMetrics(points)},env)
  const directory=trackDir(track.id,env),path=join(directory,'annotations.json')
  const annotations=[{id:'marker',pointIndex:0,label:'山口',color:'#7c3aed'}]
  return {home,env,points,track,directory,path,annotations}
}
const styles: ArtStyles={
  defaults:{textColor:'#123456',textSize:24,textOffsetX:10,photoWidth:400},
  texts:{title:{textColor:'#ff0000',textSize:32}},
  route:{color:'#00aaff',width:8},
  background:'#f4f4f4',
}

describe('annotation artwork styles sidecars', () => {
  it('reads empty styles without migrating or mutating legacy sidecars', () => {
    const {env,track,path,annotations}=fixture()
    expect(readArtStyles(track.id,env)).toEqual({})
    writeAnnotations(track.id,annotations,env)
    const legacy=JSON.stringify({version:1,annotations})
    expect(readFileSync(path,'utf8')).toBe(legacy)
    expect(readArtStyles(track.id,env)).toEqual({})
    expect(readFileSync(path,'utf8')).toBe(legacy)
    writeAnnotations(track.id,annotations,env)
    expect(readFileSync(path,'utf8')).toBe(legacy)
  })
  it('persists independent and unified styles while older writers preserve all canvas settings', () => {
    const {env,track,path,annotations,points,directory}=fixture(),canvas={width:1600,height:900},layout={title:{x:30,y:60}},route={x:20,y:-10,scale:.8}
    const original=readSource(track.id,env)!.body,styled=[{...annotations[0],style:{textColor:'#884422',textSize:28,textOffsetX:16}}]
    const before=structuredClone({styles,styled})
    writeAnnotations(track.id,styled,env,layout,route,canvas,styles)
    expect(readArtStyles(track.id,env)).toEqual(styles)
    expect(readAnnotations(track.id,env)).toEqual(styled)
    expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({version:1,annotations:styled,layout,route,canvas,styles})
    const updated=[{...styled[0],label:'新山口'}]
    writeAnnotations(track.id,updated,env)
    expect(readArtStyles(track.id,env)).toEqual(styles)
    expect(readArtCanvasSize(track.id,env)).toEqual(canvas)
    expect(readArtLayout(track.id,env)).toEqual(layout)
    expect(readArtRouteTransform(track.id,env)).toEqual(route)
    expect(readAnnotations(track.id,env)).toEqual(updated)
    expect(readSource(track.id,env)!.body).toEqual(original)
    expect(readTrack(track.id,env)!.coordinates).toEqual(points)
    expect({styles,styled}).toEqual(before)
    expect(readdirSync(directory).some(name=>name.startsWith('.annotations-'))).toBe(false)
    writeAnnotations(track.id,updated,env,undefined,undefined,undefined,{})
    expect(readArtStyles(track.id,env)).toEqual({})
    expect(JSON.parse(readFileSync(path,'utf8')).styles).toEqual({})
    expect(readArtCanvasSize(track.id,env)).toEqual(canvas)
    writeAnnotations(track.id,updated,env)
    expect(JSON.parse(readFileSync(path,'utf8')).styles).toEqual({})
  })
  it('rejects invalid styles before any sidecar replacement and leaves no temporary files', () => {
    const {env,track,path,annotations,directory}=fixture()
    writeAnnotations(track.id,annotations,env,{end:{x:400,y:300}},{x:1,y:2,scale:1.5},{width:900,height:1200},styles)
    const before=readFileSync(path,'utf8')
    for (const invalid of [null,[],{unknown:1},{defaults:{textColor:'url(javascript:alert(1))'}},{defaults:{textSize:0}},{defaults:{textSize:'24'}},{defaults:{textOffsetX:Infinity}},{texts:{unknown:{textColor:'#ffffff'}}},{route:{width:-1}},{background:'url(file:///secret)'}]) {
      expect(()=>writeAnnotations(track.id,[{...annotations[0],label:'不得保存'}],env,{}, {x:0,y:0,scale:1},{width:1200,height:900},invalid)).toThrow()
      expect(readFileSync(path,'utf8')).toBe(before)
      expect(readdirSync(directory).some(name=>name.startsWith('.annotations-'))).toBe(false)
    }
    for (const invalid of [{textSize:0},{textColor:'invalid'},{textOffsetX:1001},{unknown:1}]) {
      expect(()=>writeAnnotations(track.id,[{...annotations[0],style:invalid}],env,undefined,undefined,undefined,styles)).toThrow()
      expect(readFileSync(path,'utf8')).toBe(before)
    }
    expect(readArtStyles(track.id,env)).toEqual(styles)
    expect(()=>readArtStyles('../../outside',env)).toThrow('轨迹不存在')
    expect(()=>writeAnnotations('../../outside',annotations,env,undefined,undefined,undefined,styles)).toThrow('轨迹不存在')
  })
  it('validates stored styles on read and refuses to silently overwrite corrupted style data', () => {
    const {env,track,path,annotations}=fixture()
    const corrupt=JSON.stringify({version:1,annotations,styles:{defaults:{textColor:'invalid'}}})
    writeFileSync(path,corrupt,'utf8')
    expect(()=>readArtStyles(track.id,env)).toThrow()
    expect(()=>writeAnnotations(track.id,annotations,env)).toThrow()
    expect(readFileSync(path,'utf8')).toBe(corrupt)
  })
  it('round trips styles through the real annotations HTTP endpoint with atomic invalid update rejection', async () => {
    const {home,env,track,path,annotations,points}=fixture(),previousHome=process.env.DSH_HOME,ctx=new Context()
    process.env.DSH_HOME=home
    try {
      await ctx.plugin(WebServer,{host:'127.0.0.1',port:0})
      await ctx.plugin(plugin)
      const base=`http://127.0.0.1:${String(ctx.webServer.port)}${API}/annotations`
      const get=()=>fetch(`${base}?id=${encodeURIComponent(track.id)}`)
      const post=(body:unknown,headers:Record<string,string>={'x-cqai-track':'1','content-type':'application/json'})=>fetch(base,{method:'POST',headers,body:JSON.stringify(body)})
      expect(await (await get()).json()).toMatchObject({annotations:[],saved:false,styles:{}})
      const styled=[{...annotations[0],style:{textColor:'#884422',textSize:28,textOffsetX:16}}]
      const saved=await post({id:track.id,annotations:styled,styles})
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({annotations:styled,styles})
      expect(await (await get()).json()).toMatchObject({annotations:styled,saved:true,styles})
      const updated=[{...styled[0],label:'只更新标注'}]
      expect(await (await post({id:track.id,annotations:updated})).json()).toMatchObject({annotations:updated,styles})
      const before=readFileSync(path,'utf8')
      expect((await post({id:track.id,annotations,styles:{defaults:{textSize:0}}})).status).toBe(400)
      expect(readFileSync(path,'utf8')).toBe(before)
      expect((await post({id:track.id,annotations,styles},{'content-type':'application/json'})).status).toBe(403)
      expect(readFileSync(path,'utf8')).toBe(before)
      expect(await (await get()).json()).toMatchObject({annotations:updated,saved:true,styles})
      expect(readSource(track.id,env)!.body.toString('utf8')).toBe('<gpx>原始内容</gpx>')
      expect(readTrack(track.id,env)!.coordinates).toEqual(points)
      expect(await (await post({id:track.id,annotations:updated,styles:{}})).json()).toMatchObject({styles:{}})
      expect(readArtStyles(track.id,env)).toEqual({})
    } finally {
      await ctx.fiber.dispose()
      if (previousHome===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME=previousHome
    }
  })
})
