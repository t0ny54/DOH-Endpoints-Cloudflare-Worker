const VERSION = '0.4.7';
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
  MAX_DNS_MESSAGE_BYTES: 4096,
  MAX_GET_DNS_CHARS: 5462,
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
    const clientIP = getClientIP(req);
    if (url.pathname === CONFIG.DNS_PATH) {
      if (!(await allowDNSRequest(clientIP, env))) {
        return textResponse('Rate limit exceeded', 429, {
          'cache-control': 'no-store',
          'retry-after': '60'
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
      return renderUI(url.host);
    }
    return textResponse('Not found', 404);
  }
};
async function handleDNS(req, url, ctx) {
  const methodError = validateMethod(req.method);
  if (methodError) return methodError;
  let payload;
  try {
    payload = await readDNSPayload(req, url);
  } catch (err) {
    return textResponse(err.message || 'Invalid DNS query', err.status || 400, {
      'cache-control': 'no-store'
    });
  }
  if (payload.byteLength === 0) {
    return textResponse('Empty DNS query', 400, { 'cache-control': 'no-store' });
  }
  const parsed = parseDNSQuestion(payload);
  if (!parsed.ok) {
    return textResponse(parsed.error, 400, { 'cache-control': 'no-store' });
  }
  const cacheKey = await makeCacheKey(payload);
  const localHit = getCache(cacheKey);
  if (localHit) {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - localHit.storedAt) / 1000));
    const responseBody = patchDNSResponseForAge(localHit.body, parsed.id, ageSeconds, payload);
    return dnsResponse(responseBody, {
      'x-cache': 'L1-HIT',
      'x-edge-cache': 'SKIP',
      'x-upstreams': '0'
    });
  }
  const existing = APP_STATE.inflight.get(cacheKey);
  if (existing) return joinInflight(existing, parsed, payload);
  if (CONFIG.EDGE_CACHE_ENABLED) {
    const edgeHit = await getEdgeCache(cacheKey, parsed.id, url.origin, payload);
    if (edgeHit) {
      const promotedTTL = cappedTTL(
        edgeHit.ttlSeconds - edgeHit.ageSeconds,
        CONFIG.LOCAL_CACHE_MAX_TTL_SECONDS
      );
      setCache(
        cacheKey,
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
  }
  const raced = APP_STATE.inflight.get(cacheKey);
  if (raced) return joinInflight(raced, parsed, payload);
  if (APP_STATE.inflight.size >= CONFIG.MAX_INFLIGHT_ENTRIES) {
    return textResponse('Resolver busy, please retry', 503, {
      'cache-control': 'no-store',
      'retry-after': '1'
    });
  }
  const job = (async () => {
    const result = await resolveWithParallelRace(RESOLVER_NODES, payload, parsed.id);
    const storedAt = Date.now();
    const ttlSeconds = getDNSCacheTTL(result.body);
    if (ttlSeconds > 0) {
      // The buffer is private to this job (fresh from relay()), so zero the ID in place.
      new Uint8Array(result.body).fill(0, 0, 2);
      const localTTL = cappedTTL(ttlSeconds, CONFIG.LOCAL_CACHE_MAX_TTL_SECONDS);
      setCache(
        cacheKey,
        result.body,
        localTTL,
        storedAt
      );
      if (CONFIG.EDGE_CACHE_ENABLED) {
        try {
          ctx?.waitUntil?.(putEdgeCache(
            cacheKey,
            result.body,
            cappedTTL(ttlSeconds, CONFIG.EDGE_CACHE_MAX_TTL_SECONDS),
            storedAt,
            url.origin
          ));
        } catch (_) {}
      }
    }
    return { ...result, storedAt };
  })();
  APP_STATE.inflight.set(cacheKey, job);
  try {
    const result = await job;
    const responseBody = patchDNSResponseForAge(result.body, parsed.id, 0, payload);
    const headers = {
      'x-cache': 'MISS',
      'x-edge-cache': CONFIG.EDGE_CACHE_ENABLED ? 'MISS' : 'DISABLED',
      'x-upstreams': String(result.attempts),
      'x-winner': sanitizeHeaderValue(result.url),
      'x-winner-lat': `${result.latencyMs}ms`
    };
    if (result.degraded) headers['x-dns-degraded'] = '1';
    return dnsResponse(responseBody, headers);
  } catch (err) {
    return upstreamFailureResponse(err, RESOLVER_NODES.length);
  } finally {
    if (APP_STATE.inflight.get(cacheKey) === job) APP_STATE.inflight.delete(cacheKey);
  }
}
async function joinInflight(job, parsed, queryBytes) {
  try {
    const shared = await job;
    return coalescedDNSResponse(shared, parsed, queryBytes);
  } catch (err) {
    return upstreamFailureResponse(err, RESOLVER_NODES.length);
  }
}
function upstreamFailureResponse(err, fallbackAttempts = 0) {
  return textResponse('Global resolving failed', 502, {
    'cache-control': 'no-store',
    'x-upstreams': String(err?.attempts || fallbackAttempts)
  });
}
function coalescedDNSResponse(shared, parsed, queryBytes) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - shared.storedAt) / 1000));
  const responseBody = patchDNSResponseForAge(shared.body, parsed.id, ageSeconds, queryBytes);
  const headers = {
    'x-cache': 'COALESCED',
    'x-edge-cache': 'SKIP',
    'x-upstreams': '0',
    'x-winner': sanitizeHeaderValue(shared.url),
    'x-winner-lat': `${shared.latencyMs}ms`
  };
  if (shared.degraded) headers['x-dns-degraded'] = '1';
  return dnsResponse(responseBody, headers);
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
  const mediaType = (req.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/dns-message') {
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
    'DNS message too large'
  );
}
async function readCappedBody(source, maxBytes, tooLargeMessage) {
  const reader = source.body?.getReader();
  if (!reader) {
    const buffer = await source.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw httpError(tooLargeMessage, 413);
    }
    return new Uint8Array(buffer);
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('message-too-large'); } catch (_) {}
        throw httpError(tooLargeMessage, 413);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  if (chunks.length === 1) return new Uint8Array(chunks[0]);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
function decodeBase64Url(input) {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw httpError('Invalid base64url DNS query', 400);
  }
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const decoded = atob(normalized);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    if (bytes.byteLength > CONFIG.MAX_DNS_MESSAGE_BYTES) {
      throw httpError('DNS message too large', 413);
    }
    return bytes;
  } catch (err) {
    if (err && err.status) throw err;
    throw httpError('Invalid base64url DNS query', 400);
  }
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
        if (value.usable && value.rcode === 0) {
          return {
            ...value,
            attempts: nodes.length
          };
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
    if (nxdomain) {
      return {
        ...nxdomain,
        attempts: nodes.length
      };
    }
    if (fallback) {
      return {
        ...fallback,
        attempts: nodes.length
      };
    }
    const err = new Error('All DNS upstreams failed');
    err.attempts = nodes.length;
    throw err;
  } finally {
    clearGrace();
    abortAttempts(controllers);
  }
}
function isBetterDegraded(value, node, bestValue, bestNode) {
  if (value.rcode !== bestValue.rcode) {
    if (value.rcode === 2) return true;
    if (bestValue.rcode === 2) return false;
  }
  if (node.score !== bestNode.score) return node.score > bestNode.score;
  return value.latencyMs < bestValue.latencyMs;
}
function abortAttempts(controllers) {
  for (const controller of controllers.values()) {
    try { controller.abort('winner-selected'); } catch (_) {}
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
      body: packet.slice(),
      signal: combinedSignal
    });
    if (!res.ok) {
      discardBody(res);
      throw upstreamError(`Upstream HTTP ${res.status}`, 'http');
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().startsWith('application/dns-message')) {
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
    let bodyBytes;
    try {
      bodyBytes = await readCappedBody(
        res,
        CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES,
        'Upstream DNS response too large'
      );
    } catch (err) {
      if (err?.status === 413) {
        throw upstreamError('Upstream DNS response too large', 'response-too-large');
      }
      throw err;
    }
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
      degraded: !usable
    };
  } catch (err) {
    const raceAbort = signal?.aborted && signal.reason === 'winner-selected';
    const timeoutAbort = timeoutController.signal.aborted;
    if (raceAbort) throw err;
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
function validateDNSResponse(responseBuffer, expectedID, queryBytes) {
  const bytes = new Uint8Array(responseBuffer);
  if (bytes.length < 12) return { ok: false, error: 'Upstream returned short DNS response' };
  const id = (bytes[0] << 8) | bytes[1];
  const flags = (bytes[2] << 8) | bytes[3];
  const rcode = flags & 0x000f;
  if (id !== expectedID) return { ok: false, error: 'Upstream response ID mismatch' };
  if ((flags & 0x8000) === 0) return { ok: false, error: 'Upstream returned a DNS query, not response' };
  if ((flags & 0x7800) !== 0) return { ok: false, error: 'Unexpected DNS opcode in upstream response' };
  const qdcount = (bytes[4] << 8) | bytes[5];
  const ancount = (bytes[6] << 8) | bytes[7];
  const nscount = (bytes[8] << 8) | bytes[9];
  const arcount = (bytes[10] << 8) | bytes[11];
  if (qdcount !== 1) return { ok: false, error: 'Unexpected question count in upstream response' };
  const nameContext = createDNSNameContext();
  let offset = skipDNSName(bytes, 12, nameContext);
  if (offset < 0 || offset + 4 > bytes.length) {
    return { ok: false, error: 'Malformed question in upstream response' };
  }
  if (!questionMatchesQuery(bytes, offset, queryBytes)) {
    return { ok: false, error: 'Upstream response question does not match the query' };
  }
  offset += 4;
  const rrTotal = ancount + nscount + arcount;
  for (let i = 0; i < rrTotal; i++) {
    const rr = readResourceRecord(bytes, offset, nameContext);
    if (!rr) return { ok: false, error: 'Malformed resource record in upstream response' };
    offset = rr.rdEnd;
  }
  if (offset !== bytes.length) {
    return { ok: false, error: 'Trailing bytes in upstream response' };
  }
  return { ok: true, rcode };
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
  if (!queryBytes || queryBytes.byteLength < 12) return true;
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
function combineSignals(signal, timeoutSignal) {
  const signals = signal ? [signal, timeoutSignal] : [timeoutSignal];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  return anySignal(signals);
}
function anySignal(signals) {
  const controller = new AbortController();
  function abortFrom(signal) {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason || 'aborted');
    }
  }
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    signal.addEventListener('abort', () => abortFrom(signal), { once: true });
  }
  return controller.signal;
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
async function makeCacheKey(packet) {
  const normalized = packet.slice();
  normalized[0] = 0;
  normalized[1] = 0;
  normalizeUncompressedQuestionName(normalized);
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
  return clamp(Math.max(1, Math.floor(ttlSeconds)), CONFIG.EDGE_CACHE_MIN_TTL_SECONDS, maxSeconds);
}
function getDNSCacheTTL(responseBuffer) {
  const bytes = new Uint8Array(responseBuffer);
  if (bytes.length < 12 || bytes.length > CONFIG.MAX_UPSTREAM_DNS_MESSAGE_BYTES) return 0;
  const flags = (bytes[2] << 8) | bytes[3];
  if ((flags & 0x8000) === 0) return 0;
  if ((flags & 0x0200) !== 0) return 0; 
  const rcode = flags & 0x000f;
  if (rcode !== 0 && rcode !== 3) return 0;
  const qdcount = (bytes[4] << 8) | bytes[5];
  const ancount = (bytes[6] << 8) | bytes[7];
  const nscount = (bytes[8] << 8) | bytes[9];
  const arcount = (bytes[10] << 8) | bytes[11];
  const nameContext = createDNSNameContext();
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    offset = skipDNSName(bytes, offset, nameContext);
    if (offset < 0 || offset + 4 > bytes.length) return 0;
    offset += 4;
  }
  let answerMin = Infinity;
  let authorityMin = Infinity;
  let soaNegativeMin = Infinity;
  const answerEnd = ancount;
  const authorityEnd = ancount + nscount;
  const rrTotal = authorityEnd + arcount;
  for (let i = 0; i < rrTotal; i++) {
    const rr = readResourceRecord(bytes, offset, nameContext);
    if (!rr) return 0;
    offset = rr.rdEnd;
    if (rr.type === 41 || i >= authorityEnd) continue;
    const rrTTL = effectiveTTL(rr.ttl);
    if (i < answerEnd) {
      answerMin = Math.min(answerMin, rrTTL);
    } else {
      authorityMin = Math.min(authorityMin, rrTTL);
      if (rr.type === 6) {
        // readResourceRecord() already proved the SOA RDATA ends with its 20 numeric octets.
        soaNegativeMin = Math.min(soaNegativeMin, effectiveTTL(readUint32(bytes, rr.rdEnd - 4)));
      }
    }
  }
  const negativeTTL = soaNegativeMin === Infinity ? Infinity : Math.min(authorityMin, soaNegativeMin);
  // A negative answer (NXDOMAIN/NODATA) needs an SOA; any answer-section records
  // (for example the CNAME chain in front of an NXDOMAIN) bound the lifetime too.
  if (negativeTTL === Infinity && (rcode === 3 || ancount === 0)) return 0;
  const ttl = Math.min(answerMin, negativeTTL);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  return clamp(
    Math.floor(ttl),
    CONFIG.EDGE_CACHE_MIN_TTL_SECONDS,
    CONFIG.EDGE_CACHE_MAX_TTL_SECONDS
  );
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
function patchDNSResponseForAge(responseBuffer, queryID, ageSeconds, queryBytes) {
  const copy = new Uint8Array(responseBuffer).slice();
  copy[0] = (queryID >> 8) & 0xff;
  copy[1] = queryID & 0xff;
  if (queryBytes) restoreQuestionCase(copy, queryBytes);
  if (copy.length < 12 || ageSeconds <= 0) return copy.buffer;
  const qdcount = (copy[4] << 8) | copy[5];
  const ancount = (copy[6] << 8) | copy[7];
  const nscount = (copy[8] << 8) | copy[9];
  const arcount = (copy[10] << 8) | copy[11];
  const nameContext = createDNSNameContext();
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    offset = skipDNSName(copy, offset, nameContext);
    if (offset < 0 || offset + 4 > copy.length) return copy.buffer;
    offset += 4;
  }
  const rrTotal = ancount + nscount + arcount;
  for (let i = 0; i < rrTotal; i++) {
    const rr = readResourceRecord(copy, offset, nameContext);
    if (!rr) return copy.buffer;
    if (rr.type !== 41) {
      const remaining = Math.max(0, effectiveTTL(rr.ttl) - ageSeconds);
      const ttlOffset = rr.rdataOffset - 6;
      copy[ttlOffset] = (remaining >>> 24) & 0xff;
      copy[ttlOffset + 1] = (remaining >>> 16) & 0xff;
      copy[ttlOffset + 2] = (remaining >>> 8) & 0xff;
      copy[ttlOffset + 3] = remaining & 0xff;
    }
    offset = rr.rdEnd;
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
    const body = await hit.arrayBuffer();
    const storedHeader = hit.headers.get('x-doh-stored-at');
    const ttlHeader = hit.headers.get('x-doh-ttl');
    const storedAt = storedHeader ? Number(storedHeader) : NaN;
    const ttlSeconds = ttlHeader ? Number(ttlHeader) : NaN;
    if (!Number.isFinite(storedAt) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return null;
    }
    const ageSeconds = Math.max(0, Math.floor((Date.now() - storedAt) / 1000));
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
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/dns-message',
        'cache-control': `public, s-maxage=${ttl}`,
        'x-doh-stored-at': String(storedAt),
        'x-doh-ttl': String(ttl)
      }
    });
    await cache.put(cacheKey, response);
  } catch (_) {
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
  if (env?.DNS_RATE_LIMITER?.limit) {
    try {
      const result = await env.DNS_RATE_LIMITER.limit({ key: ip });
      if (typeof result?.success === 'boolean') return result.success;
      throw new Error('Invalid DNS_RATE_LIMITER response');
    } catch (_) {
    }
  }
  return localRateLimit(ip);
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
      'vary': 'Accept-Encoding',
      ...extraHeaders
    }
  });
}
function textResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...headers
    }
  });
}
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
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
  makeCacheKey,
  getDNSCacheTTL,
  patchDNSResponseForAge,
  localRateLimit,
  resolveWithParallelRace,
  isBetterDegraded,
  relay,
  getCache,
  setCache,
  APP_STATE
};
const UI_RESPONSE_CACHE = new Map();
const UI_RESPONSE_CACHE_MAX_ENTRIES = 16;
function renderUI(host) {
  let html = UI_RESPONSE_CACHE.get(host);
  if (html) return new Response(html, uiResponseInit());
  const safeHost = escapeHtml(host);
  const endpoint = `https://${safeHost}${CONFIG.DNS_PATH}`;
  html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Secure DNS over HTTPS (DoH) Pro</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🛡️</text></svg>">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #020617; color: #cbd5e1; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow-x: hidden; }
        .cyber-glass { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(15px); border: 1px solid rgba(0, 243, 255, 0.08); }
        .lang-fa { direction: rtl; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        .nav-active { background: #0ea5e9; color: white !important; border-color: #38bdf8 !important; box-shadow: 0 0 15px rgba(14, 165, 233, 0.3); }
        .panel { display: none; } .panel-active { display: block; animation: fadeInUp 0.3s ease-out; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        code { color: #22d3ee; font-family: monospace; background: #000; padding: 3px 7px; border-radius: 6px; }
        .btn-tab { transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); border: 1px solid #1e293b; }
    </style>
</head>
<body class="p-4 md:p-12">
    <!-- LANGUAGE SWITCHER -->
    <div class="fixed top-6 right-6 z-50">
        <button onclick="document.getElementById('langMenu').classList.toggle('hidden')" class="cyber-glass px-6 py-3 rounded-2xl flex items-center gap-4 text-xs font-bold border-cyan-500/20 hover:scale-[1.02] transition-transform">
            🌐 <span id="currentLang">LANGUAGE</span>
        </button>
        <div id="langMenu" class="hidden absolute right-0 mt-3 cyber-glass p-2 rounded-2xl w-44 shadow-2xl border-slate-800">
            <button onclick="changeLang('en')" class="w-full text-left p-3 hover:bg-sky-600 rounded-xl text-xs mb-1">ENGLISH</button>
            <button onclick="changeLang('fa')" class="w-full text-right p-3 hover:bg-emerald-600 rounded-xl text-xs mb-1">فارسی</button>
            <button onclick="changeLang('zh')" class="w-full text-left p-3 hover:bg-teal-600 rounded-xl text-xs">简体中文</button>
        </div>
    </div>
    <div class="max-w-4xl mx-auto">
        <header class="text-center py-16 md:py-24">
            <h1 class="text-5xl md:text-7xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-sky-300 to-emerald-400" id="mainTitle">Secure DNS over HTTPS</h1>
            <p id="subTag" class="mt-8 text-slate-500 font-bold uppercase tracking-[0.3em] text-[10px] md:text-xs">Edge Resolve Network • Parallel DoH Resolution</p>
        </header>
        <section class="cyber-glass rounded-[3rem] p-8 md:p-14 mb-10 text-center">
            <div class="mb-6">
                <span class="text-[11px] font-black text-cyan-500 tracking-widest uppercase mb-4 block" id="labelUrl">Endpoint URL</span>
                <input id="linkInp" value="${endpoint}" readonly class="w-full bg-black/40 border border-slate-800 p-5 rounded-2xl text-cyan-300 font-mono text-center text-sm outline-none focus:border-cyan-500/60">
            </div>
            <button onclick="copyURL()" class="bg-cyan-600 hover:bg-cyan-400 text-black font-black px-12 py-5 rounded-2xl transition-all shadow-xl active:scale-95">
                <span id="txtCopy">COPY ENDPOINT</span>
            </button>
        </section>
        <!-- TUTORIAL SECTION -->
        <div class="mb-16">
            <nav id="tutorialNav" class="flex flex-wrap gap-3 justify-center mb-8">
                <button onclick="tab('chrome', this)" id="btnC" class="btn-tab px-6 py-3 rounded-2xl text-[11px] font-black uppercase text-slate-400 nav-active">Chrome / Brave / Edge</button>
                <button onclick="tab('firefox', this)" id="btnF" class="btn-tab px-6 py-3 rounded-2xl text-[11px] font-black uppercase text-slate-400">Firefox</button>
                <button onclick="tab('mobile', this)" id="btnM" class="btn-tab px-6 py-3 rounded-2xl text-[11px] font-black uppercase text-slate-400">Android / iOS</button>
            </nav>
            <section id="docPanels" class="min-h-[300px]">
                <!-- Chrome/Edge Panel -->
                <div id="chrome" class="panel panel-active cyber-glass p-10 md:p-14 rounded-[3rem]">
                    <h3 class="text-2xl font-black mb-8 text-cyan-100" id="cH">Setup for Chromium Browsers</h3>
                    <div class="space-y-6 text-slate-400 text-sm leading-relaxed" id="cL">
                        <p>1. Open Browser <b>Settings</b> and type "DNS" in the search box.</p>
                        <p>2. Select <b>Security</b> > Scroll to <b>Use Secure DNS</b>.</p>
                        <p>3. Choose <b>"With Custom"</b> provider.</p>
                        <p>4. Paste your DoH endpoint URL from the copy-box above.</p>
                        <p>5. Test by visiting a DNS-restricted website.</p>
                    </div>
                </div>
                <!-- Firefox Panel -->
                <div id="firefox" class="panel cyber-glass p-10 md:p-14 rounded-[3rem]">
                    <h3 class="text-2xl font-black mb-8 text-emerald-100" id="fH">Setup for Firefox</h3>
                    <div class="space-y-6 text-slate-400 text-sm leading-relaxed" id="fL">
                        <p>1. Open Firefox <code>Settings</code> and scroll down to <b>Network Settings</b>.</p>
                        <p>2. Click <b>Settings...</b> and check <b>"Enable DNS over HTTPS"</b> at the bottom.</p>
                        <p>3. Set provider to <b>Custom</b> and paste your unique URL.</p>
                        <p>4. Select <b>"Max Protection"</b> for stronger browser-level DNS privacy.</p>
                    </div>
                </div>
                <!-- Mobile/iOS Panel -->
                <div id="mobile" class="panel cyber-glass p-10 md:p-14 rounded-[3rem]">
                    <h3 class="text-2xl font-black mb-8 text-teal-100" id="mH">Android / iOS Logic</h3>
                    <p class="text-slate-500 text-sm mb-6 italic" id="mD">This resolver is a DoH (HTTPS-based) service, which modern phones handle differently than system-wide settings.</p>
                    <div class="space-y-6 text-slate-400 text-sm" id="mL">
                        <p><b>A) For Mobile Browsers:</b> Open Browser settings (Chrome/Firefox/Edge) on your phone and follow the desktop steps. <b>This is the best and fastest way.</b></p>
                        <p><b>B) For System-wide Apps:</b> We recommend using <b>RethinkDNS</b> or <b>Intra</b> apps. In these apps, set the DNS type to DoH and provide your unique DoH endpoint link.</p>
                    </div>
                </div>
            </section>
        </div>
        <!-- SPECIAL EXPLANATION (Critical Point) -->
        <div class="cyber-glass p-8 md:p-12 rounded-[3.5rem] mb-20 border-sky-900/40 relative">
            <h4 class="text-sky-400 font-black text-base md:text-lg mb-6 flex items-center gap-3">
                ⭐ <span id="whyH">Why ONLY Browser-level DOH? (Crucial Tip)</span>
            </h4>
            <div class="space-y-6 text-[13px] md:text-[14px] text-slate-400 leading-loose" id="whyT">
                <p>Most operating systems (Windows settings, Android "Private DNS", or Apple Profiles) natively expect <b>DNS-over-TLS (DoT)</b> which runs on Port 853. Since this worker is built on <code>https://</code> and Port 443, it is not directly usable in these native settings.</p>
                <p><b>The Issue:</b> You <u>cannot</u> paste an <code>https://</code> link into many native DNS settings. It will usually result in an "Invalid Hostname" error. Systems there expect a hostname or DoT endpoint, not a full HTTPS resolver URL.</p>
                <p><b>The Solution:</b> Browsers (Chrome, Edge, Firefox) have their own independent DoH clients. They are compatible with Port 443 workers and provide browser-level encrypted DNS. DoH is therefore best configured directly in the browser.</p>
            </div>
        </div>
        <footer class="mt-32 pb-20 border-t border-slate-900 flex flex-col md:flex-row justify-between items-center opacity-60 gap-8">
            <div>
                <span class="text-[10px] font-black tracking-widest text-cyan-600 block mb-1">Secure DNS over HTTPS v${VERSION}</span>
                <p class="text-[9px] uppercase">Built with Edge-Computing Infrastructure</p>
            </div>
            <div class="flex gap-10 font-bold text-[10px] uppercase">
                <a href="https://github.com/t0ny54/DOH-Endpoints-Cloudflare-Worker" class="hover:text-cyan-400" target="_blank" rel="noreferrer">GitHub</a>
            </div>
        </footer>
    </div>
    <script>
        const I18N = {
            en: {
                main: 'Secure DNS over HTTPS', sub: 'Edge Resolve Network • Parallel DoH Resolution',
                urlL: 'Endpoint URL', cpT: 'COPY ENDPOINT', copied: 'LINK CAPTURED!', tabC: 'Chrome / Brave / Edge', tabF: 'Firefox', tabM: 'Android / iOS',
                cH: 'Chromium Browser Settings', cL: '<p>1. Open Browser <b>Settings</b> and find <b>Privacy & Security</b>.</p><p>2. Scroll to <b>"Use Secure DNS"</b>.</p><p>3. Select <b>"With Custom"</b>.</p><p>4. Paste the worker URL into the provider field.</p><p>5. Verify with a blocked site or your own DNS test.</p>',
                fH: 'Firefox Network Options', fL: '<p>1. In Firefox <code>Settings</code>, search for "DNS over HTTPS".</p><p>2. Select <b>Custom</b> from the providers dropdown.</p><p>3. Paste your DoH server address and confirm.</p><p>4. Switch to <b>Max Protection</b> for stronger privacy.</p>',
                mH: 'Mobile Setup Strategy', mD: 'Smartphones often prioritize DoT hostnames in system settings. To use this Worker DoH endpoint:',
                mL: '<p><b>In Browsers:</b> Setting it directly in Chrome or Firefox for Mobile is the easiest path.</p><p><b>For Apps:</b> Use <b>Intra</b> or <b>RethinkDNS</b> apps and set DoH as the resolver.</p>',
                whyH: 'Why Browser-Level ONLY? (The Technical Reality)',
                whyT: '<p>Operating systems like Windows/Android often expect <b>DoT (Port 853)</b> or native resolver formats and may not accept a full <code>https://</code> DoH URL. Workers on Cloudflare listen on <b>Port 443</b>, which fits browsers and not native system resolvers.</p><p>Browsers are the intended place to use this service.</p>',
                curL: 'ENGLISH'
            },
            fa: {
                main: 'سرویس امن DNS بر روی HTTPS', sub: 'پاسخگویی همزمان با سه سرور DNS و انتخاب اولین پاسخ معتبر',
                urlL: 'آدرس مستقیم سرور شما (DoH)', cpT: 'کپی آدرس هوشمند', copied: 'لینک کپی شد!', tabC: 'خانواده کروم', tabF: 'فایرفاکس', tabM: 'اندروید / آیفون',
                cH: 'تنظیمات در کروم، اج و بریو', cL: '<p>۱. در تنظیمات مرورگر کلمه DNS را جستجو کنید.</p><p>۲. وارد بخش Security شوید.</p><p>۳. گزینه «Use Secure DNS» را انتخاب کنید.</p><p>۴. آدرس سرور را در فیلد Custom وارد کنید.</p><p>۵. با جستجوی یک سایت محدود، نتیجه را تست کنید.</p>',
                fH: 'تنظیمات در مرورگر فایرفاکس', fL: '<p>۱. در فایرفاکس وارد Settings شوید و DNS over HTTPS را جستجو کنید.</p><p>۲. گزینه Custom را انتخاب کنید.</p><p>۳. URL سرویس DoH را وارد کنید.</p><p>۴. برای حداکثر محافظت، گزینه Max Protection را فعال کنید.</p>',
                mH: 'استراتژی راه‌اندازی در موبایل', mD: 'گوشی‌ها معمولاً در تنظیمات سیستمی به دنبال hostname برای DoT هستند؛ برای این سرویس DoH، بهترین روش در مرورگر است:',
                mL: '<p><b>داخل مرورگر:</b> بهترین راه تنظیم مستقیم در بخش Secure DNSِ کروم یا فایرفاکس است.</p><p><b>برای اپ‌ها:</b> از اپ‌های <b>Intra</b> یا <b>RethinkDNS</b> کمک بگیرید و نوع DNS را DoH تنظیم کنید.</p>',
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
        function getStoredLanguage() {
            let stored = 'en';
            try { stored = localStorage.getItem('doc_v6') || 'en'; } catch (_) {}
            return I18N[stored] ? stored : 'en';
        }
        function changeLang(c) {
            if (!I18N[c]) c = 'en';
            try { localStorage.setItem('doc_v6', c); } catch (_) {}
            const l = I18N[c];
            document.documentElement.lang = c;
            document.body.classList.toggle('lang-fa', c === 'fa');
            document.getElementById('currentLang').innerText = l.curL;
            document.getElementById('mainTitle').innerText = l.main;
            document.getElementById('subTag').innerText = l.sub;
            document.getElementById('labelUrl').innerText = l.urlL;
            document.getElementById('txtCopy').innerText = l.cpT;
            document.getElementById('btnC').innerText = l.tabC;
            document.getElementById('btnF').innerText = l.tabF;
            document.getElementById('btnM').innerText = l.tabM;
            document.getElementById('cH').innerText = l.cH;
            document.getElementById('cL').innerHTML = l.cL;
            document.getElementById('fH').innerText = l.fH;
            document.getElementById('fL').innerHTML = l.fL;
            document.getElementById('mH').innerText = l.mH;
            document.getElementById('mD').innerText = l.mD;
            document.getElementById('mL').innerHTML = l.mL;
            document.getElementById('whyH').innerText = l.whyH;
            document.getElementById('whyT').innerHTML = l.whyT;
            document.getElementById('langMenu').classList.add('hidden');
        }
        function tab(id, el) {
            document.querySelectorAll('.panel-active').forEach(p => { p.classList.remove('panel-active'); p.classList.add('panel'); });
            document.querySelectorAll('.btn-tab').forEach(b => b.classList.remove('nav-active'));
            document.getElementById(id).classList.add('panel-active');
            document.getElementById(id).classList.remove('panel');
            el.classList.add('nav-active');
        }
        async function copyURL() {
            const el = document.getElementById('linkInp');
            const lang = getStoredLanguage();
            const msg = I18N[lang]?.copied || 'LINK CAPTURED!';
            try {
                await navigator.clipboard.writeText(el.value);
            } catch (_) {
                el.select();
                document.execCommand('copy');
            }
            alert(msg);
        }
        window.onload = () => changeLang(getStoredLanguage());
    </script>
</body>
</html>`;
  UI_RESPONSE_CACHE.set(host, html);
  if (UI_RESPONSE_CACHE.size > UI_RESPONSE_CACHE_MAX_ENTRIES) {
    UI_RESPONSE_CACHE.delete(UI_RESPONSE_CACHE.keys().next().value);
  }
  return new Response(html, uiResponseInit());
}
function uiResponseInit() {
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none';",
    }
  };
}