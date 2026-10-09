import { describe, expect, it } from 'vitest'
import type { TrackPoint } from '../src/protocol.ts'
import type { SandboxCameraState } from '../src/track/sandbox/types.ts'
import { createShotEditorPlan, evaluateShotEditorFrame, parseShotEditorPlan, shotEditorTrackFingerprint,
  type ShotEditorPlan } from '../src/track/shot-editor.ts'
import {parseShotEditorProject, resizeShotEditorDuration, retimeShotEditorKey} from '../src/track/shot-editor-workspace.ts'
import {DEFAULT_MAP_SETTINGS} from '../src/track/map-settings.ts'

const camera: SandboxCameraState = {position: [100, 100, 100], target: [0, 0, 0], fov: 40}
function plan(): ShotEditorPlan {
  return createShotEditorPlan({trackId: 'track-1', fingerprint: 'source-1', sceneFingerprint: 'scene-1', title: '环境介绍', camera})
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
}

describe('shared workbench adapters preserve the native shot document', () => {
  it('retimes only its native camera lane while preserving ids, vectors, easing and independent route keys', () => {
    const source = plan(), before = structuredClone(source)
    source.routeKeyframes[0].id = source.cameraKeyframes[1].id
    before.routeKeyframes[0].id = source.cameraKeyframes[1].id
    freeze(source)
    const moved = retimeShotEditorKey(source, 'camera', 'camera-end', 13)
    expect(moved.cameraKeyframes[1]).toEqual({...before.cameraKeyframes[1], time: 13})
    expect(moved.cameraKeyframes[0]).toEqual(before.cameraKeyframes[0])
    expect(moved.routeKeyframes).toEqual(before.routeKeyframes)
    expect(moved.caption).toEqual(before.caption)
    expect(source).toEqual(before)
    expect(parseShotEditorPlan(moved, 'track-1')).toEqual(moved)
  })

  it('rejects collisions within a lane without changing either track and accepts a time used in another lane', () => {
    const source = plan(), before = structuredClone(source)
    expect(() => retimeShotEditorKey(source, 'route', 'route-hold', 13)).toThrow('原关键帧保留')
    expect(source).toEqual(before)
    const moved = retimeShotEditorKey(source, 'camera', 'camera-end', 13)
    expect(moved.cameraKeyframes[1].time).toBe(13)
    const route = retimeShotEditorKey(source, 'route', 'route-hold', 10)
    expect(route.routeKeyframes.find(key => key.id === 'route-hold')).toEqual({id: 'route-hold', time: 10, progress: 0})
    expect(route.cameraKeyframes).toEqual(source.cameraKeyframes)
    expect(() => retimeShotEditorKey(source, 'camera', 'camera-end', NaN)).toThrow()
    expect(() => retimeShotEditorKey(source, 'camera', 'camera-end', 21)).toThrow()
  })

  it('resizes close imported key times without rounding them together or changing camera data', () => {
    const source = plan()
    source.cameraKeyframes[0].time = .001
    source.cameraKeyframes[1].time = .0014
    source.labels = [{id: 'named-place', sourceId: 'source-place', name: '旧地名', coordinates: [114.2, 27.5], from: 2, to: 9}]
    source.caption = {text: '保留字幕', from: 4, to: 14}
    const before = structuredClone(source); freeze(source)
    const resized = resizeShotEditorDuration(source, 1)
    expect(resized.cameraKeyframes[0].time).toBeCloseTo(.001 / 20, 12)
    expect(resized.cameraKeyframes[1].time).toBeCloseTo(.0014 / 20, 12)
    expect(new Set(resized.cameraKeyframes.map(key => key.time)).size).toBe(2)
    expect(resized.cameraKeyframes.map(key => key.camera)).toEqual(before.cameraKeyframes.map(key => key.camera))
    expect(resized.routeKeyframes.map(key => [key.id, key.time, key.progress])).toEqual(before.routeKeyframes.map(key => [key.id, key.time / 20, key.progress]))
    expect(resized.labels[0]).toEqual({...before.labels[0], from: .1, to: .45})
    expect(resized.caption.text).toBe('保留字幕'); expect(resized.caption.from).toBeCloseTo(.2); expect(resized.caption.to).toBeCloseTo(.7)
    expect(parseShotEditorPlan(resized, 'track-1')).toEqual(resized); expect(source).toEqual(before)
    expect(() => resizeShotEditorDuration(source, 0)).toThrow()
    expect(() => resizeShotEditorDuration(source, 1801)).toThrow()
  })

  it('accepts the original legacy payload and versioned workspace envelope without converting coordinates', () => {
    const source = {schema: 'cqai-track-shot-editor@1', plan: plan(), appearance: {
      lighting: structuredClone(DEFAULT_MAP_SETTINGS.lighting), sandboxColors: structuredClone(DEFAULT_MAP_SETTINGS.sandboxColors),
      sandboxBackground: DEFAULT_MAP_SETTINGS.sandboxBackground,
    }}
    const restored = parseShotEditorProject(source, 'track-1')!
    expect(restored).toEqual(source)
    expect(parseShotEditorProject({...source, revision: 'saved-v1', updatedAt: '2026-10-09'}, 'track-1')).toEqual(source)
    restored.plan.cameraKeyframes[0].camera.position[0] = 999
    restored.appearance.lighting.ambient = 0
    expect(source.plan.cameraKeyframes[0].camera.position[0]).toBe(100)
    expect(source.appearance.lighting.ambient).toBe(DEFAULT_MAP_SETTINGS.lighting.ambient)
    expect(parseShotEditorProject(source, 'another-track')).toBe(null)
    expect(parseShotEditorProject({...source, schema: 'unknown'}, 'track-1')).toBe(null)
    expect(parseShotEditorProject({...source, appearance: null}, 'track-1')).toBe(null)
    expect(parseShotEditorProject({...source, appearance: {...source.appearance, sandboxBackground: 'unsupported'}}, 'track-1')).toBe(null)
  })
})

describe('executable shot timeline', () => {
  it('starts with two detached camera frames, a separate hold/draw/hold route track and a 20 second duration', () => {
    const input = structuredClone(camera), built = createShotEditorPlan({
      trackId: 'track-1', fingerprint: 'source-1', sceneFingerprint: 'scene-1', title: '环境介绍', camera: input,
    })
    expect(built.duration).toBe(20)
    expect(built.cameraKeyframes.map(key => key.time)).toEqual([0, 20])
    expect(built.cameraKeyframes[0].camera).toEqual(camera)
    expect(built.cameraKeyframes[1].camera.position).not.toEqual(camera.position)
    expect(built.cameraKeyframes[1].camera.target).toEqual(camera.target)
    expect(built.routeKeyframes.map(key => [key.time, key.progress])).toEqual([[0, 0], [4, 0], [13, 1], [20, 1]])
    expect(built.labels).toEqual([])
    expect(built.caption.text).toBe('')
    input.position[0] = 900
    expect(built.cameraKeyframes[0].camera.position[0]).toBe(100)
    expect(evaluateShotEditorFrame(built, 2).routeProgress).toBe(0)
    expect(evaluateShotEditorFrame(built, 2).camera).not.toEqual(evaluateShotEditorFrame(built, 0).camera)
    expect(evaluateShotEditorFrame(built, 7).routeProgress).toBeCloseTo(1 / 3)
    expect(evaluateShotEditorFrame(built, 17).routeProgress).toBe(1)
  })

  it('applies smooth easing only within the outgoing camera interval while route time stays linear', () => {
    const built = plan()
    built.duration = 10
    built.cameraKeyframes = [{id: 'start', time: 0, camera: structuredClone(camera), easing: 'smooth'},
      {id: 'end', time: 10, camera: {...structuredClone(camera), position: [300, 100, 100], fov: 60}, easing: 'linear'}]
    built.routeKeyframes = [{id: 'route-a', time: 0, progress: 0}, {id: 'route-b', time: 10, progress: 1}]
    const smooth = evaluateShotEditorFrame(built, 2.5)
    expect(smooth.camera?.position[0]).toBeCloseTo(131.25)
    expect(smooth.camera?.fov).toBeCloseTo(43.125)
    expect(smooth.routeProgress).toBe(.25)
    built.cameraKeyframes[0].easing = 'linear'
    expect(evaluateShotEditorFrame(built, 2.5).camera?.position[0]).toBe(150)
    expect(evaluateShotEditorFrame(built, 0).camera).toEqual(camera)
    expect(evaluateShotEditorFrame(built, 10).camera).toEqual(built.cameraKeyframes[1].camera)
  })

  it('holds before/after the available camera keys and supports an empty camera track without inventing a view', () => {
    const built = plan()
    built.cameraKeyframes[0].time = 3
    built.cameraKeyframes[1].time = 16
    expect(evaluateShotEditorFrame(built, 0).camera).toEqual(built.cameraKeyframes[0].camera)
    expect(evaluateShotEditorFrame(built, 20).camera).toEqual(built.cameraKeyframes[1].camera)
    built.cameraKeyframes = []
    built.routeKeyframes = []
    expect(evaluateShotEditorFrame(built, 10)).toMatchObject({camera: null, routeProgress: 1})
  })

  it('makes reverse seeking and repeated evaluation deterministic and detaches every returned editable value', () => {
    const built = plan()
    built.labels = [{id: 'label-1', sourceId: 'kml-12', name: '发云界', coordinates: [114.1969984, 27.5231532], from: 4, to: 13}]
    built.caption = {text: '路线环境', from: 7, to: 10}
    freeze(built)
    const original = JSON.stringify(built), reference = evaluateShotEditorFrame(built, 8)
    evaluateShotEditorFrame(built, 19)
    evaluateShotEditorFrame(built, 2)
    expect(evaluateShotEditorFrame(built, 8)).toEqual(reference)
    reference.camera!.position[0] = 20000
    reference.labels[0].coordinates[0] = 10
    reference.labels[0].name = 'changed'
    expect(evaluateShotEditorFrame(built, 8).labels[0].name).toBe('发云界')
    expect(evaluateShotEditorFrame(built, 8).camera!.position[0]).not.toBe(20000)
    expect(JSON.stringify(built)).toBe(original)
    expect(evaluateShotEditorFrame(built, 4).labels).toHaveLength(1)
    expect(evaluateShotEditorFrame(built, 13).labels).toHaveLength(1)
    expect(evaluateShotEditorFrame(built, 13.01).labels).toEqual([])
    expect(evaluateShotEditorFrame(built, 7).caption).toBe('路线环境')
    expect(evaluateShotEditorFrame(built, 10).caption).toBe('路线环境')
    expect(evaluateShotEditorFrame(built, 10.01).caption).toBe('')
  })

  it('clamps seeks without accumulating playback state', () => {
    const built = plan()
    expect(evaluateShotEditorFrame(built, -100)).toEqual(evaluateShotEditorFrame(built, 0))
    expect(evaluateShotEditorFrame(built, NaN)).toEqual(evaluateShotEditorFrame(built, 0))
    expect(evaluateShotEditorFrame(built, -Infinity)).toEqual(evaluateShotEditorFrame(built, 0))
    expect(evaluateShotEditorFrame(built, Infinity)).toEqual(evaluateShotEditorFrame(built, 20))
    expect(evaluateShotEditorFrame(built, 200)).toEqual(evaluateShotEditorFrame(built, 20))
  })
})

describe('untrusted executable shot documents', () => {
  it('validates, sorts detached keyframes and accepts versioned JSON strings only for the expected track', () => {
    const input = plan()
    input.cameraKeyframes.reverse()
    input.routeKeyframes.reverse()
    const parsed = parseShotEditorPlan(input, 'track-1')!
    expect(parsed).not.toBeNull()
    expect(parsed.cameraKeyframes.map(key => key.time)).toEqual([0, 20])
    expect(input.cameraKeyframes.map(key => key.time)).toEqual([20, 0])
    parsed.cameraKeyframes[0].camera.position[0] = 300
    expect(input.cameraKeyframes[1].camera.position[0]).toBe(100)
    expect(parseShotEditorPlan(JSON.stringify(plan()), 'track-1')).toEqual(plan())
    expect(parseShotEditorPlan(plan(), 'other-track')).toBeNull()
    expect(parseShotEditorPlan('{broken')).toBeNull()
  })

  it.each([
    ['unsupported version', (value: ShotEditorPlan) => { (value as {version: number}).version = 2 }],
    ['NaN duration', (value: ShotEditorPlan) => { value.duration = NaN }],
    ['unbounded duration', (value: ShotEditorPlan) => { value.duration = 1801 }],
    ['zero duration', (value: ShotEditorPlan) => { value.duration = 0 }],
    ['unsafe track id', (value: ShotEditorPlan) => { value.trackId = '../track' }],
    ['long title', (value: ShotEditorPlan) => { value.title = 'x'.repeat(161) }],
    ['unsafe color', (value: ShotEditorPlan) => { value.routeColor = 'red' }],
    ['infinite camera', (value: ShotEditorPlan) => { value.cameraKeyframes[0].camera.position[0] = Infinity }],
    ['bounded camera', (value: ShotEditorPlan) => { value.cameraKeyframes[0].camera.position[0] = 1e9 + 1 }],
    ['invalid FOV', (value: ShotEditorPlan) => { value.cameraKeyframes[0].camera.fov = 180 }],
    ['coincident camera target', (value: ShotEditorPlan) => { value.cameraKeyframes[0].camera.position = [0, 0, 0] }],
    ['negative time', (value: ShotEditorPlan) => { value.cameraKeyframes[0].time = -1 }],
    ['time outside movie', (value: ShotEditorPlan) => { value.cameraKeyframes[1].time = 21 }],
    ['duplicate camera time', (value: ShotEditorPlan) => { value.cameraKeyframes[1].time = 0 }],
    ['duplicate camera id', (value: ShotEditorPlan) => { value.cameraKeyframes[1].id = value.cameraKeyframes[0].id }],
    ['duplicate route time', (value: ShotEditorPlan) => { value.routeKeyframes[1].time = 0 }],
    ['duplicate route id', (value: ShotEditorPlan) => { value.routeKeyframes[1].id = value.routeKeyframes[0].id }],
    ['invalid progress', (value: ShotEditorPlan) => { value.routeKeyframes[1].progress = 1.01 }],
    ['NaN progress', (value: ShotEditorPlan) => { value.routeKeyframes[1].progress = NaN }],
    ['caption outside movie', (value: ShotEditorPlan) => { value.caption.to = 21 }],
    ['reversed caption interval', (value: ShotEditorPlan) => { value.caption.from = 10; value.caption.to = 9 }],
    ['excessive keys', (value: ShotEditorPlan) => { value.cameraKeyframes = Array.from({length: 129}, () => value.cameraKeyframes[0]) }],
  ])('rejects %s', (_description, change) => {
    const value = plan()
    change(value)
    expect(parseShotEditorPlan(value)).toBeNull()
  })

  it('rejects duplicate labels, illegal geographic coordinates and missing fields', () => {
    const value = plan()
    value.labels = [{id: 'location', sourceId: 'kml-12', name: '发云界', coordinates: [180.01, 27], from: 0, to: 20}]
    expect(parseShotEditorPlan(value)).toBeNull()
    value.labels[0].coordinates = [114, 90.01]
    expect(parseShotEditorPlan(value)).toBeNull()
    value.labels[0].coordinates = [114, 27]
    expect(parseShotEditorPlan(value)).not.toBeNull()
    value.labels.push({...value.labels[0]})
    expect(parseShotEditorPlan(value)).toBeNull()
    const missing = {...plan()} as Partial<ShotEditorPlan>
    delete missing.sceneFingerprint
    expect(parseShotEditorPlan(missing)).toBeNull()
  })

  it('does not invoke accessors or trust inherited records, unusual arrays, symbols or prototype payloads', () => {
    let getterCalls = 0
    const accessor = {...plan()}
    Object.defineProperty(accessor, 'title', {get: () => { getterCalls++; return 'bad' }, enumerable: true})
    expect(parseShotEditorPlan(accessor)).toBeNull()
    expect(getterCalls).toBe(0)
    const inherited = Object.assign(Object.create({inherited: true}), plan())
    expect(parseShotEditorPlan(inherited)).toBeNull()
    const nested = plan()
    Object.setPrototypeOf(nested.cameraKeyframes[0].camera, {hidden: true})
    expect(parseShotEditorPlan(nested)).toBeNull()
    const symbol = {...plan(), [Symbol('payload')]: true}
    expect(parseShotEditorPlan(symbol)).toBeNull()
    const prototypePayload = JSON.parse(JSON.stringify(plan()))
    Object.defineProperty(prototypePayload, '__proto__', {value: {}, enumerable: true})
    expect(parseShotEditorPlan(prototypePayload)).toBeNull()
    const sparse = plan()
    delete sparse.cameraKeyframes[0]
    expect(parseShotEditorPlan(sparse)).toBeNull()
    const arrayAccessor = plan()
    Object.defineProperty(arrayAccessor.cameraKeyframes, '0', {get: () => { getterCalls++; return null }, enumerable: true})
    expect(parseShotEditorPlan(arrayAccessor)).toBeNull()
    expect(getterCalls).toBe(0)
  })
})

describe('shot source identity', () => {
  const points: TrackPoint[] = [[114, 27, 500, null], [114.01, 27, 800, null], [114.02, 27.01, 600, null]]
  it('includes real route breaks and samples without changing their order or values', () => {
    const original = JSON.stringify(points)
    expect(shotEditorTrackFingerprint(points, [0, 2])).toBe(shotEditorTrackFingerprint(points, [2, 0, 2]))
    expect(shotEditorTrackFingerprint(points, [0, 2])).not.toBe(shotEditorTrackFingerprint(points, [0]))
    const changed = structuredClone(points)
    changed[1][0] += .000001
    expect(shotEditorTrackFingerprint(changed, [0, 2])).not.toBe(shotEditorTrackFingerprint(points, [0, 2]))
    changed[1][0] = points[1][0]
    changed[1][3] = 1000
    expect(shotEditorTrackFingerprint(changed, [0, 2])).not.toBe(shotEditorTrackFingerprint(points, [0, 2]))
    expect(JSON.stringify(points)).toBe(original)
  })
})
