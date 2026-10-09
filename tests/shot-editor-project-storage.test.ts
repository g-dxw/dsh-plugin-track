import {Context} from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {request} from 'node:http'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {readSource, removeTrack, trackDir, writeTrack} from '../src/artifacts.ts'
import {ShotEditorProjectConflictError, readShotEditorProject, writeShotEditorProject} from '../src/shot-editor-project-store.ts'
import {SHOT_EDITOR_PROJECT_MAX_BYTES, SHOT_EDITOR_PROJECT_SCHEMA, type ShotEditorProjectInput} from '../src/track/shot-editor-project-types.ts'
import {createShotEditorPlan} from '../src/track/shot-editor.ts'
import {DEFAULT_MAP_SETTINGS} from '../src/track/map-settings.ts'
import * as plugin from '../src/index.ts'
import {API, type TrackInput} from '../src/protocol.ts'

const faults = vi.hoisted(() => ({rename: false, write: false, collision: false}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (faults.rename && String(args[0]).includes('.shot-editor-project-')) throw new Error('rename blocked')
    return fs.renameSync(...args)
  }, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).includes('.shot-editor-project-')) {
      if (faults.write) throw new Error('write blocked')
      if (faults.collision) {
        fs.writeFileSync(args[0], 'unowned temporary')
        throw Object.assign(new Error('temporary collision'), {code: 'EEXIST'})
      }
    }
    return fs.writeFileSync(...args)
  }}
})
const roots: string[] = []
afterEach(() => {
  faults.rename = false; faults.write = false; faults.collision = false
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-shot-editor-project-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})
const input: TrackInput = {
  name: '测试路线', filename: 'source.kml', source: '<kml>原始测试内容</kml>\r\n',
  points: [[120, 30, 100, 1000], [120.01, 30.01, 120, 3000]], segmentStarts: [0],
  metrics: {distance: 1000, elevationGain: 20, elevationLoss: 0, duration: 2000, elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.01, 30.01]},
}
function project(id: string): ShotEditorProjectInput {
  return {schema: SHOT_EDITOR_PROJECT_SCHEMA,
    plan: createShotEditorPlan({trackId: id, fingerprint: 'source-v1', sceneFingerprint: 'scene-v1', title: '手工镜头', camera: {position: [10, 20, 30], target: [0, 0, 0], fov: 45}}),
    appearance: {lighting: {...DEFAULT_MAP_SETTINGS.lighting}, sandboxColors: {...DEFAULT_MAP_SETTINGS.sandboxColors}, sandboxBackground: 'environment'}}
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-shot-editor-project-')); roots.push(home)
  const env = {DSH_HOME: home}, {id} = writeTrack(input, env), dir = trackDir(id, env)
  for (const name of ['placemark-state.json', 'annotations.json', 'geomotion-project.json', 'video-materials.json']) writeFileSync(join(dir, name), `preserved ${name}`)
  const originals = readdirSync(dir).map(name => ({name, bytes: readFileSync(join(dir, name))}))
  const unchanged = () => {for (const file of originals) expect(readFileSync(join(dir, file.name))).toEqual(file.bytes)}
  return {id, env, dir, value: project(id), unchanged}
}
function status(run: () => unknown, code: number) {
  try {run(); expect.fail('Expected error')} catch (error) {expect(error).toMatchObject({status: code})}
}

describe('three-dimensional shot editor project sidecar', () => {
  it('reads an absent project without writes and round-trips a detached revisioned envelope independently', () => {
    const {id, env, dir, value, unchanged} = fixture(), before = structuredClone(value)
    expect(readShotEditorProject(id, env)).toBeNull(); expect(existsSync(join(dir, 'shot-editor-project.json'))).toBe(false)
    const saved = writeShotEditorProject(id, value, null, env)
    expect(saved).toMatchObject(before); expect(saved.revision).toMatch(/^[0-9a-f-]{36}$/u); expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
    expect(readShotEditorProject(id, {...env})).toEqual(saved)
    value.plan.title = '调用方未保存'; value.appearance.lighting.azimuth = 17; saved.appearance.sandboxColors.sides = '#abcdef'
    expect(readShotEditorProject(id, env)).toMatchObject(before)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]); unchanged()
  })
  it('updates only the latest revision and rejects stale, missing or create-only revisions without overwriting', () => {
    const {id, env, dir, value, unchanged} = fixture()
    status(() => writeShotEditorProject(id, value, undefined, env), 400)
    const first = writeShotEditorProject(id, value, null, env)
    const latest = writeShotEditorProject(id, {...value, plan: {...value.plan, title: '新镜头'}}, first.revision, env)
    expect(latest.revision).not.toBe(first.revision)
    const bytes = readFileSync(join(dir, 'shot-editor-project.json'))
    for (const revision of [first.revision, null, undefined]) expect(() => writeShotEditorProject(id, value, revision, env)).toThrow(ShotEditorProjectConflictError)
    for (const revision of ['', ' ', 1, {}, false]) status(() => writeShotEditorProject(id, value, revision, env), 400)
    expect(readFileSync(join(dir, 'shot-editor-project.json'))).toEqual(bytes); unchanged()
  })
  it('strictly rejects plan, appearance, schema and unsafe JSON changes while retaining the complete save', () => {
    const {id, env, dir, value, unchanged} = fixture(), saved = writeShotEditorProject(id, value, null, env)
    const bytes = readFileSync(join(dir, 'shot-editor-project.json')), {appearance} = value
    const getter = vi.fn(() => value.plan), accessor = {...value}
    Object.defineProperty(accessor, 'plan', {get: getter, enumerable: true})
    const bad = [null, [], {...value, schema: 'future@2'}, {...value, extra: true}, {...value, plan: JSON.stringify(value.plan)}, {...value, plan: {...value.plan, trackId: 'other'}},
      {...value, plan: {...value.plan, version: 2}}, {...value, plan: {...value.plan, duration: NaN}}, {...value, plan: {...value.plan, cameraKeyframes: [{...value.plan.cameraKeyframes[0], camera: {position: [0, 0, 0], target: [0, 0, 0], fov: 45}}]}},
      {...value, appearance: {...appearance, maptilerKey: 'should-not-save'}}, {...value, appearance: {...appearance, sandboxBackground: 'future'}},
      {...value, appearance: {...appearance, sandboxColors: {sides: '#fff', background: '#000000'}}},
      {...value, appearance: {...appearance, sandboxColors: {...appearance.sandboxColors, background: 'url(https://example.com)'}}},
      ...[['azimuth', -1], ['azimuth', 361], ['elevation', 4], ['elevation', 86], ['intensity', 6], ['ambient', 3], ['shadows', 1]].map(([key, item]) => ({...value, appearance: {...appearance, lighting: {...appearance.lighting, [key as string]: item}}})),
      accessor, {...value, appearance: {...appearance, lighting: {...appearance.lighting, intensity: Infinity}}}, {...value, [Symbol('unexpected')]: true}]
    for (const invalid of bad) status(() => writeShotEditorProject(id, invalid, saved.revision, env), 400)
    expect(getter).not.toHaveBeenCalled(); expect(readFileSync(join(dir, 'shot-editor-project.json'))).toEqual(bytes); unchanged()
  })
  it('returns 413 for oversized writes and reads and never replaces oversized or corrupt canonical saves', () => {
    const {id, env, dir, value} = fixture(), saved = writeShotEditorProject(id, value, null, env), file = join(dir, 'shot-editor-project.json')
    const bytes = readFileSync(file)
    status(() => writeShotEditorProject(id, {...value, plan: {...value.plan, title: 'x'.repeat(SHOT_EDITOR_PROJECT_MAX_BYTES)}}, saved.revision, env), 413)
    expect(readFileSync(file)).toEqual(bytes)
    for (const corrupt of ['{broken', JSON.stringify({...saved, schema: 'future@9'}), JSON.stringify({...saved, plan: {...saved.plan, trackId: 'other'}}), JSON.stringify({...saved, revision: null}), JSON.stringify({...saved, updatedAt: 'bad-date'})]) {
      writeFileSync(file, corrupt); status(() => readShotEditorProject(id, env), 400); status(() => writeShotEditorProject(id, value, null, env), 400)
      expect(readFileSync(file, 'utf8')).toBe(corrupt)
    }
    writeFileSync(file, ' '.repeat(SHOT_EDITOR_PROJECT_MAX_BYTES + 4097))
    status(() => readShotEditorProject(id, env), 413); status(() => writeShotEditorProject(id, value, null, env), 413)
    expect(readFileSync(file, 'utf8')).toHaveLength(SHOT_EDITOR_PROJECT_MAX_BYTES + 4097)
  })
  it('keeps prior bytes on write or rename failure and never removes an unowned colliding temporary', () => {
    const {id, env, dir, value, unchanged} = fixture(), saved = writeShotEditorProject(id, value, null, env)
    const bytes = readFileSync(join(dir, 'shot-editor-project.json')), abandoned = join(dir, '.shot-editor-project-abandoned.tmp')
    writeFileSync(abandoned, 'previous unfinished write')
    faults.write = true; expect(() => writeShotEditorProject(id, value, saved.revision, env)).toThrow('write blocked')
    faults.write = false; faults.rename = true; expect(() => writeShotEditorProject(id, value, saved.revision, env)).toThrow('rename blocked'); faults.rename = false
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual(['.shot-editor-project-abandoned.tmp'])
    faults.collision = true; expect(() => writeShotEditorProject(id, value, saved.revision, env)).toThrow('temporary collision'); faults.collision = false
    const colliding = readdirSync(dir).find(name => name.endsWith('.tmp') && name !== '.shot-editor-project-abandoned.tmp')!
    expect(readFileSync(join(dir, colliding), 'utf8')).toBe('unowned temporary'); expect(readFileSync(abandoned, 'utf8')).toBe('previous unfinished write')
    expect(readFileSync(join(dir, 'shot-editor-project.json'))).toEqual(bytes); expect(readShotEditorProject(id, env)).toEqual(saved); unchanged()
  })
  it('rejects unknown and unsafe track IDs and never recreates deleted track data', () => {
    const {id, env, dir, value} = fixture()
    for (const invalid of ['../../outside', '..', '', 'missing']) {
      status(() => readShotEditorProject(invalid, env), 404); status(() => writeShotEditorProject(invalid, value, null, env), 404)
    }
    writeShotEditorProject(id, value, null, env); expect(readSource(id, env)!.body.toString()).toBe(input.source)
    expect(removeTrack(id, env)).toBe(true); expect(existsSync(dir)).toBe(false)
    status(() => writeShotEditorProject(id, value, null, env), 404); expect(existsSync(dir)).toBe(false)
  })
})

async function withServer(run: (base: string, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-shot-editor-project-')); roots.push(home)
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home
  const ctx = new Context()
  try {
    await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0}); await ctx.plugin(plugin)
    await run(`http://127.0.0.1:${ctx.webServer.port}${API}`, home)
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  }
}
function send(base: string, action: string, body?: unknown, headers: Record<string, string> = {'x-cqai-track': '1'}, method?: string) {
  return fetch(`${base}/${action}`, {method: method ?? (body === undefined ? 'GET' : 'POST'), headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)})
}
function streamed(base: string, body: string): Promise<{status: number; body: string}> {
  return new Promise((yes, no) => {
    const req = request(`${base}/shot-editor-project`, {method: 'POST', headers: {'x-cqai-track': '1', 'content-type': 'application/json'}}, res => {
      let output = ''; res.setEncoding('utf8'); res.on('data', chunk => {output += chunk}); res.on('end', () => yes({status: res.statusCode!, body: output}))
    }); req.on('error', no)
    for (let offset = 0; offset < body.length; offset += 64000) req.write(body.slice(offset, offset + 64000))
    req.end()
  })
}
describe('shot editor project HTTP routes', () => {
  it('round-trips revisions with no-store, rejects stale writers and deletes only with its track', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home})
    const track = readFileSync(join(dir, 'track.json')), source = readFileSync(join(dir, 'source.kml'))
    const empty = await send(base, `shot-editor-project?id=${id}`)
    expect(empty.status).toBe(200); expect(empty.headers.get('cache-control')).toBe('no-store'); expect(await empty.json()).toEqual({project: null})
    const value = project(id), response = await send(base, 'shot-editor-project', {id, project: value, expectedRevision: null})
    expect(response.status).toBe(200); const {project: first} = await response.json()
    expect(await (await send(base, `shot-editor-project?id=${id}`)).json()).toEqual({project: first})
    const update = await send(base, 'shot-editor-project', {id, project: {...value, plan: {...value.plan, title: '最新工程'}}, expectedRevision: first.revision})
    expect(update.status).toBe(200); const {project: latest} = await update.json(); expect(latest.revision).not.toBe(first.revision)
    for (const body of [{id, project: value, expectedRevision: null}, {id, project: value, expectedRevision: first.revision}, {id, project: value}]) expect((await send(base, 'shot-editor-project', body)).status).toBe(409)
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect((await send(base, `track?id=${id}`, undefined, {'x-cqai-track': '1'}, 'DELETE')).status).toBe(200)
    expect(existsSync(dir)).toBe(false); expect((await send(base, `shot-editor-project?id=${id}`)).status).toBe(404)
  }), 30000)
  it('keeps the existing origin gate and returns 400 or 404 for malformed input without side effects', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home}), value = project(id)
    expect((await send(base, 'shot-editor-project', {id, project: value, expectedRevision: null}, {})).status).toBe(403)
    expect((await send(base, 'shot-editor-project', {id, project: value, expectedRevision: null}, {'x-cqai-track': '1', origin: 'https://other.example'})).status).toBe(403)
    for (const body of [null, [], {}, {id: 42}, {id, project: value}, {id, project: {...value, schema: 'other'}, expectedRevision: null}, {id, project: {...value, plan: {...value.plan, trackId: 'other'}}, expectedRevision: null}, {id, project: {...value, appearance: {...value.appearance, sandboxBackground: 'future'}}, expectedRevision: null}]) expect((await send(base, 'shot-editor-project', body)).status).toBe(400)
    expect((await fetch(`${base}/shot-editor-project`, {method: 'POST', headers: {'x-cqai-track': '1'}, body: '{broken'})).status).toBe(400)
    expect((await send(base, 'shot-editor-project?id=..%2Foutside')).status).toBe(404)
    expect((await send(base, 'shot-editor-project', {id: 'missing', project: project('missing'), expectedRevision: null})).status).toBe(404)
    expect(existsSync(join(dir, 'shot-editor-project.json'))).toBe(false)
  }), 30000)
  it('rejects oversized normal and chunked requests with 413 while preserving a prior complete project', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home}), value = project(id)
    const {project: saved} = await (await send(base, 'shot-editor-project', {id, project: value, expectedRevision: null})).json()
    const bytes = readFileSync(join(dir, 'shot-editor-project.json'))
    const oversized = {id, project: {...value, plan: {...value.plan, title: 'x'.repeat(SHOT_EDITOR_PROJECT_MAX_BYTES + 4096)}}, expectedRevision: saved.revision}
    const ordinary = await send(base, 'shot-editor-project', oversized)
    expect(ordinary.status).toBe(413); expect((await ordinary.json()).error).toContain('2 MB')
    const chunked = await streamed(base, JSON.stringify(oversized)); expect(chunked.status).toBe(413); expect(JSON.parse(chunked.body).error).toContain('2 MB')
    expect(readFileSync(join(dir, 'shot-editor-project.json'))).toEqual(bytes)
  }), 30000)
})
