/** Accessible screen-space placemarks anchored to the actual Three terrain triangles. */
import * as THREE from 'three'
import { terrainPosition } from './coordinates.ts'
import { sceneHeight, triangleElevation, type TerrainModel } from './geometry.ts'
import type { SandboxPlacemark, TerrainGrid } from './types.ts'

export interface SandboxPlacemarkOptions {
  visible?: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
}
interface MarkerEntry {
  button: HTMLButtonElement
  dot: HTMLSpanElement
  count: HTMLSpanElement | null
  anchor: THREE.Vector3
}

export class SandboxPlacemarkLayer {
  private root = document.createElement('div')
  private markers = new Map<string, MarkerEntry>()
  private visible = true
  private onSelect?: (id: string) => void
  private projected = new THREE.Vector3()
  private view = new THREE.Vector3()

  constructor(container: HTMLDivElement, private terrain: TerrainGrid, private model: TerrainModel) {
    this.root.className = 'trk-sandbox-placemarks'
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden'
    container.appendChild(this.root)
  }

  update(placemarks: readonly SandboxPlacemark[], options: SandboxPlacemarkOptions): void {
    this.visible = options.visible !== false
    this.onSelect = options.onSelect
    this.root.hidden = !this.visible
    this.root.style.display = this.visible ? '' : 'none'
    const retained = new Set<string>()
    const [west, south, east, north] = this.terrain.bounds
    for (const placemark of placemarks) {
      const [lon, lat] = placemark.coordinates
      // terrainPosition clamps for routes; markers outside the model must not pile up on its rim.
      if (!placemark.id || retained.has(placemark.id) || !Number.isFinite(lon) || !Number.isFinite(lat)
        || lon < west || lon > east || lat < south || lat > north) continue
      retained.add(placemark.id)
      let entry = this.markers.get(placemark.id)
      if (!entry) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.sandboxPlacemark = placemark.id
        button.style.cssText = 'position:absolute;width:44px;height:44px;min-height:44px;padding:0;pointer-events:auto;touch-action:manipulation;transform:translate(-50%,-50%)'
        const dot = document.createElement('span')
        dot.className = 'trk-sandbox-placemark-dot'
        button.appendChild(dot)
        entry = {button, dot, count: null, anchor: new THREE.Vector3()}
        this.markers.set(placemark.id, entry)
        this.root.appendChild(button)
        button.onpointerdown = event => event.stopPropagation()
        button.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        }
        // Native button activation covers pointer, Enter, Space and assistive technology.
        button.onclick = event => {
          event.stopPropagation()
          if (this.visible && !button.hidden) this.onSelect?.(placemark.id)
        }
      }
      const group = placemark.groupCount !== undefined
      entry.button.className = `trk-sandbox-placemark${group ? ' trk-sandbox-placemark-group' : ''}`
      if (entry.dot.textContent !== placemark.label) entry.dot.textContent = placemark.label
      if (group) {
        if (!entry.count) {
          entry.count = document.createElement('span')
          entry.count.className = 'trk-sandbox-placemark-count'
          entry.button.appendChild(entry.count)
        }
        entry.count.textContent = String(placemark.groupCount)
      } else {
        entry.count?.remove()
        entry.count = null
      }
      const title = placemark.title?.trim()
      entry.button.title = title || (group ? `标记组 ${placemark.label}` : `标注点 ${placemark.label}`)
      entry.button.setAttribute('aria-label', group
        ? `标记组 ${placemark.label}${title ? `：${title}` : ''}，${placemark.groupCount} 个子点`
        : title ? `标注点 ${placemark.label}：${title}` : `标注点 ${placemark.label}`)
      entry.button.setAttribute('aria-pressed', String(placemark.id === options.selectedId))
      const {x, z} = terrainPosition(lon, lat, this.terrain)
      entry.anchor.set(x, sceneHeight(triangleElevation(x, z, this.terrain), this.model), z)
    }
    for (const [id, entry] of this.markers) {
      if (retained.has(id)) continue
      this.remove(entry)
      this.markers.delete(id)
    }
  }

  project(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    camera.updateMatrixWorld()
    for (const entry of this.markers.values()) {
      this.view.copy(entry.anchor).applyMatrix4(camera.matrixWorldInverse)
      const distance = -this.view.z
      this.projected.copy(entry.anchor).project(camera)
      const {x, y, z} = this.projected
      const shown = this.visible && width > 0 && height > 0
        && distance >= camera.near && distance <= camera.far
        && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        && Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1
      entry.button.hidden = !shown
      entry.button.style.display = shown ? '' : 'none'
      if (!shown) continue
      entry.button.style.left = `${(x + 1) * width / 2}px`
      entry.button.style.top = `${(1 - y) * height / 2}px`
    }
  }

  dispose(): void {
    this.onSelect = undefined
    this.visible = false
    for (const entry of this.markers.values()) this.remove(entry)
    this.markers.clear()
    this.root.remove()
  }

  private remove(entry: MarkerEntry): void {
    entry.button.onclick = entry.button.onpointerdown = entry.button.onkeydown = null
    entry.button.remove()
  }
}
