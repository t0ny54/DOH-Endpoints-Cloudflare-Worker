## 0.4.27

### Fixed
- Upstream responses carrying an OPT extended RCODE (RFC 6891 section 6.1.3, for example BADVERS = 16) were reported as NOERROR, so they could be scored as a usable answer and, if they carried records, cached. The response analyzer now combines the OPT TTL's top 8 bits with the 4-bit header RCODE. Such responses are relayed as degraded (`x-dns-degraded: 1`), never cached, and reported in `/health` as `DNS RCODE 16`.

### Changed
- A cold cache miss now normalizes the DNS query once and derives both the L1 key and the L2 SHA-256 key from that buffer. Previously each key re-normalized and copied the packet.
- README: the test-suite sections list coverage in shorter form (the long per-test enumerations repeated test names and went stale on every release), a history-style sentence was removed, and the RCODE rule is documented.

### Tests
- Unit suite 45 -> 46: the OPT extended RCODE is applied to cacheability and to the returned RCODE, and relay classifies it as a degraded answer. The new test fails on 0.4.26 (expected 16, actual 0).

### Verified
- `npm test` passes (46 unit tests plus the integration suite), and `npm run test:wrangler` passes against the local workerd runtime.
- A differential fuzz of 20,000 random query and response pairs against 0.4.26 produced identical cache keys in every case. Response validation differed only where an OPT extended RCODE is present, and then only in the RCODE and the cache TTL (now 0).
