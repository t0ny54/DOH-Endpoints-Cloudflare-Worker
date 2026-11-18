# Changelog

## 0.4.39

### Changed

- Removed a redundant nested `try`/`catch` in `getEdgeCache()`. The enclosing `try` already returns `null` for any failure while reading an L2 entry, so behavior is unchanged.
- Added `package-lock.json`, so `npm install` reproduces the exact dependency tree the test suites ran against (including Wrangler 4.143.0's transitive dependencies).

### Added

- `.gitignore` excluding `node_modules/`, Wrangler's local `.wrangler/` state, and `.dev.vars`, so local development artifacts are not committed.

### Verified

- Unit suite: 59 tests, all passing.
- Integration suite passes.
- `npm run test:wrangler` passes against a local `wrangler dev` (Wrangler 4.143.0).
- `wrangler deploy --dry-run` validates the `DNS_RATE_LIMITER` binding in `wrangler.toml`.
- Parser fuzzing: 300,000 randomly mutated DNS messages through the parse, validate, and cache-aging paths raised no uncaught exceptions.
