/**
 * Panel helpers: the host API, the browser-download dance, and the two small
 * bits of remembered state.
 *
 * Nothing here touches the DOM at module scope, so the tests can import the
 * pure parts (`clipboardSafeName`, `pageUrl`) without a document.
 */
import { API } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import { readMapSettings, writeMapSettings } from '../track/map-settings.ts'

/**
 * The host half's store. Non-GET writes carry the plugin's own header: the
 * host refuses a write without it (see `permitted()`), which is what keeps a
 * page on another origin from pushing files into the local store.
 */
export async function api<T>(action: string, data?: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
  const options: RequestInit = data === undefined
    ? {}
    : {method, headers: {'content-type': 'application/json', 'x-cqai-track': '1'}, body: JSON.stringify(data)}
  const response = await fetch(`${API}/${action}`, options)
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('轨迹服务暂未就绪，请稍候或重启应用')
  }
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || '请求失败') as Error & {status: number}
    error.status = response.status
    throw error
  }
  return result as T
}

/**
 * The URL of the running app's own page. Read off a live element rather than
 * `location.href`, because the panel is also mounted inside the desktop app's
 * custom protocol and the two do not spell the origin the same way.
 */
export function pageUrl(): string {
  if (typeof location === 'undefined') return 'http://127.0.0.1/'
  return location.href
}

/**
 * Hand a file to the browser. The object URL is revoked on the next frame
 * rather than immediately, because the click and the revoke in the same task
 * cancel each other out in Chromium.
 */
export function download(filename: string, contents: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([contents], {type: `${type};charset=utf-8`}))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

/** `name` as the part of a filename that survives every filesystem, without extension. */
export function clipboardSafeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return cleaned.slice(0, 80) || '轨迹'
}

/** Compatibility helpers delegate to the complete versioned preference. */
export function readBasemap(): BasemapId {return readMapSettings().basemap}
export function writeBasemap(basemap: BasemapId): void {writeMapSettings({...readMapSettings(), basemap})}
