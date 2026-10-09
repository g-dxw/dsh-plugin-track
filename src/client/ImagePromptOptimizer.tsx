import {useEffect, useRef, useState} from 'react'
import {IMAGE_PROMPT_LIMITS, IMAGE_PROMPT_TIMEOUT_MS, type ImagePromptModelCatalog, type ImagePromptOptimizationResult} from '../track/image-prompt.ts'
import {loadImagePromptModels, optimizeImagePrompt} from './image-prompt-ai.ts'
import {imagePromptContextFingerprint, type ImagePromptAttribution, type ImagePromptContext} from './image-prompt-context.ts'
import {ResourceImageModal} from './resource-image-media.tsx'

export interface ImagePromptOptimizerProps {
  context: ImagePromptContext
  initialPrompt: string
  kind: 'template' | 'refine'
  attribution?: ImagePromptAttribution
  onClose: () => void
  onApply: (prompt: string, contextFingerprint: string, attribution?: ImagePromptAttribution) => void | boolean
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '提示词优化失败，请重试'
const blankCatalog: ImagePromptModelCatalog = {models: [], defaultModel: null, available: false}

/** Produces a proposal only. Image generation remains a separate explicit action. */
export function ImagePromptOptimizer({context, initialPrompt, kind, attribution, onClose, onApply}: ImagePromptOptimizerProps) {
  const [catalog, setCatalog] = useState<ImagePromptModelCatalog>(blankCatalog), [loading, setLoading] = useState(true), [catalogError, setCatalogError] = useState('')
  const [model, setModel] = useState(''), [basePrompt, setBasePrompt] = useState(initialPrompt), [requirements, setRequirements] = useState('')
  const [result, setResult] = useState<(ImagePromptOptimizationResult & {contextKey: string; requestKey: string}) | null>(null), [proposal, setProposal] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const request = useRef(0), controller = useRef<AbortController | null>(null), alive = useRef(true), latestContext = useRef(context)
  latestContext.current = context
  const contextKey = imagePromptContextFingerprint(context), previousContext = useRef(contextKey)
  const hasImages = context.references.length > 0
  const eligible = catalog.models.filter(item => !hasImages || item.supportsVision)
  const selected = eligible.find(item => item.id === model)
  const missing = context.references.filter(item => item.status === 'missing' || item.status === 'error')
  const inputIssue = missing.length ? `${missing.length} 张参考图已缺失或不可读取，请回到创作页补回或明确移除。` : context.references.length > IMAGE_PROMPT_LIMITS.references ? `提示词优化最多读取 ${IMAGE_PROMPT_LIMITS.references} 张参考图，请回到创作页调整；不会自动省略图片。` : basePrompt.length > IMAGE_PROMPT_LIMITS.prompt ? `待优化提示词最多 ${IMAGE_PROMPT_LIMITS.prompt} 个字符，请先缩短原提示词。` : ''
  const requestKey = JSON.stringify({contextKey, basePrompt, requirements, model})
  const stale = !!result && result.requestKey !== requestKey
  const proposalIssue = proposal.length > IMAGE_PROMPT_LIMITS.prompt ? `优化结果最多 ${IMAGE_PROMPT_LIMITS.prompt} 个字符，请缩短后再应用。` : ''
  function stopElapsedTimer() {if (elapsedTimer.current !== null) clearInterval(elapsedTimer.current); elapsedTimer.current = null}
  function startElapsedTimer(id: number, signal: AbortSignal) {
    stopElapsedTimer(); setElapsedSeconds(0)
    const started = Date.now()
    elapsedTimer.current = setInterval(() => {if (alive.current && id === request.current && !signal.aborted) setElapsedSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)))}, 1000)
  }
  function cancelRequest() {request.current++; controller.current?.abort(); controller.current = null; stopElapsedTimer(); setElapsedSeconds(0); setPending(false)}
  function close() {cancelRequest(); onClose()}
  useEffect(() => {
    const abort = new AbortController(); alive.current = true
    void loadImagePromptModels(abort.signal).then(value => {
      if (!alive.current || abort.signal.aborted) return
      setCatalog(value)
      if (value.defaultModel && value.models.some(item => item.id === value.defaultModel && (!latestContext.current.references.length || item.supportsVision))) setModel(value.defaultModel)
    }).catch(error => {if (alive.current && !abort.signal.aborted) setCatalogError(errorText(error))}).finally(() => {if (alive.current && !abort.signal.aborted) setLoading(false)})
    return () => {alive.current = false; request.current++; abort.abort(); controller.current?.abort(); controller.current = null; stopElapsedTimer()}
  }, [])
  useEffect(() => {
    if (previousContext.current === contextKey) return
    previousContext.current = contextKey
    cancelRequest(); setNotice('当前提示词或参考图已变化，请按当前素材重新优化。')
  }, [contextKey])
  async function optimize() {
    if (pending || inputIssue || !selected || !basePrompt.trim()) return
    const id = ++request.current, abort = new AbortController(), frozenContext = structuredClone(latestContext.current), frozenKey = imagePromptContextFingerprint(frozenContext)
    const snapshot = {model, prompt: basePrompt, requirements, references: frozenContext.references.map(({assetId, role}) => ({assetId, role}))}
    controller.current = abort; startElapsedTimer(id, abort.signal); setPending(true); setError(''); setNotice('')
    try {
      const value = await optimizeImagePrompt(frozenContext.trackId, snapshot, abort.signal)
      if (!alive.current || abort.signal.aborted || id !== request.current) return
      setResult({...value, contextKey: frozenKey, requestKey: JSON.stringify({contextKey: frozenKey, basePrompt: snapshot.prompt, requirements: snapshot.requirements, model: snapshot.model})}); setProposal(value.prompt)
      if (frozenKey !== imagePromptContextFingerprint(latestContext.current)) setNotice('素材已经变化，本次结果仅供预览，请重新优化。')
    } catch (error) {if (alive.current && !abort.signal.aborted && id === request.current) setError(errorText(error))}
    finally {if (alive.current && id === request.current) {stopElapsedTimer(); setPending(false); controller.current = null}}
  }
  function refreshBase() {if (kind === 'refine') setBasePrompt(context.prompt); setResult(null); setProposal(''); setError(''); setNotice('已更新为当前素材，请确认要求后点击优化。')}
  function apply() {
    if (!result || stale || pending || !proposal.trim() || proposalIssue) return
    if (imagePromptContextFingerprint(latestContext.current) !== result.contextKey) {setNotice('草稿已变化，请重新优化后再应用。'); return}
    if (onApply(proposal, result.contextKey, attribution ? {...attribution, adapted: true} : undefined) !== false) close()
  }
  return <ResourceImageModal className="trk-i-optimizer" label={kind === 'template' ? '优化后使用提示词' : '继续调整提示词'} onClose={close}>
    <header><div><h3>{kind === 'template' ? '优化后使用' : '继续调整提示词'}</h3><p className="trk-i-muted">结合轨迹信息{hasImages ? '与参考图内容' : ''}改写提示词，确认应用后更新草稿。</p></div><button type="button" onClick={close}>关闭优化</button></header>
    <section className="trk-i-opt-context" aria-label="本次优化素材"><strong>{context.trackName}</strong><span>{hasImages ? `主体 ${context.references.filter(item => item.role === 'subject').length} 张 · 效果 ${context.references.filter(item => item.role === 'effect').length} 张` : '没有参考图，按轨迹信息与文字优化'}</span>{attribution && <span>基于：{attribution.name}{attribution.source?.sourceLabel ? ` · ${attribution.source.sourceLabel}` : ''}</span>}<div>{context.references.map((item, index) => <span key={item.assetId} className="trk-i-opt-reference">{item.url && item.status !== 'error' && <img src={item.url} alt=""/>}<span>{item.role === 'subject' ? '主体' : '效果'} · {index + 1} · {item.name}</span></span>)}</div></section>
    {inputIssue && <p className="trk-i-error" role="alert">{inputIssue}</p>}{catalogError && <p className="trk-i-error" role="alert">{catalogError}</p>}{catalog.message && <p className="trk-i-muted">{catalog.message}</p>}
    <label className="trk-i-field">{hasImages ? '识图模型' : '文本模型'}<select aria-label="提示词优化模型" value={model} disabled={pending || loading} onChange={event => {setModel(event.target.value); setError('')}}><option value="">{loading ? '正在读取宿主模型…' : hasImages ? '请选择支持识图的模型' : '请选择文本模型'}</option>{model && !selected && <option value={model}>原选择不可用：{model}</option>}{eligible.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    {!loading && !eligible.length && <p className="trk-i-warning" role="status">{hasImages ? '宿主当前没有已确认支持识图的文本模型。请先配置可读取图片的模型。' : '宿主当前没有可用文本模型。'}</p>}
    {pending && <p className="trk-i-warning" role="status" aria-label="提示词优化等待状态"><span>{elapsedSeconds >= 60 ? '提示词优化仍在进行' : '正在读取素材并优化提示词'}</span> · <span aria-live="off">已等待 {elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒` : `${elapsedSeconds} 秒`}</span>。最多等待 {Math.ceil(IMAGE_PROMPT_TIMEOUT_MS / 60_000)} 分钟，可随时取消，原提示词保留。</p>}
    <div className="trk-i-opt-columns"><section><h4>{kind === 'template' ? '原模板提示词' : '当前提示词'}</h4><pre aria-label="优化前提示词">{basePrompt}</pre><label className="trk-i-field">调整要求<textarea aria-label="提示词调整要求" rows={4} maxLength={IMAGE_PROMPT_LIMITS.requirements} value={requirements} disabled={pending} placeholder="例如：保留人物与山脊形态，光线更自然，减少夸张的天空；不要增加画面中没有的建筑" onChange={event => setRequirements(event.target.value)}/></label></section><section><h4>优化结果</h4>{result ? <><label><span className="trk-i-sr-only">优化后的提示词</span><textarea aria-label="优化后的提示词" maxLength={IMAGE_PROMPT_LIMITS.prompt} rows={10} value={proposal} disabled={pending} onChange={event => setProposal(event.target.value)}/></label>{!!result.changes.length && <div className="trk-i-opt-changes"><strong>调整说明</strong><ul>{result.changes.map((change, index) => <li key={index}>{change}</li>)}</ul></div>}</> : <p className="trk-i-opt-empty" role="status">{pending ? '优化结果返回后将在这里展示。' : '点击优化后，在这里预览并修改结果。'}</p>}</section></div>
    {proposalIssue && <p className="trk-i-error" role="alert">{proposalIssue}</p>}{error && <p className="trk-i-error" role="alert">{error}</p>}{(notice || stale) && <p className="trk-i-warning" role="status">{notice || '模型或调整要求已改变，请重新优化后再应用。'}{(!!result && contextKey !== result.contextKey || kind === 'refine' && basePrompt !== context.prompt) && <button type="button" disabled={pending} onClick={refreshBase}>使用当前草稿与素材</button>}</p>}
    <footer><span className="trk-i-muted">应用只修改提示词；模板原文和参考图会保留。</span><div className="trk-i-actions"><button type="button" onClick={close}>取消</button>{pending ? <button type="button" onClick={() => {cancelRequest(); setNotice('已取消本次优化，当前提示词未改动。')}}>取消优化</button> : <button type="button" disabled={loading || !catalog.available || !selected || !basePrompt.trim() || !!inputIssue || kind === 'refine' && basePrompt !== context.prompt} onClick={() => {void optimize()}}>{result ? '重新优化' : '优化提示词'}</button>}<button type="button" className="trk-primary" disabled={!result || pending || stale || !proposal.trim() || !!inputIssue || !!proposalIssue} onClick={apply}>应用到提示词</button></div></footer>
  </ResourceImageModal>
}
