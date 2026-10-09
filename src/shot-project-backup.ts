import {closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {readTrack, trackDir, tracksRoot} from './artifacts.ts'
import {GEOMOTION_PROJECT_MAX_BYTES} from './track/geomotion-project-types.ts'
import {resolveOpenMontageShotDirectory} from './openmontage-store.ts'
import type {ShotProjectScope} from './track/shot-project-scope.ts'

/** Also permits backups of sandbox files too large for its normal 2 MB parser. */
export const SHOT_PROJECT_BACKUP_MAX_BYTES = GEOMOTION_PROJECT_MAX_BYTES + 4096
export class ShotProjectBackupError extends Error {
  constructor(message: string, readonly status = 400) {super(message)}
}

/** Read only the existing, fixed sidecar; damaged JSON remains a lossless backup. */
export function readShotProjectBackup(id: string, scene: unknown, env: NodeJS.ProcessEnv = process.env, scope?: ShotProjectScope): {body: Buffer; filename: string} {
  if (scene !== 'map' && scene !== 'sandbox') throw new ShotProjectBackupError('镜头场景参数无效')
  if (!readTrack(id, env)) throw new ShotProjectBackupError('轨迹不存在', 404)
  const directory = scope ? resolveOpenMontageShotDirectory(id, scope, env) : trackDir(id, env), name = scene === 'map' ? 'geomotion-project.json' : 'shot-editor-project.json'
  let descriptor: number | undefined
  try {
    // Backups must not follow a substituted directory or file outside this track.
    const directoryMetadata = lstatSync(directory)
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new ShotProjectBackupError('镜头工程目录无效', 404)
    const resolvedDirectory = realpathSync(directory)
    if (!scope && dirname(resolvedDirectory) !== realpathSync(tracksRoot(env))) throw new ShotProjectBackupError('镜头工程目录无效', 404)
    const file = join(directory, name), metadata = lstatSync(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || dirname(realpathSync(file)) !== resolvedDirectory) throw new ShotProjectBackupError('原始镜头工程不存在', 404)
    descriptor = openSync(file, 'r')
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev) throw new ShotProjectBackupError('原始镜头工程不存在', 404)
    if (opened.size > SHOT_PROJECT_BACKUP_MAX_BYTES) throw new ShotProjectBackupError('原始镜头工程超过备份大小上限', 413)
    const chunks: Buffer[] = []
    let size = 0
    while (size <= SHOT_PROJECT_BACKUP_MAX_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, SHOT_PROJECT_BACKUP_MAX_BYTES + 1 - size))
      const count = readSync(descriptor, chunk, 0, chunk.length, null)
      if (!count) break
      size += count
      if (size > SHOT_PROJECT_BACKUP_MAX_BYTES) throw new ShotProjectBackupError('原始镜头工程超过备份大小上限', 413)
      chunks.push(chunk.subarray(0, count))
    }
    return {body: Buffer.concat(chunks, size), filename: `${scope ? `${scope.projectId}-${scope.shotId}` : id}-${scene}-project-backup.json`}
  } catch (error) {
    if (error instanceof ShotProjectBackupError) throw error
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    throw new ShotProjectBackupError(code === 'ENOENT' || code === 'ENOTDIR' ? '原始镜头工程不存在' : '无法读取原始镜头工程', code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 400)
  } finally {if (descriptor !== undefined) closeSync(descriptor)}
}
