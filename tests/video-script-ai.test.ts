import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  generateAnimationScript, type RouteAIContext, type TrackAIAccount,
} from '../src/ai.ts'
import { generateTrackVideoScript, validateVideoScriptRequest } from '../src/video-script-ai.ts'
import type { VideoSceneCandidate, VideoScriptRequest } from '../src/track/video-script-types.ts'

const CANDIDATE: VideoSceneCandidate = {
  id: 'high-point-3', kind: 'high-point', title: '轨迹最高采样点', readiness: 'ready',
  facts: ['第4个轨迹采样点海拔1200米，不等于实际山顶。'], evidence: ['当前轨迹有效高程采样'],
  missing: [], visual: '定位最高有效高程采样点', camera: '', draftNarration: '', onScreenText: '',
  materials: ['制作时核验 DEM'], duration: 10, target: {pointIndex: 3},
}
const SECOND: VideoSceneCandidate = {...CANDIDATE, id: 'finish', kind: 'finish', title: '轨迹终点', target: {pointIndex: 9}}
function request(candidates = [CANDIDATE]): VideoScriptRequest {
  return structuredClone({
    model: 'text-model',
    analysis: {trackName: '合成路线', pointCount: 10, fingerprint: 'synthetic-fingerprint', summary: ['共10个采样点'], limitations: ['不含现场设施资料']},
    candidates, userNotes: '简短介绍，资料参考 https://example.org/route-description',
  })
}
const SHOT = {
  candidateId: CANDIDATE.id, title: '最高采样点', duration: 12, visual: '显示轨迹最高有效海拔采样点',
  camera: '俯视后缓慢推近采样点', narration: '这里是轨迹记录的最高海拔采样点。', onScreenText: '最高采样点 · 1200米',
  materials: ['核对字幕中的单位'],
}
const OUTPUT = {title: '路线空间关系介绍', shots: [SHOT]}
function completion(value: unknown, finish = 'stop'): Response {
  return new Response(JSON.stringify({choices: [{finish_reason: finish, message: {content: JSON.stringify(value)}}]}), {headers: {'content-type': 'application/json'}})
}
function account() {
  return {
    getStatus: vi.fn<TrackAIAccount['getStatus']>().mockResolvedValue({state: 'signed-in'}),
    listModels: vi.fn<TrackAIAccount['listModels']>().mockResolvedValue({models: [{id: 'text-model', name: '合成文本模型', categories: ['text'], supportedEndpointTypes: ['openai']}]}),
    getDefaultModel: vi.fn<TrackAIAccount['getDefaultModel']>().mockResolvedValue({provider: 'cqai', model: 'text-model'}),
    fetchAi: vi.fn<TrackAIAccount['fetchAi']>().mockResolvedValue(completion(OUTPUT)),
  }
}
afterEach(() => vi.useRealTimers())

describe('video script planning with a mocked host model', () => {
  it('supports a single selected scene and assigns identity and target on the server', async () => {
    const host = account(), input = request()
    const result = await generateTrackVideoScript(host, input)
    expect(result).toEqual({
      title: OUTPUT.title,
      shots: [{...SHOT, id: 'shot-1', kind: CANDIDATE.kind, confirmed: false, target: CANDIDATE.target, materials: [...CANDIDATE.materials, ...SHOT.materials]}],
    })
    expect(host.fetchAi).toHaveBeenCalledOnce()
    const [path, init, signal] = host.fetchAi.mock.calls[0]
    const body = JSON.parse(init!.body as string)
    expect(path).toBe('/v1/chat/completions')
    expect(body).toMatchObject({model: 'text-model', temperature: 0.3, max_tokens: 12_000})
    const {model: _model, ...safeContext} = input
    expect(JSON.parse(body.messages[1].content)).toEqual(safeContext)
    expect(body.messages[0].content).toContain('不录制、不生成视频')
    expect(body.messages[0].content).toContain('不能增加其他候选')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(result.shots[0].target).not.toBe(input.candidates[0].target)
  })
  it('preserves the selected order and known candidate facts when the model reorders scenes', async () => {
    const host = account(), input = request([CANDIDATE, SECOND])
    host.fetchAi.mockResolvedValue(completion({title: OUTPUT.title, shots: [{...SHOT, candidateId: SECOND.id}, SHOT]}))
    const result = await generateTrackVideoScript(host, input)
    expect(result.shots.map(shot => [shot.id, shot.candidateId, shot.kind, shot.target?.pointIndex, shot.confirmed])).toEqual([
      ['shot-1', CANDIDATE.id, 'high-point', 3, false], ['shot-2', SECOND.id, 'finish', 9, false],
    ])
  })
  it('retains missing production materials even when the model omits them', async () => {
    const host = account()
    host.fetchAi.mockResolvedValue(completion({...OUTPUT, shots: [{...SHOT, materials: []}]}))
    expect((await generateTrackVideoScript(host, request())).shots[0].materials).toEqual(CANDIDATE.materials)
  })
  it('allows cited text URLs but rejects embedded data media without invoking the model', async () => {
    expect(validateVideoScriptRequest(request()).userNotes).toContain('https://example.org/')
    const host = account(), input = request()
    input.candidates[0].facts = ['data:image/png;base64,NEVER-SEND-PHOTO']
    await expect(generateTrackVideoScript(host, input)).rejects.toMatchObject({status: 400, code: 'invalid-video-script-request'})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it.each([
    ['unknown candidate', {...OUTPUT, shots: [{...SHOT, candidateId: 'invented-peak'}]}],
    ['invented target', {...OUTPUT, shots: [{...SHOT, target: {coordinates: [101, 31]}}]}],
    ['invented kind', {...OUTPUT, shots: [{...SHOT, kind: 'surrounding-peaks'}]}],
    ['invented confirmation', {...OUTPUT, shots: [{...SHOT, confirmed: true}]}],
    ['nested narration', {...OUTPUT, shots: [{...SHOT, narration: {text: '不是字符串'}}]}],
    ['nested materials', {...OUTPUT, shots: [{...SHOT, materials: [{src: 'https://example.org/photo.jpg'}]}]}],
    ['empty camera', {...OUTPUT, shots: [{...SHOT, camera: ''}]}],
    ['short duration', {...OUTPUT, shots: [{...SHOT, duration: 2}]}],
    ['long duration', {...OUTPUT, shots: [{...SHOT, duration: 121}]}],
    ['missing shot', {...OUTPUT, shots: []}],
    ['additional shot', {...OUTPUT, shots: [SHOT, {...SHOT, candidateId: 'extra'}]}],
    ['extra root field', {...OUTPUT, generatedVideo: 'invented.webm'}],
    ['media narration', {...OUTPUT, shots: [{...SHOT, narration: 'data:audio/wav;base64,NEVER-SEND-AUDIO'}]}],
  ])('rejects %s rather than repairing or adopting model output', async (_label, output) => {
    const host = account()
    host.fetchAi.mockResolvedValue(completion(output))
    await expect(generateTrackVideoScript(host, request())).rejects.toMatchObject({status: 502, code: 'ai-invalid-video-script'})
  })
  it('rejects duplicate or missing selected candidates', async () => {
    const host = account(), input = request([CANDIDATE, SECOND])
    host.fetchAi.mockResolvedValue(completion({...OUTPUT, shots: [SHOT, SHOT]}))
    await expect(generateTrackVideoScript(host, input)).rejects.toMatchObject({code: 'ai-invalid-video-script'})
    host.fetchAi.mockResolvedValue(completion(OUTPUT))
    await expect(generateTrackVideoScript(host, input)).rejects.toMatchObject({code: 'ai-invalid-video-script'})
  })
  it('rejects an excessive model total without imposing old overview/follow requirements', async () => {
    const candidates = Array.from({length: 16}, (_, index) => ({...CANDIDATE, id: 'candidate-' + index}))
    const host = account()
    host.fetchAi.mockResolvedValue(completion({title: OUTPUT.title, shots: candidates.map(candidate => ({...SHOT, candidateId: candidate.id, duration: 120}))}))
    await expect(generateTrackVideoScript(host, request(candidates))).rejects.toMatchObject({code: 'ai-invalid-video-script'})
  })
})

describe('bounded candidate request boundary', () => {
  const invalid: Array<[string, (input: VideoScriptRequest) => unknown]> = [
    ['no candidates', input => ({...input, candidates: []})],
    ['too many candidates', input => ({...input, candidates: Array.from({length: 25}, (_, index) => ({...CANDIDATE, id: String(index)}))})],
    ['duplicate ids', input => ({...input, candidates: [CANDIDATE, CANDIDATE]})],
    ['needs-info', input => ({...input, candidates: [{...CANDIDATE, readiness: 'needs-info'}]})],
    ['ready but missing', input => ({...input, candidates: [{...CANDIDATE, missing: ['尚未确认山峰名称']} ]})],
    ['missing facts', input => ({...input, candidates: [{...CANDIDATE, facts: []}]})],
    ['wrong kind', input => ({...input, candidates: [{...CANDIDATE, kind: 'cinematic-flight'}]})],
    ['out of range target', input => ({...input, candidates: [{...CANDIDATE, target: {pointIndex: 10}}]})],
    ['reversed section', input => ({...input, candidates: [{...CANDIDATE, target: {pointIndex: 4, endIndex: 3}}]})],
    ['section without start', input => ({...input, candidates: [{...CANDIDATE, target: {endIndex: 3}}]})],
    ['wrong coordinates', input => ({...input, candidates: [{...CANDIDATE, target: {coordinates: [180.1, 31]}}]})],
    ['three coordinates', input => ({...input, candidates: [{...CANDIDATE, target: {coordinates: [101, 31, 5000]}}]})],
    ['mixed independent point', input => ({...input, candidates: [{...CANDIDATE, target: {placemarkId: 'peak-1', pointIndex: 3}}]})],
    ['unknown target field', input => ({...input, candidates: [{...CANDIDATE, target: {pointIndex: 3, photos: ['NEVER-SEND-PHOTO']}}]})],
    ['source payload', input => ({...input, source: '<gpx>NEVER-SEND-GPX</gpx>'})],
    ['image payload', input => ({...input, candidates: [{...CANDIDATE, images: ['NEVER-SEND-PHOTO']}]})],
    ['summary nested data', input => ({...input, analysis: {...input.analysis, summary: [{source: 'NEVER-SEND-GPX'}]}})],
    ['analysis source', input => ({...input, analysis: {...input.analysis, source: 'NEVER-SEND-GPX'}})],
    ['empty model', input => ({...input, model: ''})],
    ['wrong point count', input => ({...input, analysis: {...input.analysis, pointCount: 1}})],
    ['long notes', input => ({...input, userNotes: 'a'.repeat(4001)})],
    ['candidate duration', input => ({...input, candidates: [{...CANDIDATE, duration: 2}]})],
    ['excessive candidate total', input => ({...input, candidates: Array.from({length: 16}, (_, index) => ({...CANDIDATE, id: String(index), duration: 120}))})],
  ]
  it.each(invalid)('rejects %s before catalog discovery or completion', async (_label, change) => {
    const host = account()
    await expect(generateTrackVideoScript(host, change(request()) as VideoScriptRequest)).rejects.toMatchObject({status: 400, code: 'invalid-video-script-request'})
    expect(host.getStatus).not.toHaveBeenCalled()
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('bounds aggregate facts rather than allowing individually bounded arrays to create a huge prompt', async () => {
    const host = account()
    const candidates = Array.from({length: 24}, (_, index) => ({...CANDIDATE, id: String(index), facts: Array(24).fill('字'.repeat(600)), duration: 3}))
    await expect(generateTrackVideoScript(host, request(candidates))).rejects.toMatchObject({code: 'invalid-video-script-request'})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
})

describe('shared authentication, cancellation and old API regression', () => {
  it('reports the absent account service before request validation and does not invent a script', async () => {
    await expect(generateTrackVideoScript(undefined, {} as VideoScriptRequest)).rejects.toMatchObject({status: 503, code: 'ai-unavailable'})
  })
  it('rejects signed-out accounts and unavailable models without a completion call', async () => {
    const host = account()
    host.getStatus.mockResolvedValueOnce({state: 'signed-out'})
    await expect(generateTrackVideoScript(host, request())).rejects.toMatchObject({status: 503, code: 'ai-models-unavailable'})
    await expect(generateTrackVideoScript(host, {...request(), model: 'not-in-catalog'})).rejects.toMatchObject({status: 400, code: 'ai-model-unavailable'})
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('aborts an active call and skips discovery for an already canceled signal', async () => {
    const host = account(), controller = new AbortController()
    host.fetchAi.mockReturnValue(new Promise(() => {}))
    const pending = generateTrackVideoScript(host, request(), controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({status: 499, code: 'ai-canceled'})
    await vi.waitFor(() => expect(host.fetchAi).toHaveBeenCalledOnce())
    const forwarded = host.fetchAi.mock.calls[0][2]!
    controller.abort()
    await rejected
    expect(forwarded.aborted).toBe(true)
    const next = account()
    await expect(generateTrackVideoScript(next, request(), controller.signal)).rejects.toMatchObject({code: 'ai-canceled'})
    expect(next.getStatus).not.toHaveBeenCalled()
  })
  it('keeps the existing overall 60 second deadline during catalog discovery', async () => {
    vi.useFakeTimers()
    const host = account()
    host.getStatus.mockReturnValue(new Promise(() => {}))
    const pending = generateTrackVideoScript(host, request())
    const rejected = expect(pending).rejects.toMatchObject({status: 504, code: 'ai-timeout'})
    await vi.advanceTimersByTimeAsync(60_001)
    await rejected
    expect(host.fetchAi).not.toHaveBeenCalled()
  })
  it('rejects incomplete JSON and does not expose upstream credential-bearing exceptions', async () => {
    const host = account()
    host.fetchAi.mockResolvedValueOnce(completion(OUTPUT, 'length'))
    await expect(generateTrackVideoScript(host, request())).rejects.toMatchObject({code: 'ai-incomplete-response'})
    host.fetchAi.mockResolvedValueOnce(new Response(JSON.stringify({choices: [{message: {content: 'not-json'}}]})))
    await expect(generateTrackVideoScript(host, request())).rejects.toMatchObject({code: 'ai-invalid-json'})
    host.fetchAi.mockRejectedValueOnce(new Error('NEVER-EXPOSE-TOKEN'))
    await expect(generateTrackVideoScript(host, request())).rejects.toMatchObject({code: 'ai-service-failed', message: expect.not.stringContaining('NEVER-EXPOSE')})
  })
  it('preserves the old animation script contract and its unchanged completion budget', async () => {
    const host = account()
    const script = {title: '旧录制脚本', shots: [{type: 'overview', duration: 3}, {type: 'follow', duration: 3}]}
    const context: RouteAIContext = {
      name: '旧路线', pointCount: 2, distance: 100, elevationGain: 0, elevationLoss: 0, elevationMin: null, elevationMax: null,
      duration: 0, elevationCoverage: 0, timestampCoverage: 0, coordinates: [{index: 0, lon: 101, lat: 31, elevation: null}, {index: 1, lon: 101.01, lat: 31.01, elevation: null}],
      annotations: [], restCandidates: [], userNotes: '',
    }
    host.fetchAi.mockResolvedValueOnce(completion(script))
    expect(await generateAnimationScript(host, {model: 'text-model', context})).toEqual(script)
    const body = JSON.parse(host.fetchAi.mock.calls[0][1]!.body as string)
    expect(body.max_tokens).toBe(3000)
    expect(JSON.parse(body.messages[1].content)).toEqual(context)
    host.fetchAi.mockResolvedValueOnce(completion({...script, shots: [{type: 'overview', duration: 3}]}))
    await expect(generateAnimationScript(host, {model: 'text-model', context})).rejects.toMatchObject({code: 'ai-invalid-script'})
  })
})
