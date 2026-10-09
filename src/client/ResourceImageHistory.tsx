import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {ResourceAsset, ResourceJob, ResourceLibraryEnvelope} from '../track/resources.ts'
import {loadResourceLibrary} from './resources-api.ts'
import {useResourceJobs} from './useResourceJobs.ts'
import {ResourceImagePreview, ResourceImageThumbnail} from './resource-image-media.tsx'
import {RESOURCE_IMAGE_WORKSPACE_CSS} from './resource-image-workspace-css.ts'

export interface ResourceImageHistoryProps {track: TrackRecord; onBack: () => void; onRestore: (job: ResourceJob, resultAssetId?: string) => void; backLabel?: string; reloadToken?: number}
const states = {submitting: '正在提交', queued: '排队中', running: '生成中', completed: '已完成', failed: '生成失败', canceled: '已取消', unknown: '状态待核对'}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const initialLibrary: ResourceLibraryEnvelope = {revision: '', assets: [], jobs: []}
function referenceSummary(job: ResourceJob): string {
  const references = job.references || (job.sourceAssetId ? [{assetId: job.sourceAssetId, role: 'subject'}] : [])
  const subjects = references.filter(item => item.role === 'subject').length, effects = references.filter(item => item.role === 'effect').length
  return subjects && effects ? `主体 ${subjects} · 效果 ${effects}` : subjects ? `主体参考 ${subjects}` : effects ? `效果参考 ${effects}` : '无参考图'
}
export function ResourceImageHistory(props: ResourceImageHistoryProps) {return <HistoryWorkspace key={props.track.id} {...props}/>}
function HistoryWorkspace({track, onBack, onRestore, backLabel = '返回资源库', reloadToken}: ResourceImageHistoryProps) {
  const [library, setLibrary] = useState<ResourceLibraryEnvelope>(initialLibrary), [loading, setLoading] = useState(true), [error, setError] = useState(''), [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [sort, setSort] = useState('newest'), [covers, setCovers] = useState<Record<string, string>>({}), [preview, setPreview] = useState<ResourceAsset | null>(null)
  const alive = useRef(true), sequence = useRef(0)
  const refresh = useCallback(async () => {const token = ++sequence.current, value = await loadResourceLibrary(track.id); if (!alive.current || token !== sequence.current) return; setLibrary(value); setLoading(false); setError('')}, [track.id])
  const tasks = useResourceJobs(track.id, library.jobs, refresh)
  useEffect(() => {alive.current = true; return () => {alive.current = false; sequence.current++}}, [])
  useEffect(() => {void refresh().catch(error => {if (alive.current) {setLoading(false); setError(message(error))}})}, [refresh, reloadToken])
  const filtered = useMemo(() => library.jobs.filter(job => (status === 'all' || status === 'active' && ['submitting', 'queued', 'running', 'unknown'].includes(job.status) || job.status === status)
    && (!search.trim() || `${job.prompt} ${job.model} ${(job.references || []).map(reference => reference.name || '').join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
    .sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)), [library.jobs, status, search, sort])
  return <section className="trk-i trk-i-history" aria-label="AI 图片历史记录" data-track-image-history=""><style>{RESOURCE_IMAGE_WORKSPACE_CSS}</style><header className="trk-i-head"><div><button type="button" className="trk-i-back" onClick={onBack}>← {backLabel}</button><h2>历史记录</h2><p>所属轨迹：<strong>{track.name}</strong></p></div><button type="button" onClick={() => {void refresh().catch(error => setError(message(error)))}}>刷新历史</button></header>
    {(error || tasks.error) && <p className="trk-i-error" role="alert">{error || tasks.error}</p>}<div className="trk-i-history-toolbar"><input aria-label="搜索图片任务" placeholder="搜索提示词、模型或参考图名称" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="历史任务状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="completed">已完成</option><option value="active">进行中 / 待核对</option><option value="failed">生成失败</option><option value="canceled">已取消</option></select><select aria-label="历史任务排序" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">最新优先</option><option value="oldest">最早优先</option></select></div><p className="trk-i-history-help">点击结果图恢复任务配置；放大仅查看图片，不改变当前草稿。</p>
    {loading ? <div className="trk-i-empty" role="status">正在读取图片创作历史…</div> : !filtered.length ? <div className="trk-i-empty"><h3>{library.jobs.length ? '没有符合条件的任务' : '还没有图片创作记录'}</h3><p>{library.jobs.length ? '调整搜索或状态筛选后继续浏览。' : '提交图片创作后，结果和输入配置会保存在这里。'}</p></div> : <div className="trk-i-history-grid">{filtered.map(job => {
      const results = job.resultAssetIds.map(id => library.assets.find(asset => asset.id === id)).filter((asset): asset is ResourceAsset => !!asset && asset.kind === 'image')
      const cover = results.find(asset => asset.id === covers[job.id]) || results[0]
      return <article className="trk-i-history-card" key={job.id}><div className="trk-i-history-cover">{cover ? <><button type="button" className="trk-i-history-image" aria-label={`恢复任务：${job.prompt}`} onClick={() => onRestore(job, cover.id)}><ResourceImageThumbnail asset={cover} alt="任务实际生成结果"/></button><button type="button" className="trk-i-history-zoom" aria-label={`放大任务结果：${job.prompt}`} title="只放大查看，不恢复配置" onClick={() => setPreview(cover)}>放大</button></> : <button type="button" className="trk-i-history-placeholder" aria-label={`恢复任务：${job.prompt}`} onClick={() => onRestore(job)}><span>{states[job.status]}</span><small>{job.status === 'completed' ? job.resultsPersisted === true ? '结果已移除' : '结果尚未保存' : job.status === 'failed' ? '恢复要求后可以重新创作' : job.status === 'canceled' ? '原任务已取消，输入配置仍保留' : '任务完成后显示实际结果'}</small></button>}</div>
        {results.length > 1 && <div className="trk-i-history-results" aria-label="切换任务封面">{results.map((asset, index) => <button key={asset.id} type="button" aria-label={`任务结果 ${index + 1}：${job.prompt}`} aria-pressed={cover?.id === asset.id} onClick={() => setCovers(previous => ({...previous, [job.id]: asset.id}))}><ResourceImageThumbnail asset={asset}/></button>)}</div>}
        <div className="trk-i-history-copy"><h3 title={job.prompt}>{job.prompt}</h3><p>{referenceSummary(job)}</p><div><span>{new Date(job.createdAt).toLocaleString('zh-CN')}</span><b>{states[job.status]}</b></div><p>{results.length ? `${results.length} 张结果` : '输入配置已保留'}{job.restoredFromJobId ? ' · 来自历史任务' : ''}</p>{job.error && <p className="trk-i-history-error" role="status">{job.error}</p>}<div className="trk-i-actions"><button type="button" onClick={() => onRestore(job, cover?.id)}>恢复任务</button>{job.hostTaskId && job.status === 'completed' && job.resultsPersisted !== true && <button type="button" onClick={() => {void tasks.sync(job)}}>重试保存结果</button>}{job.hostTaskId && ['queued', 'running', 'unknown'].includes(job.status) && <button type="button" onClick={() => {void tasks.sync(job)}}>核对任务</button>}</div></div>
      </article>
    })}</div>}<footer className="trk-i-history-count" role="status">显示 {filtered.length} 项任务 · 当前轨迹共 {library.jobs.length} 项</footer>{preview && <ResourceImagePreview asset={preview} onClose={() => setPreview(null)}/>} 
  </section>
}