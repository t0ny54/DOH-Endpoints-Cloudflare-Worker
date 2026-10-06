# Changelog

## 0.4.5

### Fixed
- **Cached answers could be served with a TTL of about 136 years:** `patchDNSResponseForAge()` aged raw 32-bit TTLs. A record whose TTL has the top bit set, in a part of the response that `getDNSCacheTTL()` does not use for the cache lifetime (a CNAME in a cached NXDOMAIN answer, or an additional-section record), was counted down from that huge value (for example `0xFFFFFFFF` became 4,294,967,285 after 10 s). RFC 2181 section 8 says such TTLs must be treated as 0; aged records now use the same `effectiveTTL()` rule as the cache-lifetime code. Responses without top-bit TTLs, and any response served at age 0, are unchanged.
- **Connection-level upstream failures had no `lastErrorKind`:** a `fetch()` rejection (DNS failure, connection reset, TLS error, body stream error) left `lastErrorKind` as `null`, because the `'network'` default of `upstreamError()` was never reached by errors that were not created through it. These errors are now classified `network`, as the README already claimed. Scoring is unchanged (12 points, counted in `fail`).
- **Docs conflicts:** `README.md` said generic/network failures were distinguished, but nothing exposed or recorded that for raw fetch errors (see above), and it did not describe the actual scoring (timeout 8 / failure 12 / success 1, range 0-100); it did not say that cached records with top-bit TTLs are aged as 0; and its version and test count were out of date. All are now stated accurately.
- **Test mock did not behave like the Cache API:** the `integration.mjs` mock `caches.default.match()` returned the same stored `Response` object every time, so a second hit would have received an already-consumed body. It now returns a fresh clone, like the real Cache API.

### Removed (dead / redundant code)
- `findSOAMinimumOffset()`: it re-parsed both SOA names and re-checked `pos + 20 === rdEnd`, which `readResourceRecord()` has already proven for every SOA, so its `-1` branch could never run. The SOA `MINIMUM` is now read directly from the last four octets of the validated RDATA. The redundant `rr.rdLength >= 20` guard went with it.
- `rdLength` and `end` fields of the `readResourceRecord()` result: `end` always equalled `rdEnd`, and `rdLength` was only used by the guard above. Callers use `rdEnd`.
- Duplicate `type === 43` (DS) branch in `validateRData()`: identical to the KEY/DNSKEY branch (`>= 4` octets); the three types are now one condition.
- `order` property of the resolver nodes (and of the test fixtures): set but never read.
- The `'network'` default argument of `upstreamError()`: every caller passes a kind explicitly; network errors are classified in `relay()` instead (see Fixed).
- Five `__internals` exports that no test used: `decodeBase64Url`, `normalizeDNSResponseID`, `getEdgeCache`, `putEdgeCache`, `allowDNSRequest`. They are still used inside the Worker.
- `integration.mjs`: the `b[7]=rcode===0?1:0` assignment in `answerFor()` is now only executed for NOERROR answers (it was a no-op assignment of 0 for every other RCODE).

### Changed
- `/health`: each upstream now also reports `lastErrorKind` (additive; the field was already recorded and asserted by tests but never exposed).
- `package.json`, `Worker.js` `VERSION`: version `0.4.5`.
- `test.mjs`: 33 tests (was 31). New: top-bit TTLs are aged as 0 (fails against 0.4.4), and connection-level fetch failures are classified `network` and counted as failures (fails against 0.4.4). Removed the unused `order` property from node fixtures.
- `integration.mjs`: asserts `/health` reports `lastErrorKind` `network` after connection failures and `http` after HTTP 503 answers; cache mock returns clones.
- `README.md`: version, test count/coverage, aging rule for top-bit TTLs, failure classification and scoring, `/health` fields.

### Verified
- Differential fuzz against 0.4.4 (150,000 randomly mutated responses, about 125,000 of them valid, with top-bit TTLs deliberately over-represented): identical `validateDNSResponse()` and `getDNSCacheTTL()` results in every case; `patchDNSResponseForAge()` output (ages 0, 5 and 400 s) differed only for responses containing a top-bit-TTL record at an age above 0, which is the fix above.
- `npm test` (33 unit tests plus the integration suite) and `npm run test:wrangler` (real `wrangler dev` smoke test, no leftover live `workerd` process) pass on Node 22.

### Not changed (reviewed)
- `anySignal()` is the fallback for runtimes without `AbortSignal.any()`, so it was kept. The `jumps` limit in `skipDNSName()` is not reachable through the Worker's own call paths (with a compression context the 255-octet name limit already bounds the loop), but it keeps context-less calls bounded, so it was kept as cheap defence in depth.
- Upstream responses are parsed twice on a cold miss (`validateDNSResponse()` and `getDNSCacheTTL()`); merging them would couple validation and caching for a small CPU gain, so it was left as is.
