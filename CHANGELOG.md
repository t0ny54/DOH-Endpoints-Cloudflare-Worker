# Changelog

## 0.4.2

### Fixed
- **Local rate limiter eviction:** the per-isolate fallback limiter evicted by first-insertion order, so an actively rate-limited IP could be dropped (and its counter reset) once the table held 2048 IPs. Entries are now re-inserted on every hit, so the least recently seen IP is evicted.
- **L2 → L1 promotion expiry:** the L1 expiry was `now + remaining TTL` with a whole-second floored age, so it could outlive the real DNS expiry by up to 1 s. It is now `min(storedAt + TTL, now + L1 cap)`, and the TTL is computed once instead of twice.
- **Invalid markup in the dashboard:** translated tutorial steps were injected as `<li>` elements into `<div>` containers (no `<ul>/<ol>`); they are now `<p>`, matching the static English markup.
- **Docs conflict:** `README.md` stated `compatibility_date = "2026-10-01"` while `wrangler.toml` uses `2026-09-01`; README now matches the file.

### Removed (dead / redundant code)
- Redundant `payload.byteLength > MAX_DNS_MESSAGE_BYTES` and `!payload` checks in `handleDNS()`: both GET (`decodeBase64Url`) and POST (`readCappedBody`) already enforce the limit, and the payload is never falsy.
- The per-call `seenPointers` `Set` in DNS name parsing: loops are already bounded by the 255-octet expanded-name budget and the 127-jump cap, so the set never changed the outcome.
- Duplicate `readDNSName` + `skipDNSName` walk of every name (and `questionMatchesQuery`'s four separate scans).

### Optimized
- `scanDNSName()`: one pass validates a name, returns its encoded end offset and (optionally) builds the lower-cased name. `skipDNSName()` no longer builds a throw-away string, which removes the double walk on every owner name and RDATA name in every parsed/validated/patched packet. Fuzzed against the 0.4.1 implementation (300k random packets): identical results.
- `validateRData()` uses module-level `Set`s for name-bearing RR types instead of allocating arrays for every record.

### Changed
- `package.json`, `Worker.js` header/`VERSION`, `integration.mjs`, `wrangler-smoke.mjs`: version `0.4.2`.
- `__internals` additionally exports `scanDNSName` (tests only).
- `test.mjs`: 3 new tests (28 total): single-pass scanner, pointer-loop/forward-pointer rejection, rate-limiter LRU eviction.
- `README.md`: version, `compatibility_date`, test count/coverage, L1 promotion and fallback-limiter notes.
