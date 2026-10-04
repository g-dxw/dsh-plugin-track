import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'
import { preparePlacemarkPhotoCache } from './placemark-photo-cache.ts'

/** Load a selected link only, then embed bounded pixels into the saved canvas. */
export async function readLinkedAnnotationPhoto(url: string, trackId?: string): Promise<string> {
  const valid = imageLink(url)
  if (!valid) throw new Error('请输入 HTTP 或 HTTPS 图片链接')
  const signal=AbortSignal.timeout(15000)
  if(trackId)await preparePlacemarkPhotoCache(trackId,[valid],signal)
  const response = await fetch(trackId ? placemarkPhotoThumbnailUrl(trackId, valid) : valid, {signal, credentials: trackId ? 'same-origin' : 'omit'})
  if (!response.ok) throw new Error('图片链接加载失败，请检查链接或上传本地图片')
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('单张原图不能超过 8 MB')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('图片链接没有返回图片内容')
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      size += next.value.byteLength
      if (size > 8 * 1024 * 1024) throw new Error('单张原图不能超过 8 MB')
      chunks.push(new Uint8Array(next.value))
    }
  } finally {await reader.cancel()}
  const blob = new Blob(chunks, {type: response.headers.get('content-type')?.split(';')[0] || ''})
  return readAnnotationPhoto(new File([blob], 'linked-photo', {type: blob.type}))
}

/** Normalize user-picked photos into bounded local JPEGs for SVG and model references. */
export async function readAnnotationPhoto(file: File): Promise<string> {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
  if(file.size>8*1024*1024)throw new Error('单张原图不能超过 8 MB')
  const url=URL.createObjectURL(file),image=new Image()
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
    await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('图片无法读取'));timer=setTimeout(()=>reject(new Error('图片读取超时')),10000);image.src=url})
    const scale=Math.min(1,1024/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas')
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale))
    const context=canvas.getContext('2d');if(!context)throw new Error('当前设备无法处理图片')
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height)
    for(const quality of [.82,.65,.45]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<=700000)return data}
    throw new Error('图片压缩后仍过大，请选择更小的图片')
  }finally{clearTimeout(timer);image.onload=null;image.onerror=null;URL.revokeObjectURL(url)}
}
