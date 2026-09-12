import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { HostedState, digest } from '../lib/hosted/state.mjs';
import { HostedPlatform } from '../lib/hosted/platform.mjs';
import { cookieHeader, verifyAppleIdentity, AccountICloud } from '../lib/hosted/icloud.mjs';
import { ForwardMailboxReader } from '../lib/forward-mailbox.mjs';
import { createHostedServer } from '../hosted.mjs';
const password = 'synthetic-admin-password-2026';
const cookies = value => [{ name: 'X-APPLE-DS-WEB-SESSION-TOKEN', value }, { name: 'X-APPLE-WEBAUTH-TOKEN', value: 'synthetic-web' }];
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-hosted-'));
  const key = randomBytes(32), path = join(dataDir, 'platform.enc'), state = new HostedState(path, key);
  await state.initialize('admin', password);
  const reads = [];
  const platform = new HostedPlatform({ state, dataDir,
    verifyIdentity: async header => ({ ...(header.includes('=account-a;') ? { appleId: 'a@example.test', dsid: '111' } : { appleId: 'b@example.test', dsid: '222' }), hmeOrigin: 'https://p42-maildomainws.icloud.com' }),
    cloudFactory: () => ({ list: async () => [{ email: 'synced@icloud.com', label: 'hme-010' }], generate: async () => ({ email: 'generated@icloud.com', label: 'hme-011' }), generateBatch: async () => ({ generated: [], errors: [] }) }),
    mailReaderFactory: accountId => ({ listForAlias: async (email, settings) => { reads.push({ accountId, email, settings }); return [{ subject: `${accountId}:${email}`, text: 'Your code is 123456', receivedAt: new Date().toISOString(), codes: ['123456'] }]; } }),
    autoOptions: { setIntervalImpl: () => 1, clearIntervalImpl() {} }, ...options });
  const a = await platform.addAccount({ name: 'Account A', appleId: 'a@example.test' });
  const b = await platform.addAccount({ name: 'Account B', appleId: 'b@example.test' });
  const ka = await platform.createKey(a.id, 'upload', 'Chrome A'), kb = await platform.createKey(b.id, 'upload', 'Chrome B');
  await platform.syncCookies(ka.token, cookies('account-a')); await platform.syncCookies(kb.token, cookies('account-b'));
  await platform.updateAccount(a.id, { paused: false }); await platform.updateAccount(b.id, { paused: false });
  await platform.runtime(a.id).store.createInventoryItems([{ email: 'a-one@icloud.com', label: 'a-001' }, { email: 'a-two@icloud.com', label: 'a-002' }]);
  await platform.runtime(b.id).store.createInventoryItems([{ email: 'b-one@icloud.com', label: 'b-001' }]);
  const ai = (await platform.runtime(a.id).store.read()).inventory, bi = (await platform.runtime(b.id).store.read()).inventory;
  t.after(async () => { await platform.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return { platform, state, path, dataDir, key, a, b, ka, kb, ai, bi, reads };
}
async function httpFixture(t, options) {
  const f = await fixture(t, options);
  const origin = 'http://127.0.0.1:19876';
  const server = createHostedServer({ platform: f.platform, adminOrigin: origin, allowHttp: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (path, { method = 'GET', data, cookie, csrf, token, from = origin } = {}) => {
    return new Promise((resolveRequest, reject) => {
      const r = httpRequest(base + path, { method, headers: { Host: '127.0.0.1:19876', ...(from ? { Origin: from } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) } }, response => {
        const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => { const headers = new Headers(Object.entries(response.headers).map(([k,v]) => [k, Array.isArray(v) ? v.join(',') : v])); resolveRequest({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)), cookie: response.headers['set-cookie']?.[0].split(';')[0], headers }); });
      }); r.on('error', reject); if (data !== undefined) r.write(JSON.stringify(data)); r.end();
    });
  };
  const login = await request('/admin-api/login', { method: 'POST', data: { username: 'admin', password } });
  assert.equal(login.status, 200);
  return { ...f, request, admin: { cookie: login.cookie, csrf: login.value.csrf } };
}

test('hosted state encrypts credentials, rejects corrupt/wrong-key state and refuses reinitialization', async t => {
  const f = await fixture(t);
  const raw = await readFile(f.path, 'utf8');
  assert.ok(!raw.includes('account-a') && !raw.includes('a@example.test') && !raw.includes(password));
  await assert.rejects(f.state.initialize('admin', password), { code: 'EEXIST' });
  await assert.rejects(new HostedState(f.path, randomBytes(32)).read());
  const env = JSON.parse(raw); env.tag = randomBytes(16).toString('base64'); await writeFile(f.path, JSON.stringify(env));
  await assert.rejects(f.state.read());
});
test('account creation, sync and generated inventory never produce mailbox tokens', async t => {
  const f = await fixture(t);
  await f.platform.syncInventory(f.a.id);
  await f.platform.runtime(f.a.id).autoStock.manualOne('hme-011');
  assert.equal((await f.state.read()).grants.length, 0);
  assert.equal((await f.platform.inventory()).length, 2);
  assert.deepEqual((await f.platform.inventory(f.b.id))[0].inventory.map(i => i.email), ['b-one@icloud.com']);
});
test('wrong-account and ambiguous cookie uploads leave stored cookies and identity unchanged', async t => {
  const f = await fixture(t), before = await f.platform.account(f.a.id);
  await assert.rejects(f.platform.syncCookies(f.ka.token, cookies('account-b')), { code: 'ACCOUNT_IDENTITY_MISMATCH' });
  assert.equal((await f.platform.account(f.a.id)).cookieHeader, before.cookieHeader);
  assert.throws(() => cookieHeader([...cookies('account-a'), { name: 'X-APPLE-WEBAUTH-TOKEN', value: 'different' }]), { code: 'AMBIGUOUS_COOKIES' });
  assert.throws(() => cookieHeader(cookies('bad;header')), { code: 'INVALID_COOKIES' });
  await f.state.mutate(s => { s.keys.find(k => k.id === f.ka.id).revoked = true; });
  await assert.rejects(f.platform.syncCookies(f.ka.token, cookies('account-a')), { code: 'INVALID_KEY' });
});
test('Apple identity must be returned by verified endpoint, never inferred from uploaded metadata', async () => {
  let request;
  const identity = await verifyAppleIdentity('synthetic', 'china', async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ dsInfo: { dsid: '123', appleId: 'A@EXAMPLE.TEST' } }) }; });
  assert.equal(identity.appleId, 'a@example.test'); assert.match(request.url, /^https:\/\/setup.icloud.com.cn\//); assert.equal(request.init.redirect, 'error');
  await assert.rejects(verifyAppleIdentity('synthetic', 'global', async () => ({ ok: true, json: async () => ({ dsInfo: { dsid: '123' } }) })), { code: 'APPLE_LOGIN_REQUIRED' });
});
test('explicit distribution is permanent, atomic and does not alter inventory/read group', async t => {
  const f = await fixture(t), id = f.ai[0].id;
  const results = await Promise.allSettled([f.platform.distribute(f.a.id, [id], 'Permanent owner'), f.platform.distribute(f.a.id, [id], 'Repeated click')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const g = (await f.state.read()).grants[0]; assert.equal(g.expiresAt, null); assert.equal(g.recipient, results.find(r => r.status === 'fulfilled').value[0].recipient); assert.equal(g.token, undefined);
  assert.equal((await f.platform.runtime(f.a.id).store.read()).inventory[0].group, f.ai[0].group);
  await assert.rejects(f.platform.distribute(f.a.id, [f.bi[0].id], 'Wrong account'), { code: 'EMAIL_NOT_AVAILABLE' });
  await assert.rejects(f.platform.distribute(f.a.id, [f.ai[1].id, id], 'Partial batch'), { code: 'ALREADY_DISTRIBUTED_RESET_EXISTING' });
  assert.equal((await f.state.read()).grants.length, 1);
});
test('reset invalidates old token/session, retains permanent owner and original history floor; revoke never recycles', async t => {
  const f = await fixture(t), [g] = await f.platform.distribute(f.a.id, [f.ai[0].id], 'Owner');
  assert.equal((await f.platform.authorizeGrant(g.token)).id, g.id);
  const reset = await f.platform.changeGrant(g.id, 'reset');
  assert.equal(reset.since, g.since); assert.equal(reset.recipient, 'Owner'); assert.equal(reset.expiresAt, null);
  await assert.rejects(f.platform.authorizeGrant(g.token)); await assert.rejects(f.platform.checkGrant(g.id, g.revision));
  assert.equal((await f.platform.authorizeGrant(reset.token)).id, g.id);
  await f.platform.changeGrant(g.id, 'revoke'); await assert.rejects(f.platform.authorizeGrant(reset.token));
  await assert.rejects(f.platform.distribute(f.a.id, [f.ai[0].id], 'New person'), { code: 'ALREADY_DISTRIBUTED_RESET_EXISTING' });
});
test('restarting the platform retains permanent token authorization but inventory read does not leak token hashes', async t => {
  const f = await fixture(t), [g] = await f.platform.distribute(f.a.id, [f.ai[0].id], 'Owner');
  const restored = new HostedPlatform({ state: new HostedState(f.path, f.key), dataDir: f.dataDir });
  assert.equal((await restored.authorizeGrant(g.token)).id, g.id);
  const serialized = JSON.stringify(await restored.inventory()); assert.ok(!serialized.includes(digest(g.token))); assert.ok(!serialized.includes(g.token));
  await restored.stop();
});
test('public/admin/upload/program capabilities are separated; CSRF blocks cross-origin mutations', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/admin-api/inventory')).status, 401);
  assert.equal((await f.request('/admin-api/accounts', { method: 'POST', cookie: f.admin.cookie, data: {} })).status, 403);
  assert.equal((await f.request('/admin-api/accounts', { method: 'POST', ...f.admin, from: 'https://evil.example', data: {} })).status, 403);
  assert.equal((await f.request('/admin-api/inventory', { token: f.ka.token })).status, 401);
  const program = await f.platform.createKey(f.a.id, 'program', 'Reader', ['inventory:read']);
  assert.equal((await f.request(`/admin-api/accounts/${f.a.id}/inventory`, { token: program.token })).status, 200);
  assert.equal((await f.request(`/admin-api/accounts/${f.b.id}/inventory`, { token: program.token })).status, 403);
  assert.equal((await f.request('/admin-api/keys', { token: program.token })).status, 403);
  assert.equal((await f.request('/api/icloud/list')).status, 404);
  assert.equal((await f.request('/mail-api/messages?token=secret')).status, 400);
  const before = (await f.platform.account(f.a.id)).cookieHeader;
  assert.equal((await f.request('/bridge/v1/sync', { method: 'POST', token: f.ka.token, data: { expectedAccountId: f.b.id, cookies: cookies('account-a') } })).status, 409);
  assert.equal((await f.platform.account(f.a.id)).cookieHeader, before);
});
test('single mailbox session never selects another mailbox from URL, and revoked sessions stop reading', async t => {
  const f = await httpFixture(t), [g] = await f.platform.distribute(f.a.id, [f.ai[0].id], 'Owner');
  const login = await f.request('/mail-api/login', { method: 'POST', data: { token: g.token } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const auth = { cookie: login.cookie };
  const mail = await f.request('/mail-api/messages', auth);
  assert.equal(mail.status, 200); assert.equal(mail.value.email, f.ai[0].email); assert.equal(f.reads[0].settings.strictRecipients, true); assert.equal(f.reads[0].settings.since, g.since);
  assert.equal((await f.request(`/mail-api/messages/${f.bi[0].id}`, auth)).status, 404);
  assert.equal((await f.request('/admin-api/inventory', auth)).status, 401);
  assert.equal((await f.request('/admin-api/inventory', { token: g.token })).status, 401);
  await f.platform.changeGrant(g.id, 'revoke'); assert.equal((await f.request('/mail-api/messages', auth)).status, 401);
});
test('authorization is rechecked after slow mailbox response, including revoke during fetch', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const f = await httpFixture(t, { mailReaderFactory: () => ({ listForAlias: async () => { await delayed; return [{ text: 'secret mail' }]; } }) });
  const [g] = await f.platform.distribute(f.a.id, [f.ai[0].id], 'Owner');
  const login = await f.request('/mail-api/login', { method: 'POST', data: { token: g.token } });
  const pending = f.request('/mail-api/messages', { cookie: login.cookie });
  await new Promise(resolve => setTimeout(resolve, 30)); await f.platform.changeGrant(g.id, 'revoke'); release();
  const result = await pending; assert.equal(result.status, 401); assert.ok(!JSON.stringify(result.value).includes('secret mail'));
});
test('account-scoped mail cache never reuses account A result for B; grant floor is part of cache key', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.platform.messages(f.a.id, f.ai[0].id), f.platform.messages(f.b.id, f.bi[0].id)]);
  assert.notEqual(a[0].subject, b[0].subject);
  await f.platform.messages(f.a.id, f.ai[0].id); assert.equal(f.reads.length, 2);
  await f.platform.messages(f.a.id, f.ai[0].id, new Date().toISOString()); assert.equal(f.reads.length, 3);
});
test('strict reader rejects body-only alias matches and forged Date, preserving legacy mode', async () => {
  const raw = (recipient, body, date) => `From: source@example.test\r\nTo: ${recipient}\r\nDate: ${date}\r\nSubject: Mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  const items = [
    { uid: 1, internalDate: new Date('2026-09-11'), source: raw('target@icloud.com', 'old target', 'Sun, 12 Sep 2032 12:00:00 GMT') },
    { uid: 2, internalDate: new Date('2026-09-13'), source: raw('other@icloud.com', 'mentions target@icloud.com but private to other', 'Sun, 13 Sep 2026 12:00:00 GMT') },
    { uid: 3, internalDate: new Date('2026-09-13'), source: raw('target@icloud.com', 'new target', 'Sun, 13 Sep 2026 12:00:00 GMT') }
  ];
  const reader = new ForwardMailboxReader({ configProvider: async () => ({ email: 'forward@example.test', password: 'synthetic', host: 'imap.example.test' }), clientFactory: () => ({ on() {}, connect: async () => {}, logout: async () => {}, mailboxOpen: async () => {}, search: async () => [1, 2, 3], async *fetch() { yield* items; } }) });
  const strict = await reader.listForAlias('target@icloud.com', { strictRecipients: true, since: '2026-09-12T00:00:00Z' });
  assert.equal(strict.length, 1); assert.equal(strict[0].text, 'new target');
  assert.equal((await reader.listForAlias('target@icloud.com')).length, 3);
});
test('generation persists successful prefix and stops after uncertain result without silent retry', async t => {
  const f = await fixture(t); const requests = [];
  const cloud = new AccountICloud({ getAccount: () => f.platform.account(f.a.id), store: f.platform.runtime(f.a.id).store,
    fetchImpl: async (url, init) => { requests.push({ url, body: init.body }); if (requests.length === 3) throw new Error('timeout'); return { ok: true, json: async () => ({ success: true, result: { hme: 'new@icloud.com' } }) }; } });
  const result = await cloud.generateBatch(['hme-001', 'hme-002', 'hme-003']);
  assert.equal(result.generated.length, 1); assert.equal(result.errors[0].code, 'GENERATION_RESULT_UNCERTAIN'); assert.equal(requests.length, 3);
  assert.equal((await f.platform.runtime(f.a.id).store.read()).hostedSequence.hme, 2);
});

test('simultaneous cookie syncs are serialized and a revoked key cannot finish an in-flight update', async t => {
  const f = await fixture(t); let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.platform.verifyIdentity = async () => { entered(); await gate; return { appleId: 'a@example.test', dsid: '111' }; };
  const before = (await f.platform.account(f.a.id)).cookieHeader;
  const pending = f.platform.syncCookies(f.ka.token, cookies('new-session'));
  await started; await f.state.mutate(s => { s.keys.find(k => k.id === f.ka.id).revoked = true; }); release();
  await assert.rejects(pending, { code: 'INVALID_KEY' }); assert.equal((await f.platform.account(f.a.id)).cookieHeader, before);
});
test('background inbox scan updates correct account only, never creates tokens or changes group', async t => {
  const f = await fixture(t, { mailReaderFactory: () => ({ latestForAliases: async emails => ({ messages: Object.fromEntries(emails.map(email => [email, { receivedAt: '2026-09-14T00:00:00Z', text: 'scanned', subject: 'new', codes: ['123456'] }])), truncated: false }) }) });
  await f.platform.scanMail(f.a.id);
  const a = await f.platform.runtime(f.a.id).store.read(), b = await f.platform.runtime(f.b.id).store.read();
  assert.equal(a.inventory[0].unread, true); assert.equal(a.inventory[0].group, f.ai[0].group); assert.notEqual(b.inventory[0].subject, 'new');
  assert.equal((await f.state.read()).grants.length, 0);
  await f.platform.runtime(f.a.id).store.updateInventoryItems([{ id: f.ai[0].id, patch: { unread: false } }]);
  await f.platform.scanMail(f.a.id); assert.equal((await f.platform.runtime(f.a.id).store.read()).inventory[0].unread, false);
});

test('editing forwarding settings never silently sends an old password to a new server', async t => {
  const f = await fixture(t);
  const forward = { host: 'imap.example.test', email: 'forward@example.test', port: 993, secure: true, password: 'synthetic-mail-password' };
  await f.platform.updateAccount(f.a.id, { forward });
  await assert.rejects(f.platform.updateAccount(f.a.id, { forward: { ...forward, host: 'other.example.test', password: '' } }), { code: 'NEW_IMAP_PASSWORD_REQUIRED' });
  assert.equal((await f.platform.account(f.a.id)).forward.host, forward.host);
  await f.platform.updateAccount(f.a.id, { forward: { ...forward, password: '' } });
  assert.equal((await f.platform.account(f.a.id)).forward.password, forward.password);
  const publicRows = await f.platform.inventory(f.a.id);
  assert.equal(publicRows[0].forwardSettings, undefined);
  const adminRows = await f.platform.inventory(f.a.id, { includeSettings: true });
  assert.equal(adminRows[0].forwardSettings.host, forward.host);
  assert.ok(!JSON.stringify(adminRows).includes(forward.password));
});

test('inactive Apple aliases are synchronized so existing grants stop accepting logins', async t => {
  const f = await fixture(t), [grant] = await f.platform.distribute(f.a.id, [f.ai[0].id], 'Owner');
  const cloud = new AccountICloud({ getAccount: () => f.platform.account(f.a.id), store: f.platform.runtime(f.a.id).store,
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: { hmeEmails: [{ hme: f.ai[0].email, isActive: false }] } }) }) });
  await f.platform.runtime(f.a.id).store.syncAliases(await cloud.list());
  await assert.rejects(f.platform.checkGrant(grant.id, grant.revision), { code: 'MAILBOX_UNAVAILABLE' });
});

test('production requires different HTTPS hosts for admin and public inbox cookies', async t => {
  const f = await fixture(t);
  assert.throws(() => createHostedServer({ platform: f.platform, adminOrigin: 'https://admin.example.test' }), /SEPARATE_ADMIN_AND_MAIL_HOSTS_REQUIRED/);
  assert.throws(() => createHostedServer({ platform: f.platform, adminOrigin: 'https://example.test', mailOrigin: 'https://example.test:8443' }), /SEPARATE_ADMIN_AND_MAIL_HOSTS_REQUIRED/);
  const server = createHostedServer({ platform: f.platform, adminOrigin: 'https://admin.example.test', mailOrigin: 'https://mail.example.test' });
  server.close();
});

test('HME endpoints are discovered per account and reject non-Apple or cross-region origins', async () => {
  const reply = url => async () => ({ ok: true, json: async () => ({ dsInfo: { dsid: '123', appleId: 'a@example.test' }, webservices: { premiummailsettings: { url } } }) });
  const identity = await verifyAppleIdentity('synthetic', 'global', reply('https://p42-maildomainws.icloud.com'));
  assert.equal(identity.hmeOrigin, 'https://p42-maildomainws.icloud.com');
  for (const url of ['https://evil.example', 'https://p42-maildomainws.icloud.com.evil.example', 'https://p42-maildomainws.icloud.com:8443', 'https://p42-maildomainws.icloud.com.cn', 'http://p42-maildomainws.icloud.com', 'https://p42-maildomainws.icloud.com/private']) {
    await assert.rejects(verifyAppleIdentity('synthetic', 'global', reply(url)), { code: 'APPLE_HME_SERVICE_UNAVAILABLE' });
  }
  let requested;
  const cloud = new AccountICloud({ getAccount: async () => ({ identity, cookieHeader: 'synthetic', region: 'global' }), fetchImpl: async url => { requested = url; return { ok: true, json: async () => ({ success: true, result: { hmeEmails: [] } }) }; } });
  await cloud.list(); assert.equal(new URL(requested).hostname, 'p42-maildomainws.icloud.com');
});
