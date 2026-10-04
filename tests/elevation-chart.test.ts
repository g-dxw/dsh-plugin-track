// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElevationChart } from '../src/client/ElevationChart.tsx'
import type { Chart, Plugin } from 'chart.js'
import type { ElevationProfileOptions } from '../src/track/vendor/elevation-profile/elevationprofile.ts'
import type { TrackPoint, TrackPlacemark } from '../src/protocol.ts'

type Mode = 'success' | 'constructor-failure' | 'data-failure' | 'pending'
type FakeAxis = {min: number; max: number; ticks: {color?: string; font: {family: string; size?: number}}; grid: {color?: string; tickColor?: string}; border: {color?: string}}
type FakeChart = {
  canvas: HTMLCanvasElement
  width: number; height: number
  chartArea: {left: number; right: number; top: number; bottom: number}
  config: {plugins: Plugin<'line'>[]}
  scales: {x: {min: number; max: number; getPixelForValue: (value: number) => number}; y: {min: number; max: number; getPixelForValue: (value: number) => number}}
  destroy: ReturnType<typeof vi.fn<() => void>>
  update: ReturnType<typeof vi.fn<() => void>>
  data: {labels: number[]; datasets: {data: number[]; borderColor: object; backgroundColor?: string | null}[]}
  options: {
    scales: {x: FakeAxis; y: FakeAxis}
    plugins: {tooltip: {backgroundColor?: string; bodyColor?: string; titleColor?: string; footerColor?: string; bodyFont: {family: string; size?: number}; titleFont: {weight: string; size?: number}; footerFont: {size?: number}; enabled: boolean; callbacks: object}; crosshair: {line: {color?: string}}; zoom: object}
  }
  crosshair: {x: number; originalData: number[]; dragStarted: boolean}
}
type Attempt = {
  canvas: HTMLCanvasElement
  container: HTMLDivElement
  chart: FakeChart
  destroy: ReturnType<typeof vi.fn<() => void>>
  setData: ReturnType<typeof vi.fn<() => Promise<void>>>
  toggleTheme: ReturnType<typeof vi.fn<(options: ElevationProfileOptions) => void>>
  initialOptions: ElevationProfileOptions
  visible: boolean
  reject?: (reason: unknown) => void
}

const faults = vi.hoisted(() => ({
  defaultFont: {size: 17},
  modes: [] as Mode[],
  attempts: [] as Attempt[],
  charts: new WeakMap<HTMLCanvasElement, FakeChart>(),
}))

vi.mock('chart.js', () => ({
  Chart: {defaults: {font: faults.defaultFont}, getChart: (canvas: HTMLCanvasElement) => faults.charts.get(canvas)},
}))
vi.mock('../src/track/vendor/elevation-profile/elevationprofile.ts', () => ({
  ElevationProfile: class {
    chart: FakeChart
    destroy: ReturnType<typeof vi.fn<() => void>>
    mode: Mode
    attempt: Attempt
    setData = vi.fn((): Promise<void> => {
      if (this.mode === 'data-failure') return Promise.reject(new Error('Chart data update failed'))
      if (this.mode === 'pending') return new Promise((_resolve, reject) => {this.attempt.reject = reject})
      this.chart.update()
      return Promise.resolve()
    })
    toggleTheme = vi.fn((options: ElevationProfileOptions) => {
      this.chart.data.datasets[0].backgroundColor = options.profileBackgroundColor
      this.chart.options.scales.x.ticks.color = options.labelColor
      this.chart.options.scales.y.ticks.color = options.labelColor
      this.chart.options.scales.y.grid.color = options.elevationGridColor
      this.chart.options.scales.y.border.color = options.elevationGridColor
      this.chart.options.plugins.crosshair.line.color = options.crosshairColor
      this.chart.update()
    })

    constructor(container: HTMLDivElement, options: ElevationProfileOptions) {
      this.mode = faults.modes.shift() ?? 'success'
      faults.defaultFont.size = options.fontSize ?? 12
      const canvas = document.createElement('canvas')
      container.appendChild(canvas)
      const axis = (min: number, max: number): FakeAxis => ({min, max, ticks: {font: {family: 'host-font'}}, grid: {}, border: {}})
      const owner = this
      this.chart = {
        canvas, width: 480, height: 250, chartArea: {left: 40, right: 440, top: 20, bottom: 220}, config: {plugins: []},
        scales: {
          x: {get min() {return owner.chart.options.scales.x.min}, get max() {return owner.chart.options.scales.x.max}, getPixelForValue: value => {
            const axis = owner.chart.options.scales.x
            return 40 + (value - axis.min) / (axis.max - axis.min) * 400
          }},
          y: {get min() {return owner.chart.options.scales.y.min}, get max() {return owner.chart.options.scales.y.max}, getPixelForValue: value => {
            const axis = owner.chart.options.scales.y
            return 220 - (value - axis.min) / (axis.max - axis.min) * 200
          }},
        },
        destroy: vi.fn(() => {faults.charts.delete(canvas); canvas.remove()}), update: vi.fn(),
        data: {labels: [0, 1, 2], datasets: [{data: [1600, 1800, 1900], borderColor: {slopeGradient: true}}]},
        options: {scales: {x: axis(0, 2), y: axis(1500, 2000)}, plugins: {
          tooltip: {enabled: false, callbacks: {title: vi.fn()}, bodyFont: {family: 'host-font'}, titleFont: {weight: 'bold'}, footerFont: {}},
          crosshair: {line: {}}, zoom: {pan: {enabled: true}},
        }}, crosshair: {x: 42, originalData: [1600], dragStarted: true},
      }
      this.chart.update.mockImplementation(() => {
        for (const plugin of this.chart.config.plugins) plugin.afterDraw?.(this.chart as unknown as Chart<'line'>, {}, {})
      })
      this.destroy = vi.fn(() => {this.chart.destroy()})
      faults.charts.set(canvas, this.chart)
      let visible = container.isConnected
      for (let ancestor: HTMLElement | null = container; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        if (style.display === 'none' || style.visibility === 'hidden') visible = false
      }
      this.attempt = {canvas, container, chart: this.chart, destroy: this.destroy, setData: this.setData, toggleTheme: this.toggleTheme, initialOptions: options, visible}
      faults.attempts.push(this.attempt)
      if (this.mode === 'constructor-failure') throw new Error('Chart first draw failed')
    }
  },
}))

const POINTS: TrackPoint[] = [[114.18, 27.46, 1600, null], [114.19, 27.47, 1900, null]]
const MESSAGE = '海拔剖面暂时无法显示，可继续查看轨迹和统计。'
const LIGHT = {'--trk-chart-label': 'rgb(80, 80, 80)', '--trk-chart-grid': 'rgb(180, 180, 180)', '--trk-chart-crosshair': 'rgb(100, 100, 100)', '--trk-surface': 'rgb(250, 250, 250)', '--trk-text': 'rgb(20, 20, 20)'}
const DARK = {'--trk-chart-label': 'rgb(190, 190, 190)', '--trk-chart-grid': 'rgb(70, 70, 70)', '--trk-chart-crosshair': 'rgb(220, 220, 220)', '--trk-surface': 'rgb(30, 30, 30)', '--trk-text': 'rgb(240, 240, 240)'}
let root: Root | null
let container: HTMLDivElement
let initialBodyStyle: string | null
let initialDark: string | null

function hostTheme(colors: typeof LIGHT, fontSize = '14px') {
  for (const [token, value] of Object.entries(colors)) document.body.style.setProperty(token, value)
  document.body.style.fontSize = fontSize
}

beforeEach(() => {
  faults.defaultFont.size = 17
  faults.modes = []
  faults.attempts = []
  faults.charts = new WeakMap()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  initialBodyStyle = document.body.getAttribute('style')
  initialDark = document.body.getAttribute('data-ds-dark-theme')
  hostTheme(LIGHT)
  // jsdom resolves inherited fonts, but does not resolve var(...) colors.
  // Keep the real theme probe/observer and supply only that missing CSS step.
  const realComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = realComputedStyle(element, pseudo)
    const token = element instanceof HTMLElement ? element.style.color.match(/^var\((--[^,]+)/u)?.[1] : undefined
    if (!token) return style
    const color = document.body.style.getPropertyValue(token)
    return new Proxy(style, {get(target, key) {return key === 'color' && color ? color : Reflect.get(target, key, target)}})
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await unmount()
  container.remove()
  if (initialBodyStyle === null) document.body.removeAttribute('style')
  else document.body.setAttribute('style', initialBodyStyle)
  if (initialDark === null) document.body.removeAttribute('data-ds-dark-theme')
  else document.body.setAttribute('data-ds-dark-theme', initialDark)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderDetail(name = '武功山反穿', extra: Partial<Parameters<typeof ElevationChart>[0]> = {}) {
  await act(async () => {
    root!.render(createElement('article', null,
      createElement('h2', null, name),
      createElement('p', {'data-track-stat': ''}, '累计爬升 300 米'),
      createElement(ElevationChart, {points: POINTS, name, ...extra}),
    ))
  })
}
async function unmount() {
  if (!root) return
  const current = root
  root = null
  await act(async () => {current.unmount()})
}
function expectDetailVisible(name = '武功山反穿') {
  expect(container.querySelector('h2')?.textContent).toBe(name)
  expect(container.querySelector('[data-track-stat]')?.textContent).toBe('累计爬升 300 米')
}
async function retry() {
  const button = container.querySelector<HTMLButtonElement>('[role="alert"] button')
  expect(button?.textContent).toBe('重试剖面')
  await act(async () => {button!.click()})
}
async function changeTheme(colors = DARK, fontSize = '21px') {
  await act(async () => {hostTheme(colors, fontSize); document.body.setAttribute('data-ds-dark-theme', 'true')})
}

 describe('an elevation failure stays inside its card', () => {
  it.each(['constructor-failure', 'data-failure'] as const)('preserves the detail and recovers after %s', async mode => {
    faults.modes.push(mode, 'success')
    await renderDetail()
    expectDetailVisible()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(MESSAGE)
    expect(container.querySelector('canvas')).toBeNull()
    const failed = faults.attempts[0]
    expect(failed.chart.destroy).toHaveBeenCalledTimes(1)
    expect(failed.destroy).toHaveBeenCalledTimes(mode === 'constructor-failure' ? 0 : 1)
    expect(failed.container.isConnected).toBe(true)
    await retry()
    expectDetailVisible()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('canvas')).toBe(faults.attempts[1].canvas)
    expect(faults.attempts[1].visible).toBe(true)
    expect(faults.attempts[1].container).toBe(failed.container)
    expect(failed.chart.destroy).toHaveBeenCalledTimes(1)
    await unmount()
    expect(faults.attempts[1].destroy).toHaveBeenCalledTimes(1)
    expect(faults.attempts[1].chart.destroy).toHaveBeenCalledTimes(1)
    expect(failed.chart.destroy).toHaveBeenCalledTimes(1)
  })

  it('keeps the new profile when an earlier track update rejects late', async () => {
    faults.modes.push('pending', 'success')
    await renderDetail('旧轨迹')
    const old = faults.attempts[0]
    await renderDetail('新轨迹')
    expect(old.destroy).toHaveBeenCalledTimes(1)
    expect(old.chart.destroy).toHaveBeenCalledTimes(1)
    await act(async () => {old.reject!(new Error('Old data failed after navigation'))})
    expectDetailVisible('新轨迹')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('canvas')).toBe(faults.attempts[1].canvas)
    expect(faults.attempts[1].chart.destroy).not.toHaveBeenCalled()
  })

  it('cleans up a pending profile and ignores its rejection after unmount', async () => {
    faults.modes.push('pending')
    await renderDetail()
    const pending = faults.attempts[0]
    await unmount()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {pending.reject!(new Error('Data failed after unmount'))})
    expect(container.childElementCount).toBe(0)
    expect(pending.destroy).toHaveBeenCalledTimes(1)
    expect(pending.chart.destroy).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('host theme changes repaint the existing elevation chart', () => {
  it('reads current resolved colors and proportional host font size at construction', async () => {
    hostTheme(DARK, '21px')
    await renderDetail()
    const current = faults.attempts[0]
    expect(current.initialOptions).toMatchObject({labelColor: DARK['--trk-chart-label'], elevationGridColor: DARK['--trk-chart-grid'], tooltipBackgroundColor: DARK['--trk-surface'], tooltipTextColor: DARK['--trk-text'], fontSize: 18})
    expect(current.chart.options.scales.x.grid.tickColor).toBe(DARK['--trk-chart-grid'])
    expect(current.chart.options.plugins.tooltip.bodyFont).toEqual({family: 'host-font', size: 18})
  })

  it('updates colors and fonts through the real ancestor observer without reloading data or losing zoom/cursor state', async () => {
    await renderDetail()
    const current = faults.attempts[0]
    const {chart} = current
    const data = chart.data, slopeGradient = chart.data.datasets[0].borderColor, cursor = chart.crosshair, zoom = chart.options.plugins.zoom, callbacks = chart.options.plugins.tooltip.callbacks
    chart.options.scales.x.min = .4; chart.options.scales.x.max = .8
    chart.options.scales.y.min = 1500; chart.options.scales.y.max = 2000
    await changeTheme()
    expect(faults.attempts).toHaveLength(1)
    expect(container.querySelector('canvas')).toBe(current.canvas)
    expect(current.setData).toHaveBeenCalledTimes(1)
    expect(current.destroy).not.toHaveBeenCalled()
    expect(chart.data).toBe(data)
    expect(chart.data.datasets[0].borderColor).toBe(slopeGradient)
    expect(chart.crosshair).toBe(cursor)
    expect(chart.options.plugins.zoom).toBe(zoom)
    expect(chart.options.plugins.tooltip.callbacks).toBe(callbacks)
    expect(chart.options.plugins.tooltip.enabled).toBe(false)
    expect(chart.options.scales.x).toMatchObject({min: .4, max: .8, ticks: {color: DARK['--trk-chart-label'], font: {family: 'host-font', size: 18}}, grid: {color: DARK['--trk-chart-grid'], tickColor: DARK['--trk-chart-grid']}})
    expect(chart.options.scales.y).toMatchObject({min: 1500, max: 2000, ticks: {color: DARK['--trk-chart-label'], font: {size: 18}}, border: {color: DARK['--trk-chart-grid']}})
    expect(chart.options.plugins.tooltip).toMatchObject({backgroundColor: DARK['--trk-surface'], bodyColor: DARK['--trk-text'], titleFont: {weight: 'bold', size: 18}})
    expect(chart.options.plugins.crosshair.line.color).toBe(DARK['--trk-chart-crosshair'])
    expect(current.toggleTheme).toHaveBeenCalledTimes(2)
  })

  it('updates typography alone and skips repaint when observed values are unchanged', async () => {
    await renderDetail()
    const current = faults.attempts[0]
    await act(async () => {document.body.style.fontSize = '28px'})
    expect(current.chart.options.plugins.tooltip.bodyFont.size).toBe(24)
    expect(current.toggleTheme).toHaveBeenCalledTimes(2)
    await act(async () => {document.body.setAttribute('data-ds-dark-theme', 'unchanged'); current.canvas.setAttribute('width', '500')})
    expect(current.toggleTheme).toHaveBeenCalledTimes(2)
    expect(current.setData).toHaveBeenCalledTimes(1)
  })

  it('reads the latest theme on retry after a style repaint failure', async () => {
    await renderDetail()
    const current = faults.attempts[0]
    current.toggleTheme.mockImplementationOnce(() => {throw new Error('Theme repaint failed')})
    await changeTheme()
    expectDetailVisible()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(MESSAGE)
    expect(current.destroy).toHaveBeenCalledTimes(1)
    await retry()
    expect(faults.attempts[1].initialOptions).toMatchObject({labelColor: DARK['--trk-chart-label'], fontSize: 18})
    expect(faults.attempts[1].setData).toHaveBeenCalledTimes(1)
  })

  it('disconnects real observers and ignores a queued theme callback after unmount', async () => {
    await renderDetail()
    const current = faults.attempts[0]
    const queued: VoidFunction[] = []
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {queued.push(callback)})
    await act(async () => {hostTheme(DARK); await Promise.resolve()})
    expect(queued.length).toBeGreaterThan(0)
    await unmount()
    const calls = current.toggleTheme.mock.calls.length
    await act(async () => {for (const callback of queued.splice(0)) callback(); hostTheme(LIGHT); await Promise.resolve()})
    expect(current.toggleTheme).toHaveBeenCalledTimes(calls)
    expect(current.chart.destroy).toHaveBeenCalledTimes(1)
    expect(container.querySelector('canvas')).toBeNull()
  })
})


describe('vendor global typography is isolated', () => {
  it('restores the shared Chart.js font after successful creation and keeps theme updates local', async () => {
    hostTheme(DARK, '21px')
    await renderDetail()
    const current = faults.attempts[0]
    expect(current.initialOptions.fontSize).toBe(18)
    expect(current.chart.options.scales.x.ticks.font.size).toBe(18)
    expect(faults.defaultFont.size).toBe(17)
    await changeTheme(DARK, '28px')
    expect(current.chart.options.plugins.tooltip.bodyFont.size).toBe(24)
    expect(current.chart.options.scales.x.ticks.font.size).toBe(24)
    expect(faults.defaultFont.size).toBe(17)
    expect(current.setData).toHaveBeenCalledTimes(1)
  })

  it('restores the shared font when the constructor throws and on a later successful retry', async () => {
    faults.modes.push('constructor-failure', 'success')
    hostTheme(DARK, '28px')
    await renderDetail()
    expect(faults.attempts[0].initialOptions.fontSize).toBe(24)
    expect(faults.defaultFont.size).toBe(17)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(MESSAGE)
    hostTheme(LIGHT, '21px')
    await retry()
    expect(faults.attempts[1].chart.options.plugins.tooltip.bodyFont.size).toBe(18)
    expect(faults.defaultFont.size).toBe(17)
    expect(faults.attempts[1].setData).toHaveBeenCalledTimes(1)
  })
})

describe('profile annotations share selection without replacing the chart', () => {
  const placemarks: TrackPlacemark[] = [
    {id: 'a', name: '起点', coordinates: [114.18, 27.46], description: '', images: []},
    {id: 'b', name: '山口', coordinates: [114.185, 27.465], description: '', images: []},
  ]
  it('shows matching numbers and forwards point selection through the supplied callback', async () => {
    const select = vi.fn()
    await renderDetail('轨迹', {placemarks, onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(2)
    const button = container.querySelector<HTMLButtonElement>('[data-profile-placemark="b"]')!
    expect(button.textContent).toBe('2')
    await act(async () => button.click())
    expect(select).toHaveBeenCalledWith('b')
    expect(faults.attempts).toHaveLength(1)
  })

  it('updates selected styling on the same chart without setData or zoom resets', async () => {
    await renderDetail('轨迹', {placemarks})
    const current = faults.attempts[0], {chart} = current
    const callbacks = chart.options.plugins.tooltip.callbacks, dataset = chart.data.datasets[0]
    chart.options.scales.x.min = .4; chart.options.scales.x.max = .8
    await renderDetail('轨迹', {placemarks, selectedPlacemark: 'b'})
    expect(faults.attempts).toHaveLength(1)
    expect(current.setData).toHaveBeenCalledOnce()
    expect(current.chart.config.plugins.filter(plugin => plugin.id === 'cqai-track-profile-placemarks')).toHaveLength(1)
    expect(chart.options.scales.x).toMatchObject({min: .4, max: .8})
    expect(chart.data.datasets[0]).toBe(dataset)
    expect(chart.options.plugins.tooltip.callbacks).toBe(callbacks)
    expect(container.querySelector('[data-profile-placemark="b"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(current.container.style.position).toBe('relative')
  })

  it('filters projected markers after numbering and preserves the same chart, zoom and cursor state', async () => {
    const typed: TrackPlacemark[] = [
      {...placemarks[0], type: '营地'},
      {...placemarks[1], type: ['风景', '水源']},
      {id: 'c', name: '未分类', coordinates: [114.188, 27.468], description: '', images: [], type: []},
    ]
    const select = vi.fn()
    await renderDetail('轨迹', {placemarks: typed, onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(3)
    const current = faults.attempts[0], {chart} = current
    const canvas = current.canvas, dataset = chart.data.datasets[0], cursor = chart.crosshair
    chart.options.scales.x.min = 0; chart.options.scales.x.max = 1.5
    await renderDetail('轨迹', {placemarks: typed, placemarkTypeFilter: 'type:水源', onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(1)
    const water = container.querySelector<HTMLButtonElement>('[data-profile-placemark="b"]')!
    expect(water.textContent).toBe('2')
    await act(async () => water.click())
    expect(select).toHaveBeenLastCalledWith('b')
    await renderDetail('轨迹', {placemarks: typed, placemarkTypeFilter: 'untyped', onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(1)
    expect(container.querySelector('[data-profile-placemark="c"]')?.textContent).toBe('3')
    await renderDetail('轨迹', {placemarks: typed, placemarkTypeFilter: ['type:风景', 'type:水源'], onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(1)
    expect(container.querySelector('[data-profile-placemark="b"]')?.textContent).toBe('2')
    await renderDetail('轨迹', {placemarks: typed, placemarkTypeFilter: ['type:营地', 'untyped'], onSelectPlacemark: select})
    expect([...container.querySelectorAll('[data-profile-placemark]')].map(marker => marker.textContent)).toEqual(['1', '3'])
    await renderDetail('轨迹', {placemarks: typed, placemarkTypeFilter: [], onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(0)
    await renderDetail('轨迹', {placemarks: typed, onSelectPlacemark: select})
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(3)
    expect(faults.attempts).toHaveLength(1)
    expect(container.querySelector('canvas')).toBe(canvas)
    expect(current.setData).toHaveBeenCalledOnce()
    expect(current.destroy).not.toHaveBeenCalled()
    expect(chart.options.scales.x).toMatchObject({min: 0, max: 1.5})
    expect(chart.data.datasets[0]).toBe(dataset)
    expect(chart.crosshair).toBe(cursor)
    expect(chart.config.plugins.filter(plugin => plugin.id === 'cqai-track-profile-placemarks')).toHaveLength(1)
  })

  it('removes overlay controls and the local plugin through chart failure/retry and unmount', async () => {
    faults.modes.push('data-failure', 'success')
    await renderDetail('轨迹', {placemarks})
    const failed = faults.attempts[0]
    expect(container.querySelector('.trk-profile-placemarks')).toBeNull()
    expect(failed.chart.config.plugins).toEqual([])
    await retry()
    expect(container.querySelectorAll('[data-profile-placemark]')).toHaveLength(2)
    const current = faults.attempts[1]
    await unmount()
    expect(current.chart.config.plugins).toEqual([])
    expect(container.querySelector('.trk-profile-placemarks')).toBeNull()
  })
})
