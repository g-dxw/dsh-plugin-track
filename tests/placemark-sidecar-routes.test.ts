import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import * as plugin from '../src/index.ts'
import { trackDir } from '../src/artifacts.ts'
import { API, type TrackInput, type PlacemarkGroup } from '../src/protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-placemark-routes-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})

const input: TrackInput = {
  name: '点位调整', filename: 'legacy.kml',
  source: '<?xml version="1.0"?>\r\n<kml><Document><name>保留原始名称</name></Document></kml>\r\n',
  points: [[120, 30, 100, null], [120.01, 30.01, 120, null]],
  metrics: {distance: 1000, elevationGain: 20, elevationLoss: 0, duration: 0, elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.01, 30.01]},
}

async function withServer(run: (base: string, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-placemark-routes-'))
  roots.push(home)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  try {
    await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0})
    await ctx.plugin(plugin)
    await run(`http://127.0.0.1:${ctx.webServer.port}${API}`, home)
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

function send(base: string, action: string, body?: unknown, method?: string) {
  return fetch(`${base}/${action}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {'x-cqai-track': '1', 'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
function fieldDocument(dir: string, field: 'order' | 'edits' | 'groups') {
  return {version: 1, [field]: JSON.parse(readFileSync(join(dir, 'placemark-state.json'), 'utf8'))[field]}
}
function fieldBytes(dir: string, field: 'order' | 'edits' | 'groups') {return Buffer.from(JSON.stringify(fieldDocument(dir, field)))}

describe('placemark sidecar HTTP routes', () => {
  it('saves and deletes route-bound points atomically, rejects stale revisions, exposes changes through old reads and preserves the imported file', async () => withServer(async (base, home) => {
    const timed = {...input, points: [[120, 30, 100, 1000], [120.01, 30.01, 120, 3000]], segmentStarts: [0]}
    const {id} = await (await send(base, 'tracks', timed)).json(), dir = trackDir(id, {DSH_HOME: home})
    const track = readFileSync(join(dir, 'track.json')), source = readFileSync(join(dir, 'source.kml'))
    expect(JSON.parse(track.toString()).segmentStarts).toEqual([0])
    const initial = await send(base, `placemark-state?id=${id}`)
    expect(initial.status).toBe(200); expect(initial.headers.get('cache-control')).toBe('no-store')
    const {state} = await initial.json()
    expect(state).toEqual({version: 1, revision: 0, added: [], deletedIds: [], edits: [], order: null, groups: [], routeContext: null})
    expect(existsSync(join(dir, 'placemark-state.json'))).toBe(false)
    const point = {id: 'local-00000000-0000-0000-0000-000000000001', name: '沿途照片', description: '', images: ['https://photos.example/a.jpg'], coordinates: [0, 0], elevation: 0, time: null, timeSource: 'unknown', type: ['风景点', '打卡点'], routePosition: {startIndex: 0, endIndex: 1, fraction: .5}}
    const save = await send(base, 'placemark-state', {id, revision: 0, data: {...state, routeContext: {segmentStarts: [0], references: []}, added: [point], order: [point.id]}})
    expect(save.status).toBe(200)
    const {state: created} = await save.json()
    expect(created).toMatchObject({revision: 1, added: [{elevation: 110, time: 2000, timeSource: 'track', type: ['风景点', '打卡点']}]})
    expect(created.added[0].coordinates[0]).toBeCloseTo(120.005, 8); expect(created.added[0].coordinates[1]).toBeCloseTo(30.005, 8)
    const previous = readFileSync(join(dir, 'placemark-state.json'))
    const conflict = await send(base, 'placemark-state', {id, revision: 0, data: state})
    expect(conflict.status).toBe(409); expect((await conflict.json()).error).toContain('409')
    expect(readFileSync(join(dir, 'placemark-state.json'))).toEqual(previous)
    const bad = await send(base, 'placemark-state', {id, revision: 1, data: {...created, added: [{...point, routePosition: {startIndex: 0, endIndex: 1, fraction: 2}}]}})
    expect(bad.status).toBe(400); expect(readFileSync(join(dir, 'placemark-state.json'))).toEqual(previous)
    expect(await (await send(base, `placemark-order?id=${id}`)).json()).toEqual({order: [point.id]})
    const removed = await send(base, 'placemark-state', {id, revision: 1, data: {...created, added: [], order: null}})
    expect(removed.status).toBe(200); expect((await removed.json()).state).toMatchObject({revision: 2, added: [], order: null})
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect(await (await send(base, `source?id=${id}`)).text()).toBe(input.source)
  }), 30000)
  it('locks corrupt canonical states across new and old interfaces and validates persisted segment boundaries', async () => withServer(async (base, home) => {
    for (const segmentStarts of [[], [1], [0, 0], [0, 2], [0, .5]]) expect((await send(base, 'tracks', {...input, segmentStarts})).status).toBe(400)
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home})
    writeFileSync(join(dir, 'placemark-state.json'), '{broken')
    for (const action of ['placemark-state', 'placemark-order', 'placemark-edits', 'placemark-groups']) expect((await send(base, `${action}?id=${id}`)).status).toBe(400)
    for (const [action, body] of [['placemark-state', {id, revision: 0, data: {added: [], deletedIds: [], edits: [], order: null, groups: [], routeContext: null}}], ['placemark-edits', {id, edits: []}], ['placemark-order', {id, order: null}], ['placemark-groups', {id, groups: []}]] as const) expect((await send(base, action, body)).status).toBe(400)
    expect(readFileSync(join(dir, 'placemark-state.json'), 'utf8')).toBe('{broken')
  }), 30000)
  it('persists group references and moves or dissolves groups without rewriting child edits, order or source',async()=>withServer(async(base,home)=>{
    const {id}=await (await send(base,'tracks',input)).json()
    const dir=trackDir(id,{DSH_HOME:home}),track=readFileSync(join(dir,'track.json')),source=readFileSync(join(dir,'source.kml'))
    expect(JSON.parse(track.toString())).not.toHaveProperty('placemarks')
    const initial=await send(base,`placemark-groups?id=${id}`)
    expect(initial.status).toBe(200);expect(initial.headers.get('cache-control')).toBe('no-store')
    expect(await initial.json()).toEqual({groups:[]})
    expect(existsSync(join(dir,'placemark-groups.json'))).toBe(false)
    const edits=[{id:'restored-1',hidden:true,name:'已修改子点',images:['https://photos.example/a.jpg'],type:['风景点','营地']}],order=['restored-2','restored-1']
    await send(base,'placemark-edits',{id,edits});await send(base,'placemark-order',{id,order})
    const editsBytes=fieldBytes(dir, 'edits'),orderBytes=fieldBytes(dir, 'order')
    const group:PlacemarkGroup={id:'group-00000000-0000-0000-0000-000000000001',name:'组合景点',description:'保留说明',memberIds:['restored-1','restored-2'],coordinates:[120.005,30.005],cover:{pointId:'restored-1',imageUrl:' https://photos.example/a.jpg '},hidden:false}
    const normalized={...group,cover:{pointId:'restored-1',imageUrl:'https://photos.example/a.jpg'}}
    const save=await send(base,'placemark-groups',{id,groups:[group]})
    expect(save.status).toBe(200);expect(await save.json()).toEqual({groups:[normalized]})
    expect(await (await send(base,`placemark-groups?id=${id}`)).json()).toEqual({groups:[normalized]})
    expect(fieldDocument(dir, 'groups')).toEqual({version:1,groups:[normalized]})
    const previous=fieldBytes(dir, 'groups')
    for(const body of [null,{}, {id}, {id:42,groups:[]}, {id,groups:null}, {id,groups:[{...group,name:42}]}, {id,groups:[{...group,coordinates:[120,'30']}]}, {id,groups:[{...group,memberIds:[]}]}, {id,groups:[group,{...group,id:'group-00000000-0000-0000-0000-000000000002'}]}, {id,groups:[{...group,cover:{pointId:'restored-2',imageUrl:'javascript:alert(1)'}}]}]) {
      expect((await send(base,'placemark-groups',body)).status).toBe(400)
      expect(fieldBytes(dir, 'groups')).toEqual(previous)
    }
    const moved={...normalized,coordinates:[120.008,30] as [number,number],memberIds:['restored-1']}
    expect(await (await send(base,'placemark-groups',{id,groups:[moved]})).json()).toEqual({groups:[moved]})
    expect(await (await send(base,'placemark-groups',{id,groups:[]})).json()).toEqual({groups:[]})
    expect(await (await send(base,`placemark-groups?id=${id}`)).json()).toEqual({groups:[]})
    expect(fieldBytes(dir, 'edits')).toEqual(editsBytes)
    expect(fieldBytes(dir, 'order')).toEqual(orderBytes)
    expect(readFileSync(join(dir,'track.json'))).toEqual(track)
    expect(readFileSync(join(dir,'source.kml'))).toEqual(source)
    await send(base,'placemark-groups',{id,groups:[normalized]})
    await send(base,`track?id=${id}`,undefined,'DELETE')
    expect(existsSync(dir)).toBe(false)
    expect((await send(base,`placemark-groups?id=${id}`)).status).toBe(400)
    expect((await send(base,'placemark-groups',{id,groups:[]})).status).toBe(400)
  }),30000)

  it('round-trips both type formats, validates multi-select limits and persists explicit clearing', async () => withServer(async (base, home) => {
    const {id} = await (await send(base,'tracks',input)).json()
    const dir=trackDir(id,{DSH_HOME:home})
    const track=readFileSync(join(dir,'track.json'))
    const source=readFileSync(join(dir,'source.kml'))
    const legacy=[{id:'kml-1',name:'原有名称',description:'保留说明',type:'  旧自定义类型  ',coordinates:[120.005,30.005],elevation:110,images:['https://photos.example/a.jpg'],hidden:true}]
    const oldSave=await send(base,'placemark-edits',{id,edits:legacy})
    expect(oldSave.status).toBe(200)
    expect(await oldSave.json()).toEqual({edits:legacy})
    const normalized=[{...legacy[0],type:['风景点','补给点']}]
    const saved=await send(base,'placemark-edits',{id,edits:[{...legacy[0],type:[' 风景点 ','补给点','风景点']}]})
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({edits:normalized})
    expect(await (await send(base,`placemark-edits?id=${id}`)).json()).toEqual({edits:normalized})
    expect(fieldDocument(dir, 'edits')).toEqual({version:1,edits:normalized})
    const bytes=fieldBytes(dir, 'edits')
    for (const type of [42,null,{},[''],['  '],[42],[['nested']],['类'.repeat(65)],Array.from({length:21},()=> '重复')]) {
      expect((await send(base,'placemark-edits',{id,edits:[{...legacy[0],type}]})).status).toBe(400)
      expect(fieldBytes(dir, 'edits')).toEqual(bytes)
    }
    const maximum=[{...legacy[0],type:Array.from({length:20},(_,index)=>`标签${index}`)}]
    const maxSave=await send(base,'placemark-edits',{id,edits:maximum})
    expect(maxSave.status).toBe(200)
    expect(await maxSave.json()).toEqual({edits:maximum})
    const cleared=[{...legacy[0],type:[]}]
    const clearSave=await send(base,'placemark-edits',{id,edits:cleared})
    expect(clearSave.status).toBe(200)
    expect(await clearSave.json()).toEqual({edits:cleared})
    expect(await (await send(base,`placemark-edits?id=${id}`)).json()).toEqual({edits:cleared})
    expect(fieldDocument(dir, 'edits')).toEqual({version:1,edits:cleared})
    expect(readFileSync(join(dir,'track.json'))).toEqual(track)
    expect(readFileSync(join(dir,'source.kml'))).toEqual(source)
  }),30000)

  it('persists point information, clearing and visibility through the existing version 1 endpoint', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json()
    const dir = trackDir(id, {DSH_HOME:home})
    const track = readFileSync(join(dir, 'track.json'))
    const source = readFileSync(join(dir, 'source.kml'))
    const old = [{id:'kml-1', coordinates:[120.005,30.005], elevation:110, images:['https://photos.example/a.jpg']}]
    expect((await send(base, 'placemark-edits', {id, edits:old})).status).toBe(200)
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits:old})
    const edits = [{...old[0], name:'', description:'\n'+'说'.repeat(9998)+'\n', type:'自定义补给点', hidden:true}]
    const saved = await send(base, 'placemark-edits', {id, edits})
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({edits})
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits})
    const cleared = [{...edits[0], description:'', type:'', hidden:false}]
    expect(await (await send(base, 'placemark-edits', {id, edits:cleared})).json()).toEqual({edits:cleared})
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits:cleared})
    for(const change of [{name:null}, {description:'说'.repeat(10001)}, {type:['a',42]}, {hidden:0}]) {
      expect((await send(base, 'placemark-edits', {id, edits:[{...cleared[0],...change}]})).status).toBe(400)
    }
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits:cleared})
    expect(fieldDocument(dir, 'edits')).toEqual({version:1, edits:cleared})
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track)
    expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect(await (await send(base, `source?id=${id}`)).text()).toBe(input.source)
  }), 30000)

  it('saves manual order, photo transfers and marker corrections independently while preserving original bytes', async () => withServer(async (base, home) => {
    const response = await send(base, 'tracks', input)
    expect(response.status).toBe(201)
    const {id} = await response.json()
    const dir = trackDir(id, {DSH_HOME: home})
    const track = readFileSync(join(dir, 'track.json'))
    const source = readFileSync(join(dir, 'source.kml'))
    expect(JSON.parse(track.toString())).not.toHaveProperty('placemarks')
    expect(await (await send(base, `placemark-order?id=${id}`)).json()).toEqual({order: null})
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits: []})

    const order = ['kml-2', 'kml-1']
    const savedOrder = await send(base, 'placemark-order', {id, order})
    expect(savedOrder.status).toBe(200)
    expect(savedOrder.headers.get('cache-control')).toBe('no-store')
    expect(await savedOrder.json()).toEqual({order})
    expect(await (await send(base, `placemark-order?id=${id}`)).json()).toEqual({order})

    const edits = [{id: 'kml-1', images: []}, {id: 'kml-2', coordinates: [120.005, 30.005], elevation: 110,
      images: ['https://photos.example/a.jpg', 'https://photos.example/b.jpg']}]
    const savedEdits = await send(base, 'placemark-edits', {id, edits})
    expect(savedEdits.status).toBe(200)
    expect(await savedEdits.json()).toEqual({edits})
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits})
    expect(await (await send(base, `placemark-order?id=${id}`)).json()).toEqual({order})

    expect(await (await send(base, 'placemark-order', {id, order: null})).json()).toEqual({order: null})
    expect(existsSync(join(dir, 'placemark-order.json'))).toBe(false)
    expect(await (await send(base, `placemark-order?id=${id}`)).json()).toEqual({order: null})
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits})
    expect(await (await send(base, `source?id=${id}`)).text()).toBe(input.source)
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track)
    expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])

    await send(base, 'placemark-order', {id, order})
    expect((await send(base, `track?id=${id}`, undefined, 'DELETE')).status).toBe(200)
    expect(existsSync(dir)).toBe(false)
    expect((await send(base, `placemark-order?id=${id}`)).status).toBe(400)
    expect((await send(base, `placemark-edits?id=${id}`)).status).toBe(400)
    expect((await send(base, 'placemark-edits', {id, edits})).status).toBe(400)
    expect(existsSync(dir)).toBe(false)
  }), 30000)

  it('rejects invalid bodies, unknown tracks and foreign origins without changing saved batches', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json()
    const dir = trackDir(id, {DSH_HOME: home})
    const order = ['kml-1', 'kml-2']
    const edits = [{id: 'kml-1', images: ['https://photos.example/a.jpg']}, {id: 'kml-2', images: []}]
    await send(base, 'placemark-order', {id, order})
    await send(base, 'placemark-edits', {id, edits})
    const beforeOrder = fieldBytes(dir, 'order')
    const beforeEdits = fieldBytes(dir, 'edits')

    for (const body of [null, {}, {id: 42, order}, {id}, {id, order: 'kml-1'}, {id, order: ['same', 'same']}, {id, order: ['']}, {id, order: ['a'.repeat(201)]}]) {
      expect((await send(base, 'placemark-order', body)).status).toBe(400)
    }
    for (const body of [null, {}, {id: 42, edits}, {id}, {id, edits: null}, {id, edits: [{id: 'kml-1', images: []}, {id: 'kml-2', images: ['data:image/png;base64,eA==']}]},
      {id, edits: [{id: 'kml-1', images: []}, {id: 'kml-2', coordinates: [120, 91]}]}]) {
      expect((await send(base, 'placemark-edits', body)).status).toBe(400)
    }
    for (const badId of ['missing', '../../outside', '..\\outside']) {
      const encoded = encodeURIComponent(badId)
      expect((await send(base, `placemark-order?id=${encoded}`)).status).toBe(400)
      expect((await send(base, `placemark-edits?id=${encoded}`)).status).toBe(400)
      expect((await send(base, `placemark-groups?id=${encoded}`)).status).toBe(400)
      expect((await send(base, 'placemark-order', {id: badId, order})).status).toBe(400)
      expect((await send(base, 'placemark-edits', {id: badId, edits})).status).toBe(400)
      expect((await send(base, 'placemark-groups', {id: badId, groups:[]})).status).toBe(400)
    }
    for (const action of ['placemark-order', 'placemark-edits','placemark-groups']) {
      expect((await fetch(`${base}/${action}?id=${id}`, {headers: {origin: 'https://evil.example'}})).status).toBe(403)
      expect((await fetch(`${base}/${action}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id})})).status).toBe(403)
      expect((await fetch(`${base}/${action}`, {method: 'POST', headers: {'x-cqai-track': '1', origin: 'https://evil.example'}, body: JSON.stringify({id})})).status).toBe(403)
    }
    expect(fieldBytes(dir, 'order')).toEqual(beforeOrder)
    expect(fieldBytes(dir, 'edits')).toEqual(beforeEdits)
    expect(await (await send(base, `placemark-order?id=${id}`)).json()).toEqual({order})
    expect(await (await send(base, `placemark-edits?id=${id}`)).json()).toEqual({edits})
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  }), 30000)
})
