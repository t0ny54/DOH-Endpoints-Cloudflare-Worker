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

test('skipDNSName follows backward pointers, rejects out-of-bounds pointers and loops', () => {
  assert.equal(dns.skipDNSName(Uint8Array.from([0x00, 1, 0x61, 0x00, 0xc0, 0x00]), 4), 6);
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


function rr(owner, type, rdata, ttl = 60, rrClass = 1) {
  return [
    ...owner,
    type >> 8, type & 0xff,
    rrClass >> 8, rrClass & 0xff,
    ttl >>> 24, (ttl >>> 16) & 0xff, (ttl >>> 8) & 0xff, ttl & 0xff,
    rdata.length >> 8, rdata.length & 0xff,
    ...rdata
  ];
}

function compressedOwner() {
  return [0xc0, 0x0c]; // points at the query QNAME
}

function aaaaRData() {
  return [
    0x20,0x01,0x0d,0xb8,0x00,0x00,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01
  ];
}

function rrsigRData() {
  return [
    0x00,0x01, // covered A
    0x08,     // algorithm
    0x03,     // labels
    0x00,0x00,0x00,0x3c, // original TTL
    0x65,0x53,0x12,0x34, // expiration
    0x65,0x52,0x12,0x34, // inception
    0x12,0x34, // key tag
    0xc0,0x0c, // signer name
    0xaa,0xbb // tiny synthetic signature
  ];
}

function dnskeyRData() {
  return [0x01,0x00,0x03,0x0d,0xaa,0xbb,0xcc,0xdd];
}

function dsRData() {
  return [0x12,0x34,0x08,0x02,0xaa,0xbb,0xcc,0xdd];
}

function nsecRData() {
  // Next name = example.com., then window 0, two-byte bitmap with A set.
  return [0xc0,0x0c,0x00,0x02,0x40,0x00];
}

function mxRData() {
  return [0x00,0x0a,0xc0,0x0c];
}

function srvRData() {
  return [0x00,0x00,0x00,0x05,0x01,0xbb,0xc0,0x0c];
}

test('validateDNSResponse handles compressed owner names across answer, authority, and additional sections', () => {
  const query = buildQuery(0x1010);
  const owner = compressedOwner();
  const a = rr(owner, 1, [1,2,3,4]);
  const ns = rr(owner, 2, [0xc0,0x0c]);

  const response = buildResponse(query, {
    answers: [a],
    authority: [ns],
    additional: [rr(owner, 28, aaaaRData())]
  });

  const result = dns.validateDNSResponse(response.buffer, 0x1010, query);
  assert.equal(result.ok, true);
});

test('validateDNSResponse rejects malformed compression pointers in every RR section', () => {
  const query = buildQuery(0x1111);
  const malformedOwner = [0xc0, 0xff]; // out of message bounds
  const malformed = rr(malformedOwner, 1, [1,2,3,4]);

  for (const section of ['answers', 'authority', 'additional']) {
    const opts = { answers: [], authority: [], additional: [] };
    opts[section] = [malformed];
    const response = buildResponse(query, opts);
    assert.equal(
      dns.validateDNSResponse(response.buffer, 0x1111, query).ok,
      false,
      `malformed owner should fail in ${section}`
    );
  }
});

test('compression pointers must target prior parsed label boundaries', () => {
  const query = buildQuery(0x1212);
  const header = [
    query[0], query[1], 0x81, 0x80,
    0x00,0x01,0x00,0x01,0x00,0x00,0x00,0x00
  ];

  // Answer owner starts at offset 29. Pointer target 40 is inside the answer,
  // is forward, and is therefore not a valid prior-name compression target.
  const forwardOwner = [0xc0,0x28];
  const response = Uint8Array.from([
    ...header,
    ...query.slice(12),
    ...rr(forwardOwner, 1, [1,2,3,4])
  ]);

  assert.equal(dns.validateDNSResponse(response.buffer, 0x1212, query).ok, false);
});

test('malformed and boundary-crossing SOA records are rejected', () => {
  const query = buildQuery(0x1313);

  // Valid compressed SOA: both MNAME and RNAME point at the query QNAME.
  const validSoa = rr(compressedOwner(), 6, [
    0xc0,0x0c,
    0xc0,0x0c,
    0,0,0,1,  0,0,0,2,  0,0,0,3,  0,0,0,4,  0,0,0,30
  ]);
  assert.equal(dns.validateDNSResponse(
    buildResponse(query, { rcode: 3, authority: [validSoa] }).buffer,
    0x1313,
    query
  ).ok, true);

  // RDLENGTH says the SOA stops before the final 20-byte numeric fields.
  const truncatedSoa = rr(compressedOwner(), 6, [
    0xc0,0x0c,
    0xc0,0x0c,
    0,0,0,1,  0,0,0,2, 0,0,0,3
  ]);
  assert.equal(dns.validateDNSResponse(
    buildResponse(query, { rcode: 3, authority: [truncatedSoa] }).buffer,
    0x1313,
    query
  ).ok, false);

  // The second SOA name uses a forward/self boundary into its own RDATA.
  const malformedSoa = rr(compressedOwner(), 6, [
    0xc0,0x0c,
    0xc0,0x4a,
    ...new Array(20).fill(0)
  ]);
  assert.equal(dns.validateDNSResponse(
    buildResponse(query, { rcode: 3, authority: [malformedSoa] }).buffer,
    0x1313,
    query
  ).ok, false);
});

test('malformed compressed names inside name-bearing RDATA are rejected in every RR section', () => {
  const query = buildQuery(0x1a1a);
  const badCname = rr(compressedOwner(), 5, [0xc0,0xff]); // CNAME target OOB.

  for (const section of ['answers', 'authority', 'additional']) {
    const opts = { answers: [], authority: [], additional: [] };
    opts[section] = [badCname];
    const response = buildResponse(query, opts);
    assert.equal(
      dns.validateDNSResponse(response.buffer, 0x1a1a, query).ok,
      false,
      `malformed RDATA name should fail in ${section}`
    );
  }
});

test('DNSSEC-heavy and IPv6/other-type responses remain valid and cacheable', () => {
  const query = buildQuery(0x1414, 'example.com', 28);
  const owner = compressedOwner();

  const response = buildResponse(query, {
    answers: [
      rr(owner, 28, aaaaRData(), 120),   // AAAA
      rr(owner, 15, mxRData(), 180),      // MX
      rr(owner, 33, srvRData(), 240),     // SRV
      rr(owner, 43, dsRData(), 300),      // DS
      rr(owner, 46, rrsigRData(), 300),   // RRSIG
      rr(owner, 48, dnskeyRData(), 300),  // DNSKEY
      rr(owner, 47, nsecRData(), 300)     // NSEC
    ]
  });

  const validated = dns.validateDNSResponse(response.buffer, 0x1414, query);
  assert.equal(validated.ok, true);
  assert.equal(dns.getDNSCacheTTL(response.buffer), 120);
});

test('expanded compressed names are rejected when they exceed the DNS 255-octet name limit', () => {
  const labels = new Array(4).fill(null).map(() => 'a'.repeat(63));
  const longName = encodeName(labels.join('.'));
  const bytes = Uint8Array.from(longName);
  assert.equal(dns.readDNSName(bytes, 0), null);
  assert.equal(dns.skipDNSName(bytes, 0), -1);
});

test('L1 cache expires entries and evicts the least-recently-used item', () => {
  const previousMax = dns.CONFIG.MAX_CACHE_ENTRIES;
  dns.CONFIG.MAX_CACHE_ENTRIES = 2;
  dns.APP_STATE.cache.clear();

  dns.setCache('expired', new ArrayBuffer(0), 10, Date.now() - 11_000);
  assert.equal(dns.getCache('expired'), null);

  dns.setCache('a', new ArrayBuffer(1), 60);
  dns.setCache('b', new ArrayBuffer(1), 60);
  assert.ok(dns.getCache('a')); // refresh A to MRU
  dns.setCache('c', new ArrayBuffer(1), 60);

  assert.ok(dns.getCache('a'));
  assert.equal(dns.getCache('b'), null);
  assert.ok(dns.getCache('c'));

  dns.APP_STATE.cache.clear();
  dns.CONFIG.MAX_CACHE_ENTRIES = previousMax;
});

test('timeout classification increments timeout without counting it as a generic failure', async () => {
  const realFetch = globalThis.fetch;
  const previousTimeout = dns.CONFIG.UPSTREAM_TIMEOUT_MS;
  dns.CONFIG.UPSTREAM_TIMEOUT_MS = 20;

  const node = {
    url: 'https://timeout.test/dns-query',
    order: 0,
    score: 100,
    ok: 0,
    fail: 0,
    timeout: 0,
    lastLatencyMs: null,
    ewmaLatencyMs: null,
    lastError: null,
    lastErrorKind: null
  };

  globalThis.fetch = async (_url, { signal } = {}) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    return new Response(new Uint8Array());
  };

  try {
    await assert.rejects(
      () => dns.relay(node, buildQuery(0x1515), 0x1515, new AbortController().signal)
    );
    assert.equal(node.timeout, 1);
    assert.equal(node.fail, 0);
    assert.equal(node.lastError, 'timeout');
    assert.equal(node.lastErrorKind, 'timeout');
  } finally {
    globalThis.fetch = realFetch;
    dns.CONFIG.UPSTREAM_TIMEOUT_MS = previousTimeout;
  }
});

test('HTTP errors and content-type failures are classified distinctly from DNS-invalid payloads', async () => {
  const realFetch = globalThis.fetch;
  const makeNode = () => ({
    url: 'https://failure.test/dns-query',
    order: 0,
    score: 100,
    ok: 0,
    fail: 0,
    timeout: 0,
    lastLatencyMs: null,
    ewmaLatencyMs: null,
    lastError: null,
    lastErrorKind: null
  });

  try {
    let node = makeNode();
    globalThis.fetch = async () => new Response('bad gateway', { status: 503 });
    await assert.rejects(() => dns.relay(node, buildQuery(0x1616), 0x1616, null));
    assert.match(node.lastError, /^Upstream HTTP 503/);
    assert.equal(node.lastErrorKind, 'http');

    node = makeNode();
    globalThis.fetch = async () => new Response('<html>oops</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
    await assert.rejects(() => dns.relay(node, buildQuery(0x1717), 0x1717, null));
    assert.equal(node.lastError, 'Upstream returned an invalid content type');
    assert.equal(node.lastErrorKind, 'content-type');

    node = makeNode();
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(60_000));
          controller.enqueue(new Uint8Array(6_000));
          controller.close();
        }
      }),
      { status: 200, headers: { 'content-type': 'application/dns-message' } }
    );
    await assert.rejects(() => dns.relay(node, buildQuery(0x1818), 0x1818, null));
    assert.equal(node.lastError, 'Upstream DNS response too large');
    assert.equal(node.lastErrorKind, 'response-too-large');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('NXDOMAIN vs NOERROR race timing respects the grace window', async () => {
  const realFetch = globalThis.fetch;
  const previousGrace = dns.CONFIG.NXDOMAIN_GRACE_MS;
  const previousTimeout = dns.CONFIG.UPSTREAM_TIMEOUT_MS;
  dns.CONFIG.NXDOMAIN_GRACE_MS = 60;
  dns.CONFIG.UPSTREAM_TIMEOUT_MS = 500;

  const makeNode = (url, order) => ({
    url, order,
    score: 100,
    ok: 0,
    fail: 0,
    timeout: 0,
    lastLatencyMs: null,
    ewmaLatencyMs: null,
    lastError: null,
    lastErrorKind: null
  });

  const nodes = [
    makeNode('https://race/nxdomain', 0),
    makeNode('https://race/noerror-fast', 1),
    makeNode('https://race/noerror-slow', 2)
  ];
  const query = buildQuery(0x1919);

  try {
    globalThis.fetch = async (url, { signal } = {}) => {
      const slow = String(url).endsWith('noerror-slow');
      const nx = String(url).endsWith('nxdomain');
      const delay = nx ? 0 : (slow ? 140 : 20);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });

      if (nx) {
        const body = buildResponse(query, { rcode: 3 });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/dns-message' }
        });
      }

      const body = buildResponse(query, { answers: [aRecord('1.2.3.4')] });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/dns-message' }
      });
    };

    const early = await dns.resolveWithParallelRace(nodes, query, 0x1919);
    assert.equal(early.rcode, 0);

    const lateNodes = [
      makeNode('https://race/nxdomain', 0),
      makeNode('https://race/noerror-slow-a', 1),
      makeNode('https://race/noerror-slow-b', 2)
    ];

    globalThis.fetch = async (url, { signal } = {}) => {
      const nx = String(url).endsWith('nxdomain');
      const delay = nx ? 0 : 140;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });

      const body = buildResponse(query, nx ? { rcode: 3 } : {
        answers: [aRecord('9.9.9.9')]
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/dns-message' }
      });
    };

    const late = await dns.resolveWithParallelRace(lateNodes, query, 0x1919);
    assert.equal(late.rcode, 3);
  } finally {
    globalThis.fetch = realFetch;
    dns.CONFIG.NXDOMAIN_GRACE_MS = previousGrace;
    dns.CONFIG.UPSTREAM_TIMEOUT_MS = previousTimeout;
  }
});

test('setCache honors an explicit expiry independent of storedAt (L2 -> L1 promotion)', () => {
  dns.APP_STATE.cache.clear();
  // Entry stored 1 h ago (old L2 entry): storedAt + TTL would already be in the past.
  const storedAt = Date.now() - 3_600_000;
  dns.setCache('promoted', new ArrayBuffer(1), 300, storedAt, Date.now() + 60_000);
  const hit = dns.getCache('promoted');
  assert.ok(hit, 'promoted entry must be served from L1');
  assert.equal(hit.storedAt, storedAt);
  dns.APP_STATE.cache.clear();
});

test('scanDNSName returns the encoded end offset and the lower-cased name in one pass', () => {
  const query = buildQuery(1, 'ExAmPle.COM');
  const out = { name: '' };
  const end = dns.scanDNSName(query, 12, null, out);
  assert.equal(out.name, 'example.com.');
  assert.equal(end, 12 + 1 + 7 + 1 + 3 + 1);
  assert.equal(dns.skipDNSName(query, 12), end);
  assert.equal(dns.readDNSName(query, 12), 'example.com.');
});

test('scanDNSName rejects pointer loops and forward pointers without a visited-set', () => {
  // Label "a" at 12, then a pointer at 14 back to 12 -> infinite loop if unchecked.
  const loop = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x61, 0xc0, 0x0c, 0, 0]);
  assert.equal(dns.scanDNSName(loop, 12), -1);
  const forward = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0x20, 0, 0]);
  assert.equal(dns.scanDNSName(forward, 12), -1);
});

test('localRateLimit evicts the least recently used IP, not an actively limited one', () => {
  const previousMax = dns.CONFIG.MAX_THROTTLE_ENTRIES;
  dns.APP_STATE.throttle.clear();
  dns.CONFIG.MAX_THROTTLE_ENTRIES = 2;
  try {
    dns.localRateLimit('busy');
    dns.localRateLimit('idle');
    dns.localRateLimit('busy');   // refresh recency of "busy"
    dns.localRateLimit('newcomer'); // forces one eviction
    assert.ok(dns.APP_STATE.throttle.has('busy'), 'active IP must keep its counter');
    assert.equal(dns.APP_STATE.throttle.get('busy').count, 2);
    assert.ok(!dns.APP_STATE.throttle.has('idle'));
  } finally {
    dns.CONFIG.MAX_THROTTLE_ENTRIES = previousMax;
    dns.APP_STATE.throttle.clear();
  }
});
