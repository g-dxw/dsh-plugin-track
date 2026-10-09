import {spawn, spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveDshHome} from '@deepseek-ai/dsh-home-paths'
import {readTrack, trackDir} from './artifacts.ts'
import {readResources} from './resource-store.ts'
import {readVideoMaterials} from './video-materials-store.ts'
import {readPlacemarkState} from './placemark-state-store.ts'
import {effectivePlacemarks} from './track/placemark-state.ts'
import type {OpenMontageAgentWorkspace, OpenMontageProject, OpenMontageSettings, OpenMontageShotScope} from './track/openmontage.ts'

export class OpenMontageError extends Error {constructor(message: string, readonly status = 400) {super(message)}}
export const OPENMONTAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u
export const OPENMONTAGE_JSON_MAX_BYTES = 32 * 1024 * 1024
export function openMontageRoot(env: NodeJS.ProcessEnv = process.env): string {return join(resolveDshHome(undefined, env), 'track-agent', 'openmontage')}
export function openMontageProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {return join(openMontageRoot(env), 'projects')}
export function openMontageBridgePath(): string {
  // Source Vite and packaged lib/index.js both resolve the package's sibling scripts.
  return fileURLToPath(new URL('../scripts/openmontage_bridge.py', import.meta.url))
}
function id(value: unknown): string {if (typeof value !== 'string' || !OPENMONTAGE_ID.test(value)) throw new OpenMontageError('项目、轨迹或镜头编号无效'); return value}
function object(value: unknown): Record<string, unknown> {if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpenMontageError('OpenMontage 请求格式无效'); return value as Record<string, unknown>}
function json(path: string): unknown {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OPENMONTAGE_JSON_MAX_BYTES) throw new OpenMontageError('OpenMontage 文件不可读取')
  try {return JSON.parse(readFileSync(path, 'utf8'))} catch {throw new OpenMontageError(`OpenMontage 文件损坏: ${path.split(/[\\/]/u).pop()}`)}
}
function atomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), {recursive: true})
  const temporary = `${path}.${randomUUID()}.tmp`
  try {writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'}); renameSync(temporary, path)}
  finally {try {unlinkSync(temporary)} catch {}}
}
export function readOpenMontageSettings(env: NodeJS.ProcessEnv = process.env): OpenMontageSettings {
  const value = json(join(openMontageRoot(env), 'settings.json'))
  if (value === null) return {sourceDirectory: 'E:\\workspace\\project\\OpenMontage', pythonPath: 'python'}
  const saved = object(value)
  if (typeof saved.sourceDirectory !== 'string' || !isAbsolute(saved.sourceDirectory) || typeof saved.pythonPath !== 'string' || !saved.pythonPath.trim()) throw new OpenMontageError('OpenMontage 连接设置损坏，请重新设置')
  return {sourceDirectory: saved.sourceDirectory, pythonPath: saved.pythonPath}
}
export function writeOpenMontageSettings(value: unknown, env: NodeJS.ProcessEnv = process.env): OpenMontageSettings {
  const input = object(value)
  if (Object.keys(input).some(key => !['sourceDirectory', 'pythonPath'].includes(key)) || typeof input.sourceDirectory !== 'string' || !isAbsolute(input.sourceDirectory)
    || input.sourceDirectory.length > 4096 || typeof input.pythonPath !== 'string' || !input.pythonPath.trim() || input.pythonPath.length > 4096 || /[\r\n\0]/u.test(input.pythonPath + input.sourceDirectory)) throw new OpenMontageError('请填写源码绝对路径及 Python 可执行文件路径')
  const settings = {sourceDirectory: resolve(input.sourceDirectory), pythonPath: input.pythonPath.trim()}
  atomic(join(openMontageRoot(env), 'settings.json'), settings)
  return settings
}
export function openMontageEnvironment(settings: OpenMontageSettings, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {PYTHONPATH: settings.sourceDirectory, OPENMONTAGE_PROJECTS_DIR: openMontageProjectsRoot(env), PYTHONDONTWRITEBYTECODE: '1',
    TRACK_OPENMONTAGE_THUMB_CACHE: join(openMontageRoot(env), 'cache', 'thumbs'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}
}
/** All commands use argv without a shell; Python receives one bounded JSON on stdin. */
export function runOpenMontageCommand<T = Record<string, unknown>>(command: string, request: unknown, env: NodeJS.ProcessEnv = process.env, settings = readOpenMontageSettings(env)): Promise<T> {
  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload) > OPENMONTAGE_JSON_MAX_BYTES) return Promise.reject(new OpenMontageError('OpenMontage 请求内容过大', 413))
  return new Promise((success, failure) => {
    const child = spawn(settings.pythonPath, [openMontageBridgePath(), command], {cwd: settings.sourceDirectory,
      env: {...process.env, ...env, ...openMontageEnvironment(settings, env)}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
    let output = '', errors = '', settled = false
    const finish = (error?: Error, result?: T) => {if (settled) return; settled = true; clearTimeout(timer); if (error) failure(error); else success(result!)}
    const timer = setTimeout(() => {child.kill(); finish(new OpenMontageError('OpenMontage 本地调用超时，请检查连接或项目锁', 503))}, 45000)
    child.stdout.on('data', (chunk: Buffer) => {output += chunk.toString('utf8'); if (Buffer.byteLength(output) > OPENMONTAGE_JSON_MAX_BYTES) {child.kill(); finish(new OpenMontageError('OpenMontage 返回内容过大', 413))}})
    child.stderr.on('data', (chunk: Buffer) => {errors = (errors + chunk.toString('utf8')).slice(-6000)})
    child.on('error', error => finish(new OpenMontageError(`无法启动 Python：${error.message}`, 503)))
    child.stdin.on('error', () => {/* Exit/error handler carries the useful diagnostics. */})
    child.on('close', code => {
      if (settled) return
      try {
        const result = JSON.parse(output.trim()) as {ok?: boolean; result?: T; error?: string; status?: number}
        if (!result.ok || code !== 0) {finish(new OpenMontageError(result.error || errors || 'OpenMontage 调用失败', result.status ?? 503)); return}
        finish(undefined, result.result)
      } catch {finish(new OpenMontageError(`OpenMontage 未返回有效 JSON：${errors || output.slice(-1000)}`, 503))}
    })
    child.stdin.end(payload)
  })
}
/** Scoped legacy store APIs are synchronous; only their atomic persist crosses this boundary. */
export function runOpenMontageCommandSync<T = Record<string, unknown>>(command: string, request: unknown, env: NodeJS.ProcessEnv = process.env, settings = readOpenMontageSettings(env)): T {
  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload) > OPENMONTAGE_JSON_MAX_BYTES) throw new OpenMontageError('OpenMontage 请求内容过大', 413)
  const child = spawnSync(settings.pythonPath, [openMontageBridgePath(), command], {cwd: settings.sourceDirectory,
    env: {...process.env, ...env, ...openMontageEnvironment(settings, env)}, windowsHide: true, input: payload, encoding: 'utf8', timeout: 45000, maxBuffer: OPENMONTAGE_JSON_MAX_BYTES})
  if (child.error) throw new OpenMontageError(`OpenMontage 工程写入失败：${child.error.message}`, 503)
  let value: {ok?: boolean; result?: T; error?: string; status?: number}
  try {value = JSON.parse(child.stdout.trim()) as typeof value} catch {throw new OpenMontageError(`OpenMontage 工程写入未返回有效 JSON：${child.stderr.slice(-6000)}`, 503)}
  if (!value.ok || child.status !== 0) throw new OpenMontageError(value.error || 'OpenMontage 工程写入失败', value.status ?? 503)
  return value.result!
}
export function requiredOpenMontageTrack(trackId: unknown, env: NodeJS.ProcessEnv = process.env) {
  const track = readTrack(id(trackId), env)
  if (!track) throw new OpenMontageError('轨迹不存在', 404)
  return track
}
function checkedDirectory(path: string, root: string): string {
  const stat = lstatSync(path, {throwIfNoEntry: false})
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new OpenMontageError('项目或镜头目录不存在', 404)
  const real = realpathSync(path), rel = relative(resolve(root), real)
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel) || resolve(real) !== resolve(path)) throw new OpenMontageError('项目目录路径无效', 404)
  return real
}
export function readOpenMontageProject(trackId: string, projectId: string, env: NodeJS.ProcessEnv = process.env): OpenMontageProject {
  requiredOpenMontageTrack(trackId, env)
  const path = checkedDirectory(join(openMontageProjectsRoot(env), id(projectId)), openMontageProjectsRoot(env)), saved = object(json(join(path, 'track-binding.json')))
  if (saved.projectId !== projectId || saved.trackId !== trackId || typeof saved.title !== 'string' || typeof saved.createdAt !== 'string' || typeof saved.updatedAt !== 'string'
    || !(saved.sessionId == null || typeof saved.sessionId === 'string' && OPENMONTAGE_ID.test(saved.sessionId))) throw new OpenMontageError('项目与当前轨迹不匹配或绑定文件损坏', 404)
  return {projectId, trackId, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt, workspace: path, sessionId: saved.sessionId as string | null, pipeline: 'hybrid'}
}
export function listOpenMontageProjects(trackId: string, env: NodeJS.ProcessEnv = process.env): OpenMontageProject[] {
  requiredOpenMontageTrack(trackId, env)
  const root = openMontageProjectsRoot(env)
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => OPENMONTAGE_ID.test(name)).flatMap(name => {try {return [readOpenMontageProject(trackId, name, env)]} catch {return []}}).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
/** Scope resolution is deliberately synchronous for the existing explicit-save stores. */
export function resolveOpenMontageShotDirectory(trackId: string, scope: Pick<OpenMontageShotScope, 'projectId' | 'shotId'>, env: NodeJS.ProcessEnv = process.env): string {
  const project = readOpenMontageProject(trackId, scope.projectId, env), shotId = id(scope.shotId)
  const path = checkedDirectory(join(project.workspace, 'shots', shotId), project.workspace), shot = object(json(join(path, 'shot-binding.json')))
  if (shot.shot_id !== shotId || shot.track_id !== trackId || !['map', 'sandbox'].includes(shot.editor as string) || typeof shot.scene_id !== 'string') throw new OpenMontageError('镜头与当前项目或轨迹不匹配', 404)
  return path
}
export function openMontageMaterialSnapshot(trackId: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const track = requiredOpenMontageTrack(trackId, env), {coordinates, placemarks, ...summary} = track
  const warnings: string[] = [], current = <T>(read: () => T, label: string): T | null => {try {return read()} catch (error) {warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); return null}}
  const prepared = current(() => readVideoMaterials(trackId, env), '素材准备读取失败'), state = current(() => readPlacemarkState(trackId, env), '标注状态读取失败'), resources = current(() => readResources(trackId, env), '资源库读取失败')
  const points = state ? effectivePlacemarks(track.placemarks ?? [], state) : placemarks ?? []
  return {version: 1, updatedAt: new Date().toISOString(), provenance: '轨迹源文件及用户显式保存的点位、素材信息；不能从图片推测到访、时间或经历',
    track: summary, sourceDirectory: trackDir(trackId, env), pointCount: coordinates.length, firstPoint: coordinates[0] ?? null, lastPoint: coordinates.at(-1) ?? null,
    importantPoints: points,
    prepared: prepared ? {...prepared.document, markers: prepared.document.markers.map(({photo, ...marker}) => ({...marker, ...(photo?.sourceUrl ? {selectedPhotoSource: photo.sourceUrl} : {})}))} : null,
    selectedResources: resources?.assets.filter(asset => asset.candidate || asset.videoRole).map(asset => ({id: asset.id, name: asset.name, kind: asset.kind, url: asset.url, metadata: asset.metadata, videoRole: asset.videoRole, tags: asset.tags})) ?? [],
    userExperience: prepared?.document.information.filter(item => item.selected).map(item => ({label: item.label, text: item.text})) ?? [],
    warnings, confirmationRequired: ['先询问主目标和观众收益，再确认素材范围、画幅及制作规格', '时长、分段讲述侧重、个人经历须由用户确认', '尚未核实的交通、票价、天气及住宿条件不能当作已确认事实', '只核对重要点位，不遍历所有照片', '异常结论必须展示轨迹记录或资料来源依据']}
}
export async function createOpenMontageProject(trackId: string, title: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenMontageProject> {
  requiredOpenMontageTrack(trackId, env)
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\0\r\n]/u.test(title)) throw new OpenMontageError('请填写 200 字以内的项目名称')
  const projectId = `track-video-${randomUUID()}`
  await runOpenMontageCommand('create', {trackId, projectId, title: title.trim()}, env)
  await ensureOpenMontageAgentWorkspace(trackId, projectId, env)
  return readOpenMontageProject(trackId, projectId, env)
}
export async function ensureOpenMontageAgentWorkspace(trackId: string, projectId: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenMontageAgentWorkspace> {
  const project = readOpenMontageProject(trackId, projectId, env), settings = readOpenMontageSettings(env), environment = openMontageEnvironment(settings, env)
  const instructions = [
    '# Track + OpenMontage 独立视频项目', '',
    `本项目 ${projectId} 仅绑定轨迹 ${trackId}。工作目录固定为本目录，不复用其他项目会话。`,
    `先读取 ${join(settings.sourceDirectory, 'AGENT_GUIDE.md')}；本项目的原生 pipeline manifest 是 ${join(settings.sourceDirectory, 'pipeline_defs/hybrid.yaml')}（不是另造 manifest.json）。完整读取该 manifest，随后读对应阶段 director 和 skills/meta/checkpoint-protocol.md。`,
    'track-material-snapshot.json 是只读路线依据和素材清单；用户目的、经历、素材范围未确认前不能自行决定片长、生成配音或素材。',
    '首期流程仅 idea（brief/key_points需求与大纲）、script、scene_plan，三个阶段分别在对话中展示成果并等待用户明确确认。只制作用户选择的部分镜头，不自动进入整片合成、配音、批量素材生成或发布。',
    '原生严格 schema 的场景使用 type=screen_recording，required_assets 中 source=record。地图/沙盘绑定写 scene_plan.metadata.track_shots，不向场景对象添加自定义字段。',
    '请保留现有工程关键帧；不要将基础模板或示例直接覆盖用户镜头。不要从图片推测停留、露营或路线时间。未核实和待补充的信息放到末尾，提醒用户补充。',
    '本宿主 Session SDK 没有 env 选项。track-openmontage-environment.json 是明确环境配置；下列薄桥会自动加载它，保持项目根、PYTHONPATH、禁写字节码和缓存根一致。不要从源码目录运行生产写入。',
    `桥命令：${JSON.stringify(settings.pythonPath)} ${JSON.stringify(openMontageBridgePath())} <state|commit|approve> --input request.json`,
    `request.json 必须包含 {"trackId":${JSON.stringify(trackId)},"projectId":${JSON.stringify(projectId)}}。state 读取当前磁盘成果、摘要和审批状态。`,
    'commit 加 stage、artifact（原生 schema JSON）、expectedDigest（首次null，否则当前stage摘要）；返回awaiting_human之后立即结束当前制作步骤，等待用户。',
    'approve 加 stage、expectedDigest（必须为刚展示并确认的当前成果摘要）、humanApprovalEvidence（用户本次明确确认原文）。此前的一次“继续”不覆盖后续审批。',
    '所有 canonical artifact/checkpoint 写入通过该桥：调用原生 schema/checkpoint 库、操作系统跨进程锁、修订摘要、不可变历史与中断恢复。不要直接改 checkpoint 或把 completed 当作授权证明；上游变化会清除下游审批。',
    '这只是持久化适配器，不代替 OpenMontage 原生预检、director、自审及用户确认。不要自动调用收费服务，不修改外部 OpenMontage 源码。', ''
  ].join('\n')
  const result = await runOpenMontageCommand<{path: string; sessionId: string | null}>('workspace', {trackId, projectId, snapshot: openMontageMaterialSnapshot(trackId, env), instructions}, env)
  atomic(join(project.workspace, 'track-openmontage-environment.json'), environment)
  return {...result, projectId, trackId, environment,
    initialPrompt: `请读取本项目 AGENTS.md 与 track-material-snapshot.json，按 OpenMontage hybrid 流程先讨论这条路线视频的主目标、观众收益、素材范围及制作规格。先提供需求与大纲，不自行生成镜头或调用 AI 素材服务。项目 ${project.title}；轨迹 ${trackId}。`}
}
export async function saveOpenMontageAgentSession(trackId: string, projectId: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<{sessionId: string}> {
  readOpenMontageProject(trackId, projectId, env)
  return runOpenMontageCommand('session', {trackId, projectId, sessionId: id(sessionId)}, env)
}
