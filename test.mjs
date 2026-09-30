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
