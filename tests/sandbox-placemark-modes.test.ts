// @vitest-environment jsdom
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAP_SETTINGS, sanitizePlacemarkPointRadius, sanitizePlacemarkPointSize } from '../src/track/map-settings.ts'
import { gridCoordinate } from '../src/track/sandbox/coordinates.ts'
import { sceneHeight, terrainModel, terrainTop, triangleElevation } from '../src/track/sandbox/geometry.ts'
import { SandboxPlacemarkLayer, type SandboxPlacemarkOptions } from '../src/track/sandbox/placemarks.ts'
import type { SandboxPlacemark, TerrainGrid } from '../src/track/sandbox/types.ts'

interface Paint {
  fills: string[]
  texts: {text: string; color: string; font: string; x: number; y: number}[]
  corners: number[][]
  starts: number[][]
  arcs: number[][]
  strokes: {color: string; width: number}[]
  images: {canvas: HTMLCanvasElement; x: number; y: number; width: number; height: number}[]
}
const flat: TerrainGrid = {bounds: [120, 30, 120.02, 30.02], rows: 3, columns: 3,
  widthMeters: 1000, depthMeters: 1000, elevations: Array(9).fill(100)}
let paints = new WeakMap<HTMLCanvasElement, Paint>()
let layers: SandboxPlacemarkLayer[] = []
let surfaces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = []

beforeEach(() => {
  paints = new WeakMap(); layers = []; surfaces = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null
    const paint: Paint = {fills: [], texts: [], corners: [], starts: [], arcs: [], strokes: [], images: []}
    paints.set(this, paint)
    return {
      canvas: this, font: '', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1,
      textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter', scale: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn((...values: number[]) => paint.starts.push(values)), lineTo: vi.fn(),
      quadraticCurveTo: vi.fn((...values: number[]) => paint.corners.push(values)), closePath: vi.fn(),
      arc: vi.fn((...values: number[]) => paint.arcs.push(values)),
      stroke: vi.fn(function(this: CanvasRenderingContext2D) {paint.strokes.push({color: String(this.strokeStyle), width: this.lineWidth})}),
      fill: vi.fn(function(this: CanvasRenderingContext2D) {paint.fills.push(String(this.fillStyle))}),
      drawImage: vi.fn((canvas: HTMLCanvasElement, x: number, y: number, width: number, height: number) => {
        paint.images.push({canvas, x, y, width, height})
      }),
      measureText: vi.fn(function(this: CanvasRenderingContext2D, text: string) {
        return {width: Array.from(text).length * Number(this.font.match(/(\d+)px/)?.[1] ?? 16) * .6}
      }), strokeText: vi.fn(),
      fillText: vi.fn(function(this: CanvasRenderingContext2D, text: string, x: number, y: number) {
        paint.texts.push({text, color: String(this.fillStyle), font: this.font, x, y})
      }),
    } as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext)
})
afterEach(() => {
  for (const layer of layers) layer.dispose()
  for (const surface of surfaces) {surface.geometry.dispose(); surface.material.dispose()}
  document.body.replaceChildren(); vi.restoreAllMocks()
})

function fixture(ground = flat) {
  const holder = document.createElement('div'); document.body.appendChild(holder)
  const scene = new THREE.Scene(), model = terrainModel(ground)
  const layer = new SandboxPlacemarkLayer(holder, ground, model, scene); layers.push(layer)
  const camera = new THREE.PerspectiveCamera(38, 1.5, .1, 10000)
  camera.position.set(0, 600, 2000); camera.lookAt(0, model.topHeight / 2, 0); camera.updateMatrixWorld()
  const project = (width = 900, height = 600) => {
    camera.aspect = width / height; camera.updateProjectionMatrix(); layer.project(camera, width, height)
  }
  const parts = (id: string) => {
    const group = scene.getObjectByName('sandbox-placemarks') as THREE.Group
    const node = group.children.find(child => child.userData.id === id) as THREE.Group
    const sphere = node.getObjectByName('placemark-anchor') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    const connector = node.getObjectByName('placemark-connector') as Line2
    const label = node.getObjectByName('placemark-label') as THREE.Sprite
    const button = holder.querySelector<HTMLButtonElement>('[data-sandbox-placemark="' + id + '"]')!
    return {group, node, sphere, connector, label, button}
  }
  return {holder, scene, model, layer, camera, project, parts}
}
function drawing(label: THREE.Sprite) {return paints.get(label.material.map!.image as HTMLCanvasElement)!}
function badgeDimensions(label: THREE.Sprite, camera: THREE.PerspectiveCamera, width: number, height: number) {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(label.scale.x / 2)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(label.scale.y / 2)
  const left = label.position.clone().sub(right).project(camera), rightEdge = label.position.clone().add(right).project(camera)
  const bottom = label.position.clone().sub(up).project(camera), top = label.position.clone().add(up).project(camera)
  return {width: (rightEdge.x - left.x) * width / 2, height: (top.y - bottom.y) * height / 2}
}
function mainBadge(label: THREE.Sprite, camera: THREE.PerspectiveCamera) {
  const canvas = label.material.map!.image as HTMLCanvasElement, [x, y, radius] = drawing(label).arcs[0]
  const units = label.scale.x / (canvas.width / 2)
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const center = label.position.clone().addScaledVector(right, (x - canvas.width / 4) * units)
    .addScaledVector(up, (canvas.height / 4 - y) * units)
  return {center, bottom: center.clone().addScaledVector(up, -radius * units), radius, units, right, up}
}
function mainBadgePixels(label: THREE.Sprite, camera: THREE.PerspectiveCamera, width: number, height: number) {
  const {center, radius, units, right, up} = mainBadge(label, camera)
  const left = center.clone().addScaledVector(right, -radius * units).project(camera)
  const rightEdge = center.clone().addScaledVector(right, radius * units).project(camera)
  const bottom = center.clone().addScaledVector(up, -radius * units).project(camera)
  const top = center.clone().addScaledVector(up, radius * units).project(camera)
  return {width: (rightEdge.x - left.x) * width / 2, height: (top.y - bottom.y) * height / 2}
}
function terrainSurface(ground: TerrainGrid, scene: THREE.Scene) {
  const data = terrainTop(ground, terrainModel(ground)), geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3)); geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))
  const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({side: THREE.DoubleSide}))
  scene.add(surface); surfaces.push(surface); surface.updateWorldMatrix(true, false); return surface
}
function blocked(surface: THREE.Mesh, from: THREE.Vector3, point: THREE.Vector3) {
  const delta = point.clone().sub(from), distance = delta.length()
  return new THREE.Raycaster(from, delta.normalize(), 0, distance - .001).intersectObject(surface, false).length > 0
}
function disposal(resource: THREE.BufferGeometry | THREE.Material | THREE.Texture) {
  const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener
}

const marker: SandboxPlacemark = {id: 'point', coordinates: gridCoordinate(1, 1, flat), label: '12', title: 'Summit'}
const groupMarker: SandboxPlacemark = {id: 'group', coordinates: gridCoordinate(1.2, 1, flat), label: 'G2', title: 'Photo group', groupCount: 3}

describe('sandbox point and floating marker modes', () => {
  it('keeps the floating name, dashed leader and ball when mode is omitted', () => {
    const {layer, project, parts, model} = fixture()
    layer.update([marker], {}); project()
    const {sphere, connector, label, button} = parts(marker.id)
    expect(button.dataset.sandboxPlacemarkMode).toBe('marker')
    expect(drawing(label).texts.map(item => item.text)).toEqual(['Summit'])
    expect(sphere.visible).toBe(true); expect(connector.visible).toBe(true)
    expect(label.center.toArray()).toEqual([.5, 0]); expect(label.position.y).toBeGreaterThan(sphere.position.y)
    expect(sphere.position.y).toBeCloseTo(sceneHeight(triangleElevation(0, 0, flat), model) + 1, 6)
    expect(label.material.depthTest).toBe(true); expect(connector.material.depthTest).toBe(true)
    expect(sphere.material.depthTest).toBe(true)
  })

  it('renders numbered and grouped canvas badges at unchanged ground anchors with native accessible targets', () => {
    const {layer, project, parts, camera, scene} = fixture()
    layer.update([marker, groupMarker], {mode: 'point'}); project()
    for (const [item, background] of [[marker, DEFAULT_MAP_SETTINGS.placemarkPointColor],
      [groupMarker, DEFAULT_MAP_SETTINGS.placemarkGroupColor]] as const) {
      const {node, sphere, connector, label, button} = parts(item.id), paint = drawing(label)
      expect(paint.fills).toEqual(item.groupCount === undefined ? [background] : [background, background])
      expect(paint.arcs[0].slice(0, 3)).toEqual([12, item.groupCount === undefined ? 12 : 21, 12])
      expect(paint.arcs[1].slice(0, 3)).toEqual([12, item.groupCount === undefined ? 12 : 21, 11])
      expect(paint.strokes).toEqual(item.groupCount === undefined ? [{color: '#ffffff', width: 2}]
        : [{color: '#ffffff', width: 2}, {color: '#ffffff', width: 1}])
      if (item.groupCount !== undefined) {
        expect(paint.arcs[2].slice(0, 3)).toEqual([26, 8, 8])
        expect(paint.texts[1]).toMatchObject({x: 26, y: 8})
      }
      expect(paint.texts[0]).toMatchObject({text: item.label, color: '#ffffff'})
      expect(paint.texts[0].font).toMatch(item.groupCount === undefined ? /^600 11px / : /^600 10px /)
      expect(paint.texts.map(value => value.text)).toEqual(item.groupCount ? [item.label, String(item.groupCount)] : [item.label])
      expect(button.title).toBe(item.title); expect(button.textContent).toBe(item.label)
      expect(button.getAttribute('aria-label')).toContain(item.title)
      expect(button.dataset.sandboxPlacemarkMode).toBe('point')
      expect(parseFloat(button.style.width)).toBe(44); expect(parseFloat(button.style.height)).toBe(44)
      expect(sphere.visible).toBe(false); expect(connector.visible).toBe(false); expect(node.visible).toBe(true)
      expect(label.center.toArray()).toEqual([.5, .5]); expect(label.material.depthTest).toBe(true)
      expect(label.material.depthWrite).toBe(false); expect(label.material.map).toBeInstanceOf(THREE.CanvasTexture)
      expect(label.parent?.parent?.parent).toBe(scene)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const padding = item.groupCount === undefined ? 0 : 10, textureWidth = 24 + padding
      const bottom = label.position.clone().addScaledVector(up, -label.scale.y / 2)
        .addScaledVector(right, -padding / 2 * label.scale.x / textureWidth)
      expect(bottom.distanceTo(sphere.position)).toBeLessThan(1e-7)
      const pixels = badgeDimensions(label, camera, 900, 600)
      expect(pixels.width).toBeCloseTo(textureWidth, 6)
      expect(pixels.height).toBeCloseTo(item.groupCount === undefined ? 24 : 33, 6)
      expect(pixels.width / textureWidth * 24).toBeCloseTo(24, 6)
      const center = label.position.clone().project(camera)
      expect(parseFloat(button.style.left)).toBeCloseTo((center.x + 1) * 450, 6)
      expect(parseFloat(button.style.top)).toBeCloseTo((1 - center.y) * 300, 6)
      expect(button.style.transform).toBe('translate(-50%,-50%)')
      expect(button.hidden).toBe(false)
    }
  })

  it('applies independent point and group colors, square size, percent corners and contrasting black text', () => {
    const {layer, project, parts} = fixture()
    layer.update([marker, groupMarker], {mode: 'point', pointSize: 48, pointRadius: 20,
      pointColor: ' #FFFFFF ', groupColor: '#fff8e0'}); project()
    for (const [item, background] of [[marker, '#ffffff'], [groupMarker, '#fff8e0']] as const) {
      const {label, button} = parts(item.id), canvas = label.material.map!.image as HTMLCanvasElement, paint = drawing(label)
      const top = item.groupCount === undefined ? 0 : 9, right = item.groupCount === undefined ? 0 : 10
      expect(canvas.width).toBe((48 + right) * 2); expect(canvas.height).toBe((48 + top) * 2)
      expect(paint.fills).toEqual(item.groupCount === undefined ? [background] : [background, background])
      expect(paint.starts[0]).toEqual([9.6, top])
      expect(paint.corners).toHaveLength(8); expect(paint.corners[0]).toEqual([48, top, 48, top + 9.6])
      expect(paint.starts[1][0]).toBeCloseTo(9.6, 8); expect(paint.starts[1][1]).toBe(top + 1)
      expect(paint.corners[4].slice(0, 3)).toEqual([47, top + 1, 47])
      expect(paint.corners[4][3]).toBeCloseTo(top + 9.6, 8)
      expect(paint.strokes[0]).toEqual({color: '#ffffff', width: 2})
      expect(paint.texts[0].font).toMatch(item.groupCount === undefined ? /^600 22px / : /^600 20px /)
      expect(paint.texts.every(value => value.color === '#000000')).toBe(true)
      expect(parseFloat(button.style.width)).toBe(48 + right); expect(parseFloat(button.style.height)).toBe(48 + top)
    }
  })

  it.each([
    {size: NaN, radius: NaN, expectedSize: 24, expectedRadius: 50},
    {size: -2, radius: -2, expectedSize: 12, expectedRadius: 0},
    {size: 100, radius: 100, expectedSize: 64, expectedRadius: 50},
    {size: 26.6, radius: 19.8, expectedSize: 27, expectedRadius: 20},
  ])('shares setting boundaries for size $size and radius $radius', ({size, radius, expectedSize, expectedRadius}) => {
    const {layer, project, parts, camera} = fixture()
    expect(sanitizePlacemarkPointSize(size)).toBe(expectedSize)
    expect(sanitizePlacemarkPointRadius(radius)).toBe(expectedRadius)
    layer.update([marker], {mode: 'point', pointSize: size, pointRadius: radius, pointColor: 'bad'}); project()
    const {label} = parts(marker.id), paint = drawing(label), canvas = label.material.map!.image as HTMLCanvasElement
    expect(canvas.width).toBe(expectedSize * 2); expect(canvas.height).toBe(expectedSize * 2)
    if (expectedRadius === 50) expect(paint.arcs[0][2]).toBe(expectedSize / 2)
    else expect(paint.starts[0][0]).toBeCloseTo(expectedSize * expectedRadius / 100)
    expect(paint.fills).toEqual([DEFAULT_MAP_SETTINGS.placemarkPointColor])
    expect(badgeDimensions(label, camera, 900, 600).width).toBeCloseTo(expectedSize, 6)
  })

  it('retains the complete group count without reducing the main badge diameter', () => {
    const {layer, project, parts} = fixture()
    layer.update([{...groupMarker, groupCount: 128}], {mode: 'point'}); project()
    const paint = drawing(parts(groupMarker.id).label)
    expect(paint.texts.map(value => value.text)).toEqual(['G2', '128'])
    expect(paint.arcs[0][2]).toBe(12); expect(paint.arcs[1][2]).toBe(11); expect(paint.arcs[2][2]).toBe(8)
  })

  it('shrinks a long point number to fit without truncating its source label or enlarging the badge', () => {
    const {layer, project, parts} = fixture(), label = '123456'
    layer.update([{...marker, label}], {mode: 'point'}); project()
    const paint = drawing(parts(marker.id).label)
    expect(paint.texts[0].text).toBe(label); expect(paint.texts[0].font).toMatch(/^600 6px /)
    expect(paint.arcs[0][2]).toBe(12); expect(paint.arcs[1][2]).toBe(11)
    expect(parts(marker.id).button.textContent).toBe(label)
  })

  it('hides and restores the count corner without changing group identity, font, full aria metadata or ground anchor', () => {
    const {layer, project, parts, camera} = fixture()
    layer.update([groupMarker], {mode: 'point'}); project()
    const {label, sphere, connector, button} = parts(groupMarker.id), anchor = sphere.position.clone(), geometry = connector.geometry
    const first = label.material.map!, firstDisposed = disposal(first)
    layer.update([groupMarker], {mode: 'point', pointShowCount: false}); project()
    const hidden = label.material.map!, canvas = hidden.image as HTMLCanvasElement, paint = drawing(label)
    expect(firstDisposed).toHaveBeenCalledTimes(1); expect(hidden).not.toBe(first)
    expect(canvas.width).toBe(48); expect(canvas.height).toBe(48)
    expect(paint.texts.map(value => value.text)).toEqual(['G2'])
    expect(paint.texts[0].font).toMatch(/^600 10px /); expect(paint.fills).toEqual([DEFAULT_MAP_SETTINGS.placemarkGroupColor])
    expect(paint.arcs).toHaveLength(2); expect(paint.arcs[0].slice(0, 3)).toEqual([12, 12, 12])
    expect(button.getAttribute('aria-label')).toContain('3'); expect(button.getAttribute('aria-label')).toContain('Photo group')
    expect(mainBadge(label, camera).bottom.distanceTo(anchor)).toBeLessThan(1e-7)
    expect(sphere.position.equals(anchor)).toBe(true); expect(connector.geometry).toBe(geometry)
    layer.update([{...groupMarker, groupCount: 4}], {mode: 'point', pointShowCount: false}); project()
    expect(label.material.map).toBe(hidden); expect(button.getAttribute('aria-label')).toContain('4')
    layer.update([{...groupMarker, groupCount: 4}], {mode: 'point', pointShowCount: true}); project()
    expect(drawing(label).texts.map(value => value.text)).toEqual(['G2', '4'])
    expect((label.material.map!.image as HTMLCanvasElement).width).toBe(68)
    expect((label.material.map!.image as HTMLCanvasElement).height).toBe(66)
    expect(mainBadge(label, camera).bottom.distanceTo(anchor)).toBeLessThan(1e-7)
  })

  it('composes original point and group names above their unchanged circular badges in the captured WebGL texture', () => {
    const {layer, project, parts, camera, scene} = fixture()
    layer.update([marker, groupMarker], {mode: 'point', pointShowName: true}); project()
    for (const source of [marker, groupMarker]) {
      const {label, sphere, button} = parts(source.id), paint = drawing(label)
      expect(paint.images).toHaveLength(1)
      const image = paint.images[0], name = paints.get(image.canvas)!
      expect(name.texts.map(value => value.text)).toEqual([source.title])
      expect(name.texts.every(value => value.color === '#ffffff' && /^600 16px /.test(value.font))).toBe(true)
      expect(paint.texts[0].text).toBe(source.label)
      expect(image.x + image.width / 2).toBeCloseTo(paint.arcs[0][0], 8)
      expect(image.y).toBe(0); expect(image.height + 4).toBeLessThanOrEqual(paint.arcs[0][1] - 12)
      expect(image.width * 2).toBe(image.canvas.width); expect(image.height * 2).toBe(image.canvas.height)
      expect(paint.arcs[0][2]).toBe(12); expect(paint.arcs[0][3]).toBe(0); expect(paint.arcs[0][4]).toBe(Math.PI * 2)
      expect(paint.arcs[1][2]).toBe(11); expect(paint.corners).toHaveLength(0)
      const pixels = mainBadgePixels(label, camera, 900, 600)
      expect(pixels.width).toBeCloseTo(24, 6); expect(pixels.height).toBeCloseTo(24, 6)
      expect(mainBadge(label, camera).bottom.distanceTo(sphere.position)).toBeLessThan(1e-7)
      expect(label.parent?.parent?.parent).toBe(scene); expect(label.material.map).toBeInstanceOf(THREE.CanvasTexture)
      expect(button.title).toBe(source.title); expect(button.getAttribute('aria-label')).toContain(source.title)
      expect(button.textContent).toBe(source.label)
    }
  })

  it('preserves the full original name while wrapping, limiting two lines and applying name-only color and size', () => {
    const {layer, project, parts, camera} = fixture(), title = 'Long original placemark name '.repeat(12).trim()
    layer.update([{...marker, title}], {mode: 'point', pointShowName: true, labelColor: '#112233', labelSize: 32}); project()
    const {label, button, sphere} = parts(marker.id), paint = drawing(label), image = paint.images[0], name = paints.get(image.canvas)!
    expect(name.texts).toHaveLength(2)
    expect(name.texts[1].text.endsWith('\u2026')).toBe(true)
    expect(name.texts.every(value => value.color === '#112233' && /^600 32px /.test(value.font))).toBe(true)
    expect(name.texts.every(value => Array.from(value.text).length * 32 * .6 <= 248)).toBe(true)
    expect(paint.texts[0]).toMatchObject({text: marker.label, color: '#ffffff'})
    expect(paint.arcs[0][2]).toBe(12); expect(mainBadgePixels(label, camera, 900, 600).width).toBeCloseTo(24, 6)
    expect(mainBadge(label, camera).bottom.distanceTo(sphere.position)).toBeLessThan(1e-7)
    expect(button.title).toBe(title); expect(button.getAttribute('aria-label')).toContain(title)
  })

  it('keeps name-less points compact and reuses badges when only a hidden name changes', () => {
    const {layer, project, parts} = fixture()
    layer.update([{...marker, title: '   '}], {mode: 'point', pointShowName: true}); project()
    const {label} = parts(marker.id), canvas = label.material.map!.image as HTMLCanvasElement
    expect(drawing(label).images).toHaveLength(0); expect(canvas.width).toBe(48); expect(canvas.height).toBe(48)
    layer.update([marker], {mode: 'point', pointShowName: false}); project()
    const texture = label.material.map
    layer.update([{...marker, title: 'Renamed summit'}], {mode: 'point', pointShowName: false, labelColor: '#123456', labelSize: 32}); project()
    expect(label.material.map).toBe(texture); expect(drawing(label).images).toHaveLength(0)
  })

  it('updates name and count settings in place, disposing only replaced textures and preserving badge pixels through resize', () => {
    const {layer, project, parts, camera} = fixture()
    const source = {...groupMarker, title: 'A wide original group name'}, options: SandboxPlacemarkOptions = {mode: 'point', pointShowName: true}
    layer.update([source], options); project()
    const {label, sphere, connector, node, button} = parts(source.id), texture = label.material.map!, retired = disposal(texture)
    const anchor = sphere.position.clone(), geometry = connector.geometry, material = label.material, position = camera.position.clone()
    layer.update([source], {...options, pointShowCount: false}); project()
    expect(retired).toHaveBeenCalledTimes(1); expect(label.material).toBe(material); expect(connector.geometry).toBe(geometry)
    expect(sphere.position.equals(anchor)).toBe(true); expect(camera.position.equals(position)).toBe(true)
    expect(parts(source.id).node).toBe(node); expect(parts(source.id).button).toBe(button)
    expect(drawing(label).texts.map(value => value.text)).toEqual(['G2'])
    const countOff = label.material.map!, countOffRetired = disposal(countOff)
    layer.update([{...source, title: 'Renamed group'}], {...options, pointShowCount: false}); project()
    expect(countOffRetired).toHaveBeenCalledTimes(1)
    expect(paints.get(drawing(label).images[0].canvas)!.texts[0].text).toBe('Renamed group')
    const renamed = label.material.map!, renamedRetired = disposal(renamed)
    layer.update([{...source, title: 'Renamed group'}], {...options, pointShowCount: false, labelColor: '#abcdef', labelSize: 24}); project()
    expect(renamedRetired).toHaveBeenCalledTimes(1)
    expect(paints.get(drawing(label).images[0].canvas)!.texts[0]).toMatchObject({color: '#abcdef'})
    const current = label.material.map!
    camera.position.set(1300, 900, -1700); camera.lookAt(anchor); project(600, 400)
    expect(label.material.map).toBe(current); expect(sphere.position.equals(anchor)).toBe(true)
    expect(mainBadge(label, camera).bottom.distanceTo(anchor)).toBeLessThan(1e-7)
    const pixels = mainBadgePixels(label, camera, 600, 400)
    expect(pixels.width).toBeCloseTo(24, 6); expect(pixels.height).toBeCloseTo(24, 6)
    const center = label.position.clone().project(camera)
    expect(parseFloat(button.style.left)).toBeCloseTo((center.x + 1) * 300, 6)
    expect(parseFloat(button.style.top)).toBeCloseTo((1 - center.y) * 200, 6)
    layer.update([{...source, title: 'Renamed group'}], {mode: 'point', pointShowCount: false, pointShowName: false}); project(600, 400)
    expect(drawing(label).images).toHaveLength(0); expect(drawing(label).arcs[0].slice(0, 3)).toEqual([12, 12, 12])
    expect((label.material.map!.image as HTMLCanvasElement).width).toBe(48)
    expect((label.material.map!.image as HTMLCanvasElement).height).toBe(48)
    expect(mainBadge(label, camera).bottom.distanceTo(anchor)).toBeLessThan(1e-7)
  })

  it('reuses nodes, geometry and camera through point-marker switches and retains independent marker styles', () => {
    const {layer, project, parts, camera, model} = fixture(), selected = vi.fn()
    const floating: SandboxPlacemarkOptions = {labelSize: 24, labelHeight: 2, labelColor: '#abcdef', connectorColor: '#112233', onSelect: selected}
    layer.update([marker], floating); project()
    const original = parts(marker.id), anchor = original.sphere.position.clone(), head = original.label.position.clone()
    const geometry = original.connector.geometry, sphereGeometry = original.sphere.geometry, material = original.label.material
    const initialTexture = material.map!, initialDisposed = disposal(initialTexture), position = camera.position.clone(), projection = camera.projectionMatrix.clone()
    const automaticLift = Math.max(5, 90, model.topHeight * .12)
    expect(head.y - anchor.y).toBeCloseTo(automaticLift * 2, 6)
    layer.update([marker], {...floating, mode: 'point', pointSize: 36, pointColor: '#334455'}); project()
    const badgeTexture = material.map!, badgeDisposed = disposal(badgeTexture), current = parts(marker.id)
    expect(initialDisposed).toHaveBeenCalledTimes(1); expect(badgeTexture).not.toBe(initialTexture)
    expect(current.node).toBe(original.node); expect(current.label).toBe(original.label); expect(current.button).toBe(original.button)
    expect(current.connector.geometry).toBe(geometry); expect(current.sphere.geometry).toBe(sphereGeometry)
    expect(current.sphere.position.equals(anchor)).toBe(true); expect(current.sphere.visible).toBe(false)
    expect(current.label.material).toBe(material); expect(camera.position.equals(position)).toBe(true)
    expect(camera.projectionMatrix.equals(projection)).toBe(true)
    layer.update([marker], {...floating, mode: 'marker'}); project()
    expect(badgeDisposed).toHaveBeenCalledTimes(1); expect(material.map).not.toBe(badgeTexture)
    expect(original.label.position.equals(head)).toBe(true); expect(original.label.center.toArray()).toEqual([.5, 0])
    expect(original.sphere.visible).toBe(true); expect(original.connector.visible).toBe(true)
    expect(original.sphere.material.color.getHexString()).toBe('112233')
    expect(drawing(original.label).texts.every(value => value.color === '#abcdef')).toBe(true)
    expect(original.connector.geometry).toBe(geometry); expect(original.sphere.position.equals(anchor)).toBe(true)
    expect(geometry.getAttribute('instanceDistanceEnd').getX(0)).toBeCloseTo(automaticLift * 2, 3)
    original.button.click(); expect(selected).toHaveBeenCalledWith(marker.id)
  })

  it('rebuilds only badge textures affected by their label, count or point style', () => {
    const {layer, project, parts} = fixture(), options: SandboxPlacemarkOptions = {mode: 'point'}
    layer.update([marker, groupMarker], options); project()
    const point = parts(marker.id), grouped = parts(groupMarker.id)
    const pointTexture = point.label.material.map!, groupTexture = grouped.label.material.map!
    const pointDisposed = disposal(pointTexture), groupDisposed = disposal(groupTexture)
    const renamed = [{...marker, title: 'New summit'}, {...groupMarker, title: 'New photos'}]
    layer.update(renamed, {...options, selectedId: marker.id, labelColor: '#123456', labelSize: 32, labelHeight: 3}); project()
    expect(point.label.material.map).toBe(pointTexture); expect(grouped.label.material.map).toBe(groupTexture)
    expect(point.button.title).toBe('New summit'); expect(point.button.getAttribute('aria-pressed')).toBe('true')
    expect(pointDisposed).not.toHaveBeenCalled(); expect(groupDisposed).not.toHaveBeenCalled()
    layer.update([renamed[0], {...renamed[1], groupCount: 4}], options); project()
    expect(point.label.material.map).toBe(pointTexture); expect(grouped.label.material.map).not.toBe(groupTexture)
    expect(groupDisposed).toHaveBeenCalledTimes(1); expect(drawing(grouped.label).texts.map(value => value.text)).toEqual(['G2', '4'])
    const revisedGroup = grouped.label.material.map
    layer.update([renamed[0], {...renamed[1], groupCount: 4}], {...options, pointColor: '#000000'}); project()
    expect(pointDisposed).toHaveBeenCalledTimes(1); expect(grouped.label.material.map).toBe(revisedGroup)
    expect(drawing(point.label).texts[0].color).toBe('#ffffff')
  })

  it('keeps the badge bottom anchored and its pixel dimensions stable after orbit, zoom and resize', () => {
    const {layer, project, parts, camera} = fixture()
    layer.update([marker], {mode: 'point', pointSize: 40}); project()
    const {sphere, label, button} = parts(marker.id), anchor = sphere.position.clone(), texture = label.material.map
    camera.position.set(1300, 900, -1700); camera.lookAt(anchor); project(600, 400)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    expect(label.position.clone().addScaledVector(up, -label.scale.y / 2).distanceTo(anchor)).toBeLessThan(1e-7)
    expect(sphere.position.equals(anchor)).toBe(true); expect(label.material.map).toBe(texture)
    const pixels = badgeDimensions(label, camera, 600, 400)
    expect(pixels.width).toBeCloseTo(40, 6); expect(pixels.height).toBeCloseTo(40, 6)
    const projection = label.position.clone().project(camera)
    expect(parseFloat(button.style.left)).toBeCloseTo((projection.x + 1) * 300, 6)
    expect(parseFloat(button.style.top)).toBeCloseTo((1 - projection.y) * 200, 6)
    expect(button.hidden).toBe(false)
  })

  it('keeps fallback endpoint balls when point mode hides its source ball and restores deduplication in marker mode', () => {
    const {layer, project, parts} = fixture()
    layer.update([marker], {mode: 'marker'}); project()
    const {sphere} = parts(marker.id), anchor = sphere.position.clone()
    expect(layer.hasVisibleAnchorAt(anchor)).toBe(true)
    layer.update([marker], {mode: 'point'}); project()
    expect(layer.hasVisibleAnchorAt(anchor)).toBe(false)
    layer.update([marker], {mode: 'marker'}); project()
    expect(layer.hasVisibleAnchorAt(anchor)).toBe(true)
    layer.update([marker], {mode: 'marker', visible: false}); project()
    expect(layer.hasVisibleAnchorAt(anchor)).toBe(false)
  })

  it('disables fully terrain-blocked point buttons, then restores selection without replacing the captured badge', () => {
    const ridge: TerrainGrid = {...flat, elevations: [0, 0, 0, 600, 600, 600, 0, 0, 0]}
    const {layer, project, parts, camera, scene} = fixture(ridge), selected = vi.fn()
    const surface = terrainSurface(ridge, scene)
    const source: SandboxPlacemark = {id: 'valley', coordinates: gridCoordinate(1, 1.6, ridge), label: '8', title: 'Valley'}
    layer.update([source], {mode: 'point', pointSize: 24, onSelect: selected})
    camera.position.set(0, 450, -2000); camera.lookAt(0, 450, 300); project()
    const {node, sphere, connector, label, button} = parts(source.id), texture = label.material.map
    expect(blocked(surface, camera.position, label.position)).toBe(true)
    expect(button.hidden).toBe(true); expect(node.visible).toBe(true); expect(label.visible).toBe(true)
    expect(label.material.depthTest).toBe(true); expect(label.material.depthWrite).toBe(false)
    expect(sphere.visible).toBe(false); expect(connector.visible).toBe(false)
    button.click(); expect(selected).not.toHaveBeenCalled()
    camera.position.set(0, 450, 2000); camera.lookAt(0, 450, 300); project()
    expect(blocked(surface, camera.position, label.position)).toBe(false); expect(button.hidden).toBe(false)
    const projection = label.position.clone().project(camera)
    button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1,
      clientX: (projection.x + 1) * 450, clientY: (1 - projection.y) * 300}))
    expect(selected).toHaveBeenCalledWith(source.id); expect(label.material.map).toBe(texture)
    layer.update([source], {mode: 'point', visible: false, onSelect: selected}); project()
    expect(node.visible).toBe(false); expect(button.hidden).toBe(true)
    layer.update([source], {mode: 'point', visible: true, onSelect: selected}); project()
    expect(node.visible).toBe(true); expect(button.hidden).toBe(false); expect(label.material.map).toBe(texture)
  })

  it('rejects terrain-covered pointer pixels on a partially exposed point badge using its actual centered sprite plane', () => {
    const ridge: TerrainGrid = {...flat, elevations: [0, 0, 0, 600, 600, 600, 0, 0, 0]}
    const {layer, project, parts, camera, scene} = fixture(ridge), selected = vi.fn(), surface = terrainSurface(ridge, scene)
    const source: SandboxPlacemark = {id: 'partial', coordinates: gridCoordinate(1, 1.08, ridge), label: '7'}
    layer.update([source], {mode: 'point', pointSize: 64, pointRadius: 0, onSelect: selected})
    camera.position.set(0, 450, -2000); camera.lookAt(0, 450, 300); project()
    const {sphere, label, button} = parts(source.id), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const lower = label.position.clone().addScaledVector(up, -label.scale.y * .35)
    const upper = label.position.clone().addScaledVector(up, label.scale.y * .35)
    expect(blocked(surface, camera.position, sphere.position)).toBe(true)
    expect(blocked(surface, camera.position, lower)).toBe(true)
    expect(blocked(surface, camera.position, upper)).toBe(false); expect(button.hidden).toBe(false)
    const click = (point: THREE.Vector3) => {
      const projection = point.clone().project(camera)
      button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1,
        clientX: (projection.x + 1) * 450, clientY: (1 - projection.y) * 300}))
    }
    click(lower); expect(selected).not.toHaveBeenCalled()
    click(upper); expect(selected).toHaveBeenCalledWith(source.id)
  })

  it('disposes replaced badges and removed nodes once, keeps shared assets alive, and ignores updates after final disposal', () => {
    const {layer, project, parts, holder, scene} = fixture()
    layer.update([marker, groupMarker], {mode: 'point'}); project()
    const point = parts(marker.id), grouped = parts(groupMarker.id)
    const shared = [point.sphere.geometry, point.sphere.material, point.connector.material].map(resource => disposal(resource))
    const removed = [point.connector.geometry, point.label.material, point.label.material.map!].map(resource => disposal(resource))
    const oldGroupTexture = grouped.label.material.map!, oldGroupDisposed = disposal(oldGroupTexture)
    layer.update([groupMarker], {mode: 'point', pointSize: 32}); project()
    for (const listener of removed) expect(listener).toHaveBeenCalledTimes(1)
    for (const listener of shared) expect(listener).not.toHaveBeenCalled()
    expect(oldGroupDisposed).toHaveBeenCalledTimes(1); expect(point.node.parent).toBeNull()
    const remaining = [grouped.connector.geometry, grouped.label.material, grouped.label.material.map!].map(resource => disposal(resource))
    layer.dispose(); layer.dispose(); layer.update([marker], {mode: 'point'}); project()
    for (const listener of [...removed, ...shared, ...remaining, oldGroupDisposed]) expect(listener).toHaveBeenCalledTimes(1)
    expect(holder.children).toHaveLength(0); expect(scene.getObjectByName('sandbox-placemarks')).toBeUndefined()
  })
})
