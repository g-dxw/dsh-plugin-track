import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readTrack, removeTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { readPlacemarkState, writePlacemarkState, PlacemarkStateConflictError } from '../src/placemark-state-store.ts'
import { readPlacemarkEdits, writePlacemarkEdits } from '../src/placemark-edits-store.ts'
import { readPlacemarkOrder, writePlacemarkOrder } from '../src/placemark-order-store.ts'
import { readPlacemarkGroups, writePlacemarkGroups } from '../src/placemark-groups-store.ts'
import { effectivePlacemarks, removeStatePlacemarks, type PlacemarkStateData } from '../src/track/placemark-state.ts'
import type { TrackInput, TrackPlacemark } from '../src/protocol.ts'

const faults = vi.hoisted(() => ({rename: false}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (faults.rename) throw new Error('rename blocked')
    return fs.renameSync(...args)
  }}
})
const roots: string[] = []
afterEach(() => {
  faults.rename = false
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-placemark-state-')) throw new Error('Unexpected test directory')
    rmSync(root, {recursive: true, force: true})
  }
})
const raw: TrackPlacemark[] = [
  {id: 'kml-1', name: '起点', description: '原描述', coordinates: [120, 30], elevation: 100, time: 1000, images: ['https://example.com/a.jpg'], type: ['起点']},
  {id: 'kml-2', name: '终点', description: '', coordinates: [120.02, 30], elevation: 140, time: 5000, images: ['https://example.com/b.jpg']},
]
const input: TrackInput = {filename: 'source.kml', source: '<kml>unchanged</kml>', points: [[120, 30, 100, 1000], [120.01, 30, 120, 3000], [120.02, 30, 140, 5000]], placemarks: raw,
  segmentStarts: [0], metrics: {distance: 2000, elevationGain: 40, elevationLoss: 0, duration: 4000, elevationMax: 140, elevationMin: 100, bbox: [120, 30, 120.02, 30]}}
const group = {id: 'group-00000000-0000-0000-0000-000000000001', name: '沿途', description: '', memberIds: ['kml-1', 'legacy-missing', 'kml-2'], coordinates: [120, 30] as [number, number], cover: {pointId: 'kml-1', imageUrl: 'https://example.com/a.jpg'}}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-placemark-state-')); roots.push(home)
  const env = {DSH_HOME: home}, {id} = writeTrack(input, env), dir = trackDir(id, env)
  const source = readFileSync(join(dir, 'source.kml')), track = readFileSync(join(dir, 'track.json'))
  const unchanged = () => {expect(readFileSync(join(dir, 'source.kml'))).toEqual(source); expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])}
  return {id, env, dir, unchanged}
}
function contextData(id: string, env: NodeJS.ProcessEnv): PlacemarkStateData {return {...readPlacemarkState(id, env), routeContext: {segmentStarts: [0], references: raw}}}

describe('atomic placemark state storage', () => {
  it('reads legacy files without writing and migrates all three on the first successful state save, keeping their bytes', () => {
    const {id, env, dir, unchanged} = fixture()
    const legacy = [{name: 'placemark-edits.json', data: {version: 1, edits: [{id: 'kml-1', name: '旧名'}]}}, {name: 'placemark-order.json', data: {version: 1, order: ['kml-2', 'legacy-missing', 'kml-1']}}, {name: 'placemark-groups.json', data: {version: 1, groups: [group]}}]
    for (const file of legacy) writeFileSync(join(dir, file.name), JSON.stringify(file.data))
    const before = legacy.map(file => readFileSync(join(dir, file.name)))
    const state = readPlacemarkState(id, env)
    expect(state).toMatchObject({version: 1, revision: 0, added: [], deletedIds: [], edits: legacy[0].data.edits, order: legacy[1].data.order, groups: [group], routeContext: null})
    expect(existsSync(join(dir, 'placemark-state.json'))).toBe(false)
    const saved = writePlacemarkState(id, state.revision, {...state, groups: [{...group, name: '新名'}]}, env)
    expect(saved.revision).toBe(1); expect(readPlacemarkState(id, env)).toEqual(saved)
    legacy.forEach((file, index) => expect(readFileSync(join(dir, file.name))).toEqual(before[index]))
    expect(readPlacemarkGroups(id, env)[0].name).toBe('新名'); unchanged()
  })
  it('normalizes created locations from a valid route position and preserves complete metadata through refresh', () => {
    const {id, env, unchanged} = fixture(), data = contextData(id, env)
    data.added = [{id: 'local-00000000-0000-0000-0000-000000000001', name: '日出', description: '说'.repeat(10000), images: ['https://example.com/c.jpg'], coordinates: [121, 31], elevation: 999, time: 99, timeSource: 'unknown', type: ['风景点', '打卡点'], hidden: true, routePosition: {startIndex: 0, endIndex: 1, fraction: .5}}]
    const saved = writePlacemarkState(id, 0, data, env)
    expect(saved.added[0]).toMatchObject({coordinates: [120.005, 30], elevation: 110, time: 2000, timeSource: 'track', type: ['风景点', '打卡点'], hidden: true})
    expect(readPlacemarkState(id, env)).toEqual(saved); expect(readTrack(id, env)!.placemarks).toEqual(raw); unchanged()
  })
  it('deletes points and all direct relationships together, preserves unknown legacy references and allows deleting every annotation', () => {
    const {id, env, unchanged} = fixture(), data = contextData(id, env)
    data.groups = [group]; data.order = ['legacy-order', 'kml-1', 'kml-2']; data.edits = [{id: 'kml-1', name: '改名'}, {id: 'legacy-edit', hidden: true}]
    const initial = writePlacemarkState(id, 0, data, env), removed = removeStatePlacemarks(raw, initial, ['kml-1'])
    expect(removed).toMatchObject({deletedIds: ['kml-1'], edits: [{id: 'legacy-edit', hidden: true}], order: ['legacy-order', 'kml-2'], groups: [{memberIds: ['legacy-missing', 'kml-2'], cover: {pointId: 'kml-2', imageUrl: 'https://example.com/b.jpg'}, coordinates: group.coordinates}]})
    const saved = writePlacemarkState(id, initial.revision, removed, env)
    expect(effectivePlacemarks(raw, readPlacemarkState(id, env)).map(point => point.id)).toEqual(['kml-2'])
    const allRemoved = removeStatePlacemarks(raw, saved, ['kml-2'])
    expect(allRemoved.groups[0].memberIds).toEqual(['legacy-missing']); expect(allRemoved.groups[0]).not.toHaveProperty('cover')
    const empty = writePlacemarkState(id, saved.revision, allRemoved, env)
    expect(effectivePlacemarks(raw, empty)).toEqual([])
    const restored = writePlacemarkState(id, empty.revision, initial, env)
    expect(restored.groups).toEqual(data.groups); expect(restored.edits).toEqual(data.edits); expect(restored.order).toEqual(data.order)
    expect(effectivePlacemarks(raw, restored)).toHaveLength(2); unchanged()
  })
  it('removes local points without tombstones and removes only genuinely empty groups, retaining one-member groups', () => {
    const {id, env} = fixture(), data = contextData(id, env)
    const local = {...raw[0], id: 'local-00000000-0000-0000-0000-000000000001', routePosition: {startIndex: 0, endIndex: 1, fraction: 0}, timeSource: 'track' as const}
    data.added = [local]; data.groups = [{...group, memberIds: [local.id, 'kml-1'], cover: {pointId: local.id, imageUrl: local.images[0]}}]
    const removed = removeStatePlacemarks(raw, data, [local.id])
    expect(removed.added).toEqual([]); expect(removed.deletedIds).toEqual([]); expect(removed.groups[0].memberIds).toEqual(['kml-1'])
    expect(removeStatePlacemarks(raw, removed, ['kml-1']).groups).toEqual([])
  })
  it('rejects stale revisions and invalid positions before replacing the canonical file', () => {
    const {id, env, dir, unchanged} = fixture(), first = writePlacemarkState(id, 0, contextData(id, env), env), bytes = readFileSync(join(dir, 'placemark-state.json'))
    expect(() => writePlacemarkState(id, 0, {...first, order: []}, env)).toThrow(PlacemarkStateConflictError)
    expect(() => writePlacemarkState(id, undefined, first, env)).toThrow('修订号')
    expect(() => writePlacemarkState(id, first.revision, {...first, edits: [{id: 'kml-1', coordinates: [120.01, 30]}]}, env)).toThrow('轨迹位置')
    expect(() => writePlacemarkState(id, first.revision, {...first, edits: [{id: 'kml-1', routePosition: {startIndex: 1, endIndex: 2, fraction: 2}}]}, env)).toThrow()
    expect(readFileSync(join(dir, 'placemark-state.json'))).toEqual(bytes); unchanged()
  })
  it('keeps the old complete snapshot when atomic rename fails and cleans temporary files', () => {
    const {id, env, dir, unchanged} = fixture(), first = writePlacemarkState(id, 0, contextData(id, env), env), bytes = readFileSync(join(dir, 'placemark-state.json'))
    faults.rename = true
    expect(() => writePlacemarkState(id, first.revision, {...first, groups: [group]}, env)).toThrow('rename blocked')
    expect(readFileSync(join(dir, 'placemark-state.json'))).toEqual(bytes); expect(readPlacemarkState(id, env)).toEqual(first); unchanged()
  })
  it('locks corrupt authoritative files instead of falling back to readable legacy files or allowing old endpoints to overwrite them', () => {
    const {id, env, dir} = fixture()
    writeFileSync(join(dir, 'placemark-edits.json'), JSON.stringify({version: 1, edits: []}))
    writeFileSync(join(dir, 'placemark-state.json'), '{broken')
    for (const operation of [() => readPlacemarkState(id, env), () => readPlacemarkEdits(id, env), () => readPlacemarkGroups(id, env), () => readPlacemarkOrder(id, env), () => writePlacemarkEdits(id, [], env), () => writePlacemarkGroups(id, [], env), () => writePlacemarkOrder(id, null, env)]) expect(operation).toThrow()
    expect(readFileSync(join(dir, 'placemark-state.json'), 'utf8')).toBe('{broken')
  })
  it('keeps fixed contexts, routes legacy field writes through the same state and never recreates removed track directories', () => {
    const {id, env, dir} = fixture(), first = writePlacemarkState(id, 0, contextData(id, env), env)
    expect(() => writePlacemarkState(id, first.revision, {...first, routeContext: null}, env)).toThrow('已固定')
    expect(writePlacemarkEdits(id, [{id: 'kml-1', name: '旧接口修改'}], env)).toEqual([{id: 'kml-1', name: '旧接口修改'}])
    writePlacemarkOrder(id, ['kml-2', 'kml-1'], env); writePlacemarkGroups(id, [group], env)
    const final = readPlacemarkState(id, env)
    expect(final.revision).toBe(4); expect(final.routeContext).toEqual(first.routeContext); expect(final.edits[0].name).toBe('旧接口修改')
    expect(readPlacemarkOrder(id, env)).toEqual(final.order); expect(readPlacemarkGroups(id, env)).toEqual(final.groups)
    expect(removeTrack(id, env)).toBe(true); expect(() => writePlacemarkEdits(id, [], env)).toThrow('轨迹不存在'); expect(existsSync(dir)).toBe(false)
  })
  it('restores exact legacy off-route coordinates after an anchored move but rejects arbitrary unanchored locations', () => {
    const {id, env, dir, unchanged} = fixture()
    const legacy = [{id: 'kml-1', coordinates: [119.97, 29.98] as [number, number], elevation: 88, images: ['https://example.com/old.jpg']}]
    writeFileSync(join(dir, 'placemark-edits.json'), JSON.stringify({version: 1, edits: legacy}))
    const baseline = writePlacemarkState(id, 0, contextData(id, env), env)
    expect(baseline.edits).toEqual(legacy)
    const moved = writePlacemarkState(id, baseline.revision, {...baseline, edits: [{...legacy[0], routePosition: {startIndex: 0, endIndex: 1, fraction: .5}}]}, env)
    expect(moved.edits[0]).toMatchObject({coordinates: [120.005, 30], elevation: 110, time: 2000, timeSource: 'track'})
    const restored = writePlacemarkState(id, moved.revision, baseline, env)
    expect(restored.edits).toEqual(legacy)
    const bytes = readFileSync(join(dir, 'placemark-state.json'))
    expect(() => writePlacemarkState(id, restored.revision, {...restored, edits: [{...legacy[0], coordinates: [119.98, 29.98]}]}, env)).toThrow('轨迹位置')
    expect(() => writePlacemarkEdits(id, [{...legacy[0], coordinates: [119.98, 29.98]}], env)).toThrow('轨迹位置')
    expect(readFileSync(join(dir, 'placemark-state.json'))).toEqual(bytes)
    expect(JSON.parse(readFileSync(join(dir, 'placemark-edits.json'), 'utf8'))).toEqual({version: 1, edits: legacy}); unchanged()
  })
})
