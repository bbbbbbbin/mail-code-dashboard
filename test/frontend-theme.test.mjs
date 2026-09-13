import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const css = await readFile(new URL('../web/site.css', import.meta.url), 'utf8');
const variable = name => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('one light theme defines readable text, controls and primary actions', () => {
  assert.equal((css.match(/:root\s*\{/g) || []).length, 1, 'theme must have one token source, not appended overrides');
  assert.match(css, /color-scheme:\s*light/);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark|color-scheme:\s*dark/);
  assert.ok(luminance(variable('page')) > .9);
  assert.ok(luminance(variable('sidebar')) > .85);
  for (const name of ['ink', 'muted', 'accent', 'danger']) assert.ok(contrast(variable(name), variable('surface')) >= 4.5, `${name} contrast`);
  assert.ok(contrast(variable('control-line'), variable('surface')) >= 3, 'input boundary contrast');
  assert.ok(contrast(variable('accent-hover'), '#ffffff') >= 4.5, 'pressed primary contrast');
  assert.match(css, /button\.primary:active:not\(:disabled\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /transition:\s*all|letter-spacing:\s*-/);
});

for (const page of ['admin', 'inbox']) {
  test(`${page} declares light native controls and labels its refresh switch`, async () => {
    const dom = new JSDOM(await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8'));
    try {
      const d = dom.window.document;
      assert.equal(d.querySelector('meta[name="color-scheme"]').content, 'light');
      assert.equal(d.querySelector('meta[name="theme-color"]').content, variable('page'));
      const labelId = d.querySelector('#auto-refresh').getAttribute('aria-labelledby');
      assert.equal(d.getElementById(labelId).textContent.trim(), '自动刷新');
      assert.ok(d.querySelector('a.skip-link[href="#main-content"]'));
      assert.ok(d.querySelector('#busy-layer[aria-live="polite"]'));
    } finally { dom.window.close(); }
  });
}
