import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import type {ResourceAsset, ResourceJob, ResourceJobReference, ResourceLibraryEnvelope} from '../track/resources.ts'
import type {ResourcePromptTemplate} from '../track/resource-templates.ts'
import {IMAGEGEN_RESOURCE_SETTINGS_DEFAULT, IMAGEGEN_RESOURCE_SIZES, IMAGEGEN_RESOURCE_QUALITIES, loadImagegenCatalog, type ImagegenCatalog} from './imagegen.ts'
import {loadResourceLibrary, resourceFileType, updateResource, uploadResource} from './resources-api.ts'
import {useResourceJobs} from './useResourceJobs.ts'
import {PromptTemplateLibrary} from './PromptTemplateLibrary.tsx'
import {ImageAgentActions} from './ImageAgentActions.tsx'
import {ImagePromptOptimizer} from './ImagePromptOptimizer.tsx'
import {imagePromptContext, imagePromptContextFingerprint, type ImagePromptAttribution} from './image-prompt-context.ts'
import {clearReservedImageDraft, emptyImageDraft, imageDraftDirty, imageDraftFingerprint, imageDraftFromJob, imageDraftHasInput, moveImageReference, readImageDraft, writeImageDraft, type ResourceImageDraft} from './resource-image-draft.ts'
import {ResourceImageModal, ResourceImagePreview, ResourceImageThumbnail} from './resource-image-media.tsx'
import {RESOURCE_IMAGE_WORKSPACE_CSS} from './resource-image-workspace-css.ts'

export type ResourceImageRestore = {job: ResourceJob; resultAssetId?: string; token: string}
export interface ResourceImageWorkspaceProps {
  track: TrackRecord; initialAssetIds?: string[]; initialAssetUrl?: string; restore?: ResourceImageRestore
  onBack: () => void; onHistory: () => void; onUseImage?: (asset: ResourceAsset) => void | Promise<void>
  onVideo?: () => void; reloadToken?: number
}
type Role = ResourceJobReference['role']
type SwitchRequest = {kind: 'restore'; value: ResourceImageRestore} | {kind: 'new' | 'initial'; references?: ResourceJobReference[]} | {kind: 'backup'; draft: ResourceImageDraft}
type Upload = {id: string; name: string; progress: number; status: 'uploading' | 'saved' | 'error'; error?: string}
const blankLibrary: ResourceLibraryEnvelope = {revision: '', assets: [], jobs: []}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const roleName = {subject: '主体', effect: '效果'}
const stateName = {submitting: '正在提交', queued: '排队中', running: '生成中', completed: '已完成', failed: '生成失败', canceled: '已取消', unknown: '状态待核对'}
function grouped(references: ResourceJobReference[]): ResourceJobReference[] {return [...references.filter(item => item.role === 'subject'), ...references.filter(item => item.role === 'effect')]}

export function ResourceImageWorkspace(props: ResourceImageWorkspaceProps) {return <ImageWorkspace key={props.track.id} {...props}/>}
function ImageWorkspace({track, initialAssetIds, initialAssetUrl, restore, onBack, onHistory, onUseImage, onVideo, reloadToken}: ResourceImageWorkspaceProps) {
  const [draft, setDraft] = useState<ResourceImageDraft>(() => readImageDraft(track.id) || emptyImageDraft(track.id))
  const [library, setLibrary] = useState<ResourceLibraryEnvelope>(blankLibrary), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('')
  const [catalog, setCatalog] = useState<ImagegenCatalog>({models: [], defaultModel: null, available: false, message: '正在读取宿主 AI 服务…'})
  const [template, setTemplate] = useState<ResourcePromptTemplate>(), [templateDialog, setTemplateDialog] = useState<{tab: 'featured' | 'mine' | 'reference'; create?: boolean} | null>(null)
  const [optimizer, setOptimizer] = useState<{prompt: string; kind: 'template' | 'refine'; attribution?: ImagePromptAttribution} | null>(null)
  const [mobileView, setMobileView] = useState<'configuration' | 'results'>('configuration'), [comparison, setComparison] = useState(false), [compareId, setCompareId] = useState('')
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [storageError, setStorageError] = useState(''), [busy, setBusy] = useState(false)
  const [switchRequest, setSwitchRequest] = useState<SwitchRequest | null>(null), [hasBackup, setHasBackup] = useState(() => !!readImageDraft(track.id, true))
  const [picker, setPicker] = useState<Role | null>(null), [pickerSearch, setPickerSearch] = useState(''), [pickerIds, setPickerIds] = useState<string[]>([])
  const [duplicateRequest, setDuplicateRequest] = useState<{assets: ResourceAsset[]; role: Role} | null>(null), [previewAsset, setPreviewAsset] = useState<ResourceAsset | null>(null), [uploads, setUploads] = useState<Upload[]>([])
  const subjectInput = useRef<HTMLInputElement>(null), effectInput = useRef<HTMLInputElement>(null), alive = useRef(true), loadSequence = useRef(0), epoch = useRef(0), restoring = useRef(''), initialSelection = useRef(''), importLock = useRef(false), importQueue = useRef<{files: File[]; role: Role; epoch: number}[]>([]), draftRef = useRef(draft)
  draftRef.current = draft
  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current, value = await loadResourceLibrary(track.id)
    if (!alive.current || sequence !== loadSequence.current) return
    setLibrary(value); setLoading(false); setLoadError('')
  }, [track.id])
  const jobs = useResourceJobs(track.id, library.jobs, refresh)
  useEffect(() => {alive.current = true; return () => {alive.current = false; loadSequence.current++}}, [])
  useEffect(() => {void refresh().catch(error => {if (alive.current) {setLoading(false); setLoadError(errorText(error))}})}, [refresh, reloadToken])
  const loadCatalog = useCallback(async () => {
    const value = await loadImagegenCatalog()
    if (!alive.current) return
    setCatalog(value)
    if (value.defaultModel) setDraft(current => {if (current.model || current.restoredFromJobId) return current; const next = {...current, model: value.defaultModel!, channelId: value.models.find(model => model.id === value.defaultModel)?.channelId, updatedAt: new Date().toISOString()}; if (imageDraftFingerprint(current) === current.baseline) next.baseline = imageDraftFingerprint(next); return next})
  }, [])
  useEffect(() => {void loadCatalog()}, [loadCatalog])
  useEffect(() => {const failure = writeImageDraft(draft); setStorageError(failure || '')}, [draft])
  const configure = (patch: Partial<ResourceImageDraft>) => setDraft(current => ({...current, ...patch, updatedAt: new Date().toISOString()}))
  const replaceDraft = (next: ResourceImageDraft) => {setOptimizer(null); epoch.current++; setDraft(next); setTemplate(undefined); setComparison(false); setCompareId(''); setError('')}
  const applySwitch = (request: SwitchRequest) => {
    if (request.kind === 'restore') {replaceDraft(imageDraftFromJob(track.id, request.value.job, request.value.resultAssetId)); setMobileView(request.value.job.resultAssetIds.length ? 'results' : 'configuration'); setNotice('已恢复历史任务，尚未提交生成。')}
    else if (request.kind === 'backup') {replaceDraft(structuredClone(request.draft)); setNotice('已恢复保留的草稿，尚未提交生成。')}
    else {const next = emptyImageDraft(track.id); next.references = request.references || []; next.model = catalog.defaultModel || ''; next.channelId = catalog.models.find(model => model.id === next.model)?.channelId; if (!next.references.length) next.baseline = imageDraftFingerprint(next); replaceDraft(next); setMobileView('configuration'); setNotice(request.kind === 'initial' ? '已把所选图片加入主体参考组。' : '已开始空白创作。')}
  }
  const requestSwitch = (request: SwitchRequest) => {if (imageDraftDirty(draftRef.current)) setSwitchRequest(request); else applySwitch(request)}
  useEffect(() => {
    if (!restore || loading || restoring.current === restore.token) return
    restoring.current = restore.token
    requestSwitch({kind: 'restore', value: restore})
  }, [restore?.token, loading])
  useEffect(() => {
    if (loading || restore) return
    const key = JSON.stringify({ids: initialAssetIds || [], url: initialAssetUrl || ''})
    if (initialSelection.current === key) return
    initialSelection.current = key
    const assets = [...new Set(initialAssetIds || [])].map(id => library.assets.find(asset => asset.id === id && asset.kind === 'image')).filter((asset): asset is ResourceAsset => !!asset)
    const linked = initialAssetUrl ? library.assets.find(asset => asset.kind === 'image' && (asset.sourceUrl === initialAssetUrl || asset.url === initialAssetUrl)) : undefined
    if (linked && !assets.some(asset => asset.id === linked.id)) assets.push(linked)
    if (!assets.length) {if (initialAssetUrl || initialAssetIds?.length) setError('所选图片尚未登记或已移除，请从资源库重新选择。'); return}
    const references = assets.map(asset => ({assetId: asset.id, role: 'subject' as const, name: asset.name}))
    if (references.every(reference => draftRef.current.references.some(item => item.assetId === reference.assetId && item.role === 'subject'))) return
    requestSwitch({kind: 'initial', references})
  }, [loading, initialAssetUrl, JSON.stringify(initialAssetIds || [])])
  const subjects = draft.references.filter(item => item.role === 'subject'), effects = draft.references.filter(item => item.role === 'effect')
  const missing = draft.references.filter(reference => !library.assets.some(asset => asset.id === reference.assetId && asset.kind === 'image' && asset.status !== 'error'))
  const model = catalog.models.find(item => item.id === draft.model)
  const referenceLimit = model?.maxReferenceImages
  const referenceIssue = model && (referenceLimit === 0 && draft.references.length ? '当前模型仅支持文字生成，请更换模型或移除参考图。'
    : referenceLimit !== undefined && draft.references.length > referenceLimit ? `当前模型最多支持 ${referenceLimit} 张参考图，请调整图片或更换模型。`
      : referenceLimit === undefined && draft.references.length > 1 ? '当前模型尚未确认多参考图能力，请更换已支持的模型或减少为一张。' : '')
  const outputLimit = model?.maxOutputImages || 1
  const settingsIssue = draft.settings.n > outputLimit ? `当前模型最多输出 ${outputLimit} 张，请调整输出张数。` : ''
  const sizeOptions = model?.allowedSizes || IMAGEGEN_RESOURCE_SIZES, qualityOptions = model?.allowedQualities || IMAGEGEN_RESOURCE_QUALITIES
  const unsupportedSettings = model?.allowedSizes && !model.allowedSizes.includes(draft.settings.size) ? '当前模型不支持历史画幅，请调整画幅。' : model?.allowedQualities && !model.allowedQualities.includes(draft.settings.quality) ? '当前模型不支持历史质量档位，请调整质量。' : model?.allowedDetails && !model.allowedDetails.includes(draft.settings.detail) ? '当前模型不支持历史 detail 设置，请恢复自动设置。' : ''
  const channelIssue = draft.channelId && draft.channelId !== 'cqai' && (draft.references.length > 1 || draft.settings.n !== 1 || draft.settings.size !== 'auto' || draft.settings.quality !== 'auto' || !!draft.settings.detail) ? '历史服务配置未确认支持这些参考图或设置，请明确改用当前宿主模型配置。' : ''
  const activeJob = library.jobs.find(job => job.id === draft.activeJobId)
  const resultAssets = activeJob ? activeJob.resultAssetIds.map(id => library.assets.find(asset => asset.id === id)).filter((asset): asset is ResourceAsset => !!asset && asset.kind === 'image') : []
  const selectedResult = resultAssets.find(asset => asset.id === draft.selectedResultId) || resultAssets[0]
  const currentCompareId = subjects.some(reference => reference.assetId === compareId) ? compareId : subjects[0]?.assetId
  const comparisonSource = library.assets.find(asset => asset.id === currentCompareId && asset.status !== 'error')
  const pickerAssets = useMemo(() => library.assets.filter(asset => asset.kind === 'image' && (!pickerSearch.trim() || `${asset.name} ${asset.tags.join(' ')}`.toLocaleLowerCase().includes(pickerSearch.trim().toLocaleLowerCase()))), [library.assets, pickerSearch])
  const inputSummary = subjects.length && effects.length ? `主体 ${subjects.length} 张 · 效果 ${effects.length} 张` : subjects.length ? `主体参考 ${subjects.length} 张` : effects.length ? `效果参考 ${effects.length} 张` : '根据提示词生成'
  const configChanged = !!draft.restoredFromJobId && imageDraftFingerprint(draft) !== draft.baseline
  const optimizationContext = imagePromptContext(track, draft.prompt, grouped(draft.references), library.assets)
  function applyOptimization(value: string, fingerprint: string, attribution?: ImagePromptAttribution) {
    const current = draftRef.current
    if (imagePromptContextFingerprint(imagePromptContext(track, current.prompt, grouped(current.references), library.assets)) !== fingerprint) {setError('提示词或参考素材已经变化，请重新优化后再应用。'); return false}
    configure({prompt: value, presetId: attribution?.templateId, presetVersion: attribution?.templateVersion, promptAttribution: attribution, promptUndo: {prompt: current.prompt, presetId: current.presetId, presetVersion: current.presetVersion, attribution: current.promptAttribution, appliedPrompt: value}})
    setTemplate(undefined); setNotice('优化结果已应用到提示词，尚未生成图片。'); return true
  }
  function undoOptimization() {
    const current = draftRef.current, undo = current.promptUndo; if (!undo) return
    if (current.prompt !== undo.appliedPrompt && !window.confirm('提示词在优化后又有修改。撤销会恢复优化前的完整文本，是否继续？')) return
    configure({prompt: undo.prompt, presetId: undo.presetId, presetVersion: undo.presetVersion, promptAttribution: undo.attribution, promptUndo: undefined}); setTemplate(undefined); setNotice('已恢复优化前的提示词。')
  }

  function appendReferences(assets: ResourceAsset[], role: Role, move = false) {
    setDraft(current => {
      const next = [...current.references]
      for (const asset of assets) {
        const index = next.findIndex(reference => reference.assetId === asset.id)
        if (index >= 0) {if (move) next[index] = {...next[index], role, name: asset.name}; continue}
        next.push({assetId: asset.id, role, name: asset.name})
      }
      return {...current, references: grouped(next), updatedAt: new Date().toISOString()}
    })
  }
  function addReferences(assets: ResourceAsset[], role: Role) {
    if (assets.some(asset => draftRef.current.references.some(reference => reference.assetId === asset.id && reference.role !== role))) setDuplicateRequest({assets, role})
    else appendReferences(assets, role)
  }
  async function importImages(files: File[], role: Role, requestEpoch = epoch.current) {
    if (!files.length) return
    if (importLock.current) {importQueue.current.push({files, role, epoch: requestEpoch}); setNotice(`${roleName[role]}参考图已排队，将在当前导入完成后继续。`); return}
    importLock.current = true; setError(''); const currentEpoch = requestEpoch
    for (const file of files) {
      const id = crypto.randomUUID(), update = (patch: Partial<Upload>) => {if (alive.current) setUploads(previous => previous.map(item => item.id === id ? {...item, ...patch} : item))}
      if (alive.current) setUploads(previous => [...previous, {id, name: file.name, progress: 0, status: 'uploading'}])
      try {
        if (resourceFileType(file).kind !== 'image') throw new Error('参考输入只接受图片，视频和音频请在资源库管理。')
        const asset = await uploadResource(track.id, file, progress => update({progress}))
        update({status: 'saved', progress: 100}); if (!alive.current) continue
        await refresh()
        if (epoch.current === currentEpoch) addReferences([asset], role)
        else setNotice('图片已导入资源库；当前草稿已切换，请重新选择参考图。')
      } catch (error) {update({status: 'error', error: errorText(error)})}
    }
    importLock.current = false
    const queued = importQueue.current.shift(); if (queued) await importImages(queued.files, queued.role, queued.epoch)
  }
  async function run(action: () => Promise<void>) {if (busy) return; setBusy(true); setError(''); try {await action()} catch (error) {if (alive.current) setError(errorText(error))} finally {if (alive.current) setBusy(false)}}
  async function savedResult(asset: ResourceAsset) {
    if (!asset.candidate) return asset
    const saved = await updateResource(track.id, asset.id, {candidate: false})
    if (alive.current) setLibrary(current => ({...current, assets: current.assets.map(item => item.id === saved.id ? saved : item)}))
    return saved
  }
  async function submit() {
    if (missing.length || referenceIssue || settingsIssue || unsupportedSettings || channelIssue || !model) return
    const snapshot = structuredClone(draftRef.current), fingerprint = imageDraftFingerprint(snapshot)
    const references = grouped(snapshot.references).map(reference => ({asset: library.assets.find(asset => asset.id === reference.assetId)!, role: reference.role}))
    const job = await jobs.submit({prompt: snapshot.prompt, model: snapshot.model, channelId: snapshot.channelId || model.channelId, references, settings: snapshot.settings, restoredFromJobId: snapshot.restoredFromJobId, template, presetId: snapshot.presetId, presetVersion: snapshot.presetVersion, allowedSizes: model.allowedSizes, allowedQualities: model.allowedQualities, allowedDetails: model.allowedDetails, maxReferenceImages: model.maxReferenceImages, maxOutputImages: model.maxOutputImages})
    if (job && alive.current) {
      setDraft(current => ({...current, activeJobId: job.id, selectedResultId: undefined, baseline: imageDraftFingerprint(current) === fingerprint ? fingerprint : current.baseline, updatedAt: new Date().toISOString()}))
      setNotice(job.status === 'queued' || job.status === 'running' ? '任务已提交，生成期间可以继续调整草稿。' : '本次任务已保留，可在历史记录中查看。')
    }
  }
  function referenceGroup(role: Role, references: ResourceJobReference[]) {
    return <section className="trk-i-reference-group" aria-label={`${roleName[role]}参考图`} onDragOver={event => event.preventDefault()} onDrop={event => {event.preventDefault(); void importImages(Array.from(event.dataTransfer.files), role)}}><header><h3>{roleName[role]}参考图 <span>{references.length} 张</span></h3><button type="button" disabled={uploads.some(item => item.status === 'uploading')} onClick={() => (role === 'subject' ? subjectInput : effectInput).current?.click()}>上传图片</button></header><p className="trk-i-muted">{role === 'subject' ? '提供人物、景物、装备或构图；第一张为主图。' : '参考色调、光影、质感或画风。'}</p><div className="trk-i-references">{references.map((reference, index) => {
      const asset = library.assets.find(item => item.id === reference.assetId), available = asset && asset.status !== 'error', label = `${roleName[role]}${index + 1}`
      return <article key={reference.assetId} className={`trk-i-reference${available ? '' : ' is-missing'}`}><button type="button" className="trk-i-reference-image" disabled={!available} aria-label={`放大${label}：${asset?.name || reference.name || '缺失图片'}`} onClick={() => asset && setPreviewAsset(asset)}>{available ? <ResourceImageThumbnail asset={asset}/> : <span className="trk-i-missing">参考图已缺失</span>}</button><div className="trk-i-reference-copy"><strong>{label}{role === 'subject' && index === 0 ? ' · 主图' : ''}</strong><span>{asset?.name || reference.name || reference.assetId}</span></div><div className="trk-i-reference-actions"><button type="button" aria-label={`${label}前移`} disabled={!index} onClick={() => configure({references: moveImageReference(draft.references, reference.assetId, -1)})}>↑</button><button type="button" aria-label={`${label}后移`} disabled={index === references.length - 1} onClick={() => configure({references: moveImageReference(draft.references, reference.assetId, 1)})}>↓</button>{role === 'subject' && index > 0 && <button type="button" onClick={() => configure({references: grouped([reference, ...draft.references.filter(item => item.assetId !== reference.assetId)])})}>设为主图</button>}<button type="button" onClick={() => configure({references: grouped(draft.references.map(item => item.assetId === reference.assetId ? {...item, role: role === 'subject' ? 'effect' : 'subject'} : item))})}>移到{role === 'subject' ? '效果' : '主体'}</button><button type="button" aria-label={`移除${label}`} onClick={() => configure({references: draft.references.filter(item => item.assetId !== reference.assetId)})}>移除</button></div></article>
    })}</div><button type="button" className="trk-i-select-library" onClick={() => {setPicker(role); setPickerSearch(''); setPickerIds([])}}>从资源库选择</button><input ref={role === 'subject' ? subjectInput : effectInput} type="file" accept="image/*" multiple hidden disabled={uploads.some(item => item.status === 'uploading')} aria-label={`上传${roleName[role]}参考图`} onChange={event => {void importImages(Array.from(event.target.files || []), role); event.target.value = ''}}/></section>
  }
  return <section className={`trk-i trk-i-view-${mobileView}`} aria-label="AI 图片创作" data-track-image-workspace=""><style>{RESOURCE_IMAGE_WORKSPACE_CSS}</style>
    <header className="trk-i-head"><div><button type="button" className="trk-i-back" onClick={onBack}>← 返回资源库</button><h2>AI 图片创作</h2><p>所属轨迹：<strong>{track.name}</strong></p></div><div className="trk-i-actions"><button type="button" onClick={onHistory}>历史记录</button><button type="button" onClick={() => requestSwitch({kind: 'new'})}>新建创作</button>{hasBackup && <button type="button" onClick={() => {const reserved = readImageDraft(track.id, true); if (reserved) requestSwitch({kind: 'backup', draft: reserved})}}>恢复保留的草稿</button>}</div></header>
    <div className="trk-i-mobile-tabs" role="group" aria-label="创作视图"><button type="button" aria-pressed={mobileView === 'configuration'} onClick={() => setMobileView('configuration')}>创作配置</button><button type="button" aria-pressed={mobileView === 'results'} onClick={() => setMobileView('results')}>生成结果</button></div>
    {loadError && <div className="trk-i-error" role="alert">{loadError}<button onClick={() => {void refresh().catch(error => setLoadError(errorText(error)))}}>重新读取资源</button></div>}{storageError && <p className="trk-i-warning" role="status">{storageError}</p>}{(error || jobs.error) && <p className="trk-i-error" role="alert">{error || jobs.error}</p>}{notice && <div className="trk-i-notice" role="status"><span>{notice}</span>{resultAssets.length > 0 && <button type="button" onClick={() => setMobileView('results')}>查看结果</button>}</div>}
    <div className="trk-i-body"><main className="trk-i-results" aria-label="生成结果预览"><header><strong>{draft.restoredFromJobId && draft.activeJobId === draft.restoredFromJobId ? '历史任务结果' : '生成结果'}</strong>{activeJob && <span role="status">{stateName[activeJob.status]}</span>}</header>{configChanged && <p className="trk-i-warning">配置已修改，再次生成将创建新任务。</p>}{selectedResult && subjects.length > 0 && <div className="trk-i-comparison-controls"><button type="button" aria-pressed={!comparison} onClick={() => setComparison(false)}>结果</button><button type="button" aria-pressed={comparison} onClick={() => setComparison(true)}>对比</button>{comparison && <select aria-label="选择对比主体图" value={currentCompareId || subjects[0].assetId} onChange={event => setCompareId(event.target.value)}>{subjects.map((reference, index) => <option key={reference.assetId} value={reference.assetId}>主体{index + 1} · {library.assets.find(asset => asset.id === reference.assetId)?.name || reference.name || '图片缺失'}</option>)}</select>}</div>}
      <div className="trk-i-stage">{selectedResult ? comparison && subjects.length > 0 && comparisonSource ? <div className="trk-i-compare"><figure><img src={comparisonSource.url} alt="选中的主体参考图"/><figcaption>主体参考</figcaption></figure><figure><img src={selectedResult.url} alt="当前生成结果"/><figcaption>生成结果</figcaption></figure></div> : <button className="trk-i-result-image" type="button" aria-label="放大当前生成结果" onClick={() => setPreviewAsset(selectedResult)}><img src={selectedResult.url} alt="当前生成结果"/></button> : <div className="trk-i-empty"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="6" y="9" width="36" height="30" rx="5"/><circle cx="16" cy="18" r="3"/><path d="m8 35 10-10 7 7 6-6 9 9"/></svg><h3>{activeJob ? stateName[activeJob.status] : '等待生成的图片'}</h3><p>{activeJob?.error || (activeJob?.status === 'completed' ? '结果已移除或尚未保存。可在历史记录中核对任务。' : activeJob ? '任务配置已保存，完成后会显示实际结果。' : '添加参考图或填写提示词，点击生成图片开始创作。')}</p></div>}</div>
      {!!resultAssets.length && <div className="trk-i-result-strip" aria-label="任务生成图片">{resultAssets.map((asset, index) => <button key={asset.id} type="button" aria-label={`选择生成结果${index + 1}`} aria-pressed={selectedResult?.id === asset.id} onClick={() => configure({selectedResultId: asset.id})}><ResourceImageThumbnail asset={asset}/><span>结果{index + 1}</span></button>)}</div>}
      {selectedResult && <><footer className="trk-i-result-actions"><span>{selectedResult.candidate ? '待选结果' : '已保存到资源库'}</span><div className="trk-i-actions"><button type="button" className="trk-primary" disabled={busy || !selectedResult.candidate} onClick={() => void run(async () => {await savedResult(selectedResult); setNotice('所选结果已保存到资源库。')})}>保存到资源库</button>{onUseImage && <button type="button" disabled={busy} onClick={() => void run(async () => {await onUseImage(await savedResult(selectedResult))})}>添加到点位</button>}<button type="button" disabled={busy} onClick={() => void run(async () => {const saved = await savedResult(selectedResult); await updateResource(track.id, saved.id, {videoRole: 'image-insert'}); await refresh(); setNotice('所选结果已加入这条轨迹的视频素材清单。')})}>用于视频</button><a href={selectedResult.url} download={selectedResult.name}>下载</a>{onVideo && selectedResult.videoRole && <button type="button" onClick={onVideo}>进入视频制作</button>}</div></footer><div className="trk-i-result-reference"><p className="trk-i-muted">图片 ID：<code style={{overflowWrap: 'anywhere', whiteSpace: 'normal'}}>{selectedResult.id}</code></p><ImageAgentActions key={track.id + ':' + selectedResult.id} image={{kind: 'resource', trackId: track.id, assetId: selectedResult.id}}/><p className="trk-i-muted">图片引用可供 Agent 手动读取；添加到 Agent 草稿后不会自动发送。</p></div></>}
      {activeJob && <details className="trk-i-task-details"><summary>本次任务配置</summary><p>{activeJob.prompt}</p><span>{activeJob.model} · {new Date(activeJob.createdAt).toLocaleString('zh-CN')}</span>{activeJob.submittedPrompt && activeJob.submittedPrompt !== activeJob.prompt && <details><summary>实际提交提示词</summary><p>{activeJob.submittedPrompt}</p></details>}{activeJob.hostTaskId && <div className="trk-i-actions"><button type="button" onClick={() => {void jobs.sync(activeJob)}}>{activeJob.status === 'completed' && activeJob.resultsPersisted !== true ? '重试保存结果' : '核对任务'}</button>{['queued', 'running', 'unknown'].includes(activeJob.status) && <button type="button" onClick={() => {void jobs.cancel(activeJob)}}>取消任务</button>}</div>}</details>}
    </main><aside className="trk-i-configuration" aria-label="创作配置">{loading && <p role="status">正在读取轨迹素材…</p>}{referenceGroup('subject', subjects)}{referenceGroup('effect', effects)}
      <section className="trk-i-prompt"><h3>提示词</h3><div className="trk-i-actions"><button type="button" onClick={() => setTemplateDialog({tab: 'featured'})}>精选模板</button><button type="button" onClick={() => setTemplateDialog({tab: 'mine'})}>我的模板</button><button type="button" onClick={() => setTemplateDialog({tab: 'reference'})}>参考 e图宝</button></div><p className="trk-i-muted">我的模板默认为空；精选模板已按旅行场景整理，案例图片不加入本次参考。</p><label><span className="trk-i-sr-only">图片创作提示词</span><textarea aria-label="图片创作提示词" rows={7} value={draft.prompt} placeholder="描述画面与修改要求，也可以说明多张图片之间的关系" onChange={event => {configure({prompt: event.target.value, presetId: undefined, presetVersion: undefined}); setTemplate(undefined)}}/></label><div className="trk-i-actions"><button type="button" disabled={!draft.prompt.trim() || loading || uploads.some(item => item.status === 'uploading')} onClick={() => setOptimizer({prompt: draft.prompt, kind: 'refine', attribution: draft.promptAttribution})}>继续调整</button><button type="button" disabled={!draft.prompt.trim()} onClick={() => setTemplateDialog({tab: 'mine', create: true})}>保存为模板</button>{draft.promptUndo && <button type="button" onClick={undoOptimization}>撤销提示词优化</button>}</div>{draft.promptAttribution ? <p className="trk-i-muted">{draft.promptAttribution.adapted ? 'AI 调整自：' : '已使用模板：'}{draft.promptAttribution.name}{draft.promptAttribution.source?.sourceLabel && ` · ${draft.promptAttribution.source.sourceLabel}`}{draft.promptAttribution.source?.sourceUrl && <> · <a href={draft.promptAttribution.source.sourceUrl} target="_blank" rel="noopener noreferrer">原作者</a></>}</p> : template && <p className="trk-i-muted">已使用模板：{template.name}</p>}</section>
      <label className="trk-i-field">宿主模型<select aria-label="AI 创作模型" value={draft.model} disabled={jobs.working} onChange={event => configure({model: event.target.value, channelId: catalog.models.find(model => model.id === event.target.value)?.channelId})}><option value="">请选择宿主模型</option>{draft.model && !model && <option value={draft.model}>历史模型：{draft.model}（当前不可用）</option>}{catalog.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>{catalog.message && <p className="trk-i-muted">{catalog.message}</p>}{model?.capabilityMessage && <p className="trk-i-muted">{model.capabilityMessage}</p>}
      <details className="trk-i-generation-settings"><summary>生成设置</summary><label className="trk-i-field">画幅<select aria-label="图片画幅" value={draft.settings.size} onChange={event => configure({settings: {...draft.settings, size: event.target.value}})}>{!sizeOptions.includes(draft.settings.size) && <option value={draft.settings.size}>历史设置：{draft.settings.size}</option>}{sizeOptions.map(value => <option key={value} value={value}>{value === 'auto' ? '自动' : value}</option>)}</select></label><label className="trk-i-field">质量档位<select aria-label="图片质量档位" value={draft.settings.quality} onChange={event => configure({settings: {...draft.settings, quality: event.target.value}})}>{!qualityOptions.includes(draft.settings.quality) && <option value={draft.settings.quality}>历史设置：{draft.settings.quality}</option>}{qualityOptions.map(value => <option key={value} value={value}>{value === 'auto' ? '自动' : `${value} 档`}</option>)}</select></label><p className="trk-i-muted">沿用宿主的画幅与质量档位，实际输出遵循所选模型。</p><label className="trk-i-field">输出张数<select aria-label="图片输出张数" value={draft.settings.n} onChange={event => configure({settings: {...draft.settings, n: Number(event.target.value)}})}>{draft.settings.n > outputLimit && <option value={draft.settings.n}>历史：{draft.settings.n} 张</option>}{Array.from({length: Math.min(outputLimit, 10)}, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 张</option>)}</select></label>{draft.settings.detail && <p className="trk-i-muted">保留的历史 detail 设置：{draft.settings.detail}</p>}<button type="button" onClick={() => configure({settings: {...IMAGEGEN_RESOURCE_SETTINGS_DEFAULT}})}>恢复自动设置</button></details>
      {!!missing.length && <p className="trk-i-error" role="alert">{missing.length} 张参考图已缺失。请补回图片或明确移除后再生成。</p>}{referenceIssue && <p className="trk-i-error" role="alert">{referenceIssue}</p>}{settingsIssue && <p className="trk-i-error" role="alert">{settingsIssue}</p>}{unsupportedSettings && <p className="trk-i-error" role="alert">{unsupportedSettings}</p>}{channelIssue && <p className="trk-i-error" role="alert">{channelIssue}</p>}{draft.channelId && draft.channelId !== model?.channelId && <p className="trk-i-warning">保留历史服务配置：{draft.channelId}。{model && <button type="button" onClick={() => configure({channelId: model.channelId})}>使用当前宿主模型配置</button>}</p>}{draft.model && !model && <p className="trk-i-warning">原模型当前不可用，请自行选择可用模型。</p>}
      <div className="trk-i-submit"><p>{inputSummary}</p><button type="button" className="trk-primary" disabled={loading || jobs.working || !catalog.available || !model || !draft.prompt.trim() || !!missing.length || !!referenceIssue || !!settingsIssue || !!unsupportedSettings || !!channelIssue || uploads.some(item => item.status === 'uploading')} onClick={() => {void submit()}}>{jobs.working ? '正在提交…' : '生成图片'}</button><span>提交后保存本次输入快照，不会自动替换轨迹照片。</span></div>
    </aside></div>
    {!!uploads.length && <section className="trk-i-uploads" aria-label="参考图导入进度">{uploads.map(item => <div key={item.id}><strong>{item.name}</strong><span>{item.status === 'error' ? item.error : item.status === 'saved' ? '已导入资源库' : item.progress === 100 ? '正在保存…' : `上传 ${item.progress}%`}</span>{item.status === 'uploading' && <progress max={100} value={item.progress}/>}</div>)}<button type="button" disabled={uploads.some(item => item.status === 'uploading')} onClick={() => setUploads([])}>收起导入记录</button></section>}
    {templateDialog && <PromptTemplateLibrary initialTab={templateDialog.tab} initialCreate={templateDialog.create} currentMode={draft.references.length ? 'edit' : 'text'} currentSubjectCount={subjects.length} initialPrompt={draft.prompt} initialSource={draft.promptAttribution?.source} onClose={() => setTemplateDialog(null)} onOptimizeUse={(value, chosenTemplate, origin) => {setOptimizer({prompt: value, kind: 'template', attribution: {name: chosenTemplate?.name || origin?.name || '参考提示词', templateId: chosenTemplate?.id, templateVersion: chosenTemplate?.version, source: chosenTemplate?.source || origin?.source}}); setTemplateDialog(null); return true}} onUse={(value, chosenTemplate, origin) => {if (draft.prompt.trim() && value !== draft.prompt && !window.confirm('用此模板替换当前提示词草稿？')) return false; configure({prompt: value, presetId: chosenTemplate?.id, presetVersion: chosenTemplate?.version, promptUndo: undefined, promptAttribution: chosenTemplate || origin ? {name: chosenTemplate?.name || origin?.name || '参考提示词', templateId: chosenTemplate?.id, templateVersion: chosenTemplate?.version, source: chosenTemplate?.source || origin?.source} : undefined}); setTemplate(chosenTemplate); setTemplateDialog(null); return true}}/>}
    {optimizer && <ImagePromptOptimizer context={optimizationContext} initialPrompt={optimizer.prompt} kind={optimizer.kind} attribution={optimizer.attribution} onClose={() => setOptimizer(null)} onApply={applyOptimization}/>}
    {picker && <ResourceImageModal className="trk-i-picker" labelledBy="trk-i-picker-title" onClose={() => setPicker(null)}><header><h3 id="trk-i-picker-title">选择{roleName[picker]}参考图</h3><button type="button" onClick={() => setPicker(null)}>关闭选择</button></header><input autoFocus aria-label="搜索参考图片" value={pickerSearch} placeholder="搜索图片名称或标签" onChange={event => setPickerSearch(event.target.value)}/><div className="trk-i-picker-grid">{pickerAssets.map(asset => <label key={asset.id} className={pickerIds.includes(asset.id) ? 'is-selected' : ''}><input type="checkbox" aria-label={`选择参考图片：${asset.name}`} checked={pickerIds.includes(asset.id)} onChange={event => setPickerIds(previous => event.target.checked ? [...previous, asset.id] : previous.filter(id => id !== asset.id))}/><ResourceImageThumbnail asset={asset}/><strong>{asset.name}</strong>{draft.references.some(reference => reference.assetId === asset.id) && <span>已用于{roleName[draft.references.find(reference => reference.assetId === asset.id)!.role]}参考</span>}</label>)}</div>{!pickerAssets.length && <p className="trk-i-muted">当前没有可选择的图片，可先上传图片。</p>}<footer><span>已选 {pickerIds.length} 张</span><button type="button" className="trk-primary" disabled={!pickerIds.length} onClick={() => {addReferences(pickerIds.map(id => library.assets.find(asset => asset.id === id)!).filter(Boolean), picker); setPicker(null)}}>添加到{roleName[picker]}参考</button></footer></ResourceImageModal>}
    {duplicateRequest && <ResourceImageModal label="选择参考图用途" onClose={() => setDuplicateRequest(null)}><h3>图片已有参考用途</h3><p>部分图片已在另一组中。同一张图只发送一次，请选择保留原用途或移到{roleName[duplicateRequest.role]}组。</p><div className="trk-i-actions"><button type="button" autoFocus onClick={() => {appendReferences(duplicateRequest.assets, duplicateRequest.role); setDuplicateRequest(null)}}>保留原用途</button><button type="button" className="trk-primary" onClick={() => {appendReferences(duplicateRequest.assets, duplicateRequest.role, true); setDuplicateRequest(null)}}>移到{roleName[duplicateRequest.role]}组</button></div></ResourceImageModal>}
    {switchRequest && <ResourceImageModal labelledBy="trk-i-draft-title" onClose={() => setSwitchRequest(null)}><h3 id="trk-i-draft-title">保留当前创作草稿</h3><p>{switchRequest.kind === 'restore' ? '恢复历史配置前，可以保留当前修改的草稿，之后随时找回。' : switchRequest.kind === 'initial' ? '已有创作草稿。可以继续当前创作，或保留它并使用所选图片新建。' : '当前修改尚未提交。保留后可以从页面顶部找回。'}</p><div className="trk-i-actions"><button type="button" autoFocus onClick={() => setSwitchRequest(null)}>留在当前创作</button><button type="button" className="trk-primary" onClick={() => {const failure = writeImageDraft(draftRef.current, true); if (failure) setStorageError(failure); setHasBackup(true); applySwitch(switchRequest); setSwitchRequest(null)}}>{switchRequest.kind === 'restore' ? '保留草稿并恢复' : switchRequest.kind === 'backup' ? '保留当前并找回草稿' : '保留草稿并新建'}</button></div></ResourceImageModal>}
    {previewAsset && <ResourceImagePreview asset={previewAsset} onClose={() => setPreviewAsset(null)}/>} 
  </section>
}