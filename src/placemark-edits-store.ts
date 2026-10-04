import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import { validatePlacemarkEdits, type PlacemarkEdit } from './track/placemark-edits.ts'
import { hasPlacemarkState, patchPlacemarkState, readPlacemarkState } from './placemark-state-store.ts'

/** Image assignments and marker corrections never overwrite the imported file. */
export function readPlacemarkEdits(id: string, env: NodeJS.ProcessEnv = process.env): PlacemarkEdit[] {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  if (hasPlacemarkState(id, env)) return readPlacemarkState(id, env).edits
  const path = join(trackDir(id, env), 'placemark-edits.json')
  if (!existsSync(path)) return []
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!document || typeof document !== 'object' || (document as {version?: unknown}).version !== 1) throw new Error('点位调整文件格式无效')
  return validatePlacemarkEdits((document as {edits?: unknown}).edits)
}

/** Validate the complete batch before replacing the sidecar, including photo transfers. */
export function writePlacemarkEdits(id: string, value: unknown, env: NodeJS.ProcessEnv = process.env): PlacemarkEdit[] {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  const edits = validatePlacemarkEdits(value)
  return patchPlacemarkState(id, {edits}, env).edits
}
