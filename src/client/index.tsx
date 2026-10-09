/**
 * The client half's entry point: two slot registrations, nothing else.
 *
 * The panel itself is entirely in `TrackPanel.tsx`. This file only says where it
 * goes — the main area under its own key, and one entry in the side panel list —
 * so the layout shell can mount and unmount it like any built-in panel.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { TrackIcon, TrackPanel } from './TrackPanel.tsx'
import type { TrackAgentServices } from './track-agent-session.ts'

export const inject = ['slots']

/** The key the layout shell files this panel under. */
const PANEL = 'cqai-track' as MainPanelId

export function apply(ctx: Context): void {
  const getAgentServices = (): TrackAgentServices | undefined => {
    const sessions = ctx.get('sessions'), workspaces = ctx.get('workspaces'), uiWorkspace = ctx.get('uiWorkspace'), layout = ctx.get('layout')
    if (!sessions || !workspaces || !uiWorkspace || !layout) return undefined
    return {sessions, workspaces, uiWorkspace, layout, conversation: ctx.get('conversation')} as unknown as TrackAgentServices
  }
  ctx.slots.inject('main', () => ctx.slots.register({name: 'main', key: PANEL}, () => <TrackPanel getAgentServices={getAgentServices} />))
  // 43 sits after e剪宝 (41) and 一稿多发 (42): the three are one family and read
  // in the order the work happens — cut, publish, then go look at the ride.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    {name: 'sidebar.panellist', id: PANEL, order: 43, label: '轨迹'},
    ({size}: PropsRuntime<'sidebar.panellist'>) => <TrackIcon size={size} />,
  ))
}
