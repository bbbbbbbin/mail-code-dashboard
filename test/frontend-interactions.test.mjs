import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

async function ui(t, page = 'admin', { authenticated = true } = {}) {
  const dom = new JSDOM(await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8'), { url: `https://example.test/${page}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; t.after(() => w.close());
  const calls = [], timers = new Map(), routes = new Map(); let timerId = 0;
  w.setInterval = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; };
  w.clearInterval = id => timers.delete(id);
  const accounts = [{ id: 'A', name: 'Account A', inventory: [{ id: 'email-a', accountId: 'A', email: 'mailbox-a@example.test', label: 'A', distribution: { status: 'unassigned' } }, { id: 'email-b', accountId: 'A', email: 'mailbox-b@example.test', distribution: { status: 'active', id: 'grant-b' } }] }];
  const defaults = {
    '/admin-api/session': authenticated ? response({ csrf: 'fixture-csrf' }) : response({ error: 'LOGIN_REQUIRED' }, 401),
    '/admin-api/inventory': response({ accounts }),
    '/admin-api/scan-mail': response({ results: [] }),
    '/admin-api/grants': response({ grants: [] }),
    '/mail-api/messages': authenticated ? response({ email: 'mailbox-a@example.test', messages: [] }) : response({ error: 'INVALID_MAIL_TOKEN' }, 401)
  };
  w.fetch = async (path, init = {}) => {
    const call = { path, data: init.body ? JSON.parse(init.body) : null }; calls.push(call);
    return routes.has(path) ? routes.get(path)(call) : defaults[path] || response({});
  };
  const dialog = w.document.querySelector('dialog');
  if (dialog) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; setTimeout(() => dialog.dispatchEvent(new w.Event('close')), 0); };
  }
  const shared = (await readFile(new URL('../web/shared.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const script = (await readFile(new URL(`../web/${page}.js`, import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, '');
  vm.runInContext(`${shared}\nconst el = element;\n${script}`, dom.getInternalVMContext());
  await settle();
  const $ = selector => w.document.querySelector(selector);
  const click = text => [...w.document.querySelectorAll('button')].find(button => button.textContent === text).click();
  const submit = selector => $(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { w, $, calls, timers, routes, accounts, click, submit, evaluate: source => vm.runInContext(source, dom.getInternalVMContext()) };
}

for (const page of ['admin', 'inbox']) {
  test(`${page}: automatic refresh defaults off, persists opt-in, and stops when disabled`, async t => {
    const u = await ui(t, page), input = u.$('#auto-refresh'), interval = u.$('#refresh-interval');
    assert.equal(u.timers.size, 0);
    assert.equal(input.checked, false);
    assert.equal(interval.disabled, true);
    assert.equal(u.w.document.body.classList.contains('is-authenticated'), true);
    assert.equal(u.$(page === 'admin' ? '#admin-tools' : '#mailbox-identity-panel').hidden, false);
    input.checked = true; input.dispatchEvent(new u.w.Event('change'));
    interval.value = '60'; interval.dispatchEvent(new u.w.Event('change'));
    assert.equal(u.timers.size, 1);
    assert.equal([...u.timers.values()][0].ms, 60_000);
    assert.equal(interval.disabled, false);
    assert.equal(u.w.localStorage.getItem(`mail-dashboard-${page}-auto-refresh`), 'on');
    assert.equal(u.w.localStorage.getItem(`mail-dashboard-${page}-auto-refresh-interval`), '60');
    input.checked = false; input.dispatchEvent(new u.w.Event('change'));
    assert.equal(u.timers.size, 0);
    assert.equal(interval.disabled, true);
  });

  test(`${page}: failed login blocks duplicate submission and restores inputs`, async t => {
    const u = await ui(t, page, { authenticated: false }), request = deferred();
    const endpoint = page === 'admin' ? '/admin-api/login' : '/mail-api/login';
    u.routes.set(endpoint, () => request.promise);
    const form = u.$('#login-form');
    if (page === 'admin') { form.elements.username.value = 'fixture-admin'; form.elements.password.value = 'fixture-password'; }
    else form.elements.token.value = ' fixture-token ';
    u.submit('#login-form'); u.submit('#login-form');
    assert.equal(u.calls.filter(call => call.path === endpoint).length, 1);
    assert.deepEqual(u.calls.find(call => call.path === endpoint).data, page === 'admin' ? { username: 'fixture-admin', password: 'fixture-password' } : { token: 'fixture-token' });
    assert.equal(form.querySelector('button').disabled, true);
    assert.equal(form.querySelector('input').disabled, true);
    assert.equal(u.$('main').inert, true);
    assert.equal(u.$('#busy-layer').hidden, false);
    request.resolve(response({ error: page === 'admin' ? 'INVALID_LOGIN' : 'INVALID_MAIL_TOKEN' }, 401)); await settle();
    assert.equal(form.querySelector('button').disabled, false);
    assert.equal(form.querySelector('input').disabled, false);
    assert.notEqual(u.$('main').inert, true);
    assert.equal(u.$('#busy-layer').hidden, true);
    assert.equal(u.$('#refresh-interval').disabled, true);
    assert.equal(u.w.document.body.classList.contains('is-authenticated'), false);
    assert.equal(u.$(page === 'admin' ? '#admin-tools' : '#mailbox-identity-panel').hidden, true);
    assert.match(u.$('#notice').textContent, /不正确|无效/);
  });

  test(`${page}: automatic refresh cannot overlap a pending request and stops on session loss`, async t => {
    const u = await ui(t, page), request = deferred();
    const endpoint = page === 'admin' ? '/admin-api/session' : '/mail-api/messages';
    const input = u.$('#auto-refresh'); input.checked = true; input.dispatchEvent(new u.w.Event('change'));
    const tick = [...u.timers.values()][0].callback;
    u.routes.set(endpoint, () => request.promise);
    const previousCalls = u.calls.length; tick(); tick();
    assert.equal(u.calls.length, previousCalls + 1);
    assert.equal(u.$('#refresh').disabled, true);
    u.$('#refresh').click(); assert.equal(u.calls.length, previousCalls + 1);
    request.resolve(response({ error: 'LOGIN_REQUIRED' }, 401)); await settle();
    assert.equal(u.timers.size, 0);
    assert.equal(u.$('#logout').hidden, true);
    assert.equal(u.w.document.body.classList.contains('is-authenticated'), false);
    assert.equal(u.$('#busy-layer').hidden, true);
  });
}

test('admin: dialog stays locked through mutation, refresh and one-time result', async t => {
  const u = await ui(t), mutation = deferred(), inventory = deferred();
  u.routes.set('/admin-api/accounts/A/distribute', () => mutation.promise);
  u.routes.set('/admin-api/inventory', () => inventory.promise);
  u.click('分发'); u.$('[name=recipient]').value = 'Fixture recipient';
  u.submit('#dialog-form'); u.submit('#dialog-form');
  assert.equal(u.calls.filter(call => call.path.endsWith('/distribute')).length, 1);
  assert.equal(u.$('#dialog-submit').disabled, true);
  assert.equal(u.$('#dialog-close').disabled, true);
  assert.equal(u.$('#dialog-cancel').disabled, true);
  assert.equal(u.$('#dialog-form').inert, true);
  assert.equal(u.$('#busy-layer').parentElement, u.$('#dialog'));
  assert.equal(u.$('#dialog').classList.contains('is-pending'), true);
  const cancel = new u.w.Event('cancel', { cancelable: true }); u.$('#dialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  u.$('#dialog-close').click(); assert.equal(u.$('#dialog').open, true);
  u.$('#add-account').onclick(); assert.match(u.$('#dialog-title').textContent, /永久分发/);
  mutation.resolve(response({ inboxUrl: 'https://example.test/inbox', grants: [{ email: 'mailbox-a@example.test', token: 'fixture-one-time-token' }] }));
  await settle();
  assert.equal(u.$('#dialog-submit').disabled, true);
  assert.equal(u.$('#busy-layer').hidden, false);
  assert.equal(u.$('#dialog').open, true);
  assert.equal(u.$('#dialog-body textarea'), null);
  inventory.resolve(response({ accounts: u.accounts })); await settle();
  assert.equal(u.$('#dialog').open, true);
  assert.match(u.$('#dialog-body textarea').value, /fixture-one-time-token/);
  assert.equal(u.$('#dialog-close').disabled, false);
  assert.equal(u.$('#busy-layer').hidden, true);
  assert.equal(u.$('#busy-layer').parentElement, u.w.document.body);
  assert.equal(u.$('#dialog').classList.contains('is-pending'), false);
  assert.equal(u.$('#dialog').contains(u.w.document.activeElement), true);
  assert.equal(u.$('input[aria-label="选择 mailbox-b@example.test"]').disabled, true);
});

test('admin: a failed dialog submission preserves entered data and restores dismiss controls', async t => {
  const u = await ui(t), request = deferred();
  u.routes.set('/admin-api/accounts', () => request.promise);
  u.$('#add-account').click(); u.$('[name=name]').value = 'Fixture account'; u.$('[name=appleId]').value = 'fixture@example.test';
  u.submit('#dialog-form');
  assert.equal(u.$('[name=name]').disabled, true);
  request.resolve(response({ error: 'ACCOUNT_IDENTITY_MISMATCH' }, 409)); await settle();
  assert.equal(u.$('#dialog').open, true);
  assert.equal(u.$('[name=name]').disabled, false);
  assert.equal(u.$('[name=name]').value, 'Fixture account');
  assert.equal(u.$('#dialog-submit').disabled, false);
  assert.equal(u.$('#dialog-close').disabled, false);
  assert.match(u.$('#dialog-error').textContent, /身份/);
  u.$('#dialog-cancel').click(); await settle(); assert.equal(u.$('#dialog').open, false);
});

test('clipboard fallback reports failure truthfully, uses CSP-compatible CSS, and restores focus and selection', async t => {
  const u = await ui(t, 'inbox'), input = u.$('[name=token]');
  // A dialog is the top-layer focus scope, so fallback selection must stay inside it.
  const dialog = u.w.document.createElement('dialog'); dialog.open = true; u.w.document.body.append(dialog); dialog.append(input);
  input.value = 'select this token'; input.focus(); input.setSelectionRange(2, 8);
  Object.defineProperty(u.w.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard permission denied'); } } });
  let copied = '';
  u.w.document.execCommand = command => {
    assert.equal(command, 'copy'); const field = u.$('.clipboard-fallback');
    assert.equal(field.parentElement, dialog); assert.equal(field.getAttribute('style'), null); copied = field.value; return true;
  };
  await u.evaluate("copyText('mailbox-a@example.test')");
  assert.equal(copied, 'mailbox-a@example.test');
  assert.equal(u.w.document.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 8);
  assert.equal(u.$('.clipboard-fallback'), null);
  u.w.document.execCommand = () => false;
  await assert.rejects(u.evaluate("copyText('not-copied')"), /复制未完成/);
  const button = u.evaluate("copyButton('not-copied')"); dialog.append(button); button.click(); await settle();
  assert.equal(button.textContent, '请手动复制');
  assert.notEqual(button.textContent, '已复制');
  assert.equal(u.$('.clipboard-fallback'), null);
});
