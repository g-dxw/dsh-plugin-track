import { useEffect, useId, useRef, useState } from 'react'
import { DEFAULT_MAP_SETTINGS, type SandboxLighting } from '../track/map-settings.ts'
import { useMapSettings } from './map-settings.tsx'

export function SandboxLightingControls({dock = false}: {dock?: boolean} = {}) {
  const {settings, updateSettings} = useMapSettings()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const tools = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => {setOpen(false); trigger.current?.focus({preventScroll: true})}
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {if (event.target instanceof Node && !tools.current?.contains(event.target)) setOpen(false)}
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside)}
  }, [open])
  const change = (key: keyof SandboxLighting, value: number | boolean) =>
    updateSettings({lighting: {...settings.lighting, [key]: value}})
  const panel = open && <section id={id} className="trk-lighting-panel" aria-label="沙盘光影设置">
    <div className="trk-lighting-heading"><strong>光影</strong><button type="button" aria-label="关闭光影面板" onClick={close}>关闭</button></div>
    {([
      ['azimuth', '太阳方位角', 0, 360, 1, '°'],
      ['elevation', '太阳高度角', 5, 85, 1, '°'],
      ['intensity', '主光强度', 0, 5, 0.1, ''],
      ['ambient', '环境光强度', 0, 2, 0.05, ''],
    ] as const).map(([key, label, min, max, step, unit]) => <label key={key}>
      <span>{label}<output>{Number(settings.lighting[key].toFixed(2))}{unit}</output></span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={settings.lighting[key]}
        onChange={event => change(key, Number(event.target.value))}/>
    </label>)}
    <label className="trk-lighting-check"><input type="checkbox" aria-label="地形阴影" disabled={settings.quality === 'eco'}
      checked={settings.lighting.shadows && settings.quality !== 'eco'} onChange={event => change('shadows', event.target.checked)}/>地形阴影</label>
    {settings.quality === 'eco' && <p>节能档关闭阴影，切换标准或精细档可开启。</p>}
    <p>方位：北 0° · 东 90°。调节即时生效。</p>
    <button type="button" onClick={() => updateSettings({lighting: {...DEFAULT_MAP_SETTINGS.lighting}})}>恢复默认光影</button>
  </section>
  return <div className={`trk-lighting${dock ? ' trk-lighting-dock' : ''}`} ref={tools} onKeyDown={event => {
    if (event.key === 'Escape' && open) {event.preventDefault(); event.stopPropagation(); close()}
  }}>
    <button ref={trigger} className="trk-lighting-trigger" type="button" aria-label="光影" title="光影" aria-expanded={open} aria-controls={id} onClick={() => {
      setOpen(value => !value)
    }}>{dock ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><span className="trk-map-control-label">光影</span></> : '光影'}</button>
    {panel}
    <style>{CSS}</style>
  </div>
}

const CSS = `
.trk-lighting{display:contents}.trk-lighting-trigger{position:absolute;right:14px;top:calc(var(--trk-map-toolbar-bottom,82px) + 4px);min-height:44px;padding:8px 12px;border:0;border-radius:var(--trk-radius-sm);background:transparent;color:var(--trk-text);font:inherit;cursor:pointer;z-index:5}.trk-lighting-trigger:hover{background:var(--trk-active)}.trk-lighting-trigger:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-lighting-panel{position:absolute;right:64px;top:calc(var(--trk-map-toolbar-bottom,82px) + 60px);width:280px;max-width:calc(100% - 84px);max-height:calc(100% - var(--trk-map-toolbar-bottom,82px) - 110px);overflow:auto;box-sizing:border-box;padding:12px;background:var(--trk-overlay);color:var(--trk-text);border:1px solid var(--trk-border);border-radius:var(--trk-radius-md);box-shadow:0 8px 28px #0003;z-index:6}
.trk-lighting-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.trk-lighting-panel label{display:block;margin:10px 0}.trk-lighting-panel label>span{display:flex;justify-content:space-between;gap:8px;font-size:13px}.trk-lighting-panel output{font-variant-numeric:tabular-nums}.trk-lighting-panel input[type=range]{width:100%;height:32px;accent-color:var(--trk-accent);cursor:pointer}.trk-lighting-panel .trk-lighting-check{display:flex;align-items:center;gap:8px;min-height:36px}.trk-lighting-panel p{font-size:12px;line-height:1.5;margin:6px 0;color:var(--trk-muted)}.trk-lighting-panel input:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-lighting-panel button{min-height:44px;padding:8px 12px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);color:var(--trk-text);font:inherit;cursor:pointer}.trk-lighting-panel button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-lighting-dock .trk-lighting-trigger{position:static;z-index:auto;width:44px;padding:8px;border-top:1px solid var(--trk-border);border-radius:0;background:transparent}.trk-lighting-dock .trk-lighting-panel{left:auto;right:54px;top:0;bottom:auto;width:min(280px,calc(100% - 54px));max-width:calc(100% - 54px);max-height:100%}
@container(max-width:500px){.trk-lighting-dock .trk-lighting-panel{top:calc(var(--trk-map-toolbar-bottom,72px) - 10px);max-height:calc(100% - var(--trk-map-toolbar-bottom,72px) + 10px)}.trk-lighting-panel{left:10px;right:64px;bottom:44px;top:auto;width:auto;max-width:none;max-height:min(360px,calc(100% - var(--trk-map-toolbar-bottom,82px) - 110px));border-radius:var(--trk-radius-lg);z-index:6}}
`
