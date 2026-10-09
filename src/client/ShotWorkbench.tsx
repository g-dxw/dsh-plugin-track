import type {KeyboardEventHandler, ReactNode, Ref} from 'react'
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
}

/** The two scene editors share a title, status, actions and workspace frame. */
export function ShotWorkbench({context, status, dirty, navigation, toolbar, children, timeline, footer, dialog, workspaceRef, onKeyDown, panel, ariaLabel = '镜头编辑', className = ''}: ShotWorkbenchProps) {
  return <div ref={workspaceRef} className={`trk-gm${className ? ` ${className}` : ''}`} data-panel={panel} tabIndex={0} onKeyDown={onKeyDown} aria-label={ariaLabel}>
    <style>{GEOMOTION_EDITOR_CSS}</style>
    <header className="trk-gm-header">
      <div className="trk-gm-heading"><h2>镜头编辑</h2><p className="trk-gm-context">{context}{dirty && <span className="trk-gm-dirty">有未保存修改</span>}</p>{status != null && <p className="trk-gm-save-status" role="status" aria-live="polite">{status}</p>}</div>
      {navigation && <nav className="trk-gm-navigation" aria-label="镜头编辑导航">{navigation}</nav>}
    </header>
    {toolbar}
    <div className="trk-gm-workbench" style={{display: 'flex', flexDirection: 'column', gap: 'calc(var(--trk-gm-gap)*1.5)', minWidth: 0}}>{children}</div>
    {timeline}
    {footer && <footer className="trk-gm-footer">{footer}</footer>}
    {dialog}
  </div>
}

export function ShotWorkbenchToolbar({children, fileTools, label = '镜头工程操作'}: {children: ReactNode; fileTools?: ReactNode; label?: string}) {
  return <div className="trk-gm-toolbar" role="group" aria-label={label}>
    <div className="trk-gm-actions">{children}</div>
    {fileTools && <details className="trk-gm-file-tools"><summary>工程文件</summary><div className="trk-gm-actions">{fileTools}</div></details>}
  </div>
}

/** A failed parser must still leave the original sidecar available for recovery. */
export function ShotProjectBackup({trackId, scene, scope, disabled = false}: {trackId: string; scene: 'map' | 'sandbox'; scope?: ShotProjectScope; disabled?: boolean}) {
  return <a className={`trk-gm-file${disabled ? ' is-disabled' : ''}`} href={`${API}/shot-project-backup?id=${encodeURIComponent(trackId)}&scene=${scene}${shotScopeQuery(scope)}`}
    download={`${scene === 'map' ? 'geomotion' : 'shot-editor'}-project-original.json`} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
    onClick={event => {if (disabled) event.preventDefault()}}>下载原工程备份</a>
}
