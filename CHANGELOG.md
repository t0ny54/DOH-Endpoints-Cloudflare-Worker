# Changelog

## 0.4.43

### Fixed

- **Node.js requirement conflict.** `package.json` (`engines`), the root entry of `package-lock.json`, and the README all declared Node.js 20.3+, but the pinned `wrangler` 4.143.0 and its dependencies `miniflare` and `@cloudflare/kv-asset-handler` require Node.js 22+. The minimum is now Node.js 22 everywhere, so the documented requirement matches what `npm install` actually needs.

### Changed

- Removed the redundant `plain()` alias in the dashboard builder. Its 14 call sites now call `escapeHtml()` directly. The rendered page is unchanged (the HTML was compared byte-for-byte against 0.4.42, ignoring the version string).
- Version bumped to 0.4.43 in `Worker.js`, `package.json`, both version fields of `package-lock.json`, and the README.
- `CHANGELOG.md` now holds only the latest release entry.

### Verified

- Full read of every project file before changes. Scans found no unused top-level functions, constants, or `CONFIG` keys, so no further dead code was removed.
- Unit suite: 59 tests, all passing. Integration suite passing, including the lockfile version guard.
- Parser fuzzing: 300,000 mutated DNS messages through the question parser, upstream response validator, and TTL patcher, with no uncaught exceptions.
- Concurrency and cache probe: concurrent and cached queries that differ only in transaction ID and ASCII letter case each receive their own ID and question casing back.
- Not run: `npm run test:dashboard` (Playwright is not installed in the verification environment) and `npm run test:wrangler` (project dependencies are not installed and the network is disabled).
