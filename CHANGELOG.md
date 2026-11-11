# Changelog

## 0.4.33

### Fixed

- A truncated (TC) upstream answer could win the parallel race and be returned to the client, even when another upstream returned the complete answer. DoH has no TCP retry, so the client received an incomplete response. A truncated answer is now used only if no complete answer arrives.
- The degraded-answer tie-break returned whichever degraded answer arrived first when score and latency were equal, although the README describes that choice as deterministic. An exact tie now goes to the upstream listed first in `DOH_UPSTREAMS`, so arrival order never decides.

### Changed

- The `RESOLVER_NODES` list is exported through the internal test hook so the tie-break can be tested directly.

### Verified

- Unit suite: 55 tests, all passing. Three tests were added: a truncated answer loses to a complete one, a truncated answer is relayed when nothing complete arrives, and degraded ties follow configuration order. Two of them fail against 0.4.32; the third guards existing fallback behavior and passes on both versions.
- Integration suite passes.
- Fuzzing of the parser, validator, TTL patcher and cache-key code: 200,000 random and mutated packets, no exceptions.
- Hot-path microbenchmark: every DNS operation (key derivation, parsing, validation, TTL patching) takes under 1 µs, so no CPU optimization was pursued.
- Not run here: `npm run test:wrangler`, which needs Wrangler installed locally.
