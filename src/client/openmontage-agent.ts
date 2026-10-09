/** OpenMontage project sessions use the host's retained, scoped Conversation. */
import {api as defaultApi} from './util.ts'
import type {TrackAgentServices, TrackAgentSession} from './track-agent-session.ts'
import type {TrackAgentSummary} from '../track-agent-context.ts'
import type {OpenMontageAgentWorkspace} from '../track/openmontage.ts'
import {TRACK_AGENT_DRAWER_EVENT, trackAgentDrawerAvailable} from './useTrackAgentDrawer.ts'

export interface OpenMontageAgentSession extends TrackAgentSession, OpenMontageAgentWorkspace {sessionId: string}
export interface OpenMontageAgentSendReceipt {status: 'accepted'; sessionId: string; requestId: string}
export interface OpenMontageAgentSendOptions {requestId: string; signal?: AbortSignal}
export interface OpenMontageAgentMessageRequest {readonly requestId: string; readonly prompt: string; readonly sessionId: string}
export interface OpenMontageProjectDrawerOptions {
  /** The panel owns these references and releases them when its lifetime ends. */
  onKeepSession: (sessionId: string, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  title?: string
  summary?: TrackAgentSummary
  requestId?: string
}
export interface OpenMontageProjectDrawerRequest {
  open: boolean; panelId: 'cqai-track'; entityId: string; requestId: string; sessionId: string
  title: string; side: 'left'; mode: 'simple'; summary?: TrackAgentSummary
}
interface ProjectRequests {
  preparing?: Promise<OpenMontageAgentSession>
  candidate?: TrackAgentSession
  current?: OpenMontageAgentSession
  pendingMessage?: OpenMontageAgentMessageRequest
  messages: Map<string, {text: string; sessionId: string; operation: Promise<OpenMontageAgentSendReceipt>}>
}
interface Runtime {generation: number; drawerGeneration: number; projects: Map<string, ProjectRequests>}
const runtimes = new WeakMap<TrackAgentServices['sessions'], Runtime>()
const SNAPSHOT_TIMEOUT_MS = 8000
const keyFor = (trackId: string, projectId: string) => JSON.stringify([trackId, projectId])
const aborted = () => new DOMException('OpenMontage Agent 操作已取消', 'AbortError')
function checkAbort(signal?: AbortSignal) {if (signal?.aborted) throw aborted()}
function runtimeFor(services: TrackAgentServices): Runtime {
  let runtime = runtimes.get(services.sessions)
  if (!runtime) {runtime = {generation: 0, drawerGeneration: 0, projects: new Map()}; runtimes.set(services.sessions, runtime)}
  return runtime
}
function projectFor(runtime: Runtime, trackId: string, projectId: string): ProjectRequests {
  const key = keyFor(trackId, projectId)
  let project = runtime.projects.get(key)
  if (!project) {project = {messages: new Map()}; runtime.projects.set(key, project)}
  return project
}
function validateIdentity(trackId: string, projectId: string) {
  if (!trackId?.trim() || !projectId?.trim()) throw new Error('缺少 OpenMontage 项目或轨迹编号')
}
function preparationServices(services: TrackAgentServices) {
  if (!services?.sessions || typeof services.sessions.refresh !== 'function' || typeof services.sessions.create !== 'function'
    || typeof services.sessions.list?.getSnapshot !== 'function' || typeof services.sessions.list?.subscribe !== 'function'
    || !services.workspaces || typeof services.workspaces.create !== 'function'
    || typeof services.workspaces.list?.getSnapshot !== 'function' || typeof services.workspaces.list?.subscribe !== 'function') {
    throw new Error('当前 Desktop 缺少原生 Agent 项目会话能力，请更新后重试')
  }
}
function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const cancel = () => {signal.removeEventListener('abort', cancel); reject(aborted())}
    signal.addEventListener('abort', cancel, {once: true})
    operation.then(value => {signal.removeEventListener('abort', cancel); resolve(value)}, error => {signal.removeEventListener('abort', cancel); reject(error)})
  })
}
function waitForSnapshot<T>(source: {getSnapshot(): T; subscribe(listener: () => void): () => void}, ready: (value: T) => boolean, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}, finished = false
    const finish = (error?: Error) => {if (finished) return; finished = true; clearTimeout(timer); unsubscribe(); if (error) reject(error); else resolve()}
    const timer = setTimeout(() => finish(new Error(message)), SNAPSHOT_TIMEOUT_MS)
    const check = () => {
      if (finished) return
      try {
        const snapshot = source.getSnapshot(), state = snapshot as {state?: string; error?: {message?: string} | null}
        if (state.state === 'error') finish(new Error(state.error?.message ? `${message}：${state.error.message}` : message))
        else if (ready(snapshot)) finish()
      } catch (error) {finish(error instanceof Error ? error : new Error(message))}
    }
    try {unsubscribe = source.subscribe(check); if (finished) unsubscribe(); else check()}
    catch (error) {finish(error instanceof Error ? error : new Error(message))}
  })
}
function eligible(services: TrackAgentServices, sessionId: string): boolean {
  const sessions = services.sessions.list.getSnapshot(), workspaces = services.workspaces.list.getSnapshot(), summary = sessions.byId[sessionId]
  return sessions.phase === 'ready' && workspaces.phase === 'ready' && workspaces.state !== 'error'
    && sessions.ids.includes(sessionId) && !!summary && !summary.parentId && summary.origin !== 'subagent'
    && !workspaces.archivedSessionIds.includes(sessionId)
}
function reusable(services: TrackAgentServices, sessionId: string, workspaceId: string): boolean {
  return eligible(services, sessionId) && services.workspaces.list.getSnapshot().items.some(value => value.workspaceId === workspaceId && value.sessionIds.includes(sessionId))
}
async function prepare(services: TrackAgentServices, project: ProjectRequests, trackId: string, projectId: string): Promise<OpenMontageAgentSession> {
  const api = services.api ?? defaultApi
  const linked = await api<OpenMontageAgentWorkspace>('openmontage-agent-workspace', {trackId, projectId})
  if (!linked || typeof linked.path !== 'string' || !linked.path.trim()
    || linked.trackId !== trackId || linked.projectId !== projectId
    || !(linked.sessionId === null || typeof linked.sessionId === 'string' && !!linked.sessionId.trim())
    || typeof linked.initialPrompt !== 'string' || !linked.environment || typeof linked.environment !== 'object'
    || Array.isArray(linked.environment) || Object.values(linked.environment).some(value => typeof value !== 'string')) {
    throw new Error('OpenMontage Agent 工作区返回的项目绑定无效')
  }
  const workspace = await services.workspaces.create({path: linked.path})
  if (!workspace?.workspaceId) throw new Error('原生 Agent 工作区创建失败')
  await services.sessions.refresh()
  await waitForSnapshot(services.sessions.list, value => value.phase === 'ready', 'Agent 对话列表尚未就绪，请稍后重试')
  await waitForSnapshot(services.workspaces.list, value => value.phase === 'ready', 'Agent 项目工作区尚未就绪，请稍后重试')
  let sessionId = linked.sessionId
  if (!sessionId || !reusable(services, sessionId, workspace.workspaceId)) {
    const candidate = project.candidate
    if (candidate?.workspaceId === workspace.workspaceId && eligible(services, candidate.sessionId)) sessionId = candidate.sessionId
    else {
      project.candidate = undefined
      // Official 0.2 sessions.create accepts cwd; environment is supplied by the project command bridge.
      const create = services.sessions.create as (input: {workspaceId: string; cwd: string}) => Promise<string>
      sessionId = await create.call(services.sessions, {workspaceId: workspace.workspaceId, cwd: linked.path})
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('原生 Agent 对话创建失败')
      project.candidate = {sessionId, workspaceId: workspace.workspaceId}
    }
    const created = sessionId
    await waitForSnapshot(services.sessions.list, value => value.phase === 'ready' && value.ids.includes(created) && !!value.byId[created], 'Agent 项目对话尚未进入列表，请稍后重试')
    await waitForSnapshot(services.workspaces.list, value => value.phase === 'ready' && value.items.some(item => item.workspaceId === workspace.workspaceId && item.sessionIds.includes(created)), 'Agent 项目工作区尚未关联对话，请稍后重试')
  }
  if (!reusable(services, sessionId, workspace.workspaceId)) throw new Error('Agent 对话不存在、已归档或不属于此 OpenMontage 项目')
  const saved = await api<{sessionId: string}>('openmontage-agent-session', {trackId, projectId, sessionId})
  if (saved?.sessionId !== sessionId) throw new Error('OpenMontage 项目对话绑定未获确认')
  const result: OpenMontageAgentSession = {...linked, environment: {...linked.environment}, sessionId, workspaceId: workspace.workspaceId}
  project.current = result; project.candidate = undefined
  return result
}

/** Prepare and bind independently; the drawer helper activates only after the panel retains it. */
export async function ensureOpenMontageAgentSession(services: TrackAgentServices, trackId: string, projectId: string, signal?: AbortSignal): Promise<OpenMontageAgentSession> {
  checkAbort(signal); validateIdentity(trackId, projectId); preparationServices(services)
  const runtime = runtimeFor(services), generation = ++runtime.generation
  const navigation = services.layout?.beginNavigation?.(), project = projectFor(runtime, trackId, projectId)
  let preparation = project.preparing
  if (!preparation) {
    preparation = prepare(services, project, trackId, projectId); project.preparing = preparation
    const clear = () => {if (project.preparing === preparation) project.preparing = undefined}
    preparation.then(clear, clear)
  }
  const result = await cancellable(preparation, signal)
  checkAbort(signal); checkAbort(navigation)
  if (runtime.generation !== generation) throw aborted()
  if (!reusable(services, result.sessionId, result.workspaceId)) throw new Error('Agent 项目对话已失效，请重新打开')
  return result
}
function requirePrepared(services: TrackAgentServices, session: OpenMontageAgentSession): ProjectRequests {
  validateIdentity(session.trackId, session.projectId)
  const project = runtimeFor(services).projects.get(keyFor(session.trackId, session.projectId))
  if (!project?.current || project.current.sessionId !== session.sessionId || project.current.workspaceId !== session.workspaceId
    || !reusable(services, session.sessionId, session.workspaceId)) throw new Error('此 OpenMontage 项目的原生 Agent 对话尚未就绪')
  return project
}
function scopedConversation(services: TrackAgentServices, sessionId: string): {send(text: string): Promise<void>} {
  if (typeof services.sessions.scope !== 'function') throw new Error('当前 Desktop 缺少原生 Conversation 发送能力，请更新后重试')
  const scope = services.sessions.scope(sessionId) as {conversation?: unknown; get?: (name: string) => unknown} | undefined
  if (!scope) throw new Error('Agent 对话未保留，请先打开项目 Agent')
  const direct = scope.conversation as {send?: unknown} | undefined
  const conversation = typeof direct?.send === 'function' ? direct : scope.get?.('conversation') as {send?: unknown} | undefined
  if (typeof conversation?.send !== 'function') throw new Error('当前项目缺少原生 Conversation 发送能力，请更新后重试')
  return conversation as {send(text: string): Promise<void>}
}

/** Keep an unresolved user intent in host/project memory across page remounts. */
export function prepareOpenMontageAgentMessage(services: TrackAgentServices, session: OpenMontageAgentSession, createPrompt: () => string): OpenMontageAgentMessageRequest {
  validateIdentity(session.trackId, session.projectId)
  const project = projectFor(runtimeFor(services), session.trackId, session.projectId)
  if (project.pendingMessage) {
    if (project.pendingMessage.sessionId !== session.sessionId) throw new Error('上一条 Agent 消息的接受状态尚未确认，请先检查原项目对话')
    return project.pendingMessage
  }
  const prompt = createPrompt()
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('缺少 Agent 消息')
  return project.pendingMessage = Object.freeze({requestId: crypto.randomUUID(), prompt, sessionId: session.sessionId})
}
/** The active UI calls this only after receiving acceptance; SDK completion never clears it. */
export function acknowledgeOpenMontageAgentMessage(services: TrackAgentServices, session: OpenMontageAgentSession, receipt: OpenMontageAgentSendReceipt): boolean {
  const project = runtimeFor(services).projects.get(keyFor(session.trackId, session.projectId)), request = project?.pendingMessage
  if (!request || receipt.status !== 'accepted' || receipt.sessionId !== session.sessionId
    || request.sessionId !== receipt.sessionId || request.requestId !== receipt.requestId) return false
  project!.pendingMessage = undefined
  return true
}

/** Acceptance only: the native Agent owns execution, events and final results. */
export async function sendOpenMontageAgentMessage(services: TrackAgentServices, session: OpenMontageAgentSession, text: string, options: OpenMontageAgentSendOptions): Promise<OpenMontageAgentSendReceipt> {
  checkAbort(options.signal)
  if (typeof text !== 'string' || !text.trim() || typeof options.requestId !== 'string' || !options.requestId.trim()) throw new Error('缺少 Agent 消息或发送请求编号')
  const project = runtimeFor(services).projects.get(keyFor(session.trackId, session.projectId)), existing = project?.messages.get(options.requestId)
  if (existing) {
    if (existing.text !== text || existing.sessionId !== session.sessionId) throw new Error('此发送请求编号已用于另一条消息')
    return cancellable(existing.operation, options.signal)
  }
  const prepared = requirePrepared(services, session), conversation = scopedConversation(services, session.sessionId)
  // Install before dispatch, sharing admission across concurrent callers and late cancellation.
  let accept!: (receipt: OpenMontageAgentSendReceipt) => void, reject!: (error: unknown) => void
  const operation = new Promise<OpenMontageAgentSendReceipt>((yes, no) => {accept = yes; reject = no})
  const record = {text, sessionId: session.sessionId, operation}; prepared.messages.set(options.requestId, record)
  void operation.catch(() => {if (prepared.messages.get(options.requestId) === record) prepared.messages.delete(options.requestId)})
  try {
    checkAbort(options.signal)
    // Official send starts admission now; cancellation only ends this caller's wait.
    Promise.resolve(conversation.send(text)).then(() => accept({status: 'accepted', sessionId: session.sessionId, requestId: options.requestId}), reject)
  } catch (error) {reject(error)}
  return cancellable(operation, options.signal)
}

/** Use the native drawer event; this helper never owns or releases Session references. */
export async function openOpenMontageProjectDrawer(services: TrackAgentServices, session: OpenMontageAgentSession, options: OpenMontageProjectDrawerOptions): Promise<OpenMontageProjectDrawerRequest> {
  checkAbort(options.signal); requirePrepared(services, session)
  if (typeof options.onKeepSession !== 'function' || typeof services.sessions.retain !== 'function'
    || typeof services.uiWorkspace?.openSession !== 'function' || typeof services.layout?.selectPanel !== 'function'
    || typeof services.sessions.scope !== 'function') throw new Error('当前 Desktop 缺少原生 Agent 对话保留或导航能力，请更新后重试')
  if (!trackAgentDrawerAvailable()) throw new Error('当前布局暂不支持原生项目 Agent 抽屉，请更新后重试')
  const runtime = runtimeFor(services), generation = ++runtime.drawerGeneration, navigation = services.layout.beginNavigation?.()
  await cancellable(options.onKeepSession(session.sessionId, options.signal), options.signal)
  checkAbort(options.signal); checkAbort(navigation)
  if (runtime.drawerGeneration !== generation) throw aborted()
  requirePrepared(services, session); scopedConversation(services, session.sessionId)
  const request: OpenMontageProjectDrawerRequest = {open: true, panelId: 'cqai-track', entityId: `openmontage:${session.trackId}:${session.projectId}`,
    sessionId: session.sessionId, requestId: options.requestId || crypto.randomUUID(), title: options.title || 'Agent · OpenMontage 项目', side: 'left', mode: 'simple', summary: options.summary}
  services.uiWorkspace.openSession(session.sessionId); services.layout.selectPanel('cqai-track')
  window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: request}))
  return request
}
export function closeOpenMontageProjectDrawer(request: OpenMontageProjectDrawerRequest): void {
  window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: {...request, open: false}}))
}
