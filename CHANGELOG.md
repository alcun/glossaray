# Changelog

## [1.0.0] - 2026-09-15

### Added

- `GET /health` returns `status`, `service` and `version`. `/healthz` is
  unchanged.
- `server/package.json` carries the release version, and a test fails when the
  changelog does not open with it.

### Changed

- The container runs tini as PID 1, so orphaned child processes are reaped.
### Changed

- Simplify server and container comments to implementation details.
- Simplify documentation to installation, architecture, protocol and privacy.
- Remove agent instructions, naming notes and internal operational narratives
  from documentation and source comments.
- Stop tracking generated Astro metadata.

### Fixed

- Pass the selected public origin into the macOS website build during setup.
