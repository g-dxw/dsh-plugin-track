import { useCallback, useEffect, useRef, useState } from 'react'
import { ensureTrackAgentSession, type TrackAgentServices, type TrackAgentSession } from './track-agent-session.ts'
import { trackAgentSummary, type TrackAgentSummary, type TrackAgentViewContext } from '../track-agent-context.ts'
import { api as defaultApi } from './util.ts'
import {TrackAgentProjectRetentions} from './track-agent-projects.ts'

export const TRACK_AGENT_DRAWER_EVENT = 'dsh-desktop-agent-drawer'
export const TRACK_AGENT_CAPABILITIES_EVENT = 'dsh-desktop-agent-drawer-capabilities'
const PANEL = 'cqai-track'
const trackScope = (context: TrackAgentViewContext) => context.page === 'library' || context.page === 'new' ? null : context.track?.id ?? null
const drawerEntity = (trackId: string | null) => trackId ?? 'track-library'
interface DrawerRequest {open: boolean; panelId: string; entityId?: string; requestId?: string; title?: string; side?: 'left'; mode?: 'simple'; summary?: TrackAgentSummary}
export type TrackAgentServicesReader = () => TrackAgentServices | undefined

/** Capability negotiation belongs to the owning shell, without probing its DOM. */
export function trackAgentDrawerAvailable(): boolean {
  let available = false
  window.dispatchEvent(new CustomEvent(TRACK_AGENT_CAPABILITIES_EVENT, {
    detail: {accept: (capabilities: {sides?: readonly string[]}) => {available = !!capabilities.sides?.includes('left')}},
  }))
  return available
}

export function useTrackAgentDrawer(context: TrackAgentViewContext, getServices?: TrackAgentServicesReader) {
  const [available, setAvailable] = useState(false), [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const current = useRef(context); current.current = context
  const reader = useRef(getServices); reader.current = getServices
  const active = useRef<DrawerRequest | null>(null), pending = useRef<AbortController | null>(null)
  const generation = useRef(0), mounted = useRef(true)
  const retainedProjects = useRef(new TrackAgentProjectRetentions())
  // Capture each write scope: a delayed A write must never update B's project.
  const contextWrites = useRef(new Map<string | null, Promise<void>>())
  const scopeId = trackScope(context), previousScope = useRef(scopeId)
  const contextKey = JSON.stringify([context.page, context.trackCount, context.track?.id, context.track?.name, context.track?.filename, context.track?.points, context.track?.metrics, context.library?.map(track => [track.id, track.name, track.filename, track.points, track.metrics])])
  const latestKey = useRef(contextKey); latestKey.current = contextKey
  const syncContext = useCallback((snapshot = current.current) => {
    const input = {page: snapshot.page, trackId: trackScope(snapshot)}
    const previous = contextWrites.current.get(input.trackId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      if (!mounted.current) return
      const api = reader.current?.()?.api ?? defaultApi
      await api('agent-context', input)
    })
    contextWrites.current.set(input.trackId, next)
    return next
  }, [])

  const close = useCallback(() => {
    generation.current += 1
    pending.current?.abort(); pending.current = null
    const request = active.current
    active.current = null
    setOpen(false); setBusy(false)
    if (request) window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: {...request, open: false}}))
  }, [])

  useEffect(() => {
    mounted.current = true
    const probe = () => setAvailable(trackAgentDrawerAvailable() && !!reader.current?.())
    probe()
    const timer = window.setTimeout(probe, 0)
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<DrawerRequest>).detail
      const request = active.current
      if (!detail || detail.open !== false || detail.panelId !== PANEL || !request
        || detail.requestId !== request.requestId || (detail.entityId !== undefined && detail.entityId !== request.entityId)) return
      active.current = null
      generation.current += 1
      pending.current?.abort(); pending.current = null
      setOpen(false); setBusy(false)
    }
    window.addEventListener(TRACK_AGENT_DRAWER_EVENT, onRequest)
    return () => {
      mounted.current = false
      window.clearTimeout(timer)
      window.removeEventListener(TRACK_AGENT_DRAWER_EVENT, onRequest)
      generation.current += 1
      pending.current?.abort()
      retainedProjects.current.releaseAll()
      const request = active.current; active.current = null
      if (request) window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: {...request, open: false}}))
    }
  }, [])

  useEffect(() => {
    const request = active.current
    if (!request || request.entityId !== drawerEntity(trackScope(current.current))) return
    const updated = {...request, summary: trackAgentSummary(current.current)}
    active.current = updated
    window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: updated}))
    const ticket = generation.current
    void syncContext().then(() => {
      if (mounted.current && generation.current === ticket) setError('')
    }, reason => {
      if (mounted.current && generation.current === ticket) setError(reason instanceof Error ? reason.message : 'Agent 上下文更新失败，请刷新重试。')
    })
  }, [contextKey, syncContext])

  const show = useCallback(async (signal?: AbortSignal): Promise<TrackAgentSession | undefined> => {
    if (signal?.aborted) return
    if (pending.current) return
    const services = reader.current?.()
    if (!services || !trackAgentDrawerAvailable()) {
      setError('当前布局暂不支持左侧 Agent 对话，请更新并重新启动 Desktop。')
      return
    }
    const targetScope = trackScope(current.current)
    const ticket = ++generation.current, controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, {once: true})
    pending.current = controller
    setBusy(true); setError('')
    try {
      const session = await ensureTrackAgentSession(services, controller.signal, targetScope)
      if (controller.signal.aborted || generation.current !== ticket) return
      await retainedProjects.current.hold(services.sessions, session.sessionId, controller.signal)
      if (controller.signal.aborted || generation.current !== ticket) return
      // Pages in one project may change while opening; a different project cancels this opener.
      let written: string
      do {
        if (trackScope(current.current) !== targetScope) return
        written = latestKey.current
        await syncContext(current.current)
        if (controller.signal.aborted || generation.current !== ticket) return
      } while (written !== latestKey.current)
      if (trackScope(current.current) !== targetScope) return
      const request: DrawerRequest = {
        open: true, panelId: PANEL, entityId: drawerEntity(targetScope), requestId: active.current?.requestId ?? crypto.randomUUID(),
        title: 'Agent · 轨迹助手', side: 'left', mode: 'simple', summary: trackAgentSummary(current.current),
      }
      active.current = request
      window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: request}))
      setOpen(true)
      return session
    } catch (reason) {
      if (mounted.current && generation.current === ticket && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Agent 对话打开失败，请重试。')
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (mounted.current && generation.current === ticket) {pending.current = null; setBusy(false)}
    }
  }, [syncContext])

  useEffect(() => {
    if (previousScope.current === scopeId) return
    previousScope.current = scopeId
    const reopen = !!active.current || !!pending.current
    // Native sessions keep their own history and drafts; only the drawer changes its project.
    close()
    if (reopen) void show()
  }, [scopeId, close, show])

  const toggle = useCallback(async () => {
    if (active.current) {close(); return}
    await show()
  }, [close, show])

  return {available, open, busy, error, toggle, show, close}
}
