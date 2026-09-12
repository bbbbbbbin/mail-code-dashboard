import { $, api, element as el, displayMail } from './shared.js';
let csrf = '', accounts = [], view = 'inventory', selected = new Map(), dialogAction;
const write = (path, data = {}, method = 'POST') => api(path, { method, data, csrf });
const accountName = id => accounts.find(a => a.id === id)?.name || id;
const rowKey = r => `${r.accountId}:${r.id}`;
const accountTone = id => `tone-${Math.max(0, accounts.findIndex(a => a.id === id)) % 5}`;
const date = v => v ? new Date(v).toLocaleString() : '—';
const stateName = s => ({ unassigned: '未分发', active: '已分发 · 永久', revoked: '已撤销' })[s] || s;
function button(text, action, cls = '') { const b = el('button', text, cls); b.type = 'button'; b.onclick = async () => { b.disabled = true; try { await action(); } catch(e) { $('#notice').textContent = e.message; } finally { b.disabled = false; } }; return b; }
function field(label, name, type = 'text', value = '', required = true) { const l = el('label', label), input = el('input'); Object.assign(input, { name, type, value, required }); if (type === 'password') input.autocomplete = 'new-password'; l.append(input); return l; }
function openDialog(title, nodes, action) { $('#dialog-title').textContent = title; $('#dialog-body').replaceChildren(...nodes); $('#dialog-error').textContent = ''; $('#dialog-submit').hidden = !action; dialogAction = action; $('#dialog').showModal(); }
function secretDialog(title, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const area = el('textarea'); area.value = payload; area.readOnly = true; area.rows = 10;
  openDialog(title, [el('p', '完整密钥仅此次显示。请妥善保存，关闭后不再回显；丢失时可以重置。', 'muted'), area, button('复制', async () => { await navigator.clipboard.writeText(payload); })]);
}
$('#dialog-close').onclick = () => $('#dialog').close();
$('#dialog').addEventListener('close', () => { if (!$('#dialog').open) { $('#dialog-body').replaceChildren(); dialogAction = null; } });
$('#dialog-form').onsubmit = async e => {
  e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); const action = dialogAction;
  $('#dialog-submit').disabled = true;
  try { const after = await action?.(data); $('#dialog').close(); await refresh(); if (typeof after === 'function') after(); }
  catch (e) { $('#dialog-error').textContent = e.message; }
  finally { $('#dialog-submit').disabled = false; }
};
async function refresh() {
  try {
    const auth = await api('/admin-api/session'); csrf = auth.csrf;
    accounts = (await api('/admin-api/inventory')).accounts;
    $('#login').hidden = true; $('#workspace').hidden = false;
    const chosen = $('#account-filter').value;
    $('#account-filter').replaceChildren(new Option('全部账号', ''), ...accounts.map(a => new Option(a.name, a.id)));
    $('#account-filter').value = chosen;
    const rows = accounts.flatMap(a => a.inventory);
    $('#stats').replaceChildren(...[[accounts.length, 'iCloud 账号'], [rows.length, '邮箱总数'], [rows.filter(r => r.distribution.status === 'active').length, '永久分发'], [rows.filter(r => r.distribution.status === 'unassigned').length, '未分发']].map(([n, label]) => { const c = el('div', undefined, 'card stat'); c.append(el('strong', n), el('span', label)); return c; }));
    await render();
  } catch (e) { $('#notice').textContent = e.message; if (e.status === 401) { $('#login').hidden = false; $('#workspace').hidden = true; $('#content').replaceChildren(); } }
}
function table(headers, rows) { const wrap = el('div', undefined, 'table-wrap card'), t = el('table'), head = el('thead'), hr = el('tr'); headers.forEach(h => hr.append(el('th', h))); head.append(hr); t.append(head); const body = el('tbody'); rows.forEach(cells => { const row = el('tr'); cells.forEach(v => { const cell = el('td'); cell.append(v instanceof Node ? v : document.createTextNode(String(v ?? ''))); row.append(cell); }); body.append(row); }); t.append(body); wrap.append(t); if (!rows.length) wrap.append(el('p', '暂无记录', 'empty')); return wrap; }
function actions(...items) { const box = el('div', undefined, 'actions'); box.append(...items); return box; }
function grantActions(g) { return actions(button('重置 Token', () => openDialog('重置原使用者的 Token', [el('p', `邮箱：${g.email}。旧 Token 与旧会话立即失效；原分发对象和邮件起始范围保持不变。`)], async () => { const result = await write(`/admin-api/grants/${g.id}/reset`); return () => secretDialog('新的收件 Token', { email: result.email, token: result.token }); })), ...(g.status === 'active' ? [button('撤销', () => openDialog('撤销收件授权', [el('p', `${g.email} 将停止对原 Token 提供收件。邮箱不删除，也不自动重新分发。`)], () => write(`/admin-api/grants/${g.id}/revoke`)))] : [])); }
async function render() {
  const content = $('#content'); content.replaceChildren();
  const chosen = $('#account-filter').value, q = $('#search').value.toLowerCase(), status = $('#status-filter').value;
  $('#search').closest('label').hidden = view !== 'inventory';
  $('#status-filter').closest('label').hidden = view !== 'inventory';
  $('#distribute-selected').hidden = view !== 'inventory';
  if (view === 'inventory') {
    const rows = accounts.filter(a => !chosen || a.id === chosen).flatMap(a => a.inventory.map(r => ({ ...r, account: a }))).filter(r => (!status || r.distribution.status === status) && `${r.email} ${r.label} ${r.distribution.recipient || ''}`.toLowerCase().includes(q));
    const broken = accounts.filter(a => a.error); if (broken.length) content.append(el('p', `部分账号状态暂不可用：${broken.map(a => a.name).join('、')}，未用空数据替换。`, 'warning'));
    content.append(table(['选择', '邮箱 / 标签', '所属账号', '分发状态', '分发对象', '邮件', '操作'], rows.map(r => {
      const key = rowKey(r);
      const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', `选择 ${r.email}`); input.disabled = r.distribution.status !== 'unassigned'; input.checked = selected.has(key); input.onchange = () => input.checked ? selected.set(key, r) : selected.delete(key);
      const mailbox = el('div'); mailbox.append(el('strong', r.email), el('small', r.label || '无标签', 'muted'));
      const account = el('span', r.account.name, `badge ${accountTone(r.accountId)}`);
      return [input, mailbox, account, stateName(r.distribution.status), r.distribution.recipient || '—', r.unread ? '未读' : r.receivedAt ? date(r.receivedAt) : '—', actions(button('查看邮件', async () => { const data = await api(`/admin-api/accounts/${r.accountId}/emails/${r.id}/messages`); const box = el('div'); displayMail(data.messages, box); openDialog(r.email, [box]); }), ...(r.distribution.status === 'unassigned' ? [button('分发', () => distribute([r]))] : [grantActions(r.distribution)]))];
    })));
  } else if (view === 'accounts') {
    const grid = el('div', undefined, 'account-grid');
    for (const a of accounts.filter(a => !chosen || a.id === chosen)) {
      const card = el('section', undefined, `card account ${accountTone(a.id)}`); card.append(el('h2', a.name), el('p', a.expectedAppleId, 'muted'), el('p', `${a.bound ? '已核验绑定' : '待 Chrome 配对'} · ${a.paused ? '已暂停' : '已启用'}`, 'badge'), el('p', `Cookie：${({ verified: '已核验', not_synced: '未同步', verification_failed: '核验失败' })[a.cookieStatus] || a.cookieStatus} · ${date(a.lastSyncedAt)}`), el('p', `转发收件：${a.forwardConfigured ? '已配置' : '待配置'} · 邮箱 ${a.inventory.length} 个`), el('p', `收件扫描：${({ ok: '正常', unavailable: '连接失败，请检查配置', not_checked: '尚未扫描', scan_window_truncated: '已扫描最近邮件，存在更早邮件' })[a.mailStatus] || a.mailStatus} · ${date(a.lastMailScanAt)}`), el('p', `后台生成：${a.autoStock?.enabled ? '开启' : '关闭'} · 下次 ${date(a.autoStock?.nextAttemptAt)}`, 'muted'));
      card.append(button('修改账号名称', () => openDialog('修改显示名称（保持原账号绑定）', [field('账号名称', 'name', 'text', a.name)], async b => { await write(`/admin-api/accounts/${a.id}`, b, 'PATCH'); })));
      if (a.autoStock?.pausedReason || a.autoStock?.lastError) card.append(el('p', a.autoStock.pausedReason || a.autoStock.lastError, 'warning'));
      card.append(actions(button('创建同步密钥', () => createKey(a, 'upload')), button(a.paused ? '启用账号' : '暂停账号', async () => { await write(`/admin-api/accounts/${a.id}`, { paused: !a.paused }, 'PATCH'); await refresh(); }), button('同步库存', async () => { await write(`/admin-api/accounts/${a.id}/sync`); await refresh(); }), button('配置转发收件', () => forward(a)), button('自动生成设置', () => auto(a)), button('手动生成一个', () => openDialog('生成隐藏邮箱', [field('标签（例如 hme-001）', 'label', 'text', `${a.autoStock?.prefix || 'hme'}-001`)], async b => { await write(`/admin-api/accounts/${a.id}/generate`, b); })), button('手动导入 Cookie', () => manualCookie(a)))); grid.append(card);
    }
    content.append(grid); if (!accounts.length) content.append(el('div', '先新增账号，再使用对应 Chrome 扩展配对。账号归属验证通过后，启用账号并配置转发收件。', 'empty'));
  } else if (view === 'grants') {
    const data = await api('/admin-api/grants'); content.append(table(['邮箱', '所属账号', '分发对象', '状态', '创建时间', '最近访问', '操作'], data.grants.filter(g => !chosen || g.accountId === chosen).map(g => [g.email, accountName(g.accountId), g.recipient, stateName(g.status), date(g.createdAt), date(g.lastUsedAt), grantActions(g)])));
  } else if (view === 'keys') {
    content.append(el('p', '程序密钥与 Cookie 同步密钥分别绑定账号；收件 Token 请在“永久分发”管理。', 'muted'));
    for (const a of accounts.filter(a => !chosen || a.id === chosen)) content.append(button(`为 ${a.name} 创建程序密钥`, () => createKey(a, 'program')));
    const data = await api('/admin-api/keys'); content.append(table(['名称', '账号', '权限', '标识', '状态', '最近使用', '操作'], data.keys.filter(k => !chosen || k.accountId === chosen).map(k => [k.name, accountName(k.accountId), k.scopes.join(' / '), k.mask, k.revoked ? '已撤销' : '有效', date(k.lastUsedAt), k.revoked ? '—' : button('撤销', () => openDialog('撤销密钥', [el('p', `${k.name} 将立即停止访问。`)], async () => { await write(`/admin-api/keys/${k.id}/revoke`); }))])));
    content.append(button('更改管理员密码', () => openDialog('更改密码后需重新登录', [field('当前密码', 'currentPassword', 'password'), field('新密码（至少 14 位）', 'newPassword', 'password')], async b => { await write('/admin-api/password', b); location.reload(); })));
  } else { const data = await api('/admin-api/audit'); content.append(table(['时间', '操作', '账号', '记录编号'], data.events.filter(e => !chosen || e.accountId === chosen).map(e => [date(e.at), e.action, e.accountId ? accountName(e.accountId) : '系统', e.objectId || '—']))); }
}
function distribute(rows) {
  if (!rows.length) throw new Error('请先选择未分发的邮箱。');
  if (new Set(rows.map(r => r.accountId)).size !== 1) throw new Error('批量分发请选择同一账号的邮箱，避免混淆归属。');
  const history = field('开放分发前的历史邮件（默认不开放）', 'history', 'checkbox', '', false);
  openDialog(`永久分发 ${rows.length} 个邮箱`, [el('p', `所属账号：${accountName(rows[0].accountId)}。仅确认后才会产生 Token。`), field('分发对象 / 用途', 'recipient'), history], async b => {
    const result = await write(`/admin-api/accounts/${rows[0].accountId}/distribute`, { emailIds: rows.map(r => r.id), recipient: b.recipient, includeHistory: b.history !== undefined });
    selected.clear(); return () => secretDialog('分发完成 · 请保存收件凭证', { inboxUrl: result.inboxUrl, mailboxes: result.grants.map(g => ({ email: g.email, token: g.token, expiresAt: '永久' })) });
  });
}
function createKey(a, kind) { openDialog(kind === 'upload' ? '创建账号专属同步密钥' : '创建账号专属程序密钥', [el('p', `仅绑定 ${a.name}（${a.expectedAppleId}）`), field('密钥备注', 'name', 'text', kind === 'upload' ? '我的 Chrome' : '收件脚本')], async b => {
  const result = await write(`/admin-api/accounts/${a.id}/keys`, { kind, name: b.name, scopes: kind === 'program' ? ['inventory:read', 'mail:read'] : [] });
  return () => secretDialog('密钥已创建', { server: location.origin, account: a.name, accountId: a.id, token: result.token, scopes: result.scopes });
}); }
function forward(a) { openDialog(`配置 ${a.name} 的转发收件`, [el('p', '此处填写接收 iCloud 转发邮件的 IMAP 邮箱与应用授权码，非 Apple 登录密码。已有密码留空保持不变；更换主机或邮箱时需填写新授权码。', 'muted'), field('IMAP 主机', 'host', 'text', a.forwardSettings?.host || 'imap.qq.com'), field('TLS 端口', 'port', 'number', String(a.forwardSettings?.port || 993)), field('转发邮箱地址', 'email', 'email', a.forwardSettings?.email || ''), field('应用授权码', 'password', 'password', '', !a.forwardConfigured)], async b => { await write(`/admin-api/accounts/${a.id}`, { forward: { ...b, port: Number(b.port), secure: true } }, 'PATCH'); }); }
function auto(a) { const enabled = field('开启后台自动生成', 'enabled', 'checkbox', '', false); enabled.querySelector('input').checked = !!a.autoStock?.enabled; openDialog(`${a.name} · 后台生成`, [field('标签前缀', 'prefix', 'text', a.autoStock?.prefix || 'hme'), enabled, el('p', '每小时一批、每批最多 5 个。关闭页面后继续运行；结果不确定时暂停，先同步核对再恢复。', 'muted')], async b => { await write(`/admin-api/accounts/${a.id}/auto-stock`, { prefix: b.prefix, enabled: b.enabled !== undefined }, 'PATCH'); }); }
function manualCookie(a) { const cookies = el('textarea'); cookies.name = 'cookies'; cookies.rows = 7; cookies.required = true; cookies.placeholder = '[{"name":"X-APPLE-…","value":"…"}]'; openDialog(`手动同步至 ${a.name}`, [el('p', '使用此账号的同步密钥；服务器仍会核验 Apple 身份。不要粘贴其他账号的 Cookie。'), field('此账号同步密钥', 'token', 'password'), cookies], async b => { const r = await fetch('/bridge/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ expectedAccountId: a.id, cookies: JSON.parse(b.cookies) }) }); const result = await r.json(); if (!r.ok) throw new Error(`同步未完成：${result.error}`); if (result.account.id !== a.id) throw new Error('密钥属于其他账号；请核对绑定。'); }); }
$('#login-form').onsubmit = async e => { e.preventDefault(); const f = e.currentTarget, b = f.querySelector('button'); b.disabled = true; try { await api('/admin-api/login', { method: 'POST', data: Object.fromEntries(new FormData(f)) }); f.reset(); $('#notice').textContent = ''; await refresh(); } catch(e) { $('#notice').textContent = e.message; } finally { b.disabled = false; } };
$('#refresh').onclick = refresh;
$('#scan-mail').onclick = async () => {
  const b = $('#scan-mail'); b.disabled = true;
  try { const r = await write('/admin-api/scan-mail'); $('#notice').textContent = r.results.some(x => x.error) ? '部分账号扫描失败，请查看各账号状态。' : '收件扫描完成。'; await refresh(); }
  catch(e) { $('#notice').textContent = e.message; } finally { b.disabled = false; }
};
$('#logout').onclick = async () => { try { await write('/admin-api/logout'); location.reload(); } catch(e) { $('#notice').textContent = e.message; } };
$('#add-account').onclick = () => { const region = el('label', 'iCloud 区域'), select = el('select'); select.name = 'region'; select.append(new Option('全球 icloud.com', 'global'), new Option('中国大陆 icloud.com.cn', 'china')); region.append(select); openDialog('新增独立 iCloud 账号', [field('账号名称', 'name'), field('预期 Apple 登录邮箱（用于防串号核验）', 'appleId', 'email'), region], async b => { await write('/admin-api/accounts', b); }); };
$('#distribute-selected').onclick = () => { try { distribute([...selected.values()]); } catch(e) { $('#notice').textContent = e.message; } };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = async () => { view = button.dataset.view; $('#heading').textContent = button.textContent; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button)); try { await render(); } catch(e) { $('#notice').textContent = e.message; } };
for (const id of ['#account-filter', '#search', '#status-filter']) $(id).addEventListener('input', () => { void render().catch(e => { $('#notice').textContent = e.message; }); });
setInterval(() => { if (!document.hidden && !$('#workspace').hidden && !$('#dialog').open) void refresh(); }, 30000);
void refresh();
