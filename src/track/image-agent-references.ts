/** Browser-safe references to images explicitly prepared for the native Track Agent. */
export type AgentImageReferenceInput =
  | {kind: 'resource'; trackId: string; assetId: string}
  | {kind: 'featured'; key: string; trackId?: string | null}
  | {kind: 'template'; sourceId: string; caseId: string; image?: string; trackId?: string | null}

export interface AgentImageReference {
  referenceId: string
  name: string
  filePath: string
  mime: 'image/png' | 'image/webp'
  bytes: number
  width: number
  height: number
  fileUrl: string
  clipboardText: string
  source: AgentImageReferenceInput
}
export interface AgentImageReferenceResponse {reference: AgentImageReference}

export const AGENT_IMAGE_REFERENCE_API = '/api/cqai-track/agent-image-reference'
export const AGENT_IMAGE_REFERENCE_FILE_API = '/api/cqai-track/agent-image-reference-file'

