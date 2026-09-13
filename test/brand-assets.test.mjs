import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { JSDOM } from 'jsdom';
import { createHostedServer } from '../hosted.mjs';

const ADMIN = 'admin.example.test', MAIL = 'mail.example.test';
const PRIVATE_TOKEN = 'synthetic-private-brand-test-token';
const assets = [
  ['/ui/brand/logo.svg', 'logo.svg', 'image/svg+xml'],
  ['/ui/brand/icon-32.png', 'icon-32.png', 'image/png'],
  ['/ui/brand/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
  ['/ui/brand/favicon.ico', 'favicon.ico', 'image/x-icon'],
  ['/favicon.ico', 'favicon.ico', 'image/x-icon'],
];

async function fixture(t) {
  let stateReads = 0;
  const platform = { state: { async read() { stateReads++; return { grants: [{ token: PRIVATE_TOKEN }] }; } } };
  const server = createHostedServer({ platform, adminOrigin: `https://${ADMIN}`, mailOrigin: `https://${MAIL}` });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, host = ADMIN, method = 'GET') => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: host, Authorization: `Bearer ${PRIVATE_TOKEN}`, Cookie: `__Host-md_mail=${PRIVATE_TOKEN}` } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { request, stateReads: () => stateReads };
}

function securityHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.match(response.headers['content-security-policy'], /img-src 'self' data:/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.ok(!response.body.includes(PRIVATE_TOKEN));
}

test('allowlisted brand assets return original bytes and explicit MIME on both isolated hosts', async t => {
  const f = await fixture(t);
  for (const [path, file, mime] of assets) {
    const expected = await readFile(new URL(`../web/brand/${file}`, import.meta.url));
    assert.ok(expected.length > 0);
    for (const host of [ADMIN, MAIL]) {
      const response = await f.request(path, host);
      assert.equal(response.status, 200, `${host}${path}`);
      assert.equal(response.headers['content-type'], mime);
      assert.deepEqual(response.body, expected);
      securityHeaders(response);
    }
  }
  assert.equal(f.stateReads(), 0, 'public branding never reads account or grant state');
});

test('brand asset serving preserves host rejection, exact allowlisting and query credential protection', async t => {
  const f = await fixture(t);
  for (const [path] of assets) {
    const wrongHost = await f.request(path, 'unrelated.example.test');
    assert.equal(wrongHost.status, 400);
    assert.deepEqual(JSON.parse(wrongHost.body), { error: 'HOST_REJECTED' });
    const query = await f.request(`${path}?token=${PRIVATE_TOKEN}`);
    assert.equal(query.status, 400);
    assert.deepEqual(JSON.parse(query.body), { error: 'QUERY_NOT_SUPPORTED' });
    const post = await f.request(path, ADMIN, 'POST');
    assert.equal(post.status, 404);
    for (const response of [wrongHost, query, post]) securityHeaders(response);
  }
  for (const path of [
    '/ui/brand/', '/ui/brand/missing.svg', '/ui/brand/logo.svg/private', '/ui/brand/logo.svg.bak',
    '/ui/brand/../../../data/platform.enc', '/ui/brand/%2e%2e/%2e%2e/secrets/master-key',
    '/ui/brand/..%2f..%2fsecrets%2fmaster-key', '/ui/brand/..%5c..%5csecrets%5cmaster-key',
    '/ui/brand/%2flogo.svg', '/ui/brand/logo.svg%00', '/ui/brand/Logo.svg',
    '/data/platform.enc', '/secrets/master-key', '/.env', '/hosted.mjs', '/ui/hosted.mjs',
  ]) {
    const response = await f.request(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(response.body), { error: 'NOT_FOUND' });
    securityHeaders(response);
  }
  assert.equal(f.stateReads(), 0);
});

test('branded pages use same-origin icons and retain isolated page access and existing script styles', async t => {
  const f = await fixture(t);
  for (const [path, host, otherHost] of [['/', ADMIN, MAIL], ['/admin', ADMIN, MAIL], ['/inbox', MAIL, ADMIN]]) {
    const response = await f.request(path, host);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    securityHeaders(response);
    const dom = new JSDOM(response.body.toString('utf8'));
    try {
      const d = dom.window.document;
      assert.match(d.title, /信屿/); assert.match(d.title, /MailIsle/);
      assert.ok(d.querySelector('link[rel="icon"][href="/ui/brand/logo.svg"][type="image/svg+xml"]'));
      assert.ok(d.querySelector('link[rel="icon"][href="/ui/brand/icon-32.png"][type="image/png"]'));
      assert.ok(d.querySelector('link[rel="apple-touch-icon"][href="/ui/brand/apple-touch-icon.png"]'));
      assert.ok(d.querySelector('img[src="/ui/brand/logo.svg"]'));
    } finally { dom.window.close(); }
    assert.equal((await f.request(path, otherHost)).status, 404);
  }
  for (const [path, mime] of [['/ui/admin.js', 'text/javascript; charset=utf-8'], ['/ui/inbox.js', 'text/javascript; charset=utf-8'], ['/ui/shared.js', 'text/javascript; charset=utf-8'], ['/ui/site.css', 'text/css; charset=utf-8']]) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], mime);
  }
  assert.equal(f.stateReads(), 0);
});
