/** Small local panoramic surroundings; no image fetch or terrain sampling is involved. */
import * as THREE from 'three'

export interface SandboxEnvironment {
  panorama: THREE.DataTexture
  lighting: THREE.WebGLRenderTarget
}

export function createSandboxPanorama(background: string): THREE.DataTexture {
  const width = 256, height = 128
  const pixels = new Uint8Array(width * height * 4)
  const base = new THREE.Color(background)
  const white = new THREE.Color('#ffffff')
  const zenith = base.clone().lerp(new THREE.Color('#718aa6'), 0.4)
  const horizon = base.clone().lerp(white, 0.62)
  const ground = base.clone().lerp(new THREE.Color('#727869'), 0.4).multiplyScalar(0.78)
  const nadir = ground.clone().multiplyScalar(0.62)
  const row = new THREE.Color(), pixel = new THREE.Color()
  for (let y = 0; y < height; y++) {
    const elevation = (y / (height - 1) - 0.5) * Math.PI
    // A lowered, soft horizon keeps the bands visible from the sandbox's fitted overhead view.
    const aboveHorizon = elevation + 0.45
    if (aboveHorizon >= 0) row.copy(horizon).lerp(zenith, THREE.MathUtils.smoothstep(aboveHorizon, 0, 1.8))
    else row.copy(horizon).lerp(ground, THREE.MathUtils.smoothstep(-aboveHorizon, 0, 0.24))
      .lerp(nadir, THREE.MathUtils.smoothstep(-aboveHorizon, 0.25, 1.12))
    for (let x = 0; x < width; x++) {
      const longitude = x / (width - 1) * Math.PI * 2
      const daylight = Math.max(0, Math.cos(longitude - 3.4)) ** 8
        * Math.exp(-(((aboveHorizon - 0.55) / 0.55) ** 2)) * 0.08
      pixel.copy(row).lerp(white, daylight).convertLinearToSRGB()
      const offset = (y * width + x) * 4
      pixels[offset] = Math.round(THREE.MathUtils.clamp(pixel.r, 0, 1) * 255)
      pixels[offset + 1] = Math.round(THREE.MathUtils.clamp(pixel.g, 0, 1) * 255)
      pixels[offset + 2] = Math.round(THREE.MathUtils.clamp(pixel.b, 0, 1) * 255)
      pixels[offset + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.needsUpdate = true
  return texture
}

/** Track temporary render targets through the public renderer API, including an interrupted PMREM pass. */
export function createSandboxEnvironment(renderer: THREE.WebGLRenderer, background: string): SandboxEnvironment {
  const panorama = createSandboxPanorama(background)
  const originalSetter = renderer.setRenderTarget
  const previous = renderer.getRenderTarget()
  const previousFace = renderer.getActiveCubeFace()
  const previousMip = renderer.getActiveMipmapLevel()
  const previousXr = renderer.xr.enabled
  const previousClear = renderer.autoClear
  type RenderTarget = NonNullable<Parameters<THREE.WebGLRenderer['setRenderTarget']>[0]>
  const allocated = new Set<RenderTarget>()
  const listeners = new Map<RenderTarget, () => void>()
  let generator: THREE.PMREMGenerator | null = null
  let lighting: THREE.WebGLRenderTarget | null = null
  renderer.setRenderTarget = function (...args) {
    const target = args[0]
    if (target && target !== previous && !listeners.has(target)) {
      const released = () => allocated.delete(target)
      allocated.add(target)
      listeners.set(target, released)
      target.addEventListener('dispose', released)
    }
    originalSetter.apply(renderer, args)
  }
  try {
    generator = new THREE.PMREMGenerator(renderer)
    lighting = generator.fromEquirectangular(panorama)
    return {panorama, lighting}
  } catch (error) {
    panorama.dispose()
    throw error
  } finally {
    renderer.setRenderTarget = originalSetter
    originalSetter.call(renderer, previous, previousFace, previousMip)
    renderer.xr.enabled = previousXr
    renderer.autoClear = previousClear
    generator?.dispose()
    // The generator owns intermediate targets, while its returned target belongs to the caller.
    for (const target of allocated) if (target !== lighting) target.dispose()
    for (const [target, listener] of listeners) target.removeEventListener('dispose', listener)
  }
}
