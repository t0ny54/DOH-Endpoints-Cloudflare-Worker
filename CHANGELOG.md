# Changelog

## 0.4.8

Audit release: every file (`Worker.js`, `test.mjs`, `integration.mjs`, `wrangler-smoke.mjs`, `wrangler.toml`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) was read in full. One behavior bug (wasted upstream work under a cache race), one conflict (dashboard English text defined twice with different wording) and a few redundancies were found and fixed. DNS parsing, validation and caching rules are unchanged.

### Fixed
- **Wasted upstream lookups after the L2 await:** `handleDNS()` checked L1 and the in-flight map, then awaited the Cache API (L2), then re-checked only the in-flight map. If another request finished in that window (L1 filled, in-flight entry removed), the request found neither and raced all three upstreams again. It now re-checks L1 after the L2 lookup and answers `L1-HIT` with 0 upstreams. Reproduced before the fix: `x-cache: MISS`, 3 upstream calls; after: `L1-HIT`, 0 calls.
- **Dashboard English text conflict:** the page carried its English copy twice, in the static HTML and in `I18N.en`, with different wording (for example "Setup for Chromium Browsers" vs "Chromium Browser Settings", and different steps), and `changeLang()` runs on every load, so English visitors saw the static text replaced a moment after first paint. `I18N.en` now equals the static text, so the page no longer changes wording on load or when switching back to English. The heading "DOH" is spelled "DoH", and the raw `>` in a step is written `&gt;`.
- **`Retry-After` on 429:** the value was a hard-coded `'60'`; it is now derived from `RATE_LIMIT_WINDOW_MS` (still 60 with the shipped settings).

### Removed (dead / redundant code)
- `handleDNS()`: the duplicated L1-hit response block; `l1HitResponse()` now serves both L1 checks.
- Trailing whitespace left behind by removed comments in `Worker.js` and `test.mjs` (about 40 lines).
- `wrangler-smoke.mjs`: the second `/health` request. The readiness probe's response is now reused.
- `integration.mjs`: a no-op `MAX_CACHE_ENTRIES = 512` assignment (the value was never changed before it) and a trailing `mode = 'ok'`.

### Changed
- `package.json`, `Worker.js` `VERSION`: version `0.4.8`.
- `integration.mjs`: new checks for the late-L1 race (L2 `match()` that fills L1 while pending), for static/`I18N.en` dashboard text staying identical (nine fields), and for the `Retry-After` value. The first two fail against 0.4.7.
- `README.md`: version, the race and dashboard behavior, the unchanged-by-design list below, and the description of the integration suite.

### Verified
- `npm test` (39 unit tests plus the integration suite) passes on Node 22.22.2. The unit tests are unchanged and pass against both 0.4.7 and 0.4.8 `Worker.js`.
- The new integration checks were run against 0.4.7 `Worker.js` and fail there (dashboard text differs), and pass on 0.4.8.
- The dashboard's inline script passes `node --check`; `wrangler-smoke.mjs` passes `node --check`.
- Not run: `npm run test:wrangler` (no network or Wrangler install in the audit environment). `wrangler.toml` is unchanged; the only smoke-test change is reusing one response.

### Not changed (reviewed)
- **NXDOMAIN grace window:** when two upstreams return `NXDOMAIN` the Worker still waits out the remaining `NXDOMAIN_GRACE_MS` (200 ms) for the third. Returning on a 2-of-3 agreement would cut that latency but weakens the protection against filtered upstreams; this is a policy choice, so it stays.
- **Cache key includes the EDNS OPT record:** clients that send per-query EDNS data (cookies, client subnet) get separate cache entries. Ordinary DoH clients do not.
- **`Vary: Accept-Encoding`** on DNS responses is redundant next to `Cache-Control: no-store` but harmless; header set left as is.
- **`validateDNSResponse()` requires one question:** a response with an empty question section (rare FORMERR/NOTIMP replies) counts as an upstream failure. Left strict by design.
- `getDNSCacheTTL()` and `validateDNSResponse()` both walk the response on a cold miss; merging them would save CPU but risk diverging validation, so they stay separate.
- `decodeBase64Url()` post-decode size check, `anySignal()`, `packet.slice()` in `relay()` and the `try`/`catch` around `ctx.waitUntil()` stay as documented in 0.4.7.
- `LICENSE` still has no copyright holder name after "Copyright (c) 2026"; add one if needed.

