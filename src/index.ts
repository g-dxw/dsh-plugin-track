import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { UPLOADS, API, validateUpload, type TrackInput, type TrackMetrics, type TrackPoint } from './protocol.ts'
import { listTracks, readSource, readTrack, removeTrack, writeTrack, writeTrackBatch } from './artifacts.ts'
import { ensureTrackAgentWorkspace, saveTrackAgentSession, writeTrackAgentContext, TrackAgentStoreError } from './track-agent-store.ts'

import { annotationsSaved, readAnnotations, readArtLayout, readArtRouteTransform, writeAnnotations } from './annotations-store.ts'
import { readPlacemarkOrder, writePlacemarkOrder } from './placemark-order-store.ts'
import { readPlacemarkEdits, writePlacemarkEdits } from './placemark-edits-store.ts'
import { readPlacemarkGroups, writePlacemarkGroups } from './placemark-groups-store.ts'
import { readPlacemarkState, writePlacemarkState, PlacemarkStateConflictError } from './placemark-state-store.ts'
import { readGeoMotionProject, writeGeoMotionProject, GeoMotionProjectError } from './geomotion-project-store.ts'
import {readShotEditorProject, writeShotEditorProject, ShotEditorProjectError} from './shot-editor-project-store.ts'
import {SHOT_EDITOR_PROJECT_MAX_BYTES} from './track/shot-editor-project-types.ts'
import {readShotProjectBackup, ShotProjectBackupError} from './shot-project-backup.ts'
import { readVideoMaterials, writeVideoMaterials, VideoMaterialsError, VIDEO_MATERIALS_MAX_BYTES } from './video-materials-store.ts'
import { readPlacemarkPhoto, writePlacemarkPhoto, PlacemarkPhotoError } from './placemark-photos-store.ts'
import { PLACEMARK_PHOTO_MAX_BYTES } from './track/placemark-photos.ts'
import { preparePlacemarkPhotos, readPlacemarkPhotoAsset, listPlacemarkPhotoAssets } from './placemark-photo-assets-store.ts'
import { validateRouteContext } from './track/placemark-location.ts'
import { validatePlacemarks } from './track/placemarks.ts'
import { loadTextModels, analyzeRoute, generateAnimationScript, TrackAIError, type TrackAIAccount, type TextAIRequest } from './ai.ts'
import { generateTrackVideoScript } from './video-script-ai.ts'
import type { VideoScriptRequest } from './track/video-script-types.ts'
import { handleResourceRoute } from './resource-routes.ts'
import {handleOpenMontageRoute} from './openmontage-routes.ts'
import {disposeOpenMontage} from './openmontage-runtime.ts'
import {OpenMontageError} from './openmontage-store.ts'
import type {ShotProjectScope} from './track/shot-project-scope.ts'

export const name = 'cqai-track'
// Cordis object-form injection maps service names to intercept configuration;
// it does not support `required`/`optional` groups. Resolve the optional account
// with ctx.get() at request time so local tracks work without AI enabled.
export const inject = ['webServer']

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(JSON.stringify(data))
}
function editorScope(projectId: unknown, shotId: unknown): ShotProjectScope | undefined {
  if (projectId === undefined && shotId === undefined) return undefined
  if(typeof projectId!=='string'||typeof shotId!=='string'||!projectId||!shotId)throw new OpenMontageError('项目与分镜作用域必须同时提供')
  return {projectId,shotId}
}
function queryEditorScope(url:URL): ShotProjectScope|undefined {
  if(['projectId','shotId'].some(key=>url.searchParams.getAll(key).length>1))throw new OpenMontageError('镜头作用域参数重复')
  return editorScope(url.searchParams.get('projectId')??undefined,url.searchParams.get('shotId')??undefined)
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
  return req.method === 'GET' || req.method === 'HEAD' || req.headers['x-cqai-track'] === '1'
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

/** A preparation document is bounded independently from the larger track upload limit. */
async function readVideoMaterialsJson(req: IncomingMessage): Promise<unknown> {
  const limit = VIDEO_MATERIALS_MAX_BYTES + 4096
  const chunks: Buffer[] = []
  let size = 0, oversized = Number(req.headers['content-length']) > limit
  // Discard overflow while draining this request so callers receive 413 rather than a socket reset.
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) oversized = true
    if (oversized) chunks.length = 0
    else chunks.push(bytes)
  }
  if (oversized) throw new VideoMaterialsError('视频素材准备最多 16 MiB', 413)
  return chunks.length ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : {}
}
/** Drain overflow so an oversized project still receives a concrete 413 response. */
async function readShotEditorProjectJson(req: IncomingMessage): Promise<unknown> {
  const limit = SHOT_EDITOR_PROJECT_MAX_BYTES + 4096
  const chunks: Buffer[] = []
  let size = 0, oversized = Number(req.headers['content-length']) > limit
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) oversized = true
    if (oversized) chunks.length = 0
    else chunks.push(bytes)
  }
  if (oversized) throw new ShotEditorProjectError('三维镜头工程最多 2 MB', 413)
  return chunks.length ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : {}
}
async function readPhoto(req: IncomingMessage): Promise<Buffer> {
  const length = req.headers['content-length']
  if (length && Number(length) > PLACEMARK_PHOTO_MAX_BYTES) throw new PlacemarkPhotoError('图片最多 20 MiB', 413)
  const chunks: Buffer[] = []
  let size = 0
  // Keep the socket alive long enough to return 413 after a streaming overflow.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > PLACEMARK_PHOTO_MAX_BYTES) throw new PlacemarkPhotoError('图片最多 20 MiB', 413)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
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
    ...(input.segmentStarts === undefined ? {} : {segmentStarts: validateRouteContext({segmentStarts: input.segmentStarts, references: []}, points).segmentStarts}),
    ...(input.placemarks === undefined ? {} : {placemarks: validatePlacemarks(input.placemarks)}),
    metrics: {
      distance: number(metrics?.distance),
      elevationGain: number(metrics?.elevationGain),
      elevationLoss: number(metrics?.elevationLoss),
      duration: number(metrics?.duration),
      ...(Number.isInteger(metrics?.calculationVersion) && number(metrics?.calculationVersion) > 0
        ? {calculationVersion: number(metrics?.calculationVersion)} : {}),
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

/** Image jobs must not delay track loading or turn a successful import into a failure. */
function preparePhotos(id: string, sources?: string[]): void {
  void preparePlacemarkPhotos(id, sources).catch(() => { /* Each photo has an independent retry path. */ })
}
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const unregister = ctx.webServer.register({kind: 'prefix', path: API, handler: async (req, res) => {
      if (!permitted(req)) return json(res, 403, {error: '仅允许本机应用访问'})
      try {
        const url = new URL(req.url!, 'http://localhost')
        const action = url.pathname.slice(API.length + 1)
        const id = url.searchParams.get('id') ?? ''
        if (await handleResourceRoute(req, res, url)) return
        if (await handleOpenMontageRoute(req,res,url)) return
        if (req.method === 'POST' && action === 'agent-workspace') {
          const body = await readJson(req) as {trackId?: string | null}
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TrackAgentStoreError('Agent 工作区请求格式无效')
          return json(res, 200, ensureTrackAgentWorkspace(process.env, body.trackId))
        }
        if (req.method === 'POST' && action === 'agent-session') {
          const body = await readJson(req) as {sessionId?: unknown; trackId?: string | null}
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TrackAgentStoreError('Agent 会话请求格式无效')
          return json(res, 200, saveTrackAgentSession(body.sessionId, process.env, body.trackId))
        }
        if (req.method === 'POST' && action === 'agent-context') {
          return json(res, 200, writeTrackAgentContext(await readJson(req)))
        }
        if (req.method === 'POST' && action === 'placemark-photos') {
          if (!readTrack(id)) throw new PlacemarkPhotoError('轨迹不存在', 404)
          const saved = writePlacemarkPhoto(id, await readPhoto(req), req.headers['content-type'])
          preparePhotos(id, [saved.url])
          return json(res, 201, saved)
        }
        if (req.method === 'POST' && action === 'placemark-photo-cache') {
          const body = await readJson(req) as {sources?: unknown}
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlacemarkPhotoError('图片资源请求格式无效')
          return json(res, 202, {queued: await preparePlacemarkPhotos(id, body.sources)})
        }
        if (req.method === 'GET' && action === 'placemark-photo-cache') {
          return json(res, 200, {assets: listPlacemarkPhotoAssets(id)})
        }
        if (req.method === 'GET' && action === 'placemark-photo-asset') {
          if (url.searchParams.size !== 3 || ['id', 'source', 'size'].some(key => url.searchParams.getAll(key).length !== 1)) {
            throw new PlacemarkPhotoError('图片资源参数无效')
          }
          const size = url.searchParams.get('size')
          if (size !== 'original' && size !== 'thumbnail') throw new PlacemarkPhotoError('图片尺寸类型无效')
          const photo = await readPlacemarkPhotoAsset(id, url.searchParams.get('source') || '', size)
          if (res.destroyed) return
          res.writeHead(200, {'content-type': photo.mime, 'content-length': String(photo.body.length),
            'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600'})
          res.end(photo.body)
          return
        }
        if (req.method === 'GET' && action === 'placemark-photo') {
          const photo = readPlacemarkPhoto(id, url.searchParams.get('photo') ?? '')
          if (!photo) return json(res, 404, {error: '图片不存在'})
          res.writeHead(200, {'content-type': photo.mime, 'content-length': String(photo.body.length), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable'})
          res.end(photo.body)
          return
        }
        if ((req.method === 'GET' && action === 'text-models') || (req.method === 'POST' && ['analyze','animation-script','video-script'].includes(action))) {
          const account = ctx.get('dsnAccount') as TrackAIAccount | undefined
          const controller = new AbortController()
          const disconnect = () => {if (!res.writableEnded) controller.abort()}
          res.once('close', disconnect)
          try {
            if (action === 'text-models') return json(res, 200, await loadTextModels(account, controller.signal))
            const body = await readJson(req)
            if (action === 'video-script') {
              try {return json(res, 200, await generateTrackVideoScript(account, body as VideoScriptRequest, controller.signal))}
              catch (error) {
                if (error instanceof TrackAIError) {
                  if (!res.headersSent && !res.destroyed) json(res, error.status, {error: error.message, code: error.code})
                  return
                }
                throw error
              }
            }
            const request = body as TextAIRequest
            const result = action === 'analyze' ? await analyzeRoute(account, request, controller.signal) : await generateAnimationScript(account, request, controller.signal)
            return json(res, 200, result)
          } finally {res.off('close', disconnect)}
        }
        if (req.method === 'GET' && action === 'video-materials') return json(res, 200, {materials: readVideoMaterials(id)})
        if (req.method === 'POST' && action === 'video-materials') {
          const body = await readVideoMaterialsJson(req) as {id?: unknown; document?: unknown; expectedRevision?: unknown}
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') throw new VideoMaterialsError('缺少轨迹编号')
          return json(res, 200, {materials: writeVideoMaterials(body.id, body.document, body.expectedRevision)})
        }
        if (req.method === 'GET' && action === 'shot-project-backup') {
          const scope=queryEditorScope(url)
          if (url.searchParams.size !== (scope?4:2) || ['id', 'scene'].some(key => url.searchParams.getAll(key).length !== 1)) throw new ShotProjectBackupError('镜头备份参数无效')
          const backup = readShotProjectBackup(id, url.searchParams.get('scene'),process.env,scope)
          res.writeHead(200, {'content-type': 'application/json', 'content-length': String(backup.body.length),
            'content-disposition': `attachment; filename="${backup.filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'})
          res.end(backup.body)
          return
        }
        if (req.method === 'GET' && action === 'geomotion-project') return json(res, 200, {project: readGeoMotionProject(id,process.env,queryEditorScope(url))})
        if (req.method === 'POST' && action === 'geomotion-project') {
          const body = await readJson(req) as {id?: unknown; project?: unknown; expectedRevision?: unknown; projectId?:unknown;shotId?:unknown}
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') throw new GeoMotionProjectError('缺少轨迹编号')
          return json(res, 200, {project: writeGeoMotionProject(body.id, body.project, body.expectedRevision,process.env,editorScope(body.projectId,body.shotId))})
        }
        if (req.method === 'GET' && action === 'shot-editor-project') return json(res, 200, {project: readShotEditorProject(id,process.env,queryEditorScope(url))})
        if (req.method === 'POST' && action === 'shot-editor-project') {
          const body = await readShotEditorProjectJson(req) as {id?: unknown; project?: unknown; expectedRevision?: unknown; projectId?:unknown;shotId?:unknown}
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') throw new ShotEditorProjectError('缺少轨迹编号')
          return json(res, 200, {project: writeShotEditorProject(body.id, body.project, body.expectedRevision,process.env,editorScope(body.projectId,body.shotId))})
        }
        if (req.method === 'GET' && action === 'placemark-state') return json(res, 200, {state: readPlacemarkState(id)})
        if (req.method === 'POST' && action === 'placemark-state') {
          const body = await readJson(req) as {id?: unknown; revision?: unknown; data?: unknown}
          if (typeof body?.id !== 'string') throw new Error('缺少轨迹编号')
          return json(res, 200, {state: writePlacemarkState(body.id, body.revision, body.data)})
        }
        if (req.method === 'GET' && action === 'annotations') return json(res, 200, {annotations: readAnnotations(id), saved: annotationsSaved(id), layout: readArtLayout(id), route: readArtRouteTransform(id)})
        if (req.method === 'POST' && action === 'annotations') {
          const body = await readJson(req) as {id?: unknown; annotations?: unknown; layout?: unknown; route?: unknown}
          if (typeof body?.id !== 'string') throw new Error('缺少轨迹编号')
          return json(res, 200, {annotations: writeAnnotations(body.id, body.annotations, process.env, body.layout, body.route), layout: readArtLayout(body.id), route: readArtRouteTransform(body.id)})
        }
        if (req.method === 'GET' && action === 'placemark-order') return json(res, 200, {order: readPlacemarkOrder(id)})
        if (req.method === 'POST' && action === 'placemark-order') {
          const body = await readJson(req) as {id?: unknown; order?: unknown}
          if (typeof body?.id !== 'string') throw new Error('缺少轨迹编号')
          return json(res, 200, {order: writePlacemarkOrder(body.id, body.order)})
        }
        if (req.method === 'GET' && action === 'placemark-edits') return json(res, 200, {edits: readPlacemarkEdits(id)})
        if (req.method === 'POST' && action === 'placemark-edits') {
          const body = await readJson(req) as {id?: unknown; edits?: unknown}
          if (typeof body?.id !== 'string') throw new Error('缺少轨迹编号')
          return json(res, 200, {edits: writePlacemarkEdits(body.id, body.edits)})
        }
        if (req.method === 'GET' && action === 'placemark-groups') return json(res, 200, {groups: readPlacemarkGroups(id)})
        if (req.method === 'POST' && action === 'placemark-groups') {
          const body = await readJson(req) as {id?: unknown; groups?: unknown}
          if (typeof body?.id !== 'string') throw new Error('缺少轨迹编号')
          return json(res, 200, {groups: writePlacemarkGroups(body.id, body.groups)})
        }
        if (req.method === 'GET' && action === 'tracks') return json(res, 200, listTracks())
        if (req.method === 'GET' && action === 'track') {
          const track = readTrack(id)
          if (track) preparePhotos(track.id)
          return track ? json(res, 200, track) : json(res, 404, {error: '轨迹不存在'})
        }
        if (req.method === 'GET' && action === 'source') {
          const source = readSource(id)
          if (!source) return json(res, 404, {error: '原始文件不存在'})
          const track = readTrack(id)
          const name = (track?.filename || `track.${source.ext}`).replace(/["\\\r\n]/gu, '')
          const asciiName = name.replace(/[^\x20-\x7e]/gu, '_')
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(source.body.length),
            // The original file is handed back byte for byte, under the name it
            // was imported with, so a round trip through the panel is lossless.
            'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
          })
          res.end(source.body)
          return
        }
        if (req.method === 'POST' && action === 'edited-tracks') {
          const body = await readJson(req) as {tracks?: unknown}
          if (!Array.isArray(body?.tracks) || !body.tracks.length || body.tracks.length > 32) throw new Error('一次可保存 1 至 32 条编辑轨迹')
          const inputs = body.tracks.map(asTrack)
          for (const input of inputs) {
            const problem = validateUpload(input.filename, input.source)
            if (problem) throw new Error(problem)
            if (!input.filename.toLowerCase().endsWith('.gpx')) throw new Error('编辑轨迹请保存为 GPX')
            if (input.points.length < 2) throw new Error('每条编辑轨迹至少需要 2 个点')
            if (input.points.some(point => Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) throw new Error('轨迹点超出经纬度范围')
          }
          const tracks = writeTrackBatch(inputs)
          for (const track of tracks) preparePhotos(track.id)
          return json(res, 201, tracks)
        }
        if (req.method === 'POST' && action === 'tracks') {
          const track = writeTrack(asTrack(await readJson(req)))
          preparePhotos(track.id)
          return json(res, 201, track)
        }
        if (req.method === 'DELETE' && action === 'track') {
          return removeTrack(id) ? json(res, 200, {ok: true}) : json(res, 404, {error: '轨迹不存在'})
        }
        json(res, 404, {error: '接口不存在'})
      } catch (error) {
        if ((error instanceof PlacemarkPhotoError || error instanceof VideoMaterialsError || error instanceof ShotEditorProjectError) && error.status === 413) res.setHeader('connection', 'close')
        if (!res.headersSent && !res.destroyed) json(res, error instanceof OpenMontageError || error instanceof TrackAIError || error instanceof PlacemarkStateConflictError || error instanceof PlacemarkPhotoError || error instanceof GeoMotionProjectError || error instanceof ShotEditorProjectError || error instanceof ShotProjectBackupError || error instanceof VideoMaterialsError || error instanceof TrackAgentStoreError ? error.status : 400, {error: error instanceof Error ? error.message : '操作失败'})
      }
    }})
    return () => {unregister();disposeOpenMontage()}
  }, '轨迹存储与本地服务')
}
