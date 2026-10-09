import { api } from './util.ts'
import type { ResourcePromptTemplate, ResourcePromptTemplateInput } from '../track/resource-templates.ts'

export async function loadResourceTemplates(): Promise<ResourcePromptTemplate[]> {
  return (await api<{templates: ResourcePromptTemplate[]}>('resource-templates')).templates
}
export async function saveResourceTemplate(input: ResourcePromptTemplateInput): Promise<ResourcePromptTemplate> {
  return (await api<{template: ResourcePromptTemplate}>('resource-templates', input)).template
}
export async function deleteResourceTemplate(id: string): Promise<void> {
  await api('resource-templates', {id}, 'DELETE')
}
