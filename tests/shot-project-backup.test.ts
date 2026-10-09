import {Context} from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {afterEach, describe, expect, it} from 'vitest'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {readSource, readTrack, trackDir, writeTrack} from '../src/artifacts.ts'
import {readGeoMotionProject, writeGeoMotionProject} from '../src/geomotion-project-store.ts'
import {readShotEditorProject, writeShotEditorProject} from '../src/shot-editor-project-store.ts'
import {readShotProjectBackup, SHOT_PROJECT_BACKUP_MAX_BYTES} from '../src/shot-project-backup.ts'
import {createGeoMotionProject} from '../src/track/geomotion.ts'
import {createShotEditorPlan} from '../src/track/shot-editor.ts'
import {DEFAULT_MAP_SETTINGS} from '../src/track/map-settings.ts'
import {API, type TrackInput} from '../src/protocol.ts'
import * as plugin from '../src/index.ts'

const roots: string[] = []
const input: TrackInput = {name: '原工程备份测试', filename: 'source.kml', source: '<kml>原始测试内容</kml>\r\n',
  points: [[120, 30, 100, 1000], [120.01, 30.01, 120, 3000]], segmentStarts: [0],
  metrics: {distance: 1000, elevationGain: 20, elevationLoss: 0, duration: 2000, elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.01, 30.01]}}
function fixture(home?: string) {
  const base = home || mkdtempSync(join(tmpdir(), 'cqai-shot-project-backup-')); if (!home) roots.push(base)
  const env = {DSH_HOME: base}, {id} = writeTrack(input, env), track = readTrack(id, env)!, directory = trackDir(id, env)
  return {env, track, directory}
}
function status(read: () => unknown, code: number) {try {read(); expect.fail('Expected read error')} catch (error) {expect(error).toMatchObject({status: code})}}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-shot-project-backup-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})

describe('read-only original shot project backup', () => {
  it('backs up valid saved map and sandbox envelopes byte for byte without changing any source or sidecar', () => {
    const {track, env, directory} = fixture(), imported = createGeoMotionProject(track, [])
    writeGeoMotionProject(track.id, {trackId: track.id, sourceFingerprint: imported.sourceFingerprint, document: imported.document}, null, env)
    writeShotEditorProject(track.id, {schema: 'cqai-track-shot-editor@1', plan: createShotEditorPlan({trackId: track.id, fingerprint: 'original-track', sceneFingerprint: 'original-scene', title: track.name, camera: {position: [10, 20, 30], target: [0, 0, 0], fov: 45}}), appearance: {
      lighting: {...DEFAULT_MAP_SETTINGS.lighting}, sandboxColors: {...DEFAULT_MAP_SETTINGS.sandboxColors}, sandboxBackground: 'environment'}}, null, env)
    const snapshot = readdirSync(directory).map(name => ({name, body: readFileSync(join(directory, name))}))
    for (const [scene, name] of [['map', 'geomotion-project.json'], ['sandbox', 'shot-editor-project.json']] as const) {
      const backup = readShotProjectBackup(track.id, scene, env)
      expect(backup.body).toEqual(readFileSync(join(directory, name))); expect(backup.filename).toBe(`${track.id}-${scene}-project-backup.json`)
    }
    expect(readdirSync(directory)).toEqual(snapshot.map(file => file.name)); for (const file of snapshot) expect(readFileSync(join(directory, file.name))).toEqual(file.body)
    expect(readSource(track.id, env)!.body.toString()).toBe(input.source)
  })
  it('downloads malformed bytes and unsupported or stale saved JSON even when the normal parser refuses it', () => {
    const {track, env, directory} = fixture()
    const mapBytes = Buffer.from('\ufeff {"schema":"old-unsupported@9","sourceFingerprint":"old-track","broken":\r\n', 'utf8')
    const sandboxBytes = Buffer.from([0x7b, 0x22, 0x62, 0xff, 0x00, 0x0d, 0x0a])
    writeFileSync(join(directory, 'geomotion-project.json'), mapBytes); writeFileSync(join(directory, 'shot-editor-project.json'), sandboxBytes)
    status(() => readGeoMotionProject(track.id, env), 400); status(() => readShotEditorProject(track.id, env), 400)
    expect(readShotProjectBackup(track.id, 'map', env).body).toEqual(mapBytes); expect(readShotProjectBackup(track.id, 'sandbox', env).body).toEqual(sandboxBytes)
    expect(readFileSync(join(directory, 'geomotion-project.json'))).toEqual(mapBytes); expect(readFileSync(join(directory, 'shot-editor-project.json'))).toEqual(sandboxBytes)
  })
  it('rejects invalid scenes, unknown or unsafe IDs and missing or substituted sidecars without creating anything', () => {
    const {track, env, directory} = fixture(), names = readdirSync(directory)
    for (const scene of [undefined, '', '../source.kml', 'MAP', 'unknown', []]) status(() => readShotProjectBackup(track.id, scene, env), 400)
    for (const id of ['', '..', '../outside', 'missing', 'a/b', 'C:\\outside']) status(() => readShotProjectBackup(id, 'map', env), 404)
    for (const scene of ['map', 'sandbox']) status(() => readShotProjectBackup(track.id, scene, env), 404)
    expect(readdirSync(directory)).toEqual(names)
    mkdirSync(join(directory, 'geomotion-project.json')); status(() => readShotProjectBackup(track.id, 'map', env), 404)
    const outside = join(env.DSH_HOME, 'outside'), alias = join(env.DSH_HOME, 'track', 'substituted-track')
    mkdirSync(outside); writeFileSync(join(outside, 'track.json'), JSON.stringify({...track, id: 'substituted-track'})); writeFileSync(join(outside, 'geomotion-project.json'), 'must not leak')
    // Junctions do not require the Windows file-symlink privilege.
    symlinkSync(outside, alias, 'junction'); status(() => readShotProjectBackup('substituted-track', 'map', env), 404)
    expect(readFileSync(join(outside, 'geomotion-project.json'), 'utf8')).toBe('must not leak')
  })
  it('keeps oversized originals and bounds backup memory while accepting larger-than-parser sandbox files', () => {
    const {track, env, directory} = fixture(), sandboxFile = join(directory, 'shot-editor-project.json'), mapFile = join(directory, 'geomotion-project.json')
    const reparable = Buffer.alloc(2_004_097, 32); writeFileSync(sandboxFile, reparable)
    status(() => readShotEditorProject(track.id, env), 413); expect(readShotProjectBackup(track.id, 'sandbox', env).body.equals(reparable)).toBe(true)
    writeFileSync(mapFile, Buffer.alloc(SHOT_PROJECT_BACKUP_MAX_BYTES + 1, 32)); status(() => readShotProjectBackup(track.id, 'map', env), 413)
    expect(readFileSync(mapFile)).toHaveLength(SHOT_PROJECT_BACKUP_MAX_BYTES + 1); expect(readFileSync(sandboxFile).equals(reparable)).toBe(true)
  })
})

async function withServer(run: (base: string, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'cqai-shot-project-backup-')); roots.push(home)
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home; const ctx = new Context()
  try {await ctx.plugin(WebServer, {host: '127.0.0.1', port: 0}); await ctx.plugin(plugin); await run(`http://127.0.0.1:${ctx.webServer.port}${API}`, home)}
  finally {await ctx.fiber.dispose(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome}
}
describe('original shot project backup HTTP route', () => {
  it('returns attachment/json with exact malformed bytes and no-store for both scenes, requiring no write header', async () => withServer(async (base, home) => {
    const {track, directory} = fixture(home), body = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0xff, 0x00])
    for (const [scene, name] of [['map', 'geomotion-project.json'], ['sandbox', 'shot-editor-project.json']] as const) {
      writeFileSync(join(directory, name), body)
      const response = await fetch(`${base}/shot-project-backup?id=${track.id}&scene=${scene}`)
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/json'); expect(response.headers.get('content-length')).toBe(String(body.length))
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${track.id}-${scene}-project-backup.json"`)
      expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(body); expect(readFileSync(join(directory, name))).toEqual(body)
      expect((await fetch(`${base}/${scene === 'map' ? 'geomotion-project' : 'shot-editor-project'}?id=${track.id}`)).status).toBe(400)
    }
  }), 30000)
  it('rejects traversal, missing files, duplicate/extra parameters, cross-origin access and non-GET without mutations', async () => withServer(async (base, home) => {
    const {track, directory} = fixture(home), names = readdirSync(directory), action = `${base}/shot-project-backup`
    for (const query of [`id=${track.id}&scene=other`, `id=${track.id}`, `id=${track.id}&scene=map&scene=sandbox`, `id=${track.id}&scene=map&id=${track.id}`, `id=${track.id}&scene=map&file=source.kml`]) expect((await fetch(`${action}?${query}`)).status).toBe(400)
    for (const query of ['id=..%2Foutside&scene=map', 'id=missing&scene=sandbox', `id=${track.id}&scene=map`]) expect((await fetch(`${action}?${query}`)).status).toBe(404)
    expect((await fetch(`${action}?id=${track.id}&scene=map`, {headers: {origin: 'https://other.example'}})).status).toBe(403)
    expect((await fetch(`${action}?id=${track.id}&scene=map`, {headers: {'sec-fetch-site': 'cross-site'}})).status).toBe(403)
    expect((await fetch(`${action}?id=${track.id}&scene=map`, {method: 'POST', headers: {'x-cqai-track': '1'}})).status).toBe(404)
    expect(readdirSync(directory)).toEqual(names); expect(existsSync(join(directory, 'geomotion-project.json'))).toBe(false)
    writeFileSync(join(directory, 'shot-editor-project.json'), Buffer.alloc(SHOT_PROJECT_BACKUP_MAX_BYTES + 1, 32))
    const oversized = await fetch(`${action}?id=${track.id}&scene=sandbox`); expect(oversized.status).toBe(413); expect((await oversized.json()).error).toContain('备份大小上限')
    expect(readFileSync(join(directory, 'shot-editor-project.json'))).toHaveLength(SHOT_PROJECT_BACKUP_MAX_BYTES + 1)
  }), 30000)
})
