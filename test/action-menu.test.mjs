import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const shared = (await readFile(new URL('../web/shared.js', import.meta.url), 'utf8')).replaceAll('export ', '');
function ui(t, native = false) {
  const dom = new JSDOM('<!doctype html><body><main><div id="table"></div><button id="outside">外部按钮</button></main><div id="busy-layer" hidden></div></body>', { url: 'https://example.test/admin', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; t.after(() => w.close());
  Object.defineProperty(w, 'innerWidth', { configurable: true, value: 400 }); Object.defineProperty(w, 'innerHeight', { configurable: true, value: 300 });
  const nativeCalls = [], nativeOpen = new WeakSet();
  if (native) {
    const prototype = w.HTMLElement.prototype, matches = prototype.matches;
    const toggle = (panel, state) => queueMicrotask(() => { const event = new w.Event('toggle'); Object.defineProperty(event, 'newState', { value: state }); panel.dispatchEvent(event); });
    prototype.showPopover = function () { assert.equal(this.getAttribute('popover'), 'auto'); nativeCalls.push('show'); nativeOpen.add(this); toggle(this, 'open'); };
    prototype.hidePopover = function () { nativeCalls.push('hide'); nativeOpen.delete(this); toggle(this, 'closed'); };
    prototype.matches = function (selector) { return selector === ':popover-open' ? nativeOpen.has(this) : matches.call(this, selector); };
  }
  vm.runInContext(`${shared}\nglobalThis.popupTools = { actionMenu, bindPopup, closePopups, setPagePending };`, dom.getInternalVMContext());
  const $ = selector => w.document.querySelector(selector);
  const button = (label, action) => { const node = w.document.createElement('button'); node.textContent = label; if (action) node.onclick = action; return node; };
  const key = (node, value, options = {}) => node.dispatchEvent(new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
  function menu(buttons = [button('编辑'), button('撤销')], label = '更多') {
    const wrapper = w.popupTools.actionMenu(label, buttons, '邮箱更多操作'); $('#table').append(wrapper);
    const trigger = wrapper.querySelector('.menu-trigger'), panel = wrapper.querySelector('.action-popover');
    trigger.getBoundingClientRect = () => ({ left: 340, right: 390, top: 240, bottom: 284, width: 50, height: 44 });
    panel.getBoundingClientRect = () => ({ width: 180, height: 120 });
    return { wrapper, trigger, panel, buttons };
  }
  return { w, $, button, key, menu, nativeCalls, ...w.popupTools };
}

for (const native of [false, true]) {
  const mode = native ? 'native popover' : 'portal fallback';

  test(`${mode}: menu has safe labels, ARIA, clamped position and full keyboard navigation`, t => {
    const u = ui(t, native), disabled = u.button('不可用'); disabled.disabled = true;
    const m = u.menu([u.button('编辑'), disabled, u.button('撤销')], '<img src=x>更多');
    assert.equal(m.trigger.textContent, '<img src=x>更多'); assert.equal(m.wrapper.querySelector('img'), null);
    assert.equal(m.panel.hidden, true); assert.equal(m.panel.parentElement, m.wrapper);
    assert.equal(m.trigger.getAttribute('aria-haspopup'), 'menu'); assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(m.trigger.getAttribute('aria-controls'), m.panel.id); assert.equal(m.panel.getAttribute('role'), 'menu');
    m.trigger.click();
    assert.equal(m.panel.hidden, false); assert.equal(m.trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(m.panel.parentElement, native ? m.wrapper : u.w.document.body);
    assert.equal(m.panel.style.left, '210px'); assert.equal(m.panel.style.top, '114px');
    assert.equal(u.w.document.activeElement, m.buttons[0]);
    assert.equal(m.buttons[0].getAttribute('role'), 'menuitem'); assert.equal(m.buttons[0].type, 'button');
    u.key(m.buttons[0], 'ArrowDown'); assert.equal(u.w.document.activeElement, m.buttons[2]);
    u.key(m.buttons[2], 'ArrowDown'); assert.equal(u.w.document.activeElement, m.buttons[0]);
    u.key(m.buttons[0], 'ArrowUp'); assert.equal(u.w.document.activeElement, m.buttons[2]);
    u.key(m.buttons[2], 'Home'); assert.equal(u.w.document.activeElement, m.buttons[0]);
    u.key(m.buttons[0], 'End'); assert.equal(u.w.document.activeElement, m.buttons[2]);
    u.key(m.buttons[2], 'Escape');
    assert.equal(m.panel.hidden, true); assert.equal(m.panel.parentElement, m.wrapper); assert.equal(u.w.document.activeElement, m.trigger);
    u.key(m.trigger, 'ArrowUp'); assert.equal(u.w.document.activeElement, m.buttons[2]);
    u.key(m.buttons[2], 'Tab'); assert.equal(m.panel.hidden, true); assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  });

  test(`${mode}: action restores trigger before its prewired handler opens a dialog`, t => {
    const u = ui(t, native); let focusedAtAction;
    const dialog = u.w.document.createElement('dialog'), input = u.w.document.createElement('input'); dialog.append(input); u.w.document.body.append(dialog);
    const action = u.button('配置', () => { focusedAtAction = u.w.document.activeElement; dialog.open = true; input.focus(); });
    const m = u.menu([action]); m.trigger.click(); action.click();
    assert.equal(focusedAtAction, m.trigger); assert.equal(m.panel.hidden, true); assert.equal(u.w.document.activeElement, input);
    u.closePopups(); assert.equal(u.w.document.activeElement, input);
    m.trigger.click(); assert.equal(m.panel.hidden, true, 'a background trigger must not open across a modal');
  });

  test(`${mode}: settings preserve native checkbox/select interaction and close on outside focus`, t => {
    const u = ui(t, native), trigger = u.button('刷新设置'), panel = u.w.document.createElement('div');
    const checkbox = u.w.document.createElement('input'), select = u.w.document.createElement('select'); checkbox.type = 'checkbox';
    select.append(new u.w.Option('30秒', '30'), new u.w.Option('1分钟', '60')); panel.append(checkbox, select); panel.className = 'settings-popover';
    u.$('#table').append(trigger, panel); const popup = u.bindPopup(trigger, panel);
    assert.equal(u.bindPopup(trigger, panel), popup, 'binding a static settings panel twice is harmless');
    trigger.click(); assert.equal(u.w.document.activeElement, checkbox); assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    checkbox.click(); select.value = '60'; select.dispatchEvent(new u.w.Event('change', { bubbles: true })); select.click();
    assert.equal(checkbox.checked, true); assert.equal(select.value, '60'); assert.equal(panel.hidden, false);
    const arrow = new u.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }); select.dispatchEvent(arrow); assert.equal(arrow.defaultPrevented, false);
    u.$('#outside').focus(); assert.equal(panel.hidden, true); assert.equal(u.w.document.activeElement, u.$('#outside'));
    popup.open(); u.key(checkbox, 'Escape'); assert.equal(panel.hidden, true); assert.equal(u.w.document.activeElement, trigger);
  });

  test(`${mode}: pending closes popovers before locking and repeated render cleanup leaves no orphan panels`, t => {
    const u = ui(t, native), m = u.menu(); m.trigger.click();
    u.setPagePending(true);
    assert.equal(m.panel.hidden, true); assert.equal(m.panel.parentElement, m.wrapper); assert.equal(m.trigger.disabled, true);
    u.bindPopup(m.trigger, m.panel).open(); assert.equal(m.panel.hidden, true);
    u.setPagePending(false); assert.equal(m.trigger.disabled, false); assert.equal(u.w.document.activeElement, m.trigger);
    m.trigger.click(); const second = u.menu(); second.trigger.click(); assert.equal(m.panel.hidden, true); assert.equal(second.panel.hidden, false);
    second.wrapper.remove(); u.closePopups(); assert.equal(second.panel.isConnected, false);
    m.wrapper.remove();
    for (let i = 0; i < 20; i++) { const row = u.menu(); row.trigger.click(); row.wrapper.remove(); u.closePopups(); }
    assert.equal(u.w.document.querySelectorAll('.action-popover').length, 0);
    u.closePopups();
  });

  test(`${mode}: resize repositions, panel scroll remains usable, ancestor scroll dismisses`, t => {
    const u = ui(t, native), m = u.menu(); m.trigger.click();
    Object.defineProperty(u.w, 'innerWidth', { value: 200, configurable: true }); Object.defineProperty(u.w, 'innerHeight', { value: 180, configurable: true });
    u.w.dispatchEvent(new u.w.Event('resize'));
    assert.equal(m.panel.style.left, '12px'); assert.equal(m.panel.style.top, '52px');
    m.panel.dispatchEvent(new u.w.Event('scroll')); assert.equal(m.panel.hidden, false);
    u.w.dispatchEvent(new u.w.Event('scroll')); assert.equal(m.panel.hidden, true);
  });

  test(`${mode}: popup works within a native modal and outside click dismisses without stealing focus`, t => {
    const u = ui(t, native), dialog = u.w.document.createElement('dialog'); dialog.open = true; u.w.document.body.append(dialog);
    const m = u.menu(); dialog.append(m.wrapper); m.trigger.click();
    assert.equal(m.panel.parentElement, native ? m.wrapper : dialog);
    assert.equal(m.panel.hidden, false);
    const outside = u.button('外部'); dialog.append(outside); outside.focus(); outside.click();
    assert.equal(m.panel.hidden, true); assert.equal(m.panel.parentElement, m.wrapper); assert.equal(u.w.document.activeElement, outside);
  });
}

test('native popover light-dismiss synchronizes ARIA; stale toggle events do not hide a reopened menu', async t => {
  const u = ui(t, true), m = u.menu(); m.trigger.click(); await Promise.resolve();
  m.panel.hidePopover(); await Promise.resolve();
  assert.equal(m.panel.hidden, true); assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(u.nativeCalls.filter(call => call === 'hide').length, 1);
  m.trigger.click(); m.trigger.click(); m.trigger.click(); await Promise.resolve();
  assert.equal(m.panel.hidden, false); assert.equal(m.trigger.getAttribute('aria-expanded'), 'true');
});

test('a failed native showPopover falls back to a body portal without losing the action', t => {
  const u = ui(t, true), m = u.menu(); m.panel.showPopover = () => { throw new Error('Popover unavailable'); };
  m.trigger.click(); assert.equal(m.panel.hidden, false); assert.equal(m.panel.parentElement, u.w.document.body);
  assert.equal(m.panel.hasAttribute('popover'), false); u.closePopups(); assert.equal(m.panel.parentElement, m.wrapper);
});
