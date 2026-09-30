/**
 * The panel's whole data layer: the track list, the open track, and the four
 * things the user can do to a track.
 *
 * Kept out of the component so the state transitions can be read in one place —
 * importing is the only sequence with an order that matters (parse, then store,
 * then reload the list, then open what was just stored).
 */
import { useCallback, useEffect, useState } from 'react'
import type { TrackRecord, TrackSummary } from '../protocol.ts'
import { api } from './util.ts'
import { parseTrackFile } from '../track/import.ts'

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
  remove: (id: string) => void
  clearError: () => void
  setNote: (note: string) => void
}

export function useTracks(): TracksState {
  const [list, setList] = useState<TrackSummary[]>([])
  const [open, setOpen] = useState<TrackRecord | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const refresh = useCallback(() => {
    api<TrackSummary[]>('tracks')
      .then(setList)
      // A read that fails must not wipe what is already on screen: the panel is
      // most useful offline, and that is exactly when the list request may fail.
      .catch((cause: unknown) => setError(message(cause)))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const openTrack = useCallback((id: string) => {
    setError('')
    api<TrackRecord>(`track?id=${encodeURIComponent(id)}`)
      .then(setOpen)
      .catch((cause: unknown) => setError(message(cause)))
  }, [])

  const closeTrack = useCallback(() => { setOpen(null) }, [])

  const importFiles = useCallback((files: readonly File[]) => {
    void (async () => {
      for (const file of files) {
        setError('')
        setNote(`正在解析 ${file.name}…`)
        try {
          const text = await file.text()
          const parsed = parseTrackFile(file.name, text)
          setNote(`正在保存 ${file.name}…`)
          const saved = await api<TrackSummary>('tracks', {...parsed, filename: file.name})
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
    api(`track?id=${encodeURIComponent(id)}`, {})
      .then(() => {
        setList(previous => previous.filter(item => item.id !== id))
        setOpen(current => current?.id === id ? null : current)
      })
      .catch((cause: unknown) => setError(message(cause)))
  }, [])

  return {
    list, open, error, note,
    refresh, openTrack, closeTrack, importFiles, remove,
    clearError: () => setError(''),
    setNote,
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败'
}
