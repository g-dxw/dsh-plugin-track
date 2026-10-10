import {useEffect, useRef, useState} from 'react'
import {API} from '../protocol.ts'
import type {OpenMontageEditorScope} from '../track/shot-project-scope.ts'

export interface ShotResultIdentity {
  readonly trackId: string
  readonly scope: Readonly<OpenMontageEditorScope>
  readonly projectRevision: string
  readonly editor: 'map' | 'sandbox'
  readonly takeId: string
}
export interface ShotUploadState {status: string; complete: boolean}
/** Recheck native approvals on explicit output; already-open editors are not
 * trusted to retain a current approval after another Agent edits upstream. */
export async function assertShotCaptureApproval(identity: ShotResultIdentity, signal?: AbortSignal): Promise<void> {
  const query = new URLSearchParams({id: identity.trackId, projectId: identity.scope.projectId})
  const response = await fetch(`${API}/openmontage-state?${query}`, {signal})
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('无法核验分镜当前确认状态，镜头工程已保留')
  const state = await response.json()
  if (!response.ok) throw Object.assign(new Error(state?.error || '分镜状态读取失败，镜头工程已保留'), {status: response.status})
  if (!state || state.canProduce !== true || state.scenePlanDigest !== identity.scope.scenePlanDigest
    || state.project?.projectId !== identity.scope.projectId || state.project?.trackId !== identity.trackId) {
    throw new Error('当前需求、脚本或分镜尚未按最新版本确认，镜头工程已保留，请返回 Agent 确认后输出')
  }
  const shot = Array.isArray(state.shots) ? state.shots.find((item: Record<string, unknown>) => item?.shotId === identity.scope.shotId) : null
  if (!shot || shot.editor !== identity.editor || shot.sceneId !== identity.scope.sceneId || shot.scope?.projectId !== identity.scope.projectId
    || shot.scope?.shotId !== identity.scope.shotId || shot.scope?.sceneId !== identity.scope.sceneId || shot.scope?.scenePlanDigest !== identity.scope.scenePlanDigest) {
    throw new Error('当前分镜镜头关联已变化，镜头工程已保留，请重新确认关联后输出')
  }
}
export function freezeShotResult(trackId: string, scope: OpenMontageEditorScope | undefined, revision: string | null, editor: ShotResultIdentity['editor']): ShotResultIdentity | undefined {
  if (!scope) return undefined
  if (!revision || !scope.scenePlanDigest) throw new Error('请先保存已确认分镜的镜头工程，再输出视频')
  return Object.freeze({trackId, scope: Object.freeze({...scope}), projectRevision: revision, editor, takeId: globalThis.crypto.randomUUID()})
}
export function shotResultMatches(identity: ShotResultIdentity, scope: OpenMontageEditorScope | undefined, revision: string | null, dirty: boolean): boolean {
  return !dirty && !!scope && identity.projectRevision === revision && identity.scope.projectId === scope.projectId
    && identity.scope.shotId === scope.shotId && identity.scope.sceneId === scope.sceneId && identity.scope.scenePlanDigest === scope.scenePlanDigest
}
export async function uploadShotResult(blob: Blob, identity: ShotResultIdentity, signal?: AbortSignal): Promise<unknown> {
  const query = new URLSearchParams({id: identity.trackId, projectId: identity.scope.projectId, shotId: identity.scope.shotId,
    takeId: identity.takeId, scenePlanDigest: identity.scope.scenePlanDigest, projectRevision: identity.projectRevision, editor: identity.editor})
  const response = await fetch(`${API}/openmontage-shot-result?${query}`, {method: 'POST', headers: {'content-type': blob.type || 'video/webm', 'x-cqai-track': '1'}, body: blob, signal})
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('轨迹服务暂未就绪，视频仍可下载')
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error || '素材回填失败，视频已保留，可以重试'), {status: response.status})
  const take = result && typeof result === 'object' ? result.take : null
  if (!take || take.takeId !== identity.takeId || take.shotId !== identity.scope.shotId || take.sceneId !== identity.scope.sceneId
    || take.editor !== identity.editor || take.projectRevision !== identity.projectRevision || take.scenePlanDigest !== identity.scope.scenePlanDigest) {
    throw new Error('服务端未确认本次分镜素材已回填，视频已保留，可以重试')
  }
  return result
}

/** The actual capture Blob and immutable identity survive a failed upload or conflict. */
export function ShotResultUpload({blob, identity, scope, revision, dirty, active, disabled, onBusy, onUploaded, initialState, onState}: {
  blob: Blob; identity: ShotResultIdentity; scope?: OpenMontageEditorScope; revision: string | null; dirty: boolean;
  active: boolean; disabled?: boolean; onBusy: (busy: boolean) => void; onUploaded?: () => void; initialState?: ShotUploadState; onState?: (state: ShotUploadState) => void
}) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(initialState?.status ?? ''), [complete, setComplete] = useState(initialState?.complete ?? false)
  const request = useRef<AbortController | null>(null), alive = useRef(true), latestBusy = useRef(onBusy)
  latestBusy.current = onBusy
  useEffect(() => {alive.current = true; return () => {alive.current = false; request.current?.abort(); latestBusy.current(false)}}, [])
  useEffect(() => {if (!active) request.current?.abort()}, [active])
  useEffect(() => {onState?.({status, complete})}, [status, complete, onState])
  const matches = shotResultMatches(identity, scope, revision, dirty)
  async function upload() {
    if (request.current || !active || !matches || disabled || complete) return
    const controller = new AbortController(); request.current = controller; setBusy(true); latestBusy.current(true); setStatus('正在回填分镜素材…')
    try {
      await uploadShotResult(blob, identity, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      setComplete(true); setStatus('已回填当前分镜素材'); onUploaded?.()
    } catch (error) {
      if (alive.current) setStatus(controller.signal.aborted ? '回填已取消，视频已保留，可重试。' : error instanceof Error ? error.message : String(error))
    } finally {
      if (request.current === controller) request.current = null
      if (alive.current) {setBusy(false); latestBusy.current(false)}
    }
  }
  return <div className="trk-gm-shot-result"><style>{SHOT_RESULT_CSS}</style><button type="button" disabled={busy || !active || !matches || disabled || complete} onClick={() => void upload()}>{busy ? '正在回填…' : complete ? '已回填分镜素材' : '回填当前分镜素材'}</button>
    {busy && <button type="button" onClick={() => request.current?.abort()}>取消回填</button>}
    <p role="status" aria-live="polite">{status || (!matches ? '工程或分镜已变化，请保存并重新输出后回填；当前视频仍可下载。' : '回填将关联本次输出的工程版本。')}</p></div>
}

const SHOT_RESULT_CSS=`
.trk-gm-shot-result{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;padding:8px 0;margin-top:8px;border-top:1px solid var(--trk-border);color:var(--trk-text);font-size:var(--trk-ui-font-size,13px)}
.trk-gm-shot-result button{min-height:var(--trk-control-height,32px);padding:4px 9px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm,5px);background:var(--trk-surface);color:var(--trk-text);font:inherit;font-size:var(--trk-ui-label-size,12px);white-space:normal;overflow-wrap:anywhere;cursor:pointer}.trk-gm-shot-result button:disabled{opacity:.5;cursor:not-allowed}.trk-gm-shot-result button:hover:not(:disabled){background:var(--trk-hover)}.trk-gm-shot-result button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-gm-shot-result p{flex-basis:100%;margin:0;color:var(--trk-muted);font-size:var(--trk-ui-label-size,12px);line-height:1.5;overflow-wrap:anywhere}
@container geomotion (max-width:850px){.trk-gm-shot-result button{min-height:44px}.trk-gm-shot-result{gap:8px}}
`
