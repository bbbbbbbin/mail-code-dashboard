import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DASHBOARD_STORAGE_KEYS } from "../assets/dashboard-state.js";

/* 设计系统的完整性靠这几条断言守住：
   令牌漂移、深色两份副本不一致、页面绕过令牌写颜色字面量，
   都是只靠人眼评审很难持续拦住的问题。 */

const css = readFileSync(
  new URL("../assets/design-system.css", import.meta.url),
  "utf8"
);
const dashboardHtml = readFileSync(
  new URL("../mail-code-dashboard.html", import.meta.url),
  "utf8"
);
const guideHtml = readFileSync(
  new URL("../design-system.html", import.meta.url),
  "utf8"
);

/* 取出某个选择器后面那一对花括号里的内容。设计系统的令牌块内部没有嵌套。 */
function selectorBlock(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `未找到选择器 ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `${selector} 的花括号不完整`);
  return source.slice(open + 1, close);
}

function tokensOf(block) {
  const tokens = new Map();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return tokens;
}

test("浅色与深色令牌集合完全对应", () => {
  const light = tokensOf(selectorBlock(css, ":root {"));
  const dark = tokensOf(selectorBlock(css, ':root[data-theme="dark"] {'));

  assert.ok(light.size > 40, `浅色令牌只解析出 ${light.size} 个`);
  for (const name of dark.keys()) {
    assert.ok(light.has(name), `深色定义了浅色没有的令牌 ${name}`);
  }
});

test("显式深色与跟随系统深色两份副本一致", () => {
  const explicit = tokensOf(selectorBlock(css, ':root[data-theme="dark"] {'));
  const auto = tokensOf(selectorBlock(css, ':root[data-theme="auto"] {'));

  assert.deepEqual(
    [...auto.entries()].sort(),
    [...explicit.entries()].sort(),
    "两份深色令牌必须逐条相同，改动时要同时改"
  );
});

test("收件台样式只保留页面布局与业务态", () => {
  let pageCss = "";
  try {
    pageCss = readFileSync(
      new URL("../assets/dashboard.css", import.meta.url),
      "utf8"
    );
  } catch {
    assert.fail("必须提供 /assets/dashboard.css");
  }

  assert.doesNotMatch(pageCss, /:root|\[data-theme\b/);
  assert.doesNotMatch(pageCss, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  assert.doesNotMatch(
    pageCss,
    /^\s*\.(?:btn|panel|row|stats)(?=[\s:{.#[])/m,
    "页面 CSS 不得重新定义裸设计系统组件"
  );
  const inventory = selectorBlock(pageCss, ".inventory-panel {");
  for (const variable of [
    "--grid-cols",
    "--grid-cols-md",
    "--grid-cols-sm"
  ]) {
    assert.match(inventory, new RegExp(`${variable}\\s*:`));
  }
  assert.match(pageCss, /\.mail-html-frame\s*\{[\s\S]*color-scheme:\s*only light;/);
  assert.match(pageCss, /\.mail-html-frame\s*\{[\s\S]*background:\s*Canvas;/);
});

test("样式指南只引用设计系统，不自带颜色字面量", () => {
  assert.match(guideHtml, /<link rel="stylesheet" href="\/assets\/design-system\.css" \/>/);
  assert.match(guideHtml, /<script src="\/assets\/design-system\.js"><\/script>/);

  const style = guideHtml.slice(
    guideHtml.indexOf("<style>"),
    guideHtml.indexOf("</style>")
  );
  const literals = style.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || [];
  assert.deepEqual(literals, [], `样式指南里出现颜色字面量：${literals.join(", ")}`);
});

test("运行时导出页面依赖的接口", () => {
  const js = readFileSync(
    new URL("../assets/design-system.js", import.meta.url),
    "utf8"
  );
  const exported = selectorBlock(js, "global.DS =");
  for (const name of [
    "initTheme",
    "applyTheme",
    "cycleTheme",
    "toast",
    "withBusy",
    "openDialog",
    "closeDialog",
    "placeMenu",
    "closeMenus",
    "relativeTime",
    "debounce"
  ]) {
    assert.ok(exported.includes(`${name}:`), `DS 未导出 ${name}`);
  }
});

test("主题偏好与收件台共用同一个存储键", () => {
  assert.match(css, /data-theme="dark"/);
  const designSystemSource = readFileSync(
    new URL("../assets/design-system.js", import.meta.url),
    "utf8"
  );
  assert.ok(
    designSystemSource.includes(
      JSON.stringify(DASHBOARD_STORAGE_KEYS.theme)
    ),
    "设计系统运行时必须复用收件台的主题存储键"
  );
  assert.equal(
    DASHBOARD_STORAGE_KEYS.theme,
    "mail-code-dashboard-theme-v1"
  );
});
