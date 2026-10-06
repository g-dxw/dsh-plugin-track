import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ensureTrackAgentSession, type TrackAgentServices, type TrackAgentSession} from '../src/client/track-agent-session.ts'
import {openRouteInformationWorkspace} from '../src/client/route-information-workspace.ts'

vi.mock('../src/client/track-agent-session.ts', async original => ({...await original<typeof import('../src/client/track-agent-session.ts')>(), ensureTrackAgentSession: vi.fn()}))

type MountedSession = ReturnType<NonNullable<TrackAgentServices['sidebarRight']>['mounted']['getSnapshot']>
function source<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {getSnapshot: () => snapshot, subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener)}},
    set(value: T) {snapshot = value; for (const listener of [...listeners]) listener()}, get subscriberCount() {return listeners.size}}
}
function fixture(initial: MountedSession = undefined) {
  const mounted = source<MountedSession>(initial)
  const api = vi.fn(async () => ({})), openedSessions: MountedSession[] = []
  const openTab = vi.fn((_kind: string) => {openedSessions.push(mounted.getSnapshot())})
  const composer = {input: {for: vi.fn(() => ({addAttachments: vi.fn(() => true)}))}, createDrafts: vi.fn(() => []), releaseDraftAttachments: vi.fn(), send: vi.fn()}
  const services: TrackAgentServices & {conversation: typeof composer} = {
    sessions: {list: source({phase: 'ready', ids: [], byId: {}}), refresh: vi.fn(async () => {}), create: vi.fn(async () => 'unused')},
    workspaces: {list: source({phase: 'ready', items: [], archivedSessionIds: []}), create: vi.fn(async () => ({workspaceId: 'unused'}))},
    uiWorkspace: {openSession: vi.fn()}, layout: {selectPanel: vi.fn()}, sidebarRight: {mounted, openTab}, conversation: composer,
    api: api as NonNullable<TrackAgentServices['api']>,
  }
  return {services, mounted, api, openTab, openedSessions, composer}
}
const session: TrackAgentSession = {sessionId: 'native-route-A', workspaceId: 'workspace-route-A'}
async function flush() {for (let count = 0; count < 15; count++) await Promise.resolve()}

beforeEach(() => {vi.resetAllMocks(); vi.mocked(ensureTrackAgentSession).mockResolvedValue(session)})
afterEach(() => {vi.useRealTimers()})

describe('native route information workspace', () => {
  it('updates route context before opening the native conversation and its files tab without sending anything', async () => {
    const f = fixture(session.sessionId)
    expect(await openRouteInformationWorkspace(f.services, 'route-A')).toEqual(session)
    expect(f.api.mock.calls).toEqual([['agent-context', {page: 'route-information', trackId: 'route-A'}]])
    expect(ensureTrackAgentSession).toHaveBeenCalledWith(f.services, undefined, 'route-A', expect.objectContaining({presentation: 'conversation'}))
    expect(f.api.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ensureTrackAgentSession).mock.invocationCallOrder[0])
    expect(f.openTab).toHaveBeenCalledExactlyOnceWith('files')
    expect(f.openedSessions).toEqual([session.sessionId])
    expect(f.services.layout.selectPanel).not.toHaveBeenCalled()
    expect(f.composer.input.for).not.toHaveBeenCalled(); expect(f.composer.createDrafts).not.toHaveBeenCalled(); expect(f.composer.send).not.toHaveBeenCalled()
    expect(f.mounted.subscriberCount).toBe(0)
  })

  it('waits until the right sidebar belongs to the exact route session and releases its listener', async () => {
    const f = fixture('another-session')
    const opening = openRouteInformationWorkspace(f.services, 'route-A')
    await flush()
    expect(f.openTab).not.toHaveBeenCalled()
    expect(f.mounted.subscriberCount).toBe(1)
    f.mounted.set('still-not-route-A'); await flush()
    expect(f.openTab).not.toHaveBeenCalled()
    f.mounted.set(session.sessionId)
    expect(await opening).toEqual(session)
    expect(f.openedSessions).toEqual([session.sessionId])
    expect(f.mounted.subscriberCount).toBe(0)
  })

  it('rejects an already-cancelled open before context changes, session navigation or file opening', async () => {
    const f = fixture(session.sessionId), cancellation = new AbortController(); cancellation.abort()
    await expect(openRouteInformationWorkspace(f.services, 'route-A', cancellation.signal)).rejects.toMatchObject({name: 'AbortError'})
    expect(f.api).not.toHaveBeenCalled(); expect(ensureTrackAgentSession).not.toHaveBeenCalled(); expect(f.openTab).not.toHaveBeenCalled()
  })

  it('cancels while waiting for the sidebar and ignores a later mount of the old route', async () => {
    const f = fixture(), cancellation = new AbortController()
    const opening = openRouteInformationWorkspace(f.services, 'route-A', cancellation.signal).catch(reason => reason as Error)
    await flush(); expect(f.mounted.subscriberCount).toBe(1)
    cancellation.abort()
    expect(await opening).toMatchObject({name: 'AbortError'})
    expect(f.mounted.subscriberCount).toBe(0)
    f.mounted.set(session.sessionId); await flush()
    expect(f.openTab).not.toHaveBeenCalled()
  })

  it('does not open the cancelled route files after a different route becomes active', async () => {
    const f = fixture(), cancellation = new AbortController()
    const second = {sessionId: 'native-route-B', workspaceId: 'workspace-route-B'}
    vi.mocked(ensureTrackAgentSession).mockResolvedValueOnce(session).mockResolvedValueOnce(second)
    const old = openRouteInformationWorkspace(f.services, 'route-A', cancellation.signal).catch(reason => reason as Error)
    await flush(); cancellation.abort()
    const current = openRouteInformationWorkspace(f.services, 'route-B')
    await flush(); f.mounted.set(second.sessionId)
    expect(await current).toEqual(second)
    expect(await old).toMatchObject({name: 'AbortError'})
    f.mounted.set(session.sessionId); await flush()
    expect(f.openedSessions).toEqual([second.sessionId])
    expect(f.api.mock.calls).toEqual([['agent-context', {page: 'route-information', trackId: 'route-A'}], ['agent-context', {page: 'route-information', trackId: 'route-B'}]])
    expect(f.mounted.subscriberCount).toBe(0)
  })

  it('times out a missing sidebar mount without opening a different session or leaving a listener', async () => {
    vi.useFakeTimers()
    const f = fixture('another-session')
    const opening = openRouteInformationWorkspace(f.services, 'route-A').catch(reason => reason as Error)
    await flush(); await vi.advanceTimersByTimeAsync(8000)
    expect(await opening).toBeInstanceOf(Error)
    expect(f.openTab).not.toHaveBeenCalled()
    expect(f.mounted.subscriberCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps navigation unchanged when updating the Agent context fails', async () => {
    const f = fixture(session.sessionId)
    f.api.mockRejectedValueOnce(new Error('轨迹上下文写入失败'))
    await expect(openRouteInformationWorkspace(f.services, 'route-A')).rejects.toThrow('轨迹上下文写入失败')
    expect(ensureTrackAgentSession).not.toHaveBeenCalled(); expect(f.openTab).not.toHaveBeenCalled()
    expect(f.mounted.subscriberCount).toBe(0)
  })

  it('reports unavailable native file browsing without navigating to a partially prepared workspace', async () => {
    const f = fixture(session.sessionId)
    await expect(openRouteInformationWorkspace({...f.services, sidebarRight: undefined}, 'route-A')).rejects.toBeInstanceOf(Error)
    expect(ensureTrackAgentSession).not.toHaveBeenCalled()
    expect(f.openTab).not.toHaveBeenCalled()
  })
})
