import {spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync} from 'node:fs'
import {open} from 'node:fs/promises'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {isAbsolute, join, relative} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {resourceRange} from './resource-routes.ts'
import {uploadResource, updateResource} from './resource-store.ts'
import {API} from './protocol.ts'
import {RESOURCE_LIMITS} from './track/resources.ts'
import type {OpenMontageEditor, OpenMontageShot, OpenMontageShotScope, OpenMontageStage, OpenMontageState, OpenMontageTake} from './track/openmontage.ts'
import {OpenMontageError, OPENMONTAGE_ID, OPENMONTAGE_JSON_MAX_BYTES, createOpenMontageProject, ensureOpenMontageAgentWorkspace, listOpenMontageProjects, readOpenMontageProject, readOpenMontageSettings, resolveOpenMontageShotDirectory, runOpenMontageCommand, saveOpenMontageAgentSession, writeOpenMontageSettings} from './openmontage-store.ts'
import {disposeOpenMontage, ensureOpenMontageBacklot, inspectOpenMontageConnection} from './openmontage-runtime.ts'

const actions = ['openmontage-settings', 'openmontage-projects', 'openmontage-state', 'openmontage-events', 'openmontage-agent-workspace', 'openmontage-agent-session', 'openmontage-shot', 'openmontage-shot-result', 'openmontage-media', 'openmontage-commit', 'openmontage-approve']
function json(res: ServerResponse, status: number, value: unknown): void {res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(JSON.stringify(value))}
function text(value: unknown, label: string): string {if (typeof value !== 'string' || !OPENMONTAGE_ID.test(value)) throw new OpenMontageError(`${label}无效`); return value}
function object(value: unknown): Record<string, unknown> {if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpenMontageError('请求 JSON 格式无效'); return value as Record<string, unknown>}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []; let bytes = 0
  for await (const raw of req.iterator({destroyOnReturn: false})) {const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > OPENMONTAGE_JSON_MAX_BYTES) throw new OpenMontageError('OpenMontage JSON 最多 32 MiB', 413); parts.push(chunk)}
  try {return object(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))} catch (error) {if (error instanceof OpenMontageError) throw error; throw new OpenMontageError('请求 JSON 无效')}
}
function mediaUrl(trackId: string, projectId: string, takeId: string): string {return `${API}/openmontage-media?id=${encodeURIComponent(trackId)}&projectId=${encodeURIComponent(projectId)}&takeId=${encodeURIComponent(takeId)}`}
function exposeTake(trackId: string, projectId: string, take: Omit<OpenMontageTake, 'url'>): OpenMontageTake {return {...take, url: mediaUrl(trackId, projectId, take.takeId)}}
interface BridgeState {board: Record<string, unknown>; stages: OpenMontageStage[]; currentStage: string; scenePlanDigest: string | null; canProduce: boolean;
  mappings: Array<{shot_id: string; scene_id: string; editor: OpenMontageEditor; track_id: string}>; takes: Array<Omit<OpenMontageTake, 'url'>>}

export async function readOpenMontageState(trackId: string, projectId: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenMontageState> {
  const project = readOpenMontageProject(trackId, projectId, env)
  const data = await runOpenMontageCommand<BridgeState>('state', {trackId, projectId}, env), base = await ensureOpenMontageBacklot(env)
  // Derive mutation protection in the locked bridge, then forward the actual
  // Backlot state. The embedded board and outer list read the same native API.
  const response = await fetch(`${base}/api/project/${encodeURIComponent(projectId)}/state`, {signal: AbortSignal.timeout(15000)})
  if (!response.ok) throw new OpenMontageError('Backlot 项目状态读取失败', 503)
  const board = await response.json() as Record<string, unknown>, storyboard = (board.storyboard ?? {}) as {scenes?: Array<Record<string, unknown>>}
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : []
  const takes = data.takes.map(take => exposeTake(trackId, projectId, take))
  const shots: OpenMontageShot[] = data.mappings.filter(mapping => mapping.track_id === trackId).map(mapping => {
    const scene = scenes.find(scene => scene.id === mapping.scene_id) ?? {}
    const scope: OpenMontageShotScope = {projectId, shotId: mapping.shot_id, sceneId: mapping.scene_id, scenePlanDigest: data.scenePlanDigest ?? ''}
    return {shotId: mapping.shot_id, sceneId: mapping.scene_id, editor: mapping.editor, purpose: String(scene.shot_intent ?? scene.description ?? ''), description: String(scene.description ?? ''),
      startSeconds: Number(scene.start_seconds ?? 0), endSeconds: Number(scene.end_seconds ?? 0), requiredAssets: Array.isArray(scene.required_assets) ? scene.required_assets as OpenMontageShot['requiredAssets'] : [],
      scope, takes: takes.filter(take => take.shotId === mapping.shot_id)}
  })
  return {project, boardUrl: `${base}/p/${encodeURIComponent(projectId)}`, board, stages: data.stages, currentStage: data.currentStage, scenePlanDigest: data.scenePlanDigest,
    canProduce: data.canProduce, shots, issues: data.stages.flatMap(stage => stage.error ? [stage.error] : [])}
}

interface ActualVideo {mime: string; extension: 'webm' | 'mp4'; width: number; height: number; duration: number; fps?: number}
/** MediaRecorder's streaming WebM often omits Duration; inspect actual packets. */
function packetTimeline(path: string, nominalFps: number | undefined, env: NodeJS.ProcessEnv): Promise<{duration: number; fps?: number}> {
  return new Promise((success, failure) => {
    const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', path],
      {env: {...process.env, ...env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    let pending = '', first = Infinity, last = -Infinity, packets = 0, settled = false
    const finish = (error?: Error) => {if (settled) return; settled = true; clearTimeout(timer); const duration = last - first; error ? failure(error) : success({duration, ...(packets > 0 && duration > 0 ? {fps: packets / duration} : {})})}
    const timer = setTimeout(() => {probe.kill(); finish(new OpenMontageError('WebM 实际录制时间校验超时；保留视频后可重试', 503))}, 30000)
    const inspect = (line: string) => {
      if (!line.trim()) return
      const [pts, length] = line.split(',').map(Number)
      if (!Number.isFinite(pts)) return
      first = Math.min(first, pts); last = Math.max(last, pts + (Number.isFinite(length) && length > 0 ? length : nominalFps ? 1 / nominalFps : 0)); packets += 1
    }
    probe.stdout.on('data', (chunk: Buffer) => {pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? ''; lines.forEach(inspect); if (pending.length > 4096 || packets > 5_000_000) {probe.kill(); finish(new OpenMontageError('录制时间数据超过校验上限', 413))}})
    probe.stderr.on('data', () => {/* Main format probe already reports container diagnostics. */})
    probe.on('error', error => finish(new OpenMontageError(`ffprobe 实际时间校验失败：${error.message}`, 503)))
    probe.on('close', code => {inspect(pending); if (code !== 0 || !packets || !Number.isFinite(last - first) || last <= first) finish(new OpenMontageError('录制文件没有有效的视频记录时间', 415)); else finish()})
  })
}
/** Actual file dimensions/duration are authoritative, never the canvas labels. */
export function probeOpenMontageVideo(path: string, declaredMime: string, env: NodeJS.ProcessEnv = process.env): Promise<ActualVideo> {
  return new Promise((success, failure) => {
    const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration:format=duration,format_name', '-of', 'json', path],
      {env: {...process.env, ...env}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    let output = '', errors = '', settled = false
    const finish = (error?: Error, result?: ActualVideo) => {if (settled) return; settled = true; clearTimeout(timer); error ? failure(error) : success(result!)}
    const timer = setTimeout(() => {probe.kill(); finish(new OpenMontageError('录制文件 ffprobe 校验超时；视频已保留，请重试', 503))}, 30000)
    probe.stdout.on('data', (chunk: Buffer) => {output += chunk.toString(); if (output.length > 1024 * 1024) {probe.kill(); finish(new OpenMontageError('视频校验返回过大', 413))}})
    probe.stderr.on('data', (chunk: Buffer) => {errors = (errors + chunk.toString()).slice(-2000)})
    probe.on('error', error => finish(new OpenMontageError(`ffprobe 不可用：${error.message}；请配置本机 FFmpeg，未自动安装`, 503)))
    probe.on('close', async code => {
      if (settled) return
      try {
        const data = JSON.parse(output) as {streams?: Array<{codec_name?: string; width?: number; height?: number; duration?: string; r_frame_rate?: string}>; format?: {format_name?: string; duration?: string}}
        const stream = data.streams?.[0], width = stream?.width ?? 0, height = stream?.height ?? 0, name = data.format?.format_name ?? ''
        let duration = Number(data.format?.duration ?? stream?.duration)
        const rate = stream?.r_frame_rate?.split('/').map(Number)
        let fps = rate?.length === 2 && rate[1] ? rate[0] / rate[1] : undefined
        const isWebm = name.includes('webm') && declaredMime === 'video/webm', isMp4 = name.includes('mp4') && declaredMime === 'video/mp4'
        if (code === 0 && isWebm && (!Number.isFinite(duration) || duration <= 0)) {clearTimeout(timer); const actual = await packetTimeline(path, fps, env); duration = actual.duration; fps = actual.fps}
        if (code !== 0 || !stream || !['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(stream.codec_name ?? '') || (!isWebm && !isMp4) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
          || width < 2 || height < 2 || width * height > 32_000_000 || !Number.isFinite(duration) || duration <= 0 || duration > 86400 || fps !== undefined && (!Number.isFinite(fps) || fps <= 0 || fps > 240)) throw new Error()
        finish(undefined, {mime: isWebm ? 'video/webm' : 'video/mp4', extension: isWebm ? 'webm' : 'mp4', width, height, duration, ...(fps ? {fps} : {})})
      } catch {finish(new OpenMontageError(`录制文件无法校验为有效 MP4/WebM 视频：${errors || '缺少视频轨、规格或时长'}`, 415))}
    })
  })
}
interface ResultIdentity {trackId: string; projectId: string; shotId: string; takeId: string; scenePlanDigest: string; projectRevision: string; editor: OpenMontageEditor}
export async function saveOpenMontageShotResult(req: IncomingMessage, identity: ResultIdentity, env: NodeJS.ProcessEnv = process.env): Promise<OpenMontageTake> {
  const {trackId, projectId, shotId, takeId, scenePlanDigest, projectRevision, editor} = identity
  const project = readOpenMontageProject(trackId, projectId, env)
  resolveOpenMontageShotDirectory(trackId, {projectId, shotId}, env)
  if (![takeId, projectRevision].every(value => typeof value === 'string' && OPENMONTAGE_ID.test(value)) || !/^[a-f0-9]{64}$/u.test(scenePlanDigest) || !['map', 'sandbox'].includes(editor)) throw new OpenMontageError('录制回填版本参数无效')
  const declaredMime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (!['video/webm', 'video/mp4'].includes(declaredMime)) throw new OpenMontageError('镜头回填只接受实际 MP4/WebM 视频', 415)
  if (Number(req.headers['content-length']) > RESOURCE_LIMITS.video) throw new OpenMontageError('视频不能超过资源库 2 GiB 上限', 413)
  const directory = join(project.workspace, 'assets', 'video'), temporary = join(directory, `.track-upload-${randomUUID()}.tmp`)
  mkdirSync(directory, {recursive: true})
  const directoryStat = lstatSync(directory), actualDirectory = realpathSync(directory), inside = relative(realpathSync(project.workspace), actualDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || inside.startsWith('..') || isAbsolute(inside) || actualDirectory !== directory) throw new OpenMontageError('录制素材目录路径无效', 404)
  const handle = await open(temporary, 'wx'), hash = createHash('sha256')
  let bytes = 0, closed = false, finalPath: string | undefined
  try {
    for await (const raw of req.iterator({destroyOnReturn: false})) {
      const chunk = Buffer.from(raw); bytes += chunk.length
      if (bytes > RESOURCE_LIMITS.video) throw new OpenMontageError('视频不能超过资源库 2 GiB 上限', 413)
      hash.update(chunk); let offset = 0
      while (offset < chunk.length) {const written = await handle.write(chunk, offset, chunk.length - offset); offset += written.bytesWritten}
    }
    if (!bytes) throw new OpenMontageError('录制文件不能为空')
    await handle.close(); closed = true
    const sha256 = hash.digest('hex'), actual = await probeOpenMontageVideo(temporary, declaredMime, env), filename = `${takeId}-${sha256}.${actual.extension}`
    finalPath = join(directory, filename)
    if (existsSync(finalPath)) {
      const stat = lstatSync(finalPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes || createHash('sha256').update(readFileSync(finalPath)).digest('hex') !== sha256) throw new OpenMontageError('已保存的视频内容已变化', 409)
    } else renameSync(temporary, finalPath)
    const saved = await runOpenMontageCommand<Omit<OpenMontageTake, 'url'>>('take', {...identity, sha256, bytes, ...actual, path: `assets/video/${filename}`}, env)
    // Resource-library registration shares the existing sniff/limits/dedupe
    // implementation. Failure is safe to retry: native take and file persist.
    const upload = createReadStream(finalPath) as unknown as IncomingMessage
    Object.assign(upload, {headers: {'content-type': actual.mime, 'content-length': String(bytes)}})
    const asset = await uploadResource(trackId, upload, {name: `镜头 ${saved.sceneId} · ${takeId}`, kind: 'video'}, env)
    updateResource(trackId, asset.id, {...(!asset.videoRole ? {videoRole: 'travel-video'} : {}), tags: [...new Set([...asset.tags, 'OpenMontage', editor === 'map' ? '地图镜头' : '沙盘镜头'])].slice(0, 30), metadata: {width: actual.width, height: actual.height, duration: actual.duration, ...(actual.fps ? {fps: actual.fps} : {})}}, env)
    return exposeTake(trackId, projectId, saved)
  } catch (error) {
    if (error && typeof error === 'object') Object.assign(error, {attemptId: takeId, ...(finalPath ? {videoPreserved: true} : {})})
    throw error
  } finally {if (!closed) await handle.close().catch(() => {}); try {unlinkSync(temporary)} catch {}}
}

async function serveMedia(req: IncomingMessage, res: ServerResponse, trackId: string, projectId: string, takeId: string, env: NodeJS.ProcessEnv): Promise<void> {
  const project = readOpenMontageProject(trackId, projectId, env), receiptFile = join(project.workspace, 'track-takes.json'), receiptStat = lstatSync(receiptFile, {throwIfNoEntry: false})
  if (!receiptStat?.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > OPENMONTAGE_JSON_MAX_BYTES) throw new OpenMontageError('录制素材清单不存在或不可读取', 404)
  const receipts = JSON.parse(readFileSync(receiptFile, 'utf8')) as {takes: OpenMontageTake[]}
  if (!Array.isArray(receipts.takes)) throw new OpenMontageError('录制素材清单损坏')
  const take = receipts.takes.find(take => take.takeId === takeId)
  if (!take) throw new OpenMontageError('录制素材不存在', 404)
  const path = join(project.workspace, take.path), stat = lstatSync(path, {throwIfNoEntry: false}), root = realpathSync(join(project.workspace, 'assets', 'video'))
  const mediaRoot = relative(realpathSync(project.workspace), root)
  if (mediaRoot.startsWith('..') || isAbsolute(mediaRoot)) throw new OpenMontageError('录制素材目录路径无效', 404)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== take.bytes) throw new OpenMontageError('录制素材文件不存在或已变化', 404)
  const rel = relative(root, realpathSync(path))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new OpenMontageError('录制素材路径无效', 404)
  const range = resourceRange(req.headers.range, stat.size), length = range ? range.end - range.start + 1 : stat.size
  res.writeHead(range ? 206 : 200, {'content-type': take.mime, 'content-length': String(length), 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(range ? {'content-range': `bytes ${range.start}-${range.end}/${stat.size}`} : {})})
  if (req.method === 'HEAD') {res.end(); return}
  await pipeline(createReadStream(path, range ?? undefined), res)
}

export async function handleOpenMontageRoute(req: IncomingMessage, res: ServerResponse, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const action = url.pathname.split('/').pop() ?? ''
  if (!actions.includes(action)) return false
  try {
    for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new OpenMontageError('OpenMontage 参数重复')
    if (action === 'openmontage-settings') {
      if (req.method === 'POST') {writeOpenMontageSettings(await body(req), env); disposeOpenMontage(env)}
      else if (req.method !== 'GET') {json(res, 405, {error: '方法不支持'}); return true}
      json(res, 200, await inspectOpenMontageConnection(env)); return true
    }
    const trackId = url.searchParams.get('id') ?? '', projectId = url.searchParams.get('projectId') ?? ''
    if (action === 'openmontage-projects' && req.method === 'GET') {json(res, 200, {projects: listOpenMontageProjects(trackId, env)}); return true}
    if (action === 'openmontage-projects' && req.method === 'POST') {
      const input = await body(req), connection = await inspectOpenMontageConnection(env)
      if (!connection.ready) throw new OpenMontageError(connection.issues.join('\n'), 503)
      json(res, 201, {project: await createOpenMontageProject(text(input.trackId, '轨迹编号'), typeof input.title === 'string' ? input.title : '', env)}); return true
    }
    if (action === 'openmontage-state' && req.method === 'GET') {json(res, 200, await readOpenMontageState(trackId, projectId, env)); return true}
    if (action === 'openmontage-events' && req.method === 'GET') {
      readOpenMontageProject(trackId, projectId, env)
      const base = await ensureOpenMontageBacklot(env), controller = new AbortController()
      const abort = () => controller.abort(); res.once('close', abort)
      try {
        const upstream = await fetch(`${base}/api/project/${encodeURIComponent(projectId)}/events`, {signal: controller.signal})
        if (!upstream.ok || !upstream.body) throw new OpenMontageError('Backlot 事件连接失败', 503)
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no'})
        const reader = upstream.body.getReader()
        try {
          while (!res.destroyed) {
            const {done, value} = await reader.read(); if (done) break
            if (!res.write(Buffer.from(value))) await new Promise<void>(resolve => {const done = () => {res.off('drain', done); res.off('close', done); resolve()}; res.once('drain', done); res.once('close', done)})
          }
        } finally {await reader.cancel().catch(() => {}); reader.releaseLock()}
        if (!res.destroyed) res.end()
      } finally {controller.abort(); res.off('close', abort)}
      return true
    }
    if (action === 'openmontage-agent-workspace' && req.method === 'POST') {const input = await body(req); json(res, 200, await ensureOpenMontageAgentWorkspace(text(input.trackId, '轨迹编号'), text(input.projectId, '项目编号'), env)); return true}
    if (action === 'openmontage-agent-session' && req.method === 'POST') {const input = await body(req); json(res, 200, await saveOpenMontageAgentSession(text(input.trackId, '轨迹编号'), text(input.projectId, '项目编号'), text(input.sessionId, '会话编号'), env)); return true}
    if (['openmontage-commit', 'openmontage-approve'].includes(action) && req.method === 'POST') {
      const input = await body(req), selectedTrack = text(input.trackId, '轨迹编号'), selectedProject = text(input.projectId, '项目编号')
      readOpenMontageProject(selectedTrack, selectedProject, env)
      const result = await runOpenMontageCommand(action.endsWith('commit') ? 'commit' : 'approve', input, env)
      json(res, 200, {result, state: await readOpenMontageState(selectedTrack, selectedProject, env)}); return true
    }
    if (action === 'openmontage-shot' && req.method === 'POST') {
      const input = await body(req), selectedTrack = text(input.trackId, '轨迹编号'), selectedProject = text(input.projectId, '项目编号')
      readOpenMontageProject(selectedTrack, selectedProject, env)
      const mapping = await runOpenMontageCommand<{shot_id: string}>('bind', input, env), state = await readOpenMontageState(selectedTrack, selectedProject, env), shot = state.shots.find(shot => shot.shotId === mapping.shot_id)
      if (!shot) throw new OpenMontageError('分镜关联写入后未能读取，请保留原文件重试', 503)
      json(res, 200, {scope: shot.scope, editor: shot.editor, shot, state}); return true
    }
    if (action === 'openmontage-shot-result' && req.method === 'POST') {
      const identity: ResultIdentity = {trackId, projectId, shotId: text(url.searchParams.get('shotId'), '镜头编号'), takeId: text(url.searchParams.get('takeId'), '回填编号'),
        scenePlanDigest: url.searchParams.get('scenePlanDigest') ?? '', projectRevision: text(url.searchParams.get('projectRevision'), '工程修订'), editor: url.searchParams.get('editor') as OpenMontageEditor}
      const take = await saveOpenMontageShotResult(req, identity, env)
      json(res, 201, {take, state: await readOpenMontageState(trackId, projectId, env)}); return true
    }
    if (action === 'openmontage-media' && ['GET', 'HEAD'].includes(req.method ?? '')) {await serveMedia(req, res, trackId, projectId, text(url.searchParams.get('takeId'), '素材编号'), env); return true}
    json(res, 405, {error: '方法不支持'}); return true
  } catch (error) {
    if (res.headersSent) {if (!res.destroyed) res.end(); return true}
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500
    json(res, status, {error: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'attemptId' in error ? {attemptId: error.attemptId, videoPreserved: 'videoPreserved' in error && error.videoPreserved === true} : {})})
    return true
  }
}
