import dns from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { PlacemarkPhotoError } from './placemark-photos-store.ts'
import { PLACEMARK_PHOTO_MAX_BYTES } from './track/placemark-photos.ts'

const DOWNLOAD_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** Conservative public-address policy, based on the IANA special-purpose registries. */
export function isPublicPlacemarkPhotoAddress(address: string): boolean {
  if (address.includes('%')) return false
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6) return false
  // Accept only native global unicast. This also excludes mapped IPv4, NAT64,
  // loopback, private, link-local, multicast, and unassigned IPv6 space.
  const [first, second = '0'] = address.split(':')
  const a = Number.parseInt(first, 16), b = Number.parseInt(second || '0', 16)
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x200 || b === 0xdb8))
    && a !== 0x2002 // 6to4 embeds a destination IPv4 address.
    && !(a === 0x3fff && b < 0x1000) // 3fff::/20 documentation.
}

function validatedUrl(source: string): URL {
  let url: URL
  try { url = new URL(source) } catch { throw new PlacemarkPhotoError('图片链接无效') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PlacemarkPhotoError('图片链接只支持 HTTP 或 HTTPS')
  if (url.username || url.password) throw new PlacemarkPhotoError('图片链接不能包含用户名或密码')
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new PlacemarkPhotoError('图片链接只允许默认 HTTP 或 HTTPS 端口')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new PlacemarkPhotoError('图片链接必须指向公网地址')
  if (isIP(hostname) && !isPublicPlacemarkPhotoAddress(hostname)) throw new PlacemarkPhotoError('图片链接必须指向公网地址')
  url.hash = ''
  return url
}

function abortError(signal: AbortSignal): PlacemarkPhotoError {
  return signal.reason instanceof PlacemarkPhotoError ? signal.reason : new PlacemarkPhotoError('下载图片超时，请重试', 504)
}

async function publicAddress(url: URL, signal: AbortSignal): Promise<LookupAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  if (signal.aborted) throw abortError(signal)
  if (family) return {address: hostname, family}
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError(signal)) }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, {once: true})
    // Inspect every returned address; a mixed public/private result is denied.
    dns.lookup(hostname, {all: true, verbatim: true}).then(addresses => {
      cleanup()
      if (signal.aborted) return reject(abortError(signal))
      if (!addresses.length || addresses.some(entry => !isPublicPlacemarkPhotoAddress(entry.address) || isIP(entry.address) !== entry.family)) {
        return reject(new PlacemarkPhotoError('图片链接必须指向公网地址'))
      }
      resolve(addresses[0])
    }, () => { cleanup(); reject(new PlacemarkPhotoError('无法解析图片链接，请检查后重试', 502)) })
  })
}

type DownloadResult = {body: Buffer; contentType?: string} | {redirect: URL}

function requestPhoto(url: URL, address: LookupAddress, signal: AbortSignal): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      response?.destroy()
      request?.destroy()
      reject(error instanceof PlacemarkPhotoError ? error : new PlacemarkPhotoError('下载图片失败，请检查链接后重试', 502))
    }
    const finish = (result: DownloadResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = () => fail(abortError(signal))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, {once: true})
    // Never re-resolve after validation or reuse another request's pooled socket.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      callback(null, options.all ? [address] : address.address, address.family)
    }
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', agent: false, lookup, family: address.family,
        headers: {accept: 'image/*', 'accept-encoding': 'identity'},
      }, incoming => {
        response = incoming
        incoming.on('error', fail)
        incoming.on('aborted', () => fail(new PlacemarkPhotoError('图片下载中断，请重试', 502)))
        incoming.on('close', () => { if (!settled) fail(new PlacemarkPhotoError('图片下载中断，请重试', 502)) })
        if (settled) { incoming.destroy(); return }
        const status = incoming.statusCode ?? 0
        if (REDIRECT_STATUS.has(status)) {
          try {
            const location = incoming.headers.location
            if (!location) throw new PlacemarkPhotoError('图片链接重定向无效', 502)
            const redirect = validatedUrl(new URL(location, url).href)
            finish({redirect})
            incoming.destroy()
            request?.destroy()
          } catch (error) { fail(error) }
          return
        }
        if (status < 200 || status >= 300) { fail(new PlacemarkPhotoError('图片链接未返回可下载的内容', 502)); return }
        const declared = incoming.headers['content-length']
        if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
          fail(new PlacemarkPhotoError('图片链接返回的大小无效', 502)); return
        }
        if (declared !== undefined && Number(declared) > PLACEMARK_PHOTO_MAX_BYTES) {
          fail(new PlacemarkPhotoError('图片最多 20 MiB', 413)); return
        }
        const chunks: Buffer[] = []
        let size = 0
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > PLACEMARK_PHOTO_MAX_BYTES) { fail(new PlacemarkPhotoError('图片最多 20 MiB', 413)); return }
          chunks.push(chunk)
        })
        incoming.on('end', () => {
          if (incoming.complete === false || (declared !== undefined && Number(declared) !== size)) {
            fail(new PlacemarkPhotoError('图片下载不完整，请重试', 502)); return
          }
          if (!size) { fail(new PlacemarkPhotoError('图片链接返回了空内容', 502)); return }
          finish({body: Buffer.concat(chunks, size), contentType: incoming.headers['content-type']})
        })
      })
      request.on('error', fail)
      request.end()
    } catch (error) { fail(error) }
  })
}

/** Download only the supplied URL; no application cookies, authorization, or track data. */
export async function downloadRemotePlacemarkPhoto(source: string): Promise<{body: Buffer; contentType?: string}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new PlacemarkPhotoError('下载图片超时，请重试', 504)), DOWNLOAD_TIMEOUT_MS)
  timer.unref()
  try {
    let url = validatedUrl(source)
    for (let redirects = 0; ; redirects++) {
      const address = await publicAddress(url, controller.signal)
      const result = await requestPhoto(url, address, controller.signal)
      if ('body' in result) return result
      if (redirects >= MAX_REDIRECTS) throw new PlacemarkPhotoError('图片链接重定向次数过多', 502)
      url = result.redirect
    }
  } finally { clearTimeout(timer) }
}

