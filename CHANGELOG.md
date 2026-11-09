## 0.4.26

### Changed
- Faster cache lookups. The isolate-local L1 cache and in-flight coalescing now key on the exact normalized query bytes instead of a SHA-256 digest, so each request no longer awaits a digest before checking the cache. Keys are collision-free by construction: distinct questions never share an entry. The L2 Cache API key is unchanged (SHA-256 of the same bytes) and is computed only when the Cache API is enabled and L1 misses. Measured in Node 22: key derivation dropped from about 8.4 µs to 0.2 µs, and an end-to-end L1-hit request through `fetch()` dropped from about 36 µs to about 23 µs.
- `MAX_GET_DNS_CHARS` is derived from `MAX_DNS_MESSAGE_BYTES` (still 5,462 characters), so the GET size cap and the byte cap cannot drift apart.

### Removed
- Dead lenient-mode size check in `analyzeDNSResponse()`. Only the test-only lenient path reached it, and it never receives oversized buffers.
- Unreachable post-decode size check in `decodeBase64Url()`. The GET character cap already bounds the decoded length.

### Fixed
- `wrangler-smoke.mjs` returned before Wrangler had exited. It now signals the process tree and waits, with a bounded timeout, for Wrangler to exit.
- README: the release-sync instructions omitted the README and CHANGELOG version lines; an unverified claim about Cache API calls counting against the subrequest quota was removed; the smoke-test cleanup wording now matches what the script does.

### Tests
- Unit suite 44 -> 45: exact local cache keys ignore transaction ID and ASCII case, keep distinct questions apart, and do not mutate their input.
- Integration: the GET size boundary is checked at exactly 4,096 bytes (accepted) and 4,097 bytes (`413`). The L1 test seed uses `localCacheKey()`.
- A mutation check confirmed that a GET cap one character too large fails the boundary test.

### Verified
- `npm run test:all` passes: unit suite (45), integration suite, and the real `wrangler dev` (workerd) smoke test.
- A deterministic differential replay of 2,500 mixed requests (L1 hits, L2 hits, misses, and degraded SERVFAIL answers, over GET and POST) produced byte-identical responses and headers to 0.4.25.
