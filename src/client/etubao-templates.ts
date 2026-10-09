import type { ResourcePromptTemplateInput } from '../track/resource-templates.ts'
import { ImagegenError } from './imagegen.ts'

/** Verified e图宝 source ids. These read existing host lists without refreshing or caching entire galleries. */
export const ETUBAO_TEMPLATE_SOURCES = [
  {id: 'vibeui', label: '精选案例库', homepage: 'https://vibeui.top/'},
  {id: 'canghe', label: '沧河案例库', homepage: 'https://gpt-image2.canghe.ai/'},
  {id: 'handraw', label: '手绘模板库', homepage: 'https://github.com/yang0/handraw-style'},
  {id: 'prompt-signal', label: 'Prompt/Signal', homepage: 'https://github.com/andy7076/image_prompt'},
  {id: 'evolink', label: 'GPT Image 2 案例库', homepage: 'https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts'},
] as const
export interface EtubaoTemplateCase {
  id: string
  title: string
  prompt: string
  category: string
  categoryZh: string
  styles: string[]
  scenes: string[]
  sourceLabel: string
  sourceUrl: string
  image: string
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function text(value: unknown, limit = 200): string {return typeof value === 'string' ? value.trim().slice(0, limit) : ''}
function tags(value: unknown): string[] {return Array.isArray(value) ? value.slice(0, 12).filter((value): value is string => typeof value === 'string').map(value => value.slice(0, 40)) : []}
export function safeReferenceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : ''
  } catch {return ''}
}
/** Mirrors the host image-reference shape; image requests still go through its source/list checks. */
function templateImageRef(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) return ''
  const ref = value.trim()
  if (!ref || ref.includes('..') || /[\\\u0000-\u001f]/u.test(ref)) return ''
  if (/^https?:\/\//iu.test(ref)) {
    try {
      const url = new URL(ref)
      return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : ''
    } catch {return ''}
  }
  return ref.length <= 160 && /^[a-z0-9_.-]+\.(?:jpg|jpeg|png|webp|gif)$/iu.test(ref) ? ref : ''
}
export async function loadEtubaoTemplates(sourceId: string): Promise<EtubaoTemplateCase[]> {
  if (!ETUBAO_TEMPLATE_SOURCES.some(source => source.id === sourceId)) throw new ImagegenError('模板来源无效', 'invalid-source')
  let response: Response
  try {
    response = await fetch('/api/dsh-imagegen/templates/list', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'}, body: JSON.stringify({source: sourceId})})
  } catch {throw new ImagegenError('无法读取 e图宝 模板，请检查应用和网络后重试', 'network-error')}
  if (!response.headers.get('content-type')?.includes('application/json') || response.status === 404) {
    throw new ImagegenError('e图宝 模板服务不可用，请在 DSH 中启用 e图宝', 'plugin-unavailable')
  }
  let envelope: Record<string, unknown> | null
  try {envelope = record(await response.json())} catch {throw new ImagegenError('e图宝 模板返回数据无效', 'invalid-response')}
  if (!response.ok || envelope?.ok !== true) throw new ImagegenError(text(envelope?.message) || '无法读取 e图宝 模板，请稍后重试', text(envelope?.code) || 'request-failed')
  if (envelope.sourceId !== sourceId || !Array.isArray(envelope.cases)) throw new ImagegenError('e图宝 模板目录格式无效', 'invalid-response')
  return envelope.cases.flatMap(value => {
    const item = record(value)
    if (!item || (typeof item.id !== 'string' && typeof item.id !== 'number')
      || typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 12000) return []
    const title = text(item.title, 100), id = String(item.id).slice(0, 160)
    if (!title || !id) return []
    return [{
      id, title, prompt: item.prompt.trim(), category: text(item.category, 40), categoryZh: text(item.categoryZh, 40),
      styles: tags(item.styles), scenes: tags(item.scenes), sourceLabel: text(item.sourceLabel),
      sourceUrl: safeReferenceUrl(item.sourceUrl),
      image: templateImageRef(item.image),
    }]
  })
}
export function etubaoTemplateImage(sourceId: string, item: Pick<EtubaoTemplateCase, 'image'>): string | undefined {
  const image = templateImageRef(item.image)
  return image && ETUBAO_TEMPLATE_SOURCES.some(source => source.id === sourceId)
    ? '/api/dsh-imagegen/templates/image/' + encodeURIComponent(sourceId) + '/' + encodeURIComponent(image) : undefined
}
export function etubaoTemplateInput(sourceId: string, item: EtubaoTemplateCase): ResourcePromptTemplateInput {
  const source = ETUBAO_TEMPLATE_SOURCES.find(source => source.id === sourceId)
  if (!source) throw new ImagegenError('模板来源无效', 'invalid-source')
  return {
    name: item.title, prompt: item.prompt, category: item.categoryZh || item.category, tags: [...new Set([...item.styles, ...item.scenes])].slice(0, 12),
    mode: 'both',
    source: {kind: 'etubao', sourceId, caseId: item.id, sourceLabel: item.sourceLabel, sourceUrl: item.sourceUrl, homepage: source.homepage},
  }
}
