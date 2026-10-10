import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ResourcePromptTemplate, ResourcePromptTemplateInput, ResourceTemplateMode, ResourceTemplateSource } from '../track/resource-templates.ts'
import { RESOURCE_TEMPLATE_LIMITS } from '../track/resource-templates.ts'
import { FEATURED_TRAVEL_TEMPLATES, type FeaturedTravelTemplate } from '../track/featured-travel-templates.ts'
import { ImageAgentActions } from './ImageAgentActions.tsx'
import { deleteResourceTemplate, loadResourceTemplates, saveResourceTemplate } from './resource-templates.ts'
import { ETUBAO_TEMPLATE_SOURCES, etubaoTemplateImage, etubaoTemplateInput, loadEtubaoTemplates, type EtubaoTemplateCase } from './etubao-templates.ts'

export interface PromptTemplateLibraryProps {
  onClose: () => void
  /** Only fills the prompt; the caller retains its generation mode and reference image. */
  onUse: (prompt: string, template?: ResourcePromptTemplate, origin?: Pick<ResourcePromptTemplateInput, 'name' | 'source'>) => void | boolean
  onOptimizeUse?: (prompt: string, template?: ResourcePromptTemplate, origin?: Pick<ResourcePromptTemplateInput, 'name' | 'source'>) => void | boolean
  initialSource?: ResourceTemplateSource
  initialPrompt?: string
  initialTab?: 'featured' | 'mine' | 'reference'
  initialCreate?: boolean
  currentMode?: 'edit' | 'text'
  /** Effect references alone do not satisfy photo-based featured templates. */
  currentSubjectCount?: number
}
type Editor = ResourcePromptTemplateInput & {tagText: string}
type TemplateTab = 'featured' | 'mine' | 'reference'
function featuredOrigin(item: FeaturedTravelTemplate): Pick<ResourcePromptTemplateInput, 'name' | 'source'> {return {name: item.name, source: item.source}}
function featuredInput(item: FeaturedTravelTemplate): ResourcePromptTemplateInput {return {name: item.name, prompt: item.prompt, category: item.category, tags: [...item.tags], mode: item.mode, source: item.source}}
const modeLabels: Record<ResourceTemplateMode, string> = {both: '美化 / 生图', edit: '照片美化', text: '提示词生图'}
function message(error: unknown): string {return error instanceof Error ? error.message : '模板操作失败，请重试'}
function matches(query: string, values: string[]): boolean {return !query || values.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())}
function editorFrom(input: ResourcePromptTemplateInput): Editor {return {...input, tagText: (input.tags ?? []).join('、')}}
function TemplateImage({sourceId, item}: {sourceId: string; item: EtubaoTemplateCase}) {
  const [failed, setFailed] = useState(false)
  const url = etubaoTemplateImage(sourceId, item)
  return url && !failed ? <img src={url} loading="lazy" alt={item.title} onError={() => setFailed(true)} />
    : <span className="trk-template-placeholder" aria-hidden="true">提示词案例</span>
}

function FeaturedTemplateImage({item, detail = false, onAdded}: {item: FeaturedTravelTemplate; detail?: boolean; onAdded?: () => void}) {
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0)
  const url = item.preview ? etubaoTemplateImage(item.source.sourceId, item.preview) : undefined
  const src = url && retry ? url + (url.includes('?') ? '&' : '?') + 'retry=' + retry : url
  const picture = url && !failed ? <img className={detail ? 'trk-template-featured-large' : 'trk-template-featured-thumbnail'} src={src} loading="lazy" alt={item.name + ' · 原案例效果参考'} onError={() => setFailed(true)} />
    : <span className={'trk-template-featured-image-fallback' + (detail ? ' is-detail' : '')}><span>{item.preview ? '参考图未能加载，提示词仍可使用。' : '原案例暂无可用参考图，提示词仍可使用。'}</span>{detail && url && <button type="button" className="trk-secondary" onClick={() => {setRetry(value => value + 1); setFailed(false)}}>重试参考图</button>}</span>
  return detail ? <figure className="trk-template-featured-preview">{picture}<figcaption><strong>原案例效果参考</strong><p>{item.preview?.caption || '此原案例暂未提供可用图片，可继续查看与使用提示词。'}</p>{url && <a href={url} target="_blank" rel="noopener noreferrer">查看大图</a>}<p>示例图不会自动添加到主体或效果参考图。图片引用可供 Agent 手动读取；添加到 Agent 草稿后不会自动发送。</p>{url && <ImageAgentActions image={{kind: 'featured', key: item.key}} onAdded={onAdded}/>}</figcaption></figure> : picture
}

/** Packaged travel selections stay separate from personal templates; host libraries load only when opened. */
export function PromptTemplateLibrary(props: PromptTemplateLibraryProps) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId(), pending = useRef(false), personalLoaded = useRef(false)
  const [tab, setTab] = useState<TemplateTab>(props.initialTab ?? 'mine')
  const [templates, setTemplates] = useState<ResourcePromptTemplate[]>([]), [loading, setLoading] = useState(true)
  const [sourceId, setSourceId] = useState<string>(ETUBAO_TEMPLATE_SOURCES[0].id)
  const [referenceLists, setReferenceLists] = useState<Record<string, EtubaoTemplateCase[]>>({})
  const [referenceLoading, setReferenceLoading] = useState(false), [referenceRetry, setReferenceRetry] = useState(0)
  const [search, setSearch] = useState(''), [category, setCategory] = useState('')
  const [selectedId, setSelectedId] = useState(''), [referenceId, setReferenceId] = useState(''), [featuredKey, setFeaturedKey] = useState('')
  const [editor, setEditor] = useState<Editor | null>(() => props.initialCreate ? editorFrom({name: '', prompt: props.initialPrompt ?? '', source: props.initialSource, category: '', tags: [], mode: props.currentMode ?? 'both'}) : null), [error, setError] = useState(''), [referenceError, setReferenceError] = useState('')
  const [busy, setBusy] = useState(false), [deleteId, setDeleteId] = useState('')

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current!
    if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', '')
    element.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {if (element.open && typeof element.close === 'function') element.close(); if (previous?.isConnected) previous.focus()}
  }, [])
  useEffect(() => {
    if (tab !== 'mine' || personalLoaded.current) return
    let active = true
    setLoading(true)
    void loadResourceTemplates().then(items => {if (active) {setTemplates(items); setError(''); personalLoaded.current = true}})
      .catch(error => {if (active) setError(message(error))}).finally(() => {if (active) setLoading(false)})
    return () => {active = false}
  }, [tab])
  useEffect(() => {
    if (tab !== 'reference' || referenceLists[sourceId]) return
    let active = true
    setReferenceLoading(true); setReferenceError('')
    void loadEtubaoTemplates(sourceId).then(items => {if (active) setReferenceLists(previous => ({...previous, [sourceId]: items}))})
      .catch(error => {if (active) setReferenceError(message(error))}).finally(() => {if (active) setReferenceLoading(false)})
    return () => {active = false}
  }, [tab, sourceId, referenceRetry, referenceLists])

  const references = referenceLists[sourceId] ?? []
  const categories = useMemo(() => [...new Set((tab === 'featured' ? FEATURED_TRAVEL_TEMPLATES.map(item => item.category) : tab === 'mine' ? templates.map(item => item.category) : references.map(item => item.categoryZh || item.category)).filter(Boolean))].sort(), [tab, templates, references])
  const visibleFeatured = FEATURED_TRAVEL_TEMPLATES.filter(item => (!category || item.category === category) && matches(search, [item.name, item.prompt, item.category, item.description, item.preview?.caption ?? '', ...item.tags]))
  const featured: FeaturedTravelTemplate | undefined = FEATURED_TRAVEL_TEMPLATES.find(item => item.key === featuredKey)
  const featuredMissingSubject = featured?.mode === 'edit' && props.currentSubjectCount === 0
  const featuredIncompatible = !!featured && !!props.currentMode && featured.mode !== 'both' && featured.mode !== props.currentMode
  const visibleTemplates = templates.filter(item => (!category || item.category === category) && matches(search, [item.name, item.prompt, item.category, ...item.tags]))
  const visibleReferences = references.filter(item => (!category || (item.categoryZh || item.category) === category) && matches(search, [item.title, item.prompt, item.categoryZh, ...item.styles, ...item.scenes]))
  const selected = templates.find(item => item.id === selectedId)
  const reference = references.find(item => item.id === referenceId)
  const incompatible = !!selected && !!props.currentMode && selected.mode !== 'both' && selected.mode !== props.currentMode
  const source = ETUBAO_TEMPLATE_SOURCES.find(source => source.id === sourceId)!

  function changeTab(next: TemplateTab) {setTab(next); setSearch(''); setCategory(''); setEditor(null); setDeleteId(''); setError('')}
  function startNew() {
    setTab('mine'); setDeleteId(''); setError('')
    setEditor(editorFrom({name: '', prompt: props.initialPrompt ?? '', source: props.initialSource, category: '', tags: [], mode: props.currentMode ?? 'both'}))
  }
  function edit(input: ResourcePromptTemplateInput, duplicate = false) {
    setError(''); setDeleteId('')
    setEditor(editorFrom({...input, ...(duplicate ? {id: undefined, name: input.name.slice(0, 94) + '（副本）'} : {})}))
  }
  async function save() {
    if (!editor || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const {tagText, ...input} = editor
      const template = await saveResourceTemplate({...input, tags: [...new Set(tagText.split(/[、,，]/u).map(value => value.trim()).filter(Boolean))]})
      setTemplates(previous => [template, ...previous.filter(item => item.id !== template.id)])
      setSelectedId(template.id); setTab('mine'); setSearch(''); setCategory(''); setEditor(null)
    } catch (error) {setError(message(error))}
    finally {pending.current = false; setBusy(false)}
  }
  async function remove() {
    if (!deleteId || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      await deleteResourceTemplate(deleteId)
      setTemplates(previous => previous.filter(item => item.id !== deleteId)); setDeleteId(''); setSelectedId('')
    } catch (error) {setError(message(error))}
    finally {pending.current = false; setBusy(false)}
  }
  function use(prompt: string, template?: ResourcePromptTemplate, origin?: Pick<ResourcePromptTemplateInput, 'name' | 'source'>) {if ((origin ? props.onUse(prompt, template, origin) : props.onUse(prompt, template)) !== false) props.onClose()}
  function optimize(prompt: string, template?: ResourcePromptTemplate, origin?: Pick<ResourcePromptTemplateInput, 'name' | 'source'>) {if (props.onOptimizeUse?.(prompt, template, origin) !== false) props.onClose()}
  return <dialog ref={dialog} className="trk-template-library" aria-labelledby={title} aria-modal="true" onCancel={event => {event.preventDefault(); if (!busy) props.onClose()}}>
    <style>{TEMPLATE_CSS}</style>
    <header className="trk-template-header"><div><h2 id={title}>提示词模板库</h2><p>选择旅行精选提示词，保存自己的模板，或浏览 e图宝 原始案例。</p></div><button type="button" className="trk-secondary" onClick={props.onClose} disabled={busy} aria-label="关闭提示词模板库">关闭</button></header>
    <div className="trk-template-tabs" role="tablist" aria-label="模板范围">
      <button type="button" role="tab" disabled={busy} aria-selected={tab === 'featured'} className="trk-secondary" onClick={() => changeTab('featured')}>精选模板</button>
      <button type="button" role="tab" disabled={busy} aria-selected={tab === 'mine'} className="trk-secondary" onClick={() => changeTab('mine')}>我的模板{templates.length > 0 ? ' · ' + templates.length : ''}</button>
      <button type="button" role="tab" disabled={busy} aria-selected={tab === 'reference'} className="trk-secondary" onClick={() => changeTab('reference')}>参考 e图宝</button>
    </div>
    {error && <p className="trk-error" role="alert">{error}</p>}
    {editor ? <form className="trk-template-editor" onSubmit={event => {event.preventDefault(); void save()}}>
      <div className="trk-template-editor-heading"><h3>{editor.id ? '编辑模板' : editor.source ? '修改并另存为我的模板' : '新建模板'}</h3><span>保存后可在不同轨迹中使用</span></div>
      <label>模板名称<input autoFocus value={editor.name} maxLength={RESOURCE_TEMPLATE_LIMITS.name} required disabled={busy} placeholder="例如：自然色彩与光线修复" onChange={event => setEditor({...editor, name: event.target.value})} /></label>
      <div className="trk-template-editor-row">
        <label>分类<input value={editor.category ?? ''} maxLength={RESOURCE_TEMPLATE_LIMITS.category} disabled={busy} placeholder="自行填写分类" onChange={event => setEditor({...editor, category: event.target.value})} /></label>
        <label>适用模式<select value={editor.mode ?? 'both'} disabled={busy} onChange={event => setEditor({...editor, mode: event.target.value as ResourceTemplateMode})}><option value="both">美化 / 生图</option><option value="edit">照片美化</option><option value="text">提示词生图</option></select></label>
      </div>
      <label>标签<input value={editor.tagText} disabled={busy} placeholder="用顿号或逗号分隔" onChange={event => setEditor({...editor, tagText: event.target.value})} /></label>
      <label>提示词<textarea aria-label="模板提示词" value={editor.prompt} required maxLength={RESOURCE_TEMPLATE_LIMITS.prompt} disabled={busy} rows={10} placeholder="描述希望保留的内容与需要优化的画面" onChange={event => setEditor({...editor, prompt: event.target.value})} /></label>
      {editor.source && <p className="trk-template-attribution">参考来源：{editor.source.sourceLabel || 'e图宝案例库'}{editor.source.sourceUrl && <> · <a href={editor.source.sourceUrl} target="_blank" rel="noopener noreferrer">查看作者原文</a></>}。保存时保留来源。</p>}
      <footer><button type="button" className="trk-secondary" disabled={busy} onClick={() => setEditor(null)}>取消</button><button type="submit" className="trk-primary" disabled={busy || !editor.name.trim() || !editor.prompt.trim()}>{busy ? '正在保存…' : '保存模板'}</button></footer>
    </form> : <>
      <div className="trk-template-tools">
        {tab === 'reference' && <label>案例来源<select value={sourceId} onChange={event => {setSourceId(event.target.value); setReferenceId(''); setCategory('')}}>{ETUBAO_TEMPLATE_SOURCES.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>}
        <label className="trk-template-search">搜索<input value={search} placeholder="名称、提示词或标签" onChange={event => setSearch(event.target.value)} /></label>
        <label>分类<select aria-label="分类" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部分类</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        {tab === 'mine' && <button type="button" className="trk-primary" onClick={startNew}>新建模板</button>}
      </div>
      {tab === 'featured' && <p className="trk-template-featured-intro">结合 e图宝 案例改写为旅行场景提示词，可直接填入或按当前轨迹与参考图优化。精选内容独立于我的模板，修改后可另存。</p>}
      <div className="trk-template-body">
        <section className="trk-template-list" aria-label={tab === 'featured' ? '精选旅行模板列表' : tab === 'mine' ? '我的模板列表' : 'e图宝案例列表'}>
          {tab === 'featured' ? visibleFeatured.length === 0 ? <p className="trk-template-empty">没有匹配的精选模板，请调整搜索或分类。</p>
            : visibleFeatured.map(item => <button key={item.key} type="button" className="trk-template-card trk-template-featured-card" aria-pressed={featuredKey === item.key} onClick={() => setFeaturedKey(item.key)}><FeaturedTemplateImage key={'card:' + item.key} item={item} /><strong>{item.name}</strong><span>{item.category} · {modeLabels[item.mode]}</span><p>{item.description}</p>{item.tags.length > 0 && <small>{item.tags.join(' · ')}</small>}</button>)
            : tab === 'mine' ? loading ? <p role="status">正在读取模板…</p> : templates.length === 0 ? <div className="trk-template-empty"><h3>还没有自己的模板</h3><p>把常用的美化要求保存为模板，下一次直接套用。</p><button type="button" className="trk-primary" onClick={startNew}>{props.initialPrompt?.trim() ? '保存当前提示词' : '新建第一个模板'}</button><button type="button" className="trk-secondary" onClick={() => changeTab('reference')}>参考 e图宝</button></div>
            : visibleTemplates.length === 0 ? <p className="trk-template-empty">没有匹配的模板，请调整搜索或分类。</p>
              : visibleTemplates.map(item => <button key={item.id} type="button" className="trk-template-card" aria-pressed={selectedId === item.id} onClick={() => {setSelectedId(item.id); setDeleteId('')}}><strong>{item.name}</strong><span>{item.category || '未分类'} · {modeLabels[item.mode]}</span><p>{item.prompt}</p>{item.tags.length > 0 && <small>{item.tags.join(' · ')}</small>}</button>)
            : referenceLoading ? <p role="status">正在读取 e图宝 案例…</p> : referenceError ? <div className="trk-template-empty"><p role="alert">{referenceError}</p><button type="button" className="trk-secondary" onClick={() => setReferenceRetry(value => value + 1)}>重试读取</button></div>
              : visibleReferences.length === 0 ? <p className="trk-template-empty">没有匹配的案例，请调整搜索或分类。</p>
                : visibleReferences.map(item => <button key={item.id} type="button" className="trk-template-card trk-template-reference-card" aria-pressed={referenceId === item.id} onClick={() => setReferenceId(item.id)}><TemplateImage key={sourceId + ':' + item.id} sourceId={sourceId} item={item} /><strong>{item.title}</strong><span>{item.categoryZh || item.category}</span><small>{item.sourceLabel || source.label}</small></button>)}
        </section>
        <aside className="trk-template-preview" aria-label="模板详情">
          {tab === 'featured' && featured ? <>
            <span className="trk-template-eyebrow">精选旅行模板 · 场景改写</span><h3>{featured.name}</h3><p className="trk-template-meta">{featured.category} · {modeLabels[featured.mode]}</p><p className="trk-template-featured-description">{featured.description}</p><FeaturedTemplateImage key={'detail:' + featured.key} item={featured} detail onAdded={props.onClose} /><pre>{featured.prompt}</pre>
            <p className="trk-template-notice"><strong>参考图建议：</strong>{featured.referenceAdvice}</p>
            <p className="trk-template-attribution">旅行场景改写，提示词已作调整。参考来源：{featured.source.sourceLabel}{featured.source.sourceUrl && <> · <a href={featured.source.sourceUrl} target="_blank" rel="noopener noreferrer">作者原文</a></>}{featured.source.homepage && <> · <a href={featured.source.homepage} target="_blank" rel="noopener noreferrer">案例来源</a></>}{featured.sources?.filter(item => item.caseId !== featured.source.caseId || item.sourceId !== featured.source.sourceId).map(item => <span key={item.sourceId + ':' + item.caseId}> · {item.sourceLabel}{item.sourceUrl && <> <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">参考案例</a></>}</span>)}</p>
            {featuredMissingSubject ? <p className="trk-template-notice" role="status">请添加主体参考图后原样填入；效果参考图不能代替主体照片。也可选择“优化后使用”，明确将照片美化模板转换为文字创作要求。</p> : featuredIncompatible && <p className="trk-template-notice" role="status">该模板适用于{modeLabels[featured.mode]}。可调整参考图后原样填入，或按当前素材优化后使用。</p>}
            <div className="trk-template-actions"><button type="button" className="trk-primary" disabled={featuredIncompatible || featuredMissingSubject} onClick={() => use(featured.prompt, undefined, featuredOrigin(featured))}>填入提示词</button>{props.onOptimizeUse && <button type="button" className="trk-secondary" onClick={() => optimize(featured.prompt, undefined, featuredOrigin(featured))}>优化后使用</button>}<button type="button" className="trk-secondary" onClick={() => edit(featuredInput(featured))}>修改并另存</button></div>
            <p className="trk-template-meta">填入提示词会保留工作台当前参考图；优化后使用会结合当前轨迹和主体、效果参考图改写。精选模板不会自动加入我的模板。</p>
          </> : tab === 'mine' && selected ? <>
            <span className="trk-template-eyebrow">我的模板 · v{selected.version}</span><h3>{selected.name}</h3><p className="trk-template-meta">{selected.category || '未分类'} · {modeLabels[selected.mode]}</p><pre>{selected.prompt}</pre>
            {selected.source && <p className="trk-template-attribution">参考来源：{selected.source.sourceLabel || 'e图宝案例库'}{selected.source.sourceUrl && <> · <a href={selected.source.sourceUrl} target="_blank" rel="noopener noreferrer">原作者</a></>}</p>}
            {incompatible && <p className="trk-template-notice" role="status">该模板适用于{modeLabels[selected.mode]}。可调整参考图后原样填入，或按当前素材优化后使用。</p>}
            {deleteId === selected.id ? <div className="trk-template-delete"><p>删除「{selected.name}」？已生成的图片会保留。</p><button type="button" className="trk-secondary" onClick={() => setDeleteId('')} disabled={busy}>取消</button><button type="button" className="trk-secondary trk-delete" onClick={() => void remove()} disabled={busy}>{busy ? '正在删除…' : '确认删除'}</button></div> : <div className="trk-template-actions"><button type="button" className="trk-primary" disabled={incompatible} onClick={() => use(selected.prompt, selected)}>填入提示词</button>{props.onOptimizeUse && <button type="button" className="trk-secondary" onClick={() => optimize(selected.prompt, selected)}>优化后使用</button>}<button type="button" className="trk-secondary" onClick={() => edit(selected)}>编辑</button><button type="button" className="trk-secondary" onClick={() => edit(selected, true)}>复制</button><button type="button" className="trk-secondary trk-delete" onClick={() => setDeleteId(selected.id)}>删除</button></div>}
          </> : tab === 'reference' && reference ? <>
            <span className="trk-template-eyebrow">{source.label}</span><h3>{reference.title}</h3><TemplateImage key={'preview:' + sourceId + ':' + reference.id} sourceId={sourceId} item={reference} />{etubaoTemplateImage(sourceId, reference) && <><ImageAgentActions key={'template:' + sourceId + ':' + reference.id} image={{kind: 'template', sourceId, caseId: reference.id, image: reference.image}} onAdded={props.onClose}/><p className="trk-template-meta">图片引用可供 Agent 手动读取；添加到 Agent 草稿后不会自动发送，也不会加入本次生成参考图。</p></>}<pre>{reference.prompt}</pre>
            <p className="trk-template-attribution">{reference.sourceLabel || source.label}{reference.sourceUrl && <> · <a href={reference.sourceUrl} target="_blank" rel="noopener noreferrer">作者原文</a></>} · <a href={source.homepage} target="_blank" rel="noopener noreferrer">案例来源</a></p>
            <div className="trk-template-actions"><button type="button" className="trk-primary" onClick={() => edit(etubaoTemplateInput(sourceId, reference))}>修改并另存</button><button type="button" className="trk-secondary" onClick={() => use(reference.prompt, undefined, etubaoTemplateInput(sourceId, reference))}>仅填入提示词</button>{props.onOptimizeUse && <button type="button" className="trk-secondary" onClick={() => optimize(reference.prompt, undefined, etubaoTemplateInput(sourceId, reference))}>优化后使用</button>}</div>
            <p className="trk-template-meta">仅填入提示词会保留当前参考图；优化后使用会读取工作台的主体和效果参考图。案例图可单独复制引用或添加到 Agent，不会自动用于本次生成。</p>
          </> : <div className="trk-template-empty"><h3>选择一个模板</h3><p>{tab === 'featured' ? '查看旅行场景提示词、参考图建议与原始案例来源，再填入或优化后使用。' : tab === 'mine' ? '查看完整提示词，修改后再用于图片美化或生图。' : '先查看案例与来源，再按自己的轨迹素材修改提示词。'}</p></div>}
        </aside>
      </div>
    </>}
  </dialog>
}

const TEMPLATE_CSS = `
.trk-template-library{box-sizing:border-box;width:min(1100px,calc(100vw - 40px));max-height:calc(100dvh - 40px);padding:14px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);background:var(--trk-surface);color:var(--trk-text);font:inherit;overflow:auto;font-size:var(--trk-ui-font-size,13px)}
.trk-template-library::backdrop{background:color-mix(in srgb,var(--trk-text) 30%,transparent)}
.trk-template-library button,.trk-template-library input,.trk-template-library select,.trk-template-library textarea{font:inherit;box-sizing:border-box;padding:4px 7px;min-height:var(--trk-input-height,30px);font-size:var(--trk-ui-label-size,12px)}
.trk-template-library button{min-height:var(--trk-control-height,32px);padding:5px 9px;font-size:var(--trk-ui-label-size,12px)}.trk-template-library button:focus-visible,.trk-template-library input:focus-visible,.trk-template-library select:focus-visible,.trk-template-library textarea:focus-visible,.trk-template-library a:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-template-library input,.trk-template-library select,.trk-template-library textarea{width:100%;padding:9px 10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:var(--trk-text)}
.trk-template-library input::placeholder,.trk-template-library textarea::placeholder{color:var(--trk-muted)}
.trk-template-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.trk-template-header h2{margin:0;font-size:16px}.trk-template-header p{margin:6px 0 0;color:var(--trk-muted);font-size:var(--trk-ui-label-size,12px);line-height:1.5}
.trk-template-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 8px;border-bottom:1px solid var(--trk-border);padding-bottom:8px}.trk-template-tabs [aria-selected=true]{background:var(--trk-active);border-color:var(--trk-accent)}
.trk-template-tools{display:flex;align-items:flex-end;gap:8px;margin-bottom:10px;flex-wrap:wrap}.trk-template-tools label{display:grid;gap:6px;font-size:var(--trk-ui-label-size,12px);color:var(--trk-muted);min-width:140px}.trk-template-tools .trk-template-search{flex:1}
.trk-template-body{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,1fr);gap:12px;min-height:380px}
.trk-template-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));grid-auto-rows:max-content;gap:8px;align-content:start;align-items:start;max-height:52dvh;overflow:auto;padding:2px}.trk-template-list>p,.trk-template-list>.trk-template-empty{grid-column:1/-1}
.trk-template-card{padding:10px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;min-width:0;background:var(--trk-bg);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);color:var(--trk-text);cursor:pointer}
.trk-template-library .trk-template-card{height:auto;min-height:max-content;align-self:start}.trk-template-card>*{flex-shrink:0}
.trk-template-card:hover{background:var(--trk-hover)}.trk-template-card[aria-pressed=true]{border-color:var(--trk-accent);box-shadow:inset 0 0 0 1px var(--trk-accent)}.trk-template-card strong{font-size:1em;overflow-wrap:anywhere}.trk-template-card span,.trk-template-card small{font-size:var(--trk-ui-label-size,12px);color:var(--trk-muted)}.trk-template-card p{font-size:var(--trk-ui-label-size,12px);line-height:1.6;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
 .trk-template-featured-card p{display:block;overflow:visible;-webkit-line-clamp:unset}.trk-template-featured-thumbnail{display:block;width:100%;height:160px;object-fit:contain;background:var(--trk-hover);border-radius:var(--trk-radius-sm)}.trk-template-featured-preview{margin:14px 0}.trk-template-featured-large{display:block;width:100%;height:auto;max-height:320px;object-fit:contain;background:var(--trk-hover);border-radius:var(--trk-radius-sm)}.trk-template-featured-preview figcaption{font-size:var(--trk-ui-label-size,12px);line-height:1.6;color:var(--trk-muted);margin-top:8px;overflow-wrap:anywhere}.trk-template-featured-preview figcaption p{margin:4px 0 8px}.trk-template-featured-preview figcaption a{color:var(--trk-accent)}.trk-template-featured-image-fallback{display:flex;width:100%;min-height:160px;box-sizing:border-box;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:16px;text-align:center;white-space:normal;font-size:var(--trk-ui-label-size,12px);line-height:1.6;background:var(--trk-hover);border-radius:var(--trk-radius-sm)}.trk-template-featured-image-fallback.is-detail{min-height:180px}.trk-template-featured-intro,.trk-template-featured-description{font-size:var(--trk-ui-label-size,12px);line-height:1.65;overflow-wrap:anywhere}.trk-template-featured-intro{color:var(--trk-muted);margin:0 0 16px}.trk-template-notice strong{font-weight:600}
.trk-template-reference-card{padding:0 0 12px;overflow:hidden}.trk-template-reference-card strong,.trk-template-reference-card span,.trk-template-reference-card small{padding:0 12px}.trk-template-reference-card img,.trk-template-placeholder{height:136px;width:100%;object-fit:cover;background:var(--trk-hover)}.trk-template-placeholder{display:flex;align-items:center;justify-content:center}
.trk-template-preview{border-left:1px solid var(--trk-border);padding-left:22px;min-width:0;max-height:52dvh;overflow:auto}.trk-template-preview h3{margin:8px 0;line-height:1.5}.trk-template-preview>img{width:100%;max-height:220px;object-fit:contain;border-radius:var(--trk-radius-sm)}.trk-template-preview pre{font:inherit;font-size:var(--trk-ui-label-size,12px);line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--trk-bg);border:1px solid var(--trk-border);padding:14px;border-radius:var(--trk-radius-sm)}
.trk-template-eyebrow,.trk-template-meta,.trk-template-attribution{color:var(--trk-muted);font-size:var(--trk-ui-label-size,12px);line-height:1.6}.trk-template-attribution a{color:var(--trk-accent)}.trk-template-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.trk-template-empty{padding:40px 18px;text-align:center;color:var(--trk-muted);line-height:1.6}.trk-template-empty h3{color:var(--trk-text);margin:0 0 8px}.trk-template-empty p{margin:0 0 16px}.trk-template-empty button{margin:4px}
.trk-template-notice,.trk-template-delete{padding:12px;background:var(--trk-notice-bg);border:1px solid var(--trk-notice-border);border-radius:var(--trk-radius-sm);font-size:var(--trk-ui-label-size,12px);line-height:1.6}.trk-template-delete button{margin-right:8px}
.trk-template-editor{display:grid;gap:16px;max-width:800px;margin:0 auto}.trk-template-editor label{display:grid;gap:7px;font-size:var(--trk-ui-label-size,12px)}.trk-template-editor-heading h3{margin:0 0 4px}.trk-template-editor-heading span{color:var(--trk-muted);font-size:var(--trk-ui-label-size,12px)}.trk-template-editor-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.trk-template-editor textarea{resize:vertical;line-height:1.65;min-height:180px}.trk-template-editor footer{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:760px){.trk-template-library{width:calc(100vw - 20px);padding:16px;max-height:calc(100dvh - 20px)}.trk-template-body{grid-template-columns:1fr;min-height:0}.trk-template-list{max-height:40dvh}.trk-template-preview{padding:16px 0 0;border-left:0;border-top:1px solid var(--trk-border);max-height:none}.trk-template-tools label{flex:1;min-width:120px}.trk-template-editor-row{grid-template-columns:1fr}}

@media(max-width:760px){.trk-template-library button{min-height:44px}.trk-template-library input,.trk-template-library select{min-height:40px}.trk-template-tabs{gap:8px}}
@media(pointer:coarse){.trk-template-library button{min-height:44px}.trk-template-library input,.trk-template-library select{min-height:40px}.trk-template-tabs{gap:8px}}
`
