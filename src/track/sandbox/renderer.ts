/**
 * Three.js terrain view. DEM/texture construction is separate from live lighting
 * and camera changes, so controls redraw without fetching or rebuilding terrain.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { TrackPoint } from '../../protocol.ts'
import { DEFAULT_SANDBOX_COLORS, DEFAULT_SANDBOX_LIGHTING, sanitizeLighting, sanitizeSandboxColors,
  type SandboxBackground, type SandboxColors, type SandboxLighting, type SandboxQuality } from '../map-settings.ts'
import { TRACK_COLOR } from '../trail-layer.ts'
import { routePaths, sceneHeight, triangleElevation, terrainModel, terrainSides, terrainTop, type GeometryData, type TerrainModel, type SandboxPosition } from './geometry.ts'
import { terrainPosition } from './coordinates.ts'
import type { SandboxCameraState, SandboxPlacemark, TerrainGrid } from './types.ts'
import { SANDBOX_ENDPOINT_RADIUS, SandboxPlacemarkLayer, type SandboxPlacemarkOptions } from './placemarks.ts'
import { createSandboxEnvironment, type SandboxEnvironment } from './environment.ts'
import { SandboxTerrainOcclusion } from './occlusion.ts'

interface Disposable { dispose(): void }
interface RouteLine {
  line: Line2
  path: SandboxPosition[]
  cumulative: number[]
  offset: number
  distance: number
  trimmedSegment: number | null
}
export interface SandboxRenderOptions {
  exaggeration?: number
  quality?: SandboxQuality
  lighting?: SandboxLighting
  colors?: SandboxColors
  background?: SandboxBackground
  routeColor?: string
  segmentStarts?: readonly number[]
}

export class SandboxRenderer {
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private controls: OrbitControls | null = null
  private observer: ResizeObserver | null = null
  private frame = 0
  private terrain: TerrainGrid | null = null
  private model: TerrainModel | null = null
  private placemarks: SandboxPlacemarkLayer | null = null
  private occlusion: SandboxTerrainOcclusion | null = null
  private disposed = false
  private assets = new Set<Disposable>()
  private lineMaterial: LineMaterial | null = null
  private sideMaterial: THREE.MeshBasicMaterial | null = null
  private ambient: THREE.HemisphereLight | null = null
  private directional: THREE.DirectionalLight | null = null
  private shadowBounds: {width: number; depth: number; height: number} | null = null
  private quality: SandboxQuality = 'standard'
  private colors: SandboxColors = {...DEFAULT_SANDBOX_COLORS}
  private backgroundMode: SandboxBackground = 'solid'
  private environment: SandboxEnvironment | null = null
  private environmentBase: string | null = null
  private ambientLevel = DEFAULT_SANDBOX_LIGHTING.ambient
  private fit: {target: THREE.Vector3; direction: THREE.Vector3; radius: number} | null = null
  private interactionEnabled = true
  private frameListeners = new Set<() => void>()
  private routeLines: RouteLine[] = []
  private routeDistance = 0
  private routeProgress = 1
  private endpointMarkers: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = []
  private markerView = new THREE.Vector3()
  private markerProjection = new THREE.Vector3()

  private contextLost = () => {
    if (this.disposed) return
    this.dispose()
    this.onContextLost?.()
  }
  private requestRender = () => {
    if (this.frame || this.disposed || !this.scene) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.disposed || !this.renderer || !this.scene || !this.camera) return
      const changing = this.interactionEnabled && this.controls?.update()
      this.projectPlacemarks()
      this.renderer.render(this.scene, this.camera)
      this.notifyFrameRendered()
      if (changing) this.requestRender()
    })
  }

  constructor(private container: HTMLDivElement, private onContextLost?: () => void) {
    try {
      const renderer = this.renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true,
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.domElement.className = 'trk-sandbox-canvas'
      renderer.domElement.addEventListener('webglcontextlost', this.contextLost)
      renderer.domElement.setAttribute('aria-label', '3D 地形沙盘，可以旋转、平移和缩放')
      container.appendChild(renderer.domElement)
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(container)
      this.resize()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  build(terrain: TerrainGrid, points: readonly TrackPoint[], canvas: HTMLCanvasElement | null,
    options: SandboxRenderOptions = {}): void {
    if (this.disposed || !this.renderer) throw new Error('沙盘渲染器已关闭')
    this.clearScene()
    try {
      this.quality = options.quality ?? 'standard'
      const model = this.model = terrainModel(terrain, options.exaggeration)
      this.terrain = terrain
      this.occlusion = new SandboxTerrainOcclusion(terrain, model)
      const scene = this.scene = new THREE.Scene()
      const topGeometry = this.geometry(terrainTop(terrain, model))
      let texture: THREE.CanvasTexture | null = null
      if (canvas) {
        texture = this.own(new THREE.CanvasTexture(canvas))
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
      }
      const topMaterial = this.own(new THREE.MeshStandardMaterial({
        map: texture, vertexColors: !texture, roughness: 0.95, metalness: 0,
      }))
      const top = new THREE.Mesh(topGeometry, topMaterial)
      top.castShadow = top.receiveShadow = true
      scene.add(top)

      // Cut faces keep their chosen color even with the terrain lighting off.
      const sideMaterial = this.sideMaterial = this.own(new THREE.MeshBasicMaterial({
        color: DEFAULT_SANDBOX_COLORS.sides, side: THREE.DoubleSide, toneMapped: false,
      }))
      const sides = new THREE.Mesh(this.geometry(terrainSides(terrain, model)), sideMaterial)
      sides.castShadow = sides.receiveShadow = true
      scene.add(sides)
      const bottomGeometry = this.own(new THREE.PlaneGeometry(terrain.widthMeters, terrain.depthMeters))
      bottomGeometry.rotateX(Math.PI / 2)
      scene.add(new THREE.Mesh(bottomGeometry, sideMaterial))
      this.updateColors(options.colors ?? DEFAULT_SANDBOX_COLORS)

      const paths = routePaths(points, terrain, model, options.segmentStarts)
      const material = this.lineMaterial = this.own(new LineMaterial({
        color: options.routeColor ?? TRACK_COLOR, linewidth: 4, worldUnits: false,
      }))
      // Independent Line2 objects never bridge a GPX segment gap.
      for (const path of paths) {
        if (path.length < 2) continue
        const geometry = this.own(new LineGeometry())
        geometry.setPositions(path.flatMap(point => [point.x, point.y, point.z]))
        const line = new Line2(geometry, material), cumulative = [0]
        for (let index = 1; index < path.length; index++) cumulative.push(cumulative[index - 1]
          + Math.hypot(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z))
        const distance = cumulative[cumulative.length - 1]
        this.routeLines.push({line, path, cumulative, offset: this.routeDistance, distance, trimmedSegment: null})
        this.routeDistance += distance
        scene.add(line)
      }

      const markerGeometry = this.own(new THREE.SphereGeometry(1, 16, 12))
      const lastPath = paths[paths.length - 1]
      for (const [point, color, name] of [[paths[0]?.[0], '#4ade80', 'sandbox-route-start'],
        [lastPath?.[lastPath.length - 1], '#f87171', 'sandbox-route-end']] as const) {
        if (!point) continue
        const markerMaterial = this.own(new THREE.MeshBasicMaterial({
          color, toneMapped: false, depthTest: true, depthWrite: false,
        }))
        const marker = new THREE.Mesh(markerGeometry, markerMaterial)
        marker.name = name; marker.renderOrder = 11
        marker.position.set(point.x, point.y, point.z)
        this.endpointMarkers.push(marker)
        scene.add(marker)
      }

      this.ambient = new THREE.HemisphereLight(0xffffff, 0x334155, 0.65)
      scene.add(this.ambient)
      this.directional = this.own(new THREE.DirectionalLight(0xffffff, 2))
      this.directional.target.position.set(0, model.topHeight / 2, 0)
      scene.add(this.directional, this.directional.target)
      const maximumDimension = Math.max(terrain.widthMeters, terrain.depthMeters)
      this.shadowBounds = {width: terrain.widthMeters, depth: terrain.depthMeters, height: model.topHeight}
      this.updateLighting(options.lighting ?? DEFAULT_SANDBOX_LIGHTING)
      this.updateBackground(options.background ?? 'solid')

      const camera = this.camera = new THREE.PerspectiveCamera(
        38, Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight),
        Math.max(0.1, maximumDimension / 10000), maximumDimension * 50 + model.topHeight * 10,
      )
      const controls = this.controls = new OrbitControls(camera, this.renderer.domElement)
      controls.enabled = this.interactionEnabled
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = maximumDimension * 0.2
      controls.maxDistance = maximumDimension * 12 + model.topHeight * 5
      controls.maxPolarAngle = Math.PI * 0.49
      controls.addEventListener('change', this.requestRender)
      controls.addEventListener('start', this.requestRender)
      controls.addEventListener('end', this.requestRender)
      this.fit = {
        target: new THREE.Vector3(0, model.topHeight / 2, 0),
        direction: new THREE.Vector3(0.78, 0.7, 1).normalize(),
        radius: Math.hypot(terrain.widthMeters / 2, terrain.depthMeters / 2, model.topHeight / 2),
      }
      this.resize()
      this.resetView()
      this.requestRender()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Recolor the shared route material without resampling terrain or changing the view. */
  updateRouteColor(color: string): void {
    if (!this.lineMaterial) return
    this.lineMaterial.color.set(color)
    this.requestRender()
  }

  /** Marker changes reuse terrain and camera; the label layer owns its visual resources. */
  updatePlacemarks(placemarks: readonly SandboxPlacemark[], options: SandboxPlacemarkOptions = {}): void {
    if (this.disposed || !this.scene || !this.terrain || !this.model || !this.camera) return
    this.placemarks ??= new SandboxPlacemarkLayer(this.container, this.terrain, this.model, this.scene,
      this.endpointMarkers.map(marker => marker.position), this.occlusion ?? undefined)
    this.placemarks.update(placemarks, options)
    this.projectPlacemarks()
    this.requestRender()
  }

  private projectPlacemarks(): void {
    const camera = this.camera
    if (!camera) return
    const width = this.container.clientWidth, height = this.container.clientHeight
    camera.updateMatrixWorld()
    this.placemarks?.project(camera, width, height)
    const radiusPerDistance = height > 0
      ? 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height * SANDBOX_ENDPOINT_RADIUS : 0
    for (const marker of this.endpointMarkers) {
      const distance = -this.markerView.copy(marker.position).applyMatrix4(camera.matrixWorldInverse).z
      const {x, y, z} = this.markerProjection.copy(marker.position).project(camera)
      marker.visible = width > 0 && height > 0 && distance >= camera.near && distance <= camera.far
        && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        && Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1
        && !this.placemarks?.hasVisibleAnchorAt(marker.position)
      if (marker.visible) marker.scale.setScalar(distance * radiusPerDistance)
    }
  }

  /** Live colors share the existing cut-face material and remain part of canvas captures. */
  updateColors(value: SandboxColors): void {
    if (!this.scene || !this.sideMaterial) return
    const colors = sanitizeSandboxColors(value)
    this.sideMaterial.color.set(colors.sides)
    this.colors = colors
    this.refreshBackground()
    this.requestRender()
  }

  /** Switching surroundings changes no terrain geometry, sampling, or camera state. */
  updateBackground(mode: SandboxBackground): void {
    if (!this.scene || !this.renderer) return
    this.backgroundMode = mode === 'environment' ? 'environment' : 'solid'
    this.refreshBackground()
    this.requestRender()
  }

  private refreshBackground(): void {
    if (!this.scene || !this.renderer) return
    if (this.backgroundMode === 'environment') {
      if (this.environmentBase === this.colors.background) return
      this.releaseEnvironment()
      this.environmentBase = this.colors.background
      try {
        this.environment = createSandboxEnvironment(this.renderer, this.colors.background)
        this.scene.background = this.environment.panorama
        this.scene.environment = this.environment.lighting.texture
      } catch {
        // Keep the loaded terrain usable on devices without environment-map support.
        this.scene.background = new THREE.Color(this.colors.background)
      }
    } else {
      this.releaseEnvironment()
      if (this.scene.background instanceof THREE.Color) this.scene.background.set(this.colors.background)
      else this.scene.background = new THREE.Color(this.colors.background)
    }
    this.syncAmbient()
  }

  private syncAmbient(): void {
    if (this.scene) this.scene.environmentIntensity = this.environment ? this.ambientLevel : 0
    if (this.ambient) this.ambient.intensity = this.environment ? 0 : this.ambientLevel
  }

  private releaseEnvironment(): void {
    const environment = this.environment
    this.environment = null
    this.environmentBase = null
    if (this.scene) {
      if (this.scene.background === environment?.panorama) this.scene.background = null
      this.scene.environment = null
      this.scene.environmentIntensity = 0
    }
    environment?.panorama.dispose()
    environment?.lighting.dispose()
  }

  /** North is -Z; east is +X. Changing these values never rebuilds the mesh. */
  updateLighting(value: SandboxLighting): void {
    if (!this.renderer || !this.ambient || !this.directional || !this.shadowBounds) return
    const lighting = sanitizeLighting(value)
    this.ambientLevel = lighting.ambient
    this.syncAmbient()
    const light = this.directional
    light.intensity = lighting.intensity
    const {width, depth, height} = this.shadowBounds
    const radius = Math.max(1, Math.hypot(width / 2, depth / 2, height / 2))
    const azimuth = THREE.MathUtils.degToRad(lighting.azimuth)
    const elevation = THREE.MathUtils.degToRad(lighting.elevation)
    light.position.copy(light.target.position).add(new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    ).multiplyScalar(radius * 3))
    const enabled = lighting.shadows && this.quality !== 'eco'
    light.castShadow = enabled
    this.renderer.shadowMap.enabled = enabled
    const size = Math.min(2048, this.renderer.capabilities.maxTextureSize || 2048)
    light.shadow.mapSize.set(size, size)
    light.shadow.bias = -0.00005
    light.shadow.normalBias = radius * 0.0001
    // Fit the actual eight terrain bounds in the light's view, not a fixed box.
    const camera = light.shadow.camera
    camera.position.copy(light.position)
    camera.lookAt(light.target.position)
    camera.updateMatrixWorld()
    const corners = [-width / 2, width / 2].flatMap(x => [0, height].flatMap(y =>
      [-depth / 2, depth / 2].map(z => new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse))))
    const margin = Math.max(2, radius * 0.02)
    camera.left = Math.min(...corners.map(point => point.x)) - margin
    camera.right = Math.max(...corners.map(point => point.x)) + margin
    camera.bottom = Math.min(...corners.map(point => point.y)) - margin
    camera.top = Math.max(...corners.map(point => point.y)) + margin
    camera.near = Math.max(0.1, Math.min(...corners.map(point => -point.z)) - margin)
    camera.far = Math.max(camera.near + 1, Math.max(...corners.map(point => -point.z)) + margin)
    camera.updateProjectionMatrix()
    light.shadow.needsUpdate = true
    this.requestRender()
  }

  getCaptureCanvas(): HTMLCanvasElement | null { return this.renderer?.domElement ?? null }

  getCameraState(): SandboxCameraState | null {
    if (!this.camera || !this.controls || this.disposed) return null
    const {position, fov} = this.camera, {target} = this.controls
    return {position: [position.x, position.y, position.z], target: [target.x, target.y, target.z], fov}
  }

  /** Apply an absolute state without allowing OrbitControls damping to modify it. */
  applyCameraState(state: SandboxCameraState): void {
    if (!this.camera || !this.controls || this.disposed) return
    if (![state.position, state.target].every(vector => Array.isArray(vector) && vector.length === 3
      && vector.every(value => Number.isFinite(value) && Math.abs(value) <= 1e9))
      || !Number.isFinite(state.fov) || state.fov < 5 || state.fov > 120
      || Math.hypot(...state.position.map((value, index) => value - state.target[index])) < 1e-6) {
      throw new RangeError('沙盘相机状态无效')
    }
    this.camera.position.set(...state.position)
    this.controls.target.set(...state.target)
    this.camera.fov = state.fov
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(this.controls.target)
    this.camera.updateMatrixWorld()
    this.projectPlacemarks()
    this.requestRender()
  }

  setInteractionEnabled(enabled: boolean): void {
    if (this.disposed || this.interactionEnabled === enabled) return
    const snapshot = this.getCameraState()
    this.interactionEnabled = enabled
    if (this.controls) {
      this.controls.enabled = enabled
      if (enabled && snapshot) {
        // Flush residual damping only when returning to manual editing, then
        // restore the exact last evaluated camera before the next paint.
        const damping = this.controls.enableDamping
        this.controls.enableDamping = false
        this.controls.update()
        this.applyCameraState(snapshot)
        this.controls.enableDamping = damping
      }
    }
    this.requestRender()
  }

  onFrameRendered(callback: () => void): () => void {
    if (this.disposed) return () => {}
    this.frameListeners.add(callback)
    return () => { this.frameListeners.delete(callback) }
  }

  private notifyFrameRendered(): void {
    for (const callback of [...this.frameListeners]) {
      try { callback() } catch { /* A consumer must not stop the renderer's lifecycle. */ }
    }
  }

  /** Clip already draped line instances; no terrain or line geometry is rebuilt. */
  setRouteProgress(progress: number): void {
    if (!Number.isFinite(progress)) throw new RangeError('路线进度必须是有限数值')
    if (this.disposed) return
    const next = Math.max(0, Math.min(1, progress))
    if (next === this.routeProgress) return
    this.routeProgress = next
    const travelled = next * this.routeDistance
    for (const entry of this.routeLines) {
      const geometry = entry.line.geometry, ends = geometry.getAttribute('instanceEnd')
      if (entry.trimmedSegment !== null) {
        const point = entry.path[entry.trimmedSegment + 1]
        ends.setXYZ(entry.trimmedSegment, point.x, point.y, point.z)
        ends.needsUpdate = true
        entry.trimmedSegment = null
      }
      const distance = Math.max(0, Math.min(entry.distance, travelled - entry.offset))
      if (next <= 0 || distance <= 0 && next < 1) {
        geometry.instanceCount = 0
        entry.line.visible = false
        continue
      }
      entry.line.visible = true
      if (distance >= entry.distance) { geometry.instanceCount = entry.path.length - 1; continue }
      let index = 0
      while (index < entry.path.length - 2 && entry.cumulative[index + 1] <= distance) index++
      const from = entry.path[index], to = entry.path[index + 1]
      const length = entry.cumulative[index + 1] - entry.cumulative[index]
      const fraction = length > 0 ? (distance - entry.cumulative[index]) / length : 1
      ends.setXYZ(index, from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction,
        from.z + (to.z - from.z) * fraction)
      ends.needsUpdate = true
      entry.trimmedSegment = index
      geometry.instanceCount = index + 1
    }
    this.requestRender()
  }

  /** Projection into CSS pixels, anchored to the same DEM triangles as the route. */
  projectCoordinates(coordinates: readonly [number, number], raise = 0): {x: number; y: number; visible: boolean} {
    const hidden = {x: 0, y: 0, visible: false}
    if (!this.camera || !this.terrain || !this.model || this.disposed || !Number.isFinite(raise)
      || !coordinates.every(Number.isFinite)) return hidden
    const [lon, lat] = coordinates, [west, south, east, north] = this.terrain.bounds
    if (lon < west || lon > east || lat < south || lat > north) return hidden
    const {x, z} = terrainPosition(lon, lat, this.terrain)
    const point = new THREE.Vector3(x, sceneHeight(triangleElevation(x, z, this.terrain), this.model) + raise, z)
    this.camera.updateMatrixWorld()
    const distance = -point.clone().applyMatrix4(this.camera.matrixWorldInverse).z
    const projected = point.project(this.camera)
    const width = this.container.clientWidth, height = this.container.clientHeight
    return {x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2,
      visible: width > 0 && height > 0 && distance >= this.camera.near && distance <= this.camera.far
        && Number.isFinite(projected.x) && Number.isFinite(projected.y) && Number.isFinite(projected.z)
        && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z >= -1 && projected.z <= 1}
  }

  /** Synchronous redraw for a future frame recorder. */
  renderFrame(): void {
    if (!this.renderer || !this.scene || !this.camera || this.disposed) return
    if (this.interactionEnabled) this.controls?.update()
    this.projectPlacemarks()
    this.renderer.render(this.scene, this.camera)
    this.notifyFrameRendered()
  }

  zoomIn(): void { this.zoom(1 / 1.25) }
  zoomOut(): void { this.zoom(1.25) }

  resetView(): void {
    if (!this.camera || !this.controls || !this.fit) return
    const verticalHalfFov = THREE.MathUtils.degToRad(this.camera.fov / 2)
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * this.camera.aspect)
    const distance = this.fit.radius * 1.15 / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))
    this.controls.maxDistance = Math.max(this.controls.maxDistance, distance * 3)
    this.controls.target.copy(this.fit.target)
    this.camera.position.copy(this.fit.target).addScaledVector(this.fit.direction, distance)
    if (this.interactionEnabled) this.controls.update()
    else this.camera.lookAt(this.controls.target)
    this.projectPlacemarks()
    this.requestRender()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost)
    this.observer?.disconnect()
    this.observer = null
    this.clearScene()
    this.frameListeners.clear()
    const renderer = this.renderer
    this.renderer = null
    if (renderer) {
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }

  private own<T extends Disposable>(resource: T): T {
    this.assets.add(resource)
    return resource
  }

  private geometry(data: GeometryData): THREE.BufferGeometry {
    const geometry = this.own(new THREE.BufferGeometry())
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))
    if (data.colors) geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3))
    if (data.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2))
    geometry.computeVertexNormals()
    return geometry
  }

  private zoom(factor: number): void {
    if (!this.camera || !this.controls) return
    const offset = this.camera.position.clone().sub(this.controls.target)
    const distance = Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, offset.length() * factor))
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance))
    if (this.interactionEnabled) this.controls.update()
    else this.camera.lookAt(this.controls.target)
    this.projectPlacemarks()
    this.requestRender()
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.renderer?.setSize(width, height, false)
    if (this.camera) {
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
    this.lineMaterial?.resolution.set(width, height)
    this.projectPlacemarks()
    this.requestRender()
  }

  private clearScene(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.controls?.removeEventListener('change', this.requestRender)
    this.controls?.removeEventListener('start', this.requestRender)
    this.controls?.removeEventListener('end', this.requestRender)
    this.controls?.dispose()
    this.controls = null
    this.placemarks?.dispose()
    this.placemarks = null
    this.terrain = null
    this.model = null
    this.occlusion = null
    this.releaseEnvironment()
    for (const resource of this.assets) resource.dispose()
    this.assets.clear()
    this.scene?.clear()
    this.scene = null
    this.camera = null
    this.fit = null
    this.lineMaterial = null
    this.routeLines = []
    this.endpointMarkers = []
    this.routeDistance = 0
    this.routeProgress = 1
    this.sideMaterial = null
    this.ambient = null
    this.directional = null
    this.shadowBounds = null
    this.colors = {...DEFAULT_SANDBOX_COLORS}
    this.backgroundMode = 'solid'
    this.ambientLevel = DEFAULT_SANDBOX_LIGHTING.ambient
  }
}
