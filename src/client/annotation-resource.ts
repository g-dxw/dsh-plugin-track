import {storeResourceAnnotation} from './resources-api.ts'
import {SVG_ANNOTATION_MAX_BYTES, SVG_ANNOTATION_MAX_PIXELS} from '../track/resources.ts'

export interface AnnotationImageSnapshot {trackId: string; name: string; svg: string}

/** Rasterize the complete export artwork, independently of selection and viewport chrome. */
export async function renderAnnotationPng(svg: string, requestedScale = 2): Promise<Blob> {
  const scene = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const element = scene.documentElement, width = Number(element.getAttribute('width')), height = Number(element.getAttribute('height'))
  if (scene.querySelector('parsererror') || element.localName !== 'svg' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 10000 || height > 10000) throw new Error('标注画布尺寸无效')
  await document.fonts?.ready
  const url = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'})), image = new Image()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('标注画布无法转换为图片'))
      timer = setTimeout(() => reject(new Error('标注图片转换超时')), 15000)
      image.src = url
    })
    clearTimeout(timer)
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    if (!context) throw new Error('当前设备无法生成 PNG 标注图')
    let scale = Math.min(2, requestedScale, 4096 / Math.max(width, height), Math.sqrt(SVG_ANNOTATION_MAX_PIXELS / (width * height)))
    for (let attempt = 0; attempt < 6; attempt++, scale *= .75) {
      canvas.width = Math.max(1, Math.floor(width * scale)); canvas.height = Math.max(1, Math.floor(height * scale))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('PNG 标注图生成超时')), 15000)
        canvas.toBlob(value => value && value.size ? resolve(value) : reject(new Error('PNG 标注图生成失败')), 'image/png')
      })
      clearTimeout(timer)
      if (blob.type !== 'image/png') throw new Error('当前设备未返回 PNG 格式')
      if (blob.size <= SVG_ANNOTATION_MAX_BYTES) return blob
    }
    throw new Error('PNG 标注图仍超过 10 MiB，请减少画布配图后重试')
  } finally {
    clearTimeout(timer); image.onload = null; image.onerror = null; URL.revokeObjectURL(url)
  }
}

export async function storeAnnotationImage(snapshot: AnnotationImageSnapshot): Promise<void> {
  const png = await renderAnnotationPng(snapshot.svg, 1)
  await storeResourceAnnotation(snapshot.trackId, snapshot.name, png)
}
