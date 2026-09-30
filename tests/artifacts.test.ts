/**
 * The store, on a real filesystem.
 *
 * Nothing here is mocked: the whole point of these tests is what actually lands
 * on disk and what happens when something else has been writing there too. The
 * `DSH_HOME` override is the same seam the desktop host uses, so pointing it at
 * a temp directory exercises the production path rather than a stand-in.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listTracks, readSource, readTrack, removeTrack, trackDir, tracksRoot, writeTrack,
} from '../src/artifacts.ts'
import type { TrackMetrics, TrackPoint } from '../src/protocol.ts'

const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})})

/** A temp `$DSH_HOME`, standing in for the user's real one. */
function home(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'cqai-track-'))
  roots.push(root)
  return {DSH_HOME: root}
}

const METRICS: TrackMetrics = {
  distance: 1925.9526243125622,
  elevationGain: 20,
  elevationLoss: 10,
  duration: 1_200_000,
  elevationMax: 120,
  elevationMin: 100,
  bbox: [120, 30, 120.02, 30],
}

const POINTS: TrackPoint[] = [
  [120, 30, 100, Date.parse('2026-09-20T01:00:00Z')],
  [120.01, 30, 120, Date.parse('2026-09-20T01:10:00Z')],
  [120.02, 30, 110, Date.parse('2026-09-20T01:20:00Z')],
]

const SOURCE = '<?xml version="1.0"?><gpx><trk><name>晨跑</name></trk></gpx>'

function import_(env: NodeJS.ProcessEnv, overrides: Partial<Parameters<typeof writeTrack>[0]> = {}) {
  return writeTrack({filename: 'morning.gpx', source: SOURCE, points: POINTS, metrics: METRICS, ...overrides}, env)
}

describe('an empty store', () => {
  it('lists nothing, and that is not an error', () => {
    // The first run of the plugin has no `track/` directory at all.
    expect(listTracks(home())).toEqual([])
  })

  it('does not find a track that was never written', () => {
    const env = home()
    expect(readTrack('missing', env)).toBeNull()
    expect(readSource('missing', env)).toBeNull()
    expect(removeTrack('missing', env)).toBe(false)
  })
})

describe('importing a track', () => {
  it('lands under <DSH home>/track/<id>/ with both files', () => {
    const env = home()
    const written = import_(env)
    expect(trackDir(written.id, env)).toContain(join(tracksRoot(env), written.id))
    const json = JSON.parse(readFileSync(join(trackDir(written.id, env), 'track.json'), 'utf8')) as {coordinates: TrackPoint[]}
    expect(json.coordinates).toEqual(POINTS)
    // The original file is kept byte for byte, which is what makes "export the
    // original" a download rather than a re-serialisation.
    expect(readFileSync(join(trackDir(written.id, env), 'source.gpx'), 'utf8')).toBe(SOURCE)
  })

  it('names the track from the parser, and falls back to the filename', () => {
    const env = home()
    expect(import_(env, {name: '测试环线'}).name).toBe('测试环线')
    expect(import_(env, {name: '   '}).name).toBe('morning')
    expect(import_(env, {name: undefined}).name).toBe('morning')
  })

  it('reads the extension case-insensitively and stores it lowercase', () => {
    const env = home()
    const written = import_(env, {filename: 'RIDE.TCX'})
    expect(written.format).toBe('tcx')
    expect(readFileSync(join(trackDir(written.id, env), 'source.tcx'), 'utf8')).toBe(SOURCE)
  })

  it('counts the stored bytes in UTF-8, like the upload cap does', () => {
    const env = home()
    const written = import_(env, {source: '轨'})
    expect(written.bytes).toBe(3)
  })

  it('gives two imports in the same millisecond their own directories', () => {
    // The id is the import timestamp; two files dropped together would otherwise
    // overwrite each other, and the second import would appear to do nothing.
    const env = home()
    const first = import_(env)
    const second = import_(env, {filename: 'evening.gpx'})
    expect(second.id).not.toBe(first.id)
    expect(listTracks(env)).toHaveLength(2)
    expect(readSource(first.id, env)!.body.toString('utf8')).toBe(SOURCE)
  })
})

describe('listing', () => {
  it('returns metadata without the point arrays', () => {
    const env = home()
    import_(env)
    const [summary] = listTracks(env)
    expect(summary).not.toHaveProperty('coordinates')
    expect(summary).toMatchObject({name: 'morning', filename: 'morning.gpx', format: 'gpx', points: 3})
    expect(summary.metrics.distance).toBeCloseTo(METRICS.distance, 6)
  })

  it('orders newest first, so the last import is at the top', () => {
    const env = home()
    const older = import_(env, {filename: 'older.gpx'})
    const newer = import_(env, {filename: 'newer.gpx'})
    // Same-millisecond imports make the sort a coin toss, so the timestamps are
    // forced apart on disk rather than assumed.
    const patch = (id: string, createdAt: string) => {
      const file = join(trackDir(id, env), 'track.json')
      const held = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      writeFileSync(file, JSON.stringify({...held, createdAt}))
    }
    patch(older.id, '2026-09-20T01:00:00.000Z')
    patch(newer.id, '2026-09-21T01:00:00.000Z')
    expect(listTracks(env).map(track => track.filename)).toEqual(['newer.gpx', 'older.gpx'])
  })

  it('skips a directory that is not a readable track instead of failing the list', () => {
    // What a half-finished write, or a hand-placed directory, looks like.
    const env = home()
    const good = import_(env)
    const dir = tracksRoot(env)
    mkdirSync(join(dir, 'not-a-track'), {recursive: true})
    mkdirSync(join(dir, 'no-coordinates'), {recursive: true})
    writeFileSync(join(dir, 'no-coordinates', 'track.json'), JSON.stringify({id: 'no-coordinates', filename: 'x.gpx'}))
    mkdirSync(join(dir, 'invalid-json'), {recursive: true})
    writeFileSync(join(dir, 'invalid-json', 'track.json'), '{ this is not json')
    writeFileSync(join(dir, 'a-file-not-a-dir'), 'x')
    expect(listTracks(env).map(track => track.id)).toEqual([good.id])
  })

  it('serves a track whose directory exists but whose source file was deleted', () => {
    // Losing the original is not a reason to lose the parsed path.
    const env = home()
    const written = import_(env)
    rmSync(join(trackDir(written.id, env), 'source.gpx'))
    expect(readTrack(written.id, env)!.coordinates).toEqual(POINTS)
    expect(readSource(written.id, env)).toBeNull()
  })
})

describe('reading one track back', () => {
  it('returns the points and the summary together', () => {
    const env = home()
    const written = import_(env)
    const track = readTrack(written.id, env)!
    expect(track.coordinates).toEqual(POINTS)
    expect(track.points).toBe(3)
    expect(track).not.toHaveProperty('metrics.coordinates')
  })

  it('hands the original file back as bytes, under the format it came in as', () => {
    const env = home()
    const written = import_(env)
    const source = readSource(written.id, env)!
    expect(Buffer.isBuffer(source.body)).toBe(true)
    expect(source.ext).toBe('gpx')
    expect(source.body.toString('utf8')).toBe(SOURCE)
  })

  it('guesses across every extension when the stored format is unreadable', () => {
    // A hand-copied directory with no format field still yields its source file.
    const env = home()
    const dir = join(tracksRoot(env), 'hand-made')
    mkdirSync(dir, {recursive: true})
    writeFileSync(join(dir, 'track.json'), JSON.stringify({id: 'hand-made', filename: 'x.kml', coordinates: POINTS}))
    writeFileSync(join(dir, 'source.kml'), '<kml/>')
    expect(readSource('hand-made', env)).toEqual({body: Buffer.from('<kml/>'), ext: 'kml'})
  })

  it('never reads outside the store, whatever the id says', () => {
    // Ids come from us, but the endpoint takes one from the query string, so the
    // join has to be survivable even if something upstream forgets that. The bait
    // is a *readable* track one level above the store: without the id guard the
    // join would escape `track/` and find it, so this passes only if the guard is
    // really there and not merely a path that happens to be empty.
    const env = home()
    const outside = join(env.DSH_HOME!, 'outside')
    mkdirSync(outside, {recursive: true})
    writeFileSync(join(outside, 'track.json'), JSON.stringify({id: 'outside', filename: 'x.gpx', coordinates: POINTS}))
    writeFileSync(join(outside, 'source.gpx'), SOURCE)

    expect(readTrack('../outside', env)).toBeNull()
    expect(readSource('../outside', env)).toBeNull()
    expect(removeTrack('../outside', env)).toBe(false)
    // And the directory it would have reached is still standing.
    expect(existsSync(join(outside, 'track.json'))).toBe(true)

    // The shape the HTTP layer actually hands over.
    expect(readTrack('../../../../someone/.dsh/track/2026-09-22T10-30-00-000Z', env)).toBeNull()
  })
})

describe('deleting', () => {
  it('takes the whole directory, source file included', () => {
    const env = home()
    const written = import_(env)
    expect(removeTrack(written.id, env)).toBe(true)
    expect(listTracks(env)).toEqual([])
    // The second delete is a no-op, not a crash — the panel may ask twice.
    expect(removeTrack(written.id, env)).toBe(false)
  })
})
