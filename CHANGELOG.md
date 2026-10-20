# Changelog

## 0.4.15

Eighth audit release: every file (`Worker.js`, `test.mjs`, `integration.mjs`, `wrangler-smoke.mjs`, `wrangler.toml`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) was read in full. No bugs or conflicts were found; only redundant code was removed.

### Changed (dead/redundant code removed)
- `Worker.js` `cappedTTL()`: dropped the `Math.max(1, ...)` before `clamp()`; `EDGE_CACHE_MIN_TTL_SECONDS` (1) already enforces the same lower bound.
- `Worker.js` `putEdgeCache()`: removed the `ttl` alias of `ttlSeconds`.
- `Worker.js` dashboard: removed the unused `tutorialNav` / `docPanels` element ids and the `font-family` in `.lang-fa` that repeated the `body` rule.

### Verified (no change)
- No unused functions or `CONFIG` keys; `test.mjs` (39/39) and `integration.mjs` pass unchanged. `wrangler-smoke.mjs`, `wrangler.toml`, `LICENSE` need no change.
- `Worker.js` `VERSION`, `package.json`, `README.md`: bumped to `0.4.15` together.
