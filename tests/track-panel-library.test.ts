// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {TrackRecord, TrackSummary} from '../src/protocol.ts'
import {TrackPanel} from '../src/client/TrackPanel.tsx'

const mocks = vi.hoisted(() => ({
  list: [] as TrackSummary[], open: null as TrackRecord | null,
  openTrack: vi.fn(), closeTrack: vi.fn(), refresh: vi.fn(), toggle: vi.fn(),
}))
vi.mock('../src/client/useTracks.ts', () => ({useTracks: () => ({
  list: mocks.list, open: mocks.open, error: '', note: '', refresh: mocks.refresh,
  openTrack: mocks.openTrack, closeTrack: mocks.closeTrack, clearError: vi.fn(),
  importFiles: vi.fn(), remove: vi.fn(), saveEdited: vi.fn(),
})}))
vi.mock('../src/client/map-settings.tsx', () => ({
  MapSettingsProvider: ({children}: {children: unknown}) => children,
  useMapSettings: () => ({settings: {basemap: 'none'}, updateSettings: vi.fn(), openSettings: vi.fn()}),
}))
vi.mock('../src/client/useTrackAgentDrawer.ts', () => ({useTrackAgentDrawer: () => ({
  available: true, busy: false, open: false, error: '', toggle: mocks.toggle,
})}))
vi.mock('../src/client/track-agent-projects.ts', () => ({
  TrackAgentProjectRetentions: class {releaseAll() {} async retain() {}},
}))
vi.mock('../src/client/ImageAgentActions.tsx', async () => {
  const {createContext} = await import('react')
  return {ImageAgentContext: createContext(null)}
})
vi.mock('../src/client/TrackEditor.tsx', () => ({TrackEditor: () => null}))
vi.mock('../src/client/TrackOverview.tsx', () => ({TrackOverview: () => null}))
vi.mock('../src/client/TrackVideoScript.tsx', () => ({TrackVideoScript: () => null}))
vi.mock('../src/client/ResourceLibrary.tsx', () => ({ResourceLibrary: () => null}))
vi.mock('../src/client/ResourceImageWorkspace.tsx', () => ({ResourceImageWorkspace: () => null}))
vi.mock('../src/client/ResourceImageHistory.tsx', () => ({ResourceImageHistory: () => null}))
vi.mock('../src/client/ResourceUseDialog.tsx', () => ({ResourceUseDialog: () => null}))
vi.mock('../src/client/AnimationStudio.tsx', () => ({
  AnimationStudio: ({track, onCancel}: {track: TrackRecord; onCancel: () => void}) =>
    createElement('section', {'aria-label': '动画录制工作区'}, track.name,
      createElement('button', {onClick: onCancel}, '返回轨迹总览')),
}))

function record(id: string, name: string, filename: string, createdAt: string, distance: number, elevationGain: number): TrackRecord {
  return {id, name, filename, format: 'gpx', createdAt, bytes: 100, points: 2,
    coordinates: [[114, 27, 100, null], [114.1, 27.1, 200, null]],
    metrics: {distance, elevationGain, elevationLoss: 100, duration: 3600, elevationMin: 100, elevationMax: 200, bbox: null}}
}
const routes = [
  record('wugong', '武功山反穿', 'wugongshan.kml', '2026-10-01T00:00:00Z', 23000, 1000),
  record('ridge', '阴条岭', 'cloud-ridge.gpx', '2026-10-09T00:00:00Z', 12000, 2400),
  record('city', '城郊环线', 'city-loop.tcx', '2026-10-05T00:00:00Z', 8000, 500),
]
let container: HTMLDivElement, root: Root
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
function visibleRoutes() {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-label^="打开轨迹："]')]
    .map(node => node.getAttribute('aria-label')!.slice('打开轨迹：'.length))
}
async function render() {await act(async () => root.render(createElement(TrackPanel)))}
async function click(label: string) {await act(async () => button(label).click())}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}
async function sort(value: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="轨迹排序"]')!
  await act(async () => {select.value = value; select.dispatchEvent(new Event('change', {bubbles: true}))})
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {callback(0); return 1})
  mocks.list = Object.freeze([...routes]) as unknown as TrackSummary[]; mocks.open = null
  mocks.toggle.mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals()
})

describe('track library navigation', () => {
  it('searches route names and filenames while keeping the original collection intact', async () => {
    await render(); await search('武功山')
    expect(visibleRoutes()).toEqual(['武功山反穿'])
    await search('CLOUD-RIDGE.GPX'); expect(visibleRoutes()).toEqual(['阴条岭'])
    expect(mocks.list.map(track => track.id)).toEqual(['wugong', 'ridge', 'city'])
    expect(mocks.openTrack).not.toHaveBeenCalled()
  })
  it('sorts by recent import, distance and climb without sorting the source array', async () => {
    await render(); expect(visibleRoutes()).toEqual(['阴条岭', '城郊环线', '武功山反穿'])
    await sort('distance'); expect(visibleRoutes()).toEqual(['武功山反穿', '阴条岭', '城郊环线'])
    await sort('climb'); expect(visibleRoutes()).toEqual(['阴条岭', '武功山反穿', '城郊环线'])
    await sort('recent'); expect(visibleRoutes()).toEqual(['阴条岭', '城郊环线', '武功山反穿'])
    expect(mocks.list.map(track => track.id)).toEqual(['wugong', 'ridge', 'city'])
  })
  it('clears an empty search result and restores the route list', async () => {
    await render(); await search('不存在的路线')
    expect(visibleRoutes()).toEqual([]); expect(container.textContent).toContain('没有找到匹配的轨迹')
    await click('清空搜索')
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('')
    expect(visibleRoutes()).toEqual(['阴条岭', '城郊环线', '武功山反穿'])
  })
  it('keeps the native DSH Agent button connected to its drawer toggle', async () => {
    await render(); const agent = button('Agent')
    expect(agent.disabled).toBe(false)
    expect(agent.getAttribute('aria-controls')).toBe('desktop-agent-drawer')
    expect(agent.getAttribute('aria-pressed')).toBe('false')
    await click('Agent'); expect(mocks.toggle).toHaveBeenCalledOnce()
  })
  it('closes More with Escape, restores summary focus and keeps animation recording reachable', async () => {
    mocks.open = routes[0]; await render()
    const summary = [...container.querySelectorAll<HTMLElement>('summary')].find(node => node.textContent === '更多操作')!
    const menu = summary.closest('details')!
    await act(async () => summary.click()); expect(menu.open).toBe(true)
    const animation = button('轨迹动画录制'); animation.focus()
    const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
    await act(async () => animation.dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true); expect(menu.open).toBe(false)
    expect(document.activeElement).toBe(summary)
    await act(async () => summary.click()); await click('轨迹动画录制')
    expect(container.querySelector('[aria-label="动画录制工作区"]')?.textContent).toContain('武功山反穿')
    expect(menu.open).toBe(false)
    await click('返回轨迹总览'); expect(container.querySelector('[aria-label="动画录制工作区"]')).toBeNull()
    expect(container.querySelector('summary')?.textContent).toBe('更多操作')
  })
})
