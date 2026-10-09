import type {Scene} from './vendor/geomotion/renderer/scene-types.ts'

/** Fit prepared photographs above the credit band, without altering saved layers or imported artwork. */
export function fitVideoMaterialImages(scene: Scene, width: number, height: number, sources: ReadonlySet<string>, dimensions: (source: string) => {width: number; height: number} | null): Scene {
  if (!(width > 0 && height > 0) || !sources.size) return scene
  const images = scene.images.map(image => {
    if (!sources.has(image.style.src) || image.style.anchor !== 'topRight') return image
    const size = dimensions(image.style.src)
    if (!size || !(size.width > 0 && size.height > 0) || !Number.isFinite(size.width + size.height)) return image
    const scale = height / 1080, caption = image.style.caption.trim() ? 30 * scale : 0
    const available = Math.max(1, height * (.91 - image.style.y) - Math.max(0, image.offsetY * scale) - caption)
    const maximum = available * (size.width / size.height) / (width * Math.max(1, image.zoom))
    if (image.style.width <= maximum) return image
    return {...image, style: {...image.style, width: maximum}}
  })
  return images.every((image, index) => image === scene.images[index]) ? scene : {...scene, images}
}