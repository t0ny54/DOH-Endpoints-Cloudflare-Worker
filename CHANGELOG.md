# Changelog

## 0.4.22

### Changed
- `relay()`: inlined the single-use `raceAbort` intermediate; race-abort detection now reads directly from the combined signal. No behavioral change — aborted losers are still not penalized, and timeouts are still classified via the timeout controller's own signal.
- Version bumped to 0.4.22 (`Worker.js` `VERSION`, `package.json`); `/health` and the integration/smoke version checks read both dynamically and stay in agreement.

### Verified
- Every file was read and audited in full (Worker.js, test.mjs, integration.mjs, wrangler-smoke.mjs, package.json, wrangler.toml, README.md, CHANGELOG.md, LICENSE): no dead functions (the one single-use variable was inlined), no configuration conflicts (wrangler.toml 100 req / 60 s matches the local-limiter constants and the `DNS_RATE_LIMITER` binding name), and no functional bugs. Rejecting padded base64url and reporting `x-upstreams: 3` on partial races are documented, RFC 8484-aligned behaviors, covered by the integration and smoke tests — not defects.
- `node --test test.mjs` (43 tests) and `node integration.mjs` pass with the changes applied.
