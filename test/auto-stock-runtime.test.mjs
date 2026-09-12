import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardStore } from "../lib/dashboard-store.mjs";
import { __test } from "../server.mjs";

test("a configured service generates and persists inventory without any page or HTTP request", async t => {
  const directory = await mkdtemp(join(tmpdir(), "auto-stock-runtime-"));
  const statePath = join(directory, "state.json");
  const store = new DashboardStore({ statePath, backupDir: join(directory, "backups") });
  await store.mutate(state => {
    state.autoStock = { configured: true, enabled: true, prefix: "hme" };
  });
  const generatedBatches = [];
  let intervalCallback;
  const runtime = await __test.createRuntimeDashboardServer({
    MAIL_DASHBOARD_STATE_PATH: statePath,
    MAIL_DASHBOARD_BACKUP_DIR: join(directory, "backups"),
    MAIL_FORWARD_CONFIG: join(directory, "forward.json"),
    MAIL_DASHBOARD_API_KEY: "synthetic-auto-stock-key"
  }, {
    autoStockOptions: {
      now: () => Date.parse("2026-09-12T00:00:00Z"),
      setIntervalImpl(callback) { intervalCallback = callback; return { unref() {} }; },
      clearIntervalImpl() {},
      async generateBatch(labels) {
        generatedBatches.push(labels);
        return { generated: labels.map(label => ({ email: `${label}@icloud.com`, label })), errors: [] };
      }
    }
  });
  t.after(async () => {
    await runtime.autoStock?.stop();
    if (runtime.server.listening) await new Promise(resolve => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  await runtime.autoStock?.waitForIdle();
  assert.equal(generatedBatches.length, 1, "generation must start without a browser visit");
  assert.equal((await store.read()).inventory.length, 5, "server must persist generated addresses itself");
  assert.equal(typeof intervalCallback, "function", "server must own the recurring timer");
  await intervalCallback();
  assert.equal(generatedBatches.length, 1, "polling must respect the persisted hourly cooldown");
});

test("the page only polls background status, never schedules Apple generation", async () => {
  const source = await readFile(new URL("../assets/dashboard.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setInterval\(autoGenerateStock|async function autoGenerateStock\(/);
  assert.match(source, /\/v1\/auto-stock/);
});

test("background configuration is authenticated, validated and shared by tabs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "auto-stock-api-"));
  const runtime = await __test.createRuntimeDashboardServer({
    MAIL_DASHBOARD_STATE_PATH: join(directory, "state.json"),
    MAIL_DASHBOARD_BACKUP_DIR: join(directory, "backups"),
    MAIL_DASHBOARD_API_KEY: "synthetic-config-key"
  }, { autoStockOptions: { setIntervalImpl() { return 1; }, clearIntervalImpl() {},
    async generateBatch() { throw new Error("configuration must not synchronously generate"); } } });
  t.after(async () => {
    await runtime.autoStock.stop();
    await new Promise(resolve => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  const headers = { "X-API-Key": "synthetic-config-key", "Content-Type": "application/json" };
  for (const [method, path] of [["GET", "/v1/auto-stock"], ["PATCH", "/v1/auto-stock"], ["POST", "/v1/auto-stock/initialize"]]) {
    assert.equal((await fetch(url + path, { method })).status, 401);
  }
  const initial = await fetch(url + "/v1/auto-stock/initialize", { method: "POST", headers, body: JSON.stringify({ enabled: false, prefix: "first" }) });
  assert.equal(initial.status, 200);
  await fetch(url + "/v1/auto-stock/initialize", { method: "POST", headers, body: JSON.stringify({ enabled: true, prefix: "second" }) });
  const state = (await (await fetch(url + "/v1/auto-stock", { headers })).json()).data;
  assert.equal(state.prefix, "first");
  assert.equal(state.enabled, false);
  const bad = await fetch(url + "/v1/auto-stock", { method: "PATCH", headers, body: '{"enabled":"false"}' });
  assert.equal(bad.status, 400);
  const updated = await fetch(url + "/v1/auto-stock", { method: "PATCH", headers, body: '{"prefix":"changed"}' });
  assert.equal((await updated.json()).data.prefix, "changed");
});
