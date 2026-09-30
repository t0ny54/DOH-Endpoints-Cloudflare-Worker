import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internals as dns } from './Worker.js';

function encodeName(name) {
  if (!name) return [0];
  const out = [];
  for (const label of name.split('.')) {
    out.push(label.length, ...Buffer.from(label, 'ascii'));
  }
  out.push(0);
  return out;
}

function buildQuery(id, name = 'example.com', qtype = 1, qclass = 1, extra = []) {
  return Uint8Array.from([
    id >> 8, id & 0xff, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, extra.length ? 0x01 : 0x00,
    ...encodeName(name),
    qtype >> 8, qtype & 0xff, qclass >> 8, qclass & 0xff,
    ...extra
  ]);
}

function optRecord() {
  return [0x00, 0x00, 0x29, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
}

function aRecord(ip, ttl = 300) {
  return [
    0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
    ttl >>> 24, (ttl >>> 16) & 0xff, (ttl >>> 8) & 0xff, ttl & 0xff,
    0x00, 0x04, ...ip.split('.').map(Number)
  ];
}

function soaRecord(ttl = 60, minimum = 30) {
  return [
    0xc0, 0x0c, 0x00, 0x06, 0x00, 0x01,
    ttl >>> 24, (ttl >>> 16) & 0xff, (ttl >>> 8) & 0xff, ttl & 0xff,
    0x00, 0x24,
    0x02, 0x6e, 0x73, 0x00,             // mname "ns"
    0x0a, 0x68, 0x6f, 0x73, 0x74, 0x6d, 0x61, 0x73, 0x74, 0x65, 0x72, 0x00, // rname "hostmaster" (10 chars)
    0x00, 0x00, 0x00, 0x01,             // serial
    0x00, 0x00, 0x0e, 0x10,             // refresh 3600
    0x00, 0x00, 0x01, 0x2c,             // retry 300
    0x00, 0x09, 0x3a, 0x80,             // expire 600000
    minimum >>> 24, (minimum >>> 16) & 0xff, (minimum >>> 8) & 0xff, minimum & 0xff
  ];
}

function buildResponse(query, { rcode = 0, answers = [], authority = [], additional = [] } = {}) {
  const header = [
    query[0], query[1], 0x80, 0x80 | rcode, // QR + RA, RCODE in low nibble of byte 3
    0x00, 0x01,
    answers.length >> 8, answers.length & 0xff,
    authority.length >> 8, authority.length & 0xff,
    additional.length >> 8, additional.length & 0xff
  ];
  const question = [...query.slice(12)]; // echo the query's actual question section
  return Uint8Array.from([...header, ...question, ...answers.flat(), ...authority.flat(), ...additional.flat()]);
}

test('parseDNSQuestion accepts a valid query', () => {
  const r = dns.parseDNSQuestion(buildQuery(0x1234));
  assert.equal(r.ok, true);
  assert.equal(r.id, 0x1234);
});

test('parseDNSQuestion rejects responses, garbage trailing data', () => {
  const q = buildQuery(1);
  q[2] = 0x80;
  assert.equal(dns.parseDNSQuestion(q).ok, false);
  const trailing = Uint8Array.from([...buildQuery(1), 0xde, 0xad, 0xbe]);
  assert.equal(dns.parseDNSQuestion(trailing).ok, false);
});

test('parseDNSQuestion accepts a valid EDNS OPT record', () => {
  assert.equal(dns.parseDNSQuestion(buildQuery(1, 'example.com', 1, 1, optRecord())).ok, true);
});

test('skipDNSName follows pointers, rejects out-of-bounds pointers and loops', () => {
  assert.equal(dns.skipDNSName(Uint8Array.from([1, 0x61, 0xc0, 0x04, 1, 0x62, 0x00]), 0), 4);
  assert.equal(dns.skipDNSName(Uint8Array.from([1, 0x61, 0xc0, 0x3f, 1, 0x62, 0x00]), 0), -1);
  assert.equal(dns.skipDNSName(Uint8Array.from([0xc0, 0x00]), 0), -1);
  assert.equal(dns.skipDNSName(Uint8Array.from([1, 0x61, 0xc0, 0x02, 0x00]), 0), -1); // mutual loop
});

test('readDNSName expands and lowercases names, returns null on malformed input', () => {
  const bytes = Uint8Array.from([7, ...Buffer.from('ExAmPlE'), 3, 0x63, 0x6f, 0x6d, 0x00]);
  assert.equal(dns.readDNSName(bytes, 0), 'example.com.');
  assert.equal(dns.readDNSName(Uint8Array.from([0xc0, 0x00]), 0), null);
  assert.equal(dns.readDNSName(Uint8Array.from([0xc0, 0x2a]), 0), null);
});

test('validateDNSResponse rejects matching-ID fakes and mismatched questions', () => {
  const query = buildQuery(0x1234);
  const fake = Uint8Array.from([0x12, 0x34, 0x80, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
  assert.equal(dns.validateDNSResponse(fake.buffer, 0x1234, query).ok, false);
  const wrong = buildResponse(buildQuery(9, 'other.org'));
  assert.equal(dns.validateDNSResponse(wrong.buffer, 9, query).ok, false);
});

test('validateDNSResponse accepts a valid NOERROR answer, rejects trailing bytes', () => {
  const query = buildQuery(7);
  const good = buildResponse(query, { answers: [aRecord('93.184.216.34')] });
  const v = dns.validateDNSResponse(good.buffer, 7, query);
  assert.equal(v.ok, true);
  assert.equal(v.rcode, 0);
  const padded = Uint8Array.from([...good, 0x00]);
  assert.equal(dns.validateDNSResponse(padded.buffer, 7, query).ok, false);
});

test('validateDNSResponse accepts NXDOMAIN and rejects non-zero opcodes', () => {
  const query = buildQuery(5);
  const nx = buildResponse(query, { rcode: 3 });
  assert.equal(dns.validateDNSResponse(nx.buffer, 5, query).ok, true);
  const badOp = Uint8Array.from(nx);
  badOp[2] = 0x88; // opcode 1 (0x0800) + QR
  assert.equal(dns.validateDNSResponse(badOp.buffer, 5, query).ok, false);
});

test('getDNSCacheTTL honors min answer TTL', () => {
  const query = buildQuery(7);
  const res = buildResponse(query, { answers: [aRecord('1.2.3.4', 120)] });
  assert.equal(dns.getDNSCacheTTL(res.buffer), 120);
});

test('getDNSCacheTTL caches NXDOMAIN only with SOA (RFC 2308), uses min(SOA TTL, MINIMUM)', () => {
  const query = buildQuery(7);
  const bare = buildResponse(query, { rcode: 3 });
  assert.equal(dns.getDNSCacheTTL(bare.buffer), 0);
  const withSoa = buildResponse(query, { rcode: 3, authority: [soaRecord(60, 30)] });
  assert.equal(dns.getDNSCacheTTL(withSoa.buffer), 30);
});

test('getDNSCacheTTL refuses to cache SERVFAIL and truncated answers', () => {
  const query = buildQuery(7);
  assert.equal(dns.getDNSCacheTTL(buildResponse(query, { rcode: 2 }).buffer), 0);
  const tc = buildResponse(query, { answers: [aRecord('1.2.3.4')] });
  tc[2] |= 0x02;
  assert.equal(dns.getDNSCacheTTL(tc.buffer), 0);
});

test('isBetterDegraded prefers SERVFAIL, then score, then latency', () => {
  const mk = (rcode, latencyMs) => ({ rcode, latencyMs });
  const A = { score: 90 }, B = { score: 50 };
  assert.equal(dns.isBetterDegraded(mk(2, 500), B, mk(5, 10), A), true);
  assert.equal(dns.isBetterDegraded(mk(5, 10), A, mk(5, 10), B), true);
  assert.equal(dns.isBetterDegraded(mk(5, 5), A, mk(5, 10), A), true);
  assert.equal(dns.isBetterDegraded(mk(5, 50), B, mk(5, 10), A), false);
});

test('cache keys ignore case and transaction ID', async () => {
  const a = await dns.makeCacheKey(buildQuery(1, 'example.com'));
  const b = await dns.makeCacheKey(buildQuery(999, 'EXAMPLE.COM'));
  assert.equal(a, b);
});

import handler from './Worker.js';

function queryFor(id, name = 'example.com', qtype = 1, qclass = 1) {
  return buildQuery(id, name, qtype, qclass);
}

function responseFor(query, options = {}) {
  return new Response(buildResponse(query, options), {
    status: 200,
    headers: { 'content-type': 'application/dns-message' }
  });
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function requestFor(query, { method = 'POST', ip = '198.51.100.10', url = 'https://doh.test/dns-query' } = {}) {
  if (method === 'GET') {
    return new Request(`${url}?dns=${base64url(query)}`, {
      headers: { 'CF-Connecting-IP': ip }
    });
  }
  return new Request(url, {
    method,
    headers: {
      'content-type': 'application/dns-message',
      'CF-Connecting-IP': ip
    },
    body: query
  });
}

async function readBodyBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

test('Worker routes health, root and unknown paths', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    const health = await handler.fetch(new Request('https://doh.test/health'), {}, {});
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.version, '0.3.0');
    assert.equal(healthBody.upstreams.length, 3);
    assert.equal(healthBody.upstreamStrategy, 'parallel-race');

    const root = await handler.fetch(new Request('https://doh.test/'), {}, {});
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Secure DNS over HTTPS/);

    const missing = await handler.fetch(new Request('https://doh.test/nope'), {}, {});
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker validates DoH methods and payloads before upstream access', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not be called'); };
  try {
    const method = await handler.fetch(new Request('https://doh.test/dns-query', {
      method: 'PUT', headers: { 'CF-Connecting-IP': '198.51.100.20' }
    }), {}, {});
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET, POST');

    const missing = await handler.fetch(new Request('https://doh.test/dns-query', {
      headers: { 'CF-Connecting-IP': '198.51.100.21' }
    }), {}, {});
    assert.equal(missing.status, 400);

    const badB64 = await handler.fetch(new Request('https://doh.test/dns-query?dns=%%%bad', {
      headers: { 'CF-Connecting-IP': '198.51.100.22' }
    }), {}, {});
    assert.equal(badB64.status, 400);

    const badContentType = await handler.fetch(new Request('https://doh.test/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '198.51.100.23' },
      body: Uint8Array.from([1, 2, 3])
    }), {}, {});
    assert.equal(badContentType.status, 415);

    const oversized = await handler.fetch(new Request('https://doh.test/dns-query', {
      method: 'POST',
      headers: {
        'content-type': 'application/dns-message',
        'content-length': '4097',
        'CF-Connecting-IP': '198.51.100.24'
      },
      body: new Uint8Array(4097)
    }), {}, {});
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker races all three upstreams and returns the first valid NOERROR', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const query = queryFor(0x2201, 'race-success.example');
  const calls = [];
  const started = new Promise((resolve) => {
    let count = 0;
    globalThis.__raceStarted = () => { if (++count === 3) resolve(); };
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    globalThis.__raceStarted();
    const delay = String(url).includes('freedns') ? 10 : String(url).includes('dns-pi') ? 80 : 150;
    const body = buildResponse(query, { answers: [aRecord('93.184.216.34', 120)] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/dns-message' } });
  };

  try {
    const responsePromise = handler.fetch(requestFor(query, { ip: '198.51.100.30' }), {}, {});
    await started;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'MISS');
    assert.equal(response.headers.get('x-upstreams'), '3');
    assert.match(response.headers.get('x-winner'), /freedns/);
    const body = await readBodyBytes(response);
    assert.equal(body[0], 0x22);
    assert.equal(body[1], 0x01);
    assert.equal((body[6] << 8) | body[7], 1);
    assert.equal(calls.length, 3);
  } finally {
    delete globalThis.__raceStarted;
    globalThis.fetch = originalFetch;
  }
});

test('Worker holds NXDOMAIN briefly and accepts a later NOERROR', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const query = queryFor(0x2202, 'race-nxdomain.example');
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('freedns')) {
      return responseFor(query, { rcode: 3 });
    }
    if (String(url).includes('dns-pi')) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
      return responseFor(query, { answers: [aRecord('1.2.3.4', 60)] });
    }
    throw new Error('simulated upstream failure');
  };
  try {
    const response = await handler.fetch(requestFor(query, { ip: '198.51.100.31' }), {}, {});
    assert.equal(response.status, 200);
    const body = await readBodyBytes(response);
    assert.equal(body[3] & 0x0f, 0);
    assert.equal((body[6] << 8) | body[7], 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker returns deterministic degraded SERVFAIL instead of caching it', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const query = queryFor(0x2203, 'degraded.example');
  let calls = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls += 1;
    const requestQuery = new Uint8Array(options.body);
    const rcode = String(url).includes('dns-pi') ? 5 : 2;
    return responseFor(requestQuery, { rcode });
  };
  try {
    const response = await handler.fetch(requestFor(query, { ip: '198.51.100.32' }), {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-dns-degraded'), '1');
    assert.equal((await readBodyBytes(response))[3] & 0x0f, 2);
    assert.equal(calls, 3);

    const again = await handler.fetch(requestFor(queryFor(0x2204, 'degraded.example'), { ip: '198.51.100.32' }), {}, {});
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('x-cache'), 'MISS');
    assert.equal(calls, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker shares POST/GET cache entries and restores transaction ID and QNAME case', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const first = queryFor(0x3301, 'CaseTest.Example');
  const second = queryFor(0x3302, 'casetest.example');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return responseFor(first, { answers: [aRecord('203.0.113.9', 300)] });
  };
  try {
    const a = await handler.fetch(requestFor(first, { ip: '198.51.100.33' }), {}, {});
    assert.equal(a.status, 200);
    const b = await handler.fetch(requestFor(second, { method: 'GET', ip: '198.51.100.34' }), {}, {});
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('x-cache'), 'L1-HIT');
    assert.equal(calls, 3);
    const body = await readBodyBytes(b);
    assert.equal(body[0], 0x33);
    assert.equal(body[1], 0x02);
    assert.equal(dns.readDNSName(body, 12), 'casetest.example.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker returns 502 for all-upstream failure, including coalesced waiters', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const query = queryFor(0x4401, 'coalesce-failure.example');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    await gate;
    throw new Error('offline');
  };
  try {
    const p1 = handler.fetch(requestFor(query, { ip: '198.51.100.40' }), {}, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const p2 = handler.fetch(requestFor(query, { ip: '198.51.100.41' }), {}, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.status, 502);
    assert.equal(b.status, 502);
    assert.equal(await a.text(), 'Global resolving failed');
    assert.equal(await b.text(), 'Global resolving failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker local fallback rate limiter blocks the 101st request in a window', { concurrency: false }, async () => {
  const ip = '198.51.100.250';
  const results = [];
  for (let i = 0; i < 101; i++) {
    const response = await handler.fetch(new Request('https://doh.test/dns-query', {
      headers: { 'CF-Connecting-IP': ip }
    }), {}, {});
    results.push(response.status);
  }
  assert.equal(results.slice(0, 100).every((status) => status === 400), true);
  assert.equal(results[100], 429);
});

test('Worker serves a valid L2 Cache API hit and patches age/transaction ID', { concurrency: false }, async () => {
  const originalCaches = globalThis.caches;
  const query = queryFor(0x5502, 'edge-cache.example');
  const storedBody = buildResponse(queryFor(0, 'edge-cache.example'), {
    answers: [aRecord('192.0.2.53', 120)]
  });
  const key = await dns.makeCacheKey(query);
  const storedAt = Date.now() - 5000;
  let matchCalls = 0;
  let putCalls = 0;
  let cacheResponse = new Response(storedBody, {
    status: 200,
    headers: {
      'content-type': 'application/dns-message',
      'x-doh-stored-at': String(storedAt),
      'x-doh-ttl': '120'
    }
  });

  globalThis.caches = {
    default: {
      async match(request) {
        matchCalls += 1;
        assert.match(request.url, new RegExp(`/__doh-cache/v1/${key}$`));
        return cacheResponse.clone();
      },
      async put(request, response) {
        putCalls += 1;
        cacheResponse = response.clone();
      }
    }
  };
  try {
    const response = await handler.fetch(requestFor(query, { ip: '198.51.100.50' }), {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'L2-HIT');
    assert.equal(response.headers.get('x-edge-cache'), 'HIT');
    assert.equal(response.headers.get('x-upstreams'), '0');
    assert.equal(matchCalls, 1);
    assert.equal(putCalls, 0);
    const body = await readBodyBytes(response);
    assert.equal((body[0] << 8) | body[1], 0x5502);
    const questionEnd = dns.skipDNSName(body, 12);
    assert.ok(questionEnd > 0);
    assert.equal(readUint32ForTest(body, questionEnd + 4 + 6), 115);
  } finally {
    globalThis.caches = originalCaches;
  }
});

function readUint32ForTest(bytes, offset) {
  return (((bytes[offset] * 256 + bytes[offset + 1]) * 256 + bytes[offset + 2]) * 256 + bytes[offset + 3]) >>> 0;
}

test('Worker uses the native DNS_RATE_LIMITER binding when available', { concurrency: false }, async () => {
  let calls = 0;
  const env = {
    DNS_RATE_LIMITER: {
      async limit({ key }) {
        calls += 1;
        assert.equal(key, '198.51.100.60');
        return { success: false };
      }
    }
  };
  const response = await handler.fetch(new Request('https://doh.test/dns-query', {
    headers: { 'CF-Connecting-IP': '198.51.100.60' }
  }), env, {});
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});
