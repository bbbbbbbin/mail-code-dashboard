import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const page of ['admin', 'inbox']) {
  test(`${page} refresh control is opt-in and persisted locally`, async () => {
    const html = await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8');
    const js = await readFile(new URL(`../web/${page}.js`, import.meta.url), 'utf8');
    assert.match(html, /id="auto-refresh"/);
    assert.match(html, /id="refresh-interval"[^>]*disabled/);
    assert.doesNotMatch(html, /id="auto-refresh"[^>]*checked/);
    assert.match(js, /localStorage\.getItem\(REFRESH_KEY\) === 'on'/);
    assert.match(js, /interval\.disabled = !enabled/);
  });
}
