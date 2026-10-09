// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {localizeBacklot, startBacklotLocalization, stopBacklotLocalization, translateUiText} from '../scripts/openmontage_zh_cn.js'

const html = (source: string) => {document.body.innerHTML = source}
const text = (selector: string) => document.querySelector(selector)?.textContent
async function flush() {await Promise.resolve(); await Promise.resolve(); await Promise.resolve()}
beforeEach(() => {
  stopBacklotLocalization(document)
  document.body.innerHTML = ''
  document.documentElement.lang = 'en'
  document.title = 'Backlot'
})
afterEach(() => {stopBacklotLocalization(document); document.body.innerHTML = ''; vi.restoreAllMocks()})

it('localizes the native slate without changing project titles, style identifiers or pipeline data', () => {
  html(`<header class="slate"><h1>Library</h1><span class="chip">hybrid pipeline</span><span class="chip">3 scenes · 0:15</span><span class="chip">IDLE</span><span class="live"><span class="dot"></span>IDLE · 2M AGO</span><div class="cost"><span class="nums">$2.00 / $10.00</span><div class="label">generation spend</div></div></header>`)
  localizeBacklot()
  expect(text('.slate h1')).toBe('Library')
  expect([...document.querySelectorAll('.chip')].map(node => node.textContent)).toEqual(['混合制作流程', '3 个分镜 · 0:15', 'IDLE'])
  expect(text('.live')).toBe('暂无活动 · 2分钟前')
  expect(text('.cost .label')).toBe('生成费用')
  expect(text('.nums')).toBe('$2.00 / $10.00')
  expect(document.documentElement.lang).toBe('zh-CN')
})

it('translates stage display names and statuses while preserving native keys and JSON', () => {
  const raw = '{"scene_plan":{"status":"completed","script":"LIVE"}}'
  html(`<nav class="rail"><div class="stage" data-stage="idea"><span class="name">idea</span><span class="sub">awaiting your approval\nreply in chat to continue</span></div><div class="stage" title='"scene_plan" ran but isn\'t declared by this pipeline\'s manifest'><span class="name">scene_plan</span><span class="sub">13:01:04 · approved\nunlisted</span></div></nav><div class="drawer"><div class="drawer-head"><h3>scene_plan — completed</h3><span class="gate-chip">⚑ GATE SKIPPED</span><span class="close">CLOSE ✕</span></div><div class="drawer-body"><div class="d-cat">scene_plan</div><pre></pre></div></div>`)
  document.querySelector('pre')!.textContent = raw
  // Set this attribute directly because the original value contains quotes.
  document.querySelectorAll('.stage')[1].setAttribute('title', '"scene_plan" ran but isn\'t declared by this pipeline\'s manifest')
  localizeBacklot()
  expect(text('.stage .name')).toBe('需求与大纲')
  expect(text('.stage .sub')).toBe('等待你确认\n请在对话中回复后继续')
  expect(document.querySelectorAll('.stage .sub')[1].textContent).toBe('13:01:04 · 已确认\n未列入流程')
  expect(text('.drawer-head h3')).toBe('分镜 — 已完成')
  expect(text('.drawer-body > .d-cat')).toBe('分镜方案')
  expect(document.querySelector('.stage')?.getAttribute('data-stage')).toBe('idea')
  expect(document.querySelectorAll('.stage')[1].getAttribute('title')).toBe('“分镜”已执行，但未列入此制作流程。')
  expect(text('pre')).toBe(raw)
})

it.each([
  ['◈ AWAITING YOU', '◈ 等待你确认'], ['⚠ STALLED?', '⚠ 可能已停滞'], ['LIVE', '进行中'],
  ['IDLE', '暂无活动'], ['stalled? no activity for 4.5m\nask the agent for status', '可能已停滞：4.5 分钟没有活动\n请在对话中向 Agent 查询进度'],
  ['1 scene done', '已完成 1 个分镜'], ['2 scenes done', '已完成 2 个分镜'],
  ['3 projects', '3 个项目'], ['1 item', '1 项'], ['2 versions', '2 个版本'],
  ['3 TAKES', '3 个素材版本'], ['just now', '刚刚'], ['4h ago', '4小时前'], ['5D AGO', '5天前'],
])('handles dynamic native UI text %s', (source, expected) => {
  expect(translateUiText(source)).toBe(expected)
})

it('localizes review gates and structured findings without rewriting free-form reviewer text', () => {
  html(`<section class="approval-review" data-stage="scene_plan"><div class="approval-review-head"><div class="approval-eyebrow">REVIEW GATE</div><h2>scene plan is ready for your review</h2><p>Review the artifact here, then reply in chat to approve it or request changes.</p><span class="approval-status">PENDING APPROVAL</span></div><div class="approval-review-note"><b>SELF-REVIEW  </b>approve · 0 critical · 2 suggestions · review focus pacing · valid</div><article class="approval-artifact" data-artifact="scene_plan"><div class="approval-artifact-kicker">scene plan</div><h2>Scene plan</h2><div class="approval-fact"><span>scenes</span><b>3</b></div><div class="approval-fact"><span>types</span><b>video, image</b></div><p class="approval-guidance">Review timing and shot coverage in the storyboard below.</p></article><div class="approval-review-foot"><span>Approval unlocks assets.</span><button>OPEN FULL ARTIFACT</button></div></section><div class="findings"><span class="f">1 critical</span><span class="f">3 suggestions</span><span class="f">2 nitpicks</span><span>Storyboard</span></div>`)
  localizeBacklot()
  expect(text('.approval-review-head h2')).toBe('分镜已可供你确认')
  expect(text('.approval-status')).toBe('待确认')
  expect(text('.approval-review-note')).toBe('自查结果  通过 · 0 个严重问题 · 2 条建议 · 审核重点：pacing · 符合结构规范')
  expect(text('.approval-artifact > h2')).toBe('分镜方案')
  expect(text('.approval-fact > span')).toBe('分镜')
  expect(document.querySelectorAll('.approval-fact b')[1].textContent).toBe('视频, 图片')
  expect(text('.approval-review-foot > span')).toBe('确认后可进入素材。')
  expect(text('.approval-review-foot button')).toBe('查看完整成果')
  expect([...document.querySelectorAll('.findings .f')].map(node => node.textContent)).toEqual(['1 个严重问题', '3 条建议', '2 个细节问题'])
  expect(text('.findings > span:not(.f)')).toBe('Storyboard')
  expect(document.querySelector('.approval-review')?.getAttribute('data-stage')).toBe('scene_plan')
})

it('localizes missing artifact and paused Agent messages with their split native text nodes', () => {
  html(`<div class="approval-missing"><b>Nothing reviewable was found. </b>The scene_plan checkpoint declares scene plan, asset manifest, but Backlot could not load it.</div><div class="notice"><span>◈</span><span><b>The script stage is waiting for your review. </b>The agent is paused at this gate — reply <b>in chat</b> to approve or request changes.</span></div><div class="drawer"><div class="hint">This stage hasn't run yet.</div></div>`)
  localizeBacklot()
  expect(text('.approval-missing')).toBe('未找到可供确认的成果。 分镜阶段应包含分镜方案、素材清单，但 Backlot 未能读取。')
  expect(text('.notice')).toContain('脚本阶段正在等待你确认。')
  expect(text('.notice')).toContain('Agent 已在此阶段暂停，请 在对话中 确认成果或提出修改。')
  expect(text('.drawer .hint')).toBe('此阶段尚未开始。')
})

it('localizes script chrome, metadata and cue types while preserving authored labels and text', () => {
  html(`<div class="script-preview" title="Click to expand full script"><span class="script-status">APPROVED</span><div class="sp-title">Storyboard</div><div class="sp-meta">script · 1:20 · 5 sections</div><div class="sp-slug">SC01 — Section</div><div class="sp-action">OPEN FULL ARTIFACT</div><span class="sp-cue">▸ overlay · Keep the English word Storyboard</span><div class="sp-fade">… 1 more sections</div><span class="sp-expand">⤢ EXPAND SCRIPT</span></div><div class="modal-page"><div class="sp-paren">Intent — no asset yet</div><div class="sp-paren">END</div></div><span class="modal-close">ESC · CLOSE</span>`)
  localizeBacklot()
  expect(text('.script-status')).toBe('已确认')
  expect(text('.sp-meta')).toBe('脚本 · 1:20 · 5 个段落')
  expect(text('.sp-fade')).toBe('… 还有 1 个段落')
  expect(text('.sp-title')).toBe('Storyboard')
  expect(text('.sp-slug')).toBe('SC01 — Section')
  expect(text('.sp-action')).toBe('OPEN FULL ARTIFACT')
  expect(text('.sp-cue')).toBe('▸ 叠加画面 · Keep the English word Storyboard')
  expect(text('.modal-page .sp-paren')).toBe('镜头用途 — no asset yet')
  expect(document.querySelectorAll('.modal-page .sp-paren')[1].textContent).toBe('END')
})

it('translates storyboard chrome but preserves media paths, scene IDs, model/tool names and asset requirements', () => {
  html(`<div class="section-title">Storyboard<span class="meta">3 scenes · 0:15 · card width ∝ duration</span></div><div class="scene-card"><div class="sc-slate"><span class="num">SC 01</span><span class="take">T2</span><span class="hero">★ HERO</span></div><div class="thumb generating"><div class="gen-label"><span>◉ GENERATING</span><span class="sub">track_map_editor</span></div></div><div class="thumb missing"><div class="spec-desc">asset in manifest, file missing</div><div class="spec-shot">assets/video/LIVE.mp4</div></div><div class="thumb missing"><div class="spec-desc">no asset yet</div><div class="spec-shot">Storyboard</div></div><div class="thumb spec"><div class="spec-desc">no asset yet</div><div class="spec-shot">wide · pan_left</div></div><div class="thumb approved"><span class="badge">snapshot</span><span class="badge">track_sandbox_editor · $0.00</span></div><div class="shotchips"><span>medium close</span><span>crane up</span><span>50mm</span><span>golden hour</span></div><div class="takes"><span class="tk" title="take 2"></span><span class="tk-label">2 TAKES</span></div><div class="narr" title="Click to read the full narration">no asset yet</div><div class="wave" title="Play narration"></div></div>`)
  localizeBacklot()
  expect(text('.section-title')).toBe('分镜看板3 个分镜 · 0:15 · 卡片宽度与时长成比例')
  expect(text('.num')).toBe('SC 01'); expect(text('.take')).toBe('T2')
  expect(text('.gen-label .sub')).toBe('track_map_editor')
  expect(text('.thumb.missing .spec-desc')).toBe('素材已登记，但文件缺失')
  expect(text('.thumb.missing .spec-shot')).toBe('assets/video/LIVE.mp4')
  expect(document.querySelectorAll('.thumb.missing .spec-shot')[1].textContent).toBe('Storyboard')
  expect(text('.thumb.spec .spec-desc')).toBe('no asset yet')
  expect(text('.thumb.spec .spec-shot')).toBe('远景 · 向左摇镜')
  expect([...document.querySelectorAll('.shotchips > span')].map(node => node.textContent)).toEqual(['中近景', '升高', '50mm', '黄金时段'])
  expect([...document.querySelectorAll('.badge')].map(node => node.textContent)).toEqual(['snapshot', 'track_sandbox_editor · $0.00'])
  expect(text('.narr')).toBe('no asset yet')
  expect(document.querySelector('.narr')?.getAttribute('title')).toBe('点击阅读完整旁白')
  expect(document.querySelector('.wave')?.getAttribute('title')).toBe('播放旁白')
  expect(document.querySelector('.tk')?.getAttribute('title')).toBe('素材版本 2')
})

it('preserves option labels and decision reasoning while localizing decision and activity controls', () => {
  html(`<div class="panel-head"><h2>Decisions</h2><span class="meta">decision_log.json</span></div><div class="decision"><div class="d-cat">model<span class="d-revised"> · revised</span></div><div class="d-pick">voice → LIVE</div><div class="d-why">Storyboard</div><div class="d-alt">also considered: <s>END</s> · <s>APPROVED</s></div></div><div class="panel-head"><h2>Activity</h2><span class="meta">events.jsonl</span></div><div class="act-row"><span class="tool">track_map_editor</span><span class="target">SC01</span><span class="status run">● running</span></div>`)
  localizeBacklot()
  expect(text('.panel-head h2')).toBe('制作决策')
  expect(text('.d-revised')).toBe(' · 已修订')
  expect(text('.d-alt')).toBe('其他考虑过的方案： END · APPROVED')
  expect(text('.d-pick')).toBe('voice → LIVE'); expect(text('.d-why')).toBe('Storyboard')
  expect(text('.tool')).toBe('track_map_editor'); expect(text('.target')).toBe('SC01')
  expect(text('.status.run')).toBe('● 执行中')
  expect([...document.querySelectorAll('.panel-head .meta')].map(node => node.textContent)).toEqual(['decision_log.json', 'events.jsonl'])
})

it('localizes the original library, replay and accessibility labels', () => {
  html(`<header class="slate"><h1>Library</h1><span id="count">2 projects</span><span id="liveText">1 LIVE</span><button class="theme-toggle" title="Switch to light theme" aria-label="Switch to light theme"></button></header><div class="lib-grid" id="grid"><h3>Library</h3><div class="lb-meta"><span class="chip">hybrid</span><span class="chip">3 scenes</span><span class="chip">1 renders</span><span class="when">just now</span></div><div class="mini-rail"><i title="script: awaiting_human"></i></div><span class="lp-txt">NO MEDIA YET</span><span class="lp-live">LIVE · SCENE_PLAN</span></div><p id="empty">No projects yet — run a production and it will appear here.</p><div class="replay-bar"><span class="rp-time">scrub the whole run</span><span class="rp-btn">▶ REPLAY RUN</span><span class="rp-btn">✕ LIVE</span></div>`)
  document.title = 'Backlot — Library'
  localizeBacklot()
  expect(text('.slate h1')).toBe('项目库'); expect(document.title).toBe('Backlot — 项目库')
  expect(text('#grid h3')).toBe('Library')
  expect(text('#count')).toBe('2 个项目'); expect(text('#liveText')).toBe('1 个项目进行中')
  expect([...document.querySelectorAll('.lb-meta .chip')].map(node => node.textContent)).toEqual(['混合流程', '3 个分镜', '1 个输出视频'])
  expect(text('.when')).toBe('刚刚')
  expect(document.querySelector('.mini-rail i')?.getAttribute('title')).toBe('脚本 : 待确认')
  expect(text('.lp-live')).toBe('进行中 · 分镜')
  expect(document.querySelector('.theme-toggle')?.getAttribute('title')).toBe('切换到浅色主题')
  expect(document.querySelector('.theme-toggle')?.getAttribute('aria-label')).toBe('切换到浅色主题')
  expect(text('.replay-bar')).toContain('回放制作过程')
})

it('does not touch arbitrary user text or JSON even when the words exactly match UI terms', () => {
  html(`<h1>Storyboard</h1><p>APPROVED</p><pre><span class="script-status">APPROVED</span>{"script":"LIVE"}</pre><code><span class="sp-fade">END</span></code><textarea>NO MEDIA YET</textarea><div class="approval-artifact" data-artifact="brief"><h2>Scene plan</h2><div class="approval-lead">PENDING APPROVAL</div><div class="approval-fact"><span>tone</span><b>APPROVED</b></div><div class="approval-items"><div class="approval-item-title">SELECTED<span class="approval-selected">SELECTED</span></div><p>no asset yet</p></div></div>`)
  const pre = text('pre'), code = text('code')
  localizeBacklot()
  expect(text('h1')).toBe('Storyboard'); expect(text('body > p')).toBe('APPROVED')
  expect(text('pre')).toBe(pre); expect(text('code')).toBe(code); expect(text('textarea')).toBe('NO MEDIA YET')
  expect(text('.approval-artifact h2')).toBe('Scene plan'); expect(text('.approval-lead')).toBe('PENDING APPROVAL')
  expect(text('.approval-fact b')).toBe('APPROVED')
  expect(text('.approval-items p')).toBe('no asset yet')
  expect(text('.approval-item-title')).toBe('SELECTED已选择')
})

it('is idempotent and keeps existing DOM identity and event handlers', () => {
  html(`<div class="script-preview"><span class="sp-expand">⤢ EXPAND SCRIPT</span></div>`)
  const node = document.querySelector('.script-preview')!, click = vi.fn()
  node.addEventListener('click', click)
  expect(localizeBacklot()).toBeGreaterThan(0)
  expect(localizeBacklot()).toBe(0)
  expect(document.querySelector('.script-preview')).toBe(node)
  node.dispatchEvent(new Event('click')); expect(click).toHaveBeenCalledOnce()
})

it('observes SSE replacements, modal insertion and theme accessibility changes without self-triggering loops', async () => {
  html(`<div id="app"><div class="section-title">Storyboard</div></div><div id="modal"></div>`)
  const observer = vi.spyOn(window.MutationObserver.prototype, 'disconnect')
  const dispose = startBacklotLocalization()
  expect(startBacklotLocalization()).toBe(dispose)
  document.querySelector('#app')!.innerHTML = '<div class="section-title">Renders<span class="meta">2 versions</span></div><button class="theme-toggle" title="Switch to dark theme" aria-label="Switch to dark theme"></button>'
  document.querySelector('#modal')!.innerHTML = '<span class="modal-close">ESC · CLOSE</span><div class="sp-action">Storyboard</div>'
  await flush()
  expect(text('.section-title')).toBe('输出视频2 个版本')
  expect(text('.modal-close')).toBe('Esc · 关闭'); expect(text('.sp-action')).toBe('Storyboard')
  const theme = document.querySelector('.theme-toggle')!
  expect(theme.getAttribute('aria-label')).toBe('切换到深色主题')
  theme.setAttribute('title', 'Switch to light theme'); theme.setAttribute('aria-label', 'Switch to light theme')
  await flush()
  expect(theme.getAttribute('title')).toBe('切换到浅色主题')
  const passes = observer.mock.calls.length
  await flush(); await flush()
  expect(observer.mock.calls.length).toBe(passes)
})

it('disconnects observers and removes lifecycle listeners on dispose, including a queued refresh', async () => {
  html('<div class="section-title">Storyboard</div>')
  const remove = vi.spyOn(window, 'removeEventListener'), removeDocument = vi.spyOn(document, 'removeEventListener')
  const dispose = startBacklotLocalization()
  document.querySelector('.section-title')!.textContent = 'Renders'
  dispose(); dispose()
  await flush()
  expect(text('.section-title')).toBe('Renders')
  expect(remove.mock.calls.filter(([event]) => event === 'pagehide')).toHaveLength(1)
  expect(remove.mock.calls.filter(([event]) => event === 'pageshow')).toHaveLength(1)
  expect(removeDocument.mock.calls.filter(([event]) => event === 'DOMContentLoaded')).toHaveLength(1)
  const restarted = startBacklotLocalization()
  expect(restarted).not.toBe(dispose); expect(text('.section-title')).toBe('输出视频')
})

it('suspends for BFCache pagehide and re-localizes on pageshow, but disposes when the document leaves', async () => {
  html('<div class="section-title">Storyboard</div>')
  startBacklotLocalization()
  const hide = new Event('pagehide'); Object.defineProperty(hide, 'persisted', {value: true})
  window.dispatchEvent(hide)
  document.querySelector('.section-title')!.textContent = 'Renders'; await flush()
  expect(text('.section-title')).toBe('Renders')
  const show = new Event('pageshow'); Object.defineProperty(show, 'persisted', {value: true})
  window.dispatchEvent(show); await flush()
  expect(text('.section-title')).toBe('输出视频')
  window.dispatchEvent(new Event('pagehide'))
  document.querySelector('.section-title')!.textContent = 'Storyboard'; await flush()
  expect(text('.section-title')).toBe('Storyboard')
})
