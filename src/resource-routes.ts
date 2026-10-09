import {createReadStream} from 'node:fs'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {pipeline} from 'node:stream/promises'
import {ResourceError, readResources, updateResource, removeResource, upsertResourceJob, uploadResource, resourceFile} from './resource-store.ts'
import {isResourceMapView, RESOURCE_MAP_VIEW_LABELS, type ResourceKind} from './track/resources.ts'

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    size += chunk.length
    if (size > 128 * 1024) throw new ResourceError('资源请求最多 128 KiB',413)
    parts.push(Buffer.from(chunk))
  }
  try {return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}} catch {throw new ResourceError('资源请求 JSON 无效')}
}
export function resourceRange(value: string | undefined, size: number): {start: number; end: number} | null {
  if (value === undefined) return null
  const matched = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (!matched || !matched[1] && !matched[2] || size <= 0) throw new ResourceError('请求的媒体范围无效',416)
  const start = matched[1] ? Number(matched[1]) : Math.max(0, size - Number(matched[2]))
  const end = matched[1] ? matched[2] ? Math.min(size - 1, Number(matched[2])) : size - 1 : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || !matched[1] && Number(matched[2]) <= 0) throw new ResourceError('请求的媒体范围无效',416)
  return {start,end}
}
export async function handleResourceRoute(req: IncomingMessage, res: ServerResponse, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const action = url.pathname.split('/').pop() ?? ''
  if (!['resources','resource-upload','resource-update','resource','resource-file','resource-job','resource-result','resource-annotation','resource-map-image'].includes(action)) return false
  const id = url.searchParams.get('id') ?? ''
  try {
    for (const key of ['id','assetId','kind','name','jobId','parentAssetId','view']) if (url.searchParams.getAll(key).length > 1) throw new ResourceError('资源请求参数重复')
    if (action === 'resources' && req.method === 'GET') {json(res,200,readResources(id,env)); return true}
    if (['resource-upload','resource-result','resource-annotation','resource-map-image'].includes(action) && req.method === 'POST') {
      const isAnnotation = action === 'resource-annotation', isMap = action === 'resource-map-image', mapView = url.searchParams.get('view')
      if (isMap && (!isResourceMapView(mapView) || [...url.searchParams.keys()].some(key => !['id','name','view'].includes(key)))) throw new ResourceError('地图资源请求参数无效')
      if (isAnnotation && [...url.searchParams.keys()].some(key => !['id','name'].includes(key))) throw new ResourceError('标注资源请求参数无效')
      const isResult = action === 'resource-result', jobId = url.searchParams.get('jobId') ?? undefined
      if (isResult && !jobId) throw new ResourceError('缺少生成任务编号')
      const asset = await uploadResource(id,req,{name:url.searchParams.get('name') || (isMap ? `${RESOURCE_MAP_VIEW_LABELS[mapView as keyof typeof RESOURCE_MAP_VIEW_LABELS]}.png`:isAnnotation ? 'SVG 标注.png':isResult ? 'AI 生成图片':'新资源'),...(isMap && isResourceMapView(mapView) ? {mapView}:isAnnotation ? {annotation:true}:{}),kind:isResult || isAnnotation || isMap ? 'image':url.searchParams.get('kind') as ResourceKind | undefined ?? undefined,...(isResult ? {jobId,parentAssetId:url.searchParams.get('parentAssetId') ?? undefined}:{})},env)
      json(res,201,{asset}); return true
    }
    if (action === 'resource-update' && req.method === 'POST') {
      const value = await body(req) as {assetId?:string;patch?:unknown}
      json(res,200,{asset:updateResource(id,value?.assetId ?? '',value?.patch,env)}); return true
    }
    if (action === 'resource' && req.method === 'DELETE') {removeResource(id,url.searchParams.get('assetId') ?? '',env); json(res,200,{ok:true}); return true}
    if (action === 'resource-job' && req.method === 'POST') {const value = await body(req) as {job?:unknown}; json(res,200,{job:upsertResourceJob(id,value?.job,env)}); return true}
    if (action === 'resource-file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = await resourceFile(id,url.searchParams.get('assetId') ?? '',env)
      let range: {start:number;end:number} | null
      try {range = resourceRange(req.headers.range,file.bytes)} catch (error) {if (error instanceof ResourceError && error.status === 416) res.setHeader('content-range',`bytes */${file.bytes}`); throw error}
      const start = range?.start ?? 0, end = range?.end ?? file.bytes - 1
      res.writeHead(range ? 206:200,{'content-type':file.mime,'content-length':String(end-start+1),'accept-ranges':'bytes','cache-control':'private, max-age=3600','x-content-type-options':'nosniff',...(range ? {'content-range':`bytes ${start}-${end}/${file.bytes}`}:{})})
      if (req.method === 'HEAD') res.end()
      else if (file.body) res.end(file.body.subarray(start,end+1))
      else await pipeline(createReadStream(file.path!,{start,end}),res)
      return true
    }
    json(res,405,{error:'该资源接口不支持此方法'}); return true
  } catch (error) {
    if (error instanceof ResourceError && error.status === 413) res.setHeader('connection','close')
    if (!res.headersSent && !res.destroyed) {
      if (req.method === 'HEAD') {res.writeHead(error instanceof ResourceError ? error.status:400); res.end()}
      else json(res,error instanceof ResourceError ? error.status:400,{error:error instanceof Error ? error.message:'资源操作失败'})
    } else if (!res.destroyed) res.destroy()
    return true
  }
}
