// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TrackRecord, TrackSummary } from '../src/protocol.ts'
import type { TracksState } from '../src/client/useTracks.ts'
import { TrackPanel } from '../src/client/TrackPanel.tsx'
import { apply } from '../src/client/index.tsx'
import { ensureTrackAgentSession, type TrackAgentServices } from '../src/client/track-agent-session.ts'
import { TRACK_AGENT_CAPABILITIES_EVENT, TRACK_AGENT_DRAWER_EVENT, trackAgentDrawerAvailable, useTrackAgentDrawer } from '../src/client/useTrackAgentDrawer.ts'
import { editedMetrics } from '../src/track/edit.ts'

const fakeTracks = vi.hoisted(() => ({ current: null as unknown as TracksState }))
vi.mock('../src/client/util.ts', async importOriginal => ({...await importOriginal<typeof import('../src/client/util.ts')>(), api: vi.fn(async () => ({}))}))
vi.mock('../src/client/useTracks.ts', () => ({ useTracks: () => fakeTracks.current }))
vi.mock('../src/client/track-agent-session.ts', () => ({ ensureTrackAgentSession: vi.fn() }))
vi.mock('../src/client/TrackOverview.tsx', () => ({ TrackOverview: () => null }))
vi.mock('../src/client/TrackEditor.tsx', () => ({ TrackEditor: () => null }))
vi.mock('../src/client/TrackArt.tsx', () => ({ TrackArt: () => null }))
vi.mock('../src/client/AnimationStudio.tsx', () => ({ AnimationStudio: () => null }))

const coordinates: TrackRecord['coordinates'] = [[120, 30, null, null], [120.01, 30, null, null]]
const tracks: TrackRecord[] = ['峨眉山', '武功山反穿'].map((name, index) => ({
  id: `track-${index}`, name, filename: `${name}.kml`, format: 'kml', createdAt: '2026-10-01',
  coordinates, bytes: 100, points: coordinates.length, metrics: editedMetrics(coordinates),
}))
interface DrawerRequest { open: boolean; panelId: string; entityId?: string; requestId?: string; title?: string; side?: string; mode?: string; summary?: {items: {label: string; value: string}[]} }
let node: HTMLDivElement, root: Root | undefined, state: ReturnType<typeof useTrackAgentDrawer>
let services: TrackAgentServices, events: DrawerRequest[], stopListeners: (() => void)[]
const ensureSession = vi.mocked(ensureTrackAgentSession)

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function session(trackId: string | null = 'track-0') { const scope = trackId ?? 'track-library'; return {sessionId: scope + '-session', workspaceId: scope + '-workspace'} }
function capability(sides: readonly string[] = ['left', 'right']) {
  const listener = (event: Event) => (event as CustomEvent<{ accept: (value: { sides: readonly string[] }) => void }>).detail.accept({ sides })
  window.addEventListener(TRACK_AGENT_CAPABILITIES_EVENT, listener)
  stopListeners.push(() => window.removeEventListener(TRACK_AGENT_CAPABILITIES_EVENT, listener))
}
function Hook({ track, page }: { track: TrackSummary | null; page?: Parameters<typeof useTrackAgentDrawer>[0]['page'] }) {
  state = useTrackAgentDrawer({page: page ?? (track ? 'overview' : 'library'), track, trackCount: fakeTracks.current.list.length, library: fakeTracks.current.list}, () => services)
  return null
}
async function renderHook(track: TrackSummary | null = tracks[0], page?: Parameters<typeof useTrackAgentDrawer>[0]['page']) {
  await act(async () => { root!.render(createElement(Hook, { track, page })) })
}
async function startToggle() {
  let opening!: Promise<void>
  await act(async () => { opening = state.toggle() })
  return { opening }
}
function opens() { return events.filter(event => event.open) }
async function dispatchClose(detail: Partial<DrawerRequest>) {
  await act(async () => { window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, { detail: { open: false, panelId: 'cqai-track', ...detail } })) })
}
function button(text: string) { return [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text) }
async function click(element: HTMLElement) { await act(async () => { element.click() }) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  stopListeners = []; events = []
  services = {
    sessions: {},
    uiWorkspace: { openSession: vi.fn() }, layout: { selectPanel: vi.fn() }, api: vi.fn(async () => ({})),
  } as unknown as TrackAgentServices
  ensureSession.mockImplementation(async (value, _signal, trackId) => {
    const result = session(trackId)
    value.uiWorkspace.openSession(result.sessionId)
    value.layout.selectPanel('cqai-track')
    return result
  })
  fakeTracks.current = {
    list: tracks, open: tracks[0], error: '', note: '', clearError: vi.fn(), refresh: vi.fn(),
    openTrack: vi.fn(), closeTrack: vi.fn(), importFiles: vi.fn(), saveEdited: vi.fn(), remove: vi.fn(),
  } as unknown as TracksState
  const listener = (event: Event) => events.push((event as CustomEvent<DrawerRequest>).detail)
  window.addEventListener(TRACK_AGENT_DRAWER_EVENT, listener)
  stopListeners.push(() => window.removeEventListener(TRACK_AGENT_DRAWER_EVENT, listener))
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined; node.remove()
  for (const stop of stopListeners) stop()
  vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear()
})

describe('left Agent capability and selected project scope', () => {
  it('requires an explicit left-side capability', async () => {
    expect(trackAgentDrawerAvailable()).toBe(false)
    capability(['right'])
    expect(trackAgentDrawerAvailable()).toBe(false)
    capability()
    await renderHook()
    expect(state.available).toBe(true)
  })
  it('retries after the owning shell installs its listener', async () => {
    vi.useFakeTimers()
    await renderHook()
    expect(state.available).toBe(false)
    capability()
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(state.available).toBe(true)
  })
  it('prepares a native Session and context before requesting the simple left drawer', async () => {
    capability()
    const sequence: string[] = []
    vi.mocked(services.uiWorkspace.openSession).mockImplementation(() => { sequence.push('open-session') })
    const opened = (event: Event) => { if ((event as CustomEvent<DrawerRequest>).detail.open) sequence.push('open-drawer') }
    window.addEventListener(TRACK_AGENT_DRAWER_EVENT, opened)
    stopListeners.push(() => window.removeEventListener(TRACK_AGENT_DRAWER_EVENT, opened))
    await renderHook()
    await act(async () => { await state.toggle() })
    expect(ensureSession).toHaveBeenCalledWith(services, expect.any(AbortSignal), tracks[0].id)
    expect(services.api).toHaveBeenCalledWith('agent-context', {page: 'overview', trackId: 'track-0'})
    expect(sequence).toEqual(['open-session', 'open-drawer'])
    expect(opens()).toEqual([expect.objectContaining({
      open: true, panelId: 'cqai-track', entityId: tracks[0].id, side: 'left', mode: 'simple', title: 'Agent · 轨迹助手', requestId: expect.any(String),
    })])
    expect(state.open).toBe(true)
    expect(state.busy).toBe(false)
    await act(async () => { await state.toggle() })
    expect(events.at(-1)).toEqual({...opens()[0], open: false})
    expect(state.open).toBe(false)
  })
  it('opens from an empty library and requires a compatible shell', async () => {
    capability()
    fakeTracks.current.list = []
    await renderHook(null)
    await act(async () => { await state.toggle() })
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(opens()[0].summary?.items).toEqual([
      {label: '轨迹库', value: '0 条轨迹'}, {label: '当前页面', value: '轨迹列表'}, {label: '当前线路', value: '未选择线路'}, {label: '轨迹编号', value: '未选择线路'},
    ])
    await act(async () => { state.close() })
    for (const stop of stopListeners) stop()
    stopListeners = []
    await renderHook()
    await act(async () => { await state.toggle() })
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(state.error).toContain('当前布局暂不支持左侧 Agent')
  })
})

describe('drawer lifetime and context races', () => {
  it('cancels the previous project opener and opens only the selected route', async () => {
    capability()
    const wait = deferred<ReturnType<typeof session>>()
    ensureSession.mockReturnValueOnce(wait.promise)
    await renderHook()
    const {opening} = await startToggle()
    const signal = ensureSession.mock.calls[0][1]!
    await renderHook(tracks[1])
    expect(signal.aborted).toBe(true)
    expect(ensureSession.mock.calls.map(call => call[2])).toEqual(['track-0','track-1'])
    await act(async () => { wait.resolve(session()); await opening })
    expect(opens()).toHaveLength(1)
    expect(opens()[0]).toMatchObject({entityId:'track-1'})
    expect(opens()[0].summary?.items).toContainEqual({label: '当前线路', value: '武功山反穿'})
    expect(opens()[0].summary?.items).toContainEqual({label: '轨迹编号', value: 'track-1'})
    expect(services.api).toHaveBeenCalledWith('agent-context', {page: 'overview', trackId: 'track-1'})
    expect(services.api).not.toHaveBeenCalledWith('agent-context', {page: 'overview', trackId: 'track-0'})
    expect(state.open).toBe(true)
  })
  it('switches native projects on A to B to A and uses the library project on return', async () => {
    capability()
    await renderHook()
    await act(async () => { await state.toggle() })
    const first = opens()[0]
    await renderHook(tracks[1])
    const second = opens().at(-1)!
    expect(events).toContainEqual({...first,open:false})
    expect(second.entityId).toBe('track-1');expect(second.requestId).not.toBe(first.requestId)
    await renderHook(tracks[0])
    expect(opens().at(-1)?.entityId).toBe('track-0')
    await renderHook(null)
    expect(ensureSession.mock.calls.map(call=>call[2])).toEqual(['track-0','track-1','track-0',null])
    expect(vi.mocked(services.uiWorkspace.openSession).mock.calls.map(call=>call[0])).toEqual(['track-0-session','track-1-session','track-0-session','track-library-session'])
    expect(opens().at(-1)?.entityId).toBe('track-library')
    expect(opens().at(-1)?.summary?.items).toEqual([
      {label: '轨迹库', value: '2 条轨迹'}, {label: '当前页面', value: '轨迹列表'}, {label: '当前线路', value: '未选择线路'}, {label: '轨迹编号', value: '未选择线路'},
    ])
    expect(services.api).toHaveBeenLastCalledWith('agent-context', {page: 'library', trackId: null})
  })
  it('stays closed when changing routes without an active or pending drawer', async () => {
    capability();await renderHook();await renderHook(tracks[1]);await renderHook(null)
    expect(ensureSession).not.toHaveBeenCalled();expect(opens()).toHaveLength(0)
  })
  it('leaves the previous project closed when the new project fails and retries the current one', async () => {
    capability();await renderHook();await act(async()=>{await state.toggle()})
    ensureSession.mockRejectedValueOnce(new Error('new project unavailable'))
    await renderHook(tracks[1])
    expect(state.open).toBe(false);expect(state.error).toBe('new project unavailable')
    expect(opens().at(-1)?.entityId).toBe('track-0')
    await act(async()=>{await state.toggle()})
    expect(state.open).toBe(true);expect(opens().at(-1)?.entityId).toBe('track-1')
  })
  it('refreshes the workspace snapshot when library metadata changes without a count change', async () => {
    capability()
    await renderHook(null)
    await act(async () => { await state.toggle() })
    fakeTracks.current.list = fakeTracks.current.list.map(track => ({...track, name: track.name + '新版'}))
    await renderHook(null)
    expect(services.api).toHaveBeenCalledTimes(2)
    expect(services.api).toHaveBeenLastCalledWith('agent-context', {page: 'library', trackId: null})
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(events.every(event => event.open)).toBe(true)
  })
  it('serializes context in one project while a slow A write does not block opening B', async () => {
    capability();await renderHook();await act(async () => { await state.toggle() })
    const wait = deferred<unknown>()
    vi.mocked(services.api!).mockReturnValueOnce(wait.promise)
    await renderHook(tracks[0],'animation')
    await renderHook(tracks[0],'edit')
    // Both writes belong to A; its second write waits for the first.
    expect(services.api).toHaveBeenCalledTimes(2)
    expect(ensureSession).toHaveBeenCalledTimes(1)
    await renderHook(tracks[1])
    expect(state.open).toBe(true);expect(opens().at(-1)?.entityId).toBe('track-1')
    expect(services.api).toHaveBeenLastCalledWith('agent-context',{page:'overview',trackId:'track-1'})
    expect(services.api).toHaveBeenCalledTimes(3)
    await act(async () => {wait.resolve({});await wait.promise})
    expect(vi.mocked(services.api!).mock.calls.map(call=>call[1])).toEqual([
      {page:'overview',trackId:'track-0'}, {page:'animation',trackId:'track-0'},
      {page:'overview',trackId:'track-1'}, {page:'edit',trackId:'track-0'},
    ])
    expect(state.open).toBe(true);expect(opens().at(-1)?.entityId).toBe('track-1')
    expect(opens().at(-1)?.summary?.items).toContainEqual({label:'当前线路',value:'武功山反穿'})
  })
  it('reports same-project context failure while preserving its drawer and recovers on refresh', async () => {
    capability()
    await renderHook()
    await act(async () => { await state.toggle() })
    vi.mocked(services.api!).mockRejectedValueOnce(new Error('context unavailable'))
    await renderHook({...tracks[0],name:'峨眉山更新'})
    expect(state.open).toBe(true)
    expect(state.error).toBe('context unavailable')
    await renderHook({...tracks[0],name:'峨眉山再更新'})
    expect(state.open).toBe(true)
    expect(state.error).toBe('')
  })
  it('cancels pending preparation on explicit close and suppresses late errors', async () => {
    capability()
    const wait = deferred<ReturnType<typeof session>>()
    ensureSession.mockReturnValueOnce(wait.promise)
    await renderHook()
    const {opening} = await startToggle()
    const signal = ensureSession.mock.calls[0][1]!
    await act(async () => { state.close() })
    expect(signal.aborted).toBe(true)
    await act(async () => { wait.reject(new Error('late failure')); await opening })
    expect(opens()).toHaveLength(0)
    expect(state.error).toBe('')
    expect(state.busy).toBe(false)
  })
  it('cancels on unmount and emits a matching close for an open drawer', async () => {
    capability()
    const wait = deferred<ReturnType<typeof session>>()
    ensureSession.mockReturnValueOnce(wait.promise)
    await renderHook()
    const {opening} = await startToggle()
    const signal = ensureSession.mock.calls[0][1]!
    await act(async () => { root!.unmount() }); root = undefined
    expect(signal.aborted).toBe(true)
    await act(async () => { wait.resolve(session()); await opening })
    expect(opens()).toHaveLength(0)
    root = createRoot(node)
    await renderHook()
    await act(async () => { await state.toggle() })
    const opened = opens()[0]
    await act(async () => { root!.unmount() }); root = undefined
    expect(events.at(-1)).toEqual({...opened, open: false})
  })
  it('ignores foreign and stale closes after reopening the fixed drawer', async () => {
    capability()
    await renderHook()
    await act(async () => { await state.toggle() })
    const previous = opens()[0]
    await act(async () => { state.close() })
    await act(async () => { await state.toggle() })
    const current = opens()[1]
    await dispatchClose({requestId: previous.requestId})
    await dispatchClose({panelId: 'other', requestId: current.requestId})
    await dispatchClose({entityId: 'track-1', requestId: current.requestId})
    expect(state.open).toBe(true)
    await dispatchClose({entityId: current.entityId, requestId: current.requestId})
    expect(state.open).toBe(false)
  })
  it('surfaces preparation failures and lets the user retry', async () => {
    capability()
    ensureSession.mockRejectedValueOnce(new Error('session unavailable'))
    await renderHook()
    await act(async () => { await state.toggle() })
    expect(state.error).toBe('session unavailable')
    expect(state.open).toBe(false)
    await act(async () => { await state.toggle() })
    expect(state.error).toBe('')
    expect(state.open).toBe(true)
  })
})

describe('real TrackPanel and slot entry wiring', () => {
  it('keeps the same drawer through editing and publishes the current page', async () => {
    capability()
    await act(async () => { root!.render(createElement<NonNullable<Parameters<typeof TrackPanel>[0]>>(TrackPanel, {getAgentServices: () => services})) })
    expect(button('Agent')?.disabled).toBe(false)
    expect(button('Agent')?.getAttribute('aria-controls')).toBe('desktop-agent-drawer')
    await click(button('Agent')!)
    await click(button('编辑当前轨迹')!)
    expect(button('收起 Agent')).toBeDefined()
    expect(opens()).toHaveLength(2)
    expect(opens()[1].requestId).toBe(opens()[0].requestId)
    expect(opens()[1].summary?.items).toContainEqual({label: '当前页面', value: '编辑线路'})
  })
  it('keeps the async opener focusable while busy and ignores repeated clicks', async () => {
    capability()
    const wait = deferred<ReturnType<typeof session>>()
    ensureSession.mockReturnValueOnce(wait.promise)
    await act(async () => { root!.render(createElement<NonNullable<Parameters<typeof TrackPanel>[0]>>(TrackPanel, {getAgentServices: () => services})) })
    const opener = button('Agent')!
    opener.focus()
    let focusedOnOpen: Element | null = null
    const captureFocus = (event: Event) => { if ((event as CustomEvent<DrawerRequest>).detail.open) focusedOnOpen = document.activeElement }
    window.addEventListener(TRACK_AGENT_DRAWER_EVENT, captureFocus)
    stopListeners.push(() => window.removeEventListener(TRACK_AGENT_DRAWER_EVENT, captureFocus))
    await act(async () => { opener.click(); opener.click() })
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(button('正在打开 Agent…')).toBe(opener)
    expect(opener.disabled).toBe(false)
    expect(opener.tabIndex).toBe(0)
    expect(opener.getAttribute('aria-disabled')).toBe('true')
    expect(opener.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(opener)
    await click(opener)
    expect(ensureSession).toHaveBeenCalledTimes(1)
    await act(async () => { wait.resolve(session()); await wait.promise })
    expect(focusedOnOpen).toBe(opener)
    expect(button('收起 Agent')).toBe(opener)
    expect(opener.hasAttribute('aria-disabled')).toBe(false)
    expect(opener.hasAttribute('aria-busy')).toBe(false)
    expect(opens()).toHaveLength(1)
  })
  it('opens on a new draft without inheriting the previous saved route', async () => {
    capability()
    await act(async () => { root!.render(createElement<NonNullable<Parameters<typeof TrackPanel>[0]>>(TrackPanel, {getAgentServices: () => services})) })
    await click(button('新建路线')!)
    expect(button('Agent')?.disabled).toBe(false)
    await click(button('Agent')!)
    expect(opens()[0].summary?.items).toContainEqual({label: '当前线路', value: '未保存路线'})
    expect(opens()[0].summary?.items).toContainEqual({label: '轨迹编号', value: '尚未保存'})
    expect(services.api).toHaveBeenCalledWith('agent-context', {page: 'new', trackId: null})
  })
  it('gets DSH services through the real slot registration', async () => {
    capability()
    let entry: (() => ReactElement) | undefined
    const sources = {sessions: {}, workspaces: {}, uiWorkspace: services.uiWorkspace, layout: services.layout}
    const ctx = {
      get: vi.fn((name: keyof typeof sources) => sources[name]),
      slots: {
        inject: vi.fn((_name: string, register: () => void) => register()),
        register: vi.fn((spec: {key?: string}, component: () => ReactElement) => { if (spec.key === 'cqai-track') entry = component }),
      },
    }
    apply(ctx as unknown as Context)
    expect(entry).toBeDefined()
    await act(async () => { root!.render(entry!()) })
    await click(button('Agent')!)
    expect(ensureSession).toHaveBeenCalledWith(sources, expect.any(AbortSignal), tracks[0].id)
    expect(opens()[0]).toMatchObject({panelId: 'cqai-track', entityId: tracks[0].id, side: 'left', mode: 'simple'})
  })
})
describe('visited project native Session ownership', () => {
  it('holds A and B scopes across selection and drawer closes, deduplicates A and releases all on unmount', async () => {
    capability()
    const references = new Map<string,{sessionId:string;ready:Promise<unknown>;release:ReturnType<typeof vi.fn>}>()
    const retain=vi.fn((id:string)=>{const reference={sessionId:id,ready:Promise.resolve(),release:vi.fn()};references.set(id,reference);return reference})
    services.sessions.retain=retain
    await renderHook();await act(async()=>{await state.show()})
    await act(async()=>{await state.show()})
    await renderHook(tracks[1]);await renderHook(tracks[0])
    expect(retain.mock.calls).toEqual([['track-0-session',{source:'trackPanel'}],['track-1-session',{source:'trackPanel'}]])
    for(const reference of references.values())expect(reference.release).not.toHaveBeenCalled()
    await act(async()=>{state.close()})
    for(const reference of references.values())expect(reference.release).not.toHaveBeenCalled()
    await act(async()=>{root!.unmount()});root=undefined
    for(const reference of references.values())expect(reference.release).toHaveBeenCalledTimes(1)
  })
  it('cancels waiting for native readiness without discarding that project or opening a stale drawer', async () => {
    capability();const wait=deferred<unknown>(),release=vi.fn()
    const retain=vi.fn((id:string)=>({sessionId:id,ready:wait.promise,release}))
    services.sessions.retain=retain
    await renderHook();const {opening}=await startToggle()
    expect(retain).toHaveBeenCalledTimes(1);expect(services.api).not.toHaveBeenCalled()
    await act(async()=>{state.close();await opening})
    expect(state.busy).toBe(false);expect(opens()).toHaveLength(0);expect(release).not.toHaveBeenCalled()
    await act(async()=>{wait.resolve({});await wait.promise;await state.show()})
    expect(retain).toHaveBeenCalledTimes(1);expect(state.open).toBe(true)
    await act(async()=>{root!.unmount()});root=undefined
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('releases a failed native open and creates a fresh holder on retry', async () => {
    capability();const failedRelease=vi.fn(),nextRelease=vi.fn()
    services.sessions.retain=vi.fn().mockImplementationOnce((id:string)=>({sessionId:id,ready:Promise.reject(new Error('native open failed')),release:failedRelease}))
      .mockImplementationOnce((id:string)=>({sessionId:id,ready:Promise.resolve(),release:nextRelease}))
    await renderHook();await act(async()=>{await state.show()})
    expect(state.open).toBe(false);expect(state.error).toBe('native open failed');expect(failedRelease).toHaveBeenCalledTimes(1)
    await act(async()=>{await state.show()})
    expect(state.open).toBe(true);expect(state.error).toBe('');expect(services.sessions.retain).toHaveBeenCalledTimes(2)
    await act(async()=>{root!.unmount()});root=undefined
    expect(failedRelease).toHaveBeenCalledTimes(1);expect(nextRelease).toHaveBeenCalledTimes(1)
  })
})
