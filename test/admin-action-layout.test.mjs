import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const statuses = ['unassigned', 'active', 'expired', 'revoked'];
const grantLabels = (status, view) => ['重新生成链接', ...(view === 'inventory' ? ['调整有效期'] : []), ...(status === 'revoked' ? [] : ['撤销'])];

test('row action sizing follows content while keeping alignment and touch spacing', async () => {
  const css = await readFile(new URL('../web/site.css', import.meta.url), 'utf8');
  const group = css.match(/td > \.actions\.row-actions\s*\{([^}]+)\}/)?.[1] || '';
  const button = css.match(/td > \.row-actions > button\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(group, /display:\s*inline-flex/);
  assert.match(group, /flex-wrap:\s*nowrap/);
  assert.match(group, /gap:\s*8px/);
  assert.match(group, /width:\s*(?:auto|max-content)/);
  assert.doesNotMatch(group, /grid-template-columns|(?:min-)?width:\s*(?:208|224)px/);
  assert.match(button, /width:\s*auto/);
  assert.match(button, /padding-inline:\s*10px/);
  assert.doesNotMatch(button, /width:\s*100%/);
  assert.match(css, /\.actions button\s*\{[^}]*min-height:\s*36px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)\s*\{\s*button,\s*\.actions button[^}]+min-height:\s*44px/);
});

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
    const data = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || 'GET', data });
    let result;
    if (path === '/admin-api/session') result = { csrf: 'fixture-csrf' };
    else if (path === '/admin-api/inventory') result = { accounts };
    else if (path === '/admin-api/grants') result = { grants };
    else if (path === '/admin-api/keys') result = { keys: [] };
    else if (/^\/admin-api\/accounts\/[AB]\/keys$/.test(path)) result = { token: 'synthetic-account-key', scopes: data.scopes };
    else if (/^\/admin-api\/accounts\/[AB]$/.test(path) && init.method === 'PATCH') result = { ok: true };
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

function rowActions(row, expected, menuLabels = []) {
  assert.ok(row);
  const cell = row.lastElementChild;
  assert.equal(cell.children.length, 1, 'operation cell has one direct action group');
  const group = cell.firstElementChild;
  assert.ok(group.matches('.actions.row-actions'), 'row actions use the shared layout class');
  assert.equal(group.querySelector('.actions'), null, 'no nested multi-row action groups');
  assert.deepEqual([...group.children].map(child => child.tagName === 'BUTTON' ? child.textContent : child.querySelector('.menu-trigger')?.textContent), expected);
  const trigger = group.querySelector('.menu-trigger');
  if (menuLabels.length) {
    assert.ok(trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    trigger.click(); const panel = row.ownerDocument.getElementById(trigger.getAttribute('aria-controls'));
    assert.equal(panel.hidden, false);
    assert.deepEqual([...panel.querySelectorAll('button')].map(button => button.textContent), menuLabels);
    trigger.click(); assert.equal(panel.hidden, true);
  } else assert.equal(trigger, null);
  return group;
}

for (const view of ['inventory', 'grants']) {
  test(`${view}: action cells show two compact controls and state-appropriate menu items`, async t => {
    const u = await ui(t);
    if (view === 'grants') await u.navigate(view);
    for (const status of view === 'inventory' ? statuses : statuses.slice(1)) {
      const labels = status === 'unassigned' ? ['查看邮件', '分享'] : [view === 'inventory' ? '查看邮件' : '调整有效期', '更多'];
      rowActions(u.row(`${status}@example.test`), labels, status === 'unassigned' ? [] : grantLabels(status, view));
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
      const row = u.row(`${status}@example.test`), trigger = row.querySelector('.menu-trigger');
      let button = [...row.querySelectorAll('button')].find(b => b.textContent === label && !b.closest('[hidden]'));
      if (!button) { trigger.click(); const panel = u.w.document.getElementById(trigger.getAttribute('aria-controls')); assert.equal(panel.hidden, false); button = [...panel.querySelectorAll('button')].find(b => b.textContent === label); }
      assert.ok(button); button.click();
      assert.equal(u.$('dialog').open, true);
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
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

test('compact row actions preserve account-aware selection across views and batch confirmation', async t => {
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

function visibleButton(root, text) {
  const button = [...root.querySelectorAll('button')].find(button => button.textContent === text && !button.closest('[hidden]'));
  assert.ok(button, `visible ${text} button`); return button;
}
function openMore(u, container) {
  const trigger = container.querySelector('.menu-trigger'); assert.ok(trigger); trigger.click();
  const panel = u.w.document.getElementById(trigger.getAttribute('aria-controls'));
  assert.equal(panel.hidden, false); return { trigger, panel };
}

test('account cards show one compact three-control row and preserve secondary account actions in More', async t => {
  const u = await ui(t); await u.navigate('accounts');
  for (const card of u.w.document.querySelectorAll('.account')) {
    const group = card.querySelector('.account-actions'); assert.ok(group);
    assert.deepEqual([...group.children].map(child => child.tagName === 'BUTTON' ? child.textContent : child.querySelector('.menu-trigger')?.textContent), ['同步库存', '收件设置', '更多']);
    assert.equal(card.querySelector('.account-settings'), null);
    assert.equal(card.querySelector(':scope > button'), null);
    const { trigger, panel } = openMore(u, card);
    assert.deepEqual([...panel.querySelectorAll('button')].map(button => button.textContent), ['手动生成一个', '自动生成设置', '修改账号名称', '创建同步密钥', '手动导入 Cookie', '暂停账号']);
    trigger.click(); assert.equal(panel.hidden, true);
  }
  visibleButton(u.$('.account'), '收件设置').click();
  assert.match(u.$('#dialog-title').textContent, /配置 Account A 的转发收件/);
  assert.ok(u.$('[name=host]')); assert.ok(u.$('[name=password]'));
  assert.deepEqual(u.mutations(), [], 'opening settings never saves them');
});

test('an account menu opens confirmation for its own account and closes before the modal', async t => {
  const u = await ui(t); await u.navigate('accounts');
  const card = [...u.w.document.querySelectorAll('.account')][1], { trigger, panel } = openMore(u, card);
  visibleButton(panel, '修改账号名称').click();
  assert.equal(panel.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(u.$('dialog').open, true); assert.equal(u.$('[name=name]').value, 'Account B');
  assert.deepEqual(u.mutations(), []);
  u.$('[name=name]').value = 'Renamed B'; u.submit(); await settle();
  assert.deepEqual(u.mutations(), [{ path: '/admin-api/accounts/B', method: 'PATCH', data: { name: 'Renamed B' } }]);
  assert.equal(u.$('dialog').open, false);
  assert.equal(u.w.document.activeElement, u.$('[data-view=accounts]'), 'rerendered menu returns focus to a stable visible navigation control');
});

test('upload key creation stays account-bound when invoked from a collapsed account menu', async t => {
  const u = await ui(t); await u.navigate('accounts');
  const { panel } = openMore(u, [...u.w.document.querySelectorAll('.account')][1]);
  visibleButton(panel, '创建同步密钥').click();
  assert.equal(u.$('[name=accountId]'), null, 'a sync key retains the account chosen by the card');
  u.$('[name=name]').value = 'Fixture browser'; u.submit(); await settle();
  assert.deepEqual(u.mutations(), [{ path: '/admin-api/accounts/B/keys', method: 'POST', data: { kind: 'upload', name: 'Fixture browser', scopes: [] } }]);
  const result = JSON.parse(u.$('#dialog-body textarea').value);
  assert.equal(result.accountId, 'B'); assert.equal(result.token, 'synthetic-account-key');
});

test('key management offers one create button with an explicit account selector and an adjacent password action', async t => {
  const u = await ui(t); await u.navigate('keys');
  assert.deepEqual([...u.$('.key-actions').children].map(button => button.textContent), ['创建程序密钥', '更改管理员密码']);
  visibleButton(u.$('.key-actions'), '创建程序密钥').click();
  const select = u.$('[name=accountId]'); assert.ok(select.required);
  assert.deepEqual([...select.options].map(option => option.value), ['', 'A', 'B']);
  assert.equal(select.value, '');
  u.submit(); await settle();
  assert.deepEqual(u.mutations(), [], 'missing account is rejected rather than silently choosing a mailbox owner');
  assert.match(u.$('#dialog-error').textContent, /请选择要绑定的账号/);
  select.value = 'B'; u.$('[name=name]').value = 'Fixture integration'; u.submit(); await settle();
  assert.deepEqual(u.mutations(), [{ path: '/admin-api/accounts/B/keys', method: 'POST', data: { kind: 'program', name: 'Fixture integration', scopes: ['inventory:read', 'mail:read'] } }]);
  assert.equal(JSON.parse(u.$('#dialog-body textarea').value).accountId, 'B');
});

test('the single program-key dialog respects the selected account filter', async t => {
  const u = await ui(t);
  u.$('#account-filter').value = 'B'; u.$('#account-filter').dispatchEvent(new u.w.Event('input')); await settle();
  await u.navigate('keys'); visibleButton(u.$('.key-actions'), '创建程序密钥').click();
  const select = u.$('[name=accountId]'); assert.equal(select.value, 'B');
  assert.deepEqual([...select.options].map(option => option.value), ['', 'B']);
  assert.deepEqual(u.mutations(), []);
});

test('closing a menu confirmation returns focus to More and rerendering leaves no open orphan popup', async t => {
  const u = await ui(t), { trigger, panel } = openMore(u, u.row('active@example.test'));
  visibleButton(panel, '撤销').click(); assert.equal(panel.hidden, true);
  u.$('#dialog-cancel').click(); await settle();
  assert.equal(u.w.document.activeElement, trigger);
  trigger.click(); assert.equal(panel.hidden, false);
  await u.navigate('accounts');
  assert.equal(trigger.isConnected, false); assert.equal(panel.isConnected, false);
  assert.equal(u.w.document.querySelector('.action-popover:not([hidden])'), null);
  assert.deepEqual(u.mutations(), []);
});
