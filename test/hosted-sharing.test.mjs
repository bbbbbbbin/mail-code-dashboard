import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { HostedState, digest, grantExpired, publicGrant } from '../lib/hosted/state.mjs';
import { HostedPlatform } from '../lib/hosted/platform.mjs';
import { createHostedServer } from '../hosted.mjs';

const DAY_MS = 86400000;
const START = Date.parse('2026-09-13T12:00:00.000Z');
const password = 'synthetic-share-admin-2026';
const expiredError = { status: 401, code: 'MAIL_ACCESS_EXPIRED' };
function clock(t) {
  let now = START;
  t.mock.method(Date, 'now', () => now);
  return value => { now = value; };
}
async function fixture(t, reader) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-sharing-'));
  const path = join(dataDir, 'platform.enc'), key = randomBytes(32), state = new HostedState(path, key);
  await state.initialize('admin', password);
  let reads = 0;
  const platform = new HostedPlatform({ state, dataDir,
    cloudFactory: () => ({}),
    mailReaderFactory: () => ({ listForAlias: async (...args) => { reads++; return reader ? reader(...args) : [{ text: 'synthetic private mail', receivedAt: '2026-09-13T13:00:00.000Z' }]; } }),
    autoOptions: { setIntervalImpl: () => 1, clearIntervalImpl() {} } });
  const account = await platform.addAccount({ name: 'Synthetic account', appleId: 'owner@example.test' });
  await state.mutate(s => { s.accounts[0].paused = false; s.accounts[0].identity = { appleId: 'owner@example.test', dsid: 'synthetic' }; });
  await platform.runtime(account.id).store.createInventoryItems([{ email: 'share-one@icloud.com' }, { email: 'share-two@icloud.com' }]);
  const inventory = (await platform.runtime(account.id).store.read()).inventory;
  t.after(async () => { await platform.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, path, key, state, platform, account, inventory, reads: () => reads,
    distribute: (days, ids = [inventory[0].id], history = false) => platform.distribute(account.id, ids, 'Synthetic recipient', history, days) };
}
async function httpFixture(t, reader) {
  const f = await fixture(t, reader);
  const adminOrigin = 'http://127.0.0.1:19876', mailOrigin = 'http://localhost:19877';
  const server = createHostedServer({ platform: f.platform, adminOrigin, mailOrigin, allowHttp: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, { method = 'GET', data, cookie, csrf, token, from } = {}) => new Promise((resolveRequest, reject) => {
    const expected = path.startsWith('/mail-api/') ? mailOrigin : adminOrigin;
    const r = httpRequest(base + path, { method, headers: { Host: new URL(expected).host, Origin: from ?? expected,
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) } }, response => {
      const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolveRequest({ status: response.statusCode,
        value: JSON.parse(Buffer.concat(chunks)), cookie: response.headers['set-cookie']?.[0].split(';')[0], headers: response.headers }));
    });
    r.on('error', reject); if (data !== undefined) r.write(JSON.stringify(data)); r.end();
  });
  const login = await request('/admin-api/login', { method: 'POST', data: { username: 'admin', password } });
  assert.equal(login.status, 200);
  const admin = { cookie: login.cookie, csrf: login.value.csrf };
  return { ...f, request, admin, mailOrigin,
    patch: (id, data, auth = admin) => request(`/admin-api/grants/${id}`, { method: 'PATCH', ...auth, data }),
    refreshAdmin: async () => {
      const login = await request('/admin-api/login', { method: 'POST', data: { username: 'admin', password } });
      assert.equal(login.status, 200); Object.assign(admin, { cookie: login.cookie, csrf: login.value.csrf });
    },
    login: token => request('/mail-api/login', { method: 'POST', data: { token } }) };
}

test('grant expiry is exact, derived without changing ownership, and malformed non-null dates fail closed', () => {
  const grant = { id: 'synthetic', status: 'active', recipient: 'Owner', tokenHash: 'hidden', expiresAt: new Date(START).toISOString() };
  assert.equal(grantExpired(grant, START - 1), false);
  assert.equal(grantExpired(grant, START), true);
  assert.equal(publicGrant(grant, START).status, 'expired');
  assert.equal(grant.status, 'active');
  assert.equal(publicGrant(grant, START).recipient, 'Owner');
  assert.equal(publicGrant(grant, START).tokenHash, undefined);
  for (const expiresAt of ['bad', '', {}, [], false, 0, START + DAY_MS]) assert.equal(grantExpired({ expiresAt }, START), true);
  for (const expiresAt of [undefined, null]) assert.equal(grantExpired({ expiresAt }, START), false);
  assert.equal(publicGrant({ ...grant, status: 'revoked' }, START).status, 'revoked');
});

test('timed batch creation uses one server deadline and keeps only hashes; omitted days stay permanent', async t => {
  clock(t);
  const f = await fixture(t);
  const grants = await f.distribute(7, f.inventory.map(i => i.id));
  assert.equal(grants.length, 2);
  for (const g of grants) {
    assert.equal(g.createdAt, new Date(START).toISOString());
    assert.equal(g.since, g.createdAt);
    assert.equal(g.expiresAt, new Date(START + 7 * DAY_MS).toISOString());
    assert.equal((await f.platform.authorizeGrant(g.token)).id, g.id);
  }
  const state = await f.state.read();
  assert.equal(state.keys.length, 0);
  for (const g of grants) {
    const stored = state.grants.find(item => item.id === g.id);
    assert.equal(stored.tokenHash, digest(g.token));
    assert.equal(stored.token, undefined); assert.equal(stored.shareUrl, undefined);
    assert.ok(!JSON.stringify(state).includes(g.token));
    assert.ok(!(await readFile(f.path, 'utf8')).includes(g.token));
  }
  const legacy = await fixture(t);
  const [permanent] = await legacy.platform.distribute(legacy.account.id, [legacy.inventory[0].id], 'Legacy recipient');
  assert.equal(permanent.expiresAt, null);
  const [explicit] = await legacy.distribute(null, [legacy.inventory[1].id], true);
  assert.equal(explicit.expiresAt, null); assert.equal(explicit.since, null);
});

test('invalid duration types/ranges are rejected without any state mutation and max range is accepted', async t => {
  clock(t);
  const f = await fixture(t), before = await readFile(f.path, 'utf8');
  for (const days of [0, -1, 0.5, 3651, '7', '', true, false, {}, [], NaN, Infinity]) {
    await assert.rejects(f.distribute(days), { status: 400, code: 'INVALID_DURATION_DAYS' });
    assert.equal(await readFile(f.path, 'utf8'), before);
  }
  const [g] = await f.distribute(3650);
  assert.equal(g.expiresAt, new Date(START + 3650 * DAY_MS).toISOString());
});

test('expiry is calculated inside the serialized creation, not before a pending state write', async t => {
  const setNow = clock(t), f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const blocker = f.state.mutate(async () => { entered(); await gate; });
  await started;
  const pending = f.distribute(1);
  setNow(START + DAY_MS); release(); await blocker;
  const [g] = await pending;
  assert.equal(g.createdAt, new Date(START + DAY_MS).toISOString());
  assert.equal(g.expiresAt, new Date(START + 2 * DAY_MS).toISOString());
});

test('expired tokens, public listings and sessions fail at the boundary while legacy absent expiry survives restart', async t => {
  const setNow = clock(t), f = await httpFixture(t);
  const [g] = await f.distribute(1);
  setNow(START + DAY_MS - 1);
  const login = await f.login(g.token);
  assert.equal(login.status, 200); assert.equal(login.value.expiresAt, g.expiresAt);
  const mail = await f.request('/mail-api/messages', { cookie: login.cookie });
  assert.equal(mail.status, 200); assert.equal(mail.value.expiresAt, g.expiresAt); assert.equal(f.reads(), 1);
  setNow(START + DAY_MS);
  await assert.rejects(f.platform.authorizeGrant(g.token), expiredError);
  await assert.rejects(f.platform.checkGrant(g.id, g.revision), expiredError);
  const denied = await f.login(g.token); assert.equal(denied.status, 401); assert.equal(denied.value.error, 'MAIL_ACCESS_EXPIRED');
  const cached = await f.request('/mail-api/messages', { cookie: login.cookie });
  assert.equal(cached.status, 401); assert.equal(cached.value.error, 'MAIL_ACCESS_EXPIRED'); assert.equal(f.reads(), 1);
  await f.refreshAdmin();
  const listing = await f.request('/admin-api/grants', f.admin);
  assert.equal(listing.value.grants[0].status, 'expired');
  const inventory = await f.platform.inventory(f.account.id);
  assert.equal(inventory[0].inventory[0].distribution.status, 'expired');
  assert.equal((await f.state.read()).grants[0].status, 'active');
  await assert.rejects(f.distribute(2), { code: 'ALREADY_DISTRIBUTED_RESET_EXISTING' });
  const [legacy] = await f.distribute(null, [f.inventory[1].id]);
  await f.state.mutate(s => { delete s.grants.find(g => g.id === legacy.id).expiresAt; });
  setNow(START + 5000 * DAY_MS);
  const restored = new HostedPlatform({ state: new HostedState(f.path, f.key), dataDir: f.dataDir });
  assert.equal((await restored.authorizeGrant(legacy.token)).id, legacy.id);
  const legacyLogin = await f.login(legacy.token);
  assert.equal(legacyLogin.status, 200); assert.equal(legacyLogin.value.expiresAt, null);
  assert.equal((await f.request('/mail-api/messages', { cookie: legacyLogin.cookie })).value.expiresAt, null);
  await restored.stop();
});

test('malformed stored expiry denies both token login and an already-established session', async t => {
  clock(t);
  const f = await httpFixture(t), [g] = await f.distribute(1), login = await f.login(g.token);
  for (const expiresAt of ['invalid-date', '', false, 42, {}]) {
    await f.state.mutate(s => { s.grants[0].expiresAt = expiresAt; });
    assert.equal((await f.login(g.token)).value.error, 'MAIL_ACCESS_EXPIRED');
    const response = await f.request('/mail-api/messages', { cookie: login.cookie });
    assert.equal(response.status, 401); assert.equal(response.value.error, 'MAIL_ACCESS_EXPIRED');
  }
  assert.equal(f.reads(), 0);
});

test('a deadline reached while IMAP is in flight cannot release mail into the response', async t => {
  const setNow = clock(t); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await httpFixture(t, async () => { entered(); await gate; return [{ text: 'synthetic protected message' }]; });
  const [g] = await f.distribute(1);
  setNow(START + DAY_MS - 10);
  const login = await f.login(g.token), pending = f.request('/mail-api/messages', { cookie: login.cookie });
  await started; setNow(START + DAY_MS); release();
  const response = await pending;
  assert.equal(response.status, 401); assert.equal(response.value.error, 'MAIL_ACCESS_EXPIRED');
  assert.ok(!JSON.stringify(response.value).includes('synthetic protected message'));
  assert.equal((await f.state.read()).grants[0].lastUsedAt, undefined);
});

test('authorization is rechecked after the final last-used write before delivering mail', async t => {
  const setNow = clock(t), f = await httpFixture(t), [g] = await f.distribute(1);
  setNow(START + DAY_MS - 10);
  const login = await f.login(g.token), mutate = f.state.mutate.bind(f.state);
  t.mock.method(f.state, 'mutate', async fn => { const result = await mutate(fn); setNow(START + DAY_MS); return result; });
  const response = await f.request('/mail-api/messages', { cookie: login.cookie });
  assert.equal(response.status, 401); assert.equal(response.value.error, 'MAIL_ACCESS_EXPIRED');
  assert.equal(response.value.messages, undefined);
});

test('revoke, reset and expiry edits during the inventory read invalidate its pending authorization', async t => {
  clock(t);
  for (const action of ['revoke', 'reset', 'renew']) {
    const f = await fixture(t), [g] = await f.distribute(7), store = f.platform.runtime(f.account.id).store;
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const read = store.read.bind(store);
    t.mock.method(store, 'read', async () => { const result = await read(); entered(); await gate; return result; });
    const pending = f.platform.checkGrant(g.id, g.revision);
    await started;
    if (action === 'renew') await f.platform.updateGrant(g.id, 10);
    else await f.platform.changeGrant(g.id, action);
    release();
    await assert.rejects(pending, { status: 401, code: 'MAIL_ACCESS_REVOKED' });
  }
});

test('revocation overlapping the last inventory check cannot release an HTTP mail response', async t => {
  clock(t);
  const f = await httpFixture(t), [g] = await f.distribute(1), login = await f.login(g.token);
  const store = f.platform.runtime(f.account.id).store, read = store.read.bind(store);
  let reads = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.mock.method(store, 'read', async () => {
    const result = await read();
    if (++reads === 4) { entered(); await gate; }
    return result;
  });
  const pending = f.request('/mail-api/messages', { cookie: login.cookie });
  await started; await f.platform.changeGrant(g.id, 'revoke'); release();
  const response = await pending;
  assert.equal(response.status, 401); assert.equal(response.value.error, 'MAIL_ACCESS_REVOKED');
  assert.equal(response.value.messages, undefined);
});

test('a failed same-origin share login clears the prior mailbox session, but a foreign origin does not', async t => {
  const setNow = clock(t), f = await httpFixture(t), [permanent] = await f.distribute(null);
  const [timed] = await f.distribute(1, [f.inventory[1].id]);
  setNow(START + DAY_MS);
  const login = await f.login(permanent.token), auth = { cookie: login.cookie };
  const foreign = await f.request('/mail-api/login', { method: 'POST', ...auth, from: 'https://other.example.test', data: { token: timed.token } });
  assert.equal(foreign.status, 403); assert.equal(foreign.headers['set-cookie'], undefined);
  assert.equal((await f.request('/mail-api/messages', auth)).status, 200);
  const denied = await f.request('/mail-api/login', { method: 'POST', ...auth, data: { token: timed.token } });
  assert.equal(denied.status, 401); assert.equal(denied.value.error, 'MAIL_ACCESS_EXPIRED');
  assert.match(denied.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.request('/mail-api/messages', auth)).value.error, 'LOGIN_REQUIRED');
});

test('HTTP distribution/reset return fragment links only once and reset does not renew an expired grant', async t => {
  const setNow = clock(t), f = await httpFixture(t);
  const created = await f.request(`/admin-api/accounts/${f.account.id}/distribute`, { method: 'POST', ...f.admin,
    data: { emailIds: [f.inventory[0].id], recipient: 'Synthetic owner', durationDays: 7 } });
  assert.equal(created.status, 201); assert.equal(created.value.inboxUrl, `${f.mailOrigin}/inbox`);
  const g = created.value.grants[0];
  assert.equal(g.shareUrl, `${f.mailOrigin}/inbox#token=${encodeURIComponent(g.token)}`);
  assert.equal(new URL(g.shareUrl).search, '');
  assert.equal((await f.login(g.token)).status, 200);
  const reset = await f.request(`/admin-api/grants/${g.id}/reset`, { method: 'POST', ...f.admin, data: {} });
  assert.equal(reset.status, 200); assert.equal(reset.value.inboxUrl, created.value.inboxUrl);
  assert.equal(reset.value.shareUrl, `${f.mailOrigin}/inbox#token=${encodeURIComponent(reset.value.token)}`);
  assert.equal(reset.value.expiresAt, g.expiresAt); assert.equal(reset.value.since, g.since); assert.equal(reset.value.recipient, g.recipient);
  assert.equal((await f.login(g.token)).status, 401);
  setNow(START + 7 * DAY_MS);
  await f.refreshAdmin();
  const expiredReset = await f.request(`/admin-api/grants/${g.id}/reset`, { method: 'POST', ...f.admin, data: {} });
  assert.equal(expiredReset.status, 200); assert.equal(expiredReset.value.status, 'expired');
  assert.equal(expiredReset.value.expiresAt, g.expiresAt);
  assert.equal((await f.login(expiredReset.value.token)).value.error, 'MAIL_ACCESS_EXPIRED');
  const listing = await f.request('/admin-api/grants', f.admin);
  assert.equal(listing.value.grants[0].shareUrl, undefined); assert.equal(listing.value.grants[0].token, undefined); assert.equal(listing.value.grants[0].tokenHash, undefined);
  assert.ok(!JSON.stringify(await f.state.read()).includes(expiredReset.value.token));
});

test('explicit expiry edits use now, retain token/owner/history, invalidate old sessions and leave revocation intact', async t => {
  const setNow = clock(t), f = await httpFixture(t), [g] = await f.distribute(7);
  const login = await f.login(g.token), original = (await f.state.read()).grants[0];
  setNow(START + DAY_MS / 4);
  const shortened = await f.patch(g.id, { durationDays: 1 });
  assert.equal(shortened.status, 200); assert.equal(shortened.value.expiresAt, new Date(START + DAY_MS * 1.25).toISOString());
  assert.equal(shortened.value.revision, g.revision + 1); assert.equal(shortened.value.token, undefined); assert.equal(shortened.value.shareUrl, undefined);
  assert.equal((await f.request('/mail-api/messages', { cookie: login.cookie })).value.error, 'MAIL_ACCESS_REVOKED');
  setNow(START + 2 * DAY_MS);
  assert.equal((await f.login(g.token)).value.error, 'MAIL_ACCESS_EXPIRED');
  await f.refreshAdmin();
  const renewed = await f.patch(g.id, { durationDays: 3 });
  assert.equal(renewed.status, 200); assert.equal(renewed.value.expiresAt, new Date(START + 5 * DAY_MS).toISOString());
  assert.equal(renewed.value.status, 'active'); assert.equal((await f.login(g.token)).status, 200);
  const saved = (await f.state.read()).grants[0];
  for (const key of ['tokenHash', 'recipient', 'since', 'createdAt', 'mask']) assert.equal(saved[key], original[key]);
  const permanent = await f.patch(g.id, { durationDays: null });
  assert.equal(permanent.status, 200); assert.equal(permanent.value.expiresAt, null);
  await f.platform.changeGrant(g.id, 'revoke');
  const revoked = await f.patch(g.id, { durationDays: 30 });
  assert.equal(revoked.status, 200); assert.equal(revoked.value.status, 'revoked');
  assert.equal((await f.login(g.token)).status, 401);
  assert.equal((await f.state.read()).grants.length, 1); assert.equal((await f.state.read()).keys.length, 0);
  assert.ok(!JSON.stringify(await f.state.read()).includes(g.token));
});

test('expiry API requires an explicit valid duration and admin session+CSRF, never program/upload/mail credentials', async t => {
  clock(t);
  const f = await httpFixture(t), [g] = await f.distribute(1), before = await readFile(f.path, 'utf8');
  for (const data of [{}, { durationDays: 0 }, { durationDays: '7' }, { durationDays: false }, { durationDays: 1.5 }, { durationDays: 3651 }]) {
    const response = await f.patch(g.id, data);
    assert.equal(response.status, 400); assert.equal(response.value.error, 'INVALID_DURATION_DAYS');
    assert.equal(await readFile(f.path, 'utf8'), before);
  }
  assert.equal((await f.patch(g.id, { durationDays: 2 }, {})).status, 401);
  assert.equal((await f.patch(g.id, { durationDays: 2 }, { cookie: f.admin.cookie })).status, 403);
  assert.equal((await f.patch(g.id, { durationDays: 2 }, { ...f.admin, from: 'https://other.example.test' })).status, 403);
  const program = await f.platform.createKey(f.account.id, 'program', 'Synthetic program', ['inventory:read', 'mail:read', 'generate']);
  const upload = await f.platform.createKey(f.account.id, 'upload', 'Synthetic uploader');
  const keys = (await f.state.read()).keys.length;
  assert.equal((await f.patch(g.id, { durationDays: 2 }, { token: program.token })).status, 403);
  assert.equal((await f.patch(g.id, { durationDays: 2 }, { token: upload.token })).status, 401);
  assert.equal((await f.patch(g.id, { durationDays: 2 }, { token: g.token })).status, 401);
  const mailLogin = await f.login(g.token);
  assert.equal((await f.patch(g.id, { durationDays: 2 }, { cookie: mailLogin.cookie })).status, 401);
  assert.equal((await f.state.read()).keys.length, keys);
  assert.equal((await f.state.read()).grants[0].revision, g.revision);
});
