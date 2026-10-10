import {createContext, useContext, useEffect, useRef, useState} from 'react'
import type {AgentImageReference, AgentImageReferenceInput, AgentImageReferenceResponse} from '../track/image-agent-references.ts'
import {API} from '../protocol.ts'

/** Supplied by the Track panel using the native Conversation service. */
export const ImageAgentContext = createContext<{available: boolean; trackId?: string | null; addFile(file: File, signal: AbortSignal): Promise<void>}>({
  available: false,
  async addFile() {throw new Error('当前宿主暂不支持添加图片到 Agent，请复制图片引用。')},
})

async function prepareReference(image: AgentImageReferenceInput, signal: AbortSignal): Promise<AgentImageReference> {
  const response = await fetch(`${API}/agent-image-reference`, {method: 'POST', signal,
    headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify(image)})
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('图片引用服务暂未就绪，请稍后重试。')
  const value = await response.json() as AgentImageReferenceResponse & {error?: string}
  if (!response.ok) throw new Error(value.error || '准备图片引用失败')
  const reference = value.reference
  if (!reference || typeof reference.clipboardText !== 'string' || typeof reference.fileUrl !== 'string'
    || !reference.fileUrl.startsWith(`${API}/agent-image-reference-file?`) || typeof reference.name !== 'string') throw new Error('图片引用响应无效')
  const scope = image.trackId ?? null, url = new URL(reference.fileUrl, 'http://localhost')
  if (!reference.source || reference.source.kind !== image.kind || (reference.source.trackId ?? null) !== scope
    || url.searchParams.getAll('trackId').length > 1 || url.searchParams.get('trackId') !== scope) throw new Error('图片引用不属于当前轨迹项目，请重新准备图片引用。')
  return reference
}

/** Clipboard failure keeps the full reference available for manual copying. */
export function ImageAgentActions({image, onAdded}: {image: AgentImageReferenceInput; onAdded?: () => void}) {
  const agent = useContext(ImageAgentContext)
  const scopedImage: AgentImageReferenceInput = image.kind === 'resource' || agent.trackId === undefined ? image : {...image, trackId: agent.trackId}
  const identity = JSON.stringify([scopedImage, agent.trackId ?? null]), currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const resourceMatches = image.kind !== 'resource' || agent.trackId === image.trackId
  const canAdd = agent.available && resourceMatches
  const [busy, setBusy] = useState<'copy' | 'add' | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [manual, setManual] = useState(''), pending = useRef<AbortController | null>(null)
  useEffect(() => {
    setBusy(null); setNotice(''); setError(''); setManual('')
    return () => {pending.current?.abort(); pending.current = null}
  }, [identity])

  async function run(action: 'copy' | 'add') {
    if (pending.current || (action === 'add' && !canAdd)) return
    const controller = new AbortController(), startedIdentity = identity; pending.current = controller
    const stale = () => controller.signal.aborted || currentIdentity.current !== startedIdentity
    setBusy(action); setNotice(''); setError(''); setManual('')
    try {
      const reference = await prepareReference(scopedImage, controller.signal)
      if (stale()) return
      if (action === 'copy') {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用')
          await navigator.clipboard.writeText(reference.clipboardText)
          if (!stale()) setNotice('图片引用已复制，可粘贴到 Agent。')
        } catch {
          if (!stale()) {setManual(reference.clipboardText); setError('无法写入剪贴板，请选择下面的完整引用并复制。')}
        }
      } else {
        const response = await fetch(reference.fileUrl, {signal: controller.signal})
        if (!response.ok) throw new Error('读取引用图片失败，请重新准备图片引用。')
        const blob = await response.blob()
        if (stale()) return
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) throw new Error('此图片格式暂不支持添加到 Agent。')
        await agent.addFile(new File([blob], reference.name, {type: blob.type}), controller.signal)
        if (!stale()) {setNotice('图片已添加到 Agent 草稿，等待你发送。'); onAdded?.()}
      }
    } catch (reason) {
      if (!stale()) setError(reason instanceof Error ? reason.message : '图片引用操作失败，请重试。')
    } finally {
      if (pending.current === controller) {pending.current = null; setBusy(null)}
    }
  }

  return <div className="trk-image-agent-actions">
    <style>{`.trk-image-agent-actions{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;margin:6px 0;font-size:var(--trk-ui-font-size,13px)}.trk-image-agent-actions-buttons{display:flex;flex-wrap:wrap;gap:8px}.trk-image-agent-actions p{margin:0;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.trk-image-agent-actions textarea{box-sizing:border-box;width:100%;min-height:160px;resize:vertical;font:inherit;overflow-wrap:anywhere;white-space:pre-wrap;font-size:var(--trk-ui-label-size,12px);padding:6px 8px;border-radius:var(--trk-radius-sm,5px);border:1px solid var(--trk-border);background:var(--trk-bg);color:var(--trk-text)}.trk-image-agent-actions button{min-height:var(--trk-control-height,32px);padding:5px 9px;font-size:var(--trk-ui-label-size,12px)}.trk-image-agent-actions button:focus-visible,.trk-image-agent-actions textarea:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}@media(pointer:coarse){.trk-image-agent-actions button{min-height:44px}}@container(max-width:760px){.trk-image-agent-actions button{min-height:44px}}`}</style>
    <div className="trk-image-agent-actions-buttons">
      <button type="button" className="trk-secondary" disabled={!!busy} aria-busy={busy === 'copy'} onClick={() => void run('copy')}>{busy === 'copy' ? '准备引用…' : '复制图片引用'}</button>
      <button type="button" className="trk-secondary" disabled={!!busy || !canAdd} aria-busy={busy === 'add'} title={!resourceMatches ? '请先选择这张图片所属的轨迹，再添加到 Agent。' : !agent.available ? '当前宿主暂不支持添加到 Agent，可先复制图片引用。' : '添加到轨迹助手的对话草稿，等待手动发送'} onClick={() => void run('add')}>{busy === 'add' ? '添加中…' : '添加到 Agent'}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="trk-error">{error}</p>}
    {manual && <label>完整图片引用<textarea readOnly aria-label="完整图片引用" value={manual} onFocus={event => event.currentTarget.select()}/></label>}
  </div>
}
