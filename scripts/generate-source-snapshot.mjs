import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, sourcePath, normalizePackResult } from './release-package-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = readJson('package.json');
const baseCommit = git('rev-parse', 'HEAD');
const changed = git('diff', '--name-only', '-z', 'HEAD', '--').split('\0').filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
const generated = new Set(['package.json', 'SOURCE-SNAPSHOT.json', 'build-inputs/yarn.lock']);
const sourceChanges = [...changed.filter((path) => !generated.has(path)), ...untracked];
if (sourceChanges.length) throw new Error('Commit release sources before generating a snapshot: ' + sourceChanges.join(', '));
const committedManifest = JSON.parse(git('show', 'HEAD:package.json'));
const withoutSource = ({ trackSource: _ignored, ...fields }) => fields;
if (JSON.stringify(withoutSource(manifest)) !== JSON.stringify(withoutSource(committedManifest))) {
  throw new Error('Commit package identity and release settings before generating a snapshot.');
}
const lock = readFileSync(resolve(root, 'yarn.lock'));
const packedLock = readFileSync(resolve(root, 'build-inputs/yarn.lock'));
const lf = (bytes) => bytes.toString('utf8').replace(/\r\n/g, '\n');
if (lf(lock) !== lf(packedLock)) throw new Error('build-inputs/yarn.lock does not match the committed root lockfile.');
// Copy actual checkout bytes: Windows and Linux archives can have different text line endings.
writeFileSync(resolve(root, 'build-inputs/yarn.lock'), lock);
const packOutput = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--ignore-scripts', '--json'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
const pack = normalizePackResult(JSON.parse(packOutput));
if (pack.length !== 1 || pack[0].name !== manifest.name || pack[0].version !== manifest.version) {
  throw new Error('npm pack identity does not match package.json.');
}
const paths = pack[0].files.map(({ path }) => path).filter(sourcePath).sort();
if (new Set(paths).size !== paths.length) throw new Error('Duplicate npm source paths.');
const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
const notCommitted = paths.filter((path) => !tracked.has(path));
if (notCommitted.length) throw new Error('npm would include uncommitted source inputs: ' + notCommitted.join(', '));
const files = paths.map((path) => {
  const absolute = resolve(root, path);
  const actual = realpathSync(absolute);
  const within = relative(root, actual);
  if (isAbsolute(within) || within === '..' || within.startsWith('..\\') || within.startsWith('../') || !lstatSync(absolute).isFile()) {
    throw new Error('Source path must be a regular file inside the repository: ' + path);
  }
  const bytes = readFileSync(absolute);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
});
const snapshot = {
  schemaVersion: 1,
  version: manifest.version,
  baseCommit,
  dirty: false,
  sourceMeaning: 'Exact source and build-input bytes packed from the committed release checkout. Generated package metadata, this snapshot and lib outputs are identified by the release archive checksum.',
  files,
};
const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
writeFileSync(resolve(root, 'SOURCE-SNAPSHOT.json'), bytes);
manifest.trackSource = { baseCommit, dirty: false, sourceSnapshotSha256: sha256(bytes) };
writeFileSync(resolve(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ name: manifest.name, version: manifest.version, baseCommit, sourceFileCount: files.length }));
