import {API} from '../protocol.ts'
import type {ResourceAsset, ResourceAssetPatch, ResourceJob, ResourceKind, ResourceLibraryEnvelope, ResourceMapView, ResourceMetadata} from '../track/resources.ts'
import {RESOURCE_LIMITS, SVG_ANNOTATION_MAX_BYTES, MAP_CAPTURE_MAX_BYTES, isResourceMapView} from '../track/resources.ts'
import {imageLink} from '../track/placemarks.ts'
import {api} from './util.ts'
import {preparePlacemarkPhotoCache} from './placemark-photo-cache.ts'
import {placemarkPhotoOriginalUrl, placemarkPhotoThumbnailUrl} from '../track/placemark-photo-assets.ts'

const extensions: Record<string, {kind: ResourceKind; mime: string}> = {
  jpg: {kind: 'image', mime: 'image/jpeg'}, jpeg: {kind: 'image', mime: 'image/jpeg'}, png: {kind: 'image', mime: 'image/png'}, webp: {kind: 'image', mime: 'image/webp'}, gif: {kind: 'image', mime: 'image/gif'}, avif: {kind: 'image', mime: 'image/avif'},
  mp4: {kind: 'video', mime: 'video/mp4'}, mov: {kind: 'video', mime: 'video/quicktime'}, webm: {kind: 'video', mime: 'video/webm'}, mkv: {kind: 'video', mime: 'video/x-matroska'}, m4v: {kind: 'video', mime: 'video/mp4'},
  mp3: {kind: 'audio', mime: 'audio/mpeg'}, wav: {kind: 'audio', mime: 'audio/wav'}, m4a: {kind: 'audio', mime: 'audio/mp4'}, aac: {kind: 'audio', mime: 'audio/aac'}, ogg: {kind: 'audio', mime: 'audio/ogg'}, flac: {kind: 'audio', mime: 'audio/flac'}, opus: {kind: 'audio', mime: 'audio/ogg'},
}
export function resourceFileType(file: Pick<File, 'name' | 'type' | 'size'>): {kind: ResourceKind; mime: string} {
  const extension = extensions[file.name.split('.').at(-1)?.toLowerCase() || '']
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : extension?.kind
  if (!kind) throw new Error('请选择图片、视频或音频文件')
  if (file.size > RESOURCE_LIMITS[kind]) throw new Error(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}超过大小上限`)
  return {kind, mime: file.type || extension?.mime || 'application/octet-stream'}
}
export function loadResourceLibrary(trackId: string): Promise<ResourceLibraryEnvelope> {return api(`resources?id=${encodeURIComponent(trackId)}`)}
export async function updateResource(trackId: string, assetId: string, patch: ResourceAssetPatch): Promise<ResourceAsset> {
  return (await api<{asset: ResourceAsset}>(`resource-update?id=${encodeURIComponent(trackId)}`, {assetId, patch})).asset
}
export async function deleteResource(trackId: string, assetId: string): Promise<void> {await api(`resource?id=${encodeURIComponent(trackId)}&assetId=${encodeURIComponent(assetId)}`, {}, 'DELETE')}
export async function saveResourceJob(trackId: string, job: ResourceJob): Promise<ResourceJob> {return (await api<{job: ResourceJob}>(`resource-job?id=${encodeURIComponent(trackId)}`, {job})).job}

/** Binary upload reports bytes transferred; metadata probing is separate and lazy. */
function upload(action: string, blob: Blob, mime: string, onProgress?: (progress: number) => void): Promise<ResourceAsset> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${API}/${action}`)
    request.setRequestHeader('x-cqai-track', '1'); request.setRequestHeader('content-type', mime)
    request.upload.onprogress = event => {if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100))}
    request.onerror = () => reject(new Error('上传连接中断，请检查应用后重试'))
    request.onabort = () => reject(new Error('上传已取消'))
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText) as {asset?: ResourceAsset; error?: string}
        if (request.status < 200 || request.status >= 300 || !result.asset) throw new Error(result.error || `上传失败（HTTP ${request.status}）`)
        onProgress?.(100); resolve(result.asset)
      } catch (error) {reject(error instanceof SyntaxError ? new Error('轨迹服务暂未就绪，请稍后重试') : error)}
    }
    request.send(blob)
  })
}
export function uploadResource(trackId: string, file: File, onProgress?: (progress: number) => void): Promise<ResourceAsset> {
  const {kind, mime} = resourceFileType(file)
  return upload(`resource-upload?id=${encodeURIComponent(trackId)}&name=${encodeURIComponent(file.name)}&kind=${kind}`, file, mime, onProgress)
}
/** Saved SVG artwork is an immutable, track-owned reference image. */
export function storeResourceAnnotation(trackId: string, name: string, png: Blob): Promise<ResourceAsset> {
  if (png.type !== 'image/png' || !png.size || png.size > SVG_ANNOTATION_MAX_BYTES) throw new Error('标注图片必须为 10 MiB 以内的 PNG')
  return upload(`resource-annotation?id=${encodeURIComponent(trackId)}&name=${encodeURIComponent(name)}`, png, 'image/png')
}
/** Save the selected view as an immutable, track-owned map reference image. */
export function storeResourceMapImage(trackId: string, name: string, view: ResourceMapView, png: Blob): Promise<ResourceAsset> {
  if (!isResourceMapView(view)) throw new Error('地图视图类型无效')
  if (png.type !== 'image/png' || !png.size || png.size > MAP_CAPTURE_MAX_BYTES) throw new Error('地图图片必须为 10 MiB 以内的 PNG')
  return upload(`resource-map-image?id=${encodeURIComponent(trackId)}&name=${encodeURIComponent(name)}&view=${view}`, png, 'image/png')
}
export async function storeResourceResult(trackId: string, job: ResourceJob, dataUrl: string): Promise<ResourceAsset> {
  const response = await fetch(dataUrl); const blob = await response.blob()
  return upload(`resource-result?id=${encodeURIComponent(trackId)}&jobId=${encodeURIComponent(job.id)}${job.sourceAssetId ? `&parentAssetId=${encodeURIComponent(job.sourceAssetId)}` : ''}&name=${encodeURIComponent(job.mode === 'edit' ? 'AI 美化结果' : 'AI 生成图片')}`, blob, blob.type)
}
export function resourceThumbnail(asset: ResourceAsset): string {
  return asset.kind === 'image' && asset.sourceUrl && imageLink(asset.sourceUrl) ? placemarkPhotoThumbnailUrl(asset.trackId, asset.sourceUrl) : asset.url
}
export async function prepareResourcePreview(asset: ResourceAsset): Promise<void> {
  if (asset.kind === 'image' && asset.sourceUrl && imageLink(asset.sourceUrl)) await preparePlacemarkPhotoCache(asset.trackId, [asset.sourceUrl])
}
/** Only the selected original is read for AI; never use a template's example image. */
export async function readResourceReference(asset: ResourceAsset): Promise<string> {
  await prepareResourcePreview(asset)
  const url = asset.source === 'existing-photo' && /^https?:\/\//iu.test(asset.sourceUrl || '') ? placemarkPhotoOriginalUrl(asset.trackId, asset.sourceUrl!) : asset.url
  const response = await fetch(url, {credentials: 'same-origin', signal: AbortSignal.timeout(30000)})
  if (!response.ok) throw new Error('参考照片读取失败，请重新导入或检查链接')
  const blob = await response.blob()
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type.split(';')[0])) throw new Error('AI 参考照片需要 PNG、JPEG 或 WebP 格式')
  if (blob.size > 10 * 1024 * 1024) throw new Error('参考照片超过 10 MiB，请缩小图片后重新导入')
  return new Promise((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('参考照片无法读取')); reader.readAsDataURL(blob)})
}

/** Probe one selected media item, without decoding all files during import. */
export function probeResourceMetadata(asset: ResourceAsset): Promise<ResourceMetadata> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(asset.kind === 'image' ? 'img' : asset.kind === 'video' ? 'video' : 'audio')
    const media = element as HTMLMediaElement, image = element as HTMLImageElement
    const cleanup = () => {clearTimeout(timeout); element.removeAttribute('src'); if (asset.kind !== 'image') {media.load?.()}}
    const timeout = setTimeout(() => {cleanup(); reject(new Error('当前环境无法读取此媒体的元数据'))}, 15000)
    const done = () => {
      const metadata: ResourceMetadata = asset.kind === 'image' ? {width: image.naturalWidth, height: image.naturalHeight}
        : {...(Number.isFinite(media.duration) ? {duration: media.duration} : {}), ...(asset.kind === 'video' ? {width: (media as HTMLVideoElement).videoWidth, height: (media as HTMLVideoElement).videoHeight} : {})}
      cleanup(); resolve(metadata)
    }
    element.addEventListener(asset.kind === 'image' ? 'load' : 'loadedmetadata', done, {once: true})
    element.addEventListener('error', () => {cleanup(); reject(new Error('当前环境无法预览此编码'))}, {once: true})
    if (asset.kind !== 'image') media.preload = 'metadata'
    element.setAttribute('src', asset.url)
  })
}