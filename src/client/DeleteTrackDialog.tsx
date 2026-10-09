import { useEffect, useRef } from 'react'
import type { TrackSummary } from '../protocol.ts'
import { clipTitle } from '../track/title.ts'

export function DeleteTrackDialog({track, busy, error, onCancel, onConfirm, fallbackFocus}: {
  track: TrackSummary
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
  fallbackFocus: HTMLElement | null
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancel.current?.focus()
    return () => {
      const target = previous?.isConnected && previous !== document.body && previous !== document.documentElement ? previous : fallbackFocus
      target?.focus({preventScroll: true})
    }
  }, [fallbackFocus])
  useEffect(() => { if (busy) dialog.current?.focus(); else cancel.current?.focus() }, [busy])

  return <div className="trk-delete-overlay" onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (!busy) onCancel()
    } else if (event.key === 'Tab') {
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const first = buttons[0], last = buttons.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
  }}>
    <div ref={dialog} className="trk-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="trk-delete-title" aria-describedby="trk-delete-description" aria-busy={busy} tabIndex={-1}>
      <h2 id="trk-delete-title">删除轨迹？</h2>
      <p className="trk-delete-name">{clipTitle(track.name, track.filename)}</p>
      <p id="trk-delete-description">应用内的轨迹、标注照片和动画脚本将一并删除，此操作无法撤销。电脑上的原始文件和已导出的文件不会删除。</p>
      {error && <p className="trk-error" role="alert">{error}</p>}
      <div className="trk-delete-actions">
        <button ref={cancel} className="trk-secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button className="trk-danger" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '确认删除'}</button>
      </div>
    </div>
  </div>
}
