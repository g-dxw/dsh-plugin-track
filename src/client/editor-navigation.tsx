import {useCallback, useEffect, useId, useRef, useState, type ReactNode} from 'react'

export interface EditorNavigationHandle {requestLeave: (next: () => void) => void; busy: boolean}
export interface EditorNavigationOptions {
  active: boolean
  dirty: boolean
  busy: boolean
  save: () => Promise<boolean>
  discard: () => void
  onRegister?: (handle: EditorNavigationHandle | null) => void
}

const DIALOG_CSS = `.trk-editor-leave-mask{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:var(--trk-backdrop,rgba(0,0,0,.45))}.trk-editor-leave-dialog{box-sizing:border-box;width:min(460px,100%);padding:20px;background:var(--trk-surface);color:var(--trk-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);box-shadow:0 12px 36px rgba(0,0,0,.2);font:inherit}.trk-editor-leave-dialog h3{margin:0 0 10px;font:inherit;font-weight:600}.trk-editor-leave-dialog p{margin:0 0 16px;line-height:1.6}.trk-editor-leave-actions{display:flex;gap:8px;flex-wrap:wrap}.trk-editor-leave-actions button{min-height:44px;padding:8px 12px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);font:inherit;background:var(--trk-surface);color:var(--trk-text);cursor:pointer}.trk-editor-leave-actions button:hover:not(:disabled){background:var(--trk-hover)}.trk-editor-leave-actions .is-primary{background:var(--trk-primary-bg);border-color:var(--trk-primary-bg);color:var(--trk-on-accent)}.trk-editor-leave-actions .is-discard{color:var(--trk-danger)}.trk-editor-leave-actions button:disabled{opacity:.5;cursor:default}.trk-editor-leave-dialog:focus,.trk-editor-leave-actions button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-editor-leave-error{color:var(--trk-danger)}`

export interface EditorConfirmationDialogProps {title: ReactNode; description: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; busy?: boolean}

/** Mount for a separate action confirmation; dismissing restores its trigger focus. */
export function EditorConfirmationDialog({title, description, confirmLabel, onConfirm, onCancel, busy = false}: EditorConfirmationDialogProps) {
  const root = useRef<HTMLElement>(null), trigger = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const titleId = useId(), descriptionId = useId()
  useEffect(() => () => {if (trigger.current?.isConnected) trigger.current.focus()}, [])
  useEffect(() => {if (busy) root.current?.focus(); else root.current?.querySelector<HTMLButtonElement>('button')?.focus()}, [busy])
  return <div className="trk-editor-leave-mask"><style>{DIALOG_CSS}</style>
    <section ref={root} className="trk-editor-leave-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') {event.preventDefault(); if (!busy) onCancel()}
      if (event.key !== 'Tab') return
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const first = buttons[0], last = buttons.at(-1)
      if (!first) {event.preventDefault(); root.current?.focus()}
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {event.preventDefault(); last?.focus()}
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) {event.preventDefault(); first.focus()}
    }}>
      <h3 id={titleId}>{title}</h3><p id={descriptionId}>{description}</p>
      <div className="trk-editor-leave-actions"><button type="button" className="is-discard" disabled={busy} onClick={onConfirm}>{confirmLabel}</button><button type="button" disabled={busy} onClick={onCancel}>取消</button></div>
    </section>
  </div>
}

/** Keep the destination pending until the user explicitly saves or abandons the draft. */
export function useEditorNavigation(options: EditorNavigationOptions): {requestLeave: EditorNavigationHandle['requestLeave']; dialog: ReactNode} {
  const latest = useRef(options); latest.current = options
  const pending = useRef<(() => void) | null>(null), processing = useRef(false), alive = useRef(true)
  const trigger = useRef<HTMLElement | null>(null), dialogRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const titleId = useId(), descriptionId = useId()
  const busy = options.busy || saving
  const requestLeave = useCallback((next: () => void) => {
    const current = latest.current
    if (!current.active || current.busy || processing.current || pending.current) return
    if (!current.dirty) {next(); return}
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    pending.current = next; setError(''); setOpen(true)
  }, [])

  useEffect(() => {alive.current = true; return () => {alive.current = false; pending.current = null}}, [])
  useEffect(() => {
    if (!options.active) {pending.current = null; setOpen(false); setError('')}
  }, [options.active])
  useEffect(() => {
    if (!options.active || !options.onRegister) return
    options.onRegister({requestLeave, busy})
    return () => options.onRegister?.(null)
  }, [options.active, options.onRegister, requestLeave, busy])
  useEffect(() => {
    if (!open) return
    const root = dialogRef.current
    if (busy) root?.focus()
    else root?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open, busy])

  function close(restoreFocus: boolean) {
    pending.current = null; setOpen(false); setError('')
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus()
  }
  async function saveAndLeave() {
    if (latest.current.busy || processing.current || !pending.current) return
    processing.current = true; setSaving(true); setError('')
    try {
      const saved = await latest.current.save()
      if (!alive.current || !latest.current.active) return
      if (!saved) {setError('保存未完成，当前修改已保留。请检查错误后重试。'); return}
      const next = pending.current; close(false); next?.()
    } catch (reason) {
      if (alive.current && latest.current.active) setError(reason instanceof Error ? reason.message : '保存失败，当前修改已保留。')
    } finally {
      processing.current = false; if (alive.current) setSaving(false)
    }
  }
  function discardAndLeave() {
    if (latest.current.busy || processing.current || !pending.current) return
    try {latest.current.discard(); const next = pending.current; close(false); next?.()}
    catch (reason) {setError(reason instanceof Error ? reason.message : '无法放弃当前修改。')}
  }
  const dialog = open && options.active ? <div className="trk-editor-leave-mask">
    <style>{DIALOG_CSS}</style>
    <section ref={dialogRef} className="trk-editor-leave-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); if (!busy) close(true)}
      if (event.key !== 'Tab') return
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const first = buttons[0], last = buttons.at(-1)
      if (!first) {event.preventDefault(); dialogRef.current?.focus()}
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {event.preventDefault(); last?.focus()}
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {event.preventDefault(); first.focus()}
    }}>
      <h3 id={titleId}>保存当前修改后离开？</h3>
      <p id={descriptionId}>当前工作区有未保存修改，离开前请选择如何处理。</p>
      {error && <p className="trk-editor-leave-error" role="alert">{error}</p>}
      <div className="trk-editor-leave-actions">
        <button type="button" className="is-primary" disabled={busy} onClick={() => void saveAndLeave()}>{saving ? '正在保存…' : '保存后继续'}</button>
        <button type="button" className="is-discard" disabled={busy} onClick={discardAndLeave}>放弃本次修改</button>
        <button type="button" disabled={busy} onClick={() => close(true)}>取消</button>
      </div>
    </section>
  </div> : null
  return {requestLeave, dialog}
}
