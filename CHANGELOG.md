# Changelog

## 0.4.36

### Fixed

- `/`, `/index.html` and `/health` accepted every HTTP method (a `POST` to `/health` returned the metrics). They now accept only `GET` and `HEAD`. Other methods get `405` with `Allow: GET, HEAD`, matching the method policy already used by `/dns-query`.
- The comment on `validateDNSResponse()` said lenient mode is what cache-TTL computation needs. Every production caller passes an expected ID and the query, so production always runs in strict mode; lenient mode is exercised by the unit tests. The comment now says so.
- The README's negative-caching rule now matches the code: a `NOERROR` answer that carries answer records is cached by its lowest answer TTL, with or without an SOA record. `NXDOMAIN` and `NODATA` are cached only when they carry an SOA record.

### Verified

- Unit suite: 57 tests, all passing.
- Integration suite passes, including the new `405` and `HEAD` assertions. Those assertions fail against the 0.4.35 `Worker.js`.
- Not run here: `npm run test:wrangler`, which needs Wrangler installed locally.
