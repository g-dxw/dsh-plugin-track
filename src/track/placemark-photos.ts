import {API} from '../protocol.ts'

export const PLACEMARK_PHOTO_MAX_BYTES = 20 * 1024 * 1024
export const PLACEMARK_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif'
export const PLACEMARK_PHOTO_PATH = API + '/placemark-photo'
export const PLACEMARK_PHOTO_FILE = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif|avif)$/u
const TRACK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export interface LocalPlacemarkPhoto {trackId:string;filename:string}
export function placemarkPhotoUrl(trackId:string,filename:string):string {
  if(!TRACK_ID.test(trackId)||!PLACEMARK_PHOTO_FILE.test(filename))throw new Error('本地图片编号无效')
  return PLACEMARK_PHOTO_PATH+'?id='+encodeURIComponent(trackId)+'&photo='+encodeURIComponent(filename)
}

/** Only the plugin's own bounded image endpoint is a valid relative reference. */
export function localPlacemarkPhoto(value:unknown):LocalPlacemarkPhoto|null {
  if(typeof value!=='string'||!value.trim().startsWith(PLACEMARK_PHOTO_PATH+'?'))return null
  try {
    const url=new URL(value.trim(),'http://track.invalid')
    const trackId=url.searchParams.get('id'),filename=url.searchParams.get('photo')
    if(url.origin!=='http://track.invalid'||url.pathname!==PLACEMARK_PHOTO_PATH||url.hash
      ||url.searchParams.size!==2||url.searchParams.getAll('id').length!==1||url.searchParams.getAll('photo').length!==1
      ||!trackId||!filename||!TRACK_ID.test(trackId)||!PLACEMARK_PHOTO_FILE.test(filename))return null
    return {trackId,filename}
  } catch {return null}
}
