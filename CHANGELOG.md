# Changelog

## 0.4.7

Audit release: every file (`Worker.js`, `test.mjs`, `integration.mjs`, `wrangler-smoke.mjs`, `wrangler.toml`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) was read in full. No functional DNS bug was found; the changes below are one small UI fix, leftover/dead code, and test and documentation gaps.

### Fixed
- **Dashboard `lang` attribute:** the page is served with `<html lang="en">` and switching to Persian or Chinese only replaced the text, so screen readers and browser translation still treated the page as English. `changeLang()` now also sets `document.documentElement.lang`.
- **Docs:** `README.md` listed no cost for a request that joins an in-flight lookup (the `COALESCED` path: 0 upstreams and, at most, one Cache API `match`), and described `x-winner` / `x-winner-lat` without saying they are also sent on `COALESCED` responses. Both are documented now; the version and test count are updated.

### Removed (dead / redundant code)
- `normalizeUncompressedQuestionName()`: the `len > 63` test was unreachable (any length byte above 63 has one of its two top bits set and had already returned), and a line carried trailing whitespace.
- `handleDNS()`: the `normalizedBody` alias and the `body: normalizedBody` override were leftovers from the removed `normalizeDNSResponseID()` (0.4.6); the alias always equalled `result.body`.
- `parseDNSQuestion()` and `makeCacheKey()`: the `instanceof Uint8Array` fallbacks. Both receive the `Uint8Array` produced by `readDNSPayload()`.
- `readCappedBody()`: `await` on `reader.releaseLock()`, which is synchronous.
- `patchDNSResponseForAge()`: the intermediate `bytes` view plus allocate-and-`set()`; a single `slice()` makes the copy.

### Changed
- `package.json`, `Worker.js` `VERSION`: version `0.4.7`.
- `test.mjs`: 39 tests (was 36). New: local rate-limiter window reset (exactly at `RATE_LIMIT_WINDOW_MS`); `makeCacheKey()` and `patchDNSResponseForAge()` never mutate their inputs (cached and coalesced bodies are shared, so this is a safety property); `relay()` timeout and race-abort bookkeeping without `AbortSignal.any` (covers the `anySignal()` fallback, previously never executed by any test).
- `integration.mjs`: new checks for client body limits (chunked body over 4 KiB, `Content-Length` over 4 KiB, empty POST), an L2 entry without `x-doh-*` headers (ignored, resolved upstream), the periodic sweep of expired L1 and throttle entries, `COALESCED` response headers, and the dashboard `lang` update.

### Verified
- `npm test` (39 unit tests plus the integration suite) passes on Node 22.22.2. Line coverage of `Worker.js` under both suites rose from 89.7% to 92.3%; the remaining uncovered lines are mostly rarely used RDATA validators and defensive guards.
- The 39 unit tests also pass against the unmodified 0.4.6 `Worker.js`, i.e. the refactors did not change behavior.
- Differential check against 0.4.6 (20,000 random queries, valid and byte-mutated): identical `makeCacheKey()`, `parseDNSQuestion()` and `patchDNSResponseForAge()` output in every case.
- Fuzz (200,000 byte-mutated or truncated responses): `validateDNSResponse()`, `getDNSCacheTTL()`, `patchDNSResponseForAge()` and `parseDNSQuestion()` never threw, and aging never changed a response's length (about 46,800 mutants were still structurally valid).
- The dashboard's inline script passes `node --check`; the pinned `wrangler@4.143.0` exists on the public release list.
- Not run: `npm run test:wrangler` (no network or Wrangler install in the audit environment). `wrangler.toml` and `wrangler-smoke.mjs` are unchanged.

### Not changed (reviewed)
- `decodeBase64Url()`: the post-decode 413 check cannot trigger with the shipped limits (5,462 base64url characters decode to at most 4,096 bytes). It stays as a guard so changing `MAX_GET_DNS_CHARS` alone cannot let an oversized query through.
- `anySignal()`: unreachable on Node 20.3+ and current `workerd`, but `engines` still allows Node 20.0 to 20.2, so it stays (and is now tested).
- `relay()` still passes `packet.slice()` to `fetch()`; dropping the three small copies per cold miss could not be verified against `workerd` here.
- `ctx?.waitUntil?.()` stays inside its `try`/`catch`; `putEdgeCache()` never rejects, but the guard keeps a misbehaving `ctx` from failing a DNS answer.
- `wrangler-smoke.mjs` requests `/health` twice (the readiness probe's response is discarded); harmless and untestable here.
- `/health` and `/` answer any HTTP method and are not rate limited, as documented. The DoH endpoint sends no CORS headers; browsers' built-in DoH does not need them.
- `LICENSE` still has no copyright holder name after "Copyright (c) 2026"; add one if needed.

