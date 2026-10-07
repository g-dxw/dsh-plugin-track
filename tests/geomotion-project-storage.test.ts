import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readSource, removeTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { GeoMotionProjectConflictError, readGeoMotionProject, writeGeoMotionProject } from '../src/geomotion-project-store.ts'
import { GEOMOTION_PROJECT_SCHEMA, type GeoMotionProjectInput } from '../src/track/geomotion-project-types.ts'
import * as plugin from '../src/index.ts'
import { API, type TrackInput } from '../src/protocol.ts'

const faults = vi.hoisted(() => ({rename: false, write: false, collision: false}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (faults.rename) throw new Error('rename blocked')
    return fs.renameSync(...args)
  }, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (faults.write && String(args[0]).includes('.geomotion-project-')) throw new Error('write blocked')
    if (faults.collision && String(args[0]).includes('.geomotion-project-')) {
      fs.writeFileSync(args[0], 'unowned colliding temporary')
      throw Object.assign(new Error('temporary collision'), {code: 'EEXIST'})
    }
    return fs.writeFileSync(...args)
  }}
})
const roots: string[] = []
afterEach(() => {
  faults.rename = false
  faults.write = false
  faults.collision = false
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-geomotion-project-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})
const input: TrackInput = {
  name: '真实轨迹', filename: 'source.kml', source: '<kml>源文件不变</kml>\r\n',
  points: [[120, 30, 100, 1000], [120.01, 30.01, 120, 3000]], segmentStarts: [0],
  metrics: {distance: 1000, elevationGain: 20, elevationLoss: 0, duration: 2000, elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.01, 30.01]},
}
function document(): Record<string, unknown> {
  return {
    format: 7, name: '轨迹片头', duration: 12, fps: 30, width: 1280, height: 720,
    basemap: 'dark', terrain: true, terrainExaggeration: 1, background: '#111111', contexts: [], story: [],
    nodes: {
      camera: {id: 'camera', type: 'camera', name: '相机', parentId: null, order: 'a0', behaviours: {}, tracks: {
        center: {kind: 'static', value: [120, 30]}, zoom: {kind: 'keyframed', keys: [{id: 'first', t: 0, value: 12, easing: 'linear'}, {id: 'last', t: 12, value: 14, easing: 'easeInOut'}]}, bearing: {kind: 'static', value: 0}, pitch: {kind: 'static', value: 45},
      }},
      marker: {id: 'marker', type: 'marker', name: '地名', parentId: null, order: 'a1', visible: true, in: 0, out: 12, fade: .3, coord: [120, 30], label: '真实地名'},
    },
  }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-geomotion-project-')); roots.push(home)
  const env = {DSH_HOME: home}, {id} = writeTrack(input, env), dir = trackDir(id, env)
  writeFileSync(join(dir, 'placemark-state.json'), '{"version":1,"revision":5,"label":"已编辑地名"}')
  const originals = ['source.kml', 'track.json', 'placemark-state.json'].map(name => ({name, bytes: readFileSync(join(dir, name))}))
  const unchanged = () => {for (const file of originals) expect(readFileSync(join(dir, file.name))).toEqual(file.bytes)}
  const project: GeoMotionProjectInput = {trackId: id, sourceFingerprint: 'track-points-v1:actual-track', document: document()}
  return {id, env, dir, project, unchanged}
}

describe('GeoMotion sidecar storage', () => {
  it('returns null without creating a sidecar and round-trips authored documents independently from original data', () => {
    const {id, env, dir, project, unchanged} = fixture()
    expect(readGeoMotionProject(id, env)).toBeNull()
    expect(existsSync(join(dir, 'geomotion-project.json'))).toBe(false)
    const saved = writeGeoMotionProject(id, project, null, env)
    expect(saved).toMatchObject({schema: GEOMOTION_PROJECT_SCHEMA, ...project})
    expect(saved.revision).toMatch(/^[0-9a-f-]{36}$/u)
    expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
    expect(readGeoMotionProject(id, {...env})).toEqual(saved)
    project.document.name = '调用方未保存的变化'
    expect(readGeoMotionProject(id, env)!.document.name).toBe('轨迹片头')
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    unchanged()
  })
  it('updates with the latest revision and rejects stale, create-only and revision-free clients without overwriting', () => {
    const {id, env, dir, project, unchanged} = fixture()
    const first = writeGeoMotionProject(id, project, null, env)
    const latest = writeGeoMotionProject(id, {...project, document: {...project.document, name: '新镜头'}}, first.revision, env)
    expect(latest.revision).not.toBe(first.revision)
    const bytes = readFileSync(join(dir, 'geomotion-project.json'))
    for (const revision of [first.revision, null, undefined]) expect(() => writeGeoMotionProject(id, project, revision, env)).toThrow(GeoMotionProjectConflictError)
    for (const revision of ['', 1, {}, false]) expect(() => writeGeoMotionProject(id, project, revision, env)).toThrow('修订号')
    expect(readFileSync(join(dir, 'geomotion-project.json'))).toEqual(bytes)
    unchanged()
  })
  it('requires a declared create revision and rejects track substitution, invalid identities and schema before creating files', () => {
    const {id, env, dir, project, unchanged} = fixture()
    expect(() => writeGeoMotionProject(id, project, undefined, env)).toThrow('修订号')
    for (const invalid of [{...project, trackId: 'other'}, {...project, sourceFingerprint: ''}, {...project, sourceFingerprint: ' '}, {...project, schema: 'other@1'}, null, []]) expect(() => writeGeoMotionProject(id, invalid, null, env)).toThrow()
    for (const badId of ['../../outside', '..', 'missing-track', '']) {
      expect(() => readGeoMotionProject(badId, env)).toThrow('轨迹不存在')
      expect(() => writeGeoMotionProject(badId, {...project, trackId: badId}, null, env)).toThrow('轨迹不存在')
    }
    expect(existsSync(join(dir, 'geomotion-project.json'))).toBe(false)
    unchanged()
  })
  it('rejects malformed format-7 graphs and unsafe numeric values while retaining the last saved document', () => {
    const {id, env, dir, project, unchanged} = fixture(), saved = writeGeoMotionProject(id, project, null, env)
    const bytes = readFileSync(join(dir, 'geomotion-project.json'))
    const doc = document(), nodes = doc.nodes as Record<string, Record<string, unknown>>
    const variants = [
      {...doc, format: 6}, {...doc, nodes: []}, {...doc, nodes: {}}, {...doc, nodes: {camera: null}},
      {...doc, fps: 0}, {...doc, fps: 121}, {...doc, fps: 29.97}, {...doc, duration: -1}, {...doc, duration: 3601},
      {...doc, width: 63}, {...doc, height: 4097}, {...doc, width: 1280.5}, {...doc, contexts: null}, {...doc, story: null},
      {...doc, nodes: {...nodes, marker: {...nodes.marker, id: 'different'}}},
      {...doc, nodes: {...nodes, marker: {...nodes.marker, parentId: 'missing'}}},
      {...doc, nodes: {...nodes, marker: {...nodes.marker, parentId: 'camera'}}},
      {...doc, nodes: {...nodes, marker: {...nodes.marker, coord: [181, 30]}}},
      {...doc, nodes: {...nodes, marker: {...nodes.marker, out: -1}}},
      {...doc, nodes: {...nodes, camera: {...nodes.camera, tracks: {center: {kind: 'static', value: [120, 30]}}}}},
      {...doc, nodes: {...nodes, marker: {...nodes.marker, opacity: Infinity}}},
    ]
    for (const badDocument of variants) expect(() => writeGeoMotionProject(id, {...project, document: badDocument}, saved.revision, env)).toThrow()
    expect(readFileSync(join(dir, 'geomotion-project.json'))).toEqual(bytes)
    unchanged()
  })
  it('rejects graph parent cycles, non-JSON data, excessive nesting and documents over 16 MiB', () => {
    const {id, env, dir, project} = fixture(), doc = document(), nodes = doc.nodes as Record<string, unknown>
    const group = (id: string, parentId: string) => ({id, type: 'group', name: id, parentId, order: 'a2', visible: true})
    expect(() => writeGeoMotionProject(id, {...project, document: {...doc, nodes: {...nodes, one: group('one', 'two'), two: group('two', 'one')}}}, null, env)).toThrow('循环')
    expect(() => writeGeoMotionProject(id, {...project, document: {...doc, extra: undefined}}, null, env)).toThrow('不可保存')
    const nested: Record<string, unknown> = {}; let current = nested
    for (let i = 0; i < 102; i++) {current.next = {}; current = current.next as Record<string, unknown>}
    expect(() => writeGeoMotionProject(id, {...project, document: {...doc, extra: nested}}, null, env)).toThrow('层级过深')
    const large = {...doc, audio: {url: 'x'.repeat(16 * 1024 * 1024)}}
    expect(() => writeGeoMotionProject(id, {...project, document: large}, null, env)).toThrow('16 MiB')
    expect(existsSync(join(dir, 'geomotion-project.json'))).toBe(false)
  })
  it('keeps the prior complete save and removes only owned temporary files when writing or replacement fails', () => {
    const {id, env, dir, project, unchanged} = fixture(), saved = writeGeoMotionProject(id, project, null, env)
    const bytes = readFileSync(join(dir, 'geomotion-project.json'))
    const dirty = join(dir, '.geomotion-project-abandoned.tmp'); writeFileSync(dirty, 'unfinished save from before')
    faults.write = true
    expect(() => writeGeoMotionProject(id, project, saved.revision, env)).toThrow('write blocked')
    faults.write = false; faults.rename = true
    expect(() => writeGeoMotionProject(id, project, saved.revision, env)).toThrow('rename blocked')
    faults.rename = false
    expect(readFileSync(join(dir, 'geomotion-project.json'))).toEqual(bytes)
    expect(readGeoMotionProject(id, env)).toEqual(saved)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual(['.geomotion-project-abandoned.tmp'])
    expect(readFileSync(dirty, 'utf8')).toBe('unfinished save from before')
    faults.collision = true
    expect(() => writeGeoMotionProject(id, project, saved.revision, env)).toThrow('temporary collision')
    faults.collision = false
    const collided = readdirSync(dir).find(name => name.endsWith('.tmp') && name !== '.geomotion-project-abandoned.tmp')!
    expect(readFileSync(join(dir, collided), 'utf8')).toBe('unowned colliding temporary')
    expect(readGeoMotionProject(id, env)).toEqual(saved)
    unchanged()
  })
  it('never recovers stale temporary files over a corrupt canonical save or lets any writer replace it', () => {
    const {id, env, dir, project} = fixture()
    const saved = writeGeoMotionProject(id, project, null, env)
    const canonical = join(dir, 'geomotion-project.json')
    writeFileSync(join(dir, '.geomotion-project-abandoned.tmp'), JSON.stringify(saved))
    for (const corrupt of ['{broken', JSON.stringify({...saved, schema: 'future@9'}), JSON.stringify({...saved, trackId: 'other'}), JSON.stringify({...saved, revision: null}), JSON.stringify({...saved, updatedAt: 'bad-date'})]) {
      writeFileSync(canonical, corrupt)
      expect(() => readGeoMotionProject(id, env)).toThrow()
      expect(() => writeGeoMotionProject(id, project, null, env)).toThrow()
      expect(readFileSync(canonical, 'utf8')).toBe(corrupt)
    }
  })
  it('deletes the project with its track and never recreates removed track directories', () => {
    const {id, env, dir, project} = fixture()
    writeGeoMotionProject(id, project, null, env)
    expect(readSource(id, env)!.body.toString()).toBe(input.source)
    expect(removeTrack(id, env)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(() => writeGeoMotionProject(id, project, null, env)).toThrow('轨迹不存在')
    expect(existsSync(dir)).toBe(false)
  })
})

async function withServer(run: (base: string, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-geomotion-project-')); roots.push(home)
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
function send(base: string, action: string, body?: unknown, headers: Record<string, string> = {'x-cqai-track': '1'}, method?: string) {
  return fetch(`${base}/${action}`, {method: method ?? (body === undefined ? 'GET' : 'POST'), headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)})
}

describe('GeoMotion project HTTP routes', () => {
  it('round-trips and updates the envelope, returns 409 for stale clients, retains original bytes and removes the sidecar with track deletion', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home})
    const track = readFileSync(join(dir, 'track.json')), source = readFileSync(join(dir, 'source.kml'))
    const initial = await send(base, `geomotion-project?id=${id}`)
    expect(initial.status).toBe(200); expect(initial.headers.get('cache-control')).toBe('no-store'); expect(await initial.json()).toEqual({project: null})
    const project = {trackId: id, sourceFingerprint: 'actual-source', document: document()}
    const save = await send(base, 'geomotion-project', {id, project, expectedRevision: null})
    expect(save.status).toBe(200)
    const {project: saved} = await save.json()
    expect(await (await send(base, `geomotion-project?id=${id}`)).json()).toEqual({project: saved})
    const update = await send(base, 'geomotion-project', {id, project: {...project, document: {...project.document, name: '已编辑工程'}}, expectedRevision: saved.revision})
    expect(update.status).toBe(200)
    const {project: latest} = await update.json()
    expect(latest.revision).not.toBe(saved.revision)
    for (const body of [{id, project, expectedRevision: saved.revision}, {id, project, expectedRevision: null}, {id, project}]) {
      const conflict = await send(base, 'geomotion-project', body)
      expect(conflict.status).toBe(409); expect((await conflict.json()).error).toContain('重新读取')
    }
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect((await send(base, `track?id=${id}`, undefined, {'x-cqai-track': '1'}, 'DELETE')).status).toBe(200)
    expect(existsSync(dir)).toBe(false)
    expect((await send(base, `geomotion-project?id=${id}`)).status).toBe(404)
  }), 30000)
  it('uses the existing local-origin gate, rejects malformed requests and unknown tracks and does not create sidecars on failure', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home})
    const project = {trackId: id, sourceFingerprint: 'actual-source', document: document()}
    expect((await send(base, 'geomotion-project', {id, project, expectedRevision: null}, {})).status).toBe(403)
    expect((await send(base, 'geomotion-project', {id, project, expectedRevision: null}, {'x-cqai-track': '1', origin: 'https://other.example'})).status).toBe(403)
    for (const body of [null, [], {}, {id: 42}, {id, project}, {id, project: {...project, trackId: 'other'}, expectedRevision: null}, {id, project: {...project, document: {...project.document, format: 6}}, expectedRevision: null}]) expect((await send(base, 'geomotion-project', body)).status).toBe(400)
    expect((await send(base, 'geomotion-project?id=..%2Foutside')).status).toBe(404)
    expect((await send(base, 'geomotion-project', {id: 'missing', project: {...project, trackId: 'missing'}, expectedRevision: null})).status).toBe(404)
    expect(existsSync(join(dir, 'geomotion-project.json'))).toBe(false)
  }), 30000)
})
