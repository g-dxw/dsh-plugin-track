/** GeoMotion chrome follows the host theme; Track has no separate theme switch. */
export const TRACK_THEME_CSS = `
.trk{
 --trk-bg:var(--dsw-alias-bg-base,var(--background,Canvas));
 --trk-text:var(--dsw-alias-label-primary,var(--foreground,CanvasText));
 --trk-muted:var(--dsw-alias-label-secondary,GrayText);
 --trk-surface:var(--dsw-alias-bg-layer-1,var(--trk-bg));
 --trk-border:var(--dsw-alias-border-l2,color-mix(in srgb,var(--trk-text) 18%,transparent));
 --trk-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--trk-text) 8%,transparent));
 --trk-active:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,var(--trk-text) 14%,transparent));
 --trk-accent:var(--dsw-alias-brand-primary,Highlight);
 --trk-primary-bg:var(--dsw-alias-button-primary-fill,var(--trk-accent));
 --trk-on-accent:var(--dsw-alias-label-primary-foreground,HighlightText);
 --trk-focus:var(--dsw-alias-brand-primary,Highlight);
 --trk-danger:var(--dsw-alias-state-error-primary,color-mix(in srgb,FireBrick 70%,var(--trk-text)));
 --trk-danger-bg:color-mix(in srgb,var(--trk-danger) 8%,var(--trk-bg));
 --trk-danger-border:color-mix(in srgb,var(--trk-danger) 40%,var(--trk-border));
 --trk-notice:var(--dsw-alias-label-primary,var(--trk-text));
 --trk-notice-bg:var(--dsw-alias-interactive-bg-active,var(--trk-hover));
 --trk-notice-border:var(--trk-border);
 --trk-warning:var(--dsw-alias-state-warn-label,var(--trk-text));
 --trk-overlay:var(--dsw-alias-bg-layer-1,var(--trk-bg));
 --trk-overlay-text:var(--trk-text);
 --trk-map-background:var(--dsw-alias-bg-layer-2,var(--trk-bg));
 --trk-shadow:var(--dsw-alias-bg-mask-2,color-mix(in srgb,var(--trk-text) 12%,transparent));
 --trk-radius-sm:5px;
 --trk-radius-md:6px;
 --trk-radius-lg:8px;
 --trk-control-height:32px;
 --trk-input-height:30px;
 --trk-ui-font-size:calc(var(--trk-font-size)*.92857);
 --trk-ui-label-size:calc(var(--trk-font-size)*.85714);
 --trk-panel-title-height:36px;
 --trk-font-size:var(--dsh-content-font-size,14px);
 --trk-chart-label:var(--trk-muted);
 --trk-chart-grid:var(--trk-border);
 --trk-chart-crosshair:var(--trk-muted);
 font-size:var(--trk-font-size);color-scheme:inherit;
}
.trk input[type=checkbox],.trk input[type=radio],.trk input[type=range],.trk progress{accent-color:var(--trk-accent)}
.trk .trk-secondary,.trk .trk-primary,.trk .trk-danger{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--trk-control-height);padding:5px 9px;border-radius:var(--trk-radius-sm);font-size:var(--trk-ui-label-size);line-height:1.5;box-shadow:none}
.trk input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]),.trk select{min-height:var(--trk-input-height);font-size:var(--trk-ui-label-size)}
.trk textarea{font-size:var(--trk-ui-font-size);line-height:1.6}
@container(max-width:750px){.trk .trk-secondary,.trk .trk-primary,.trk .trk-danger{min-height:44px}.trk input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]),.trk select{min-height:40px}}
@media(pointer:coarse){.trk{--trk-control-height:44px;--trk-input-height:40px}}
.trk button:focus-visible,.trk input:focus-visible,.trk select:focus-visible,.trk textarea:focus-visible,.trk a:focus-visible,.trk summary:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
@media(forced-colors:active){.trk{
 --trk-bg:Canvas;--trk-text:CanvasText;--trk-muted:CanvasText;--trk-surface:Canvas;
 --trk-border:ButtonText;--trk-hover:Canvas;--trk-active:Canvas;
 --trk-accent:Highlight;--trk-primary-bg:Highlight;--trk-on-accent:HighlightText;--trk-focus:Highlight;
 --trk-danger:CanvasText;--trk-danger-bg:Canvas;--trk-danger-border:CanvasText;
 --trk-notice:CanvasText;--trk-notice-bg:Canvas;--trk-notice-border:CanvasText;
 --trk-warning:CanvasText;--trk-overlay:Canvas;--trk-overlay-text:CanvasText;--trk-map-background:Canvas;
}}
`

export interface TrackThemeColors {
  label: string
  grid: string
  crosshair: string
  tooltipBackground: string
  tooltipText: string
}

/** Canvas cannot consume var(...); resolve through CSS, including nested aliases. */
export function readTrackThemeColors(element: HTMLElement): TrackThemeColors {
  const probe = element.ownerDocument.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  probe.setAttribute('aria-hidden', 'true')
  element.appendChild(probe)
  const read = (token: string, system: string, fallback: string) => {
    probe.style.color = `var(${token},${system})`
    const color = element.ownerDocument.defaultView?.getComputedStyle(probe).color.trim() || ''
    // Non-rendering environments can return the unresolved CSS expression.
    return color && !/^(?:var\(|Canvas|GrayText|Button|Highlight|inherit|initial|unset)/i.test(color) ? color : fallback
  }
  try {
    return {
      label: read('--trk-chart-label', 'GrayText', '#555555'),
      grid: read('--trk-chart-grid', 'GrayText', '#888888'),
      crosshair: read('--trk-chart-crosshair', 'CanvasText', '#555555'),
      tooltipBackground: read('--trk-surface', 'Canvas', '#ffffff'),
      tooltipText: read('--trk-text', 'CanvasText', '#111111'),
    }
  } finally { probe.remove() }
}

/** Body tokens, theme attributes and token stylesheets all change without remounting. */
export function observeTrackTheme(element: HTMLElement, onChange: () => void): () => void {
  const view = element.ownerDocument.defaultView
  if (!view) return () => {}
  let active = true, queued = false
  const changed = () => {
    if (!active || queued) return
    queued = true
    queueMicrotask(() => {queued = false; if (active) onChange()})
  }
  const observer = new view.MutationObserver(changed)
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, {attributes: true})
  }
  observer.observe(element.ownerDocument.head, {childList: true, characterData: true, subtree: true, attributes: true})
  const media = ['(prefers-color-scheme: dark)', '(forced-colors: active)'].map(query => view.matchMedia?.(query)).filter((query): query is MediaQueryList => !!query)
  for (const query of media) query.addEventListener('change', changed)
  return () => {active = false; observer.disconnect(); for (const query of media) query.removeEventListener('change', changed)}
}
