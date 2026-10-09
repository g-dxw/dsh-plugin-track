// @vitest-environment jsdom
import * as THREE from 'three'
import { MercatorCoordinate, LngLat, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from 'maplibre-gl'
import type { Line2 } from 'three/addons/lines/Line2.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapFloatingPlacemarkLayer, MAP_FLOATING_PLACEMARK_LAYER } from '../src/track/map-floating-placemarks.ts'
import { TRACK_ENDS_SOURCE } from '../src/track/trail-layer.ts'
import type { SandboxPlacemark } from '../src/track/sandbox/types.ts'

const webgl = vi.hoisted(() => ({instances: [] as unknown[], options: [] as unknown[], render: vi.fn(), resetState: vi.fn(), setViewport: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn(), clearDepth: vi.fn(), setSize: vi.fn()}))
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  return {...actual, WebGLRenderer: class {
    constructor(options: {canvas: HTMLCanvasElement; context: unknown}) {webgl.instances.push(this); webgl.options.push(options); this.domElement = options.canvas}
    domElement: HTMLCanvasElement
    autoClear = true
    toneMapping = actual.NoToneMapping
    outputColorSpace = ''
    render = webgl.render
    resetState = webgl.resetState
    setViewport = webgl.setViewport
    dispose = webgl.dispose
    forceContextLoss = webgl.forceContextLoss
    clearDepth = webgl.clearDepth
    setSize = webgl.setSize
  }}
})

const points: readonly SandboxPlacemark[] = [
  {id: 'a', coordinates: [120.002, 30.001], label: '1', title: '谷地补给点'},
  {id: 'group', coordinates: [120.008, 30.009], label: 'G1', title: '山脊休息组', groupCount: 2},
]
beforeEach(() => {
  vi.clearAllMocks(); webgl.instances = []; webgl.options = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null
    return {font: '', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter',
      scale: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(), measureText: function(this: CanvasRenderingContext2D, text: string) {
        return {width: Array.from(text).length * Number(this.font.match(/(\d+)px/)?.[1] ?? 16)}
      }} as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext)
})
afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks()})

async function fixture() {
  // Use MapLibre's actual 5.24 matrix implementation, not an approximation of its
  // bearing/pitch/terrain transform. importActual avoids typechecking library sources.
  const {MercatorTransform} = await vi.importActual<{MercatorTransform: new () => MapLibreMap['transform']}>('../node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts')
  const transform = new MercatorTransform()
  transform.resize(900, 600, true); transform.setZoom(13); transform.setCenter(new LngLat(120.005, 30.005))
  transform.setPitch(60); transform.setBearing(35); transform.setElevation(400)
  const getModel = vi.spyOn(transform, 'getMatrixForModel')
  const holder = document.createElement('div'), canvas = document.createElement('canvas')
  Object.defineProperties(canvas, {clientWidth: {value: 900, configurable: true}, clientHeight: {value: 600, configurable: true}})
  canvas.width = 1800; canvas.height = 1200; holder.appendChild(canvas); document.body.appendChild(holder)
  const gl = {clearDepth: vi.fn(), clear: vi.fn()}, layers = new Map<string, CustomLayerInterface>(), listeners = new Map<string, Set<() => void>>()
  const mock = {
    transform, getCanvas: () => canvas, getCenter: () => transform.center,
    getStyle: () => ({sources: {[TRACK_ENDS_SOURCE]: {type: 'geojson', data: {type: 'FeatureCollection', features: [{type: 'Feature', geometry: {type: 'Point', coordinates: [...points[0].coordinates]}, properties: {role: 'start'}}]}}}}),
    queryTerrainElevation: vi.fn<(coordinates: [number, number]) => number | null>(() => 400),
    terrain: {depthAtPoint: vi.fn((_point: {x: number; y: number}) => 0)},
    on: vi.fn((event: string, callback: () => void) => {if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(callback)}),
    off: vi.fn((event: string, callback: () => void) => {listeners.get(event)?.delete(callback)}),
    getLayer: vi.fn((id: string) => layers.get(id)),
    addLayer: vi.fn((layer: CustomLayerInterface) => {layers.set(layer.id, layer); layer.onAdd?.(mock as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext)}),
    removeLayer: vi.fn((id: string) => {const layer = layers.get(id); layers.delete(id); layer?.onRemove?.(mock as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext)}),
    triggerRepaint: vi.fn(),
  }
  const helper = new MapFloatingPlacemarkLayer(mock as unknown as MapLibreMap, holder)
  const args = (): CustomRenderMethodInput => ({nearZ: transform.nearZ, farZ: transform.farZ, fov: transform.fov * Math.PI / 180,
    projectionMatrix: transform.projectionMatrix, modelViewProjectionMatrix: transform.modelViewProjectionMatrix,
    defaultProjectionData: transform.getProjectionDataForCustomLayer(false), shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''}})
  const draw = () => {layers.get(MAP_FLOATING_PLACEMARK_LAYER)!.render(gl as unknown as WebGL2RenderingContext, args()); const last = webgl.render.mock.calls.at(-1)!; return {scene: last[0] as THREE.Scene, camera: last[1] as THREE.PerspectiveCamera}}
  const emit = (name: string) => {for (const listener of listeners.get(name) ?? []) listener()}
  return {helper, mock, holder, canvas, layers, listeners, gl, transform, getModel, args, draw, emit}
}
function visuals(scene: THREE.Scene, id: string) {
  const node = scene.children.find(node => node.userData.id === id) as THREE.Group
  return {node, sphere: node.getObjectByName('placemark-anchor') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>,
    line: node.getObjectByName('placemark-connector') as Line2, label: node.getObjectByName('placemark-label') as THREE.Sprite}
}
function diameter(sphere: THREE.Mesh<THREE.SphereGeometry>, camera: THREE.Camera): number {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(sphere.scale.x)
  const a = sphere.position.clone().sub(right).project(camera), b = sphere.position.clone().add(right).project(camera)
  return Math.abs(b.x - a.x) * 900 / 2
}
function labelHeight(label: THREE.Sprite, camera: THREE.Camera): number {
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(label.scale.y)
  const a = label.position.clone().project(camera), b = label.position.clone().add(up).project(camera)
  return Math.abs(b.y - a.y) * 600 / 2
}

describe('native floating placemarks', () => {
  it('starts hidden and renders into the map canvas/context without clearing, resizing or taking ownership of that context', async () => {
    const f = await fixture()
    expect(f.mock.addLayer).not.toHaveBeenCalled()
    f.helper.update(points, {visible: false}); expect(f.mock.addLayer).not.toHaveBeenCalled()
    f.helper.update(points, {visible: true}); f.draw()
    expect(f.mock.addLayer.mock.calls[0][0]).toMatchObject({id: MAP_FLOATING_PLACEMARK_LAYER, type: 'custom', renderingMode: '3d'})
    expect(webgl.options[0]).toMatchObject({canvas: f.canvas, context: f.gl})
    expect(webgl.instances[0]).toMatchObject({autoClear: false})
    expect(webgl.resetState).toHaveBeenCalledOnce(); expect(webgl.setViewport).toHaveBeenCalledWith(0, 0, 1800, 1200)
    expect(f.canvas.width).toBe(1800); expect(f.canvas.height).toBe(1200)
    expect(webgl.clearDepth).not.toHaveBeenCalled(); expect(webgl.setSize).not.toHaveBeenCalled(); expect(f.gl.clear).not.toHaveBeenCalled()
    f.helper.update(points, {visible: false}); const count = webgl.render.mock.calls.length; f.draw(); expect(webgl.render).toHaveBeenCalledTimes(count)
    f.helper.dispose(); expect(webgl.forceContextLoss).not.toHaveBeenCalled(); expect(f.canvas.parentElement).toBe(f.holder)
  })

  it('does not attach or request map frames for initially hidden points or repeated hidden updates/events', async () => {
    const f = await fixture()
    for (let index = 0; index < 2; index++) {
      f.helper.update(points, {visible: false})
      for (const event of ['styledata', 'terrain', 'sourcedata', 'webglcontextrestored']) f.emit(event)
    }
    expect(f.mock.addLayer).not.toHaveBeenCalled(); expect(f.mock.triggerRepaint).not.toHaveBeenCalled()
    expect(webgl.instances).toHaveLength(0); expect(webgl.render).not.toHaveBeenCalled()
    expect(f.helper.getButton('a')).toBeUndefined(); expect(f.holder.querySelector<HTMLElement>('.trk-map-floating-placemarks')!.hidden).toBe(true)
    f.helper.dispose()
    expect([...f.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(f.holder.querySelector('.trk-map-floating-placemarks')).toBeNull(); expect(f.canvas.parentElement).toBe(f.holder)
  })

  it('requests exactly one clearing frame when visible points become hidden and reuses their resources when shown again', async () => {
    const f = await fixture()
    // Omitting visible also means visible, so that transition needs the same clearing frame.
    f.helper.update(points); const {scene, camera} = f.draw(), original = visuals(scene, 'group')
    const button = f.helper.getButton('group'), renderer = webgl.instances[0]
    const resources = [original.sphere.geometry, original.sphere.material, original.line.geometry, original.line.material, original.label.material, original.label.material.map!]
    const disposed = resources.map(resource => {const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener})
    f.mock.triggerRepaint.mockClear()
    f.helper.update(points, {visible: false})
    expect(f.mock.triggerRepaint).toHaveBeenCalledOnce(); expect(scene.visible).toBe(false)
    expect(f.holder.querySelector<HTMLElement>('.trk-map-floating-placemarks')!.hidden).toBe(true)
    const rendered = webgl.render.mock.calls.length, modeled = f.getModel.mock.calls.length, queried = f.mock.queryTerrainElevation.mock.calls.length
    f.draw()
    expect(webgl.render).toHaveBeenCalledTimes(rendered); expect(f.getModel).toHaveBeenCalledTimes(modeled)
    expect(f.mock.queryTerrainElevation).toHaveBeenCalledTimes(queried)
    f.helper.update(points, {visible: false})
    for (const event of ['styledata', 'terrain', 'sourcedata', 'webglcontextrestored']) f.emit(event)
    expect(f.mock.triggerRepaint).toHaveBeenCalledOnce(); expect(f.mock.addLayer).toHaveBeenCalledOnce()
    for (const callback of disposed) expect(callback).not.toHaveBeenCalled()
    f.helper.update(points, {visible: true}); const restored = f.draw()
    expect(f.mock.triggerRepaint).toHaveBeenCalledTimes(2); expect(restored.scene).toBe(scene); expect(restored.camera).toBe(camera)
    expect(scene.visible).toBe(true); expect(f.holder.querySelector<HTMLElement>('.trk-map-floating-placemarks')!.hidden).toBe(false)
    const current = visuals(scene, 'group')
    expect(current.node).toBe(original.node); expect(f.helper.getButton('group')).toBe(button); expect(webgl.instances[0]).toBe(renderer)
    const currentResources = [current.sphere.geometry, current.sphere.material, current.line.geometry, current.line.material, current.label.material, current.label.material.map!]
    currentResources.forEach((resource, index) => expect(resource).toBe(resources[index]))
    expect(f.mock.addLayer).toHaveBeenCalledOnce()
    for (const callback of disposed) expect(callback).not.toHaveBeenCalled()
    f.helper.dispose(); f.helper.dispose()
    for (const callback of disposed) expect(callback).toHaveBeenCalledOnce()
    expect(webgl.dispose).toHaveBeenCalledOnce(); expect(webgl.forceContextLoss).not.toHaveBeenCalled()
  })

  it('defers style restoration while hidden and cleans both generations of owned resources', async () => {
    const f = await fixture(); f.helper.update(points, {visible: true}); const {scene} = f.draw(), old = visuals(scene, 'group')
    const oldButton = f.helper.getButton('group')!
    const watch = (visual: ReturnType<typeof visuals>) => [visual.sphere.geometry, visual.sphere.material, visual.line.geometry, visual.line.material, visual.label.material, visual.label.material.map!]
      .map(resource => {const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener})
    const oldDisposed = watch(old)
    f.helper.update(points, {visible: false}); f.mock.removeLayer(MAP_FLOATING_PLACEMARK_LAYER)
    for (const callback of oldDisposed) expect(callback).toHaveBeenCalledOnce()
    expect(oldButton.isConnected).toBe(false)
    f.mock.triggerRepaint.mockClear(); f.emit('styledata'); f.emit('webglcontextrestored')
    expect(f.mock.addLayer).toHaveBeenCalledOnce(); expect(f.mock.triggerRepaint).not.toHaveBeenCalled()
    f.helper.update(points, {visible: true}); const restored = f.draw(), current = visuals(restored.scene, 'group'), currentDisposed = watch(current)
    expect(f.mock.addLayer).toHaveBeenCalledTimes(2); expect(f.mock.triggerRepaint).toHaveBeenCalledOnce()
    expect(restored.scene).not.toBe(scene); expect(current.node).not.toBe(old.node); expect(f.helper.getButton('group')).not.toBe(oldButton)
    f.helper.dispose(); f.helper.dispose()
    for (const callback of [...oldDisposed, ...currentDisposed]) expect(callback).toHaveBeenCalledOnce()
    expect(webgl.dispose).toHaveBeenCalledTimes(2); expect(webgl.forceContextLoss).not.toHaveBeenCalled()
    expect([...f.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(f.holder.querySelector('.trk-map-floating-placemarks')).toBeNull(); expect(f.canvas.parentElement).toBe(f.holder)
  })

  it('uses the actual MapLibre matrices across bearing/pitch and keeps billboard dimensions, sphere size and leader width in CSS pixels', async () => {
    const f = await fixture(); f.helper.update(points, {visible: true})
    for (const [bearing, pitch, zoom] of [[0, 0, 12], [45, 50, 13], [150, 75, 14], [-120, 60, 15]]) {
      f.transform.setBearing(bearing); f.transform.setPitch(pitch); f.transform.setZoom(zoom)
      const {scene, camera} = f.draw(), args = f.args(), origin = f.getModel.mock.calls.at(-1)![0]
      const model = new THREE.Matrix4().fromArray(f.transform.getMatrixForModel(origin, 0))
      const expected = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(model)
      for (const id of ['a', 'group']) {
        const {sphere, line, label} = visuals(scene, id)
        const a = sphere.position.clone().applyMatrix4(expected), b = sphere.position.clone().project(camera)
        expect(a.distanceTo(b)).toBeLessThan(1e-7)
        expect(Math.abs(diameter(sphere, camera) - (id === 'a' ? 10 : 7))).toBeLessThan(.001)
        expect(Math.abs(labelHeight(label, camera) - 30)).toBeLessThan(.001)
        expect(line.material.linewidth).toBe(1.5); expect(line.material.resolution.toArray()).toEqual([900, 600])
        expect(camera.projectionMatrix.elements[11]).toBeCloseTo(-1, 10)
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
        expect(right.length()).toBeCloseTo(1, 5); expect(up.length()).toBeCloseTo(1, 5); expect(right.dot(up)).toBeCloseTo(0, 5)
      }
    }
    f.helper.dispose()
  })

  it('samples the already exaggerated native DEM every frame and updates height/leader distances while preserving anchors, source data and resource identities', async () => {
    const f = await fixture(), before = JSON.stringify(points)
    f.helper.update(points, {visible: true, labelHeight: 1}); const {scene} = f.draw(), original = visuals(scene, 'group')
    const anchor = original.sphere.position.clone(), height = original.label.position.y - anchor.y, map = original.label.material.map, geometry = original.line.geometry
    f.helper.update(points, {visible: true, labelHeight: 3}); f.draw()
    const high = visuals(scene, 'group')
    expect(high.node).toBe(original.node); expect(high.line.geometry).toBe(geometry); expect(high.label.material.map).toBe(map)
    expect(high.sphere.position.equals(anchor)).toBe(true); expect(high.label.position.y - anchor.y).toBeCloseTo(height * 3, 8)
    expect(high.line.geometry.getAttribute('instanceDistanceEnd').getX(0)).toBeCloseTo(height * 3, 3)
    f.mock.queryTerrainElevation.mockReturnValue(450); f.draw()
    expect(high.sphere.position.y).toBeGreaterThan(anchor.y); expect(f.mock.queryTerrainElevation).toHaveBeenCalledWith([...points[1].coordinates])
    const origin = f.getModel.mock.calls.at(-1)![0], nativePoint = high.sphere.position.clone().applyMatrix4(new THREE.Matrix4().fromArray(f.transform.getMatrixForModel(origin, 0)))
    const altitude = new MercatorCoordinate(nativePoint.x, nativePoint.y, nativePoint.z).toAltitude()
    expect(altitude).toBeGreaterThan(450); expect(altitude).toBeLessThan(452)
    expect(JSON.stringify(points)).toBe(before)
    f.helper.dispose()
  })

  it('keeps all GPU parts submitted when terrain hides the ground, and independently removes only wholly hidden label hit targets', async () => {
    const f = await fixture(); f.helper.update(points, {visible: true}); const {scene, camera} = f.draw()
    const projected = visuals(scene, 'a').label.position.clone().project(camera)
    expect(Math.abs(projected.x)).toBeLessThan(1); expect(Math.abs(projected.y)).toBeLessThan(1); expect(projected.z).toBeGreaterThan(-1); expect(projected.z).toBeLessThan(1)
    f.mock.terrain.depthAtPoint.mockReturnValue(.0001); f.draw()
    for (const point of points) {
      const {node, sphere, line, label} = visuals(scene, point.id)
      expect(node.visible).toBe(true); expect(sphere.material.depthTest).toBe(true); expect(line.material.depthTest).toBe(true); expect(label.material.depthTest).toBe(true)
      expect(f.helper.getButton(point.id)!.hidden).toBe(true)
    }
    f.mock.terrain.depthAtPoint.mockReturnValue(0); f.draw()
    expect(f.helper.getButton('a')!.hidden).toBe(false)
    f.helper.dispose()
  })

  it('compares actual packed RGBA8 terrain depth and label NDC z in the same units near the far plane', async () => {
    const f = await fixture(); f.helper.update(points, {visible: true}); const {scene, camera} = f.draw()
    const z = visuals(scene, 'a').label.position.clone().project(camera).z
    // Emulate the actual terrain_depth pack shader, UNORM8 writes, and
    // depthAtPoint byte decode, instead of supplying an ideal depth float.
    const encoded = (depth: number) => {
      const shifts = [16777216, 65536, 256, 1], components = shifts.map(shift => (depth * shift) % 1)
      const packed = components.map((value, index) => index === 0 ? value : value - components[index - 1] / 256)
      const bytes = packed.map(value => Math.round(value * 255))
      return (bytes[0] / 16777216 + bytes[1] / 65536 + bytes[2] / 256 + bytes[3]) / 256
    }
    expect(z).toBeGreaterThan(.97)
    f.mock.terrain.depthAtPoint.mockReturnValue(encoded(z + .0002)); f.draw()
    expect(f.helper.getButton('a')!.hidden).toBe(false)
    f.mock.terrain.depthAtPoint.mockReturnValue(encoded(z - .0002)); f.draw()
    expect(f.helper.getButton('a')!.hidden).toBe(true)
    f.mock.terrain.depthAtPoint.mockReturnValue(encoded(z + .0002)); f.draw()
    expect(f.helper.getButton('a')!.hidden).toBe(false)
    expect(visuals(scene, 'a').label.material.depthTest).toBe(true)
    f.helper.dispose()
  })

  it('accepts exposed label/keyboard picks but rejects a terrain-covered pointer position on a partially exposed billboard', async () => {
    const f = await fixture(), selected = vi.fn(); f.helper.update(points, {visible: true, onSelect: selected})
    const {scene, camera} = f.draw(), label = visuals(scene, 'a').label
    const bottom = label.position.clone().project(camera), x = (bottom.x + 1) * 900 / 2, y = (1 - bottom.y) * 600 / 2
    f.mock.terrain.depthAtPoint.mockImplementation(point => point.y > y - 15 ? .0001 : 0); f.draw()
    const button = f.helper.getButton('a')!; expect(button.hidden).toBe(false)
    button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1, clientX: x, clientY: y - 2})); expect(selected).not.toHaveBeenCalled()
    button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1, clientX: x, clientY: y - 26})); expect(selected).toHaveBeenCalledWith('a')
    button.click(); expect(selected).toHaveBeenCalledTimes(2)
    f.helper.dispose()
  })

  it('restores its layer after a style replacement and disposes only its own resources/listeners exactly once', async () => {
    const f = await fixture(); f.helper.update(points, {visible: true}); const {scene} = f.draw(), old = visuals(scene, 'group')
    const resources = [old.sphere.geometry, old.sphere.material, old.line.geometry, old.line.material, old.label.material, old.label.material.map!]
    const disposed = resources.map(resource => {const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener})
    f.mock.removeLayer(MAP_FLOATING_PLACEMARK_LAYER); f.emit('styledata'); f.draw()
    expect(f.mock.addLayer).toHaveBeenCalledTimes(2); expect(f.helper.getButton('group')!.textContent).toBe('山脊休息组')
    for (const callback of disposed) expect(callback).toHaveBeenCalledOnce()
    f.helper.dispose(); f.helper.dispose()
    for (const callback of disposed) expect(callback).toHaveBeenCalledOnce()
    expect(webgl.dispose).toHaveBeenCalledTimes(2); expect(webgl.forceContextLoss).not.toHaveBeenCalled()
    expect([...f.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(f.holder.querySelector('.trk-map-floating-placemarks')).toBeNull(); expect(f.canvas.parentElement).toBe(f.holder)
  })

  it('unwraps date-line placemarks into a small local extent and follows the visible world copy without changing source coordinates', async () => {
    const f = await fixture(), seam: readonly SandboxPlacemark[] = [
      {id: 'east', coordinates: [179.995, 30], label: 'E'}, {id: 'west', coordinates: [-179.995, 30.003], label: 'W'},
    ], source = JSON.stringify(seam)
    f.transform.setCenter(new LngLat(179.998, 30.0015)); f.helper.update(seam, {visible: true})
    const {scene} = f.draw(), east = visuals(scene, 'east'), west = visuals(scene, 'west')
    const distance = Math.abs(east.sphere.position.x - west.sphere.position.x)
    expect(distance).toBeGreaterThan(900); expect(distance).toBeLessThan(1000)
    expect(east.label.position.y - east.sphere.position.y).toBeLessThan(100)
    expect(Math.abs(east.sphere.position.x)).toBeLessThan(600); expect(Math.abs(west.sphere.position.x)).toBeLessThan(600)
    f.transform.setCenter(new LngLat(-179.998, 30.0015)); f.draw()
    expect(f.helper.getButton('east')!.hidden).toBe(false); expect(f.helper.getButton('west')!.hidden).toBe(false)
    expect(Math.abs(east.sphere.position.x - west.sphere.position.x)).toBeCloseTo(distance, 5)
    expect(JSON.stringify(seam)).toBe(source)
    f.helper.dispose()
  })

  it('retries a pending style, filters invalid/duplicate points and preserves selected group metadata', async () => {
    const f = await fixture()
    f.mock.addLayer.mockImplementationOnce(() => {throw new Error('style not yet loaded')})
    f.helper.update([...points, points[0], {id: 'invalid', coordinates: [0, Infinity], label: 'bad'}], {visible: true, selectedId: 'group'})
    expect(f.helper.getButton('group')).toBeUndefined(); f.emit('styledata'); f.draw()
    expect(f.holder.querySelectorAll('[data-floating-placemark]').length).toBe(2)
    expect(f.helper.getButton('group')!.getAttribute('aria-pressed')).toBe('true'); expect(f.helper.getButton('group')!.getAttribute('aria-label')).toContain('2 个子点')
    f.helper.dispose()
  })
})
