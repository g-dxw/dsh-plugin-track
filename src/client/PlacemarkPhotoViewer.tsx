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
