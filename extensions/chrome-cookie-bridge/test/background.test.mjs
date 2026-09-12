// background.js 是 MV3 的 classic service worker，没法 import。这里用 node:vm 把它跑在一个
// 装了假 chrome / 假 fetch / 假计时器的上下文里，这样防抖、白名单、端口配置都能当纯逻辑来断言，
// 不用真的装扩展。
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKGROUND_SOURCE = readFileSync(join(ROOT, "background.js"), "utf8");
const POPUP_SOURCE = readFileSync(join(ROOT, "popup.js"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const SESSION_COOKIE = { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session" };
const WEBAUTH_COOKIE = { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" };
const PCS_MAIL_COOKIE = { name: "X-APPLE-WEBAUTH-PCS-Mail", value: "pcs" };

function createClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn) {
      const id = nextId;
      nextId += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    fireAll() {
      const due = Array.from(timers.values());
      timers.clear();
      for (const fn of due) fn();
      return due.length;
    }
  };
}

// 所有假异步都立刻 resolve，多转几圈宏任务就能把 promise 链跑干净。
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function loadBackground({
  cookies = [],
  storage = {},
  response = { ok: true, status: 200, text: '{"ok":true}' },
  fetchError = null
} = {}) {
  const state = {
    cookies: cookies.map(cookie => ({ ...cookie })),
    storage: { ...storage },
    fetches: [],
    gate: null,
    response,
    fetchError
  };
  const listeners = {};
  const clock = createClock();

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) {
            if (Object.hasOwn(state.storage, key)) out[key] = state.storage[key];
          }
          return out;
        },
        async set(values) {
          Object.assign(state.storage, values);
        }
      }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {},
      onClicked: { addListener(fn) { listeners.clicked = fn; } }
    },
    alarms: {
      create() {},
      onAlarm: { addListener(fn) { listeners.alarm = fn; } }
    },
    runtime: {
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } },
      onMessage: { addListener(fn) { listeners.message = fn; } }
    },
    cookies: {
      async getAll() {
        return state.cookies.map(cookie => ({ ...cookie }));
      },
      onChanged: { addListener(fn) { listeners.cookieChanged = fn; } }
    }
  };

  async function fetchImpl(url, init) {
    state.fetches.push({ url, init });
    if (state.gate) await state.gate;
    if (state.fetchError) throw state.fetchError;
    return {
      ok: state.response.ok,
      status: state.response.status,
      async text() { return state.response.text; }
    };
  }

  const context = vm.createContext({
    chrome,
    fetch: fetchImpl,
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  vm.runInContext(BACKGROUND_SOURCE, context, { filename: "background.js" });

  return {
    state,
    clock,
    listeners,
    read: expression => vm.runInContext(expression, context),
    changeCookie(name, domain = ".icloud.com") {
      listeners.cookieChanged({ cookie: { name, domain, value: "x" } });
    }
  };
}

function loadPopup({ storage = {} } = {}) {
  const state = { storage: { ...storage } };
  const elements = new Map();
  const ids = ["status", "syncBtn", "bridgePort", "apiKey", "keyHint", "saveBtn"];
  for (const id of ids) {
    elements.set(id, {
      value: "",
      textContent: "",
      listeners: {},
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
    });
  }
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            wanted.filter(key => Object.hasOwn(state.storage, key))
              .map(key => [key, state.storage[key]])
          );
        },
        async set(values) {
          Object.assign(state.storage, values);
        }
      }
    },
    runtime: {
      async sendMessage() {
        return { ok: true };
      }
    }
  };
  const context = vm.createContext({
    chrome,
    document: { getElementById: id => elements.get(id) },
    setTimeout: callback => {
      callback();
      return 1;
    }
  });
  vm.runInContext(POPUP_SOURCE, context, { filename: "popup.js" });
  return {
    state,
    elements,
    read: expression => vm.runInContext(expression, context)
  };
}

function lastBody(state) {
  return JSON.parse(state.fetches[state.fetches.length - 1].init.body);
}

test("cookie 白名单只放行链路上真的会用到的名字", () => {
  const { read } = loadBackground();
  const shouldSyncCookie = read("shouldSyncCookie");

  for (const name of read("SYNCED_COOKIE_NAMES")) {
    assert.equal(shouldSyncCookie(name), true, `${name} 应该在白名单里`);
    assert.equal(shouldSyncCookie(name.toLowerCase()), true, `${name} 的小写形式也应该放行`);
  }
  // server.mjs / cookie-freshness.mjs 硬性依赖的三个必须在。
  for (const name of ["X-APPLE-DS-WEB-SESSION-TOKEN", "X-APPLE-WEBAUTH-TOKEN", "X-APPLE-WEBAUTH-PCS-Mail"]) {
    assert.equal(shouldSyncCookie(name), true);
  }

  // 下面这些在旧的 `startsWith("X-APPLE") || includes("APPLE")` 下全都会被收走。
  for (const name of ["X-APPLE-WEBAUTH-PCS-Photos", "APPLE_MARKETING_ID", "s_apple_vi", "dslang-apple"]) {
    assert.equal(shouldSyncCookie(name), false, `${name} 不该被同步`);
  }
  assert.equal(shouldSyncCookie(""), false);
  assert.equal(shouldSyncCookie(undefined), false);
});

test("collectAppleCookies 丢掉白名单外的 cookie", async () => {
  const { read } = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE, { name: "X-APPLE-WEBAUTH-PCS-Photos", value: "photos" }, { name: "APPLE_TRACKING", value: "junk" }]
  });
  // Array.from 把 vm realm 的数组搬回宿主 realm，否则 deepEqual 会因为 prototype 不同而失败。
  const collected = await read("collectAppleCookies()");
  assert.deepEqual(Array.from(collected, cookie => cookie.name).sort(), [
    "X-APPLE-DS-WEB-SESSION-TOKEN",
    "X-APPLE-WEBAUTH-TOKEN"
  ]);
});

test("collectAppleCookies 规范化大小写并按规范名称去重", async () => {
  const { read } = loadBackground({
    cookies: [
      { name: "x-apple-ds-web-session-token", value: "old-session" },
      { name: "X-Apple-DS-Web-Session-Token", value: "new-session" },
      { name: "x-apple-webauth-token", value: "webauth" }
    ]
  });

  const collected = Array.from(await read("collectAppleCookies()"), cookie => ({
    name: cookie.name,
    value: cookie.value
  }));
  assert.deepEqual(collected, [
    { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "new-session" },
    { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" }
  ]);
});

test("一串 cookie 变更只触发一次同步，且最后一次变更一定被带上", async () => {
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key" }
  });

  for (let i = 0; i < 30; i += 1) harness.changeCookie("X-APPLE-WEBAUTH-TOKEN");
  assert.equal(harness.state.fetches.length, 0, "防抖窗口里不该发请求");
  assert.equal(harness.clock.pending, 1, "30 次变更只应留下一个待跑的计时器");

  // 窗口内最后一次变更引入了一个新 cookie，它必须出现在最终那一次 POST 里。
  harness.state.cookies.push({ ...PCS_MAIL_COOKIE });
  harness.changeCookie("X-APPLE-WEBAUTH-PCS-Mail");

  harness.clock.fireAll();
  await flush();

  assert.equal(harness.state.fetches.length, 1);
  const names = lastBody(harness.state).cookies.map(cookie => cookie.name);
  assert.ok(names.includes("X-APPLE-WEBAUTH-PCS-Mail"), "最后一次变更的 cookie 必须被同步");
});

test("白名单外的 cookie 变更不会安排同步", async () => {
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key" }
  });
  harness.changeCookie("APPLE_MARKETING_ID");
  harness.changeCookie("X-APPLE-WEBAUTH-PCS-Photos");
  assert.equal(harness.clock.pending, 0, "不该排上计时器");
  harness.clock.fireAll();
  await flush();
  assert.equal(harness.state.fetches.length, 0, "埋点 cookie 变动不该惊动本地服务");
});

test("非 Apple 域名的同名 cookie 不会安排同步", async () => {
  const harness = loadBackground({ storage: { bridgeApiKey: "test-key" } });
  harness.changeCookie("X-APPLE-WEBAUTH-TOKEN", "evil.example.com");
  assert.equal(harness.clock.pending, 0);
});

test("同步串行化：在飞的时候不会并发再发一次，但窗口后的变更不会被丢掉", async () => {
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key" }
  });
  let release;
  harness.state.gate = new Promise(resolve => { release = resolve; });

  harness.changeCookie("X-APPLE-WEBAUTH-TOKEN");
  harness.clock.fireAll();
  await flush();
  assert.equal(harness.state.fetches.length, 1, "第一次同步应该已经发出并卡在 gate 上");

  harness.changeCookie("X-APPLE-DS-WEB-SESSION-TOKEN");
  harness.clock.fireAll();
  await flush();
  assert.equal(harness.state.fetches.length, 1, "前一次还没结束时不该并发发第二个 POST");

  harness.state.gate = null;
  release();
  await flush();
  assert.equal(harness.state.fetches.length, 2, "在飞期间发生的变更必须补一次同步");
});

test("端口从 chrome.storage.local 读，默认仍是 4173", async () => {
  const withDefault = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key" }
  });
  await withDefault.read("syncCookies()");
  assert.equal(withDefault.state.fetches[0].url, "http://127.0.0.1:4173/api/edge-cookie-bridge");

  const withCustom = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key", bridgePort: 5173 }
  });
  await withCustom.read("syncCookies()");
  assert.equal(withCustom.state.fetches[0].url, "http://127.0.0.1:5173/api/edge-cookie-bridge");

  // 弹窗里存的是字符串也要认。
  const withString = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key", bridgePort: "8080" }
  });
  await withString.read("syncCookies()");
  assert.equal(withString.state.fetches[0].url, "http://127.0.0.1:8080/api/edge-cookie-bridge");
});

test("端口非法时退回默认值而不是拼出坏 URL", () => {
  const { read } = loadBackground();
  const buildBridgeUrl = read("buildBridgeUrl");
  for (const bad of [undefined, null, "", "  ", "abc", 0, -1, 70000, 65536, {}]) {
    assert.equal(buildBridgeUrl(bad), "http://127.0.0.1:4173/api/edge-cookie-bridge", `端口 ${JSON.stringify(bad)} 应退回默认值`);
  }
  assert.equal(buildBridgeUrl(65535), "http://127.0.0.1:65535/api/edge-cookie-bridge");
});

test("端口必须是完整的十进制整数，background 和 popup 规则一致", () => {
  const backgroundPort = loadBackground().read("normalizeBridgePort");
  const popupPort = loadPopup().read("normalizeBridgePort");
  for (const bad of ["8080junk", "1e3", "12.5", "+8080", "-1", "0x20"]) {
    assert.equal(backgroundPort(bad), 4173, `background 不应接受 ${bad}`);
    assert.equal(popupPort(bad), 4173, `popup 不应接受 ${bad}`);
  }
  for (const good of [1, "1", " 8080 ", 65535, "65535"]) {
    assert.equal(backgroundPort(good), Number(String(good).trim()));
    assert.equal(popupPort(good), Number(String(good).trim()));
  }
});

// 这是"不要破坏"的护栏：服务端和 mail-code-dashboard/test/server-security.test.mjs 依赖这个形状。
test("请求形状不变：POST + X-API-Key + {cookies:[{name,value}]}", async () => {
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE, PCS_MAIL_COOKIE],
    storage: { bridgeApiKey: "secret-key" }
  });
  const status = await harness.read("syncCookies()");

  assert.equal(harness.state.fetches.length, 1);
  const { url, init } = harness.state.fetches[0];
  assert.equal(url, "http://127.0.0.1:4173/api/edge-cookie-bridge");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["X-API-Key"], "secret-key");
  assert.deepEqual(JSON.parse(init.body), {
    cookies: [
      { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session" },
      { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" },
      { name: "X-APPLE-WEBAUTH-PCS-Mail", value: "pcs" }
    ]
  });
  assert.equal(status.ok, true);
  assert.equal(status.count, 3);
});

test("没有 API key 就不发请求", async () => {
  const harness = loadBackground({ cookies: [SESSION_COOKIE, WEBAUTH_COOKIE] });
  const status = await harness.read("syncCookies()");
  assert.equal(harness.state.fetches.length, 0);
  assert.equal(status.ok, false);
  assert.match(status.error, /API key/);
});

test("只有空白的 API key 也不会发请求", async () => {
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: " \r\n\t " }
  });
  const status = await harness.read("syncCookies()");
  assert.equal(harness.state.fetches.length, 0);
  assert.equal(status.ok, false);
  assert.match(status.error, /API key/);
});

test("服务端错误正文里的 cookie 不会进入扩展状态", async () => {
  const secret = "X-APPLE-WEBAUTH-TOKEN=must-not-leak";
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key" },
    response: { ok: false, status: 500, text: `failed while handling ${secret}` }
  });

  const status = await harness.read("syncCookies()");

  assert.equal(status.ok, false);
  assert.equal(status.error.includes(secret), false);
  assert.equal(JSON.stringify(harness.state.storage).includes(secret), false);
  assert.match(status.error, /HTTP 500/);
});

test("意外网络错误里的 cookie 赋值会在落状态前脱敏", async () => {
  const secretValue = "must-not-leak";
  const harness = loadBackground({
    cookies: [SESSION_COOKIE, WEBAUTH_COOKIE],
    storage: { bridgeApiKey: "test-key" },
    fetchError: new Error(`network failed for X-APPLE-WEBAUTH-TOKEN=${secretValue}`)
  });

  const status = await harness.read("syncCookies()");

  assert.equal(status.ok, false);
  assert.equal(status.error.includes(secretValue), false);
  assert.match(status.error, /已隐藏/);
});

test("manifest 声明了图标和最低浏览器版本", () => {
  for (const size of ["16", "32", "48", "128"]) {
    assert.equal(MANIFEST.icons?.[size], `icons/icon-${size}.png`);
    assert.equal(MANIFEST.action?.default_icon?.[size], `icons/icon-${size}.png`);
    const stats = statSync(join(ROOT, `icons/icon-${size}.png`));
    assert.ok(stats.size > 0, `icons/icon-${size}.png 不能是空文件`);
    const header = readFileSync(join(ROOT, `icons/icon-${size}.png`)).subarray(0, 8);
    assert.deepEqual(Array.from(header), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "必须是真的 PNG");
  }
  assert.match(String(MANIFEST.minimum_chrome_version), /^\d+$/);
});

test("host_permissions 不再包含整个 apple.com，也不带端口", () => {
  const hosts = MANIFEST.host_permissions;
  assert.ok(!hosts.includes("https://*.apple.com/*"), "整站 apple.com 权限比需要的宽太多");
  assert.ok(hosts.includes("https://account.apple.com/*"), "登录态 cookie 来自 account.apple.com");
  assert.ok(hosts.includes("https://*.icloud.com/*"));
  // match pattern 的 host 部分不允许出现端口，写了 `:4173` 整条会被浏览器判为非法而丢弃；
  // 端口可配之后也必须覆盖所有端口。
  for (const host of hosts) {
    const hostPart = host.split("://")[1]?.split("/")[0] ?? "";
    assert.ok(!hostPart.includes(":"), `${host} 的 host 部分不能带端口`);
  }
  assert.ok(hosts.includes("http://127.0.0.1/*"));
});

test("popup 提供端口输入并和 background 用同一个 storage key", () => {
  const html = readFileSync(join(ROOT, "popup.html"), "utf8");
  const popup = readFileSync(join(ROOT, "popup.js"), "utf8");
  assert.match(html, /id="bridgePort"/);
  assert.match(popup, /BRIDGE_PORT_STORAGE_KEY = "bridgePort"/);
  assert.match(popup, /DEFAULT_BRIDGE_PORT = 4173/);
  assert.match(BACKGROUND_SOURCE, /BRIDGE_PORT_STORAGE_KEY = "bridgePort"/);
});

test("popup 保存时 trim 非空 API key，空白输入不会覆盖旧 key", async () => {
  const harness = loadPopup({ storage: { bridgeApiKey: "old-key", bridgePort: 4173 } });
  await flush();
  harness.elements.get("bridgePort").value = "8080";
  harness.elements.get("apiKey").value = "  new-key  ";
  await harness.elements.get("saveBtn").listeners.click();

  assert.equal(harness.state.storage.bridgePort, 8080);
  assert.equal(harness.state.storage.bridgeApiKey, "new-key");

  harness.elements.get("apiKey").value = " \r\n ";
  await harness.elements.get("saveBtn").listeners.click();
  assert.equal(harness.state.storage.bridgeApiKey, "new-key");
});
