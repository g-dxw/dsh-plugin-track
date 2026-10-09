import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { API, type TrackRecord, type TrackPlacemark, type PlacemarkGroup } from '../protocol.ts'
import { parseKmlPlacemarks, imageLink } from '../track/placemarks.ts'
import { isPlacemarkOrder, orderedPlacemarks } from '../track/placemark-order.ts'
import { api } from './util.ts'
import { preparePlacemarkPhotoCache } from './placemark-photo-cache.ts'
import { patchPlacemarkEdits, validatePlacemarkEdits, type PlacemarkEdit } from '../track/placemark-edits.ts'
import { samePlacemarkHistoryValue, type PlacemarkHistory, type PlacemarkHistoryChange, type PlacemarkHistoryDirection } from './placemark-history.ts'
import { validatePlacemarkGroups } from '../track/placemark-groups.ts'
import { parseTrackFile } from '../track/import.ts'
import { derivePlacemarkLocation, locatePlacemarkCandidates, validateRouteContext, type LocatedPlacemark, type PlacemarkRouteContext } from '../track/placemark-location.ts'
import { clonePlacemarkStateData, effectivePlacemarks, removeStatePlacemarks, validatePlacemarkState, validatePlacemarkStateData, type PlacemarkState, type PlacemarkStateData } from '../track/placemark-state.ts'

const EMPTY_HISTORY = {revision: 0, canUndo: false, canRedo: false}
const noSubscription = () => () => {}
const emptyHistory = () => EMPTY_HISTORY
type HistoryAction = {direction: PlacemarkHistoryDirection; change: PlacemarkHistoryChange}
type Channel = 'order' | 'edits' | 'groups'
const emptyData = (): PlacemarkStateData => ({added: [], deletedIds: [], edits: [], order: null, groups: [], routeContext: null})
const emptyDocument = (): PlacemarkState => ({version: 1, revision: 0, ...emptyData()})

// The entire transaction, including outcome verification, survives an editor unmount.
const pendingWrites = new Map<string, Promise<unknown>>()
async function readArrangement(id: string): Promise<{state: unknown}> {
  await pendingWrites.get(id)?.catch(() => {})
  return api(`placemark-state?id=${encodeURIComponent(id)}`)
}

export async function loadTrackPlacemarks(track: TrackRecord, signal?: AbortSignal): Promise<TrackPlacemark[]> {
  const stored = track.placemarks
  if (track.format !== 'kml') return stored || []
  if (stored !== undefined && stored.every(hasPointMetadata)) return stored
  try {
    const response = await fetch(`${API}/source?id=${encodeURIComponent(track.id)}`, {signal})
    if (!response.ok) throw new Error('原 KML 文件无法读取，请重新导入以恢复标注点')
    const original = parseKmlPlacemarks(await response.text())
    if (stored === undefined) return original
    const byId = new Map(original.map(point => [point.id, point]))
    const locationKey = (point: TrackPlacemark) => point.coordinates.join(',')
    const byLocation = new Map<string, TrackPlacemark | null>()
    for (const point of original) {
      const key = locationKey(point)
      byLocation.set(key, byLocation.has(key) ? null : point)
    }
    return stored.map(point => {
      if (hasPointMetadata(point)) return point
      const sameId = byId.get(point.id)
      const source = sameId && locationKey(sameId) === locationKey(point) ? sameId : byLocation.get(locationKey(point))
      return source ? {...point, name: source.name, elevation: source.elevation, time: source.time} : point
    })
  } catch (reason) {
    if (signal?.aborted || stored === undefined) throw reason
    return stored
  }
}
function hasPointMetadata(point: TrackPlacemark): boolean {return point.elevation !== undefined && point.time !== undefined}

/** Read the point editor's persisted state after any pending writes settle. */
export async function loadTrackPlacemarkState(track: TrackRecord): Promise<{points: TrackPlacemark[]; groups: PlacemarkGroup[]}> {
  const [raw, result] = await Promise.all([loadTrackPlacemarks(track), readArrangement(track.id)])
  const state = validatePlacemarkState(result.state, track.coordinates)
  return {points: effectivePlacemarks(raw, state), groups: state.groups}
}

async function recoverRouteContext(track: TrackRecord, points: TrackPlacemark[], signal: AbortSignal): Promise<PlacemarkRouteContext> {
  if (track.segmentStarts !== undefined) return validateRouteContext({segmentStarts: track.segmentStarts, references: points}, track.coordinates)
  const response = await fetch(`${API}/source?id=${encodeURIComponent(track.id)}`, {signal})
  if (!response.ok) throw new Error('原始轨迹无法读取，新增和位置调整暂不可用')
  const parsed = parseTrackFile(track.filename, await response.text())
  if (!Array.isArray(track.coordinates) || parsed.points.length !== track.coordinates.length
    || parsed.points.some((point, index) => Math.abs(point[0] - track.coordinates[index][0]) > 1e-8 || Math.abs(point[1] - track.coordinates[index][1]) > 1e-8)) {
    throw new Error('原文件与当前轨迹坐标不一致，新增和位置调整暂不可用')
  }
  return validateRouteContext({segmentStarts: parsed.segmentStarts, references: parsed.placemarks || []}, track.coordinates)
}

export function useTrackPlacemarks(track: TrackRecord, history?: PlacemarkHistory, options: {preparePhotos?: boolean} = {}) {
  const preparePhotos = options.preparePhotos !== false
  const [raw, setRaw] = useState({id: track.id, points: track.placemarks || []})
  const [saved, setSaved] = useState({id: track.id, state: emptyDocument(), ready: false})
  const [route, setRoute] = useState<{id: string; context: PlacemarkRouteContext | null; ready: boolean; error: string}>({id: track.id, context: null, ready: false, error: ''})
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [stateError, setStateError] = useState('')
  const [saving, setSaving] = useState(false), [orderError, setOrderError] = useState('')
  const [editing, setEditing] = useState(false), [editError, setEditError] = useState('')
  const [grouping, setGrouping] = useState(false), [groupError, setGroupError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const active = useRef<AbortController | null>(null), inFlight = useRef(false)
  const currentId = useRef(track.id); currentId.current = track.id
  const historyStore = history?.trackId === track.id ? history : undefined
  const currentHistory = useRef(historyStore); currentHistory.current = historyStore
  const historySnapshot = useSyncExternalStore(historyStore?.subscribe || noSubscription, historyStore?.getSnapshot || emptyHistory, historyStore?.getSnapshot || emptyHistory)
  const rawRef = useRef(raw); rawRef.current = raw
  const savedRef = useRef(saved); savedRef.current = saved
  const routeRef = useRef(route); routeRef.current = route
  const loadingRef = useRef(loading); loadingRef.current = loading
  const errorRef = useRef(error); errorRef.current = error
  function publishRaw(next: typeof raw) {rawRef.current = next; setRaw(next)}
  function publishSaved(next: typeof saved) {savedRef.current = next; setSaved(next)}
  function publishRoute(next: typeof route) {routeRef.current = next; setRoute(next)}
  function publishLoading(next: boolean) {loadingRef.current = next; setLoading(next)}
  function publishError(next: string) {errorRef.current = next; setError(next)}
  const rawPoints = raw.id === track.id ? raw.points : track.placemarks || []
  const state = saved.id === track.id ? saved.state : emptyDocument()
  const ready = saved.id === track.id && saved.ready
  const routeReady = route.id === track.id && route.ready
  const routeContext = route.id === track.id ? route.context : null
  const points = useMemo(() => !state.added.length && !state.deletedIds.length && !state.edits.length ? orderedPlacemarks(rawPoints, state.order) : effectivePlacemarks(rawPoints, state), [rawPoints, state])

  useEffect(() => {
    const controller = new AbortController()
    active.current = controller; inFlight.current = false
    publishRaw({id: track.id, points: track.placemarks || []}); publishLoading(true); publishError('')
    publishSaved({id: track.id, state: emptyDocument(), ready: false}); setStateError('')
    publishRoute({id: track.id, context: null, ready: false, error: ''})
    setSaving(false); setEditing(false); setGrouping(false); setOrderError(''); setEditError(''); setGroupError('')
    const rawRead = loadTrackPlacemarks(track, controller.signal).then(result => {
      if (preparePhotos) void preparePlacemarkPhotoCache(track.id, result.flatMap(point => point.images), controller.signal).catch(() => {
        // Image failures are shown per photo and never disable point editing.
      })
      if (!controller.signal.aborted) publishRaw({id: track.id, points: result})
      return result
    }).catch(reason => {
      if (!controller.signal.aborted) publishError(reason instanceof Error ? reason.message : '标注点读取失败')
      return track.placemarks || []
    }).finally(() => {if (!controller.signal.aborted) publishLoading(false)})
    const stateRead = readArrangement(track.id).then(result => {
      const restored = validatePlacemarkState(result?.state, track.coordinates)
      if (!controller.signal.aborted) {
        historyStore?.reconcile('state', restored)
        publishSaved({id: track.id, state: restored, ready: true})
      }
      return restored
    }).catch(reason => {
      if (!controller.signal.aborted) {
        const message = reason instanceof Error ? reason.message : '标注状态读取失败'
        setStateError(message); setGroupError(message)
      }
      return null
    })
    void Promise.all([rawRead, stateRead]).then(async ([original, restored]) => {
      if (!restored || controller.signal.aborted) return
      try {
        const context = restored.routeContext || await recoverRouteContext(track, original, controller.signal)
        if (!controller.signal.aborted) publishRoute({id: track.id, context, ready: true, error: ''})
      } catch (reason) {
        if (!controller.signal.aborted) publishRoute({id: track.id, context: null, ready: false,
          error: reason instanceof Error ? reason.message : '轨迹分段恢复失败，新增和位置调整暂不可用'})
      }
    })
    return () => controller.abort()
  }, [track.id, track.placemarks, attempt, historyStore, preparePhotos])

  function canWrite() {
    const controller = active.current
    return !!controller && !controller.signal.aborted && currentId.current === track.id
      && rawRef.current.id === track.id && savedRef.current.id === track.id && savedRef.current.ready
      && !loadingRef.current && !errorRef.current && !inFlight.current && !pendingWrites.has(track.id)
  }
  function currentPoints() {return effectivePlacemarks(rawRef.current.points, savedRef.current.state)}
  function currentContext() {return savedRef.current.state.routeContext || (routeRef.current.id === track.id ? routeRef.current.context : null)}
  function markBusy(channel: Channel, value: boolean) {(channel === 'order' ? setSaving : channel === 'groups' ? setGrouping : setEditing)(value)}
  function markError(channel: Channel, value: string) {(channel === 'order' ? setOrderError : channel === 'groups' ? setGroupError : setEditError)(value)}

  async function persistState(next: PlacemarkStateData, channel: Channel, action?: HistoryAction): Promise<boolean> {
    const controller = active.current
    if (!controller || !canWrite()) return false
    const previous = savedRef.current
    const store = currentHistory.current
    if (action && (!store || store.peek(action.direction) !== action.change)) return false
    let requested: PlacemarkStateData
    try {requested = validatePlacemarkStateData({...next, routeContext: currentContext()}, track.coordinates)}
    catch (reason) {markError(channel, reason instanceof Error ? reason.message : '标注状态格式无效'); return false}
    if (!action && samePlacemarkHistoryValue('state', previous.state, requested)) return true
    inFlight.current = true; markBusy(channel, true); markError(channel, ''); setStateError('')
    publishSaved({id: track.id, state: {version: 1, revision: previous.state.revision, ...requested}, ready: true})
    const operation = (async () => {
      let restored: PlacemarkState | null = null, failure: unknown = null, uncertain = false
      try {
        const result = await api<{state: unknown}>('placemark-state', {id: track.id, revision: previous.state.revision, data: requested})
        restored = validatePlacemarkState(result?.state, track.coordinates)
        if (restored.revision <= previous.state.revision || !samePlacemarkHistoryValue('state', restored, requested)) throw new Error('标注状态保存结果与请求不一致')
      } catch (reason) {
        failure = reason
        // Even an interrupted response can belong to an atomic write that already succeeded.
        try {
          const result = await api<{state: unknown}>(`placemark-state?id=${encodeURIComponent(track.id)}`)
          restored = validatePlacemarkState(result?.state, track.coordinates)
        } catch {restored = null; uncertain = true}
      }
      const conflict = !!failure && typeof failure === 'object' && 'status' in failure && failure.status === 409
      const confirmed = !!restored && !conflict && restored.revision > previous.state.revision && samePlacemarkHistoryValue('state', restored, requested)
      const isCurrent = !controller.signal.aborted && currentId.current === track.id
      if (confirmed) {
        const data = clonePlacemarkStateData(restored!)
        const historyValue = action?.change.kind === 'order' ? data.order : action?.change.kind === 'edits' ? data.edits : action?.change.kind === 'groups' ? data.groups : data
        const completed = action ? store!.complete(action.direction, action.change, historyValue) : true
        if (!action) store?.record({kind: 'state', before: previous.state, after: data})
        if (isCurrent) {
          publishSaved({id: track.id, state: restored!, ready: true})
          if (restored!.routeContext) publishRoute({id: track.id, context: restored!.routeContext, ready: true, error: ''})
          if (!completed) markError(channel, '撤销或重做结果与历史不一致，已清除历史')
        }
        return isCurrent && completed
      }
      // A different saved state is an external update; keep the UI draft but refresh its baseline.
      const refreshed = restored && (conflict || !samePlacemarkHistoryValue('state', restored, previous.state)) ? restored : previous.state
      if (restored && refreshed === restored) store?.reconcile('state', restored)
      if (isCurrent) {
        publishSaved({id: track.id, state: refreshed, ready: !uncertain})
        if (refreshed.routeContext) publishRoute({id: track.id, context: refreshed.routeContext, ready: true, error: ''})
        const message = conflict ? '标注状态已被其他操作更新，请重试保存，当前草稿保留' : failure instanceof Error ? failure.message : '保存结果无效'
        markError(channel, `${channel === 'order' ? '排序未保存，已恢复原顺序' : channel === 'groups' ? '分组未保存，已恢复' : '点位调整未保存，已恢复'}：${message}`)
        if (uncertain) {setStateError('保存结果尚未确定，请重新读取后重试'); setGroupError('保存结果尚未确定，请重新读取后重试')}
      }
      return false
    })()
    pendingWrites.set(track.id, operation)
    try {return await operation}
    finally {
      if (pendingWrites.get(track.id) === operation) pendingWrites.delete(track.id)
      if (!controller.signal.aborted && currentId.current === track.id) {inFlight.current = false; markBusy(channel, false)}
    }
  }

  async function saveOrder(next: string[] | null): Promise<boolean> {
    if (!canWrite()) return false
    const latest = currentPoints(), ids = new Set(latest.map(point => point.id))
    if (!isPlacemarkOrder(next) || (next !== null && (next.length !== latest.length || next.some(id => !ids.has(id))))) {setOrderError('排序必须包含当前全部点位'); return false}
    if (samePlacemarkHistoryValue('order', savedRef.current.state.order, next)) return true
    return persistState({...savedRef.current.state, order: next}, 'order')
  }
  async function saveGroups(next: PlacemarkGroup[]): Promise<boolean> {
    if (!canWrite()) return false
    try {
      const groups = validatePlacemarkGroups(next)
      if (samePlacemarkHistoryValue('groups', savedRef.current.state.groups, groups)) return true
      return await persistState({...savedRef.current.state, groups}, 'groups')
    } catch (reason) {setGroupError(reason instanceof Error ? reason.message : '分组格式无效'); return false}
  }
  async function replay(direction: PlacemarkHistoryDirection): Promise<boolean> {
    if (!canWrite()) return false
    const change = currentHistory.current?.peek(direction)
    if (!change) return false
    const target = direction === 'undo' ? change.before : change.after
    const data = change.kind === 'state' ? target as PlacemarkStateData : {...savedRef.current.state, [change.kind]: target}
    return persistState(data, change.kind === 'order' ? 'order' : change.kind === 'groups' ? 'groups' : 'edits', {direction, change})
  }
  async function moveGroup(id: string, coordinates: [number, number]): Promise<boolean> {
    if (!canWrite()) return false
    const group = savedRef.current.state.groups.find(item => item.id === id), context = currentContext()
    if (!group || !context) return false
    try {
      const candidates = locatePlacemarkCandidates(track.coordinates, context, coordinates)
      if (!candidates.length) throw new Error('轨迹没有可对应的坐标点')
      const patch = candidates[0]
      return await saveGroups(savedRef.current.state.groups.map(item => item.id === id ? {...item, coordinates: patch.coordinates} : item))
    } catch (reason) {setGroupError(reason instanceof Error ? reason.message : '分组位置调整失败'); return false}
  }
  async function movePhoto(sourceId: string, targetId: string, url: string): Promise<boolean> {
    if (!canWrite()) return false
    const latest = currentPoints(), source = latest.find(point => point.id === sourceId), target = latest.find(point => point.id === targetId), normalized = imageLink(url)
    if (!source || !target || sourceId === targetId || !normalized || !source.images.some(image => imageLink(image) === normalized)) return false
    try {
      const images = [...new Set([...target.images, normalized])]
      const edits = patchPlacemarkEdits(savedRef.current.state.edits, [{id: sourceId, images: source.images.filter(image => imageLink(image) !== normalized)}, {id: targetId, images}])
      return await persistState({...savedRef.current.state, edits}, 'edits')
    } catch (reason) {setEditError(reason instanceof Error ? reason.message : '照片关联调整失败'); return false}
  }
  async function movePointTo(id: string, location: LocatedPlacemark): Promise<boolean> {
    if (!canWrite()) return false
    const point = currentPoints().find(point => point.id === id), context = currentContext()
    if (!point || !context) return false
    try {
      // Recalculate, rather than trust caller-provided altitude or time.
      const derived = derivePlacemarkLocation(track.coordinates, context, location.routePosition)
      const patch: PlacemarkEdit = {id, coordinates: derived.coordinates, elevation: derived.elevation, time: derived.time, timeSource: derived.timeSource, routePosition: derived.routePosition}
      if (Object.entries(patch).every(([key, value]) => key === 'id' || JSON.stringify(value) === JSON.stringify(point[key as keyof TrackPlacemark]))) return true
      return await persistState({...savedRef.current.state, edits: patchPlacemarkEdits(savedRef.current.state.edits, [patch])}, 'edits')
    } catch (reason) {setEditError(reason instanceof Error ? reason.message : '点位位置调整失败'); return false}
  }
  async function movePoint(id: string, coordinates: [number, number]): Promise<boolean> {
    if (!canWrite()) return false
    const context = currentContext()
    if (!context) return false
    try {
      const candidates = locatePlacemarkCandidates(track.coordinates, context, coordinates)
      if (candidates.length !== 1) {setEditError(candidates.length ? '此处有多次经过，请选择对应的轨迹位置' : '轨迹没有可对应的坐标点'); return false}
      return await movePointTo(id, candidates[0])
    } catch (reason) {setEditError(reason instanceof Error ? reason.message : '点位位置调整失败'); return false}
  }
  async function updatePoint(id: string, patch: Pick<PlacemarkEdit, 'name' | 'description' | 'images' | 'type' | 'hidden'>): Promise<boolean> {
    if (!canWrite()) return false
    const point = currentPoints().find(point => point.id === id)
    if (!point) return false
    const update: PlacemarkEdit = {id}
    if (patch.name !== undefined) update.name = patch.name
    if (patch.description !== undefined) update.description = patch.description
    if (patch.images !== undefined) update.images = patch.images
    if (patch.type !== undefined) update.type = patch.type
    if (patch.hidden !== undefined) update.hidden = patch.hidden
    try {
      const normalized = validatePlacemarkEdits([update])[0]
      if (Object.entries(normalized).every(([key, value]) => key === 'id' || JSON.stringify(value) === JSON.stringify(point[key as keyof TrackPlacemark]))) return true
      return await persistState({...savedRef.current.state, edits: patchPlacemarkEdits(savedRef.current.state.edits, [normalized])}, 'edits')
    } catch (reason) {setEditError(reason instanceof Error ? reason.message : '点位信息更新失败'); return false}
  }
  async function createPoint(point: TrackPlacemark): Promise<boolean> {
    if (!canWrite()) return false
    const context = currentContext()
    if (!context || !point.routePosition || currentPoints().some(item => item.id === point.id)) return false
    try {
      const location = derivePlacemarkLocation(track.coordinates, context, point.routePosition)
      const added: TrackPlacemark = {...point, coordinates: location.coordinates, elevation: location.elevation, time: location.time, timeSource: location.timeSource, routePosition: location.routePosition}
      const before = savedRef.current.state
      return await persistState({...before, added: [...before.added, added], order: before.order === null ? null : [...currentPoints().map(item => item.id), point.id]}, 'edits')
    } catch (reason) {setEditError(reason instanceof Error ? reason.message : '新增标注点失败'); return false}
  }
  async function deletePoints(ids: string[]): Promise<boolean> {
    if (!canWrite()) return false
    try {
      const next = removeStatePlacemarks(rawRef.current.points, savedRef.current.state, ids)
      return await persistState(next, 'edits')
    } catch (reason) {setEditError(reason instanceof Error ? reason.message : '删除标注点失败'); return false}
  }
  return {points, loading, error, stateError, retry: () => setAttempt(value => value + 1), manualOrder: state.order !== null,
    orderReady: ready, saving, orderError, saveOrder, editing, editReady: ready, editError, movePhoto, movePoint, movePointTo, updatePoint, createPoint, deletePoints,
    groups: state.groups, groupReady: ready, groupError, grouping, saveGroups, moveGroup,
    routeReady, routeContext, routeError: route.id === track.id ? route.error : '',
    canUndo: !!historyStore && ready && !loading && !error && !saving && !editing && !grouping && historySnapshot.canUndo,
    canRedo: !!historyStore && ready && !loading && !error && !saving && !editing && !grouping && historySnapshot.canRedo,
    undo: () => replay('undo'), redo: () => replay('redo')}
}
