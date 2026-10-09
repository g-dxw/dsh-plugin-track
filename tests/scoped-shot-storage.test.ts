import {afterEach, describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {readTrack, trackDir, writeTrack} from '../src/artifacts.ts'
import {readGeoMotionProject, writeGeoMotionProject} from '../src/geomotion-project-store.ts'
import {readShotEditorProject, writeShotEditorProject} from '../src/shot-editor-project-store.ts'
import {readShotProjectBackup} from '../src/shot-project-backup.ts'
import {openMontageBridgePath, openMontageEnvironment, openMontageProjectsRoot, readOpenMontageSettings, runOpenMontageCommand, writeOpenMontageSettings} from '../src/openmontage-store.ts'
import {createGeoMotionProject} from '../src/track/geomotion.ts'
import {createShotEditorPlan} from '../src/track/shot-editor.ts'
import {DEFAULT_MAP_SETTINGS} from '../src/track/map-settings.ts'
import type {ShotProjectScope} from '../src/track/shot-project-scope.ts'
import type {TrackInput} from '../src/protocol.ts'

const roots: string[] = []
const source = process.env.OPENMONTAGE_TEST_SOURCE || 'E:/workspace/project/OpenMontage'
const python = process.env.OPENMONTAGE_TEST_PYTHON || 'python'
const nativeAvailable = existsSync(join(source, 'lib', 'checkpoint.py'))
afterEach(() => {for (const directory of roots.splice(0)) {if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('cqai-scoped-shot-')) throw new Error('Unexpected test directory'); rmSync(directory, {recursive: true, force: true})}})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-scoped-shot-')); roots.push(home)
  const env = {DSH_HOME: home}, input: TrackInput = {name: '路线', filename: 'source.gpx', source: '<gpx>preserved</gpx>', points: [[120, 30, 100, 1000], [120.01, 30.01, 120, 3000]], segmentStarts: [0], metrics: {distance: 1000, elevationGain: 20, elevationLoss: 0, duration: 2000, elevationMax: 120, elevationMin: 100, bbox: [120, 30, 120.01, 30.01]}}
  // These scopes use the installed native schema; no fake OpenMontage library
  // or modification of the external source is involved.
  writeOpenMontageSettings({sourceDirectory: source, pythonPath: python}, env)
  const {id} = writeTrack(input, env), track = readTrack(id, env)!, imported = createGeoMotionProject(track, [])
  const map = {trackId: id, sourceFingerprint: imported.sourceFingerprint, document: imported.document}
  const sandbox = {schema: 'cqai-track-shot-editor@1', plan: createShotEditorPlan({trackId: id, fingerprint: 'source-1', sceneFingerprint: 'scene-1', title: '相机', camera: {position: [10, 20, 30], target: [0, 0, 0], fov: 45}}), appearance: {lighting: {...DEFAULT_MAP_SETTINGS.lighting}, sandboxColors: {...DEFAULT_MAP_SETTINGS.sandboxColors}, sandboxBackground: 'environment'}}
  function shot(projectId: string, shotId: string, editor: 'map' | 'sandbox' = 'map') {
    const workspace = join(openMontageProjectsRoot(env), projectId), directory = join(workspace, 'shots', shotId)
    mkdirSync(directory, {recursive: true}); writeFileSync(join(workspace, 'track-binding.json'), JSON.stringify({projectId, trackId: id, title: '策划项目', createdAt: '2026-10-09T01:00:00Z', updatedAt: '2026-10-09T01:00:00Z', sessionId: null}))
    const sceneId = `scene-${shotId}`, mapping = {shot_id: shotId, track_id: id, editor, scene_id: sceneId}
    writeFileSync(join(directory, 'shot-binding.json'), JSON.stringify(mapping))
    const planFile = join(workspace, 'artifacts', 'scene_plan.json'), plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {version: '1.0', scenes: [], metadata: {track_shots: []}}
    if (!plan.scenes.some((scene: {id: string}) => scene.id === sceneId)) plan.scenes.push({id: sceneId, type: 'screen_recording', description: '独立镜头存储测试', start_seconds: 0, end_seconds: 5, required_assets: [{type: 'video', description: '编辑器录制', source: 'record'}]})
    plan.metadata.track_shots.push(mapping); mkdirSync(dirname(planFile), {recursive: true}); writeFileSync(planFile, JSON.stringify(plan))
    return {scope: {projectId, shotId} satisfies ShotProjectScope, directory}
  }
  return {id, env, map, sandbox, shot, legacy: trackDir(id, env)}
}
function status(run: () => unknown, expected: number) {try {run(); expect.fail('Expected failure')} catch (error) {expect(error).toMatchObject({status: expected})}}
describe.runIf(nativeAvailable)('project scoped map and sandbox sidecars', () => {
  it('keeps same-route shots and same-shot names in different projects independent of legacy storage', () => {
    const {id, env, map, shot, legacy} = fixture(), first = shot('project-1', 'shot-1'), second = shot('project-1', 'shot-2'), other = shot('project-2', 'shot-1')
    const original = writeGeoMotionProject(id, map, null, env)
    expect(readGeoMotionProject(id, env, first.scope)).toBeNull(); expect(existsSync(join(first.directory, 'geomotion-project.json'))).toBe(false)
    const a = writeGeoMotionProject(id, {...map, document: {...map.document, name: '第一个镜头', duration: 24}}, null, env, first.scope)
    const b = writeGeoMotionProject(id, {...map, document: {...map.document, name: '第二个镜头', duration: 26}}, null, env, second.scope)
    const c = writeGeoMotionProject(id, {...map, document: {...map.document, name: '另一个项目', duration: 28}}, null, env, other.scope)
    expect(readGeoMotionProject(id, env, first.scope)).toEqual(a); expect(readGeoMotionProject(id, env, second.scope)).toEqual(b); expect(readGeoMotionProject(id, env, other.scope)).toEqual(c)
    expect(readGeoMotionProject(id, env)).toEqual(original); expect(JSON.parse(readFileSync(join(legacy, 'geomotion-project.json'), 'utf8'))).toEqual(original)
    status(() => writeGeoMotionProject(id, map, b.revision, env, first.scope), 409)
    expect(readGeoMotionProject(id, env, first.scope)).toEqual(a)
    expect(readShotProjectBackup(id, 'map', env, first.scope).body).toEqual(readFileSync(join(first.directory, 'geomotion-project.json')))
  })
  it('preserves sandbox keys, route progress, clips and appearance under a scope without touching legacy drafts', () => {
    const {id, env, sandbox, shot} = fixture(), target = shot('project-1', 'sandbox-1', 'sandbox')
    const legacy = writeShotEditorProject(id, sandbox, null, env), revised = structuredClone(sandbox)
    revised.plan.cameraKeyframes[0].id = 'authored-camera'; revised.plan.routeKeyframes[1].time = 5
    revised.plan.caption = {text: '山脊镜头', from: 2, to: 9}; revised.appearance.lighting.intensity = 2.4
    const saved = writeShotEditorProject(id, revised, null, env, target.scope)
    expect(readShotEditorProject(id, env, target.scope)).toEqual(saved); expect(readShotEditorProject(id, env)).toEqual(legacy)
    expect(readShotProjectBackup(id, 'sandbox', env, target.scope).body).toEqual(readFileSync(join(target.directory, 'shot-editor-project.json')))
    status(() => writeShotEditorProject(id, sandbox, null, env, target.scope), 409)
  })
  it('rejects invalid bindings and preserves malformed originals with raw backups instead of rebuilding', () => {
    const {id, env, map, shot} = fixture(), target = shot('project-1', 'shot-1'), bytes = Buffer.from(' {"old":\r\n damaged draft')
    writeFileSync(join(target.directory, 'geomotion-project.json'), bytes)
    status(() => readGeoMotionProject(id, env, target.scope), 400); status(() => writeGeoMotionProject(id, map, null, env, target.scope), 400)
    expect(readShotProjectBackup(id, 'map', env, target.scope).body).toEqual(bytes)
    for (const scope of [{projectId: '../outside', shotId: 'shot-1'}, {projectId: 'project-1', shotId: '../outside'}]) status(() => readGeoMotionProject(id, env, scope), 400)
    writeFileSync(join(target.directory, 'shot-binding.json'), JSON.stringify({shot_id: 'shot-1', track_id: 'different-track', editor: 'map', scene_id: 'SC03'}))
    status(() => readGeoMotionProject(id, env, target.scope), 404)
    expect(readFileSync(join(target.directory, 'geomotion-project.json'))).toEqual(bytes)
  })
  it('serializes independent Python engine saves and keeps the losing revision from overwriting a winning host', async () => {
    const {id, env, map, shot} = fixture(), target = shot('project-1', 'shot-1')
    const saved = writeGeoMotionProject(id, map, null, env, target.scope)
    const payload = {trackId: id, ...target.scope, editor: 'map', expectedRevision: saved.revision}
    const results = await Promise.allSettled([
      runOpenMontageCommand('engine-write', {...payload, project: {...saved, revision: 'host-a-revision', document: {...saved.document, name: 'host-a'}}}, env),
      runOpenMontageCommand('engine-write', {...payload, project: {...saved, revision: 'host-b-revision', document: {...saved.document, name: 'host-b'}}}, env),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({reason: {status: 409}})
    const winner = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<unknown>
    expect(readGeoMotionProject(id, env, target.scope)).toEqual(winner.value)
  }, 30000)
  it('waits for the same OS project lock held by native take transactions before writing an engine', async () => {
    const {id, env, map, shot} = fixture(), target = shot('project-1', 'shot-1'), saved = writeGeoMotionProject(id, map, null, env, target.scope)
    const lockHolder = spawn(python, ['-u', '-c', 'import importlib.util,sys\ns=importlib.util.spec_from_file_location("track_bridge",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith m.locked(m.project_path(sys.argv[2])):\n print("LOCKED",flush=True)\n sys.stdin.readline()\n', openMontageBridgePath(), target.scope.projectId], {env: {...process.env, ...env, ...openMontageEnvironment(readOpenMontageSettings(env), env)}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
    let stderr = '', pending: Promise<unknown> | undefined
    lockHolder.stderr.on('data', chunk => {stderr += chunk.toString()})
    try {
      await new Promise<void>((resolveReady, rejectReady) => {lockHolder.stdout.on('data', chunk => {if (chunk.toString().includes('LOCKED')) resolveReady()}); lockHolder.once('error', rejectReady); lockHolder.once('exit', code => {if (code) rejectReady(new Error(stderr))})})
      let completed = false
      pending = runOpenMontageCommand('engine-write', {trackId: id, ...target.scope, editor: 'map', expectedRevision: saved.revision, project: {...saved, revision: 'after-native-lock'}}, env).finally(() => {completed = true})
      await new Promise(resolveDelay => setTimeout(resolveDelay, 80))
      expect(completed).toBe(false); expect(readGeoMotionProject(id, env, target.scope)?.revision).toBe(saved.revision)
      lockHolder.stdin.end('release\n'); await pending
      expect(readGeoMotionProject(id, env, target.scope)?.revision).toBe('after-native-lock')
    } finally {lockHolder.stdin.end(); if (lockHolder.exitCode === null) lockHolder.kill(); await pending?.catch(() => {})}
  }, 30000)
  it('keeps a saved scoped project intact if the Python lock writer cannot start', () => {
    const {id, env, map, shot} = fixture(), target = shot('project-1', 'shot-1'), saved = writeGeoMotionProject(id, map, null, env, target.scope)
    const file = join(target.directory, 'geomotion-project.json'), original = readFileSync(file)
    writeOpenMontageSettings({sourceDirectory: source, pythonPath: 'cqai-nonexistent-python-for-test'}, env)
    status(() => writeGeoMotionProject(id, {...map, document: {...map.document, name: '不能丢失原镜头'}}, saved.revision, env, target.scope), 503)
    expect(readFileSync(file)).toEqual(original); expect(readGeoMotionProject(id, env, target.scope)).toEqual(saved)
  })
})
