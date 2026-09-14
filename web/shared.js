export const $ = selector => document.querySelector(selector);
export function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (className) e.className = className; return e; }
let pendingState, activePopup, popupId = 0;
const popupBindings = new WeakMap();
export function closePopups({ restoreFocus = false } = {}) { activePopup?.close({ restoreFocus }); }
export function bindPopup(trigger, panel, { menu = false } = {}) {
  if (popupBindings.has(trigger)) return popupBindings.get(trigger);
  let opened = false, native = false, originalParent, originalNext;
  trigger.type = 'button';
  trigger.id ||= `popup-trigger-${++popupId}`;
  panel.id ||= `popup-panel-${++popupId}`;
  panel.hidden = true; panel.tabIndex = -1;
  // Keep the native top-layer contract on capable browsers; fallback browsers simply ignore this attribute.
  if (typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function') panel.setAttribute('popover', 'auto');
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', panel.id); trigger.setAttribute('aria-haspopup', menu ? 'menu' : 'dialog');
  panel.setAttribute('role', menu ? 'menu' : 'dialog'); if (!panel.getAttribute('aria-labelledby')) panel.setAttribute('aria-labelledby', trigger.id);
  if (menu) for (const button of panel.querySelectorAll('button')) { button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1; }
  const items = () => [...panel.querySelectorAll(menu ? 'button:not(:disabled)' : 'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]')].filter(node => !node.closest('[hidden]'));
  function position() {
    if (!trigger.isConnected || !panel.isConnected) { close({ restoreFocus: false }); return; }
    const anchor = trigger.getBoundingClientRect(), box = panel.getBoundingClientRect(), padding = 8, gap = 6;
    const width = document.documentElement.clientWidth || window.innerWidth, height = document.documentElement.clientHeight || window.innerHeight;
    const left = Math.max(padding, Math.min(anchor.right - box.width, width - box.width - padding));
    const below = anchor.bottom + gap, top = Math.max(padding, Math.min(below + box.height > height - padding ? anchor.top - box.height - gap : below, height - box.height - padding));
    panel.style.left = `${Math.round(left)}px`; panel.style.top = `${Math.round(top)}px`;
  }
  function outside(event) { if (!panel.contains(event.target) && !trigger.contains(event.target)) close({ restoreFocus: false }); }
  function scroll(event) { if (!(event.target instanceof Node) || !panel.contains(event.target)) close({ restoreFocus: false }); }
  function keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!menu) return;
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = items(), index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }
  function listen(add) {
    const method = add ? 'addEventListener' : 'removeEventListener';
    document[method]('click', outside, true); document[method]('focusin', outside, true); document[method]('keydown', keydown, true);
    window[method]('scroll', scroll, true); window[method]('resize', position);
  }
  function close({ restoreFocus = true, nativeHidden = false } = {}) {
    if (!opened) return;
    opened = false; listen(false); if (activePopup === controller) activePopup = null;
    if (native && !nativeHidden) { try { panel.hidePopover(); } catch {} }
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (originalParent?.isConnected && trigger.isConnected) originalParent.insertBefore(panel, originalNext?.parentNode === originalParent ? originalNext : null);
    else if (!trigger.isConnected) panel.remove();
    originalParent = null; originalNext = null;
    const dialog = $('dialog[open]');
    if (restoreFocus && trigger.isConnected && !trigger.disabled && !trigger.closest('[hidden], [inert]') && (!dialog || dialog.contains(trigger))) trigger.focus({ preventScroll: true });
  }
  function open({ focusLast = false } = {}) {
    const dialog = $('dialog[open]');
    if (pendingState || document.body.classList.contains('is-busy') || trigger.disabled || !trigger.isConnected || trigger.closest('[hidden], [inert]') || (dialog && !dialog.contains(trigger))) return;
    if (!opened) {
      closePopups(); opened = true; activePopup = controller; panel.hidden = false;
      native = typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function';
      if (native) {
        try { panel.showPopover(); } catch { native = false; panel.removeAttribute('popover'); }
      }
      if (!native) { originalParent = panel.parentNode; originalNext = panel.nextSibling; (dialog || document.body).append(panel); }
      trigger.setAttribute('aria-expanded', 'true'); position(); listen(true);
    }
    const buttons = items(); (buttons[focusLast ? buttons.length - 1 : 0] || panel).focus({ preventScroll: true });
  }
  const controller = { open, close }; popupBindings.set(trigger, controller);
  trigger.addEventListener('click', () => opened ? close() : open());
  trigger.addEventListener('keydown', event => {
    if (menu && !opened && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open({ focusLast: event.key === 'ArrowUp' }); }
  });
  // Close before the prewired action runs, so a new modal remembers the visible trigger as its return focus.
  if (menu) panel.addEventListener('click', event => { const button = event.target.closest('button'); if (button && panel.contains(button) && !button.disabled) close(); }, true);
  panel.addEventListener('toggle', event => {
    let stillOpen = false; try { stillOpen = panel.matches(':popover-open'); } catch {}
    if (opened && native && event.newState === 'closed' && !stillOpen) close({ restoreFocus: panel.contains(document.activeElement), nativeHidden: true });
  });
  return controller;
}
export function actionMenu(label, buttons, ariaLabel = label) {
  const wrapper = element('div', undefined, 'action-menu'), trigger = element('button', label, 'menu-trigger'), panel = element('div', undefined, 'action-popover');
  trigger.setAttribute('aria-label', ariaLabel); panel.append(...buttons); wrapper.append(trigger, panel); bindPopup(trigger, panel, { menu: true });
  return wrapper;
}
export function setPagePending(value) {
  const layer = $('#busy-layer'), dialog = $('dialog[open]');
  if (value) {
    closePopups({ restoreFocus: true });
    pendingState ||= { controls: new Map(), regions: new Map(), focus: document.activeElement, layerParent: layer?.parentNode, layerNext: layer?.nextSibling };
    for (const control of document.querySelectorAll('button, input, select, textarea')) {
      if (!pendingState.controls.has(control)) pendingState.controls.set(control, control.disabled);
      control.disabled = true;
    }
    for (const region of document.querySelectorAll('main, .sidebar, #dialog-form')) {
      if (!pendingState.regions.has(region)) pendingState.regions.set(region, { inert: region.inert, busy: region.getAttribute('aria-busy') });
      region.inert = true; region.setAttribute('aria-busy', 'true');
    }
    document.body.classList.add('is-busy');
    dialog?.classList.add('is-pending');
    if (layer) {
      (dialog || document.body).append(layer); layer.hidden = false;
      layer.tabIndex = -1; layer.focus({ preventScroll: true });
    }
    return;
  }
  document.body.classList.remove('is-busy');
  document.querySelectorAll('dialog.is-pending').forEach(node => node.classList.remove('is-pending'));
  if (layer) {
    layer.hidden = true;
    if (pendingState?.layerParent?.isConnected) pendingState.layerParent.insertBefore(layer, pendingState.layerNext?.parentNode === pendingState.layerParent ? pendingState.layerNext : null);
  }
  if (!pendingState) return;
  const state = pendingState; pendingState = null;
  for (const [control, disabled] of state.controls) if (control.isConnected) control.disabled = disabled;
  for (const [region, previous] of state.regions) {
    region.inert = previous.inert;
    if (previous.busy === null) region.removeAttribute('aria-busy'); else region.setAttribute('aria-busy', previous.busy);
  }
  const openDialog = $('dialog[open]');
  const previousFocusAvailable = state.focus?.isConnected && !state.focus.disabled && !state.focus.closest('[hidden]') && (!openDialog || state.focus.closest('dialog[open]'));
  const focusTarget = previousFocusAvailable ? state.focus : openDialog?.querySelector('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)');
  focusTarget?.focus({ preventScroll: true });
}
export async function copyText(value) {
  const text = String(value || '');
  if (!text) throw new Error('没有可复制的内容。');
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const focused = document.activeElement, selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const inputSelection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  const input = element('textarea', undefined, 'clipboard-fallback'); input.value = text; input.readOnly = true; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
  try {
    ($('dialog[open]') || document.body).append(input); input.select();
    if (document.execCommand?.('copy') !== true) throw new Error('复制未完成，请手动选择并复制。');
  } finally {
    input.remove(); focused?.focus({ preventScroll: true });
    if (inputSelection) focused.setSelectionRange(...inputSelection);
    if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
  }
}
export function copyButton(value, label = '复制') {
  let copying = false, resetTimer;
  const button = element('button', label, 'copy-button'); button.type = 'button'; button.setAttribute('aria-label', `${label} ${value}`); button.setAttribute('aria-live', 'polite'); button.onclick = async () => {
    if (copying || pendingState) return;
    copying = true; clearTimeout(resetTimer); button.setAttribute('aria-busy', 'true');
    try { await copyText(value); button.textContent = '已复制'; resetTimer = setTimeout(() => { button.textContent = label; }, 1200); } catch { button.textContent = '请手动复制'; }
    finally { copying = false; button.removeAttribute('aria-busy'); }
  }; return button;
}
const messages = { LOGIN_REQUIRED: '请登录后继续。', INVALID_LOGIN: '用户名或密码不正确。', INVALID_MAIL_TOKEN: 'Token 无效或已被撤销。', MAIL_ACCESS_REVOKED: '授权已撤销或重置，请联系分发人。', ACCOUNT_IDENTITY_MISMATCH: 'Cookie 的 iCloud 身份与绑定账号不一致，原数据未覆盖。', ACCOUNT_NOT_BOUND: '请先在对应 Chrome 中同步 Cookie，完成身份绑定。', ACCOUNT_PAUSED: '账号已暂停，请联系管理员。', ACCOUNT_NOT_READY: '账号尚未绑定或已暂停。', ALREADY_DISTRIBUTED_RESET_EXISTING: '该邮箱已有分发记录，请管理原授权，不重复分发。', MAILBOX_NOT_CONFIGURED: '请先配置此账号的转发收件邮箱。', MAILBOX_UNAVAILABLE: '转发收件暂时不可用，请检查认证与网络。', RATE_LIMITED: '操作较频繁，请稍后再试。', APPLE_LOGIN_REQUIRED: 'iCloud 登录已失效，请在对应 Chrome 重新登录。', APPLE_VERIFICATION_UNAVAILABLE: 'iCloud 身份验证暂时失败，原 Cookie 保持不变。', PASSWORD_LENGTH_14_256: '密码长度需为 14–256 位。' };
Object.assign(messages, {
  NEW_IMAP_PASSWORD_REQUIRED: '更换转发主机、邮箱或端口时，请填写对应的新应用授权码。',
  APPLE_HME_SERVICE_UNAVAILABLE: 'Apple 尚未返回此账号的隐藏邮箱服务地址，请重新同步 Cookie 并检查 iCloud+ 服务。',
  GENERATION_RESULT_UNCERTAIN: '生成结果待核对，已暂停重复尝试；请先同步库存后再恢复。',
  INCOMPLETE_COOKIES: '当前 Chrome 的 iCloud 登录信息不完整，请重新登录后同步。',
  INVALID_KEY: '密钥无效或已撤销，请检查所绑定的账号。',
  MAIL_ACCESS_EXPIRED: '分享已到期，请联系分享人调整有效期后，重新打开原链接。',
  INVALID_DURATION_DAYS: '分享天数需为 1–3650 的整数，或选择永久有效。'
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
