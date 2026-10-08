# 🛡️ DoH — Cloudflare Worker

**Version 0.4.6** · see [`CHANGELOG.md`](CHANGELOG.md)

A lightweight Cloudflare Worker that exposes a standard **DNS-over-HTTPS** endpoint, races three configured DoH upstreams in parallel, and keeps a two-level DNS cache:

```txt
L1: per-isolate memory cache
L2: Cloudflare Cache API (data-center-local)
```

The three configured DoH upstreams are listed in [Configured upstreams](#-configured-dns-over-https-upstreams).


### Cloudflare limits and how this build uses them

Cloudflare's current Workers Free limits are 100,000 requests/day, 10 ms CPU time/invocation, 128 MB memory, 50 subrequests/invocation, and 6 simultaneous outgoing connections per invocation. Free requests reset at midnight UTC. Cache API calls are also counted against the subrequest quota, with 50 Cache API calls/request on Free. See the Cloudflare Workers Limits documentation.

This Worker deliberately stays far below those ceilings on ordinary DNS traffic:

| Path | Cache API | configured DoH upstreams |
|---|---:|---:|
| L1 cache hit | 0 | 0 |
| L2 cache hit | 1 | 0 |
| Cold cache miss | 1 match + 1 async put (cacheable answers only) | 3 in parallel |
| Degraded upstream fallback | 1 match | 3 in parallel |
| Total upstream failure | 1 match | 3 in parallel; returns 502 |

The resolver logic launches all three configured upstreams immediately on every cold-cache lookup (`UPSTREAM_TIMEOUT_MS`, 1200 ms per upstream). The first valid `NOERROR` response wins, and the other in-flight upstream requests are aborted. If the first usable answer is `NXDOMAIN`, the Worker keeps racing for a short grace period (`NXDOMAIN_GRACE_MS`, 200 ms) so a single stale or filtered upstream cannot cause false negatives. If every upstream returns a syntactically valid degraded response such as `SERVFAIL` or `REFUSED`, the best degraded response is returned deterministically (SERVFAIL preferred, then the highest-scored upstream, then the fastest); if all three requests fail or return invalid DNS data, the Worker returns `502`. In-flight duplicate work is bounded at 128 entries (new cold resolutions are rejected with 503 when the map is full; live jobs are never evicted, so request coalescing is never broken mid-flight), and upstream response buffering is capped at 65,535 bytes. Maximum concurrent upstream connections from this Worker are 3, below Cloudflare's documented limit of 6.

### Two-level DNS cache

The Worker intentionally does **not** enable the global Workers Cache feature in `wrangler.toml`. That feature can return a cached response without executing the Worker, which would put the cache in front of the `/dns-query` rate limiter. Instead, the Worker uses the Cache API after rate limiting, so every `/dns-query` request still reaches the rate-limit check.

The Cache API is data-center-local and does not replicate entries automatically between data centers. It is also generally not effective on `*.workers.dev` hostnames, so deploy on a custom domain/route to get L2 hits; on `workers.dev` the Worker still works and simply relies on L1 plus upstream resolution. That is still useful for hot DNS traffic because repeated queries at the same edge location can avoid an upstream lookup entirely.

Both DoH GET and POST requests use the SHA-256-derived DNS wire-query key, with only the transaction ID normalized. ASCII QNAME case is also normalized when the question name is uncompressed, so `example.com`, `EXAMPLE.com`, and mixed-case variants can share a cache entry. Therefore the same DNS question can share a cache entry across GET and POST. When a cached answer is served, the question section is rewritten to the exact letter case the requesting client sent, so DNS 0x20-style case randomization still validates.

Only DNS answers that are safe to reuse are cached: `NOERROR` and `NXDOMAIN` responses that are not truncated (TC) and are at most 65,535 bytes. Negative answers (`NXDOMAIN`/`NODATA`) are cached only when they carry an SOA record. The negative cache TTL is the lowest TTL in the authority section, capped by the SOA `MINIMUM` field, so it is never longer than the RFC 2308 value `min(SOA TTL, SOA MINIMUM)`. If the answer section is not empty (for example the CNAME chain in front of an `NXDOMAIN`, or a CNAME that ends in `NODATA`), the lowest answer TTL bounds the cache lifetime as well, so a cached CNAME is never served past its own TTL. For an ordinary positive answer the TTL is the lowest answer-section TTL. Following RFC 2181 §8, a TTL with the most significant bit set (above 2,147,483,647) is treated as 0, so an answer carrying one is relayed but not cached. The same rule applies when a cached answer is aged for a client: a record whose TTL has the top bit set (for example a CNAME in a cached NXDOMAIN, or an additional-section record) is returned with TTL 0 instead of being counted down from about 136 years. `SERVFAIL`, `REFUSED` and similar responses are relayed to the client (marked `x-dns-degraded: 1`) but never cached.

Responses cached internally use DNS TTL-derived expiration. The response transaction ID is rewritten for each client, and cached DNS record TTLs are reduced by cache age before being returned. `Cache-Control: no-store` remains on the client-facing response so the Worker controls the DNS cache instead of creating an uncontrolled browser/HTTP cache layer.

### Rate limiting

`/dns-query` is limited to **100 requests per 60 seconds per client IP** through the native `DNS_RATE_LIMITER` binding in `wrangler.toml`. A lightweight per-isolate fallback limiter (bounded to 2048 IPs, evicting the least recently seen) is used when the binding is missing, throws, or returns an invalid response (the request is then limited locally rather than rejected or allowed unconditionally). Cloudflare documents the native Rate Limiting API as low-latency; its counters are scoped to the relevant Cloudflare location rather than being one globally exact counter.

### Request-size protection

DoH DNS messages are normally tiny, so this Worker rejects client messages larger than 4 KiB. It checks `Content-Length` before reading a POST when available and also stream-limits chunked/unknown-length bodies. Upstream resolver responses are independently capped at **65,535 bytes** (the DNS wire-format maximum) and are stream-limited before buffering. These limits avoid spending memory/CPU on oversized abuse traffic while still allowing large legitimate DNSSEC/EDNS answers.

## Deploy with Wrangler

The repository includes `wrangler.toml` with the service name `dns`, `compatibility_date = "2026-09-01"` and a `DNS_RATE_LIMITER` binding configured for **100 requests / 60 seconds**. With Wrangler, deploy from the folder containing `Worker.js` and `wrangler.toml` so the binding is created/used. Keep the rate-limit namespace unique if this service must not share counters with another deployment. The `limit`/`period` in `wrangler.toml` and `RATE_LIMIT_MAX_REQUESTS`/`RATE_LIMIT_WINDOW_MS` in `Worker.js` (used only by the fallback limiter) are separate settings: change them together so both limiters agree. If the Worker is uploaded through a method that does not apply the Wrangler binding, the script falls back to an in-memory per-isolate limiter.

For strict network-wide abuse protection, a Cloudflare WAF Rate Limiting Rule can also be applied to `/dns-query`. Cloudflare notes that rate-limit counters are not globally shared across its entire network, so neither the native binding nor WAF should be treated as one globally exact counter.

```bash
npx wrangler deploy
```

## Endpoint

After deployment:

```txt
https://YOUR-DOMAIN.example/dns-query
```

The Worker also serves a small English/Persian/Chinese setup dashboard at `/` (also reachable as `/index.html`; it loads Tailwind from `cdn.tailwindcss.com`, while the DoH endpoint itself has no external dependency) and a JSON status page at `/health`. The dashboard is served with `Content-Security-Policy` (scripts only from itself, inline scripts and `cdn.tailwindcss.com`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: public, max-age=300`.

## DoH methods

### GET

Standard RFC 8484-style GET requests use the `dns` base64url query parameter. The value must be unpadded (no trailing `=`) and at most 5,462 characters; padded or otherwise invalid values are rejected with `400`, oversized ones with `413`:

```txt
/dns-query?dns=BASE64URL_DNS_PACKET
```

### POST

Send the raw DNS wire-format packet with:

```txt
Content-Type: application/dns-message
```

## Cloudflare Worker notes

The L1 cache is a per-isolate LRU (512 entries, TTL capped at 300 s). L2 Cache API entries can honor authoritative TTLs up to 24 hours, reducing unnecessary upstream resolutions for long-lived DNS records. An L2 hit is promoted to L1 for at most its remaining DNS lifetime (capped at 300 s from the moment of promotion, and never beyond the entry's true DNS expiry), so old L2 entries still warm L1. Correctness never depends on the Cache API: if L2 is unavailable, misses, or fails, requests fall through to the upstream resolvers. Expired isolate-local cache and throttle entries are swept periodically so `/health` does not retain stale bounded state indefinitely.

For a production deployment, attach the Worker to a custom domain and use:

```txt
https://dns.yourdomain.com/dns-query
```

`/health` is public and unauthenticated. It exposes resolver scores and cache counters but no client data; restrict it with a WAF rule if you prefer not to publish it.

## Hardening coverage

This build treats upstream DNS as untrusted input. Every resource-record owner name is parsed, and when a compression context is available, a pointer must target a previously observed label boundary rather than a forward/header offset. Expanded names are capped at the DNS 255-octet limit.

The question section of every upstream response must match the client's query byte for byte on the wire, ignoring only ASCII letter case (so 0x20 randomization still validates) and including the exact label structure, QTYPE and QCLASS.

Known name-bearing RDATA is validated within each RR's `RDLENGTH`. In particular, SOA requires both domain names plus exactly 20 octets of numeric fields, and the parser rejects SOA names that cross their RDATA boundary. Common DNSSEC and modern record formats (AAAA, DS, DNSKEY, RRSIG, NSEC, NSEC3, SVCB/HTTPS, MX, SRV, NAPTR and related name-bearing types) receive structural checks; unknown/private types remain opaque after their owner name and RDATA length have been proven valid.

Upstream failure handling classifies every failure as `timeout`, `http` (HTTP status), `content-type` (incompatible content type), `response-too-large`, `dns-invalid` or `network` (connection-level `fetch()` errors and body-stream errors), and `/health` reports the last kind per upstream as `lastErrorKind` (a degraded SERVFAIL/REFUSED answer records `lastError` as `DNS RCODE n` with no kind). For scoring, a timeout costs 8 points and is counted in `timeout` rather than `fail`; every other failure, including a degraded RCODE answer, costs 12 and is counted in `fail`; a usable NOERROR/NXDOMAIN answer earns 1 point (score range 0-100).

Cache behavior is defensive at both levels: expired L1 entries are removed before use, L1 is true LRU, live in-flight resolutions are never evicted, expired L2 entries fall through to resolution, and exceptions from `caches.default.match()` / `put()` or malformed/throwing rate-limit bindings do not break DNS resolution.

## Testing

Run the included unit tests, Worker-level integration tests, and the optional real `wrangler dev` smoke test:

```bash
npm install   # Node.js >= 20
npm test
npm run test:wrangler
# or:
npm run test:all
```

The integration and smoke tests read the expected version from `package.json` and compare it with `/health`, so a release only needs `package.json` and the `VERSION` constant in `Worker.js` to be bumped together.

The unit suite (36 tests) covers DNS wire parsing, strict compression-pointer validation, all RR sections, name-bearing RDATA, SOA structure/compression boundaries, TTL/cacheability rules (including the negative-cache TTL of lowest authority TTL capped by SOA `MINIMUM`, answer-section CNAME TTLs bounding NXDOMAIN/NODATA answers, and RFC 2181 top-bit TTLs), response patching (transaction ID, TTL aging, question-case restoration, top-bit TTLs aged as 0), IPv6/other RR types, DNSSEC-heavy responses, L1 expiration/LRU eviction, resolver scoring, upstream failure classification (timeout, HTTP, content-type, oversized body, network), NXDOMAIN-vs-NOERROR race timing, attempt counting and loser handling in the race, L2-to-L1 promotion expiry, DNS name scanning (pointer loops/forward pointers), local rate-limiter LRU eviction, wire-level question matching (case-insensitive, label structure must match), degraded-answer ranking (SERVFAIL, then score, then latency), and cache-key normalization.

The integration suite exercises the exported Worker `fetch()` handler for routing, GET/POST DoH, request validation, L1/L2 caching, expired L2 entries, transaction-ID restoration, request coalescing, the `MAX_INFLIGHT_ENTRIES` saturation path, native/local rate limiting, malformed/throwing rate-limit bindings, degraded `SERVFAIL` answers (relayed with `x-dns-degraded: 1` and never cached), HTTP/content-type/timeout/oversized-chunked/connection-level upstream failures (including the `lastErrorKind` values reported by `/health`), cache API failures, and size protections.

`wrangler-smoke.mjs` starts the actual local Wrangler `dev` runtime (Cloudflare's `workerd` through Wrangler/Miniflare), then probes `/health`, `/`, an invalid DoH request, and an unsupported method without contacting the public DoH upstreams. On Linux/macOS it stops the whole Wrangler process group when it finishes; on Windows it runs through a shell and ends the whole process tree with `taskkill /T /F`, so no `workerd` process is left behind. If Wrangler cannot start or exits early, the script fails immediately and prints Wrangler's output instead of waiting for the 20-second startup timeout. The Rate Limiting binding is locally simulated during `wrangler dev`; it is not a test of production-wide Cloudflare counters. See the [Cloudflare local-development documentation](https://developers.cloudflare.com/workers/local-development/) and [Rate Limiting API documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

A healthy request should return:

```txt
HTTP 200
Content-Type: application/dns-message
```

Useful response headers include:

```txt
x-cache: L1-HIT / L2-HIT / COALESCED / MISS
x-edge-cache: HIT / MISS / SKIP / DISABLED
x-upstreams: 0 (cache/coalesced) or 3 (every cold lookup races all three)
x-winner: <upstream-url>
x-winner-lat: <latency>
x-dns-degraded: 1   (only when the answer is SERVFAIL/REFUSED/etc.)
```

The `/health` endpoint reports the version, the three configured resolver scores, counters and last error (`lastError`, `lastErrorKind`), the parallel-race strategy, rate-limit settings, plus L1/L2 cache and in-flight state. Resolver scores are informational and used only to break ties between degraded (SERVFAIL/REFUSED) answers; they do not change which upstreams are queried.


## Important limitation

This is **DNS encryption**, not a VPN. It protects DNS traffic between the client and this Worker, but it does not hide destination IP addresses or guarantee bypass of IP, SNI, TLS, QUIC, or other network-level filtering.

## Credits

Based on [Secure DNS over HTTPS Cloudflare Worker](https://github.com/TheGreatAzizi/Secure-DNS-over-HTTPS-Cloudflare-Worker) by M.M.Azizi (MIT).

## 🌐 Configured DNS-over-HTTPS Upstreams

The Worker uses these three DoH endpoints simultaneously for each uncached DNS lookup:

| # | DNS-over-HTTPS (DoH) upstream |
| :---: | :--- |
| 1 | `https://freedns.koyeb.app/dns-query` |
| 2 | `https://dns-pi.vercel.app/api/doh/dns-query` |
| 3 | `https://dns.mydoh.workers.dev/dns-query` |


## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
