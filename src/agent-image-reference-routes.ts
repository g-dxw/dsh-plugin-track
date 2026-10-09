import type {IncomingMessage, ServerResponse} from 'node:http'
import {AgentImageReferenceError, prepareAgentImageReference, readAgentImageReference, type AgentImageReferenceOptions} from './agent-image-references.ts'
import {ResourceError} from './resource-store.ts'
import {AGENT_IMAGE_REFERENCE_API, AGENT_IMAGE_REFERENCE_FILE_API} from './track/image-agent-references.ts'

const MAX_BODY = 128 * 1024
function json(res: ServerResponse, status: number, value: unknown): void {res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(JSON.stringify(value))}
async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new AgentImageReferenceError('图片引用请求最多 128 KiB', 413)
  const chunks: Buffer[] = []; let size = 0
  for await (const raw of req.iterator({destroyOnReturn: false})) {
    const chunk = Buffer.from(raw); size += chunk.length
    if (size > MAX_BODY) throw new AgentImageReferenceError('图片引用请求最多 128 KiB', 413)
    chunks.push(chunk)
  }
  try {return chunks.length ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : {}} catch {throw new AgentImageReferenceError('图片引用请求 JSON 无效')}
}
/** Mounted inside Track's existing permitted() gate; no new public access boundary is introduced. */
export async function handleAgentImageReferenceRoute(req: IncomingMessage, res: ServerResponse, url: URL, options: AgentImageReferenceOptions = {}): Promise<boolean> {
  if (url.pathname !== AGENT_IMAGE_REFERENCE_API && url.pathname !== AGENT_IMAGE_REFERENCE_FILE_API) return false
  const controller = new AbortController(), close = () => {if (!res.writableEnded) controller.abort()}
  res.once('close', close)
  try {
    if (url.pathname === AGENT_IMAGE_REFERENCE_API) {
      if (req.method !== 'POST') throw new AgentImageReferenceError('图片引用准备接口仅支持 POST', 405)
      if ([...url.searchParams].length) throw new AgentImageReferenceError('图片引用准备接口不接受查询参数')
      // This route has already passed Desktop admission and Track's permitted() gate.
      // Forward only the native capability, never the caller's cookies, Host or arbitrary headers.
      const rendererAccess = req.headers['x-dsh-desktop-renderer']
      const reference = await prepareAgentImageReference(await body(req), {...options,
        desktopRendererAccess: typeof rendererAccess === 'string' ? rendererAccess : undefined,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal})
      json(res, 200, {reference})
    } else {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AgentImageReferenceError('图片引用读取接口仅支持 GET 或 HEAD', 405)
      if (url.searchParams.getAll('referenceId').length !== 1 || url.searchParams.getAll('trackId').length > 1
        || [...url.searchParams.keys()].some(key => key !== 'referenceId' && key !== 'trackId')) throw new AgentImageReferenceError('图片引用读取参数无效或重复')
      const {reference, body: image} = readAgentImageReference(url.searchParams.get('referenceId'), options.env, url.searchParams.get('trackId'))
      res.writeHead(200, {'content-type': reference.mime, 'content-length': String(image.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'})
      res.end(req.method === 'HEAD' ? undefined : image)
    }
  } catch (error) {
    const status = error instanceof AgentImageReferenceError || error instanceof ResourceError ? error.status : 400
    if (status === 413) res.setHeader('connection', 'close')
    if (!res.headersSent && !res.destroyed) {
      if (req.method === 'HEAD') {res.writeHead(status); res.end()}
      else json(res, status, {error: error instanceof Error ? error.message : '图片引用操作失败'})
    } else if (!res.destroyed) res.destroy()
  } finally {res.off('close', close)}
  return true
}

