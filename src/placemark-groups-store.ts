import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import type { PlacemarkGroup } from './protocol.ts'
import { validatePlacemarkGroups } from './track/placemark-groups.ts'
import { hasPlacemarkState, patchPlacemarkState, readPlacemarkState } from './placemark-state-store.ts'

export function readPlacemarkGroups(id: string, env: NodeJS.ProcessEnv = process.env): PlacemarkGroup[] {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  if (hasPlacemarkState(id, env)) return readPlacemarkState(id, env).groups
  const path = join(trackDir(id, env), 'placemark-groups.json')
  if (!existsSync(path)) return []
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!document || typeof document !== 'object' || (document as {version?: unknown}).version !== 1) throw new Error('分组文件格式无效')
  return validatePlacemarkGroups((document as {groups?: unknown}).groups)
}

/** Grouping and ungrouping only replace references, never child points or source bytes. */
export function writePlacemarkGroups(id: string, value: unknown, env: NodeJS.ProcessEnv = process.env): PlacemarkGroup[] {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  const groups = validatePlacemarkGroups(value)
  return patchPlacemarkState(id, {groups}, env).groups
}
