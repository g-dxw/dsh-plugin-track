import {useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode, type Ref} from 'react'
import {GEOMOTION_EDITOR_CSS} from './geomotion-editor-css.ts'
import {API} from '../protocol.ts'
import {shotScopeQuery, type ShotProjectScope} from '../track/shot-project-scope.ts'

export interface ShotWorkbenchProps {
  context: ReactNode
  status?: ReactNode
  dirty?: boolean
  navigation?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
  timeline?: ReactNode
  footer?: ReactNode
  dialog?: ReactNode
  workspaceRef?: Ref<HTMLDivElement>
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
  panel?: string
  ariaLabel?: string
  className?: string
  fitViewport?: boolean
}

/** The two scene editors share a title, status, actions and workspace frame. */
export function ShotWorkbench({context, status, dirty, navigation, toolbar, children, timeline, footer, dialog, workspaceRef, onKeyDown, panel, ariaLabel = '镜头编辑', className = '', fitViewport = false}: ShotWorkbenchProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => {
    frame.current = element
    if (typeof workspaceRef === 'function') workspaceRef(element)
    else if (workspaceRef) (workspaceRef as {current: HTMLDivElement | null}).current = element
  }, [workspaceRef])
  useLayoutEffect(() => {
    const element = frame.current
    if (!fitViewport || !element) return
    const measure = () => {
      const bounds = element.getBoundingClientRect()
      if (!bounds.width) return
      const size = bounds.width <= 850 ? 'compact' : bounds.width <= 1100 ? 'medium' : 'wide'
      if (element.dataset.workspaceSize !== size) element.dataset.workspaceSize = size
      const height = Math.max(480, window.innerHeight - Math.max(0, bounds.top) - 12)
      const value = height + 'px'
      if (element.style.getPropertyValue('--trk-gm-workspace-height') !== value) element.style.setProperty('--trk-gm-workspace-height', value)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    if (element.parentElement) observer?.observe(element.parentElement)
    window.addEventListener('resize', measure)
    measure()
    return () => {observer?.disconnect(); window.removeEventListener('resize', measure)}
  }, [fitViewport])
  return <div ref={attach} className={`trk-gm${className ? ` ${className}` : ''}`} data-panel={panel} data-viewport-fit={fitViewport || undefined} tabIndex={0} onKeyDown={onKeyDown} aria-label={ariaLabel}>
    <style>{GEOMOTION_EDITOR_CSS}</style>
    <div className="trk-gm-topbar"><header className="trk-gm-header">
      <div className="trk-gm-heading"><h2><ShotWorkbenchIcon name="camera"/>镜头编辑</h2><p className="trk-gm-context">{context}{dirty && <span className="trk-gm-dirty">有未保存修改</span>}</p>{status != null && <p className="trk-gm-save-status" role="status" aria-live="polite">{status}</p>}</div>
      {navigation && <nav className="trk-gm-navigation" aria-label="镜头编辑导航">{navigation}</nav>}
    </header>
    {toolbar}</div>
    <div className="trk-gm-workbench">{children}</div>
    {timeline}
    {footer && <footer className="trk-gm-footer">{footer}</footer>}
    {dialog}
  </div>
}

export function ShotWorkbenchToolbar({children, fileTools, label = '镜头工程操作'}: {children: ReactNode; fileTools?: ReactNode; label?: string}) {
  const files = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: Event) => {if (files.current?.open && event.target instanceof Node && !files.current.contains(event.target)) files.current.open = false}
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => {document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss)}
  }, [])
  return <div className="trk-gm-toolbar" role="group" aria-label={label}>
    <div className="trk-gm-actions">{children}</div>
    {fileTools && <details ref={files} className="trk-gm-file-tools" onKeyDown={event => {if (event.key === 'Escape' && files.current?.open) {event.preventDefault(); event.stopPropagation(); files.current.open = false; files.current.querySelector('summary')?.focus()}}}><summary title="工程文件"><ShotWorkbenchIcon name="file"/><span>工程文件</span></summary><div className="trk-gm-actions">{fileTools}</div></details>}
  </div>
}

/** A failed parser must still leave the original sidecar available for recovery. */
export function ShotProjectBackup({trackId, scene, scope, disabled = false}: {trackId: string; scene: 'map' | 'sandbox'; scope?: ShotProjectScope; disabled?: boolean}) {
  return <a className={`trk-gm-file${disabled ? ' is-disabled' : ''}`} href={`${API}/shot-project-backup?id=${encodeURIComponent(trackId)}&scene=${scene}${shotScopeQuery(scope)}`}
    download={`${scene === 'map' ? 'geomotion' : 'shot-editor'}-project-original.json`} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
    onClick={event => {if (disabled) event.preventDefault()}}>下载原工程备份</a>
}

/** Small consistent stroke icons; names stay on their native controls. */
export function ShotWorkbenchIcon({name, size = 16}: {name: 'camera' | 'pin' | 'route' | 'text' | 'layers' | 'eye' | 'eye-off' | 'search' | 'undo' | 'redo' | 'save' | 'export' | 'expand' | 'collapse' | 'file' | 'reset' | 'settings'; size?: number}) {
  const paths = {
    camera: 'M4 6h4l2-3h4l2 3h4v14H4V6Zm4 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z',
    pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Zm-11 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
    route: 'M5 19h.01M19 5h.01M5 16V9a4 4 0 0 1 4-4h7M8 19h7a4 4 0 0 0 4-4V8',
    text: 'M4 5V3h16v2M12 3v18m-4 0h8',
    layers: 'm12 2 10 5-10 5L2 7l10-5ZM2 12l10 5 10-5M2 17l10 5 10-5',
    eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
    'eye-off': 'm3 3 18 18M10 5c7-1 12 7 12 7s-2 4-6 6M7 6c-3 2-5 6-5 6s3 7 10 7l3-1',
    search: 'M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 6 5 5',
    undo: 'm8 4-5 5 5 5M3 9h10a7 7 0 0 1 7 7v4',
    redo: 'm16 4 5 5-5 5M21 9H11a7 7 0 0 0-7 7v4',
    save: 'M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8',
    export: 'M12 15V3m-5 5 5-5 5 5M4 14v7h16v-7',
    expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    collapse: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
    file: 'M3 6h7l2 2h9v13H3V6Z',
    reset: 'M3 10a9 9 0 1 1 2 9M3 4v6h6',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
  }
  return <svg className="trk-gm-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>
}
