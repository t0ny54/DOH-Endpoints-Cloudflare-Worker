## 0.4.24

### Fixed
- Dashboard language-button drift: the static HTML rendered `LANGUAGE` inside the
  `#currentLang` span while the English row of the `I18N` table (applied on load)
  reads `ENGLISH`, so the page changed wording on first load and contradicted the
  documented invariant that static English copy and `I18N.en` never drift apart.
  The static span now renders `ENGLISH`.

### Changed
- `getEdgeCache()` validates the cheap `x-doh-stored-at` / `x-doh-ttl` metadata
  before buffering a cached L2 body, so expired or malformed entries no longer pay
  for a body read they discard. No observable behavior change.
- `integration.mjs`: the static-vs-`I18N.en` consistency check now also covers the
  language button, main title, subtitle, endpoint label, and copy button
  (`currentLang`/`curL`, `mainTitle`/`main`, `subTag`/`sub`, `labelUrl`/`urlL`,
  `txtCopy`/`cpT`).
- Version bumped to 0.4.24 (`Worker.js` `VERSION`, `package.json`); `/health` and
  the integration/smoke version checks read both dynamically and stay in agreement.

### Verified
- Full re-audit of every project file (`Worker.js`, `test.mjs`, `integration.mjs`,
  `wrangler-smoke.mjs`, `package.json`, `wrangler.toml`, `README.md`, `CHANGELOG.md`,
  `LICENSE`): no functional bugs beyond the drift fixed above, no configuration
  conflicts, no dead production code. The lenient branch of `analyzeDNSResponse()`
  is intentionally retained (unit-suite load-bearing).
- Baseline `node --test test.mjs` (43 tests) and `node integration.mjs` pass; all
  changes are behavior-preserving except the `LANGUAGE` -> `ENGLISH` fix, and the
  extended consistency assertions were verified against the shipped HTML and
  `I18N.en` strings.
