import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RESOURCE_TEMPLATE_LIMITS as LIMIT, type ResourcePromptTemplate, type ResourcePromptTemplateInput, type ResourceTemplateSource } from './track/resource-templates.ts'

export class ResourceTemplateError extends Error {
  constructor(message: string, readonly status = 400) {super(message); this.name = 'ResourceTemplateError'}
}
const directory = (env: NodeJS.ProcessEnv) => join(resolveDshHome(undefined, env), 'track-resource-templates')
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function string(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > max) throw new ResourceTemplateError(label + '格式无效或过长')
  const result = value.trim()
  if (required && !result) throw new ResourceTemplateError('请填写' + label)
  return result
}
function safeUrl(value: unknown): string {
  const input = string(value, '来源链接', 2048)
  if (!input) return ''
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    return url.href
  } catch {throw new ResourceTemplateError('来源链接格式无效')}
}
function source(value: unknown): ResourceTemplateSource | undefined {
  if (value === undefined || value === null) return undefined
  const input = record(value)
  if (!input || input.kind !== 'etubao') throw new ResourceTemplateError('模板来源格式无效')
  return {
    kind: 'etubao', sourceId: string(input.sourceId, '来源编号', 80, true),
    caseId: string(input.caseId, '案例编号', 160, true),
    sourceLabel: string(input.sourceLabel, '来源作者', 200),
    sourceUrl: safeUrl(input.sourceUrl), homepage: safeUrl(input.homepage),
  }
}
function fields(value: unknown): Omit<ResourcePromptTemplate, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  const input = record(value)
  if (!input) throw new ResourceTemplateError('模板格式无效')
  const mode = input.mode ?? 'both'
  if (mode !== 'both' && mode !== 'edit' && mode !== 'text') throw new ResourceTemplateError('模板适用模式无效')
  const tags = input.tags ?? []
  if (!Array.isArray(tags) || tags.length > LIMIT.tags) throw new ResourceTemplateError('模板标签格式无效')
  const origin = source(input.source)
  return {
    name: string(input.name, '模板名称', LIMIT.name, true),
    prompt: string(input.prompt, '提示词', LIMIT.prompt, true),
    category: string(input.category, '分类', LIMIT.category),
    tags: [...new Set(tags.map(tag => string(tag, '标签', LIMIT.tag, true)))],
    mode, ...(origin ? {source: origin} : {}),
  }
}

/** Malformed persisted data is reported; a save must never silently replace it with an empty library. */
export function listResourceTemplates(env: NodeJS.ProcessEnv = process.env): ResourcePromptTemplate[] {
  const file = join(directory(env), 'templates.json')
  if (!existsSync(file)) return []
  try {
    const input = record(JSON.parse(readFileSync(file, 'utf8')))
    if (input?.version !== 1 || !Array.isArray(input.templates) || input.templates.length > LIMIT.count) throw new Error()
    const ids = new Set<string>()
    return input.templates.map(value => {
      const item = record(value)
      if (!item || !validId(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.version) || Number(item.version) < 1
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
        || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error()
      ids.add(item.id)
      return {...fields(item), id: item.id, version: Number(item.version), createdAt: item.createdAt, updatedAt: item.updatedAt}
    })
  } catch {throw new ResourceTemplateError('模板库数据无法读取，请先恢复模板文件后再保存', 409)}
}
function write(templates: ResourcePromptTemplate[], env: NodeJS.ProcessEnv): void {
  const root = directory(env), file = join(root, 'templates.json'), temporary = join(root, randomUUID() + '.tmp')
  mkdirSync(root, {recursive: true})
  try {
    writeFileSync(temporary, JSON.stringify({version: 1, templates}, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'})
    renameSync(temporary, file)
  } finally {if (existsSync(temporary)) rmSync(temporary)}
}
export function saveResourceTemplate(value: unknown, env: NodeJS.ProcessEnv = process.env): ResourcePromptTemplate {
  const input = record(value), parsed = fields(value)
  const id = input?.id
  if (id !== undefined && !validId(id)) throw new ResourceTemplateError('模板编号无效')
  const templates = listResourceTemplates(env)
  const previous = id === undefined ? undefined : templates.find(item => item.id === id)
  if (id !== undefined && !previous) throw new ResourceTemplateError('模板不存在或已删除', 404)
  if (!previous && templates.length >= LIMIT.count) throw new ResourceTemplateError('模板数量已达上限', 409)
  const now = new Date().toISOString()
  const template: ResourcePromptTemplate = {...parsed, id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now}
  write(previous ? templates.map(item => item.id === previous.id ? template : item) : [template, ...templates], env)
  return template
}
export function removeResourceTemplate(id: unknown, env: NodeJS.ProcessEnv = process.env): ResourcePromptTemplate[] {
  if (!validId(id)) throw new ResourceTemplateError('模板编号无效')
  const templates = listResourceTemplates(env)
  if (!templates.some(template => template.id === id)) throw new ResourceTemplateError('模板不存在或已删除', 404)
  const next = templates.filter(template => template.id !== id)
  write(next, env)
  return next
}
