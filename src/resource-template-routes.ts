import type { IncomingMessage, ServerResponse } from 'node:http'
import { RESOURCE_TEMPLATE_LIMITS } from './track/resource-templates.ts'
import { listResourceTemplates, removeResourceTemplate, ResourceTemplateError, saveResourceTemplate } from './resource-templates-store.ts'

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(JSON.stringify(data))
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  let bytes = 0, oversized = Number(req.headers['content-length']) > RESOURCE_TEMPLATE_LIMITS.body
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > RESOURCE_TEMPLATE_LIMITS.body) oversized = true
    if (!oversized) chunks.push(Buffer.from(chunk))
  }
  if (oversized) throw new ResourceTemplateError('模板内容过大', 413)
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'))} catch {throw new ResourceTemplateError('模板请求格式无效')}
}

/** Parent router applies the existing loopback, origin and x-cqai-track fence before this helper. */
export async function handleResourceTemplateRoute(req: IncomingMessage, res: ServerResponse, _url: URL, action: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (action !== 'resource-templates') return false
  try {
    if (req.method === 'GET') json(res, 200, {templates: listResourceTemplates(env)})
    else if (req.method === 'POST') {
      const template = saveResourceTemplate(await readJson(req), env)
      json(res, 200, {template, templates: listResourceTemplates(env)})
    } else if (req.method === 'DELETE') {
      const body = await readJson(req) as {id?: unknown} | null
      json(res, 200, {templates: removeResourceTemplate(body?.id, env)})
    } else json(res, 405, {error: '请求方法不支持'})
  } catch (error) {
    json(res, error instanceof ResourceTemplateError ? error.status : 500, {error: error instanceof ResourceTemplateError ? error.message : '模板保存失败，请稍后重试'})
  }
  return true
}
