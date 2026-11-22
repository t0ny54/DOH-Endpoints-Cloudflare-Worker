# Changelog

## 0.4.47

### Fixed

- **Smoke test could hang.** `wrangler-smoke.mjs` called `fetch()` with no timeout, both for its port-in-use check and for the readiness poll. A port that accepted a connection but never answered HTTP stalled the script indefinitely. Every request now has a timeout (2 s for the poll and port check, 5 s for the probes). Verified: a black-holed socket now fails after 2.0 s.

### Changed

- **Faster L1 cache-key construction.** `localKeyFromNormalized` builds the key from 8-byte `String.fromCharCode` chunks instead of one `apply` over the whole message. The key is byte-for-byte identical (verified for every length from 0 to 4,096 bytes). Measured on a 40-byte question: 125 ns to 74 ns per call. This runs on every request, including L1 hits.
- **Faster edge-cache key encoding.** `edgeKeyFromNormalized` converts the digest to hex through a 256-entry lookup table instead of `toString(16).padStart(2, "0")` per byte. The output is identical. Measured on the hex step alone: 356 ns to 144 ns. The SHA-256 digest dominates the total, so the end-to-end gain is small.
- **Redundant code removed.**
  - `decodeBase64Url` no longer tests `!input` separately. The regex that follows already rejects the empty string, so behavior is unchanged.
  - The `validateRData` branch for URI (256) had the same check as the KEY, DS and DNSKEY branch, so they are merged.
  - The two identical "elapsed whole seconds" calculations in the L1 and coalesced hit paths now share `ageSecondsSince()`.
- `serializeForScript` is exported so the test suite can check its escaping directly.
- Version bumped to 0.4.47 in `Worker.js`, `package.json`, both version fields of `package-lock.json`, and the README.

### Tests

- Five unit tests added (64 in total, up from 59): key-builder equivalence for lengths 0 to 4,096; edge-key equivalence with SHA-256 reference hex; round-trip of the inline-script escaping for `</`, `<!--`, quotes and non-ASCII text; a check that the dashboard's language table still parses; and URI/DS header-length validation.

### Verified

- Every project file was read in full before any change.
- Unit suite: 64 of 64 passing.
- Integration suite: passing, including the lockfile version guard and the dashboard CSP hash checks.
- Browser dashboard test (`npm run test:dashboard`): passing, run in Chromium with Playwright from the sandbox. Playwright is not a project dependency, so this run used a local install.
- Behavior parity against 0.4.46: 10 representative requests (cold miss, L1 hit with a different query case, GET, malformed input, method rejection, upstream failure, degraded answer, NXDOMAIN, dashboard page, health) produce the same status, headers and body bytes. The only difference is the version string.
- Fuzzing: 300,000 random and mutated inputs through the DNS query parser, the upstream response validator (strict and lenient modes) and the TTL-aging routine produced no uncaught exceptions.
- Not run: `npm run test:wrangler`. Wrangler is not installed in the verification environment and the network is disabled. The timeout change was checked on its own against a black-holed socket.
