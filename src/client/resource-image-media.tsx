import {useEffect, useRef, useState, type ReactNode} from 'react'
import type {ResourceAsset} from '../track/resources.ts'
import {prepareResourcePreview, resourceThumbnail} from './resources-api.ts'

export function ResourceImageThumbnail({asset, alt = ''}: {asset: ResourceAsset; alt?: string}) {
  const node = useRef<HTMLSpanElement>(null), [ready, setReady] = useState(!asset.sourceUrl), [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    if (!asset.sourceUrl) {setReady(true); return () => {active = false}}
    const prepare = () => {void prepareResourcePreview(asset).then(() => {if (active) setReady(true)}).catch(() => {if (active) setFailed(true)})}
    if (!node.current || typeof IntersectionObserver === 'undefined') {prepare(); return () => {active = false}}
    const observer = new IntersectionObserver(entries => {if (entries.some(item => item.isIntersecting)) {observer.disconnect(); prepare()}}, {rootMargin: '100px'})
    observer.observe(node.current); return () => {active = false; observer.disconnect()}
  }, [asset.id, asset.sourceUrl])
  return <span ref={node} className="trk-i-thumb">{ready && !failed ? <img src={resourceThumbnail(asset)} alt={alt} loading="lazy" onError={() => setFailed(true)}/> : <span>{failed ? '图片暂不可用' : '准备缩略图…'}</span>}</span>
}
export function ResourceImagePreview({asset, onClose}: {asset: ResourceAsset; onClose: () => void}) {
  const previousFocus = useRef(document.activeElement), [failed, setFailed] = useState(false)
  useEffect(() => () => {const previous = previousFocus.current as HTMLElement | null; if (previous?.isConnected) previous.focus()}, [])
  return <div className="trk-i-mask" onClick={event => {if (event.target === event.currentTarget) onClose()}}><section className="trk-i-lightbox" role="dialog" aria-modal="true" aria-label={`放大查看：${asset.name}`} onKeyDown={event => {if (event.key === 'Escape') onClose(); if (event.key === 'Tab') {event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus()}}}><header><strong>{asset.name}</strong><button type="button" autoFocus onClick={onClose}>关闭预览</button></header>{failed ? <p role="alert">图片暂时无法读取。</p> : <img src={asset.url} alt={asset.name} onError={() => setFailed(true)}/>}</section></div>
}
export function ResourceImageModal({children, onClose, className = 'trk-i-dialog', label, labelledBy}: {children: ReactNode; onClose: () => void; className?: string; label?: string; labelledBy?: string}) {
  const previous = useRef(document.activeElement), node = useRef<HTMLElement>(null)
  useEffect(() => {
    if (node.current && !node.current.contains(document.activeElement)) node.current.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')?.focus()
    return () => {const target = previous.current as HTMLElement | null; if (target?.isConnected) target.focus()}
  }, [])
  return <div className="trk-i-mask"><section ref={node} className={className} role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy} onKeyDown={event => {
    if (event.key === 'Escape') {event.preventDefault(); onClose(); return}
    if (event.key !== 'Tab') return
    const fields = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    const first = fields[0], last = fields.at(-1)
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {event.preventDefault(); last?.focus()}
    else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {event.preventDefault(); first?.focus()}
  }}>{children}</section></div>
}