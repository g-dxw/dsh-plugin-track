/**
 * The panel's whole data layer: the track list, the open track, and the four
 * things the user can do to a track.
 *
 * Kept out of the component so the state transitions can be read in one place —
 * importing is the only sequence with an order that matters (parse, then store,
 * then reload the list, then open what was just stored).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, METRICS_VERSION, type TrackInput, type TrackRecord, type TrackSummary } from '../protocol.ts'
import { api } from './util.ts'
import { parseTrackFile } from '../track/import.ts'
import { pointMetrics } from '../track/metrics.ts'

export interface TracksState {
  list: TrackSummary[]
  open: TrackRecord | null
  /** The last failure, as a message to show verbatim. */
  error: string
  /** A short progress note while an import or a download is in flight. */
  note: string
  refresh: () => void
  openTrack: (id: string) => void
  closeTrack: () => void
  importFiles: (files: readonly File[]) => void
  remove: (id: string) => Promise<boolean>
  saveEdited: (inputs: readonly TrackInput[]) => Promise<void>
  clearError: () => void
  setNote: (note: string) => void
}

export function useTracks(): TracksState {
  const [list, setList] = useState<TrackSummary[]>([])
  const [open, setOpen] = useState<TrackRecord | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const openRequest = useRef(0)
  const removedIds = useRef(new Set<string>())
  const removals = useRef(new Map<string, Promise<boolean>>())
  const recalculated = useRef(new Map<string, TrackRecord>())

  const refresh = useCallback(() => {
    api<TrackSummary[]>('tracks')
      .then(tracks => {setList(tracks.filter(track => !removedIds.current.has(track.id)).map(track => {
        const updated = recalculated.current.get(track.id)
        return updated ? {...track, metrics: updated.metrics} : track
      })); setError('')})
      // A read that fails must not wipe what is already on screen: the panel is
      // most useful offline, and that is exactly when the list request may fail.
      .catch((cause: unknown) => setError(message(cause)))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const openTrack = useCallback((id: string) => {
    if (removedIds.current.has(id)) return
    const request = ++openRequest.current
    setError('')
    setNote('')
    api<TrackRecord>(`track?id=${encodeURIComponent(id)}`)
      .then(async track => {
        const current = () => openRequest.current === request && !removedIds.current.has(id)
        if (!current()) return
        const cached = recalculated.current.get(id)
        if (cached) {setOpen({...track, metrics: cached.metrics, coordinates: cached.coordinates}); return}
        if (track.metrics.calculationVersion === METRICS_VERSION) {setOpen(track); return}
        // Old imports keep their original text. Re-read it for summary times and
        // corrected timestamp association, preserving titles and annotation anchors.
        let updated: TrackRecord = {...track, metrics: {...pointMetrics(track.coordinates), calculationVersion: METRICS_VERSION}}
        let sourceUnavailable = false
        try {
          const response = await fetch(`${API}/source?id=${encodeURIComponent(id)}`)
          if (!response.ok) throw new Error('原文件无法读取')
          const parsed = parseTrackFile(track.filename, await response.text())
          if (parsed.points.length === track.coordinates.length && parsed.points.every((point, index) =>
            point[0] === track.coordinates[index][0] && point[1] === track.coordinates[index][1] && point[2] === track.coordinates[index][2])) {
            updated = {...track, metrics: parsed.metrics, coordinates: parsed.points}
          }
        } catch {sourceUnavailable = true}
        if (!current()) return
        // A temporary source failure must be retried when the track is reopened.
        if (!sourceUnavailable) recalculated.current.set(id, updated)
        setOpen(updated)
        setList(previous => previous.map(item => item.id === id ? {...item, metrics: updated.metrics} : item))
        if (sourceUnavailable) setNote('原文件暂时无法读取，已按保存的轨迹点重算统计。')
      })
      .catch((cause: unknown) => { if (openRequest.current === request && !removedIds.current.has(id)) setError(message(cause)) })
  }, [])

  const closeTrack = useCallback(() => { openRequest.current += 1; setOpen(null) }, [])

  const importFiles = useCallback((files: readonly File[]) => {
    void (async () => {
      for (const file of files) {
        setError('')
        setNote(`正在解析 ${file.name}…`)
        try {
          const text = await file.text()
          const parsed = parseTrackFile(file.name, text)
          setNote(`正在保存 ${file.name}…`)
          const input: TrackInput = {...parsed, filename: file.name, source: text}
          const saved = await api<TrackSummary>('tracks', input)
          setList(previous => [saved, ...previous])
          setNote('')
          openTrack(saved.id)
        } catch (cause) {
          setError(`${file.name}：${message(cause)}`)
          setNote('')
        }
      }
    })()
  }, [openTrack])

  const remove = useCallback((id: string) => {
    const pending = removals.current.get(id)
    if (pending) return pending
    const request = (async () => {
      setError('')
      setNote('')
      try {
        await api(`track?id=${encodeURIComponent(id)}`, {}, 'DELETE')
        removedIds.current.add(id)
        recalculated.current.delete(id)
        setList(previous => previous.filter(item => item.id !== id))
        setOpen(current => current?.id === id ? null : current)
        try { localStorage.removeItem(`cqai-track.animation-script.${id}`); localStorage.removeItem(`cqai-track.video-script.${id}`) } catch { /* optional browser cache */ }
        setNote('轨迹已删除。')
        return true
      } catch (cause) {
        setError(message(cause))
        return false
      } finally {
        removals.current.delete(id)
      }
    })()
    removals.current.set(id, request)
    return request
  }, [])

  const saveEdited = useCallback(async (inputs: readonly TrackInput[]) => {
    const saved = await api<TrackSummary[]>('edited-tracks', {tracks: inputs})
    openRequest.current += 1
    setList(previous => [...saved, ...previous])
    if (saved[0] && inputs[0]) setOpen({...saved[0], coordinates: inputs[0].points})
    setError('')
    setNote(`已保存 ${saved.length} 条轨迹副本，原始轨迹保留。`)
  }, [])
  return {
    list, open, error, note,
    refresh, openTrack, closeTrack, importFiles, remove, saveEdited,
    clearError: () => setError(''),
    setNote,
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败'
}
