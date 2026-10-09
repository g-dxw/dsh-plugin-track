/** Keep editor history separate from native text undo and other open dialogs. */
export function editorHistoryShortcut(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return null
  const target = isDocumentTarget(event.target) ? document.activeElement : event.target
  if (target instanceof Element && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return null
  if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo'
  return null
}

export function shortcutInsideEditor(event: KeyboardEvent, editor: HTMLElement | null): boolean {
  if (!editor) return false
  const target = isDocumentTarget(event.target) ? document.activeElement : event.target
  return target instanceof Node && editor.contains(target)
}

function isDocumentTarget(target: EventTarget | null): boolean {
  return target === document || target === document.body || target === document.documentElement
}
