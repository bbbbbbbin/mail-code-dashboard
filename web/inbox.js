import { $, api, bindPopup, copyButton, displayMail, element as el, setPagePending } from './shared.js';
let loading = false, refreshTimer = null, expiryTimer = null, busy = false, needsLogin = false, accessUntil = null, accessVersion = 0, pendingShareLink = null;
function setBusy(value) { busy = value; setPagePending(value); }
async function runAction(action) { if (busy) return; setBusy(true); try { return await action(); } finally { setBusy(false); if (pendingShareLink) void runAction(openPendingShare); } }
const REFRESH_KEY = 'mail-dashboard-inbox-auto-refresh';
const expiredMessage = '分享已到期，请联系分享人调整有效期后，重新打开原链接。';
function consumeShareLink() {
  const fragment = location.hash;
  if (!fragment || fragment === '#main-content') return null;
  // Remove credentials before any network call; fragments are never sent as HTTP paths.
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  const params = new URLSearchParams(fragment.slice(1)), tokens = params.getAll('token');
  return tokens.length === 1 && [...params.keys()].length === 1 && /^mbx_[A-Za-z0-9_-]{43}$/.test(tokens[0]) ? { token: tokens[0] } : { error: '分享链接不完整或格式不正确，请向分享人索取完整链接。' };
}
function handleShareLink() {
  const link = consumeShareLink();
  if (!link) return false;
  clearMailbox(); pendingShareLink = link;
  if (!busy) void runAction(openPendingShare);
  return true;
}
async function openPendingShare() {
  const link = pendingShareLink, version = accessVersion; pendingShareLink = null;
  if (link.error) {
    // Clear an earlier mailbox session as well, including after a later reload.
    let warning = '';
    try { await api('/mail-api/logout', { method: 'POST', data: {} }); }
    catch (e) { if (e.status !== 401) warning = ' 原会话退出未完成，请检查网络后重新打开完整链接。'; }
    if (version === accessVersion) $('#notice').textContent = link.error + warning;
  } else { try { await login(link.token); } finally { link.token = ''; } }
}
function clearMailbox() {
  needsLogin = true; accessVersion += 1; accessUntil = null;
  clearTimeout(expiryTimer); expiryTimer = null;
  $('#messages').replaceChildren(); $('#mailbox-name').replaceChildren();
  $('#grant-expiry').textContent = ''; setAuthenticated(false);
}
function setExpiry(expiresAt) {
  clearTimeout(expiryTimer); expiryTimer = null;
  accessUntil = expiresAt == null ? null : Date.parse(expiresAt);
  if (accessUntil !== null && (!Number.isFinite(accessUntil) || accessUntil <= Date.now())) { clearMailbox(); $('#notice').textContent = expiredMessage; return false; }
  $('#grant-expiry').textContent = accessUntil === null ? '永久授权' : `有效至 ${new Date(accessUntil).toLocaleString()}`;
  const checkExpiry = () => {
    if (accessUntil === null) return;
    const remaining = accessUntil - Date.now();
    if (remaining <= 0) { clearMailbox(); $('#notice').textContent = expiredMessage; }
    else expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
  };
  // A one-shot deadline clears visible mail even with automatic refresh disabled.
  checkExpiry(); return true;
}
function setAuthenticated(value) {
  document.body.classList.toggle('is-authenticated', value);
  $('#login-form').hidden = value; $('#mailbox').hidden = !value; $('#logout').hidden = !value;
  if ($('#mailbox-identity-panel')) $('#mailbox-identity-panel').hidden = !value;
  if ($('#inbox-description')) $('#inbox-description').textContent = value ? '你的专属邮件空间。复制地址、展开邮件，按需刷新。' : '打开分享链接即可收件，也可以手动输入收件 Token。';
  if (!value) { clearInterval(refreshTimer); refreshTimer = null; }
}
async function refresh() {
  if (loading || needsLogin) return; loading = true;
  const version = accessVersion;
  const wasAuthenticated = document.body.classList.contains('is-authenticated');
  try {
    const data = await api('/mail-api/messages');
    if (version !== accessVersion || !setExpiry(data.expiresAt)) return;
    setAuthenticated(true);
    const mailboxName = $('#mailbox-name'); mailboxName.classList.add('mailbox-identity'); mailboxName.replaceChildren(el('strong', data.email), copyButton(data.email));
    displayMail(data.messages, $('#messages')); $('#notice').textContent = `已更新 ${new Date().toLocaleTimeString()}`; updateRefreshLabel(); scheduleRefresh();
    if (busy) setPagePending(true);
  } catch (e) {
    if (version !== accessVersion) return;
    $('#notice').textContent = e.status === 401 && !wasAuthenticated ? '' : e.message;
    if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) {
      clearMailbox();
    }
  } finally { loading = false; }
}
async function login(token) {
  clearMailbox();
  const version = accessVersion;
  try {
    const data = await api('/mail-api/login', { method: 'POST', data: { token } });
    if (version !== accessVersion) return;
    $('#login-form').reset();
    if (!setExpiry(data.expiresAt)) return;
    needsLogin = false; await refresh();
  } catch (e) { if (version === accessVersion) { clearMailbox(); $('#notice').textContent = e.message; } }
}
function refreshSettings() {
  const input = $('#auto-refresh'), interval = $('#refresh-interval'); if (!input || !interval) return;
  let enabled = false, seconds = '30';
  try { enabled = localStorage.getItem(REFRESH_KEY) === 'on'; seconds = localStorage.getItem(`${REFRESH_KEY}-interval`) || seconds; } catch {}
  input.checked = enabled; interval.value = ['30', '60', '300'].includes(seconds) ? seconds : '30'; interval.disabled = !enabled; updateRefreshLabel();
}
function updateRefreshLabel() {
  const input = $('#auto-refresh'), interval = $('#refresh-interval'); if (!input || !interval) return;
  const dot = document.querySelector('.compact .sync-dot'); if (dot) dot.classList.toggle('is-on', input.checked);
  const hint = $('#mailbox-hint'); if (hint) hint.textContent = input.checked ? `每 ${interval.value === '60' ? '1 分钟' : interval.value === '300' ? '5 分钟' : '30 秒'}自动检查 · 仅展示授权范围内的邮件` : '手动刷新 · 仅展示授权范围内的邮件';
}
function scheduleRefresh() {
  clearInterval(refreshTimer); refreshTimer = null;
  const input = $('#auto-refresh'), interval = $('#refresh-interval');
  if (input?.checked && !$('#mailbox')?.hidden) refreshTimer = setInterval(() => { if (busy || document.hidden || $('#mailbox')?.hidden) return; void runAction(refresh); }, Number(interval?.value || 30) * 1000);
}
function saveRefreshSettings() {
  if (busy) return;
  const input = $('#auto-refresh'), interval = $('#refresh-interval'); if (!input || !interval) return;
  try { localStorage.setItem(REFRESH_KEY, input.checked ? 'on' : 'off'); localStorage.setItem(`${REFRESH_KEY}-interval`, interval.value); } catch {}
  interval.disabled = !input.checked; updateRefreshLabel(); scheduleRefresh();
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return; const form = e.currentTarget, token = form.elements.token.value.trim();
  await runAction(() => login(token));
});
$('#refresh').onclick = () => { if (!busy) void runAction(refresh); };
bindPopup($('#refresh-options'), $('#refresh-panel'));
$('#auto-refresh').onchange = saveRefreshSettings;
$('#refresh-interval').onchange = saveRefreshSettings;
$('#logout').onclick = async () => { if (busy) return; try { await runAction(async () => { await api('/mail-api/logout', { method: 'POST', data: {} }); clearMailbox(); $('#notice').textContent = '已退出收件箱。'; }); } catch (e) { $('#notice').textContent = e.message; } };
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && accessUntil !== null && accessUntil <= Date.now()) { clearMailbox(); $('#notice').textContent = expiredMessage; }
});
window.addEventListener('hashchange', handleShareLink);
refreshSettings();
if (!handleShareLink()) void runAction(refresh);
