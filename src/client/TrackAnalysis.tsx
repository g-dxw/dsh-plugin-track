import { useMemo } from 'react'
import type { TrackPoint } from '../protocol.ts'
import { analyzeTrack } from '../track/analysis.ts'
import { formatDuration } from '../track/format.ts'

export function TrackAnalysis({points}: {points: readonly TrackPoint[]}) {
  const report = useMemo(() => analyzeTrack(points), [points])
  const coverage = (count: number) => `${points.length ? Math.round(100 * count / points.length) : 0}%`
  const speed = (value: number | null) => value === null ? '—' : `${(value * 3.6).toFixed(1)} km/h`
  return <details className="trk-analysis" style={{marginBottom: 18, border: '1px solid var(--trk-border)', borderRadius: 'var(--trk-radius-md)', background: 'var(--trk-surface)', color: 'var(--trk-text)', fontSize: 'var(--trk-font-size)', padding: 14}}>
    <summary style={{cursor: 'pointer', minHeight: 30}}>轨迹分析 · 数据完整度与移动情况</summary>
    <div className="trk-stats" style={{marginTop: 14}}>
      {[
        ['海拔覆盖', coverage(report.elevationPoints)], ['时间覆盖', coverage(report.timestampPoints)],
        ['已记录移动时间', report.timedLegs ? formatDuration(report.movingTime) : '—'], ['已记录停留时间', report.timedLegs ? formatDuration(report.stoppedTime) : '—'],
        ['平均移动速度', speed(report.averageMovingSpeed)], ['最高已记录速度', speed(report.maximumSpeed)],
      ].map(([label, value]) => <div className="trk-stat" key={label}><small>{label}</small><strong>{value}</strong></div>)}
    </div>
    <p className="trk-muted">移动与停留只统计相邻点时间完整的路段；速度低于 0.5 m/s 记为停留。超过 30 分钟的采样间隔与超过 200 km/h 的跳点不参与速度统计。缺失的海拔不会按海平面计算。</p>
    <p className="trk-muted">重复位置 {report.duplicatePoints} 处 · 时间重复或倒序 {report.reversedTimes} 处 · 可疑跳点 {report.jumps} 处 · 长采样间隔 {report.longGaps} 处</p>
    <p className="trk-muted"><strong>徒步难度参考：</strong>{report.guidance.difficulty}</p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:12}}>
      <div><strong>适合人群</strong><ul>{report.guidance.audience.map(item=><li key={item}>{item}</li>)}</ul></div>
      <div><strong>所需装备参考</strong><ul>{report.guidance.equipment.map(item=><li key={item}>{item}</li>)}</ul></div>
    </div>
    <p className="trk-muted">{report.guidance.limitations.join('；')}</p>
    <p className="trk-muted">休息候选 {report.restCandidates.length} 处，仅表示连续定位采样中的停留，需确认现场条件。</p>
    {report.restCandidates.length>0&&<ol>{report.restCandidates.map(candidate=><li key={candidate.startIndex}>第 {candidate.startIndex+1}–{candidate.endIndex+1} 个点 · 停留 {formatDuration(candidate.duration)} · {candidate.lon.toFixed(5)}, {candidate.lat.toFixed(5)}</li>)}</ol>}
  </details>
}

