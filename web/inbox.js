import { $, api, displayMail } from './shared.js';
let loading = false;
async function refresh() {
  if (loading) return; loading = true;
  try {
    const data = await api('/mail-api/messages');
    $('#login-form').hidden = true; $('#mailbox').hidden = false; $('#logout').hidden = false;
    $('#mailbox-name').textContent = data.email;
    displayMail(data.messages, $('#messages')); $('#notice').textContent = `已更新 ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('#notice').textContent = e.message;
    if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) {
      $('#messages').replaceChildren(); $('#mailbox').hidden = true; $('#login-form').hidden = false;
      $('#mailbox-name').textContent = '输入分发给你的 Token，查看对应邮箱的邮件。';
    }
  } finally { loading = false; }
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const form = e.currentTarget, button = form.querySelector('button'); button.disabled = true;
  try { await api('/mail-api/login', { method: 'POST', data: { token: form.elements.token.value.trim() } }); form.reset(); await refresh(); }
  catch (e) { $('#notice').textContent = e.message; } finally { button.disabled = false; }
});
$('#refresh').onclick = refresh;
$('#logout').onclick = async () => { try { await api('/mail-api/logout', { method: 'POST', data: {} }); location.reload(); } catch (e) { $('#notice').textContent = e.message; } };
setInterval(() => { if (!document.hidden && !$('#mailbox').hidden) void refresh(); }, 15000);
void refresh();
