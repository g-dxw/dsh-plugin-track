import { API } from '../protocol.ts'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'

/** Register legacy or newly pasted links before requesting their local thumbnails. */
export async function preparePlacemarkPhotoCache(trackId: string, sources: readonly string[], signal?: AbortSignal): Promise<void> {
  const unique = [...new Set(sources.map(imageLink).filter((source): source is string => !!source))]
  if (!unique.length) return
  for (const source of unique) placemarkPhotoThumbnailUrl(trackId, source)
  for (let start = 0; start < unique.length; start += 100) {
    const response = await fetch(`${API}/placemark-photo-cache?id=${encodeURIComponent(trackId)}`, {
      method: 'POST', signal, credentials: 'same-origin',
      headers: {'content-type': 'application/json', 'x-cqai-track': '1'},
      body: JSON.stringify({sources: unique.slice(start, start + 100)}),
    })
    if (!response.ok) throw new Error('图片缓存准备失败，请重试')
  }
}
