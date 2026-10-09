/** Floating labels in the native terrain map's own WebGL/depth buffer. */
import * as THREE from 'three'
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from 'maplibre-gl'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { DEFAULT_MAP_SETTINGS, sanitizeSandboxLabelHeight, sanitizeSandboxLabelSize } from './map-settings.ts'
import { TRACK_ENDS_SOURCE } from './trail-layer.ts'
import type { SandboxPlacemark } from './sandbox/types.ts'
import type { SandboxPlacemarkOptions } from './sandbox/placemarks.ts'

export const MAP_FLOATING_PLACEMARK_LAYER = 'cqai-track-floating-placemarks'
interface Entry {
  point: SandboxPlacemark
  node: THREE.Group
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  line: Line2
  label: THREE.Sprite
  button: HTMLButtonElement
  text: string
  color: string
  size: number
  width: number
  height: number
}
interface TerrainDepthCompatibility {
  terrain?: {depthAtPoint?: (point: {x: number; y: number}) => number} | null
}

/**
 * MapLibre packs NDC z (not window depth) into an RGBA8 texture. Its CPU
 * depthAtPoint divides the read bytes by 256, whereas UNORM8 writes use 255.
 * Recover the original base-256 components before comparing camera NDC z.
 * Alpha byte 128 has a 1/256 ambiguity (digit 128 or 129); recover
 * the farther value conservatively rather than hiding a potentially visible pick.
 * In the usual map NDC band above .51 the alpha digit is unambiguous;
 * remaining B/G ambiguity is at most 1/65536, covered by 2e-5 tolerance.
 */
function terrainDepthNDC(encoded: number): number {
  const packed = Math.round(encoded * 0x100000000)
  const alpha = Math.floor(packed / 0x1000000), blue = Math.floor(packed / 0x10000) % 256
  const green = Math.floor(packed / 256) % 256, red = packed % 256
  const recover = (byte: number) => Math.round(byte * 256 / 255) / 256
  return recover(alpha) + recover(blue) / 256 + recover(green) / 65536 + red / 255 / 16777216
}

/** MapLibre 5.24 exposes the rendered DEM depth here; isolate the optional internal API. */
function terrainCovers(map: MapLibreMap, point: THREE.Vector3, width: number, height: number): boolean {
  const terrain = (map as unknown as TerrainDepthCompatibility).terrain
  if (!terrain?.depthAtPoint || width <= 0 || height <= 0) return false
  const x = Math.floor((point.x + 1) * width / 2), y = Math.floor((1 - point.y) * height / 2)
  if (x < 0 || y < 0 || x >= width || y >= height) return true
  try {
    const depth = terrain.depthAtPoint({x, y})
    // The depth FBO clears RGBA to zero: zero means no terrain pixel, not a near occluder.
    return Number.isFinite(depth) && depth > 0 && depth < 1 && point.z > terrainDepthNDC(depth) + 2e-5
  } catch {return false}
}
function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
}
function texture(text: string, color: string, size: number): {texture: THREE.CanvasTexture; width: number; height: number} {
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
  if (!context) throw new Error('地图文字画布无法创建')
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
  const lineHeight = Math.round(size * 1.375), height = lines.length * lineHeight + 8
  canvas.width = width * 2; canvas.height = height * 2
  context.scale(2, 2); context.font = font; context.textAlign = 'center'; context.textBaseline = 'middle'
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16))
  context.strokeStyle = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 140 ? '#17202a' : '#ffffff'
  context.lineWidth = 3; context.lineJoin = 'round'; context.fillStyle = color
  lines.forEach((value, index) => {const y = 4 + (index + .5) * lineHeight; context.strokeText(value, width / 2, y); context.fillText(value, width / 2, y)})
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace; map.generateMipmaps = false; map.minFilter = THREE.LinearFilter
  return {texture: map, width, height}
}

/** Local metre coordinates make Three billboards/spheres precise as the map camera rotates. */
export class MapFloatingPlacemarkLayer {
  private root = document.createElement('div')
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera = new THREE.PerspectiveCamera()
  private entries = new Map<string, Entry>()
  private sphereGeometry: THREE.SphereGeometry | null = null
  private sphereMaterial: THREE.MeshBasicMaterial | null = null
  private lineMaterial: LineMaterial | null = null
  private points: readonly SandboxPlacemark[] = []
  private options: SandboxPlacemarkOptions = {visible: false}
  private origin: [number, number] = [0, 0]
  private originMercator = new MercatorCoordinate(0, 0, 0)
  private units = 1
  private span = 1
  private disposed = false
  private attaching = false
  private lastWidth = 0
  private lastHeight = 0
  private right = new THREE.Vector3()
  private up = new THREE.Vector3()
  private sample = new THREE.Vector3()
  private projected = new THREE.Vector3()
  private viewPoint = new THREE.Vector3()
  private model = new THREE.Matrix4()
  private main = new THREE.Matrix4()
  private view = new THREE.Matrix4()
  private scale = new THREE.Matrix4()
  private activeFrame = false
  private layer: CustomLayerInterface = {
    id: MAP_FLOATING_PLACEMARK_LAYER, type: 'custom', renderingMode: '3d',
    onAdd: (_map, gl) => this.add(gl),
    render: (_gl, args) => this.render(args),
    onRemove: () => this.release(),
  }
  private restoreLayer = () => this.ensureLayer()
  private redraw = () => {if (!this.disposed && this.options.visible !== false) this.map.triggerRepaint()}

  constructor(private map: MapLibreMap, container: HTMLElement) {
    this.root.className = 'trk-map-floating-placemarks'
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden'
    this.root.hidden = true
    container.appendChild(this.root)
    this.camera.matrixAutoUpdate = false; this.camera.matrixWorldAutoUpdate = false
    map.on('styledata', this.restoreLayer)
    map.on('terrain', this.redraw)
    map.on('sourcedata', this.redraw)
    map.on('webglcontextrestored', this.redraw)
  }

  update(placemarks: readonly SandboxPlacemark[], options: SandboxPlacemarkOptions = {}): void {
    if (this.disposed) return
    const wasVisible = this.options.visible !== false
    const seen = new Set<string>()
    this.points = placemarks.filter(point => {
      const [lon, lat] = point.coordinates
      if (!point.id || seen.has(point.id) || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85.051129) return false
      seen.add(point.id); return true
    })
    this.options = {...options}
    this.setOrigin()
    this.root.hidden = options.visible === false
    if (this.scene) this.scene.visible = options.visible !== false
    this.ensureLayer()
    this.syncEntries()
    // The hidden layer skips drawing, but a map frame must clear its previous pixels.
    if (wasVisible && options.visible === false) this.map.triggerRepaint()
    else this.redraw()
  }

  getButton(id: string): HTMLButtonElement | undefined {return this.entries.get(id)?.button}

  private setOrigin(): void {
    if (!this.points.length) return
    const coordinates = this.points.map(point => MercatorCoordinate.fromLngLat(point.coordinates as [number, number]))
    // Keep a local world copy across the date line instead of spanning almost the whole planet.
    const reference = coordinates[0].x
    const xs = coordinates.map(point => point.x + Math.round(reference - point.x))
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...coordinates.map(point => point.y)), maxY = Math.max(...coordinates.map(point => point.y))
    this.originMercator = new MercatorCoordinate((minX + maxX) / 2, (minY + maxY) / 2, 0)
    const origin = this.originMercator.toLngLat()
    this.origin = [origin.lng, origin.lat]; this.units = this.originMercator.meterInMercatorCoordinateUnits()
    this.span = Math.max(1, (maxX - minX) / this.units, (maxY - minY) / this.units)
    this.matchWorldCopy()
  }

  private matchWorldCopy(): void {
    const center = this.map.getCenter?.()
    if (!center) return
    const shift = Math.round(MercatorCoordinate.fromLngLat(center).x - this.originMercator.x)
    if (!shift) return
    this.originMercator.x += shift
    const origin = this.originMercator.toLngLat()
    this.origin = [origin.lng, origin.lat]
  }

  private ensureLayer(): void {
    if (this.disposed || this.attaching || this.options.visible === false || !this.points.length || this.map.getLayer(this.layer.id)) return
    this.attaching = true
    try {this.map.addLayer(this.layer)} catch { /* A style replacement will retry via styledata. */ }
    finally {this.attaching = false}
  }

  private add(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.disposed) return
    this.release()
    const renderer = this.renderer = new THREE.WebGLRenderer({canvas: this.map.getCanvas(), context: gl as WebGL2RenderingContext})
    renderer.autoClear = false; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping
    this.scene = new THREE.Scene()
    this.sphereGeometry = new THREE.SphereGeometry(1, 12, 8)
    this.sphereMaterial = new THREE.MeshBasicMaterial({color: DEFAULT_MAP_SETTINGS.sandboxConnectorColor, depthTest: true, depthWrite: false, toneMapped: false})
    this.lineMaterial = new LineMaterial({color: DEFAULT_MAP_SETTINGS.sandboxConnectorColor, linewidth: 1.5, dashed: true,
      worldUnits: false, dashSize: Math.max(.1, this.span * .006), gapSize: Math.max(.1, this.span * .004),
      depthTest: true, depthWrite: false, toneMapped: false})
    this.syncEntries()
  }

  private syncEntries(): void {
    if (!this.scene || !this.sphereGeometry || !this.sphereMaterial || !this.lineMaterial) return
    const labelColor = color(this.options.labelColor, DEFAULT_MAP_SETTINGS.sandboxLabelColor)
    const connectorColor = color(this.options.connectorColor, DEFAULT_MAP_SETTINGS.sandboxConnectorColor)
    const size = sanitizeSandboxLabelSize(this.options.labelSize), retained = new Set<string>()
    this.sphereMaterial.color.set(connectorColor); this.lineMaterial.color.set(connectorColor)
    this.lineMaterial.dashSize = Math.max(.1, this.span * .006); this.lineMaterial.gapSize = Math.max(.1, this.span * .004)
    for (const point of this.points) {
      retained.add(point.id)
      let entry = this.entries.get(point.id)
      const text = point.title?.trim() || point.label
      if (!entry) {
        const node = new THREE.Group(); node.userData.id = point.id
        const sphere = new THREE.Mesh(this.sphereGeometry, this.sphereMaterial)
        sphere.name = 'placemark-anchor'; sphere.renderOrder = 11
        const line = new Line2(new LineGeometry(), this.lineMaterial)
        line.name = 'placemark-connector'; line.renderOrder = 10
        // The shared canvas viewport uses physical pixels; linewidth/resolution use CSS pixels.
        line.onBeforeRender = () => {}
        const label = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true, depthTest: true, depthWrite: false, toneMapped: false}))
        label.name = 'placemark-label'; label.center.set(.5, 0); label.renderOrder = 12
        node.add(line, sphere, label); this.scene.add(node)
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'trk-sandbox-placemark trk-map-floating-placemark'
        button.dataset.floatingPlacemark = point.id
        button.style.cssText = 'position:absolute;box-sizing:border-box;min-width:44px;min-height:44px;padding:0;margin:0;pointer-events:auto;touch-action:manipulation;transform:translate(-50%,-100%);background:none;color:transparent;border:0;text-shadow:none'
        button.style.backgroundColor = 'transparent'; button.hidden = true
        this.root.appendChild(button)
        entry = {point, node, sphere, line, label, button, text: '', color: '', size: 0, width: 44, height: 30}
        this.entries.set(point.id, entry)
        button.onpointerdown = event => event.stopPropagation()
        button.onkeydown = event => {if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()}
        button.onclick = event => {
          event.stopPropagation()
          if (this.options.visible !== false && !entry!.button.hidden && this.canPick(entry!, event)) this.options.onSelect?.(entry!.point.id)
        }
      }
      entry.point = point
      if (entry.text !== text || entry.color !== labelColor || entry.size !== size) {
        const drawn = texture(text, labelColor, size)
        entry.label.material.map?.dispose(); entry.label.material.map = drawn.texture; entry.label.material.needsUpdate = true
        entry.width = drawn.width; entry.height = drawn.height; entry.text = text; entry.color = labelColor; entry.size = size
      }
      entry.button.textContent = text; entry.button.title = text
      entry.button.style.width = `${Math.max(44, entry.width)}px`; entry.button.style.height = `${Math.max(44, entry.height)}px`
      const title = point.title?.trim()
      entry.button.setAttribute('aria-label', point.groupCount !== undefined ? `标记组 ${point.label}${title ? `：${title}` : ''}，${point.groupCount} 个子点`
        : title ? `标注点 ${point.label}：${title}` : `标注点 ${point.label}`)
      entry.button.setAttribute('aria-pressed', String(point.id === this.options.selectedId))
      this.updatePosition(entry)
    }
    for (const [id, entry] of this.entries) if (!retained.has(id)) {this.remove(entry); this.entries.delete(id)}
  }

  /** Query the map's displayed, already exaggerated DEM; source-file elevations never enter. */
  private updatePosition(entry: Entry): void {
    const elevation = this.map.queryTerrainElevation(entry.point.coordinates as [number, number])
    const point = MercatorCoordinate.fromLngLat(entry.point.coordinates as [number, number], Number.isFinite(elevation) ? elevation! : 0)
    const lift = Math.max(.2, this.span * .001)
    const height = Math.max(5, this.span * .09) * sanitizeSandboxLabelHeight(this.options.labelHeight)
    const localUnits = point.meterInMercatorCoordinateUnits() / this.units
    const wrappedX = point.x + Math.round(this.originMercator.x - point.x)
    const x = (wrappedX - this.originMercator.x) / this.units, y = point.z / this.units + lift * localUnits, z = (point.y - this.originMercator.y) / this.units
    const headY = y + height * localUnits
    const start = entry.line.geometry.getAttribute('instanceStart'), end = entry.line.geometry.getAttribute('instanceEnd')
    if (start && entry.sphere.position.x === x && entry.sphere.position.y === y && entry.sphere.position.z === z && entry.label.position.y === headY) return
    entry.sphere.position.set(x, y, z); entry.label.position.set(x, headY, z)
    if (start && end) {
      start.setXYZ(0, x, y, z); end.setXYZ(0, x, headY, z); start.needsUpdate = end.needsUpdate = true
      entry.line.geometry.computeBoundingBox(); entry.line.geometry.computeBoundingSphere()
    } else entry.line.geometry.setPositions([x, y, z, x, headY, z])
    entry.line.computeLineDistances()
  }

  private prepareCamera(args: CustomRenderMethodInput): boolean {
    this.model.fromArray(this.map.transform.getMatrixForModel(this.origin, 0))
    this.main.fromArray(args.defaultProjectionData.mainMatrix).multiply(this.model)
    this.camera.projectionMatrix.fromArray(args.projectionMatrix)
    this.view.copy(this.camera.projectionMatrix).invert().multiply(this.main)
    const elements = this.view.elements, scale = Math.hypot(elements[0], elements[1], elements[2])
    if (!Number.isFinite(scale) || scale <= 0) return false
    // Separate uniform metre->view-pixel scale from rotation/translation, so Sprite's
    // camera-facing plane and Line2's perspective detection operate in metre space.
    this.scale.makeScale(1 / scale, 1 / scale, 1 / scale)
    this.camera.matrixWorldInverse.multiplyMatrices(this.scale, this.view)
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert()
    this.camera.matrix.copy(this.camera.matrixWorld)
    this.scale.makeScale(scale, scale, scale)
    this.camera.projectionMatrix.multiply(this.scale)
    for (let index = 0; index < 16; index++) this.camera.projectionMatrix.elements[index] /= scale
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
    this.camera.near = args.nearZ / scale; this.camera.far = args.farZ / scale
    this.camera.fov = THREE.MathUtils.radToDeg(args.fov)
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0); this.up.setFromMatrixColumn(this.camera.matrixWorld, 1)
    return this.camera.matrixWorld.elements.every(Number.isFinite)
  }

  private render(args: CustomRenderMethodInput): void {
    if (!this.renderer || !this.scene || this.disposed || this.options.visible === false) return
    const canvas = this.map.getCanvas(), width = canvas.clientWidth || this.map.transform.width, height = canvas.clientHeight || this.map.transform.height
    this.lastWidth = width; this.lastHeight = height
    this.matchWorldCopy()
    if (width <= 0 || height <= 0 || !this.prepareCamera(args)) {this.root.hidden = true; return}
    this.activeFrame = true; this.root.hidden = false; this.scene.visible = true
    this.lineMaterial?.resolution.set(width, height)
    const unitsPerDepth = 2 * Math.tan(args.fov / 2) / height
    const ends = this.map.getStyle()?.sources?.[TRACK_ENDS_SOURCE]
    const endpoints = ends?.type === 'geojson' && typeof ends.data === 'object' && ends.data.type === 'FeatureCollection'
      ? ends.data.features.flatMap(feature => feature.geometry?.type === 'Point' ? [feature.geometry.coordinates] : []) : []
    for (const entry of this.entries.values()) {
      this.updatePosition(entry)
      const anchorDepth = -this.viewPoint.copy(entry.sphere.position).applyMatrix4(this.camera.matrixWorldInverse).z
      const headDepth = -this.viewPoint.copy(entry.label.position).applyMatrix4(this.camera.matrixWorldInverse).z
      const radius = endpoints.some(point => point[0] === entry.point.coordinates[0] && point[1] === entry.point.coordinates[1]) ? 5 : 3.5
      entry.sphere.scale.setScalar(Math.max(this.camera.near, anchorDepth) * unitsPerDepth * radius)
      const units = Math.max(this.camera.near, headDepth) * unitsPerDepth
      entry.label.scale.set(entry.width * units, entry.height * units, 1)
      // All parts stay submitted: the native terrain depth buffer clips each pixel.
      entry.node.visible = true
      const shown = headDepth >= this.camera.near && headDepth <= this.camera.far && this.hasVisibleLabel(entry, units)
      entry.button.hidden = !shown; entry.button.style.display = shown ? '' : 'none'
      if (shown) {
        this.projected.copy(entry.label.position).project(this.camera)
        entry.button.style.left = `${(this.projected.x + 1) * width / 2}px`; entry.button.style.top = `${(1 - this.projected.y) * height / 2}px`
      }
    }
    this.renderer.resetState()
    // Never resize/clear the shared canvas, or clear MapLibre's terrain depth.
    this.renderer.setViewport(0, 0, canvas.width, canvas.height)
    this.renderer.render(this.scene, this.camera)
  }

  private hasVisibleLabel(entry: Entry, units: number): boolean {
    const half = Math.max(0, entry.width / 2 - 6), middle = entry.height / 2
    for (const [x, y] of [[0, middle], [-half, 4], [half, 4], [-half, entry.height - 4], [half, entry.height - 4], [0, 4], [0, entry.height - 4], [-half, middle], [half, middle]]) {
      this.sample.copy(entry.label.position).addScaledVector(this.right, x * units).addScaledVector(this.up, y * units)
      this.projected.copy(this.sample).project(this.camera)
      const {x: px, y: py, z} = this.projected
      if ([px, py, z].every(Number.isFinite) && Math.abs(px) <= 1 && Math.abs(py) <= 1 && z >= -1 && z <= 1
        && !terrainCovers(this.map, this.projected, this.lastWidth, this.lastHeight)) return true
    }
    return false
  }

  private canPick(entry: Entry, event: MouseEvent): boolean {
    if (!this.activeFrame || this.lastWidth <= 0 || this.lastHeight <= 0) return false
    if (event.detail === 0) return true
    const rect = this.root.getBoundingClientRect()
    const x = (event.clientX - rect.left) / (rect.width || this.lastWidth) * this.lastWidth
    const y = (event.clientY - rect.top) / (rect.height || this.lastHeight) * this.lastHeight
    this.projected.copy(entry.label.position).project(this.camera)
    const depth = -this.viewPoint.copy(entry.label.position).applyMatrix4(this.camera.matrixWorldInverse).z
    const units = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * depth / this.lastHeight
    this.sample.copy(entry.label.position).addScaledVector(this.right, (x - (this.projected.x + 1) * this.lastWidth / 2) * units)
      .addScaledVector(this.up, ((1 - this.projected.y) * this.lastHeight / 2 - y) * units)
    this.projected.copy(this.sample).project(this.camera)
    return !terrainCovers(this.map, this.projected, this.lastWidth, this.lastHeight)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.map.off('styledata', this.restoreLayer); this.map.off('terrain', this.redraw)
    this.map.off('sourcedata', this.redraw); this.map.off('webglcontextrestored', this.redraw)
    if (this.map.getLayer(this.layer.id)) this.map.removeLayer(this.layer.id)
    this.release(); this.root.remove()
  }

  private remove(entry: Entry): void {
    entry.button.onclick = null; entry.button.onpointerdown = null; entry.button.onkeydown = null
    entry.button.remove(); entry.node.removeFromParent(); entry.line.geometry.dispose()
    entry.label.material.map?.dispose(); entry.label.material.dispose()
  }
  private release(): void {
    this.activeFrame = false
    for (const entry of this.entries.values()) this.remove(entry)
    this.entries.clear(); this.scene?.clear(); this.scene = null
    this.sphereGeometry?.dispose(); this.sphereGeometry = null
    this.sphereMaterial?.dispose(); this.sphereMaterial = null
    this.lineMaterial?.dispose(); this.lineMaterial = null
    // dispose releases this renderer's resources; it must never lose the shared context.
    this.renderer?.dispose(); this.renderer = null
    this.root.hidden = true
  }
}
