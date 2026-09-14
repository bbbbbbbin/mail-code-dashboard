import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const statuses = ['unassigned', 'active', 'expired', 'revoked'];
const grantLabels = status => ['重新生成链接', '调整有效期', ...(status === 'revoked' ? [] : ['撤销'])];

async function ui(t) {
  const dom = new JSDOM(await readFile(new URL('../web/admin.html', import.meta.url), 'utf8'), {
    url: 'https://admin.example.test/admin', runScripts: 'outside-only',
  });
  const w = dom.window, $ = selector => w.document.querySelector(selector), calls = [];
  t.after(() => w.close());
  w.Date.now = () => Date.parse('2026-09-14T00:00:00Z');
  w.setInterval = () => 1;
  const rows = statuses.map(status => ({ id: `email-${status}`, accountId: 'A', email: `${status}@example.test`,
    label: status, distribution: { id: `grant-${status}`, status, recipient: 'Fixture owner',
      expiresAt: status === 'expired' ? '2026-09-13T00:00:00Z' : '2026-10-01T00:00:00Z' } }));
  const accounts = [{ id: 'A', name: 'Account A', inventory: rows }, { id: 'B', name: 'Account B', inventory: [
    { ...rows[0], accountId: 'B', email: 'other-account@example.test' },
  ] }];
  const grants = rows.slice(1).map(row => ({ ...row.distribution, email: row.email, accountId: row.accountId }));
  w.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET', data: init.body ? JSON.parse(init.body) : null });
    let result;
    if (path === '/admin-api/session') result = { csrf: 'fixture-csrf' };
    else if (path === '/admin-api/inventory') result = { accounts };
    else if (path === '/admin-api/grants') result = { grants };
    else if (path === '/admin-api/accounts/A/distribute') result = { inboxUrl: 'https://mail.example.test/inbox', grants: [] };
    else if (path.endsWith('/messages')) result = { messages: [] };
    else {
      const match = /^\/admin-api\/grants\/(grant-(?:active|expired|revoked))(?:\/(reset|revoke))?$/.exec(path);
      assert.ok(match, `unexpected request ${path}`);
      result = { ...grants.find(g => g.id === match[1]), token: 'synthetic-token', inboxUrl: 'https://mail.example.test/inbox' };
    }
    return { ok: true, json: async () => result };
  };
  const dialog = $('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; setTimeout(() => dialog.dispatchEvent(new w.Event('close')), 0); };
  const shared = (await readFile(new URL('../web/shared.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const admin = (await readFile(new URL('../web/admin.js', import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, '');
  vm.runInContext(`${shared}\nconst el = element;\n${admin}`, dom.getInternalVMContext());
  await settle();
  return { w, $, calls, row: email => [...w.document.querySelectorAll('tbody tr')].find(row => row.textContent.includes(email)),
    submit: () => $('#dialog-form').dispatchEvent(new w.Event('submit', { cancelable: true })),
    navigate: async view => { $(`[data-view="${view}"]`).click(); await settle(); },
    mutations: () => calls.filter(call => call.method !== 'GET'),
  };
}

function rowActions(row, expected) {
  assert.ok(row);
  const cell = row.lastElementChild;
  assert.equal(cell.children.length, 1, 'operation cell has one direct action group');
  const group = cell.firstElementChild;
  assert.ok(group.matches('.actions.row-actions'), 'row actions use the shared layout class');
  assert.equal(group.querySelector('.actions'), null, 'no nested flex/grid action groups');
  assert.ok([...group.children].every(child => child.tagName === 'BUTTON'));
  assert.deepEqual([...group.children].map(button => button.textContent), expected);
  return group;
}

for (const view of ['inventory', 'grants']) {
  test(`${view}: action cells are flat and state-appropriate`, async t => {
    const u = await ui(t);
    if (view === 'grants') await u.navigate(view);
    for (const status of view === 'inventory' ? statuses : statuses.slice(1)) {
      const labels = status === 'unassigned' ? ['分享'] : grantLabels(status);
      rowActions(u.row(`${status}@example.test`), [...(view === 'inventory' ? ['查看邮件'] : []), ...labels]);
    }
    assert.deepEqual(u.mutations(), []);
  });

  for (const [status, label, suffix, method, data] of [
    ['revoked', '重新生成链接', '/reset', 'POST', {}],
    ['expired', '调整有效期', '', 'PATCH', { durationDays: 30 }],
    ['active', '撤销', '/revoke', 'POST', {}],
  ]) {
    test(`${view}: ${label} confirms before acting on the correct ${status} grant`, async t => {
      const u = await ui(t);
      if (view === 'grants') await u.navigate(view);
      const button = [...u.row(`${status}@example.test`).querySelectorAll('button')].find(b => b.textContent === label);
      assert.ok(button); button.click();
      assert.equal(u.$('dialog').open, true);
      assert.match(u.$('#dialog-body').textContent, new RegExp(`${status}@example\\.test`));
      assert.deepEqual(u.mutations(), [], 'opening a confirmation cannot mutate the grant');
      if (method === 'PATCH') {
        u.$('[name=durationPreset]').value = '30';
        u.$('[name=durationPreset]').dispatchEvent(new u.w.Event('change'));
      }
      u.submit(); await settle();
      assert.deepEqual(u.mutations(), [{ path: `/admin-api/grants/grant-${status}${suffix}`, method, data }]);
      assert.equal(u.$('#dialog-error').textContent, '');
      if (suffix === '/reset') {
        assert.equal(u.$('dialog').open, true);
        assert.match(u.$('#dialog-body textarea').value, /#token=synthetic-token$/);
      } else assert.equal(u.$('dialog').open, false);
    });
  }
}

test('flat row actions preserve account-aware selection across views and batch confirmation', async t => {
  const u = await ui(t);
  const check = email => u.row(email).querySelector('input[type=checkbox]');
  const select = (email, value) => { const input = check(email); input.checked = value; input.dispatchEvent(new u.w.Event('change')); };
  for (const status of statuses.slice(1)) assert.equal(check(`${status}@example.test`).disabled, true);
  select('unassigned@example.test', true);
  await u.navigate('grants'); await u.navigate('inventory');
  assert.equal(check('unassigned@example.test').checked, true);
  assert.equal(check('other-account@example.test').checked, false);
  select('other-account@example.test', true);
  u.$('#distribute-selected').click();
  assert.match(u.$('#notice').textContent, /同一账号/);
  assert.equal(u.$('dialog').open, false);
  assert.deepEqual(u.mutations(), []);
  select('other-account@example.test', false);
  u.$('#distribute-selected').click();
  assert.equal(u.$('dialog').open, true);
  assert.deepEqual(u.mutations(), []);
  u.$('[name=recipient]').value = 'Fixture recipient';
  u.submit(); await settle();
  assert.deepEqual(u.mutations(), [{ path: '/admin-api/accounts/A/distribute', method: 'POST',
    data: { emailIds: ['email-unassigned'], recipient: 'Fixture recipient', includeHistory: false, durationDays: 7 } }]);
});
