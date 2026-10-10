import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {ResourceAsset, ResourceKind, ResourceLibraryEnvelope, ResourceMetadata, ResourceVideoRole} from '../track/resources.ts'
import {formatBytes} from '../track/format.ts'
import {deleteResource, loadResourceLibrary, prepareResourcePreview, resourceThumbnail, updateResource, uploadResource} from './resources-api.ts'
import {ImageAgentActions} from './ImageAgentActions.tsx'
import {useResourceJobs} from './useResourceJobs.ts'
import {RESOURCE_LIBRARY_CSS} from './resource-library-css.ts'

export type ResourceLibraryProps = {track: TrackRecord; onBack: () => void; initialAssetUrl?: string; onCreate?: (assetIds?: string[]) => void; onHistory?: () => void; onUseImage?: (asset: ResourceAsset) => void | Promise<void>; onVideo?: () => void; reloadToken?: number}
type UploadItem = {id: string; file: File; progress: number; status: 'waiting' | 'uploading' | 'ready' | 'error'; error?: string}
type ViewState = {search: string; type: ResourceKind | 'all'; filter: string; sort: string; selectedId: string; display: 'grid' | 'list'; scroll: number}
const views = new Map<string, ViewState>()
const emptyLibrary: ResourceLibraryEnvelope = {revision: '', assets: [], jobs: []}
const typeName = {image: '图片', video: '视频', audio: '音频'}
const sourceName = {'existing-photo': '轨迹照片', upload: '导入素材', 'svg-annotation': 'SVG 标注', 'map-capture': '地图导出', 'ai-edit': 'AI 创作', 'ai-generate': 'AI 生成'}
const jobName = {submitting: '正在提交', queued: '排队中', running: '生成中', completed: '已完成', failed: '生成失败', canceled: '已取消', unknown: '状态待核对'}
const roleName: Record<ResourceVideoRole, string> = {'image-insert': '图片插图', 'travel-video': '旅程片段', ambient: '环境声', narration: '旁白', music: '背景音乐', 'sound-effect': '音效'}
const getMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const time = (seconds?: number) => seconds === undefined || !Number.isFinite(seconds) ? '时长待读取' : `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
const roles = (kind: ResourceKind): ResourceVideoRole[] => kind === 'image' ? ['image-insert'] : kind === 'video' ? ['travel-video'] : ['ambient', 'narration', 'music', 'sound-effect']

export function ResourceLibrary(props: ResourceLibraryProps) {return <LibraryWorkspace key={props.track.id} {...props}/>}
function LibraryWorkspace({track, onBack, initialAssetUrl, onCreate, onHistory, onUseImage, onVideo, reloadToken}: ResourceLibraryProps) {
  const saved = views.get(track.id)
  const [library, setLibrary] = useState<ResourceLibraryEnvelope>(emptyLibrary), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState(saved?.search || ''), [type, setType] = useState<ResourceKind | 'all'>(saved?.type || 'all'), [filter, setFilter] = useState(saved?.filter || 'all'), [sort, setSort] = useState(saved?.sort || 'newest')
  const [selectedId, setSelectedId] = useState(saved?.selectedId || ''), [checked, setChecked] = useState<string[]>([]), [display, setDisplay] = useState<'grid' | 'list'>(saved?.display || 'grid')
  const [preview, setPreview] = useState(false), [mobilePanel, setMobilePanel] = useState(false), [comparison, setComparison] = useState<'result' | 'original' | 'both'>('result')
  const [draftName, setDraftName] = useState(''), [draftTags, setDraftTags] = useState(''), [videoRole, setVideoRole] = useState<ResourceVideoRole>('image-insert'), [bulkTags, setBulkTags] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [mediaError, setMediaError] = useState('')
  const [uploads, setUploads] = useState<UploadItem[]>([]), [deleteIds, setDeleteIds] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null), gridScroll = useRef<HTMLDivElement>(null), alive = useRef(true), request = useRef(0), initialHandled = useRef(false), importLock = useRef(false), metadataPending = useRef(new Set<string>()), scrollPosition = useRef(saved?.scroll || 0)
  const workspace = useRef<HTMLElement>(null), main = useRef<HTMLElement>(null), workbench = useRef<HTMLElement>(null), mobileBack = useRef<HTMLButtonElement>(null), deleteDialog = useRef<HTMLElement>(null)
  const libraryReturnFocus = useRef<HTMLElement | null>(null), panelReturnFocus = useRef<HTMLElement | null>(null), deleteReturnFocus = useRef<HTMLElement | null>(null), pendingFocus = useRef<'panel' | 'main' | 'library' | null>(null)
  const selected = library.assets.find(asset => asset.id === selectedId)
  const activeJob = selected?.jobId ? library.jobs.find(job => job.id === selected.jobId) : undefined
  const originalId = activeJob?.references ? activeJob.references.find(reference => reference.role === 'subject')?.assetId : selected?.parentAssetId
  const original = originalId ? library.assets.find(asset => asset.id === originalId) : undefined
  const refresh = useCallback(async () => {
    const token = ++request.current
    const result = await loadResourceLibrary(track.id)
    if (!alive.current || token !== request.current) return
    setLibrary(result); setLoading(false); setLoadError('')
    if (initialAssetUrl && !initialHandled.current) {
      initialHandled.current = true
      const asset = result.assets.find(item => item.url === initialAssetUrl || item.sourceUrl === initialAssetUrl)
      if (asset) {setSelectedId(asset.id); setPreview(true); setMobilePanel(true)}
      else setError('这张照片尚未登记到资源库，请刷新后重试')
    }
  }, [track.id, initialAssetUrl])
  const jobs = useResourceJobs(track.id, library.jobs, refresh)
  useEffect(() => {alive.current = true; return () => {alive.current = false; request.current++}}, [])
  useEffect(() => {void refresh().catch(reason => {if (alive.current) {setLoadError(getMessage(reason)); setLoading(false)}})}, [refresh, reloadToken])
  useEffect(() => {
    views.set(track.id, {search, type, filter, sort, selectedId, display, scroll: scrollPosition.current})
  }, [track.id, search, type, filter, sort, selectedId, display])
  useEffect(() => {
    setDraftName(selected?.name || ''); setDraftTags(selected?.tags.join(', ') || ''); setVideoRole(selected?.videoRole || (selected?.kind === 'video' ? 'travel-video' : selected?.kind === 'audio' ? 'ambient' : 'image-insert')); setMediaError('')
  }, [selected?.id, selected?.name, selected?.tags.join(','), selected?.videoRole])
  useEffect(() => {if (!preview && gridScroll.current) gridScroll.current.scrollTop = scrollPosition.current}, [preview, loading, mobilePanel])
  useEffect(() => {
    const target = pendingFocus.current; pendingFocus.current = null
    if (!target) return
    const returnTo = target === 'library' ? libraryReturnFocus.current : panelReturnFocus.current
    if (target === 'panel') (compact() ? mobileBack.current : workbench.current)?.focus({preventScroll: true})
    else if (returnTo?.isConnected && main.current?.contains(returnTo)) returnTo.focus({preventScroll: true})
    else (target === 'library' ? main.current?.querySelector<HTMLElement>('.trk-r-card.is-selected .trk-r-card-main') || main.current : main.current)?.focus({preventScroll: true})
  }, [mobilePanel, preview, selectedId])
  useEffect(() => {
    if (!deleteIds.length) return
    return () => {
      if (deleteReturnFocus.current?.isConnected) deleteReturnFocus.current.focus({preventScroll: true})
      else (mobilePanel ? workbench.current : main.current)?.focus({preventScroll: true})
    }
  }, [Boolean(deleteIds.length)])
  useEffect(() => {if (deleteIds.length && busy) deleteDialog.current?.focus({preventScroll: true})}, [Boolean(deleteIds.length), busy])
  const filtered = useMemo(() => library.assets.filter(asset => (type === 'all' || asset.kind === type)
    && (filter === 'all' || filter === 'candidate' && asset.candidate || filter === 'ai' && asset.source.startsWith('ai-') || filter === 'unused' && !asset.usages.length || filter === 'video' && !!asset.videoRole)
    && (!search.trim() || `${asset.name} ${asset.tags.join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.createdAt.localeCompare(a.createdAt)), [library.assets, type, filter, search, sort])
  const pendingCount = library.jobs.filter(job => ['submitting', 'queued', 'running', 'unknown'].includes(job.status)).length
  const candidates = library.assets.filter(asset => asset.candidate).length
  const patchAsset = (asset: ResourceAsset) => setLibrary(previous => ({...previous, assets: previous.assets.map(item => item.id === asset.id ? asset : item)}))
  async function run(action: () => Promise<void>) {if (busy) return; setBusy(true); setError(''); setNotice(''); try {await action()} catch (reason) {if (alive.current) setError(getMessage(reason))} finally {if (alive.current) setBusy(false)}}
  async function ensureSaved(asset: ResourceAsset): Promise<ResourceAsset> {if (!asset.candidate) return asset; const savedAsset = await updateResource(track.id, asset.id, {candidate: false}); if (alive.current) patchAsset(savedAsset); return savedAsset}
  function compact() {return (workspace.current?.getBoundingClientRect().width || window.innerWidth) <= 960}
  function showWorkbench(trigger: HTMLElement) {if (!preview && gridScroll.current) scrollPosition.current = gridScroll.current.scrollTop; panelReturnFocus.current = trigger; pendingFocus.current = 'panel'; setMobilePanel(true)}
  function closeWorkbench() {pendingFocus.current = 'main'; setMobilePanel(false)}
  function openSelectedPreview() {pendingFocus.current = 'main'; setPreview(true); setComparison('result'); setMobilePanel(false)}
  function choose(asset: ResourceAsset, openPreview = false, trigger?: HTMLElement) {
    libraryReturnFocus.current = trigger || null
    setSelectedId(asset.id); setPreview(openPreview); setComparison('result')
    if (!openPreview && trigger && compact()) showWorkbench(trigger)
    else {setMobilePanel(false); if (openPreview) pendingFocus.current = 'main'}
  }
  function backToLibrary() {pendingFocus.current = 'library'; setPreview(false); setMobilePanel(false)}
  function requestDelete(ids: string[], trigger: HTMLElement) {deleteReturnFocus.current = trigger; setDeleteIds(ids)}
  function createImage() {onCreate?.(checked.length ? checked.filter(id => library.assets.find(asset => asset.id === id)?.kind === 'image') : selected?.kind === 'image' ? [selected.id] : [])}
  async function importFiles(files: File[]) {
    if (importLock.current || !files.length) return
    importLock.current = true
    const items = files.map(file => ({id: crypto.randomUUID(), file, progress: 0, status: 'waiting' as const}))
    setUploads(previous => [...previous, ...items]); setError('')
    for (const item of items) {
      const update = (patch: Partial<UploadItem>) => {if (alive.current) setUploads(previous => previous.map(entry => entry.id === item.id ? {...entry, ...patch} : entry))}
      update({status: 'uploading'})
      try {
        const asset = await uploadResource(track.id, item.file, progress => update({progress}))
        update({status: 'ready', progress: 100}); if (alive.current) {await refresh(); setSelectedId(asset.id)}
      } catch (reason) {update({status: 'error', error: getMessage(reason)})}
    }
    importLock.current = false
  }
  async function recordMetadata(asset: ResourceAsset, metadata: ResourceMetadata) {
    if (metadataPending.current.has(asset.id) || Object.entries(metadata).every(([name, value]) => asset.metadata[name as keyof ResourceMetadata] === value)) return
    metadataPending.current.add(asset.id)
    try {const updated = await updateResource(track.id, asset.id, {metadata}); if (alive.current) patchAsset(updated)} catch { /* Playback remains usable if optional metadata could not be saved. */ }
    finally {metadataPending.current.delete(asset.id)}
  }
  function image(asset: ResourceAsset, label: string) {return <figure><img src={asset.url} alt={label} onError={() => setMediaError('图片暂时无法读取，请检查原始文件或链接')} onLoad={event => {const target = event.currentTarget; void recordMetadata(asset, {width: target.naturalWidth, height: target.naturalHeight})}}/><figcaption>{label}</figcaption></figure>}
  function media(asset: ResourceAsset) {
    if (asset.kind === 'image') {
      if (comparison === 'both' && original) return <div className="trk-r-compare">{image(original, '原图')}{image(asset, 'AI 结果')}</div>
      return image(comparison === 'original' && original ? original : asset, comparison === 'original' && original ? '原图' : asset.name)
    }
    const metadata = (element: HTMLMediaElement) => {void recordMetadata(asset, {...(Number.isFinite(element.duration) ? {duration: element.duration} : {}), ...(asset.kind === 'video' ? {width: (element as HTMLVideoElement).videoWidth, height: (element as HTMLVideoElement).videoHeight} : {})})}
    return asset.kind === 'video' ? <video key={asset.id} src={asset.url} controls preload="metadata" aria-label={`预览视频：${asset.name}`} onLoadedMetadata={event => metadata(event.currentTarget)} onError={() => setMediaError('当前环境无法预览此编码，仍可整理和下载文件')}/>
      : <div className="trk-r-audio"><MediaIcon kind="audio"/><h3>{asset.name}</h3><audio key={asset.id} src={asset.url} controls preload="metadata" aria-label={`试听音频：${asset.name}`} onLoadedMetadata={event => metadata(event.currentTarget)} onError={() => setMediaError('当前环境无法预览此编码，仍可整理和下载文件')}/></div>
  }
  return <section ref={workspace} className="trk-r" aria-label="轨迹资源库" data-track-resource-library="">
    <style>{RESOURCE_LIBRARY_CSS}</style>
    <header className="trk-r-head"><div><nav aria-label="资源库导航"><button type="button" onClick={onBack}>← 返回轨迹详情</button><span>/ 资源库</span></nav><h2>轨迹资源库</h2><p>所属轨迹：<strong>{track.name}</strong><span> · {library.assets.filter(asset => !asset.candidate).length} 项素材{candidates ? ` · ${candidates} 项待选结果` : ''}</span></p></div><div className="trk-r-actions"><button type="button" onClick={onHistory} disabled={!onHistory}>历史记录</button>{onVideo && <button type="button" onClick={onVideo}>视频制作</button>}<button type="button" onClick={() => {void refresh().catch(reason => setError(getMessage(reason)))}}>刷新资源</button></div></header>
    {loadError && <div className="trk-r-error" role="alert">{loadError} <button onClick={() => {setLoading(true); void refresh().catch(reason => {setLoadError(getMessage(reason)); setLoading(false)})}}>重新读取</button></div>}
    {(error || jobs.error) && <div className="trk-r-error" role="alert">{error || jobs.error}</div>}{notice && <div className="trk-r-notice" role="status">{notice}</div>}
    <div className={`trk-r-body${mobilePanel ? ' trk-r-panel-open' : ''}`}>
      <main ref={main} className="trk-r-main" tabIndex={-1} aria-label={preview ? '资源预览' : '资源列表'}>
        {!preview ? <><div className="trk-r-toolbar"><div className="trk-r-tabs" role="group" aria-label="素材类型">{(['all', 'image', 'video', 'audio'] as const).map(value => <button key={value} type="button" aria-pressed={type === value} onClick={() => setType(value)}>{value === 'all' ? '全部' : typeName[value]}</button>)}</div><div className="trk-r-actions"><button type="button" onClick={() => input.current?.click()}>导入资源</button>{onCreate && <button type="button" className="trk-primary" onClick={createImage}>AI 图片创作</button>}</div><input ref={input} type="file" multiple hidden accept="image/*,video/*,audio/*,.mkv,.flac,.m4a" aria-label="导入图片视频音频" onChange={event => {void importFiles(Array.from(event.target.files || [])); event.target.value = ''}}/></div>
          <div className="trk-r-filters"><input aria-label="搜索素材" placeholder="搜索名称或标签" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="筛选资源" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">所有素材</option><option value="candidate">待选结果</option><option value="ai">AI 图片</option><option value="unused">尚未使用</option><option value="video">视频素材清单</option></select><select aria-label="素材排序" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">最近导入</option><option value="name">按名称</option></select><button type="button" aria-label={display === 'grid' ? '切换列表显示' : '切换网格显示'} onClick={() => setDisplay(display === 'grid' ? 'list' : 'grid')}>{display === 'grid' ? '列表' : '网格'}</button></div>
          <div className="trk-r-scroll" ref={gridScroll} onScroll={event => {if (mobilePanel && compact()) return; scrollPosition.current = event.currentTarget.scrollTop; const value = views.get(track.id); if (value) value.scroll = scrollPosition.current}} onDragOver={event => event.preventDefault()} onDrop={event => {event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files))}}>
            {loading ? <div className="trk-r-empty" role="status">正在读取轨迹素材…</div> : !filtered.length ? <div className="trk-r-empty"><MediaIcon kind="image"/><h3>{library.assets.length ? '没有符合条件的素材' : '收集这次旅程的素材'}</h3><p>{library.assets.length ? '调整搜索和筛选条件后继续浏览。' : '导入图片、视频和音频，也可以在这里生成新的图片。'}</p><div className="trk-r-actions"><button type="button" onClick={() => input.current?.click()}>导入资源</button>{!library.assets.length && onCreate && <button type="button" className="trk-primary" onClick={() => onCreate([])}>AI 图片创作</button>}</div></div> : <div className={`trk-r-assets trk-r-${display}`}>{filtered.map(asset => <article key={asset.id} className={`trk-r-card${selectedId === asset.id ? ' is-selected' : ''}`}><label className="trk-r-check"><input type="checkbox" aria-label={`选择素材：${asset.name}`} checked={checked.includes(asset.id)} onChange={event => setChecked(previous => event.target.checked ? [...previous, asset.id] : previous.filter(id => id !== asset.id))}/></label><button type="button" className="trk-r-card-main" aria-pressed={selectedId === asset.id} aria-label={`查看素材：${asset.name}`} onClick={event => choose(asset, false, event.currentTarget)} onDoubleClick={event => choose(asset, true, event.currentTarget)}><ResourceThumbnail asset={asset}/><span className="trk-r-card-copy"><strong>{asset.name}</strong><span>{sourceName[asset.source]}{asset.kind !== 'image' ? ` · ${time(asset.metadata.duration)}` : ''}</span><span className="trk-r-badges">{asset.candidate && <b>待选结果</b>}{asset.videoRole && <b>{roleName[asset.videoRole]}</b>}{asset.usages.filter(usage => usage.kind !== 'video').length > 0 && <b>已关联点位</b>}{asset.tags.slice(0, 2).map(tag => <b key={tag}>{tag}</b>)}</span></span></button><button type="button" className="trk-r-card-preview" onClick={event => choose(asset, true, event.currentTarget)}>预览</button></article>)}</div>}
          </div><div className="trk-r-count"><span role="status">显示 {filtered.length} 项 · 已选 {checked.length} 项</span>{!!checked.length && <button type="button" onClick={event => showWorkbench(event.currentTarget)}>整理所选 {checked.length} 项</button>}<button type="button" disabled={!checked.length} onClick={() => setChecked([])}>取消选择</button></div>
        </> : <><div className="trk-r-preview-head"><button type="button" onClick={backToLibrary}>← 返回资源库</button><strong>{selected?.name || '图片创作'}</strong><button type="button" className="trk-r-mobile-settings" onClick={event => showWorkbench(event.currentTarget)}>查看工作台</button></div>{selected?.kind === 'image' && original && <div className="trk-r-tabs" role="group" aria-label="图片结果对比">{([['result', '结果'], ['original', '原图'], ['both', '左右对照']] as const).map(([value, label]) => <button key={value} aria-pressed={comparison === value} onClick={() => setComparison(value)}>{label}</button>)}</div>}<div className="trk-r-stage">{selected ? media(selected) : <div className="trk-r-empty"><MediaIcon kind="image"/><h3>创作一张新的旅程图片</h3><p>填写要求并点击生成；结果先保存为候选，原有素材保持完整。</p></div>}</div>{mediaError && <p role="alert" className="trk-r-error">{mediaError}</p>}{selected && <div className="trk-r-preview-actions">{selected.candidate && <button className="trk-primary" disabled={busy} onClick={() => void run(async () => {await ensureSaved(selected); setNotice('图片已保存到资源库')})}>保存到资源库</button>}{selected.kind === 'image' && onUseImage && <button disabled={busy} onClick={() => void run(async () => {await onUseImage(await ensureSaved(selected))})}>添加到点位</button>}<a href={selected.url} download={selected.name}>下载原文件</a></div>}{selected?.kind === 'image' && originalId && !original && <p className="trk-r-muted">原图已移除，当前结果仍可保存和使用。</p>}{activeJob && <div className="trk-r-provenance"><strong>本次生成要求</strong><p>{activeJob.prompt}</p><span>{activeJob.model} · {jobName[activeJob.status]}</span></div>}</>}
      </main>
      <aside ref={workbench} className="trk-r-workbench" aria-label="资源工作台" tabIndex={-1}><button ref={mobileBack} type="button" className="trk-r-mobile-back" onClick={closeWorkbench}>{preview ? '← 查看预览' : '← 查看素材'}</button>
        {checked.length > 0 ? <><h3>批量整理 · {checked.length} 项</h3>{onCreate && <button className="trk-primary" disabled={!checked.some(id => library.assets.find(asset => asset.id === id)?.kind === 'image')} onClick={() => onCreate(checked.filter(id => library.assets.find(asset => asset.id === id)?.kind === 'image'))}>用所选图片创作</button>}<label>追加标签<input aria-label="批量标签" value={bulkTags} onChange={event => setBulkTags(event.target.value)} placeholder="使用逗号分隔"/></label><button disabled={busy || !bulkTags.trim()} onClick={() => void run(async () => {for (const id of checked) {const asset = library.assets.find(item => item.id === id); if (asset) await updateResource(track.id, id, {tags: [...new Set([...asset.tags, ...bulkTags.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean)])]})}; await refresh(); setNotice('标签已保存')})}>保存标签</button><hr/><button className="trk-r-danger" disabled={busy} onClick={event => requestDelete(checked, event.currentTarget)}>移除所选资源</button><p className="trk-r-muted">仍被点位或视频素材清单引用的资源受到保护。</p></> : <>
          {selected ? <><h3>{typeName[selected.kind]}信息</h3>{selected.error && <p role="alert" className="trk-r-error">{selected.error}</p>}<label>名称<input aria-label="资源名称" value={draftName} onChange={event => setDraftName(event.target.value)}/></label><label>标签<input aria-label="资源标签" value={draftTags} placeholder="使用逗号分隔" onChange={event => setDraftTags(event.target.value)}/></label><button disabled={busy || !draftName.trim()} onClick={() => void run(async () => {patchAsset(await updateResource(track.id, selected.id, {name: draftName.trim(), tags: [...new Set(draftTags.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean))]})); setNotice('资源信息已保存')})}>保存信息</button><dl><dt>来源</dt><dd>{sourceName[selected.source]}{selected.candidate ? ' · 待选结果' : ''}</dd><dt>文件</dt><dd>{selected.mime || '未知格式'} · {formatBytes(selected.bytes)}</dd>{selected.kind === 'image' && <><dt>图片 ID</dt><dd><code style={{overflowWrap: 'anywhere', whiteSpace: 'normal'}}>{selected.id}</code></dd></>}{selected.metadata.width && <><dt>尺寸</dt><dd>{selected.metadata.width} × {selected.metadata.height}</dd></>}{selected.kind !== 'image' && <><dt>时长</dt><dd>{time(selected.metadata.duration)}</dd></>}<dt>关联</dt><dd>{selected.usages.length ? selected.usages.map(usage => usage.name || (usage.kind === 'video' ? '视频素材清单' : '轨迹点位')).join('、') : '尚未使用'}</dd></dl>{selected.kind === 'image' && <><ImageAgentActions key={track.id + ':' + selected.id} image={{kind: 'resource', trackId: track.id, assetId: selected.id}}/><p className="trk-r-muted">图片引用可供 Agent 手动读取；添加到 Agent 草稿后不会自动发送。</p></>}<div className="trk-r-stack"><button onClick={openSelectedPreview}>打开预览</button>{selected.candidate && <button className="trk-primary" disabled={busy} onClick={() => void run(async () => {await ensureSaved(selected); setNotice('图片已保存到资源库')})}>保存到资源库</button>}<button className="trk-primary" disabled={!onCreate} onClick={() => onCreate?.(selected.kind === 'image' ? [selected.id] : [])}>AI 图片创作</button>{selected.kind === 'image' && onUseImage && <button disabled={busy} onClick={() => void run(async () => {await onUseImage(await ensureSaved(selected))})}>添加到点位</button>}</div><hr/><h3>视频素材清单</h3><label>素材用途<select aria-label="视频素材用途" value={videoRole} onChange={event => setVideoRole(event.target.value as ResourceVideoRole)}>{roles(selected.kind).map(role => <option key={role} value={role}>{roleName[role]}</option>)}</select></label><button disabled={busy} onClick={() => void run(async () => {const savedAsset = await ensureSaved(selected); patchAsset(await updateResource(track.id, savedAsset.id, {videoRole})); setNotice('已加入这条轨迹的视频素材清单')})}>加入视频素材清单</button>{selected.videoRole && <button disabled={busy} onClick={() => void run(async () => {patchAsset(await updateResource(track.id, selected.id, {videoRole: null})); setNotice('已从视频素材清单移除')})}>从素材清单移除</button>}<p className="trk-r-muted">先整理制作素材，进入视频制作后选择使用。</p><hr/><button className="trk-r-danger" disabled={busy || !!selected.usages.length} onClick={event => requestDelete([selected.id], event.currentTarget)}>{selected.candidate ? '丢弃候选结果' : '移除资源'}</button>{!!selected.usages.length && <p className="trk-r-muted">请先解除现有用途，再移除资源。</p>}</> : <div className="trk-r-empty"><p>选择素材以查看详情，或导入这次旅程的图片、视频和音频。</p><button className="trk-primary" disabled={!onCreate} onClick={() => onCreate?.([])}>AI 图片创作</button></div>}
        </>}
      </aside>
    </div>
    {!!uploads.length && <div className="trk-r-uploads" aria-label="资源导入进度">{uploads.map(item => <div key={item.id}><strong>{item.file.name}</strong><span>{item.status === 'ready' ? '导入完成' : item.status === 'error' ? item.error : item.status === 'waiting' ? '等待导入' : item.progress === 100 ? '正在保存文件…' : `上传 ${item.progress}%`}</span>{item.status === 'uploading' && <progress value={item.progress} max={100} aria-label={`${item.file.name} 上传进度`}/>} {item.status === 'error' && <button disabled={importLock.current} onClick={() => {setUploads(previous => previous.filter(entry => entry.id !== item.id)); void importFiles([item.file])}}>重试此文件</button>}</div>)}<button disabled={uploads.some(item => item.status === 'waiting' || item.status === 'uploading')} onClick={() => setUploads([])}>收起导入记录</button></div>}
    <footer className="trk-r-taskbar"><span role="status">{pendingCount ? `${pendingCount} 项任务进行中` : '任务记录'}{candidates ? ` · ${candidates} 项待选结果` : ''}</span><div className="trk-r-actions">{!!candidates && <button type="button" onClick={() => {setFilter('candidate'); setType('image'); setPreview(false); setMobilePanel(false)}}>查看待选结果</button>}<button type="button" disabled={!onHistory} onClick={onHistory}>查看历史记录</button></div></footer>
    {!!deleteIds.length && <div className="trk-r-mask"><section ref={deleteDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="trk-resource-delete-title" className="trk-r-dialog" onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); if (!busy) setDeleteIds([])}; if (event.key === 'Tab') {const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const first = buttons[0], last = buttons.at(-1); if (!first) {event.preventDefault(); event.currentTarget.focus(); return} if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {event.preventDefault(); last?.focus()} else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {event.preventDefault(); first?.focus()}}}}><h3 id="trk-resource-delete-title">移除 {deleteIds.length} 项资源？</h3><p>此操作会移除未被使用的资源。轨迹照片的原有文件仍保留。</p>{deleteIds.some(id => library.assets.find(asset => asset.id === id)?.usages.length) && <p className="trk-r-error">所选资源仍有用途，请先解除关联。</p>}{busy && <p role="status">正在移除资源…</p>}<div className="trk-r-actions"><button autoFocus disabled={busy} onClick={() => setDeleteIds([])}>取消</button><button className="trk-r-danger" disabled={busy || deleteIds.some(id => library.assets.find(asset => asset.id === id)?.usages.length)} onClick={() => void run(async () => {for (const id of deleteIds) await deleteResource(track.id, id); setChecked(previous => previous.filter(id => !deleteIds.includes(id))); if (deleteIds.includes(selectedId)) {setSelectedId(''); setPreview(false)}; setDeleteIds([]); await refresh(); setNotice('资源已移除')})}>确认移除</button></div></section></div>}
  </section>
}

function MediaIcon({kind}: {kind: ResourceKind}) {return <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{kind === 'image' ? <><rect x="6" y="9" width="36" height="30" rx="5"/><circle cx="16" cy="18" r="3"/><path d="m8 35 10-10 7 7 6-6 9 9"/></> : kind === 'video' ? <><rect x="5" y="10" width="38" height="28" rx="4"/><path d="m20 18 12 6-12 6Z"/></> : <><path d="M8 19v10m8-17v24m8-29v34m8-28v22m8-17v12"/></>}</svg>}
function ResourceThumbnail({asset}: {asset: ResourceAsset}) {
  const node = useRef<HTMLSpanElement>(null), [ready, setReady] = useState(asset.kind !== 'image' || !asset.sourceUrl), [failed, setFailed] = useState(false)
  useEffect(() => {
    if (ready || asset.kind !== 'image') return
    let active = true
    const prepare = () => {void prepareResourcePreview(asset).then(() => {if (active) setReady(true)}).catch(() => {if (active) setFailed(true)})}
    if (typeof IntersectionObserver === 'undefined' || !node.current) {prepare(); return () => {active = false}}
    const observer = new IntersectionObserver(entries => {if (entries.some(entry => entry.isIntersecting)) {observer.disconnect(); prepare()}}, {rootMargin: '120px'})
    observer.observe(node.current)
    return () => {active = false; observer.disconnect()}
  }, [asset.id, ready])
  return <span ref={node} className="trk-r-thumb">{asset.kind === 'image' && ready && !failed ? <img src={resourceThumbnail(asset)} alt="" loading="lazy" onError={() => setFailed(true)}/> : <><MediaIcon kind={asset.kind}/><span>{failed ? '预览暂不可用' : typeName[asset.kind]}</span></>}</span>
}
