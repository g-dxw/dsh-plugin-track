import { useCallback, useEffect, useRef, useState } from 'react'
import { ensureTrackAgentSession, type TrackAgentServices } from './track-agent-session.ts'
import { trackAgentSummary, type TrackAgentSummary, type TrackAgentViewContext } from '../track-agent-context.ts'
import { api as defaultApi } from './util.ts'

export const TRACK_AGENT_DRAWER_EVENT = 'dsh-desktop-agent-drawer'
export const TRACK_AGENT_CAPABILITIES_EVENT = 'dsh-desktop-agent-drawer-capabilities'
const PANEL = 'cqai-track'
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
  // Serialize writes and take the latest context when each queued write begins.
  const contextWrites = useRef<Promise<void>>(Promise.resolve())
  const contextKey = JSON.stringify([context.page, context.trackCount, context.track?.id, context.track?.name, context.track?.filename, context.track?.points, context.track?.metrics, context.library?.map(track => [track.id, track.name, track.filename, track.points, track.metrics])])
  const latestKey = useRef(contextKey); latestKey.current = contextKey
  const syncContext = useCallback(() => {
    const next = contextWrites.current.catch(() => {}).then(async () => {
      if (!mounted.current) return
      const latest = current.current
      const api = reader.current?.()?.api ?? defaultApi
      await api('agent-context', {page: latest.page, trackId: latest.track?.id ?? null})
    })
    contextWrites.current = next
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
      const request = active.current; active.current = null
      if (request) window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: {...request, open: false}}))
    }
  }, [])

  useEffect(() => {
    const request = active.current
    if (!request) return
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

  const toggle = useCallback(async () => {
    if (active.current) {close(); return}
    if (busy || pending.current) return
    const services = reader.current?.()
    if (!services || !trackAgentDrawerAvailable()) {
      setError('当前布局暂不支持左侧 Agent 对话，请更新并重新启动 Desktop。')
      return
    }
    const ticket = ++generation.current, controller = new AbortController()
    pending.current = controller
    setBusy(true); setError('')
    try {
      await ensureTrackAgentSession(services, controller.signal)
      if (controller.signal.aborted || generation.current !== ticket) return
      // A route may change during preparation: publish only the freshest scope.
      let written: string
      do {
        written = latestKey.current
        await syncContext()
        if (controller.signal.aborted || generation.current !== ticket) return
      } while (written !== latestKey.current)
      const request: DrawerRequest = {
        open: true, panelId: PANEL, entityId: 'track-library', requestId: crypto.randomUUID(),
        title: 'Agent · 轨迹助手', side: 'left', mode: 'simple', summary: trackAgentSummary(current.current),
      }
      active.current = request
      window.dispatchEvent(new CustomEvent(TRACK_AGENT_DRAWER_EVENT, {detail: request}))
      setOpen(true)
    } catch (reason) {
      if (mounted.current && generation.current === ticket && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Agent 对话打开失败，请重试。')
    } finally {
      if (mounted.current && generation.current === ticket) {pending.current = null; setBusy(false)}
    }
  }, [busy, close, syncContext])

  return {available, open, busy, error, toggle, close}
}
