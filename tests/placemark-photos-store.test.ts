import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readSource, removeTrack, trackDir, writeTrack } from '../src/artifacts.ts'
import { PlacemarkPhotoError, readPlacemarkPhoto, writePlacemarkPhoto } from '../src/placemark-photos-store.ts'
import { readPlacemarkState, writePlacemarkState } from '../src/placemark-state-store.ts'
import { imageLink } from '../src/track/placemarks.ts'
import { groupCoverPhoto, validatePlacemarkGroups } from '../src/track/placemark-groups.ts'
import { PLACEMARK_PHOTO_MAX_BYTES, localPlacemarkPhoto, placemarkPhotoUrl } from '../src/track/placemark-photos.ts'
import type { TrackInput } from '../src/protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-placemark-photos-store-')) throw new Error('Unexpected photo fixture')
    rmSync(root, {recursive: true, force: true})
  }
})
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mk0iIiIiIgBoSygABc6zbAAA', 'base64')
const AVIF = Buffer.alloc(24); AVIF.writeUInt32BE(24); AVIF.write('ftyp', 4); AVIF.write('mif1', 8); AVIF.write('mif1', 16); AVIF.write('avif', 20)
const input: TrackInput = {filename: 'unchanged.kml', source: '<kml>original bytes</kml>', points: [[120, 30, 100, null], [120.01, 30, 110, null]],
  placemarks: [{id: 'kml-1', name: '起点', description: '', coordinates: [120, 30], images: []}],
  metrics: {distance: 1000, elevationGain: 10, elevationLoss: 0, duration: 0, elevationMax: 110, elevationMin: 100, bbox: [120, 30, 120.01, 30]}}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cqai-placemark-photos-store-')); roots.push(home)
  const env = {DSH_HOME: home}, {id} = writeTrack(input, env), dir = trackDir(id, env)
  return {env, id, dir, photoDir: join(dir, 'placemark-photos')}
}
function errorStatus(run: () => unknown, status: number) {
  try {run(); throw new Error('Expected photo rejection')} catch (error) {expect(error).toBeInstanceOf(PlacemarkPhotoError); expect((error as PlacemarkPhotoError).status).toBe(status)}
}

describe('owned placemark photos', () => {
  it('sniffs all supported image headers and uses only generated SHA-256 names', () => {
    const {env, id, photoDir} = fixture()
    for (const [body, extension, mime] of [[JPEG, 'jpg', 'image/jpeg'], [PNG, 'png', 'image/png'], [WEBP, 'webp', 'image/webp'], [GIF, 'gif', 'image/gif'], [AVIF, 'avif', 'image/avif']] as const) {
      const filename = createHash('sha256').update(body).digest('hex') + '.' + extension
      const {url} = writePlacemarkPhoto(id, body, mime, env)
      expect(url).toBe(placemarkPhotoUrl(id, filename))
      expect(readPlacemarkPhoto(id, filename, env)).toEqual({body, filename, mime})
      expect(readFileSync(join(photoDir, filename))).toEqual(body)
    }
    expect(readdirSync(photoDir)).toHaveLength(5)
    expect(readdirSync(photoDir).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  it('rejects empty, oversized, non-image, SVG, truncated and mislabeled data before writing files', () => {
    const {env, id, photoDir} = fixture()
    errorStatus(() => writePlacemarkPhoto(id, Buffer.alloc(0), undefined, env), 400)
    errorStatus(() => writePlacemarkPhoto(id, Buffer.alloc(PLACEMARK_PHOTO_MAX_BYTES + 1), undefined, env), 413)
    for (const body of [Buffer.from('hello'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), PNG.subarray(0, 12), Buffer.from('GIF89a'), Buffer.from('RIFFfakeWEBP')]) errorStatus(() => writePlacemarkPhoto(id, body, undefined, env), 415)
    for (const mime of ['image/jpeg', 'image/svg+xml', 'text/html', 'image/jpg']) errorStatus(() => writePlacemarkPhoto(id, PNG, mime, env), 415)
    const falseHeader = Buffer.from(GIF); falseHeader[0] |= 128
    errorStatus(() => writePlacemarkPhoto(id, falseHeader, undefined, env), 415)
    expect(existsSync(photoDir)).toBe(false)
    expect(writePlacemarkPhoto(id, PNG, 'application/octet-stream', env)).toEqual(writePlacemarkPhoto(id, PNG, undefined, env))
    expect(writePlacemarkPhoto(id, PNG, 'IMAGE/PNG; charset=binary', env).url).toContain('.png')
  })
  it('deduplicates without rewriting bytes and never changes the imported track or source', () => {
    const {env, id, dir, photoDir} = fixture(), track = readFileSync(join(dir, 'track.json')), source = readSource(id, env)!.body
    const bytes = Buffer.from(PNG), first = writePlacemarkPhoto(id, bytes, 'image/png', env), filename = localPlacemarkPhoto(first.url)!.filename
    const modified = statSync(join(photoDir, filename)).mtimeMs
    bytes.fill(0)
    expect(readPlacemarkPhoto(id, filename, env)!.body).toEqual(PNG)
    expect(writePlacemarkPhoto(id, PNG, undefined, env)).toEqual(first)
    expect(statSync(join(photoDir, filename)).mtimeMs).toBe(modified)
    expect(readdirSync(photoDir)).toEqual([filename])
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readSource(id, env)!.body).toEqual(source)
  })
  it('rejects path traversal and returns no photo for missing tracks, files or corrupt stored bytes', () => {
    const {env, id, photoDir} = fixture(), missing = '0'.repeat(64) + '.png'
    for (const invalid of ['', '../track.json', '..\\source.kml', 'C:\\outside.png', 'a'.repeat(64) + '.svg', 'A'.repeat(64) + '.png']) errorStatus(() => readPlacemarkPhoto(id, invalid, env), 400)
    expect(readPlacemarkPhoto(id, missing, env)).toBeNull()
    for (const invalid of ['missing', '../outside', 'C:\\outside']) {
      expect(readPlacemarkPhoto(invalid, missing, env)).toBeNull()
      errorStatus(() => writePlacemarkPhoto(invalid, PNG, 'image/png', env), 404)
    }
    const {filename} = localPlacemarkPhoto(writePlacemarkPhoto(id, PNG, undefined, env).url)!
    writeFileSync(join(photoDir, filename), 'corrupt')
    expect(readPlacemarkPhoto(id, filename, env)).toBeNull()
    errorStatus(() => writePlacemarkPhoto(id, PNG, undefined, env), 409)
    expect(readFileSync(join(photoDir, filename), 'utf8')).toBe('corrupt')
  })
  it('persists exact local references in state and group covers, retains files for undo, and removes them with the track', () => {
    const {env, id, dir, photoDir} = fixture(), track = readFileSync(join(dir, 'track.json')), source = readSource(id, env)!.body
    const {url} = writePlacemarkPhoto(id, PNG, undefined, env), filename = localPlacemarkPhoto(url)!.filename
    expect(imageLink(url)).toBe(url)
    for (const invalid of [url + '&other=1', url + '#fragment', url + '&id=' + id, url.replace('/placemark-photo?', '/placemark-photo/../source?'), '/api/cqai-track/source?id=' + id, '../' + filename, 'file:///tmp/' + filename, 'data:image/png;base64,aGVsbG8=']) expect(imageLink(invalid)).toBeNull()
    const group = {id: 'group-00000000-0000-0000-0000-000000000001', name: '照片组', description: '', coordinates: [120, 30] as [number, number], memberIds: ['kml-1'], cover: {pointId: 'kml-1', imageUrl: url}}
    expect(validatePlacemarkGroups([group])[0].cover?.imageUrl).toBe(url)
    expect(groupCoverPhoto(group, [{...input.placemarks![0], images: [url]}])?.url).toBe(url)
    const saved = writePlacemarkState(id, 0, {...readPlacemarkState(id, env), edits: [{id: 'kml-1', images: [url]}], groups: [group]}, env)
    expect(readPlacemarkState(id, env)).toEqual(saved)
    const removed = writePlacemarkState(id, saved.revision, {...saved, edits: [], groups: [], deletedIds: ['kml-1']}, env)
    expect(readPlacemarkPhoto(id, filename, env)!.body).toEqual(PNG)
    const restored = writePlacemarkState(id, removed.revision, saved, env)
    expect(restored.edits[0].images).toEqual([url]); expect(restored.groups[0].cover?.imageUrl).toBe(url)
    expect(readFileSync(join(dir, 'track.json'))).toEqual(track); expect(readSource(id, env)!.body).toEqual(source)
    expect(readdirSync(photoDir)).toEqual([filename])
    expect(removeTrack(id, env)).toBe(true); expect(existsSync(dir)).toBe(false); expect(readPlacemarkPhoto(id, filename, env)).toBeNull()
  })
})
