import {observeTrackTheme} from './theme.ts'

const boardOrigin = (frame: HTMLIFrameElement) => /^http:\/\/127\.0\.0\.1:\d+\/p\//u.test(frame.src) ? new URL(frame.src).origin : null

/** Only appearance crosses the iframe boundary; project files stay native. */
export function syncOpenMontageBoardTheme(frame: HTMLIFrameElement, scope: HTMLElement): void {
  const origin = boardOrigin(frame)
  const view = scope.ownerDocument.defaultView
  if (!origin || !view || !frame.contentWindow) return
  const probe = scope.ownerDocument.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;background:var(--trk-bg,Canvas)'
  probe.setAttribute('aria-hidden', 'true')
  scope.appendChild(probe)
  try {
    const background = view.getComputedStyle(probe).backgroundColor
    const channels = background.replace(/^color\([^ ]+\s+/u, '')
    const colors = channels.match(/[\d.]+/gu)?.map(Number)
    if (colors && /^color\(/u.test(background)) {for (let i = 0; i < 3; i++) colors[i] = (colors[i] || 0) * 255}
    else if (colors && background.includes('%')) {for (let i = 0; i < 3; i++) colors[i] = (colors[i] || 0) * 2.55}
    const scheme = view.getComputedStyle(scope).colorScheme
    const theme = colors && colors.length >= 3 ? (colors[0]! * .2126 + colors[1]! * .7152 + colors[2]! * .0722 < 128 ? 'dark' : 'light') : scheme === 'dark' ? 'dark' : 'light'
    frame.contentWindow.postMessage({type: 'track-openmontage-theme', theme}, origin)
  } finally {probe.remove()}
}

export function observeOpenMontageBoardTheme(frame: HTMLIFrameElement, scope: HTMLElement): () => void {
  syncOpenMontageBoardTheme(frame, scope)
  return observeTrackTheme(scope, () => syncOpenMontageBoardTheme(frame, scope))
}

/** A hidden preview pauses its media; revealing it never starts playback. */
export function syncOpenMontageBoardVisibility(frame: HTMLIFrameElement): void {
  const origin = boardOrigin(frame), board = frame.closest('.trk-om-board'), view = frame.ownerDocument.defaultView
  if (!origin || !board || !view || !frame.contentWindow) return
  frame.contentWindow.postMessage({type: 'track-openmontage-visibility', visible: view.getComputedStyle(board).display !== 'none'}, origin)
}

export function observeOpenMontageBoardVisibility(frame: HTMLIFrameElement): () => void {
  const board = frame.closest('.trk-om-board'), view = frame.ownerDocument.defaultView
  if (!board || !view) return () => {}
  syncOpenMontageBoardVisibility(frame)
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => syncOpenMontageBoardVisibility(frame)) : null
  observer?.observe(board)
  return () => observer?.disconnect()
}
