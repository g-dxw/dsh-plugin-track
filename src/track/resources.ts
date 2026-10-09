import {API} from '../protocol.ts'

export type ResourceKind = 'image' | 'video' | 'audio'
export type ResourceMapView = 'map' | 'terrain' | 'sandbox'
export const RESOURCE_MAP_VIEW_LABELS: Record<ResourceMapView, string> = {map: '二维地图', terrain: '3D 地图', sandbox: '3D 沙盘'}
export function isResourceMapView(value: unknown): value is ResourceMapView {return typeof value === 'string' && ['map', 'terrain', 'sandbox'].includes(value)}
export type ResourceVideoRole = 'image-insert' | 'travel-video' | 'ambient' | 'narration' | 'music' | 'sound-effect'
export interface ResourceMetadata {
  width?: number; height?: number; duration?: number; rotation?: number; hasAudio?: boolean
  sampleRate?: number; channels?: number; fps?: number
}
export interface ResourceUsage {kind: 'placemark' | 'svg' | 'video'; id: string; name?: string}
export interface ResourceAsset {
  id: string; trackId: string; kind: ResourceKind; name: string; mime: string; bytes: number; url: string
  source: 'existing-photo' | 'upload' | 'ai-edit' | 'ai-generate' | 'svg-annotation' | 'map-capture'; sourceUrl?: string; mapView?: ResourceMapView
  parentAssetId?: string; jobId?: string; tags: string[]; candidate: boolean; videoRole?: ResourceVideoRole
  metadata: ResourceMetadata; createdAt: string; updatedAt: string; usages: ResourceUsage[]
  status: 'ready' | 'pending' | 'error'; error?: string
}
export type ResourceJobStatus = 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'
export interface ResourceJobReference {assetId: string; role: 'subject' | 'effect'; name?: string}
export interface ResourceJobSettings {size: string; quality: string; n: number; detail: string}
export interface ResourceJob {
  id: string; trackId: string; hostTaskId?: string; sourceAssetId?: string; mode: 'edit' | 'text'
  prompt: string; model: string; channelId?: string; presetId?: string; presetVersion?: string | number
  references?: ResourceJobReference[]; settings?: ResourceJobSettings; submittedPrompt?: string; restoredFromJobId?: string
  status: ResourceJobStatus; resultAssetIds: string[]; resultsPersisted?: boolean; createdAt: string; updatedAt: string; error?: string
}
export interface ResourceLibraryEnvelope {revision: string; assets: ResourceAsset[]; jobs: ResourceJob[]}
export interface ResourceAssetPatch {
  name?: string; tags?: string[]; candidate?: boolean; videoRole?: ResourceVideoRole | null
  metadata?: ResourceMetadata
}
export const RESOURCE_LIMITS: Record<ResourceKind, number> = {image: 20 * 1024 * 1024, video: 2 * 1024 * 1024 * 1024, audio: 512 * 1024 * 1024}
export const SVG_ANNOTATION_MAX_BYTES = 10 * 1024 * 1024
export const SVG_ANNOTATION_MAX_PIXELS = 16_000_000
export const MAP_CAPTURE_MAX_BYTES = SVG_ANNOTATION_MAX_BYTES
export const MAP_CAPTURE_MAX_PIXELS = SVG_ANNOTATION_MAX_PIXELS
export const RESOURCE_VIDEO_ROLES: ResourceVideoRole[] = ['image-insert','travel-video','ambient','narration','music','sound-effect']
export const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
export function resourceFileUrl(trackId: string, assetId: string): string {
  if (!RESOURCE_ID.test(trackId) || !RESOURCE_ID.test(assetId)) throw new Error('资源编号无效')
  return `${API}/resource-file?id=${encodeURIComponent(trackId)}&assetId=${encodeURIComponent(assetId)}`
}
export function localResourceFile(value: unknown): {trackId: string; assetId: string} | null {
  if (typeof value !== 'string' || !value.startsWith(API + '/resource-file?')) return null
  try {
    const url = new URL(value, 'http://resource.invalid'), trackId = url.searchParams.get('id'), assetId = url.searchParams.get('assetId')
    return url.origin === 'http://resource.invalid' && url.pathname === API + '/resource-file' && !url.hash && url.searchParams.size === 2
      && url.searchParams.getAll('id').length === 1 && url.searchParams.getAll('assetId').length === 1
      && trackId && assetId && RESOURCE_ID.test(trackId) && RESOURCE_ID.test(assetId) ? {trackId, assetId} : null
  } catch {return null}
}
