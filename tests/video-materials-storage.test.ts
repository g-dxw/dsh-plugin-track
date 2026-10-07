import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readSource, removeTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { VideoMaterialsConflictError, readVideoMaterials, writeVideoMaterials, VIDEO_MATERIALS_ENVELOPE_SCHEMA, VIDEO_MATERIALS_MAX_BYTES } from '../src/video-materials-store.ts'
import * as plugin from '../src/index.ts'
import { API, type TrackInput } from '../src/protocol.ts'
import { placemarkPhotoUrl } from '../src/track/placemark-photos.ts'

const faults = vi.hoisted(() => ({rename: false, write: false, collision: false}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (faults.rename && String(args[0]).includes('.video-materials-')) throw new Error('replacement blocked')
    return fs.renameSync(...args)
  }, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (faults.write && String(args[0]).includes('.video-materials-')) throw new Error('write blocked')
    if (faults.collision && String(args[0]).includes('.video-materials-')) {
      fs.writeFileSync(args[0], 'unowned colliding temporary')
      throw Object.assign(new Error('temporary collision'), {code: 'EEXIST'})
    }
    return fs.writeFileSync(...args)
  }}
})
const roots: string[] = []
afterEach(() => {
  faults.rename = false; faults.write = false; faults.collision = false
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-video-materials-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})
const input: TrackInput = {
  name: '真实轨迹', filename: 'source.kml', source: '<kml>视频素材来源不变</kml>\r\n',
  points: [[120, 30, 100, 1000], [120.01, 30.01, 120, 3000], [120.02, 30.02, 125, 5000]], segmentStarts: [0],
  metrics: {distance: 1000, elevationGain: 25, elevationLoss: 0, duration: 4000, elevationMax: 125, elevationMin: 100, bbox: [120, 30, 120.02, 30.02]},
}
function document(id: string): Record<string, unknown> {
  return {schema: 'cqai-track-video-materials@1', trackId: id, title: '路线素材', sourceFingerprint: 'vm1-abc-def', sourcePointCount: input.points.length, sourceSegmentStarts: [0], markers: [], segments: [], information: []}
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-video-materials-')); roots.push(home)
  const env = {DSH_HOME: home}, {id} = writeTrack(input, env), dir = trackDir(id, env)
  writeFileSync(join(dir, 'placemark-state.json'), '{"version":1,"revision":5,"label":"已编辑地名"}')
  writeFileSync(join(dir, 'annotations.json'), '{"labels":["已有SVG标注"]}')
  writeFileSync(join(dir, 'geomotion-project.json'), '{"previous":"已有镜头工程"}')
  const originals = ['source.kml', 'track.json', 'placemark-state.json', 'annotations.json', 'geomotion-project.json'].map(name => ({name, bytes: readFileSync(join(dir, name))}))
  const unchanged = () => {for (const file of originals) expect(readFileSync(join(dir, file.name))).toEqual(file.bytes)}
  return {id, env, dir, document: document(id), unchanged}
}

describe('Video materials independent sidecar', () => {
  it('round-trips a detached document without rewriting original points, source, SVG or existing video work', () => {
    const {id, env, dir, document, unchanged} = fixture()
    expect(readVideoMaterials(id, env)).toBeNull()
    expect(existsSync(join(dir, 'video-materials.json'))).toBe(false)
    const saved = writeVideoMaterials(id, document, null, env)
    expect(saved).toMatchObject({schema: VIDEO_MATERIALS_ENVELOPE_SCHEMA, trackId: id, document})
    expect(saved.revision).toMatch(/^[0-9a-f-]{36}$/u)
    expect(Number.isFinite(Date.parse(saved.updatedAt))).toBe(true)
    expect(readVideoMaterials(id, {...env})).toEqual(saved)
    document.title = '调用方的未保存修改'
    expect(readVideoMaterials(id, env)!.document.title).toBe('路线素材')
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    unchanged()
  })
  it('requires explicit creation and fresh revisions and does not overwrite on stale saves', () => {
    const {id, env, dir, document, unchanged} = fixture()
    expect(() => writeVideoMaterials(id, document, undefined, env)).toThrow('修订号')
    const first = writeVideoMaterials(id, document, null, env)
    const latest = writeVideoMaterials(id, {...document, title: '已确认素材'}, first.revision, env)
    expect(latest.revision).not.toBe(first.revision)
    const bytes = readFileSync(join(dir, 'video-materials.json'))
    for (const revision of [first.revision, null, undefined]) expect(() => writeVideoMaterials(id, document, revision, env)).toThrow(VideoMaterialsConflictError)
    for (const revision of ['', false, 1, {}]) expect(() => writeVideoMaterials(id, document, revision, env)).toThrow('修订号')
    expect(readFileSync(join(dir, 'video-materials.json'))).toEqual(bytes)
    unchanged()
  })
  it('rejects unknown and unsafe identities, track substitution and changed point or original segmentation counts', () => {
    const {id, env, dir, document, unchanged} = fixture()
    for (const badId of ['../../outside', '..', '', 'a/b', 'a\\b', 'a'.repeat(129), 'missing']) {
      expect(() => readVideoMaterials(badId, env)).toThrow()
      expect(() => writeVideoMaterials(badId, {...document, trackId: badId}, null, env)).toThrow()
    }
    for (const badDocument of [{...document, trackId: 'other'}, {...document, sourcePointCount: 2}, {...document, sourceSegmentStarts: [0, 1]}, {...document, schema: 'future@2'}, null, []]) expect(() => writeVideoMaterials(id, badDocument, null, env)).toThrow()
    expect(existsSync(join(dir, 'video-materials.json'))).toBe(false)
    unchanged()
  })
  it('uses validated canonical route context for legacy imported gaps without rewriting the old track', () => {
    const home = mkdtempSync(join(tmpdir(), 'cqai-video-materials-')); roots.push(home)
    const env = {DSH_HOME: home}, {id} = writeTrack({...input, segmentStarts: undefined}, env), dir = trackDir(id, env)
    writeFileSync(join(dir, 'placemark-state.json'), JSON.stringify({version: 1, revision: 0, added: [], deletedIds: [], edits: [], order: null, groups: [], routeContext: {segmentStarts: [0, 2], references: []}}))
    const original = readFileSync(join(dir, 'track.json')), state = readFileSync(join(dir, 'placemark-state.json'))
    const doc = {...document(id), sourceSegmentStarts: [0, 2]}
    const saved = writeVideoMaterials(id, doc, null, env)
    expect(readVideoMaterials(id, env)).toEqual(saved)
    expect(() => writeVideoMaterials(id, document(id), saved.revision, env)).toThrow('原轨迹分段')
    expect(readFileSync(join(dir, 'track.json'))).toEqual(original)
    expect(readFileSync(join(dir, 'placemark-state.json'))).toEqual(state)
  })
  it('validates embedded photo signatures and forbids local photo references from another track', () => {
    const {id, env, dir, document, unchanged} = fixture()
    const local = placemarkPhotoUrl(id, 'a'.repeat(64) + '.png'), foreign = placemarkPhotoUrl('another-track', 'b'.repeat(64) + '.png')
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const marker = {id: 'selected-marker', name: '山顶', description: '已确认地名', coordinates: [120, 30], pointIndex: 1, selected: true, color: '#d33d33', photoCandidates: [local, 'https://images.example/photo.jpg'], photo: {dataUrl, sourceUrl: local}}
    const saved = writeVideoMaterials(id, {...document, markers: [marker]}, null, env)
    expect(saved.document.markers[0].photo).toEqual(marker.photo)
    const bytes = readFileSync(join(dir, 'video-materials.json'))
    for (const badMarker of [{...marker, photoCandidates: [foreign]}, {...marker, photo: {...marker.photo, sourceUrl: foreign}}, {...marker, photo: {dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+'}}, {...marker, photo: {dataUrl: 'data:image/png;base64,PGh0bWw+'}}, {...marker, photoCandidates: ['file:///C:/private.jpg']}, {...marker, photoCandidates: ['javascript:alert(1)']}]) expect(() => writeVideoMaterials(id, {...document, markers: [badMarker]}, saved.revision, env)).toThrow()
    expect(readFileSync(join(dir, 'video-materials.json'))).toEqual(bytes)
    unchanged()
  })
  it('rejects non-JSON, cyclic, deeply nested and over-limit values before creating any sidecar', () => {
    const {id, env, dir, document} = fixture()
    expect(() => writeVideoMaterials(id, {...document, extra: undefined}, null, env)).toThrow('不可保存')
    expect(() => writeVideoMaterials(id, {...document, extra: Infinity}, null, env)).toThrow('不可保存')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => writeVideoMaterials(id, {...document, extra: cyclic}, null, env)).toThrow('循环')
    const nested: Record<string, unknown> = {}; let current = nested
    for (let i = 0; i < 102; i++) {current.next = {}; current = current.next as Record<string, unknown>}
    expect(() => writeVideoMaterials(id, {...document, extra: nested}, null, env)).toThrow('层级过深')
    try {writeVideoMaterials(id, {...document, extra: 'x'.repeat(VIDEO_MATERIALS_MAX_BYTES)}, null, env); expect.fail('Expected size error')}
    catch (error) {expect(error).toMatchObject({status: 413, message: '视频素材准备最多 16 MiB'})}
    expect(existsSync(join(dir, 'video-materials.json'))).toBe(false)
  })
  it('retains the last complete sidecar and cleans only owned temporary files on failed writes or replacements', () => {
    const {id, env, dir, document, unchanged} = fixture(), saved = writeVideoMaterials(id, document, null, env)
    const bytes = readFileSync(join(dir, 'video-materials.json'))
    const abandoned = join(dir, '.video-materials-abandoned.tmp'); writeFileSync(abandoned, 'old incomplete save')
    faults.write = true
    expect(() => writeVideoMaterials(id, document, saved.revision, env)).toThrow('write blocked')
    faults.write = false; faults.rename = true
    expect(() => writeVideoMaterials(id, document, saved.revision, env)).toThrow('replacement blocked')
    faults.rename = false
    expect(readFileSync(join(dir, 'video-materials.json'))).toEqual(bytes)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual(['.video-materials-abandoned.tmp'])
    faults.collision = true
    expect(() => writeVideoMaterials(id, document, saved.revision, env)).toThrow('temporary collision')
    faults.collision = false
    const collided = readdirSync(dir).find(name => name.endsWith('.tmp') && name !== '.video-materials-abandoned.tmp')!
    expect(readFileSync(join(dir, collided), 'utf8')).toBe('unowned colliding temporary')
    expect(readVideoMaterials(id, env)).toEqual(saved)
    unchanged()
  })
  it('rejects corrupt canonical sidecars without recovering or overwriting from abandoned temporary files', () => {
    const {id, env, dir, document} = fixture(), saved = writeVideoMaterials(id, document, null, env)
    const canonical = join(dir, 'video-materials.json')
    writeFileSync(join(dir, '.video-materials-abandoned.tmp'), JSON.stringify(saved))
    for (const corrupt of ['{broken', JSON.stringify({...saved, schema: 'future@9'}), JSON.stringify({...saved, trackId: 'other'}), JSON.stringify({...saved, revision: null}), JSON.stringify({...saved, updatedAt: 'bad-date'}), JSON.stringify({...saved, document: {...saved.document, sourcePointCount: 2}})]) {
      writeFileSync(canonical, corrupt)
      expect(() => readVideoMaterials(id, env)).toThrow()
      expect(() => writeVideoMaterials(id, document, null, env)).toThrow()
      expect(readFileSync(canonical, 'utf8')).toBe(corrupt)
    }
  })
  it('deletes the sidecar with its track and cannot recreate removed track directories', () => {
    const {id, env, dir, document} = fixture()
    writeVideoMaterials(id, document, null, env)
    expect(readSource(id, env)!.body.toString()).toBe(input.source)
    expect(removeTrack(id, env)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(() => writeVideoMaterials(id, document, null, env)).toThrow('轨迹不存在')
    expect(existsSync(dir)).toBe(false)
  })
})

async function withServer(run: (base: string, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-video-materials-')); roots.push(home)
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

describe('Video materials HTTP routes', () => {
  it('round-trips the real API, preserves source bytes and reports stale clients as 409', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home})
    const track = readFileSync(join(dir, 'track.json')), source = readFileSync(join(dir, 'source.kml'))
    const initial = await send(base, `video-materials?id=${id}`)
    expect(initial.status).toBe(200); expect(initial.headers.get('cache-control')).toBe('no-store'); expect(await initial.json()).toEqual({materials: null})
    const doc = document(id)
    const savedResponse = await send(base, 'video-materials', {id, document: doc, expectedRevision: null})
    expect(savedResponse.status).toBe(200)
    const {materials: saved} = await savedResponse.json()
    expect(await (await send(base, `video-materials?id=${id}`)).json()).toEqual({materials: saved})
    const update = await send(base, 'video-materials', {id, document: {...doc, title: '已确认展示内容'}, expectedRevision: saved.revision})
    expect(update.status).toBe(200)
    const {materials: latest} = await update.json()
    expect(latest.revision).not.toBe(saved.revision)
    for (const body of [{id, document: doc, expectedRevision: saved.revision}, {id, document: doc, expectedRevision: null}, {id, document: doc}]) {
      const conflict = await send(base, 'video-materials', body)
      expect(conflict.status).toBe(409); expect((await conflict.json()).error).toContain('重新读取')
    }
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readFileSync(join(dir, 'source.kml'))).toEqual(source)
    expect((await send(base, `track?id=${id}`, undefined, {'x-cqai-track': '1'}, 'DELETE')).status).toBe(200)
    expect(existsSync(dir)).toBe(false)
    expect((await send(base, `video-materials?id=${id}`)).status).toBe(404)
  }), 30000)
  it('uses the loopback origin gate and rejects malformed or mismatched requests without creating files', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home}), doc = document(id)
    expect((await send(base, 'video-materials', {id, document: doc, expectedRevision: null}, {})).status).toBe(403)
    expect((await send(base, 'video-materials', {id, document: doc, expectedRevision: null}, {'x-cqai-track': '1', origin: 'https://other.example'})).status).toBe(403)
    for (const body of [null, [], {}, {id: 42}, {id, document: doc}, {id, document: {...doc, trackId: 'other'}, expectedRevision: null}, {id, document: {...doc, sourcePointCount: 2}, expectedRevision: null}]) expect((await send(base, 'video-materials', body)).status).toBe(400)
    expect((await send(base, 'video-materials?id=..%2Foutside')).status).toBe(400)
    expect((await send(base, 'video-materials', {id: 'missing', document: {...doc, trackId: 'missing'}, expectedRevision: null})).status).toBe(404)
    expect(existsSync(join(dir, 'video-materials.json'))).toBe(false)
  }), 30000)
  it('rejects oversized request bodies with 413 without changing prior data', async () => withServer(async (base, home) => {
    const {id} = await (await send(base, 'tracks', input)).json(), dir = trackDir(id, {DSH_HOME: home})
    const response = await send(base, 'video-materials', {id, document: {...document(id), extra: 'x'.repeat(VIDEO_MATERIALS_MAX_BYTES + 4096)}, expectedRevision: null})
    expect(response.status).toBe(413); expect((await response.json()).error).toContain('16 MiB')
    expect(existsSync(join(dir, 'video-materials.json'))).toBe(false)
  }), 30000)
})
