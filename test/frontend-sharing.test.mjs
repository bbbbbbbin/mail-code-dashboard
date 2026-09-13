import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const NOW = Date.UTC(2026, 8, 13, 12);
const token = 'mbx_' + 'a'.repeat(43), secondToken = 'mbx_' + 'b'.repeat(43);
const link = `https://example.test/inbox#token=${token}`;
const expiresAt = new Date(NOW + 7 * 86_400_000).toISOString();
const grant = { id: 'grant-a', accountId: 'A', email: 'mailbox-a@example.test', recipient: 'Fixture recipient', status: 'active', expiresAt };

async function ui(t, page = 'inbox', { hash = '', routes = new Map(), seedOld = false, expires = expiresAt } = {}) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8'), { url: `https://example.test/${page}${hash}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window; t.after(() => w.close());
  const $ = selector => w.document.querySelector(selector);
  let now = NOW, timerId = 0;
  w.Date.now = () => now;
  const timeouts = new Map(), intervals = new Map(), calls = [], events = [], clipboard = [];
  w.setTimeout = (callback, ms) => { const id = ++timerId; timeouts.set(id, { callback, ms }); return id; };
  w.clearTimeout = id => timeouts.delete(id);
  w.setInterval = (callback, ms) => { const id = ++timerId; intervals.set(id, { callback, ms }); return id; };
  w.clearInterval = id => intervals.delete(id);
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => { clipboard.push(value); } } });
  const replace = w.history.replaceState.bind(w.history);
  w.history.replaceState = (...args) => { events.push({ event: 'replace', url: args[2] }); replace(...args); };
  const accounts = [{ id: 'A', name: 'Account A', inventory: [{ id: 'email-a', accountId: 'A', email: grant.email, distribution: { status: 'unassigned' } }, { id: 'email-b', accountId: 'A', email: 'mailbox-b@example.test', distribution: { status: 'unassigned' } }] }];
  const defaults = {
    '/admin-api/session': response({ csrf: 'fixture-csrf' }),
    '/admin-api/inventory': response({ accounts }),
    '/admin-api/grants': response({ grants: [grant] }),
    '/admin-api/accounts/A/distribute': response({ inboxUrl: 'https://example.test/inbox', grants: [{ ...grant, token, shareUrl: link }] }),
    '/mail-api/login': response({ email: grant.email, expiresAt: expires }),
    '/mail-api/messages': response({ email: grant.email, expiresAt: expires, messages: [{ subject: 'Fixture mail', text: '<img src="https://tracking.invalid/pixel">Plain text only', receivedAt: '2026-09-13T00:00:00Z', from: 'Fixture sender' }] }),
    '/mail-api/logout': response({ ok: true })
  };
  w.fetch = async (path, init = {}) => {
    const call = { path, method: init.method, data: init.body ? JSON.parse(init.body) : null, hash: w.location.hash, oldVisible: $('#messages')?.textContent.includes('OLD PRIVATE MAIL') || false };
    calls.push(call); events.push({ event: 'fetch', path });
    const route = routes.has(path) ? routes.get(path) : defaults[path] || response({});
    return typeof route === 'function' ? route(call) : route;
  };
  const dialog = $('dialog');
  if (dialog) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; setTimeout(() => dialog.dispatchEvent(new w.Event('close')), 0); };
  }
  if (seedOld) { $('#messages').textContent = 'OLD PRIVATE MAIL'; $('#mailbox-name').textContent = 'old-mailbox@example.test'; w.document.body.classList.add('is-authenticated'); }
  const shared = (await readFile(new URL('../web/shared.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const script = (await readFile(new URL(`../web/${page}.js`, import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, '');
  const context = dom.getInternalVMContext();
  vm.runInContext(`${shared}\nconst el = element;\n${script}`, context);
  await settle();
  return {
    w, $, routes, calls, events, accounts, clipboard, timeouts, intervals, errors,
    evaluate: source => vm.runInContext(source, context),
    click: text => { const button = [...w.document.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(button, `button ${text} exists`); button.click(); },
    submit: () => $('#dialog-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    advance: milliseconds => { now += milliseconds; },
    change: (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new w.Event('change', { bubbles: true })); }
  };
}

function assertNoMailbox(u) {
  assert.equal(u.$('#mailbox').hidden, true);
  assert.equal(u.$('#mailbox-name').textContent, '');
  assert.equal(u.$('#messages').textContent, '');
  assert.equal(u.$('#grant-expiry').textContent, '');
  assert.equal(u.w.document.body.classList.contains('is-authenticated'), false);
}

test('inbox: share fragment is removed before one login request; prior mailbox is never fetched or exposed', async t => {
  const u = await ui(t, 'inbox', { hash: `#token=${token}`, seedOld: true });
  assert.deepEqual(u.events.slice(0, 3), [{ event: 'replace', url: '/inbox' }, { event: 'fetch', path: '/mail-api/login' }, { event: 'fetch', path: '/mail-api/messages' }]);
  assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/login', '/mail-api/messages']);
  assert.deepEqual(u.calls[0].data, { token });
  assert.ok(u.calls.every(c => c.hash === '' && c.oldVisible === false));
  assert.equal(u.w.location.search, '');
  assert.equal(u.w.location.hash, '');
  assert.equal(u.$('[name=token]').value, '');
  assert.equal(u.w.localStorage.length, 0);
  assert.equal(u.w.sessionStorage.length, 0);
  assert.equal(u.w.document.documentElement.outerHTML.includes(token), false);
  assert.ok([...u.w.document.querySelectorAll('input, textarea')].every(e => !e.value.includes(token)));
  assert.match(u.$('#mailbox-name').textContent, /mailbox-a@example\.test/);
  assert.match(u.$('#messages').textContent, /Plain text only/);
  assert.equal(u.$('#messages img'), null, 'mail continues to use inert plain-text rendering');
  assert.match(u.$('#grant-expiry').textContent, /有效至/);
  assert.equal(u.$('#auto-refresh').checked, false);
  assert.equal(u.intervals.size, 0);
  assert.equal(u.timeouts.size, 1);
});

for (const error of ['MAIL_ACCESS_EXPIRED', 'MAIL_ACCESS_REVOKED', 'INVALID_MAIL_TOKEN']) {
  test(`inbox: ${error} never falls back to a previous session`, async t => {
    const u = await ui(t, 'inbox', { hash: `#token=${token}`, seedOld: true, routes: new Map([['/mail-api/login', response({ error }, 401)]]) });
    assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/login']);
    assert.equal(u.calls[0].hash, '');
    assertNoMailbox(u);
    assert.match(u.$('#notice').textContent, /到期|撤销|无效/);
    u.$('#refresh').click(); await settle();
    assert.equal(u.calls.length, 1, 'even a stale manual refresh cannot fetch the old session');
    assert.equal(u.timeouts.size, 0);
    assert.equal(u.intervals.size, 0);
  });
}

for (const hash of ['#token=', '#token=bad-token', `#token=${token}&token=${secondToken}`, `#token=${token}&extra=1`, '#token=%E0%A4%A']) {
  test(`inbox: malformed link ${hash.slice(0, 24)} logs out the old session without reading messages`, async t => {
    const u = await ui(t, 'inbox', { hash, seedOld: true });
    assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/logout']);
    assert.equal(u.calls[0].method, 'POST');
    assert.equal(u.calls[0].hash, '');
    assert.equal(u.calls[0].oldVisible, false);
    assertNoMailbox(u);
    assert.match(u.$('#notice').textContent, /完整|格式/);
    assert.equal(u.w.localStorage.length, 0);
  });
}

test('inbox: known expiry clears visible mail without polling and an in-flight response cannot restore it', async t => {
  const u = await ui(t, 'inbox', { expires: new Date(NOW + 1000).toISOString() });
  assert.equal(u.timeouts.size, 1);
  const [id, timer] = [...u.timeouts][0]; assert.equal(timer.ms, 1000);
  let resolve;
  u.routes.set('/mail-api/messages', () => new Promise(done => { resolve = done; }));
  u.$('#refresh').click(); assert.equal(u.calls.length, 2);
  u.advance(1000); u.timeouts.delete(id); timer.callback();
  assertNoMailbox(u);
  assert.match(u.$('#notice').textContent, /已到期/);
  assert.equal(u.intervals.size, 0);
  resolve(response({ email: 'stale-mailbox@example.test', expiresAt, messages: [{ subject: 'STALE MAIL', text: 'must not appear' }] }));
  await settle(); assertNoMailbox(u);
  assert.equal(u.$('#busy-layer').hidden, true);
  assert.equal(u.calls.length, 2, 'the deadline does not make a polling request');
});

test('inbox: legacy permanent access has a truthful badge and no expiry or refresh timer', async t => {
  const u = await ui(t, 'inbox', { expires: null });
  assert.equal(u.$('#grant-expiry').textContent, '永久授权');
  assert.equal(u.timeouts.size, 0); assert.equal(u.intervals.size, 0);
});

test('inbox: navigating to a new share fragment on the same page replaces the prior mailbox', async t => {
  const u = await ui(t);
  u.routes.set('/mail-api/messages', response({ email: 'new-mailbox@example.test', expiresAt, messages: [] }));
  u.w.location.hash = `token=${secondToken}`;
  // Model the browser event explicitly: jsdom's location timer is replaced by the deadline test clock.
  u.w.dispatchEvent(new u.w.HashChangeEvent('hashchange')); await settle();
  assert.equal(u.w.location.hash, '');
  assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/messages', '/mail-api/login', '/mail-api/messages']);
  assert.deepEqual(u.calls[1].data, { token: secondToken });
  assert.equal(u.calls[1].hash, '');
  assert.match(u.$('#mailbox-name').textContent, /new-mailbox@example\.test/);
  assert.equal(u.w.document.documentElement.outerHTML.includes(secondToken), false);
});

test('inbox: a share fragment arriving during a request clears old data immediately and serializes the new login', async t => {
  const u = await ui(t); let resolve;
  u.routes.set('/mail-api/messages', () => new Promise(done => { resolve = done; }));
  u.$('#refresh').click();
  u.w.location.hash = `token=${secondToken}`; u.w.dispatchEvent(new u.w.HashChangeEvent('hashchange'));
  assertNoMailbox(u); assert.equal(u.w.location.hash, '');
  assert.equal(u.calls.filter(c => c.path === '/mail-api/login').length, 0, 'the new login waits for the previous server request');
  u.routes.set('/mail-api/messages', response({ email: 'new-mailbox@example.test', expiresAt, messages: [] }));
  resolve(response({ email: 'stale-mailbox@example.test', expiresAt, messages: [{ subject: 'OLD PRIVATE MAIL', text: 'do not show' }] }));
  await settle();
  assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/messages', '/mail-api/messages', '/mail-api/login', '/mail-api/messages']);
  assert.deepEqual(u.calls[2].data, { token: secondToken });
  assert.match(u.$('#mailbox-name').textContent, /new-mailbox@example\.test/);
  assert.doesNotMatch(u.$('#messages').textContent, /OLD PRIVATE MAIL/);
});

test('inbox: malformed same-page link clears current mail and treats logout 401 as already exited', async t => {
  const u = await ui(t);
  u.routes.set('/mail-api/logout', response({ error: 'LOGIN_REQUIRED' }, 401));
  u.w.location.hash = 'token='; u.w.dispatchEvent(new u.w.HashChangeEvent('hashchange')); await settle();
  assertNoMailbox(u);
  assert.equal(u.w.location.hash, '');
  assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/messages', '/mail-api/logout']);
  assert.match(u.$('#notice').textContent, /链接不完整/);
  assert.doesNotMatch(u.$('#notice').textContent, /退出未完成/);
});

test('inbox: a new share link arriving during logout is retained and opened without a reload', async t => {
  const u = await ui(t); let resolve;
  u.routes.set('/mail-api/logout', () => new Promise(done => { resolve = done; }));
  u.$('#logout').click();
  u.w.location.hash = `token=${secondToken}`; u.w.dispatchEvent(new u.w.HashChangeEvent('hashchange'));
  assertNoMailbox(u); assert.equal(u.w.location.hash, '');
  assert.equal(u.calls.filter(c => c.path === '/mail-api/login').length, 0);
  u.routes.set('/mail-api/messages', response({ email: 'next-mailbox@example.test', expiresAt, messages: [] }));
  resolve(response({ ok: true })); await settle();
  assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/messages', '/mail-api/logout', '/mail-api/login', '/mail-api/messages']);
  assert.deepEqual(u.calls[2].data, { token: secondToken });
  assert.equal(u.calls[2].hash, '');
  assert.match(u.$('#mailbox-name').textContent, /next-mailbox@example\.test/);
  assert.equal(u.$('#busy-layer').hidden, true);
  assert.deepEqual(u.errors, [], 'no page navigation may discard the queued credential');
});

test('inbox: manual token login remains usable after a malformed share link', async t => {
  const u = await ui(t, 'inbox', { hash: '#token=broken' });
  u.$('[name=token]').value = ` ${token} `;
  u.$('#login-form').dispatchEvent(new u.w.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(u.calls.map(c => c.path), ['/mail-api/logout', '/mail-api/login', '/mail-api/messages']);
  assert.deepEqual(u.calls[1].data, { token });
  assert.equal(u.$('#login-form').hidden, true);
  assert.equal(u.$('[name=token]').value, '');
});

test('admin: shares default to seven days and expose one copyable link, not a JSON credential dump', async t => {
  const u = await ui(t, 'admin');
  u.click('分享');
  assert.equal(u.$('[name=durationPreset]').value, '7');
  assert.equal(u.$('[name=durationDays]').disabled, true);
  assert.equal(u.$('[name=durationDays]').closest('label').hidden, true);
  u.$('[name=recipient]').value = grant.recipient; u.submit(); await settle();
  const mutation = u.calls.find(c => c.path.endsWith('/distribute'));
  assert.deepEqual(mutation.data, { emailIds: ['email-a'], recipient: grant.recipient, includeHistory: false, durationDays: 7 });
  const area = u.$('.share-result textarea');
  assert.equal(area.value, link); assert.equal(area.readOnly, true);
  assert.match(u.$('.share-expiry').textContent, /有效至/);
  assert.equal(u.$('.share-token'), null, 'optional compatibility token stays undisclosed');
  u.click('复制链接'); await settle();
  assert.deepEqual(u.clipboard, [link]);
  assert.equal(u.$('.share-result button').textContent, '已复制');
  assert.equal(u.w.localStorage.length, 0);
  u.$('#dialog-close').click(); await settle();
  assert.equal(u.$('.share-result'), null, 'closing destroys one-time link fields');
});

test('admin: custom duration rejects blank, fractional, zero, negative and oversized values before the request', async t => {
  const u = await ui(t, 'admin'); u.click('分享'); u.$('[name=recipient]').value = grant.recipient;
  u.change('[name=durationPreset]', 'custom');
  assert.equal(u.$('[name=durationDays]').disabled, false);
  assert.equal(u.$('[name=durationDays]').required, true);
  assert.equal(u.$('[name=durationDays]').closest('label').hidden, false);
  for (const value of ['', '0', '-1', '1.5', '3651']) {
    u.$('[name=durationDays]').value = value; u.submit(); await settle();
    assert.equal(u.calls.filter(c => c.path.endsWith('/distribute')).length, 0);
    assert.match(u.$('#dialog-error').textContent, /1–3650/);
    assert.equal(u.$('[name=recipient]').value, grant.recipient);
    assert.equal(u.$('[name=durationDays]').disabled, false);
    assert.equal(u.$('#dialog-submit').disabled, false);
  }
  u.$('[name=durationDays]').value = '14'; u.submit(); await settle();
  assert.equal(u.calls.find(c => c.path.endsWith('/distribute')).data.durationDays, 14);
});

test('admin: permanent selection explicitly sends null and each mailbox in a batch gets its own independent link', async t => {
  const results = [{ ...grant, expiresAt: null, token, shareUrl: link }, { ...grant, email: 'mailbox-b@example.test', id: 'grant-b', expiresAt: null, token: secondToken, shareUrl: `https://example.test/inbox#token=${secondToken}` }];
  const u = await ui(t, 'admin', { routes: new Map([['/admin-api/accounts/A/distribute', response({ inboxUrl: 'https://example.test/inbox', grants: results })]]) });
  for (const checkbox of u.w.document.querySelectorAll('#content input[type=checkbox]')) { checkbox.checked = true; checkbox.dispatchEvent(new u.w.Event('change')); }
  u.click('分享选中邮箱'); u.$('[name=recipient]').value = grant.recipient;
  u.change('[name=durationPreset]', 'permanent'); u.submit(); await settle();
  assert.deepEqual(u.calls.find(c => c.path.endsWith('/distribute')).data, { emailIds: ['email-a', 'email-b'], recipient: grant.recipient, includeHistory: false, durationDays: null });
  const cards = [...u.w.document.querySelectorAll('.share-result')]; assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(c => c.querySelector('textarea').value), results.map(g => g.shareUrl));
  assert.ok(cards.every(c => c.querySelector('.share-expiry').textContent === '永久有效'));
  for (const card of cards) { card.querySelector('button').click(); await settle(); }
  assert.deepEqual(u.clipboard, results.map(g => g.shareUrl));
});

test('admin: sharing management distinguishes finite, permanent, expired and revoked grants with filters', async t => {
  const grants = [grant, { ...grant, id: 'permanent', email: 'permanent@example.test', expiresAt: null }, { ...grant, id: 'expired', email: 'expired@example.test', expiresAt: new Date(NOW - 1).toISOString() }, { ...grant, id: 'revoked', email: 'revoked@example.test', status: 'revoked' }];
  const u = await ui(t, 'admin', { routes: new Map([['/admin-api/grants', response({ grants })]]) });
  u.click('分享管理'); await settle();
  assert.equal(u.$('#section-title').textContent, '分享管理');
  assert.equal(u.$('#status-filter').closest('label').hidden, false);
  assert.equal(u.w.document.querySelectorAll('#content tbody tr').length, 4);
  assert.match(u.$('#content').textContent, /有效 · 限时/); assert.match(u.$('#content').textContent, /有效 · 永久/);
  assert.match(u.$('#content').textContent, /已到期/); assert.match(u.$('#content').textContent, /已撤销/);
  for (const [status, email] of [['finite', grant.email], ['permanent', 'permanent@example.test'], ['expired', 'expired@example.test'], ['revoked', 'revoked@example.test']]) {
    u.$('#status-filter').value = status; u.$('#status-filter').dispatchEvent(new u.w.Event('input')); await settle();
    assert.equal(u.w.document.querySelectorAll('#content tbody tr').length, 1);
    assert.match(u.$('#content tbody tr').textContent, new RegExp(email.replaceAll('.', '\\.')));
  }
});

test('admin: explicit renewal changes only original grant expiry and never resets its token', async t => {
  const u = await ui(t, 'admin', { routes: new Map([['/admin-api/grants/grant-a', response(grant)]]) });
  u.click('分享管理'); await settle(); u.click('调整有效期');
  assert.match(u.$('#dialog-body').textContent, /原链接与使用者不变/);
  assert.match(u.$('#dialog-body').textContent, /已撤销的分享仍保持撤销/);
  u.change('[name=durationPreset]', '30'); u.submit(); await settle();
  const patch = u.calls.find(c => c.path === '/admin-api/grants/grant-a');
  assert.equal(patch.method, 'PATCH'); assert.deepEqual(patch.data, { durationDays: 30 });
  assert.equal(u.calls.some(c => c.path.endsWith('/reset')), false);
  assert.equal(u.$('.share-result'), null);
});

test('admin: replacing a link warns that old links and sessions stop, and retains the exact server expiry', async t => {
  const u = await ui(t, 'admin', { routes: new Map([['/admin-api/grants/grant-a/reset', response({ ...grant, token, shareUrl: link, inboxUrl: 'https://example.test/inbox' })]]) });
  u.click('分享管理'); await settle(); u.click('重新生成链接');
  assert.match(u.$('#dialog-body').textContent, /旧链接、旧 Token 与旧会话立即失效/);
  assert.match(u.$('#dialog-body').textContent, /不会延长有效期/);
  u.submit(); await settle();
  assert.deepEqual(u.calls.find(c => c.path.endsWith('/reset')).data, {});
  assert.equal(u.$('.share-result textarea').value, link);
  assert.equal(u.$('.share-expiry').textContent, `有效至 ${new Date(expiresAt).toLocaleString()}`);
});
