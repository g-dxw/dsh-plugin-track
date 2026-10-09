/** World-space labels and anchors, with native screen-space buttons for interaction. */
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { DEFAULT_MAP_SETTINGS, sanitizeSandboxLabelSize, sanitizeSandboxLabelHeight, sanitizePlacemarkPointSize, sanitizePlacemarkPointRadius } from '../map-settings.ts'
import { terrainPosition } from './coordinates.ts'
import { SandboxTerrainOcclusion } from './occlusion.ts'
import { sceneHeight, triangleElevation, type TerrainModel } from './geometry.ts'
import type { SandboxPlacemark, TerrainGrid } from './types.ts'

export interface SandboxPlacemarkOptions {
  mode?: 'point' | 'marker'
  pointSize?: number
  pointColor?: string
  groupColor?: string
  pointRadius?: number
  pointShowCount?: boolean
  pointShowName?: boolean
  visible?: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
  labelColor?: string
  labelSize?: number
  labelHeight?: number
  connectorColor?: string
}
interface MarkerEntry {
  button: HTMLButtonElement
  node: THREE.Group
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  connector: Line2
  label: THREE.Sprite
  anchor: THREE.Vector3
  head: THREE.Vector3
  mode: 'point' | 'marker'
  textureKey: string
  pointOffsetX: number
  pointSize: number
  badgeX: number
  badgeTop: number
  width: number
  height: number
}
/** CSS pixel radii; source points at a route endpoint keep the endpoint size. */
export const SANDBOX_ENDPOINT_RADIUS = 5
const PLACEMARK_RADIUS = 3.5
function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
}

/** Chinese text is drawn into the captured WebGL canvas; no badge background. */
function labelArtwork(text: string, color: string, size: number): {canvas: HTMLCanvasElement; width: number; height: number} {
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
  if (!context) throw new Error('沙盘文字画布无法创建')
  const font = `600 ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`
  context.font = font
  const characters = Array.from(text), lines: string[] = []
  let line = ''
  for (let index = 0; index < characters.length; index++) {
    if (context.measureText(line + characters[index]).width > 248 && line) {
      lines.push(line); line = ''
      if (lines.length === 2) {
        let last = lines[1]
        while (context.measureText(last + '…').width > 248 && last) last = Array.from(last).slice(0, -1).join('')
        lines[1] = last + '…'; break
      }
    }
    line += characters[index]
  }
  if (line && lines.length < 2) lines.push(line)
  if (!lines.length) lines.push(text)
  const width = Math.ceil(Math.max(...lines.map(value => context.measureText(value).width))) + 12
  const lineHeight = Math.round(size * 1.375)
  const height = lines.length * lineHeight + 8
  canvas.width = width * 2; canvas.height = height * 2
  context.scale(2, 2); context.font = font; context.textAlign = 'center'; context.textBaseline = 'middle'
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16))
  context.strokeStyle = (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722) > 140 ? '#17202a' : '#ffffff'
  context.lineWidth = 3; context.lineJoin = 'round'; context.fillStyle = color
  lines.forEach((value, index) => {const y = 4 + (index + .5) * lineHeight; context.strokeText(value, width / 2, y); context.fillText(value, width / 2, y)})
  return {canvas, width, height}
}

function labelTexture(text: string, color: string, size: number): {texture: THREE.CanvasTexture; width: number; height: number} {
  const {canvas, width, height} = labelArtwork(text, color, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter
  return {texture, width, height}
}


/** Number badges are WebGL textures so canvas capture includes the point display. */
function pointTexture(text: string, background: string, size: number, radius: number, group: boolean,
  count?: number, name?: {text: string; color: string; size: number}): {texture: THREE.CanvasTexture; width: number; height: number; badgeX: number; badgeTop: number} {
  const title = name ? labelArtwork(name.text, name.color, name.size) : undefined
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
  if (!context) throw new Error('Point badge canvas unavailable')
  // Name and count extend the transparent canvas; both remain independent of the main badge diameter.
  const left = Math.min(0, title ? (size - title.width) / 2 : 0)
  const right = Math.max(size + (count === undefined ? 0 : 10), title ? (size + title.width) / 2 : size)
  const badgeX = -left, width = right - left
  const badgeTop = (title ? title.height + 4 : 0) + (count === undefined ? 0 : 9), height = size + badgeTop
  canvas.width = width * 2; canvas.height = height * 2
  context.scale(2, 2)
  if (title) context.drawImage(title.canvas, badgeX + (size - title.width) / 2, 0, title.width, title.height)
  const corner = size * radius / 100
  const outline = (inset: number) => {
    const left = badgeX + inset, right = badgeX + size - inset
    const upper = badgeTop + inset, bottom = badgeTop + size - inset, rounding = Math.max(0, corner - inset)
    context.beginPath()
    if (radius === 50) context.arc(badgeX + size / 2, badgeTop + size / 2, size / 2 - inset, 0, Math.PI * 2)
    else {
      context.moveTo(left + rounding, upper); context.lineTo(right - rounding, upper)
      context.quadraticCurveTo(right, upper, right, upper + rounding); context.lineTo(right, bottom - rounding)
      context.quadraticCurveTo(right, bottom, right - rounding, bottom); context.lineTo(left + rounding, bottom)
      context.quadraticCurveTo(left, bottom, left, bottom - rounding); context.lineTo(left, upper + rounding)
      context.quadraticCurveTo(left, upper, left + rounding, upper); context.closePath()
    }
  }
  outline(0); context.fillStyle = background; context.fill()
  // Center the 2px stroke one pixel inside so the configured outer badge size does not grow.
  outline(1); context.strokeStyle = '#ffffff'; context.lineWidth = 2; context.stroke()
  const channels = [1, 3, 5].map(start => parseInt(background.slice(start, start + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  const ink = luminance > .179 ? '#000000' : '#ffffff'
  context.fillStyle = ink; context.textAlign = 'center'; context.textBaseline = 'middle'
  let fontSize = Math.max(9, Math.round(size * (group ? 10 : 11) / 24))
  const font = (pixels: number) => `600 ${pixels}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`
  context.font = font(fontSize)
  while (fontSize > 6 && context.measureText(text).width > size - 4) context.font = font(--fontSize)
  context.fillText(text, badgeX + size / 2, badgeTop + size / 2, size - 4)
  if (count !== undefined) {
    context.beginPath(); context.arc(badgeX + size + 2, badgeTop - 1, 8, 0, Math.PI * 2)
    context.fillStyle = background; context.fill(); context.strokeStyle = '#ffffff'; context.lineWidth = 1; context.stroke()
    context.fillStyle = ink; context.font = font(9)
    context.fillText(String(count), badgeX + size + 2, badgeTop - 1, 14)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter
  return {texture, width, height, badgeX, badgeTop}
}

export class SandboxPlacemarkLayer {
  private root = document.createElement('div')
  private group = new THREE.Group()
  private markers = new Map<string, MarkerEntry>()
  private visible = true
  private disposed = false
  private onSelect?: (id: string) => void
  private projected = new THREE.Vector3()
  private view = new THREE.Vector3()
  private labelPoint = new THREE.Vector3()
  private cameraRight = new THREE.Vector3()
  private cameraUp = new THREE.Vector3()
  private pickCamera: THREE.PerspectiveCamera | null = null
  private pickWidth = 0
  private pickHeight = 0
  private sphereGeometry = new THREE.SphereGeometry(1, 12, 8)
  private sphereMaterial = new THREE.MeshBasicMaterial({color: DEFAULT_MAP_SETTINGS.sandboxConnectorColor, toneMapped: false, depthTest: true, depthWrite: false})
  private connectorMaterial: LineMaterial
  private lift: number
  private labelLift: number

  constructor(container: HTMLDivElement, private terrain: TerrainGrid, private model: TerrainModel, scene?: THREE.Scene,
    private endpointAnchors: readonly THREE.Vector3[] = [],
    private occlusion = new SandboxTerrainOcclusion(terrain, model)) {
    const span = Math.max(terrain.widthMeters, terrain.depthMeters)
    this.lift = Math.max(.2, span * .001)
    this.labelLift = Math.max(5, span * .09, model.topHeight * .12)
    this.connectorMaterial = new LineMaterial({color: DEFAULT_MAP_SETTINGS.sandboxConnectorColor, linewidth: 1.5,
      worldUnits: false, dashed: true, dashSize: Math.max(.1, span * .006), gapSize: Math.max(.1, span * .004),
      toneMapped: false, depthTest: true, depthWrite: false})
    this.group.name = 'sandbox-placemarks'; scene?.add(this.group)
    this.root.className = 'trk-sandbox-placemarks'
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden'
    container.appendChild(this.root)
  }

  update(placemarks: readonly SandboxPlacemark[], options: SandboxPlacemarkOptions): void {
    if (this.disposed) return
    const mode = options.mode === 'point' ? 'point' : 'marker'
    const pointSize = sanitizePlacemarkPointSize(options.pointSize), pointRadius = sanitizePlacemarkPointRadius(options.pointRadius)
    const pointShowCount = options.pointShowCount !== false, pointShowName = options.pointShowName === true
    const pointColor = color(options.pointColor, DEFAULT_MAP_SETTINGS.placemarkPointColor)
    const groupColor = color(options.groupColor, DEFAULT_MAP_SETTINGS.placemarkGroupColor)
    this.visible = options.visible !== false; this.onSelect = options.onSelect
    this.root.hidden = !this.visible; this.root.style.display = this.visible ? '' : 'none'; this.group.visible = this.visible
    const labelColor = color(options.labelColor, DEFAULT_MAP_SETTINGS.sandboxLabelColor)
    const labelSize = sanitizeSandboxLabelSize(options.labelSize)
    const labelLift = this.labelLift * sanitizeSandboxLabelHeight(options.labelHeight)
    const connectorColor = color(options.connectorColor, DEFAULT_MAP_SETTINGS.sandboxConnectorColor)
    this.sphereMaterial.color.set(connectorColor); this.connectorMaterial.color.set(connectorColor)
    const retained = new Set<string>(), [west, south, east, north] = this.terrain.bounds
    for (const placemark of placemarks) {
      const [lon, lat] = placemark.coordinates
      if (!placemark.id || retained.has(placemark.id) || !Number.isFinite(lon) || !Number.isFinite(lat)
        || lon < west || lon > east || lat < south || lat > north) continue
      retained.add(placemark.id)
      let entry = this.markers.get(placemark.id)
      const title = placemark.title?.trim(), group = placemark.groupCount !== undefined
      const text = mode === 'point' ? placemark.label : title || placemark.label
      const count = group && pointShowCount ? (Number.isFinite(placemark.groupCount) ? Math.max(0, Math.floor(placemark.groupCount!)) : 0) : undefined
      const pointName = pointShowName && title ? {text: title, color: labelColor, size: labelSize} : undefined
      const textureColor = mode === 'point' ? (group ? groupColor : pointColor) : labelColor
      const textureSize = mode === 'point' ? pointSize : labelSize
      const textureKey = JSON.stringify(mode === 'point'
        ? [mode, text, textureColor, textureSize, pointRadius, group, group && pointShowCount, count, pointName]
        : [mode, text, textureColor, textureSize])
      if (!entry) {
        const button = document.createElement('button')
        button.type = 'button'; button.dataset.sandboxPlacemark = placemark.id
        button.className = 'trk-sandbox-placemark'
        button.style.cssText = 'position:absolute;min-height:44px;min-width:44px;padding:0;pointer-events:auto;touch-action:manipulation;transform:translate(-50%,-100%);background:none;color:transparent;border:0;text-shadow:none'
        button.style.backgroundColor = 'transparent'
        const node = new THREE.Group(); node.userData.id = placemark.id
        const sphere = new THREE.Mesh(this.sphereGeometry, this.sphereMaterial)
        sphere.name = 'placemark-anchor'; sphere.renderOrder = 11
        const connector = new Line2(new LineGeometry(), this.connectorMaterial)
        connector.name = 'placemark-connector'; connector.renderOrder = 10
        const label = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true, depthTest: true, depthWrite: false, toneMapped: false}))
        label.name = 'placemark-label'; label.center.set(.5, 0); label.renderOrder = 12
        node.add(connector, sphere, label); this.group.add(node)
        entry = {button, node, sphere, connector, label, anchor: new THREE.Vector3(), head: new THREE.Vector3(), mode, textureKey: '', pointOffsetX: 0, pointSize: 0, badgeX: 0, badgeTop: 0, width: 44, height: 30}
        this.markers.set(placemark.id, entry); this.root.appendChild(button)
        button.onpointerdown = event => event.stopPropagation()
        button.onkeydown = event => {if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()}
        button.onclick = event => {event.stopPropagation(); if (this.visible && !button.hidden && this.canPick(entry!, event)) this.onSelect?.(placemark.id)}
      }
      if (entry.textureKey !== textureKey) {
        const artwork = mode === 'point'
          ? pointTexture(text, textureColor, textureSize, pointRadius, group, count, pointName) : {...labelTexture(text, textureColor, textureSize), badgeX: 0, badgeTop: 0}
        const {texture, width, height} = artwork
        entry.label.material.map?.dispose(); entry.label.material.map = texture; entry.label.material.needsUpdate = true
        entry.textureKey = textureKey; entry.width = width; entry.height = height
        entry.badgeX = artwork.badgeX; entry.badgeTop = artwork.badgeTop
        entry.pointSize = mode === 'point' ? pointSize : 0
        entry.pointOffsetX = mode === 'point' ? width / 2 - entry.badgeX - pointSize / 2 : 0
      }
      entry.mode = mode; entry.button.dataset.sandboxPlacemarkMode = mode
      entry.button.style.transform = mode === 'point' ? 'translate(-50%,-50%)' : 'translate(-50%,-100%)'
      entry.sphere.visible = entry.connector.visible = mode === 'marker'
      entry.label.center.set(.5, mode === 'point' ? .5 : 0)
      entry.button.textContent = text; entry.button.title = title || placemark.label
      entry.button.style.width = `${Math.max(44, entry.width)}px`; entry.button.style.height = `${Math.max(44, entry.height)}px`
      entry.button.setAttribute('aria-label', group ? `标记组 ${placemark.label}${title ? `：${title}` : ''}，${placemark.groupCount} 个子点`
        : title ? `标注点 ${placemark.label}：${title}` : `标注点 ${placemark.label}`)
      entry.button.setAttribute('aria-pressed', String(placemark.id === options.selectedId))
      const {x, z} = terrainPosition(lon, lat, this.terrain)
      const y = sceneHeight(triangleElevation(x, z, this.terrain), this.model) + this.lift
      const headY = y + labelLift
      const start = entry.connector.geometry.getAttribute('instanceStart'), end = entry.connector.geometry.getAttribute('instanceEnd')
      if (!start || entry.anchor.x !== x || entry.anchor.y !== y || entry.anchor.z !== z || entry.head.y !== headY) {
        entry.anchor.set(x, y, z); entry.head.copy(entry.anchor); entry.head.y = headY
        entry.sphere.position.copy(entry.anchor); entry.label.position.copy(entry.head)
        if (start && end) {
          start.setXYZ(0, entry.anchor.x, entry.anchor.y, entry.anchor.z); end.setXYZ(0, entry.head.x, entry.head.y, entry.head.z)
          start.needsUpdate = end.needsUpdate = true
          entry.connector.geometry.computeBoundingBox(); entry.connector.geometry.computeBoundingSphere()
        } else {
          entry.connector.geometry.setPositions([...entry.anchor.toArray(), ...entry.head.toArray()])
        }
        entry.connector.computeLineDistances()
      }
    }
    for (const [id, entry] of this.markers) {if (!retained.has(id)) {this.remove(entry); this.markers.delete(id)}}
  }

  project(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    if (this.disposed) return
    camera.updateMatrixWorld(); this.connectorMaterial.resolution.set(Math.max(1, width), Math.max(1, height))
    this.pickCamera = camera; this.pickWidth = width; this.pickHeight = height
    this.cameraRight.setFromMatrixColumn(camera.matrixWorld, 0); this.cameraUp.setFromMatrixColumn(camera.matrixWorld, 1)
    const enabled = this.visible && width > 0 && height > 0
    const unitsPerDepth = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, height)
    for (const entry of this.markers.values()) {
      const distance = -this.view.copy(entry.anchor).applyMatrix4(camera.matrixWorldInverse).z
      const headDistance = entry.mode === 'point' ? distance : -this.view.copy(entry.head).applyMatrix4(camera.matrixWorldInverse).z
      const unitsPerPixel = Math.max(camera.near, headDistance) * unitsPerDepth
      entry.label.scale.set(entry.width * unitsPerPixel, entry.height * unitsPerPixel, 1)
      // The badge bottom rests at the unchanged DEM anchor; its center floats by half its screen height.
      if (entry.mode === 'point') entry.label.position.copy(entry.anchor).addScaledVector(this.cameraRight, entry.pointOffsetX * unitsPerPixel)
        .addScaledVector(this.cameraUp, entry.height * unitsPerPixel / 2)
      else entry.label.position.copy(entry.head)
      const radius = this.endpointAnchors.some(anchor => anchor.distanceToSquared(entry.anchor) < 1e-8)
        ? SANDBOX_ENDPOINT_RADIUS : PLACEMARK_RADIUS
      entry.sphere.scale.setScalar(Math.max(camera.near, distance) * unitsPerDepth * radius)
      // Submit every part to the depth buffer: a hidden anchor must not remove an exposed leader or label.
      entry.node.visible = enabled
      const shown = enabled && headDistance >= camera.near && headDistance <= camera.far
        && this.hasVisibleLabel(entry, unitsPerPixel)
      entry.button.hidden = !shown; entry.button.style.display = shown ? '' : 'none'
      if (!shown) continue
      this.projected.copy(entry.label.position).project(camera)
      entry.button.style.left = `${(this.projected.x + 1) * width / 2}px`
      entry.button.style.top = `${(1 - this.projected.y) * height / 2}px`
    }
  }

  /** DOM interaction follows the exposed billboard, independently of the ground anchor. */
  private hasVisibleLabel(entry: MarkerEntry, unitsPerPixel: number): boolean {
    const camera = this.pickCamera!
    const halfWidth = Math.max(0, entry.width / 2 - 6), middle = entry.height / 2
    const samples = [[0, middle], [-halfWidth, 4], [halfWidth, 4], [-halfWidth, entry.height - 4],
      [halfWidth, entry.height - 4], [0, 4], [0, entry.height - 4], [-halfWidth, middle], [halfWidth, middle]]
    if (entry.mode === 'point') {
      // A wide name can leave the small badge between the canvas samples; sample its opaque interior first.
      const x = entry.badgeX + entry.pointSize / 2 - entry.width / 2
      const y = entry.height - entry.badgeTop - entry.pointSize / 2, offset = entry.pointSize * .3
      samples.unshift([x, y], [x - offset, y], [x + offset, y], [x, y - offset], [x, y + offset])
    }
    for (const [x, y] of samples) {
      this.labelPoint.copy(entry.label.position).addScaledVector(this.cameraRight, x * unitsPerPixel)
        .addScaledVector(this.cameraUp, (y - entry.height * entry.label.center.y) * unitsPerPixel)
      this.projected.copy(this.labelPoint).project(camera)
      const {x: px, y: py, z} = this.projected
      if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(z) && Math.abs(px) <= 1 && Math.abs(py) <= 1
        && z >= -1 && z <= 1 && !this.occlusion.isOccluded(camera.position, this.labelPoint)) return true
    }
    return false
  }

  private canPick(entry: MarkerEntry, event: MouseEvent): boolean {
    const camera = this.pickCamera
    if (!camera || this.pickWidth <= 0 || this.pickHeight <= 0) return false
    // Keyboard activation uses the already checked visible label; pointer activation checks its exact billboard ray.
    if (event.detail === 0) return true
    const rect = this.root.getBoundingClientRect()
    const x = (event.clientX - rect.left) / (rect.width || this.pickWidth) * this.pickWidth
    const y = (event.clientY - rect.top) / (rect.height || this.pickHeight) * this.pickHeight
    this.projected.copy(entry.label.position).project(camera)
    const depth = -this.view.copy(entry.label.position).applyMatrix4(camera.matrixWorldInverse).z
    const units = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / this.pickHeight
    this.labelPoint.copy(entry.label.position).addScaledVector(this.cameraRight, (x - (this.projected.x + 1) * this.pickWidth / 2) * units)
      .addScaledVector(this.cameraUp, ((1 - this.projected.y) * this.pickHeight / 2 - y) * units)
    return !this.occlusion.isOccluded(camera.position, this.labelPoint)
  }

  /** Keep a route endpoint from drawing a second ball over a visible source anchor. */
  hasVisibleAnchorAt(position: THREE.Vector3): boolean {
    if (!this.visible) return false
    for (const entry of this.markers.values()) {
      if (entry.node.visible && entry.sphere.visible && entry.anchor.distanceToSquared(position) < 1e-8) return true
    }
    return false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.onSelect = undefined; this.visible = false; this.pickCamera = null
    for (const entry of this.markers.values()) this.remove(entry)
    this.markers.clear(); this.group.removeFromParent(); this.root.remove()
    this.sphereGeometry.dispose(); this.sphereMaterial.dispose(); this.connectorMaterial.dispose()
  }

  private remove(entry: MarkerEntry): void {
    entry.button.onclick = entry.button.onpointerdown = entry.button.onkeydown = null; entry.button.remove(); entry.node.removeFromParent()
    entry.connector.geometry.dispose(); entry.label.material.map?.dispose(); entry.label.material.dispose()
  }
}
