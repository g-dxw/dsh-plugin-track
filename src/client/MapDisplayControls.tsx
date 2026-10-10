import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { TrackPlacemark } from '../protocol.ts'
import { ALL_PLACEMARK_TYPES, isAllPlacemarkTypes, placemarkTypeOptions, placemarkTypeValues, type PlacemarkTypeFilter } from '../track/placemark-filter.ts'
import { SANDBOX_LABEL_SIZE_MIN, SANDBOX_LABEL_SIZE_MAX, SANDBOX_LABEL_HEIGHT_MIN, SANDBOX_LABEL_HEIGHT_MAX, PLACEMARK_POINT_SIZE_MIN, PLACEMARK_POINT_SIZE_MAX, PLACEMARK_POINT_RADIUS_MIN, PLACEMARK_POINT_RADIUS_MAX } from '../track/map-settings.ts'
import { useMapSettings } from './map-settings.tsx'

export interface MapDisplayControlsProps {
  placemarks: readonly TrackPlacemark[]
  typeFilter: PlacemarkTypeFilter
  onTypeFilter?: (next: PlacemarkTypeFilter) => void
  disabled?: boolean
  sandbox?: boolean
  terrain?: boolean
}

export function MapDisplayControls({placemarks, typeFilter, onTypeFilter, disabled = false, sandbox = false, terrain = false}: MapDisplayControlsProps) {
  const {settings, updateSettings} = useMapSettings()
  const [open, setOpen] = useState(false)
  const tools = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const modeField = sandbox ? 'sandboxPlacemarkMode' : 'terrainPlacemarkMode'
  const displayMode = sandbox || terrain ? settings[modeField] : 'point'
  const showTextControls = displayMode === 'marker' || settings.placemarkPointShowName
  const allTypes = useRef<HTMLInputElement>(null)
  const options = useMemo(() => placemarkTypeOptions(placemarks), [placemarks])
  const categories = options.filter(option => option.value !== ALL_PLACEMARK_TYPES)
  const selected = new Set(placemarkTypeValues(typeFilter))
  const all = isAllPlacemarkTypes(typeFilter)
  const selectedCount = all ? categories.length : categories.filter(option => selected.has(option.value)).length
  const allChecked = all || (categories.length > 0 && selectedCount === categories.length)
  useEffect(() => {
    if (allTypes.current) allTypes.current.indeterminate = !allChecked && selectedCount > 0
  }, [open, allChecked, selectedCount])
  const toggleType = (value: string, checked: boolean) => {
    if (disabled || !onTypeFilter) return
    if (value === ALL_PLACEMARK_TYPES) {onTypeFilter(checked ? ALL_PLACEMARK_TYPES : []); return}
    const next = new Set(all ? categories.map(option => option.value) : placemarkTypeValues(typeFilter))
    if (checked) next.add(value); else next.delete(value)
    const values = categories.filter(option => next.has(option.value)).map(option => option.value)
    onTypeFilter(values.length > 0 && values.length === categories.length ? ALL_PLACEMARK_TYPES : values)
  }
  const close = () => {setOpen(false); trigger.current?.focus({preventScroll: true})}
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && !tools.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])
  return <div ref={tools} className="trk-map-display" onKeyDown={event => {
    if (event.key === 'Escape' && open) {event.preventDefault(); event.stopPropagation(); close()}
  }}>
    <button ref={trigger} type="button" data-map-display-trigger className="trk-map-display-trigger"
      aria-label="标记点与路线" title="标记点与路线" aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8.5 21s-5.7-6.6-5.7-11.3a5.7 5.7 0 0 1 11.4 0C14.2 14.4 8.5 21 8.5 21Z"/>
        <circle cx="8.5" cy="9.5" r="2"/>
        <path d="M15.5 4.5H22L19.6 8v3.6l-1.7 1V8l-2.4-3.5Z"/>
      </svg>
      <span className="trk-map-control-label">标记点与路线</span>
    </button>
    {open && <section id={panelId} aria-label="标记点与路线设置" className="trk-map-display-panel">
      <div className="trk-map-display-heading"><strong>标记点与路线</strong>
        <button type="button" className="trk-map-display-close" aria-label="关闭标记点与路线设置" onClick={close}>关闭</button>
      </div>
      <div className="trk-map-display-field"><label htmlFor={`${panelId}-route`}>路线颜色</label>
        <div className="trk-map-display-color"><input id={`${panelId}-route`} type="color" aria-label="路线颜色" value={settings.routeColor} disabled={disabled}
          onChange={event => {if (!disabled) updateSettings({routeColor: event.target.value})}}/>
          <output>{settings.routeColor}</output>
        </div>
      </div>
      {(sandbox || terrain) && <div className="trk-map-display-field"><label htmlFor={`${panelId}-mode`}>显示模式</label>
        <select id={`${panelId}-mode`} className="trk-map-display-mode" aria-label="显示模式" aria-describedby={`${panelId}-mode-help`} value={displayMode} disabled={disabled}
          onChange={event => {
            const value = event.target.value
            if (!disabled && (value === 'point' || value === 'marker')) updateSettings({[modeField]: value})
          }}>
          <option value="point">点位模式</option><option value="marker">标记模式</option>
        </select>
        <small id={`${panelId}-mode-help`} className="trk-map-display-help">点位显示编号色块；标记显示悬浮文字、虚线与小球。</small>
      </div>}
      {displayMode === 'point' && <>
        <div className="trk-map-display-field"><label htmlFor={`${panelId}-point-size`}>点位大小</label>
          <div className="trk-map-display-label-size"><input id={`${panelId}-point-size`} type="range" aria-label="点位大小"
            min={PLACEMARK_POINT_SIZE_MIN} max={PLACEMARK_POINT_SIZE_MAX} step={1} value={settings.placemarkPointSize}
            aria-valuetext={`${settings.placemarkPointSize} px`} disabled={disabled}
            onChange={event => {if (!disabled) updateSettings({placemarkPointSize: Number(event.target.value)})}}/>
            <output htmlFor={`${panelId}-point-size`}>{settings.placemarkPointSize} px</output>
          </div>
        </div>
        {([['placemarkPointColor', '点位颜色'], ['placemarkGroupColor', '分组颜色']] as const).map(([field, label]) =>
          <div key={field} className="trk-map-display-field"><label htmlFor={`${panelId}-${field}`}>{label}</label>
            <div className="trk-map-display-color"><input id={`${panelId}-${field}`} type="color" aria-label={label} value={settings[field]} disabled={disabled}
              onChange={event => {if (!disabled) updateSettings({[field]: event.target.value})}}/>
              <output>{settings[field]}</output>
            </div>
          </div>)}
        <div className="trk-map-display-field"><label htmlFor={`${panelId}-point-radius`}>点位圆角</label>
          <div className="trk-map-display-label-size"><input id={`${panelId}-point-radius`} type="range" aria-label="点位圆角"
            min={PLACEMARK_POINT_RADIUS_MIN} max={PLACEMARK_POINT_RADIUS_MAX} step={1} value={settings.placemarkPointRadius}
            aria-valuetext={`${settings.placemarkPointRadius}%`} aria-describedby={`${panelId}-point-radius-help`} disabled={disabled}
            onChange={event => {if (!disabled) updateSettings({placemarkPointRadius: Number(event.target.value)})}}/>
            <output htmlFor={`${panelId}-point-radius`}>{settings.placemarkPointRadius}%</output>
          </div>
          <small id={`${panelId}-point-radius-help`} className="trk-map-display-help">0% 为方形，50% 为圆形。</small>
        </div>
        <label className="trk-map-display-check"><input type="checkbox" aria-label="显示组内点位数量" checked={settings.placemarkPointShowCount} disabled={disabled}
          onChange={event => {if (!disabled) updateSettings({placemarkPointShowCount: event.target.checked})}}/>显示组内点位数量</label>
        <label className="trk-map-display-check"><input type="checkbox" aria-label="显示名称" checked={settings.placemarkPointShowName} disabled={disabled}
          onChange={event => {if (!disabled) updateSettings({placemarkPointShowName: event.target.checked})}}/>显示名称</label>
      </>}
      {(showTextControls ? displayMode === 'marker' ? [['sandboxLabelColor', '文字颜色'], ['sandboxConnectorColor', '连线颜色']] as const : [['sandboxLabelColor', '文字颜色']] as const : []).map(([field, label]) =>
        <div key={field} className="trk-map-display-field"><label htmlFor={`${panelId}-${field}`}>{label}</label>
          <div className="trk-map-display-color"><input id={`${panelId}-${field}`} type="color" aria-label={label} value={settings[field]} disabled={disabled}
            onChange={event => {if (!disabled) updateSettings({[field]: event.target.value})}}/>
            <output>{settings[field]}</output>
          </div>
        </div>)}
      {showTextControls && <div className="trk-map-display-field"><label htmlFor={`${panelId}-label-size`}>文字大小</label>
        <div className="trk-map-display-label-size"><input id={`${panelId}-label-size`} type="range" aria-label="文字大小"
          min={SANDBOX_LABEL_SIZE_MIN} max={SANDBOX_LABEL_SIZE_MAX} step={1} value={settings.sandboxLabelSize}
          aria-valuetext={`${settings.sandboxLabelSize} px`} disabled={disabled}
          onChange={event => {if (!disabled) updateSettings({sandboxLabelSize: Number(event.target.value)})}}/>
          <output htmlFor={`${panelId}-label-size`}>{settings.sandboxLabelSize} px</output>
        </div>
      </div>}
      {displayMode === 'marker' && <div className="trk-map-display-field"><label htmlFor={`${panelId}-label-height`}>文字高度</label>
        <div className="trk-map-display-label-size"><input id={`${panelId}-label-height`} type="range" aria-label="文字高度"
          min={SANDBOX_LABEL_HEIGHT_MIN} max={SANDBOX_LABEL_HEIGHT_MAX} step={.1} value={settings.sandboxLabelHeight}
          aria-valuetext={`默认高度的 ${Math.round(settings.sandboxLabelHeight * 100)}%`} aria-describedby={`${panelId}-label-height-help`} disabled={disabled}
          onChange={event => {if (!disabled) updateSettings({sandboxLabelHeight: Number(event.target.value)})}}/>
          <output htmlFor={`${panelId}-label-height`}>{Math.round(settings.sandboxLabelHeight * 100)}%</output>
        </div>
        <small id={`${panelId}-label-height-help`} className="trk-map-display-help">调整文字与点位的距离，100% 为默认高度。</small>
      </div>}
      <fieldset className="trk-map-display-types"><legend>标记点类型</legend>
        {options.map(option => <label key={option.value} className="trk-map-display-type-option">
          <input type="checkbox" aria-label={option.label} data-placemark-type={option.value}
            ref={option.value === ALL_PLACEMARK_TYPES ? allTypes : undefined}
            checked={option.value === ALL_PLACEMARK_TYPES ? allChecked : all || selected.has(option.value)}
            disabled={disabled || !onTypeFilter} onChange={event => toggleType(option.value, event.target.checked)}/>
          <span>{option.label}（{option.count}）</span>
        </label>)}
      </fieldset>
      <label className="trk-map-display-check"><input type="checkbox" aria-label="显示标记点" checked={settings.sandboxPlacemarks}
        onChange={event => updateSettings({sandboxPlacemarks: event.target.checked})}/>显示标记点</label>
    </section>}
    <style>{CSS}</style>
  </div>
}

const CSS = `

.trk-map-display{display:contents}.trk-map-dock .trk-map-display-trigger{width:var(--trk-control-height,32px);height:var(--trk-control-height,32px);min-height:var(--trk-control-height,32px);padding:6px;border-top:1px solid var(--trk-border);border-top-left-radius:0;border-top-right-radius:0}.trk-map-display-trigger svg{width:18px;height:18px}.trk-map-display-trigger:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-map-display-panel{position:absolute;right:calc(var(--trk-control-height,32px) + 10px);top:0;width:min(300px,calc(100% - var(--trk-control-height,32px) - 10px));max-width:calc(100% - var(--trk-control-height,32px) - 10px);max-height:100%;overflow:auto;box-sizing:border-box;padding:0 10px 10px;pointer-events:auto;z-index:6;background:var(--trk-overlay);color:var(--trk-overlay-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);box-shadow:0 4px 16px var(--trk-shadow);font-size:var(--trk-ui-font-size,13px)}
.trk-map-display-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:36px;margin:0 -10px 8px;padding:2px 10px;border-bottom:1px solid var(--trk-border)}.trk-map-display-heading strong{font-size:13px;font-weight:600}.trk-map-display .trk-map-display-panel button{display:inline-flex;align-items:center;justify-content:center;width:auto;height:auto;min-width:var(--trk-control-height,32px);min-height:var(--trk-control-height,32px);padding:4px 7px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-surface);color:var(--trk-overlay-text);font:inherit;font-size:12px;cursor:pointer}.trk-map-display .trk-map-display-panel button:hover{background:var(--trk-hover)}
.trk-map-display-field{display:grid;grid-template-columns:88px minmax(0,1fr);align-items:center;gap:6px 8px;margin:7px 0;font-size:var(--trk-ui-label-size,12px)}.trk-map-display-field>span,.trk-map-display-field>label{display:block;margin:0;color:var(--trk-muted)}.trk-map-display-color{display:flex;align-items:center;gap:7px}.trk-map-display-color input{width:var(--trk-control-height,32px);height:var(--trk-input-height,30px);min-height:var(--trk-input-height,30px);box-sizing:border-box;padding:2px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);cursor:pointer}.trk-map-display-color output{font:11px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}.trk-map-display-types{margin:8px 0;padding:7px 0 0;border:0;border-top:1px solid var(--trk-border);min-width:0;max-height:180px;overflow:auto;font-size:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 6px}.trk-map-display-types legend{padding:0 5px 0 0;font-weight:600;color:var(--trk-muted)}.trk-map-display-type-option{display:flex;align-items:center;gap:6px;min-height:36px;padding:3px 5px;box-sizing:border-box;cursor:pointer;border-left:2px solid transparent}.trk-map-display-type-option:has(input:checked){background:var(--trk-active);border-left-color:var(--trk-accent)}.trk-map-display-type-option input{width:16px;height:16px;margin:0;flex-shrink:0;accent-color:var(--trk-accent)}.trk-map-display-type-option span{overflow-wrap:anywhere}.trk-map-display-type-option:has(input:disabled){cursor:default}.trk-map-display-check{display:flex;align-items:center;gap:6px;min-height:var(--trk-control-height,32px);font-size:12px;cursor:pointer}.trk-map-display-check:has(input:disabled){cursor:default}.trk-map-display-check input{width:16px;height:16px;margin:0;accent-color:var(--trk-accent)}
.trk-map-display-label-size{display:flex;align-items:center;gap:7px}.trk-map-display-label-size input{width:100%;min-width:0;min-height:var(--trk-input-height,30px);margin:0;accent-color:var(--trk-accent);cursor:pointer}.trk-map-display-label-size output{flex-shrink:0;white-space:nowrap;font:11px/1.5 ui-monospace,monospace}
.trk-map-display-mode{width:100%;min-width:0;min-height:var(--trk-input-height,30px);box-sizing:border-box;padding:4px 7px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-bg);color:var(--trk-overlay-text);font:inherit;font-size:12px}.trk-map-display-help{display:block;grid-column:1/-1;font-size:11px;line-height:1.5;color:var(--trk-muted)}
.trk-map-display-panel input:focus-visible,.trk-map-display-panel select:focus-visible,.trk-map-display-panel button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-map-display-panel input:disabled,.trk-map-display-panel select:disabled{opacity:.5;cursor:default}
@container(max-width:750px){.trk-map-dock .trk-map-display-trigger{width:44px;height:44px;min-height:44px}.trk-map-display .trk-map-display-panel button,.trk-map-display-type-option,.trk-map-display-check{min-height:44px}.trk-map-display-color input,.trk-map-display-mode,.trk-map-display-label-size input{min-height:40px}.trk-map-display-color input{height:40px;width:44px}}
@container(max-width:500px){.trk-map-display-panel{right:54px;top:calc(var(--trk-map-toolbar-bottom,72px) - 10px);width:min(300px,calc(100% - 54px));max-width:calc(100% - 54px);max-height:calc(100% - var(--trk-map-toolbar-bottom,72px) + 10px)}}
@media(pointer:coarse){.trk-map-dock .trk-map-display-trigger{width:44px;height:44px;min-height:44px}.trk-map-display .trk-map-display-panel button,.trk-map-display-type-option,.trk-map-display-check{min-height:44px}.trk-map-display-color input,.trk-map-display-mode,.trk-map-display-label-size input{min-height:40px}.trk-map-display-color input{height:40px;width:44px}}
@media(forced-colors:active){.trk-map-display-panel{background:var(--trk-overlay);color:var(--trk-overlay-text);border-color:var(--trk-border)}}

`
