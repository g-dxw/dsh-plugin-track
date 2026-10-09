# Third-party notices

This document accompanies the Track plugin source and compiled bundles. Third-party components keep their original copyright and license notices. The files below contain the complete license texts copied from the exact installed npm versions; MapLibre's complete LICENSE.txt includes its additional third-party notices. Machine-readable source URLs and SHA-256 hashes are in [licenses/manifest.json](licenses/manifest.json).

Evidence checked: 2026-10-08. This is a license-text and provenance inventory. The completed GeoMotion distribution confirmation is recorded below.

## Bundled npm components

| Component | Installed version | Declared license | Copyright and license text | Source |
| --- | --- | --- | --- | --- |
| maplibre-gl | 5.24.0 | BSD-3-Clause | [Full text](licenses/maplibre-gl-5.24.0-LICENSE.txt) | [Exact source tarball](https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-5.24.0.tgz) |
| three | 0.185.1 | MIT | [Full text](licenses/three-0.185.1-LICENSE) | [Exact source tarball](https://registry.npmjs.org/three/-/three-0.185.1.tgz) |
| chart.js | 4.5.1 | MIT | [Full text](licenses/chart.js-4.5.1-LICENSE.md) | [Exact source tarball](https://registry.npmjs.org/chart.js/-/chart.js-4.5.1.tgz) |
| chartjs-plugin-zoom | 2.2.0 | MIT | [Full text](licenses/chartjs-plugin-zoom-2.2.0-LICENSE.md) | [Exact source tarball](https://registry.npmjs.org/chartjs-plugin-zoom/-/chartjs-plugin-zoom-2.2.0.tgz) |
| chartjs-plugin-crosshair | 2.0.0 | MIT | [Full text](licenses/chartjs-plugin-crosshair-2.0.0-LICENSE.md) | [Exact source tarball](https://registry.npmjs.org/chartjs-plugin-crosshair/-/chartjs-plugin-crosshair-2.0.0.tgz) |
| @panzoom/panzoom | 4.6.2 | MIT | [Full text](licenses/panzoom-panzoom-4.6.2-MIT-License.txt) | [Exact source tarball](https://registry.npmjs.org/@panzoom/panzoom/-/panzoom-4.6.2.tgz) |
| immer | 10.1.1 | MIT | [Full text](licenses/immer-10.1.1-LICENSE) | [Exact source tarball](https://registry.npmjs.org/immer/-/immer-10.1.1.tgz) |
| mediabunny | 1.24.2 | MPL-2.0 | [Full text](licenses/mediabunny-1.24.2-LICENSE) | [Exact source tarball](https://registry.npmjs.org/mediabunny/-/mediabunny-1.24.2.tgz) |
| @kurkle/color | 0.3.4 | MIT | [Full text](licenses/kurkle-color-0.3.4-LICENSE.md) | [Exact source tarball](https://registry.npmjs.org/@kurkle/color/-/color-0.3.4.tgz) |
| hammerjs | 2.0.8 | MIT | [Full text](licenses/hammerjs-2.0.8-LICENSE.md) | [Exact source tarball](https://registry.npmjs.org/hammerjs/-/hammerjs-2.0.8.tgz) |

The installed production dependency graph also includes sharp and host-supplied peer dependencies. They are not claimed by this table to be bundled in the browser artifact; their independently distributed npm packages carry their own notices. This inventory covers the ten npm components requested for the Track bundle.

## Mediabunny source availability

Mediabunny 1.24.2 is used under MPL-2.0. Its complete license is included above. The exact source form published for this version is available from [the official npm source tarball](https://registry.npmjs.org/mediabunny/-/mediabunny-1.24.2.tgz). The tarball includes the package's source; its official integrity value is recorded in the manifest. This notice does not relicense Mediabunny under Track's AGPL.

## Vendored toGeoJSON: BSD upstream and fixed fork

The JavaScript body in src/track/vendor/toGeoJSON.ts, after removing Track's comment header and normalizing CRLF to LF, matches [the fixed VoyageTrack file](https://github.com/g-dxw/VoyageTrack/blob/4a4d8f49711868d7b96917322cb05bdd6333428c/web/src/lib/vendor/toGeoJSON/toGeoJSON.js) at commit 4a4d8f49711868d7b96917322cb05bdd6333428c exactly (SHA-256 db0f9daade474f68156f7d82dad4b30c01b681823e86afdfc89b9ba437c3845d). Track only adds its comment header and changes the extension to .ts; the fork runtime body is unchanged.

The upstream togeojson code is BSD-2-Clause. The complete copyright notice and license text from [the fixed official upstream commit](https://github.com/placemark/togeojson/blob/71b38c6ffaf016b2040225004b3a7ab122d2ed2a/LICENSE) are retained in [this license file](licenses/togeojson-upstream-BSD-2-Clause-LICENSE.txt). The previous ISC attribution has been corrected.

Source comparison uses the official @tmcw/togeojson 5.8.1 npm artifact and commit 71b38c6ffaf016b2040225004b3a7ab122d2ed2a as a baseline: 57 of 62 top-level functions are structurally identical; three differ only in optional-chain compilation. The fork modifies TCX coordPair to append elevation placeholders and time values, and KML gxCoords to append times, omit invalid short coordinates, and emit a two-point LineString. Full comparison details, official source URLs, and artifact integrity are recorded in [the evidence file](licenses/togeojson-evidence.json).

Status: **verified-upstream-derived-fork**. The fork contains modifications, so it is not described as an unmodified exact npm release. This BSD notice preserves the upstream component's rights and does not replace the project license applicable to VoyageTrack/Track modifications.

## GeoMotion: source and distribution confirmation

Source: [https://github.com/databandar/geomotion](https://github.com/databandar/geomotion), pinned commit [a911219b1f0d704aa10f1fc915df65c21f612ec1](https://github.com/databandar/geomotion/tree/a911219b1f0d704aa10f1fc915df65c21f612ec1).

The original source notice remains in [SOURCE.md](src/track/vendor/geomotion/SOURCE.md), with individual upstream and adjusted file hashes in [source-manifest.json](src/track/vendor/geomotion/source-manifest.json). Distribution status: **distribution-permission-confirmed**. Routine releases of this pinned snapshot reuse the confirmation recorded on 2026-10-08.

Distribution permission for this pinned snapshot is recorded as confirmed by the publisher on 2026-10-08. The completed record is in [geomotion-distribution-record.md](docs/releases/geomotion-distribution-record.md). Copyright remains with the upstream authors; the original license record is retained in SOURCE.md.

## Wanderer-derived code and Track

The AGPL-3.0-only full text is already provided by [LICENSE](LICENSE) and src/track/LICENSE. See [PROVENANCE.md](PROVENANCE.md) for the fixed Wanderer/VoyageTrack source and Track modifications. These texts are not duplicated here. Third-party components retain the original notices linked above.
