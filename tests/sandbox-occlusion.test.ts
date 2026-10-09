import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { sceneHeight, terrainModel, terrainSides, terrainTop, triangleElevation, type GeometryData } from '../src/track/sandbox/geometry.ts'
import { SandboxTerrainOcclusion } from '../src/track/sandbox/occlusion.ts'
import type { TerrainGrid } from '../src/track/sandbox/types.ts'

function grid(columns = 2, rows = 2, elevations = Array(columns * rows).fill(0), widthMeters = 100, depthMeters = 100): TerrainGrid {
  return {bounds: [119, 30, 119.1, 30.1], columns, rows, elevations, widthMeters, depthMeters}
}
function point(x: number, y: number, z: number) {return new THREE.Vector3(x, y, z)}
function fixture(terrain: TerrainGrid) {
  const model = terrainModel(terrain, 1)
  return {model, checker: new SandboxTerrainOcclusion(terrain, model)}
}
const flat = grid()
const ridge = grid(5, 3, Array.from({length: 15}, (_, index) => index % 5 === 2 ? 80 : 0))
const splitTriangle = grid(2, 2, [0, 0, 0, 100])

function geometry(data: GeometryData): THREE.BufferGeometry {
  const result = new THREE.BufferGeometry()
  result.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  result.setIndex(new THREE.BufferAttribute(data.indices, 1))
  return result
}
/** Real meshes form the same closed top, cut sides, and bottom as the renderer. */
function meshOcclusion(terrain: TerrainGrid, from: THREE.Vector3, target: THREE.Vector3): boolean {
  const model = terrainModel(terrain, 1), material = new THREE.MeshBasicMaterial({side: THREE.DoubleSide})
  const bottom = new THREE.PlaneGeometry(terrain.widthMeters, terrain.depthMeters)
  bottom.rotateX(Math.PI / 2)
  const geometries = [geometry(terrainTop(terrain, model)), geometry(terrainSides(terrain, model)), bottom]
  const meshes = geometries.map(value => new THREE.Mesh(value, material))
  for (const mesh of meshes) mesh.updateMatrixWorld(true)
  const ray = new THREE.Raycaster(from, target.clone().sub(from).normalize(), 0, from.distanceTo(target) - .02)
  try {return ray.intersectObjects(meshes, false).length > 0}
  finally {for (const value of geometries) value.dispose(); material.dispose()}
}

describe('regular DEM terrain occlusion', () => {
  it('keeps lifted ground anchors visible from above without mutating terrain, model, or vectors', () => {
    const {model, checker} = fixture(flat), from = point(-70, 100, 20)
    const target = point(20, sceneHeight(triangleElevation(20, 0, flat), model) + .2, 0)
    const before = structuredClone({terrain: flat, model, from: from.toArray(), target: target.toArray()})
    expect(checker.isOccluded(from, target)).toBe(false)
    expect({terrain: flat, model, from: from.toArray(), target: target.toArray()}).toEqual(before)
    expect(checker.isOccluded(point(0, 90, 0), point(0, 30.2, 0))).toBe(false)
  })

  it('hides a far slope behind a mountain ridge and restores it from the same side', () => {
    const {checker} = fixture(ridge), left = point(-35, 31, 7), right = point(35, 31, 7)
    expect(checker.isOccluded(point(-60, 70, 7), right)).toBe(true)
    expect(checker.isOccluded(point(60, 70, 7), right)).toBe(false)
    expect(checker.isOccluded(point(60, 70, 7), left)).toBe(true)
    expect(checker.isOccluded(point(-60, 70, 7), left)).toBe(false)
    expect(checker.isOccluded(point(-60, 130, 7), point(35, 150, 7))).toBe(false)
  })

  it('follows the real triangle partition rather than bilinear interpolation', () => {
    const {model, checker} = fixture(splitTriangle)
    // This whole segment lies in the low a/c/b face, whose height is 30 metres.
    // Bilinear interpolation would incorrectly raise the surface to 50.25 m at its target.
    const from = point(-60, 46, -40), target = point(-5, 46, -5)
    expect(sceneHeight(triangleElevation(target.x, target.z, splitTriangle), model)).toBe(30)
    expect(checker.isOccluded(from, target)).toBe(false)
    expect(checker.isOccluded(point(60, 80, 25), point(-30, 31, -20))).toBe(true)
  })

  it('includes cut sides and the bottom while handling vertical and parallel-axis rays', () => {
    const {checker} = fixture(flat)
    expect(checker.isOccluded(point(100, 15, 0), point(-100, 15, 0))).toBe(true)
    expect(checker.isOccluded(point(0, -50, 0), point(0, 90, 0))).toBe(true)
    expect(checker.isOccluded(point(0, 15, 0), point(0, 90, 0))).toBe(true)
    expect(checker.isOccluded(point(0, 90, 0), point(0, 31, 0))).toBe(false)
    expect(checker.isOccluded(point(51, -50, 0), point(51, 90, 0))).toBe(false)
    expect(checker.isOccluded(point(100, 45, 0), point(-100, 45, 0))).toBe(false)
    expect(checker.isOccluded(point(100, -1, 0), point(-100, -1, 0))).toBe(false)
  })

  it('uses only a small geometric tolerance and excludes near-target self intersections', () => {
    const {checker} = fixture(flat)
    expect(checker.isOccluded(point(100, 30, 0), point(-100, 30, 0))).toBe(false)
    expect(checker.isOccluded(point(100, 29.995, 0), point(-100, 29.995, 0))).toBe(false)
    expect(checker.isOccluded(point(100, 29.98, 0), point(-100, 29.98, 0))).toBe(true)
    expect(checker.isOccluded(point(0, 90, 0), point(0, 29.995, 0))).toBe(false)
    expect(checker.isOccluded(point(0, 90, 0), point(0, 29.9, 0))).toBe(true)
  })

  it('returns safely for coincident, tiny, non-finite, and overflowed vectors', () => {
    const {checker} = fixture(flat), target = point(0, 31, 0)
    expect(checker.isOccluded(target, target)).toBe(false)
    expect(checker.isOccluded(target, point(0, 31.001, 0))).toBe(false)
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(checker.isOccluded(point(invalid, 40, 0), target)).toBe(false)
      expect(checker.isOccluded(point(0, 40, 0), point(0, invalid, 0))).toBe(false)
    }
    expect(checker.isOccluded(point(Number.MAX_VALUE, 40, 0), point(-Number.MAX_VALUE, 31, 0))).toBe(false)
  })

  it('traverses a fine regular grid without losing narrow mountain ridges', () => {
    const size = 257
    const terrain = grid(size, size, Array.from({length: size * size}, (_, index) => index % size === 128 ? 80 : 0), 200, 160)
    const {checker} = fixture(terrain)
    expect(checker.isOccluded(point(-130, 65, 7), point(70, 31, 7))).toBe(true)
    expect(checker.isOccluded(point(130, 65, 7), point(70, 31, 7))).toBe(false)
    expect(checker.isOccluded(point(130, 65, 7), point(-70, 31, 7))).toBe(true)
    expect(checker.isOccluded(point(-130, 140, 7), point(70, 150, 7))).toBe(false)
  })

  it.each([
    {name: 'flat lifted anchor', terrain: flat, from: [-70, 100, 20], target: [20, 31, 0]},
    {name: 'flat vertical anchor', terrain: flat, from: [0, 90, 0], target: [0, 31, 0]},
    {name: 'side wall', terrain: flat, from: [100, 15, 7], target: [-100, 15, 7]},
    {name: 'bottom face', terrain: flat, from: [7, -50, 9], target: [7, 90, 9]},
    {name: 'above the whole flat mesh', terrain: flat, from: [100, 45, 7], target: [-100, 45, 7]},
    {name: 'ridge from the rear', terrain: ridge, from: [-60, 70, 7], target: [35, 31, 7]},
    {name: 'ridge from the front', terrain: ridge, from: [60, 70, 7], target: [35, 31, 7]},
    {name: 'ridge in reverse', terrain: ridge, from: [60, 70, 7], target: [-35, 31, 7]},
    {name: 'low triangle face', terrain: splitTriangle, from: [-60, 46, -40], target: [-5, 46, -5]},
    {name: 'uneven side behind the high face', terrain: splitTriangle, from: [60, 80, 25], target: [-30, 31, -20]},
  ])('agrees with real DoubleSide Three meshes for $name', ({terrain, from, target}) => {
    const origin = point(from[0], from[1], from[2]), destination = point(target[0], target[1], target[2])
    expect(fixture(terrain).checker.isOccluded(origin, destination)).toBe(meshOcclusion(terrain, origin, destination))
  })
})
