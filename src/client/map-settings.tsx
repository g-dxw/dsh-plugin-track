/** Shared browser-local map preferences and the settings dialog. */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { BASEMAP_OPTIONS, MAPTILER_LOGO_URL, basemapCredits, styleFor, terrainProviderFor, type BasemapId } from '../track/basemaps.ts'
import { DEFAULT_MAP_SETTINGS, MAP_SETTINGS_KEY, LEGACY_BASEMAP_KEY, readMapSettings, sanitizeMapSettings, writeMapSettings, type MapCredit, type MapSettings } from '../track/map-settings.ts'
import { TRACK_THEME_CSS } from './theme.ts'

const CHANGE_EVENT = 'cqai-track:map-settings-changed'
const OPEN_EVENT = 'cqai-track:map-settings-open'
interface SettingsContext {settings: MapSettings; updateSettings: (patch: Partial<MapSettings>) => void; openSettings: () => void}
export type MapViewSettingsMode = 'terrain' | 'sandbox'
type SettingsScope = 'global' | MapViewSettingsMode
const Context = createContext<SettingsContext | null>(null)
const ViewSettingsContext = createContext<((mode: MapViewSettingsMode) => void) | null>(null)
function usePreferences() {
  const [settings, setSettings] = useState(readMapSettings)
  const current = useRef(settings); current.current = settings
  useEffect(() => {
    const change = (event: Event) => {const next = sanitizeMapSettings((event as CustomEvent<MapSettings>).detail); current.current = next; setSettings(next)}
    const storage = (event: StorageEvent) => {if (!event.key || event.key === MAP_SETTINGS_KEY || event.key === LEGACY_BASEMAP_KEY) {const next = readMapSettings(); current.current = next; setSettings(next)}}
    window.addEventListener(CHANGE_EVENT, change); window.addEventListener('storage', storage)
    return () => {window.removeEventListener(CHANGE_EVENT, change); window.removeEventListener('storage', storage)}
  }, [])
  const updateSettings = useCallback((patch: Partial<MapSettings>) => {
    const next = writeMapSettings(sanitizeMapSettings({...current.current, ...patch}))
    current.current = next; setSettings(next)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {detail: next}))
  }, [])
  return {settings, updateSettings}
}
export function useMapSettings(): SettingsContext {
  const context = useContext(Context)
  const local = usePreferences()
  const openSettings = useCallback(() => {window.dispatchEvent(new CustomEvent(OPEN_EVENT, {detail: {handled: false}}))}, [])
  return context ?? {...local, openSettings}
}
export function MapSettingsProvider({children}: {children?: ReactNode}) {
  const {settings, updateSettings} = usePreferences()
  const [scope, setScope] = useState<SettingsScope | null>(null)
  const open = scope !== null
  const content = useRef<HTMLDivElement>(null)
  const openSettings = useCallback(() => setScope('global'), [])
  const openViewSettings = useCallback((mode: MapViewSettingsMode) => setScope(mode), [])
  const close = useCallback(() => {content.current?.removeAttribute('inert'); setScope(null)}, [])
  const context = useMemo(() => ({settings, updateSettings, openSettings}), [settings, updateSettings, openSettings])
  useEffect(() => {if (open) content.current?.setAttribute('inert', ''); else content.current?.removeAttribute('inert')}, [open])
  return <Context.Provider value={context}><ViewSettingsContext.Provider value={openViewSettings}>
    <div ref={content} style={{display: 'contents'}} aria-hidden={open || undefined}>{children}</div>
    {scope && <MapSettingsDialog key={scope} scope={scope} settings={settings} onSave={updateSettings} onClose={close} />}
  </ViewSettingsContext.Provider></Context.Provider>
}

/** The overview uses a Wanderer-style layer dock; editors keep the inline toolbar. */
export function BasemapControls({basemap, onBasemap, disabled, className, layout = 'toolbar', mapControls, viewSettings}: {basemap: BasemapId; onBasemap: (value: BasemapId) => void; disabled?: boolean; className?: string; layout?: 'toolbar' | 'dock'; mapControls?: ReactNode; viewSettings?: ReactNode}) {
  const {settings, updateSettings} = useMapSettings()
  const [layersOpen, setLayersOpen] = useState(false)
  const dock = useRef<HTMLDivElement>(null)
  const layerTrigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const closeLayers = () => {setLayersOpen(false); layerTrigger.current?.focus({preventScroll: true})}
  useEffect(() => {if (disabled) setLayersOpen(false)}, [disabled])
  useEffect(() => {
    if (!layersOpen) return
    dock.current?.querySelector<HTMLInputElement>('input:checked')?.focus({preventScroll: true})
    // Dismiss without stealing focus from the map or another tool.
    const outside = (event: Event) => {if (event.target instanceof Node && !dock.current?.contains(event.target)) setLayersOpen(false)}
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside)}
  }, [layersOpen])
  const choose = (value: BasemapId) => {updateSettings({basemap: value}); onBasemap(value)}
  return <>
    <style>{BASEMAP_CONTROLS_CSS}</style>
    {layout === 'dock' ? <div ref={dock} role="group" aria-label="地图工具" className={`trk-map-dock${className ? ` ${className}` : ''}`} onKeyDown={event => {
      if (event.key === 'Escape' && layersOpen) {event.preventDefault(); event.stopPropagation(); closeLayers()}
    }}>
      <div className="trk-map-dock-buttons">
        {mapControls && <div className="trk-map-navigation-tools" onPointerDown={() => setLayersOpen(false)} onFocusCapture={() => setLayersOpen(false)}>{mapControls}</div>}
        <button ref={layerTrigger} type="button" aria-label="地图图层" title="地图图层" aria-expanded={layersOpen} aria-controls={panelId} disabled={disabled} onClick={() => setLayersOpen(value => !value)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
        </button>
        {viewSettings && <div className="trk-map-view-settings-tools" onPointerDown={() => setLayersOpen(false)} onFocusCapture={() => setLayersOpen(false)}>{viewSettings}</div>}
      </div>
      {layersOpen && <section id={panelId} role="region" aria-label="地图图层" className="trk-map-layers-panel">
        <div className="trk-map-layers-heading"><strong>地图图层</strong><button type="button" aria-label="关闭地图图层" title="关闭地图图层" onClick={closeLayers}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
        <div className="trk-map-layer-options"><fieldset><legend>地图源</legend>
          {BASEMAP_OPTIONS.map(option => <label key={option.id} className="trk-map-layer-option">
            <input type="radio" name={`${panelId}-basemap`} value={option.id} checked={basemap === option.id} disabled={disabled || (option.requiresKey && !settings.maptilerKey)} onChange={() => choose(option.id)} />
            <span>{option.label}{option.requiresKey && !settings.maptilerKey && <small>需填写 Key</small>}</span>
          </label>)}
        </fieldset></div>
        <button className="trk-map-layer-retry" type="button" disabled={disabled} onClick={() => choose(basemap)}>重新加载当前底图</button>
      </section>}
    </div> : <div role="group" aria-label="底图" className={`${className ?? 'trk-base'} trk-basemap-controls`} style={{display: 'flex', gap: 6, flexWrap: 'wrap', pointerEvents: 'auto', background: 'var(--trk-overlay)', padding: 8, borderRadius: 'var(--trk-radius-sm)'}}>
      {BASEMAP_OPTIONS.slice(0, 4).map(option => <button className="trk-basebtn trk-basemap-primary" type="button" style={{minHeight: 'var(--trk-control-height,32px)'}} key={option.id} aria-pressed={basemap === option.id} disabled={disabled} onClick={() => choose(option.id)}>{option.label}</button>)}
      <select className="trk-basemap-extra" aria-label="其他地图源" disabled={disabled} value={BASEMAP_OPTIONS.slice(4).some(option => option.id === basemap) ? basemap : ''}
        style={{minHeight: 'var(--trk-input-height,30px)', maxWidth: 180, borderRadius: 'var(--trk-radius-sm)', background: 'var(--trk-overlay)', color: 'var(--trk-overlay-text)', border: '1px solid var(--trk-border)'}}
        onChange={event => {if (event.target.value) choose(event.target.value as BasemapId)}}>
        <option value="">其他地图源</option>
        {BASEMAP_OPTIONS.slice(4).map(option => <option value={option.id} key={option.id} disabled={option.requiresKey && !settings.maptilerKey}>{option.label}{option.requiresKey && !settings.maptilerKey ? '（需 Key）' : ''}</option>)}
      </select>
      <select className="trk-basemap-compact" aria-label="地图源" disabled={disabled} value={basemap}
        style={{minHeight: 'var(--trk-input-height,30px)', minWidth: 0, maxWidth: 220, borderRadius: 'var(--trk-radius-sm)', background: 'var(--trk-overlay)', color: 'var(--trk-overlay-text)', border: '1px solid var(--trk-border)'}}
        onChange={event => choose(event.target.value === 'retry-current' ? basemap : event.target.value as BasemapId)}>
        {BASEMAP_OPTIONS.map(option => <option value={option.id} key={option.id} disabled={option.requiresKey && !settings.maptilerKey}>{option.label}{option.requiresKey && !settings.maptilerKey ? '（需 Key）' : ''}</option>)}
        <option value="retry-current">重新加载当前底图</option>
      </select>

    </div>}
  </>
}
const BASEMAP_CONTROLS_CSS = `

.trk-basemap-controls .trk-basemap-compact{display:none}.trk-basemap-controls button{min-height:var(--trk-control-height,32px);padding:5px 9px;font-size:12px}.trk-basemap-controls select{min-height:var(--trk-input-height,30px);padding:4px 7px;font-size:12px}
.trk-map-dock{position:absolute;top:10px;right:10px;left:10px;bottom:64px;display:flex;flex-direction:column;align-items:flex-end;pointer-events:none;z-index:6}
.trk-map-dock-buttons{display:flex;flex-direction:column;pointer-events:auto;flex-shrink:0;background:var(--trk-overlay);color:var(--trk-overlay-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);box-shadow:0 2px 8px var(--trk-shadow)}
.trk-map-dock button{display:grid;place-items:center;min-width:var(--trk-control-height,32px);min-height:var(--trk-control-height,32px);padding:6px;border:0;border-radius:var(--trk-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer}.trk-map-dock .trk-map-dock-buttons .trk-map-native-navigation .maplibregl-ctrl-group button{width:var(--trk-control-height,32px);height:var(--trk-control-height,32px);min-height:var(--trk-control-height,32px);padding:0}
.trk-map-navigation-tools,.trk-map-view-settings-tools{display:contents}.trk-map-dock .trk-map-view-settings-trigger{width:var(--trk-control-height,32px);height:var(--trk-control-height,32px);border-top:1px solid var(--trk-border);border-top-left-radius:0;border-top-right-radius:0}.trk-map-dock-buttons>button:not(:first-child),.trk-map-navigation-tools>button:not(:first-child){border-top:1px solid var(--trk-border);border-top-left-radius:0;border-top-right-radius:0}.trk-map-native-navigation[hidden]+button{border-top:0}.trk-map-control-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.trk-map-dock button svg{width:18px;height:18px;flex-shrink:0}
.trk-map-dock button:hover:not(:disabled),.trk-map-dock button[aria-expanded=true]{background:var(--trk-active)}.trk-map-dock button:disabled{opacity:.45;cursor:default}.trk-map-dock button:focus-visible,.trk-map-dock input:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-map-layers-panel{position:absolute;top:0;right:calc(var(--trk-control-height,32px) + 10px);width:min(300px,calc(100% - var(--trk-control-height,32px) - 10px));max-height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;pointer-events:auto;padding:0 10px 10px;background:var(--trk-overlay);color:var(--trk-overlay-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);box-shadow:0 4px 16px var(--trk-shadow);font-size:var(--trk-ui-font-size,13px)}
.trk-map-layers-heading{display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:6px;min-height:36px;margin:0 -10px 6px;padding:2px 10px;border-bottom:1px solid var(--trk-border)}.trk-map-layers-heading strong{font-size:13px;font-weight:600}.trk-map-layers-heading button{margin-right:-4px}
.trk-map-layer-options{min-height:0;overflow:auto;flex:1 1 auto}.trk-map-layers-panel fieldset{border:0;padding:0;margin:0;min-width:0}.trk-map-layers-panel legend{font-size:12px;color:var(--trk-muted);padding:4px 0}
.trk-map-layer-option{display:flex;align-items:center;gap:7px;min-height:40px;padding:5px 8px;border-left:2px solid transparent;border-radius:0;font-size:12px;cursor:pointer}.trk-map-layer-option:hover{background:var(--trk-hover)}.trk-map-layer-option:has(input:checked){background:var(--trk-active);border-left-color:var(--trk-accent)}.trk-map-layer-option:has(input:disabled){opacity:.55;cursor:default}.trk-map-layer-option input{margin:0;accent-color:var(--trk-accent);flex-shrink:0}.trk-map-layer-option span{display:flex;flex-wrap:wrap;align-items:center;gap:3px 6px}.trk-map-layer-option small{font-size:11px;color:var(--trk-muted)}
.trk-map-dock .trk-map-layer-retry{display:block;flex-shrink:0;width:100%;margin-top:7px;border:1px solid var(--trk-border);font-size:12px}
@media(forced-colors:active){.trk-map-dock-buttons,.trk-map-layers-panel{background:var(--trk-overlay);color:var(--trk-overlay-text);border-color:var(--trk-border)}.trk-map-dock button[aria-expanded=true],.trk-map-layer-option:has(input:checked){outline:2px solid var(--trk-focus);outline-offset:-2px}}
@container(max-width:750px){.trk-basemap-controls{--trk-control-height:44px;--trk-input-height:40px}.trk-map-dock button{min-width:44px;min-height:44px}.trk-map-dock .trk-map-view-settings-trigger,.trk-map-dock .trk-map-dock-buttons .trk-map-native-navigation .maplibregl-ctrl-group button{width:44px;height:44px;min-height:44px}.trk-map-layer-option{min-height:44px}.trk-map-layers-panel{right:54px;width:min(300px,calc(100% - 54px))}.trk-basemap-controls button{min-height:44px}.trk-basemap-controls select{min-height:40px}}
@container(max-width:500px){.trk-map-layers-panel{top:calc(var(--trk-map-toolbar-bottom,72px) - 10px);max-height:calc(100% - var(--trk-map-toolbar-bottom,72px) + 10px)}.trk-basemap-controls .trk-basemap-primary,.trk-basemap-controls .trk-basemap-extra{display:none}.trk-basemap-controls .trk-basemap-compact{display:block}}
@media(pointer:coarse){.trk-map-dock button{min-width:44px;min-height:44px}.trk-map-dock .trk-map-view-settings-trigger,.trk-map-dock .trk-map-dock-buttons .trk-map-native-navigation .maplibregl-ctrl-group button{width:44px;height:44px;min-height:44px}.trk-map-layer-option{min-height:44px}.trk-map-layers-panel{right:54px;width:min(300px,calc(100% - 54px))}.trk-basemap-controls button{min-height:44px}.trk-basemap-controls select{min-height:40px}}

`
export function MapCredits({basemap, terrain = false, texture = true, className, settings: capturedSettings, placement}: {basemap: BasemapId; terrain?: boolean; texture?: boolean; className?: string; settings?: MapSettings; placement?: 'inline'}) {
  const {settings: sharedSettings} = useMapSettings()
  const settings = capturedSettings ?? sharedSettings
  const effectiveBasemap = basemap.startsWith('maptiler-') && !settings.maptilerKey ? 'vector' : basemap
  const credits: readonly MapCredit[] = [...(texture ? basemapCredits(effectiveBasemap) : []), ...(terrain ? terrainProviderFor(settings).credits : [])]
  const unique = credits.filter((credit, index) => credits.findIndex(item => item.url === credit.url && item.label === credit.label) === index)
  const maptiler = unique.some(credit => credit.url.includes('maptiler.com'))
  if (!unique.length) return null
  const inline = placement === 'inline' || className === 'trk-sandbox-attribution'
  return <div className={className ?? 'trk-map-credits'} style={{position: inline ? 'relative' : 'absolute', bottom: inline ? undefined : 0, right: inline ? undefined : 0, left: inline ? undefined : 0, zIndex: 3, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '2px 7px', background: 'var(--trk-overlay)', color: 'var(--trk-overlay-text)', padding: '3px 6px', fontSize: 10, pointerEvents: 'auto'}}>
    {maptiler && <a href="https://www.maptiler.com/" target="_blank" rel="noopener noreferrer" style={{marginRight: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', padding: '3px 4px', borderRadius: 3, background: '#fff'}}><img src={MAPTILER_LOGO_URL} alt="MapTiler logo" width={67} height={20} style={{display: 'block', width: 67, height: 20, objectFit: 'contain'}} /></a>}
    {unique.map(credit => <a key={`${credit.url}:${credit.label}`} href={credit.url} target="_blank" rel="noopener noreferrer" style={{color: 'inherit'}}>{credit.label}</a>)}
  </div>
}

/** A connection test only requests service metadata or one user-requested sample tile. */
export async function testMapConnection(settings: MapSettings, signal: AbortSignal): Promise<void> {
  const checks: {url: string; json: boolean; label: string}[] = []
  const selected = styleFor(settings.basemap, settings)
  if (typeof selected === 'string') checks.push({url: selected, json: true, label: 'MapTiler 底图'})
  else if (settings.basemap === 'vector') checks.push({url: 'https://tiles.openfreemap.org/planet', json: true, label: 'OpenFreeMap 底图'})
  else if (settings.basemap !== 'none') {
    const raster = Object.values(selected.sources).find(source => source.type === 'raster')
    if (raster?.type === 'raster' && raster.tiles?.[0]) checks.push({url: raster.tiles[0].replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0'), json: false, label: '底图'})
  }
  const terrain = terrainProviderFor(settings)
  checks.push({url: terrain.url ?? terrain.tiles![0].replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0'), json: Boolean(terrain.url), label: '高程服务'})
  await Promise.all(checks.map(async check => {
    const response = await fetch(check.url, {signal, credentials: 'omit'})
    if (!response.ok) throw new Error(`${check.label}连接失败（HTTP ${response.status}）`)
    if (check.json) {
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || (!('tiles' in value) && !('sources' in value))) throw new Error(`${check.label}返回的数据无效`)
    } else {
      const blob = await response.blob()
      if (!blob.size || (blob.type && !blob.type.startsWith('image/'))) throw new Error(`${check.label}返回的数据无效`)
    }
  }))
}
/** Patch only fields owned by this dialog; another view may update the rest while it is open. */
function settingsPatch(scope: SettingsScope, settings: MapSettings): Partial<MapSettings> {
  if (scope === 'global') return {basemap: settings.basemap, maptilerKey: settings.maptilerKey, tiandituKey: settings.tiandituKey, terrainProvider: settings.terrainProvider}
  if (scope === 'terrain') return {exaggeration: settings.exaggeration, buildings: settings.buildings}
  return {exaggeration: settings.exaggeration, quality: settings.quality, sandboxColors: {...settings.sandboxColors}, sandboxBackground: settings.sandboxBackground}
}

/** In-map preferences never expose provider configuration. */
export function MapViewSettingsControls({mode, disabled}: {mode: MapViewSettingsMode; disabled?: boolean}) {
  const openViewSettings = useContext(ViewSettingsContext)
  const {settings, updateSettings} = useMapSettings()
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const title = mode === 'terrain' ? '3D 地图设置' : '3D 沙盘设置'
  return <>
    <button className="trk-map-view-settings-trigger" type="button" aria-label={title} title={title} disabled={disabled} onClick={() => openViewSettings ? openViewSettings(mode) : setFallbackOpen(true)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 3h5l.5 2.5 2 1.2 2.4-.7 2.5 4.3-1.9 1.7v2.3l1.9 1.7-2.5 4.3-2.4-.7-2 1.2-.5 2.2h-5L9 20.8l-2-1.2-2.4.7-2.5-4.3L4 14.3V12l-1.9-1.7L4.6 6l2.4.7 2-1.2.5-2.5Z" transform="translate(0 -1) scale(1 .96)"/><circle cx="12" cy="11.5" r="3"/></svg>
    </button>
    {fallbackOpen && <MapSettingsDialog scope={mode} settings={settings} onSave={updateSettings} onClose={() => setFallbackOpen(false)} />}
  </>
}

function MapSettingsDialog({scope, settings, onSave, onClose}: {scope: SettingsScope; settings: MapSettings; onSave: (patch: Partial<MapSettings>) => void; onClose: () => void}) {
  const [draft, setDraft] = useState<MapSettings>(() => sanitizeMapSettings(settings))
  const [showKey, setShowKey] = useState(false)
  const [showTiandituKey, setShowTiandituKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState('')
  const [failure, setFailure] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const id = useId()
  const global = scope === 'global'
  const sandbox = scope === 'sandbox'
  const title = global ? '地图设置' : sandbox ? '3D 沙盘设置' : '3D 地图设置'
  const missingKey = global && (draft.basemap.startsWith('maptiler-') || draft.terrainProvider === 'maptiler') && !draft.maptilerKey.trim()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    first.current?.focus()
    const containFocus = (event: FocusEvent) => {if (dialog.current && !dialog.current.contains(event.target as Node)) first.current?.focus()}
    document.addEventListener('focusin', containFocus)
    return () => {request.current?.abort(); request.current = null; document.removeEventListener('focusin', containFocus); if (previous?.isConnected) previous.focus({preventScroll: true})}
  }, [])
  useEffect(() => {if (testing) dialog.current?.focus()}, [testing])
  const update = (patch: Partial<MapSettings>) => {setDraft(value => ({...value, ...patch})); setStatus(''); setFailure(false)}
  async function test() {
    if (missingKey) {setStatus('请填写 MapTiler Key'); setFailure(true); return}
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    setTesting(true); setStatus(''); setFailure(false)
    try {await testMapConnection(sanitizeMapSettings(draft), controller.signal); if (!controller.signal.aborted) setStatus('底图和高程服务连接成功')}
    catch (error) {
      if (request.current === controller) {setFailure(true); setStatus(controller.signal.aborted ? '连接超时，请检查网络后重试' : error instanceof Error && /^.+（HTTP \d+）$|^.+返回的数据无效$/.test(error.message) ? error.message : '服务暂不可连接，请检查网络、Key 或域名限制后重试')}
    } finally {window.clearTimeout(timeout); if (request.current === controller) {setTesting(false); request.current = null}}
  }
  return <div className="trk trk-map-settings-overlay" onKeyDown={event => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onClose()}
    if (event.key === 'Tab') {
      const fields = Array.from(dialog.current?.querySelectorAll<HTMLElement>('*') ?? []).filter(element => element.matches('button,input,select,a[href]') && !element.matches(':disabled'))
      const start = fields[0], end = fields.at(-1)
      if (!start) {event.preventDefault(); return}
      if (event.shiftKey && (document.activeElement === start || document.activeElement === dialog.current)) {event.preventDefault(); end?.focus()}
      else if (!event.shiftKey && document.activeElement === end) {event.preventDefault(); start.focus()}
    }
  }}>
    <style>{TRACK_THEME_CSS + SETTINGS_CSS}</style>
    <div ref={dialog} className="trk-map-settings-dialog" role="dialog" aria-modal="true" aria-busy={testing || undefined} aria-labelledby={`${id}-title`} tabIndex={-1}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="trk-map-settings-hint">{global ? '地图源、Key 和高程来源用于所有地图，设置保存在当前浏览器。' : '设置保存在当前浏览器，保存后应用到当前视图。'}</p>
      <form onSubmit={event => {event.preventDefault(); if (!missingKey) {onSave(settingsPatch(scope, sanitizeMapSettings(draft))); onClose()}}}>
        <fieldset disabled={testing}>
          {global && <>
          <label>地图源<select ref={element => {first.current = element}} value={draft.basemap} onChange={event => update({basemap: event.target.value as BasemapId})}>
            {BASEMAP_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label>
          <label>MapTiler Key<div className="trk-map-key-row"><input type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.maptilerKey} placeholder="可选，使用 MapTiler 时填写" onChange={event => update({maptilerKey: event.target.value})} /><button type="button" onClick={() => setShowKey(value => !value)} aria-pressed={showKey}>{showKey ? '隐藏 Key' : '显示 Key'}</button></div></label>
          <label>高程来源<select value={draft.terrainProvider} onChange={event => update({terrainProvider: event.target.value as MapSettings['terrainProvider']})}><option value="mapterhorn">Mapterhorn（免费）</option><option value="maptiler">MapTiler Terrain RGB（需 Key）</option></select></label>
          <div className="trk-map-settings-field"><label htmlFor={`${id}-tianditu-key`} style={{marginBottom: 0}}>天地图 API Key</label>
          <div className="trk-map-key-row"><input id={`${id}-tianditu-key`} type={showTiandituKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} aria-describedby={`${id}-tianditu-hint`} value={draft.tiandituKey} placeholder="可选，填写天地图 Key" onChange={event => update({tiandituKey: event.target.value})} /><button type="button" onClick={() => setShowTiandituKey(value => !value)} aria-label={showTiandituKey ? '隐藏天地图 Key' : '显示天地图 Key'} aria-pressed={showTiandituKey}>{showTiandituKey ? '隐藏 Key' : '显示 Key'}</button></div></div>
          <p id={`${id}-tianditu-hint`} className="trk-map-settings-hint">用于配置国内位置服务，位置反查尚未接入。<a href="https://console.tianditu.gov.cn/" target="_blank" rel="noopener noreferrer" style={{color: 'var(--trk-accent)'}}>申请天地图 Key</a></p>
          </>}
          {!global && <>
          <label className="trk-map-range-row" htmlFor={`${id}-exaggeration`}>地形倍率 <output>{draft.exaggeration.toFixed(2)} 倍</output><input id={`${id}-exaggeration`} ref={element => {first.current = element}} type="range" aria-label="地形倍率" min={1} max={3} step={0.05} value={draft.exaggeration} onChange={event => update({exaggeration: Number(event.target.value)})} /></label>
          {sandbox && <label>沙盘质量<select aria-label="沙盘质量" value={draft.quality} onChange={event => update({quality: event.target.value as MapSettings['quality']})}><option value="eco">节能 · 96 网格 / 1024 贴图</option><option value="standard">标准 · 192 网格 / 2048 贴图</option><option value="fine">精细 · 256 网格 / 4096 贴图</option></select></label>}
          {sandbox && <>
            <h3>沙盘颜色</h3>
            <label>背景模式<select aria-label="背景模式" aria-describedby={`${id}-background-hint`} value={draft.sandboxBackground} onChange={event => update({sandboxBackground: event.target.value as MapSettings['sandboxBackground']})}>
              <option value="solid">纯色背景</option><option value="environment">球形环境光</option>
            </select></label>
            <p id={`${id}-background-hint`} className="trk-map-settings-hint">{draft.sandboxBackground === 'environment' ? '使用背景颜色生成天空、地平线和地面反光。亮度可通过光影中的环境光强度调整。' : '背景颜色以纯色显示。'}</p>
            {([['sides', '侧壁颜色'], ['background', '背景颜色']] as const).map(([key, label]) => <label key={key} className="trk-map-color-row">
              <span>{label}</span><output>{draft.sandboxColors[key]}</output>
              <input type="color" aria-label={label} value={draft.sandboxColors[key]} onChange={event => update({sandboxColors: {...draft.sandboxColors, [key]: event.target.value}})} />
            </label>)}
          </>}
          {!sandbox && <label className="trk-map-check"><input type="checkbox" aria-label="显示 3D 建筑" checked={draft.buildings} onChange={event => update({buildings: event.target.checked})} />显示 3D 建筑（需矢量底图含建筑数据）</label>}
          </>}
          {global && draft.basemap === 'osm' && <p className="trk-map-settings-hint">OpenStreetMap 公共瓦片用于可见交互地图；沙盘使用地形着色。需要沙盘贴图时可选择矢量底图或 MapTiler。</p>}
        </fieldset>
        {missingKey && <p role="alert" className="trk-map-settings-error">请填写 MapTiler Key，或选择免费地图与高程服务。</p>}
        {status && <p role={failure ? 'alert' : 'status'} className={failure ? 'trk-map-settings-error' : 'trk-map-settings-hint'}>{status}</p>}
        <div className="trk-map-settings-actions">
          <button type="button" disabled={testing} onClick={() => update(settingsPatch(scope, sanitizeMapSettings(DEFAULT_MAP_SETTINGS)))}>恢复默认</button>
          {global && <button type="button" disabled={testing || missingKey} onClick={() => void test()}>{testing ? '连接测试中…' : '连接测试'}</button>}
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" disabled={testing || missingKey}>保存应用</button>
        </div>
      </form>
    </div>
  </div>
}
const SETTINGS_CSS = `

.trk-map-settings-overlay{position:fixed;inset:0;z-index:1000;height:100%;display:grid;place-items:center;padding:12px;background:var(--trk-shadow);overflow:auto;color:var(--trk-text)}
.trk-map-settings-dialog{width:min(100%,560px);max-height:100%;overflow:auto;background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-lg);padding:0 10px 10px;box-shadow:0 8px 30px var(--trk-shadow);font-family:inherit;font-size:var(--trk-ui-font-size,13px)}
.trk-map-settings-dialog h2{display:flex;align-items:center;min-height:36px;margin:0 -10px 8px;padding:7px 10px;border-bottom:1px solid var(--trk-border);font-size:15px}.trk-map-settings-dialog h3{font-size:12px;margin:10px 0 7px;padding-top:8px;border-top:1px solid var(--trk-border)}.trk-map-settings-hint{font-size:11px;line-height:1.5;color:var(--trk-muted);margin:6px 0}
.trk-map-settings-dialog fieldset{padding:0;border:0;min-width:0}.trk-map-settings-dialog label{display:grid;grid-template-columns:104px minmax(0,1fr);align-items:center;gap:8px;margin:8px 0;font-size:var(--trk-ui-label-size,12px)}.trk-map-settings-dialog select,.trk-map-settings-dialog input:not([type=checkbox]):not([type=range]){width:100%;margin:0;min-height:var(--trk-input-height,30px);background:var(--trk-bg);color:var(--trk-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:4px 7px;font:inherit;font-size:12px}.trk-map-settings-dialog input[type=range]{width:100%;display:block;accent-color:var(--trk-accent);margin:0;min-height:var(--trk-input-height,30px)}.trk-map-settings-dialog output{font-variant-numeric:tabular-nums}.trk-map-settings-dialog .trk-map-range-row{grid-template-columns:104px minmax(0,1fr) 64px}.trk-map-range-row>input{grid-column:2;grid-row:1}.trk-map-range-row>output{grid-column:3;grid-row:1;text-align:right}.trk-map-settings-dialog .trk-map-settings-field{display:grid;grid-template-columns:104px minmax(0,1fr);gap:8px;align-items:center;margin:8px 0}.trk-map-settings-field>label{display:block;margin:0!important}.trk-map-settings-dialog .trk-map-check{display:flex;align-items:center;gap:7px;line-height:1.5;min-height:var(--trk-control-height,32px)}.trk-map-check input{width:16px;height:16px;min-width:16px;min-height:16px;margin:0;accent-color:var(--trk-accent)}
.trk-map-settings-dialog .trk-map-color-row{display:flex;align-items:center;gap:8px;min-height:var(--trk-control-height,32px)}.trk-map-color-row span{flex:1}.trk-map-color-row output{font:11px monospace;color:var(--trk-muted)}.trk-map-settings-dialog .trk-map-color-row input[type=color]{width:44px;height:var(--trk-input-height,30px);min-height:var(--trk-input-height,30px);padding:2px;margin:0;flex-shrink:0;cursor:pointer}
.trk-map-key-row{display:flex;align-items:center;gap:6px}.trk-map-key-row input{min-width:0}.trk-map-settings-dialog button{font:inherit;font-size:12px;min-height:var(--trk-control-height,32px);padding:5px 9px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:var(--trk-text);cursor:pointer;white-space:nowrap}.trk-map-settings-dialog button:hover{background:var(--trk-hover)}.trk-map-settings-dialog button:disabled{opacity:.55;cursor:default}.trk-map-settings-dialog button:focus-visible,.trk-map-settings-dialog input:focus-visible,.trk-map-settings-dialog select:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-map-settings-error{color:var(--trk-danger);font-size:12px;line-height:1.5}.trk-map-settings-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin-top:10px;padding-top:8px;border-top:1px solid var(--trk-border)}.trk-map-settings-actions button[type=submit]{background:var(--trk-primary-bg);color:var(--trk-on-accent);border-color:var(--trk-primary-bg)}
@media(max-width:750px),(pointer:coarse){.trk-map-settings-dialog button,.trk-map-settings-dialog .trk-map-check{min-height:44px}.trk-map-settings-dialog select,.trk-map-settings-dialog input:not([type=checkbox]){min-height:40px}.trk-map-settings-dialog .trk-map-color-row input[type=color]{height:40px;min-height:40px}}
@media(max-width:420px){.trk-map-settings-dialog label,.trk-map-settings-dialog .trk-map-settings-field{grid-template-columns:88px minmax(0,1fr)}.trk-map-settings-dialog .trk-map-range-row{grid-template-columns:88px minmax(0,1fr) 56px}.trk-map-key-row{flex-wrap:wrap}.trk-map-key-row button{width:100%}.trk-map-settings-actions button{flex:1}}

`
