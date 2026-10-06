/** Native DSH Session preparation; the Desktop frame owns its Conversation. */
import { api as defaultApi } from './util.ts'

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionCatalog {
  readonly phase: string
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, { readonly parentId?: string; readonly origin?: string }>>
}

interface WorkspaceCatalog {
  readonly phase: string
  readonly state?: string
  readonly error?: { readonly message: string } | null
  readonly items: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[]
  readonly archivedSessionIds: readonly string[]
}

/** An owned native Session reference; release only when its owning Track panel ends. */
export interface TrackAgentSessionReference {
  readonly sessionId: string
  readonly ready: Promise<unknown>
  release(): void
}

/** Type-only structural boundary: supplied by the real DSH Client services. */
export interface TrackAgentServices {
  readonly sessions: {
    readonly list: SnapshotSource<SessionCatalog>
    refresh(): Promise<void>
    create(input: { workspaceId: string }): Promise<string>
    /** Official acquisition keeps that Session generation alive across main-view selection changes. */
    retain?(sessionId: string, options: { source: string; signal?: AbortSignal }): TrackAgentSessionReference
  }
  readonly workspaces: {
    readonly list: SnapshotSource<WorkspaceCatalog>
    create(input: { path: string }): Promise<{ workspaceId: string }>
  }
  readonly uiWorkspace: { openSession(sessionId: string): void }
  readonly layout: {
    selectPanel(panelId: 'cqai-track'): void
    /** Available on the official layout service; also cancels manual navigation. */
    beginNavigation?(): AbortSignal
  }
  /** Native files and previews stay bound to their official Session seat. */
  readonly sidebarRight?: {
    readonly mounted: SnapshotSource<string | undefined>
    openTab(kind: 'files'): void
  }
  readonly api?: <T>(action: string, data: unknown) => Promise<T>
}

export interface TrackAgentSession {
  readonly sessionId: string
  readonly workspaceId: string
}

interface ScopeRequests {
  preparing?: Promise<TrackAgentSession>
  candidate?: TrackAgentSession
}

interface RuntimeRequests {
  /** Navigation is global even while different tracks prepare independently. */
  generation: number
  readonly scopes: Map<string | null, ScopeRequests>
}

const requests = new WeakMap<TrackAgentServices['sessions'], RuntimeRequests>()
const SNAPSHOT_TIMEOUT_MS = 8000

function aborted(): DOMException {
  return new DOMException('Agent 对话打开已取消', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted()
}

/** Wait on DSH sources, including synchronous subscription notifications. */
function waitForSnapshot<T>(source: SnapshotSource<T>, ready: (snapshot: T) => boolean, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error(message)), SNAPSHOT_TIMEOUT_MS)
    const check = () => {
      if (finished) return
      try {
        const snapshot = source.getSnapshot()
        const failure = snapshot as { state?: string; error?: { message?: string } | null }
        if (failure.state === 'error') {
          finish(new Error(failure.error?.message ? `${message}：${failure.error.message}` : message))
        } else if (ready(snapshot)) finish()
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(message))
      }
    }
    try {
      unsubscribe = source.subscribe(check)
      if (finished) unsubscribe()
      else check()
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error(message))
    }
  })
}

function eligibleSession(services: TrackAgentServices, sessionId: string): boolean {
  const sessions = services.sessions.list.getSnapshot()
  const workspaces = services.workspaces.list.getSnapshot()
  const summary = sessions.byId[sessionId]
  return sessions.phase === 'ready' && workspaces.phase === 'ready' && workspaces.state !== 'error'
    && sessions.ids.includes(sessionId) && Boolean(summary) && !summary.parentId && summary.origin !== 'subagent'
    && !workspaces.archivedSessionIds.includes(sessionId)
}

function reusable(services: TrackAgentServices, sessionId: string, workspaceId: string): boolean {
  return eligibleSession(services, sessionId) && services.workspaces.list.getSnapshot().items
    .some(item => item.workspaceId === workspaceId && item.sessionIds.includes(sessionId))
}

async function prepare(services: TrackAgentServices, scope: ScopeRequests, trackId: string | null): Promise<TrackAgentSession> {
  const api = services.api ?? defaultApi
  const linked = await api<{ path: string; sessionId: string | null }>('agent-workspace', { trackId })
  const workspace = await services.workspaces.create({ path: linked.path })
  await services.sessions.refresh()
  await waitForSnapshot(services.sessions.list, value => value.phase === 'ready', 'Agent 对话列表尚未就绪，请稍后重试')
  await waitForSnapshot(services.workspaces.list, value => value.phase === 'ready', 'Agent 工作区状态尚未就绪，请稍后重试')
  let sessionId = linked.sessionId
  if (!sessionId || !reusable(services, sessionId, workspace.workspaceId)) {
    const candidate = scope.candidate
    if (candidate?.workspaceId === workspace.workspaceId && eligibleSession(services, candidate.sessionId)) {
      sessionId = candidate.sessionId
    } else {
      scope.candidate = undefined
      sessionId = await services.sessions.create({ workspaceId: workspace.workspaceId })
      // Retain a successful creation across binding writes or follow-stream delays.
      scope.candidate = { sessionId, workspaceId: workspace.workspaceId }
    }
    const createdSessionId = sessionId
    await waitForSnapshot(services.workspaces.list, value => value.phase === 'ready'
      && value.items.some(item => item.workspaceId === workspace.workspaceId && item.sessionIds.includes(createdSessionId)),
    'Agent 工作区尚未关联新对话，请稍后重试')
  }
  if (!reusable(services, sessionId, workspace.workspaceId)) throw new Error('Agent 对话不存在、已归档或不属于轨迹工作区')
  // Keep a successfully created Session reusable even if its UI waiter has closed.
  await api<{ sessionId: string }>('agent-session', { sessionId, trackId })
  scope.candidate = undefined
  return { sessionId, workspaceId: workspace.workspaceId }
}

function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(aborted()) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, cause => {
      signal.removeEventListener('abort', onAbort)
      reject(cause)
    })
  })
}

/**
 * Prepare or reuse the selected track workspace's native Session, then activate it.
 * Repeated requests for the same track share preparation. Cancellation never deletes a Session,
 * and a superseded request never changes the selected Session or main panel.
 */
export async function ensureTrackAgentSession(
  services: TrackAgentServices,
  signal?: AbortSignal,
  trackId: string | null = null,
  options: {presentation?: 'track' | 'conversation'; onActivate?: () => void} = {},
): Promise<TrackAgentSession> {
  throwIfAborted(signal)
  const navigation = services.layout.beginNavigation?.()
  let runtime = requests.get(services.sessions)
  if (!runtime) {
    runtime = { generation: 0, scopes: new Map() }
    requests.set(services.sessions, runtime)
  }
  const generation = ++runtime.generation
  let scope = runtime.scopes.get(trackId)
  if (!scope) {
    scope = {}
    runtime.scopes.set(trackId, scope)
  }
  let preparation = scope.preparing
  if (!preparation) {
    // Capture this request's scope. A later selection must never rewrite its binding.
    preparation = prepare(services, scope, trackId)
    scope.preparing = preparation
    const currentScope = scope
    const clear = () => { if (currentScope.preparing === preparation) currentScope.preparing = undefined }
    preparation.then(clear, clear)
  }
  const result = await cancellable(preparation, signal)
  throwIfAborted(signal)
  throwIfAborted(navigation)
  if (generation !== runtime.generation) throw aborted()
  if (!reusable(services, result.sessionId, result.workspaceId)) throw new Error('Agent 对话已失效，请重新打开')
  // Native files and document previews belong to the official Conversation surface.
  options.onActivate?.()
  services.uiWorkspace.openSession(result.sessionId)
  if (options.presentation !== 'conversation') services.layout.selectPanel('cqai-track')
  return result
}
