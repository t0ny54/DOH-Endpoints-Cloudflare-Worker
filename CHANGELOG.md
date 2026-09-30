# Changelog

## 0.4.1

### Fixed
- **L2 → L1 promotion:** an L2 (Cache API) hit older than the 300 s L1 cap was written to L1 already expired, so every repeat query paid a Cache API call. L1 now gets `min(remaining DNS TTL, 300 s)` counted from promotion.
- **NXDOMAIN grace window:** if the grace deadline had already passed when the race loop iterated, the loop kept waiting on slower upstreams (up to the upstream timeout). It now settles immediately.
- **Version drift:** file header said `0.3.0` while the runtime constant said `0.4.0`; both are now `0.4.1`.

### Removed (dead / redundant code)
- `selectRacers()` and `APP_STATE.primaryCursor`: every upstream is started in parallel, so sorting/rotating the list had no effect on results; it only cost CPU on each cold miss.
- Duplicate `resolveWithParallelRace` key in `__internals`.
- Unused `message` variable in `relay()`, unused `classCode` / `questionEnd` return fields, and the no-op `type === 46 ? 18 : 18` ternary.
- Inline NSEC bitmap loop duplicating `validateTypeBitmap()`; NSEC now reuses it (behavior unchanged).
- Two copy-pasted coalescing blocks and the `awaitSharedResolution`/`toUpstreamFailure` helpers, replaced by a single `joinInflight()`.

### Optimized
- Grace-period `setTimeout` is now cleared when the race ends (previously a timer was created on every loop iteration and left pending).
- No per-request sort/filter of resolver nodes on cold misses.

### Changed
- `setCache()` accepts an optional explicit expiry (`expiresAtMs`).
- `package.json`: added `version` and `engines.node >= 20`.
- `integration.mjs`, `wrangler-smoke.mjs`: expected `/health` version bumped to `0.4.1`.
- `test.mjs`: new test for explicit-expiry L1 promotion (25 unit tests).
- `README.md`: corrected to match the code (`x-upstreams` is 0 or 3, `x-edge-cache: DISABLED`, 1200 ms upstream timeout, L2→L1 promotion, scores are informational, `/health` contents, test count, Node version, dashboard's Tailwind CDN dependency); removed the duplicated upstream list.
