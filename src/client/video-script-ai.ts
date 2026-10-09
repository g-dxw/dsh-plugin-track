/** Same-origin text suggestions for selected route-film scenes; never generates video assets. */
import { API } from '../protocol.ts'
import { validateVideoScriptDraft } from '../track/video-script.ts'
import { MAX_VIDEO_SHOTS, type VideoSceneCandidate, type VideoScriptAnalysis, type VideoScriptRequest, type VideoScriptSuggestion } from '../track/video-script-types.ts'

function scene(candidate: VideoSceneCandidate): VideoSceneCandidate {
  return {
    id: candidate.id, kind: candidate.kind, title: candidate.title, readiness: candidate.readiness,
    facts: [...candidate.facts], evidence: [...candidate.evidence], missing: [...candidate.missing],
    visual: candidate.visual, camera: candidate.camera, draftNarration: candidate.draftNarration,
    onScreenText: candidate.onScreenText, materials: [...candidate.materials], duration: candidate.duration,
    ...(candidate.target ? {target: {
      ...(candidate.target.pointIndex === undefined ? {} : {pointIndex: candidate.target.pointIndex}),
      ...(candidate.target.endIndex === undefined ? {} : {endIndex: candidate.target.endIndex}),
      ...(candidate.target.coordinates ? {coordinates: [...candidate.target.coordinates] as [number, number]} : {}),
      ...(candidate.target.placemarkId === undefined ? {} : {placemarkId: candidate.target.placemarkId}),
    }} : {}),
  }
}
export async function generateVideoScript(input: VideoScriptRequest, signal?: AbortSignal): Promise<VideoScriptSuggestion> {
  if (signal?.aborted) throw new DOMException('AI 请求已取消', 'AbortError')
  if (!input.model?.trim()) throw new Error('请选择文本模型')
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > MAX_VIDEO_SHOTS
    || input.candidates.some(candidate => candidate.readiness !== 'ready')
    || new Set(input.candidates.map(candidate => candidate.id)).size !== input.candidates.length) throw new Error('请选择 1–24 个资料完整的镜头')
  const payload: VideoScriptRequest = {
    model: input.model.trim(),
    analysis: {trackName: input.analysis.trackName, pointCount: input.analysis.pointCount, fingerprint: input.analysis.fingerprint,
      summary: [...input.analysis.summary], limitations: [...input.analysis.limitations]},
    candidates: input.candidates.map(scene), userNotes: input.userNotes,
  }
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, {once: true})
  const timer = setTimeout(() => {timedOut = true; controller.abort()}, 65_000)
  try {
    const response = await fetch(`${API}/video-script`, {method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify(payload)})
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('视频脚本服务暂未就绪，请重启插件后重试')
    const found: unknown = await response.json()
    if (controller.signal.aborted) throw new DOMException('AI 请求已取消', 'AbortError')
    const result = found && typeof found === 'object' && !Array.isArray(found) ? found as Record<string, unknown> : null
    if (!result) throw new Error('AI 文案建议格式无效')
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '生成视频脚本文案失败')
    if (!Array.isArray(result.shots) || result.shots.length !== payload.candidates.length) throw new Error('AI 文案建议的镜头数量不匹配')
    const validation: VideoScriptAnalysis = {trackId: 'ai-response', ...payload.analysis, candidates: payload.candidates}
    const draft = validateVideoScriptDraft({version: 1, trackId: validation.trackId, fingerprint: validation.fingerprint,
      title: result.title, notes: payload.userNotes, shots: result.shots}, validation)
    if (draft.shots.some(shot => shot.confirmed) || new Set(draft.shots.map(shot => shot.candidateId)).size !== payload.candidates.length) throw new Error('AI 建议必须经过人工确认')
    return {title: draft.title, shots: draft.shots}
  } catch (reason) {
    if (signal?.aborted) throw new DOMException('AI 请求已取消', 'AbortError')
    if (timedOut) throw new Error('文本模型响应超时，请重试或更换模型')
    throw reason instanceof Error ? reason : new Error('无法连接视频脚本服务')
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort)}
}
