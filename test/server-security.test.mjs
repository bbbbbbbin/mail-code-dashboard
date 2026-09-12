import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DashboardStore } from "../lib/dashboard-store.mjs";
import { createV1Router } from "../lib/v1-router.mjs";
import {
  createDashboardServer,
  startDashboardServer
} from "../server.mjs";

const API_KEY = "synthetic-server-security-key";

function fakeLegacyHandlers(overrides = {}) {
  return {
    async checkForwardedHiddenMail(accounts) {
      return { updates: [], errors: [], checked: [], received: accounts.length };
    },
    async generateHideMyEmail(label) {
      return { label };
    },
    async generateHideMyEmailBatch(labels) {
      return { labels };
    },
    async acceptEdgeCookieBridge() {
      return { ok: true };
    },
    async getICloudLoginStatus() {
      return { authenticated: true };
    },
    async listHideMyEmailAccounts() {
      return [];
    },
    ...overrides
  };
}

async function makeSecurityServer(t, options = {}) {
  const logs = [];
  const server = createDashboardServer({
    apiKey: API_KEY,
    v1Router: options.v1Router || (async () => false),
    legacyHandlers: fakeLegacyHandlers(options.legacyHandlers),
    logger(message) {
      logs.push(message);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise(resolve => {
        server.close(resolve);
      })
  );
  const address = server.address();
  return {
    logs,
    url: `http://127.0.0.1:${address.port}`
  };
}

test("startDashboardServer passes 127.0.0.1 to listen by default", () => {
  const calls = [];
  const fakeServer = {
    listen(...args) {
      calls.push(args);
    }
  };

  startDashboardServer(fakeServer, { env: {}, port: 4173 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 4173);
  assert.equal(calls[0][1], "127.0.0.1");
});

test("startDashboardServer fails closed for a non-loopback HOST", () => {
  const fakeServer = {
    listen() {
      assert.fail("listen must not be called");
    }
  };

  assert.throws(
    () =>
      startDashboardServer(fakeServer, {
        env: { HOST: "0.0.0.0" },
        port: 4173
      }),
    /127\.0\.0\.1/
  );
});

test("legacy APIs reject missing keys and accept the configured key", async t => {
  const app = await makeSecurityServer(t);
  const routes = [
    ["GET", "/api/icloud/list", undefined],
    ["GET", "/api/icloud/status", undefined],
    ["POST", "/api/forward/check", JSON.stringify({ accounts: [] })],
    // Edge 扩展也走这条路由，缺 key 必须 401，不能因为“本机插件”而放行。
    ["POST", "/api/edge-cookie-bridge", JSON.stringify({ cookies: [] })]
  ];

  for (const [method, path, body] of routes) {
    const missing = await fetch(`${app.url}${path}`, { method, body });
    assert.equal(missing.status, 401, `${method} ${path} missing key`);

    const accepted = await fetch(`${app.url}${path}`, {
      method,
      body,
      headers: {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json"
      }
    });
    assert.equal(accepted.status, 200, `${method} ${path} accepted key`);
    assert.match(
      accepted.headers.get("cache-control") || "",
      /no-store/
    );
  }
});

test("the Outlook routes stay gone, even for a request holding the key", async t => {
  const app = await makeSecurityServer(t);
  const headers = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
  // 这三条路由随 Graph/OAuth 通道一起删除；mail-all / mail-body 还曾把
  // refresh_token 放在查询串里，重新加回来就会再次把凭据写进访问日志。
  const query = "email=synthetic%40example.com&client_id=synthetic&refresh_token=synthetic";

  const mailAll = await fetch(`${app.url}/api/mail-all?${query}`, { headers });
  const mailBody = await fetch(`${app.url}/api/mail-body?${query}&uid=1`, {
    headers
  });
  const mailCheck = await fetch(`${app.url}/api/mail/check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ accounts: [] })
  });

  assert.equal(mailAll.status, 404);
  assert.equal(mailBody.status, 404);
  assert.equal(mailCheck.status, 405);
});

test("approved static pages and favicon remain public", async t => {
  const app = await makeSecurityServer(t);

  const root = await fetch(`${app.url}/`);
  const named = await fetch(`${app.url}/mail-code-dashboard.html`);
  const favicon = await fetch(`${app.url}/favicon.ico`);

  assert.equal(root.status, 200);
  assert.match(await root.text(), /<!doctype html>/i);
  assert.equal(named.status, 200);
  assert.equal(favicon.status, 204);
  assert.match(root.headers.get("cache-control") || "", /no-store/);
});

test("design system assets are public and correctly typed", async t => {
  const app = await makeSecurityServer(t);

  const page = await fetch(`${app.url}/design-system.html`);
  const css = await fetch(`${app.url}/assets/design-system.css`);
  const js = await fetch(`${app.url}/assets/design-system.js`);

  assert.equal(page.status, 200);
  assert.equal(css.status, 200);
  assert.equal(js.status, 200);
  assert.match(css.headers.get("content-type") || "", /text\/css/);
  assert.match(js.headers.get("content-type") || "", /text\/javascript/);
  assert.match(await css.text(), /--brand:/);
  assert.match(await js.text(), /global\.DS = \{/);
});

test("dashboard stylesheet is public, correctly typed, and narrowly allowlisted", async t => {
  const app = await makeSecurityServer(t);

  const css = await fetch(`${app.url}/assets/dashboard.css`);
  const lookalike = await fetch(`${app.url}/assets/dashboard.css.bak`);

  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") || "", /text\/css/);
  assert.match(await css.text(), /\.inventory-panel\s*\{/);
  assert.equal(lookalike.status, 404);
});

test("dashboard module graph is public and served as JavaScript", async t => {
  const app = await makeSecurityServer(t);
  const names = [
    "dashboard-state.js",
    "dashboard-api.js",
    "dashboard-mail.js",
    "dashboard-ui.js",
    "dashboard.js"
  ];

  for (const name of names) {
    const response = await fetch(`${app.url}/assets/${name}`);
    assert.equal(response.status, 200, name);
    assert.match(
      response.headers.get("content-type") || "",
      /(?:text|application)\/javascript/,
      name
    );
    assert.match(await response.text(), /\b(?:export|import)\b/, name);
  }
});

test("traversal and arbitrary local files return 404", async t => {
  const app = await makeSecurityServer(t);
  const paths = [
    "/server.mjs",
    "/package.json",
    "/../server.mjs",
    "/%2e%2e%2fserver.mjs",
    "/scripts/start_dashboard.ps1",
    "/assets/../server.mjs",
    "/assets/design-system.css/../../server.mjs",
    "/removed-page.html/../server.mjs",
    "/runtime/removed-page-state-v1.json",
    "/removed-page.htm"
  ];

  for (const path of paths) {
    const response = await fetch(`${app.url}${path}`);
    assert.equal(response.status, 404, path);
  }
});

test("POST /v1/inventory refuses to create anything without the API key", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-security-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DashboardStore({
    statePath: join(directory, "dashboard-state-v1.json"),
    backupDir: join(directory, "backups")
  });
  const app = await makeSecurityServer(t, {
    v1Router: createV1Router({ apiKey: API_KEY, store })
  });
  const body = JSON.stringify({
    addresses: [{ email: "synthetic.alias@icloud.com", label: "hme-001" }]
  });

  const missing = await fetch(`${app.url}/v1/inventory`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" }
  });
  const wrong = await fetch(`${app.url}/v1/inventory`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "wrong-secret"
    }
  });
  // An unauthenticated create must fail before the state file is touched.
  const rejectedInventory = await store.listInventory();

  const accepted = await fetch(`${app.url}/v1/inventory`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY
    }
  });

  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "UNAUTHORIZED");
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "UNAUTHORIZED");
  assert.deepEqual(rejectedInventory, []);
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get("cache-control") || "", /no-store/);
  assert.equal(
    (await store.listInventory()).map(item => item.email).join(),
    "synthetic.alias@icloud.com"
  );
});

test("legacy error responses and logs redact the supplied API key", async t => {
  const app = await makeSecurityServer(t, {
    legacyHandlers: {
      async getICloudLoginStatus() {
        throw new Error(`synthetic failure containing ${API_KEY}`);
      }
    }
  });

  const response = await fetch(`${app.url}/api/icloud/status`, {
    headers: { "X-API-Key": API_KEY }
  });
  const body = await response.text();

  assert.equal(response.status, 500);
  assert.equal(body.includes(API_KEY), false);
  assert.equal(app.logs.join("\n").includes(API_KEY), false);
});
