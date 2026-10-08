# Changelog

## 0.4.6

### Fixed
- **Negative answers with a CNAME chain were cached longer than the CNAME's own TTL:** for `NXDOMAIN` (and for `NOERROR` with an empty final answer) `getDNSCacheTTL()` looked only at the authority section and ignored answer-section records. An `NXDOMAIN` preceded by a CNAME with TTL 10 and an SOA with TTL/MINIMUM 60/30 was cached for 30 s, although the CNAME aged to 0 after 10 s (and, through L2, for up to 24 h with longer SOAs). The cache lifetime is now `min(lowest answer TTL, negative TTL)`. An answer that carries a top-bit TTL record is therefore no longer cached (RFC 2181 section 8). Responses without answer-section records and positive answers without an SOA are unchanged; the new lifetime is never longer than the old one.
- **Docs:** `README.md` described the negative TTL as authority-only; it now states the answer-section bound, the dashboard security headers, and that the `wrangler.toml` limiter settings and the fallback limiter `CONFIG` values are separate and must be changed together. Its version and test count are updated, and a sentence that was duplicated verbatim (stream-limited upstream body) was removed.

### Removed (dead / redundant code)
- `normalizeDNSResponseID()`: it copied the whole response only to zero two octets. The buffer returned by `relay()` is private to the resolve job, so the ID is now zeroed in place (one allocation fewer per cacheable cold miss).
- `skipDNSName()`: `len > 63` (unreachable after the `(len & 0xc0) !== 0` test) and `pointer >= bytes.length` (implied by `pointer < pos`).
- `restoreQuestionCase()`: the `typeof ... !== 'number'` checks, unreachable because every index is already bounded by `maxLen`.
- `resolveWithParallelRace()`: the `attempts` array (always equal to `nodes.length`), the `!result.node` test (only the grace-timer result can be falsy) and the early `abortAttempts(controllers, winner)` call, which the `finally` block repeats immediately; `abortAttempts()` lost its `winnerNode` parameter.
- `relay()`: the explicit `lastError`/`lastErrorKind = 'timeout'` assignments (`penalize()` sets exactly these values), and the `packet.slice ? ... : ...` test (the packet is always a `Uint8Array`).
- `allowDNSRequest()`: two `ip || 'unknown'` fallbacks; `getClientIP()` already returns `'unknown'`.
- `putEdgeCache()`: the TTL was clamped and floored twice; it is computed once.

### Changed
- `package.json`, `Worker.js` `VERSION`: version `0.4.6`.
- `test.mjs`: 36 tests (was 33). New: CNAME chains bound NXDOMAIN/NODATA lifetimes (fails against 0.4.5); timeout bookkeeping through `penalize()` alone; one attempt per upstream and no penalty for aborted losers. The top-bit-TTL aging test no longer asserts the old cacheability of that NXDOMAIN.

### Verified
- Differential fuzz against 0.4.5 (60,000 randomly mutated responses, answer and authority records, all TTL edge values): identical `validateDNSResponse()` results and identical `patchDNSResponseForAge()` output (ages 0, 5, 400 s) in every case. `getDNSCacheTTL()` differed only for responses with both answer and authority records, and the new value was never larger.
- `npm test` (36 unit tests plus the integration suite) passes on Node 22. `npm run test:wrangler` could not be run here (no `wrangler` install, no network); `wrangler.toml`, `wrangler-smoke.mjs` and `integration.mjs` are unchanged.

### Not changed (reviewed)
- `questionMatchesQuery()` and `getDNSCacheTTL()` keep their length guards; they are unreachable from the Worker's own paths but the functions are reachable from tests and cost nothing. `anySignal()`, the `jumps` limit in `skipDNSName()`, and the double parse on a cold miss stay as documented in 0.4.5.
- The English text in the dashboard HTML is overwritten by the `I18N.en` strings on load; it only shows before scripts run, so it was left alone.
- `/health` and `/` are not rate limited (only `/dns-query` is), as documented.
- `LICENSE` has no copyright holder name after "Copyright (c) 2026"; add one if needed.

