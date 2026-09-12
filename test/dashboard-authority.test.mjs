import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DASHBOARD_STORAGE_KEYS,
  MESSAGE_CACHE_TTL_MS,
  createDashboardState,
  readLegacyInventory
} from "../assets/dashboard-state.js";
import {
  createDashboardApi,
  createIcloudAddress,
  createIcloudBatch,
  normalizeGeneratedAddresses,
  persistGeneratedAddresses
} from "../assets/dashboard-api.js";

const dashboardPath = new URL("../mail-code-dashboard.html", import.meta.url);
const assetNames = [
  "dashboard-state.js",
  "dashboard-api.js",
  "dashboard-mail.js",
  "dashboard-ui.js"
];

async function dashboardSource() {
  return readFile(dashboardPath, "utf8");
}

function legacyResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function generationHarness(overrides = {}) {
  const notifications = [];
  const persisted = [];
  const state = {
    accounts: [],
    claims: [],
    labelNumbers: new Map(),
    generatingIcloud: false,
    autoStock: {
      enabled: true,
      pausedReason: "",
      lastError: "",
      failureCount: 0,
      nextAttemptAt: ""
    },
    ...overrides.state
  };
  return {
    context: {
      state,
      generateButton: {},
      autoGenerateIntervalMs: 60 * 60 * 1000,
      autoRetryIntervalMs: 5 * 60 * 1000,
      async apiFetch() {
        return legacyResponse({
          email: "generated@icloud.com",
          label: "hme-003"
        });
      },
      async withBusy(_button, worker) {
        return worker();
      },
      async persistGeneratedAddresses(_context, addresses) {
        persisted.push(addresses);
        state.accounts = [
          {
            id: "server-generated-1",
            email: addresses[0].email,
            label: addresses[0].label,
            group: "unused"
          }
        ];
        state.claims = [{ claimId: "server-claim" }];
      },
      saveAutoStockState() {},
      updateAutoStatus() {},
      notify(...args) {
        notifications.push(args);
      },
      isCookieOrLimitError() {
        return false;
      },
      console: { warn() {} },
      ...overrides.context
    },
    notifications,
    persisted,
    state
  };
}

test("dashboard HTML loads external CSS and one module entry in dependency order", async () => {
  const source = await dashboardSource();
  const stylesheets = [
    ...source.matchAll(
      /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi
    )
  ].map(match => match[1]);
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

  assert.deepEqual(stylesheets, [
    "/assets/design-system.css",
    "/assets/dashboard.css"
  ]);
  assert.doesNotMatch(source, /<style\b/i);
  assert.equal(scripts.length, 2);
  assert.match(scripts[0][0], /src="\/assets\/design-system\.js"/);
  assert.doesNotMatch(scripts[0][0], /\btype="module"/);
  assert.match(
    scripts[1][0],
    /type="module"[^>]*src="\/assets\/dashboard\.js"/
  );
  assert.ok(
    source.indexOf("/assets/design-system.js") <
      source.indexOf("/assets/dashboard.js")
  );
  assert.equal(scripts.every(([, body]) => body.trim() === ""), true);
  assert.doesNotMatch(source, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(source, /\beval\s*\(/);
});

test("dashboard markup and renderer use design-system business-state hooks", async () => {
  const source = await dashboardSource();
  const entry = await readFile(
    new URL("../assets/dashboard.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /<main\b[^>]*class="app-main"/);
  assert.match(
    source,
    /<section\b[^>]*class="panel inventory-panel"/
  );
  assert.match(
    source,
    /<div\b[^>]*class="stat"[^>]*data-tone="brand"[^>]*>[\s\S]*?id="newCodeCount"/
  );
  assert.match(entry, /row\.dataset\.marked\s*=/);
  assert.doesNotMatch(entry, /row\.dataset\.unread\s*=/);
  assert.match(entry, /unused:\s*"info"/);
  assert.match(entry, /finished:\s*"ok"/);
  assert.match(entry, /trash:\s*"neutral"/);
  assert.match(entry, /tag\.dataset\.tone\s*=/);
  assert.match(entry, /element\("div",\s*"cell-actions"\)/);
  assert.doesNotMatch(entry, /element\("div",\s*"row-actions"\)/);
  assert.match(source, /<span>备注<\/span>/);
  assert.match(entry, /element\("div",\s*"cell cell-remark"\)/);
  assert.match(entry, /account\.subject \|\| "尚未收到邮件"/);
  assert.doesNotMatch(entry, /account\.subject \|\| \(account\.remark \?/);
  assert.match(
    entry,
    /status\.dataset\.tone\s*=\s*claim\.status === "released"\s*\?\s*"neutral"\s*:\s*"ok"/
  );
  assert.doesNotMatch(entry, /status\.dataset\.group\s*=/);
});

test("dashboard entry owns the acyclic module graph", async () => {
  const entry = await readFile(
    new URL("../assets/dashboard.js", import.meta.url),
    "utf8"
  );
  for (const name of assetNames) {
    assert.match(entry, new RegExp(`from ["']\\.\\/${name.replace(".", "\\.")}["']`));
    const child = await readFile(
      new URL(`../assets/${name}`, import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(child, /from ["']\.\/dashboard\.js["']/);
    assert.doesNotMatch(child, /\.addEventListener\s*\(|\bsetInterval\s*\(/);
  }
  assert.match(entry, /\.addEventListener\s*\(/);
  assert.match(entry, /\bsetInterval\s*\(/);
});

test("all non-entry modules import without browser globals or side effects", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.window, "undefined");
  for (const name of assetNames) {
    const module = await import(
      `${new URL(`../assets/${name}`, import.meta.url).href}?side-effect=${Date.now()}-${name}`
    );
    assert.ok(Object.keys(module).length > 0, `${name} must expose real work`);
  }
});

test("dashboard state starts with server-only inventory and one frozen legacy snapshot", () => {
  const reads = [];
  const values = new Map([
    [
      DASHBOARD_STORAGE_KEYS.legacyInventory,
      JSON.stringify([{ id: "legacy", group: "unused" }])
    ],
    [DASHBOARD_STORAGE_KEYS.pageSize, "50"]
  ]);
  const storage = {
    getItem(key) {
      reads.push(key);
      return values.get(key) ?? null;
    }
  };

  const dashboard = createDashboardState({ storage });

  assert.deepEqual(dashboard.state.accounts, []);
  assert.equal(dashboard.state.pageSize, 50);
  assert.equal(Object.isFrozen(dashboard.legacyMigrationSnapshot), true);
  assert.equal(Object.isFrozen(dashboard.legacyMigrationSnapshot[0]), true);
  assert.equal(
    reads.filter(key => key === DASHBOARD_STORAGE_KEYS.legacyInventory).length,
    1
  );
});

test("legacy inventory rejects corrupt and non-array values", () => {
  const storage = {
    value: "{broken",
    getItem() {
      return this.value;
    }
  };

  assert.deepEqual(Array.from(readLegacyInventory(storage)), []);
  storage.value = JSON.stringify({ id: "not-an-array" });
  assert.deepEqual(Array.from(readLegacyInventory(storage)), []);
});

test("API key stays in session storage and authenticated requests use it", async () => {
  const requests = [];
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
  const api = createDashboardApi({
    storage,
    async fetchImpl(input, options) {
      requests.push([input, options]);
      return { ok: true };
    }
  });

  api.setApiKey("  secret-key  ");
  await api.apiFetch("/v1/inventory");
  assert.equal(
    values.get(DASHBOARD_STORAGE_KEYS.apiKeySession),
    "secret-key"
  );
  assert.equal(requests[0][1].headers.get("X-API-Key"), "secret-key");
  api.clearApiKey();
  assert.equal(values.has(DASHBOARD_STORAGE_KEYS.apiKeySession), false);
});

test("persistGeneratedAddresses writes one batch and adopts the server mirror", async () => {
  const requests = [];
  const state = {
    accounts: [{ id: "client-stale" }],
    claims: [{ claimId: "claim-stale" }],
    labelNumbers: new Map([["stale", 1]])
  };
  let renders = 0;
  let invalidations = 0;
  const serverData = {
    inventory: [
      {
        id: "server-stable-id",
        email: "generated@icloud.com",
        label: "hme-003",
        group: "unused"
      }
    ],
    claims: [{ claimId: "server-claim" }]
  };
  const context = {
    state,
    async apiFetch(path, options) {
      requests.push([path, options]);
      return { serverData };
    },
    async readApiEnvelope(response) {
      return response.serverData;
    },
    invalidateMessageCache() {
      invalidations += 1;
    },
    render() {
      renders += 1;
    }
  };

  await persistGeneratedAddresses(context, [
    { email: "generated@icloud.com", label: "hme-003" }
  ]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "/v1/inventory");
  assert.equal(requests[0][1].method, "POST");
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    addresses: [{ email: "generated@icloud.com", label: "hme-003" }]
  });
  assert.deepEqual(state.accounts, serverData.inventory);
  assert.deepEqual(state.claims, serverData.claims);
  assert.equal(state.labelNumbers.size, 0);
  assert.equal(invalidations, 1);
  assert.equal(renders, 1);
});

test("inventory POST failure is tagged as an Apple half-success", async () => {
  await assert.rejects(
    () =>
      persistGeneratedAddresses(
        {
          state: { accounts: [], claims: [], labelNumbers: new Map() },
          async apiFetch() {
            throw new Error("state disk unavailable");
          },
          async readApiEnvelope(response) {
            return response;
          },
          invalidateMessageCache() {},
          render() {}
        },
        [{ email: "orphan@icloud.com", label: "hme-004" }]
      ),
    error =>
      error?.code === "INVENTORY_PERSIST_FAILED" &&
      /已在 Apple 生成/.test(error.message) &&
      /同步 iCloud/.test(error.message)
  );
});

test("successful inventory POST is not relabeled when rendering fails", async () => {
  const state = {
    accounts: [],
    claims: [],
    labelNumbers: new Map()
  };
  await assert.rejects(
    () =>
      persistGeneratedAddresses(
        {
          state,
          async apiFetch() {
            return {
              serverData: {
                inventory: [{ id: "server-written" }],
                claims: []
              }
            };
          },
          async readApiEnvelope(response) {
            return response.serverData;
          },
          invalidateMessageCache() {},
          render() {
            throw new Error("render failed after the server write");
          }
        },
        [{ email: "written@icloud.com", label: "hme-007" }]
      ),
    error =>
      error?.code !== "INVENTORY_PERSIST_FAILED" &&
      /render failed after the server write/.test(error?.message)
  );
  assert.equal(state.accounts[0].id, "server-written");
});

test("single generation persists once and keeps the server row", async () => {
  const harness = generationHarness();

  const result = await createIcloudAddress(
    harness.context,
    "hme-003",
    { manual: true }
  );

  assert.equal(result, true);
  assert.deepEqual(harness.persisted, [
    [{ email: "generated@icloud.com", label: "hme-003" }]
  ]);
  assert.equal(harness.state.accounts[0].id, "server-generated-1");
  assert.deepEqual(harness.state.claims, [{ claimId: "server-claim" }]);
});

test("batch generation shares one authoritative persistence call", async () => {
  const harness = generationHarness({
    context: {
      async apiFetch() {
        return legacyResponse({
          generated: [
            { email: "batch-1@icloud.com", label: "hme-004" },
            { email: "batch-2@icloud.com", label: "hme-005" }
          ],
          errors: []
        });
      }
    }
  });

  const result = await createIcloudBatch(
    harness.context,
    ["hme-004", "hme-005"]
  );

  assert.equal(result, true);
  assert.deepEqual(harness.persisted, [
    [
      { email: "batch-1@icloud.com", label: "hme-004" },
      { email: "batch-2@icloud.com", label: "hme-005" }
    ]
  ]);
});

test("partly malformed Apple batch pauses without partial persistence", async () => {
  const harness = generationHarness({
    context: {
      async apiFetch() {
        return legacyResponse({
          generated: [
            { email: "batch-valid@icloud.com", label: "hme-008" },
            null
          ],
          errors: []
        });
      }
    }
  });

  const result = await createIcloudBatch(
    harness.context,
    ["hme-008", "hme-009"]
  );

  assert.equal(result, false);
  assert.deepEqual(harness.persisted, []);
  assert.match(harness.state.autoStock.pausedReason, /同步 iCloud/);
  assert.equal(harness.state.autoStock.nextAttemptAt, "");
  assert.equal(harness.state.autoStock.failureCount, 0);
});

test("batch normalization rejects unsafe, sparse, and non-array results", () => {
  const invalid = [
    [{ email: "missing-domain", label: "hme-010" }],
    [{ email: "valid@icloud.com", label: "<unsafe>" }],
    [
      { email: "batch-1@icloud.com", label: "hme-011" },
      ,
      { email: "batch-3@icloud.com", label: "hme-013" }
    ],
    { email: "unknown@icloud.com", label: "hme-014" }
  ];

  for (const value of invalid) {
    assert.throws(() => normalizeGeneratedAddresses(value), /同步 iCloud/);
  }
});

test("post-persistence UI failure pauses instead of scheduling another Apple request", async () => {
  const notifications = [];
  const requests = [];
  const state = {
    accounts: [],
    claims: [],
    labelNumbers: new Map(),
    generatingIcloud: false,
    autoStock: {
      enabled: true,
      pausedReason: "",
      lastError: "",
      failureCount: 0,
      nextAttemptAt: ""
    }
  };
  const context = {
    state,
    generateButton: {},
    autoGenerateIntervalMs: 60 * 60 * 1000,
    autoRetryIntervalMs: 5 * 60 * 1000,
    async apiFetch(path) {
      requests.push(path);
      if (path === "/api/icloud/generate") {
        return legacyResponse({
          email: "written@icloud.com",
          label: "hme-007"
        });
      }
      return {
        serverData: {
          inventory: [{ id: "server-written" }],
          claims: []
        }
      };
    },
    async readApiEnvelope(response) {
      return response.serverData;
    },
    async withBusy(_button, worker) {
      return worker();
    },
    invalidateMessageCache() {},
    render() {
      throw new Error("render failed after the server write");
    },
    saveAutoStockState() {},
    updateAutoStatus() {},
    notify(...args) {
      notifications.push(args);
    },
    console: { warn() {} }
  };

  const result = await createIcloudAddress(context, "hme-007");

  assert.equal(result, false);
  assert.deepEqual(requests, ["/api/icloud/generate", "/v1/inventory"]);
  assert.equal(state.accounts[0].id, "server-written");
  assert.match(state.autoStock.pausedReason, /已写入库存/);
  assert.equal(state.autoStock.nextAttemptAt, "");
  assert.equal(
    notifications.some(
      ([title, message]) =>
        title === "库存写入失败" || /库存写入失败/.test(message)
    ),
    false
  );
});

test("message cache TTL remains bounded in the state module", () => {
  assert.ok(
    MESSAGE_CACHE_TTL_MS > 0 && MESSAGE_CACHE_TTL_MS <= 5 * 60 * 1000
  );
});
