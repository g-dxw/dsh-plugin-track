import type {TrackAgentServices} from './track-agent-session.ts'

type Sessions = Pick<TrackAgentServices['sessions'], 'retain'>
type Reference = NonNullable<ReturnType<NonNullable<Sessions['retain']>>>

function ready(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Agent 对话打开已取消', 'AbortError'))
  return new Promise((resolve, reject) => {
    const cancel = () => {signal?.removeEventListener('abort', cancel); reject(new DOMException('Agent 对话打开已取消', 'AbortError'))}
    signal?.addEventListener('abort', cancel, {once: true})
    promise.then(() => {signal?.removeEventListener('abort', cancel); resolve()}, error => {signal?.removeEventListener('abort', cancel); reject(error)})
  })
}

/** Keep visited native Session scopes alive while the Track panel owns their unsent drafts. */
export class TrackAgentProjectRetentions {
  private readonly references = new Map<Sessions, Map<string, Reference>>()

  async hold(sessions: Sessions, sessionId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Agent 对话打开已取消', 'AbortError')
    if (!sessions.retain) return
    let projects = this.references.get(sessions)
    if (!projects) {projects = new Map(); this.references.set(sessions, projects)}
    let reference = projects.get(sessionId)
    if (!reference) {
      reference = sessions.retain(sessionId, {source: 'trackPanel'})
      projects.set(sessionId, reference)
      const owned = reference, scope = projects
      // A failed initial open must be retryable; successful scopes survive selection changes.
      void owned.ready.catch(() => {
        if (scope.get(sessionId) !== owned) return
        scope.delete(sessionId)
        try {owned.release()} catch { /* Other retained projects still need cleanup. */ }
      })
    }
    await ready(reference.ready, signal)
  }

  releaseAll(): void {
    const owned = [...this.references.values()].flatMap(projects => [...projects.values()])
    for (const projects of this.references.values()) projects.clear()
    this.references.clear()
    for (const reference of owned) {try {reference.release()} catch { /* Release every other project too. */ }}
  }
}
