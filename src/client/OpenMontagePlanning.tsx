import {useCallback, useEffect, useRef, useState} from 'react'
import type {TrackRecord} from '../protocol.ts'
import {API} from '../protocol.ts'
import type {OpenMontageConnection, OpenMontageEditor, OpenMontageProject, OpenMontageSettings, OpenMontageShotScope, OpenMontageState} from '../track/openmontage.ts'
import {api, clipboardSafeName, download} from './util.ts'
import {useEditorNavigation, type EditorNavigationHandle} from './editor-navigation.tsx'
import type {TrackAgentServicesReader} from './useTrackAgentDrawer.ts'
import {acknowledgeOpenMontageAgentMessage, ensureOpenMontageAgentSession, openOpenMontageProjectDrawer, prepareOpenMontageAgentMessage, sendOpenMontageAgentMessage} from './openmontage-agent.ts'
import {OPENMONTAGE_PLANNING_CSS} from './openmontage-planning-css.ts'
import {observeOpenMontageBoardTheme, observeOpenMontageBoardVisibility, syncOpenMontageBoardTheme, syncOpenMontageBoardVisibility} from './openmontage-board-theme.ts'

type Props = {
  track: TrackRecord; active: boolean; refreshKey?: number
  getAgentServices?: TrackAgentServicesReader
  onKeepSession?: (sessionId: string, signal?: AbortSignal) => Promise<void>
  onRegister?: (value: EditorNavigationHandle | null) => void
  onOpenShot: (scope: OpenMontageShotScope, editor: OpenMontageEditor) => void
}
type SceneAsset = {id: string; type: string; path?: string; exists?: boolean; resolution?: string; duration_seconds?: number}
type Scene = {id: string; description?: string; narration?: string; shot_intent?: string; duration_seconds?: number; required_assets?: Array<{type: string; description: string; source: string}>; visual?: SceneAsset | null; audio?: SceneAsset[]}
const DEFAULT_SETTINGS: OpenMontageSettings = {sourceDirectory: 'E:\\workspace\\project\\OpenMontage', pythonPath: 'python'}
const stageName = (value: string) => ({idea: '需求与大纲', script: '脚本', scene_plan: '分镜', assets: '镜头素材', edit: '剪辑', compose: '合成', publish: '发布'}[value] || value)
const stateName = (value: string) => ({completed: '已提交', awaiting_human: '等待你确认', in_progress: '处理中', failed: '需要处理'}[value] || '尚未开始')
const message = (reason: unknown) => reason instanceof Error ? reason.message : '连接失败，请重试'

/** OpenMontage owns the creative artifacts; this surface only connects their actual project. */
export function OpenMontagePlanning({track, active, refreshKey = 0, getAgentServices, onKeepSession, onRegister, onOpenShot}: Props) {
  const [connection, setConnection] = useState<OpenMontageConnection | null>(null)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS), [baseline, setBaseline] = useState(JSON.stringify(DEFAULT_SETTINGS))
  const [projects, setProjects] = useState<OpenMontageProject[]>([]), [projectId, setProjectId] = useState('')
  const [projectTitle, setProjectTitle] = useState(`${track.name} · 视频策划`)
  const [state, setState] = useState<OpenMontageState | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [showSettings, setShowSettings] = useState(false)
  const [legacy, setLegacy] = useState<string | null>(null), [choices, setChoices] = useState<Record<string, OpenMontageEditor | 'none'>>({})
  const [boardRefresh, setBoardRefresh] = useState(0)
  const [showNewProject, setShowNewProject] = useState(false), [showShots, setShowShots] = useState(true), [focusBoard, setFocusBoard] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'board' | 'shots'>('board'), [shotSearch, setShotSearch] = useState(''), [shotFilter, setShotFilter] = useState<'all' | 'pending' | 'filled'>('all')
  const shotsPanel = useRef<HTMLElement | null>(null)
  const planningPanel = useRef<HTMLElement | null>(null), boardFrame = useRef<HTMLIFrameElement | null>(null)
  const pending = useRef<AbortController | null>(null), alive = useRef(true), generation = useRef(0), reading = useRef(false)
  const latest = useRef({projectId, active, getAgentServices, onKeepSession, onOpenShot}); latest.current = {projectId, active, getAgentServices, onKeepSession, onOpenShot}
  const dirty = JSON.stringify(settings) !== baseline
  const project = projects.find(item => item.projectId === projectId)
  useEffect(() => {
    if (!active || !showShots || focusBoard || mobilePanel === 'board') shotsPanel.current?.querySelectorAll('video').forEach(video => {if (!video.paused) video.pause()})
  }, [active, showShots, focusBoard, mobilePanel])

  useEffect(() => {alive.current = true; try {setLegacy(localStorage.getItem(`cqai-track.video-script.${track.id}`))} catch { /* Backup is optional; never overwrite old storage. */ }
    return () => {alive.current = false; generation.current++; pending.current?.abort()}
  }, [track.id])
  useEffect(() => {if (!active) {generation.current++; pending.current?.abort(); setBusy(false)}}, [active])
  useEffect(() => {
    if (!active || loaded) return
    let current = true
    void Promise.all([api<OpenMontageConnection>('openmontage-settings'), api<{projects: OpenMontageProject[]}>(`openmontage-projects?id=${encodeURIComponent(track.id)}`)]).then(([found, list]) => {
      if (!current) return
      setConnection(found); setSettings(found.settings); setBaseline(JSON.stringify(found.settings)); setProjects(list.projects)
      setProjectId(value => value || list.projects[0]?.projectId || ''); setShowSettings(!found.ready); setLoaded(true); setError('')
    }).catch(reason => {if (current) {setError(message(reason)); setLoaded(true)}})
    return () => {current = false}
  }, [active, loaded, track.id])

  const readState = useCallback(async () => {
    const id = latest.current.projectId
    if (!id || !latest.current.active || reading.current) return
    reading.current = true
    try {
      const found = await api<OpenMontageState>(`openmontage-state?id=${encodeURIComponent(track.id)}&projectId=${encodeURIComponent(id)}`)
      if (alive.current && latest.current.active && latest.current.projectId === id) {setState(found); setError('')}
    } catch (reason) {if (alive.current && latest.current.active && latest.current.projectId === id) setError(message(reason))}
    finally {reading.current = false}
  }, [track.id])
  useEffect(() => {
    setState(null)
    if (!active || !projectId || !connection?.ready) return
    void readState()
    const source = typeof EventSource === 'function' ? new EventSource(`${API}/openmontage-events?id=${encodeURIComponent(track.id)}&projectId=${encodeURIComponent(projectId)}`) : null
    const update = () => {void readState()}
    if (source) {source.onmessage = update; source.addEventListener('change', update)}
    const timer = window.setInterval(() => {if (!document.hidden) void readState()}, 5000)
    return () => {source?.close(); window.clearInterval(timer)}
  }, [active, projectId, connection?.ready, refreshKey, boardRefresh, readState, track.id])

  async function saveSettings(): Promise<boolean> {
    if (busy || !loaded) return false
    setBusy(true); setError('')
    try {
      const found = await api<OpenMontageConnection>('openmontage-settings', settings)
      if (!alive.current) return false
      setConnection(found); setSettings(found.settings); setBaseline(JSON.stringify(found.settings)); setNotice(found.ready ? '连接设置已保存' : '设置已保存，请按提示补齐本地环境')
      setBoardRefresh(value => value + 1)
      return true
    } catch (reason) {if (alive.current) setError(message(reason)); return false}
    finally {if (alive.current) setBusy(false)}
  }
  const navigation = useEditorNavigation({active, dirty, busy, save: saveSettings, discard: () => setSettings(JSON.parse(baseline) as OpenMontageSettings), onRegister})
  async function createProject() {
    if (!connection?.ready || busy || !projectTitle.trim()) return
    setBusy(true); setError('')
    try {
      const reply = await api<{project: OpenMontageProject}>('openmontage-projects', {trackId: track.id, title: projectTitle.trim()})
      if (!alive.current) return
      setProjects(value => [reply.project, ...value]); setProjectId(reply.project.projectId); setState(null)
      setShowNewProject(false); setChoices({}); setShotSearch(''); setShotFilter('all')
      setNotice('项目已建立，点击「开始 / 继续策划」与 Agent 确认目标和资料。')
    } catch (reason) {if (alive.current) setError(message(reason))}
    finally {if (alive.current) setBusy(false)}
  }
  async function refreshProjects() {
    if(busy)return
    setBusy(true);setError('')
    try {const found=await api<{projects:OpenMontageProject[]}>(`openmontage-projects?id=${encodeURIComponent(track.id)}`);if(alive.current){setProjects(found.projects);setProjectId(value=>found.projects.some(item=>item.projectId===value)?value:found.projects[0]?.projectId||'')}}
    catch(reason){if(alive.current)setError(message(reason))}
    finally{if(alive.current)setBusy(false)}
  }
  async function agentAction(send: boolean) {
    const current = latest.current, services = current.getAgentServices?.()
    if (!current.projectId || busy) return
    if (!services || !current.onKeepSession) {setError('请在支持原生 Agent 对话的 Desktop 中使用此功能'); return}
    const controller = new AbortController(), ticket = ++generation.current
    pending.current?.abort(); pending.current = controller; setBusy(true); setError('')
    try {
      const session = await ensureOpenMontageAgentSession(services, track.id, current.projectId, controller.signal)
      if (controller.signal.aborted || generation.current !== ticket) return
      await openOpenMontageProjectDrawer(services, session, {onKeepSession: current.onKeepSession, signal: controller.signal, title: `${project?.title || track.name} · OpenMontage`})
      if (send) {
        const request=prepareOpenMontageAgentMessage(services,session,()=>`${session.initialPrompt}\n\n请读取本项目 AGENTS.md 和当前 checkpoint，从现有成果继续。先确认主目标、观众收获、素材范围和制作规格，需求与大纲、脚本、分镜分别提交审阅并等待我在对话中确认。此次只做到分镜及 Track 镜头素材回填，不调用配音、批量生成、剪辑或合成。当前阶段：${state?.currentStage || 'idea'}。`)
        const receipt=await sendOpenMontageAgentMessage(services, session, request.prompt, {requestId: request.requestId, signal: controller.signal})
        if(!alive.current||controller.signal.aborted||generation.current!==ticket||!latest.current.active||latest.current.projectId!==current.projectId)return
        acknowledgeOpenMontageAgentMessage(services,session,receipt)
      }
      if (alive.current && generation.current === ticket) setNotice(send ? '要求已发送到项目 Agent；阶段成果以看板文件为准。' : '已打开本项目的独立 Agent 对话。')
    } catch (reason) {if (alive.current && generation.current === ticket && !controller.signal.aborted) setError(message(reason))}
    finally {if (alive.current && generation.current === ticket) {setBusy(false); pending.current = null}}
  }
  async function openShot(scene: Scene) {
    if (!state?.canProduce || !state.scenePlanDigest || busy) return
    const existing = state.shots.find(item => item.sceneId === scene.id), editor = choices[scene.id] || existing?.editor || 'none'
    if (editor === 'none') return
    setBusy(true); setError('')
    try {
      const result = await api<{shot: OpenMontageState['shots'][number]; state: OpenMontageState}>('openmontage-shot', {trackId: track.id, projectId, sceneId: scene.id, editor, expectedScenePlanDigest: state.scenePlanDigest})
      if (!alive.current || latest.current.projectId !== projectId || !latest.current.active) return
      setState(result.state)
      // Bind before changing the page; the editor always receives a concrete project and shot.
      latest.current.onOpenShot(result.shot.scope, editor)
    } catch (reason) {if (alive.current) setError(message(reason))}
    finally {if (alive.current) setBusy(false)}
  }
  const storyboard = state?.board.storyboard as {scenes?: Scene[]} | undefined
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  const approved = state?.stages.filter(item => ['idea', 'script', 'scene_plan'].includes(item.stage) && item.approved).length || 0
  const safeBoardUrl = state?.boardUrl && /^http:\/\/127\.0\.0\.1:\d+\/p\//u.test(state.boardUrl) ? state.boardUrl : null
  useEffect(() => {
    if (!active || !safeBoardUrl || !boardFrame.current || !planningPanel.current) return
    const stopTheme = observeOpenMontageBoardTheme(boardFrame.current, planningPanel.current)
    const stopVisibility = observeOpenMontageBoardVisibility(boardFrame.current)
    return () => {stopTheme(); stopVisibility()}
  }, [active, safeBoardUrl, projectId, boardRefresh])
  useEffect(() => {
    if (active && safeBoardUrl && boardFrame.current) syncOpenMontageBoardVisibility(boardFrame.current)
  }, [active, safeBoardUrl, projectId, boardRefresh, mobilePanel, focusBoard, showShots])
  const hasAgent = Boolean(getAgentServices?.() && onKeepSession)
  const agentDisabledReason = !connection?.ready ? '先完成本地连接，再开始策划。' : !hasAgent ? '当前浏览器可查看成果；策划对话需要原生 Desktop Agent。' : ''
  const filled = (scene: Scene) => Boolean(state?.shots.find(item => item.sceneId === scene.id)?.takes.length)
  const hasVisual = (scene: Scene) => Boolean(scene.visual && scene.visual.exists !== false)
  const pendingScenes = scenes.filter(scene => !filled(scene) && !hasVisual(scene)).length
  const filledScenes = scenes.filter(filled).length
  const search = shotSearch.trim().toLocaleLowerCase()
  const visibleScenes = scenes.filter(scene => (shotFilter === 'all' || (shotFilter === 'filled' ? filled(scene) : !filled(scene) && !hasVisual(scene))) && (!search || [scene.id, scene.description, scene.shot_intent, scene.narration, ...(scene.required_assets || []).map(asset => asset.description)].filter(Boolean).join(' ').toLocaleLowerCase().includes(search)))
  const nextStage = ['idea', 'script', 'scene_plan'].find(key => !state?.stages.some(item => item.stage === key && item.approved))
  const waitingForConfirmation = state?.stages.find(item => item.stage === nextStage)?.status === 'awaiting_human'
  const nextHint = !projectId ? '选择已有项目，或新建项目开始策划。' : !state ? '正在读取项目成果…' : state.canProduce ? '策划已确认，选择需要录制的镜头进入编辑器。' : waitingForConfirmation ? `请先查看${stageName(nextStage || 'idea')}成果，再到 Agent 对话中确认。` : `在 Agent 对话中继续${stageName(nextStage || state.currentStage)}，提交成果后再确认。`

  return <section ref={planningPanel} className="trk-om" data-focus={focusBoard} data-show-shots={showShots && Boolean(state)} data-mobile-panel={mobilePanel} aria-label="OpenMontage 脚本策划">
    <style>{OPENMONTAGE_PLANNING_CSS}</style>{navigation.dialog}
    <header className="trk-om-heading"><div><h2>脚本策划 <span>OpenMontage</span></h2><p>从需求到分镜，让每个镜头都有清楚的制作方向。</p></div><div className="trk-om-heading-actions"><span className="trk-om-connection" data-ready={Boolean(connection?.ready)} role="status">{!loaded ? '连接检测中…' : connection?.ready ? '本地已连接' : '连接未就绪'}</span><button type="button" aria-expanded={showSettings} aria-controls="trk-om-config" onClick={() => setShowSettings(value => !value)} disabled={busy}>连接设置</button></div></header>
    {showSettings && <form id="trk-om-config" className="trk-om-config" onSubmit={event => {event.preventDefault(); void saveSettings()}}>
      <div className="trk-om-config-heading"><strong>本地连接</strong><span>{connection?.pythonVersion ? `Python ${connection.pythonVersion}` : '填写本机 OpenMontage 与 Python 路径'}</span></div>
      <label>OpenMontage 源码目录<input value={settings.sourceDirectory} onChange={event => setSettings(value => ({...value, sourceDirectory: event.target.value}))} disabled={busy || !loaded}/></label>
      <label>Python 可执行文件<input value={settings.pythonPath} onChange={event => setSettings(value => ({...value, pythonPath: event.target.value}))} disabled={busy || !loaded}/></label>
      <button type="submit" className="trk-primary" disabled={busy || !loaded || !settings.sourceDirectory.trim() || !settings.pythonPath.trim()}>{busy && !pending.current ? '正在检测…' : '保存并检测连接'}</button>
      {dirty && <p className="trk-om-config-help">连接设置有未保存的修改。</p>}
    </form>}
    {!connection && loaded && <button type="button" disabled={busy} onClick={() => setLoaded(false)}>重新读取</button>}
    {connection?.issues.length ? <div className="trk-om-issue-box"><strong>连接需要处理</strong><ul className="trk-om-issues">{connection.issues.map((item, i) => <li key={i}>{item}</li>)}</ul></div> : null}
    {error && <p role="alert" className="trk-om-error">{error}</p>}{notice && <p className="trk-om-notice" role="status">{notice}</p>}
    <div className="trk-om-projects">
      <label>策划项目<select value={projectId} disabled={busy || !projects.length} onChange={event => {const id = event.target.value; navigation.requestLeave(() => {setProjectId(id); setNotice(''); setChoices({}); setShotSearch(''); setShotFilter('all')})}}><option value="">{projects.length ? '选择项目' : '还没有策划项目'}</option>{projects.map(item => <option key={item.projectId} value={item.projectId}>{item.title}</option>)}</select></label>
      <div className="trk-om-project-tools"><button type="button" aria-expanded={showNewProject} aria-controls="trk-om-new-project" disabled={!connection?.ready || busy} onClick={() => setShowNewProject(value => !value)}>新建项目</button><button type="button" disabled={busy || !loaded} onClick={() => navigation.requestLeave(() => void refreshProjects())}>刷新项目</button></div>
      {projectId && <div className="trk-om-actions"><button type="button" disabled={busy || !hasAgent || !connection?.ready} title={agentDisabledReason || undefined} aria-describedby={agentDisabledReason ? 'trk-om-agent-help' : undefined} onClick={() => void agentAction(false)}>打开项目 Agent</button><button type="button" className="trk-primary" disabled={busy || !hasAgent || !connection?.ready} title={agentDisabledReason || undefined} aria-describedby={agentDisabledReason ? 'trk-om-agent-help' : undefined} onClick={() => void agentAction(true)}>开始 / 继续策划</button>{busy && pending.current && <button type="button" onClick={() => {generation.current++; pending.current?.abort(); pending.current = null; setBusy(false); setNotice('已取消页面等待；已发送的 Agent 消息请在对话中停止。')}}>取消等待</button>}</div>}
    </div>
    {showNewProject && <form id="trk-om-new-project" className="trk-om-new-project" onSubmit={event => {event.preventDefault(); navigation.requestLeave(() => void createProject())}}><label>新项目名称<input value={projectTitle} disabled={busy} onChange={event => setProjectTitle(event.target.value)} autoFocus/></label><button type="submit" className="trk-primary" disabled={!connection?.ready || busy || !projectTitle.trim()}>{busy ? '正在创建…' : '创建项目'}</button><button type="button" disabled={busy} onClick={() => setShowNewProject(false)}>取消新建</button></form>}
    {projectId && agentDisabledReason && <p id="trk-om-agent-help" className="trk-om-agent-help">{agentDisabledReason}</p>}
    {projectId && <div className="trk-om-progress"><ol aria-label="策划确认进度">{['idea', 'script', 'scene_plan'].map((key, index) => {const stage = state?.stages.find(item => item.stage === key); return <li key={key} data-approved={Boolean(stage?.approved)} aria-current={state?.currentStage === key ? 'step' : undefined}><span className="trk-om-step-index" aria-hidden="true">{stage?.approved ? '✓' : index + 1}</span><div><strong>{stageName(key)}</strong><span>{stage?.approved ? '已确认' : stateName(stage?.status || '')}</span></div></li>})}</ol><div className="trk-om-next" role="status"><span>{nextHint}</span><small>{approved}/3 已确认</small></div></div>}
    {state?.issues.length ? <div className="trk-om-issue-box"><strong>制作前需要处理</strong><ul className="trk-om-issues">{state.issues.map((item, i) => <li key={i}>{item}</li>)}</ul></div> : null}
    <div className="trk-om-board-toolbar"><div><strong>策划看板</strong>{state && <span>当前：{stageName(state.currentStage)}</span>}</div><div><button type="button" disabled={!projectId || busy} onClick={() => setBoardRefresh(value => value + 1)}>刷新成果</button><button type="button" disabled={!state} aria-pressed={showShots} onClick={() => {setShowShots(value => !value); if (mobilePanel === 'shots') setMobilePanel('board')}}>{showShots ? '收起镜头清单' : '显示镜头清单'}</button><button type="button" aria-pressed={focusBoard} onClick={() => {setFocusBoard(value => !value); setMobilePanel('board')}}>{focusBoard ? '退出专注' : '专注看板'}</button></div></div>
    {state && showShots && !focusBoard && <div className="trk-om-mobile-panels" role="group" aria-label="策划工作区视图"><button type="button" aria-pressed={mobilePanel === 'board'} onClick={() => setMobilePanel('board')}>看板</button><button type="button" aria-pressed={mobilePanel === 'shots'} onClick={() => setMobilePanel('shots')}>镜头清单（{scenes.length}）</button></div>}
    <div className="trk-om-workspace">
      <main className="trk-om-board">{active && safeBoardUrl ? <iframe ref={boardFrame} key={`${projectId}:${boardRefresh}`} title="OpenMontage 生产看板" src={safeBoardUrl} referrerPolicy="no-referrer" allow="fullscreen" onLoad={() => {if (boardFrame.current && planningPanel.current) {syncOpenMontageBoardTheme(boardFrame.current, planningPanel.current); syncOpenMontageBoardVisibility(boardFrame.current)}}}/> : <div className="trk-om-empty"><h3>{projectId ? connection?.ready ? '正在连接策划看板' : '完成连接后查看看板' : '开始你的第一个策划项目'}</h3><p>{projectId ? connection?.ready ? '正在加载大纲、脚本和分镜成果。' : '打开连接设置，按提示检查本地环境。' : '选择已有项目，或点击「新建项目」。'}</p></div>}</main>
      {state && <aside ref={shotsPanel} className="trk-om-shots" aria-label="镜头制作清单"><div className="trk-om-shots-heading"><div><h3>镜头制作</h3><p>{scenes.length} 个镜头 · {filledScenes} 已回填</p></div><span className="trk-om-count">{scenes.length}</span></div>
        {!scenes.length ? <div className="trk-om-list-empty"><strong>还没有分镜</strong><p>先在 Agent 对话中完成大纲、脚本和分镜确认。</p></div> : <><label className="trk-om-shot-search">搜索镜头<input type="search" value={shotSearch} onChange={event => setShotSearch(event.target.value)} placeholder="编号、画面或旁白"/></label><div className="trk-om-shot-filters" role="group" aria-label="镜头素材筛选"><button type="button" aria-pressed={shotFilter === 'all'} onClick={() => setShotFilter('all')}>全部 <span>{scenes.length}</span></button><button type="button" aria-pressed={shotFilter === 'pending'} onClick={() => setShotFilter('pending')}>待制作 <span>{pendingScenes}</span></button><button type="button" aria-pressed={shotFilter === 'filled'} onClick={() => setShotFilter('filled')}>已回填 <span>{filledScenes}</span></button></div><p className="trk-om-filter-count" role="status">显示 {visibleScenes.length} / {scenes.length} 个镜头</p></>}
        {!!scenes.length && !visibleScenes.length && <div className="trk-om-list-empty"><strong>没有匹配的镜头</strong><p>试试其他关键词，或恢复全部镜头。</p><button type="button" onClick={() => {setShotSearch(''); setShotFilter('all')}}>清除筛选</button></div>}
        <div className="trk-om-shot-list">{visibleScenes.map(scene => {const linked = state.shots.find(item => item.sceneId === scene.id), choice = choices[scene.id] || linked?.editor || 'none'; const isFilled = filled(scene), materialStatus = isFilled ? '已回填' : hasVisual(scene) ? '已选素材' : '待制作'; return <article key={scene.id} aria-label={`${scene.id} 镜头`}>
          <div className="trk-om-scene-title"><strong>{scene.id}</strong><span className="trk-om-shot-status" data-filled={isFilled}>{materialStatus}</span><span className="trk-om-duration">{Math.round(scene.duration_seconds || 0)} 秒</span></div>
          <p className="trk-om-scene-description">{scene.description || scene.shot_intent || '待补充画面说明'}</p>
          <label>制作方式<select aria-label={`${scene.id} 制作方式`} value={choice} disabled={busy} onChange={event => setChoices(value => ({...value, [scene.id]: event.target.value as OpenMontageEditor | 'none'}))}><option value="none">使用素材 / 其他制作</option><option value="map">地图编辑器</option><option value="sandbox">3D 沙盘编辑器</option></select></label>
          {choice !== 'none' && <button type="button" className="trk-primary" disabled={!state.canProduce || busy} title={!state.canProduce ? '先在 Agent 对话中确认策划成果' : undefined} onClick={() => navigation.requestLeave(() => void openShot(scene))}>进入镜头编辑</button>}
          {(scene.narration || scene.shot_intent) && <details><summary>旁白与镜头说明</summary>{scene.shot_intent && <p>{scene.shot_intent}</p>}{scene.narration && <blockquote>{scene.narration}</blockquote>}</details>}
          {!!scene.required_assets?.length && <details><summary>所需素材 <span>{scene.required_assets.length}</span></summary><ul>{scene.required_assets.map((asset, i) => <li key={i}>{asset.description} · {asset.source === 'record' ? '需录制' : asset.source === 'provided' ? '用户素材' : asset.source === 'generate' ? '待制作' : '待选取'}</li>)}</ul></details>}
          {(scene.visual || !!scene.audio?.length) && <details><summary>已选素材</summary><ul>{[...(scene.visual ? [scene.visual] : []), ...(scene.audio || [])].map((asset, i) => <li key={`${asset.id}:${i}`}>{asset.type === 'video' ? '视频' : asset.type === 'image' ? '图片' : asset.type === 'audio' ? '音频' : asset.type} · {asset.path?.split(/[\\/]/u).at(-1) || asset.id}{asset.resolution ? ` · ${asset.resolution}` : ''}{asset.exists === false ? ' · 文件缺失' : ''}</li>)}</ul></details>}
          {linked && <div className="trk-om-takes"><span>{linked.takes.length ? `${linked.takes.length} 个录制版本` : '待录制回填'}</span>{linked.takes.map((take, i) => <details key={take.takeId}><summary>版本 {i + 1} · {take.width}×{take.height} · {take.duration.toFixed(1)} 秒</summary><video src={take.url} controls preload="none" playsInline/></details>)}</div>}
        </article>})}</div>
        <details className="trk-om-stage-details"><summary>全部阶段状态</summary>{state.stages.map(stage => <p key={stage.stage}>{stageName(stage.stage)} · {stage.approved ? '已确认' : stateName(stage.status)}</p>)}</details>
      </aside>}
    </div>
    {legacy !== null && <details className="trk-om-legacy"><summary>旧版脚本草稿备份</summary><p>原浏览器草稿已保留；不会自动转成已确认的项目。</p><button type="button" onClick={() => download(`${clipboardSafeName(track.name)}-旧版脚本草稿.json`, legacy)}>下载旧草稿备份</button></details>}
  </section>
}
