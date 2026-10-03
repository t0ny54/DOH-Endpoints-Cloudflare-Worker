# 🛡️ DoH — Cloudflare Worker

**Version 0.4.2** · see [`CHANGELOG.md`](CHANGELOG.md)

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

Only DNS answers that are safe to reuse are cached: `NOERROR` and `NXDOMAIN` responses that are not truncated (TC) and are at most 65,535 bytes. Negative answers (`NXDOMAIN`/`NODATA`) are cached only when they carry an SOA record, using `min(SOA TTL, SOA MINIMUM)` per RFC 2308. `SERVFAIL`, `REFUSED` and similar responses are relayed to the client (marked `x-dns-degraded: 1`) but never cached.

Responses cached internally use DNS TTL-derived expiration. The response transaction ID is rewritten for each client, and cached DNS record TTLs are reduced by cache age before being returned. `Cache-Control: no-store` remains on the client-facing response so the Worker controls the DNS cache instead of creating an uncontrolled browser/HTTP cache layer.

### Rate limiting

`/dns-query` is limited to **100 requests per 60 seconds per client IP** through the native `DNS_RATE_LIMITER` binding in `wrangler.toml`. A lightweight per-isolate fallback limiter (bounded to 2048 IPs, evicting the least recently seen) is used when the binding is missing, throws, or returns an invalid response (the request is then limited locally rather than rejected or allowed unconditionally). Cloudflare documents the native Rate Limiting API as low-latency; its counters are scoped to the relevant Cloudflare location rather than being one globally exact counter.

### Request-size protection

DoH DNS messages are normally tiny, so this Worker rejects client messages larger than 4 KiB. It checks `Content-Length` before reading a POST when available and also stream-limits chunked/unknown-length bodies. Upstream resolver responses are independently capped at **65,535 bytes** (the DNS wire-format maximum) and are stream-limited before buffering. These limits avoid spending memory/CPU on oversized abuse traffic while still allowing large legitimate DNSSEC/EDNS answers.

## Deploy with Wrangler

The repository includes `wrangler.toml` with the service name `dns`, `compatibility_date = "2026-09-01"` and a `DNS_RATE_LIMITER` binding configured for **100 requests / 60 seconds**. With Wrangler, deploy from the folder containing `Worker.js` and `wrangler.toml` so the binding is created/used. Keep the rate-limit namespace unique if this service must not share counters with another deployment. If the Worker is uploaded through a method that does not apply the Wrangler binding, the script falls back to an in-memory per-isolate limiter.

For strict network-wide abuse protection, a Cloudflare WAF Rate Limiting Rule can also be applied to `/dns-query`. Cloudflare notes that rate-limit counters are not globally shared across its entire network, so neither the native binding nor WAF should be treated as one globally exact counter.

```bash
npx wrangler deploy
```

## Endpoint

After deployment:

```txt
https://YOUR-DOMAIN.example/dns-query
```

The Worker also serves a small dashboard at `/` (it loads Tailwind from `cdn.tailwindcss.com`; the DoH endpoint itself has no external dependency) and a JSON status page at `/health`.

## DoH methods

### GET

Standard RFC 8484-style GET requests use the `dns` base64url query parameter:

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

Known name-bearing RDATA is validated within each RR's `RDLENGTH`. In particular, SOA requires both domain names plus exactly 20 octets of numeric fields, and the parser rejects SOA names that cross their RDATA boundary. Common DNSSEC and modern record formats (AAAA, DS, DNSKEY, RRSIG, NSEC, NSEC3, SVCB/HTTPS, MX, SRV, NAPTR and related name-bearing types) receive structural checks; unknown/private types remain opaque after their owner name and RDATA length have been proven valid.

Upstream failure handling distinguishes timeout, HTTP-status, incompatible content-type, oversized-body, invalid-DNS, and generic/network failures for resolver scoring. A chunked upstream body is stream-limited before buffering, and timed-out resolvers are counted separately from ordinary failures.

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

The unit suite (28 tests) covers DNS wire parsing, strict compression-pointer validation, all RR sections, name-bearing RDATA, SOA structure/compression boundaries, TTL/cacheability rules, IPv6/other RR types, DNSSEC-heavy responses, L1 expiration/LRU eviction, resolver scoring, NXDOMAIN-vs-NOERROR race timing, L2-to-L1 promotion expiry, single-pass DNS name scanning (pointer loops/forward pointers), local rate-limiter LRU eviction, and cache-key normalization.

The integration suite exercises the exported Worker `fetch()` handler for routing, GET/POST DoH, request validation, L1/L2 caching, expired L2 entries, transaction-ID restoration, request coalescing, the `MAX_INFLIGHT_ENTRIES` saturation path, native/local rate limiting, malformed/throwing rate-limit bindings, HTTP/content-type/timeout/oversized-chunked upstream failures, cache API failures, and size protections.

`wrangler-smoke.mjs` starts the actual local Wrangler `dev` runtime (Cloudflare's `workerd` through Wrangler/Miniflare), then probes `/health`, `/`, an invalid DoH request, and an unsupported method without contacting the public DoH upstreams. The Rate Limiting binding is locally simulated during `wrangler dev`; it is not a test of production-wide Cloudflare counters. See the [Cloudflare local-development documentation](https://developers.cloudflare.com/workers/local-development/) and [Rate Limiting API documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

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

The `/health` endpoint reports the version, the three configured resolver scores and counters, the parallel-race strategy, rate-limit settings, plus L1/L2 cache and in-flight state. Resolver scores are informational and used only to break ties between degraded (SERVFAIL/REFUSED) answers; they do not change which upstreams are queried.


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
