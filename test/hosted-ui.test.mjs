import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

async function ui(t) {
  const html = await readFile(new URL('../web/admin.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://admin.example.test/admin', runScripts: 'outside-only' });
  const { window: w } = dom;
  t.after(() => w.close());
  const calls = [];
  const rows = ['A', 'B'].map((id, i) => ({ id, name: `Account ${id}`, inventory: [{ id: 'same-email-id', accountId: id, email: `${id.toLowerCase()}@example.test`, label: 'label', distribution: { status: 'unassigned' } }] }));
  w.setInterval = () => 1;
  w.fetch = async (path, init = {}) => {
    calls.push({ path, data: init.body ? JSON.parse(init.body) : null });
    let result = {};
    if (path === '/admin-api/session') result = { csrf: 'test-csrf' };
    if (path === '/admin-api/inventory') result = { accounts: rows };
    if (path === '/admin-api/scan-mail') result = { results: [] };
    if (path === '/admin-api/grants') result = { grants: [{ id: 'grant', email: 'a@example.test', accountId: 'A', status: 'active' }] };
    if (path.endsWith('/revoke')) result = { ok: true };
    if (path.endsWith('/distribute')) result = { inboxUrl: 'https://mail.example.test/inbox', grants: [{ email: 'a@example.test', token: 'synthetic-token' }] };
    return { ok: true, json: async () => result };
  };
  const dialog = w.document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  // Browsers dispatch close asynchronously. Model that ordering for the token-result regression.
  dialog.close = () => { dialog.open = false; setTimeout(() => dialog.dispatchEvent(new w.Event('close')), 0); };
  const shared = (await readFile(new URL('../web/shared.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const admin = (await readFile(new URL('../web/admin.js', import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, '');
  vm.runInContext(`${shared}\nconst el = element;\n${admin}`, dom.getInternalVMContext());
  const settle = () => new Promise(resolve => setTimeout(resolve, 15));
  await settle();
  const $ = selector => w.document.querySelector(selector);
  const click = text => { const b = [...w.document.querySelectorAll('button')].find(b => b.textContent === text && !b.closest('[hidden]')); assert.ok(b, `visible button ${text}`); b.click(); };
  return { w, $, calls, settle, click };
}

test('selection uses both account and email ID, rejecting a mixed-account distribution', async t => {
  const u = await ui(t), inputs = [...u.w.document.querySelectorAll('tbody input')];
  inputs.forEach(input => { input.checked = true; input.dispatchEvent(new u.w.Event('change')); });
  u.click('分享选中邮箱');
  assert.match(u.$('#notice').textContent, /同一账号/);
  assert.equal(u.$('dialog').open, false);
  assert.equal(u.calls.filter(c => c.path.endsWith('/distribute')).length, 0);
});

test('distribute requires submit; token result remains open after asynchronous close event', async t => {
  const u = await ui(t);
  u.click('分享');
  assert.equal(u.calls.filter(c => c.path.endsWith('/distribute')).length, 0);
  u.$('[name=recipient]').value = 'Synthetic owner';
  u.$('#dialog-form').dispatchEvent(new u.w.Event('submit', { cancelable: true }));
  await u.settle();
  assert.equal(u.$('dialog').open, true);
  assert.match(u.$('#dialog-body textarea').value, /synthetic-token/);
  assert.equal(u.calls.find(c => c.path.endsWith('/distribute')).data.includeHistory, false);
  u.$('#dialog-close').click(); await u.settle(); assert.equal(u.$('#dialog-body').textContent, '');
});

test('revoke response objects do not get invoked as callbacks; scanning is wired to the server', async t => {
  const u = await ui(t);
  u.click('分享管理'); await u.settle();
  assert.equal(u.$('[data-view=grants]').getAttribute('aria-current'), 'page');
  assert.equal(u.$('[data-view=inventory]').hasAttribute('aria-current'), false);
  u.click('更多'); u.click('撤销');
  u.$('#dialog-form').dispatchEvent(new u.w.Event('submit', { cancelable: true }));
  await u.settle();
  assert.equal(u.$('#dialog-error').textContent, '');
  assert.equal(u.$('dialog').open, false);
  u.click('扫描全部收件'); await u.settle();
  assert.equal(u.calls.filter(c => c.path === '/admin-api/scan-mail').length, 1);
});
