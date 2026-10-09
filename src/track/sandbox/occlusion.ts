/** Camera-to-marker visibility against the displayed, filled DEM triangle mesh. */
import type * as THREE from 'three'
import { sceneHeight, triangleElevation, type TerrainModel } from './geometry.ts'
import type { TerrainGrid } from './types.ts'

interface BoundaryCursor {next: number; step: number}
/** Grid coordinates are linear along a ray; each cursor visits boundaries in ray order. */
function boundaries(start: number, end: number, startT: number, endT: number): BoundaryCursor {
  const delta = end - start, interval = endT - startT
  if (delta === 0 || interval <= 0) return {next: Infinity, step: Infinity}
  const boundary = delta > 0 ? Math.floor(start) + 1 : Math.ceil(start) - 1
  const next = startT + (boundary - start) / delta * interval
  return {next: next > startT && next < endT ? next : Infinity, step: interval / Math.abs(delta)}
}

/** A regular height field needs only grid/diagonal crossings, without raycasting every face. */
export class SandboxTerrainOcclusion {
  private tolerance: number

  constructor(private terrain: TerrainGrid, private model: TerrainModel) {
    this.tolerance = Math.max(.01, Math.max(terrain.widthMeters, terrain.depthMeters) * 1e-6, model.topHeight * 1e-6)
  }

  isOccluded(from: THREE.Vector3, target: THREE.Vector3): boolean {
    if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(from.z)
      || !Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) return false
    const dx = target.x - from.x, dy = target.y - from.y, dz = target.z - from.z
    const distance = Math.hypot(dx, dy, dz)
    if (!Number.isFinite(distance) || distance <= this.tolerance) return false

    // Exclude the target itself so tiny mesh/anchor differences do not hide grounded markers.
    let enter = 0, exit = 1 - this.tolerance / distance
    const clip = (origin: number, delta: number, minimum: number, maximum: number): boolean => {
      if (delta === 0) return origin >= minimum && origin <= maximum
      const a = (minimum - origin) / delta, b = (maximum - origin) / delta
      enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b))
      return enter <= exit
    }
    const {widthMeters: width, depthMeters: depth, columns, rows} = this.terrain
    if (!clip(from.x, dx, -width / 2, width / 2)
      || !clip(from.z, dz, -depth / 2, depth / 2)
      || !clip(from.y, dy, 0, this.model.topHeight)) return false

    const gx = (t: number) => ((from.x + dx * t) / width + .5) * (columns - 1)
    const gz = (t: number) => ((from.z + dz * t) / depth + .5) * (rows - 1)
    const ax = gx(enter), bx = gx(exit), az = gz(enter), bz = gz(exit)
    const crossings = [boundaries(ax, bx, enter, exit), boundaries(az, bz, enter, exit),
      boundaries(ax + az, bx + bz, enter, exit)]
    const blockedAt = (t: number): boolean => {
      const x = from.x + dx * t, y = from.y + dy * t, z = from.z + dz * t
      return y - sceneHeight(triangleElevation(x, z, this.terrain), this.model) < -this.tolerance
    }

    // Between crossings both the ray and the actual triangle surface are linear.
    // A ray below that surface is inside the solid terrain, including side/bottom entries.
    if (blockedAt(enter)) return true
    let previous = enter
    while (previous < exit) {
      const next = Math.min(exit, crossings[0].next, crossings[1].next, crossings[2].next)
      if (!(next > previous)) return false
      if (blockedAt(next)) return true
      if (next === exit) return false
      for (const cursor of crossings) {
        if (cursor.next > next) continue
        const following = cursor.next + cursor.step
        cursor.next = following > next && following < exit ? following : Infinity
      }
      previous = next
    }
    return false
  }
}
