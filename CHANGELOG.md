# Changelog

## 0.4.29

### Changed

- `readCappedBody()` takes an error factory instead of a message. Each caller states how an oversized body is classified, so `relay()` no longer wraps the read in a try/catch that rewrote 413 errors. The upstream response-too-large error and its kind are unchanged.

### Tests

- Renamed a unit test whose name claimed it checked transaction IDs but actually exercised a missing question. No behavior change.

### Review

- Re-read all project files in full. No new functional defect was found in the DNS parser, cache, coalescing, rate limiter, or dashboard.
- Kept on purpose: `escapeHtml()` (defensive, unreachable with URL origins), `localCacheKey()` and `makeCacheKey()` (test seams), and the lenient mode of the response analysis (used by TTL tests).

### Verified

- `npm test` passes: 56 unit tests and the integration suite.
- Merged V8 coverage: unexecuted code remains 5 lines (the `escapeHtml` replacement map).
- 500,000 fuzzed packets against the parsers and key functions: no exceptions.
