import assert from 'node:assert/strict';
import worker, { __internals as dns } from './Worker.js';

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
const realCrypto = globalThis.crypto;

function encodeName(name) {
  return [...name.split('.').flatMap(x => [x.length, ...Buffer.from(x)]), 0];
}
function query(id, name='example.com', type=1, cls=1) {
  return Uint8Array.from([id>>8,id&255,0,0,0,1,0,0,0,0,0,0,...encodeName(name),type>>8,type&255,cls>>8,cls&255]);
}
function answerFor(q, ip='1.2.3.4', ttl=60, rcode=0) {
  const b = [...q];
  b[0]=q[0]; b[1]=q[1]; b[2]=0x81; b[3]=rcode;
  b[6]=rcode===0?0:0; b[7]=rcode===0?1:0;
  if (rcode===0) b.push(0xc0,0x0c,0,1,0,1,(ttl>>>24)&255,(ttl>>>16)&255,(ttl>>>8)&255,ttl&255,0,4,...ip.split('.').map(Number));
  return Uint8Array.from(b);
}

let upstreamCalls = 0;
let mode = 'ok';
const cacheStore = new Map();
globalThis.caches = { default: {
  async match(req) { return cacheStore.get(req.url) || undefined; },
  async put(req, res) { cacheStore.set(req.url, res.clone()); }
}};

globalThis.fetch = async (url, opts={}) => {
  upstreamCalls++;
  const body = new Uint8Array(opts.body);
  if (mode === 'fail') throw new Error('upstream down');
  if (mode === 'slow') await new Promise(r=>setTimeout(r,80));
  const response = answerFor(body, '1.2.3.4', 60, mode === 'servfail' ? 2 : 0);
  return new Response(response, {status:200, headers:{'content-type':'application/dns-message'}});
};

const rateOK = { DNS_RATE_LIMITER: { limit: async()=>({success:true}) } };
const req = (path, opts={}) => new Request('https://dns.example.test'+path, opts);

// Routing / health / methods
let r = await worker.fetch(req('/')); assert.equal(r.status,200); assert.match(await r.text(), /DNS over HTTPS/);
r = await worker.fetch(req('/health')); assert.equal(r.status,200); assert.equal((await r.json()).version,'0.3.0');
r = await worker.fetch(req('/missing')); assert.equal(r.status,404);
r = await worker.fetch(req('/dns-query',{method:'PUT',headers:{'CF-Connecting-IP':'1'}}), rateOK); assert.equal(r.status,405);

// POST validation
const q1 = query(0x1234,'example.com');
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'2','content-type':'text/plain'},body:q1}), rateOK); assert.equal(r.status,415);
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'3','content-type':'application/dns-message'},body:new Uint8Array([1,2])}), rateOK); assert.equal(r.status,400);

// POST success, ID preserved
upstreamCalls=0; mode='ok';
const ctx = { jobs: [], waitUntil(p){ this.jobs.push(p); } };
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'4','content-type':'application/dns-message'},body:q1}), rateOK, ctx);
await Promise.all(ctx.jobs); assert.equal(r.status,200); assert.equal(r.headers.get('content-type'),'application/dns-message');
let out = new Uint8Array(await r.arrayBuffer()); assert.equal((out[0]<<8)|out[1],0x1234); assert.equal(upstreamCalls,3);

// L1 cache hit should avoid upstreams
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'5','content-type':'application/dns-message'},body:query(0x5678,'EXAMPLE.COM')}), rateOK); assert.equal(r.status,200); assert.equal(r.headers.get('x-cache'),'L1-HIT'); assert.equal(upstreamCalls,3);
out=new Uint8Array(await r.arrayBuffer()); assert.equal((out[0]<<8)|out[1],0x5678);

// GET shares cache namespace
const b64=Buffer.from(query(0x9abc,'example.com')).toString('base64url');
r = await worker.fetch(req('/dns-query?dns='+b64,{method:'GET',headers:{'CF-Connecting-IP':'6'}}), rateOK); assert.equal(r.status,200); assert.equal(r.headers.get('x-cache'),'L1-HIT');
out=new Uint8Array(await r.arrayBuffer()); assert.equal((out[0]<<8)|out[1],0x9abc);

// L2 hit using unique name after clearing L1 is hard through private state; verify Cache API write exists.
assert.ok(cacheStore.size >= 1);

// Rate limit fallback: use unique IP and call 101 times; avoid upstream work via a cached question.
const limiterIP='rate-test';
let saw429=false;
for(let i=0;i<101;i++) {
  const rr=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':limiterIP,'content-type':'application/dns-message'},body:q1}));
  if(i===100) saw429=rr.status===429;
}
assert.equal(saw429,true);

// Native binding denial
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'native','content-type':'application/dns-message'},body:q1}),{DNS_RATE_LIMITER:{limit:async()=>({success:false})}}); assert.equal(r.status,429);

// All upstream failures => 502 and coalescing failure should not throw.
mode='fail';
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'fail1','content-type':'application/dns-message'},body:query(0x2222,'failure.example')})); assert.equal(r.status,502); assert.equal(r.headers.get('x-upstreams'),'3');

// Size / base64 validation
const huge='A'.repeat(5463); r=await worker.fetch(req('/dns-query?dns='+huge,{method:'GET',headers:{'CF-Connecting-IP':'huge'}}), rateOK); assert.equal(r.status,413);
r=await worker.fetch(req('/dns-query?dns=%%%',{method:'GET',headers:{'CF-Connecting-IP':'badb64'}}), rateOK); assert.equal(r.status,400);

console.log('INTEGRATION TESTS: PASS');

// Concurrent coalescing: two identical cold misses should share one 3-upstream race.
dns.CONFIG.MAX_CACHE_ENTRIES = 512;
mode='slow'; upstreamCalls=0;
const coalesceQ=query(0x3333,'coalesce.example');
const p1=worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'c1','content-type':'application/dns-message'},body:coalesceQ}),rateOK);
const p2=worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'c2','content-type':'application/dns-message'},body:coalesceQ}),rateOK);
const [c1,c2]=await Promise.all([p1,p2]);
assert.equal(c1.status,200); assert.equal(c2.status,200);
assert.ok([c1.headers.get('x-cache'),c2.headers.get('x-cache')].includes('COALESCED'));
assert.equal(upstreamCalls,3);

// L2 Cache API hit: shrink L1 for the test, evict the original key, then serve it from L2.
mode='ok'; upstreamCalls=0; dns.CONFIG.MAX_CACHE_ENTRIES=1;
const evictQ=query(0x4444,'evict.example');
const evictCtx={jobs:[],waitUntil(p){this.jobs.push(p)}};
let er=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'e1','content-type':'application/dns-message'},body:evictQ}),rateOK,evictCtx);
await Promise.all(evictCtx.jobs); assert.equal(er.status,200);
const l2Ctx={jobs:[],waitUntil(p){this.jobs.push(p)}};
er=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'e2','content-type':'application/dns-message'},body:query(0x5555,'another.example')}),rateOK,l2Ctx);
await Promise.all(l2Ctx.jobs); assert.equal(er.status,200);
const beforeL2=upstreamCalls;
er=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'e3','content-type':'application/dns-message'},body:query(0x6666,'evict.example')}),rateOK);
assert.equal(er.status,200); assert.equal(er.headers.get('x-cache'),'L2-HIT'); assert.equal(upstreamCalls,beforeL2);

dns.CONFIG.MAX_CACHE_ENTRIES=512;
console.log('EXTENDED INTEGRATION TESTS: PASS');
