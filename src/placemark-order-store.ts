import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTrack, trackDir } from './artifacts.ts'
import { isPlacemarkOrder } from './track/placemark-order.ts'
import { hasPlacemarkState, patchPlacemarkState, readPlacemarkState } from './placemark-state-store.ts'

function validateOrder(value: unknown): string[] | null {
  if (!isPlacemarkOrder(value)) throw new Error('点位顺序须为最多 10000 个不重复的编号，每个编号为 1 至 200 个字符')
  return value === null ? null : [...value]
}

/** A separate display order also supports points restored from an old KML source. */
export function readPlacemarkOrder(id: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  if (hasPlacemarkState(id, env)) return readPlacemarkState(id, env).order
  const path = join(trackDir(id, env), 'placemark-order.json')
  if (!existsSync(path)) return null
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!document || typeof document !== 'object' || (document as {version?: unknown}).version !== 1) throw new Error('点位顺序文件格式无效')
  return validateOrder((document as {order?: unknown}).order)
}

/** null restores chronological order without changing track.json or the source file. */
export function writePlacemarkOrder(id: string, value: unknown, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!readTrack(id, env)) throw new Error('轨迹不存在')
  const order = validateOrder(value)
  return patchPlacemarkState(id, {order}, env).order
}
