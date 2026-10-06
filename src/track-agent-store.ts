import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { listTracks, readTrack, trackDir } from './artifacts.ts'
import { TRACK_EXTENSIONS } from './protocol.ts'
import { TRACK_AGENT_PAGES, type TrackAgentContext } from './track-agent-context.ts'

/** The library has a shared workspace; each saved route has its own project and session. */
export interface TrackAgentWorkspace {path: string; sessionId: string | null}
export class TrackAgentStoreError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {super(message); this.name = 'TrackAgentStoreError'}
}
const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(value)
const directory = (env: NodeJS.ProcessEnv) => join(resolveDshHome(undefined, env), 'track-agent')

function selectedTrackId(value: unknown, env: NodeJS.ProcessEnv): string | null {
  if (value == null) return null
  if (!validSessionId(value)) throw new TrackAgentStoreError('Agent 轨迹编号无效')
  if (!readTrack(value, env)) throw new TrackAgentStoreError('Agent 轨迹不存在或已删除', 404)
  return value
}
function savedSession(root: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(root, 'agent-session.json'), 'utf8')) as {version?: unknown; sessionId?: unknown}
    return saved.version === 1 && validSessionId(saved.sessionId) ? saved.sessionId : null
  } catch {return null}
}
const RENAME_RETRY_DELAYS = [20, 40, 80, 120, 160, 200] as const
const renameWait = new Int32Array(new SharedArrayBuffer(4))
/** Windows readers can briefly lock an existing snapshot; never remove that target to replace it. */
function replaceJson(temporary: string, file: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {renameSync(temporary, file); return}
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= RENAME_RETRY_DELAYS.length) throw error
      // Six bounded waits total 620 ms; the public synchronous store contract stays unchanged.
      Atomics.wait(renameWait, 0, 0, RENAME_RETRY_DELAYS[attempt])
    }
  }
}
function writeJson(file: string, value: unknown): void {
  const temporary = file + '.' + randomUUID() + '.tmp'
  let owned = false
  try {
    const descriptor = openSync(temporary, 'wx'); owned = true
    try {writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8')} finally {closeSync(descriptor)}
    replaceJson(temporary, file)
  } finally {
    if (owned && existsSync(temporary)) rmSync(temporary)
  }
}
function snapshot(context: TrackAgentContext, env: NodeJS.ProcessEnv) {
  const tracks = listTracks(env)
  const currentTrack = context.page === 'library' || context.page === 'new' ? null : tracks.find(track => track.id === context.trackId) ?? null
  const sourceTrack = context.page === 'route-information' && currentTrack ? readTrack(currentTrack.id, env) : null
  const format = sourceTrack && TRACK_EXTENSIONS.find(extension => extension === sourceTrack.format)
  const sources = sourceTrack ? {
    trackJson: join(trackDir(sourceTrack.id, env), 'track.json'),
    sourceFile: format ? join(trackDir(sourceTrack.id, env), 'source.' + format) : null,
    placemarkState: join(trackDir(sourceTrack.id, env), 'placemark-state.json'),
  } : undefined
  return {
    version: 2, updatedAt: new Date().toISOString(),
    library: {trackCount: tracks.length, tracks},
    current: {page: context.page, pageTitle: TRACK_AGENT_PAGES[context.page], trackId: currentTrack?.id ?? null, track: currentTrack,
      ...(currentTrack ? {workspacePath: join(directory(env), 'tracks', currentTrack.id)} : {}),
      ...(sources ? {sources, sourcesNote: '这些路径仅作只读来源。placemark-state.json 可能尚未生成；不存在时使用 track.json 中的原始点位。sourceFile 为 null 时没有已确认格式的原始文件路径。'} : {}),
    },
  }
}

/** Legacy shared/per-route files stay in place and are never adopted by a new route project. */
export function ensureTrackAgentWorkspace(env: NodeJS.ProcessEnv = process.env, trackId?: string | null): TrackAgentWorkspace {
  const selected = selectedTrackId(trackId, env)
  const root = directory(env), path = selected ? join(root, 'tracks', selected) : join(root, '轨迹')
  mkdirSync(path, {recursive: true})
  const context = join(path, 'track-context.json')
  if (!existsSync(context)) writeJson(context, snapshot(selected ? {page: 'overview', trackId: selected} : {page: 'library'}, env))
  const instructions = join(path, 'AGENTS.md')
  if (!existsSync(instructions)) writeFileSync(instructions, [
    '# 轨迹工作区', '',
    selected ? `这是轨迹 ${selected} 的独立项目目录。只在本目录讨论和保存这条线路的草稿；不要复用其他轨迹的会话或文件。` : '这是轨迹库的公共工作区，用于尚未选择已保存线路的页面。',
    'track-context.json 是轨迹库和当前页面、当前线路的只读参考快照；回答当前范围的问题前读取它。',
    selected ? '目录以轨迹编号固定，线路改名不会改变目录。切换到其他线路时，应用会打开另一条线路的独立目录和会话。' : '选择已保存线路后，应用会打开该线路的独立项目目录和会话。',
    'current.track 为 null 时，当前没有选定已保存线路；不要从旧对话推断当前线路。新建路线的未保存内容尚未同步。',
    '本工作区用于轨迹讨论和方案草稿。修改这里的文件不会修改应用中的轨迹。',
    '路线资料 Markdown 保存在当前线路的 Agent 工作区（current.workspacePath），通过应用的文件列表预览；已有用户资料只在明确要求时修改，不要另建第二份资料索引。',
    '当前页面为 route-information 时，先读取 current.sources 列出的只读来源。保留来源中的路线名称、标注点与分组信息和真实坐标；不要修改 track.json、原始 source 文件或 placemark-state.json。',
    '整理环境、交通、补给和住宿资料时区分轨迹实测信息、用户经历与外部来源；没有依据或可能过时的内容标为待核实，不要把轨迹记录时长当作行程安排。',
    '轨迹、标注点和分组的编辑工具尚未接入；没有工具成功结果时，不要声称已修改应用数据。', '',
  ].join('\n'), {encoding: 'utf8', flag: 'wx'})
  return {path, sessionId: savedSession(selected ? path : root)}
}

export function writeTrackAgentContext(value: unknown, env: NodeJS.ProcessEnv = process.env) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TrackAgentStoreError('Agent 上下文格式无效')
  const input = value as Partial<TrackAgentContext>
  if (typeof input.page !== 'string' || !Object.hasOwn(TRACK_AGENT_PAGES, input.page)) throw new TrackAgentStoreError('Agent 当前页面无效')
  if (input.trackId != null && !validSessionId(input.trackId)) throw new TrackAgentStoreError('Agent 轨迹编号无效')
  // Library/new are intentionally global even when the UI retains a previous route id.
  const trackId = input.page === 'library' || input.page === 'new' ? null : selectedTrackId(input.trackId, env)
  const {path} = ensureTrackAgentWorkspace(env, trackId)
  const context = snapshot({...input, trackId} as TrackAgentContext, env)
  writeJson(join(path, 'track-context.json'), context)
  return context
}

export function saveTrackAgentSession(sessionId: unknown, env: NodeJS.ProcessEnv = process.env, trackId?: string | null): {sessionId: string} {
  if (!validSessionId(sessionId)) throw new TrackAgentStoreError('Agent 会话编号无效')
  const selected = selectedTrackId(trackId, env)
  const root = selected ? ensureTrackAgentWorkspace(env, selected).path : directory(env)
  mkdirSync(root, {recursive: true})
  writeJson(join(root, 'agent-session.json'), {version: 1, sessionId})
  return {sessionId}
}
