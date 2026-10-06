# Changelog

## 0.4.4

### Fixed
- **TTLs with the top bit set were cached for 24 hours:** `getDNSCacheTTL()` used the raw unsigned 32-bit TTL, so an answer with TTL `0xFFFFFFFF` (or an SOA `MINIMUM` of `0x80000000` or more) was cached for the 86,400 s maximum. RFC 2181 section 8 says such values must be treated as 0; they now make the answer uncacheable (it is still relayed to the client). `0x7FFFFFFF` is still valid and still capped at 86,400 s.
- **Smoke test left processes behind on Windows:** `wrangler-smoke.mjs` runs `npx.cmd` through a shell there, and `child.kill()` only ends that shell, not the Node/`workerd` processes below it. It now ends the whole process tree with `taskkill /T /F`. (Linux/macOS behaviour is unchanged: the whole process group is signalled.)
- **Smoke test waited 20 s and showed nothing useful when Wrangler failed to start:** a spawn error or an early exit (for example Wrangler not installed, so `npx --no-install` refuses) is now detected on the next poll and reported immediately together with Wrangler's output.
- **Docs conflicts:** `README.md` said the smoke test stops the whole process group on Windows (see above); did not say that GET `dns` values must be unpadded base64url (a padded value returns 400); and did not mention the RFC 2181 TTL rule. All three are now stated.
- **Misleading test title:** the NXDOMAIN TTL unit test claimed `min(SOA TTL, MINIMUM)`; it now describes the real rule (lowest authority TTL capped by SOA `MINIMUM`) and asserts the authority-TTL part, which was previously untested.

### Removed (dead / redundant code)
- `readDNSName()` and the name-building `out` mode of `scanDNSName()`: nothing in the Worker used them, only tests did. `scanDNSName()` and its one-line wrapper `skipDNSName()` are merged into a single `skipDNSName()`. `readDNSName` and `scanDNSName` are no longer exported through `__internals`.
- `MAX_CACHEABLE_DNS_BYTES`: it was `Math.min(65_535, 65_535)`; `getDNSCacheTTL()` now uses `CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES` directly.
- `integration.mjs`: unused `realFetch`, `realCaches` and `realCrypto`; the no-op `b[6]=rcode===0?0:0` and the self-assignment of the transaction ID in `answerFor()`; a `throttle.delete()` of a key that was never set; and three "PASS" lines printed before the later tests had run (one final line remains).

### Optimized
- `getDNSCacheTTL()` no longer builds a `[name, count]` array of sections per call: one loop over the summed record count, as `validateDNSResponse()` and `patchDNSResponseForAge()` already do since 0.4.3.
- Fuzzed against 0.4.3 (150k randomly mutated responses, about 40k of them valid): identical `validateDNSResponse()` results and byte-identical `patchDNSResponseForAge()` output at ages 0, 5 and 400 s. `getDNSCacheTTL()` differed only in the 2,401 cases where an answer/authority TTL or an SOA `MINIMUM` had the top bit set (the fix above).

### Changed
- `package.json`, `Worker.js` `VERSION`: version `0.4.4`.
- `test.mjs`: 31 tests (was 30). Removed the `readDNSName` test; the two `scanDNSName` tests now exercise `skipDNSName`; new tests for the RFC 2181 TTL rule (fails against 0.4.3) and for `patchDNSResponseForAge()` (transaction ID, TTL aging, expiry to 0, question-case restoration, OPT left untouched), which had no direct test.
- `integration.mjs`: new degraded-answer test. All three upstreams return `SERVFAIL`: the client gets 200 with `x-dns-degraded: 1`, the upstream RCODE and its own transaction ID, and nothing is stored in L1 or L2 (a repeat query goes upstream again). The `servfail` mock mode existed but no test used it.
- `wrangler-smoke.mjs`: process-tree shutdown on Windows and fail-fast on startup errors (see Fixed).
- `README.md`: version, test count/coverage, RFC 2181 TTL rule, GET padding rule, smoke-test notes.
