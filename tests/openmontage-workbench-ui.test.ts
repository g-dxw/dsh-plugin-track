// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {enhanceBacklotUi, startBacklotUi, stopBacklotUi} from '../scripts/openmontage_ui.js'

const find = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const nativeHandlers = new WeakMap<HTMLElement, (event: Event) => void>()
// This is how native Backlot lib.js el() installs onclick attributes. A real
// native control therefore has .onclick === null even though clicks work.
function nativeClick(node: HTMLElement, handler: (event: Event) => void = vi.fn()) {node.addEventListener('click', handler); nativeHandlers.set(node, handler); return handler}
async function flush() {await Promise.resolve(); await Promise.resolve(); await Promise.resolve()}
function key(node: HTMLElement, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {key: value, bubbles: true, cancelable: true, ...options}); node.dispatchEvent(event); return event
}
function stage(name = 'idea', selected = false) {
  const node = document.createElement('div'); node.className = `stage${selected ? ' selected' : ''}`
  node.innerHTML = `<span class="name">${name}</span><span class="sub">awaiting_human</span>`; nativeClick(node); return node
}
const originalParent = Object.getOwnPropertyDescriptor(window, 'parent')!
beforeEach(() => {stopBacklotUi(document); document.body.innerHTML = '<div id="app"></div><div id="modal" class="modal-bg"></div>'; document.documentElement.dataset.theme = 'dark'})
afterEach(() => {stopBacklotUi(document); document.body.innerHTML = ''; Object.defineProperty(window, 'parent', originalParent); vi.restoreAllMocks()})

it('decorates native controls in place and leaves authored content, JSON and non-clickable media alone', () => {
  find('#app').innerHTML = '<nav class="rail"></nav><div class="script-preview"><div class="sp-action">Storyboard</div></div><div class="drawer-head"><span class="close">CLOSE</span></div><div class="scene-card"><div class="sc-slate"><span class="num">SC01</span></div><div class="thumb approved"><video src="/media/a.mp4"></video></div><div class="thumb approved" id="image"><img src="/media/a.jpg"></div><div class="narr" title="Click to read the full narration">Original narration</div><div class="narr tc-note" id="note" title="An authored tooltip">An authored note</div><div class="narr" id="static">Static narration note</div><div class="wave"></div><div class="takes"><span class="tk" title="take 2"></span></div></div><pre>{"stage":"idea"}</pre>'
  const node = stage('scene_plan', true); find('.rail').append(node)
  const preview = find('.script-preview'), handler = vi.fn(); nativeClick(preview, handler)
  for (const selector of ['.drawer-head .close', '.narr[title]:not(.tc-note)']) nativeClick(find(selector))
  for (const selector of ['.thumb:has(video)', '.wave']) find(selector).onclick = vi.fn()
  expect(enhanceBacklotUi()).toBeGreaterThan(0); expect(enhanceBacklotUi()).toBe(0)
  expect(find('.stage')).toBe(node); expect(node.getAttribute('aria-expanded')).toBe('true'); expect(node.getAttribute('aria-label')).toBe('查看分镜阶段成果')
  expect(preview.onclick).toBeNull(); preview.click(); expect(handler).toHaveBeenCalledOnce(); expect(preview.getAttribute('aria-haspopup')).toBe('dialog')
  expect(find('.thumb:has(video)').getAttribute('aria-label')).toBe('SC01：播放或暂停镜头视频')
  for (const selector of ['#image', '#note', '#static', '.tk']) expect(find(selector).hasAttribute('role')).toBe(false)
  expect(find('.sp-action').textContent).toBe('Storyboard'); expect(find('pre').textContent).toBe('{"stage":"idea"}')
})

it('activates native custom controls with Enter and Space exactly once without replacing handlers', () => {
  find('#app').innerHTML = '<nav class="rail"></nav>'; const node = stage(); find('.rail').append(node)
  startBacklotUi(); node.focus()
  expect(key(node, 'Enter').defaultPrevented).toBe(true); expect(key(node, ' ').defaultPrevented).toBe(true)
  expect(node.onclick).toBeNull(); expect(nativeHandlers.get(node)).toHaveBeenCalledTimes(2)
  key(node, 'Enter', {repeat: true}); key(node, 'Enter', {ctrlKey: true}); expect(nativeHandlers.get(node)).toHaveBeenCalledTimes(2)
})

it('activates native narration and render-version listeners without exposing static notes or unhandled media', () => {
  find('#app').innerHTML = '<div class="scene-card"><div class="narr" title="Click to read the full narration">Original narration</div><div class="narr tc-note" title="Original note">Static note</div><div class="thumb approved"><video></video></div><div class="wave"></div></div><div class="render-meta"><span class="v active">movie-v2.mp4</span></div>'
  const narration = find('.narr'), version = find('.render-meta .v'), narrClick = nativeClick(narration), renderClick = nativeClick(version)
  startBacklotUi(); key(narration, 'Enter'); key(version, ' ')
  expect(narration.onclick).toBeNull(); expect(version.onclick).toBeNull(); expect(narrClick).toHaveBeenCalledOnce(); expect(renderClick).toHaveBeenCalledOnce(); expect(version.getAttribute('aria-pressed')).toBe('true')
  for (const selector of ['.tc-note', '.thumb', '.wave']) expect(find(selector).hasAttribute('role')).toBe(false)
})

it('keeps native button keyboard handling and nested input editing untouched', () => {
  find('#app').innerHTML = '<button class="modal-close">Close</button><div class="script-preview"><input></div>'
  const button = find<HTMLButtonElement>('.modal-close'), preview = find('.script-preview'); const buttonClick = nativeClick(button), previewClick = nativeClick(preview)
  startBacklotUi()
  expect(key(button, 'Enter').defaultPrevented).toBe(false); expect(buttonClick).not.toHaveBeenCalled()
  expect(key(find('input'), ' ').defaultPrevented).toBe(false); expect(previewClick).not.toHaveBeenCalled()
})

it('restores keyboard focus on the same stage after Backlot replaces the board', async () => {
  find('#app').innerHTML = '<nav class="rail"></nav>'; const old = stage(); find('.rail').append(old)
  startBacklotUi(); old.focus()
  const next = stage('需求与大纲', true); find('.rail').replaceChildren(next); await flush()
  expect(document.activeElement).toBe(next); expect(next.getAttribute('aria-expanded')).toBe('true'); expect(next.onclick).toBeNull(); expect(nativeHandlers.get(next)).toBeTypeOf('function')
})

it('does not steal focus from another input or a deliberate pointer action during repaint', async () => {
  find('#app').innerHTML = '<nav class="rail"></nav><input id="other">'; const old = stage(); find('.rail').append(old)
  startBacklotUi(); old.focus(); find('input').focus(); find('.rail').replaceChildren(stage()); await flush(); expect(document.activeElement).toBe(find('input'))
  find('.stage').focus(); document.body.dispatchEvent(new Event('pointerdown', {bubbles: true})); find('.rail').replaceChildren(stage()); await flush(); expect(document.activeElement).toBe(document.body)
})

it('preserves replay action focus across changing play/pause labels and gives the timeline a label', async () => {
  find('#app').innerHTML = '<div class="replay-bar"><span class="rp-btn">▶</span><input type="range"></div>'
  nativeClick(find('.rp-btn')); startBacklotUi(); find('.rp-btn').focus()
  const next = document.createElement('span'); next.className = 'rp-btn'; next.textContent = '❚❚'; nativeClick(next); find('.rp-btn').replaceWith(next); await flush()
  expect(document.activeElement).toBe(next); expect(next.getAttribute('aria-label')).toBe('暂停制作回放'); expect(find('input').getAttribute('aria-label')).toBe('定位制作回放时间')
})

it('moves replay entry focus to play/pause and restores timeline focus after release repaint', async () => {
  find('#app').innerHTML = '<div class="replay-bar"><span class="rp-btn">▶ REPLAY RUN</span></div>'
  nativeClick(find('.rp-btn'), () => {find('.replay-bar').innerHTML = '<span class="rp-btn">❚❚</span><input type="range">'; nativeClick(find('.rp-btn'))})
  startBacklotUi(); find('.rp-btn').focus(); key(find('.rp-btn'), 'Enter'); await flush(); expect(document.activeElement).toBe(find('.rp-btn'))
  find('input').focus(); const next = document.createElement('input'); next.type = 'range'; find('input').replaceWith(next); await flush(); expect(document.activeElement).toBe(next)
})

it('returns focus to the selected stage when keyboard closing its native drawer', async () => {
  find('#app').innerHTML = '<nav class="rail"></nav><div class="drawer"><div class="drawer-head"><span class="close">CLOSE</span></div></div>'
  find('.rail').append(stage('script', true)); nativeClick(find('.close'), () => {find('.drawer').remove(); find('.stage').classList.remove('selected')})
  startBacklotUi(); find('.close').focus(); key(find('.close'), 'Enter'); await flush(); expect(document.activeElement).toBe(find('.stage'))
})

function modalFixture() {
  find('#app').innerHTML = '<div class="script-preview">Script</div>'
  const opener = find('.script-preview'), modal = find('#modal')
  nativeClick(opener, () => {modal.innerHTML = '<span class="modal-close">ESC · CLOSE</span><div class="modal-page">Original script</div>'; nativeClick(find('.modal-close'), () => modal.classList.remove('open')); modal.classList.add('open')})
  return {opener, modal}
}

it('opens modal with a dialog label and focus, traps Tab, and restores the actual opener on close', async () => {
  const {opener, modal} = modalFixture(); startBacklotUi(); opener.focus(); key(opener, 'Enter'); await flush()
  const close = find('.modal-close'); expect(document.activeElement).toBe(close); expect(modal.getAttribute('role')).toBe('dialog'); expect(modal.getAttribute('aria-modal')).toBe('true')
  expect(key(close, 'Tab').defaultPrevented).toBe(true); expect(document.activeElement).toBe(close)
  expect(key(close, 'Tab', {shiftKey: true}).defaultPrevented).toBe(true)
  key(close, ' '); await flush(); expect(modal.classList.contains('open')).toBe(false); expect(document.activeElement).toBe(opener)
})

it('leaves Escape to Backlot and restores a replaced opener after native modal close', async () => {
  const {opener, modal} = modalFixture(); const nativeEscape = (event: KeyboardEvent) => {if (event.key === 'Escape') modal.classList.remove('open')}
  document.addEventListener('keydown', nativeEscape); startBacklotUi(); opener.focus(); opener.click(); await flush()
  const replacement = document.createElement('div'); replacement.className = 'script-preview'; nativeClick(replacement); opener.replaceWith(replacement); await flush()
  expect(key(find('.modal-close'), 'Escape').defaultPrevented).toBe(false); await flush(); expect(document.activeElement).toBe(replacement)
  document.removeEventListener('keydown', nativeEscape)
})

it('keeps focus on another deliberate target when a modal closes', async () => {
  const {opener, modal} = modalFixture(); const other = document.createElement('input'); document.body.append(other)
  startBacklotUi(); opener.click(); await flush(); other.focus(); modal.classList.remove('open'); await flush(); expect(document.activeElement).toBe(other)
})

function parentWindow() {const parent = {} as Window; Object.defineProperty(window, 'parent', {value: parent, configurable: true}); return parent}
function sendTheme(source: Window | null, data: unknown) {window.dispatchEvent(new MessageEvent('message', {source, data}))}
function themeToggle() {
  const button = document.createElement('button'); button.className = 'theme-toggle'; let theme = document.documentElement.dataset.theme
  nativeClick(button, vi.fn(() => {theme = theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = theme})); find('#app').append(button); return button
}

it('accepts only valid theme messages from its embedding parent and calls the native theme handler', () => {
  const parent = parentWindow(), toggle = themeToggle(); startBacklotUi()
  for (const data of [null, [], {type: 'track-openmontage-theme', theme: 'sepia'}, {type: 'other', theme: 'light'}]) sendTheme(parent, data)
  sendTheme(window, {type: 'track-openmontage-theme', theme: 'light'}); sendTheme(null, {type: 'track-openmontage-theme', theme: 'light'}); expect(nativeHandlers.get(toggle)).not.toHaveBeenCalled()
  sendTheme(parent, {type: 'track-openmontage-theme', theme: 'light'}); expect(toggle.onclick).toBeNull(); expect(nativeHandlers.get(toggle)).toHaveBeenCalledOnce(); expect(document.documentElement.dataset.theme).toBe('light')
  sendTheme(parent, {type: 'track-openmontage-theme', theme: 'light'}); expect(nativeHandlers.get(toggle)).toHaveBeenCalledOnce()
})

it('holds a valid theme until Backlot renders its button and allows a later native user override', async () => {
  const parent = parentWindow(); startBacklotUi(); sendTheme(parent, {type: 'track-openmontage-theme', theme: 'light'}); const toggle = themeToggle(); await flush()
  expect(document.documentElement.dataset.theme).toBe('light'); expect(nativeHandlers.get(toggle)).toHaveBeenCalledOnce()
  toggle.click(); find('#app').append(document.createElement('div')); await flush(); expect(document.documentElement.dataset.theme).toBe('dark'); expect(nativeHandlers.get(toggle)).toHaveBeenCalledTimes(2)
})

it('does not accept theme messages when running as a standalone page', () => {
  const toggle = themeToggle(); startBacklotUi(); sendTheme(window, {type: 'track-openmontage-theme', theme: 'light'}); expect(nativeHandlers.get(toggle)).not.toHaveBeenCalled()
})

it('pauses media and active replay only when its parent hides the board, and never resumes automatically', () => {
  const parent = parentWindow()
  find('#app').innerHTML = '<video></video><audio></audio><div class="replay-bar"><span class="rp-btn">❚❚</span><span class="rp-btn">✕ LIVE</span></div>'
  const video = find<HTMLVideoElement>('video'), audio = find<HTMLAudioElement>('audio'), videoPause = vi.spyOn(video, 'pause').mockImplementation(() => {}), audioPause = vi.spyOn(audio, 'pause').mockImplementation(() => {}), videoPlay = vi.spyOn(video, 'play').mockResolvedValue(undefined), audioPlay = vi.spyOn(audio, 'play').mockResolvedValue(undefined)
  const replay = find('.rp-btn'), pauseReplay = nativeClick(replay, vi.fn(() => {replay.textContent = '▶'})); startBacklotUi()
  sendTheme(window, {type: 'track-openmontage-visibility', visible: false}); sendTheme(parent, {type: 'track-openmontage-visibility', visible: 'false'}); expect(videoPause).not.toHaveBeenCalled(); expect(pauseReplay).not.toHaveBeenCalled()
  sendTheme(parent, {type: 'track-openmontage-visibility', visible: false}); expect(videoPause).toHaveBeenCalledOnce(); expect(audioPause).toHaveBeenCalledOnce(); expect(pauseReplay).toHaveBeenCalledOnce()
  sendTheme(parent, {type: 'track-openmontage-visibility', visible: true}); expect(videoPlay).not.toHaveBeenCalled(); expect(audioPlay).not.toHaveBeenCalled(); expect(pauseReplay).toHaveBeenCalledOnce()
  sendTheme(parent, {type: 'track-openmontage-visibility', visible: false}); expect(pauseReplay).toHaveBeenCalledOnce()
})

it('installs once, avoids mutation loops, and removes listeners plus queued work on disposal', async () => {
  find('#app').innerHTML = '<nav class="rail"></nav>'; const node = stage(); find('.rail').append(node)
  const remove = vi.spyOn(document, 'removeEventListener'), disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect')
  const dispose = startBacklotUi(); expect(startBacklotUi()).toBe(dispose); await flush(); const passes = disconnect.mock.calls.length; await flush(); expect(disconnect.mock.calls.length).toBe(passes)
  const replacement = stage(); find('.rail').replaceChildren(replacement); dispose(); dispose(); await flush(); expect(replacement.hasAttribute('role')).toBe(false)
  key(node, 'Enter'); expect(nativeHandlers.get(node)).not.toHaveBeenCalled(); expect(remove.mock.calls.filter(([event]) => event === 'keydown')).toHaveLength(1)
  expect(startBacklotUi()).not.toBe(dispose); expect(replacement.getAttribute('role')).toBe('button')
})

it('suspends while in BFCache, restores enhancements on return and disposes when leaving', async () => {
  find('#app').innerHTML = '<nav class="rail"></nav>'; find('.rail').append(stage()); startBacklotUi()
  const hide = new Event('pagehide'); Object.defineProperty(hide, 'persisted', {value: true}); window.dispatchEvent(hide)
  const next = stage(); find('.rail').replaceChildren(next); await flush(); expect(next.hasAttribute('role')).toBe(false)
  window.dispatchEvent(new Event('pageshow')); await flush(); expect(next.getAttribute('role')).toBe('button')
  window.dispatchEvent(new Event('pagehide')); const after = stage(); find('.rail').replaceChildren(after); await flush(); expect(after.hasAttribute('role')).toBe(false)
})
