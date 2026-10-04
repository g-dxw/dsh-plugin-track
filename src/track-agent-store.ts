import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { listTracks } from './artifacts.ts'
import { TRACK_AGENT_PAGES, type TrackAgentContext } from './track-agent-context.ts'

/** One plugin workspace; selecting a route only updates its reference context. */
export interface TrackAgentWorkspace {path: string; sessionId: string | null}
const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(value)
const directory = (env: NodeJS.ProcessEnv) => join(resolveDshHome(undefined, env), 'track-agent')

function savedSession(root: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(root, 'agent-session.json'), 'utf8')) as {version?: unknown; sessionId?: unknown}
    return saved.version === 1 && validSessionId(saved.sessionId) ? saved.sessionId : null
  } catch {return null}
}
function writeJson(file: string, value: unknown): void {
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(temporary, file)
  } finally {
    if (existsSync(temporary)) rmSync(temporary)
  }
}
function snapshot(context: TrackAgentContext, env: NodeJS.ProcessEnv) {
  const tracks = listTracks(env)
  const currentTrack = context.page === 'library' || context.page === 'new' ? null : tracks.find(track => track.id === context.trackId) ?? null
  return {
    version: 2, updatedAt: new Date().toISOString(),
    library: {trackCount: tracks.length, tracks},
    current: {page: context.page, pageTitle: TRACK_AGENT_PAGES[context.page], trackId: currentTrack?.id ?? null, track: currentTrack},
  }
}

/** Opens even before any route is imported. Existing per-route workspaces remain intact. */
export function ensureTrackAgentWorkspace(env: NodeJS.ProcessEnv = process.env): TrackAgentWorkspace {
  const root = directory(env), path = join(root, '轨迹')
  mkdirSync(path, {recursive: true})
  const context = join(path, 'track-context.json')
  if (!existsSync(context)) writeJson(context, snapshot({page: 'library'}, env))
  const instructions = join(path, 'AGENTS.md')
  if (!existsSync(instructions)) writeFileSync(instructions, [
    '# 轨迹工作区', '',
    '这是整个轨迹插件的固定工作区，不绑定某一条线路。',
    'track-context.json 是轨迹库和当前页面、当前线路的只读参考快照；回答当前范围的问题前读取它。切换线路不会创建新的工作区或会话。',
    'current.track 为 null 时，当前没有选定已保存线路；不要从旧对话推断当前线路。新建路线的未保存内容尚未同步。',
    '本工作区用于轨迹讨论和方案草稿。修改这里的文件不会修改应用中的轨迹。',
    '轨迹、标注点和分组的编辑工具尚未接入；没有工具成功结果时，不要声称已修改应用数据。', '',
  ].join('\n'), {encoding: 'utf8', flag: 'wx'})
  return {path, sessionId: savedSession(root)}
}

export function writeTrackAgentContext(value: unknown, env: NodeJS.ProcessEnv = process.env) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 上下文格式无效')
  const input = value as Partial<TrackAgentContext>
  if (typeof input.page !== 'string' || !Object.hasOwn(TRACK_AGENT_PAGES, input.page)) throw new Error('Agent 当前页面无效')
  if (input.trackId != null && (typeof input.trackId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(input.trackId))) throw new Error('Agent 轨迹编号无效')
  const {path} = ensureTrackAgentWorkspace(env)
  const context = snapshot(input as TrackAgentContext, env)
  writeJson(join(path, 'track-context.json'), context)
  return context
}

export function saveTrackAgentSession(sessionId: unknown, env: NodeJS.ProcessEnv = process.env): {sessionId: string} {
  if (!validSessionId(sessionId)) throw new Error('Agent 会话编号无效')
  const root = directory(env)
  mkdirSync(root, {recursive: true})
  writeJson(join(root, 'agent-session.json'), {version: 1, sessionId})
  return {sessionId}
}
