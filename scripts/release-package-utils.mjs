import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const PACKAGE_NAME = 'cqai-dsh-plugin-track'
const REPOSITORY = 'git+https://github.com/g-dxw/dsh-plugin-track.git'
const utf8 = new TextDecoder('utf-8', { fatal: true })

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Normalize npm 11 array reports and npm 12 reports keyed by package name. */
export function normalizePackResult(parsed) {
  const checkEntry = value => {
    if (!plainObject(value) || typeof value.name !== 'string' || value.name.length === 0) {
      fail('Invalid npm pack result entry.')
    }
    return value
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) fail('The npm pack result is empty.')
    return parsed.map(checkEntry)
  }
  if (!plainObject(parsed)) fail('Invalid npm pack result shape.')
  const records = Object.entries(parsed)
  if (records.length === 0) fail('The npm pack result is empty.')
  return records.map(([name, value]) => {
    const entry = checkEntry(value)
    if (name !== entry.name) fail('The npm pack result key differs from its package name.')
    return entry
  })
}

function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !/[\\\x00-\x1f\x7f:]/u.test(path)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
      && !/[ .]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

/** Classify safe package-relative source inputs, excluding the three derived groups. */
export function sourcePath(path) {
  return safeRelativePath(path) && path !== 'package.json' && path !== 'SOURCE-SNAPSHOT.json'
    && path !== 'lib' && !path.startsWith('lib/')
}

function fail(message) {
  throw new Error(message)
}

function field(header, start, length) {
  const bytes = header.subarray(start, start + length)
  const end = bytes.indexOf(0)
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function tarNumber(bytes, label) {
  if (bytes[0] & 0x80) {
    if (bytes[0] & 0x40) fail(`Negative tar ${label}.`)
    let value = BigInt(bytes[0] & 0x7f)
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`Tar ${label} is too large.`)
    return Number(value)
  }
  const text = bytes.toString('latin1').replace(/^[\0 ]+|[\0 ]+$/gu, '')
  if (text !== '' && /[^0-7]/u.test(text)) fail(`Invalid tar ${label}.`)
  const value = text === '' ? 0 : Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) fail(`Tar ${label} is too large.`)
  return value
}

function paxValues(body) {
  const values = Object.create(null)
  let at = 0
  while (at < body.length) {
    const space = body.indexOf(32, at)
    if (space < 0) fail('Invalid PAX record length.')
    const lengthText = body.subarray(at, space).toString('latin1')
    if (!/^[1-9][0-9]*$/u.test(lengthText) || /[^0-9]/u.test(lengthText)) fail('Invalid PAX record length.')
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= space - at + 2 || at + length > body.length
      || body[at + length - 1] !== 10) fail('Invalid PAX record size.')
    const value = utf8.decode(body.subarray(space + 1, at + length - 1))
    const equals = value.indexOf('=')
    const key = value.slice(0, equals)
    if (equals < 1 || /[^A-Za-z0-9._-]/u.test(key) || Object.hasOwn(values, key)) {
      fail('Invalid or duplicate PAX attribute.')
    }
    if (key === 'linkpath' || key.startsWith('GNU.sparse') || key === 'SCHILY.realsize') {
      fail('PAX links and sparse files are unsupported.')
    }
    values[key] = value.slice(equals + 1)
    at += length
  }
  return values
}

function paxSize(value, fallback) {
  if (value === undefined) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || /[^0-9]/u.test(value)) fail('Invalid PAX file size.')
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size > MAX_ARCHIVE_BYTES) fail('PAX file size exceeds the archive limit.')
  return size
}

/** Inspect an npm tgz in memory. Never extract provider-controlled paths to disk. */
export function readPackageArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ARCHIVE_BYTES) fail('Invalid or oversized package archive.')
  const tar = gunzipSync(buffer, { maxOutputLength: MAX_ARCHIVE_BYTES })
  if (tar.length % 512 !== 0) fail('Truncated tar archive.')
  const files = new Map()
  const names = new Set()
  let globalPax = Object.create(null)
  let localPax
  let at = 0
  let ended = false
  while (at < tar.length) {
    const header = tar.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) {
      if (at + 1024 > tar.length || !tar.subarray(at).every(byte => byte === 0)) fail('Invalid tar end marker.')
      if (localPax !== undefined) fail('PAX metadata has no following entry.')
      ended = true
      break
    }
    const checksum = tarNumber(header.subarray(148, 156), 'checksum')
    let sum = 0
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]
    if (sum !== checksum) fail('Invalid tar header checksum.')
    const magic = field(header, 257, 6)
    if (magic !== 'ustar' && magic !== 'ustar ') fail('Unsupported tar header format.')
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    if (type === '1' || type === '2') fail('Package archive links are forbidden.')
    if (!['0', '5', 'x', 'g'].includes(type)) fail('Unsupported tar entry type.')
    const prefix = field(header, 345, 155)
    const name = field(header, 0, 100)
    const headerName = prefix === '' ? name : `${prefix}/${name}`
    if (!safeRelativePath(headerName.replace(/\/$/u, ''))) fail('Unsafe tar header path.')
    const headerSize = tarNumber(header.subarray(124, 136), 'size')
    if (headerSize > MAX_ARCHIVE_BYTES) fail('Tar entry exceeds the archive limit.')
    const pax = { ...globalPax, ...localPax }
    const size = type === 'x' || type === 'g' ? headerSize : paxSize(pax.size, headerSize)
    const bodyStart = at + 512
    const next = bodyStart + Math.ceil(size / 512) * 512
    if (next > tar.length) fail('Truncated tar entry.')
    const body = tar.subarray(bodyStart, bodyStart + size)
    if (!tar.subarray(bodyStart + size, next).every(byte => byte === 0)) fail('Invalid tar entry padding.')
    at = next
    if (type === 'x' || type === 'g') {
      const values = paxValues(body)
      if (type === 'g') globalPax = { ...globalPax, ...values }
      else {
        if (localPax !== undefined) fail('Duplicate local PAX metadata.')
        localPax = values
      }
      continue
    }
    localPax = undefined
    const effectiveName = pax.path ?? headerName
    const normalized = type === '5' ? effectiveName.replace(/\/$/u, '') : effectiveName
    if (!safeRelativePath(normalized) || (normalized !== 'package' && !normalized.startsWith('package/'))) {
      fail('Unsafe package archive path.')
    }
    if (normalized === 'package' && type !== '5') fail('The npm package root must be a directory.')
    const identity = normalized.toLowerCase()
    if (names.has(identity)) fail('Duplicate package archive path.')
    names.add(identity)
    if (type === '5') {
      if (size !== 0) fail('Tar directory contains file data.')
      continue
    }
    files.set(normalized.slice('package/'.length), body)
  }
  if (!ended || files.size === 0) fail('Package archive has no valid tar end marker or files.')
  return files
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactVersion(value) {
  if (typeof value !== 'string' || value.length > 256) return false
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value)
  return match !== null && match[0] === value && match.slice(1, 4).every(part => Number.isSafeInteger(Number(part)))
    && (match[4] === undefined || match[4].split('.').every(part => !/^[0-9]+$/u.test(part) || !/^0[0-9]/u.test(part)))
}

/** Verify the release payload and its complete corresponding-source inventory. */
export function verifyPackage(buffer) {
  const files = readPackageArchive(buffer)
  const required = path => {
    const body = files.get(path)
    if (body === undefined || body.length === 0) fail(`Required package file is missing or empty: ${path}`)
    return body
  }
  const manifest = JSON.parse(utf8.decode(required('package.json')))
  const snapshotBytes = required('SOURCE-SNAPSHOT.json')
  const snapshot = JSON.parse(utf8.decode(snapshotBytes))
  if (!object(manifest) || manifest.name !== PACKAGE_NAME || !exactVersion(manifest.version)) fail('Invalid Track package name or version.')
  if (!object(manifest.repository) || manifest.repository.url !== REPOSITORY || manifest.repository.type !== 'git') fail('Invalid Track package repository.')
  if (!object(manifest.dsh) || !object(manifest.dsh.bundle)
    || !['cordis.patch.yml', './cordis.patch.yml'].includes(manifest.dsh.bundle.patch)) fail('Invalid DSH bundle patch declaration.')
  if (manifest.main !== 'lib/index.js' || !object(manifest.exports)
    || manifest.exports['.'] !== './lib/index.js' || manifest.exports['./client'] !== './lib/client.js') fail('Invalid package build entry declarations.')
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'BUILDING.md', 'build-inputs/yarn.lock']) required(path)
  required('cordis.patch.yml')
  required('lib/index.js')
  required('lib/client.js')
  const source = manifest.trackSource
  if (!object(source) || typeof source.baseCommit !== 'string' || source.baseCommit.length !== 40 || !/^[0-9a-f]{40}$/u.test(source.baseCommit) || source.dirty !== false
    || source.sourceSnapshotSha256 !== sha256(snapshotBytes)) fail('Invalid package trackSource or snapshot hash.')
  if (!object(snapshot) || snapshot.schemaVersion !== 1 || snapshot.version !== manifest.version
    || snapshot.baseCommit !== source.baseCommit || snapshot.dirty !== false || !Array.isArray(snapshot.files)) fail('Invalid corresponding-source snapshot metadata.')
  const entries = new Map()
  const identities = new Set()
  for (const entry of snapshot.files) {
    if (!object(entry) || !sourcePath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || entry.bytes > MAX_ARCHIVE_BYTES || typeof entry.sha256 !== 'string' || entry.sha256.length !== 64 || !/^[0-9a-f]{64}$/u.test(entry.sha256)) fail('Invalid source snapshot file entry.')
    const identity = entry.path.toLowerCase()
    if (identities.has(identity)) fail('Duplicate source snapshot path.')
    identities.add(identity)
    entries.set(entry.path, entry)
  }
  const packagedSource = [...files.keys()].filter(sourcePath)
  if (!packagedSource.some(path => path.startsWith('src/')) || !packagedSource.some(path => path.startsWith('licenses/'))) {
    fail('Package is missing source code or license files.')
  }
  if (packagedSource.length !== entries.size) fail('Package source inventory differs from the snapshot.')
  for (const [path, entry] of entries) {
    const body = files.get(path)
    if (body === undefined || body.length !== entry.bytes || sha256(body) !== entry.sha256) fail(`Source file differs from snapshot: ${path}`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    sha256: sha256(buffer),
    integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
    sourceFileCount: entries.size,
    baseCommit: source.baseCommit,
  }
}
