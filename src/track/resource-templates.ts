/** Browser-safe personal prompt-template contract. Personal templates start empty; curated entries are separate. */
export type ResourceTemplateMode = 'edit' | 'text' | 'both'

export interface ResourceTemplateSource {
  kind: 'etubao'
  sourceId: string
  caseId: string
  sourceLabel: string
  sourceUrl: string
  homepage: string
}

export interface ResourcePromptTemplate {
  id: string
  name: string
  prompt: string
  category: string
  tags: string[]
  mode: ResourceTemplateMode
  version: number
  createdAt: string
  updatedAt: string
  source?: ResourceTemplateSource
}

export type ResourcePromptTemplateInput = Pick<ResourcePromptTemplate, 'name' | 'prompt'>
  & Partial<Pick<ResourcePromptTemplate, 'id' | 'category' | 'tags' | 'mode' | 'source'>>

export const RESOURCE_TEMPLATE_LIMITS = {count: 1000, name: 100, prompt: 12000, category: 40, tags: 12, tag: 40, body: 128 * 1024} as const
