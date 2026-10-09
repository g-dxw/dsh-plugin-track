/** Track-owned accessibility and interaction layer for the native Backlot UI.
 * Native nodes, click handlers, project data and media remain owned by Backlot.
 */
const stageNames = {research: '背景调查', proposal: '制作方案', idea: '需求与大纲', script: '脚本', scene_plan: '分镜', assets: '素材', edit: '剪辑', compose: '合成', publish: '发布'};
const controlSelector = '.rail .stage, .script-preview, .drawer-head .close, .modal-close, .replay-bar .rp-btn, .narr, .thumb.approved, .wave, .render-meta .v';
const marker = 'data-track-backlot-control';
const installations = new WeakMap();

function describeControl(node, doc) {
  // Backlot's el() attaches most handlers with addEventListener, which is not
  // observable through .onclick. Its fixed control markup is the contract.
  const index = selector => [...doc.querySelectorAll(selector)].indexOf(node);
  const scene = node.closest('.scene-card')?.querySelector('.sc-slate .num')?.textContent?.trim();
  const sceneKey = scene || String(index(node.matches('.narr') ? '.narr' : node.matches('.wave') ? '.wave' : '.thumb.approved'));
  if (node.matches('.rail .stage')) {
    const name = node.querySelector('.name')?.textContent?.trim() || '制作';
    return {key: `stage:${index('.rail .stage')}`, label: `查看${stageNames[name] || name}阶段成果`, expanded: node.classList.contains('selected')};
  }
  if (node.matches('.script-preview')) return {key: 'script-preview', label: '展开完整脚本', modal: true};
  if (node.matches('.drawer-head .close')) return {key: 'drawer-close', label: '关闭阶段详情'};
  if (node.matches('.modal-close')) return {key: 'modal-close', label: '关闭详情'};
  if (node.matches('.replay-bar .rp-btn')) {
    const text = node.textContent?.trim() || '';
    if (/REPLAY|回放制作过程/u.test(text)) return {key: 'replay-start', label: '回放制作过程'};
    if (/LIVE|返回当前状态/u.test(text)) return {key: 'replay-live', label: '返回当前制作状态'};
    return {key: 'replay-toggle', label: /❚❚|暂停/u.test(text) ? '暂停制作回放' : '播放制作回放'};
  }
  if (node.matches('.narr[title]:not(.tc-note)')) return {key: `narr:${sceneKey}`, label: `${scene ? `${scene}：` : ''}阅读完整旁白`, modal: true};
  // These two optional native controls do assign .onclick directly. Require
  // that handler so static images and decorative audio bars stay static.
  if (node.matches('.wave') && typeof node.onclick === 'function') return {key: `wave:${sceneKey}`, label: `${scene ? `${scene}：` : ''}播放旁白`};
  if (node.matches('.thumb.approved') && node.querySelector('video') && typeof node.onclick === 'function') return {key: `video:${sceneKey}`, label: `${scene ? `${scene}：` : ''}播放或暂停镜头视频`};
  if (node.matches('.render-meta .v')) return {key: `render:${index('.render-meta .v')}`, label: `查看输出版本：${node.textContent?.trim() || '视频'}`, pressed: node.classList.contains('active')};
  return null;
}

/** Enrich Backlot's native control markup; display-only thumbnails stay static. */
export function enhanceBacklotUi(doc = document) {
  let changed = 0;
  const set = (node, name, value) => {
    if (node.getAttribute(name) !== value) {node.setAttribute(name, value); changed += 1;}
  };
  for (const node of doc.querySelectorAll(controlSelector)) {
    const control = describeControl(node, doc);
    if (!control) continue;
    set(node, marker, control.key);
    if (!node.matches('button, input, select, textarea, a[href]')) {set(node, 'role', 'button'); set(node, 'tabindex', '0');}
    set(node, 'aria-label', control.label);
    if ('expanded' in control) set(node, 'aria-expanded', String(control.expanded));
    if ('pressed' in control) set(node, 'aria-pressed', String(control.pressed));
    if (control.modal) {set(node, 'aria-haspopup', 'dialog'); if (doc.getElementById('modal')) set(node, 'aria-controls', 'modal');}
  }
  const slider = doc.querySelector('.replay-bar input[type="range"]');
  if (slider) set(slider, 'aria-label', '定位制作回放时间');
  return changed;
}

function focusedControl(node) {
  if (!node?.getAttribute) return null;
  const key = node.getAttribute(marker) || (node.matches('.theme-toggle') ? 'theme-toggle' : node.matches('.replay-bar input[type="range"]') ? 'replay-position' : null);
  return key ? {node, key} : null;
}
function findControl(doc, key) {
  if (key === 'theme-toggle') return doc.querySelector('.theme-toggle');
  if (key === 'replay-position') return doc.querySelector('.replay-bar input[type="range"]');
  const controls = [...doc.querySelectorAll(`[${marker}]`)];
  const match = controls.find(node => node.getAttribute(marker) === key);
  if (match) return match;
  // The entry button becomes play/pause on start and returns after leaving replay.
  const fallback = key === 'replay-start' ? 'replay-toggle' : ['replay-toggle', 'replay-live'].includes(key) ? 'replay-start' : null;
  return fallback ? controls.find(node => node.getAttribute(marker) === fallback) || null : null;
}
function focus(node) {
  if (!node?.isConnected || typeof node.focus !== 'function') return;
  node.focus({preventScroll: true});
}

/** Install once; native re-rendering keeps keyboard actions and focused controls. */
export function startBacklotUi(doc = document) {
  const existing = installations.get(doc);
  if (existing) return existing;
  const view = doc.defaultView;
  if (!view?.MutationObserver || !doc.documentElement) return () => {};
  let active = true, suspended = false, queued = false;
  let lastFocus = null, opener = null, modalWasOpen = false, pendingTheme = null, drawerReturn = null;
  let observer;
  const reconnect = () => {
    if (active && !suspended) observer.observe(doc.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
  };
  const recoverFocus = () => {
    if (lastFocus && !lastFocus.node.isConnected && (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)) {
      focus(findControl(doc, lastFocus.key));
    }
  };
  const restoreOpener = modal => {
    const current = doc.activeElement;
    if (opener && (!current || current === doc.body || modal?.contains(current))) {
      focus(opener.node?.isConnected ? opener.node : opener.key ? findControl(doc, opener.key) : null);
    }
    opener = null;
  };
  const refresh = () => {
    if (!active || suspended) return;
    observer.disconnect();
    try {
      if (pendingTheme) {
        if (doc.documentElement.dataset.theme === pendingTheme) pendingTheme = null;
        else {
          const toggle = doc.querySelector('.theme-toggle');
          // Click Backlot's own button so its closure and persisted theme agree.
          if (toggle) {pendingTheme = null; toggle.click();}
        }
      }
      enhanceBacklotUi(doc);
      const modal = doc.getElementById('modal'), open = Boolean(modal?.classList.contains('open'));
      if (open) {
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '脚本与镜头详情'); modal.setAttribute('tabindex', '-1');
        if (!modalWasOpen) {
          if (!opener && doc.activeElement && doc.activeElement !== doc.body && !modal.contains(doc.activeElement)) {
            opener = focusedControl(doc.activeElement) || {node: doc.activeElement, key: null};
          }
          focus(modal.querySelector('.modal-close') || modal);
        } else recoverFocus();
      } else if (modalWasOpen) restoreOpener(modal);
      else if (drawerReturn && !doc.querySelector('.drawer')) {
        if (doc.activeElement === doc.body || doc.activeElement === doc.documentElement) focus(findControl(doc, drawerReturn));
        drawerReturn = null;
      } else recoverFocus();
      modalWasOpen = open;
    } finally {reconnect();}
  };
  observer = new view.MutationObserver(() => {
    if (!active || queued || suspended) return;
    queued = true;
    Promise.resolve().then(() => {queued = false; refresh();});
  });
  const onFocus = event => {if (active && !suspended) lastFocus = focusedControl(event.target);};
  const onPointer = event => {
    if (!active || suspended) return;
    // Clicking another location is intentional; do not resurrect the old focus.
    if (lastFocus && !lastFocus.node.contains(event.target)) lastFocus = null;
  };
  const onClick = event => {
    if (!active || suspended || modalWasOpen) return;
    if (event.target?.closest?.('.drawer-head .close')) drawerReturn = doc.querySelector('.rail .stage.selected')?.getAttribute(marker) || null;
    const node = event.target?.closest?.(`[${marker}][aria-haspopup="dialog"]`);
    if (node) opener = focusedControl(node);
  };
  const onKey = event => {
    if (!active || suspended) return;
    const modal = doc.getElementById('modal');
    if (event.key === 'Tab' && modal?.classList.contains('open')) {
      const choices = [...modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden], [aria-hidden="true"]'));
      const first = choices[0] || modal, last = choices[choices.length - 1] || modal;
      if (!choices.length || !modal.contains(doc.activeElement) || (event.shiftKey && doc.activeElement === first) || (!event.shiftKey && doc.activeElement === last)) {
        event.preventDefault(); focus(event.shiftKey ? last : first);
      }
      return;
    }
    if (!['Enter', ' ', 'Spacebar'].includes(event.key) || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const node = event.target?.closest?.(`[${marker}]`);
    if (!node || node.matches('button, input, select, textarea, a[href]')) return;
    if (event.target !== node && event.target.closest?.('button, input, select, textarea, a[href], [contenteditable="true"]')) return;
    event.preventDefault(); node.click();
  };
  const onMessage = event => {
    if (!active || suspended || view.parent === view || event.source !== view.parent) return;
    const value = event.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (value.type === 'track-openmontage-visibility') {
      if (value.visible !== false) return;
      for (const media of doc.querySelectorAll('video, audio')) media.pause();
      // Native replay rebuilds the board while playing. Its own toggle stops
      // that work without changing the project or resuming on visibility true.
      const playing = [...doc.querySelectorAll('.replay-bar .rp-btn')].find(node => /❚❚/u.test(node.textContent || ''));
      playing?.click();
      return;
    }
    if (value.type !== 'track-openmontage-theme' || !['light', 'dark'].includes(value.theme)) return;
    pendingTheme = value.theme; refresh();
  };
  const dispose = () => {
    if (!active) return;
    active = false; observer.disconnect();
    doc.removeEventListener('focusin', onFocus); doc.removeEventListener('pointerdown', onPointer, true); doc.removeEventListener('click', onClick, true); doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('DOMContentLoaded', refresh); view.removeEventListener('message', onMessage); view.removeEventListener('pagehide', onPageHide); view.removeEventListener('pageshow', onPageShow);
    if (modalWasOpen) restoreOpener(doc.getElementById('modal'));
    lastFocus = null; pendingTheme = null; drawerReturn = null; installations.delete(doc);
  };
  const onPageHide = event => {if (event.persisted) {suspended = true; observer.disconnect();} else dispose();};
  const onPageShow = () => {if (active && suspended) {suspended = false; refresh();}};
  installations.set(doc, dispose);
  doc.addEventListener('focusin', onFocus); doc.addEventListener('pointerdown', onPointer, true); doc.addEventListener('click', onClick, true); doc.addEventListener('keydown', onKey);
  doc.addEventListener('DOMContentLoaded', refresh, {once: true}); view.addEventListener('message', onMessage); view.addEventListener('pagehide', onPageHide); view.addEventListener('pageshow', onPageShow);
  refresh();
  return dispose;
}

export function stopBacklotUi(doc = document) {installations.get(doc)?.();}
if (typeof document !== 'undefined') startBacklotUi(document);
