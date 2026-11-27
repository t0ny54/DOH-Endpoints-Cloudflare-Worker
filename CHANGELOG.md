# Changelog

## 0.4.52

### Fixed

- **A stalled Cache API lookup could hold a request indefinitely.** The L2 read (`caches.default.match()` and the body read) had no time limit. A lookup that threw already fell through to upstream resolution, but one that never settled blocked the cold request until the platform stopped it, contrary to the documented fall-through behavior. Each L2 read is now bounded by `CONFIG.EDGE_CACHE_LOOKUP_TIMEOUT_MS` (250 ms). A lookup that exceeds it is abandoned and the query resolves upstream. Reproduced before the fix (request still pending after 3 s) and verified after it (completes within the bound, `x-cache: MISS`, all three upstreams queried). A regression test covers it in `integration.mjs`.

### Changed

- Removed a redundant second normalization of the cache age in `patchDNSResponseForAge()`. Its callers already pass a whole, non-negative age, so the clamp was dead code.
- `handleDNS()` now uses the transaction ID it already reads from the wire (`id`) for upstream racing, the L2 lookup and the response, instead of also reading `parsed.id`. The two values are always equal, so behavior is unchanged.

### Review

- Read every project file in full (`Worker.js`, `integration.mjs`, `test.mjs`, `dashboard-browser.mjs`, `wrangler-smoke.mjs`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `wrangler.toml`, `.gitignore`).
- Dead code: a scripted check found every top-level function, every `CONFIG` key, every dashboard CSS selector and every test-only export referenced. No unused code was removed beyond the redundancy above.
- Conflicts: README statements on cache keying, TTL rules, rate-limit keys, RCODE handling, scoring and `/health` were checked against the code. The only mismatch was the L2 fall-through claim, fixed above.
- Property probes (20,000 random base64url decodes against the reference decoder, 20,000 random IPv6 keys, 5,000 random cache-age patches) found no crashes or wrong results.

### Verified

- Unit suite: 66 of 66 passing (Node 22.23.5).
- Integration suite: passing, including the new stalled-lookup regression test.
- Version 0.4.52 is set in `Worker.js`, `package.json`, both fields of `package-lock.json`, and the README.
- Not run: `npm run test:wrangler` (Wrangler is not installed and the network is disabled) and `npm run test:dashboard` (Playwright and Chromium are not installed).
