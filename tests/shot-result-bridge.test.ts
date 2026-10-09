// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {assertShotCaptureApproval, freezeShotResult, shotResultMatches, ShotResultUpload, uploadShotResult, type ShotResultIdentity} from '../src/client/shot-result-bridge.tsx'
import {shotProjectKey, shotScopeQuery, type OpenMontageEditorScope} from '../src/track/shot-project-scope.ts'
import {API} from '../src/protocol.ts'

const scope: OpenMontageEditorScope = {projectId: 'project-1', shotId: 'shot-1', sceneId: 'SC03', scenePlanDigest: 'digest-1'}
let node: HTMLDivElement, root: Root
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', fetcher); node = document.createElement('div'); document.body.append(node); root = createRoot(node)})
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals()})
function json(value: unknown, status = 200) {return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})}
function ack(identity: ShotResultIdentity) {return {take: {takeId: identity.takeId, shotId: identity.scope.shotId, sceneId: identity.scope.sceneId, editor: identity.editor, projectRevision: identity.projectRevision, scenePlanDigest: identity.scope.scenePlanDigest}}}
function approved(identity: ShotResultIdentity) {return {canProduce: true, scenePlanDigest: identity.scope.scenePlanDigest, project: {projectId: identity.scope.projectId, trackId: identity.trackId}, shots: [{shotId: identity.scope.shotId, sceneId: identity.scope.sceneId, editor: identity.editor, scope: {...identity.scope}}]}}
describe('frozen planning shot capture identity', () => {
  it('keeps independent compound keys and encoded scope query without changing legacy URLs', () => {
    expect(shotScopeQuery()).toBe(''); expect(shotScopeQuery(scope)).toBe('&projectId=project-1&shotId=shot-1')
    expect(shotScopeQuery({projectId: 'a b', shotId: 'c/d'})).toBe('&projectId=a%20b&shotId=c%2Fd')
    expect(new Set([shotProjectKey('a', scope), shotProjectKey('a'), shotProjectKey('a', {...scope, shotId: 'shot-2'}), shotProjectKey('a', {...scope, projectId: 'project-2'})]).size).toBe(4)
  })
  it('freezes scope and revision and blocks unconfirmed, edited or reassigned outputs', () => {
    const original = {...scope}, identity = freezeShotResult('track-1', original, 'revision-1', 'map')!
    original.scenePlanDigest = 'changed'
    expect(Object.isFrozen(identity)).toBe(true); expect(Object.isFrozen(identity.scope)).toBe(true)
    expect(identity.scope.scenePlanDigest).toBe('digest-1'); expect(identity.takeId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(freezeShotResult('track-1', undefined, null, 'map')).toBeUndefined()
    expect(() => freezeShotResult('track-1', scope, null, 'map')).toThrow('请先保存')
    expect(() => freezeShotResult('track-1', {...scope, scenePlanDigest: ''}, 'r', 'map')).toThrow('已确认分镜')
    expect(shotResultMatches(identity, scope, 'revision-1', false)).toBe(true)
    for (const altered of [{...scope, shotId: 'shot-2'}, {...scope, projectId: 'project-2'}, {...scope, sceneId: 'SC04'}, {...scope, scenePlanDigest: 'digest-2'}, undefined]) expect(shotResultMatches(identity, altered, 'revision-1', false)).toBe(false)
    expect(shotResultMatches(identity, scope, 'revision-2', false)).toBe(false); expect(shotResultMatches(identity, scope, 'revision-1', true)).toBe(false)
  })
  it('uploads the actual Blob through a same-origin binary request with exact frozen identifiers', async () => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'sandbox')!, blob = new Blob(['actual frames'], {type: 'video/webm'})
    fetcher.mockResolvedValueOnce(json(ack(identity)))
    await uploadShotResult(blob, identity)
    const [path, options] = fetcher.mock.calls[0]; expect(String(path).startsWith(`${API}/openmontage-shot-result?`)).toBe(true)
    const query = new URL(String(path), 'http://127.0.0.1').searchParams
    expect(Object.fromEntries(query)).toEqual({id: 'track-1', projectId: scope.projectId, shotId: scope.shotId, takeId: identity.takeId, scenePlanDigest: scope.scenePlanDigest, projectRevision: 'revision-1', editor: 'sandbox'})
    expect(options?.body).toBe(blob); expect(options?.headers).toEqual({'content-type': 'video/webm', 'x-cqai-track': '1'})
  })
  it('checks the native approval and exact current shot binding on explicit output', async () => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!, controller = new AbortController()
    fetcher.mockResolvedValueOnce(json(approved(identity)))
    await assertShotCaptureApproval(identity, controller.signal)
    const [path, options] = fetcher.mock.calls[0]
    expect(String(path)).toBe(`${API}/openmontage-state?id=track-1&projectId=project-1`)
    expect(options?.signal).toBe(controller.signal); expect(options?.body).toBeUndefined()
  })
  it.each(['approval', 'digest', 'project', 'track', 'missing-shot', 'scene', 'editor', 'scope'])('blocks output when native %s identity is no longer current', async changed => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!, state = approved(identity)
    if (changed === 'approval') state.canProduce = false
    if (changed === 'digest') state.scenePlanDigest = 'different'
    if (changed === 'project') state.project.projectId = 'other-project'
    if (changed === 'track') state.project.trackId = 'other-track'
    if (changed === 'missing-shot') state.shots = []
    if (changed === 'scene') state.shots[0].sceneId = 'SC99'
    if (changed === 'editor') state.shots[0].editor = 'sandbox'
    if (changed === 'scope') state.shots[0].scope.scenePlanDigest = 'different'
    fetcher.mockResolvedValueOnce(json(state))
    await expect(assertShotCaptureApproval(identity)).rejects.toThrow('镜头工程已保留')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('fails closed on unreadable or failed state and supports cancelling a pending state request', async () => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!
    fetcher.mockResolvedValueOnce(new Response('not json')).mockResolvedValueOnce(json({error: '连接失败，镜头工程已保留'}, 503))
    await expect(assertShotCaptureApproval(identity)).rejects.toThrow('无法核验')
    await expect(assertShotCaptureApproval(identity)).rejects.toThrow('连接失败')
    const controller = new AbortController()
    fetcher.mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    const pending = assertShotCaptureApproval(identity, controller.signal)
    controller.abort(); await expect(pending).rejects.toThrow('Aborted')
  })
  it.each([{}, {take: {takeId: 'wrong-take'}}])('rejects an unconfirmed backfill acknowledgement without discarding the capture: %j', async result => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!, blob = new Blob(['frames'])
    fetcher.mockResolvedValueOnce(json(result))
    await expect(uploadShotResult(blob, identity)).rejects.toThrow('服务端未确认')
    expect(fetcher.mock.calls[0][1]!.body).toBe(blob)
  })
  it('preserves a failed upload and retries with the same take ID, while a changed project disables backfill', async () => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!, blob = new Blob(['frames'], {type: 'video/webm'}), onBusy = vi.fn(), onUploaded = vi.fn()
    fetcher.mockResolvedValueOnce(json({error: '分镜版本已变化，视频保留'}, 409)).mockResolvedValueOnce(json(ack(identity)))
    const props = {blob, identity, scope, revision: 'revision-1', dirty: false, active: true, onBusy, onUploaded}
    await act(async () => root.render(createElement(ShotResultUpload, props)))
    await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
    expect(node.textContent).toContain('分镜版本已变化'); expect(node.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
    await act(async () => root.render(createElement(ShotResultUpload, {...props, dirty: true})))
    expect(node.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    await act(async () => root.render(createElement(ShotResultUpload, props)))
    await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
    expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]); expect(fetcher.mock.calls[1][1]?.body).toBe(blob)
    expect(onUploaded).toHaveBeenCalledTimes(1); expect(node.textContent).toContain('已回填当前分镜素材'); expect(onBusy.mock.calls.flat()).toContain(false)
  })
  it('aborts an in-flight upload when the editor unmounts', async () => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!, onBusy = vi.fn()
    fetcher.mockImplementation((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    await act(async () => root.render(createElement(ShotResultUpload, {blob: new Blob(['frames']), identity, scope, revision: 'revision-1', dirty: false, active: true, onBusy})))
    await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
    const signal = fetcher.mock.calls[0][1]!.signal!; expect(signal.aborted).toBe(false)
    await act(async () => root.unmount()); expect(signal.aborted).toBe(true); expect(onBusy).toHaveBeenLastCalledWith(false); root = createRoot(node)
  })
  it('cancels upload without losing the take identity and permits an idempotent retry', async () => {
    const identity = freezeShotResult('track-1', scope, 'revision-1', 'map')!, blob = new Blob(['frames']), onBusy = vi.fn()
    fetcher.mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
      .mockResolvedValueOnce(json(ack(identity)))
    await act(async () => root.render(createElement(ShotResultUpload, {blob, identity, scope, revision: 'revision-1', dirty: false, active: true, onBusy})))
    await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
    await act(async () => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '取消回填')!.click())
    expect(node.textContent).toContain('视频已保留，可重试'); expect(onBusy).toHaveBeenLastCalledWith(false)
    await act(async () => node.querySelector<HTMLButtonElement>('button')!.click())
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]); expect(fetcher.mock.calls[1][1]!.body).toBe(blob)
    expect(node.textContent).toContain('已回填当前分镜素材')
  })
})
