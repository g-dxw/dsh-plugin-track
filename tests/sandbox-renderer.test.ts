// @vitest-environment jsdom
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { TRACK_COLOR } from '../src/track/trail-layer.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandboxRenderer } from '../src/track/sandbox/renderer.ts'
import { DEFAULT_SANDBOX_COLORS, DEFAULT_SANDBOX_LIGHTING } from '../src/track/map-settings.ts'
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
    if (!(object instanceof THREE.Mesh)) return
    resources.add(object.geometry)
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
  it('anchors numbered groups on actual terrain triangles and skips invalid or outside coordinates', () => {
    const holder = container()
    const sandbox = new SandboxRenderer(holder)
    const hills = {...terrain, elevations: [0, 200, 100, 800]}
    sandbox.build(hills, [], null, {exaggeration: 2})
    const {camera} = drawFrame()
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
    expect(button.style.width).toBe('44px')
    expect(button.style.height).toBe('44px')
    expect(button.querySelector('.trk-sandbox-placemark-dot')?.textContent).toBe('G7')
    expect(button.querySelector('.trk-sandbox-placemark-count')?.textContent).toBe('3')
    expect(button.getAttribute('aria-label')).toBe('标记组 G7：山顶，3 个子点')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    const {x, z} = terrainPosition(...coordinates, hills)
    // Lower-right triangle is b/c/d, not the bilinear average of all four heights.
    const elevation = 800 + (100 - 800) * (1 - 0.7) + (200 - 800) * (1 - 0.6)
    const projection = new THREE.Vector3(x, sceneHeight(elevation, terrainModel(hills, 2)), z).project(camera)
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
    const meshes = [...scene.children]
    const resources = watchDisposal(scene)
    const position = camera.position.clone()
    const markers = [{id: 'one', coordinates: gridCoordinate(0.7, 0.5, terrain), label: '12', title: '观景台'}]
    const firstCallback = vi.fn(), latestCallback = vi.fn(), bubbled = vi.fn()
    sandbox.updatePlacemarks(markers, {onSelect: firstCallback})
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="one"]')!
    holder.addEventListener('pointerdown', bubbled)
    button.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    expect(bubbled).not.toHaveBeenCalled()
    button.click()
    expect(firstCallback).toHaveBeenCalledWith('one')
    sandbox.updatePlacemarks(markers, {visible: false, onSelect: latestCallback})
    expect(button.hidden).toBe(true)
    expect(holder.querySelector('.trk-sandbox-placemarks')?.getAttribute('hidden')).not.toBeNull()
    button.click()
    expect(latestCallback).not.toHaveBeenCalled()
    sandbox.updatePlacemarks(markers, {visible: true, selectedId: 'one', onSelect: latestCallback})
    expect(holder.querySelector('[data-sandbox-placemark="one"]')).toBe(button)
    expect(button.hidden).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('true')
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
    const {camera} = drawFrame()
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
    const projection = new THREE.Vector3(x, sceneHeight(elevation, terrainModel(terrain)), z).project(camera)
    expect(parseFloat(button.style.left)).toBeCloseTo((projection.x + 1) * 300, 6)
    expect(parseFloat(button.style.top)).toBeCloseTo((1 - projection.y) * 200, 6)
    expect(holder.querySelector('[data-sandbox-placemark="ridge"]')).toBe(button)
    expect(webgl.setSize).toHaveBeenLastCalledWith(600, 400, false)
    sandbox.dispose()
    holder.remove()
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
    sandbox.build(terrain, [], null)
    expect(holder.querySelector('.trk-sandbox-placemarks')).toBeNull()
    rebuilt.click()
    expect(selected).not.toHaveBeenCalled()
    sandbox.updatePlacemarks(markers, {onSelect: selected})
    const lost = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="old"]')!
    holder.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', {cancelable: true}))
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
