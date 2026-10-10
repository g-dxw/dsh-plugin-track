import { useEffect, useRef, useState } from 'react'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoOriginalUrl } from '../track/placemark-photo-assets.ts'

/** A native top-layer dialog keeps the selected map point visible underneath. */
export type PlacemarkViewerPhoto = {url: string; name: string}
export function PlacemarkPhotoViewer({url, name, trackId, onClose, gallery, selectedIndex, onSelectImage}: {
  url: string; name: string; onClose: () => void; gallery?: readonly PlacemarkViewerPhoto[];
  trackId?: string;
  selectedIndex?: number; onSelectImage?: (index: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [localIndex, setLocalIndex] = useState(selectedIndex ?? 0)
  const photos = gallery?.map(photo => ({...photo, url: imageLink(photo.url)})).filter((photo): photo is PlacemarkViewerPhoto => !!photo.url) ?? []
  const index = photos.length ? Math.max(0, Math.min(selectedIndex ?? localIndex, photos.length - 1)) : 0
  const active = photos[index]
  const safeUrl = active?.url ?? (typeof url === 'string' ? imageLink(url) : null)
  const originalUrl = safeUrl && trackId ? placemarkPhotoOriginalUrl(trackId, safeUrl) : safeUrl
  const title = typeof (active?.name ?? name) === 'string' ? (active?.name ?? name).trim() : ''
  const advance = (step: number) => {
    if (!photos.length) return
    const next = (index + step + photos.length) % photos.length
    setLocalIndex(next); onSelectImage?.(next)
  }

  useEffect(() => {setFailed(false); setAttempt(0)}, [originalUrl, index])
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    try {element.showModal()} catch {element.setAttribute('open', '')}
    return () => {
      if (element.open) {
        if (typeof element.close === 'function') element.close()
        else element.removeAttribute('open')
      }
      if (previous?.isConnected && document.activeElement !== previous) previous.focus({preventScroll: true})
    }
  }, [])

  return <dialog ref={dialog} className="trk-placemark-photo-viewer" aria-label={title ? `${title} · 大图` : '点位图片大图'} onCancel={event => {
    event.preventDefault(); event.stopPropagation(); onClose()
  }} onKeyDown={event => {
    if (!photos.length || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault(); event.stopPropagation(); advance(event.key === 'ArrowLeft' ? -1 : 1)
    dialog.current?.querySelector<HTMLButtonElement>(event.key === 'ArrowLeft' ? '[aria-label="上一张大图"]' : '[aria-label="下一张大图"]')?.focus({preventScroll:true})
  }}>
    <style>{PHOTO_VIEWER_CSS}</style>
    <div className="trk-placemark-photo-viewer-toolbar">
      {title && <span className="trk-placemark-photo-viewer-title">{title}</span>}
      <button className="trk-placemark-photo-viewer-close" type="button" aria-label="关闭大图" onClick={onClose}>×</button>
    </div>
    {!safeUrl ? <p className="trk-placemark-photo-viewer-error" role="alert">图片链接无效</p>
      : failed ? <div className="trk-placemark-photo-viewer-error" role="status">
        <p>图片加载失败</p><button className="trk-placemark-photo-viewer-retry" type="button" onClick={() => {setFailed(false); setAttempt(value => value + 1)}}>重试图片</button>
      </div>
      : <img key={`${originalUrl}:${index}:${attempt}`} className="trk-placemark-photo-viewer-image" src={originalUrl!} alt={title || '点位图片'} decoding="async" referrerPolicy="no-referrer" onError={event => {if (event.currentTarget.isConnected) setFailed(true)}} />}
    {photos.length > 0 && <div className="trk-placemark-photo-viewer-carousel" aria-label="大图轮播">
      <button type="button" aria-label="上一张大图" onClick={()=>advance(-1)}>‹</button><span aria-live="polite">{index+1} / {photos.length}</span><button type="button" aria-label="下一张大图" onClick={()=>advance(1)}>›</button>
    </div>}
  </dialog>
}

const PHOTO_VIEWER_CSS = `
dialog.trk-placemark-photo-viewer{box-sizing:border-box;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0 10px 10px;border:0;background:var(--trk-surface);color:var(--trk-text);overflow:hidden;font:var(--trk-ui-font-size,13px)/1.5 var(--trk-font-family,system-ui,sans-serif)}dialog.trk-placemark-photo-viewer::backdrop{background:var(--trk-shadow)}dialog.trk-placemark-photo-viewer[open]{display:flex;flex-direction:column;gap:8px}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:36px;margin:0 -10px;padding:4px 10px;border-bottom:1px solid var(--trk-border);flex-shrink:0}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-title{margin:0;font-size:13px;overflow-wrap:anywhere}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-close,dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-retry,dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-carousel button{border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:var(--trk-text);min-height:var(--trk-control-height,32px);padding:4px 9px;cursor:pointer;font:inherit}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-close{margin-left:auto;min-width:var(--trk-control-height,32px)}dialog.trk-placemark-photo-viewer button:hover{background:var(--trk-hover)}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-close:focus-visible,dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-retry:focus-visible,dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-carousel button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-image{display:block;flex:1;min-height:0;width:100%;height:calc(100% - 64px);object-fit:contain}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-error{margin:auto;text-align:center;display:grid;gap:8px}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-carousel{display:flex;align-items:center;justify-content:center;gap:10px;flex-shrink:0;padding-top:6px;border-top:1px solid var(--trk-border);font-size:12px}dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-carousel button{min-width:var(--trk-control-height,32px)}
@media(max-width:750px),(pointer:coarse){dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-close,dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-retry,dialog.trk-placemark-photo-viewer .trk-placemark-photo-viewer-carousel button{min-height:44px;min-width:44px}}
`
