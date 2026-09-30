# 🛡️ DoH Cloudflare Worker

A lightweight Cloudflare Worker that exposes a standards-compatible **DNS-over-HTTPS (DoH)** endpoint at `/dns-query`.

The current Worker is **v0.3.0** and provides:

- DoH **GET** (`?dns=...`) and **POST** (`application/dns-message`)
- Three configured DoH upstream resolvers raced in parallel
- Validation of upstream DNS IDs, flags, questions, resource records, and trailing bytes
- NXDOMAIN grace handling to reduce false-negative caching
- Deterministic degraded-response fallback (`SERVFAIL` preferred)
- Two-level DNS caching:
  - **L1:** per-isolate in-memory LRU
  - **L2:** Cloudflare Cache API, data-center-local
- Request coalescing for identical concurrent cache misses
- Native Cloudflare Rate Limiting binding with a per-isolate fallback
- 4 KiB client DNS-message limit
- 65,535-byte upstream DNS-response limit
- DNS TTL-aware cache expiry and response TTL aging
- Per-client transaction-ID restoration and QNAME case restoration
- Public `/health` endpoint
- Small configuration dashboard at `/`

> **Current source of truth:** `Worker.js`, `wrangler.toml`, and `test.mjs`. This README describes the implementation in this ZIP.

---

## Endpoints

After deployment, the Worker exposes:

```text
https://YOUR-DOMAIN.example/
https://YOUR-DOMAIN.example/dns-query
https://YOUR-DOMAIN.example/health
```

### `/dns-query`

The DoH resolver endpoint.

### `/`

A small setup dashboard showing the current `/dns-query` URL and browser/mobile configuration guidance.

### `/health`

Returns resolver scores/counters and bounded runtime state such as cache, in-flight, and rate-limit entry counts. It does not expose client IPs or DNS query contents.

---

## Configured upstreams

Every cold DNS lookup starts all three configured upstreams in parallel:

| # | DoH upstream |
|---:|---|
| 1 | `https://freedns.koyeb.app/dns-query` |
| 2 | `https://dns-pi.vercel.app/api/doh/dns-query` |
| 3 | `https://dns.mydoh.workers.dev/dns-query` |

The first valid `NOERROR` response wins. Losing requests are aborted when the runtime supports the abort signal correctly.

If an upstream returns `NXDOMAIN`, the Worker holds that candidate for `NXDOMAIN_GRACE_MS` (currently **200 ms**) while waiting for a possible valid `NOERROR` from another upstream.

If no `NOERROR` is available but a syntactically valid degraded response is available, the Worker returns the degraded response deterministically. `SERVFAIL` is preferred; otherwise resolver score and then latency are used.

If every upstream fails or returns invalid DNS data, the Worker returns **HTTP 502**.

---

## DNS validation and safety limits

### Client requests

- Only `GET` and `POST` are accepted.
- GET requires the `dns` base64url query parameter.
- POST requires `Content-Type: application/dns-message`.
- Client DNS messages are limited to **4,096 bytes**.
- GET DNS payloads are limited to **5,462 base64url characters**.
- Chunked/unknown-length POST bodies are stream-limited instead of being buffered without a cap.
- DNS queries must contain exactly one question and no answer/authority records.
- Additional records are structurally parsed and arbitrary trailing bytes are rejected.

### Upstream responses

Each upstream response is checked for:

- Minimum DNS message size
- Matching transaction ID
- DNS response bit
- Opcode 0
- Exactly one question
- Matching QNAME, QTYPE, and QCLASS
- Structurally valid resource records in answer/authority/additional sections
- No trailing bytes
- Compatible `Content-Type`, when supplied
- Maximum buffered response size of **65,535 bytes**

These checks prevent malformed or unrelated HTTP/DNS data from being accepted as resolver answers.

---

## Cache architecture

```text
                 ┌─────────────────────┐
DoH request ───► │ Rate limiter        │
                 └─────────┬───────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │ Parse + validate    │
                 └─────────┬───────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │ L1 isolate LRU      │
                 │ max 512 entries     │
                 └─────────┬───────────┘
                           │ miss
                           ▼
                 ┌─────────────────────┐
                 │ L2 Cache API        │
                 │ data-center-local   │
                 └─────────┬───────────┘
                           │ miss
                           ▼
                 ┌─────────────────────┐
                 │ 3-way DoH race      │
                 └─────────────────────┘
```

### L1

The isolate-local cache contains up to **512 entries**. Local cache TTL is capped at **300 seconds**.

### L2

The Cloudflare Cache API can retain cacheable DNS responses for up to **86,400 seconds (24 hours)**, subject to the authoritative DNS TTL and Cloudflare cache behavior.

Cache API contents are **data-center-local**; they are not automatically replicated globally. Cloudflare currently documents Cache API operations as functional for Workers attached to custom domains/routes, while `workers.dev` deployments do not provide functional Cache API operations. Deploy on a custom domain or route if L2 caching is required. https://developers.cloudflare.com/workers/runtime-apis/cache/

The Worker intentionally performs the `/dns-query` rate-limit check **before** its Cache API lookup, so the L2 cache cannot bypass that application-level limiter.

### Cache key

The cache key is SHA-256-derived from the complete DNS wire query with:

- Transaction ID normalized to zero
- Uncompressed ASCII QNAME case normalized to lowercase

Therefore equivalent GET and POST DNS questions can share a cache entry.

When a cached response is returned, the Worker:

1. Restores the requesting transaction ID.
2. Restores the requesting QNAME letter case when safely possible.
3. Reduces DNS record TTLs by cache age.

### Cacheable responses

Only non-truncated `NOERROR` and `NXDOMAIN`/negative responses that satisfy the DNS TTL rules are cached.

- Positive answers use the minimum relevant answer TTL.
- `NXDOMAIN` and NODATA require an SOA and use the RFC 2308-style minimum of SOA TTL and SOA MINIMUM.
- `SERVFAIL`, `REFUSED`, malformed responses, and truncated responses are not cached.
- EDNS OPT records are not treated as DNS answer TTLs.

---

## Request coalescing

Identical cold-cache requests are coalesced inside the Worker isolate so a burst of the same DNS query does not start multiple independent upstream races.

The in-flight map is bounded at **128 entries**. Live jobs are never evicted. When the bound is reached, a new cold resolution receives:

```text
HTTP 503
Retry-After: 1
```

A failed shared resolution is converted to the normal **HTTP 502** upstream-failure response for all waiting clients.

---

## Rate limiting

The preferred configuration is the native Cloudflare `DNS_RATE_LIMITER` binding:

```toml
[[ratelimits]]
name = "DNS_RATE_LIMITER"
namespace_id = "1001"

[ratelimits.simple]
limit = 100
period = 60
```

The Worker calls the binding with the Cloudflare-provided `CF-Connecting-IP` as the key.

If the binding is missing, throws, or returns an invalid result, the Worker falls back to an isolate-local fixed-window limiter of **100 requests per 60 seconds per client IP**.

Cloudflare's current Rate Limiting API documentation specifies `namespace_id` as a string and allows a `simple.period` of 10 or 60 seconds. It also notes that using IP addresses can unintentionally group users behind shared networks. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

For stronger network-wide abuse controls, a Cloudflare WAF rate-limiting rule can be added separately.

---

## Cloudflare limits and this Worker

Current Cloudflare Workers documentation lists these Workers Free limits:

| Resource | Workers Free |
|---|---:|
| Requests | 100,000/day |
| CPU time | 10 ms/request |
| Memory | 128 MB/isolate |
| Subrequests | 50/request |
| Simultaneous open connections | 6/request |
| Cache API calls | 50/request |

This Worker normally starts **3 upstream fetches** for a cold lookup and performs at most one L2 `match()` plus one asynchronous L2 `put()` for a cacheable miss. Thus the configured upstream race stays below the documented six simultaneous open-connection limit. https://developers.cloudflare.com/workers/platform/limits/

Cloudflare's limits can change by plan and over time; consult the current documentation before relying on a limit for capacity planning.

---

## Deployment

The included `wrangler.toml` currently defines:

```toml
name = "dns"
main = "Worker.js"
compatibility_date = "2026-09-26"
```

It also defines the `DNS_RATE_LIMITER` binding shown above.

Deploy from the project directory:

```bash
npx wrangler deploy
```

The deployed Worker name is **`dns`**, not `secure-doh-worker`.

### Recommended production endpoint

Use a custom domain or Worker route, for example:

```text
https://dns.example.com/dns-query
```

Cloudflare recommends custom domains or routes for production Workers rather than relying on `workers.dev`. https://developers.cloudflare.com/workers/configuration/routing/

---

## DoH usage

### GET

RFC 8484-style GET requests use the `dns` base64url query parameter:

```text
/dns-query?dns=BASE64URL_DNS_PACKET
```

Example shape:

```bash
curl 'https://YOUR-DOMAIN.example/dns-query?dns=BASE64URL_DNS_PACKET' \
  -H 'Accept: application/dns-message'
```

### POST

Send the raw DNS wire-format message:

```bash
curl --data-binary @query.bin \
  -H 'Content-Type: application/dns-message' \
  -H 'Accept: application/dns-message' \
  'https://YOUR-DOMAIN.example/dns-query'
```

Successful DoH responses use:

```text
HTTP 200
Content-Type: application/dns-message
Cache-Control: no-store
```

The Worker deliberately uses `Cache-Control: no-store` on client-facing DNS responses because DNS caching is controlled by the Worker itself.

---

## Response headers

Useful diagnostic headers include:

```text
x-cache: L1-HIT | L2-HIT | COALESCED | MISS
x-edge-cache: HIT | MISS | SKIP | DISABLED
x-upstreams: 0 | 1 | 2 | 3
x-winner: <upstream-url>
x-winner-lat: <latency>ms
x-dns-degraded: 1
```

`x-dns-degraded: 1` is present when a valid but degraded DNS response such as `SERVFAIL` or `REFUSED` is returned.

---

## Health endpoint

`GET /health` returns information such as:

- Worker version
- Configured upstream URLs
- Resolver score, success/failure counters, and latency information
- L1 cache entry count
- In-flight resolution count
- Local throttle entry count
- Rate-limit configuration
- Maximum upstream DNS message size
- Cache strategy and TTL caps
- Maximum simultaneous configured upstreams

It is public and unauthenticated. If exposing resolver telemetry is undesirable, protect `/health` with an appropriate Cloudflare access/WAF rule.

---

## Testing

The repository contains both unit tests and mocked Worker-level integration tests.

Run the complete test suite:

```bash
node --test test.mjs
```

Syntax-check the Worker separately:

```bash
node --check Worker.js
```

The current suite covers **23 tests**, including:

- DNS query parsing
- DNS name compression and malformed-name handling
- Upstream response validation
- Transaction-ID and QNAME matching
- Positive and negative DNS cache TTL calculation
- Truncated/degraded response cache exclusion
- Resolver scoring and degraded fallback selection
- GET/POST cache-key equivalence
- L1 cache hits and TTL aging
- L2 Cache API hits
- Parallel three-upstream racing
- NXDOMAIN grace behavior
- Upstream failure and HTTP 502 handling
- Concurrent request coalescing and failed shared jobs
- Native rate-limit binding behavior
- Local fallback rate limiting
- DoH method/content-type/size validation
- `/`, `/health`, and 404 routing

The test suite mocks upstream networking and the Cache API; it does **not** prove that the three public upstream services are currently reachable from Cloudflare's network. A real deployment smoke test should therefore query `/dns-query` after deployment.

### Deployment smoke test

After deployment, verify:

```bash
curl -i 'https://YOUR-DOMAIN.example/health'
```

Then issue a real DNS wire query through `/dns-query` using a DoH-capable client.

---

## Dashboard

The root dashboard is generated directly by `Worker.js` and currently supports:

- English
- Persian
- Simplified Chinese
- Copy-to-clipboard endpoint button
- Chromium setup guidance
- Firefox setup guidance
- Android/iOS guidance

The dashboard is informational; it does not change Worker resolver configuration.

---

## Important limitation

This is **DNS encryption, not a VPN**.

The Worker protects the DNS exchange between the client and the DoH endpoint. It does not by itself hide destination IP addresses or guarantee bypass of IP, SNI, TLS, QUIC, routing, or other network-level filtering.

---

## Project files

```text
DOH-Endpoints-Cloudflare-Worker-main/
├── Worker.js      # Cloudflare Worker implementation
├── wrangler.toml  # Wrangler + rate-limit configuration
├── test.mjs       # Unit + Worker-level mocked integration tests
├── README.md      # Project documentation
└── LICENSE        # MIT license
```

---

## Credits

Based on [Secure DNS over HTTPS Cloudflare Worker](https://github.com/TheGreatAzizi/Secure-DNS-over-HTTPS-Cloudflare-Worker) by M.M. Azizi (MIT).

## License

See [`LICENSE`](LICENSE).
