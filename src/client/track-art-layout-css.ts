/** Compact SVG workbench; use the host theme and preserve one mounted canvas. */
export const ART_LAYOUT_CSS=`
.trk-art{min-width:0;font-size:var(--trk-ui-font-size,13px)}
.trk-art-head{margin-bottom:0;padding:8px 10px;border:1px solid var(--trk-border);border-bottom:0;background:var(--trk-surface)}.trk-art-head p{margin:0;font-size:var(--trk-ui-label-size,12px)}
.trk-art-status{margin:0;font-size:var(--trk-ui-label-size,12px);line-height:1.5;padding:6px 10px;border:1px solid var(--trk-border);border-bottom:0}
.trk-art-toolbar{position:relative;gap:6px 10px;padding:8px 10px;margin:0;border:1px solid var(--trk-border);border-bottom:0;background:var(--trk-surface)}
.trk-art-tool-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.trk-art .trk-art-toolbar button{font-size:var(--trk-ui-label-size,12px);padding:5px 8px;white-space:nowrap}
.trk-art-history-tools{padding-left:14px;border-left:1px solid var(--trk-border)}
.trk-art-view-tools{margin-left:auto}
.trk-art .trk-art-view-tools label{display:flex;flex-direction:row;align-items:center;gap:7px;margin:0;font-size:var(--trk-ui-label-size,12px);white-space:nowrap}
.trk-art-view-tools select{width:96px;min-width:0;font-size:inherit}
.trk-art-help{font-size:var(--trk-ui-label-size,12px);color:var(--trk-muted)}
.trk-art .trk-art-help summary{display:flex;align-items:center;justify-content:center;min-height:var(--trk-control-height,32px);padding:5px 8px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-surface);list-style:none}
.trk-art-help p{position:absolute;right:0;top:100%;z-index:8;width:300px;max-width:100%;margin:0;padding:10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-surface);color:var(--trk-text);box-shadow:0 8px 24px var(--trk-shadow);line-height:1.7}
.trk-art-workspace{grid-template-columns:minmax(0,1fr) 304px;height:clamp(480px,65vh,760px);min-height:0;align-items:stretch}
.trk-art-workspace .trk-art-board{min-height:0;height:100%;min-width:0;padding:20px}
.trk-art-workspace .trk-art-scene{width:min(100%,calc((clamp(480px,65vh,760px) - 40px) * var(--trk-art-ratio,1.333333)))}
.trk-art-sidebar{min-width:0;overflow:auto}
.trk-art .trk-art-files,.trk-art .trk-art-canvas-settings fieldset{min-width:0;margin:0;padding:10px;border:0;flex-shrink:0}
.trk-art-files{border-bottom:1px solid var(--trk-border)!important}
.trk-art-files-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:var(--trk-ui-label-size,12px)}
.trk-art-files-head>span{font-size:var(--trk-ui-label-size,12px)}.trk-art-unsaved{color:var(--trk-notice)}
.trk-art-file-actions,.trk-art-export-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px}
.trk-art .trk-art-file-actions button,.trk-art .trk-art-export-actions button{min-width:0;padding:5px 8px;font-size:var(--trk-ui-label-size,12px);white-space:nowrap}
.trk-art .trk-art-file-actions .trk-primary{background:var(--trk-primary-bg);color:var(--trk-on-accent);border-color:var(--trk-accent);font-weight:650}.trk-art .trk-art-file-actions .trk-primary:hover:not(:disabled){background:var(--trk-primary-bg);color:var(--trk-on-accent)}
.trk-art .trk-art-export-options summary{padding:6px 0 0;font-size:var(--trk-ui-label-size,12px);color:var(--trk-muted)}
.trk-art-export-actions{margin-top:10px}.trk-art .trk-art-export-note{font-size:var(--trk-ui-label-size,12px);line-height:1.6;margin:8px 0 0}
.trk-art-canvas-settings{border-bottom:1px solid var(--trk-border);flex-shrink:0}
.trk-art .trk-art-canvas-settings>summary{display:flex;align-items:center;gap:8px;padding:6px 10px;min-height:var(--trk-control-height,32px);font-size:var(--trk-ui-label-size,12px);list-style:none}
.trk-art-canvas-settings>summary:before{content:'›';font-size:16px}.trk-art-canvas-settings[open]>summary:before{transform:rotate(90deg)}
.trk-art-canvas-settings>summary>span{margin-left:auto;font-size:var(--trk-ui-label-size,12px);white-space:nowrap}
.trk-art .trk-art-canvas-settings fieldset{padding-top:0}
.trk-art-size{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:end;gap:8px;padding:0}
.trk-art .trk-art-size label{display:grid;gap:5px;margin:0;font-size:var(--trk-ui-label-size,12px)}
.trk-art-size label:first-child{grid-column:1/-1}.trk-art-size input,.trk-art-size select{width:100%;min-width:0}
.trk-art .trk-art-size button{min-width:0;font-size:var(--trk-ui-label-size,12px);padding:5px 8px}
.trk-art-size>span{grid-column:1/-1;font-size:var(--trk-ui-label-size,12px);text-align:right}
.trk-art-sidebar-head{flex-shrink:0;padding:8px 10px}.trk-art-sidebar-head h3{font-size:var(--trk-ui-label-size,12px)}
.trk-art .trk-art-sidebar-head button{font-size:var(--trk-ui-label-size,12px);padding:5px 8px}
.trk-art-point-list{min-height:110px;max-height:none;padding:8px;flex:1 1 0}
.trk-art .trk-art-point{min-width:0;padding:6px 8px;gap:8px;min-height:52px;border-color:transparent;border-radius:0}
.trk-art-point strong{font-size:var(--trk-ui-label-size,12px)}.trk-art-point small{font-size:var(--trk-ui-label-size,12px);line-height:1.5;margin-top:3px}
.trk-art .trk-art-sidebar-footer{flex-shrink:0;font-size:var(--trk-ui-label-size,12px);line-height:1.6;padding:8px 10px;margin:0}
.trk-art summary:focus-visible,.trk-art select:focus-visible,.trk-art input:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
@container(max-width:1050px){.trk-art-view-tools{margin-left:0}.trk-art-help{margin-left:auto}}
@container(max-width:760px){.trk-art-workspace{grid-template-columns:1fr;height:auto}.trk-art-workspace .trk-art-board{height:auto;min-height:360px;padding:14px}.trk-art-workspace .trk-art-scene{width:min(100%,calc(clamp(280px,46vh,520px) * var(--trk-art-ratio,1.333333)))}.trk-art-sidebar{border-left:0;border-top:1px solid var(--trk-border);max-height:600px}.trk-art-point-list{flex-basis:auto;max-height:260px}.trk-art-history-tools{padding-left:0;border-left:0}.trk-art-toolbar{gap:8px}.trk-art-view-tools{width:100%;justify-content:space-between}.trk-art-help{margin-left:0}.trk-art-toolbar>.trk-art-tool-group{gap:6px}}
@container(max-width:420px){.trk-art .trk-art-toolbar button{padding:9px 8px}.trk-art-workspace .trk-art-board{padding:10px;min-height:300px}.trk-art-view-tools label{flex:1}.trk-art-view-tools select{width:90px}.trk-art-tool-group{gap:5px}}

.trk-art button{min-height:var(--trk-control-height,32px);font-size:var(--trk-ui-label-size,12px);padding:5px 9px}.trk-art input:not([type=color]),.trk-art select{min-height:var(--trk-input-height,30px);font-size:var(--trk-ui-label-size,12px);padding:4px 7px}.trk-art h2{font-size:16px}.trk-art-workspace{border-radius:0}.trk-art .trk-point-drawer>header,.trk-art .trk-point-drawer>footer{padding:10px}.trk-art .trk-point-drawer fieldset{padding:10px;gap:10px}.trk-art .trk-point-drawer label{font-size:var(--trk-ui-label-size,12px)}.trk-art .trk-point-drawer h3{font-size:14px}.trk-art textarea{font-size:var(--trk-ui-label-size,12px);padding:6px 8px}
@container(max-width:760px){.trk-art button,.trk-art .trk-art-help summary,.trk-art .trk-art-canvas-settings>summary{min-height:44px}.trk-art input:not([type=color]),.trk-art select{min-height:40px}.trk-art-tool-group{gap:8px}}
@media(pointer:coarse){.trk-art button,.trk-art .trk-art-help summary,.trk-art .trk-art-canvas-settings>summary{min-height:44px}.trk-art input:not([type=color]),.trk-art select{min-height:40px}.trk-art-tool-group{gap:8px}}
`
