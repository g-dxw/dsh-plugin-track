import type { TrackSummary } from './protocol.ts'
import { clipTitle } from './track/title.ts'

export const TRACK_AGENT_PAGES = {
  library: '轨迹列表', overview: '线路详情', 'route-information': '路线信息整理', edit: '编辑线路',
  new: '新建路线', art: '轨迹海报', animation: '轨迹动画', 'video-script': '镜头案例与脚本',
} as const
export type TrackAgentPage = keyof typeof TRACK_AGENT_PAGES
export interface TrackAgentContext {page: TrackAgentPage; trackId?: string | null}
export interface TrackAgentViewContext {page: TrackAgentPage; track: TrackSummary | null; trackCount: number; library?: readonly TrackSummary[]}
export interface TrackAgentSummary {items: {label: string; value: string}[]; note?: string}

export function trackAgentSummary(context: TrackAgentViewContext): TrackAgentSummary {
  return {items: [
    {label: '轨迹库', value: `${context.trackCount} 条轨迹`},
    {label: '当前页面', value: TRACK_AGENT_PAGES[context.page]},
    {label: '当前线路', value: context.track ? clipTitle(context.track.name, context.track.filename) : context.page === 'new' ? '未保存路线' : '未选择线路'},
    {label: '轨迹编号', value: context.track?.id ?? (context.page === 'new' ? '尚未保存' : '未选择线路')},
  ]}
}
