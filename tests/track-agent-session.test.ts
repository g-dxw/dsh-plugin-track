import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureTrackAgentSession, type TrackAgentServices } from '../src/client/track-agent-session.ts'

type SessionCatalog = ReturnType<TrackAgentServices['sessions']['list']['getSnapshot']>
type WorkspaceCatalog = ReturnType<TrackAgentServices['workspaces']['list']['getSnapshot']>

function source<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { snapshot = next; for (const listener of [...listeners]) listener() },
    get subscriberCount() { return listeners.size },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve() }

function fixture(options: { linked?: string | null; automaticMembership?: boolean } = {}) {
  const catalog = source<SessionCatalog>({ phase: 'ready', ids: [], byId: {} })
  const workspaces = source<WorkspaceCatalog>({ phase: 'ready', state: 'idle', items: [], archivedSessionIds: [] })
  const linked = { sessionId: options.linked ?? null }
  const trackBindings = new Map<string, string>()
  const order: string[] = []
  const addSession = (sessionId: string, workspaceId: string, associate = true) => {
    catalog.set({ ...catalog.getSnapshot(), ids: [...catalog.getSnapshot().ids, sessionId],
      byId: { ...catalog.getSnapshot().byId, [sessionId]: {} } })
    if (associate) workspaces.set({ ...workspaces.getSnapshot(), items: workspaces.getSnapshot().items.map(item =>
      item.workspaceId === workspaceId ? { ...item, sessionIds: [...item.sessionIds, sessionId] } : item) })
  }
  const api = vi.fn(async (action: string, data: unknown): Promise<unknown> => {
    const input = data as { sessionId?: string; trackId?: string | null }
    if (action === 'agent-workspace') return input.trackId == null
      ? { path: '/agents/track', sessionId: linked.sessionId }
      : { path: '/agents/tracks/' + input.trackId, sessionId: trackBindings.get(input.trackId) ?? null }
    if (action === 'agent-session') {
      if (input.trackId == null) linked.sessionId = input.sessionId!
      else trackBindings.set(input.trackId, input.sessionId!)
      order.push('save:' + input.sessionId)
      return { sessionId: input.sessionId }
    }
    throw new Error('unexpected endpoint ' + action)
  })
  const createWorkspace = vi.fn(async ({ path }: { path: string }) => {
    const id = path.split('/').at(-1)!
    const workspaceId = 'workspace-' + id
    if (!workspaces.getSnapshot().items.some(item => item.workspaceId === workspaceId)) {
      workspaces.set({ ...workspaces.getSnapshot(), items: [...workspaces.getSnapshot().items, { workspaceId, sessionIds: [] }] })
    }
    return { workspaceId }
  })
  const createSession = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    const sessionId = 'session-' + workspaceId
    addSession(sessionId, workspaceId, options.automaticMembership !== false)
    return sessionId
  })
  const openSession = vi.fn((sessionId: string) => { order.push('open:' + sessionId) })
  const selectPanel = vi.fn((panelId: 'cqai-track') => { order.push('panel:' + panelId) })
  const services: TrackAgentServices = {
    sessions: { list: catalog, refresh: vi.fn(async () => {}), create: createSession },
    workspaces: { list: workspaces, create: createWorkspace },
    uiWorkspace: { openSession }, layout: { selectPanel },
    api: api as NonNullable<TrackAgentServices['api']>,
  }
  return { services, catalog, workspaces, linked, trackBindings, api, createWorkspace, createSession, addSession, openSession, selectPanel, order }
}

afterEach(() => { vi.useRealTimers() })

describe('track native Agent Session', () => {
  it('creates the fixed Track workspace and Session, persists it, then returns to the track panel', async () => {
    const f = fixture()
    expect(await ensureTrackAgentSession(f.services)).toEqual({ sessionId: 'session-workspace-track', workspaceId: 'workspace-track' })
    expect(f.createWorkspace).toHaveBeenCalledWith({ path: '/agents/track' })
    expect(f.createSession).toHaveBeenCalledWith({ workspaceId: 'workspace-track' })
    expect(f.order).toEqual(['save:session-workspace-track', 'open:session-workspace-track', 'panel:cqai-track'])
    expect(f.api.mock.calls).toEqual([['agent-workspace', { trackId: null }], ['agent-session', { sessionId: 'session-workspace-track', trackId: null }]])
    expect(f.catalog.subscriberCount + f.workspaces.subscriberCount).toBe(0)
  })

  it('opens route information as a full native conversation without returning to Track or altering the composer', async () => {
    const f = fixture()
    const composer = {input: {for: vi.fn(() => ({addAttachments: vi.fn(() => true)}))}, createDrafts: vi.fn(() => []), releaseDraftAttachments: vi.fn(), send: vi.fn()}
    const services: TrackAgentServices & {conversation: typeof composer} = {...f.services, conversation: composer}
    const opened = await ensureTrackAgentSession(services, undefined, 'track-A', {presentation: 'conversation'})
    expect(opened).toEqual({sessionId: 'session-workspace-track-A', workspaceId: 'workspace-track-A'})
    expect(f.order).toEqual(['save:session-workspace-track-A', 'open:session-workspace-track-A'])
    expect(f.selectPanel).not.toHaveBeenCalled()
    expect(f.api.mock.calls).toEqual([['agent-workspace', {trackId: 'track-A'}], ['agent-session', {sessionId: opened.sessionId, trackId: 'track-A'}]])
    expect(composer.input.for).not.toHaveBeenCalled(); expect(composer.createDrafts).not.toHaveBeenCalled(); expect(composer.send).not.toHaveBeenCalled()
    expect(f.catalog.subscriberCount + f.workspaces.subscriberCount).toBe(0)
  })

  it('reuses the route conversation across drawer and full conversation presentation', async () => {
    const f = fixture()
    const drawer = await ensureTrackAgentSession(f.services, undefined, 'track-A')
    f.selectPanel.mockClear()
    expect(await ensureTrackAgentSession(f.services, undefined, 'track-A', {presentation: 'conversation'})).toEqual(drawer)
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.openSession.mock.calls).toEqual([[drawer.sessionId], [drawer.sessionId]])
    expect(f.selectPanel).not.toHaveBeenCalled()
    expect(f.trackBindings.get('track-A')).toBe(drawer.sessionId)
  })
  it('reuses the fixed native conversation on reopen', async () => {
    const f = fixture()
    await ensureTrackAgentSession(f.services)
    await ensureTrackAgentSession(f.services)
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.openSession).toHaveBeenCalledTimes(2)
    expect(f.linked.sessionId).toBe('session-workspace-track')
  })

  it.each(['missing', 'parent', 'subagent', 'archived', 'another-workspace'])('replaces an ineligible linked Session: %s', async kind => {
    const f = fixture({ linked: 'old' })
    await f.createWorkspace({ path: '/agents/track' })
    if (kind !== 'missing') f.addSession('old', kind === 'another-workspace' ? 'elsewhere' : 'workspace-track')
    if (kind === 'parent' || kind === 'subagent') f.catalog.set({ ...f.catalog.getSnapshot(), byId: {
      old: kind === 'parent' ? { parentId: 'parent' } : { origin: 'subagent' },
    } })
    if (kind === 'archived') f.workspaces.set({ ...f.workspaces.getSnapshot(), archivedSessionIds: ['old'] })
    const opened = await ensureTrackAgentSession(f.services)
    expect(opened.sessionId).toBe('session-workspace-track')
    expect(f.openSession).not.toHaveBeenCalledWith('old')
  })

  it('waits for both catalog baselines before creating and never uses pending as empty', async () => {
    const f = fixture()
    f.catalog.set({ ...f.catalog.getSnapshot(), phase: 'pending' })
    f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'pending' })
    const opening = ensureTrackAgentSession(f.services)
    await flush()
    expect(f.createSession).not.toHaveBeenCalled()
    f.catalog.set({ ...f.catalog.getSnapshot(), phase: 'ready' })
    await flush()
    expect(f.createSession).not.toHaveBeenCalled()
    f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'ready' })
    await opening
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.catalog.subscriberCount + f.workspaces.subscriberCount).toBe(0)
  })

  it('waits for workspace membership before activating the new Session', async () => {
    const f = fixture({ automaticMembership: false })
    const opening = ensureTrackAgentSession(f.services)
    await flush()
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.openSession).not.toHaveBeenCalled()
    f.workspaces.set({ ...f.workspaces.getSnapshot(), items: [{ workspaceId: 'workspace-track', sessionIds: ['session-workspace-track'] }] })
    await opening
    expect(f.openSession).toHaveBeenCalledOnce()
    expect(f.workspaces.subscriberCount).toBe(0)
  })

  it('rejects an already-cancelled call without any API or navigation', async () => {
    const f = fixture()
    const cancellation = new AbortController(); cancellation.abort()
    await expect(ensureTrackAgentSession(f.services, cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.api).not.toHaveBeenCalled()
    expect(f.openSession).not.toHaveBeenCalled()
  })

  it('preserves a Session created during cancellation for a subsequent reopen', async () => {
    const f = fixture()
    const gate = deferred<string>()
    f.createSession.mockImplementationOnce(() => gate.promise)
    const cancellation = new AbortController()
    const opening = ensureTrackAgentSession(f.services, cancellation.signal)
    const cancelled = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    expect(f.createSession).toHaveBeenCalledOnce()
    cancellation.abort()
    await cancelled
    f.addSession('kept', 'workspace-track'); gate.resolve('kept')
    await flush()
    expect(f.linked.sessionId).toBe('kept')
    expect(f.openSession).not.toHaveBeenCalled()
    await ensureTrackAgentSession(f.services)
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.openSession).toHaveBeenCalledWith('kept')
  })

  it('shares repeated simultaneous opens without creating duplicate Sessions', async () => {
    const f = fixture()
    const first = ensureTrackAgentSession(f.services).catch(cause => cause as Error)
    const second = ensureTrackAgentSession(f.services)
    expect(await first).toMatchObject({ name: 'AbortError' })
    await second
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.api.mock.calls.filter(call => call[0] === 'agent-workspace')).toHaveLength(1)
    expect(f.openSession).toHaveBeenCalledOnce()
  })

  it('shares delayed preparation when the latest opening follows a cancelled opening', async () => {
    const f = fixture()
    const gate = deferred<string>()
    f.createSession.mockImplementationOnce(() => gate.promise)
    const cancellation = new AbortController()
    const old = ensureTrackAgentSession(f.services, cancellation.signal).catch(cause => cause as Error)
    await flush()
    cancellation.abort()
    const current = ensureTrackAgentSession(f.services)
    await flush()
    f.addSession('late-shared', 'workspace-track'); gate.resolve('late-shared')
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(await current).toEqual({ sessionId: 'late-shared', workspaceId: 'workspace-track' })
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.openSession.mock.calls).toEqual([['late-shared']])
    expect(f.linked.sessionId).toBe('late-shared')
  })

  it('honors a later manual DSH navigation before activating the prepared Session', async () => {
    const f = fixture()
    const navigation = new AbortController()
    f.services.layout.beginNavigation = () => navigation.signal
    const gate = deferred<string>()
    f.createSession.mockImplementationOnce(() => gate.promise)
    const opening = ensureTrackAgentSession(f.services).catch(cause => cause as Error)
    await flush(); navigation.abort()
    f.addSession('prepared', 'workspace-track'); gate.resolve('prepared')
    expect(await opening).toMatchObject({ name: 'AbortError' })
    expect(f.openSession).not.toHaveBeenCalled()
    expect(f.selectPanel).not.toHaveBeenCalled()
  })

  it('times out a missing baseline and releases its subscription', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'pending' })
    const failed = ensureTrackAgentSession(f.services).catch(cause => cause as Error)
    await flush()
    await vi.advanceTimersByTimeAsync(8000)
    expect(await failed).toMatchObject({ message: 'Agent 工作区状态尚未就绪，请稍后重试' })
    expect(f.workspaces.subscriberCount).toBe(0)
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.openSession).not.toHaveBeenCalled()
  })

  it('reports a failed workspace feed without activating or leaving a listener', async () => {
    const f = fixture()
    f.workspaces.set({ ...f.workspaces.getSnapshot(), state: 'error', error: { message: 'follow disconnected' } })
    await expect(ensureTrackAgentSession(f.services)).rejects.toThrow('follow disconnected')
    expect(f.workspaces.subscriberCount).toBe(0)
    expect(f.openSession).not.toHaveBeenCalled()
  })

  it('retries a failed binding write with the Session already created for the fixed workspace', async () => {
    const f = fixture()
    const api = f.services.api!
    let failSave = true
    const services: TrackAgentServices = { ...f.services, api: async <T>(action: string, data: unknown): Promise<T> => {
      if (action === 'agent-session' && failSave) { failSave = false; throw new Error('binding write failed') }
      return api<T>(action, data)
    } }
    await expect(ensureTrackAgentSession(services)).rejects.toThrow('binding write failed')
    expect(f.linked.sessionId).toBeNull()
    expect(f.openSession).not.toHaveBeenCalled()
    expect(await ensureTrackAgentSession(services)).toMatchObject({ sessionId: 'session-workspace-track' })
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.workspaces.getSnapshot().items[0].sessionIds).toEqual(['session-workspace-track'])
    expect(f.linked.sessionId).toBe('session-workspace-track')
  })

  it('retries a workspace membership timeout by waiting on the same created Session', async () => {
    vi.useFakeTimers()
    const f = fixture({ automaticMembership: false })
    const failed = ensureTrackAgentSession(f.services).catch(cause => cause as Error)
    await flush()
    await vi.advanceTimersByTimeAsync(8000)
    expect(await failed).toMatchObject({ message: 'Agent 工作区尚未关联新对话，请稍后重试' })
    expect(f.workspaces.subscriberCount).toBe(0)
    expect(f.linked.sessionId).toBeNull()
    const retry = ensureTrackAgentSession(f.services)
    await flush()
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.openSession).not.toHaveBeenCalled()
    // The delayed follow increment arrives after the first attempt timed out.
    f.workspaces.set({ ...f.workspaces.getSnapshot(), items: [{ workspaceId: 'workspace-track', sessionIds: ['session-workspace-track'] }] })
    expect(await retry).toMatchObject({ sessionId: 'session-workspace-track' })
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.linked.sessionId).toBe('session-workspace-track')
    expect(f.workspaces.subscriberCount).toBe(0)
  })

  it.each(['archived', 'deleted', 'parent', 'subagent'])('replaces an unbound retry candidate after it becomes %s', async kind => {
    const f = fixture()
    const api = f.services.api!
    let failSave = true
    const services: TrackAgentServices = { ...f.services, api: async <T>(action: string, data: unknown): Promise<T> => {
      if (action === 'agent-session' && failSave) { failSave = false; throw new Error('binding write failed') }
      return api<T>(action, data)
    } }
    f.createSession.mockImplementationOnce(async ({ workspaceId }) => { f.addSession('candidate-old', workspaceId); return 'candidate-old' })
    await expect(ensureTrackAgentSession(services)).rejects.toThrow('binding write failed')
    if (kind === 'archived') f.workspaces.set({ ...f.workspaces.getSnapshot(), archivedSessionIds: ['candidate-old'] })
    if (kind === 'deleted') f.catalog.set({ ...f.catalog.getSnapshot(), ids: [], byId: {} })
    if (kind === 'parent' || kind === 'subagent') f.catalog.set({ ...f.catalog.getSnapshot(), byId: {
      'candidate-old': kind === 'parent' ? { parentId: 'other' } : { origin: 'subagent' },
    } })
    expect(await ensureTrackAgentSession(services)).toMatchObject({ sessionId: 'session-workspace-track' })
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.openSession.mock.calls).toEqual([['session-workspace-track']])
    expect(f.linked.sessionId).toBe('session-workspace-track')
  })

  it('refuses activation if the Session is archived while its binding is being saved', async () => {
    const f = fixture()
    const original = f.services.api!
    const gate = deferred<void>()
    const services: TrackAgentServices = { ...f.services, api: async <T>(action: string, data: unknown): Promise<T> => {
      const result = await original<T>(action, data)
      if (action === 'agent-session') await gate.promise
      return result
    } }
    const opening = ensureTrackAgentSession(services)
    const failed = expect(opening).rejects.toThrow('Agent 对话已失效')
    await flush()
    f.workspaces.set({ ...f.workspaces.getSnapshot(), archivedSessionIds: ['session-workspace-track'] })
    gate.resolve()
    await failed
    expect(f.openSession).not.toHaveBeenCalled()
  })
  it('keeps A and B in separate projects and reuses A when returning from B', async () => {
    const f = fixture()
    const a = await ensureTrackAgentSession(f.services, undefined, 'track-A')
    const b = await ensureTrackAgentSession(f.services, undefined, 'track-B')
    const returnedA = await ensureTrackAgentSession(f.services, undefined, 'track-A')
    expect(a).toEqual({ sessionId: 'session-workspace-track-A', workspaceId: 'workspace-track-A' })
    expect(b).toEqual({ sessionId: 'session-workspace-track-B', workspaceId: 'workspace-track-B' })
    expect(returnedA).toEqual(a)
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.createWorkspace.mock.calls).toEqual([
      [{ path: '/agents/tracks/track-A' }], [{ path: '/agents/tracks/track-B' }], [{ path: '/agents/tracks/track-A' }],
    ])
    expect(f.openSession.mock.calls).toEqual([[a.sessionId], [b.sessionId], [a.sessionId]])
    expect(f.trackBindings).toEqual(new Map([['track-A', a.sessionId], ['track-B', b.sessionId]]))
    expect(f.linked.sessionId).toBeNull()
  })

  it('keeps the global workspace independent from any selected track', async () => {
    const f = fixture()
    const global = await ensureTrackAgentSession(f.services)
    const selected = await ensureTrackAgentSession(f.services, undefined, 'track-A')
    expect(await ensureTrackAgentSession(f.services)).toEqual(global)
    expect(selected.workspaceId).not.toBe(global.workspaceId)
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.linked.sessionId).toBe(global.sessionId)
    expect(f.trackBindings.get('track-A')).toBe(selected.sessionId)
  })

  it('deduplicates simultaneous preparation within the selected track scope', async () => {
    const f = fixture()
    const gate = deferred<string>()
    f.createSession.mockImplementationOnce(() => gate.promise)
    const first = ensureTrackAgentSession(f.services, undefined, 'track-A').catch(cause => cause as Error)
    const latest = ensureTrackAgentSession(f.services, undefined, 'track-A')
    await flush()
    expect(f.createSession).toHaveBeenCalledOnce()
    f.addSession('shared-A', 'workspace-track-A'); gate.resolve('shared-A')
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(await latest).toEqual({ sessionId: 'shared-A', workspaceId: 'workspace-track-A' })
    expect(f.api.mock.calls.filter(call => call[0] === 'agent-workspace')).toEqual([
      ['agent-workspace', { trackId: 'track-A' }],
    ])
    expect(f.openSession.mock.calls).toEqual([['shared-A']])
  })

  it('prepares different tracks concurrently and only activates the latest selection', async () => {
    const f = fixture()
    const aGate = deferred<string>()
    const bGate = deferred<string>()
    f.createSession.mockImplementation(({ workspaceId }) => workspaceId === 'workspace-track-A' ? aGate.promise : bGate.promise)
    const a = ensureTrackAgentSession(f.services, undefined, 'track-A').catch(cause => cause as Error)
    await flush()
    const b = ensureTrackAgentSession(f.services, undefined, 'track-B')
    await flush()
    expect(f.createSession.mock.calls).toEqual([
      [{ workspaceId: 'workspace-track-A' }], [{ workspaceId: 'workspace-track-B' }],
    ])
    f.addSession('native-B', 'workspace-track-B'); bGate.resolve('native-B')
    expect(await b).toEqual({ sessionId: 'native-B', workspaceId: 'workspace-track-B' })
    f.addSession('native-A', 'workspace-track-A'); aGate.resolve('native-A')
    expect(await a).toMatchObject({ name: 'AbortError' })
    expect(f.trackBindings).toEqual(new Map([['track-B', 'native-B'], ['track-A', 'native-A']]))
    expect(f.api.mock.calls.filter(call => call[0] === 'agent-session')).toEqual([
      ['agent-session', { sessionId: 'native-B', trackId: 'track-B' }],
      ['agent-session', { sessionId: 'native-A', trackId: 'track-A' }],
    ])
    expect(f.openSession.mock.calls).toEqual([['native-B']])
    expect(f.selectPanel).toHaveBeenCalledOnce()
    expect(await ensureTrackAgentSession(f.services, undefined, 'track-A')).toMatchObject({ sessionId: 'native-A' })
    expect(f.createSession).toHaveBeenCalledTimes(2)
  })

  it('does not activate a cancelled track after another track opens, and retains its own binding', async () => {
    const f = fixture()
    const gate = deferred<string>()
    f.createSession.mockImplementationOnce(() => gate.promise)
    const cancellation = new AbortController()
    const old = ensureTrackAgentSession(f.services, cancellation.signal, 'track-A').catch(cause => cause as Error)
    await flush(); cancellation.abort()
    const selected = await ensureTrackAgentSession(f.services, undefined, 'track-B')
    f.addSession('late-A', 'workspace-track-A'); gate.resolve('late-A')
    await flush()
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(f.openSession.mock.calls).toEqual([[selected.sessionId]])
    expect(f.trackBindings.get('track-A')).toBe('late-A')
    expect(f.trackBindings.get('track-B')).toBe(selected.sessionId)
    expect(await ensureTrackAgentSession(f.services, undefined, 'track-A')).toMatchObject({ sessionId: 'late-A' })
    expect(f.createSession).toHaveBeenCalledTimes(2)
  })

  it('reuses only the failed track candidate when binding is retried after visiting another track', async () => {
    const f = fixture()
    const original = f.services.api!
    let failedA = false
    const services: TrackAgentServices = { ...f.services, api: async <T>(action: string, data: unknown): Promise<T> => {
      const input = data as { trackId?: string | null }
      if (action === 'agent-session' && input.trackId === 'track-A' && !failedA) {
        failedA = true
        throw new Error('A binding write failed')
      }
      return original<T>(action, data)
    } }
    await expect(ensureTrackAgentSession(services, undefined, 'track-A')).rejects.toThrow('A binding write failed')
    expect(f.trackBindings.has('track-A')).toBe(false)
    const b = await ensureTrackAgentSession(services, undefined, 'track-B')
    const a = await ensureTrackAgentSession(services, undefined, 'track-A')
    expect(a).toMatchObject({ sessionId: 'session-workspace-track-A' })
    expect(b).toMatchObject({ sessionId: 'session-workspace-track-B' })
    expect(f.createSession).toHaveBeenCalledTimes(2)
    expect(f.openSession.mock.calls).toEqual([[b.sessionId], [a.sessionId]])
  })

  it('rejects another track’s bound session even when it is an eligible root session', async () => {
    const f = fixture()
    const a = await ensureTrackAgentSession(f.services, undefined, 'track-A')
    f.trackBindings.set('track-B', a.sessionId)
    const b = await ensureTrackAgentSession(f.services, undefined, 'track-B')
    expect(b).toMatchObject({ sessionId: 'session-workspace-track-B', workspaceId: 'workspace-track-B' })
    expect(f.trackBindings.get('track-A')).toBe(a.sessionId)
    expect(f.trackBindings.get('track-B')).toBe(b.sessionId)
    expect(f.createSession).toHaveBeenCalledTimes(2)
  })
})
