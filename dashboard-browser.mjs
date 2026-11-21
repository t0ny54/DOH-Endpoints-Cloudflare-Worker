// Optional end-to-end check of the dashboard in a real browser. It runs the Worker's own fetch()
// handler behind a local HTTP server, then drives the page with Playwright and fails on any page
// error or Content-Security-Policy violation. Playwright is not a project dependency:
//   npm install --no-save playwright && npx playwright install chromium
//   npm run test:dashboard
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (_) {
  console.error('Playwright is not installed. See the instructions at the top of dashboard-browser.mjs.');
  process.exit(1);
}
const { default: worker } = await import('./Worker.js');

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await worker.fetch(new Request(origin + req.url, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined
  }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  // Chromium reports CSP violations as console errors.
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  await page.goto(`${base}/`, { waitUntil: 'load' });

  // Language menu: open, pick each language, and check the title and lang attribute.
  for (const lang of ['fa', 'zh', 'en']) {
    if (!(await page.isVisible('#langMenu'))) await page.click('#langToggle');
    await page.click(`.lang-option[data-lang="${lang}"]`);
    assert.equal(await page.getAttribute('html', 'lang'), lang);
  }
  assert.equal(await page.innerText('#mainTitle'), 'Secure DNS over HTTPS');

  // Tabs: only the selected panel is visible.
  await page.click('#btnF');
  assert.equal(await page.getAttribute('#firefox', 'hidden'), null);
  assert.notEqual(await page.getAttribute('#chrome', 'hidden'), null);
  await page.click('#btnC');

  // Copy feedback appears on the button (the clipboard write is asynchronous, so poll).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.click('#copyBtn');
  for (let i = 0; i < 50 && (await page.innerText('#txtCopy')) === 'COPY ENDPOINT'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await page.innerText('#txtCopy'), 'LINK CAPTURED!');

  // A stored language is applied on load.
  await page.evaluate(() => localStorage.setItem('doc_v6', 'zh'));
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.innerText('#mainTitle'), 'Secure DoH 安全加密中心');
  // The copy feedback follows the active language, not only English.
  await page.click('#copyBtn');
  for (let i = 0; i < 50 && (await page.innerText('#txtCopy')) !== '已复制!'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await page.innerText('#txtCopy'), '已复制!');

  // A stored value that names an inherited property must fall back to English, not render "undefined".
  for (const stored of ['constructor', 'toString', '__proto__']) {
    await page.evaluate((value) => localStorage.setItem('doc_v6', value), stored);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.innerText('#mainTitle'), 'Secure DNS over HTTPS', stored);
    assert.equal(await page.getAttribute('html', 'lang'), 'en', stored);
    assert.equal(await page.innerText('#currentLang'), 'ENGLISH', stored);
  }
} finally {
  await browser.close();
  server.close();
}
assert.deepEqual(problems, [], `page errors or CSP violations:\n${problems.join('\n')}`);
console.log('DASHBOARD BROWSER TEST: PASS');
