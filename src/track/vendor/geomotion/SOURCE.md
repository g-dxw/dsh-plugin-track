# GeoMotion engine snapshot

Source: https://github.com/databandar/geomotion

Pinned upstream commit: `a911219b1f0d704aa10f1fc915df65c21f612ec1`.

This snapshot contains the core, document, animation, geometry, evaluator, entities, renderer, and MapLibre adapter source packages. Tests and standalone applications are excluded. Internal package imports have been rewritten to relative imports, so the Track plugin does not require the adjacent GeoMotion checkout. `source-manifest.json` records each original and adjusted file SHA-256.

## Distribution confirmation

Status: **distribution-permission-confirmed**.

On 2026-10-08, the publisher confirmed that permission had been obtained and explicitly requested npm publication. That confirmation was recorded for beta.2 and retained in beta.3. Routine development, builds, and releases of this same pinned snapshot use the existing confirmation. The earlier permission request is closed; the current record is in [geomotion-distribution-record.md](../../../../docs/releases/geomotion-distribution-record.md).

## Original license record

The pinned upstream repository has no declared public license. Written permission terms are not included in this snapshot. These are provenance facts accompanying the publisher's distribution confirmation above. GeoMotion retains its upstream copyright and is not relicensed as Track AGPL-3.0-only; this record does not create a new public license.

Snapshot hashes describe canonical LF bytes in the Git tree; `.gitattributes` keeps this snapshot at LF on Windows too. Trailing blank lines were normalized before the development-branch commit; upstream hashes are retained.
