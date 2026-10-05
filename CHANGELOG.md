# Changelog

## 0.4.3

### Fixed
- **Upstream question check accepted a different label structure:** `questionMatchesQuery()` compared the dotted, lower-cased name strings, so a response whose question was one label `a.b` matched a query for the two labels `a` and `b`. The question is now compared on the wire (ASCII-case-insensitive, identical label structure, QTYPE and QCLASS), so 0x20 case randomization still validates but nothing else is accepted.
- **Degraded-answer ranking ignored resolver score:** when two degraded answers had different RCODEs and neither was SERVFAIL (for example REFUSED vs NOTIMP), `isBetterDegraded()` always kept the earlier arrival. It now falls through to the documented order: SERVFAIL first, then the higher-scored upstream, then the lower latency.
- **Flaky integration test:** the in-flight saturation test waited for the in-flight entry with 100 `setImmediate` ticks, but the cache key is derived through the asynchronous `crypto.subtle.digest`, so the entry sometimes appeared too late (3 failures in 12 runs, 0 in 40 after the fix). It now polls with a 5 ms timer for up to 2 s.
- **Smoke test on Windows and leftover processes:** `wrangler-smoke.mjs` spawned `npx.cmd` without a shell (Node.js rejects this with `EINVAL` since the CVE-2024-27980 fix) and only signalled `npx`, which could leave `workerd` running. It now uses a shell on Windows and kills the whole process group elsewhere.
- **Docs conflicts:** `README.md` described the negative-cache TTL as `min(SOA TTL, SOA MINIMUM)`, but the code uses the lowest authority-section TTL capped by the SOA `MINIMUM`, which can only be shorter. README now states this. README also did not mention `/index.html` or the Persian/Chinese dashboard languages.

### Removed (dead / redundant code)
- The per-call `[ancount, nscount, arcount]` arrays and nested loops in `validateDNSResponse()` and `patchDNSResponseForAge()`: sections do not matter in those loops, so they now run one loop over the summed record count.
- The always-true bounds check around the TTL write in `patchDNSResponseForAge()`: `readResourceRecord()` has already proven the record is in range.
- Hard-coded `0.4.2` version strings in `integration.mjs` and `wrangler-smoke.mjs`: both now read the version from `package.json`.

### Optimized
- `questionMatchesQuery()` no longer builds two throw-away lower-cased name strings and two result objects per upstream response; it reuses the question end offset that `validateDNSResponse()` already computed and compares bytes directly.
- Fuzzed against 0.4.2 (150k randomly mutated responses, about 48k of them valid): identical `validateDNSResponse()` results and byte-identical `patchDNSResponseForAge()` output.

### Changed
- `package.json`, `Worker.js` `VERSION`: version `0.4.3`.
- `test.mjs`: 2 new regression tests (30 total): wire-level question matching and degraded-answer ranking. Both fail against 0.4.2.
- `integration.mjs`, `wrangler-smoke.mjs`: expected version read from `package.json`.
- `README.md`: version, test count/coverage, negative-cache TTL wording, upstream question check, dashboard routes/languages, version-bump note, smoke-test notes.
