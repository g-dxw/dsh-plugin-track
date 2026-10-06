import {ensureTrackAgentSession, type TrackAgentServices, type TrackAgentSession} from './track-agent-session.ts'
import {api as defaultApi} from './util.ts'

const FILES_TIMEOUT_MS = 8000

/** Reuse the host's real Agent workspace, file tree, watcher and document viewers. */
export async function openRouteInformationWorkspace(
  services: TrackAgentServices,
  trackId: string,
  signal?: AbortSignal,
  onActivate?: () => void,
): Promise<TrackAgentSession> {
  signal?.throwIfAborted()
  const files = services.sidebarRight
  if (!files) throw new Error('当前宿主尚未提供原生文件工作区，请更新 Desktop 后重试。')
  const api = services.api ?? defaultApi
  await api('agent-context', {page: 'route-information', trackId})
  signal?.throwIfAborted()
  const session = await ensureTrackAgentSession(services, signal, trackId, {presentation: 'conversation', ...(onActivate ? {onActivate} : {})})
  await waitForFiles(files.mounted, session.sessionId, signal)
  signal?.throwIfAborted()
  // Check and open synchronously: a late A request can never open files in B's seat.
  if (files.mounted.getSnapshot() !== session.sessionId) throw new Error('Agent 工作区已切换，请重新进入当前路线资料。')
  files.openTab('files')
  return session
}

function waitForFiles(source: NonNullable<TrackAgentServices['sidebarRight']>['mounted'], sessionId: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false, unsubscribe = () => {}
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true; clearTimeout(timeout); unsubscribe(); signal?.removeEventListener('abort', onAbort)
      if (error) reject(error); else resolve()
    }
    const onAbort = () => finish(signal?.reason ?? new DOMException('资料工作区打开已取消', 'AbortError'))
    const timeout = setTimeout(() => finish(new Error('原生文件工作区尚未就绪，请在 Agent 工作区中打开「文件」标签，或返回重试。')), FILES_TIMEOUT_MS)
    const check = () => {
      if (finished) return
      try {if (signal?.aborted) onAbort(); else if (source.getSnapshot() === sessionId) finish()}
      catch (error) {finish(error)}
    }
    signal?.addEventListener('abort', onAbort, {once: true})
    try {unsubscribe = source.subscribe(check); if (finished) unsubscribe(); else check()}
    catch (error) {finish(error)}
  })
}
