const VERSION = '0.4.33';
const MAX_DNS_MESSAGE_BYTES = 4096;
const CONFIG = {
  DNS_PATH: '/dns-query',
  EDGE_CACHE_ENABLED: true,
  EDGE_CACHE_PATH: '/__doh-cache/v1',
  LOCAL_CACHE_MAX_TTL_SECONDS: 300,
  EDGE_CACHE_MAX_TTL_SECONDS: 86_400,
  EDGE_CACHE_MIN_TTL_SECONDS: 1,
  MAX_CACHE_ENTRIES: 512,
  MAX_INFLIGHT_ENTRIES: 128,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX_REQUESTS: 100,
  MAX_THROTTLE_ENTRIES: 2048,
  STATE_SWEEP_INTERVAL_MS: 60_000,
  MAX_DNS_MESSAGE_BYTES,
  // Longest unpadded base64url string whose decoded length is at most MAX_DNS_MESSAGE_BYTES
  // (5,462 characters for 4,096 bytes). Derived, so the two limits cannot drift apart.
  MAX_GET_DNS_CHARS: Math.ceil((4 * (MAX_DNS_MESSAGE_BYTES + 1)) / 3) - 1,
  MAX_UPSTREAM_DNS_MESSAGE_BYTES: 65_535,
  UPSTREAM_TIMEOUT_MS: 1200,
  NXDOMAIN_GRACE_MS: 200,
  SCORE_START: 100,
  SCORE_MIN: 0,
  SCORE_MAX: 100,
  SCORE_SUCCESS_DELTA: 1,
  SCORE_FAILURE_DELTA: 12,
  SCORE_TIMEOUT_DELTA: 8
};
const DOH_UPSTREAMS = [
  'https://freedns.koyeb.app/dns-query',
  'https://dns-pi.vercel.app/api/doh/dns-query',
  'https://dns.mydoh.workers.dev/dns-query'
];
const RESOLVER_NODES = DOH_UPSTREAMS.map((url) => ({
  url,
  score: CONFIG.SCORE_START,
  ok: 0,
  fail: 0,
  timeout: 0,
  lastLatencyMs: null,
  ewmaLatencyMs: null,
  lastError: null,
  lastErrorKind: null
}));
const APP_STATE = {
  cache: new Map(),
  throttle: new Map(),
  inflight: new Map(),
  lastSweepAt: 0
};
export default {
  async fetch(req, env, ctx) {
    maybeSweepState();
    const url = new URL(req.url);
    if (url.pathname === CONFIG.DNS_PATH) {
      if (!(await allowDNSRequest(getClientIP(req), env))) {
        return textResponse('Rate limit exceeded', 429, {
          'cache-control': 'no-store',
          'retry-after': String(Math.ceil(CONFIG.RATE_LIMIT_WINDOW_MS / 1000))
        });
      }
      return handleDNS(req, url, ctx);
    }
    if (url.pathname === '/health') {
      return jsonResponse(getHealthSnapshot(), 200, {
        'cache-control': 'no-store'
      });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return renderUI(url.origin);
    }
    return textResponse('Not found', 404, { 'cache-control': 'no-store' });
  }
};
async function handleDNS(req, url, ctx) {
  const methodError = validateMethod(req.method);
  if (methodError) return methodError;
  let payload;
  try {
    payload = await readDNSPayload(req, url);
  } catch (err) {
    // Only deliberate httpError() messages are client-safe; anything else (for example a
    // body-stream failure) must not leak internal error text.
    return textResponse(err?.status ? err.message : 'Invalid DNS query', err?.status || 400, {
      'cache-control': 'no-store'
    });
  }
  const parsed = parseDNSQuestion(payload);
  if (!parsed.ok) {
    return textResponse(parsed.error, 400, { 'cache-control': 'no-store' });
  }
  // L1 and in-flight state use the exact normalized query bytes (no hash on the hot path, and
  // distinct questions can never share an entry). The L2 Cache API key is derived from the same
  // normalized buffer, so the query is normalized once per request.
  const normalized = normalizeQueryForKey(payload);
  const localKey = localKeyFromNormalized(normalized);
  const local = serveLocal(localKey, parsed, payload);
  if (local) return local;
  let edgeKey = null;
  if (CONFIG.EDGE_CACHE_ENABLED) {
    edgeKey = await edgeKeyFromNormalized(normalized);
    const edgeHit = await getEdgeCache(edgeKey, parsed.id, url.origin, payload);
    if (edgeHit) {
      const promotedTTL = cappedTTL(
        edgeHit.ttlSeconds - edgeHit.ageSeconds,
        CONFIG.LOCAL_CACHE_MAX_TTL_SECONDS
      );
      setCache(
        localKey,
        edgeHit.body,
        promotedTTL,
        edgeHit.storedAt,
        Math.min(
          edgeHit.storedAt + edgeHit.ttlSeconds * 1000,
          Date.now() + promotedTTL * 1000
        )
      );
      return dnsResponse(edgeHit.responseBody, {
        'x-cache': 'L2-HIT',
        'x-edge-cache': 'HIT',
        'x-upstreams': '0'
      });
    }
    // The L2 lookup above is asynchronous: another request may have finished (L1 filled,
    // in-flight entry removed) or started a lookup in the meantime.
    const raced = serveLocal(localKey, parsed, payload);
    if (raced) return raced;
  }
  if (APP_STATE.inflight.size >= CONFIG.MAX_INFLIGHT_ENTRIES) {
    return textResponse('Resolver busy, please retry', 503, {
      'cache-control': 'no-store',
      'retry-after': '1'
    });
  }
  const job = (async () => {
    const result = await resolveWithParallelRace(RESOLVER_NODES, payload, parsed.id);
    const storedAt = Date.now();
    // relay() already computed the cache TTL during its single-pass analysis.
    const ttlSeconds = result.cacheTTL;
    if (ttlSeconds > 0) {
      // The buffer is private to this job (fresh from relay()), so zero the ID in place.
      new Uint8Array(result.body).fill(0, 0, 2);
      const localTTL = cappedTTL(ttlSeconds, CONFIG.LOCAL_CACHE_MAX_TTL_SECONDS);
      setCache(
        localKey,
        result.body,
        localTTL,
        storedAt
      );
      if (CONFIG.EDGE_CACHE_ENABLED) {
        // putEdgeCache() never rejects, and it is started here whether or not a context exists.
        // waitUntil() only keeps it alive after the response is sent.
        const write = putEdgeCache(
          edgeKey,
          result.body,
          ttlSeconds, // already clamped to EDGE_CACHE_MIN/MAX_TTL_SECONDS during analysis
          storedAt,
          url.origin
        );
        ctx?.waitUntil?.(write);
      }
    }
    return { ...result, storedAt };
  })();
  APP_STATE.inflight.set(localKey, job);
  try {
    const result = await job;
    const responseBody = patchDNSResponseForAge(result.body, parsed.id, 0, payload);
    return dnsResponse(responseBody, winnerHeaders(result, {
      'x-cache': 'MISS',
      'x-edge-cache': CONFIG.EDGE_CACHE_ENABLED ? 'MISS' : 'DISABLED',
      'x-upstreams': String(result.attempts)
    }));
  } catch (err) {
    return upstreamFailureResponse(err);
  } finally {
    if (APP_STATE.inflight.get(localKey) === job) APP_STATE.inflight.delete(localKey);
  }
}
function serveLocal(key, parsed, queryBytes) {
  const hit = getCache(key);
  if (hit) return l1HitResponse(hit, parsed, queryBytes);
  const job = APP_STATE.inflight.get(key);
  return job ? joinInflight(job, parsed, queryBytes) : null;
}
function winnerHeaders(result, headers) {
  headers['x-winner'] = sanitizeHeaderValue(result.url);
  headers['x-winner-lat'] = `${result.latencyMs}ms`;
  if (result.degraded) headers['x-dns-degraded'] = '1';
  return headers;
}
function l1HitResponse(hit, parsed, queryBytes) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - hit.storedAt) / 1000));
  return dnsResponse(patchDNSResponseForAge(hit.body, parsed.id, ageSeconds, queryBytes), {
    'x-cache': 'L1-HIT',
    'x-edge-cache': 'SKIP',
    'x-upstreams': '0'
  });
}
async function joinInflight(job, parsed, queryBytes) {
  try {
    const shared = await job;
    return coalescedDNSResponse(shared, parsed, queryBytes);
  } catch (err) {
    return upstreamFailureResponse(err);
  }
}
function upstreamFailureResponse(err) {
  return textResponse('Global resolving failed', 502, {
    'cache-control': 'no-store',
    'x-upstreams': String(err?.attempts ?? RESOLVER_NODES.length)
  });
}
function coalescedDNSResponse(shared, parsed, queryBytes) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - shared.storedAt) / 1000));
  const responseBody = patchDNSResponseForAge(shared.body, parsed.id, ageSeconds, queryBytes);
  return dnsResponse(responseBody, winnerHeaders(shared, {
    'x-cache': 'COALESCED',
    'x-edge-cache': 'SKIP',
    'x-upstreams': '0'
  }));
}
function validateMethod(method) {
  if (method !== 'GET' && method !== 'POST') {
    return textResponse('Method not allowed', 405, {
      allow: 'GET, POST',
      'cache-control': 'no-store'
    });
  }
  return null;
}
async function readDNSPayload(req, url) {
  if (req.method === 'GET') {
    const q = url.searchParams.get('dns');
    if (!q) throw httpError('Missing dns query parameter', 400);
    if (q.length > CONFIG.MAX_GET_DNS_CHARS) {
      throw httpError('DNS query too large', 413);
    }
    return decodeBase64Url(q);
  }
  if (!isDNSMessageContentType(req.headers.get('content-type'))) {
    throw httpError('POST requires content-type: application/dns-message', 415);
  }
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > CONFIG.MAX_DNS_MESSAGE_BYTES) {
      throw httpError('DNS message too large', 413);
    }
  }
  return readCappedBody(
    req,
    CONFIG.MAX_DNS_MESSAGE_BYTES,
    () => httpError('DNS message too large', 413)
  );
}
// makeTooLarge() supplies the error to throw when the body exceeds maxBytes, so each caller
// keeps its own classification without a second try/catch.
async function readCappedBody(source, maxBytes, makeTooLarge) {
  const reader = source.body?.getReader();
  // Without a body there is no message to cap: an empty buffer is the whole answer.
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Release the stream without waiting on it: cancel() on a shared (tee'd) body settles
        // only after every branch is cancelled, and this request fails either way.
        reader.cancel('message-too-large').catch(() => {});
        throw makeTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  // Copy so the returned buffer is exactly message-sized (a pooled chunk may be a
  // subarray view of a larger buffer, and callers use `.buffer` downstream).
  if (chunks.length === 1) {
    const only = chunks[0];
    // A chunk that already spans its whole buffer needs no copy; the callers read `.buffer`.
    return only.byteOffset === 0 && only.byteLength === only.buffer.byteLength ? only : only.slice();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
// Callers cap the input at CONFIG.MAX_GET_DNS_CHARS first, which bounds the decoded length at
// MAX_DNS_MESSAGE_BYTES, so no separate size check is needed here.
function decodeBase64Url(input) {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw httpError('Invalid base64url DNS query', 400);
  }
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  let decoded;
  try {
    decoded = atob(normalized);
  } catch (_) {
    throw httpError('Invalid base64url DNS query', 400);
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
function parseDNSQuestion(bytes) {
  if (bytes.byteLength < 12) {
    return { ok: false, error: 'DNS message too short' };
  }
  const id = (bytes[0] << 8) | bytes[1];
  const flags = (bytes[2] << 8) | bytes[3];
  const qdcount = (bytes[4] << 8) | bytes[5];
  const ancount = (bytes[6] << 8) | bytes[7];
  const nscount = (bytes[8] << 8) | bytes[9];
  const arcount = (bytes[10] << 8) | bytes[11];
  if ((flags & 0x8000) !== 0) {
    return { ok: false, error: 'DNS query expected, got response' };
  }
  if ((flags & 0x7800) !== 0) {
    return { ok: false, error: 'Unsupported DNS opcode' };
  }
  if (qdcount !== 1 || ancount !== 0 || nscount !== 0) {
    return { ok: false, error: 'Invalid DNS query section counts' };
  }
  const nameContext = createDNSNameContext();
  const questionEnd = skipDNSName(bytes, 12, nameContext);
  if (questionEnd < 0 || questionEnd + 4 > bytes.length) {
    return { ok: false, error: 'Incomplete DNS question' };
  }
  let offset = questionEnd + 4;
  for (let i = 0; i < arcount; i++) {
    const rr = readResourceRecord(bytes, offset, nameContext);
    if (!rr) return { ok: false, error: 'Malformed additional record in DNS query' };
    offset = rr.rdEnd;
  }
  if (offset !== bytes.length) {
    return { ok: false, error: 'Unexpected trailing data in DNS query' };
  }
  return { ok: true, id };
}
async function resolveWithParallelRace(nodes, packet, expectedID) {
  if (!nodes.length) throw new Error('No upstreams configured');
  const controllers = new Map();
  const active = new Map();
  let fallback = null;
  let fallbackNode = null;
  let nxdomain = null;
  let nxdomainDeadline = 0;
  // A truncated (TC) answer is incomplete. It is kept only if no complete answer arrives.
  let partial = null;
  const startAttempt = (node) => {
    const controller = new AbortController();
    controllers.set(node, controller);
    const promise = relay(node, packet, expectedID, controller.signal)
      .then((value) => ({ ok: true, node, value }))
      .catch((error) => ({ ok: false, node, error }));
    active.set(node, promise);
  };
  for (const node of nodes) startAttempt(node);
  let graceTimer = null;
  const clearGrace = () => { if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; } };
  try {
    while (active.size) {
      let result;
      if (nxdomain) {
        const remainingMs = nxdomainDeadline - Date.now();
        if (remainingMs <= 0) break;
        clearGrace();
        const grace = new Promise((resolve) => { graceTimer = setTimeout(resolve, remainingMs); });
        result = await Promise.race([...active.values(), grace]);
        clearGrace();
      } else {
        result = await Promise.race(active.values());
      }
      if (!result) break; // grace window elapsed
      active.delete(result.node);
      if (result.ok) {
        const value = result.value;
        if (value.usable && value.truncated) {
          partial = partial || value;
          continue;
        }
        if (value.usable && value.rcode === 0) {
          return { ...value, attempts: nodes.length };
        }
        if (value.usable && value.rcode === 3) {
          if (!nxdomain) {
            nxdomain = value;
            nxdomainDeadline = Date.now() + CONFIG.NXDOMAIN_GRACE_MS;
          }
          continue;
        }
        if (!fallback || isBetterDegraded(value, result.node, fallback, fallbackNode)) {
          fallback = value;
          fallbackNode = result.node;
        }
      }
    }
    const best = nxdomain || partial || fallback;
    if (best) return { ...best, attempts: nodes.length };
    const err = new Error('All DNS upstreams failed');
    err.attempts = nodes.length;
    throw err;
  } finally {
    clearGrace();
    abortAttempts(controllers, active);
  }
}
function isBetterDegraded(value, node, bestValue, bestNode) {
  if (value.rcode !== bestValue.rcode) {
    if (value.rcode === 2) return true;
    if (bestValue.rcode === 2) return false;
  }
  if (node.score !== bestNode.score) return node.score > bestNode.score;
  if (value.latencyMs !== bestValue.latencyMs) return value.latencyMs < bestValue.latencyMs;
  // Exact tie: the earlier-configured upstream wins, so the choice never depends on arrival order.
  return RESOLVER_NODES.indexOf(node) < RESOLVER_NODES.indexOf(bestNode);
}
function abortAttempts(controllers, active) {
  for (const node of active.keys()) {
    try { controllers.get(node)?.abort('winner-selected'); } catch (_) {}
  }
}
function upstreamError(message, kind) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}
async function relay(node, packet, expectedID, signal) {
  const started = Date.now();
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort('timeout'), CONFIG.UPSTREAM_TIMEOUT_MS);
  const combinedSignal = combineSignals(signal, timeoutController.signal);
  try {
    const res = await fetch(node.url, {
      method: 'POST',
      headers: {
        accept: 'application/dns-message',
        'content-type': 'application/dns-message'
      },
      body: packet,
      signal: combinedSignal
    });
    if (!res.ok) {
      discardBody(res);
      throw upstreamError(`Upstream HTTP ${res.status}`, 'http');
    }
    const contentType = res.headers.get('content-type') || '';
    if (!isDNSMessageContentType(contentType)) {
      discardBody(res);
      throw upstreamError('Upstream returned an invalid content type', 'content-type');
    }
    const declaredLength = Number(res.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength)
      && declaredLength > CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES
    ) {
      discardBody(res);
      throw upstreamError('Upstream DNS response too large', 'response-too-large');
    }
    const bodyBytes = await readCappedBody(
      res,
      CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES,
      () => upstreamError('Upstream DNS response too large', 'response-too-large')
    );
    const body = bodyBytes.buffer;
    const validation = validateDNSResponse(body, expectedID, packet);
    if (!validation.ok) {
      throw upstreamError(validation.error, 'dns-invalid');
    }
    const latencyMs = Date.now() - started;
    const rcode = validation.rcode;
    const usable = rcode === 0 || rcode === 3;
    if (usable) {
      reward(node, latencyMs);
    } else {
      penalize(node, CONFIG.SCORE_FAILURE_DELTA, `DNS RCODE ${rcode}`);
    }
    return {
      url: node.url,
      body,
      latencyMs,
      rcode,
      usable,
      truncated: (bodyBytes[2] & 0x02) !== 0,
      degraded: !usable,
      cacheTTL: validation.cacheTTL
    };
  } catch (err) {
    const timeoutAbort = timeoutController.signal.aborted;
    if (signal?.aborted && signal.reason === 'winner-selected') throw err;
    if (timeoutAbort) {
      node.timeout += 1;
      penalize(node, CONFIG.SCORE_TIMEOUT_DELTA, 'timeout', false);
    } else {
      if (err && typeof err === 'object' && !err.kind) err.kind = 'network';
      penalize(node, CONFIG.SCORE_FAILURE_DELTA, err);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
function discardBody(res) {
  try { res.body?.cancel().catch(() => {}); } catch (_) {}
}
function isDNSMessageContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase() === 'application/dns-message';
}
function validateDNSResponse(responseBuffer, expectedID, queryBytes) {
  return analyzeDNSResponse(new Uint8Array(responseBuffer), expectedID, queryBytes);
}
// Single-pass DNS response analysis shared by validation and cache-TTL computation.
// Strict mode (a non-null expectedID or queryBytes) additionally pins the transaction
// ID, requires exactly one question matching the query on the wire, and rejects
// trailing bytes; lenient mode (both null) only walks the wire format, which is what
// cache-TTL computation needs. Either way the packet is parsed exactly once, so
// relaying, L2 reads, and cache writes never re-parse a packet that was analyzed.
function analyzeDNSResponse(bytes, expectedID, queryBytes) {
  const strict = expectedID !== null || queryBytes !== null;
  if (bytes.length < 12) {
    return { ok: false, error: 'Upstream returned short DNS response', rcode: 0, cacheTTL: 0 };
  }
  const id = (bytes[0] << 8) | bytes[1];
  const flags = (bytes[2] << 8) | bytes[3];
  const rcode = flags & 0x000f;
  if (strict && id !== expectedID) {
    return { ok: false, error: 'Upstream response ID mismatch', rcode, cacheTTL: 0 };
  }
  if ((flags & 0x8000) === 0) {
    return { ok: false, error: 'Upstream returned a DNS query, not response', rcode, cacheTTL: 0 };
  }
  if (strict && (flags & 0x7800) !== 0) {
    return { ok: false, error: 'Unexpected DNS opcode in upstream response', rcode, cacheTTL: 0 };
  }
  const qdcount = (bytes[4] << 8) | bytes[5];
  const ancount = (bytes[6] << 8) | bytes[7];
  const nscount = (bytes[8] << 8) | bytes[9];
  const arcount = (bytes[10] << 8) | bytes[11];
  if (strict && qdcount !== 1) {
    return { ok: false, error: 'Unexpected question count in upstream response', rcode, cacheTTL: 0 };
  }
  const nameContext = createDNSNameContext();
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    offset = skipDNSName(bytes, offset, nameContext);
    if (offset < 0 || offset + 4 > bytes.length) {
      return { ok: false, error: 'Malformed question in upstream response', rcode, cacheTTL: 0 };
    }
    if (strict && !questionMatchesQuery(bytes, offset, queryBytes)) {
      return { ok: false, error: 'Upstream response question does not match the query', rcode, cacheTTL: 0 };
    }
    offset += 4;
  }
  let answerMin = Infinity;
  let authorityMin = Infinity;
  let soaNegativeMin = Infinity;
  // RFC 6891 section 6.1.3: the top 8 bits of the OPT record's TTL extend the 4-bit header
  // RCODE. Only the first OPT record in the additional section counts.
  let extendedRcode = 0;
  let sawOPT = false;
  const authorityEnd = ancount + nscount;
  const rrTotal = authorityEnd + arcount;
  for (let i = 0; i < rrTotal; i++) {
    const rr = readResourceRecord(bytes, offset, nameContext);
    if (!rr) {
      return { ok: false, error: 'Malformed resource record in upstream response', rcode, cacheTTL: 0 };
    }
    offset = rr.rdEnd;
    if (rr.type === 41) {
      if (i >= authorityEnd && !sawOPT) {
        sawOPT = true;
        extendedRcode = rr.ttl >>> 24;
      }
      continue;
    }
    if (i >= authorityEnd) continue;
    const rrTTL = effectiveTTL(rr.ttl);
    if (i < ancount) {
      answerMin = Math.min(answerMin, rrTTL);
    } else {
      authorityMin = Math.min(authorityMin, rrTTL);
      if (rr.type === 6) {
        // readResourceRecord() already proved the SOA RDATA ends with its 20 numeric octets.
        soaNegativeMin = Math.min(soaNegativeMin, effectiveTTL(readUint32(bytes, rr.rdEnd - 4)));
      }
    }
  }
  if (strict && offset !== bytes.length) {
    return { ok: false, error: 'Trailing bytes in upstream response', rcode, cacheTTL: 0 };
  }
  const fullRcode = rcode | (extendedRcode << 4);
  let cacheTTL = 0;
  // Truncated (TC) answers and non-NOERROR/NXDOMAIN rcodes are relayed but never cached.
  if ((flags & 0x0200) === 0 && (fullRcode === 0 || fullRcode === 3)) {
    const negativeTTL = soaNegativeMin === Infinity ? Infinity : Math.min(authorityMin, soaNegativeMin);
    // A negative answer (NXDOMAIN/NODATA) needs an SOA; any answer-section records
    // (for example the CNAME chain in front of an NXDOMAIN) bound the lifetime too.
    if (!(negativeTTL === Infinity && (fullRcode === 3 || ancount === 0))) {
      const ttl = Math.min(answerMin, negativeTTL);
      if (Number.isFinite(ttl) && ttl > 0) {
        cacheTTL = clamp(
          Math.floor(ttl),
          CONFIG.EDGE_CACHE_MIN_TTL_SECONDS,
          CONFIG.EDGE_CACHE_MAX_TTL_SECONDS
        );
      }
    }
  }
  return { ok: true, error: null, rcode: fullRcode, cacheTTL };
}
function createDNSNameContext() {
  return { nameOffsets: new Set() };
}
function skipDNSName(bytes, offset, context = null) {
  let pos = offset;
  let end = -1;
  let jumps = 0;
  let expandedWireLength = 1;
  while (pos < bytes.length) {
    const len = bytes[pos];
    if (len === 0) {
      if (context) context.nameOffsets.add(pos);
      return end < 0 ? pos + 1 : end;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= bytes.length) return -1;
      const pointer = ((len & 0x3f) << 8) | bytes[pos + 1];
      if (pointer >= pos) return -1;
      if (context && (pointer < 12 || !context.nameOffsets.has(pointer))) return -1;
      // A compression pointer is itself the start of a prior name suffix and may
      // legally be the target of a later pointer. Mark it after validating its target.
      if (context) context.nameOffsets.add(pos);
      if (++jumps > 127) return -1;
      if (end < 0) end = pos + 2;
      pos = pointer;
      continue;
    }
    if ((len & 0xc0) !== 0 || pos + 1 + len > bytes.length) {
      return -1;
    }
    if (expandedWireLength + len + 1 > 255) return -1;
    expandedWireLength += len + 1;
    if (context) context.nameOffsets.add(pos);
    pos += 1 + len;
  }
  return -1;
}
function questionMatchesQuery(responseBytes, responseNameEnd, queryBytes) {
  const queryNameEnd = skipDNSName(queryBytes, 12);
  if (queryNameEnd < 0 || queryNameEnd !== responseNameEnd) return false;
  if (queryNameEnd + 4 > queryBytes.length || responseNameEnd + 4 > responseBytes.length) return false;
  for (let i = 12; i < responseNameEnd; i++) {
    let r = responseBytes[i];
    let q = queryBytes[i];
    if (r >= 65 && r <= 90) r += 32;
    if (q >= 65 && q <= 90) q += 32;
    if (r !== q) return false;
  }
  for (let i = 0; i < 4; i++) {
    if (responseBytes[responseNameEnd + i] !== queryBytes[queryNameEnd + i]) return false;
  }
  return true;
}
// AbortSignal.any is native in Workers and in Node >= 20.3 (see package.json engines).
function combineSignals(signal, timeoutSignal) {
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}
function reward(node, latencyMs) {
  node.ok += 1;
  node.lastLatencyMs = latencyMs;
  node.ewmaLatencyMs = node.ewmaLatencyMs == null
    ? latencyMs
    : Math.round(node.ewmaLatencyMs * 0.8 + latencyMs * 0.2);
  node.lastError = null;
  node.lastErrorKind = null;
  node.score = clamp(node.score + CONFIG.SCORE_SUCCESS_DELTA, CONFIG.SCORE_MIN, CONFIG.SCORE_MAX);
}
function penalize(node, amount, error, countFailure = true) {
  if (countFailure) node.fail += 1;
  node.lastError = String(error?.message || error || 'unknown').slice(0, 80);
  node.lastErrorKind = typeof error === 'object' && error?.kind
    ? String(error.kind).slice(0, 32)
    : (String(error || '').toLowerCase() === 'timeout' ? 'timeout' : null);
  node.score = clamp(node.score - amount, CONFIG.SCORE_MIN, CONFIG.SCORE_MAX);
}
function normalizeUncompressedQuestionName(bytes) {
  let offset = 12;
  while (offset < bytes.length) {
    const len = bytes[offset];
    if (len === 0) return;
    if ((len & 0xc0) !== 0 || offset + 1 + len > bytes.length) return;
    for (let i = offset + 1; i <= offset + len; i++) {
      const value = bytes[i];
      if (value >= 65 && value <= 90) bytes[i] = value + 32;
    }
    offset += 1 + len;
  }
}
// Wire bytes used for cache identity: transaction ID zeroed and ASCII letters in an
// uncompressed question name folded to lower case. Always returns a fresh buffer.
function normalizeQueryForKey(packet) {
  const normalized = packet.slice();
  normalized[0] = 0;
  normalized[1] = 0;
  normalizeUncompressedQuestionName(normalized);
  return normalized;
}
// Exact key for the isolate-local maps (L1 cache and in-flight jobs): the normalized bytes
// themselves. Two different questions can never collide, and no async digest is needed.
function localKeyFromNormalized(normalized) {
  return String.fromCharCode.apply(null, normalized);
}
// Key for the data-center-local L2 Cache API entry: the first 128 bits of SHA-256 over the
// normalized bytes, rendered as 32 hex characters.
async function edgeKeyFromNormalized(normalized) {
  const digest = await crypto.subtle.digest('SHA-256', normalized);
  const view = new Uint8Array(digest, 0, 16);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}
function getCache(key) {
  const item = APP_STATE.cache.get(key);
  if (!item) return null;
  if (Date.now() >= item.expiresAt) {
    APP_STATE.cache.delete(key);
    return null;
  }
  APP_STATE.cache.delete(key);
  APP_STATE.cache.set(key, item);
  return item;
}
function setCache(key, body, ttlSeconds, storedAt = Date.now(), expiresAtMs = null) {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  APP_STATE.cache.delete(key);
  APP_STATE.cache.set(key, {
    body,
    storedAt,
    expiresAt: expiresAtMs ?? storedAt + ttl * 1000
  });
  trimMap(APP_STATE.cache, CONFIG.MAX_CACHE_ENTRIES);
}
function cappedTTL(ttlSeconds, maxSeconds) {
  if (!Number.isFinite(ttlSeconds)) return 0;
  return clamp(Math.floor(ttlSeconds), CONFIG.EDGE_CACHE_MIN_TTL_SECONDS, maxSeconds);
}
function readResourceRecord(bytes, offset, context = null) {
  const nameEnd = skipDNSName(bytes, offset, context);
  if (nameEnd < 0 || nameEnd + 10 > bytes.length) return null;
  const type = (bytes[nameEnd] << 8) | bytes[nameEnd + 1];
  const rrClass = (bytes[nameEnd + 2] << 8) | bytes[nameEnd + 3];
  const ttl = readUint32(bytes, nameEnd + 4);
  const rdLength = (bytes[nameEnd + 8] << 8) | bytes[nameEnd + 9];
  const rdataOffset = nameEnd + 10;
  const rdEnd = rdataOffset + rdLength;
  if (rdEnd > bytes.length) return null;
  if (!validateRData(bytes, type, rrClass, rdataOffset, rdEnd, context)) return null;
  return { type, ttl, rdataOffset, rdEnd };
}
const SINGLE_NAME_TYPES = new Set([2, 3, 4, 5, 7, 8, 9, 12, 39]);
const PREF_NAME_TYPES = new Set([15, 18, 21, 36]);
function validateRData(bytes, type, rrClass, rdataOffset, rdEnd, context) {
  const readName = (offset) => skipDNSName(bytes, offset, context);
  if (rrClass === 1 && type === 1) return rdEnd - rdataOffset === 4;
  if (rrClass === 1 && type === 28) return rdEnd - rdataOffset === 16;
  if (SINGLE_NAME_TYPES.has(type)) {
    const end = readName(rdataOffset);
    return end >= 0 && end === rdEnd;
  }
  if (type === 14 || type === 17) {
    let pos = readName(rdataOffset);
    if (pos < 0 || pos > rdEnd) return false;
    pos = readName(pos);
    return pos >= 0 && pos === rdEnd;
  }
  if (type === 6) {
    let pos = readName(rdataOffset);
    if (pos < 0 || pos > rdEnd) return false;
    pos = readName(pos);
    return pos >= 0 && pos + 20 === rdEnd;
  }
  if (PREF_NAME_TYPES.has(type)) {
    if (rdataOffset + 2 > rdEnd) return false;
    const end = readName(rdataOffset + 2);
    return end >= 0 && end === rdEnd;
  }
  if (type === 33) {
    if (rdataOffset + 6 > rdEnd) return false;
    const end = readName(rdataOffset + 6);
    return end >= 0 && end === rdEnd;
  }
  if (type === 26) {
    if (rdataOffset + 2 > rdEnd) return false;
    let pos = readName(rdataOffset + 2);
    if (pos < 0 || pos > rdEnd) return false;
    pos = readName(pos);
    return pos >= 0 && pos === rdEnd;
  }
  if (type === 35) {
    let pos = rdataOffset;
    if (pos + 4 > rdEnd) return false;
    pos += 4;
    for (let i = 0; i < 3; i++) {
      if (pos >= rdEnd) return false;
      const length = bytes[pos++];
      if (pos + length > rdEnd) return false;
      pos += length;
    }
    const end = readName(pos);
    return end >= 0 && end === rdEnd;
  }
  if (type === 24 || type === 46) {
    const fixed = 18;
    if (rdataOffset + fixed > rdEnd) return false;
    const signerStart = rdataOffset + fixed;
    const end = readName(signerStart);
    return end >= 0 && end < rdEnd;
  }
  if (type === 25 || type === 43 || type === 48) {
    return rdEnd - rdataOffset >= 4;
  }
  if (type === 47) {
    const pos = readName(rdataOffset);
    return pos >= 0 && pos < rdEnd && validateTypeBitmap(bytes, pos, rdEnd);
  }
  if (type === 50) {
    if (rdataOffset + 5 > rdEnd) return false;
    let pos = rdataOffset + 5;
    const saltLength = bytes[rdataOffset + 4];
    if (pos + saltLength + 1 > rdEnd) return false;
    pos += saltLength;
    const hashLength = bytes[pos++];
    if (pos + hashLength > rdEnd) return false;
    pos += hashLength;
    return pos < rdEnd
      ? validateTypeBitmap(bytes, pos, rdEnd)
      : true;
  }
  if (type === 51) {
    if (rdataOffset + 5 > rdEnd) return false;
    const saltLength = bytes[rdataOffset + 4];
    return rdataOffset + 5 + saltLength === rdEnd;
  }
  if (type === 64 || type === 65) {
    if (rdataOffset + 2 > rdEnd) return false;
    let pos = readName(rdataOffset + 2);
    if (pos < 0 || pos > rdEnd) return false;
    let lastKey = -1;
    while (pos < rdEnd) {
      if (pos + 4 > rdEnd) return false;
      const key = (bytes[pos] << 8) | bytes[pos + 1];
      const valueLength = (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;
      if (key <= lastKey || pos + valueLength > rdEnd) return false;
      lastKey = key;
      pos += valueLength;
    }
    return true;
  }
  if (type === 257) {
    if (rdataOffset + 2 > rdEnd) return false;
    const tagLength = bytes[rdataOffset + 1];
    return rdataOffset + 2 + tagLength <= rdEnd;
  }
  if (type === 52 || type === 53) {
    return rdEnd - rdataOffset >= 3;
  }
  if (type === 256) {
    return rdEnd - rdataOffset >= 4;
  }
  return true;
}
function validateTypeBitmap(bytes, offset, end) {
  let pos = offset;
  let previousWindow = -1;
  while (pos < end) {
    if (pos + 2 > end) return false;
    const window = bytes[pos++];
    const length = bytes[pos++];
    if (window <= previousWindow || length < 1 || length > 32 || pos + length > end) return false;
    previousWindow = window;
    pos += length;
  }
  return pos === end;
}
function effectiveTTL(ttl) {
  return ttl > 0x7fffffff ? 0 : ttl;
}
function readUint32(bytes, offset) {
  return (((bytes[offset] * 0x100 + bytes[offset + 1]) * 0x100 + bytes[offset + 2]) * 0x100 + bytes[offset + 3]) >>> 0;
}
function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
function restoreQuestionCase(target, query) {
  const lower = (v) => (v >= 65 && v <= 90 ? v + 32 : v);
  const maxLen = Math.min(query.length, target.length);
  let offset = 12;
  while (offset < maxLen) {
    const len = query[offset];
    if (len === 0) return;
    if ((len & 0xc0) !== 0 || target[offset] !== len) return;
    if (offset + 1 + len > maxLen) return;
    for (let i = offset + 1; i <= offset + len; i++) {
      if (lower(query[i]) !== lower(target[i])) return;
    }
    for (let i = offset + 1; i <= offset + len; i++) target[i] = query[i];
    offset += 1 + len;
  }
}
// Cache hits re-walk the stored packet to age its TTLs. Every packet reaches either cache
// only after relay() has fully validated it, and an L2 read revalidates it before use, so
// this pass only needs record boundaries: it skips RDATA revalidation and allocates no
// name-offset set, which matters because it runs on every cache hit.
function patchDNSResponseForAge(responseBuffer, queryID, ageSeconds, queryBytes) {
  const copy = new Uint8Array(responseBuffer).slice();
  if (copy.length < 12) return copy.buffer;
  copy[0] = (queryID >> 8) & 0xff;
  copy[1] = queryID & 0xff;
  if (queryBytes) restoreQuestionCase(copy, queryBytes);
  // Normalize RFC 2181 top-bit TTLs even for a fresh MISS or a same-second hit.
  const age = Math.max(0, Math.floor(ageSeconds));
  const qdcount = (copy[4] << 8) | copy[5];
  const ancount = (copy[6] << 8) | copy[7];
  const nscount = (copy[8] << 8) | copy[9];
  const arcount = (copy[10] << 8) | copy[11];
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    offset = skipDNSName(copy, offset);
    if (offset < 0 || offset + 4 > copy.length) return copy.buffer;
    offset += 4;
  }
  const rrTotal = ancount + nscount + arcount;
  for (let i = 0; i < rrTotal; i++) {
    const nameEnd = skipDNSName(copy, offset);
    if (nameEnd < 0 || nameEnd + 10 > copy.length) return copy.buffer;
    const type = (copy[nameEnd] << 8) | copy[nameEnd + 1];
    const rdEnd = nameEnd + 10 + ((copy[nameEnd + 8] << 8) | copy[nameEnd + 9]);
    if (rdEnd > copy.length) return copy.buffer;
    if (type !== 41) {
      const remaining = Math.max(0, effectiveTTL(readUint32(copy, nameEnd + 4)) - age);
      writeUint32(copy, nameEnd + 4, remaining);
    }
    offset = rdEnd;
  }
  return copy.buffer;
}
function makeEdgeCacheRequest(origin, key) {
  return new Request(`${origin}${CONFIG.EDGE_CACHE_PATH}/${key}`, { method: 'GET' });
}
async function getEdgeCache(key, queryID, origin, queryBytes) {
  try {
    const cache = caches.default;
    const cacheKey = makeEdgeCacheRequest(origin, key);
    const hit = await cache.match(cacheKey);
    if (!hit) return null;
    if (hit.status !== 200 || !isDNSMessageContentType(hit.headers.get('content-type'))) {
      discardBody(hit);
      return null;
    }
    // Cache entries are an optimization, not trusted resolver output. Validate the
    // cheap metadata headers before paying for the (stream-limited) body read, so
    // expired or malformed entries are discarded without buffering their payload.
    const storedHeader = hit.headers.get('x-doh-stored-at');
    const ttlHeader = hit.headers.get('x-doh-ttl');
    const storedAt = storedHeader ? Number(storedHeader) : NaN;
    const ttlSeconds = ttlHeader ? Number(ttlHeader) : NaN;
    const now = Date.now();
    if (
      !Number.isSafeInteger(storedAt)
      || storedAt <= 0
      || storedAt > now
      || !Number.isSafeInteger(ttlSeconds)
      || ttlSeconds <= 0
      || ttlSeconds > CONFIG.EDGE_CACHE_MAX_TTL_SECONDS
    ) {
      discardBody(hit);
      return null;
    }
    let body;
    try {
      body = (await readCappedBody(
        hit,
        CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES,
        () => new Error('L2 cache entry too large')
      )).buffer;
    } catch (_) {
      return null;
    }
    // Cache values are stored with their DNS transaction ID zeroed. Recheck the full
    // DNS structure, matching question, and effective DNS TTL to avoid serving corrupt
    // or mismatched cache content even when its metadata looks plausible.
    const analysis = validateDNSResponse(body, 0, queryBytes);
    if (!analysis.ok) return null;
    if (analysis.cacheTTL <= 0 || ttlSeconds > analysis.cacheTTL) return null;
    const ageSeconds = Math.floor((now - storedAt) / 1000);
    if (ageSeconds >= ttlSeconds) return null;
    return {
      body,
      storedAt,
      ttlSeconds,
      ageSeconds,
      responseBody: patchDNSResponseForAge(body, queryID, ageSeconds, queryBytes)
    };
  } catch (_) {
    return null;
  }
}
async function putEdgeCache(key, body, ttlSeconds, storedAt, origin) {
  try {
    const cache = caches.default;
    const cacheKey = makeEdgeCacheRequest(origin, key);
    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/dns-message',
        'cache-control': `public, s-maxage=${ttlSeconds}`,
        'x-doh-stored-at': String(storedAt),
        'x-doh-ttl': String(ttlSeconds)
      }
    });
    await cache.put(cacheKey, response);
  } catch (_) {
    // L2 is best-effort: a failed put never affects the client response.
  }
}
function maybeSweepState() {
  const now = Date.now();
  if (now - APP_STATE.lastSweepAt < CONFIG.STATE_SWEEP_INTERVAL_MS) return;
  for (const [key, item] of APP_STATE.cache) {
    if (now >= item.expiresAt) APP_STATE.cache.delete(key);
  }
  for (const [ip, stats] of APP_STATE.throttle) {
    if (now >= stats.resetAt) APP_STATE.throttle.delete(ip);
  }
  APP_STATE.lastSweepAt = now;
}
async function allowDNSRequest(ip, env) {
  const key = rateLimitKey(ip);
  if (env?.DNS_RATE_LIMITER?.limit) {
    try {
      const result = await env.DNS_RATE_LIMITER.limit({ key });
      if (typeof result?.success === 'boolean') return result.success;
      throw new Error('Invalid DNS_RATE_LIMITER response');
    } catch (_) {
      // Missing/throwing/malformed binding: fall through to the local limiter.
    }
  }
  return localRateLimit(key);
}
// An IPv6 client normally controls a whole /64, so limit per /64 instead of per address;
// otherwise rotating addresses inside one prefix would bypass the limiter. IPv4 and
// non-IP values are returned unchanged.
function rateLimitKey(ip) {
  if (!ip.includes(':')) return ip;
  const halves = ip.split('%', 1)[0].split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups = head;
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return ip;
    groups = [...head, ...new Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
function localRateLimit(ip) {
  const now = Date.now();
  const current = APP_STATE.throttle.get(ip);
  let stats = current || { count: 0, resetAt: now + CONFIG.RATE_LIMIT_WINDOW_MS };
  if (now >= stats.resetAt) {
    stats = { count: 0, resetAt: now + CONFIG.RATE_LIMIT_WINDOW_MS };
  }
  stats.count += 1;
  if (current) APP_STATE.throttle.delete(ip);
  APP_STATE.throttle.set(ip, stats);
  trimMap(APP_STATE.throttle, CONFIG.MAX_THROTTLE_ENTRIES);
  return stats.count <= CONFIG.RATE_LIMIT_MAX_REQUESTS;
}
function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}
function getClientIP(req) {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}
function getHealthSnapshot() {
  return {
    version: VERSION,
    upstreams: RESOLVER_NODES.map((node) => ({
      url: node.url,
      score: node.score,
      ok: node.ok,
      fail: node.fail,
      timeout: node.timeout,
      ewmaLatencyMs: node.ewmaLatencyMs,
      lastLatencyMs: node.lastLatencyMs,
      lastError: node.lastError,
      lastErrorKind: node.lastErrorKind
    })),
    cacheEntries: APP_STATE.cache.size,
    inflightEntries: APP_STATE.inflight.size,
    throttleEntries: APP_STATE.throttle.size,
    rateLimit: {
      maxRequests: CONFIG.RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: CONFIG.RATE_LIMIT_WINDOW_MS / 1000,
      preferredBinding: 'DNS_RATE_LIMITER',
      invalidBindingFallback: 'per-isolate local limiter'
    },
    maxUpstreamDNSMessageBytes: CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES,
    stateSweepIntervalSeconds: CONFIG.STATE_SWEEP_INTERVAL_MS / 1000,
    maxSimultaneousUpstreams: RESOLVER_NODES.length,
    upstreamStrategy: 'parallel-race',
    cache: {
      l1: 'in-memory LRU',
      l2: CONFIG.EDGE_CACHE_ENABLED ? 'Cloudflare Cache API (data-center-local)' : 'disabled',
      localMaxTTLSeconds: CONFIG.LOCAL_CACHE_MAX_TTL_SECONDS,
      edgeMaxTTLSeconds: CONFIG.EDGE_CACHE_MAX_TTL_SECONDS
    }
  };
}
function dnsResponse(body, extraHeaders = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/dns-message',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
  });
}
function textResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  });
}
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  });
}
function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n]/g, '').slice(0, 200);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
export const __internals = {
  CONFIG,
  parseDNSQuestion,
  validateDNSResponse,
  skipDNSName,
  readResourceRecord,
  normalizeQueryForKey,
  localKeyFromNormalized,
  edgeKeyFromNormalized,
  patchDNSResponseForAge,
  localRateLimit,
  rateLimitKey,
  resolveWithParallelRace,
  isBetterDegraded,
  RESOLVER_NODES,
  relay,
  getCache,
  setCache,
  APP_STATE
};
const UI_RESPONSE_CACHE = new Map();
const UI_RESPONSE_CACHE_MAX_ENTRIES = 16;
const UI_STATIC_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};
// The dashboard is fully self-contained: its only script and style are the inline blocks below.
// The CSP pins each one by SHA-256 hash, so no 'unsafe-inline' and no third-party origin is needed.
const UI_STYLE = `
*,*::before,*::after{box-sizing:border-box;border:0 solid}
[hidden]{display:none!important}
body{margin:0;min-height:100vh;padding:1rem;background:#020617;color:#cbd5e1;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;overflow-x:hidden}
@media (min-width:768px){body{padding:3rem}}
body.lang-fa{direction:rtl}
button,input{font:inherit;color:inherit;margin:0;background:none}
button{cursor:pointer}
h1,h3,h4,p{margin:0}
b{font-weight:700}
code{color:#22d3ee;background:#000;padding:3px 7px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:inherit;text-decoration:none}
button:focus-visible,a:focus-visible{outline:2px solid #22d3ee;outline-offset:2px}
.wrap{max-width:56rem;margin:0 auto}
.glass{background:rgba(15,23,42,.7);-webkit-backdrop-filter:blur(15px);backdrop-filter:blur(15px);border:1px solid rgba(0,243,255,.08)}
.stack>*+*{margin-top:1.5rem}
.label{display:block;margin-bottom:1rem;font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#06b6d4}
.lang-switch{position:fixed;top:1.5rem;right:1.5rem;z-index:50}
.lang-btn{display:flex;align-items:center;gap:1rem;padding:.75rem 1.5rem;border-radius:1rem;border-color:rgba(6,182,212,.2);font-size:.75rem;font-weight:700;transition:transform .2s}
.lang-btn:hover{transform:scale(1.02)}
.lang-menu{position:absolute;right:0;width:11rem;margin-top:.75rem;padding:.5rem;border-radius:1rem;border-color:#1e293b;box-shadow:0 25px 50px -12px rgba(0,0,0,.5)}
.lang-option{display:block;width:100%;margin-bottom:.25rem;padding:.75rem;border-radius:.75rem;font-size:.75rem;text-align:left;transition:background-color .2s}
.lang-option:last-child{margin-bottom:0}
.lang-option[lang="fa"]{text-align:right}
.lang-option:hover{color:#fff}
.lang-option[data-lang="en"]:hover{background:#0284c7}
.lang-option[data-lang="fa"]:hover{background:#059669}
.lang-option[data-lang="zh"]:hover{background:#0d9488}
.hero{padding:4rem 0;text-align:center}
@media (min-width:768px){.hero{padding:6rem 0}}
.hero h1{font-size:3rem;font-weight:900;line-height:1.1;background-image:linear-gradient(to right,#22d3ee,#7dd3fc,#34d399);-webkit-background-clip:text;background-clip:text;color:transparent}
@media (min-width:768px){.hero h1{font-size:4.5rem}}
.tagline{margin-top:2rem;font-size:10px;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:#64748b}
@media (min-width:768px){.tagline{font-size:12px}}
.card{margin-bottom:2.5rem;padding:2rem;border-radius:3rem;text-align:center}
@media (min-width:768px){.card{padding:3.5rem}}
.endpoint-field{margin-bottom:1.5rem}
.endpoint-input{width:100%;padding:1.25rem;border:1px solid #1e293b;border-radius:1rem;background:rgba(0,0,0,.4);color:#67e8f9;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875rem;text-align:center;outline:none}
.endpoint-input:focus{border-color:rgba(6,182,212,.6)}
.copy-btn{padding:1.25rem 3rem;border-radius:1rem;background:#0891b2;color:#000;font-weight:900;box-shadow:0 20px 25px -5px rgba(0,0,0,.4);transition:all .2s}
.copy-btn:hover{background:#22d3ee}
.copy-btn:active{transform:scale(.95)}
.tabs-wrap{margin-bottom:4rem}
.tabs{display:flex;flex-wrap:wrap;justify-content:center;gap:.75rem;margin-bottom:2rem}
.tab-btn{padding:.75rem 1.5rem;border:1px solid #1e293b;border-radius:1rem;font-size:11px;font-weight:900;text-transform:uppercase;color:#94a3b8;transition:all .25s cubic-bezier(.4,0,.2,1)}
.tab-btn.is-active{background:#0ea5e9;color:#fff;border-color:#38bdf8;box-shadow:0 0 15px rgba(14,165,233,.3)}
.panels{min-height:300px}
.panel{padding:2.5rem;border-radius:3rem}
@media (min-width:768px){.panel{padding:3.5rem}}
.panel:not([hidden]){animation:fadeInUp .3s ease-out}
.panel-title{margin-bottom:2rem;font-size:1.5rem;font-weight:900}
.t-cyan{color:#cffafe}
.t-emerald{color:#d1fae5}
.t-teal{color:#ccfbf1}
.panel-desc{margin-bottom:1.5rem;font-size:.875rem;font-style:italic;color:#64748b}
.body-text{font-size:.875rem;line-height:1.625;color:#94a3b8}
.card-why{margin-bottom:5rem;padding:2rem;border-radius:3.5rem;border-color:rgba(12,74,110,.4);position:relative}
@media (min-width:768px){.card-why{padding:3rem}}
.why-title{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem;font-size:1rem;font-weight:900;color:#38bdf8}
@media (min-width:768px){.why-title{font-size:1.125rem}}
.why-body{font-size:13px;line-height:2;color:#94a3b8}
@media (min-width:768px){.why-body{font-size:14px}}
.footer{display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:2rem;margin-top:8rem;padding-bottom:5rem;border-top:1px solid #0f172a;opacity:.6}
@media (min-width:768px){.footer{flex-direction:row}}
.footer-version{display:block;margin-bottom:.25rem;font-size:10px;font-weight:900;letter-spacing:.1em;color:#0891b2}
.footer-note{font-size:9px;text-transform:uppercase}
.footer-links{display:flex;gap:2.5rem;font-size:10px;font-weight:700;text-transform:uppercase}
.footer-links a:hover{color:#22d3ee}
@keyframes fadeInUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
`;
const UI_SCRIPT = `
        const I18N = {
            en: {
                main: 'Secure DNS over HTTPS', sub: 'Edge Resolve Network • Parallel DoH Resolution',
                urlL: 'Endpoint URL', cpT: 'COPY ENDPOINT', copied: 'LINK CAPTURED!', tabC: 'Chrome / Brave / Edge', tabF: 'Firefox', tabM: 'Android / iOS',
                cH: 'Setup for Chromium Browsers', cL: '<p>1. Open Browser <b>Settings</b> and type "DNS" in the search box.</p><p>2. Select <b>Security</b> &gt; Scroll to <b>Use Secure DNS</b>.</p><p>3. Choose <b>"With Custom"</b> provider.</p><p>4. Paste your DoH endpoint URL from the copy-box above.</p><p>5. Test by visiting a DNS-restricted website.</p>',
                fH: 'Setup for Firefox', fL: '<p>1. Open Firefox <code>Settings</code> and scroll down to <b>Network Settings</b>.</p><p>2. Click <b>Settings...</b> and check <b>"Enable DNS over HTTPS"</b> at the bottom.</p><p>3. Set provider to <b>Custom</b> and paste your unique URL.</p><p>4. Select <b>"Max Protection"</b> for stronger browser-level DNS privacy.</p>',
                mH: 'Android / iOS Logic', mD: 'This resolver is a DoH (HTTPS-based) service, which modern phones handle differently than system-wide settings.',
                mL: '<p><b>A) For Mobile Browsers:</b> Open Browser settings (Chrome/Firefox/Edge) on your phone and follow the desktop steps. <b>This is the best and fastest way.</b></p><p><b>B) For System-wide Apps:</b> We recommend using <b>RethinkDNS</b> or <b>Intra</b> apps. In these apps, set the DNS type to DoH and provide your unique DoH endpoint link.</p>',
                whyH: 'Why ONLY Browser-level DoH? (Crucial Tip)',
                whyT: '<p>Most operating systems (Windows settings, Android "Private DNS", or Apple Profiles) natively expect <b>DNS-over-TLS (DoT)</b> which runs on Port 853. Since this worker is built on <code>https://</code> and Port 443, it is not directly usable in these native settings.</p><p><b>The Issue:</b> You <u>cannot</u> paste an <code>https://</code> link into many native DNS settings. It will usually result in an "Invalid Hostname" error. Systems there expect a hostname or DoT endpoint, not a full HTTPS resolver URL.</p><p><b>The Solution:</b> Browsers (Chrome, Edge, Firefox) have their own independent DoH clients. They are compatible with Port 443 workers and provide browser-level encrypted DNS. DoH is therefore best configured directly in the browser.</p>',
                curL: 'ENGLISH'
            },
            fa: {
                main: 'سرویس امن DNS بر روی HTTPS', sub: 'پاسخگویی همزمان با سه سرور DNS و انتخاب اولین پاسخ معتبر',
                urlL: 'آدرس مستقیم سرور شما (DoH)', cpT: 'کپی آدرس هوشمند', copied: 'لینک کپی شد!', tabC: 'خانواده کروم', tabF: 'فایرفاکس', tabM: 'اندروید / آیفون',
                cH: 'تنظیمات در کروم، اج و بریو', cL: '<p>۱. در تنظیمات مرورگر کلمه DNS را جستجو کنید.</p><p>۲. وارد بخش Security شوید.</p><p>۳. گزینه «Use Secure DNS» را انتخاب کنید.</p><p>۴. آدرس سرور را در فیلد Custom وارد کنید.</p><p>۵. با جستجوی یک سایت محدود، نتیجه را تست کنید.</p>',
                fH: 'تنظیمات در مرورگر فایرفاکس', fL: '<p>۱. در فایرفاکس وارد Settings شوید و DNS over HTTPS را جستجو کنید.</p><p>۲. گزینه Custom را انتخاب کنید.</p><p>۳. URL سرویس DoH را وارد کنید.</p><p>۴. برای حداکثر محافظت، گزینه Max Protection را فعال کنید.</p>',
                mH: 'استراتژی راه‌اندازی در موبایل', mD: 'گوشی‌ها معمولاً در تنظیمات سیستمی به دنبال hostname برای DoT هستند؛ برای این سرویس DoH، بهترین روش در مرورگر است:',
                mL: '<p><b>داخل مرورگر:</b> بهترین راه تنظیم مستقیم در بخش Secure DNS کروم یا فایرفاکس است.</p><p><b>برای اپ‌ها:</b> از اپ‌های <b>Intra</b> یا <b>RethinkDNS</b> کمک بگیرید و نوع DNS را DoH تنظیم کنید.</p>',
                whyH: 'چرا معمولاً فقط در مرورگر؟',
                whyT: '<p>بسیاری از تنظیمات سیستمی ویندوز یا اندروید، معمولاً <b>DoT (پورت ۸۵۳)</b> یا فرمت hostname را می‌خواهند و URL کامل HTTPS را نمی‌پذیرند.</p><p>این سرویس برای مرورگرها و Port 443 طراحی شده است و بهترین مکان استفاده از آن در داخل مرورگر است.</p>',
                curL: 'فارسی (FA)'
            },
            zh: {
                main: 'Secure DoH 安全加密中心', sub: '基于边缘节点的三路并行 DNS 解析',
                urlL: 'DoH 配置终端', cpT: '复制配置地址', copied: '已复制!', tabC: 'Chromium 引擎', tabF: 'Firefox 火狐', tabM: '安卓与 iOS',
                cH: 'Chromium 浏览器设置', cL: '<p>1. 进入浏览器“设置”，搜索“安全 DNS”。</p><p>2. 进入“使用安全 DNS”选项。</p><p>3. 选择“自定义 (Custom)”。</p><p>4. 把当前 Worker 的 URL 粘贴进去。</p><p>5. 访问被拦截的网站做功能验证。</p>',
                fH: '火狐浏览器配置指南', fL: '<p>1. 在火狐“设置”中搜索 DNS over HTTPS。</p><p>2. 选择“自定义提供商”。</p><p>3. 输入 DoH 服务地址。</p><p>4. 选择“Max Protection”提升增强隐私。</p>',
                mH: '移动端解析说明', mD: '移动操作系统通常默认系统级 DoT 格式；若要使用此 DoH 服务器:',
                mL: '<p><b>浏览器设置:</b> 直接在安卓或苹果手机的浏览器中配置最稳定。</p><p><b>应用设置:</b> 推荐使用 <b>Intra</b> 或 <b>RethinkDNS</b>，并将 DNS 类型切换为 DoH。</p>',
                whyH: '为什么通常建议在浏览器配置?',
                whyT: '<p>Windows 或安卓系统的 Private DNS 设置项通常需要 <b>DoT / 853 端口</b> 或主机名格式，而不一定接受完整 HTTPS URL。</p><p>本项目基于 <b>Port 443</b> 的 Worker 架构，因此浏览器端配置最符合实际运行方式。</p>',
                curL: '简体中文'
            }
        };
const LANG_KEY = 'doc_v6';
const $ = (id) => document.getElementById(id);
function getStoredLanguage() {
    let stored = 'en';
    try { stored = localStorage.getItem(LANG_KEY) || 'en'; } catch (_) {}
    return I18N[stored] ? stored : 'en';
}
function setLangMenu(open) {
    $('langMenu').hidden = !open;
    $('langToggle').setAttribute('aria-expanded', String(open));
}
function changeLang(c) {
    if (!I18N[c]) c = 'en';
    try { localStorage.setItem(LANG_KEY, c); } catch (_) {}
    const l = I18N[c];
    document.documentElement.lang = c;
    document.body.classList.toggle('lang-fa', c === 'fa');
    $('currentLang').innerText = l.curL;
    $('mainTitle').innerText = l.main;
    $('subTag').innerText = l.sub;
    $('labelUrl').innerText = l.urlL;
    $('txtCopy').innerText = l.cpT;
    $('btnC').innerText = l.tabC;
    $('btnF').innerText = l.tabF;
    $('btnM').innerText = l.tabM;
    $('cH').innerText = l.cH;
    $('cL').innerHTML = l.cL;
    $('fH').innerText = l.fH;
    $('fL').innerHTML = l.fL;
    $('mH').innerText = l.mH;
    $('mD').innerText = l.mD;
    $('mL').innerHTML = l.mL;
    $('whyH').innerText = l.whyH;
    $('whyT').innerHTML = l.whyT;
    setLangMenu(false);
}
function tab(id, btn) {
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== id; });
    document.querySelectorAll('.tab-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
    });
}
let copyTimer = null;
async function copyURL() {
    let ok = false;
    try {
        await navigator.clipboard.writeText($('linkInp').value);
        ok = true;
    } catch (_) {
        $('linkInp').select();
        ok = document.execCommand('copy');
    }
    if (!ok) return;
    $('txtCopy').innerText = I18N[getStoredLanguage()].copied;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('txtCopy').innerText = I18N[getStoredLanguage()].cpT; }, 2000);
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => tab(btn.dataset.tab, btn));
});
document.querySelectorAll('.lang-option').forEach((btn) => {
    btn.addEventListener('click', () => changeLang(btn.dataset.lang));
});
$('langToggle').addEventListener('click', () => setLangMenu($('langMenu').hidden));
document.addEventListener('click', (e) => {
    if (!e.target.closest('.lang-switch')) setLangMenu(false);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setLangMenu(false);
});
$('copyBtn').addEventListener('click', copyURL);
changeLang(getStoredLanguage());
`;
let uiHeadersPromise = null;
async function sha256Source(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}
function uiHeaders() {
  uiHeadersPromise ??= Promise.all([sha256Source(UI_STYLE), sha256Source(UI_SCRIPT)]).then(([style, script]) => ({
    ...UI_STATIC_HEADERS,
    'content-security-policy': [
      "default-src 'none'",
      `script-src ${script}`,
      `style-src ${style}`,
      "img-src data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  })).catch((err) => {
    uiHeadersPromise = null; // let a later request retry instead of failing for the isolate's lifetime
    throw err;
  });
  return uiHeadersPromise;
}
async function renderUI(origin) {
  const headers = await uiHeaders();
  let html = UI_RESPONSE_CACHE.get(origin);
  if (html) {
    UI_RESPONSE_CACHE.delete(origin);
    UI_RESPONSE_CACHE.set(origin, html);
  } else {
    html = buildUIHtml(origin);
    UI_RESPONSE_CACHE.set(origin, html);
    trimMap(UI_RESPONSE_CACHE, UI_RESPONSE_CACHE_MAX_ENTRIES);
  }
  return new Response(html, { headers });
}
function buildUIHtml(origin) {
  const endpoint = `${escapeHtml(origin)}${CONFIG.DNS_PATH}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Secure DNS over HTTPS (DoH) Pro</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🛡️</text></svg>">
    <style>${UI_STYLE}</style>
</head>
<body>
    <div class="lang-switch">
        <button type="button" id="langToggle" class="glass lang-btn" aria-haspopup="true" aria-expanded="false">
            🌐 <span id="currentLang">ENGLISH</span>
        </button>
        <div id="langMenu" class="glass lang-menu" hidden>
            <button type="button" class="lang-option" data-lang="en">ENGLISH</button>
            <button type="button" class="lang-option" data-lang="fa" lang="fa">فارسی</button>
            <button type="button" class="lang-option" data-lang="zh">简体中文</button>
        </div>
    </div>
    <div class="wrap">
        <header class="hero">
            <h1 id="mainTitle">Secure DNS over HTTPS</h1>
            <p id="subTag" class="tagline">Edge Resolve Network • Parallel DoH Resolution</p>
        </header>
        <section class="glass card">
            <div class="endpoint-field">
                <span class="label" id="labelUrl">Endpoint URL</span>
                <input id="linkInp" value="${endpoint}" readonly class="endpoint-input">
            </div>
            <button type="button" id="copyBtn" class="copy-btn"><span id="txtCopy">COPY ENDPOINT</span></button>
        </section>
        <div class="tabs-wrap">
            <nav class="tabs" role="tablist">
                <button type="button" id="btnC" class="tab-btn is-active" role="tab" aria-selected="true" aria-controls="chrome" data-tab="chrome">Chrome / Brave / Edge</button>
                <button type="button" id="btnF" class="tab-btn" role="tab" aria-selected="false" aria-controls="firefox" data-tab="firefox">Firefox</button>
                <button type="button" id="btnM" class="tab-btn" role="tab" aria-selected="false" aria-controls="mobile" data-tab="mobile">Android / iOS</button>
            </nav>
            <section class="panels">
                <div id="chrome" class="glass panel" role="tabpanel" aria-labelledby="btnC">
                    <h3 id="cH" class="panel-title t-cyan">Setup for Chromium Browsers</h3>
                    <div id="cL" class="body-text stack">
                        <p>1. Open Browser <b>Settings</b> and type "DNS" in the search box.</p>
                        <p>2. Select <b>Security</b> &gt; Scroll to <b>Use Secure DNS</b>.</p>
                        <p>3. Choose <b>"With Custom"</b> provider.</p>
                        <p>4. Paste your DoH endpoint URL from the copy-box above.</p>
                        <p>5. Test by visiting a DNS-restricted website.</p>
                    </div>
                </div>
                <div id="firefox" class="glass panel" role="tabpanel" aria-labelledby="btnF" hidden>
                    <h3 id="fH" class="panel-title t-emerald">Setup for Firefox</h3>
                    <div id="fL" class="body-text stack">
                        <p>1. Open Firefox <code>Settings</code> and scroll down to <b>Network Settings</b>.</p>
                        <p>2. Click <b>Settings...</b> and check <b>"Enable DNS over HTTPS"</b> at the bottom.</p>
                        <p>3. Set provider to <b>Custom</b> and paste your unique URL.</p>
                        <p>4. Select <b>"Max Protection"</b> for stronger browser-level DNS privacy.</p>
                    </div>
                </div>
                <div id="mobile" class="glass panel" role="tabpanel" aria-labelledby="btnM" hidden>
                    <h3 id="mH" class="panel-title t-teal">Android / iOS Logic</h3>
                    <p id="mD" class="panel-desc">This resolver is a DoH (HTTPS-based) service, which modern phones handle differently than system-wide settings.</p>
                    <div id="mL" class="body-text stack">
                        <p><b>A) For Mobile Browsers:</b> Open Browser settings (Chrome/Firefox/Edge) on your phone and follow the desktop steps. <b>This is the best and fastest way.</b></p>
                        <p><b>B) For System-wide Apps:</b> We recommend using <b>RethinkDNS</b> or <b>Intra</b> apps. In these apps, set the DNS type to DoH and provide your unique DoH endpoint link.</p>
                    </div>
                </div>
            </section>
        </div>
        <div class="glass card-why">
            <h4 class="why-title">⭐ <span id="whyH">Why ONLY Browser-level DoH? (Crucial Tip)</span></h4>
            <div id="whyT" class="why-body stack">
                <p>Most operating systems (Windows settings, Android "Private DNS", or Apple Profiles) natively expect <b>DNS-over-TLS (DoT)</b> which runs on Port 853. Since this worker is built on <code>https://</code> and Port 443, it is not directly usable in these native settings.</p>
                <p><b>The Issue:</b> You <u>cannot</u> paste an <code>https://</code> link into many native DNS settings. It will usually result in an "Invalid Hostname" error. Systems there expect a hostname or DoT endpoint, not a full HTTPS resolver URL.</p>
                <p><b>The Solution:</b> Browsers (Chrome, Edge, Firefox) have their own independent DoH clients. They are compatible with Port 443 workers and provide browser-level encrypted DNS. DoH is therefore best configured directly in the browser.</p>
            </div>
        </div>
        <footer class="footer">
            <div>
                <span class="footer-version">Secure DNS over HTTPS v${VERSION}</span>
                <p class="footer-note">Built with Edge-Computing Infrastructure</p>
            </div>
            <nav class="footer-links">
                <a href="https://github.com/t0ny54/DOH-Endpoints-Cloudflare-Worker" target="_blank" rel="noreferrer">GitHub</a>
            </nav>
        </footer>
    </div>
    <script>${UI_SCRIPT}</script>
</body>
</html>`;
}
