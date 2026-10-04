import { API } from '../protocol.ts'
import { imageLink } from './placemarks.ts'
import { placemarkPhotoUrl } from './placemark-photos.ts'

export const PLACEMARK_THUMBNAIL_MAX_SIZE = 1024
export const PLACEMARK_THUMBNAIL_QUALITY = 80
export const PLACEMARK_PHOTO_ASSET_PATH = API + '/placemark-photo-asset'
export type PlacemarkPhotoSize = 'thumbnail' | 'original'

/** Rendering references never replace a photo's logical URL in edits or groups. */
export function placemarkPhotoAssetUrl(trackId: string, source: string, size: PlacemarkPhotoSize): string {
  placemarkPhotoUrl(trackId, '0'.repeat(64) + '.jpg')
  const safe = imageLink(source)
  if (!safe || safe.length > 4096 || (size !== 'thumbnail' && size !== 'original')) throw new Error('图片资源地址无效')
  return PLACEMARK_PHOTO_ASSET_PATH + '?id=' + encodeURIComponent(trackId)
    + '&source=' + encodeURIComponent(safe) + '&size=' + size
}
export function placemarkPhotoThumbnailUrl(trackId: string, source: string): string {
  return placemarkPhotoAssetUrl(trackId, source, 'thumbnail')
}
export function placemarkPhotoOriginalUrl(trackId: string, source: string): string {
  return placemarkPhotoAssetUrl(trackId, source, 'original')
}
