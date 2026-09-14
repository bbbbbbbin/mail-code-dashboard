import { $, api, copyButton, element as el, displayMail, setPagePending } from './shared.js';
let csrf = '', accounts = [], view = 'inventory', selected = new Map(), dialogAction, refreshTimer = null, busy = false;
const REFRESH_KEY = 'mail-dashboard-admin-auto-refresh';
const write = (path, data = {}, method = 'POST') => api(path, { method, data, csrf });
const accountName = id => accounts.find(a => a.id === id)?.name || id;
const rowKey = r => `${r.accountId}:${r.id}`;
const accountTone = id => `tone-${Math.max(0, accounts.findIndex(a => a.id === id)) % 5}`;
const date = v => v ? new Date(v).toLocaleString() : '—';
const grantStatus = g => g.status === 'active' && g.expiresAt != null && (!Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= Date.now()) ? 'expired' : g.status;
const expiryLabel = g => g.expiresAt == null ? '永久有效' : Number.isFinite(Date.parse(g.expiresAt)) ? `有效至 ${date(g.expiresAt)}` : '有效期异常 · 已停止访问';
const stateName = g => ({ unassigned: '未分享', active: g.expiresAt == null ? '有效 · 永久' : '有效 · 限时', expired: '已到期', revoked: '已撤销' })[grantStatus(g)] || g.status;
const matchesStatus = (g, status) => !status || (status === 'finite' ? grantStatus(g) === 'active' && g.expiresAt != null : status === 'permanent' ? grantStatus(g) === 'active' && g.expiresAt == null : grantStatus(g) === status);
function setBusy(value) { busy = value; setPagePending(value); }
async function runAction(action) { if (busy) return; setBusy(true); try { return await action(); } finally { setBusy(false); } }
function button(text, action, cls = '') { const b = el('button', text, cls); b.type = 'button'; b.onclick = async () => { if (busy) return; try { const result = action(); if (result?.then) await runAction(() => result); } catch(e) { $('#notice').textContent = e.message; } }; return b; }
function field(label, name, type = 'text', value = '', required = true) { const l = el('label', label), input = el('input'); Object.assign(input, { name, type, value, required }); if (type === 'password') input.autocomplete = 'new-password'; l.append(input); return l; }
function openDialog(title, nodes, action) { $('#dialog-title').textContent = title; $('#dialog-body').replaceChildren(...nodes); $('#dialog-error').textContent = ''; $('#dialog-submit').hidden = !action; dialogAction = action; $('#dialog').showModal(); if (busy) setPagePending(true); }
function secretDialog(title, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const area = el('textarea'); area.value = payload; area.readOnly = true; area.rows = 10;
  openDialog(title, [el('p', '完整密钥仅此次显示。请妥善保存，关闭后不再回显；丢失时可以重置。', 'muted'), area, copyButton(payload)]);
}
function durationFields() {
  const presetLabel = el('label', '分享有效期'), preset = el('select');
  preset.name = 'durationPreset'; preset.id = 'share-duration';
  preset.append(...[['7 天', '7'], ['30 天', '30'], ['90 天', '90'], ['自定义天数', 'custom'], ['永久有效', 'permanent']].map(([label, value]) => new Option(label, value)));
  preset.value = '7'; presetLabel.append(preset);
  const custom = field('自定义天数（1–3650 天）', 'durationDays', 'number', '7'), input = custom.querySelector('input');
  input.min = '1'; input.max = '3650'; input.step = '1'; input.inputMode = 'numeric';
  const hint = el('p', undefined, 'muted share-duration-hint'); hint.id = 'share-duration-hint'; preset.setAttribute('aria-describedby', hint.id); input.setAttribute('aria-describedby', hint.id);
  const update = () => {
    custom.hidden = preset.value !== 'custom'; input.disabled = custom.hidden; input.required = !custom.hidden;
    const days = Number(preset.value === 'custom' ? input.value : preset.value);
    hint.textContent = preset.value === 'permanent' ? '持续有效，直到管理员撤销或重置链接。' : Number.isInteger(days) && days >= 1 && days <= 3650 ? `从本次确认起计算 ${days} 天，到期后自动停止收件访问。` : '请输入 1–3650 的整数天数。';
  };
  preset.onchange = update; input.oninput = update; update();
  return [presetLabel, custom, hint];
}
function durationFromForm(data) {
  if (data.durationPreset === 'permanent') return null;
  const raw = data.durationPreset === 'custom' ? data.durationDays : data.durationPreset;
  if (!/^[0-9]+$/.test(String(raw || ''))) throw new Error('分享天数需为 1–3650 的整数。');
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('分享天数需为 1–3650 的整数。');
  return days;
}
function shareDialog(title, grants, inboxUrl) {
  const nodes = [el('p', '复制链接发给指定使用者，对方打开即可收件，无需再输入 Token。链接包含访问凭证，仅此次显示，请勿公开发布。', 'muted')];
  for (const g of grants) {
    const link = g.shareUrl || `${inboxUrl}#token=${encodeURIComponent(g.token)}`;
    const card = el('section', undefined, 'share-result'), area = el('textarea'), label = el('label', '专属分享链接');
    area.value = link; area.readOnly = true; area.rows = 3; area.spellcheck = false; area.setAttribute('aria-label', `${g.email} 的分享链接`); label.append(area);
    const copy = copyButton(link, '复制链接'); copy.classList.add('primary'); copy.setAttribute('aria-label', `复制 ${g.email} 的分享链接`);
    const compatibility = el('details', undefined, 'share-compatibility'); compatibility.append(el('summary', '兼容方式：手动输入 Token'));
    compatibility.addEventListener('toggle', () => {
      compatibility.querySelector('.share-token')?.remove();
      if (compatibility.open) { const token = el('input', undefined, 'share-token'); token.value = g.token; token.readOnly = true; token.setAttribute('aria-label', '兼容收件 Token'); compatibility.append(token); }
    });
    card.append(el('strong', g.email, 'share-email'), el('p', expiryLabel(g), 'share-expiry'), label, copy, compatibility); nodes.push(card);
  }
  openDialog(title, nodes);
}
function closeDialog() { if (!busy) $('#dialog').close(); }
$('#dialog-close').onclick = closeDialog;
if ($('#dialog-cancel')) $('#dialog-cancel').onclick = closeDialog;
$('#dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#dialog').addEventListener('close', () => { if (!$('#dialog').open) { $('#dialog-body').replaceChildren(); dialogAction = null; } });
$('#dialog-form').onsubmit = async e => {
  e.preventDefault(); if (busy || typeof dialogAction !== 'function') return;
  const data = Object.fromEntries(new FormData(e.currentTarget)), action = dialogAction;
  $('#dialog-error').textContent = '';
  try { await runAction(async () => { const after = await action(data); await refresh(); $('#dialog').close(); if (typeof after === 'function') after(); }); }
  catch (e) { $('#dialog-error').textContent = e.message; }
};
function setAuthenticated(value) {
  document.body.classList.toggle('is-authenticated', value);
  $('#login').hidden = value; $('#workspace').hidden = !value; $('#logout').hidden = !value;
  if ($('#admin-tools')) $('#admin-tools').hidden = !value;
  if (!value) { csrf = ''; clearInterval(refreshTimer); refreshTimer = null; }
}
async function refresh() {
  const wasAuthenticated = document.body.classList.contains('is-authenticated');
  try {
    const auth = await api('/admin-api/session'); csrf = auth.csrf;
    accounts = (await api('/admin-api/inventory')).accounts;
    setAuthenticated(true);
    const chosen = $('#account-filter').value;
    $('#account-filter').replaceChildren(new Option('全部账号', ''), ...accounts.map(a => new Option(a.name, a.id)));
    $('#account-filter').value = chosen;
    const rows = accounts.flatMap(a => a.inventory);
    $('#stats').replaceChildren(...[[accounts.length, 'iCloud 账号'], [rows.length, '邮箱总数'], [rows.filter(r => grantStatus(r.distribution) === 'active').length, '有效分享'], [rows.filter(r => r.distribution.status === 'unassigned').length, '未分享']].map(([n, label]) => { const c = el('div', undefined, 'card stat'); c.append(el('strong', n), el('span', label)); return c; }));
    await render();
    updateRefreshLabel(); scheduleRefresh();
  } catch (e) { $('#notice').textContent = e.status === 401 && !wasAuthenticated ? '' : e.message; if (e.status === 401) { setAuthenticated(false); $('#content').replaceChildren(); selected.clear(); } }
}
function refreshSettings() {
  const input = $('#auto-refresh'), interval = $('#refresh-interval');
  if (!input || !interval) return;
  let enabled = false, seconds = '30';
  try { enabled = localStorage.getItem(REFRESH_KEY) === 'on'; seconds = localStorage.getItem(`${REFRESH_KEY}-interval`) || seconds; } catch {}
  input.checked = enabled; interval.value = ['30', '60', '300'].includes(seconds) ? seconds : '30'; interval.disabled = !enabled; updateRefreshLabel();
}
function updateRefreshLabel() {
  const input = $('#auto-refresh'), interval = $('#refresh-interval'), label = $('#refresh-state'); if (!input || !label) return;
  label.textContent = input.checked ? `每 ${interval.value === '60' ? '1 分钟' : interval.value === '300' ? '5 分钟' : '30 秒'} · 自动同步` : '已关闭 · 手动刷新';
  const dot = document.querySelector('.sync-control:not(.compact) .sync-dot'); if (dot) dot.classList.toggle('is-on', input.checked);
}
function scheduleRefresh() {
  clearInterval(refreshTimer); refreshTimer = null;
  const input = $('#auto-refresh'), interval = $('#refresh-interval');
  if (input?.checked && !$('#workspace')?.hidden) refreshTimer = setInterval(() => { if (!busy && !document.hidden && !$('#dialog')?.open && !$('#workspace')?.hidden) void runAction(refresh); }, Number(interval?.value || 30) * 1000);
}
function saveRefreshSettings() {
  if (busy) return;
  const input = $('#auto-refresh'), interval = $('#refresh-interval'); if (!input || !interval) return;
  try { localStorage.setItem(REFRESH_KEY, input.checked ? 'on' : 'off'); localStorage.setItem(`${REFRESH_KEY}-interval`, interval.value); } catch {}
  interval.disabled = !input.checked; updateRefreshLabel(); scheduleRefresh();
}
function table(headers, rows) { const wrap = el('div', undefined, 'table-wrap card'), t = el('table'), head = el('thead'), hr = el('tr'); headers.forEach(h => hr.append(el('th', h))); head.append(hr); t.append(head); const body = el('tbody'); rows.forEach(cells => { const row = el('tr'); cells.forEach(v => { const cell = el('td'); cell.append(v instanceof Node ? v : document.createTextNode(String(v ?? ''))); row.append(cell); }); body.append(row); }); t.append(body); wrap.append(t); if (!rows.length) wrap.append(el('p', '暂无记录', 'empty')); return wrap; }
function actions(...items) { const box = el('div', undefined, 'actions'); box.append(...items); return box; }
function grantActions(g, ...leadingButtons) {
  const box = actions(
    ...leadingButtons,
    button('重新生成链接', () => openDialog('重新生成原使用者的分享链接', [el('p', `邮箱：${g.email}。旧链接、旧 Token 与旧会话立即失效。原使用者和邮件起始范围保持不变。`, 'warning'), el('p', `${expiryLabel(g)}。此操作不会延长有效期${g.status === 'revoked' ? '，确认后会恢复原使用者的授权' : ''}；到期链接请先调整有效期。`)], async () => { const result = await write(`/admin-api/grants/${g.id}/reset`); return () => shareDialog('新的分享链接 · 请重新发送', [result], result.inboxUrl); })),
    button('调整有效期', () => openDialog('调整原分享的有效期', [el('p', `邮箱：${g.email} · ${expiryLabel(g)}`), el('p', '新的有效期从本次确认起计算，原链接与使用者不变；已打开的会话需重新通过原链接进入。已撤销的分享仍保持撤销。', 'muted'), ...durationFields()], b => write(`/admin-api/grants/${g.id}`, { durationDays: durationFromForm(b) }, 'PATCH'))),
    ...(['active', 'expired'].includes(grantStatus(g)) ? [button('撤销', () => openDialog('撤销收件分享', [el('p', `${g.email} 将停止对原链接与 Token 提供收件。邮箱不删除，也不自动重新分发。`)], () => write(`/admin-api/grants/${g.id}/revoke`)))] : [])
  );
  box.classList.add('grant-actions', 'row-actions'); return box;
}
async function render() {
  const content = $('#content'); content.replaceChildren();
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  $('#stats').hidden = view !== 'inventory';
  const descriptions = { inventory: ['邮箱库', '查找邮箱、复制地址，设置分享天数并发送专属链接。'], accounts: ['账号管理', '分别管理每个 iCloud 账号的同步、转发收件与后台生成。'], grants: ['分享管理', '查看有效期与访问记录，按需续期、重新生成链接或撤销分享。'], keys: ['密钥与安全', '按账号管理程序和同步密钥，完整密钥仅在创建时显示。'], audit: ['活动记录', '追踪账号、邮箱与授权的操作记录，快速核对变更。'] };
  if ($('#section-title')) $('#section-title').textContent = descriptions[view][0];
  if ($('#page-description')) $('#page-description').textContent = descriptions[view][1];
  const chosen = $('#account-filter').value, q = $('#search').value.toLowerCase(), status = $('#status-filter').value;
  $('#search').closest('label').hidden = !['inventory', 'grants'].includes(view);
  $('#status-filter').closest('label').hidden = !['inventory', 'grants'].includes(view);
  $('#distribute-selected').hidden = view !== 'inventory';
  $('#add-account').hidden = !['inventory', 'accounts'].includes(view);
  if (view === 'inventory') {
    const rows = accounts.filter(a => !chosen || a.id === chosen).flatMap(a => a.inventory.map(r => ({ ...r, account: a }))).filter(r => matchesStatus(r.distribution, status) && `${r.email} ${r.label} ${r.distribution.recipient || ''}`.toLowerCase().includes(q));
    const broken = accounts.filter(a => a.error); if (broken.length) content.append(el('p', `部分账号状态暂不可用：${broken.map(a => a.name).join('、')}，未用空数据替换。`, 'warning'));
    content.append(table(['选择', '邮箱 / 标签', '所属账号', '分享状态 / 有效期', '分享对象', '邮件', '操作'], rows.map(r => {
      const key = rowKey(r);
      const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', `选择 ${r.email}`); input.disabled = r.distribution.status !== 'unassigned'; input.checked = selected.has(key); input.onchange = () => { if (!busy) input.checked ? selected.set(key, r) : selected.delete(key); };
      const mailbox = el('div', undefined, 'mailbox-cell'); const emailLine = el('div', undefined, 'email-line'); emailLine.append(el('strong', r.email), copyButton(r.email)); mailbox.append(emailLine, el('small', r.label || '无标签', 'muted'));
      const account = el('span', r.account.name, `badge ${accountTone(r.accountId)}`);
      const state = el('div', undefined, 'grant-state'); state.append(el('span', stateName(r.distribution), `badge grant-${grantStatus(r.distribution)}`)); if (r.distribution.status !== 'unassigned') state.append(el('small', expiryLabel(r.distribution), 'muted'));
      const readMail = button('查看邮件', async () => { const data = await api(`/admin-api/accounts/${r.accountId}/emails/${r.id}/messages`); const box = el('div'); displayMail(data.messages, box); openDialog(r.email, [box]); });
      const controls = r.distribution.status === 'unassigned'
        ? actions(readMail, button('分享', () => distribute([r])))
        : grantActions({ ...r.distribution, email: r.email }, readMail);
      controls.classList.add('row-actions');
      return [input, mailbox, account, state, r.distribution.recipient || '—', r.unread ? '未读' : r.receivedAt ? date(r.receivedAt) : '—', controls];
    })));
  } else if (view === 'accounts') {
    const grid = el('div', undefined, 'account-grid');
    for (const a of accounts.filter(a => !chosen || a.id === chosen)) {
      const card = el('section', undefined, `card account ${accountTone(a.id)}`); card.append(el('h2', a.name), el('p', a.expectedAppleId, 'muted'), el('p', `${a.bound ? '已核验绑定' : '待 Chrome 配对'} · ${a.paused ? '已暂停' : '已启用'}`, 'badge'), el('p', `Cookie：${({ verified: '已核验', not_synced: '未同步', verification_failed: '核验失败' })[a.cookieStatus] || a.cookieStatus} · ${date(a.lastSyncedAt)}`), el('p', `转发收件：${a.forwardConfigured ? '已配置' : '待配置'} · 邮箱 ${a.inventory.length} 个`), el('p', `收件扫描：${({ ok: '正常', unavailable: '连接失败，请检查配置', not_checked: '尚未扫描', scan_window_truncated: '已扫描最近邮件，存在更早邮件' })[a.mailStatus] || a.mailStatus} · ${date(a.lastMailScanAt)}`), el('p', `后台生成：${a.autoStock?.enabled ? '开启' : '关闭'} · 下次 ${date(a.autoStock?.nextAttemptAt)}`, 'muted'));
      if (a.autoStock?.pausedReason || a.autoStock?.lastError) card.append(el('p', a.autoStock.pausedReason || a.autoStock.lastError, 'warning'));
      const primary = actions(button('同步库存', async () => { await write(`/admin-api/accounts/${a.id}/sync`); await refresh(); }, 'primary'), button('手动生成一个', () => openDialog('生成隐藏邮箱', [field('标签（例如 hme-001）', 'label', 'text', `${a.autoStock?.prefix || 'hme'}-001`)], async b => { await write(`/admin-api/accounts/${a.id}/generate`, b); })));
      primary.classList.add('account-actions');
      const settings = actions(button('配置转发收件', () => forward(a)), button('自动生成设置', () => auto(a)), button('修改账号名称', () => openDialog('修改显示名称（保持原账号绑定）', [field('账号名称', 'name', 'text', a.name)], async b => { await write(`/admin-api/accounts/${a.id}`, b, 'PATCH'); })), button('创建同步密钥', () => createKey(a, 'upload')), button('手动导入 Cookie', () => manualCookie(a)));
      settings.classList.add('account-settings');
      card.append(primary, settings, button(a.paused ? '启用账号' : '暂停账号', async () => { await write(`/admin-api/accounts/${a.id}`, { paused: !a.paused }, 'PATCH'); await refresh(); }, a.paused ? 'button-quiet' : 'danger')); grid.append(card);
    }
    content.append(grid); if (!accounts.length) content.append(el('div', '先新增账号，再使用对应 Chrome 扩展配对。账号归属验证通过后，启用账号并配置转发收件。', 'empty'));
  } else if (view === 'grants') {
    content.append(el('p', '完整链接仅生成时显示，不在服务器保存明文。再次分享原链接请使用已保存的副本；遗失后重新生成会使旧链接和旧会话失效。到期或撤销不会将邮箱交给其他使用者。', 'muted'));
    const data = await api('/admin-api/grants'); content.append(table(['邮箱', '所属账号', '分享对象', '状态', '有效期', '最近访问', '操作'], data.grants.filter(g => (!chosen || g.accountId === chosen) && matchesStatus(g, status) && `${g.email} ${g.recipient || ''}`.toLowerCase().includes(q)).map(g => [g.email, accountName(g.accountId), g.recipient, el('span', stateName(g), `badge grant-${grantStatus(g)}`), expiryLabel(g), date(g.lastUsedAt), grantActions(g)])));
  } else if (view === 'keys') {
    content.append(el('p', '程序密钥与 Cookie 同步密钥分别绑定账号；收件链接与 Token 请在“分享管理”管理。', 'muted'));
    const keyActions = actions(...accounts.filter(a => !chosen || a.id === chosen).map(a => button(`为 ${a.name} 创建程序密钥`, () => createKey(a, 'program'))));
    keyActions.classList.add('key-actions'); content.append(keyActions);
    const data = await api('/admin-api/keys'); content.append(table(['名称', '账号', '权限', '标识', '状态', '最近使用', '操作'], data.keys.filter(k => !chosen || k.accountId === chosen).map(k => [k.name, accountName(k.accountId), k.scopes.join(' / '), k.mask, k.revoked ? '已撤销' : '有效', date(k.lastUsedAt), k.revoked ? '—' : button('撤销', () => openDialog('撤销密钥', [el('p', `${k.name} 将立即停止访问。`)], async () => { await write(`/admin-api/keys/${k.id}/revoke`); }))])));
    content.append(button('更改管理员密码', () => openDialog('更改密码后需重新登录', [field('当前密码', 'currentPassword', 'password'), field('新密码（至少 14 位）', 'newPassword', 'password')], async b => { await write('/admin-api/password', b); location.reload(); })));
  } else { const data = await api('/admin-api/audit'); content.append(table(['时间', '操作', '账号', '记录编号'], data.events.filter(e => !chosen || e.accountId === chosen).map(e => [date(e.at), e.action, e.accountId ? accountName(e.accountId) : '系统', e.objectId || '—']))); }
  if (busy) setPagePending(true);
}
function distribute(rows) {
  if (!rows.length) throw new Error('请先选择未分享的邮箱。');
  if (new Set(rows.map(r => r.accountId)).size !== 1) throw new Error('批量分享请选择同一账号的邮箱，避免混淆归属。');
  const history = field('开放分发前的历史邮件（默认不开放）', 'history', 'checkbox', '', false);
  openDialog(`分享 ${rows.length} 个邮箱`, [el('p', `所属账号：${accountName(rows[0].accountId)}。每个邮箱生成独立链接，打开即可收件。`), field('分享对象 / 用途', 'recipient'), ...durationFields(), history], async b => {
    const result = await write(`/admin-api/accounts/${rows[0].accountId}/distribute`, { emailIds: rows.map(r => r.id), recipient: b.recipient, includeHistory: b.history !== undefined, durationDays: durationFromForm(b) });
    selected.clear(); return () => shareDialog('分享完成 · 复制链接发送', result.grants, result.inboxUrl);
  });
}
function createKey(a, kind) { openDialog(kind === 'upload' ? '创建账号专属同步密钥' : '创建账号专属程序密钥', [el('p', `仅绑定 ${a.name}（${a.expectedAppleId}）`), field('密钥备注', 'name', 'text', kind === 'upload' ? '我的 Chrome' : '收件脚本')], async b => {
  const result = await write(`/admin-api/accounts/${a.id}/keys`, { kind, name: b.name, scopes: kind === 'program' ? ['inventory:read', 'mail:read'] : [] });
  return () => secretDialog('密钥已创建', { server: location.origin, account: a.name, accountId: a.id, token: result.token, scopes: result.scopes });
}); }
function forward(a) { openDialog(`配置 ${a.name} 的转发收件`, [el('p', '此处填写接收 iCloud 转发邮件的 IMAP 邮箱与应用授权码，非 Apple 登录密码。已有密码留空保持不变；更换主机或邮箱时需填写新授权码。', 'muted'), field('IMAP 主机', 'host', 'text', a.forwardSettings?.host || 'imap.qq.com'), field('TLS 端口', 'port', 'number', String(a.forwardSettings?.port || 993)), field('转发邮箱地址', 'email', 'email', a.forwardSettings?.email || ''), field('应用授权码', 'password', 'password', '', !a.forwardConfigured)], async b => { await write(`/admin-api/accounts/${a.id}`, { forward: { ...b, port: Number(b.port), secure: true } }, 'PATCH'); }); }
function auto(a) { const enabled = field('开启后台自动生成', 'enabled', 'checkbox', '', false); enabled.querySelector('input').checked = !!a.autoStock?.enabled; openDialog(`${a.name} · 后台生成`, [field('标签前缀', 'prefix', 'text', a.autoStock?.prefix || 'hme'), enabled, el('p', '每小时一批、每批最多 5 个。关闭页面后继续运行；结果不确定时暂停，先同步核对再恢复。', 'muted')], async b => { await write(`/admin-api/accounts/${a.id}/auto-stock`, { prefix: b.prefix, enabled: b.enabled !== undefined }, 'PATCH'); }); }
function manualCookie(a) { const cookies = el('textarea'); cookies.name = 'cookies'; cookies.rows = 7; cookies.required = true; cookies.placeholder = '[{"name":"X-APPLE-…","value":"…"}]'; openDialog(`手动同步至 ${a.name}`, [el('p', '使用此账号的同步密钥；服务器仍会核验 Apple 身份。不要粘贴其他账号的 Cookie。'), field('此账号同步密钥', 'token', 'password'), cookies], async b => { const r = await fetch('/bridge/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ expectedAccountId: a.id, cookies: JSON.parse(b.cookies) }) }); const result = await r.json(); if (!r.ok) throw new Error(`同步未完成：${result.error}`); if (result.account.id !== a.id) throw new Error('密钥属于其他账号；请核对绑定。'); }); }
$('#login-form').onsubmit = async e => { e.preventDefault(); if (busy) return; const f = e.currentTarget, data = Object.fromEntries(new FormData(f)); try { await runAction(async () => { await api('/admin-api/login', { method: 'POST', data }); f.reset(); $('#notice').textContent = ''; await refresh(); }); } catch(e) { $('#notice').textContent = e.message; } };
$('#refresh').onclick = () => runAction(refresh);
$('#auto-refresh').onchange = saveRefreshSettings;
$('#refresh-interval').onchange = saveRefreshSettings;
$('#scan-mail').onclick = async () => {
  if (busy) return;
  try { await runAction(async () => { const r = await write('/admin-api/scan-mail'); $('#notice').textContent = r.results.some(x => x.error) ? '部分账号扫描失败，请查看各账号状态。' : '收件扫描完成。'; await refresh(); }); }
  catch(e) { $('#notice').textContent = e.message; }
};
$('#logout').onclick = async () => { if (busy) return; try { await runAction(async () => { await write('/admin-api/logout'); location.reload(); }); } catch(e) { $('#notice').textContent = e.message; } };
$('#add-account').onclick = () => { if (busy) return; const region = el('label', 'iCloud 区域'), select = el('select'); select.name = 'region'; select.append(new Option('全球 icloud.com', 'global'), new Option('中国大陆 icloud.com.cn', 'china')); region.append(select); openDialog('新增独立 iCloud 账号', [field('账号名称', 'name'), field('预期 Apple 登录邮箱（用于防串号核验）', 'appleId', 'email'), region], async b => { await write('/admin-api/accounts', b); }); };
$('#distribute-selected').onclick = () => { if (busy) return; try { distribute([...selected.values()]); } catch(e) { $('#notice').textContent = e.message; } };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = async () => { if (busy) return; view = button.dataset.view; $('#heading').textContent = button.textContent; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button)); try { await runAction(render); } catch(e) { $('#notice').textContent = e.message; } };
for (const id of ['#account-filter', '#search', '#status-filter']) $(id).addEventListener('input', () => { if (!busy) void runAction(render).catch(e => { $('#notice').textContent = e.message; }); });
refreshSettings();
void runAction(refresh);
