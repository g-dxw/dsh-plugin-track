import type { Chart, Plugin } from 'chart.js'
import type { TrackPlacemark } from '../protocol.ts'
import { placemarkTitle, formatPlacemarkTime } from '../track/placemark-format.ts'

export interface ProfilePlacemarkPlacement {
  id: string
  number: number
  startIndex: number
  endIndex: number
  fraction: number
}
export interface ProfileOverlayData {
  placements: readonly ProfilePlacemarkPlacement[]
  placemarks: readonly TrackPlacemark[]
  selected: string | null
  onSelect?: (id: string) => void
}
export type ProfileOverlayChart = Pick<Chart<'line', number[], number>, 'canvas' | 'data' | 'scales' | 'chartArea' | 'width' | 'height' | 'config'>
type Position = ProfilePlacemarkPlacement & {point: TrackPlacemark; x: number; y: number}
type Group = {key: string; members: Position[]; x: number; y: number}
type ButtonEntry = {button: HTMLButtonElement; group: Group}

/** Read the displayed curve, including its distance units and filtered heights. */
export function profilePlacemarkPositions(chart: ProfileOverlayChart, data: ProfileOverlayData): Position[] {
  const labels = chart.data.labels ?? []
  const heights = chart.data.datasets[0]?.data ?? []
  const xScale = chart.scales.x, yScale = chart.scales.y, area = chart.chartArea
  if (!xScale || !yScale || !area) return []
  const points = new Map(data.placemarks.map(point => [point.id, point]))
  const positions: Position[] = []
  for (const placement of data.placements) {
    const point = points.get(placement.id)
    if (!point) continue
    const start = labels[placement.startIndex], end = labels[placement.endIndex]
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end)) continue
    const fraction = Math.max(0, Math.min(1, placement.fraction))
    const distance = start + (end - start) * fraction
    if (distance < xScale.min || distance > xScale.max) continue
    const first = heights[placement.startIndex], last = heights[placement.endIndex]
    let elevation: number | null = null
    if (typeof first === 'number' && Number.isFinite(first) && typeof last === 'number' && Number.isFinite(last)) {
      elevation = first + (last - first) * fraction
    } else if (fraction === 0 && typeof first === 'number' && Number.isFinite(first)) elevation = first
    else if (fraction === 1 && typeof last === 'number' && Number.isFinite(last)) elevation = last
    else if (typeof point.elevation === 'number' && Number.isFinite(point.elevation)) elevation = point.elevation
    if (elevation === null) continue
    const x = xScale.getPixelForValue(distance), y = yScale.getPixelForValue(elevation)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < area.left || x > area.right || y < area.top || y > area.bottom) continue
    positions.push({...placement, point, x, y})
  }
  return positions
}

/** Nearby points share one control; every original number remains available. */
function groupsOf(positions: Position[], selected: string | null): Group[] {
  const groups: Position[][] = []
  for (const position of positions) {
    // Bound the whole cluster, not only adjacent pairs: a dense chain must not
    // turn kilometres of unrelated points into one giant group.
    const candidates = groups.filter(group => {
      const x = group.map(member => member.x), y = group.map(member => member.y)
      return Math.max(position.x, ...x) - Math.min(position.x, ...x) <= 38
        && Math.max(position.y, ...y) - Math.min(position.y, ...y) <= 38
    })
    const group = candidates.sort((a, b) => Math.min(...a.map(member => Math.hypot(member.x - position.x, member.y - position.y)))
      - Math.min(...b.map(member => Math.hypot(member.x - position.x, member.y - position.y))))[0]
    if (group) group.push(position)
    else groups.push([position])
  }
  return groups.map(members => {
    members.sort((a, b) => a.number - b.number)
    const anchor = members.find(member => member.id === selected) ?? members[0]
    return {members, key: members.map(point => point.id).join('\u0000'),
      x: anchor.x, y: anchor.y}
  })
}
function numberLabel(group: Group, selected: string | null): string {
  const first = group.members.find(member => member.id === selected) ?? group.members[0]
  return group.members.length === 1 ? String(first.number) : `${first.number}+${group.members.length - 1}`
}

export function createProfilePlacemarkOverlay(container: HTMLElement, chart: ProfileOverlayChart, initial: ProfileOverlayData) {
  let data = initial
  let active = true
  let menu: HTMLDivElement | null = null
  let menuKey: string | null = null
  const entries = new Map<string, ButtonEntry>()
  const overlay = document.createElement('div')
  overlay.className = 'trk-profile-placemarks'
  overlay.setAttribute('aria-label', '海拔图标注点')
  const style = document.createElement('style')
  style.textContent = PROFILE_PLACEMARK_CSS
  overlay.append(style)
  container.append(overlay)

  const closeMenu = (restoreFocus = false) => {
    const previous = menuKey ? entries.get(menuKey)?.button : undefined
    menu?.remove(); menu = null; menuKey = null
    for (const entry of entries.values()) if (entry.group.members.length > 1) entry.button.setAttribute('aria-expanded', 'false')
    if (restoreFocus && previous?.isConnected) previous.focus({preventScroll: true})
  }
  const choose = (id: string) => {
    if (!active) return
    closeMenu()
    data.onSelect?.(id)
  }
  const placeMenu = (entry: ButtonEntry) => {
    if (!menu) return
    const left = Number.parseFloat(entry.button.style.left)
    const top = Number.parseFloat(entry.button.style.top)
    const width = container.clientWidth || chart.width
    const height = container.clientHeight || chart.height
    menu.style.width = `${Math.min(260, Math.max(120, width - 16))}px`
    menu.style.left = `${Math.max(8, Math.min(left - 130, width - Math.min(260, width - 16) - 8))}px`
    menu.style.maxHeight = `${Math.max(80, Math.min(180, height - 24))}px`
    menu.style.top = `${Math.max(8, Math.min(top + 18, height - Math.min(180, height - 24) - 8))}px`
  }
  const openMenu = (entry: ButtonEntry) => {
    if (!active) return
    if (menuKey === entry.group.key) {closeMenu(true); return}
    closeMenu()
    menu = document.createElement('div')
    menu.className = 'trk-profile-choices'
    menu.setAttribute('role', 'group')
    menu.setAttribute('aria-label', '选择海拔图标注点')
    menuKey = entry.group.key
    for (const member of entry.group.members) {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'trk-profile-choice'
      button.dataset.profileChoice = member.id
      const title = placemarkTitle(member.point), time = formatPlacemarkTime(member.point.time,member.point.timeSource)
      button.textContent = [String(member.number), title, time].filter(Boolean).join(' · ')
      button.setAttribute('aria-label', `标注点 ${member.number}${title ? `：${title}` : ''}${time ? `，${time}` : ''}`)
      button.setAttribute('aria-pressed', String(member.id === data.selected))
      button.addEventListener('click', event => {event.stopPropagation(); choose(member.id)})
      button.addEventListener('pointerdown', event => event.stopPropagation())
      menu.append(button)
    }
    overlay.append(menu)
    entry.button.setAttribute('aria-expanded', 'true')
    placeMenu(entry)
    const choices = [...menu.querySelectorAll<HTMLButtonElement>('[data-profile-choice]')]
    ;(choices.find(button => button.dataset.profileChoice === data.selected) ?? choices[0])?.focus({preventScroll: true})
  }
  const onOutsidePointer = (event: PointerEvent) => {
    if (!menu || !(event.target instanceof Node)) return
    if (menu.contains(event.target) || (menuKey && entries.get(menuKey)?.button.contains(event.target))) return
    closeMenu()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && menu) {event.preventDefault(); event.stopPropagation(); closeMenu(true)}
  }
  container.ownerDocument.addEventListener('pointerdown', onOutsidePointer, true)
  overlay.addEventListener('keydown', onKeyDown)

  const draw = () => {
    if (!active) return
    const groups = groupsOf(profilePlacemarkPositions(chart, data), data.selected)
    const present = new Set(groups.map(group => group.key))
    if (menuKey && !present.has(menuKey)) closeMenu()
    for (const [key, entry] of entries) if (!present.has(key)) {entry.button.remove(); entries.delete(key)}
    const canvasBox = chart.canvas.getBoundingClientRect(), containerBox = container.getBoundingClientRect()
    const ratioX = chart.width > 0 && canvasBox.width > 0 ? canvasBox.width / chart.width : 1
    const ratioY = chart.height > 0 && canvasBox.height > 0 ? canvasBox.height / chart.height : 1
    for (const group of groups) {
      let entry = entries.get(group.key)
      if (!entry) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'trk-profile-marker'
        entry = {button, group}
        const current = entry
        button.addEventListener('click', event => {
          event.stopPropagation()
          if (!active) return
          if (current.group.members.length === 1) choose(current.group.members[0].id)
          else openMenu(current)
        })
        button.addEventListener('pointerdown', event => event.stopPropagation())
        entries.set(group.key, entry)
        overlay.append(button)
      }
      entry.group = group
      const {button} = entry, multiple = group.members.length > 1
      button.classList.toggle('trk-profile-marker-group', multiple)
      button.classList.toggle('trk-profile-marker-selected', group.members.some(member => member.id === data.selected))
      button.textContent = numberLabel(group, data.selected)
      button.style.left = `${canvasBox.left - containerBox.left + group.x * ratioX}px`
      button.style.top = `${canvasBox.top - containerBox.top + group.y * ratioY}px`
      button.setAttribute('aria-pressed', String(group.members.some(member => member.id === data.selected)))
      if (multiple) {
        button.removeAttribute('data-profile-placemark')
        button.setAttribute('aria-label', `标注点 ${group.members.map(member => member.number).join('、')}，共 ${group.members.length} 个，展开选择`)
        button.setAttribute('aria-expanded', String(menuKey === group.key))
      } else {
        const member = group.members[0], title = placemarkTitle(member.point)
        button.dataset.profilePlacemark = member.id
        button.setAttribute('aria-label', `标注点 ${member.number}${title ? `：${title}` : ''}`)
        button.removeAttribute('aria-expanded')
      }
      if (menuKey === group.key) placeMenu(entry)
    }
    for (const button of menu?.querySelectorAll<HTMLButtonElement>('[data-profile-choice]') ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.profileChoice === data.selected))
    }
  }
  const destroy = () => {
    if (!active) return
    active = false
    closeMenu()
    container.ownerDocument.removeEventListener('pointerdown', onOutsidePointer, true)
    overlay.removeEventListener('keydown', onKeyDown)
    entries.clear(); overlay.remove()
    const plugins = chart.config.plugins
    const index = plugins?.indexOf(plugin) ?? -1
    if (plugins && index >= 0) plugins.splice(index, 1)
  }
  const plugin: Plugin<'line'> = {id: 'cqai-track-profile-placemarks', afterDraw: draw, afterDestroy: destroy}
  const plugins = chart.config.plugins ?? (chart.config.plugins = [])
  plugins.push(plugin)
  draw()
  return {plugin, draw, destroy, update(next: ProfileOverlayData) {data = next; draw()}}
}

const PROFILE_PLACEMARK_CSS = `
.trk-profile-placemarks{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:visible}.trk-profile-marker{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;min-width:26px;height:26px;border:2px solid white;border-radius:50%;padding:0;background:#c83532;color:white;font:700 11px/1 system-ui,sans-serif;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px #0003}.trk-profile-marker-group{border-radius:14px;min-width:38px;padding:0 4px;font-size:10px}.trk-profile-marker-selected{outline:3px solid var(--trk-focus,#263cba);outline-offset:2px;z-index:1;background:#98221f}.trk-profile-marker:focus-visible{outline:3px solid var(--trk-focus,#263cba);outline-offset:2px;z-index:3}.trk-profile-choices{position:absolute;z-index:6;box-sizing:border-box;padding:6px;border:1px solid var(--trk-border,#bbb);border-radius:var(--trk-radius-md,12px);background:var(--trk-surface,white);color:var(--trk-text,#222);box-shadow:0 4px 18px #0004;overflow:auto;pointer-events:auto}.trk-profile-choice{display:block;width:100%;min-height:36px;padding:7px 9px;border:1px solid transparent;border-radius:var(--trk-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;overflow-wrap:anywhere;cursor:pointer}.trk-profile-choice:hover,.trk-profile-choice[aria-pressed=true]{background:var(--trk-active,#eee);border-color:var(--trk-border,#bbb)}.trk-profile-choice:focus-visible{outline:2px solid var(--trk-focus,#263cba);outline-offset:-2px}
`
