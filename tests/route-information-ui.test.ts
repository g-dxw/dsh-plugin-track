// @vitest-environment jsdom
import {act, createElement, useState, type ReactNode} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {TrackRecord} from '../src/protocol.ts'
import {editedMetrics} from '../src/track/edit.ts'
import {RouteInformation} from '../src/client/RouteInformation.tsx'
import {TrackPanel} from '../src/client/TrackPanel.tsx'
import {openRouteInformationWorkspace} from '../src/client/route-information-workspace.ts'
import type {TrackAgentServices, TrackAgentSession} from '../src/client/track-agent-session.ts'

const state = vi.hoisted(() => ({track: null as TrackRecord | null, closeDrawer: vi.fn()}))
vi.mock('../src/client/route-information-workspace.ts', () => ({openRouteInformationWorkspace: vi.fn()}))
vi.mock('../src/client/useTracks.ts', () => ({useTracks: () => ({open: state.track, list: state.track ? [state.track] : [], error: '', note: '', refresh: vi.fn(), closeTrack: vi.fn(), clearError: vi.fn(), saveEdited: vi.fn()})}))
vi.mock('../src/client/map-settings.tsx', () => ({MapSettingsProvider: ({children}: {children: ReactNode}) => children, useMapSettings: () => ({settings: {basemap: 'none'}, updateSettings: vi.fn(), openSettings: vi.fn()})}))
vi.mock('../src/client/useTrackAgentDrawer.ts', () => ({useTrackAgentDrawer: () => ({available: false, open: false, busy: false, error: '', toggle: vi.fn(), close: state.closeDrawer})}))
vi.mock('../src/client/TrackOverview.tsx', () => ({TrackOverview: function Overview() {
  const [selected, setSelected] = useState(false)
  return createElement('div', {'data-testid': 'track-overview'}, createElement('button', {onClick: () => setSelected(true)}, '选择总览点位'), selected ? '已选中的点位' : '当前轨迹总览')
}}))
vi.mock('../src/client/TrackEditor.tsx', () => ({TrackEditor: () => null}))
vi.mock('../src/client/AnimationStudio.tsx', () => ({AnimationStudio: () => null}))
vi.mock('../src/client/TrackVideoScript.tsx', () => ({TrackVideoScript: () => null}))

const coordinates: TrackRecord['coordinates'] = [[114,27,100,null], [114.01,27.01,200,null], [114.02,27.02,150,null]]
const track: TrackRecord = {id: 'route-information-a', name: '测试山地路线', filename: '路线A.kml', format: 'kml', createdAt: '2026-10-06T00:00:00.000Z', bytes: 100, points: coordinates.length, coordinates, segmentStarts: [0], metrics: editedMetrics(coordinates)}
const session: TrackAgentSession = {sessionId: 'route-session-a', workspaceId: 'route-workspace-a'}
function source<T>(snapshot: T) {return {getSnapshot: () => snapshot, subscribe: () => () => {}}}
function fixture(): TrackAgentServices {
  return {
    sessions: {list: source({phase: 'ready', ids: [], byId: {}}), refresh: vi.fn(async () => {}), create: vi.fn(async () => 'unused')},
    workspaces: {list: source({phase: 'ready', items: [], archivedSessionIds: []}), create: vi.fn(async () => ({workspaceId: 'unused'}))},
    uiWorkspace: {openSession: vi.fn()}, layout: {selectPanel: vi.fn()}, sidebarRight: {mounted: source<string | undefined>(undefined), openTab: vi.fn()},
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no})
  return {promise, resolve, reject}
}
let node: HTMLDivElement, root: Root, services: TrackAgentServices, onBack: ReturnType<typeof vi.fn<() => void>>, onPrepare: ReturnType<typeof vi.fn<() => void>>
function button(label: string) {
  const value = [...node.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === label || element.getAttribute('aria-label') === label)
  if (!value) throw new Error('Missing button: ' + label)
  return value
}
async function click(label: string) {await act(async () => button(label).click())}
async function render(current = track, host: TrackAgentServices | undefined = services) {
  await act(async () => root.render(createElement(RouteInformation, {key: current.id, track: current, onBack, onPrepare, getAgentServices: () => host})))
}
function openingSignal(index = 0) {return vi.mocked(openRouteInformationWorkspace).mock.calls[index][2]!}

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {callback(0); return 1})
  state.track = track; services = fixture(); onBack = vi.fn(); onPrepare = vi.fn()
  vi.mocked(openRouteInformationWorkspace).mockResolvedValue(session)
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()})

describe('route information native workspace handoff', () => {
  it('keeps the entry between editing and video and restores the same track overview when preparing is cancelled', async () => {
    const pending = deferred<TrackAgentSession>(); vi.mocked(openRouteInformationWorkspace).mockReturnValue(pending.promise)
    await act(async () => root.render(createElement<{getAgentServices: () => TrackAgentServices}>(TrackPanel, {getAgentServices: () => services})))
    await click('选择总览点位')
    const overview = node.querySelector('[data-testid="track-overview"]')!
    const labels = [...node.querySelectorAll<HTMLButtonElement>('.trk-detail-actions button')].map(element => element.textContent)
    const entryIndex = labels.indexOf('路线信息整理')
    expect(entryIndex).toBeGreaterThan(0)
    expect(labels[entryIndex - 1]).toBe('编辑当前轨迹')
    expect(labels[entryIndex + 1]).toBe('轨迹视频制作')
    await click('路线信息整理')
    expect(node.querySelector('[aria-label="路线信息整理"]')).not.toBeNull()
    expect(openRouteInformationWorkspace).toHaveBeenCalledWith(services, track.id, expect.any(AbortSignal), expect.any(Function))
    expect(state.closeDrawer).toHaveBeenCalledOnce()
    expect(overview.closest('[hidden]')).not.toBeNull()
    expect(node.querySelector('textarea, input[type=file]')).toBeNull()
    await click('← 返回轨迹详情')
    expect(openingSignal().aborted).toBe(true)
    expect(node.querySelector('[aria-label="路线信息整理"]')).toBeNull()
    expect(node.querySelector('[data-testid="track-overview"]')).toBe(overview)
    expect(overview.closest('[hidden]')).toBeNull()
    expect(overview.textContent).toContain('已选中的点位')
    await act(async () => pending.reject(new DOMException('cancelled', 'AbortError')))
  })

  it('automatically prepares the current route once, closes the old drawer before handoff and shows no local document editor', async () => {
    const pending = deferred<TrackAgentSession>(); vi.mocked(openRouteInformationWorkspace).mockReturnValue(pending.promise)
    await render()
    expect(onPrepare).toHaveBeenCalledOnce()
    expect(onPrepare.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openRouteInformationWorkspace).mock.invocationCallOrder[0])
    expect(openRouteInformationWorkspace).toHaveBeenCalledExactlyOnceWith(services, track.id, expect.any(AbortSignal), expect.any(Function))
    expect(node.textContent).toContain(track.name)
    expect(node.textContent).toContain('Agent 资料工作区')
    expect(node.querySelector('input, textarea, form')).toBeNull()
    expect(node.textContent).not.toContain('新建文档')
    const entering = button('正在打开 Agent 资料工作区…')
    expect(entering.disabled).toBe(true); expect(entering.getAttribute('aria-busy')).toBe('true')
    await act(async () => entering.click())
    expect(openRouteInformationWorkspace).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(session))
    expect(button('进入 Agent 资料工作区').disabled).toBe(false)
  })

  it('explains a missing native files service and allows returning without partial handoff', async () => {
    await render(track, {...services, sidebarRight: undefined})
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('桌面版')
    expect(openRouteInformationWorkspace).not.toHaveBeenCalled(); expect(onPrepare).not.toHaveBeenCalled()
    await click('进入 Agent 资料工作区')
    expect(openRouteInformationWorkspace).not.toHaveBeenCalled()
    await click('← 返回轨迹详情')
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('explains an unavailable host reader without trying to create a local document form', async () => {
    await act(async () => root.render(createElement(RouteInformation, {track, onBack})))
    expect(node.querySelector('[role="alert"]')!.textContent).toContain('Agent 文件工作区')
    expect(openRouteInformationWorkspace).not.toHaveBeenCalled()
    expect(node.querySelector('input, textarea, form')).toBeNull()
  })

  it('shows an opening failure and retries the same route with a fresh cancellation signal', async () => {
    const retry = deferred<TrackAgentSession>()
    vi.mocked(openRouteInformationWorkspace).mockRejectedValueOnce(new Error('原生文件工作区尚未就绪')).mockReturnValueOnce(retry.promise)
    await render()
    expect(node.querySelector('[role="alert"]')!.textContent).toBe('原生文件工作区尚未就绪')
    const firstSignal = openingSignal()
    await click('进入 Agent 资料工作区')
    expect(node.querySelector('[role="alert"]')).toBeNull()
    expect(openRouteInformationWorkspace).toHaveBeenCalledTimes(2)
    expect(vi.mocked(openRouteInformationWorkspace).mock.calls[1].slice(0, 2)).toEqual([services, track.id])
    expect(openingSignal(1)).not.toBe(firstSignal)
    expect(openingSignal(1).aborted).toBe(false)
    expect(onPrepare).toHaveBeenCalledTimes(2)
    await act(async () => retry.resolve(session))
    expect(button('进入 Agent 资料工作区').disabled).toBe(false)
  })

  it('aborts a preparation when the user leaves the Track panel before native activation', async () => {
    const pending = deferred<TrackAgentSession>(); vi.mocked(openRouteInformationWorkspace).mockReturnValue(pending.promise)
    await render(); const signal = openingSignal()
    await act(async () => root.render(null))
    expect(signal.aborted).toBe(true)
    await act(async () => pending.reject(new DOMException('cancelled', 'AbortError')))
    expect(node.textContent).toBe('')
  })

  it('keeps the files-seat wait alive when native activation intentionally unmounts the Track panel', async () => {
    const pending = deferred<TrackAgentSession>(); vi.mocked(openRouteInformationWorkspace).mockReturnValue(pending.promise)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(); const signal = openingSignal()
    await act(async () => vi.mocked(openRouteInformationWorkspace).mock.calls[0][3]!())
    await act(async () => root.render(null))
    expect(signal.aborted).toBe(false)
    await act(async () => pending.resolve(session))
    expect(signal.aborted).toBe(false)
    expect(error).not.toHaveBeenCalled()
  })

  it('cancels the old route during a keyed route switch and ignores its late failure in the new route', async () => {
    const old = deferred<TrackAgentSession>(), current = deferred<TrackAgentSession>()
    const second = {...track, id: 'route-information-b', name: '另一条路线', filename: '路线B.kml'}
    vi.mocked(openRouteInformationWorkspace).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await render(); const oldSignal = openingSignal()
    await render(second)
    expect(oldSignal.aborted).toBe(true)
    expect(openRouteInformationWorkspace).toHaveBeenCalledTimes(2)
    expect(vi.mocked(openRouteInformationWorkspace).mock.calls[1].slice(0, 2)).toEqual([services, second.id])
    expect(openingSignal(1).aborted).toBe(false)
    await act(async () => old.reject(new Error('旧路线准备失败')))
    expect(node.querySelector('[role="alert"]')).toBeNull()
    expect(node.textContent).toContain(second.name)
    expect(node.textContent).not.toContain('旧路线准备失败')
    await act(async () => current.resolve({sessionId: 'route-session-b', workspaceId: 'route-workspace-b'}))
  })
})
