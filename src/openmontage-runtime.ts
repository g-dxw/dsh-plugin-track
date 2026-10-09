import {spawn, type ChildProcess} from 'node:child_process'
import {existsSync, mkdirSync} from 'node:fs'
import {createServer} from 'node:net'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {OpenMontageError, openMontageBridgePath, openMontageEnvironment, openMontageProjectsRoot, openMontageRoot, readOpenMontageSettings, runOpenMontageCommand} from './openmontage-store.ts'
import type {OpenMontageConnection, OpenMontageSettings} from './track/openmontage.ts'

interface OwnedRuntime {child: ChildProcess; key: string; url: string; owner: string; starting?: Promise<string>; diagnostics: string; exited: boolean}
const runtimes = new Map<string, OwnedRuntime>()
const connecting = new Map<string, Promise<string>>()
const checks = new Map<string, {at: number; result: OpenMontageConnection}>()
const generations = new Map<string, number>()
const keyOf = (settings: OpenMontageSettings) => JSON.stringify(settings)

export async function inspectOpenMontageConnection(env: NodeJS.ProcessEnv = process.env): Promise<OpenMontageConnection> {
  const settings = readOpenMontageSettings(env), root = openMontageRoot(env), key = root + keyOf(settings), cached = checks.get(key)
  if (cached && Date.now() - cached.at < 10000) return {...cached.result, ...(runtimes.get(root)?.key === keyOf(settings) && !runtimes.get(root)?.exited ? {backlotUrl: runtimes.get(root)!.url} : {})}
  const issues = ['AGENT_GUIDE.md', 'lib/checkpoint.py', 'pipeline_defs/hybrid.yaml', 'backlot/server.py', 'schemas/artifacts/scene_plan.schema.json']
    .filter(name => !existsSync(join(settings.sourceDirectory, name))).map(name => `OpenMontage 源码或文件缺失：${name}`)
  let pythonVersion: string | undefined
  if (!issues.length) {
    try {
      const detected = await runOpenMontageCommand<{issues: string[]; pythonVersion: string; ready: boolean}>('detect', {}, env, settings)
      issues.push(...detected.issues); pythonVersion = detected.pythonVersion
    } catch (error) {issues.push(error instanceof Error ? error.message : String(error))}
  }
  const result: OpenMontageConnection = {settings, ready: !issues.length, issues, projectsDirectory: openMontageProjectsRoot(env), ...(pythonVersion ? {pythonVersion} : {})}
  checks.set(key, {at: Date.now(), result})
  return result
}
const port = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') {server.close(); reject(new Error('本机端口分配失败')); return}
    server.close(error => error ? reject(error) : resolve(address.port))
  })
})
function stop(runtime: OwnedRuntime): void {
  if (!runtime.exited) {runtime.exited = true; runtime.child.kill()}
}
/** Never attaches to, kills, or rewrites an externally started Backlot process. */
export async function ensureOpenMontageBacklot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const root = openMontageRoot(env), settings = readOpenMontageSettings(env), key = keyOf(settings), existing = runtimes.get(root)
  if (existing && existing.key === key && !existing.exited) return existing.url
  const pending = connecting.get(root)
  if (pending) {await pending; return ensureOpenMontageBacklot(env)}
  const generation = generations.get(root) ?? 0
  const checkActive = () => {if ((generations.get(root) ?? 0) !== generation) throw new OpenMontageError('Backlot 连接已取消，请重新连接', 409)}
  const promise = (async () => {
    if (existing) {stop(existing); runtimes.delete(root)}
    const connection = await inspectOpenMontageConnection(env)
    checkActive()
    if (!connection.ready) throw new OpenMontageError(connection.issues.join('\n'), 503)
    mkdirSync(openMontageProjectsRoot(env), {recursive: true})
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allocated = await port(), owner = randomUUID(), url = `http://127.0.0.1:${allocated}`
      checkActive()
      const child = spawn(settings.pythonPath, [openMontageBridgePath(), 'serve', '--port', String(allocated)], {cwd: settings.sourceDirectory,
        env: {...process.env, ...env, ...openMontageEnvironment(settings, env), TRACK_OPENMONTAGE_OWNER: owner}, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']})
      const runtime: OwnedRuntime = {child, key, url, owner, diagnostics: '', exited: false}
      runtimes.set(root, runtime)
      child.stderr?.on('data', (chunk: Buffer) => {runtime.diagnostics = (runtime.diagnostics + chunk.toString('utf8')).slice(-6000)})
      child.on('error', error => {runtime.diagnostics = error.message; runtime.exited = true})
      child.on('exit', () => {runtime.exited = true})
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !runtime.exited) {
        try {
          const response = await fetch(url + '/api/track-owner', {signal: AbortSignal.timeout(1000)}), value = await response.json() as {owner?: string}
          if (response.ok && value.owner === owner && !runtime.exited) return url
        } catch {/* The owned process is still starting; no unrelated service is accepted. */}
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      stop(runtime)
      if (!runtime.diagnostics.includes('address already in use') && !runtime.diagnostics.includes('10048')) {
        throw new OpenMontageError(`Backlot 启动失败：${runtime.diagnostics || '未在规定时间内启动'}`, 503)
      }
    }
    throw new OpenMontageError('Backlot 本机端口冲突，请重试', 503)
  })()
  connecting.set(root, promise)
  try {return await promise} finally {connecting.delete(root)}
}
export function disposeOpenMontage(env?: NodeJS.ProcessEnv): void {
  if (env) {const root = openMontageRoot(env), runtime = runtimes.get(root); generations.set(root, (generations.get(root) ?? 0) + 1); if (runtime) stop(runtime); runtimes.delete(root); for (const key of checks.keys()) if (key.startsWith(root)) checks.delete(key); return}
  for (const root of new Set([...runtimes.keys(), ...connecting.keys()])) generations.set(root, (generations.get(root) ?? 0) + 1)
  for (const runtime of runtimes.values()) stop(runtime)
  runtimes.clear(); checks.clear()
}
