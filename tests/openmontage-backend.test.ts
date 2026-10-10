import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {createReadStream} from 'node:fs'
import type {IncomingMessage} from 'node:http'
import {writeTrack} from '../src/artifacts.ts'
import {createOpenMontageProject, ensureOpenMontageAgentWorkspace, listOpenMontageProjects, OpenMontageError, openMontageProjectsRoot, readOpenMontageProject, readOpenMontageSettings, resolveOpenMontageShotDirectory, runOpenMontageCommand, saveOpenMontageAgentSession, writeOpenMontageSettings} from '../src/openmontage-store.ts'
import {saveOpenMontageShotResult, probeOpenMontageVideo, readOpenMontageState} from '../src/openmontage-routes.ts'
import {disposeOpenMontage} from '../src/openmontage-runtime.ts'
import {readResources, updateResource} from '../src/resource-store.ts'
import type {OpenMontageProject} from '../src/track/openmontage.ts'

// Optional local integration dependency: the plugin never installs or vendors
// OpenMontage. Pure boundary tests always run, native contract tests use the
// explicit installed checkout when available (as in the acceptance host).
const source = process.env.OPENMONTAGE_TEST_SOURCE || 'E:/workspace/project/OpenMontage'
const python = process.env.OPENMONTAGE_TEST_PYTHON || 'python'
const nativeAvailable = existsSync(join(source, 'lib', 'checkpoint.py'))
const base = mkdtempSync(join(tmpdir(), 'cqai-openmontage-backend-')), env = {DSH_HOME: base}
const trackInput = {name: '隔离武功山示例', filename: 'route.gpx', source: '<gpx>测试素材</gpx>', points: [[114.15, 27.46, 400, 1000], [114.17, 27.48, 1918, 5000]] as [number, number, number, number][], metrics: {distance: 35000, elevationGain: 2500, elevationLoss: 2100, elevationMax: 1918, elevationMin: 400, duration: 4000, bbox: [114.15, 27.46, 114.17, 27.48] as [number, number, number, number]}}
const trackId = writeTrack(trackInput, env).id
const brief = {version: '1.0', title: '隔离流程验收', hook: '先确认目标和素材', key_points: ['测试路线位置介绍', '测试三段路线攻略'], tone: '口语', style: 'test', target_platform: 'generic', target_duration_seconds: 10}
const script = {version: '1.0', title: '测试脚本', total_duration_seconds: 10, sections: [{id: 'SEC01', text: '这是隔离测试脚本，不代表用户真实行程。', start_seconds: 0, end_seconds: 10}]}
const plan = {version: '1.0', scenes: [
  {id: 'SC01', type: 'screen_recording', description: '地图定位测试', start_seconds: 0, end_seconds: 5, script_section_id: 'SEC01', shot_intent: '测试位置定位', required_assets: [{type: 'video', description: '地图镜头', source: 'record'}]},
  {id: 'SC02', type: 'screen_recording', description: '沙盘总览测试', start_seconds: 5, end_seconds: 10, script_section_id: 'SEC01', required_assets: [{type: 'video', description: '沙盘镜头', source: 'record'}]}]}
type State = {stages: Array<{stage: string; digest: string | null; approved: boolean}>; canProduce: boolean; scenePlanDigest: string; mappings: Array<{shot_id: string; scene_id: string; editor: 'map' | 'sandbox'}>; takes: Array<Record<string, unknown>>}
let project: OpenMontageProject
const request = (extras: Record<string, unknown>, selected = project) => ({trackId, projectId: selected.projectId, ...extras})
const state = (selected = project) => runOpenMontageCommand<State>('state', request({}, selected), env)
async function approved(stage: string, artifact: unknown, selected = project) {
  const current = await state(selected), expectedDigest = current.stages.find(item => item.stage === stage)!.digest
  const saved = await runOpenMontageCommand<{digest: string}>('commit', request({stage, artifact, expectedDigest}, selected), env)
  await runOpenMontageCommand('approve', request({stage, expectedDigest: saved.digest, humanApprovalEvidence: '独立自动化验收 fixture 明确批准该固定测试成果，未调用生产 Agent'}, selected), env)
  return saved.digest
}
afterAll(async () => {disposeOpenMontage(env); await new Promise(resolve => setTimeout(resolve, 300)); if (dirname(resolve(base)) !== resolve(tmpdir()) || !basename(base).startsWith('cqai-openmontage-backend-')) throw new Error('Unsafe cleanup'); rmSync(base, {recursive: true, force: true})})

describe('OpenMontage local storage boundaries', () => {
  it('defaults to the explicit local checkout and validates settings without executing or installing anything', () => {
    const settingsSource = nativeAvailable ? resolve(source) : join(base, 'settings-source-fixture')
    expect(readOpenMontageSettings(env)).toEqual({sourceDirectory: 'E:\\workspace\\project\\OpenMontage', pythonPath: 'python'})
    for (const value of [{sourceDirectory: '../outside', pythonPath: 'python'}, {sourceDirectory: settingsSource, pythonPath: 'python\nextra'}, {sourceDirectory: settingsSource, pythonPath: 'python', token: 'ignored'}]) expect(() => writeOpenMontageSettings(value, env)).toThrow(OpenMontageError)
    expect(writeOpenMontageSettings({sourceDirectory: settingsSource, pythonPath: python}, env).sourceDirectory).toBe(settingsSource)
    expect(listOpenMontageProjects(trackId, env)).toEqual([])
    expect(() => listOpenMontageProjects('../outside', env)).toThrow()
  })
  it('rejects cross-track project binding, traversal and substituted project directories before Python runs', () => {
    const root = openMontageProjectsRoot(env), p = join(root, 'boundary-project'); mkdirSync(p, {recursive: true})
    writeFileSync(join(p, 'track-binding.json'), JSON.stringify({projectId: 'boundary-project', trackId: 'another', title: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: null}))
    expect(() => readOpenMontageProject(trackId, 'boundary-project', env)).toThrow()
    expect(() => readOpenMontageProject(trackId, '../outside', env)).toThrow()
    const other = join(base, 'outside-project'); mkdirSync(other)
    symlinkSync(other, join(root, 'alias-project'), 'junction')
    expect(() => readOpenMontageProject(trackId, 'alias-project', env)).toThrow()
  })
})

describe.skipIf(!nativeAvailable)('actual OpenMontage schema/checkpoint bridge', () => {
  beforeAll(async () => {project = await createOpenMontageProject(trackId, '隔离武功山验收项目', env)}, 45000)
  it('creates a native hybrid marker and separate workspace without checkpoints, generation or source changes', async () => {
    expect(JSON.parse(readFileSync(join(project.workspace, 'project.json'), 'utf8'))).toMatchObject({pipeline_type: 'hybrid', project_id: project.projectId})
    expect(readdirSync(project.workspace).some(name => name.startsWith('checkpoint_'))).toBe(false)
    const workspace = await ensureOpenMontageAgentWorkspace(trackId, project.projectId, env)
    expect(workspace.path).toBe(project.workspace); expect(workspace.sessionId).toBeNull()
    expect(workspace.environment.OPENMONTAGE_PROJECTS_DIR).toBe(openMontageProjectsRoot(env)); expect(workspace.environment.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(readFileSync(join(project.workspace, 'AGENTS.md'), 'utf8')).toContain('humanApprovalEvidence')
    const snapshot = JSON.parse(readFileSync(join(project.workspace, 'track-material-snapshot.json'), 'utf8'))
    expect(snapshot.track.name).toBe('隔离武功山示例'); expect(snapshot.track.metrics.distance).toBe(35000)
    await saveOpenMontageAgentSession(trackId, project.projectId, 'independent-session-01', env)
    expect(readOpenMontageProject(trackId, project.projectId, env).sessionId).toBe('independent-session-01')
    const second = await createOpenMontageProject(trackId, '同一路线另一视频', env)
    expect(second.workspace).not.toBe(project.workspace); expect(second.sessionId).toBeNull()
  }, 45000)
  it('enforces real schema, per-stage gates and content CAS before any next stage', async () => {
    await expect(runOpenMontageCommand('commit', request({stage: 'script', artifact: script, expectedDigest: null}), env)).rejects.toMatchObject({status: 409})
    await expect(runOpenMontageCommand('commit', request({stage: 'idea', artifact: {version: '1.0'}, expectedDigest: null}), env)).rejects.toMatchObject({status: 400})
    const saved = await runOpenMontageCommand<{digest: string}>('commit', request({stage: 'idea', artifact: brief, expectedDigest: null}), env)
    expect((await state()).canProduce).toBe(false)
    await expect(runOpenMontageCommand('commit', request({stage: 'idea', artifact: brief, expectedDigest: null}), env)).rejects.toMatchObject({status: 409})
    await expect(runOpenMontageCommand('approve', request({stage: 'idea', expectedDigest: saved.digest}), env)).rejects.toMatchObject({status: 400})
    await expect(runOpenMontageCommand('approve', request({stage: 'idea', expectedDigest: '0'.repeat(64), humanApprovalEvidence: '测试批准'}), env)).rejects.toMatchObject({status: 409})
    await runOpenMontageCommand('approve', request({stage: 'idea', expectedDigest: saved.digest, humanApprovalEvidence: '测试 fixture 已明确批准'}), env)
    await approved('script', script); await approved('scene_plan', plan)
    expect((await state()).stages.map(stage => stage.approved)).toEqual([true, true, true])
  }, 60000)
  it('binds multiple independent map/sandbox shots in metadata without invalidating creative approval', async () => {
    const before = await state()
    for (const [sceneId, editor] of [['SC01', 'map'], ['SC02', 'sandbox']] as const) {
      const mapping = await runOpenMontageCommand<{shot_id: string}>('bind', request({sceneId, editor, expectedScenePlanDigest: before.scenePlanDigest}), env)
      const path = resolveOpenMontageShotDirectory(trackId, {projectId: project.projectId, shotId: mapping.shot_id}, env)
      expect(path).toContain(mapping.shot_id)
      expect(readFileSync(join(path, 'shot-binding.json'), 'utf8')).toContain(sceneId)
      const again = await runOpenMontageCommand<{shot_id: string}>('bind', request({sceneId, editor, expectedScenePlanDigest: before.scenePlanDigest}), env)
      expect(again.shot_id).toBe(mapping.shot_id)
    }
    const after = await state(); expect(after.scenePlanDigest).toBe(before.scenePlanDigest); expect(after.canProduce).toBe(true)
    expect(after.mappings).toHaveLength(2)
    await expect(runOpenMontageCommand('bind', request({sceneId: 'SC01', editor: 'sandbox', expectedScenePlanDigest: before.scenePlanDigest}), env)).rejects.toMatchObject({status: 409})
    const canonical = JSON.parse(readFileSync(join(project.workspace, 'artifacts', 'scene_plan.json'), 'utf8'))
    expect(canonical.scenes[0]).not.toHaveProperty('editor'); expect(canonical.metadata.track_shots).toHaveLength(2)
  }, 45000)
  it('checks actual MP4 specs, preserves existing assets, supports idempotent partial takes and rejects stale editor revisions', async () => {
    const current = await state(), shot = current.mappings.find(shot => shot.editor === 'map')!, directory = resolveOpenMontageShotDirectory(trackId, {projectId: project.projectId, shotId: shot.shot_id}, env)
    writeFileSync(join(directory, 'geomotion-project.json'), JSON.stringify({revision: 'test-revision-01'}))
    const file = join(base, 'actual-recording.mp4'), generated = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], {windowsHide: true})
    expect(generated.status, generated.stderr?.toString()).toBe(0)
    expect(await probeOpenMontageVideo(file, 'video/mp4', env)).toMatchObject({width: 320, height: 180, duration: 1, fps: 24})
    writeFileSync(join(project.workspace, 'artifacts', 'asset_manifest.json'), JSON.stringify({version: '1.0', assets: [{id: 'old-image', type: 'image', path: 'assets/images/old.png', source_tool: 'provided', scene_id: 'SC01'}]}))
    const identity = {trackId, projectId: project.projectId, shotId: shot.shot_id, takeId: 'test-take-01', scenePlanDigest: current.scenePlanDigest, projectRevision: 'test-revision-01', editor: 'map' as const}
    const upload = () => {const req = createReadStream(file) as unknown as IncomingMessage; Object.assign(req, {headers: {'content-type': 'video/mp4'}}); return req}
    const take = await saveOpenMontageShotResult(upload(), identity, env)
    expect(take).toMatchObject({takeId: 'test-take-01', width: 320, height: 180, fps: 24, duration: 1, sceneId: 'SC01'})
    expect(existsSync(join(project.workspace, take.path))).toBe(true)
    const resource = readResources(trackId, env).assets.find(asset => asset.kind === 'video')!, userTags = Array.from({length: 30}, (_, index) => `用户标签${index}`)
    updateResource(trackId, resource.id, {videoRole: 'ambient', tags: userTags}, env)
    const duplicate = await saveOpenMontageShotResult(upload(), identity, env)
    expect(duplicate.createdAt).toBe(take.createdAt)
    expect(readResources(trackId, env).assets.find(asset => asset.id === resource.id)).toMatchObject({videoRole: 'ambient', tags: userTags})
    const manifest = JSON.parse(readFileSync(join(project.workspace, 'artifacts', 'asset_manifest.json'), 'utf8'))
    expect(manifest.assets).toHaveLength(2); expect(manifest.assets[0].id).toBe('old-image')
    expect(JSON.parse(readFileSync(join(project.workspace, 'checkpoint_assets.json'), 'utf8')).status).toBe('in_progress')
    expect(readResources(trackId, env).assets.filter(asset => asset.kind === 'video')).toHaveLength(1)
    const canonicalPath = join(project.workspace, 'artifacts', 'scene_plan.json'), originalPlan = readFileSync(canonicalPath, 'utf8'), changedRouting = JSON.parse(originalPlan)
    changedRouting.metadata.track_shots[0].scene_id = 'SC02'; changedRouting.metadata.track_shots[1].scene_id = 'SC01'
    writeFileSync(canonicalPath, JSON.stringify(changedRouting))
    await expect(saveOpenMontageShotResult(upload(), {...identity, takeId: 'test-take-misbound'}, env)).rejects.toMatchObject({status: 409, videoPreserved: true})
    expect(JSON.parse(readFileSync(join(project.workspace, 'artifacts', 'asset_manifest.json'), 'utf8')).assets).toHaveLength(2)
    writeFileSync(canonicalPath, originalPlan)
    writeFileSync(join(directory, 'geomotion-project.json'), JSON.stringify({revision: 'test-revision-02'}))
    await expect(saveOpenMontageShotResult(upload(), {...identity, takeId: 'test-take-stale'}, env)).rejects.toMatchObject({status: 409, attemptId: 'test-take-stale', videoPreserved: true})
    expect((await state()).takes).toHaveLength(1)
  }, 60000)
  it('invalidates downstream approvals after an external upstream edit and preserves immutable old versions', async () => {
    const oldPlan = readFileSync(join(project.workspace, 'artifacts', 'scene_plan.json'), 'utf8')
    writeFileSync(join(project.workspace, 'artifacts', 'brief.json'), JSON.stringify({...brief, hook: '已发生改变'}))
    const changed = await state()
    expect(changed.stages.map(stage => stage.approved)).toEqual([false, false, false]); expect(changed.canProduce).toBe(false)
    expect(readFileSync(join(project.workspace, 'artifacts', 'scene_plan.json'), 'utf8')).toBe(oldPlan)
    expect(JSON.parse(readFileSync(join(project.workspace, 'checkpoint_scene_plan.json'), 'utf8')).human_approved).toBe(false)
    expect(readdirSync(join(project.workspace, 'history')).length).toBeGreaterThan(5)
  }, 45000)
  it('validates MediaRecorder-style streaming WebM using actual packet times when Duration is absent', async () => {
    const file = join(base, 'streaming-recording.webm')
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=24', '-t', '1', '-c:v', 'libvpx', '-f', 'webm', '-live', '1', 'pipe:1'], {windowsHide: true, maxBuffer: 8 * 1024 * 1024})
    expect(generated.status, generated.stderr?.toString()).toBe(0); writeFileSync(file, generated.stdout)
    const raw = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], {windowsHide: true, encoding: 'utf8'})
    expect(JSON.parse(raw.stdout).format?.duration).toBeUndefined()
    const actual = await probeOpenMontageVideo(file, 'video/webm', env)
    expect(actual).toMatchObject({mime: 'video/webm', width: 320, height: 180}); expect(actual.duration).toBeGreaterThan(0.95); expect(actual.duration).toBeLessThan(1.05)
    expect(actual.fps).toBeGreaterThan(23); expect(actual.fps).toBeLessThan(25)
  }, 45000)
  it('serializes concurrent writers and recovers an interrupted journal before reading', async () => {
    const selected = await createOpenMontageProject(trackId, '并发与中断恢复', env), payload = request({stage: 'idea', artifact: brief, expectedDigest: null}, selected)
    const results = await Promise.allSettled([runOpenMontageCommand('commit', payload, env), runOpenMontageCommand('commit', payload, env)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({reason: {status: 409}})
    writeFileSync(join(selected.workspace, '.track-openmontage-transaction.json'), JSON.stringify({version: 1, writes: {'track-takes.json': {version: 1, takes: []}}}))
    expect((await state(selected)).stages[0].digest).toBeTruthy()
    expect(existsSync(join(selected.workspace, '.track-openmontage-transaction.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(selected.workspace, 'track-takes.json'), 'utf8'))).toEqual({version: 1, takes: []})
  }, 60000)
  it('uses extended Windows paths for native libraries in a deeply nested DSH_HOME', async () => {
    const longHome = join(base, 'long-runtime-home-'.repeat(6), 'deep-isolated-profile-'.repeat(4)), longEnv = {DSH_HOME: longHome}
    const longTrack = writeTrack(trackInput, longEnv).id
    writeOpenMontageSettings({sourceDirectory: source, pythonPath: python}, longEnv)
    const longProject = await createOpenMontageProject(longTrack, '长路径验收', longEnv)
    expect(longProject.workspace.length).toBeGreaterThan(260)
    const saved = await runOpenMontageCommand<{digest: string}>('commit', {trackId: longTrack, projectId: longProject.projectId, stage: 'idea', artifact: brief, expectedDigest: null}, longEnv)
    await runOpenMontageCommand('approve', {trackId: longTrack, projectId: longProject.projectId, stage: 'idea', expectedDigest: saved.digest, humanApprovalEvidence: '仅批准长路径自动化测试fixture'}, longEnv)
    expect(JSON.parse(readFileSync(join(longProject.workspace, 'checkpoint_idea.json'), 'utf8')).human_approved).toBe(true)
    expect((await ensureOpenMontageAgentWorkspace(longTrack, longProject.projectId, longEnv)).path).toBe(longProject.workspace)
  }, 45000)
  it('serves the real Backlot board/state and forwards real project filesystem changes over SSE', async () => {
    const selected = await createOpenMontageProject(trackId, 'Backlot SSE 验收', env), actual = await readOpenMontageState(trackId, selected.projectId, env)
    expect(actual.board).toHaveProperty('storyboard'); expect(actual.boardUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\//u)
    const origin = new URL(actual.boardUrl).origin
    const page = await fetch(actual.boardUrl); expect(page.ok).toBe(true)
    const html = await page.text(); expect(html).toContain('board.js'); expect(html).toContain('lang="zh-CN"'); expect(html).toContain('/ui/track-zh-cn.js?v=')
    const locale = await fetch(`${origin}/ui/track-zh-cn.js`); expect(locale.ok).toBe(true); expect(locale.headers.get('content-type')).toContain('javascript'); expect(locale.headers.get('cache-control')).toMatch(/no-cache|no-store/u); expect(await locale.text()).toContain('需求与大纲')
    expect(html).toContain('/ui/track-workbench.css?v='); expect(html).toContain('/ui/track-workbench.js?v=')
    const style = await fetch(`${origin}/ui/track-workbench.css`); expect(style.ok).toBe(true); expect(style.headers.get('content-type')).toContain('text/css'); expect(await style.text()).toContain('prefers-reduced-motion')
    const workbench = await fetch(`${origin}/ui/track-workbench.js`); expect(workbench.ok).toBe(true); expect(workbench.headers.get('content-type')).toContain('javascript'); expect(await workbench.text()).toContain('track-openmontage-theme')
    const library = await fetch(origin); expect(await library.text()).toContain('/ui/track-zh-cn.js?v=')
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000)
    const events = await fetch(`${origin}/api/project/${selected.projectId}/events`, {signal: controller.signal})
    const reader = events.body!.getReader(), decoder = new TextDecoder()
    try {
      expect(decoder.decode((await reader.read()).value)).toContain('hello')
      await runOpenMontageCommand('commit', request({stage: 'idea', artifact: brief, expectedDigest: null}, selected), env)
      let changes = ''
      while (!changes.includes('change')) {const next = await reader.read(); if (next.done) break; changes += decoder.decode(next.value)}
      expect(changes).toContain('change')
      expect((await readOpenMontageState(trackId, selected.projectId, env)).stages[0].status).toBe('awaiting_human')
    } finally {clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); reader.releaseLock()}
  }, 45000)
})
