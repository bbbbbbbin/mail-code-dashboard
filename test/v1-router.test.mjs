import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";
import { tmpdir } from "node:os";

import { ClaimService } from "../lib/claim-service.mjs";
import { DashboardStore } from "../lib/dashboard-store.mjs";
import { createV1Router } from "../lib/v1-router.mjs";

const API_KEY = "synthetic-test-secret";

async function makeTestServer(t) {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-router-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let sequence = 0;
  const now = () => new Date("2026-07-25T10:00:00.000Z");
  const store = new DashboardStore({
    statePath: join(directory, "dashboard-state-v1.json"),
    backupDir: join(directory, "backups"),
    now,
    randomUUID: () => `inventory-${++sequence}`
  });
  await store.syncAliases([
    { email: "first.alias@icloud.com", label: "hme-001", isActive: true },
    { email: "second.alias@icloud.com", label: "hme-002", isActive: true }
  ]);
  const claimService = new ClaimService({
    store,
    now,
    randomUUID: () => `claim-${++sequence}`
  });
  const mailboxCalls = [];
  const mailboxReader = {
    async listForAlias(email, options) {
      mailboxCalls.push(["list", email, options]);
      return [
        {
          id: "INBOX:10",
          mailbox: "INBOX",
          uid: 10,
          from: "sender@example.test",
          subject: "Synthetic message",
          receivedAt: "2026-07-25T10:00:00.000Z",
          text: "Synthetic safe text",
          html: "<p>Synthetic safe text</p>",
          codes: ["123456"],
          links: ["https://example.test/verify"],
          primaryLink: "https://example.test/verify"
        }
      ];
    },
    async latestForAlias(email, options) {
      mailboxCalls.push(["latest", email, options]);
      return null;
    }
  };
  const listAliasCalls = [];
  const listAliases = async () => {
    listAliasCalls.push([]);
    return [
      { email: "first.alias@icloud.com", label: "hme-001", isActive: true },
      { email: "second.alias@icloud.com", label: "hme-002", isActive: true },
      { email: "third.alias@icloud.com", label: "hme-003", isActive: true }
    ];
  };
  const inventoryMailCalls = [];
  const inventoryMailService = {
    async checkOne(id) {
      inventoryMailCalls.push(["one", id]);
      return {
        checked: 1,
        updated: 1,
        errors: [],
        inventoryItem: { id, subject: "Synthetic inventory message" },
        message: { subject: "Synthetic inventory message" }
      };
    },
    async checkFinished() {
      inventoryMailCalls.push(["finished"]);
      return {
        checked: 2,
        updated: 1,
        errors: [],
        inventory: await store.listInventory()
      };
    },
    async checkUnused() {
      inventoryMailCalls.push(["unused"]);
      return {
        checked: 2,
        updated: 1,
        moved: 1,
        errors: [],
        inventory: await store.listInventory()
      };
    }
  };
  const route = createV1Router({
    apiKey: API_KEY,
    claimService,
    store,
    mailboxReader,
    listAliases,
    inventoryMailService,
    randomUUID: () => `request-${++sequence}`
  });
  const server = createServer(async (req, res) => {
    if (await route(req, res)) {
      return;
    }
    res.writeHead(404).end("Not Found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise(resolve => {
        server.close(resolve);
      })
  );

  const address = server.address();
  return {
    claimService,
    inventoryMailCalls,
    listAliasCalls,
    mailboxCalls,
    store,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function requestJson(app, path, options = {}) {
  const response = await rawHttpRequest(`${app.url}${path}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

function rawHttpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {}
      },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text)
          });
        });
      }
    );
    request.once("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function authenticatedHeaders(extra = {}) {
  return {
    "X-API-Key": API_KEY,
    ...extra
  };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForResponse(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await rawHttpRequest(url, options);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

test("every v1 route rejects a missing or incorrect API key", async t => {
  const app = await makeTestServer(t);
  const routes = [
    ["GET", "/v1/inventory"],
    ["POST", "/v1/inventory"],
    ["PATCH", "/v1/inventory/inventory-1"],
    ["DELETE", "/v1/inventory/inventory-1"],
    ["POST", "/v1/inventory/inventory-1/messages/latest"],
    ["POST", "/v1/inventory/check-finished-mail"],
    ["POST", "/v1/inventory/check-unused-mail"],
    ["POST", "/v1/inventory/sync-icloud"],
    ["POST", "/v1/migrations/local-storage"],
    ["POST", "/v1/claims"],
    ["GET", "/v1/claims/missing"],
    ["POST", "/v1/claims/missing/release"],
    ["GET", "/v1/claims/missing/messages"],
    ["GET", "/v1/claims/missing/messages/latest"],
  ];

  for (const [method, path] of routes) {
    const missing = await requestJson(app, path, { method });
    const wrong = await requestJson(app, path, {
      method,
      headers: { "X-API-Key": "wrong-secret" }
    });
    assert.equal(missing.status, 401, `${method} ${path} missing key`);
    assert.equal(missing.body.error.code, "UNAUTHORIZED");
    assert.equal(wrong.status, 401, `${method} ${path} wrong key`);
    assert.equal(wrong.body.error.code, "UNAUTHORIZED");
  }
});

test("inventory mail routes delegate to the authoritative mail service", async t => {
  const app = await makeTestServer(t);
  const single = await requestJson(
    app,
    "/v1/inventory/inventory-1/messages/latest",
    {
      method: "POST",
      headers: authenticatedHeaders()
    }
  );
  const batch = await requestJson(
    app,
    "/v1/inventory/check-finished-mail",
    {
      method: "POST",
      headers: authenticatedHeaders()
    }
  );
  const unused = await requestJson(
    app,
    "/v1/inventory/check-unused-mail",
    {
      method: "POST",
      headers: authenticatedHeaders()
    }
  );

  assert.equal(single.status, 200);
  assert.equal(single.body.data.message.subject, "Synthetic inventory message");
  assert.equal(batch.status, 200);
  assert.equal(batch.body.data.checked, 2);
  assert.equal(unused.status, 200);
  assert.equal(unused.body.ok, true);
  assert.equal(unused.body.data.checked, 2);
  assert.equal(unused.body.data.moved, 1);
  assert.equal(unused.body.error, null);
  assert.deepEqual(app.inventoryMailCalls, [
    ["one", "inventory-1"],
    ["finished"],
    ["unused"]
  ]);
});

test("PATCH /v1/inventory/:id persists allowed dashboard fields", async t => {
  const app = await makeTestServer(t);
  const [first] = await app.store.listInventory();

  const result = await requestJson(app, `/v1/inventory/${first.id}`, {
    method: "PATCH",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      group: "finished",
      remark: "persisted from dashboard",
      lastMethod: "Forward IMAP/Junk",
      noCodeReason: "No numeric code"
    })
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.inventoryItem.group, "finished");
  assert.equal(
    result.body.data.inventoryItem.remark,
    "persisted from dashboard"
  );
  assert.equal(
    (await app.store.listInventory()).find(item => item.id === first.id)
      .lastMethod,
    "Forward IMAP/Junk"
  );
});

test("PATCH /v1/inventory/:id rejects an unknown inventory item", async t => {
  const app = await makeTestServer(t);
  const result = await requestJson(app, "/v1/inventory/unknown", {
    method: "PATCH",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ remark: "missing" })
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "INVENTORY_NOT_FOUND");
});

test("DELETE /v1/inventory/:id removes a trashed address and returns fresh counters", async t => {
  const app = await makeTestServer(t);
  const [first] = await app.store.listInventory();
  await app.store.updateInventoryItem(first.id, { group: "trash" });

  const result = await requestJson(app, `/v1/inventory/${first.id}`, {
    method: "DELETE",
    headers: authenticatedHeaders()
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.deleted.id, first.id);
  assert.equal(result.body.data.deleted.email, first.email);
  assert.deepEqual(result.body.data.summary, {
    total: 1,
    unused: 1,
    finished: 0,
    trash: 0
  });
  assert.equal(
    result.body.data.inventory.some(item => item.id === first.id),
    false
  );
  assert.equal(
    (await app.store.listInventory()).some(item => item.id === first.id),
    false
  );
});

test("DELETE /v1/inventory/:id refuses an address that is not in the trash", async t => {
  const app = await makeTestServer(t);
  const [first] = await app.store.listInventory();

  const result = await requestJson(app, `/v1/inventory/${first.id}`, {
    method: "DELETE",
    headers: authenticatedHeaders()
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "INVENTORY_NOT_IN_TRASH");
  assert.equal((await app.store.listInventory()).length, 2);
});

test("DELETE /v1/inventory/:id refuses an address that a claim still holds", async t => {
  const app = await makeTestServer(t);
  const claim = await app.claimService.claimNext({
    idempotencyKey: "delete-guard-key"
  });
  const held = (await app.store.listInventory()).find(
    item => item.email === claim.email
  );

  const result = await requestJson(app, `/v1/inventory/${held.id}`, {
    method: "DELETE",
    headers: authenticatedHeaders()
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "CLAIM_ACTIVE");
  assert.equal((await app.store.listInventory()).length, 2);
});

test("DELETE /v1/inventory/:id rejects an unknown inventory item", async t => {
  const app = await makeTestServer(t);
  const result = await requestJson(app, "/v1/inventory/unknown", {
    method: "DELETE",
    headers: authenticatedHeaders()
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "INVENTORY_NOT_FOUND");
});

test("POST /v1/inventory persists generated addresses and is idempotent by email", async t => {
  const app = await makeTestServer(t);
  const body = JSON.stringify({
    addresses: [
      {
        email: "Generated.One@icloud.com",
        label: "hme-101",
        statusType: "ok",
        statusMessage: "已生成，等待使用"
      },
      { email: "generated.two@icloud.com", label: "hme-102" }
    ]
  });
  const options = {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body
  };

  const created = await requestJson(app, "/v1/inventory", options);
  const retry = await requestJson(app, "/v1/inventory", options);
  const listed = await requestJson(app, "/v1/inventory", {
    headers: authenticatedHeaders()
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.error, null);
  assert.match(created.body.meta.requestId, /^request-/);
  assert.equal(created.body.data.summary.total, 4);
  assert.equal(created.body.data.summary.unused, 4);
  assert.deepEqual(
    created.body.data.created.map(item => item.email),
    ["generated.one@icloud.com", "generated.two@icloud.com"]
  );
  assert.deepEqual(created.body.data.existing, []);
  assert.equal(created.body.data.created[0].group, "unused");
  assert.equal(created.body.data.created[0].label, "hme-101");
  assert.equal(created.body.data.created[0].remark, "hme-101");
  assert.equal(created.body.data.created[0].statusMessage, "已生成，等待使用");
  assert.deepEqual(created.body.data.claims, []);

  // The second POST is the browser retrying the same generation, so it must
  // not add a second row for the same address.
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.data.created, []);
  assert.equal(retry.body.data.existing.length, 2);
  assert.equal(retry.body.data.summary.total, 4);

  assert.equal(
    listed.body.data.inventory.filter(item =>
      item.email.startsWith("generated.")
    ).length,
    2
  );
});

test("POST /v1/inventory refreshes the Apple label but keeps operator fields", async t => {
  const app = await makeTestServer(t);
  const [first] = await app.store.listInventory();
  await app.store.updateInventoryItem(first.id, {
    group: "finished",
    remark: "preserve me"
  });

  const result = await requestJson(app, "/v1/inventory", {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      addresses: [
        {
          email: "FIRST.alias@icloud.com",
          label: "regenerated",
          remark: "regenerated remark",
          appleLabel: "Apple label",
          isActive: true
        }
      ]
    })
  });
  const row = result.body.data.inventory.find(
    item => item.email === "first.alias@icloud.com"
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.data.summary.total, 2);
  assert.deepEqual(result.body.data.created, []);
  assert.equal(result.body.data.existing.length, 1);
  assert.equal(row.id, first.id);
  assert.equal(row.group, "finished");
  assert.equal(row.remark, "preserve me");
  assert.equal(row.label, "Apple label");
  assert.equal(row.appleLabel, "Apple label");
});

test("POST /v1/inventory rejects a malformed body without touching the inventory", async t => {
  const app = await makeTestServer(t);
  const headers = authenticatedHeaders({ "Content-Type": "application/json" });

  const notArray = await requestJson(app, "/v1/inventory", {
    method: "POST",
    headers,
    body: JSON.stringify({ addresses: { email: "single@icloud.com" } })
  });
  const badEmail = await requestJson(app, "/v1/inventory", {
    method: "POST",
    headers,
    body: JSON.stringify({
      addresses: [
        { email: "generated.three@icloud.com", label: "hme-103" },
        { email: "not-an-email" }
      ]
    })
  });
  const malformed = await requestJson(app, "/v1/inventory", {
    method: "POST",
    headers,
    body: "{not-json"
  });

  assert.equal(notArray.status, 400);
  assert.equal(notArray.body.error.code, "BAD_REQUEST");
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.body.error.code, "BAD_REQUEST");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "BAD_REQUEST");
  // The valid row of the rejected batch must not have been persisted alone.
  assert.equal((await app.store.listInventory()).length, 2);
});

test("POST /v1/inventory/sync-icloud persists aliases without overwriting groups", async t => {
  const app = await makeTestServer(t);
  const [first] = await app.store.listInventory();
  await app.store.updateInventoryItem(first.id, {
    group: "finished",
    remark: "preserve me"
  });

  const result = await requestJson(app, "/v1/inventory/sync-icloud", {
    method: "POST",
    headers: authenticatedHeaders()
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.summary.total, 3);
  assert.equal(result.body.data.summary.unused, 2);
  assert.equal(result.body.data.summary.finished, 1);
  assert.equal(app.listAliasCalls.length, 1);
  assert.equal(
    result.body.data.inventory.find(
      item => item.email === "first.alias@icloud.com"
    ).group,
    "finished"
  );
  assert.equal(
    result.body.data.inventory.find(
      item => item.email === "first.alias@icloud.com"
    ).remark,
    "preserve me"
  );
  assert.equal(
    result.body.data.inventory.find(
      item => item.email === "third.alias@icloud.com"
    ).group,
    "unused"
  );
});

test("POST /v1/claims is authenticated and idempotent", async t => {
  const app = await makeTestServer(t);
  const headers = authenticatedHeaders({
    "Idempotency-Key": "registration-1"
  });

  const first = await requestJson(app, "/v1/claims", {
    method: "POST",
    headers
  });
  const retry = await requestJson(app, "/v1/claims", {
    method: "POST",
    headers
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.error, null);
  assert.equal(first.body.meta.service, "mail-code-dashboard");
  assert.equal(first.body.meta.version, "1");
  assert.match(first.body.meta.requestId, /^request-/);
  assert.equal(retry.body.data.claimId, first.body.data.claimId);
  assert.equal(retry.body.data.email, first.body.data.email);
});

test("POST /v1/claims requires Idempotency-Key", async t => {
  const app = await makeTestServer(t);
  const result = await requestJson(app, "/v1/claims", {
    method: "POST",
    headers: authenticatedHeaders()
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "BAD_REQUEST");
});

test("inventory and explicit local-storage migration use stable envelopes", async t => {
  const app = await makeTestServer(t);
  const before = await requestJson(app, "/v1/inventory", {
    headers: authenticatedHeaders()
  });

  assert.equal(before.status, 200);
  assert.equal(before.body.data.initialized, false);
  assert.equal(before.body.data.summary.unused, 2);

  const migrated = await requestJson(app, "/v1/migrations/local-storage", {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      records: [
        {
          email: "first.alias@icloud.com",
          group: "finished",
          remark: "preserve me",
          label: "hme-001",
          unread: true,
          code: "123456",
          subject: "Synthetic",
          preview: "Synthetic preview",
          receivedAt: "2026-07-25T09:00:00.000Z"
        },
        {
          email: "trash.alias@icloud.com",
          group: "trash",
          remark: "discarded",
          label: "hme-003"
        }
      ]
    })
  });

  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.data.summary.finished, 1);
  assert.equal(migrated.body.data.summary.trash, 1);
  const after = await requestJson(app, "/v1/inventory", {
    headers: authenticatedHeaders()
  });
  assert.equal(after.body.data.initialized, true);
  assert.equal(
    after.body.data.inventory.find(
      item => item.email === "first.alias@icloud.com"
    ).remark,
    "preserve me"
  );
});

test("claim lookup, mail list/latest, and release are routed", async t => {
  const app = await makeTestServer(t);
  const claimed = await requestJson(app, "/v1/claims", {
    method: "POST",
    headers: authenticatedHeaders({ "Idempotency-Key": "job-1" })
  });
  const claimId = claimed.body.data.claimId;

  const lookup = await requestJson(app, `/v1/claims/${claimId}`, {
    headers: authenticatedHeaders()
  });
  const list = await requestJson(
    app,
    `/v1/claims/${claimId}/messages?limit=7`,
    { headers: authenticatedHeaders() }
  );
  const latest = await requestJson(
    app,
    `/v1/claims/${claimId}/messages/latest?waitSeconds=3`,
    { headers: authenticatedHeaders() }
  );
  const released = await requestJson(
    app,
    `/v1/claims/${claimId}/release`,
    {
      method: "POST",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ reason: "synthetic failure" })
    }
  );

  assert.equal(lookup.body.data.claimId, claimId);
  assert.equal(list.body.data.messages[0].uid, 10);
  assert.equal(latest.body.data.message, null);
  assert.deepEqual(app.mailboxCalls, [
    ["list", claimed.body.data.email, { limit: 7 }],
    ["latest", claimed.body.data.email, { waitSeconds: 3 }]
  ]);
  assert.equal(released.body.data.status, "released");
  assert.equal(released.body.data.releaseReason, "synthetic failure");
});

test("released and unknown claims return stable errors", async t => {
  const app = await makeTestServer(t);
  const claimed = await requestJson(app, "/v1/claims", {
    method: "POST",
    headers: authenticatedHeaders({ "Idempotency-Key": "job-1" })
  });
  const claimId = claimed.body.data.claimId;
  await requestJson(app, `/v1/claims/${claimId}/release`, {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: "{}"
  });

  const released = await requestJson(
    app,
    `/v1/claims/${claimId}/messages`,
    { headers: authenticatedHeaders() }
  );
  const missing = await requestJson(app, "/v1/claims/missing", {
    headers: authenticatedHeaders()
  });

  assert.equal(released.status, 409);
  assert.equal(released.body.error.code, "CLAIM_RELEASED");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "CLAIM_NOT_FOUND");
});

test("query bounds and malformed JSON return BAD_REQUEST", async t => {
  const app = await makeTestServer(t);
  const claimed = await requestJson(app, "/v1/claims", {
    method: "POST",
    headers: authenticatedHeaders({ "Idempotency-Key": "job-1" })
  });
  const claimId = claimed.body.data.claimId;

  const limit = await requestJson(
    app,
    `/v1/claims/${claimId}/messages?limit=101`,
    { headers: authenticatedHeaders() }
  );
  const wait = await requestJson(
    app,
    `/v1/claims/${claimId}/messages/latest?waitSeconds=31`,
    { headers: authenticatedHeaders() }
  );
  const malformed = await requestJson(
    app,
    `/v1/claims/${claimId}/release`,
    {
      method: "POST",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: "{not-json"
    }
  );

  assert.equal(limit.body.error.code, "BAD_REQUEST");
  assert.equal(wait.body.error.code, "BAD_REQUEST");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "BAD_REQUEST");
});

test("request IDs and responses never echo supplied secrets", async t => {
  const app = await makeTestServer(t);
  const result = await requestJson(app, "/v1/inventory", {
    headers: authenticatedHeaders()
  });
  const serialized = JSON.stringify(result.body);

  assert.match(result.body.meta.requestId, /^request-/);
  assert.equal(serialized.includes(API_KEY), false);
});

test("server.mjs exposes the protected v1 router on an isolated port", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-server-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_DASHBOARD_API_KEY: API_KEY,
      MAIL_DASHBOARD_STATE_PATH: join(directory, "dashboard-state-v1.json"),
      MAIL_DASHBOARD_BACKUP_DIR: join(directory, "backups"),
      MAIL_FORWARD_CONFIG: join(directory, "missing-forward-config.json"),
      MAIL_LIFECYCLE_LOG_PATH: join(directory, "server-lifecycle.log")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
  });

  const response = await waitForResponse(
    `http://127.0.0.1:${port}/v1/inventory`,
    { headers: authenticatedHeaders() }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.initialized, false);
});
