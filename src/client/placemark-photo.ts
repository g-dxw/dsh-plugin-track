import { API } from '../protocol.ts'
import { localPlacemarkPhoto, placemarkPhotoUrl, PLACEMARK_PHOTO_ACCEPT, PLACEMARK_PHOTO_MAX_BYTES } from '../track/placemark-photos.ts'

/** Check a whole selection before starting any upload; the server also verifies image bytes. */
export function validatePlacemarkPhotoFile(file: File): void {
  if (!file.size) throw new Error(`${file.name}：图片文件为空，请重新选择`)
  if (file.size > PLACEMARK_PHOTO_MAX_BYTES) throw new Error(`${file.name}：每张图片最多 20 MB，请压缩后重试`)
  if (/\.(?:svgz?|html?|xhtml)$/iu.test(file.name) || (file.type && !PLACEMARK_PHOTO_ACCEPT.split(',').includes(file.type.toLowerCase()))) {
    throw new Error(`${file.name}：请选择 JPEG、PNG、WebP、GIF 或 AVIF 图片，不支持 SVG 或网页文件`)
  }
}

/** Copy an image into this track's local storage; association is saved separately by the drawer. */
export async function uploadPlacemarkPhoto(trackId: string, file: File): Promise<string> {
  validatePlacemarkPhotoFile(file)
  placemarkPhotoUrl(trackId, '0'.repeat(64) + '.jpg')
  let response: Response
  try {
    response = await fetch(`${API}/placemark-photos?id=${encodeURIComponent(trackId)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: {'content-type': file.type || 'application/octet-stream', 'x-cqai-track': '1'}, body: file,
    })
  } catch {throw new Error('无法连接本地图片服务，请检查连接后重试')}
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('本地图片服务暂未就绪，请稍后重试或重启应用')
  }
  const value: unknown = await response.json().catch(() => null)
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!response.ok) {
    const message = typeof result?.error === 'string' ? result.error : typeof result?.message === 'string' ? result.message : `图片上传失败（HTTP ${response.status}），请重试`
    throw new Error(message)
  }
  const photo = localPlacemarkPhoto(result?.url)
  if (!photo || photo.trackId !== trackId) throw new Error('图片服务返回的本地图片地址无效，请重试')
  return placemarkPhotoUrl(photo.trackId, photo.filename)
}
