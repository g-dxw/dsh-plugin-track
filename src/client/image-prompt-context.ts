import type {TrackRecord} from '../protocol.ts'
import type {ResourceAsset, ResourceJobReference} from '../track/resources.ts'
import type {ResourceTemplateSource} from '../track/resource-templates.ts'

export interface ImagePromptAttribution {
  name: string
  templateId?: string
  templateVersion?: number
  source?: ResourceTemplateSource
  adapted?: boolean
}
export interface ImagePromptContext {
  trackId: string
  trackName: string
  prompt: string
  references: {assetId: string; role: ResourceJobReference['role']; name: string; status: ResourceAsset['status'] | 'missing'; updatedAt?: string; url?: string}[]
}
export function imagePromptContext(track: Pick<TrackRecord, 'id' | 'name'>, prompt: string, references: ResourceJobReference[], assets: ResourceAsset[]): ImagePromptContext {
  return {trackId: track.id, trackName: track.name, prompt, references: references.map(reference => {
    const asset = assets.find(item => item.id === reference.assetId && item.kind === 'image')
    return {assetId: reference.assetId, role: reference.role, name: asset?.name || reference.name || reference.assetId, status: asset?.status || 'missing', updatedAt: asset?.updatedAt, url: asset?.url}
  })}
}
/** Image-model settings do not affect this separate text/vision operation. */
export function imagePromptContextFingerprint(context: ImagePromptContext): string {
  return JSON.stringify({trackId: context.trackId, trackName: context.trackName, prompt: context.prompt, references: context.references.map(({assetId, role, name, status, updatedAt}) => ({assetId, role, name, status, updatedAt}))})
}
