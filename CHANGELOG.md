# Changelog

## 0.4.49

### Fixed

- **L1 memory was bounded by entry count, not by bytes.** The cache held up to 512 entries and each could be an upstream answer of up to 65,535 bytes, so one isolate could hold about 32 MiB of response data. Measured with 512 maximum-size answers: 33,553,920 bytes before this release, 8,388,480 bytes after. The L1 cache now also has an 8 MiB byte budget (`MAX_CACHE_BYTES`), evicts least-recently-used entries until both limits hold, and never admits a single answer larger than the whole budget. Typical DNS answers are far smaller than the budget, so the entry limit still governs ordinary traffic.

### Changed

- **Packets shorter than the DNS header are refused first.** A message under 12 bytes is rejected with `400 DNS message too short` before key derivation, the L1 lookup and the in-flight lookup. The response is the same as before; the rejection now happens earlier and costs less.
- **`/health` reports byte usage.** It adds `cacheBytes` at the top level and `localMaxEntries` / `localMaxBytes` under `cache`.

### Removed

- **Two one-line wrappers.** `httpError()` and `upstreamError()` only forwarded to `taggedError()`. Their call sites now call `taggedError()` directly with `{ status }` or `{ kind }`. Behaviour is unchanged.

### Tests

- Unit suite: 63 tests (was 62). New: the byte budget is respected, the least-recently-used entry is evicted first, an oversized answer is not admitted, replacing an entry does not double-count its bytes, and expiry releases bytes.
- `integration.mjs`: a short POST is refused with `400` and triggers no upstream work; `/health` reports byte usage within its configured maximum.

### Verified

- Unit suite: 63 of 63 passing (Node 22.23.5).
- Integration suite: passing.
- Randomised check (not part of the repository): 200,000 mutated DNS responses were run through response validation and TTL aging. No exception was raised and every accepted packet kept its length after aging.
- Version 0.4.49 is set in `Worker.js`, `package.json`, both fields of `package-lock.json`, and the README.
- Not run: `npm run test:wrangler` (Wrangler is not installed and the network is disabled) and `npm run test:dashboard` (Playwright and a Chromium binary are not installed). The dashboard markup and script were not changed in this release.
