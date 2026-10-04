import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trackDir, writeTrack } from '../src/artifacts.ts'
import { ensureTrackAgentWorkspace, saveTrackAgentSession, writeTrackAgentContext } from '../src/track-agent-store.ts'

let env: NodeJS.ProcessEnv, id: string
beforeEach(() => {
  env = {DSH_HOME: mkdtempSync(join(tmpdir(), 'track-agent-'))}
  const input = {name: '武功山反穿', filename: '武功山反穿.gpx', source: '<gpx>original</gpx>', points: [[120, 30, 100, null], [120.1, 30.1, 120, null]] as [number, number, number | null, number | null][], metrics: {distance: 100, elevationGain: 20, elevationLoss: 0, duration: 0, elevationMin: 100, elevationMax: 120, bbox: [120, 30, 120.1, 30.1] as [number, number, number, number]}}
  id = writeTrack(input, env).id
})
afterEach(() => {rmSync(env.DSH_HOME!, {recursive: true, force: true})})
const snapshot = () => JSON.parse(readFileSync(join(ensureTrackAgentWorkspace(env).path, 'track-context.json'), 'utf8'))

describe('fixed native track Agent workspace', () => {
  it('opens an empty library with no route dependency', () => {
    rmSync(trackDir(id, env), {recursive: true})
    const workspace = ensureTrackAgentWorkspace(env)
    expect(workspace).toEqual({path: join(env.DSH_HOME!, 'track-agent', '轨迹'), sessionId: null})
    expect(snapshot()).toMatchObject({version: 2, library: {trackCount: 0, tracks: []}, current: {page: 'library', trackId: null, track: null}})
  })
  it('updates page/route references within the same workspace without changing originals', () => {
    const directory = trackDir(id, env), original = readFileSync(join(directory, 'track.json'), 'utf8')
    const first = ensureTrackAgentWorkspace(env)
    expect(snapshot()).toMatchObject({library: {trackCount: 1}, current: {page: 'library', track: null}})
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    expect(snapshot()).toMatchObject({current: {page: 'overview', trackId: id, track: {name: '武功山反穿', points: 2}}})
    expect(snapshot().current.track.coordinates).toBeUndefined()
    expect(ensureTrackAgentWorkspace(env).path).toBe(first.path)
    // Reopening the workspace must not reset the selected route's snapshot.
    expect(snapshot().current.trackId).toBe(id)
    writeTrackAgentContext({page: 'edit', trackId: id}, env)
    expect(snapshot().current.pageTitle).toBe('编辑线路')
    writeTrackAgentContext({page: 'library', trackId: id}, env)
    expect(snapshot().current.track).toBeNull()
    expect(readFileSync(join(directory, 'track.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(directory, 'source.gpx'), 'utf8')).toBe('<gpx>original</gpx>')
  })
  it('retains user instructions and previous per-route workspaces and sessions', () => {
    const previous = join(trackDir(id, env), 'agent-workspace')
    mkdirSync(previous)
    writeFileSync(join(previous, 'AGENTS.md'), 'old route notes')
    writeFileSync(join(trackDir(id, env), 'agent-session.json'), JSON.stringify({version: 1, sessionId: 'old-session'}))
    const first = ensureTrackAgentWorkspace(env)
    expect(first.sessionId).toBeNull()
    writeFileSync(join(first.path, 'AGENTS.md'), 'user instructions')
    saveTrackAgentSession('library-session', env)
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    expect(ensureTrackAgentWorkspace(env).sessionId).toBe('library-session')
    expect(readFileSync(join(first.path, 'AGENTS.md'), 'utf8')).toBe('user instructions')
    expect(readFileSync(join(previous, 'AGENTS.md'), 'utf8')).toBe('old route notes')
    expect(JSON.parse(readFileSync(join(trackDir(id, env), 'agent-session.json'), 'utf8')).sessionId).toBe('old-session')
  })
  it('persists a shared session and recovers unreadable bindings as unlinked', () => {
    saveTrackAgentSession('session-123', env)
    expect(ensureTrackAgentWorkspace(env).sessionId).toBe('session-123')
    writeFileSync(join(env.DSH_HOME!, 'track-agent', 'agent-session.json'), '{broken')
    expect(ensureTrackAgentWorkspace(env).sessionId).toBeNull()
  })
  it('drops deleted routes and does not inherit a saved route for a new draft', () => {
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    rmSync(trackDir(id, env), {recursive: true})
    writeTrackAgentContext({page: 'overview', trackId: id}, env)
    expect(snapshot()).toMatchObject({library: {trackCount: 0}, current: {trackId: null, track: null}})
    writeTrackAgentContext({page: 'new', trackId: id}, env)
    expect(snapshot().current).toMatchObject({page: 'new', track: null})
  })
  it('rejects invalid contexts and session ids before writing', () => {
    for (const value of [null, [], {}, {page: 'unknown'}, {page: '__proto__'}, {page: 'overview', trackId: '../escape'}, {page: 'overview', trackId: 1}]) {
      expect(() => writeTrackAgentContext(value, env)).toThrow('Agent')
    }
    expect(existsSync(join(env.DSH_HOME!, 'track-agent'))).toBe(false)
    for (const value of ['../escape', '', null]) expect(() => saveTrackAgentSession(value, env)).toThrow('Agent 会话编号无效')
  })
})
