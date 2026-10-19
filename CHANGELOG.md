# Changelog

## 0.4.13

Sixth audit release: every file was read in full (`Worker.js`, `test.mjs`,
`integration.mjs`, `wrangler-smoke.mjs`, `wrangler.toml`, `package.json`,
`README.md`, `CHANGELOG.md`, `LICENSE`).

### Reviewed (suspected issues verified intentional — no change)
- `isBetterDegraded()`: SERVFAIL-preferred degraded ranking is by design.
- `relay()`: race-aborted losers are intentionally not penalized.
- `readCappedBody()`: the `arrayBuffer()` fallback is reachable (empty-body POST) and covered by the integration suite.
- `anySignal()`: retained as the documented `AbortSignal.any` compatibility shim.
- Shared `ArrayBuffer` between the L1 entry, the async L2 `put()`, and the client response is safe: all mutation goes through the copying `patchDNSResponseForAge()`.

### Fixed
- `README.md`: documented that the local fallback limiter sends `Retry-After` equal to the full window length.

### Not changed (no dead code, conflicts, bugs, or worthwhile optimizations found)
- `Worker.js`, `test.mjs` (39/39 pass), `integration.mjs` (pass), `wrangler-smoke.mjs`, `wrangler.toml`, `LICENSE`.
- `Worker.js` `VERSION`, `package.json`, `README.md`: bumped to `0.4.13` together (the integration suite asserts version agreement).


## 0.4.12

Fifth audit release: every file (`Worker.js`, `test.mjs`, `integration.mjs`, `wrangler-smoke.mjs`, `wrangler.toml`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) was read in full.

### Fixed
- `Worker.js` `getEdgeCache()`: the 0.4.11 entry claimed oversized/malformed L2 entries were ignored "instead of being buffered", but the body was still fully buffered via `arrayBuffer()` before the size check. L2 entries are now genuinely stream-limited through `readCappedBody()`; oversized or unreadable entries are discarded before buffering completes.

### Changed (cleanup / dedup)
- `Worker.js` `handleDNS()`: removed the dead `try/catch` around `ctx.waitUntil(putEdgeCache(...))` — `putEdgeCache()` already swallows its own errors, so the wrapper could never observe a throwable condition.
- `test.mjs`: the four remaining inline resolver-node factories now use the hoisted `makeNode()` helper (0.4.11 claimed this dedup was complete; it wasn't); the leftover `// makeNode() from the top-level helper` comment was removed.
- `Worker.js`, `package.json`, `README.md`: version `0.4.12`.

### Not changed (reviewed)
- `integration.mjs`, `wrangler-smoke.mjs`, `wrangler.toml`, `LICENSE`: fully re-read; no dead code, conflicts or bugs found.
