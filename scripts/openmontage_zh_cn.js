// Track-owned display layer for the original Backlot UI. Project data and the
// upstream application stay unchanged; only explicitly identified UI positions
// are translated. Keep this module dependency-free for the Backlot static server.

const stages = Object.freeze({
  research: "背景调查", proposal: "制作方案", idea: "需求与大纲", script: "脚本",
  scene_plan: "分镜", "scene plan": "分镜", assets: "素材", edit: "剪辑",
  compose: "合成", publish: "发布",
});
const statuses = Object.freeze({
  pending: "未开始", in_progress: "进行中", "in progress": "进行中",
  awaiting_human: "待确认", completed: "已完成", failed: "失败", unknown: "未知",
  approved: "已确认", unlisted: "未列入流程",
});
const artifacts = Object.freeze({
  brief: "需求与大纲", research_brief: "背景调查摘要", "research brief": "背景调查摘要",
  proposal_packet: "制作方案", "proposal packet": "制作方案", script: "脚本",
  scene_plan: "分镜方案", "scene plan": "分镜方案", asset_manifest: "素材清单",
  "asset manifest": "素材清单", edit_decisions: "剪辑方案", "edit decisions": "剪辑方案",
  render_report: "输出报告", "render report": "输出报告", final_review: "最终审核",
  "final review": "最终审核", publish_log: "发布记录", "publish log": "发布记录",
});
const metrics = Object.freeze({
  platform: "平台", duration: "时长", tone: "语气", style: "风格", runtime: "合成引擎",
  pipeline: "制作流程", "estimated cost": "预估费用", concepts: "方案数量",
  sources: "参考来源", "data points": "资料条目", angles: "内容角度", sections: "段落",
  scenes: "分镜", assets: "素材", types: "类型", "generation cost": "生成费用",
  cuts: "剪辑片段", outputs: "输出文件", destinations: "发布平台", hook: "开场钩子",
  "key points": "内容要点", "target platform": "目标平台", "target duration seconds": "目标时长（秒）",
  "total duration seconds": "总时长（秒）", "total cost usd": "总费用（美元）", metadata: "附加信息",
});
const enums = Object.freeze({
  hybrid: "混合流程", unknown: "未知", image: "图片", video: "视频", audio: "音频",
  narration: "旁白", music: "音乐", animation: "动画", text_card: "文字卡片",
  screen_recording: "屏幕录制", record: "录制", generated: "生成", provided: "用户提供",
  extreme_wide: "大远景", "extreme wide": "大远景", wide: "远景", medium_wide: "全景",
  "medium wide": "全景", medium: "中景", medium_close: "中近景", "medium close": "中近景",
  close_up: "特写", "close up": "特写", extreme_close_up: "大特写", "extreme close up": "大特写",
  establishing: "环境交代", static: "固定镜头", pan: "水平摇镜", tilt: "俯仰摇镜",
  push_in: "推进", "push in": "推进", pull_out: "拉远", "pull out": "拉远",
  dolly_in: "推进", "dolly in": "推进", dolly_out: "拉远", "dolly out": "拉远",
  tracking: "跟随", track: "跟随", orbit: "环绕", crane: "升降", handheld: "手持",
  zoom_in: "放大", "zoom in": "放大", zoom_out: "缩小", "zoom out": "缩小",
  aerial: "航拍", top_down: "俯视", "top down": "俯视", overhead: "俯视",
  eye_level: "平视", "eye level": "平视", low_angle: "仰视", "low angle": "仰视",
  high_angle: "俯视", "high angle": "俯视", natural: "自然光", soft: "柔光",
  hard: "硬光", high_key: "高调光", "high key": "高调光", low_key: "低调光",
  "low key": "低调光", backlit: "逆光", golden_hour: "黄金时段", "golden hour": "黄金时段",
  over_shoulder: "过肩镜头", insert: "细节镜头", pan_left: "向左摇镜", pan_right: "向右摇镜",
  tilt_up: "上摇", tilt_down: "下摇", tracking_left: "向左跟随", tracking_right: "向右跟随",
  crane_up: "升高", crane_down: "下降", steadicam: "稳定器跟随", whip_pan: "快速摇镜",
  orbital: "环绕", rack_focus: "转移焦点", blue_hour: "蓝调时段", tungsten_warm: "暖钨丝光",
  neon: "霓虹光", silhouette: "剪影", rim_lit: "轮廓光", volumetric: "体积光", overcast_soft: "阴天柔光",
  overlay: "叠加画面", broll: "补充画面", diagram: "示意图", stat_card: "数据卡片", code_snippet: "代码片段",
});
const ui = Object.freeze({
  Library: "项目库", Storyboard: "分镜看板", Renders: "输出视频", Decisions: "制作决策",
  Activity: "活动记录", LIVE: "进行中", IDLE: "暂无活动", "◈ AWAITING YOU": "◈ 等待你确认",
  "⚠ STALLED?": "⚠ 可能已停滞", "generation spend": "生成费用",
  "awaiting your approval\nreply in chat to continue": "等待你确认\n请在对话中回复后继续",
  "in progress": "进行中", failed: "失败", unlisted: "未列入流程", "· approved": "· 已确认",
  "⚑ GATE SKIPPED": "⚑ 已跳过确认", "CLOSE ✕": "关闭 ✕", "ESC · CLOSE": "Esc · 关闭",
  "This stage hasn't run yet.": "此阶段尚未开始。",
  "No canonical artifact found on disk for this stage.": "磁盘上未找到此阶段的正式成果。",
  APPROVED: "已确认", "PENDING APPROVAL": "待确认", DRAFTING: "编写中", SELECTED: "已选择",
  "⤢ EXPAND SCRIPT": "⤢ 展开脚本", END: "完", "WHY THIS CONCEPT": "选择此方案的原因",
  "The complete script preview is shown directly below.": "完整脚本预览位于下方。",
  "Review timing and shot coverage in the storyboard below.": "请在下方分镜看板检查时长和镜头内容。",
  "Inspect every generated take in the filmstrip below before approving compose.": "确认合成前，请检查下方分镜中的各个素材版本。",
  "REVIEW GATE": "阶段确认", "SELF-REVIEW": "自查结果",
  "Review the artifact here, then reply in chat to approve it or request changes.": "查看这里的成果后，请在对话中确认或提出修改。",
  "Nothing reviewable was found.": "未找到可供确认的成果。",
  "This is the final approval gate.": "这是最后一个确认阶段。",
  "OPEN FULL ARTIFACT": "查看完整成果", "also considered:": "其他考虑过的方案：",
  "· revised": "· 已修订", "● running": "● 执行中", "★ HERO": "★ 重点镜头",
  "◉ GENERATING": "◉ 生成中", "◆ BESPOKE": "◆ 定制动画",
  "hand-authored composition": "手工制作的合成画面", "asset in manifest, file missing": "素材已登记，但文件缺失",
  "no asset yet": "尚未准备素材", "What the watcher found": "发现的现有素材",
  "snapshots / verification frames": "截图 / 验证画面", "No pipeline state.": "暂无制作流程状态。",
  "This project has no checkpoints — Backlot is showing what it found on disk.": "此项目没有阶段记录，Backlot 正在展示磁盘上的现有素材。",
  "Runs that follow the checkpoint protocol get the full board.": "按阶段确认流程制作后，可查看完整看板。",
  "The agent is paused at this gate — reply": "Agent 已在此阶段暂停，请",
  "in chat": "在对话中", "to approve or request changes.": "确认成果或提出修改。",
  "scrub the whole run": "查看完整制作过程", "▶ REPLAY RUN": "▶ 回放制作过程",
  "✕ LIVE": "✕ 返回当前状态", "PROJECT NOT FOUND": "项目不存在", "NO MEDIA YET": "暂无素材",
  "No projects yet — run a production and it will appear here.": "暂无项目，开始制作后将在这里显示。",
  "Click to expand full script": "点击展开完整脚本", "Click to read the full narration": "点击阅读完整旁白",
  "Play narration": "播放旁白", "Switch to dark theme": "切换到深色主题", "Switch to light theme": "切换到浅色主题",
});

function mapped(table, value) { return table[value] ?? table[value.toLowerCase()] ?? table[value.toLowerCase().replaceAll(" ", "_")] ?? value; }
function stage(value) { return mapped(stages, value); }
function artifact(value) { return mapped(artifacts, value); }
function relative(value) {
  if (/^just now$/i.test(value)) return "刚刚";
  return value.replace(/^(\d+)([mhd]) ago$/i, (_, count, unit) => `${count}${{m: "分钟", h: "小时", d: "天"}[unit.toLowerCase()]}前`);
}
function enumList(value) {
  return value.split(/(\s*[,·]\s*)/).map(part => /^[\s,·]+$/.test(part) ? part : mapped(enums, part)).join("");
}
function reviewSummary(value) {
  // Free-form reviewer summaries must remain untouched. The original UI's
  // structured summary is recognizable by its numeric issue-count segments.
  if (!/(?:^| · )\d+ critical(?: · |$)/.test(value)) return value;
  return value.split(" · ").map(part => {
    if (/^\d+ (?:critical|suggestions?|nitpicks?)$/.test(part)) return translateCore(part, "ui");
    if (/^review focus /.test(part)) return `审核重点：${part.slice(13)}`;
    return mapped({approve: "通过", approved: "已确认", revise: "需修改", reject: "未通过", pass: "通过", passed: "通过", fail: "未通过", failed: "未通过", valid: "符合结构规范", invalid: "不符合结构规范"}, part);
  }).join(" · ");
}
function translateCore(value, context) {
  if (context === "stage") return stage(value);
  if (context === "artifact") return artifact(value);
  if (context === "metric") return mapped(metrics, value);
  if (context === "enum") return enumList(value);
  if (context === "review") return reviewSummary(value);
  if (context === "intent") return value.replace(/^Intent — /, "镜头用途 — ");
  if (context === "cue") return value.replace(/^▸ (\w+) · /, (_, type) => `▸ ${mapped(enums, type)} · `);
  if (context === "header-chip" && !/^(?:hybrid|unknown) pipeline$|^\d+ scenes · \d+:\d+$/.test(value)) return value;
  if (context === "stage-status") {
    const pair = value.match(/^(.+?)\s*([:—])\s*(pending|in_progress|awaiting_human|completed|failed|unknown)$/i);
    return pair ? `${stage(pair[1])} ${pair[2]} ${mapped(statuses, pair[3])}` : value;
  }
  if (Object.hasOwn(ui, value)) return ui[value];
  const ago = relative(value);
  if (ago !== value) return ago;
  let match;
  if ((match = value.match(/^IDLE · (.+)$/))) return `暂无活动 · ${relative(match[1])}`;
  if ((match = value.match(/^LIVE · (.+)$/))) return `进行中 · ${stage(match[1].toLowerCase())}`;
  if ((match = value.match(/^(\d+) LIVE$/))) return `${match[1]} 个项目进行中`;
  if (value === "hybrid pipeline") return "混合制作流程";
  if (value === "unknown pipeline") return "未知制作流程";
  if ((match = value.match(/^(\d+) scenes? done$/))) return `已完成 ${match[1]} 个分镜`;
  if ((match = value.match(/^stalled\? no activity for (\d+(?:\.\d+)?)m\nask the agent for status$/))) return `可能已停滞：${match[1]} 分钟没有活动\n请在对话中向 Agent 查询进度`;
  if ((match = value.match(/^(\d+) critical$/))) return `${match[1]} 个严重问题`;
  if ((match = value.match(/^(\d+) suggestions?$/))) return `${match[1]} 条建议`;
  if ((match = value.match(/^(\d+) nitpicks?$/))) return `${match[1]} 个细节问题`;
  if ((match = value.match(/^(\d+) (scenes?|sections?|projects?|items?|renders?|versions?|TAKES)$/))) {
    const unit = {scene: "个分镜", section: "个段落", project: "个项目", item: "项", render: "个输出视频", version: "个版本", take: "个素材版本"}[match[2].toLowerCase().replace(/s$/, "")];
    return `${match[1]} ${unit}`;
  }
  if ((match = value.match(/^take (\d+)$/))) return `素材版本 ${match[1]}`;
  if ((match = value.match(/^… (\d+) more sections$/))) return `… 还有 ${match[1]} 个段落`;
  if ((match = value.match(/^script · (.+) · (\d+) sections$/))) return `脚本 · ${match[1]} · ${match[2]} 个段落`;
  if ((match = value.match(/^(\d+) scenes( · \d+:\d+)?( · card width ∝ duration)?$/))) return `${match[1]} 个分镜${match[2] || ""}${match[3] ? " · 卡片宽度与时长成比例" : ""}`;
  if ((match = value.match(/^(.+?) is ready for your review$/))) return `${stage(match[1])}已可供你确认`;
  if ((match = value.match(/^Approval unlocks (.+?)\.$/))) return `确认后可进入${stage(match[1])}。`;
  if ((match = value.match(/^The (.+?) stage is waiting for your review\.$/))) return `${stage(match[1])}阶段正在等待你确认。`;
  if ((match = value.match(/^The (.+?) checkpoint declares (.+), but Backlot could not load it\.$/))) return `${stage(match[1])}阶段应包含${match[2].split(", ").map(artifact).join("、")}，但 Backlot 未能读取。`;
  if ((match = value.match(/^The (.+?) checkpoint does not declare an artifact\.$/))) return `${stage(match[1])}阶段未声明成果。`;
  if ((match = value.match(/^"(.+)" ran but isn't declared by this pipeline's manifest$/))) return `“${stage(match[1])}”已执行，但未列入此制作流程。`;
  if ((match = value.match(/^(.+) · approved$/))) return `${match[1]} · 已确认`;
  if (value.includes("\n")) return value.split("\n").map(line => translateCore(line, context)).join("\n");
  return value;
}

/** Translate UI text, with explicit contexts for native schema display values. */
export function translateUiText(value, context = "ui") {
  const source = String(value);
  const [, leading, body, trailing] = source.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return leading + translateCore(body, context) + trailing;
}

const protectedContent = "pre, code, script, style, textarea, input, .sp-action, .sp-title, .narr, .d-why, .d-pick, .approval-lead, .approval-items p";

/** Translate direct text only. Never replace an element's children or listeners. */
export function localizeBacklot(doc = document) {
  let changed = 0;
  const direct = (selector, context = "ui") => {
    for (const node of doc.querySelectorAll(selector)) {
      if (node.closest(protectedContent)) continue;
      for (const child of node.childNodes) {
        if (child.nodeType !== 3) continue;
        const next = translateUiText(child.nodeValue, context);
        if (next !== child.nodeValue) { child.nodeValue = next; changed += 1; }
      }
    }
  };
  const attribute = (selector, name, context = "ui") => {
    for (const node of doc.querySelectorAll(selector)) {
      const before = node.getAttribute(name);
      if (before == null) continue;
      const next = translateUiText(before, context);
      if (next !== before) { node.setAttribute(name, next); changed += 1; }
    }
  };

  direct(".slate .live, .slate .cost .label, .rail .stage .sub, .drawer-head .gate-chip, .drawer-head .close, .drawer .hint, .findings .f, .script-status, .sp-meta, .sp-expand, .sp-fade, .approval-eyebrow, .approval-status, .approval-guidance, .approval-selected, .approval-review-head p, .approval-missing, .approval-missing b, .approval-review-foot > span, .approval-review-foot button, .approval-rationale > b, .modal-close, .d-revised, .d-alt, .act-row .status.run, .scene-card .hero, .gen-label > span:first-child, .bespoke-tag, .thumb.bespoke .spec-shot, .thumb.missing .spec-desc, .takes .tk-label, .section-title, .section-title .meta, .panel-head h2, .replay-bar .rp-time, .replay-bar .rp-btn, .notice > span:not(:first-child), .notice b, .empty .big, #count, #liveText, #empty, .lp-txt, .lp-live, .lb-meta .chip, .when");
  direct(".slate .chip", "header-chip");
  direct(".rail .stage .name", "stage");
  direct(".drawer-head h3", "stage-status");
  direct(".drawer-body > .d-cat, .approval-artifact-kicker", "artifact");
  direct(".approval-fact > span", "metric");
  direct(".shotchips > span, .thumb.spec:not(.bespoke) .spec-shot", "enum");
  direct(".approval-review-head h2");
  direct(".notice > span:not(:first-child) > b");
  direct(".approval-review-note > b");
  direct(".approval-review-note, .findings > span:not(.f)", "review");
  // This prefix is UI; the remainder is the author's original shot intent.
  direct(".modal-page .sp-paren", "intent");
  direct(".sp-cue", "cue");

  for (const fact of doc.querySelectorAll(".approval-fact")) {
    const label = fact.querySelector(":scope > span")?.textContent?.trim();
    if (!["types", "类型", "pipeline", "制作流程"].includes(label)) continue;
    for (const child of fact.querySelector(":scope > b")?.childNodes || []) {
      if (child.nodeType !== 3) continue;
      const next = translateUiText(child.nodeValue, "enum");
      if (next !== child.nodeValue) { child.nodeValue = next; changed += 1; }
    }
  }
  // These native artifact headlines never use the user's title. Other artifact
  // headlines, including brief/research/proposal titles, are deliberately kept.
  const headlineLabels = {scene_plan: "分镜方案", asset_manifest: "已准备素材", edit_decisions: "剪辑方案", render_report: "输出报告", publish_log: "发布方案"};
  for (const [name, label] of Object.entries(headlineLabels)) {
    const node = doc.querySelector(`.approval-artifact[data-artifact="${name}"] > h2`);
    const expected = {scene_plan: "Scene plan", asset_manifest: "Generated assets", edit_decisions: "Edit decisions", render_report: "Render report", publish_log: "Publish plan"}[name];
    if (node?.childNodes.length === 1 && node.firstChild.nodeType === 3 && node.textContent === expected) { node.firstChild.nodeValue = label; changed += 1; }
  }
  attribute(".theme-toggle", "title");
  attribute(".theme-toggle", "aria-label");
  attribute(".rail .stage", "title");
  attribute(".mini-rail > i", "title", "stage-status");
  attribute(".script-preview, .narr, .wave, .takes .tk", "title");
  // The project title may itself be "Library"; identify the library by its grid.
  if (doc.querySelector("#grid.lib-grid")) {
    direct(".slate h1");
    if (doc.title === "Backlot — Library") { doc.title = "Backlot — 项目库"; changed += 1; }
    for (const chip of doc.querySelectorAll(".lb-meta .chip")) {
      if (chip.childNodes.length !== 1 || chip.firstChild.nodeType !== 3) continue;
      const next = translateUiText(chip.firstChild.nodeValue, "enum");
      if (next !== chip.firstChild.nodeValue) { chip.firstChild.nodeValue = next; changed += 1; }
    }
  }
  if (doc.documentElement.lang !== "zh-CN") { doc.documentElement.lang = "zh-CN"; changed += 1; }
  return changed;
}

const installations = new WeakMap();

/** Install once per document. Repaints from SSE/theme/modal remain localized. */
export function startBacklotLocalization(doc = document) {
  const existing = installations.get(doc);
  if (existing) return existing;
  const view = doc.defaultView;
  if (!view?.MutationObserver || !doc.documentElement) return () => {};
  let active = true;
  let suspended = false;
  let queued = false;
  let observer;
  const reconnect = () => {
    if (active && !suspended) observer.observe(doc.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label"]});
  };
  const refresh = () => {
    if (!active || suspended) return;
    observer.disconnect();
    try { localizeBacklot(doc); } finally { reconnect(); }
  };
  observer = new view.MutationObserver(() => {
    if (!active || queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; refresh(); });
  });
  const dispose = () => {
    if (!active) return;
    active = false;
    observer.disconnect();
    view.removeEventListener("pagehide", onPageHide);
    view.removeEventListener("pageshow", onPageShow);
    doc.removeEventListener("DOMContentLoaded", refresh);
    installations.delete(doc);
  };
  const onPageHide = event => {
    if (event.persisted) { suspended = true; observer.disconnect(); }
    else dispose();
  };
  const onPageShow = () => {
    if (!active || !suspended) return;
    suspended = false;
    refresh();
  };
  installations.set(doc, dispose);
  view.addEventListener("pagehide", onPageHide);
  view.addEventListener("pageshow", onPageShow);
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", refresh, {once: true});
  refresh();
  return dispose;
}

export function stopBacklotLocalization(doc = document) { installations.get(doc)?.(); }

if (typeof document !== "undefined") startBacklotLocalization(document);
