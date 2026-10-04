import { validatePlacemarkEdits, type PlacemarkEdit } from '../track/placemark-edits.ts'
import type { PlacemarkGroup } from '../protocol.ts'
import { validatePlacemarkGroups } from '../track/placemark-groups.ts'
import { clonePlacemarkStateData, type PlacemarkStateData } from '../track/placemark-state.ts'

export type PlacemarkHistoryChange =
  | {readonly kind: 'order'; readonly before: string[] | null; readonly after: string[] | null}
  | {readonly kind: 'edits'; readonly before: PlacemarkEdit[]; readonly after: PlacemarkEdit[]}
  | {readonly kind: 'groups'; readonly before: PlacemarkGroup[]; readonly after: PlacemarkGroup[]}
  | {readonly kind: 'state'; readonly before: PlacemarkStateData; readonly after: PlacemarkStateData}
type Kind = PlacemarkHistoryChange['kind']
type Value = string[] | null | PlacemarkEdit[] | PlacemarkGroup[] | PlacemarkStateData
export type PlacemarkHistoryDirection = 'undo' | 'redo'
export interface PlacemarkHistorySnapshot {readonly revision: number; readonly canUndo: boolean; readonly canRedo: boolean}
export interface PlacemarkHistory {
  readonly trackId: string
  subscribe(listener: () => void): () => void
  getSnapshot(): PlacemarkHistorySnapshot
  reconcile(kind: Kind, value: Value): void
  record(change: PlacemarkHistoryChange): void
  peek(direction: PlacemarkHistoryDirection): PlacemarkHistoryChange | undefined
  complete(direction: PlacemarkHistoryDirection, change: PlacemarkHistoryChange, saved: Value): boolean
}

const MAXIMUM_STEPS = 50
// Includes serialized baselines and both snapshots, estimated as UTF-16 strings.
const MAXIMUM_BYTES = 8 * 1024 * 1024

function stateText(kind: Kind, value: Value): string {
  if (kind === 'state') {
    const state = clonePlacemarkStateData(value as PlacemarkStateData)
    state.deletedIds.sort()
    state.edits.sort((left, right) => left.id.localeCompare(right.id))
    state.groups = state.groups.map(group => ({...group, memberIds: [...group.memberIds].sort()})).sort((left, right) => left.id.localeCompare(right.id))
    // Restored route boundaries and original time references are a fixed baseline, not an edit.
    return JSON.stringify({...state, routeContext: null})
  }
  return JSON.stringify(kind === 'edits' ? validatePlacemarkEdits(value).sort((left, right) => left.id.localeCompare(right.id))
    : kind === 'groups' ? validatePlacemarkGroups(value).map(group => ({...group,memberIds:[...group.memberIds].sort()})).sort((left,right)=>left.id.localeCompare(right.id)) : value)
}
export function samePlacemarkHistoryValue(kind: Kind, left: Value, right: Value): boolean {
  return stateText(kind, left) === stateText(kind, right)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function capture(change: PlacemarkHistoryChange): PlacemarkHistoryChange {
  if (change.kind === 'state') return freeze({kind: 'state', before: clonePlacemarkStateData(change.before), after: clonePlacemarkStateData(change.after)})
  return freeze(change.kind === 'order'
    ? {kind: 'order', before: change.before === null ? null : [...change.before], after: change.after === null ? null : [...change.after]}
    : change.kind === 'edits' ? {kind: 'edits', before: validatePlacemarkEdits(change.before), after: validatePlacemarkEdits(change.after)}
    : {kind:'groups',before:validatePlacemarkGroups(change.before),after:validatePlacemarkGroups(change.after)})
}

/** Owned by one editor session, so leaving the point tab does not discard history. */
export function createPlacemarkHistory(trackId: string): PlacemarkHistory {
  const listeners = new Set<() => void>()
  const expected = new Map<Kind, string | null>()
  let past: PlacemarkHistoryChange[] = [], future: PlacemarkHistoryChange[] = []
  let snapshot: PlacemarkHistorySnapshot = Object.freeze({revision: 0, canUndo: false, canRedo: false})
  const size = (change: PlacemarkHistoryChange) => (stateText(change.kind, change.before).length + stateText(change.kind, change.after).length) * 2 + 256
  const baselineSize = () => [...expected.values()].reduce((total, value) => total + (value?.length || 0) * 2, 0)
  function publish() {
    snapshot = Object.freeze({revision: snapshot.revision + 1, canUndo: past.length > 0, canRedo: future.length > 0})
    for (const listener of listeners) listener()
  }
  function clear() {past = []; future = []}
  function remember(kind: Kind, text: string) {
    // Oversized records remain editable; their history is deliberately not retained.
    const otherBytes = [...expected.entries()].reduce((total, [key, value]) => total + (key !== kind ? (value?.length || 0) * 2 : 0), 0)
    expected.set(kind, text.length * 2 + otherBytes <= MAXIMUM_BYTES ? text : null)
  }
  function trim() {
    if ([...expected.values()].some(value => value === null) || baselineSize() > MAXIMUM_BYTES) {clear(); return}
    let bytes = baselineSize() + [...past, ...future].reduce((total, change) => total + size(change), 0)
    while (past.length && (past.length + future.length > MAXIMUM_STEPS || bytes > MAXIMUM_BYTES)) bytes -= size(past.shift()!)
    while (future.length && (past.length + future.length > MAXIMUM_STEPS || bytes > MAXIMUM_BYTES)) bytes -= size(future.shift()!)
  }
  return {
    trackId,
    subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener)}},
    getSnapshot: () => snapshot,
    reconcile(kind, value) {
      const text = stateText(kind, value), previous = expected.get(kind)
      const invalidated = previous !== undefined && previous !== text
      if (invalidated) clear()
      remember(kind, text)
      const retained = past.length + future.length
      trim()
      if (invalidated || retained !== past.length + future.length) publish()
    },
    record(change) {
      const before = stateText(change.kind, change.before), after = stateText(change.kind, change.after)
      if (before === after) return
      const previous = expected.get(change.kind)
      if (previous !== undefined && previous !== before) clear()
      remember(change.kind, after)
      future = []
      // Check before cloning a large record into two retained snapshots.
      if (before.length * 2 + after.length * 2 + 256 + baselineSize() <= MAXIMUM_BYTES) past.push(capture(change))
      else clear()
      trim(); publish()
    },
    peek: direction => (direction === 'undo' ? past : future).at(-1),
    complete(direction, change, saved) {
      const source = direction === 'undo' ? past : future
      const destination = direction === 'undo' ? future : past
      const target = direction === 'undo' ? change.before : change.after
      const previous = direction === 'undo' ? change.after : change.before
      const text = stateText(change.kind, saved)
      if (source.at(-1) !== change || expected.get(change.kind) !== stateText(change.kind, previous) || text !== stateText(change.kind, target)) {
        clear(); remember(change.kind, text); publish(); return false
      }
      source.pop(); destination.push(change); remember(change.kind, text)
      trim(); publish(); return true
    },
  }
}
