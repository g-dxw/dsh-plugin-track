import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { normalizePackResult, readPackageArchive, sha256, sourcePath, verifyPackage } from './release-package-utils.mjs'

const baseCommit = 'a'.repeat(40)
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value)

function header(name, body, type = '0', options = {}) {
  const result = Buffer.alloc(512)
  result.write(name, 0, 100, 'utf8')
  result.write('0000644\0', 100, 8, 'ascii')
  result.write('0000000\0', 108, 8, 'ascii')
  result.write('0000000\0', 116, 8, 'ascii')
  result.write((options.size ?? body.length).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  result.write('00000000000\0', 136, 12, 'ascii')
  result.fill(32, 148, 156)
  result[156] = type.charCodeAt(0)
  if (options.linkname) result.write(options.linkname, 157, 100, 'utf8')
  result.write('ustar\0', 257, 6, 'ascii')
  result.write('00', 263, 2, 'ascii')
  if (options.prefix) result.write(options.prefix, 345, 155, 'utf8')
  const sum = result.reduce((total, byte) => total + byte, 0)
  result.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return result
}

function archive(entries) {
  const chunks = entries.flatMap(entry => {
    const body = bytes(entry.body ?? '')
    return [entry.header ?? header(entry.name, body, entry.type, entry.options), body,
      Buffer.alloc((512 - body.length % 512) % 512)]
  })
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

function pax(key, value) {
  const tail = Buffer.from(`${key}=${value}\n`)
  let length = tail.length + 2
  while (length !== tail.length + String(length).length + 1) length = tail.length + String(length).length + 1
  return Buffer.concat([Buffer.from(`${length} `), tail])
}

function fixture(extra = {}) {
  const source = new Map(Object.entries({
    'LICENSE': 'Complete Track project license.\n',
    'THIRD_PARTY_NOTICES.md': 'Complete third-party notices.\n',
    'BUILDING.md': 'Use the included Yarn lockfile to rebuild the source.\n',
    'build-inputs/yarn.lock': 'Fixture lockfile bytes.\n',
    'src/index.ts': 'export const name = "track"\n',
    'licenses/component-LICENSE': 'Complete component copyright and license text.\n',
    'cordis.patch.yml': '- insert:\n    - name: cqai-dsh-plugin-track\n',
    ...extra,
  }).map(([path, body]) => [path, bytes(body)]))
  const snapshot = {
    schemaVersion: 1, version: '0.1.3', baseCommit, dirty: false,
    files: [...source].map(([path, body]) => ({ path, bytes: body.length, sha256: sha256(body) })),
  }
  const snapshotBody = Buffer.from(JSON.stringify(snapshot))
  const manifest = {
    name: 'cqai-dsh-plugin-track', version: '0.1.3',
    main: 'lib/index.js', exports: { '.': './lib/index.js', './client': './lib/client.js' },
    repository: { type: 'git', url: 'git+https://github.com/g-dxw/dsh-plugin-track.git' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    trackSource: { baseCommit, dirty: false, sourceSnapshotSha256: sha256(snapshotBody) },
  }
  return {
    manifest, snapshot,
    entries: [
      { name: 'package/package.json', body: JSON.stringify(manifest) },
      { name: 'package/SOURCE-SNAPSHOT.json', body: snapshotBody },
      ...[...source].map(([path, body]) => ({ name: `package/${path}`, body })),
      { name: 'package/lib/index.js', body: 'export const name="track";' },
      { name: 'package/lib/client.js', body: 'window.__ModuleLoader__.load({id:"cqai-dsh-plugin-track"});' },
    ],
  }
}

function changedManifest(change) {
  const value = fixture()
  change(value.manifest)
  value.entries[0].body = JSON.stringify(value.manifest)
  return archive(value.entries)
}

function changedSnapshot(change) {
  const value = fixture()
  change(value.snapshot)
  const body = Buffer.from(JSON.stringify(value.snapshot))
  value.entries[1].body = body
  value.manifest.trackSource.sourceSnapshotSha256 = sha256(body)
  value.entries[0].body = JSON.stringify(value.manifest)
  return archive(value.entries)
}

test('normalizes the npm 11 array pack report without changing its package records', () => {
  const entry = { name: 'cqai-dsh-plugin-track', version: '0.1.3', filename: 'cqai-dsh-plugin-track-0.1.3.tgz', files: [{ path: 'src/index.ts' }] }
  assert.deepEqual(normalizePackResult([entry]), [entry])
})

test('normalizes the npm 12 keyed report and leaves multiple-package rejection to the caller', () => {
  const track = { name: 'cqai-dsh-plugin-track', version: '0.1.3', files: [] }
  const other = { name: 'another-package', version: '1.0.0', files: [] }
  assert.deepEqual(normalizePackResult({ 'cqai-dsh-plugin-track': track }), [track])
  assert.deepEqual(normalizePackResult({ 'cqai-dsh-plugin-track': track, 'another-package': other }), [track, other])
  assert.throws(() => normalizePackResult({ 'wrong-name': track }), /key differs/u)
})

test('rejects empty, primitive and malformed npm pack report shapes', () => {
  for (const value of [null, undefined, true, 1, 'report', [], {}, [null], ['entry'], [{}], { track: null }, { track: [] }, new Date()]) {
    assert.throws(() => normalizePackResult(value))
  }
})

test('valid tgz verifies complete source inventory and returns publication checksums', () => {
  const buffer = archive(fixture().entries)
  assert.deepEqual(verifyPackage(buffer), {
    name: 'cqai-dsh-plugin-track', version: '0.1.3', baseCommit,
    sourceFileCount: 7, sha256: sha256(buffer),
    integrity: 'sha512-' + (independentSha512(buffer)),
  })
  assert.equal(readPackageArchive(buffer).size, 11)
})

// Independent checksum implementation for the expected public result.
function independentSha512(buffer) { return createHash('sha512').update(buffer).digest('base64') }

test('sourcePath rejects unsafe names and excludes only derived groups', () => {
  for (const path of ['src/index.ts', 'licenses/LICENSE', 'cordis.patch.yml', 'docs/example.md']) assert.equal(sourcePath(path), true, path)
  for (const path of ['package.json', 'SOURCE-SNAPSHOT.json', 'lib/index.js', '', '../x', '/x', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a\nx', 'a/NUL.txt', 'a/file.']) assert.equal(sourcePath(path), false, path)
})

test('source byte tampering, missing source and extra source all fail', () => {
  const changed = fixture()
  changed.entries.find(entry => entry.name === 'package/src/index.ts').body = 'changed source'
  assert.throws(() => verifyPackage(archive(changed.entries)), /Source file differs/u)
  const omitted = fixture().entries.filter(entry => entry.name !== 'package/src/index.ts')
  assert.throws(() => verifyPackage(archive(omitted)), /missing source code|inventory differs/u)
  const extra = [...fixture().entries, { name: 'package/src/extra.ts', body: 'extra source' }]
  assert.throws(() => verifyPackage(archive(extra)), /inventory differs/u)
})

test('missing required files and empty artifacts fail', () => {
  for (const path of ['package.json', 'SOURCE-SNAPSHOT.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'BUILDING.md', 'build-inputs/yarn.lock']) {
    const entries = fixture().entries.filter(entry => entry.name !== `package/${path}`)
    assert.throws(() => verifyPackage(archive(entries)), /Required package file/u, path)
  }
  const entries = fixture().entries
  entries.find(entry => entry.name === 'package/lib/client.js').body = ''
  assert.throws(() => verifyPackage(archive(entries)), /missing or empty/u)
  assert.throws(() => verifyPackage(archive(fixture().entries.filter(entry => !entry.name.startsWith('package/licenses/')))), /missing source code or license/u)
})

test('manifest identity, version, repository, patch and snapshot identity are checked', () => {
  for (const change of [
    value => { value.name = 'another-package' },
    value => { value.main = 'lib/missing.js' },
    value => { value.exports['.'] = './lib/missing.js' },
    value => { value.exports['./client'] = './lib/missing.js' },
    value => { value.version = '01.1.3' },
    value => { value.version = '0.1.3\n' },
    value => { value.version = '0.1.3-beta.01' },
    value => { value.repository.url = 'git+https://github.com/other/track.git' },
    value => { value.dsh.bundle.patch = '../cordis.patch.yml' },
    value => { value.trackSource.dirty = true },
    value => { value.trackSource.baseCommit = baseCommit + '\n' },
    value => { value.trackSource.sourceSnapshotSha256 = '0'.repeat(64) },
  ]) assert.throws(() => verifyPackage(changedManifest(change)))
  for (const change of [
    value => { value.schemaVersion = 2 },
    value => { value.version = '0.1.4' },
    value => { value.baseCommit = 'b'.repeat(40) },
    value => { value.dirty = true },
    value => { value.files[0].bytes++ },
    value => { value.files[0].sha256 = '0'.repeat(64) },
  ]) assert.throws(() => verifyPackage(changedSnapshot(change)))
})

test('snapshot duplicates and unsafe or derived paths fail even with a matching snapshot hash', () => {
  assert.throws(() => verifyPackage(changedSnapshot(value => value.files.push(value.files[0]))), /Duplicate source/u)
  for (const path of ['../outside', '/absolute', 'lib/index.js', 'package.json', 'SOURCE-SNAPSHOT.json', 'src/a\\b']) {
    assert.throws(() => verifyPackage(changedSnapshot(value => { value.files[0].path = path })), /Invalid source snapshot/u, path)
  }
})

test('archive rejects traversal, absolute, drive and ambiguous paths', () => {
  for (const name of ['package/../outside', '/absolute', 'package/C:/file', 'package/src\\escape', 'other/src/index.ts', 'package/src/file.']) {
    assert.throws(() => readPackageArchive(archive([...fixture().entries, { name, body: 'unsafe' }])), /Unsafe/u, name)
  }
})

test('archive rejects duplicate paths including Windows case aliases and links', () => {
  const entries = fixture().entries
  for (const name of ['package/src/index.ts', 'package/SRC/INDEX.TS']) {
    assert.throws(() => readPackageArchive(archive([...entries, { name, body: 'duplicate' }])), /Duplicate package/u)
  }
  for (const type of ['1', '2']) {
    assert.throws(() => readPackageArchive(archive([...entries, { name: 'package/src/link', type, options: { linkname: '../outside' } }])), /links are forbidden/u)
  }
})

test('npm PAX long and Unicode paths preserve exact source bytes', () => {
  const path = 'src/' + 'long-directory/'.repeat(12) + '路线.ts'
  const value = fixture({ [path]: 'export const path = "路线"\n' })
  const target = value.entries.findIndex(entry => entry.name === `package/${path}`)
  const entry = value.entries[target]
  value.entries.splice(target, 1,
    { name: 'PaxHeader/long', type: 'x', body: pax('path', entry.name) },
    { ...entry, name: 'package/long-name-placeholder' })
  const buffer = archive(value.entries)
  assert.equal(verifyPackage(buffer).sourceFileCount, 8)
  assert.equal(readPackageArchive(buffer).get(path).toString(), 'export const path = "路线"\n')
})

test('PAX metadata cannot bypass path, duplicate and link safety', () => {
  for (const path of ['package/../../outside', '/absolute', 'package/src/index.ts']) {
    const entries = [...fixture().entries,
      { name: 'PaxHeader/extra', type: 'x', body: pax('path', path) },
      { name: 'package/placeholder', body: 'extra' }]
    assert.throws(() => readPackageArchive(archive(entries)), /Unsafe|Duplicate/u)
  }
  assert.throws(() => readPackageArchive(archive([
    { name: 'PaxHeader/link', type: 'x', body: pax('linkpath', '../outside') },
    { name: 'package/placeholder', body: 'extra' },
  ])), /PAX links/u)
  assert.throws(() => readPackageArchive(archive([
    { name: 'PaxHeader/bad', type: 'x', body: '999 path=package/placeholder\n' },
    { name: 'package/placeholder', body: 'extra' },
  ])), /PAX record size/u)
})

test('header checksum, declared size, padding and complete end markers are required', () => {
  const body = Buffer.from('payload')
  const damaged = header('package/file', body)
  damaged[0] ^= 1
  assert.throws(() => readPackageArchive(archive([{ name: 'ignored', body, header: damaged }])), /checksum/u)
  const huge = header('package/file', Buffer.alloc(0), '0', { size: 100 * 1024 * 1024 + 1 })
  assert.throws(() => readPackageArchive(archive([{ name: 'ignored', header: huge }])), /archive limit/u)
  const incomplete = gzipSync(Buffer.concat([header('package/file', body), body]))
  assert.throws(() => readPackageArchive(incomplete), /Truncated/u)
  const badPadding = Buffer.concat([header('package/file', body), body, Buffer.alloc(512 - body.length, 1), Buffer.alloc(1024)])
  assert.throws(() => readPackageArchive(gzipSync(badPadding)), /padding/u)
  const noEnd = gzipSync(Buffer.concat([header('package/file', body), body, Buffer.alloc(512 - body.length)]))
  assert.throws(() => readPackageArchive(noEnd), /end marker/u)
})

test('CLI emits one result JSON and exits nonzero for a tampered payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'track-release-verify-'))
  try {
    const target = join(dir, 'track.tgz')
    writeFileSync(target, archive(fixture().entries))
    const cli = fileURLToPath(new URL('./verify-package.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [cli, target], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).version, '0.1.3')
    writeFileSync(target, changedManifest(value => { value.name = 'tampered' }))
    const rejected = spawnSync(process.execPath, [cli, target], { encoding: 'utf8' })
    assert.equal(rejected.status, 1)
    assert.equal(rejected.stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
