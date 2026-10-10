import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const packages = [
  ['maplibre-gl', '5.24.0', 'LICENSE.txt'],
  ['three', '0.185.1', 'LICENSE'],
  ['chart.js', '4.5.1', 'LICENSE.md'],
  ['chartjs-plugin-zoom', '2.2.0', 'LICENSE.md'],
  ['chartjs-plugin-crosshair', '2.0.0', 'LICENSE.md'],
  ['@panzoom/panzoom', '4.6.2', 'MIT-License.txt'],
  ['immer', '10.1.1', 'LICENSE'],
  ['mediabunny', '1.24.2', 'LICENSE'],
  ['@kurkle/color', '0.3.4', 'LICENSE.md'],
  ['hammerjs', '2.0.8', 'LICENSE.md'],
];

mkdirSync(join(root, 'licenses'), { recursive: true });
const registry = json(join(root, 'licenses/npm-registry-metadata.json'));
const records = packages.map(([name, expectedVersion, filename]) => {
  const packageRoot = join(root, 'node_modules', name);
  const manifestPath = join(packageRoot, 'package.json');
  const pkg = json(manifestPath);
  if (pkg.name !== name || pkg.version !== expectedVersion) {
    throw new Error(`Expected ${name}@${expectedVersion}; found ${pkg.name}@${pkg.version}. Review license inputs before changing versions.`);
  }
  const upstream = registry.packages.find((item) => item.name === name && item.version === pkg.version);
  if (!upstream || upstream.license !== pkg.license) {
    throw new Error(`Registry evidence missing or license differs for ${name}@${pkg.version}.`);
  }
  const sourcePath = join(packageRoot, filename);
  const destination = `licenses/${name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}-${filename}`;
  const sourceBytes = readFileSync(sourcePath);
  copyFileSync(sourcePath, join(root, destination));
  if (!sourceBytes.equals(readFileSync(join(root, destination)))) {
    throw new Error(`License copy differs for ${name}.`);
  }
  return {
    name,
    version: pkg.version,
    license: pkg.license,
    licenseFile: destination,
    licenseSourcePath: `node_modules/${name}/${filename}`,
    licenseSha256: sha256(sourceBytes),
    packageJsonSha256: sha256(readFileSync(manifestPath)),
    repositoryUrl: upstream.repositoryUrl,
    npmVersionUrl: upstream.metadataUrl,
    sourceTarballUrl: upstream.sourceTarballUrl,
    sourceTarballIntegrity: upstream.sourceTarballIntegrity,
    ...(upstream.gitHead ? { gitHead: upstream.gitHead } : {}),
    status: 'license-text-copied',
  };
});

const toGeoJsonSource = 'src/track/vendor/toGeoJSON.ts';
const toGeoJsonBytes = readFileSync(join(root, toGeoJsonSource));
const body = toGeoJsonBytes.toString('utf8').replaceAll('\r\n', '\n').replace(/^[\s\S]*?(?=function \$\(element, tagName\))/, '');
const forkBodySha256 = 'db0f9daade474f68156f7d82dad4b30c01b681823e86afdfc89b9ba437c3845d';
if (sha256(body) !== forkBodySha256) {
  throw new Error('toGeoJSON source body differs from the verified fixed fork. Review source/license evidence.');
}
const toGeoJsonLicenseFile = 'licenses/togeojson-upstream-BSD-2-Clause-LICENSE.txt';
const toGeoJsonLicenseBytes = readFileSync(join(root, toGeoJsonLicenseFile));
const toGeoJsonEvidenceFile = 'licenses/togeojson-evidence.json';
const toGeoJsonEvidenceBytes = readFileSync(join(root, toGeoJsonEvidenceFile));
const toGeoJsonEvidence = JSON.parse(toGeoJsonEvidenceBytes.toString('utf8'));
const toGeoJsonLicenseGitBlobSha = createHash('sha1')
  .update(Buffer.from(`blob ${toGeoJsonLicenseBytes.length}\0`))
  .update(toGeoJsonLicenseBytes)
  .digest('hex');
if (toGeoJsonLicenseGitBlobSha !== 'c2c7dd68537f20ec6655164081e7f69f0abbe7b6') {
  throw new Error('toGeoJSON reference license differs from the verified official Git blob.');
}
if (toGeoJsonEvidence.registryVersions.some((item) => item.license !== 'BSD-2-Clause')) {
  throw new Error('toGeoJSON registry license evidence has changed; review the attribution.');
}
if (toGeoJsonEvidence.status !== 'verified-upstream-derived-fork' ||
    toGeoJsonEvidence.forkSourceSha256 !== forkBodySha256 ||
    toGeoJsonEvidence.upstreamComparison?.licenseSha256 !== sha256(toGeoJsonLicenseBytes)) {
  throw new Error('toGeoJSON verified source/license evidence is missing or inconsistent.');
}
const toGeoJson = {
  name: '@tmcw/togeojson (vendored fork)',
  version: null,
  sourcePath: toGeoJsonSource,
  sourceSha256: sha256(toGeoJsonBytes),
  normalizedBodySha256: forkBodySha256,
  forkRepositoryUrl: 'https://github.com/g-dxw/VoyageTrack',
  forkCommit: '4a4d8f49711868d7b96917322cb05bdd6333428c',
  forkSourceUrl: 'https://github.com/g-dxw/VoyageTrack/blob/4a4d8f49711868d7b96917322cb05bdd6333428c/web/src/lib/vendor/toGeoJSON/toGeoJSON.js',
  forkGitBlobSha: '70028aabb68e2291431ef08411796ee9b2dc873c',
  upstreamRepositoryUrl: 'https://github.com/placemark/togeojson',
  upstreamRepositoryFormerUrl: 'https://github.com/tmcw/togeojson',
  upstreamLicense: 'BSD-2-Clause',
  licenseFile: toGeoJsonLicenseFile,
  licenseSha256: sha256(toGeoJsonLicenseBytes),
  licenseSourceUrl: 'https://github.com/placemark/togeojson/blob/71b38c6ffaf016b2040225004b3a7ab122d2ed2a/LICENSE',
  licenseSourceCommit: '71b38c6ffaf016b2040225004b3a7ab122d2ed2a',
  licenseSourceGitBlobSha: 'c2c7dd68537f20ec6655164081e7f69f0abbe7b6',
  evidenceFile: toGeoJsonEvidenceFile,
  evidenceSha256: sha256(toGeoJsonEvidenceBytes),
  status: 'verified-upstream-derived-fork',
  upstreamComparison: toGeoJsonEvidence.upstreamComparison,
  note: 'The local normalized JavaScript body matches the fixed fork exactly. Its upstream code is verified as BSD-2-Clause by comparison with the official 5.8.1 source and npm artifact; the complete upstream notice is retained. The edited fork has two coordinate changes plus compiler formatting differences, so no unmodified exact npm version is claimed. Track has not changed the fork runtime body.',
};

const geoMotionPath = 'src/track/vendor/geomotion/source-manifest.json';
const geoMotionSourcePath = 'src/track/vendor/geomotion/SOURCE.md';
const geoMotion = json(join(root, geoMotionPath));
const vendored = {
  name: 'GeoMotion',
  version: geoMotion.commit,
  repositoryUrl: geoMotion.repository,
  sourceCommitUrl: `${geoMotion.repository}/tree/${geoMotion.commit}`,
  sourceManifestPath: geoMotionPath,
  sourceManifestSha256: sha256(readFileSync(join(root, geoMotionPath))),
  sourceNoticePath: geoMotionSourcePath,
  sourceNoticeSha256: sha256(readFileSync(join(root, geoMotionSourcePath))),
  license: null,
  status: 'distribution-permission-confirmed',
  upstreamLicenseStatus: 'undeclared',
  distributionConfirmedOn: '2026-10-08',
  distributionBasis: 'Publisher confirmed permission obtained and explicitly requested npm publication on 2026-10-08. Routine releases of this pinned snapshot reuse that confirmation.',
  note: 'Distribution permission for this pinned snapshot is recorded as confirmed by the publisher on 2026-10-08. The completed record is in [geomotion-distribution-record.md](docs/releases/geomotion-distribution-record.md). Copyright remains with the upstream authors; the original license record is retained in SOURCE.md.',
};
const firstPartyLicense = {
  project: 'Track / Wanderer-derived code',
  license: 'AGPL-3.0-only',
  files: ['LICENSE', 'src/track/LICENSE'].filter((path) => existsSync(join(root, path))).map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
  provenancePath: 'PROVENANCE.md',
  upstreamSourceUrl: 'https://github.com/g-dxw/VoyageTrack/tree/4a4d8f49711868d7b96917322cb05bdd6333428c',
};
const evidence = {
  schemaVersion: 1,
  evidenceDate: registry.evidenceDate,
  collection: 'License files copied byte-for-byte from the installed versions in node_modules. Public official npm metadata supplies source tarball URLs and integrity values; no npm credentials are used.',
  packages: records,
  vendored: [toGeoJson, vendored],
  trackLicense: firstPartyLicense,
};
writeFileSync(join(root, 'licenses/manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const rows = records.map((item) => `| ${item.name} | ${item.version} | ${item.license} | [Full text](${item.licenseFile}) | [Exact source tarball](${item.sourceTarballUrl}) |`).join('\n');
const contents = `# Third-party notices\n\nThis document accompanies the Track plugin source and compiled bundles. Third-party components keep their original copyright and license notices. The files below contain the complete license texts copied from the exact installed npm versions; MapLibre's complete LICENSE.txt includes its additional third-party notices. Machine-readable source URLs and SHA-256 hashes are in [licenses/manifest.json](licenses/manifest.json).\n\nEvidence checked: ${registry.evidenceDate}. This is a license-text and provenance inventory. The completed GeoMotion distribution confirmation is recorded below.\n\n## Bundled npm components\n\n| Component | Installed version | Declared license | Copyright and license text | Source |\n| --- | --- | --- | --- | --- |\n${rows}\n\nThe installed production dependency graph also includes sharp and host-supplied peer dependencies. They are not claimed by this table to be bundled in the browser artifact; their independently distributed npm packages carry their own notices. This inventory covers the ten npm components requested for the Track bundle.\n\n## Mediabunny source availability\n\nMediabunny ${records.find((item) => item.name === 'mediabunny').version} is used under MPL-2.0. Its complete license is included above. The exact source form published for this version is available from [the official npm source tarball](https://registry.npmjs.org/mediabunny/-/mediabunny-1.24.2.tgz). The tarball includes the package's source; its official integrity value is recorded in the manifest. This notice does not relicense Mediabunny under Track's AGPL.\n\n## Vendored toGeoJSON: BSD upstream and fixed fork\n\nThe JavaScript body in src/track/vendor/toGeoJSON.ts, after removing Track's comment header and normalizing CRLF to LF, matches [the fixed VoyageTrack file](${toGeoJson.forkSourceUrl}) at commit ${toGeoJson.forkCommit} exactly (SHA-256 ${forkBodySha256}). Track only adds its comment header and changes the extension to .ts; the fork runtime body is unchanged.\n\nThe upstream togeojson code is BSD-2-Clause. The complete copyright notice and license text from [the fixed official upstream commit](${toGeoJson.licenseSourceUrl}) are retained in [this license file](${toGeoJsonLicenseFile}). The previous ISC attribution has been corrected.\n\nSource comparison uses the official @tmcw/togeojson 5.8.1 npm artifact and commit 71b38c6ffaf016b2040225004b3a7ab122d2ed2a as a baseline: 57 of 62 top-level functions are structurally identical; three differ only in optional-chain compilation. The fork modifies TCX coordPair to append elevation placeholders and time values, and KML gxCoords to append times, omit invalid short coordinates, and emit a two-point LineString. Full comparison details, official source URLs, and artifact integrity are recorded in [the evidence file](${toGeoJsonEvidenceFile}).\n\nStatus: **verified-upstream-derived-fork**. The fork contains modifications, so it is not described as an unmodified exact npm release. This BSD notice preserves the upstream component's rights and does not replace the project license applicable to VoyageTrack/Track modifications.\n\n## GeoMotion: source and distribution confirmation\n\nSource: [${vendored.repositoryUrl}](${vendored.repositoryUrl}), pinned commit [${vendored.version}](${vendored.sourceCommitUrl}).\n\nThe original source notice remains in [SOURCE.md](${geoMotionSourcePath}), with individual upstream and adjusted file hashes in [source-manifest.json](${geoMotionPath}). Distribution status: **distribution-permission-confirmed**. Routine releases of this pinned snapshot reuse the confirmation recorded on 2026-10-08.\n\n${vendored.note}\n\n## Wanderer-derived code and Track\n\nThe AGPL-3.0-only full text is already provided by [LICENSE](LICENSE) and src/track/LICENSE. See [PROVENANCE.md](PROVENANCE.md) for the fixed Wanderer/VoyageTrack source and Track modifications. These texts are not duplicated here. Third-party components retain the original notices linked above.\n`;
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), contents);
console.log(`Copied and verified ${records.length} complete npm license texts; generated THIRD_PARTY_NOTICES.md and licenses/manifest.json. GeoMotion distribution confirmation is retained; toGeoJSON upstream-derived fork attribution is verified.`);
