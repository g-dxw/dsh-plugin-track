export const VIDEO_WORKSPACE_CSS = `
.trk-video-workspace{min-width:0}.trk-video-workspace [hidden]{display:none!important}
.trk-video-navigation{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;border-bottom:1px solid var(--trk-border);padding-bottom:10px;flex-wrap:wrap}
.trk-video-navigation nav,.trk-video-scenes{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.trk-video-navigation [role=tab],.trk-video-scenes button{min-height:44px;min-width:72px;padding:9px 14px;border:1px solid transparent;border-radius:var(--trk-radius-sm);color:var(--trk-muted);background:transparent;font:inherit;cursor:pointer}
.trk-video-navigation [role=tab][aria-selected=true],.trk-video-scenes button[aria-pressed=true]{background:var(--trk-active);color:var(--trk-accent);border-color:var(--trk-accent);font-weight:650}
.trk-video-navigation button:focus-visible,.trk-video-scenes button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
.trk-video-scenes{margin:0 0 12px;font-size:calc(var(--trk-font-size)*.9286)}.trk-video-scenes>span{color:var(--trk-muted);margin-right:4px}
.trk-video-workspace button:disabled{cursor:not-allowed;opacity:.5}
.trk-video-shot-scope{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;background:var(--trk-surface);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);font-size:13px}.trk-video-shot-scope button{min-height:44px;padding:8px 12px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-surface);color:var(--trk-text);font:inherit;cursor:pointer}.trk-video-shot-scope button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}
@container(max-width:480px){.trk-video-navigation{gap:8px}.trk-video-navigation nav{gap:4px}.trk-video-navigation [role=tab]{padding:9px 10px;min-width:0}.trk-video-scenes{gap:6px}}
`
