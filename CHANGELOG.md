# Changelog

## 0.4.19

### Changed
- Removed redundant code only; no behavior change. The POST `content-type` check now reuses the shared media-type helper instead of a second hand-written parser, and the unreachable "no query bytes" shortcut in the upstream question matcher is gone (every caller supplies the query).
- Dropped the meaningless `Vary: Accept-Encoding` header from `Cache-Control: no-store` DNS responses.
- Merged the three duplicated result constructions at the end of the upstream race into one, and removed a dead non-finite-age guard in TTL aging (callers always pass a finite age). A too-short buffer is now returned before any byte is written.
- The dashboard response headers are built once at load time instead of on every request.

### Verified
- Read and audited every file (Worker.js, tests, integration, smoke script, config, docs); a scan found no unused functions, constants or config keys, and no functional bugs.
- `npm test`: 43 unit tests and the Worker integration suite pass.
