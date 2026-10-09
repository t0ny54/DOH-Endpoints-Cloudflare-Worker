import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { __internals as dns } from './Worker.js';
const PKG_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
function encodeName(name) {
  return [...name.split('.').flatMap(x => [x.length, ...Buffer.from(x)]), 0];
}
function query(id, name='example.com', type=1, cls=1) {
  return Uint8Array.from([id>>8,id&255,0,0,0,1,0,0,0,0,0,0,...encodeName(name),type>>8,type&255,cls>>8,cls&255]);
}
function answerFor(q, ip='1.2.3.4', ttl=60, rcode=0) {
  const b = [...q];
  b[2]=0x81; b[3]=rcode;
  if (rcode===0) {
    b[7]=1;
    b.push(0xc0,0x0c,0,1,0,1,(ttl>>>24)&255,(ttl>>>16)&255,(ttl>>>8)&255,ttl&255,0,4,...ip.split('.').map(Number));
  }
  return Uint8Array.from(b);
}
let upstreamCalls = 0;
let mode = 'ok';
const cacheStore = new Map();
globalThis.caches = { default: {
  async match(req) { return cacheStore.get(req.url)?.clone(); },
  async put(req, res) { cacheStore.set(req.url, res.clone()); }
}};
globalThis.fetch = async (url, opts={}) => {
  upstreamCalls++;
  const body = new Uint8Array(opts.body);
  if (mode === 'fail') throw new Error('upstream down');
  if (mode === 'timeout') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
  if (mode === 'slow') await new Promise(r=>setTimeout(r,80));
  if (mode === 'http-error') {
    return new Response('upstream error page', {
      status: 503,
      headers: {'content-type':'text/plain; charset=utf-8'}
    });
  }
  if (mode === 'bad-content-type') {
    return new Response('<html>not dns</html>', {
      status: 200,
      headers: {'content-type':'text/html'}
    });
  }
  if (mode === 'oversized-chunked') {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(60_000));
          controller.enqueue(new Uint8Array(6_000));
          controller.close();
        }
      }),
      {status:200, headers:{'content-type':'application/dns-message'}}
    );
  }
  const response = answerFor(body, '1.2.3.4', 60, mode === 'servfail' ? 2 : 0);
  return new Response(response, {status:200, headers:{'content-type':'application/dns-message'}});
};
const rateOK = { DNS_RATE_LIMITER: { limit: async()=>({success:true}) } };
const req = (path, opts={}) => new Request('https://dns.example.test'+path, opts);
let r = await worker.fetch(req('/')); assert.equal(r.status,200); assert.match(await r.text(), /DNS over HTTPS/);
r = await worker.fetch(req('/health')); assert.equal(r.status,200); assert.equal((await r.json()).version,PKG_VERSION);
r = await worker.fetch(req('/missing')); assert.equal(r.status,404);
r = await worker.fetch(req('/dns-query',{method:'PUT',headers:{'CF-Connecting-IP':'1'}}), rateOK); assert.equal(r.status,405);
const q1 = query(0x1234,'example.com');
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'2','content-type':'text/plain'},body:q1}), rateOK); assert.equal(r.status,415);
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'3','content-type':'application/dns-message'},body:new Uint8Array([1,2])}), rateOK); assert.equal(r.status,400);
upstreamCalls=0; mode='ok';
const ctx = { jobs: [], waitUntil(p){ this.jobs.push(p); } };
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'4','content-type':'application/dns-message'},body:q1}), rateOK, ctx);
await Promise.all(ctx.jobs); assert.equal(r.status,200); assert.equal(r.headers.get('content-type'),'application/dns-message');
let out = new Uint8Array(await r.arrayBuffer()); assert.equal((out[0]<<8)|out[1],0x1234); assert.equal(upstreamCalls,3);
r = await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'5','content-type':'application/dns-message'},body:query(0x5678,'EXAMPLE.COM')}), rateOK); assert.equal(r.status,200); assert.equal(r.headers.get('x-cache'),'L1-HIT'); assert.equal(upstreamCalls,3);
out=new Uint8Array(await r.arrayBuffer()); assert.equal((out[0]<<8)|out[1],0x5678);
const b64=Buffer.from(query(0x9abc,'example.com')).toString('base64url');
r = await worker.fetch(req('/dns-query?dns='+b64,{method:'GET',headers:{'CF-Connecting-IP':'6'}}), rateOK); assert.equal(r.status,200); assert.equal(r.headers.get('x-cache'),'L1-HIT');
out=new Uint8Array(await r.arrayBuffer()); assert.equal((out[0]<<8)|out[1],0x9abc);
assert.ok(cacheStore.size >= 1);
const limiterIP='rate-test';
let saw429=false;
for(let i=0;i<101;i++) {
  const rr=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':limiterIP,'content-type':'application/dns-message'},body:q1}));
  if(i===100) saw429=rr.status===429;
}
assert.equal(saw429,true);
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'native','content-type':'application/dns-message'},body:q1}),{DNS_RATE_LIMITER:{limit:async()=>({success:false})}}); assert.equal(r.status,429);
mode='fail';
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'fail1','content-type':'application/dns-message'},body:query(0x2222,'failure.example')})); assert.equal(r.status,502); assert.equal(r.headers.get('x-upstreams'),'3');
const healthAfterFail=await (await worker.fetch(req('/health'))).json();
assert.ok(healthAfterFail.upstreams.every(u=>u.lastErrorKind==='network'));
const huge='A'.repeat(5463); r=await worker.fetch(req('/dns-query?dns='+huge,{method:'GET',headers:{'CF-Connecting-IP':'huge'}}), rateOK); assert.equal(r.status,413);
r=await worker.fetch(req('/dns-query?dns=%%%',{method:'GET',headers:{'CF-Connecting-IP':'badb64'}}), rateOK); assert.equal(r.status,400);
dns.CONFIG.MAX_CACHE_ENTRIES = 512;
mode='slow'; upstreamCalls=0;
const coalesceQ=query(0x3333,'coalesce.example');
const p1=worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'c1','content-type':'application/dns-message'},body:coalesceQ}),rateOK);
const p2=worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'c2','content-type':'application/dns-message'},body:coalesceQ}),rateOK);
const [c1,c2]=await Promise.all([p1,p2]);
assert.equal(c1.status,200); assert.equal(c2.status,200);
assert.ok([c1.headers.get('x-cache'),c2.headers.get('x-cache')].includes('COALESCED'));
assert.equal(upstreamCalls,3);
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
mode='http-error'; upstreamCalls=0;
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'http-error','content-type':'application/dns-message'},body:query(0x7777,'http-error.example')}),rateOK);
assert.equal(r.status,502); assert.equal(r.headers.get('x-upstreams'),'3');
const healthAfterHttp=await (await worker.fetch(req('/health'))).json();
assert.ok(healthAfterHttp.upstreams.every(u=>u.lastErrorKind==='http'));
mode='bad-content-type'; upstreamCalls=0;
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'content-type','content-type':'application/dns-message'},body:query(0x7778,'content-type.example')}),rateOK);
assert.equal(r.status,502); assert.equal(r.headers.get('x-upstreams'),'3');
mode='oversized-chunked'; upstreamCalls=0;
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'chunked-large','content-type':'application/dns-message'},body:query(0x7779,'chunked-large.example')}),rateOK);
assert.equal(r.status,502); assert.equal(r.headers.get('x-upstreams'),'3');
const previousTimeout= dns.CONFIG.UPSTREAM_TIMEOUT_MS;
dns.CONFIG.UPSTREAM_TIMEOUT_MS=25;
mode='timeout'; upstreamCalls=0;
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'timeout-class','content-type':'application/dns-message'},body:query(0x7780,'timeout-class.example')}),rateOK);
assert.equal(r.status,502); assert.equal(r.headers.get('x-upstreams'),'3');
assert.ok(dns.APP_STATE.inflight.size === 0);
dns.CONFIG.UPSTREAM_TIMEOUT_MS=previousTimeout;
mode='ok'; dns.APP_STATE.cache.clear(); cacheStore.clear(); upstreamCalls=0;
const expiredQuery=query(0x7781,'expired-l2.example');
const expiredKey=await dns.makeCacheKey(expiredQuery);
cacheStore.set(`https://dns.example.test/__doh-cache/v1/${expiredKey}`, new Response(
  answerFor(expiredQuery,'8.8.8.8',60),
  {
    status:200,
    headers:{
      'content-type':'application/dns-message',
      'x-doh-stored-at':String(Date.now()-120_000),
      'x-doh-ttl':'30'
    }
  }
));
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'expired-l2','content-type':'application/dns-message'},body:expiredQuery}),rateOK);
assert.equal(r.status,200); assert.notEqual(r.headers.get('x-cache'),'L2-HIT'); assert.equal(upstreamCalls,3);
const realCacheGlobal=globalThis.caches;
globalThis.caches={default:{
  async match(){throw new Error('Cache match failed');},
  async put(){throw new Error('Cache put failed');}
}};
dns.APP_STATE.cache.clear(); upstreamCalls=0; mode='ok';
const cacheFailQ=query(0x7782,'cache-failure.example');
const cacheFailCtx={jobs:[],waitUntil(p){this.jobs.push(p)}};
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'cache-failure','content-type':'application/dns-message'},body:cacheFailQ}),rateOK,cacheFailCtx);
assert.equal(r.status,200); assert.equal(r.headers.get('x-cache'),'MISS');
await Promise.all(cacheFailCtx.jobs);
globalThis.caches=realCacheGlobal;
const previousRateMax=dns.CONFIG.RATE_LIMIT_MAX_REQUESTS;
dns.CONFIG.RATE_LIMIT_MAX_REQUESTS=1;
dns.APP_STATE.throttle.clear();
const malformedLimiter={DNS_RATE_LIMITER:{limit:async()=>({})}};
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'malformed-limiter','content-type':'application/dns-message'},body:query(0x7783,'limiter-malformed.example')}),malformedLimiter);
assert.equal(r.status,200);
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'malformed-limiter','content-type':'application/dns-message'},body:query(0x7784,'limiter-malformed.example')}),malformedLimiter);
assert.equal(r.status,429);
const throwingLimiter={DNS_RATE_LIMITER:{limit:async()=>{throw new Error('binding exploded')}}};
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'throw-limiter','content-type':'application/dns-message'},body:query(0x7785,'limiter-throw.example')}),throwingLimiter);
assert.equal(r.status,200);
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'throw-limiter','content-type':'application/dns-message'},body:query(0x7786,'limiter-throw.example')}),throwingLimiter);
assert.equal(r.status,429);
dns.CONFIG.RATE_LIMIT_MAX_REQUESTS=previousRateMax;
dns.APP_STATE.throttle.clear();
const previousInflightMax=dns.CONFIG.MAX_INFLIGHT_ENTRIES;
dns.CONFIG.MAX_INFLIGHT_ENTRIES=1;
dns.APP_STATE.cache.clear(); cacheStore.clear(); upstreamCalls=0; mode='slow';
const inflightQ=query(0x7787,'inflight-full-a.example');
const firstP=worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'inflight-a','content-type':'application/dns-message'},body:inflightQ}),rateOK);
for(let waited=0;waited<2000 && dns.APP_STATE.inflight.size===0;waited+=5) await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(dns.APP_STATE.inflight.size,1);
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'inflight-b','content-type':'application/dns-message'},body:query(0x7788,'inflight-full-b.example')}),rateOK);
assert.equal(r.status,503);
const firstResult=await firstP;
assert.equal(firstResult.status,200);
assert.equal(dns.APP_STATE.inflight.size,0);
dns.CONFIG.MAX_INFLIGHT_ENTRIES=previousInflightMax;
dns.APP_STATE.cache.clear(); cacheStore.clear(); upstreamCalls=0; mode='servfail';
const degradedQ=query(0x7789,'degraded.example');
for (const run of [1,2]) {
  const degradedCtx={jobs:[],waitUntil(p){this.jobs.push(p)}};
  r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'degraded','content-type':'application/dns-message'},body:degradedQ}),rateOK,degradedCtx);
  await Promise.all(degradedCtx.jobs);
  assert.equal(r.status,200);
  assert.equal(r.headers.get('x-dns-degraded'),'1');
  assert.equal(r.headers.get('x-cache'),'MISS');
  assert.equal(r.headers.get('x-upstreams'),'3');
  out=new Uint8Array(await r.arrayBuffer());
  assert.equal((out[0]<<8)|out[1],0x7789);
  assert.equal(out[3]&0x0f,2);
  assert.equal(upstreamCalls,3*run);
}
assert.equal(dns.APP_STATE.cache.size,0);
assert.equal(cacheStore.size,0);
assert.equal(dns.APP_STATE.inflight.size,0);
mode='ok'; dns.APP_STATE.cache.clear(); cacheStore.clear(); upstreamCalls=0;
const chunkedBody=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(3000));controller.enqueue(new Uint8Array(3000));controller.close();}});
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'client-chunked','content-type':'application/dns-message'},body:chunkedBody,duplex:'half'}),rateOK);
assert.equal(r.status,413);
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'client-length','content-type':'application/dns-message','content-length':'4097'},body:new Uint8Array(10)}),rateOK);
assert.equal(r.status,413);
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'client-empty','content-type':'application/dns-message'}}),rateOK);
assert.equal(r.status,400); assert.equal(upstreamCalls,0);
const malformedL2Q=query(0x778a,'malformed-l2.example');
const malformedL2Key=await dns.makeCacheKey(malformedL2Q);
cacheStore.set(`https://dns.example.test/__doh-cache/v1/${malformedL2Key}`, new Response(answerFor(malformedL2Q,'8.8.4.4',60),{status:200,headers:{'content-type':'application/dns-message'}}));
r=await worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'malformed-l2','content-type':'application/dns-message'},body:malformedL2Q}),rateOK);
assert.equal(r.status,200); assert.equal(r.headers.get('x-cache'),'MISS'); assert.equal(upstreamCalls,3);
dns.APP_STATE.cache.clear(); cacheStore.clear(); upstreamCalls=0; mode='slow';
const sharedQ=query(0x778b,'coalesced-headers.example');
const sharedCalls=[0,1].map((n)=>worker.fetch(req('/dns-query',{method:'POST',headers:{'CF-Connecting-IP':'shared'+n,'content-type':'application/dns-message'},body:sharedQ}),rateOK));
const sharedResponses=await Promise.all(sharedCalls);
const coalesced=sharedResponses.find((x)=>x.headers.get('x-cache')==='COALESCED');
assert.ok(coalesced);
assert.equal(coalesced.headers.get('x-upstreams'),'0');
assert.equal(coalesced.headers.get('x-edge-cache'),'SKIP');
assert.ok(coalesced.headers.get('x-winner'));
assert.match(coalesced.headers.get('x-winner-lat'),/^\d+ms$/);
mode='ok'; dns.APP_STATE.cache.clear(); cacheStore.clear();
dns.APP_STATE.cache.set('sweep-expired',{body:new ArrayBuffer(0),storedAt:0,expiresAt:1});
dns.APP_STATE.cache.set('sweep-live',{body:new ArrayBuffer(0),storedAt:Date.now(),expiresAt:Date.now()+60_000});
dns.APP_STATE.throttle.set('sweep-expired-ip',{count:1,resetAt:1});
dns.APP_STATE.throttle.set('sweep-live-ip',{count:1,resetAt:Date.now()+60_000});
dns.APP_STATE.lastSweepAt=0;
await worker.fetch(req('/health'));
assert.equal(dns.APP_STATE.cache.has('sweep-expired'),false); assert.equal(dns.APP_STATE.cache.has('sweep-live'),true);
assert.equal(dns.APP_STATE.throttle.has('sweep-expired-ip'),false); assert.equal(dns.APP_STATE.throttle.has('sweep-live-ip'),true);
dns.APP_STATE.cache.clear(); dns.APP_STATE.throttle.clear();
r=await worker.fetch(req('/index.html')); assert.equal(r.status,200);
assert.match(await r.text(),/document\.documentElement\.lang = c;/);
mode='ok';
console.log('INTEGRATION TESTS: PASS');