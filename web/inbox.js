import { $, api, copyButton, displayMail, element as el } from './shared.js';
let loading = false, refreshTimer = null, busy = false;
function setBusy(value) { busy = value; document.body.classList.toggle('is-busy', value); const layer = $('#busy-layer'); if (layer) layer.hidden = !value; }
async function runAction(action) { if (busy) return; setBusy(true); try { return await action(); } finally { setBusy(false); } }
const REFRESH_KEY = 'mail-dashboard-inbox-auto-refresh';
async function refresh() {
  if (loading) return; loading = true;
  try {
    const data = await api('/mail-api/messages');
    $('#login-form').hidden = true; $('#mailbox').hidden = false; $('#logout').hidden = false;
    const mailboxName = $('#mailbox-name'); mailboxName.classList.add('mailbox-identity'); mailboxName.replaceChildren(el('strong', data.email), copyButton(data.email));
    displayMail(data.messages, $('#messages')); $('#notice').textContent = `已更新 ${new Date().toLocaleTimeString()}`; updateRefreshLabel(); scheduleRefresh();
  } catch (e) {
    $('#notice').textContent = e.message;
    if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) {
      $('#messages').replaceChildren(); $('#mailbox').hidden = true; $('#login-form').hidden = false;
      $('#mailbox-name').textContent = '输入分发给你的 Token，查看对应邮箱的邮件。';
    }
  } finally { loading = false; }
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
  if (input?.checked && !$('#mailbox')?.hidden) refreshTimer = setInterval(() => { if (busy || document.hidden || $('#mailbox')?.hidden) return; void refresh(); }, Number(interval?.value || 30) * 1000);
}
function saveRefreshSettings() {
  const input = $('#auto-refresh'), interval = $('#refresh-interval'); if (!input || !interval) return;
  try { localStorage.setItem(REFRESH_KEY, input.checked ? 'on' : 'off'); localStorage.setItem(`${REFRESH_KEY}-interval`, interval.value); } catch {}
  interval.disabled = !input.checked; updateRefreshLabel(); scheduleRefresh();
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return; const form = e.currentTarget, button = form.querySelector('button'); button.disabled = true;
  try { await runAction(async () => { await api('/mail-api/login', { method: 'POST', data: { token: form.elements.token.value.trim() } }); form.reset(); await refresh(); }); }
  catch (e) { $('#notice').textContent = e.message; } finally { button.disabled = false; }
});
$('#refresh').onclick = () => { if (!busy) void runAction(refresh); };
$('#auto-refresh').onchange = saveRefreshSettings;
$('#refresh-interval').onchange = saveRefreshSettings;
$('#logout').onclick = async () => { if (busy) return; try { await runAction(async () => { await api('/mail-api/logout', { method: 'POST', data: {} }); location.reload(); }); } catch (e) { $('#notice').textContent = e.message; } };
refreshSettings();
void refresh();
