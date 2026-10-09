export interface ImagePromptReference {assetId: string; role: 'subject' | 'effect'}
export interface ImagePromptOptimizationRequest {model: string; prompt: string; requirements?: string; references: ImagePromptReference[]}
export interface ImagePromptOptimizationResponse {prompt: string; changes: string[]}
export type ImagePromptOptimizationResult = ImagePromptOptimizationResponse
export interface ImagePromptModelCatalog {
  models: {id: string; label: string; supportsVision: boolean}[]
  defaultModel?: string | null
  available: boolean
  message?: string
}
export const IMAGE_PROMPT_LIMITS = {requestBytes: 128 * 1024, model: 200, prompt: 20000, requirements: 4000, references: 5, imageEdge: 1280, imageBytes: 2 * 1024 * 1024} as const

/** Total prompt adaptation budget, including preparing every selected reference. */
export const IMAGE_PROMPT_TIMEOUT_MS = 5 * 60_000
