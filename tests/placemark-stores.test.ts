import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readTrack, removeTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { readPlacemarkOrder, writePlacemarkOrder } from '../src/placemark-order-store.ts'
import { readPlacemarkEdits, writePlacemarkEdits } from '../src/placemark-edits-store.ts'
import { readPlacemarkGroups, writePlacemarkGroups } from '../src/placemark-groups-store.ts'
import { readPlacemarkState } from '../src/placemark-state-store.ts'
import type { TrackInput, PlacemarkGroup } from '../src/protocol.ts'

const writes = vi.hoisted(() => ({failRename: false}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (writes.failRename) throw new Error('rename blocked')
    return fs.renameSync(...args)
  }}
})

const roots: string[] = []
afterEach(() => {
  writes.failRename = false
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-placemark-store-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})

const input: TrackInput = {
  name: '标注原文件', filename: 'original.kml',
  source: '<?xml version="1.0"?><kml><Document><name>原始轨迹</name></Document></kml>\r\n',
  points: [[120, 30, 100, null], [120.01, 30.01, 120, null]],
  metrics: {distance: 1000, elevationGain: 20, elevationLoss: 0, duration: 0, elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.01, 30.01]},
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-placemark-store-'))
  roots.push(home)
  const env = {DSH_HOME: home}
  const {id} = writeTrack(input, env)
  const dir = trackDir(id, env)
  const track = readFileSync(join(dir, 'track.json'))
  const source = readFileSync(join(dir, 'source.kml'))
  const unchanged = () => {
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track)
    expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  }
  return {id, env, dir, unchanged}
}
function fieldDocument(dir: string, field: 'order' | 'edits' | 'groups') {
  return {version: 1, [field]: JSON.parse(readFileSync(join(dir, 'placemark-state.json'), 'utf8'))[field]}
}
function fieldBytes(dir: string, field: 'order' | 'edits' | 'groups') {return Buffer.from(JSON.stringify(fieldDocument(dir, field)))}

describe('placemark order sidecar', () => {
  it('defaults to time order and persists recovered IDs without rewriting the track or source', () => {
    const {id, env, dir, unchanged} = fixture()
    expect(readTrack(id, env)).not.toHaveProperty('placemarks')
    expect(readPlacemarkOrder(id, env)).toBeNull()
    expect(existsSync(join(dir, 'placemark-order.json'))).toBe(false)
    const order = ['kml-3', 'kml-1', 'kml-2']
    expect(writePlacemarkOrder(id, order, env)).toEqual(order)
    expect(readPlacemarkOrder(id, env)).toEqual(order)
    expect(fieldDocument(dir, 'order')).toEqual({version: 1, order})
    expect(writePlacemarkOrder(id, [], env)).toEqual([])
    expect(readPlacemarkOrder(id, env)).toEqual([])
    unchanged()
  })

  it('resets only the order sidecar and is safe to reset repeatedly', () => {
    const {id, env, dir, unchanged} = fixture()
    writePlacemarkOrder(id, ['kml-2', 'kml-1'], env)
    const edits = [{id: 'kml-1', images: ['https://photos.example/a.jpg']}]
    writePlacemarkEdits(id, edits, env)
    expect(writePlacemarkOrder(id, null, env)).toBeNull()
    expect(writePlacemarkOrder(id, null, env)).toBeNull()
    expect(readPlacemarkOrder(id, env)).toBeNull()
    expect(existsSync(join(dir, 'placemark-order.json'))).toBe(false)
    expect(readPlacemarkEdits(id, env)).toEqual(edits)
    unchanged()
  })

  it('accepts the maximum count and exact ID strings without requiring metadata membership', () => {
    const {id, env, unchanged} = fixture()
    const order = Array.from({length: 10000}, (_, index) => `recovered-${index}`)
    order[0] = '名'.repeat(200)
    order[1] = '  recovered-id  '
    expect(writePlacemarkOrder(id, order, env)).toEqual(order)
    expect(readPlacemarkOrder(id, env)).toEqual(order)
    unchanged()
  })

  it('rejects invalid replacement orders before touching the saved order', () => {
    const {id, env, dir, unchanged} = fixture()
    const previous = ['kml-2', 'kml-1']
    writePlacemarkOrder(id, previous, env)
    const bytes = fieldBytes(dir, 'order')
    for (const invalid of [undefined, {}, 'kml-1', [1], [''], [' \t '], ['a'.repeat(201)], ['same', 'same'], Array.from({length: 10001}, (_, index) => String(index))]) {
      expect(() => writePlacemarkOrder(id, invalid, env)).toThrow()
      expect(fieldBytes(dir, 'order')).toEqual(bytes)
    }
    expect(readPlacemarkOrder(id, env)).toEqual(previous)
    unchanged()
  })

  it('keeps the complete old order if atomic replacement fails and cleans its temporary file', () => {
    const {id, env, unchanged} = fixture()
    writePlacemarkOrder(id, ['kml-1', 'kml-2'], env)
    writes.failRename = true
    expect(() => writePlacemarkOrder(id, ['kml-2', 'kml-1'], env)).toThrow('rename blocked')
    expect(readPlacemarkOrder(id, env)).toEqual(['kml-1', 'kml-2'])
    unchanged()
  })

  it('rejects corrupt or unsupported sidecar documents and allows reset recovery', () => {
    for (const raw of ['{', 'null', JSON.stringify({version: 2, order: []}), JSON.stringify({version: 1}), JSON.stringify({version: 1, order: ['same', 'same']})]) {
      const {id, env, dir, unchanged} = fixture(), path = join(dir, 'placemark-order.json')
      writeFileSync(path, raw)
      expect(() => readPlacemarkOrder(id, env)).toThrow()
      expect(writePlacemarkOrder(id, null, env)).toBeNull()
      expect(readPlacemarkOrder(id, env)).toBeNull()
      expect(readFileSync(path, 'utf8')).toBe(raw)
      unchanged()
    }
  })
})

describe('placemark edits sidecar', () => {
  const photo1 = 'https://photos.example/a.jpg'
  const photo2 = 'https://photos.example/b.jpg'
  const original = [{id: 'kml-1', images: [photo1, photo2]}, {id: 'kml-2', images: []}]
  const moved = [{id: 'kml-1', images: []}, {id: 'kml-2', images: [photo1, photo2], coordinates: [120.005, 30.005] as [number, number], elevation: 110}]

  it('reads existing version 1 edits and saves point information and visibility without rewriting source', () => {
    const {id, env, dir, unchanged} = fixture()
    const path = join(dir, 'placemark-edits.json')
    writeFileSync(path, JSON.stringify({version:1, edits:moved}))
    expect(readPlacemarkEdits(id, env)).toEqual(moved)
    const next = [{...moved[0], name:'', description:'', type:'', hidden:false},
      {...moved[1], name:'补给点', description:'说'.repeat(10000), type:'自定义标签', hidden:true}]
    expect(writePlacemarkEdits(id, next, env)).toEqual(next)
    expect(readPlacemarkEdits(id, env)).toEqual(next)
    expect(fieldDocument(dir, 'edits')).toEqual({version:1, edits:next})
    const bytes = fieldBytes(dir, 'edits')
    for (const field of [{name:null}, {description:'说'.repeat(10001)}, {type:['a',42]}, {hidden:'false'}]) {
      expect(() => writePlacemarkEdits(id, [{...next[0],...field},next[1]], env)).toThrow()
      expect(fieldBytes(dir, 'edits')).toEqual(bytes)
    }
    unchanged()
  })

  it('round-trips legacy strings, normalized multi-select arrays and explicit clearing in version 1', () => {
    const {id, env, dir, unchanged} = fixture()
    const path = join(dir, 'placemark-edits.json')
    const legacy = [{...moved[1],type:'  旧自定义标签  ',name:'补给点',hidden:true}]
    writeFileSync(path, JSON.stringify({version:1,edits:legacy}))
    expect(readPlacemarkEdits(id,env)).toEqual(legacy)
    const next = [{...legacy[0],type:[' 风景点 ','补给点','风景点','营地']}]
    const normalized = [{...legacy[0],type:['风景点','补给点','营地']}]
    expect(writePlacemarkEdits(id,next,env)).toEqual(normalized)
    expect(readPlacemarkEdits(id,env)).toEqual(normalized)
    expect(fieldDocument(dir, 'edits')).toEqual({version:1,edits:normalized})
    const previousBytes=fieldBytes(dir, 'edits')
    for (const type of [21,null,[''],[' \t '],[['nested']],['类'.repeat(65)],Array.from({length:21},()=> '重复')]) {
      expect(() => writePlacemarkEdits(id,[{...next[0],type}],env)).toThrow()
      expect(fieldBytes(dir, 'edits')).toEqual(previousBytes)
    }
    const cleared=[{...legacy[0],type:[]}]
    expect(writePlacemarkEdits(id,cleared,env)).toEqual(cleared)
    expect(readPlacemarkEdits(id,env)).toEqual(cleared)
    expect(fieldDocument(dir, 'edits')).toEqual({version:1,edits:cleared})
    const oldClear=[{...legacy[0],type:''}]
    expect(writePlacemarkEdits(id,oldClear,env)).toEqual(oldClear)
    expect(readPlacemarkEdits(id,env)).toEqual(oldClear)
    unchanged()
  })

  it('persists both sides of a multi-photo transfer and a position correction in one batch', () => {
    const {id, env, dir, unchanged} = fixture()
    expect(readTrack(id, env)).not.toHaveProperty('placemarks')
    expect(readPlacemarkEdits(id, env)).toEqual([])
    expect(existsSync(join(dir, 'placemark-edits.json'))).toBe(false)
    expect(writePlacemarkEdits(id, original, env)).toEqual(original)
    expect(writePlacemarkEdits(id, moved, env)).toEqual(moved)
    expect(readPlacemarkEdits(id, env)).toEqual(moved)
    expect(fieldDocument(dir, 'edits')).toEqual({version: 1, edits: moved})
    expect(writePlacemarkEdits(id, [{id: 'kml-2', coordinates: [120, 30], elevation: null, images: []}], env)).toEqual([{id: 'kml-2', coordinates: [120, 30], elevation: null, images: []}])
    expect(writePlacemarkEdits(id, [], env)).toEqual([])
    expect(readPlacemarkEdits(id, env)).toEqual([])
    unchanged()
  })

  it('validates the complete replacement before saving either side of a photo transfer', () => {
    const {id, env, dir, unchanged} = fixture()
    writePlacemarkEdits(id, original, env)
    const bytes = fieldBytes(dir, 'edits')
    const invalidValues = [undefined, null, {}, [{id: 'kml-1'}, {id: 'kml-1'}],
      [{id: 'kml-1', images: []}, {id: 'kml-2', images: ['javascript:alert(1)']}],
      [{id: 'kml-1', images: []}, {id: 'kml-2', coordinates: [181, 30]}],
      [{id: 'kml-1', images: []}, {id: 'kml-2', coordinates: [120, Number.NaN]}],
      [{id: 'kml-1', images: []}, {id: 'kml-2', elevation: Infinity}],
    ]
    for (const value of invalidValues) {
      expect(() => writePlacemarkEdits(id, value, env)).toThrow()
      expect(fieldBytes(dir, 'edits')).toEqual(bytes)
      expect(readPlacemarkEdits(id, env)).toEqual(original)
    }
    unchanged()
  })

  it('keeps both photo assignments intact when replacement fails and removes the temporary file', () => {
    const {id, env, unchanged} = fixture()
    writePlacemarkEdits(id, original, env)
    writes.failRename = true
    expect(() => writePlacemarkEdits(id, moved, env)).toThrow('rename blocked')
    expect(readPlacemarkEdits(id, env)).toEqual(original)
    unchanged()
  })

  it('rejects unreadable schemas and permits recovery by saving a valid complete batch', () => {
    for (const raw of ['{', 'null', JSON.stringify({version: 2, edits: []}), JSON.stringify({version: 1}), JSON.stringify({version: 1, edits: [{id: 'kml-1', coordinates: [300, 30]}]})]) {
      const {id, env, dir, unchanged} = fixture(), path = join(dir, 'placemark-edits.json')
      writeFileSync(path, raw)
      expect(() => readPlacemarkEdits(id, env)).toThrow()
      writePlacemarkEdits(id, original, env)
      expect(readPlacemarkEdits(id, env)).toEqual(original)
      expect(readFileSync(path, 'utf8')).toBe(raw)
      unchanged()
    }
  })
})

describe('sidecar track boundaries', () => {
  it('rejects missing and traversal IDs before creating any sidecar', () => {
    const {env, dir, unchanged} = fixture()
    for (const id of ['', 'missing', '../outside', '..\\outside', '/outside']) {
      expect(() => readPlacemarkOrder(id, env)).toThrow('轨迹不存在')
      expect(() => writePlacemarkOrder(id, ['kml-1'], env)).toThrow('轨迹不存在')
      expect(() => readPlacemarkEdits(id, env)).toThrow('轨迹不存在')
      expect(() => writePlacemarkEdits(id, [{id: 'kml-1'}], env)).toThrow('轨迹不存在')
      expect(() => readPlacemarkGroups(id,env)).toThrow('轨迹不存在')
      expect(() => writePlacemarkGroups(id,[],env)).toThrow('轨迹不存在')
    }
    expect(readdirSync(dir).sort()).toEqual(['source.kml', 'track.json'])
    unchanged()
  })

  it('removes both sidecars with the track and prevents later writes from recreating it', () => {
    const {id, env, dir} = fixture()
    writePlacemarkOrder(id, ['kml-1'], env)
    writePlacemarkEdits(id, [{id: 'kml-1', images: []}], env)
    writePlacemarkGroups(id,[{id:'group-00000000-0000-0000-0000-000000000001',name:'组',description:'',coordinates:[120,30],memberIds:['legacy-id']}],env)
    expect(removeTrack(id, env)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(() => writePlacemarkOrder(id, ['kml-1'], env)).toThrow('轨迹不存在')
    expect(() => writePlacemarkEdits(id, [], env)).toThrow('轨迹不存在')
    expect(() => readPlacemarkGroups(id,env)).toThrow('轨迹不存在')
    expect(() => writePlacemarkGroups(id,[],env)).toThrow('轨迹不存在')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('placemark groups sidecar',()=>{
  const group:PlacemarkGroup={id:'group-00000000-0000-0000-0000-000000000001',name:'山景组',description:'组说明',coordinates:[120.005,30.005],memberIds:['legacy-1','legacy-2'],cover:{pointId:'legacy-2',imageUrl:'https://photos.example/b.jpg'}}
  it('defaults to no groups and persists recovered members independently from child edits and order',()=>{
    const {id,env,dir,unchanged}=fixture()
    expect(readPlacemarkGroups(id,env)).toEqual([])
    expect(existsSync(join(dir,'placemark-groups.json'))).toBe(false)
    expect(readTrack(id,env)).not.toHaveProperty('placemarks')
    writePlacemarkEdits(id,[{id:'legacy-1',hidden:true,type:['风景点','营地'],name:'保留子点'}],env)
    writePlacemarkOrder(id,['legacy-2','legacy-1'],env)
    const editsBytes=fieldBytes(dir, 'edits'),orderBytes=fieldBytes(dir, 'order')
    expect(writePlacemarkGroups(id,[group],env)).toEqual([group])
    expect(readPlacemarkGroups(id,env)).toEqual([group])
    expect(fieldDocument(dir, 'groups')).toEqual({version:1,groups:[group]})
    const moved={...group,coordinates:[120.008,30] as [number,number]}
    expect(writePlacemarkGroups(id,[moved],env)).toEqual([moved])
    expect(writePlacemarkGroups(id,[],env)).toEqual([])
    expect(readPlacemarkGroups(id,env)).toEqual([])
    expect(fieldBytes(dir, 'edits')).toEqual(editsBytes)
    expect(fieldBytes(dir, 'order')).toEqual(orderBytes)
    unchanged()
  })
  it('rejects the entire replacement before changing saved membership or cover',()=>{
    const {id,env,dir,unchanged}=fixture()
    writePlacemarkGroups(id,[group],env)
    const bytes=fieldBytes(dir, 'groups')
    for(const value of [undefined,null,{},[group,{...group,id:'group-00000000-0000-0000-0000-000000000002'}],[{...group,coordinates:[180.1,30]}],[{...group,memberIds:[]}],[{...group,hidden:'true'}],[{...group,cover:{pointId:'legacy-3',imageUrl:'https://photos.example/b.jpg'}}]]) {
      expect(()=>writePlacemarkGroups(id,value,env)).toThrow()
      expect(fieldBytes(dir, 'groups')).toEqual(bytes)
    }
    expect(readPlacemarkGroups(id,env)).toEqual([group])
    unchanged()
  })
  it('keeps the complete old group when atomic replacement fails and cleans the temporary file',()=>{
    const {id,env,unchanged}=fixture()
    writePlacemarkGroups(id,[group],env)
    writes.failRename=true
    expect(()=>writePlacemarkGroups(id,[{...group,name:'未保存'}],env)).toThrow('rename blocked')
    expect(readPlacemarkGroups(id,env)).toEqual([group])
    unchanged()
  })
  it('rejects corrupt sidecars and recovers by saving a valid complete batch',()=>{
    for(const raw of ['{','null',JSON.stringify({version:2,groups:[]}),JSON.stringify({version:1}),JSON.stringify({version:1,groups:[{...group,memberIds:[]}]})]) {
      const {id,env,dir,unchanged}=fixture(),path=join(dir,'placemark-groups.json')
      writeFileSync(path,raw)
      expect(()=>readPlacemarkGroups(id,env)).toThrow()
      expect(writePlacemarkGroups(id,[group],env)).toEqual([group])
      expect(readPlacemarkGroups(id,env)).toEqual([group])
      expect(readFileSync(path,'utf8')).toBe(raw)
      unchanged()
    }
  })
})
