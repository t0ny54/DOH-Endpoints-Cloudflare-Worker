import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = process.env.WRANGLER_SMOKE_HOST || '127.0.0.1';
const PORT = Number(process.env.WRANGLER_SMOKE_PORT || 8797);
const BASE = `http://${HOST}:${PORT}`;

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(npx, [
  '--no-install',
  'wrangler',
  'dev',
  '--local',
  '--port',
  String(PORT),
  '--ip',
  HOST
], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res;
      lastError = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Wrangler dev server did not become ready: ${lastError?.message || 'unknown error'}\n${logs}`);
}

try {
  await waitForServer();

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.equal(health.version, '0.4.0');
  assert.equal(health.maxSimultaneousUpstreams, 3);
  assert.equal(health.upstreamStrategy, 'parallel-race');

  const root = await fetch(`${BASE}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') || '', /^text\/html/i);

  // Deliberately invalid DoH input so the smoke test exercises the real
  // workerd Request/Response/binding path without contacting public upstreams.
  const badDNS = await fetch(`${BASE}/dns-query?dns=not_base64!`, {
    headers: { 'CF-Connecting-IP': 'wrangler-smoke' }
  });
  assert.equal(badDNS.status, 400);

  const wrongMethod = await fetch(`${BASE}/dns-query`, {
    method: 'PUT',
    headers: { 'CF-Connecting-IP': 'wrangler-smoke-2' }
  });
  assert.equal(wrongMethod.status, 405);

  console.log('WRANGLER DEV SMOKE TEST: PASS');
} finally {
  child.kill('SIGTERM');
}
