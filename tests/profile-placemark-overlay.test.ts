// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createProfilePlacemarkOverlay, profilePlacemarkPositions, type ProfileOverlayChart, type ProfileOverlayData, type ProfilePlacemarkPlacement} from '../src/client/profile-placemark-overlay.ts'
import type {TrackPlacemark} from '../src/protocol.ts'

const roots: HTMLElement[] = []
const controllers: ReturnType<typeof createProfilePlacemarkOverlay>[] = []
function fixture(labels: number[] = [0, 3, 10], heights: (number | null)[] = [100, 400, 1000]) {
  const container = document.createElement('div'), canvas = document.createElement('canvas')
  container.style.position = 'relative'; container.append(canvas); document.body.append(container); roots.push(container)
  const x = {min: 0, max: 10, getPixelForValue(value: number) {return (value - this.min) / (this.max - this.min) * 400}}
  const y = {min: 0, max: 1000, getPixelForValue(value: number) {return 240 - (value - this.min) / (this.max - this.min) * 240}}
  const chart = {canvas, width: 400, height: 240, chartArea: {left: 0, right: 400, top: 0, bottom: 240},
    data: {labels, datasets: [{data: heights}]}, scales: {x, y}, config: {plugins: []}} as unknown as ProfileOverlayChart
  return {container, canvas, chart, x, y}
}
function point(id: string, index = 0): TrackPlacemark {return {id, name: `地点 ${index + 1}`, coordinates: [120, 30], description: '', images: []}}
function placement(id: string, number = 1, fraction = .5): ProfilePlacemarkPlacement {return {id, number, startIndex: 0, endIndex: 1, fraction}}
function data(placements: ProfilePlacemarkPlacement[], selected: string | null = null, onSelect = vi.fn()): ProfileOverlayData {
  return {placements, placemarks: placements.map((item, index) => point(item.id, index)), selected, onSelect}
}
function mount(chart: ProfileOverlayChart, container: HTMLElement, value: ProfileOverlayData) {
  const controller = createProfilePlacemarkOverlay(container, chart, value)
  controllers.push(controller)
  return controller
}
afterEach(() => {controllers.splice(0).forEach(controller => controller.destroy()); roots.splice(0).forEach(node => node.remove()); vi.restoreAllMocks()})

describe('displayed profile point positioning', () => {
  it('uses actual nonuniform chart distance labels and filtered curve heights', () => {
    const {chart} = fixture()
    const value = data([placement('a')]); value.placemarks = [{...point('a'), elevation: 900}]
    const [result] = profilePlacemarkPositions(chart, value)
    expect(result.x).toBeCloseTo(60)
    expect(result.y).toBeCloseTo(180)
    expect(result.number).toBe(1)
  })

  it('never treats a missing curve height as sea level and uses explicit point height only when needed', () => {
    const {chart} = fixture([0, 3, 10], [null, 400, 1000])
    const value = data([placement('a')])
    expect(profilePlacemarkPositions(chart, value)).toEqual([])
    value.placemarks = [{...point('a'), elevation: 600}]
    expect(profilePlacemarkPositions(chart, value)[0].y).toBeCloseTo(96)
    value.placements = [placement('a', 1, 1)]
    expect(profilePlacemarkPositions(chart, value)[0].y).toBeCloseTo(144)
  })

  it('hides points outside the current x window or y chart area', () => {
    const {chart, x} = fixture()
    const value = data([placement('a')])
    x.min = 4; x.max = 7
    expect(profilePlacemarkPositions(chart, value)).toEqual([])
    x.min = 0
    value.placemarks = [{...point('a'), elevation: 1500}]
    chart.data.datasets[0].data = [null, null, 1000] as unknown as number[]
    expect(profilePlacemarkPositions(chart, value)).toEqual([])
  })
})

describe('local profile placemark controls', () => {
  it('positions buttons in the holder coordinate system and forwards selection', () => {
    const {container, canvas, chart} = fixture()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({left: 15, top: 10, width: 240, height: 160} as DOMRect)
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({left: 35, top: 35, width: 200, height: 120} as DOMRect)
    const selected = vi.fn(), value = data([placement('a')], null, selected)
    const controller = mount(chart, container, value)
    const button = container.querySelector<HTMLButtonElement>('[data-profile-placemark="a"]')!
    expect(button.style.left).toBe('50px')
    expect(button.style.top).toBe('115px')
    expect(button.getAttribute('aria-label')).toBe('标注点 1：地点 1')
    button.click()
    expect(selected).toHaveBeenCalledWith('a')
    expect(chart.config.plugins).toContain(controller.plugin)
  })

  it('keeps every dense point selectable and labels only real group members', () => {
    const {chart, container} = fixture([0, 10], [300, 300])
    const members = [2, 75, 76, 77].map(number => placement(`p-${number}`, number))
    const selected = vi.fn(), controller = mount(chart, container, data(members, null, selected))
    const group = container.querySelector<HTMLButtonElement>('.trk-profile-marker-group')!
    expect(group.textContent).toBe('2+3')
    expect(group.getAttribute('aria-label')).toContain('2、75、76、77')
    group.click()
    expect(container.querySelectorAll('[data-profile-choice]')).toHaveLength(4)
    container.querySelector<HTMLButtonElement>('[data-profile-choice="p-76"]')!.click()
    expect(selected).toHaveBeenCalledWith('p-76')
    expect(container.querySelector('.trk-profile-choices')).toBeNull()
    controller.update(data(members, 'p-76', selected))
    expect(group.textContent).toBe('76+3')
    expect(group.getAttribute('aria-pressed')).toBe('true')
  })

  it('makes all 77 coincident points available without overlapping 77 buttons', () => {
    const {chart, container} = fixture([0, 10], [300, 300])
    const members = Array.from({length: 77}, (_, index) => placement(`p-${index + 1}`, index + 1))
    const selected = vi.fn()
    mount(chart, container, data(members, null, selected))
    expect(container.querySelectorAll('.trk-profile-marker')).toHaveLength(1)
    container.querySelector<HTMLButtonElement>('.trk-profile-marker')!.click()
    expect(container.querySelectorAll('[data-profile-choice]')).toHaveLength(77)
    container.querySelector<HTMLButtonElement>('[data-profile-choice="p-65"]')!.click()
    expect(selected).toHaveBeenCalledOnce()
    expect(selected).toHaveBeenCalledWith('p-65')
  })

  it('bounds groups instead of merging a continuous chain across the profile', () => {
    const {chart, container} = fixture([0, 10], [300, 300])
    const members = Array.from({length: 8}, (_, index) => placement(`p-${index + 1}`, index + 1, index * 25 / 400))
    const controller = mount(chart, container, data(members))
    expect(container.querySelectorAll('.trk-profile-marker')).toHaveLength(4)
    const first = container.querySelector<HTMLButtonElement>('.trk-profile-marker')!
    expect(first.style.left).toBe('0px')
    controller.update(data(members, 'p-2'))
    expect(first.style.left).toBe('25px')
    expect(first.textContent).toBe('2+1')
  })

  it('closes group choices on Escape and outside pointer without taking chart dragging', () => {
    const {chart, canvas, container} = fixture([0, 10], [300, 300])
    mount(chart, container, data([placement('a', 1), placement('b', 2)]))
    const group = container.querySelector<HTMLButtonElement>('.trk-profile-marker')!
    group.click()
    const choice = container.querySelector<HTMLButtonElement>('[data-profile-choice]')!
    expect(document.activeElement).toBe(choice)
    const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
    choice.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(container.querySelector('.trk-profile-choices')).toBeNull()
    expect(document.activeElement).toBe(group)
    group.click()
    const pointer = new Event('pointerdown', {bubbles: true, cancelable: true})
    canvas.dispatchEvent(pointer)
    expect(pointer.defaultPrevented).toBe(false)
    expect(container.querySelector('.trk-profile-choices')).toBeNull()
  })

  it('redraws for zoom/pan while preserving live controls and keyboard focus', () => {
    const {chart, container, x} = fixture([0, 10], [300, 300])
    const controller = mount(chart, container, data([placement('a')]))
    const button = container.querySelector<HTMLButtonElement>('[data-profile-placemark]')!
    button.focus()
    controller.draw()
    expect(container.querySelector('[data-profile-placemark]')).toBe(button)
    expect(document.activeElement).toBe(button)
    x.min = 4; x.max = 6; controller.draw()
    expect(button.style.left).toBe('200px')
    x.min = 6; x.max = 8; controller.draw()
    expect(container.querySelector('[data-profile-placemark]')).toBeNull()
  })

  it('disposes only its own chart plugin, DOM and listeners and ignores late draws/clicks', () => {
    const first = fixture(), second = fixture()
    const select = vi.fn(), value = data([placement('a')], null, select)
    const controller = mount(first.chart, first.container, value), other = mount(second.chart, second.container, value)
    const button = first.container.querySelector<HTMLButtonElement>('[data-profile-placemark]')!
    const removed = vi.spyOn(document, 'removeEventListener')
    controller.destroy(); controller.draw(); button.click()
    expect(first.container.querySelector('.trk-profile-placemarks')).toBeNull()
    expect(first.chart.config.plugins).not.toContain(controller.plugin)
    expect(removed).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    expect(select).not.toHaveBeenCalled()
    expect(second.chart.config.plugins).toContain(other.plugin)
    expect(second.container.querySelector('[data-profile-placemark]')).not.toBeNull()
  })
})
