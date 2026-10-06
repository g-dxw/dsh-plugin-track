import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trackDir, writeTrack } from '../src/artifacts.ts'
import { ensureTrackAgentWorkspace, saveTrackAgentSession, writeTrackAgentContext } from '../src/track-agent-store.ts'

const faults = vi.hoisted(() => ({renameCode: '', remaining: 0, attempts: 0, collision: false}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[0]).includes('track-context.json.') && faults.renameCode) {
      faults.attempts += 1
      if (faults.remaining > 0) {
        faults.remaining -= 1
        throw Object.assign(new Error('simulated snapshot replacement failure'), {code: faults.renameCode})
      }
    }
    return fs.renameSync(...args)
  }, openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (faults.collision && String(args[0]).includes('track-context.json.')) fs.writeFileSync(args[0], 'unowned colliding snapshot')
    return fs.openSync(...args)
  }}
})
let env: NodeJS.ProcessEnv, id: string
const input = {name: '武功山反穿', filename: '武功山反穿.gpx', source: '<gpx>original</gpx>', points: [[120, 30, 100, null], [120.1, 30.1, 120, null]] as [number, number, number | null, number | null][], metrics: {distance: 100, elevationGain: 20, elevationLoss: 0, duration: 0, elevationMin: 100, elevationMax: 120, bbox: [120, 30, 120.1, 30.1] as [number, number, number, number]}}
beforeEach(() => {
  env = {DSH_HOME: mkdtempSync(join(tmpdir(), 'track-agent-'))}
  id = writeTrack(input, env).id
})
afterEach(() => {
  faults.renameCode = ''; faults.remaining = 0; faults.attempts = 0; faults.collision = false
  vi.restoreAllMocks()
  rmSync(env.DSH_HOME!, {recursive: true, force: true})
})
const snapshot = (trackId?: string | null) => JSON.parse(readFileSync(join(ensureTrackAgentWorkspace(env, trackId).path, 'track-context.json'), 'utf8'))

describe('native track Agent project workspaces', () => {
  it('retries a transient Windows EPERM/EBUSY snapshot lock and then replaces it atomically', () => {
    const project = ensureTrackAgentWorkspace(env, id)
    for (const code of ['EPERM', 'EBUSY']) {
      faults.renameCode = code; faults.remaining = 2; faults.attempts = 0
      const context = writeTrackAgentContext({page: 'route-information', trackId: id}, env)
      expect(faults.attempts).toBe(3)
      expect(snapshot(id).current).toEqual(context.current)
      expect(readdirSync(project.path).filter(name => name.endsWith('.tmp'))).toEqual([])
    }
  })
  it('bounds retries below one second and retains the complete old snapshot on a permanent lock', () => {
    const project = ensureTrackAgentWorkspace(env, id), target = join(project.path, 'track-context.json'), original = readFileSync(target)
    writeFileSync(join(project.path, 'user-draft.md'), '用户资料保持不变')
    const waits: number[] = []
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {waits.push(timeout ?? 0); return 'timed-out'})
    faults.renameCode = 'EPERM'; faults.remaining = 100
    expect(() => writeTrackAgentContext({page: 'route-information', trackId: id}, env)).toThrow('replacement failure')
    expect(waits.length).toBeGreaterThan(0); expect(waits.reduce((sum, value) => sum + value, 0)).toBeLessThan(1000)
    expect(faults.attempts).toBe(waits.length + 1)
    expect(readFileSync(target)).toEqual(original)
    expect(readFileSync(join(project.path, 'user-draft.md'), 'utf8')).toBe('用户资料保持不变')
    expect(readdirSync(project.path).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('fails unrelated rename errors immediately and preserves unowned temporary collisions', () => {
    const project = ensureTrackAgentWorkspace(env, id), target = join(project.path, 'track-context.json'), original = readFileSync(target)
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out')
    for (const code of ['EACCES', 'EXDEV']) {
      faults.renameCode = code; faults.remaining = 100; faults.attempts = 0
      expect(() => writeTrackAgentContext({page: 'route-information', trackId: id}, env)).toThrow('replacement failure')
      expect(faults.attempts).toBe(1); expect(wait).not.toHaveBeenCalled()
      expect(readFileSync(target)).toEqual(original)
      expect(readdirSync(project.path).filter(name => name.endsWith('.tmp'))).toEqual([])
    }
    faults.renameCode = ''; faults.collision = true
    expect(() => writeTrackAgentContext({page: 'route-information', trackId: id}, env)).toThrow()
    faults.collision = false
    expect(readFileSync(target)).toEqual(original)
    const collision = readdirSync(project.path).filter(name => name.endsWith('.tmp'))
    expect(collision).toHaveLength(1)
    expect(readFileSync(join(project.path, collision[0]), 'utf8')).toBe('unowned colliding snapshot')
  })
  it('gives each route information Agent its own workspace and read-only real source paths', () => {
    const secondId = writeTrack({...input, name: '第二条路线', filename: 'second.kml', source: '<kml>second</kml>'}, env).id
    const placemarkState = join(trackDir(id, env), 'placemark-state.json')
    writeFileSync(placemarkState, '{"version":1,"revision":3,"edits":[]}')
    const originals = [join(trackDir(id, env), 'track.json'), join(trackDir(id, env), 'source.gpx'), placemarkState, join(trackDir(secondId, env), 'track.json'), join(trackDir(secondId, env), 'source.kml')]
      .map(path => ({path, bytes: readFileSync(path)}))
    for (const [trackId, format] of [[id, 'gpx'], [secondId, 'kml']]) {
      const project = ensureTrackAgentWorkspace(env, trackId)
      writeFileSync(join(project.path, 'AGENTS.md'), '已有用户说明')
      writeFileSync(join(project.path, '路线资料.md'), '已有真实路线资料')
      // Caller-provided paths never enter the snapshot.
      const context = writeTrackAgentContext({page: 'route-information', trackId, sources: {trackJson: 'C:/outside'}, workspacePath: 'C:/outside'}, env)
      expect(context.current).toMatchObject({page: 'route-information', trackId, workspacePath: project.path, sources: {
        trackJson: join(trackDir(trackId, env), 'track.json'), sourceFile: join(trackDir(trackId, env), `source.${format}`),
        placemarkState: join(trackDir(trackId, env), 'placemark-state.json'),
      }})
      expect(context.current.sourcesNote).toContain('只读')
      expect(snapshot(trackId).current).toEqual(context.current)
      expect(readFileSync(join(project.path, 'AGENTS.md'), 'utf8')).toBe('已有用户说明')
      expect(readFileSync(join(project.path, '路线资料.md'), 'utf8')).toBe('已有真实路线资料')
    }
    expect(existsSync(join(trackDir(secondId, env), 'placemark-state.json'))).toBe(false)
    for (const original of originals) expect(readFileSync(original.path)).toEqual(original.bytes)
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    expect(snapshot(id).current.sources).toBeUndefined()
    for (const page of ['library', 'new']) {
      const context = writeTrackAgentContext({page, trackId: id}, env)
      expect(context.current.sources).toBeUndefined(); expect(context.current.workspacePath).toBeUndefined()
    }
  })
  it('adds route-file guidance only when creating instructions and refuses unsafe source-format paths', () => {
    const project = ensureTrackAgentWorkspace(env, id)
    const instructions = readFileSync(join(project.path, 'AGENTS.md'), 'utf8')
    expect(instructions).toContain('Markdown 保存在当前线路的 Agent 工作区')
    expect(instructions).toContain('current.sources')
    expect(instructions).toContain('待核实')
    const path = join(trackDir(id, env), 'track.json'), original = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({...original, format: '../../outside'}))
    const context = writeTrackAgentContext({page: 'route-information', trackId: id}, env)
    expect(context.current.sources).toMatchObject({trackJson: path, sourceFile: null})
    expect(context.current.sourcesNote).toContain('没有已确认格式')
    for (const trackId of ['../escape', 'route/child', 'C:\\outside']) expect(() => writeTrackAgentContext({page: 'route-information', trackId}, env)).toThrow('轨迹编号无效')
    expect(() => writeTrackAgentContext({page: 'route-information', trackId: 'missing'}, env)).toThrow('不存在')
    expect(readFileSync(join(project.path, 'AGENTS.md'), 'utf8')).toBe(instructions)
  })
  it('opens an empty library with no route dependency', () => {
    rmSync(trackDir(id, env), {recursive: true})
    const workspace = ensureTrackAgentWorkspace(env)
    expect(workspace).toEqual({path: join(env.DSH_HOME!, 'track-agent', '轨迹'), sessionId: null})
    expect(snapshot()).toMatchObject({version: 2, library: {trackCount: 0, tracks: []}, current: {page: 'library', trackId: null, track: null}})
    expect(readFileSync(join(workspace.path, 'AGENTS.md'), 'utf8')).toContain('公共工作区')
  })
  it('keeps two saved route projects and sessions separate from the library', () => {
    const secondId = writeTrack({...input, name: '第二条路线'}, env).id
    const library = ensureTrackAgentWorkspace(env)
    saveTrackAgentSession('library-session', env)
    const first = ensureTrackAgentWorkspace(env, id)
    const second = ensureTrackAgentWorkspace(env, secondId)
    expect(first).toEqual({path: join(env.DSH_HOME!, 'track-agent', 'tracks', id), sessionId: null})
    expect(second).toEqual({path: join(env.DSH_HOME!, 'track-agent', 'tracks', secondId), sessionId: null})
    expect(first.path).not.toBe(second.path)
    saveTrackAgentSession('route-a-session', env, id)
    saveTrackAgentSession('route-b-session', env, secondId)
    expect(ensureTrackAgentWorkspace(env, id).sessionId).toBe('route-a-session')
    expect(ensureTrackAgentWorkspace(env, secondId).sessionId).toBe('route-b-session')
    expect(ensureTrackAgentWorkspace(env).sessionId).toBe('library-session')
    expect(ensureTrackAgentWorkspace(env).path).toBe(library.path)
    expect(JSON.parse(readFileSync(join(first.path, 'agent-session.json'), 'utf8')).sessionId).toBe('route-a-session')
    expect(snapshot(id).current.trackId).toBe(id)
    expect(snapshot(secondId).current.trackId).toBe(secondId)
    expect(snapshot().current.trackId).toBeNull()
  })
  it('updates selected page context only in its route directory without changing originals', () => {
    const directory = trackDir(id, env), original = readFileSync(join(directory, 'track.json'), 'utf8')
    const library = ensureTrackAgentWorkspace(env)
    const libraryContext = readFileSync(join(library.path, 'track-context.json'), 'utf8')
    const first = ensureTrackAgentWorkspace(env, id)
    for (const page of ['overview', 'edit', 'route-information', 'animation', 'video-script']) {
      writeTrackAgentContext({page, trackId: id}, env)
      expect(snapshot(id)).toMatchObject({current: {page, trackId: id, track: {name: '武功山反穿', points: 2}}})
    }
    expect(snapshot(id).current.track.coordinates).toBeUndefined()
    expect(ensureTrackAgentWorkspace(env, id).path).toBe(first.path)
    expect(snapshot(id).current.pageTitle).toBe('镜头案例与脚本')
    expect(readFileSync(join(library.path, 'track-context.json'), 'utf8')).toBe(libraryContext)
    expect(readFileSync(join(directory, 'track.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(directory, 'source.gpx'), 'utf8')).toBe('<gpx>original</gpx>')
  })
  it('uses the global context for library/new even when a previous route id remains selected', () => {
    const project = ensureTrackAgentWorkspace(env, id)
    writeTrackAgentContext({page: 'edit', trackId: id}, env)
    const selectedContext = readFileSync(join(project.path, 'track-context.json'), 'utf8')
    for (const page of ['library', 'new']) {
      const context = writeTrackAgentContext({page, trackId: id}, env)
      expect(context.current).toMatchObject({page, trackId: null, track: null})
      expect(snapshot().current).toMatchObject({page, trackId: null, track: null})
      expect(readFileSync(join(project.path, 'track-context.json'), 'utf8')).toBe(selectedContext)
    }
    writeTrackAgentContext({page: 'new', trackId: 'already-deleted-route'}, env)
    expect(snapshot().current).toMatchObject({page: 'new', trackId: null, track: null})
  })
  it('keeps the same route project/session when the route name changes', () => {
    const workspace = ensureTrackAgentWorkspace(env, id)
    saveTrackAgentSession('route-session', env, id)
    const source = join(trackDir(id, env), 'track.json')
    const track = JSON.parse(readFileSync(source, 'utf8'))
    writeFileSync(source, JSON.stringify({...track, name: '新路线名字'}))
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    expect(ensureTrackAgentWorkspace(env, id)).toEqual({...workspace, sessionId: 'route-session'})
    expect(snapshot(id).current.track.name).toBe('新路线名字')
  })
  it('retains shared and legacy route data without importing their sessions into a new project', () => {
    const previous = join(trackDir(id, env), 'agent-workspace')
    mkdirSync(previous)
    writeFileSync(join(previous, 'AGENTS.md'), 'old route notes')
    const oldSession = join(trackDir(id, env), 'agent-session.json')
    writeFileSync(oldSession, JSON.stringify({version: 1, sessionId: 'old-session'}))
    const shared = ensureTrackAgentWorkspace(env)
    writeFileSync(join(shared.path, 'AGENTS.md'), 'shared user instructions')
    writeFileSync(join(shared.path, 'notes.txt'), 'shared user notes')
    saveTrackAgentSession('shared-session', env)
    writeTrackAgentContext({page: 'new'}, env)
    const sharedContext = readFileSync(join(shared.path, 'track-context.json'), 'utf8')
    const project = ensureTrackAgentWorkspace(env, id)
    expect(project.sessionId).toBeNull()
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    saveTrackAgentSession('new-route-session', env, id)
    expect(ensureTrackAgentWorkspace(env).sessionId).toBe('shared-session')
    expect(readFileSync(join(shared.path, 'AGENTS.md'), 'utf8')).toBe('shared user instructions')
    expect(readFileSync(join(shared.path, 'notes.txt'), 'utf8')).toBe('shared user notes')
    expect(readFileSync(join(shared.path, 'track-context.json'), 'utf8')).toBe(sharedContext)
    expect(readFileSync(join(previous, 'AGENTS.md'), 'utf8')).toBe('old route notes')
    expect(JSON.parse(readFileSync(oldSession, 'utf8')).sessionId).toBe('old-session')
  })
  it('does not overwrite route instructions or user files when reopening and writing context', () => {
    const first = ensureTrackAgentWorkspace(env, id)
    writeFileSync(join(first.path, 'AGENTS.md'), 'user instructions')
    writeFileSync(join(first.path, 'draft.md'), 'user draft')
    writeTrackAgentContext({page: 'route-information', trackId: id}, env)
    ensureTrackAgentWorkspace(env, id)
    expect(readFileSync(join(first.path, 'AGENTS.md'), 'utf8')).toBe('user instructions')
    expect(readFileSync(join(first.path, 'draft.md'), 'utf8')).toBe('user draft')
  })
  it('recovers unreadable session bindings as unlinked independently', () => {
    saveTrackAgentSession('library-session', env)
    saveTrackAgentSession('route-session', env, id)
    writeFileSync(join(ensureTrackAgentWorkspace(env, id).path, 'agent-session.json'), '{broken')
    expect(ensureTrackAgentWorkspace(env, id).sessionId).toBeNull()
    expect(ensureTrackAgentWorkspace(env).sessionId).toBe('library-session')
    saveTrackAgentSession('route-session', env, id)
    writeFileSync(join(env.DSH_HOME!, 'track-agent', 'agent-session.json'), '{broken')
    expect(ensureTrackAgentWorkspace(env).sessionId).toBeNull()
    expect(ensureTrackAgentWorkspace(env, id).sessionId).toBe('route-session')
  })
  it('rejects deleted routes without changing their saved project files', () => {
    const project = ensureTrackAgentWorkspace(env, id)
    saveTrackAgentSession('route-session', env, id)
    const context = readFileSync(join(project.path, 'track-context.json'), 'utf8')
    rmSync(trackDir(id, env), {recursive: true})
    expect(() => ensureTrackAgentWorkspace(env, id)).toThrow('Agent 轨迹不存在或已删除')
    expect(() => writeTrackAgentContext({page: 'overview', trackId: id}, env)).toThrow('Agent 轨迹不存在或已删除')
    expect(() => saveTrackAgentSession('replacement', env, id)).toThrow('Agent 轨迹不存在或已删除')
    expect(readFileSync(join(project.path, 'track-context.json'), 'utf8')).toBe(context)
    expect(JSON.parse(readFileSync(join(project.path, 'agent-session.json'), 'utf8')).sessionId).toBe('route-session')
  })
  it('rejects invalid contexts, sessions and missing route ids before creating any workspace', () => {
    for (const value of [null, [], {}, {page: 'unknown'}, {page: '__proto__'}, {page: 'overview', trackId: '../escape'}, {page: 'overview', trackId: 1}]) {
      expect(() => writeTrackAgentContext(value, env)).toThrow('Agent')
    }
    for (const value of ['../escape', '', null]) expect(() => saveTrackAgentSession(value, env)).toThrow('Agent 会话编号无效')
    for (const trackId of ['../escape', '', 'route/child', 1 as unknown as string]) {
      expect(() => ensureTrackAgentWorkspace(env, trackId)).toThrow('Agent 轨迹编号无效')
      expect(() => saveTrackAgentSession('valid-session', env, trackId)).toThrow('Agent 轨迹编号无效')
    }
    expect(() => ensureTrackAgentWorkspace(env, 'missing')).toThrow('Agent 轨迹不存在或已删除')
    expect(() => saveTrackAgentSession('valid-session', env, 'missing')).toThrow('Agent 轨迹不存在或已删除')
    expect(() => writeTrackAgentContext({page: 'route-information', trackId: 'missing'}, env)).toThrow('Agent 轨迹不存在或已删除')
    expect(existsSync(join(env.DSH_HOME!, 'track-agent'))).toBe(false)
  })
})
