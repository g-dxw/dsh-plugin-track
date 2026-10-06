import {useEffect, useRef, useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {TrackAgentServicesReader} from './useTrackAgentDrawer.ts'
import {openRouteInformationWorkspace} from './route-information-workspace.ts'

/** Hand off to the official Agent/files surface for this route. */
export function RouteInformation({track, onBack, getAgentServices, onPrepare}: {
  track: TrackRecord; onBack: () => void; getAgentServices?: TrackAgentServicesReader; onPrepare?: () => void
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const active = useRef(true), pending = useRef<AbortController | null>(null), navigating = useRef(false)
  const actions = useRef({getAgentServices, onPrepare}); actions.current = {getAgentServices, onPrepare}
  async function open() {
    if (pending.current) return
    const services = actions.current.getAgentServices?.()
    if (!services?.sidebarRight) {setError('当前环境无法打开 Agent 文件工作区，请在桌面版中进入这条路线的资料工作区。'); return}
    const controller = new AbortController(); pending.current = controller; navigating.current = false
    setBusy(true); setError(''); actions.current.onPrepare?.()
    try {
      await openRouteInformationWorkspace(services, track.id, controller.signal, () => {navigating.current = true})
    } catch (reason) {
      if (controller.signal.aborted) return
      if (active.current) setError(reason instanceof Error ? reason.message : '资料工作区打开失败，请重试。')
      else console.error('路线资料文件列表打开失败', reason)
    } finally {
      if (pending.current === controller) pending.current = null
      if (active.current) setBusy(false)
    }
  }
  useEffect(() => {
    active.current = true
    void open()
    return () => {active.current = false; if (!navigating.current) pending.current?.abort()}
  }, [track.id])
  return <section className="trk-route-info" aria-label="路线信息整理">
    <style>{css}</style>
    <button type="button" className="trk-secondary" onClick={() => {pending.current?.abort(); onBack()}}>← 返回轨迹详情</button>
    <h2>路线信息整理</h2>
    <p className="trk-muted">{track.name || track.filename} · Agent 资料工作区</p>
    <p>在 Agent 对话中补充路线基础信息、点位说明、环境和行程资料。文档与附件保存在这条路线的工作区，文件列表会同步显示保存结果。</p>
    <button type="button" className="trk-primary" disabled={busy} aria-busy={busy} onClick={() => void open()}>{busy ? '正在打开 Agent 资料工作区…' : '进入 Agent 资料工作区'}</button>
    <p className="trk-muted">点击文件可使用原生预览查看 Markdown、图片等资料。再次进入会恢复这条路线的会话和文件。</p>
    {error && <p className="trk-error" role="alert">{error}</p>}
  </section>
}
const css = '.trk-route-info{max-width:900px}.trk-route-info h2{margin:20px 0 8px}.trk-route-info p{line-height:1.7;overflow-wrap:anywhere}.trk-route-info button{min-height:44px}'
