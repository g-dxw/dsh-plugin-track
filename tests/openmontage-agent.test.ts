// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest'
import {acknowledgeOpenMontageAgentMessage, ensureOpenMontageAgentSession, prepareOpenMontageAgentMessage, sendOpenMontageAgentMessage, openOpenMontageProjectDrawer, closeOpenMontageProjectDrawer} from '../src/client/openmontage-agent.ts'
import type {TrackAgentServices} from '../src/client/track-agent-session.ts'
import {TrackAgentProjectRetentions} from '../src/client/track-agent-projects.ts'
import {TRACK_AGENT_DRAWER_EVENT, TRACK_AGENT_CAPABILITIES_EVENT} from '../src/client/useTrackAgentDrawer.ts'

type SessionCatalog = ReturnType<TrackAgentServices['sessions']['list']['getSnapshot']>
type WorkspaceCatalog = ReturnType<TrackAgentServices['workspaces']['list']['getSnapshot']>
function source<T>(initial: T) {
  let snapshot = initial; const listeners = new Set<() => void>()
  return {getSnapshot: () => snapshot, subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener)}},
    set(next: T) {snapshot = next; for (const listener of [...listeners]) listener()}, get count() {return listeners.size}}
}
function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
async function flush() {for (let i = 0; i < 25; i++) await Promise.resolve()}
const disposers: (() => void)[] = []
function fixture(options: {linked?: string | null; membership?: boolean; scopeStyle?: 'direct' | 'get'; drawer?: boolean} = {}) {
  const sessions = source<SessionCatalog>({phase: 'ready', ids: [], byId: {}}), workspaces = source<WorkspaceCatalog>({phase: 'ready', state: 'idle', items: [], archivedSessionIds: []})
  const bindings = new Map<string, string>(), retained = new Set<string>(), events: unknown[] = [], order: string[] = []
  const send = vi.fn(async (_text: string) => {}), release = vi.fn((id: string) => retained.delete(id))
  let nextSession = 0
  const key = (trackId: string, projectId: string) => JSON.stringify([trackId, projectId])
  const add = (id: string, workspaceId: string, membership = true) => {
    sessions.set({...sessions.getSnapshot(), ids: [...new Set([...sessions.getSnapshot().ids, id])], byId: {...sessions.getSnapshot().byId, [id]: {}}})
    if (membership) workspaces.set({...workspaces.getSnapshot(), items: workspaces.getSnapshot().items.map(item => item.workspaceId === workspaceId ? {...item, sessionIds: [...new Set([...item.sessionIds, id])]} : item)})
  }
  const createWorkspace = vi.fn(async ({path}: {path: string}) => {
    const workspaceId = 'workspace:' + path
    if (!workspaces.getSnapshot().items.some(item => item.workspaceId === workspaceId)) workspaces.set({...workspaces.getSnapshot(), items: [...workspaces.getSnapshot().items, {workspaceId, sessionIds: []}]})
    return {workspaceId}
  })
  const createSession = vi.fn(async (input: {workspaceId: string; cwd?: string}) => {const id = 'native-session-' + ++nextSession; add(id, input.workspaceId, options.membership !== false); return id})
  const api = vi.fn(async (action: string, raw: unknown) => {
    const value = raw as {trackId: string; projectId: string; sessionId: string}
    if (action === 'openmontage-agent-workspace') return {path: `/projects/${value.trackId}/${value.projectId}`, sessionId: bindings.get(key(value.trackId, value.projectId)) || options.linked || null,
      trackId: value.trackId, projectId: value.projectId, environment: {OPENMONTAGE_ROOT: '/engine', PYTHONPATH: '/engine/python'}, initialPrompt: '从此项目的 idea 阶段开始'}
    if (action === 'openmontage-agent-session') {bindings.set(key(value.trackId, value.projectId), value.sessionId); order.push('bind:' + value.sessionId); return {sessionId: value.sessionId}}
    throw new Error('Unexpected API: ' + action)
  })
  const scope = vi.fn((id: string) => {
    if (!retained.has(id)) return undefined
    return options.scopeStyle === 'get' ? {get: vi.fn((name: string) => name === 'conversation' ? {send} : undefined)} : {conversation: {send}}
  })
  const retain = vi.fn((id: string) => {retained.add(id); order.push('retain:' + id); return {sessionId: id, ready: Promise.resolve(), release: () => release(id)}})
  const services: TrackAgentServices = {sessions: {list: sessions, refresh: vi.fn(async () => {}), create: createSession, retain, scope},
    workspaces: {list: workspaces, create: createWorkspace}, uiWorkspace: {openSession: vi.fn((id: string) => order.push('open:' + id))},
    layout: {selectPanel: vi.fn((id: 'cqai-track') => order.push('panel:' + id))}, api: api as NonNullable<TrackAgentServices['api']>}
  const retentions = new TrackAgentProjectRetentions(), keep = (id: string, signal?: AbortSignal) => retentions.hold(services.sessions, id, signal)
  const listener = (event: Event) => events.push((event as CustomEvent).detail)
  const capability = (event: Event) => (event as CustomEvent<{accept: (value: {sides: string[]}) => void}>).detail.accept({sides: options.drawer === false ? [] : ['left']})
  window.addEventListener(TRACK_AGENT_DRAWER_EVENT, listener)
  window.addEventListener(TRACK_AGENT_CAPABILITIES_EVENT, capability)
  disposers.push(() => {window.removeEventListener(TRACK_AGENT_DRAWER_EVENT, listener); window.removeEventListener(TRACK_AGENT_CAPABILITIES_EVENT, capability); retentions.releaseAll()})
  return {services, sessions, workspaces, bindings, createWorkspace, createSession, add, api, scope, send, retain, release, retentions, keep, events, order, retained}
}
afterEach(() => {for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers(); vi.restoreAllMocks()})

describe('OpenMontage native project Agent session', () => {
  it('uses its project path as the workspace and native cwd, binds before returning and never opens or sends during preparation', async () => {
    const f = fixture(), session = await ensureOpenMontageAgentSession(f.services, 'track-a', 'project-a')
    expect(session).toEqual({path: '/projects/track-a/project-a', trackId: 'track-a', projectId: 'project-a', sessionId: 'native-session-1', workspaceId: 'workspace:/projects/track-a/project-a',
      environment: {OPENMONTAGE_ROOT: '/engine', PYTHONPATH: '/engine/python'}, initialPrompt: '从此项目的 idea 阶段开始'})
    expect(f.createWorkspace).toHaveBeenCalledWith({path: session.path}); expect(f.createSession).toHaveBeenCalledWith({workspaceId: session.workspaceId, cwd: session.path})
    expect(f.api.mock.calls).toEqual([['openmontage-agent-workspace', {trackId: 'track-a', projectId: 'project-a'}], ['openmontage-agent-session', {trackId: 'track-a', projectId: 'project-a', sessionId: session.sessionId}]])
    expect(f.services.uiWorkspace.openSession).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.retain).not.toHaveBeenCalled(); expect(f.sessions.count + f.workspaces.count).toBe(0)
  })
  it('reuses each project independently, including the same project id on different tracks', async () => {
    const f = fixture(), a = await ensureOpenMontageAgentSession(f.services, 'track-a', 'same'), b = await ensureOpenMontageAgentSession(f.services, 'track-b', 'same')
    expect(a.sessionId).not.toBe(b.sessionId); expect(await ensureOpenMontageAgentSession(f.services, 'track-a', 'same')).toEqual(a)
    expect(f.createSession).toHaveBeenCalledTimes(2); expect(f.bindings.size).toBe(2)
  })
  it.each(['parent', 'subagent', 'archived', 'wrong-workspace', 'missing'])('does not adopt an ineligible linked session: %s', async kind => {
    const f = fixture({linked: 'old'}), {workspaceId} = await f.createWorkspace({path: '/projects/t/p'})
    if (kind !== 'missing') f.add('old', kind === 'wrong-workspace' ? 'unrelated' : workspaceId)
    if (kind === 'parent' || kind === 'subagent') f.sessions.set({...f.sessions.getSnapshot(), byId: {old: kind === 'parent' ? {parentId: 'parent'} : {origin: 'subagent'}}})
    if (kind === 'archived') f.workspaces.set({...f.workspaces.getSnapshot(), archivedSessionIds: ['old']})
    expect((await ensureOpenMontageAgentSession(f.services, 't', 'p')).sessionId).toBe('native-session-1'); expect(f.createSession).toHaveBeenCalledOnce()
  })
  it('waits for both baselines and delayed workspace membership without treating pending as empty', async () => {
    const f = fixture({membership: false}); f.sessions.set({...f.sessions.getSnapshot(), phase: 'pending'}); f.workspaces.set({...f.workspaces.getSnapshot(), phase: 'pending'})
    const opening = ensureOpenMontageAgentSession(f.services, 't', 'p'); await flush(); expect(f.createSession).not.toHaveBeenCalled()
    f.sessions.set({...f.sessions.getSnapshot(), phase: 'ready'}); await flush(); expect(f.createSession).not.toHaveBeenCalled()
    f.workspaces.set({...f.workspaces.getSnapshot(), phase: 'ready'}); await flush(); expect(f.createSession).toHaveBeenCalledOnce(); expect(f.bindings.size).toBe(0)
    f.add('native-session-1', 'workspace:/projects/t/p'); expect((await opening).sessionId).toBe('native-session-1'); expect(f.sessions.count + f.workspaces.count).toBe(0)
  })
  it('shares concurrent same-project preparation and rejects only the superseded UI waiter', async () => {
    const f = fixture(), first = ensureOpenMontageAgentSession(f.services, 't', 'p').catch(error => error as Error), second = ensureOpenMontageAgentSession(f.services, 't', 'p')
    expect(await first).toMatchObject({name: 'AbortError'}); expect((await second).sessionId).toBe('native-session-1')
    expect(f.createSession).toHaveBeenCalledOnce(); expect(f.api.mock.calls.filter(([name]) => name === 'openmontage-agent-workspace')).toHaveLength(1)
  })
  it('keeps a created session after cancellation or binding failure and reuses it on retry', async () => {
    const f = fixture(), gate = deferred<string>(), cancel = new AbortController(); f.createSession.mockImplementationOnce(() => gate.promise)
    const opening = ensureOpenMontageAgentSession(f.services, 't', 'p', cancel.signal).catch(error => error as Error); await flush(); cancel.abort(); expect(await opening).toMatchObject({name: 'AbortError'})
    f.add('created-before-cancel', 'workspace:/projects/t/p'); gate.resolve('created-before-cancel'); await flush()
    expect((await ensureOpenMontageAgentSession(f.services, 't', 'p')).sessionId).toBe('created-before-cancel'); expect(f.createSession).toHaveBeenCalledOnce()
    const g = fixture(), implementation = g.api.getMockImplementation()!; let fail = true
    g.api.mockImplementation(async (name, value) => {if (name === 'openmontage-agent-session' && fail) {fail = false; throw new Error('binding disconnected')}; return implementation(name, value)})
    await expect(ensureOpenMontageAgentSession(g.services, 't', 'p')).rejects.toThrow('binding disconnected')
    expect((await ensureOpenMontageAgentSession(g.services, 't', 'p')).sessionId).toBe('native-session-1'); expect(g.createSession).toHaveBeenCalledOnce()
  })
  it('honors pre-cancellation and later manual navigation without activating a prepared session', async () => {
    const f = fixture(), cancel = new AbortController(); cancel.abort()
    await expect(ensureOpenMontageAgentSession(f.services, 't', 'p', cancel.signal)).rejects.toMatchObject({name: 'AbortError'}); expect(f.api).not.toHaveBeenCalled()
    const gate = deferred<string>(), navigation = new AbortController(); f.services.layout.beginNavigation = () => navigation.signal; f.createSession.mockImplementationOnce(() => gate.promise)
    const opening = ensureOpenMontageAgentSession(f.services, 't', 'p').catch(error => error as Error); await flush(); navigation.abort(); f.add('kept', 'workspace:/projects/t/p'); gate.resolve('kept')
    expect(await opening).toMatchObject({name: 'AbortError'}); expect(f.services.uiWorkspace.openSession).not.toHaveBeenCalled(); expect(f.events).toEqual([])
  })
  it('releases synchronous snapshot subscriptions and reports timeout or feed failure', async () => {
    const f = fixture(), subscribe = f.sessions.subscribe
    f.services.sessions.list.subscribe = listener => {const stop = subscribe(listener); listener(); return stop}
    await ensureOpenMontageAgentSession(f.services, 't', 'p'); expect(f.sessions.count).toBe(0)
    const g = fixture(); g.workspaces.set({...g.workspaces.getSnapshot(), state: 'error', error: {message: 'follow disconnected'}})
    await expect(ensureOpenMontageAgentSession(g.services, 't', 'p')).rejects.toThrow('follow disconnected'); expect(g.workspaces.count).toBe(0)
    vi.useFakeTimers(); const h = fixture(); h.sessions.set({...h.sessions.getSnapshot(), phase: 'pending'})
    const failed = ensureOpenMontageAgentSession(h.services, 't', 'p').catch(error => error as Error); await flush(); await vi.advanceTimersByTimeAsync(8000)
    expect(await failed).toMatchObject({message: 'Agent 对话列表尚未就绪，请稍后重试'}); expect(h.sessions.count).toBe(0); expect(h.createSession).not.toHaveBeenCalled()
  })
  it('refuses malformed cross-project workspace or unconfirmed binding results', async () => {
    const f = fixture(); f.api.mockResolvedValueOnce({path: '/other', sessionId: null, trackId: 'other', projectId: 'p', initialPrompt: '', environment: {OPENMONTAGE_ROOT: '/other', PYTHONPATH: '/other'}})
    await expect(ensureOpenMontageAgentSession(f.services, 't', 'p')).rejects.toThrow('项目绑定无效'); expect(f.createWorkspace).not.toHaveBeenCalled()
    const g = fixture(), implementation = g.api.getMockImplementation()!
    g.api.mockImplementation(async (name, value) => name === 'openmontage-agent-session' ? {sessionId: 'other'} : implementation(name, value))
    await expect(ensureOpenMontageAgentSession(g.services, 't', 'p')).rejects.toThrow('绑定未获确认'); expect(g.send).not.toHaveBeenCalled()
  })
})

describe('OpenMontage native Conversation and project drawer', () => {
  it.each(['direct', 'get'] as const)('retains through the panel before opening the native drawer and sends verbatim through the scoped %s Conversation', async scopeStyle => {
    const f = fixture({scopeStyle}), session = await ensureOpenMontageAgentSession(f.services, 't', 'p')
    const request = await openOpenMontageProjectDrawer(f.services, session, {onKeepSession: f.keep, requestId: 'drawer-one', summary: {items: [{label: '项目', value: 'p'}]}})
    expect(f.order).toEqual(['bind:native-session-1', 'retain:native-session-1', 'open:native-session-1', 'panel:cqai-track'])
    expect(f.events).toEqual([request]); expect(request).toMatchObject({open: true, panelId: 'cqai-track', entityId: 'openmontage:t:p', sessionId: session.sessionId, side: 'left', mode: 'simple'})
    const receipt = await sendOpenMontageAgentMessage(f.services, session, '保留原文\n只规划 idea，不自动批准', {requestId: 'message-one'})
    expect(receipt).toEqual({status: 'accepted', sessionId: session.sessionId, requestId: 'message-one'}); expect(f.send).toHaveBeenCalledWith('保留原文\n只规划 idea，不自动批准')
    closeOpenMontageProjectDrawer(request); expect(f.events.at(-1)).toEqual({...request, open: false}); expect(f.release).not.toHaveBeenCalled()
    f.retentions.releaseAll(); expect(f.release).toHaveBeenCalledOnce()
  })
  it('reuses panel retentions while preserving independent project scopes and native unsent drafts', async () => {
    const f = fixture(), a = await ensureOpenMontageAgentSession(f.services, 't', 'a'); await openOpenMontageProjectDrawer(f.services, a, {onKeepSession: f.keep})
    const b = await ensureOpenMontageAgentSession(f.services, 't', 'b'); await openOpenMontageProjectDrawer(f.services, b, {onKeepSession: f.keep})
    await openOpenMontageProjectDrawer(f.services, a, {onKeepSession: f.keep}); expect(f.retain).toHaveBeenCalledTimes(2); expect(f.release).not.toHaveBeenCalled(); expect(f.retained.size).toBe(2)
    expect(f.send).not.toHaveBeenCalled(); expect(f.events).toHaveLength(3)
  })
  it('cancels a pending drawer waiter without opening, sending or releasing its panel-owned reference', async () => {
    const f = fixture(), session = await ensureOpenMontageAgentSession(f.services, 't', 'p'), gate = deferred<void>(), cancel = new AbortController()
    const keep = vi.fn(async (id: string, signal?: AbortSignal) => {await f.keep(id, signal); await gate.promise})
    const opening = openOpenMontageProjectDrawer(f.services, session, {onKeepSession: keep, signal: cancel.signal}).catch(error => error as Error)
    await flush(); cancel.abort(); expect(await opening).toMatchObject({name: 'AbortError'}); gate.resolve(); await flush()
    expect(f.events).toEqual([]); expect(f.services.uiWorkspace.openSession).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('shares an admission and remembers late acceptance after navigation cancellation without resending', async () => {
    const f = fixture(), session = await ensureOpenMontageAgentSession(f.services, 't', 'p'); await f.keep(session.sessionId)
    const gate = deferred<void>(), cancel = new AbortController(); f.send.mockReturnValueOnce(gate.promise)
    const first = sendOpenMontageAgentMessage(f.services, session, 'initial prompt', {requestId: 'init-p', signal: cancel.signal}).catch(error => error as Error)
    const second = sendOpenMontageAgentMessage(f.services, session, 'initial prompt', {requestId: 'init-p'})
    expect(f.send).toHaveBeenCalledOnce(); cancel.abort(); expect(await first).toMatchObject({name: 'AbortError'})
    gate.resolve(); expect(await second).toMatchObject({status: 'accepted'}); expect(await sendOpenMontageAgentMessage(f.services, session, 'initial prompt', {requestId: 'init-p'})).toMatchObject({status: 'accepted'})
    expect(f.send).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled()
    await expect(sendOpenMontageAgentMessage(f.services, session, 'different message', {requestId: 'init-p'})).rejects.toThrow('用于另一条消息')
    await sendOpenMontageAgentMessage(f.services, session, 'initial prompt', {requestId: 'user-repeat'}); expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('does not dispatch an already-cancelled message and permits an explicit retry after native admission rejection', async () => {
    const f = fixture(), session = await ensureOpenMontageAgentSession(f.services, 't', 'p'); await f.keep(session.sessionId)
    const cancel = new AbortController(); cancel.abort()
    await expect(sendOpenMontageAgentMessage(f.services, session, 'text', {requestId: 'a', signal: cancel.signal})).rejects.toMatchObject({name: 'AbortError'}); expect(f.send).not.toHaveBeenCalled()
    f.send.mockRejectedValueOnce(new Error('conversation.send failed: session/agent-busy: busy'))
    await expect(sendOpenMontageAgentMessage(f.services, session, 'text', {requestId: 'a'})).rejects.toThrow('agent-busy')
    expect(await sendOpenMontageAgentMessage(f.services, session, 'text', {requestId: 'a'})).toMatchObject({status: 'accepted'}); expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('retains cancelled user intent and late acceptance in project memory until an active UI acknowledges it', async () => {
    const f = fixture(), session = await ensureOpenMontageAgentSession(f.services, 't', 'p'); await f.keep(session.sessionId)
    const first = prepareOpenMontageAgentMessage(f.services, session, () => 'original prompt'), gate = deferred<void>(), cancel = new AbortController()
    f.send.mockReturnValueOnce(gate.promise)
    const waiting = sendOpenMontageAgentMessage(f.services, session, first.prompt, {requestId: first.requestId, signal: cancel.signal}).catch(error => error as Error)
    cancel.abort(); expect(await waiting).toMatchObject({name: 'AbortError'}); gate.resolve(); await flush()
    const replacementServices = {...f.services}, restored = await ensureOpenMontageAgentSession(replacementServices, 't', 'p'), newPrompt = vi.fn(() => 'new prompt')
    const retry = prepareOpenMontageAgentMessage(replacementServices, restored, newPrompt)
    expect(retry).toBe(first); expect(newPrompt).not.toHaveBeenCalled()
    const receipt = await sendOpenMontageAgentMessage(replacementServices, restored, retry.prompt, {requestId: retry.requestId})
    expect(f.send).toHaveBeenCalledOnce(); expect(prepareOpenMontageAgentMessage(f.services, restored, newPrompt)).toBe(first)
    expect(acknowledgeOpenMontageAgentMessage(replacementServices, restored, {...receipt, requestId: 'another'})).toBe(false)
    expect(acknowledgeOpenMontageAgentMessage(replacementServices, restored, receipt)).toBe(true)
    const next = prepareOpenMontageAgentMessage(f.services, restored, newPrompt)
    expect(next.requestId).not.toBe(first.requestId); expect(next.prompt).toBe('new prompt'); expect(f.send).toHaveBeenCalledOnce()
  })
  it('isolates unresolved intent by host, track and project and refuses silently moving it to a replacement session', async () => {
    const f = fixture(), a = await ensureOpenMontageAgentSession(f.services, 't', 'p'), b = await ensureOpenMontageAgentSession(f.services, 't', 'q'), c = await ensureOpenMontageAgentSession(f.services, 'u', 'p')
    const requests = [a, b, c].map((session, index) => prepareOpenMontageAgentMessage(f.services, session, () => 'prompt-' + index))
    const g = fixture(), other = await ensureOpenMontageAgentSession(g.services, 't', 'p'), independent = prepareOpenMontageAgentMessage(g.services, other, () => 'other host')
    expect(new Set([...requests.map(request => request.requestId), independent.requestId]).size).toBe(4)
    expect(prepareOpenMontageAgentMessage(f.services, a, () => 'changed')).toBe(requests[0]); expect(f.send).not.toHaveBeenCalled(); expect(g.send).not.toHaveBeenCalled()
    expect(() => prepareOpenMontageAgentMessage(f.services, {...a, sessionId: 'replacement'}, () => 'changed')).toThrow('接受状态尚未确认')
  })
  it('fails loudly for missing native scope/Conversation/retain, forged project binding or missing capabilities without a model fallback', async () => {
    const f = fixture(), session = await ensureOpenMontageAgentSession(f.services, 't', 'p')
    await expect(sendOpenMontageAgentMessage(f.services, session, 'text', {requestId: 'a'})).rejects.toThrow('未保留')
    f.services.sessions.scope = undefined; await expect(sendOpenMontageAgentMessage(f.services, session, 'text', {requestId: 'a'})).rejects.toThrow('发送能力')
    f.services.sessions.scope = () => ({get: () => undefined}); await expect(sendOpenMontageAgentMessage(f.services, session, 'text', {requestId: 'a'})).rejects.toThrow('Conversation')
    await expect(sendOpenMontageAgentMessage(f.services, {...session, projectId: 'unprepared'}, 'text', {requestId: 'a'})).rejects.toThrow('尚未就绪')
    f.services.sessions.retain = undefined; await expect(openOpenMontageProjectDrawer(f.services, session, {onKeepSession: f.keep})).rejects.toThrow('保留或导航能力')
    const malformed = {...f.services, sessions: {...f.services.sessions, create: undefined}} as unknown as TrackAgentServices
    await expect(ensureOpenMontageAgentSession(malformed, 't', 'p')).rejects.toThrow('会话能力'); expect(f.events).toEqual([]); expect(f.send).not.toHaveBeenCalled()
  })
  it('does not claim to open an Agent drawer when the shell lacks its native left surface', async () => {
    const f = fixture({drawer: false}), session = await ensureOpenMontageAgentSession(f.services, 't', 'p')
    await expect(openOpenMontageProjectDrawer(f.services, session, {onKeepSession: f.keep})).rejects.toThrow('抽屉')
    expect(f.retain).not.toHaveBeenCalled(); expect(f.events).toEqual([]); expect(f.send).not.toHaveBeenCalled()
  })
})
