import { EventEmitter } from 'node:events'
import type { LookupAddress } from 'node:dns'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadRemotePlacemarkPhoto, isPublicPlacemarkPhotoAddress } from '../src/remote-placemark-photo.ts'
import { PLACEMARK_PHOTO_MAX_BYTES } from '../src/track/placemark-photos.ts'

const {lookupMock, httpMock, httpsMock} = vi.hoisted(() => ({
  lookupMock: vi.fn(), httpMock: vi.fn(), httpsMock: vi.fn(),
}))
vi.mock('node:dns/promises', () => ({default: {lookup: lookupMock}}))
vi.mock('node:http', () => ({default: {request: httpMock}}))
vi.mock('node:https', () => ({default: {request: httpsMock}}))

interface Reply {
  status?: number
  headers?: IncomingHttpHeaders
  chunks?: Buffer[]
  complete?: boolean
  abort?: boolean
  error?: boolean
  hang?: boolean
}
interface CapturedRequest {
  url: URL
  options: RequestOptions
  request: EventEmitter & {destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>}
  response?: EventEmitter & {destroy: ReturnType<typeof vi.fn>}
}
const replies: Reply[] = []
const requests: CapturedRequest[] = []

function requestReply(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
  const reply = replies.shift()
  if (!reply) throw new Error('Unexpected network request in offline test')
  const request = Object.assign(new EventEmitter(), {
    destroy: vi.fn(), end: vi.fn(),
  })
  const captured: CapturedRequest = {url, options, request}
  requests.push(captured)
  request.end.mockImplementation(() => {
    queueMicrotask(() => {
      if (request.destroy.mock.calls.length || reply.hang) return
      const response = Object.assign(new EventEmitter(), {
        statusCode: reply.status ?? 200,
        headers: reply.headers ?? {'content-type': 'image/png'},
        complete: reply.complete ?? true,
        destroy: vi.fn(),
      })
      captured.response = response
      callback(response as unknown as IncomingMessage)
      if (response.destroy.mock.calls.length) return
      if (reply.error) { response.emit('error', new Error('stream error')); return }
      if (reply.abort) { response.emit('aborted'); return }
      for (const chunk of reply.chunks ?? [Buffer.from([0, 255, 1, 128])]) {
        response.emit('data', chunk)
        if (response.destroy.mock.calls.length) return
      }
      response.emit('end')
      response.emit('close')
    })
  })
  return request as unknown as ClientRequest
}

beforeEach(() => {
  lookupMock.mockReset().mockResolvedValue([{address: '8.8.8.8', family: 4}])
  httpMock.mockReset().mockImplementation(requestReply)
  httpsMock.mockReset().mockImplementation(requestReply)
  replies.length = 0
  requests.length = 0
})
afterEach(() => { vi.useRealTimers() })

describe('remote photo public-address policy', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.2.3.4', '100.64.0.1', '100.127.255.254', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:a00:1', '::ffff:8.8.8.8', '::127.0.0.1',
    '64:ff9b::a00:1', '64:ff9b:1::1', '100::1', '2001::1', '2001:2::1', '2001:10::1',
    '2001:db8::1', '2002:7f00:1::1', '3fff::1', '3fff:fff::1', '5f00::1', 'fc00::1',
    'fdff::1', 'fe80::1', 'fec0::1', 'ff02::1', 'localhost', 'invalid',
  ])('denies special, private, and reserved address %s', address => {
    expect(isPublicPlacemarkPhotoAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
    '192.0.1.1', '198.20.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450::1'])('accepts public address %s', address => {
    expect(isPublicPlacemarkPhotoAddress(address)).toBe(true)
  })
})

describe('offline safe remote photo download', () => {
  it.each([
    'not a URL', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://photos.example/a.png',
    'https://user:password@photos.example/a.png', 'https://user@photos.example/a.png',
    'http://photos.example:8080/a.png', 'https://photos.example:80/a.png', 'http://photos.example:443/a.png',
    'http://localhost/a.png', 'http://other.localhost/a.png', 'http://127.0.0.1/a.png',
    'http://2130706433/a.png', 'http://0177.0.0.1/a.png', 'http://0x7f000001/a.png',
    'http://[::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png', 'https://[fe80::1]/a.png',
  ])('rejects unsafe source before any network call: %s', async source => {
    await expect(downloadRemotePlacemarkPhoto(source)).rejects.toMatchObject({status: 400})
    expect(lookupMock).not.toHaveBeenCalled()
    expect(httpMock).not.toHaveBeenCalled()
    expect(httpsMock).not.toHaveBeenCalled()
  })

  it('preserves original bytes and supplies only image request headers with a pinned DNS lookup', async () => {
    const body = Buffer.from([0, 255, 1, 128, 13, 10])
    replies.push({headers: {'content-type': 'image/png', 'content-length': String(body.length)}, chunks: [body.subarray(0, 3), body.subarray(3)]})
    const result = await downloadRemotePlacemarkPhoto('https://photos.example/a.png?version=2#secret')
    expect(result).toEqual({body, contentType: 'image/png'})
    expect(lookupMock).toHaveBeenCalledExactlyOnceWith('photos.example', {all: true, verbatim: true})
    expect(httpMock).not.toHaveBeenCalled()
    expect(requests[0].url.href).toBe('https://photos.example/a.png?version=2')
    expect(requests[0].options).toMatchObject({method: 'GET', agent: false, family: 4})
    expect(requests[0].options.headers).toEqual({accept: 'image/*', 'accept-encoding': 'identity'})
    // A changed DNS response is never consulted during the actual connection.
    lookupMock.mockResolvedValue([{address: '127.0.0.1', family: 4}])
    const pinned = vi.fn()
    requests[0].options.lookup!('photos.example', {}, pinned)
    expect(pinned).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    const pinnedAll = vi.fn()
    requests[0].options.lookup!('photos.example', {all: true}, pinnedAll)
    expect(pinnedAll).toHaveBeenCalledWith(null, [{address: '8.8.8.8', family: 4}], 4)
    expect(lookupMock).toHaveBeenCalledOnce()
  })

  it('pins public IPv6 while retaining the original HTTPS hostname', async () => {
    lookupMock.mockResolvedValue([{address: '2606:4700:4700::1111', family: 6}])
    replies.push({})
    await downloadRemotePlacemarkPhoto('https://photos.example/a.png')
    const pinned = vi.fn()
    requests[0].options.lookup!('photos.example', {}, pinned)
    expect(pinned).toHaveBeenCalledWith(null, '2606:4700:4700::1111', 6)
    expect(requests[0].url.hostname).toBe('photos.example')
    expect(requests[0].options.family).toBe(6)
  })

  it.each(['http://8.8.8.8/a.png', 'https://[2606:4700:4700::1111]/a.png'])('accepts a public IP literal without resolving DNS: %s', async source => {
    replies.push({})
    await expect(downloadRemotePlacemarkPhoto(source)).resolves.toMatchObject({body: expect.any(Buffer)})
    expect(lookupMock).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
  })

  it.each(([
    [], [{address: '127.0.0.1', family: 4}], [{address: '169.254.169.254', family: 4}],
    [{address: '::ffff:192.168.1.1', family: 6}], [{address: '8.8.8.8', family: 6}],
    [{address: '8.8.8.8', family: 4}, {address: '192.168.1.1', family: 4}],
  ] as LookupAddress[][]).map(addresses => ({addresses})))('rejects a non-public, mixed, empty, or mismatched DNS answer', async ({addresses}) => {
    lookupMock.mockResolvedValue(addresses)
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 400})
    expect(requests).toHaveLength(0)
  })

  it('reports a DNS failure without sending a request', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 502})
    expect(requests).toHaveLength(0)
  })

  it('follows relative and cross-origin redirects with fresh validation and closed redirect sockets', async () => {
    replies.push({status: 302, headers: {location: '/next.png'}}, {status: 307, headers: {location: 'https://cdn.example/a.png'}}, {})
    await downloadRemotePlacemarkPhoto('http://photos.example/a.png')
    expect(requests.map(entry => entry.url.href)).toEqual(['http://photos.example/a.png', 'http://photos.example/next.png', 'https://cdn.example/a.png'])
    expect(lookupMock.mock.calls.map(call => call[0])).toEqual(['photos.example', 'photos.example', 'cdn.example'])
    expect(httpMock).toHaveBeenCalledTimes(2)
    expect(httpsMock).toHaveBeenCalledOnce()
    for (const entry of requests.slice(0, 2)) {
      expect(entry.response!.destroy).toHaveBeenCalledOnce()
      expect(entry.request.destroy).toHaveBeenCalledOnce()
    }
  })

  it.each(['http://127.0.0.1/a.png', 'https://[::ffff:10.0.0.1]/a.png', 'file:///secret', 'https://user@cdn.example/a.png', 'https://cdn.example:8443/a.png'])('denies unsafe redirect destination %s before connecting', async location => {
    replies.push({status: 302, headers: {location}})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 400})
    expect(requests).toHaveLength(1)
    expect(requests[0].response!.destroy).toHaveBeenCalledOnce()
    expect(requests[0].request.destroy).toHaveBeenCalledOnce()
  })

  it('revalidates DNS on a redirect to the same host and denies rebinding', async () => {
    lookupMock.mockResolvedValueOnce([{address: '8.8.8.8', family: 4}]).mockResolvedValueOnce([{address: '10.0.0.1', family: 4}])
    replies.push({status: 301, headers: {location: '/next.png'}})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 400})
    expect(lookupMock).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(1)
  })

  it('allows five redirects and rejects a sixth without requesting its destination', async () => {
    for (let i = 0; i < 5; i++) replies.push({status: 302, headers: {location: `/redirect-${i}.png`}})
    replies.push({})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).resolves.toHaveProperty('body')
    expect(requests).toHaveLength(6)
    requests.length = 0
    for (let i = 0; i < 6; i++) replies.push({status: 302, headers: {location: `/redirect-${i}.png`}})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 502, message: expect.stringContaining('重定向次数')})
    expect(requests).toHaveLength(6)
  })

  it.each([302, 304, 401, 404, 500])('rejects a missing redirect or non-success HTTP status %s', async status => {
    replies.push({status, headers: {}})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 502})
    expect(requests[0].request.destroy).toHaveBeenCalledOnce()
    expect(requests[0].response!.destroy).toHaveBeenCalledOnce()
  })

  it('rejects declared oversize before reading the body', async () => {
    replies.push({headers: {'content-length': String(PLACEMARK_PHOTO_MAX_BYTES + 1)}})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 413})
    expect(requests[0].response!.destroy).toHaveBeenCalledOnce()
    expect(requests[0].request.destroy).toHaveBeenCalledOnce()
  })

  it('enforces the streamed cap when Content-Length is absent and accepts the exact limit', async () => {
    const limit = Buffer.alloc(PLACEMARK_PHOTO_MAX_BYTES, 7)
    replies.push({headers: {}, chunks: [limit, Buffer.from([1])]})
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 413})
    expect(requests[0].response!.destroy).toHaveBeenCalledOnce()
    expect(requests[0].request.destroy).toHaveBeenCalledOnce()
    replies.push({headers: {'content-length': String(PLACEMARK_PHOTO_MAX_BYTES)}, chunks: [limit]})
    const result = await downloadRemotePlacemarkPhoto('https://photos.example/a.png')
    expect(result.body.equals(limit)).toBe(true)
  })

  it.each([
    {chunks: []}, {complete: false}, {headers: {'content-length': '100'}},
    {headers: {'content-length': 'invalid'}}, {headers: {'content-length': '9007199254740992'}},
    {abort: true}, {error: true},
  ])('rejects empty, malformed, truncated, or failed response and cleans both streams', async reply => {
    replies.push(reply)
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 502})
    expect(requests[0].response!.destroy).toHaveBeenCalledOnce()
    expect(requests[0].request.destroy).toHaveBeenCalledOnce()
  })

  it('times out stalled DNS without starting a request when it eventually resolves', async () => {
    vi.useFakeTimers()
    let resolveDns!: (addresses: LookupAddress[]) => void
    lookupMock.mockImplementation(() => new Promise<LookupAddress[]>(resolve => { resolveDns = resolve }))
    const download = downloadRemotePlacemarkPhoto('https://photos.example/a.png')
    const rejected = expect(download).rejects.toMatchObject({status: 504})
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    resolveDns([{address: '8.8.8.8', family: 4}])
    await Promise.resolve()
    expect(requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one total timeout across DNS, redirects, and a stalled request', async () => {
    vi.useFakeTimers()
    lookupMock.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve([{address: '8.8.8.8', family: 4}]), 6_000)
    }))
    replies.push({status: 302, headers: {location: '/next.png'}}, {hang: true})
    const download = downloadRemotePlacemarkPhoto('https://photos.example/a.png')
    const rejected = expect(download).rejects.toMatchObject({status: 504})
    await vi.advanceTimersByTimeAsync(19_999)
    expect(requests).toHaveLength(2)
    expect(requests[1].request.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(requests[1].request.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes a stalled body on timeout and clears the timer after a successful download', async () => {
    vi.useFakeTimers()
    const request = Object.assign(new EventEmitter(), {destroy: vi.fn(), end: vi.fn()})
    const response = Object.assign(new EventEmitter(), {statusCode: 200, headers: {}, destroy: vi.fn()})
    httpsMock.mockImplementationOnce((_url, _options, callback) => {
      request.end.mockImplementation(() => callback(response))
      return request
    })
    const download = downloadRemotePlacemarkPhoto('https://photos.example/a.png')
    const rejected = expect(download).rejects.toMatchObject({status: 504})
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(request.destroy).toHaveBeenCalledOnce()
    expect(response.destroy).toHaveBeenCalledOnce()
    replies.push({})
    await downloadRemotePlacemarkPhoto('https://photos.example/a.png')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles request creation and connection failures without exposing upstream details', async () => {
    httpsMock.mockImplementationOnce(() => { throw new Error('private upstream detail') })
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 502, message: expect.not.stringContaining('private upstream detail')})
    const request = Object.assign(new EventEmitter(), {destroy: vi.fn(), end: vi.fn()})
    request.end.mockImplementation(() => request.emit('error', new Error('connect failure')))
    httpsMock.mockReturnValueOnce(request)
    await expect(downloadRemotePlacemarkPhoto('https://photos.example/a.png')).rejects.toMatchObject({status: 502})
    expect(request.destroy).toHaveBeenCalledOnce()
  })
})

