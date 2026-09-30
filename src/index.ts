import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { UPLOADS, API, type TrackInput, type TrackMetrics, type TrackPoint } from './protocol.ts'
import { listTracks, readSource, readTrack, removeTrack, writeTrack } from './artifacts.ts'

export const name = 'cqai-track'
export const inject = ['webServer']

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(JSON.stringify(data))
}

/**
 * Gate every request that reaches the port. The server is bound to loopback, but
 * a page in a browser on the same machine could still reach it, so the origin and
 * `sec-fetch-site` checks matter as much as the address check. The custom header
 * on writes is what forces a preflight, which is what makes the origin check bite.
 */
export function permitted(req: IncomingMessage): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false
  const origin = req.headers.origin
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return req.method === 'GET' || req.headers['x-cqai-track'] === '1'
}

/**
 * The publisher's 200 KB cap is for a short text body; a track is megabytes, so
 * this one is bounded by the parsed size instead. The cap still exists, because
 * the endpoint is reachable by anything that can open a loopback socket.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > UPLOADS.maxRequestBytes) throw new Error('文件过大，无法导入')
    chunks.push(Buffer.from(chunk))
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

/** Non-finite numbers and unknown formats would poison the map, so they are rejected here. */
function asTrack(body: unknown): TrackInput {
  if (!body || typeof body !== 'object') throw new Error('请求格式不正确')
  const input = body as Partial<TrackInput>
  if (typeof input.filename !== 'string') throw new Error('缺少文件名')
  if (typeof input.source !== 'string') throw new Error('缺少原始文件内容')
  if (!Array.isArray(input.points)) throw new Error('缺少轨迹点')
  if (input.points.length > UPLOADS.maxPoints) throw new Error(`轨迹点过多，上限 ${UPLOADS.maxPoints}`)
  const points = input.points.map((point, index) => {
    if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number' || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      throw new Error(`第 ${index + 1} 个轨迹点无效`)
    }
    const ele = typeof point[2] === 'number' && Number.isFinite(point[2]) ? point[2] : null
    const time = typeof point[3] === 'number' && Number.isFinite(point[3]) ? point[3] : null
    return [point[0], point[1], ele, time] as TrackPoint
  })
  if (!points.length) throw new Error('轨迹里没有可用的坐标点')
  const metrics = input.metrics as Partial<TrackMetrics> | undefined
  return {
    name: typeof input.name === 'string' ? input.name : '',
    filename: input.filename,
    source: input.source,
    points,
    metrics: {
      distance: number(metrics?.distance),
      elevationGain: number(metrics?.elevationGain),
      elevationLoss: number(metrics?.elevationLoss),
      duration: number(metrics?.duration),
      elevationMax: finite(metrics?.elevationMax),
      elevationMin: finite(metrics?.elevationMin),
      bbox: Array.isArray(metrics?.bbox) && metrics.bbox.length === 4 && metrics.bbox.every(value => typeof value === 'number' && Number.isFinite(value))
        ? metrics.bbox as [number, number, number, number]
        : null,
    },
  }
}

const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const unregister = ctx.webServer.register({kind: 'prefix', path: API, handler: async (req, res) => {
      if (!permitted(req)) return json(res, 403, {error: '仅允许本机应用访问'})
      try {
        const url = new URL(req.url!, 'http://localhost')
        const action = url.pathname.slice(API.length + 1)
        const id = url.searchParams.get('id') ?? ''
        if (req.method === 'GET' && action === 'tracks') return json(res, 200, listTracks())
        if (req.method === 'GET' && action === 'track') {
          const track = readTrack(id)
          return track ? json(res, 200, track) : json(res, 404, {error: '轨迹不存在'})
        }
        if (req.method === 'GET' && action === 'source') {
          const source = readSource(id)
          if (!source) return json(res, 404, {error: '原始文件不存在'})
          const track = readTrack(id)
          const name = (track?.filename || `track.${source.ext}`).replace(/["\\\r\n]/gu, '')
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(source.body.length),
            // The original file is handed back byte for byte, under the name it
            // was imported with, so a round trip through the panel is lossless.
            'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
          })
          res.end(source.body)
          return
        }
        if (req.method === 'POST' && action === 'tracks') return json(res, 201, writeTrack(asTrack(await readJson(req))))
        if (req.method === 'DELETE' && action === 'track') {
          return removeTrack(id) ? json(res, 200, {ok: true}) : json(res, 404, {error: '轨迹不存在'})
        }
        json(res, 404, {error: '接口不存在'})
      } catch (error) {
        if (!res.headersSent && !res.destroyed) json(res, 400, {error: error instanceof Error ? error.message : '操作失败'})
      }
    }})
    return () => {unregister()}
  }, '轨迹存储与本地服务')
}
