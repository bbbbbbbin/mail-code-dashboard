import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoStockService, AUTO_STOCK_INTERVAL_MS, AUTO_STOCK_TARGET } from "../lib/auto-stock-service.mjs";
import { DashboardStore } from "../lib/dashboard-store.mjs";

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "auto-stock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = Date.parse("2026-09-12T00:00:00Z");
  const statePath = join(dir, "state.json");
  const store = new DashboardStore({ statePath, backupDir: join(dir, "backup") });
  const calls = [];
  const options = { store, now: () => time, async generateBatch(labels) {
    calls.push(labels);
    return { generated: labels.map(label => ({ email: `${label}@icloud.com`, label })), errors: [] };
  }, async generateOne(label) { calls.push([label]); return { email: `${label}@icloud.com`, label }; }, ...overrides };
  const service = new AutoStockService(options);
  return { service, store, calls, statePath, options, advance(ms) { time += ms; } };
}

test("fresh installs do not generate before configuration; first browser initialization wins", async t => {
  const { service, calls } = await fixture(t);
  await service.tick();
  assert.equal(calls.length, 0);
  await service.configure({ enabled: false, prefix: "account_a" }, { initializeOnly: true });
  await service.configure({ enabled: true, prefix: "account_b" }, { initializeOnly: true });
  await service.tick();
  assert.equal(calls.length, 0);
  assert.equal((await service.status()).prefix, "account_a");
  assert.equal((await service.status()).enabled, false);
});

test("background polling is single-flight and restart preserves hourly cooldown and toggle", async t => {
  const { service, calls, advance, options, store } = await fixture(t);
  await service.configure({ enabled: true, prefix: "hme" });
  await Promise.all(Array.from({ length: 20 }, () => service.tick()));
  assert.equal(calls.length, 1);
  assert.equal((await store.read()).inventory.length, 5);
  const restarted = new AutoStockService(options);
  await restarted.tick();
  assert.equal(calls.length, 1);
  await restarted.configure({ enabled: false });
  advance(AUTO_STOCK_INTERVAL_MS);
  await restarted.tick();
  assert.equal(calls.length, 1);
  await restarted.configure({ enabled: true });
  await restarted.tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["hme-006", "hme-007", "hme-008", "hme-009", "hme-010"]);
});

test("success by manual generation blocks old automatic tabs during cooldown", async t => {
  const { service, calls, store } = await fixture(t);
  await service.configure({ enabled: true });
  await service.manualOne("hme-001");
  await service.tick();
  await assert.rejects(service.manualBatch(["hme-002"]), { code: "AUTO_STOCK_SERVER_OWNED" });
  assert.equal(calls.length, 1);
  assert.equal((await store.read()).inventory.length, 1);
});

test("target caps the last batch and never generates over 1500", async t => {
  const { service, calls, store, advance } = await fixture(t);
  await store.mutate(state => {
    state.inventory = Array.from({ length: AUTO_STOCK_TARGET - 2 }, (_, i) => ({
      id: String(i), email: `hme-${i + 1}@icloud.com`, label: `hme-${i + 1}`, group: "unused"
    }));
  });
  await service.configure({ enabled: true });
  await service.tick();
  assert.deepEqual(calls[0], ["hme-1499", "hme-1500"]);
  advance(AUTO_STOCK_INTERVAL_MS);
  await service.tick();
  assert.equal(calls.length, 1);
  assert.equal((await store.read()).inventory.length, 1500);
});

test("migration carries an existing browser cooldown without resetting it on later toggles", async t => {
  const { service, calls } = await fixture(t);
  await service.configure({ enabled: true, prefix: "hme", lastGeneratedAt: "2026-09-12T00:00:00Z" }, { initializeOnly: true });
  await service.tick();
  await service.configure({ enabled: false });
  await service.configure({ enabled: true });
  await service.tick();
  assert.equal(calls.length, 0);
  assert.equal((await service.status()).nextAttemptAt, "2026-09-12T01:00:00.000Z");
});

test("ordinary failure backs off five minutes, repeated failure backs off one hour", async t => {
  let attempts = 0;
  const { service, advance } = await fixture(t, { async generateBatch() { attempts++; throw new Error("temporarily offline"); } });
  await service.configure({ enabled: true });
  await service.tick();
  assert.equal((await service.status()).nextAttemptAt, "2026-09-12T00:05:00.000Z");
  await service.tick();
  assert.equal(attempts, 1);
  advance(300_000); await service.tick();
  advance(300_000); await service.tick();
  assert.equal((await service.status()).nextAttemptAt, "2026-09-12T01:10:00.000Z");
  assert.equal(attempts, 3);
});

test("partial success is persisted while uncertain results pause until reconciliation", async t => {
  const { service, store, advance } = await fixture(t, { async generateBatch() {
    return { generated: [{ email: "success@icloud.com", label: "hme-001" }], errors: [{ code: "GENERATION_RESULT_UNCERTAIN", error: "reserve timeout" }] };
  } });
  await service.configure({ enabled: true });
  await service.tick();
  assert.equal((await store.read()).inventory.length, 1);
  assert.match((await service.status()).pausedReason, /同步/);
  await assert.rejects(service.configure({ enabled: true }), { code: "GENERATION_RESULT_UNCERTAIN" });
  advance(AUTO_STOCK_INTERVAL_MS);
  await service.tick();
  assert.equal((await store.read()).inventory.length, 1);
  await service.reconciled();
  await service.configure({ enabled: true });
  assert.equal((await service.status()).pausedReason, "");
});

test("interrupted process marker prevents silent generation on restart", async t => {
  const { service, store, calls } = await fixture(t);
  await store.mutate(state => { state.autoStock = { configured: true, enabled: true, inFlight: true }; });
  await service.tick();
  assert.equal(calls.length, 0);
  assert.match((await service.status()).pausedReason, /同步/);
});

test("failed inventory persistence pauses, preserving marker across restart", async t => {
  const { service, store, options, calls, advance } = await fixture(t);
  await service.configure({ enabled: true });
  store.createInventoryItems = async () => { throw new Error("disk full"); };
  await service.tick();
  assert.match((await service.status()).pausedReason, /同步/);
  advance(AUTO_STOCK_INTERVAL_MS);
  await new AutoStockService(options).tick();
  assert.equal(calls.length, 1);
});

test("corrupt state fails closed without Apple calls", async t => {
  const { service, calls, statePath } = await fixture(t);
  await writeFile(statePath, "{corrupt");
  await service.tick();
  assert.equal(calls.length, 0);
});

test("instances do not share switches, schedules, prefixes or inventory", async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await a.service.configure({ enabled: true, prefix: "aaa" });
  await b.service.configure({ enabled: false, prefix: "bbb" });
  await Promise.all([a.service.tick(), b.service.tick()]);
  assert.equal((await a.store.read()).inventory.length, 5);
  assert.equal((await b.store.read()).inventory.length, 0);
  assert.equal((await b.service.status()).nextAttemptAt, "");
});

test("shutdown cancels the timer and waits for in-flight persistence", async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let cleared = false;
  const { service, store } = await fixture(t, {
    setIntervalImpl() { return 123; }, clearIntervalImpl(handle) { assert.equal(handle, 123); cleared = true; },
    async generateBatch() { entered(); await gate; return { generated: [{ email: "done@icloud.com", label: "hme-001" }], errors: [] }; }
  });
  await service.configure({ enabled: true });
  service.start();
  await started;
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(cleared, true);
  release();
  await stopping;
  assert.equal((await store.read()).inventory.length, 1);
});

test("invalid configuration never writes state", async t => {
  const { service } = await fixture(t);
  for (const patch of [null, [], { enabled: "false" }, { prefix: "../bad" }, { prefix: "_bad" }]) {
    await assert.rejects(service.configure(patch), { code: "BAD_REQUEST" });
  }
  assert.equal((await service.status()).configured, false);
});

test("a switch-off racing the due check is respected before claiming a batch", async t => {
  const { service, store, calls } = await fixture(t);
  await service.configure({ enabled: true });
  const mutate = store.mutate.bind(store);
  let first = true;
  store.mutate = async worker => {
    if (first) {
      first = false;
      await mutate(state => { state.autoStock.enabled = false; });
    }
    return mutate(worker);
  };
  await service.tick();
  assert.equal(calls.length, 0);
  assert.equal((await service.status()).inFlight, false);
});
