// @vitest-environment jsdom
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { TRACK_COLOR } from '../src/track/trail-layer.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandboxRenderer } from '../src/track/sandbox/renderer.ts'
import { DEFAULT_MAP_SETTINGS, DEFAULT_SANDBOX_COLORS, DEFAULT_SANDBOX_LIGHTING, sanitizeSandboxLabelHeight } from '../src/track/map-settings.ts'
import { sceneHeight, triangleElevation, terrainModel } from '../src/track/sandbox/geometry.ts'
import type { TerrainGrid } from '../src/track/sandbox/types.ts'
import { createSandboxPanorama } from '../src/track/sandbox/environment.ts'
import { gridCoordinate, terrainPosition } from '../src/track/sandbox/coordinates.ts'
import { SandboxPlacemarkLayer } from '../src/track/sandbox/placemarks.ts'

const webgl = vi.hoisted(() => ({
  dispose: vi.fn(), forceContextLoss: vi.fn(), render: vi.fn(), instances: [] as unknown[],
  setSize: vi.fn(), setPixelRatio: vi.fn(), getMaxAnisotropy: vi.fn(() => 16),
}))

const pmrem = vi.hoisted(() => ({generate: vi.fn(), dispose: vi.fn(), fail: false, targets: [] as unknown[]}))

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  return {
    ...actual,
    WebGLRenderer: class {
      constructor() { webgl.instances.push(this) }
      domElement = document.createElement('canvas')
      capabilities = {getMaxAnisotropy: webgl.getMaxAnisotropy, maxTextureSize: 4096}
      outputColorSpace = ''
      autoClear = true
      xr = {enabled: true}
      renderTarget: import('three').WebGLRenderTarget | null = null
      getRenderTarget = () => this.renderTarget
      getActiveCubeFace = () => 0
      getActiveMipmapLevel = () => 0
      setRenderTarget = (target: import('three').WebGLRenderTarget | null) => { this.renderTarget = target }
      shadowMap = {enabled: false, type: 0}
      setPixelRatio = webgl.setPixelRatio
      setSize = webgl.setSize
      render = webgl.render
      dispose = webgl.dispose
      forceContextLoss = webgl.forceContextLoss
    },
    PMREMGenerator: class {
      private temporary: import('three').WebGLRenderTarget | null = null
      constructor(private renderer: import('three').WebGLRenderer) {}
      fromEquirectangular(texture: import('three').Texture) {
        pmrem.generate(texture)
        const target = new actual.WebGLRenderTarget(336, 256)
        target.texture.mapping = actual.CubeUVReflectionMapping
        this.temporary = new actual.WebGLRenderTarget(336, 256)
        pmrem.targets.push(target, this.temporary)
        this.renderer.xr.enabled = false
        this.renderer.autoClear = false
        this.renderer.setRenderTarget(target)
        this.renderer.setRenderTarget(this.temporary)
        if (pmrem.fail) throw new Error('environment unavailable')
        return target
      }
      dispose() {
        pmrem.dispose()
        this.temporary?.dispose()
        this.temporary = null
      }
    },
  }
})

const terrain: TerrainGrid = {
  bounds: [120, 30, 120.02, 30.02], columns: 2, rows: 2,
  widthMeters: 1000, depthMeters: 1000, elevations: [100, 300, 200, 400],
}

const resize = {observe: vi.fn(), disconnect: vi.fn()}
let frames: FrameRequestCallback[] = []
let resizeCallback: ResizeObserverCallback | null = null
let labelPaints = new WeakMap<HTMLCanvasElement, {texts: string[]; colors: string[]}>()
let labelFonts = new WeakMap<HTMLCanvasElement, string[]>()
const animation = vi.fn((callback: FrameRequestCallback) => {
  frames.push(callback)
  return frames.length
})
const cancel = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  frames = []
  resizeCallback = null
  pmrem.fail = false
  pmrem.targets = []
  webgl.instances = []
  webgl.getMaxAnisotropy.mockImplementation(() => 16)
  labelPaints = new WeakMap()
  labelFonts = new WeakMap()
  // Keep real Three textures and materials; jsdom only needs a local drawing context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null
    const paint = {texts: [] as string[], colors: [] as string[]}
    labelPaints.set(this, paint)
    const fonts: string[] = []; labelFonts.set(this, fonts)
    return {
      canvas: this, font: '', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1,
      textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter',
      measureText: vi.fn(function(this: CanvasRenderingContext2D, text: string) {
        const size = Number(this.font.match(/(\d+)px/)?.[1] ?? 16)
        return {width: Array.from(text).length * size}
      }),
      scale: vi.fn(), clearRect: vi.fn(), strokeText: vi.fn(),
      fillText: vi.fn(function(this: CanvasRenderingContext2D, text: string) {
        paint.texts.push(text); paint.colors.push(String(this.fillStyle)); fonts.push(this.font)
      }),
    } as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext)
  vi.stubGlobal('requestAnimationFrame', animation)
  vi.stubGlobal('cancelAnimationFrame', cancel)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
    observe = resize.observe
    disconnect = resize.disconnect
  })
  Object.defineProperty(window, 'devicePixelRatio', {value: 3, configurable: true})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function container(): HTMLDivElement {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    clientWidth: {value: 900, configurable: true},
    clientHeight: {value: 600, configurable: true},
  })
  document.body.appendChild(element)
  return element
}

function drawFrame(): {scene: THREE.Scene; camera: THREE.PerspectiveCamera} {
  frames[frames.length - 1](0)
  const last = webgl.render.mock.calls[webgl.render.mock.calls.length - 1]
  return {scene: last[0], camera: last[1]}
}

function watchDisposal(scene: THREE.Scene): (() => void)[] {
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>()
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Sprite)) return
    if (object instanceof THREE.Mesh) resources.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      resources.add(material)
      const texture = (material as THREE.MeshStandardMaterial).map
      if (texture) resources.add(texture)
    }
  })
  return [...resources].map(resource => {
    const listener = vi.fn()
    resource.addEventListener('dispose', listener)
    return listener
  })
}


function placemarkVisuals(scene: THREE.Scene, id: string) {
  const group = scene.getObjectByName('sandbox-placemarks') as THREE.Group
  expect(group).toBeInstanceOf(THREE.Group)
  const node = group.children.find(child => child.userData.id === id) as THREE.Group
  expect(node).toBeInstanceOf(THREE.Group)
  const sphere = node.getObjectByName('placemark-anchor') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  const connector = node.getObjectByName('placemark-connector') as Line2
  const label = node.getObjectByName('placemark-label') as THREE.Sprite
  expect(sphere).toBeInstanceOf(THREE.Mesh)
  expect(connector).toBeInstanceOf(Line2)
  expect(label).toBeInstanceOf(THREE.Sprite)
  return {group, node, sphere, connector, label}
}

function connectorEnds(connector: Line2): THREE.Vector3[] {
  connector.updateWorldMatrix(true, false)
  return ['instanceStart', 'instanceEnd'].map(name => {
    const attribute = connector.geometry.getAttribute(name)
    return new THREE.Vector3(attribute.getX(0), attribute.getY(0), attribute.getZ(0)).applyMatrix4(connector.matrixWorld)
  })
}

function terrainSurface(scene: THREE.Scene): THREE.Mesh {
  const surface = scene.children.find(object => object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) as THREE.Mesh
  expect(surface).toBeInstanceOf(THREE.Mesh)
  return surface
}

// Use real Three triangle intersections as an independent check of the DEM fixture.
function meshBlocksPoint(surface: THREE.Mesh, origin: THREE.Vector3, point: THREE.Vector3): boolean {
  surface.updateWorldMatrix(true, false)
  const direction = point.clone().sub(origin), distance = direction.length()
  const ray = new THREE.Raycaster(origin, direction.normalize(), 0, Math.max(0, distance - .001))
  return ray.intersectObject(surface, false).length > 0
}

function projectedDiameter(sphere: THREE.Mesh<THREE.SphereGeometry>, camera: THREE.PerspectiveCamera, width: number): number {
  camera.updateMatrixWorld(); sphere.updateWorldMatrix(true, false)
  const center = sphere.getWorldPosition(new THREE.Vector3())
  const radius = sphere.geometry.parameters.radius * sphere.getWorldScale(new THREE.Vector3()).x
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(radius)
  const a = center.clone().sub(right).project(camera), b = center.clone().add(right).project(camera)
  return (b.x - a.x) * width / 2
}

function projectedLabelHeight(label: THREE.Sprite, camera: THREE.PerspectiveCamera, height: number): number {
  camera.updateMatrixWorld(); label.updateWorldMatrix(true, false)
  const bottom = label.getWorldPosition(new THREE.Vector3())
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(label.getWorldScale(new THREE.Vector3()).y)
  const a = bottom.clone().project(camera), b = bottom.add(up).project(camera)
  return (b.y - a.y) * height / 2
}

describe('sandbox renderer lifetime', () => {
  it('releases old scene assets on rebuild and shared assets exactly once on dispose', () => {
    const holder = container()
    const controlDispose = vi.spyOn(OrbitControls.prototype, 'dispose')
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [[120, 30.02, null, null], [120.02, 30, null, null]], document.createElement('canvas'))
    expect(webgl.setPixelRatio).toHaveBeenCalledWith(2)
    const first = watchDisposal(drawFrame().scene)
    sandbox.build(terrain, [[120, 30.02, null, null], [120.02, 30, null, null]], null)
    for (const listener of first) expect(listener).toHaveBeenCalledTimes(1)
    const second = watchDisposal(drawFrame().scene)
    sandbox.dispose()
    sandbox.dispose()
    for (const listener of [...first, ...second]) expect(listener).toHaveBeenCalledTimes(1)
    expect(controlDispose).toHaveBeenCalledTimes(2)
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
    expect(webgl.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(resize.disconnect).toHaveBeenCalledTimes(1)
    expect(holder.children).toHaveLength(0)
    expect(cancel).toHaveBeenCalled()
    holder.remove()
  })

  it('changes zoom distance within limits and restores the fitted view', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {camera} = drawFrame()
    const initial = camera.position.clone()
    const target = new THREE.Vector3(0, (terrain.elevations[3] - terrain.elevations[0]) * 1.25 / 2
      + Math.max(30, Math.hypot(1000, 1000) * 0.025, 300 * 0.15) / 2, 0)
    const distance = camera.position.distanceTo(target)
    sandbox.zoomIn()
    expect(camera.position.distanceTo(target)).toBeCloseTo(distance / 1.25)
    sandbox.zoomOut()
    expect(camera.position.distanceTo(target)).toBeCloseTo(distance)
    for (let index = 0; index < 100; index++) sandbox.zoomIn()
    expect(camera.position.distanceTo(target)).toBeCloseTo(200)
    sandbox.resetView()
    expect(camera.position.distanceTo(initial)).toBeLessThan(1e-8)
    sandbox.dispose()
    holder.remove()
  })

  it('releases the live scene and reports genuine context loss exactly once', () => {
    const holder = container()
    const notify = vi.fn()
    const sandbox = new SandboxRenderer(holder, notify)
    sandbox.build(terrain, [[120, 30.02, null, null], [120.02, 30, null, null]], document.createElement('canvas'))
    const resources = watchDisposal(drawFrame().scene)
    const canvas = holder.querySelector('canvas')!
    const pendingFrame = frames[frames.length - 1]
    const frameCount = frames.length
    canvas.dispatchEvent(new Event('webglcontextlost', {cancelable: true}))
    expect(notify).toHaveBeenCalledTimes(1)
    for (const listener of resources) expect(listener).toHaveBeenCalledTimes(1)
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
    expect(webgl.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(resize.disconnect).toHaveBeenCalledTimes(1)
    expect(holder.children).toHaveLength(0)
    pendingFrame(0)
    expect(frames).toHaveLength(frameCount)
    canvas.dispatchEvent(new Event('webglcontextlost'))
    sandbox.dispose()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it('removes the context-loss listener before intentional renderer cleanup', () => {
    const holder = container()
    const notify = vi.fn()
    const sandbox = new SandboxRenderer(holder, notify)
    sandbox.build(terrain, [], null)
    const canvas = holder.querySelector('canvas')!
    webgl.forceContextLoss.mockImplementationOnce(() => canvas.dispatchEvent(new Event('webglcontextlost')))
    sandbox.dispose()
    expect(webgl.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
    canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(notify).not.toHaveBeenCalled()
    holder.remove()
  })
  it('cleans the canvas and renderer when setup fails after WebGL creation', () => {
    const holder = container()
    vi.stubGlobal('ResizeObserver', class { constructor() { throw new Error('observer unavailable') } })
    expect(() => new SandboxRenderer(holder)).toThrow('observer unavailable')
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
    expect(webgl.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(holder.children).toHaveLength(0)
    holder.remove()
  })

  it('cleans partially allocated texture and geometry when model building fails', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose')
    webgl.getMaxAnisotropy.mockImplementation(() => { throw new Error('device lost') })
    expect(() => sandbox.build(terrain, [], document.createElement('canvas'))).toThrow('device lost')
    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
    expect(resize.disconnect).toHaveBeenCalledTimes(1)
    expect(holder.children).toHaveLength(0)
    sandbox.dispose()
    expect(textureDispose).toHaveBeenCalledTimes(1)
    holder.remove()
  })
})


describe('live sandbox colors and capture', () => {
  it('uses the configured opaque solid background and unlit shared cut faces by default', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene} = drawFrame()
    const [top, sides, bottom] = scene.children.filter(object => object instanceof THREE.Mesh)
    expect(top.material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(sides.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(bottom.material).toBe(sides.material)
    const material = sides.material as THREE.MeshBasicMaterial
    expect(material.color.getHexString()).toBe(DEFAULT_SANDBOX_COLORS.sides.slice(1))
    expect(material.side).toBe(THREE.DoubleSide)
    expect(material.toneMapped).toBe(false)
    expect(material.transparent).toBe(false)
    expect(scene.background).toBeInstanceOf(THREE.Color)
    expect((scene.background as THREE.Color).getHexString()).toBe(DEFAULT_SANDBOX_COLORS.background.slice(1))
    sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING, intensity: 0, ambient: 0, shadows: false})
    sandbox.renderFrame()
    expect(material.color.getHexString()).toBe(DEFAULT_SANDBOX_COLORS.sides.slice(1))
    expect(top.material).toBeInstanceOf(THREE.MeshStandardMaterial)
    sandbox.dispose()
    holder.remove()
  })

  it('updates both colors for rendering and capture without changing meshes, camera, controls or renderer', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const controlDispose = vi.spyOn(OrbitControls.prototype, 'dispose')
    sandbox.build(terrain, [], null, {colors: {sides: '#f1f5f9', background: '#334155'}})
    const {scene, camera} = drawFrame()
    const meshes = scene.children.filter(object => object instanceof THREE.Mesh)
    const resources = meshes.map(mesh => ({geometry: mesh.geometry, material: mesh.material}))
    const disposals = watchDisposal(scene)
    const background = scene.background as THREE.Color
    expect(background.getHexString()).toBe('334155')
    expect((meshes[1].material as THREE.MeshBasicMaterial).color.getHexString()).toBe('f1f5f9')
    const originalCamera = camera.position.clone()
    const originalDirection = camera.quaternion.clone()
    const capture = sandbox.getCaptureCanvas()
    const settled = animation.mock.calls.length
    sandbox.updateColors({sides: '#aabbcc', background: '#172029'})
    expect(animation.mock.calls.length).toBe(settled + 1)
    sandbox.renderFrame()
    const captured = webgl.render.mock.calls[webgl.render.mock.calls.length - 1]
    expect(captured[0]).toBe(scene)
    expect(captured[1]).toBe(camera)
    expect(scene.background).toBe(background)
    expect(background.getHexString()).toBe('172029')
    expect((meshes[1].material as THREE.MeshBasicMaterial).color.getHexString()).toBe('aabbcc')
    expect(meshes[2].material).toBe(meshes[1].material)
    expect(scene.children.filter(object => object instanceof THREE.Mesh)).toEqual(meshes)
    meshes.forEach((mesh, index) => {
      expect(mesh.geometry).toBe(resources[index].geometry)
      expect(mesh.material).toBe(resources[index].material)
    })
    expect(camera.position.distanceTo(originalCamera)).toBeLessThan(1e-7)
    expect(camera.quaternion.angleTo(originalDirection)).toBeLessThan(1e-7)
    expect(sandbox.getCaptureCanvas()).toBe(capture)
    for (const listener of disposals) expect(listener).not.toHaveBeenCalled()
    expect(controlDispose).not.toHaveBeenCalled()
    expect(webgl.dispose).not.toHaveBeenCalled()
    sandbox.dispose()
    const frameCount = animation.mock.calls.length
    sandbox.updateColors({...DEFAULT_SANDBOX_COLORS})
    expect(animation.mock.calls.length).toBe(frameCount)
    for (const listener of disposals) expect(listener).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it('rebuilds with the next colors and updates only the new shared material', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null, {colors: {sides: '#f1f5f9', background: '#334155'}})
    const first = drawFrame().scene
    const oldSides = first.children.filter(object => object instanceof THREE.Mesh)[1].material as THREE.MeshBasicMaterial
    const dispose = vi.fn()
    oldSides.addEventListener('dispose', dispose)
    sandbox.build(terrain, [], null)
    expect(dispose).toHaveBeenCalledTimes(1)
    const second = drawFrame().scene
    expect((second.background as THREE.Color).getHexString()).toBe(DEFAULT_SANDBOX_COLORS.background.slice(1))
    const newSides = second.children.filter(object => object instanceof THREE.Mesh)[1].material as THREE.MeshBasicMaterial
    expect(newSides).not.toBe(oldSides)
    expect(newSides.color.getHexString()).toBe(DEFAULT_SANDBOX_COLORS.sides.slice(1))
    sandbox.updateColors({sides: '#ccddee', background: '#202122'})
    expect(newSides.color.getHexString()).toBe('ccddee')
    expect(oldSides.color.getHexString()).toBe('f1f5f9')
    sandbox.dispose()
    sandbox.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    holder.remove()
  })
})

describe('sandbox spherical environment', () => {
  it('generates a local opaque panorama with sky, horizon and ground bands tinted by the selected base', () => {
    const texture = createSandboxPanorama('#bacaaa')
    expect(texture).toBeInstanceOf(THREE.DataTexture)
    expect(texture.image.width).toBe(256)
    expect(texture.image.height).toBe(128)
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
    const pixels = texture.image.data as Uint8Array
    expect(pixels.filter((_, index) => index % 4 === 3).every(value => value === 255)).toBe(true)
    const sample = (y: number) => Array.from(pixels.slice((y * 256 + 128) * 4, (y * 256 + 128) * 4 + 3))
    expect(sample(0)).not.toEqual(sample(127))
    expect(sample(46)).not.toEqual(sample(0))
    expect(sample(46).reduce((sum, value) => sum + value, 0)).toBeGreaterThan(sample(0).reduce((sum, value) => sum + value, 0))
    const alternate = createSandboxPanorama('#20304f')
    expect(alternate.image.data).not.toEqual(pixels)
    texture.dispose()
    alternate.dispose()
  })

  it('switches backgrounds and capture in place while keeping cut faces constant and ambient lighting controllable', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null, {colors: {sides: '#707070', background: '#bacaaa'}})
    const {scene, camera} = drawFrame()
    const meshes = scene.children.filter(object => object instanceof THREE.Mesh)
    const position = camera.position.clone()
    const direction = camera.quaternion.clone()
    const canvas = sandbox.getCaptureCanvas()
    const resources = watchDisposal(scene)
    sandbox.updateBackground('environment')
    sandbox.renderFrame()
    const background = scene.background as THREE.DataTexture
    const environment = scene.environment
    expect(background).toBeInstanceOf(THREE.DataTexture)
    expect(environment?.mapping).toBe(THREE.CubeUVReflectionMapping)
    expect(scene.environmentIntensity).toBe(DEFAULT_SANDBOX_LIGHTING.ambient)
    const ambient = scene.children.find(object => object instanceof THREE.HemisphereLight) as THREE.HemisphereLight
    const main = scene.children.find(object => object instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    expect(ambient.intensity).toBe(0)
    const captured = webgl.render.mock.calls[webgl.render.mock.calls.length - 1]
    expect(captured[0]).toBe(scene)
    expect(captured[1]).toBe(camera)
    sandbox.updateColors({sides: '#123456', background: '#bacaaa'})
    sandbox.updateBackground('environment')
    expect(scene.background).toBe(background)
    expect(scene.environment).toBe(environment)
    expect(pmrem.generate).toHaveBeenCalledTimes(1)
    expect((meshes[1].material as THREE.MeshBasicMaterial).color.getHexString()).toBe('123456')
    expect(scene.children.filter(object => object instanceof THREE.Mesh)).toEqual(meshes)
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-7)
    expect(camera.quaternion.angleTo(direction)).toBeLessThan(1e-7)
    expect(sandbox.getCaptureCanvas()).toBe(canvas)
    for (const listener of resources) expect(listener).not.toHaveBeenCalled()
    sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING, ambient: 0.2})
    expect(scene.environmentIntensity).toBe(0.2)
    sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING, ambient: 0, intensity: 0, shadows: false})
    expect(scene.environmentIntensity).toBe(0)
    expect(ambient.intensity).toBe(0)
    expect(main.intensity).toBe(0)
    expect((meshes[1].material as THREE.MeshBasicMaterial).color.getHexString()).toBe('123456')
    sandbox.updateBackground('solid')
    expect(scene.background).toBeInstanceOf(THREE.Color)
    expect((scene.background as THREE.Color).getHexString()).toBe('bacaaa')
    expect(scene.environment).toBeNull()
    expect(scene.environmentIntensity).toBe(0)
    expect(scene.children.filter(object => object instanceof THREE.Mesh)).toEqual(meshes)
    sandbox.dispose()
    holder.remove()
  })

  it('releases panorama and PMREM output once on color changes, mode changes, rebuild and repeated disposal', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const textures = vi.spyOn(THREE.DataTexture.prototype, 'dispose')
    const targets = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
    sandbox.build(terrain, [], null, {background: 'environment'})
    const first = drawFrame().scene.background
    expect(pmrem.generate).toHaveBeenCalledTimes(1)
    expect(pmrem.dispose).toHaveBeenCalledTimes(1)
    sandbox.updateColors({...DEFAULT_SANDBOX_COLORS})
    expect(pmrem.generate).toHaveBeenCalledTimes(1)
    sandbox.updateColors({sides: '#707070', background: '#334455'})
    expect(pmrem.generate).toHaveBeenCalledTimes(2)
    expect(textures.mock.contexts.filter(texture => texture === first)).toHaveLength(1)
    sandbox.updateBackground('solid')
    expect(textures).toHaveBeenCalledTimes(2)
    sandbox.updateBackground('environment')
    expect(pmrem.generate).toHaveBeenCalledTimes(3)
    sandbox.build(terrain, [], null, {background: 'environment'})
    expect(pmrem.generate).toHaveBeenCalledTimes(4)
    sandbox.dispose()
    sandbox.dispose()
    expect(textures).toHaveBeenCalledTimes(4)
    expect(pmrem.dispose).toHaveBeenCalledTimes(4)
    for (const target of pmrem.targets) expect(targets.mock.contexts.filter(context => context === target)).toHaveLength(1)
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it('keeps terrain and the selected solid color after failed environment generation and releases interrupted targets', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame()
    const meshes = scene.children.filter(object => object instanceof THREE.Mesh)
    const textures = vi.spyOn(THREE.DataTexture.prototype, 'dispose')
    const targets = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
    const renderer = webgl.instances[0] as THREE.WebGLRenderer
    const setter = renderer.setRenderTarget
    pmrem.fail = true
    sandbox.updateBackground('environment')
    sandbox.renderFrame()
    expect(scene.background).toBeInstanceOf(THREE.Color)
    expect((scene.background as THREE.Color).getHexString()).toBe(DEFAULT_SANDBOX_COLORS.background.slice(1))
    expect(scene.environment).toBeNull()
    expect(scene.environmentIntensity).toBe(0)
    const ambient = scene.children.find(object => object instanceof THREE.HemisphereLight) as THREE.HemisphereLight
    expect(ambient.intensity).toBe(DEFAULT_SANDBOX_LIGHTING.ambient)
    expect(scene.children.filter(object => object instanceof THREE.Mesh)).toEqual(meshes)
    expect(webgl.render.mock.calls[webgl.render.mock.calls.length - 1][1]).toBe(camera)
    expect(textures).toHaveBeenCalledTimes(1)
    for (const target of pmrem.targets) expect(targets.mock.contexts.filter(context => context === target)).toHaveLength(1)
    expect(pmrem.dispose).toHaveBeenCalledTimes(1)
    expect(renderer.setRenderTarget).toBe(setter)
    expect(renderer.getRenderTarget()).toBeNull()
    expect(renderer.xr.enabled).toBe(true)
    expect(renderer.autoClear).toBe(true)
    sandbox.updateBackground('environment')
    sandbox.updateColors({...DEFAULT_SANDBOX_COLORS})
    expect(pmrem.generate).toHaveBeenCalledTimes(1)
    sandbox.updateBackground('solid')
    pmrem.fail = false
    sandbox.updateBackground('environment')
    expect(scene.environment).not.toBeNull()
    sandbox.dispose()
    holder.remove()
  })
})

describe('sandbox placemark projection and interaction', () => {
  it('renders group names above actual terrain anchors and skips invalid or outside coordinates', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const hills = {...terrain, elevations: [0, 200, 100, 800]}
    sandbox.build(hills, [], null, {exaggeration: 2})
    const {scene, camera} = drawFrame()
    // This test isolates projection from the steep southeast slope's valid occlusion.
    sandbox.setInteractionEnabled(false)
    sandbox.applyCameraState({position: [0, 5000, 1000], target: [0, terrainModel(hills, 2).topHeight / 2, 0], fov: 38})
    const coordinates = gridCoordinate(0.7, 0.6, hills)
    sandbox.updatePlacemarks([
      {id: 'group', coordinates, label: 'G7', title: '山顶', groupCount: 3},
      {id: 'west', coordinates: [119.999, 30.01], label: '1'},
      {id: 'north', coordinates: [120.01, 30.0201], label: '2'},
      {id: 'nan', coordinates: [NaN, 30.01], label: '3'},
      {id: 'infinite', coordinates: [120.01, Infinity], label: '4'},
    ], {selectedId: 'group'})
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="group"]')!
    expect(holder.querySelectorAll('[data-sandbox-placemark]')).toHaveLength(1)
    expect(button.hidden).toBe(false)
    expect(button.tagName).toBe('BUTTON')
    expect(button.type).toBe('button')
    expect(parseFloat(button.style.width)).toBeGreaterThanOrEqual(44)
    expect(parseFloat(button.style.height)).toBeGreaterThanOrEqual(44)
    expect(button.textContent).toBe('山顶')
    expect(button.style.color).toBe('transparent')
    expect(button.style.backgroundColor).toBe('transparent')
    expect(button.querySelector('.trk-sandbox-placemark-dot')).toBeNull()
    expect(button.querySelector('.trk-sandbox-placemark-count')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('标记组 G7：山顶，3 个子点')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    const {x, z} = terrainPosition(...coordinates, hills)
    // Lower-right triangle is b/c/d, not the bilinear average of all four heights.
    const elevation = 800 + (100 - 800) * (1 - 0.7) + (200 - 800) * (1 - 0.6)
    const model = terrainModel(hills, 2), span = Math.max(hills.widthMeters, hills.depthMeters)
    const {group, node, sphere, connector, label} = placemarkVisuals(scene, 'group')
    expect(group.children).toEqual([node])
    const anchor = sphere.getWorldPosition(new THREE.Vector3()), head = label.getWorldPosition(new THREE.Vector3())
    expect(anchor.x).toBeCloseTo(x, 6); expect(anchor.z).toBeCloseTo(z, 6)
    expect(anchor.y).toBeCloseTo(sceneHeight(elevation, model) + Math.max(.2, span * .001), 6)
    expect(head.x).toBe(anchor.x); expect(head.z).toBe(anchor.z)
    expect(head.y - anchor.y).toBeCloseTo(Math.max(5, span * .09, model.topHeight * .12), 6)
    const ends = connectorEnds(connector)
    expect(ends[0].distanceTo(anchor)).toBeLessThan(.001)
    expect(ends[1].distanceTo(head)).toBeLessThan(.001)
    expect(connector.geometry.getAttribute('instanceDistanceStart').getX(0)).toBe(0)
    expect(connector.geometry.getAttribute('instanceDistanceEnd').getX(0)).toBeCloseTo(head.y - anchor.y, 3)
    expect(connector.material.dashed).toBe(true)
    expect(connector.material.worldUnits).toBe(false)
    expect(connector.material.linewidth).toBe(1.5)
    expect(connector.material.resolution.toArray()).toEqual([900, 600])
    expect(sphere.geometry).toBeInstanceOf(THREE.SphereGeometry)
    expect(sphere.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(sphere.material.color.getHexString()).toBe(DEFAULT_MAP_SETTINGS.sandboxConnectorColor.slice(1))
    expect(connector.material.color.getHexString()).toBe(sphere.material.color.getHexString())
    expect(sphere.material.toneMapped).toBe(false)
    expect(connector.material.toneMapped).toBe(false)
    expect(sphere.material.depthTest).toBe(true); expect(sphere.material.depthWrite).toBe(false)
    expect(connector.material.depthTest).toBe(true); expect(connector.material.depthWrite).toBe(false)
    expect(label.material.map).toBeInstanceOf(THREE.CanvasTexture)
    expect(label.material.map!.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(label.center.toArray()).toEqual([.5, 0])
    expect(label.material.depthTest).toBe(true)
    expect(label.material.depthWrite).toBe(false)
    expect(labelPaints.get(label.material.map!.image as HTMLCanvasElement)).toEqual({texts: ['山顶'], colors: ['#ffffff']})
    expect(projectedDiameter(sphere, camera, 900)).toBeCloseTo(7, 6)
    const projection = head.clone().project(camera)
    expect(parseFloat(button.style.left)).toBeCloseTo((projection.x + 1) * 450, 6)
    expect(parseFloat(button.style.top)).toBeCloseTo((1 - projection.y) * 300, 6)
    sandbox.dispose()
    holder.remove()
  })

  it('reuses marker buttons when hiding or selecting and updates callbacks without allocating terrain resources', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame()
    const terrainChildren = [...scene.children]
    const resources = watchDisposal(scene)
    const position = camera.position.clone()
    const markers = [{id: 'one', coordinates: gridCoordinate(0.7, 0.5, terrain), label: '12', title: '观景台'}]
    const firstCallback = vi.fn(), latestCallback = vi.fn(), bubbled = vi.fn()
    sandbox.updatePlacemarks(markers, {onSelect: firstCallback})
    const meshes = [...scene.children]
    expect(meshes.filter(object => object.name !== 'sandbox-placemarks')).toEqual(terrainChildren)
    const visual = placemarkVisuals(scene, 'one'), texture = visual.label.material.map
    const linePositions = visual.connector.geometry.getAttribute('instanceStart')
    const lineDistances = visual.connector.geometry.getAttribute('instanceDistanceEnd')
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="one"]')!
    holder.addEventListener('pointerdown', bubbled)
    button.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    expect(bubbled).not.toHaveBeenCalled()
    button.click()
    expect(firstCallback).toHaveBeenCalledWith('one')
    sandbox.updatePlacemarks(markers, {visible: false, onSelect: latestCallback})
    expect(button.hidden).toBe(true)
    expect(visual.group.visible).toBe(false)
    expect(visual.node.visible).toBe(false)
    expect(holder.querySelector('.trk-sandbox-placemarks')?.getAttribute('hidden')).not.toBeNull()
    button.click()
    expect(latestCallback).not.toHaveBeenCalled()
    sandbox.updatePlacemarks(markers, {visible: true, selectedId: 'one', onSelect: latestCallback})
    expect(holder.querySelector('[data-sandbox-placemark="one"]')).toBe(button)
    expect(button.hidden).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(visual.group.visible).toBe(true); expect(visual.node.visible).toBe(true)
    expect(visual.label.material.map).toBe(texture)
    expect(visual.connector.geometry.getAttribute('instanceStart')).toBe(linePositions)
    expect(visual.connector.geometry.getAttribute('instanceDistanceEnd')).toBe(lineDistances)
    button.focus(); expect(document.activeElement).toBe(button)
    const keyBubbled = vi.fn(); holder.addEventListener('keydown', keyBubbled)
    button.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
    button.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}))
    expect(keyBubbled).not.toHaveBeenCalled()
    button.click()
    expect(latestCallback).toHaveBeenCalledWith('one')
    expect(firstCallback).toHaveBeenCalledTimes(1)
    expect(scene.children).toEqual(meshes)
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-7)
    for (const listener of resources) expect(listener).not.toHaveBeenCalled()
    expect(webgl.dispose).not.toHaveBeenCalled()
    sandbox.dispose()
    button.click()
    expect(latestCallback).toHaveBeenCalledTimes(1)
    expect(holder.children).toHaveLength(0)
    holder.remove()
  })

  it('hides markers outside the screen, behind the camera, and beyond the near or far clip planes', () => {
    const holder = container()
    const layer = new SandboxPlacemarkLayer(holder, terrain, terrainModel(terrain))
    layer.update([{id: 'center', coordinates: gridCoordinate(0.5, 0.5, terrain), label: '1'}], {})
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="center"]')!
    const camera = new THREE.PerspectiveCamera(38, 1.5, 1, 10000)
    camera.position.set(0, 1500, 2000)
    camera.lookAt(0, 200, 0)
    layer.project(camera, 900, 600)
    expect(button.hidden).toBe(false)
    camera.near = 5000
    camera.updateProjectionMatrix()
    layer.project(camera, 900, 600)
    expect(button.hidden).toBe(true)
    camera.near = 1
    camera.far = 500
    camera.updateProjectionMatrix()
    layer.project(camera, 900, 600)
    expect(button.hidden).toBe(true)
    camera.far = 10000
    camera.updateProjectionMatrix()
    camera.position.set(10000, 1500, 2000)
    camera.lookAt(10000, 200, 0)
    layer.project(camera, 900, 600)
    expect(button.hidden).toBe(true)
    camera.position.set(0, 200, 2000)
    camera.lookAt(0, 200, 3000)
    layer.project(camera, 900, 600)
    expect(button.hidden).toBe(true)
    layer.dispose()
    holder.remove()
  })

  it('projects the same anchors after zoom, orbit redraw, and resize without replacing buttons', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame()
    const coordinates = gridCoordinate(0.85, 0.2, terrain)
    sandbox.updatePlacemarks([{id: 'ridge', coordinates, label: '21'}])
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="ridge"]')!
    const before = parseFloat(button.style.left)
    sandbox.zoomIn()
    expect(parseFloat(button.style.left)).not.toBeCloseTo(before, 4)
    sandbox.zoomOut()
    expect(parseFloat(button.style.left)).toBeCloseTo(before, 6)
    camera.position.x += 400
    sandbox.renderFrame()
    expect(parseFloat(button.style.left)).not.toBeCloseTo(before, 4)
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver)
    expect(camera.aspect).toBe(1.5)
    const {x, z} = terrainPosition(...coordinates, terrain)
    const elevation = 100 + (300 - 100) * 0.85 + (200 - 100) * 0.2
    // This point is in b/c/d; the grid is planar here, so either face agrees.
    const model = terrainModel(terrain), span = Math.max(terrain.widthMeters, terrain.depthMeters)
    const projection = new THREE.Vector3(x, sceneHeight(elevation, model) + Math.max(.2, span * .001)
      + Math.max(5, span * .09, model.topHeight * .12), z).project(camera)
    const {sphere, connector} = placemarkVisuals(scene, 'ridge')
    expect(projectedDiameter(sphere, camera, 600)).toBeCloseTo(7, 6)
    expect(connector.material.resolution.toArray()).toEqual([600, 400])
    expect(parseFloat(button.style.left)).toBeCloseTo((projection.x + 1) * 300, 6)
    expect(parseFloat(button.style.top)).toBeCloseTo((1 - projection.y) * 200, 6)
    expect(holder.querySelector('[data-sandbox-placemark="ridge"]')).toBe(button)
    expect(webgl.setSize).toHaveBeenLastCalledWith(600, 400, false)
    sandbox.dispose()
    holder.remove()
  })

  it('updates label, connector and route colors independently while reusing geometry, materials, camera and capture', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    const points: import('../src/protocol.ts').TrackPoint[] = [[120, 30.02, null, null], [120.02, 30, null, null]]
    sandbox.build(terrain, points, null, {routeColor: '#112233'})
    const {scene, camera} = drawFrame(), terrainResources = watchDisposal(scene)
    const marker = {id: 'one', coordinates: gridCoordinate(.55, .5, terrain), label: '8', title: '林间营地'}
    sandbox.updatePlacemarks([marker], {labelColor: '#abcdef', connectorColor: '#aabbcc'})
    const parts = placemarkVisuals(scene, 'one'), button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="one"]')!
    const capture = sandbox.getCaptureCanvas(), position = camera.position.clone(), quaternion = camera.quaternion.clone()
    const route = scene.children.find(object => object instanceof Line2) as Line2
    const sphereGeometry = parts.sphere.geometry, lineGeometry = parts.connector.geometry
    const linePositions = lineGeometry.getAttribute('instanceStart'), lineDistances = lineGeometry.getAttribute('instanceDistanceEnd')
    const sphereMaterial = parts.sphere.material, lineMaterial = parts.connector.material, labelMaterial = parts.label.material
    const firstTexture = labelMaterial.map!, firstDisposed = vi.fn()
    firstTexture.addEventListener('dispose', firstDisposed)
    expect(labelPaints.get(firstTexture.image as HTMLCanvasElement)).toEqual({texts: ['林间营地'], colors: ['#abcdef']})
    expect(sphereMaterial.color.getHexString()).toBe('aabbcc')
    expect(lineMaterial.color.getHexString()).toBe('aabbcc')
    expect(route.material.color.getHexString()).toBe('112233')

    sandbox.updatePlacemarks([marker], {selectedId: 'one', labelColor: '#abcdef', connectorColor: '#123456'})
    expect(placemarkVisuals(scene, 'one').node).toBe(parts.node)
    expect(parts.sphere.geometry).toBe(sphereGeometry); expect(parts.connector.geometry).toBe(lineGeometry)
    expect(lineGeometry.getAttribute('instanceStart')).toBe(linePositions)
    expect(lineGeometry.getAttribute('instanceDistanceEnd')).toBe(lineDistances)
    expect(parts.sphere.material).toBe(sphereMaterial); expect(parts.connector.material).toBe(lineMaterial)
    expect(parts.label.material).toBe(labelMaterial); expect(labelMaterial.map).toBe(firstTexture)
    expect(firstDisposed).not.toHaveBeenCalled()
    expect(sphereMaterial.color.getHexString()).toBe('123456'); expect(lineMaterial.color.getHexString()).toBe('123456')
    expect(route.material.color.getHexString()).toBe('112233')

    sandbox.updatePlacemarks([marker], {labelColor: '#fedcba', connectorColor: '#123456'})
    const secondTexture = labelMaterial.map!, secondDisposed = vi.fn()
    secondTexture.addEventListener('dispose', secondDisposed)
    expect(secondTexture).not.toBe(firstTexture); expect(firstDisposed).toHaveBeenCalledTimes(1)
    expect(labelPaints.get(secondTexture.image as HTMLCanvasElement)).toEqual({texts: ['林间营地'], colors: ['#fedcba']})
    expect(lineGeometry.getAttribute('instanceStart')).toBe(linePositions)
    sandbox.updateRouteColor('#778899')
    expect(route.material.color.getHexString()).toBe('778899')
    expect(sphereMaterial.color.getHexString()).toBe('123456'); expect(labelMaterial.map).toBe(secondTexture)

    sandbox.updatePlacemarks([{...marker, title: '新的营地名称'}], {labelColor: '#fedcba', connectorColor: '#123456'})
    const renamedTexture = labelMaterial.map!, renamedDisposed = vi.fn()
    renamedTexture.addEventListener('dispose', renamedDisposed)
    expect(secondDisposed).toHaveBeenCalledTimes(1)
    expect(button.textContent).toBe('新的营地名称')
    expect(button.title).toBe('新的营地名称')
    expect(labelPaints.get(renamedTexture.image as HTMLCanvasElement)?.texts).toEqual(['新的营地名称'])
    const moved = {...marker, title: '新的营地名称', coordinates: gridCoordinate(.7, .6, terrain)}
    const originalAnchor = parts.sphere.position.clone()
    sandbox.updatePlacemarks([moved], {labelColor: '#fedcba', connectorColor: '#123456'})
    expect(parts.sphere.position.distanceTo(originalAnchor)).toBeGreaterThan(1)
    expect(labelMaterial.map).toBe(renamedTexture)
    const ends = connectorEnds(parts.connector), head = parts.label.getWorldPosition(new THREE.Vector3())
    expect(ends[0].distanceTo(parts.sphere.getWorldPosition(new THREE.Vector3()))).toBeLessThan(.001)
    expect(ends[1].distanceTo(head)).toBeLessThan(.001)
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-7)
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-7)
    expect(sandbox.getCaptureCanvas()).toBe(capture)
    for (const listener of terrainResources) expect(listener).not.toHaveBeenCalled()
    sandbox.dispose()
    expect(firstDisposed).toHaveBeenCalledTimes(1); expect(secondDisposed).toHaveBeenCalledTimes(1)
    expect(renamedDisposed).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it('updates text size and hit bounds while retaining anchors, connector geometry, spheres, camera and unrelated textures', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame(), terrainResources = watchDisposal(scene)
    const markers = [{id: 'font', coordinates: gridCoordinate(.5, .5, terrain), label: '3', title: '沿途文字设置'}]
    sandbox.updatePlacemarks(markers)
    const parts = placemarkVisuals(scene, 'font'), button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="font"]')!
    const texture = parts.label.material.map!, firstDisposed = vi.fn()
    texture.addEventListener('dispose', firstDisposed)
    const canvas = texture.image as HTMLCanvasElement
    expect(labelFonts.get(canvas)?.[0]).toMatch(/^600 16px /)
    const width = parseFloat(button.style.width), height = parseFloat(button.style.height)
    const firstLabelHeight = projectedLabelHeight(parts.label, camera, 600)
    const original = {anchor: parts.sphere.position.clone(), head: parts.label.position.clone(), sphere: parts.sphere,
      sphereGeometry: parts.sphere.geometry, sphereMaterial: parts.sphere.material, lineGeometry: parts.connector.geometry,
      linePositions: parts.connector.geometry.getAttribute('instanceStart'), lineDistances: parts.connector.geometry.getAttribute('instanceDistanceEnd'),
      labelMaterial: parts.label.material, position: camera.position.clone(), direction: camera.quaternion.clone(), capture: sandbox.getCaptureCanvas()}
    sandbox.updatePlacemarks(markers, {labelSize: 32})
    const largeTexture = parts.label.material.map!, largeDisposed = vi.fn()
    largeTexture.addEventListener('dispose', largeDisposed)
    const largeCanvas = largeTexture.image as HTMLCanvasElement
    expect(largeTexture).not.toBe(texture); expect(firstDisposed).toHaveBeenCalledTimes(1)
    expect(labelFonts.get(largeCanvas)?.[0]).toMatch(/^600 32px /)
    expect(largeCanvas.width).toBeGreaterThan(canvas.width); expect(largeCanvas.height).toBeGreaterThan(canvas.height)
    expect(parseFloat(button.style.width)).toBeGreaterThan(width)
    expect(parseFloat(button.style.height)).toBeGreaterThan(height)
    expect(projectedLabelHeight(parts.label, camera, 600)).toBeGreaterThan(firstLabelHeight)
    expect(projectedLabelHeight(parts.label, camera, 600)).toBeCloseTo(largeCanvas.height / 2, 6)
    expect(parts.sphere).toBe(original.sphere); expect(parts.sphere.geometry).toBe(original.sphereGeometry)
    expect(parts.sphere.material).toBe(original.sphereMaterial); expect(parts.connector.geometry).toBe(original.lineGeometry)
    expect(parts.connector.geometry.getAttribute('instanceStart')).toBe(original.linePositions)
    expect(parts.connector.geometry.getAttribute('instanceDistanceEnd')).toBe(original.lineDistances)
    expect(parts.label.material).toBe(original.labelMaterial)
    expect(parts.sphere.position.equals(original.anchor)).toBe(true); expect(parts.label.position.equals(original.head)).toBe(true)
    expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
    expect(camera.position.distanceTo(original.position)).toBeLessThan(1e-7)
    expect(camera.quaternion.angleTo(original.direction)).toBeLessThan(1e-7)
    expect(sandbox.getCaptureCanvas()).toBe(original.capture)
    sandbox.updatePlacemarks(markers, {labelSize: 32, selectedId: 'font', connectorColor: '#123456'})
    sandbox.updatePlacemarks(markers, {labelSize: 32, visible: false, connectorColor: '#123456'})
    sandbox.updatePlacemarks(markers, {labelSize: 32, visible: true, connectorColor: '#123456'})
    expect(parts.label.material.map).toBe(largeTexture); expect(largeDisposed).not.toHaveBeenCalled()
    expect(parts.connector.geometry.getAttribute('instanceStart')).toBe(original.linePositions)
    expect(holder.querySelector('[data-sandbox-placemark="font"]')).toBe(button)
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver); sandbox.renderFrame()
    expect(parts.label.material.map).toBe(largeTexture)
    expect(projectedLabelHeight(parts.label, camera, 400)).toBeCloseTo(largeCanvas.height / 2, 6)
    expect(projectedDiameter(parts.sphere, camera, 600)).toBeCloseTo(7, 6)
    expect(parseFloat(button.style.width)).toBe(largeCanvas.width / 2)
    expect(parseFloat(button.style.height)).toBe(largeCanvas.height / 2)
    for (const listener of terrainResources) expect(listener).not.toHaveBeenCalled()
    sandbox.dispose()
    expect(firstDisposed).toHaveBeenCalledTimes(1); expect(largeDisposed).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it.each([
    [undefined, 16], [NaN, 16], [Infinity, 16], [-Infinity, 16], [9, 10], [33, 32], [19.6, 20], [10, 10], [32, 32],
  ])('normalizes label size %s to %s pixels and reuses the normalized texture', (size, expected) => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame()
    const markers = [{id: 'size', coordinates: gridCoordinate(.5, .5, terrain), label: '1', title: '短名'}]
    sandbox.updatePlacemarks(markers, {labelSize: size})
    const parts = placemarkVisuals(scene, 'size'), texture = parts.label.material.map!
    const canvas = texture.image as HTMLCanvasElement
    expect(labelFonts.get(canvas)?.[0]).toMatch(new RegExp('^600 ' + expected + 'px '))
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="size"]')!
    expect(parseFloat(button.style.width)).toBeGreaterThanOrEqual(44)
    expect(parseFloat(button.style.height)).toBeGreaterThanOrEqual(44)
    expect(projectedLabelHeight(parts.label, camera, 600)).toBeCloseTo(canvas.height / 2, 6)
    expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
    sandbox.updatePlacemarks(markers, {labelSize: expected, selectedId: 'size'})
    expect(parts.label.material.map).toBe(texture)
    sandbox.dispose(); holder.remove()
  })

  it('changes floating height and dash distances in place while preserving ground anchors, screen sizes, terrain and camera', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], document.createElement('canvas')); sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame()
    const markers = [{id: 'height', coordinates: gridCoordinate(.5, .5, terrain), label: '3', title: 'Floating label'}]
    sandbox.updatePlacemarks(markers, {labelSize: 24})
    const parts = placemarkVisuals(scene, 'height'), surface = terrainSurface(scene)
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="height"]')!
    const original = {anchor: parts.sphere.position.clone(), head: parts.label.position.clone(), scale: parts.sphere.scale.clone(),
      sphereGeometry: parts.sphere.geometry, sphereMaterial: parts.sphere.material, lineGeometry: parts.connector.geometry,
      linePositions: parts.connector.geometry.getAttribute('instanceStart'), lineMaterial: parts.connector.material,
      texture: parts.label.material.map!, labelMaterial: parts.label.material, terrainGeometry: surface.geometry,
      terrainMaterial: surface.material, position: camera.position.clone(), direction: camera.quaternion.clone(),
      projection: camera.projectionMatrix.clone(), capture: sandbox.getCaptureCanvas()}
    const disposals = watchDisposal(scene)
    const automaticHeight = original.head.y - original.anchor.y
    expect(automaticHeight).toBeGreaterThan(0)
    const pixelHeight = projectedLabelHeight(parts.label, camera, 600)
    const checkHeight = (factor: number, width = 900, height = 600) => {
      const expectedHeight = automaticHeight * factor, [start, end] = connectorEnds(parts.connector)
      expect(parts.label.position.x).toBe(original.anchor.x); expect(parts.label.position.z).toBe(original.anchor.z)
      expect(parts.label.position.y).toBeCloseTo(original.anchor.y + expectedHeight, 6)
      expect(start.distanceTo(original.anchor)).toBeLessThan(.001)
      expect(end.distanceTo(parts.label.position)).toBeLessThan(.001)
      expect(end.y - start.y).toBeCloseTo(expectedHeight, 3)
      expect(parts.connector.geometry.getAttribute('instanceDistanceStart').getX(0)).toBe(0)
      expect(parts.connector.geometry.getAttribute('instanceDistanceEnd').getX(0)).toBeCloseTo(expectedHeight, 3)
      expect(parts.sphere.position.equals(original.anchor)).toBe(true)
      expect(parts.sphere.geometry).toBe(original.sphereGeometry); expect(parts.sphere.material).toBe(original.sphereMaterial)
      expect(parts.connector.geometry).toBe(original.lineGeometry); expect(parts.connector.material).toBe(original.lineMaterial)
      expect(parts.connector.geometry.getAttribute('instanceStart')).toBe(original.linePositions)
      expect(parts.label.material).toBe(original.labelMaterial); expect(parts.label.material.map).toBe(original.texture)
      expect(surface.geometry).toBe(original.terrainGeometry); expect(surface.material).toBe(original.terrainMaterial)
      expect(camera.position.equals(original.position)).toBe(true); expect(camera.quaternion.equals(original.direction)).toBe(true)
      expect(sandbox.getCaptureCanvas()).toBe(original.capture)
      expect(projectedDiameter(parts.sphere, camera, width)).toBeCloseTo(7, 6)
      expect(projectedLabelHeight(parts.label, camera, height)).toBeCloseTo(pixelHeight, 6)
      for (const material of [parts.sphere.material, parts.connector.material, parts.label.material]) {
        expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false)
      }
      for (const listener of disposals) expect(listener).not.toHaveBeenCalled()
    }
    checkHeight(1)
    for (const factor of [.5, 2, 1]) {
      sandbox.updatePlacemarks(markers, {labelSize: 24, labelHeight: factor}); sandbox.renderFrame()
      checkHeight(factor)
      expect(parts.sphere.scale.equals(original.scale)).toBe(true)
      expect(camera.projectionMatrix.equals(original.projection)).toBe(true)
      expect(holder.querySelector('[data-sandbox-placemark="height"]')).toBe(button)
    }
    sandbox.updatePlacemarks(markers, {labelSize: 24, labelHeight: 2}); sandbox.renderFrame()
    const distanceBuffer = parts.connector.geometry.getAttribute('instanceDistanceEnd')
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver); sandbox.renderFrame()
    checkHeight(2, 600, 400)
    expect(parts.connector.geometry.getAttribute('instanceDistanceEnd')).toBe(distanceBuffer)
    sandbox.dispose()
    for (const listener of disposals) expect(listener).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it.each([
    {height: undefined, expected: 1}, {height: null, expected: 1}, {height: '2', expected: 1},
    {height: NaN, expected: 1}, {height: Infinity, expected: 1}, {height: -Infinity, expected: 1},
    {height: -.5, expected: .2}, {height: 10, expected: 3}, {height: .2, expected: .2}, {height: 3, expected: 3},
    {height: 1.24, expected: 1.2}, {height: 1.26, expected: 1.3},
  ])('normalizes floating height $height to $expected and updates the existing dash endpoint', ({height, expected}) => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null); sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame()
    const markers = [{id: 'height-limit', coordinates: gridCoordinate(.5, .5, terrain), label: '1'}]
    sandbox.updatePlacemarks(markers)
    const parts = placemarkVisuals(scene, 'height-limit'), texture = parts.label.material.map
    const anchor = parts.sphere.position.clone(), automaticHeight = parts.label.position.y - anchor.y
    const geometry = parts.connector.geometry, originalPosition = camera.position.clone()
    expect(sanitizeSandboxLabelHeight(height)).toBe(expected)
    sandbox.updatePlacemarks(markers, {labelHeight: height as number | undefined})
    const [start, end] = connectorEnds(parts.connector)
    expect(parts.label.position.y - anchor.y).toBeCloseTo(automaticHeight * expected, 6)
    expect(start.distanceTo(anchor)).toBeLessThan(.001)
    expect(end.distanceTo(parts.label.position)).toBeLessThan(.001)
    expect(geometry.getAttribute('instanceDistanceEnd').getX(0)).toBeCloseTo(automaticHeight * expected, 3)
    expect(parts.sphere.position.equals(anchor)).toBe(true); expect(parts.connector.geometry).toBe(geometry)
    expect(parts.label.material.map).toBe(texture); expect(camera.position.equals(originalPosition)).toBe(true)
    expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
    const distanceBuffer = geometry.getAttribute('instanceDistanceEnd')
    sandbox.updatePlacemarks(markers, {labelHeight: expected, selectedId: 'height-limit'})
    expect(geometry.getAttribute('instanceDistanceEnd')).toBe(distanceBuffer)
    expect(parts.label.material.map).toBe(texture)
    sandbox.dispose(); holder.remove()
  })

  it('keeps a large-font long name on at most two texture lines while preserving the full accessible name', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame(), title = '这是很长的沿途名称需要分行显示并限制两行'.repeat(4)
    sandbox.updatePlacemarks([{id: 'long', coordinates: gridCoordinate(.5, .5, terrain), label: '5', title}], {labelSize: 32})
    const parts = placemarkVisuals(scene, 'long'), texture = parts.label.material.map!, canvas = texture.image as HTMLCanvasElement
    const paint = labelPaints.get(canvas)!
    expect(paint.texts).toHaveLength(2); expect(paint.texts[1].endsWith('…')).toBe(true)
    expect(paint.texts.every(line => Array.from(line).length * 32 <= 248)).toBe(true)
    expect(labelFonts.get(canvas)?.every(font => /^600 32px /.test(font))).toBe(true)
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="long"]')!
    expect(button.textContent).toBe(title); expect(button.title).toBe(title)
    expect(button.getAttribute('aria-label')).toBe('标注点 5：' + title)
    expect(projectedLabelHeight(parts.label, camera, 600)).toBeCloseTo(canvas.height / 2, 6)
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver); sandbox.renderFrame()
    expect(parts.label.material.map).toBe(texture)
    expect(projectedLabelHeight(parts.label, camera, 400)).toBeCloseTo(canvas.height / 2, 6)
    sandbox.dispose(); holder.remove()
  })

  it('updates screen sizes and world labels before rendering each captured frame after a camera change', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame()
    sandbox.updatePlacemarks([{id: 'center', coordinates: gridCoordinate(.5, .5, terrain), label: '17'}])
    const parts = placemarkVisuals(scene, 'center'), texture = parts.label.material.map
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="center"]')!
    expect(button.textContent).toBe('17')
    const originalLabelHeight = projectedLabelHeight(parts.label, camera, 600)
    const originalScale = parts.sphere.scale.x
    camera.position.multiplyScalar(.7)
    camera.lookAt(parts.label.position)
    const renders = webgl.render.mock.calls.length
    webgl.render.mockImplementationOnce((renderedScene: THREE.Scene, renderedCamera: THREE.PerspectiveCamera) => {
      expect(renderedScene).toBe(scene); expect(renderedCamera).toBe(camera)
      expect(parts.sphere.scale.x).not.toBeCloseTo(originalScale, 5)
      expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
      expect(projectedLabelHeight(parts.label, camera, 600)).toBeCloseTo(originalLabelHeight, 6)
      const head = parts.label.getWorldPosition(new THREE.Vector3()).project(camera)
      expect(parseFloat(button.style.left)).toBeCloseTo((head.x + 1) * 450, 6)
      expect(parseFloat(button.style.top)).toBeCloseTo((1 - head.y) * 300, 6)
      expect(scene.getObjectByName('sandbox-placemarks')).toBe(parts.group)
      expect(parts.label.material.map).toBe(texture)
    })
    sandbox.renderFrame()
    expect(webgl.render).toHaveBeenCalledTimes(renders + 1)
    sandbox.dispose(); holder.remove()
  })

  it('disposes removed label assets once while retaining shared balls and connectors for the remaining node', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene} = drawFrame()
    const markers = [{id: 'first', coordinates: gridCoordinate(.4, .5, terrain), label: '1', title: '第一处'},
      {id: 'second', coordinates: gridCoordinate(.6, .5, terrain), label: '2', title: '第二处'}]
    sandbox.updatePlacemarks(markers)
    const first = placemarkVisuals(scene, 'first'), second = placemarkVisuals(scene, 'second')
    expect(first.sphere.geometry).toBe(second.sphere.geometry)
    expect(first.sphere.material).toBe(second.sphere.material)
    expect(first.connector.material).toBe(second.connector.material)
    const shared = [first.sphere.geometry, first.sphere.material, first.connector.material].map(resource => {
      const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener
    })
    const removed = [first.connector.geometry, first.label.material, first.label.material.map!].map(resource => {
      const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener
    })
    const remaining = [second.connector.geometry, second.label.material, second.label.material.map!].map(resource => {
      const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener
    })
    sandbox.updatePlacemarks([markers[1]])
    expect(first.node.parent).toBeNull(); expect(placemarkVisuals(scene, 'second').node).toBe(second.node)
    for (const listener of removed) expect(listener).toHaveBeenCalledTimes(1)
    for (const listener of [...shared, ...remaining]) expect(listener).not.toHaveBeenCalled()
    sandbox.dispose(); sandbox.dispose()
    for (const listener of [...removed, ...shared, ...remaining]) expect(listener).toHaveBeenCalledTimes(1)
    expect(first.group.parent).toBeNull(); holder.remove()
  })

  it('clears stale selection callbacks and overlays on replacement, rebuild, context loss and disposal', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const selected = vi.fn()
    const markers = [{id: 'old', coordinates: gridCoordinate(0.5, 0.5, terrain), label: '1'}]
    sandbox.build(terrain, [], null)
    sandbox.updatePlacemarks(markers, {onSelect: selected})
    const removed = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="old"]')!
    sandbox.updatePlacemarks([], {onSelect: selected})
    removed.click()
    expect(selected).not.toHaveBeenCalled()
    expect(removed.onclick).toBeNull()
    sandbox.updatePlacemarks(markers, {onSelect: selected})
    const rebuilt = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="old"]')!
    const rebuiltResources = watchDisposal(drawFrame().scene)
    sandbox.build(terrain, [], null)
    for (const listener of rebuiltResources) expect(listener).toHaveBeenCalledTimes(1)
    expect(holder.querySelector('.trk-sandbox-placemarks')).toBeNull()
    rebuilt.click()
    expect(selected).not.toHaveBeenCalled()
    sandbox.updatePlacemarks(markers, {onSelect: selected})
    const lost = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="old"]')!
    const lostResources = watchDisposal(drawFrame().scene)
    holder.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', {cancelable: true}))
    for (const listener of lostResources) expect(listener).toHaveBeenCalledTimes(1)
    for (const listener of rebuiltResources) expect(listener).toHaveBeenCalledTimes(1)
    expect(holder.querySelector('.trk-sandbox-placemarks')).toBeNull()
    expect(holder.children).toHaveLength(0)
    lost.click()
    expect(selected).not.toHaveBeenCalled()
    sandbox.updatePlacemarks(markers, {onSelect: selected})
    expect(holder.children).toHaveLength(0)
    sandbox.dispose()
    holder.remove()
  })
})



describe('sandbox terrain occlusion during rotation', () => {
  const ridge: TerrainGrid = {...terrain, columns: 3, rows: 3, elevations: [0, 0, 0, 600, 600, 600, 0, 0, 0]}
  const north: import('../src/track/sandbox/types.ts').SandboxCameraState = {position: [0, 450, -2000], target: [0, 450, 300], fov: 38}
  const south: import('../src/track/sandbox/types.ts').SandboxCameraState = {position: [0, 450, 2000], target: [0, 450, 300], fov: 38}

  it('submits blocked source balls and leaders for GPU depth while keeping exposed labels clickable and obscured labels noninteractive', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder), selected = vi.fn()
    vi.spyOn(holder, 'getBoundingClientRect').mockImplementation(() => ({x: 0, y: 0, left: 0, top: 0,
      width: holder.clientWidth, height: holder.clientHeight, right: holder.clientWidth, bottom: holder.clientHeight,
      toJSON: () => ({}),
    } as DOMRect))
    sandbox.build(ridge, [], null)
    sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame(), surface = terrainSurface(scene), resources = watchDisposal(scene)
    const markers = [{id: 'valley', coordinates: gridCoordinate(1, 1.6, ridge), label: '1', title: '山后点位'},
      {id: 'slope', coordinates: gridCoordinate(1, 1.1, ridge), label: '2', title: '坡后点位'}]
    sandbox.updatePlacemarks(markers, {labelSize: 24, onSelect: selected})
    const originals = markers.map(marker => {
      const parts = placemarkVisuals(scene, marker.id)
      return {...parts, button: holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="' + marker.id + '"]')!,
        anchor: parts.sphere.position.clone(), head: parts.label.position.clone(), sphereGeometry: parts.sphere.geometry,
        lineGeometry: parts.connector.geometry, linePositions: parts.connector.geometry.getAttribute('instanceStart'),
        lineDistances: parts.connector.geometry.getAttribute('instanceDistanceEnd'), texture: parts.label.material.map!}
    })
    const textureDisposals = originals.map(parts => {
      const listener = vi.fn(); parts.texture.addEventListener('dispose', listener); return listener
    })
    sandbox.applyCameraState(north)
    for (const parts of originals) {
      expect(meshBlocksPoint(surface, camera.position, parts.anchor)).toBe(true)
      for (const material of [parts.sphere.material, parts.connector.material, parts.label.material]) {
        expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false)
      }
    }
    // The slope's billboard clears the ridge even though its ball and lower leader are behind it.
    expect(originals[1].head.y).toBeGreaterThan(terrainModel(ridge).topHeight)
    expect(meshBlocksPoint(surface, camera.position, originals[1].head)).toBe(false)
    const labelCenters = originals.map(parts => parts.label.getWorldPosition(new THREE.Vector3()).addScaledVector(
      new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), parts.label.getWorldScale(new THREE.Vector3()).y / 2))
    expect(meshBlocksPoint(surface, camera.position, labelCenters[0])).toBe(true)
    expect(meshBlocksPoint(surface, camera.position, labelCenters[1])).toBe(false)
    webgl.render.mockImplementationOnce(() => {
      for (const parts of originals) {
        expect(parts.node.visible).toBe(true); expect(parts.sphere.visible).toBe(true)
        expect(parts.connector.visible).toBe(true); expect(parts.label.visible).toBe(true)
        expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
      }
      expect(originals[0].button.hidden).toBe(true); expect(originals[1].button.hidden).toBe(false)
    })
    sandbox.renderFrame()
    expect(originals[0].button.style.display).toBe('none')
    expect(originals[1].button.style.display).toBe('')
    originals[0].button.click()
    expect(selected).not.toHaveBeenCalled()
    for (const [index, parts] of originals.entries()) {
      const projection = labelCenters[index].clone().project(camera)
      parts.button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1,
        clientX: (projection.x + 1) * 450, clientY: (1 - projection.y) * 300}))
    }
    expect(selected.mock.calls).toEqual([['slope']])
    sandbox.applyCameraState(south)
    sandbox.renderFrame()
    for (const [index, marker] of markers.entries()) {
      const parts = originals[index], current = placemarkVisuals(scene, marker.id)
      expect(meshBlocksPoint(surface, camera.position, parts.anchor)).toBe(false)
      expect(current.node).toBe(parts.node); expect(current.sphere).toBe(parts.sphere)
      expect(parts.node.visible).toBe(true); expect(parts.button.hidden).toBe(false)
      expect(parts.button.style.display).toBe('')
      expect(parts.sphere.position.equals(parts.anchor)).toBe(true); expect(parts.label.position.equals(parts.head)).toBe(true)
      expect(parts.sphere.geometry).toBe(parts.sphereGeometry); expect(parts.connector.geometry).toBe(parts.lineGeometry)
      expect(parts.connector.geometry.getAttribute('instanceStart')).toBe(parts.linePositions)
      expect(parts.connector.geometry.getAttribute('instanceDistanceEnd')).toBe(parts.lineDistances)
      expect(parts.label.material.map).toBe(parts.texture)
      expect(labelFonts.get(parts.texture.image as HTMLCanvasElement)?.[0]).toMatch(/^600 24px /)
      expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
      expect(projectedLabelHeight(parts.label, camera, 600)).toBeCloseTo((parts.texture.image as HTMLCanvasElement).height / 2, 6)
      parts.button.click()
    }
    expect(selected.mock.calls).toEqual([['slope'], ['valley'], ['slope']])
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver); sandbox.renderFrame()
    for (const parts of originals) {
      expect(parts.node.visible).toBe(true); expect(parts.button.hidden).toBe(false)
      expect(projectedDiameter(parts.sphere, camera, 600)).toBeCloseTo(7, 6)
      expect(projectedLabelHeight(parts.label, camera, 400)).toBeCloseTo((parts.texture.image as HTMLCanvasElement).height / 2, 6)
      expect(parts.label.material.map).toBe(parts.texture)
    }
    for (const listener of [...resources, ...textureDisposals]) expect(listener).not.toHaveBeenCalled()
    sandbox.dispose()
    for (const listener of [...resources, ...textureDisposals]) expect(listener).toHaveBeenCalledTimes(1)
    holder.remove()
  })

  it('reveals a lifted label above a real ridge without moving or exposing its blocked ground anchor', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder), selected = vi.fn()
    sandbox.build(ridge, [], null); sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame(), surface = terrainSurface(scene)
    const markers = [{id: 'height-over-ridge', coordinates: gridCoordinate(1, 1.22, ridge), label: '1', title: 'Ridge'}]
    sandbox.updatePlacemarks(markers, {labelSize: 24, labelHeight: .2, onSelect: selected})
    sandbox.applyCameraState(north); sandbox.renderFrame()
    const parts = placemarkVisuals(scene, 'height-over-ridge')
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="height-over-ridge"]')!
    const anchor = parts.sphere.position.clone(), lowHead = parts.label.position.clone()
    const texture = parts.label.material.map!, geometry = parts.connector.geometry, position = camera.position.clone()
    expect(meshBlocksPoint(surface, camera.position, anchor)).toBe(true)
    expect(meshBlocksPoint(surface, camera.position, lowHead)).toBe(true)
    expect(button.hidden).toBe(true); button.click(); expect(selected).not.toHaveBeenCalled()
    sandbox.updatePlacemarks(markers, {labelSize: 24, labelHeight: 2, onSelect: selected}); sandbox.renderFrame()
    expect(meshBlocksPoint(surface, camera.position, parts.label.position)).toBe(false)
    expect(meshBlocksPoint(surface, camera.position, parts.sphere.position)).toBe(true)
    expect(button.hidden).toBe(false); button.click(); expect(selected.mock.calls).toEqual([['height-over-ridge']])
    expect(parts.label.position.y).toBeGreaterThan(lowHead.y)
    expect(geometry.getAttribute('instanceDistanceEnd').getX(0)).toBeCloseTo(parts.label.position.y - anchor.y, 3)
    const [, end] = connectorEnds(parts.connector)
    expect(end.distanceTo(parts.label.position)).toBeLessThan(.001)
    expect(parts.sphere.position.equals(anchor)).toBe(true); expect(camera.position.equals(position)).toBe(true)
    expect(parts.label.material.map).toBe(texture); expect(parts.connector.geometry).toBe(geometry)
    for (const material of [parts.sphere.material, parts.connector.material, parts.label.material]) {
      expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false)
    }
    for (const part of [parts.node, parts.sphere, parts.connector, parts.label]) expect(part.visible).toBe(true)
    sandbox.updatePlacemarks(markers, {labelSize: 24, labelHeight: .2, onSelect: selected}); sandbox.renderFrame()
    expect(parts.label.position.equals(lowHead)).toBe(true); expect(button.hidden).toBe(true)
    expect(parts.label.material.map).toBe(texture); expect(parts.sphere.position.equals(anchor)).toBe(true)
    sandbox.dispose(); holder.remove()
  })

  it('accepts a pointer on an exposed label edge while rejecting a pointer on its terrain-blocked edge', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder), selected = vi.fn()
    sandbox.build(ridge, [], null); sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame(), surface = terrainSurface(scene)
    sandbox.updatePlacemarks([{id: 'partial', coordinates: gridCoordinate(1, 1.22, ridge), label: '1', title: '半遮挡文字'}],
      {labelSize: 32, onSelect: selected})
    sandbox.applyCameraState(north); sandbox.renderFrame()
    const parts = placemarkVisuals(scene, 'partial'), button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="partial"]')!
    const bottom = parts.label.getWorldPosition(new THREE.Vector3())
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const height = parts.label.getWorldScale(new THREE.Vector3()).y
    const lower = bottom.clone().addScaledVector(up, height * .2)
    const center = bottom.clone().addScaledVector(up, height * .5)
    const upper = bottom.clone().addScaledVector(up, height * .8)
    expect(meshBlocksPoint(surface, camera.position, parts.sphere.position)).toBe(true)
    expect(meshBlocksPoint(surface, camera.position, lower)).toBe(true)
    expect(meshBlocksPoint(surface, camera.position, center)).toBe(true)
    expect(meshBlocksPoint(surface, camera.position, upper)).toBe(false)
    expect(parts.node.visible).toBe(true); expect(button.hidden).toBe(false)
    expect(parts.sphere.material.depthTest).toBe(true); expect(parts.connector.material.depthTest).toBe(true)
    expect(parts.label.material.depthTest).toBe(true)
    expect(labelFonts.get(parts.label.material.map!.image as HTMLCanvasElement)?.[0]).toMatch(/^600 32px /)
    const texture = parts.label.material.map
    const clickWorldPoint = (point: THREE.Vector3) => {
      const projection = point.clone().project(camera)
      button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1,
        clientX: (projection.x + 1) * 450, clientY: (1 - projection.y) * 300}))
    }
    clickWorldPoint(lower)
    expect(selected).not.toHaveBeenCalled()
    clickWorldPoint(upper)
    expect(selected.mock.calls).toEqual([['partial']])
    expect(parts.label.material.map).toBe(texture)
    expect(projectedDiameter(parts.sphere, camera, 900)).toBeCloseTo(7, 6)
    sandbox.dispose(); holder.remove()
  })

  it('submits route endpoints for GPU depth and deduplicates source balls independently of label hit-target visibility', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    const startCoordinate = gridCoordinate(1, 1.6, ridge), endCoordinate = gridCoordinate(.6, .4, ridge)
    const points: import('../src/protocol.ts').TrackPoint[] = [[...startCoordinate, null, null], [...endCoordinate, null, null]]
    sandbox.build(ridge, points, null); sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame(), surface = terrainSurface(scene)
    const start = scene.getObjectByName('sandbox-route-start') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    const end = scene.getObjectByName('sandbox-route-end') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    const positions = [start.position.clone(), end.position.clone()], geometries = [start.geometry, end.geometry]
    for (const endpoint of [start, end]) {expect(endpoint.material.depthTest).toBe(true); expect(endpoint.material.depthWrite).toBe(false)}
    sandbox.applyCameraState(north); sandbox.renderFrame()
    expect(meshBlocksPoint(surface, camera.position, start.position)).toBe(true)
    expect(meshBlocksPoint(surface, camera.position, end.position)).toBe(false)
    expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    expect(projectedDiameter(start, camera, 900)).toBeCloseTo(10, 6)
    expect(projectedDiameter(end, camera, 900)).toBeCloseTo(10, 6)
    sandbox.applyCameraState(south); sandbox.renderFrame()
    expect(meshBlocksPoint(surface, camera.position, start.position)).toBe(false)
    expect(meshBlocksPoint(surface, camera.position, end.position)).toBe(true)
    expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    expect(projectedDiameter(end, camera, 900)).toBeCloseTo(10, 6)
    expect(projectedDiameter(start, camera, 900)).toBeCloseTo(10, 6)
    const markers = [{id: 'start-source', coordinates: startCoordinate, label: '1', title: '起点名称'}]
    sandbox.updatePlacemarks(markers, {labelSize: 24})
    const source = placemarkVisuals(scene, 'start-source'), texture = source.label.material.map
    expect(source.node.visible).toBe(true); expect(start.visible).toBe(false)
    expect(projectedDiameter(source.sphere, camera, 900)).toBeCloseTo(10, 6)
    sandbox.applyCameraState(north); sandbox.renderFrame()
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="start-source"]')!
    expect(meshBlocksPoint(surface, camera.position, source.sphere.position)).toBe(true)
    expect(source.node.visible).toBe(true); expect(source.sphere.visible).toBe(true); expect(button.hidden).toBe(true)
    expect(start.visible).toBe(false); expect(end.visible).toBe(true)
    sandbox.updatePlacemarks(markers, {labelSize: 24, visible: false})
    expect(source.node.visible).toBe(false); expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    sandbox.applyCameraState(south); sandbox.renderFrame()
    expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    expect(projectedDiameter(start, camera, 900)).toBeCloseTo(10, 6)
    sandbox.updatePlacemarks(markers, {labelSize: 24, visible: true})
    expect(source.node.visible).toBe(true); expect(button.hidden).toBe(false)
    expect(start.visible).toBe(false); expect(end.visible).toBe(true)
    expect(source.label.material.map).toBe(texture)
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver); sandbox.renderFrame()
    expect(projectedDiameter(source.sphere, camera, 600)).toBeCloseTo(10, 6)
    for (const [index, endpoint] of [start, end].entries()) {
      expect(endpoint.position.equals(positions[index])).toBe(true); expect(endpoint.geometry).toBe(geometries[index])
    }
    sandbox.dispose(); holder.remove()
  })

  it('keeps a route-lifted summit anchor visible without treating its own terrain triangle as an occluder', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder), coordinate = gridCoordinate(1, 1, ridge)
    const points: import('../src/protocol.ts').TrackPoint[] = [[...coordinate, null, null], [...gridCoordinate(1, 1.6, ridge), null, null]]
    sandbox.build(ridge, points, null); sandbox.setInteractionEnabled(false)
    const {scene, camera} = drawFrame(), surface = terrainSurface(scene)
    sandbox.applyCameraState({position: [0, 1000, 2000], target: [0, terrainModel(ridge).topHeight + 1, 0], fov: 38})
    sandbox.renderFrame()
    const start = scene.getObjectByName('sandbox-route-start') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    expect(meshBlocksPoint(surface, camera.position, start.position)).toBe(false)
    expect(start.position.y).toBeCloseTo(terrainModel(ridge).topHeight + 1, 6)
    expect(start.visible).toBe(true); expect(projectedDiameter(start, camera, 900)).toBeCloseTo(10, 6)
    sandbox.updatePlacemarks([{id: 'summit', coordinates: coordinate, label: '1', title: '山脊点'}], {labelSize: 24})
    const source = placemarkVisuals(scene, 'summit'), button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="summit"]')!
    expect(meshBlocksPoint(surface, camera.position, source.sphere.position)).toBe(false)
    expect(source.node.visible).toBe(true); expect(button.hidden).toBe(false)
    expect(start.visible).toBe(false); expect(projectedDiameter(source.sphere, camera, 900)).toBeCloseTo(10, 6)
    sandbox.dispose(); holder.remove()
  })
})

describe('sandbox route endpoint balls', () => {
  function endpoints(scene: THREE.Scene) {
    const start = scene.getObjectByName('sandbox-route-start') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    const end = scene.getObjectByName('sandbox-route-end') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    for (const endpoint of [start, end]) {
      expect(endpoint).toBeInstanceOf(THREE.Mesh)
      expect(endpoint.geometry).toBeInstanceOf(THREE.SphereGeometry)
      expect(endpoint.geometry.parameters.radius).toBe(1)
      expect(endpoint.material).toBeInstanceOf(THREE.MeshBasicMaterial)
      expect(endpoint.material.depthTest).toBe(true)
      expect(endpoint.material.depthWrite).toBe(false)
    }
    return {start, end}
  }

  const source: import('../src/protocol.ts').TrackPoint[] = [
    [120.005, 30.015, null, null], [120.007, 30.013, null, null],
    [120.013, 30.007, null, null], [120.015, 30.005, null, null],
  ]

  it('centers endpoints on actual segmented route ends and keeps endpoint balls at 10px and ordinary source balls at 7px near, far and after resize', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, source, null, {segmentStarts: [2]})
    const {scene, camera} = drawFrame(), {start, end} = endpoints(scene)
    const paths = scene.children.filter(object => object instanceof Line2) as Line2[]
    expect(paths).toHaveLength(2)
    const first = paths[0].geometry.getAttribute('instanceStart')
    const last = paths[1].geometry.getAttribute('instanceEnd'), lastIndex = last.count - 1
    expect(start.position.distanceTo(new THREE.Vector3(first.getX(0), first.getY(0), first.getZ(0)))).toBeLessThan(.001)
    expect(end.position.distanceTo(new THREE.Vector3(last.getX(lastIndex), last.getY(lastIndex), last.getZ(lastIndex)))).toBeLessThan(.001)
    for (const endpoint of [start, end]) {
      const {x, z} = terrainPosition(endpoint === start ? source[0][0] : source[3][0], endpoint === start ? source[0][1] : source[3][1], terrain)
      expect(endpoint.position.y).toBeCloseTo(sceneHeight(triangleElevation(x, z, terrain), terrainModel(terrain)) + 1, 6)
      expect(projectedDiameter(endpoint, camera, 900)).toBeCloseTo(10, 6)
    }
    sandbox.updatePlacemarks([{id: 'middle', coordinates: gridCoordinate(.5, .5, terrain), label: '9', title: '沿途点'}])
    const middle = placemarkVisuals(scene, 'middle').sphere
    const geometries = [start.geometry, end.geometry, middle.geometry]
    const materials = [start.material, end.material, middle.material]
    const model = terrainModel(terrain), target = new THREE.Vector3(0, model.topHeight / 2, 0)
    let previousScale = start.scale.x
    for (const distance of [1000, 5000]) {
      camera.position.copy(target).add(new THREE.Vector3(0, distance * .65, distance))
      camera.lookAt(target)
      const renders = webgl.render.mock.calls.length
      webgl.render.mockImplementationOnce((renderedScene: THREE.Scene, renderedCamera: THREE.PerspectiveCamera) => {
        expect(renderedScene).toBe(scene); expect(renderedCamera).toBe(camera)
        for (const ball of [start, end, middle]) {
          expect(ball.visible).toBe(true)
          expect(projectedDiameter(ball, camera, 900)).toBeCloseTo(ball === middle ? 7 : 10, 6)
        }
      })
      sandbox.renderFrame()
      expect(webgl.render).toHaveBeenCalledTimes(renders + 1)
      expect(start.scale.x).not.toBeCloseTo(previousScale, 5)
      previousScale = start.scale.x
    }
    Object.defineProperties(holder, {clientWidth: {value: 600}, clientHeight: {value: 400}})
    resizeCallback!([], {} as ResizeObserver)
    sandbox.renderFrame()
    for (const [index, ball] of [start, end, middle].entries()) {
      expect(projectedDiameter(ball, camera, 600)).toBeCloseTo(ball === middle ? 7 : 10, 6)
      expect(ball.geometry).toBe(geometries[index]); expect(ball.material).toBe(materials[index])
    }
    expect(scene.getObjectByName('sandbox-route-start')).toBe(start)
    expect(scene.getObjectByName('sandbox-route-end')).toBe(end)
    sandbox.dispose(); holder.remove()
  })

  it('shows a source ball once when it overlaps an endpoint and restores endpoint balls when source markers are hidden or removed', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, source, null)
    const {scene, camera} = drawFrame(), {start, end} = endpoints(scene)
    expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    const markers = [
      {id: 'source-start', coordinates: [source[0][0], source[0][1]] as [number, number], label: '1', title: '出发点'},
      {id: 'source-end', coordinates: [source[3][0], source[3][1]] as [number, number], label: '2', title: '到达点'},
    ]
    sandbox.updatePlacemarks(markers)
    const sourceStart = placemarkVisuals(scene, 'source-start'), sourceEnd = placemarkVisuals(scene, 'source-end')
    expect(sourceStart.node.visible).toBe(true); expect(sourceEnd.node.visible).toBe(true)
    expect(sourceStart.sphere.position.distanceTo(start.position)).toBeLessThan(.001)
    expect(sourceEnd.sphere.position.distanceTo(end.position)).toBeLessThan(.001)
    expect(start.visible).toBe(false); expect(end.visible).toBe(false)
    expect(projectedDiameter(sourceStart.sphere, camera, 900)).toBeCloseTo(10, 6)
    expect(projectedDiameter(sourceEnd.sphere, camera, 900)).toBeCloseTo(10, 6)
    sandbox.updatePlacemarks(markers, {labelSize: 32})
    const model = terrainModel(terrain), target = new THREE.Vector3(0, model.topHeight / 2, 0)
    for (const distance of [1000, 5000]) {
      camera.position.copy(target).add(new THREE.Vector3(0, distance * .65, distance)); camera.lookAt(target)
      sandbox.renderFrame()
      expect(projectedDiameter(sourceStart.sphere, camera, 900)).toBeCloseTo(10, 6)
      expect(projectedDiameter(sourceEnd.sphere, camera, 900)).toBeCloseTo(10, 6)
      expect(start.visible).toBe(false); expect(end.visible).toBe(false)
    }
    sandbox.updatePlacemarks([{...markers[0], coordinates: gridCoordinate(.45, .45, terrain)}, markers[1]], {labelSize: 32})
    expect(placemarkVisuals(scene, 'source-start').sphere).toBe(sourceStart.sphere)
    expect(projectedDiameter(sourceStart.sphere, camera, 900)).toBeCloseTo(7, 6)
    expect(projectedDiameter(sourceEnd.sphere, camera, 900)).toBeCloseTo(10, 6)
    expect(start.visible).toBe(true); expect(end.visible).toBe(false)
    sandbox.updatePlacemarks(markers, {visible: false})
    expect(sourceStart.node.visible).toBe(false); expect(sourceEnd.node.visible).toBe(false)
    expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    sandbox.updatePlacemarks([markers[0]], {visible: true})
    expect(start.visible).toBe(false); expect(end.visible).toBe(true)
    sandbox.updatePlacemarks([])
    expect(start.visible).toBe(true); expect(end.visible).toBe(true)
    expect(scene.getObjectByName('sandbox-route-start')).toBe(start)
    expect(scene.getObjectByName('sandbox-route-end')).toBe(end)
    sandbox.dispose(); holder.remove()
  })

  it('releases shared endpoint geometry and endpoint materials once on rebuild and clears old endpoint state before an empty route', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, source, null)
    const first = drawFrame().scene, firstEndpoints = endpoints(first)
    expect(firstEndpoints.start.geometry).toBe(firstEndpoints.end.geometry)
    const firstResources = watchDisposal(first)
    sandbox.build(terrain, [source[1], source[2]], null)
    for (const listener of firstResources) expect(listener).toHaveBeenCalledTimes(1)
    expect(firstEndpoints.start.parent).toBeNull(); expect(firstEndpoints.end.parent).toBeNull()
    const second = drawFrame().scene, secondEndpoints = endpoints(second)
    expect(secondEndpoints.start).not.toBe(firstEndpoints.start)
    expect(secondEndpoints.end).not.toBe(firstEndpoints.end)
    expect(secondEndpoints.start.geometry).not.toBe(firstEndpoints.start.geometry)
    const secondResources = watchDisposal(second)
    sandbox.build(terrain, [], null)
    for (const listener of secondResources) expect(listener).toHaveBeenCalledTimes(1)
    const empty = drawFrame().scene
    expect(empty.getObjectByName('sandbox-route-start')).toBeUndefined()
    expect(empty.getObjectByName('sandbox-route-end')).toBeUndefined()
    expect(secondEndpoints.start.parent).toBeNull(); expect(secondEndpoints.end.parent).toBeNull()
    sandbox.renderFrame()
    sandbox.dispose(); sandbox.dispose()
    for (const listener of [...firstResources, ...secondResources]) expect(listener).toHaveBeenCalledTimes(1)
    holder.remove()
  })
})

describe('live sandbox route color', () => {
  const points: import('../src/protocol.ts').TrackPoint[] = [
    [120, 30.02, null, null], [120.005, 30.015, null, null],
    [120.015, 30.005, null, null], [120.02, 30, null, null],
  ]

  it('defaults to the shared track color and resets that default when rebuilding without a color override', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.updateRouteColor('#ffaa00')
    expect(animation).not.toHaveBeenCalled()
    sandbox.build(terrain, points, null)
    let scene = drawFrame().scene
    expect((scene.children.find(object => object instanceof Line2) as Line2).material.color.getHexString()).toBe(TRACK_COLOR.slice(1))
    sandbox.build(terrain, points, null, {routeColor: '#20a080'})
    scene = drawFrame().scene
    expect((scene.children.find(object => object instanceof Line2) as Line2).material.color.getHexString()).toBe('20a080')
    sandbox.build(terrain, points, null)
    scene = drawFrame().scene
    expect((scene.children.find(object => object instanceof Line2) as Line2).material.color.getHexString()).toBe(TRACK_COLOR.slice(1))
    sandbox.dispose()
    holder.remove()
  })

  it('recolors all segmented paths through the same material without changing geometry, markers, camera or captured canvas', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, points, null, {routeColor: '#20a080', segmentStarts: [2]})
    const {scene, camera} = drawFrame()
    const children = [...scene.children]
    const paths = scene.children.filter(object => object instanceof Line2) as Line2[]
    expect(paths).toHaveLength(2)
    const material = paths[0].material
    expect(paths[1].material).toBe(material)
    const geometries = paths.map(path => path.geometry)
    const position = camera.position.clone()
    const rotation = camera.quaternion.clone()
    const disposals = watchDisposal(scene)
    const canvas = sandbox.getCaptureCanvas()
    const frameCount = animation.mock.calls.length
    sandbox.updateRouteColor('#cc4400')
    expect(animation.mock.calls.length).toBe(frameCount + 1)
    sandbox.renderFrame()
    paths.forEach((path, index) => {
      expect(path.material).toBe(material)
      expect(path.material.color.getHexString()).toBe('cc4400')
      expect(path.geometry).toBe(geometries[index])
    })
    expect(scene.children).toEqual(children)
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-7)
    expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-7)
    expect(sandbox.getCaptureCanvas()).toBe(canvas)
    for (const listener of disposals) expect(listener).not.toHaveBeenCalled()
    expect(webgl.dispose).not.toHaveBeenCalled()
    sandbox.dispose()
    const disposedFrameCount = animation.mock.calls.length
    sandbox.updateRouteColor('#334455')
    expect(material.color.getHexString()).toBe('cc4400')
    expect(animation.mock.calls.length).toBe(disposedFrameCount)
    for (const listener of disposals) expect(listener).toHaveBeenCalledTimes(1)
    holder.remove()
  })
})

describe('live sandbox lighting and capture', () => {
  it('changes lighting and shadows without rebuilding geometry and restores defaults', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    const {scene, camera} = drawFrame()
    const meshes = scene.children.filter(object => object instanceof THREE.Mesh)
    const lights = scene.children.filter(object => object instanceof THREE.Light)
    const main = lights.find(light => light instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    const ambient = lights.find(light => light instanceof THREE.HemisphereLight) as THREE.HemisphereLight
    const disposals = watchDisposal(scene)
    const originalCamera = camera.position.clone()
    sandbox.updateLighting({azimuth: 90, elevation: 5, intensity: 1, ambient: 0.3, shadows: false})
    sandbox.renderFrame()
    expect(main.position.x).toBeGreaterThan(0)
    expect(Math.abs(main.position.z)).toBeLessThan(1e-8)
    expect(main.intensity).toBe(1)
    expect(ambient.intensity).toBe(0.3)
    expect(main.castShadow).toBe(false)
    expect(scene.children.filter(object => object instanceof THREE.Mesh)).toEqual(meshes)
    expect(camera.position.distanceTo(originalCamera)).toBeLessThan(1e-7)
    for (const listener of disposals) expect(listener).not.toHaveBeenCalled()
    sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING})
    expect(main.castShadow).toBe(true)
    expect(main.intensity).toBe(4.1)
    expect(ambient.intensity).toBe(0.65)
    const direction = main.position.clone().sub(main.target.position).normalize()
    expect(THREE.MathUtils.radToDeg(Math.atan2(direction.x, -direction.z))).toBeCloseTo(118)
    expect(THREE.MathUtils.radToDeg(Math.asin(direction.y))).toBeCloseTo(85)
    expect(main.shadow.mapSize.x).toBe(2048)
    expect(main.shadow.camera.far).toBeGreaterThan(main.shadow.camera.near)
    expect(main.shadow.camera.right).toBeGreaterThan(main.shadow.camera.left)
    expect(sandbox.getCaptureCanvas()).toBe(holder.querySelector('canvas'))
    sandbox.dispose()
    expect(sandbox.getCaptureCanvas()).toBeNull()
    holder.remove()
  })

  it('keeps shadows disabled in eco quality even when enabled in saved lighting', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null, {quality: 'eco', exaggeration: 2})
    const {scene} = drawFrame()
    const main = scene.children.find(object => object instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    expect(main.castShadow).toBe(false)
    sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING})
    expect(main.castShadow).toBe(false)
    sandbox.dispose()
    holder.remove()
  })

  it('stops requesting frames when controls have settled and schedules live edits', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    drawFrame()
    const settled = animation.mock.calls.length
    drawFrame()
    expect(animation.mock.calls.length).toBe(settled)
    sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING, azimuth: 0})
    expect(animation.mock.calls.length).toBe(settled + 1)
    drawFrame()
    const {scene} = drawFrame()
    const main = scene.children.find(object => object instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    expect(Math.abs(main.position.x)).toBeLessThan(1e-8)
    expect(main.position.z).toBeLessThan(0)
    sandbox.dispose()
    holder.remove()
  })
})

describe('shadow camera coverage', () => {
  it('keeps all eight terrain corners in the actual Three shadow frustum at extreme sun angles', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const narrow = {...terrain, widthMeters: 2000, depthMeters: 150, elevations: [0, 800, 100, 600]}
    sandbox.build(narrow, [], null, {exaggeration: 3})
    const {scene} = drawFrame()
    const main = scene.children.find(object => object instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    const model = terrainModel(narrow, 3)
    for (const azimuth of [0, 90, 180, 270, 315]) for (const elevation of [5, 35, 85]) {
      sandbox.updateLighting({...DEFAULT_SANDBOX_LIGHTING, azimuth, elevation})
      scene.updateMatrixWorld(true)
      main.shadow.updateMatrices(main)
      for (const x of [-narrow.widthMeters / 2, narrow.widthMeters / 2]) for (const y of [0, model.topHeight]) {
        for (const z of [-narrow.depthMeters / 2, narrow.depthMeters / 2]) {
          const projected = new THREE.Vector3(x, y, z).project(main.shadow.camera)
          expect(Math.abs(projected.x)).toBeLessThan(1)
          expect(Math.abs(projected.y)).toBeLessThan(1)
          expect(Math.abs(projected.z)).toBeLessThan(1)
        }
      }
    }
    sandbox.dispose()
    holder.remove()
  })
})

describe('executable sandbox shots', () => {
  it('captures detached camera state, restores exact views and isolates real OrbitControls damping during seeks', () => {
    const holder = container(), update = vi.spyOn(OrbitControls.prototype, 'update')
    const sandbox = new SandboxRenderer(holder)
    expect(sandbox.getCameraState()).toBeNull()
    sandbox.build(terrain, [], null)
    drawFrame()
    const controls = update.mock.contexts.at(-1) as unknown as {_sphericalDelta: THREE.Spherical}
    const fitted = sandbox.getCameraState()!
    fitted.position[0] += 100
    expect(sandbox.getCameraState()!.position[0]).not.toBe(fitted.position[0])
    const chosen = {position: [700, 900, 1000] as [number, number, number],
      target: [0, 200, 0] as [number, number, number], fov: 50}
    controls._sphericalDelta.theta = .4
    sandbox.setInteractionEnabled(false)
    update.mockClear()
    sandbox.applyCameraState(chosen)
    sandbox.renderFrame()
    drawFrame()
    expect(update).not.toHaveBeenCalled()
    expect(sandbox.getCameraState()).toEqual(chosen)
    expect(controls._sphericalDelta.theta).toBe(.4)
    sandbox.applyCameraState({...chosen, position: [300, 600, 800]})
    sandbox.renderFrame()
    sandbox.applyCameraState(chosen)
    sandbox.renderFrame()
    expect(sandbox.getCameraState()).toEqual(chosen)
    sandbox.setInteractionEnabled(true)
    expect(update).toHaveBeenCalledTimes(1)
    expect(controls._sphericalDelta.theta).toBe(0)
    expect(sandbox.getCameraState()).toEqual(chosen)
    sandbox.renderFrame()
    const restored = sandbox.getCameraState()!
    restored.position.forEach((value, index) => expect(value).toBeCloseTo(chosen.position[index], 7))
    restored.target.forEach((value, index) => expect(value).toBeCloseTo(chosen.target[index], 7))
    expect(restored.fov).toBe(50)
    const before = sandbox.getCameraState()
    expect(() => sandbox.applyCameraState({...chosen, fov: NaN})).toThrow(RangeError)
    expect(sandbox.getCameraState()).toEqual(before)
    sandbox.dispose()
    expect(sandbox.getCameraState()).toBeNull()
    holder.remove()
  })

  it('notifies only after rendered frames and supports unsubscribe, throwing consumers and disposal', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    const listener = vi.fn(), broken = vi.fn(() => { throw new Error('consumer') })
    const off = sandbox.onFrameRendered(listener), offBroken = sandbox.onFrameRendered(broken)
    sandbox.build(terrain, [], null)
    expect(listener).not.toHaveBeenCalled()
    drawFrame()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(broken).toHaveBeenCalledTimes(1)
    sandbox.renderFrame()
    expect(listener).toHaveBeenCalledTimes(2)
    off(); offBroken()
    sandbox.renderFrame()
    expect(listener).toHaveBeenCalledTimes(2)
    sandbox.dispose()
    sandbox.onFrameRendered(listener)()
    sandbox.renderFrame()
    expect(listener).toHaveBeenCalledTimes(2)
    holder.remove()
  })

  it('clips existing DEM-draped instances by distance, preserves every segment gap and restores backward seeks without rebuilding', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    const source: import('../src/protocol.ts').TrackPoint[] = [
      [120, 30.02, 9999, null], [120.005, 30.02, -9999, null],
      [120.015, 30, 9999, null], [120.02, 30, -9999, null],
    ]
    sandbox.build(terrain, source, null, {segmentStarts: [0, 2]})
    const {scene} = drawFrame()
    const paths = scene.children.filter(object => object instanceof Line2) as Line2[]
    expect(paths).toHaveLength(2)
    const geometries = paths.map(path => path.geometry), children = [...scene.children]
    const ends = paths.map(path => path.geometry.getAttribute('instanceEnd'))
    const fullEnds = ends.map(attribute => Array.from({length: attribute.count}, (_, index) =>
      [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]))
    const disposals = watchDisposal(scene)
    sandbox.setRouteProgress(0)
    expect(paths.every(path => !path.visible && path.geometry.instanceCount === 0)).toBe(true)
    sandbox.setRouteProgress(.25)
    expect(paths[0].visible).toBe(true)
    expect(paths[1].visible).toBe(false)
    const x = ends[0].getX(0), y = ends[0].getY(0), z = ends[0].getZ(0)
    expect(x).toBeCloseTo(-375, 4)
    const model = terrainModel(terrain)
    expect(y).toBeCloseTo(sceneHeight(triangleElevation(x, z, terrain), model) + 1, 4)
    sandbox.setRouteProgress(.75)
    expect(paths[0].visible).toBe(true)
    expect(paths[1].visible).toBe(true)
    expect(ends[1].getX(0)).toBeCloseTo(375, 4)
    sandbox.setRouteProgress(.25)
    expect(paths[1].visible).toBe(false)
    expect(ends[1].getX(0)).toBe(fullEnds[1][0][0])
    expect(ends[0].getX(0)).toBeCloseTo(-375, 4)
    sandbox.setRouteProgress(1)
    paths.forEach((path, index) => {
      expect(path.visible).toBe(true)
      expect(path.geometry).toBe(geometries[index])
      expect(path.geometry.instanceCount).toBe(ends[index].count)
      expect(Array.from({length: ends[index].count}, (_, item) => [
        ends[index].getX(item), ends[index].getY(item), ends[index].getZ(item)])).toEqual(fullEnds[index])
    })
    expect(scene.children).toEqual(children)
    for (const listener of disposals) expect(listener).not.toHaveBeenCalled()
    expect(() => sandbox.setRouteProgress(NaN)).toThrow(RangeError)
    sandbox.setRouteProgress(-1)
    expect(paths.every(path => !path.visible)).toBe(true)
    sandbox.setRouteProgress(2)
    expect(paths.every(path => path.visible)).toBe(true)
    sandbox.dispose()
    holder.remove()
  })

  it('projects georeferenced labels onto real DEM triangles in CSS pixels and hides off-scene or behind-camera points', () => {
    const holder = container(), sandbox = new SandboxRenderer(holder)
    sandbox.build(terrain, [], null)
    sandbox.setInteractionEnabled(false)
    const coordinate = gridCoordinate(.5, .5, terrain)
    const height = sceneHeight(triangleElevation(0, 0, terrain), terrainModel(terrain))
    sandbox.applyCameraState({position: [0, height, 1000], target: [0, height, 0], fov: 60})
    const center = sandbox.projectCoordinates(coordinate)
    expect(center.visible).toBe(true)
    expect(center.x).toBeCloseTo(450, 5)
    expect(center.y).toBeCloseTo(300, 5)
    expect(sandbox.projectCoordinates(coordinate, 100).y).toBeLessThan(center.y)
    expect(sandbox.projectCoordinates([121, 30.01])).toEqual({x: 0, y: 0, visible: false})
    expect(sandbox.projectCoordinates([NaN, 30.01]).visible).toBe(false)
    sandbox.applyCameraState({position: [0, height, 100], target: [0, height, 0], fov: 60})
    expect(sandbox.projectCoordinates([coordinate[0], 30]).visible).toBe(false)
    sandbox.dispose()
    expect(sandbox.projectCoordinates(coordinate)).toEqual({x: 0, y: 0, visible: false})
    holder.remove()
  })
})
