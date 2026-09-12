export const $ = selector => document.querySelector(selector);
export function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (className) e.className = className; return e; }
export async function copyText(value) {
  const text = String(value || '');
  if (!text) return;
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = element('textarea'); input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
}
export function copyButton(value, label = '复制') {
  const button = element('button', label, 'copy-button'); button.type = 'button'; button.setAttribute('aria-label', `${label} ${value}`); button.onclick = async () => {
    try { await copyText(value); button.textContent = '已复制'; setTimeout(() => { button.textContent = label; }, 1200); } catch { button.textContent = '请手动复制'; }
  }; return button;
}
const messages = { LOGIN_REQUIRED: '请登录后继续。', INVALID_LOGIN: '用户名或密码不正确。', INVALID_MAIL_TOKEN: 'Token 无效或已被撤销。', MAIL_ACCESS_REVOKED: '授权已撤销或重置，请联系分发人。', ACCOUNT_IDENTITY_MISMATCH: 'Cookie 的 iCloud 身份与绑定账号不一致，原数据未覆盖。', ACCOUNT_NOT_BOUND: '请先在对应 Chrome 中同步 Cookie，完成身份绑定。', ACCOUNT_PAUSED: '账号已暂停，请联系管理员。', ACCOUNT_NOT_READY: '账号尚未绑定或已暂停。', ALREADY_DISTRIBUTED_RESET_EXISTING: '该邮箱已有分发记录，请管理原授权，不重复分发。', MAILBOX_NOT_CONFIGURED: '请先配置此账号的转发收件邮箱。', MAILBOX_UNAVAILABLE: '转发收件暂时不可用，请检查认证与网络。', RATE_LIMITED: '操作较频繁，请稍后再试。', APPLE_LOGIN_REQUIRED: 'iCloud 登录已失效，请在对应 Chrome 重新登录。', APPLE_VERIFICATION_UNAVAILABLE: 'iCloud 身份验证暂时失败，原 Cookie 保持不变。', PASSWORD_LENGTH_14_256: '密码长度需为 14–256 位。' };
Object.assign(messages, {
  NEW_IMAP_PASSWORD_REQUIRED: '更换转发主机、邮箱或端口时，请填写对应的新应用授权码。',
  APPLE_HME_SERVICE_UNAVAILABLE: 'Apple 尚未返回此账号的隐藏邮箱服务地址，请重新同步 Cookie 并检查 iCloud+ 服务。',
  GENERATION_RESULT_UNCERTAIN: '生成结果待核对，已暂停重复尝试；请先同步库存后再恢复。',
  INCOMPLETE_COOKIES: '当前 Chrome 的 iCloud 登录信息不完整，请重新登录后同步。',
  INVALID_KEY: '密钥无效或已撤销，请检查所绑定的账号。'
});
export async function api(path, { method = 'GET', data, csrf } = {}) {
  const r = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const result = await r.json();
  if (!r.ok) throw Object.assign(new Error(messages[result.error] || `操作未完成：${result.error || r.status}`), { status: r.status });
  return result;
}
export function displayMail(rows, target) {
  const opened = new Set([...target.querySelectorAll('details[open]')].map(e => e.dataset.mailKey));
  target.replaceChildren();
  if (!rows.length) { target.append(element('div', '暂无符合授权范围的邮件。刷新范围为最近匹配邮件，不代表完整历史归档。', 'empty')); return; }
  for (const m of rows) {
    const box = element('details', undefined, 'message card');
    box.dataset.mailKey = JSON.stringify([m.receivedAt, m.subject, m.from]);
    box.open = opened.has(box.dataset.mailKey);
    const summary = element('summary'); summary.append(element('strong', m.subject || '无主题'), element('span', m.receivedAt ? new Date(m.receivedAt).toLocaleString() : '', 'muted'));
    box.append(summary, element('p', typeof m.from === 'string' ? m.from : m.from?.text || '', 'muted'));
    if (m.codes?.length) box.append(element('div', m.codes.join(' · '), 'code'));
    // Text rendering intentionally excludes remote images, scripts, attachment previews and HTML tracking.
    box.append(element('pre', m.text || '此邮件暂无可显示的正文。'));
    target.append(box);
  }
}
