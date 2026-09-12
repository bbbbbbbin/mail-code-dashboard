import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DashboardStore } from "../lib/dashboard-store.mjs";
import * as forwardMailbox from "../lib/forward-mailbox.mjs";
import * as serverModule from "../server.mjs";

test("lifecycle log path can be isolated from the repository", () => {
  const isolatedPath = join(
    tmpdir(),
    "isolated-dashboard-logs",
    "lifecycle.log"
  );

  assert.equal(
    serverModule.__test.resolveLifecycleLogPath({
      MAIL_LIFECYCLE_LOG_PATH: isolatedPath
    }),
    isolatedPath
  );
  assert.match(
    serverModule.__test.resolveLifecycleLogPath({}),
    /[\\/]logs[\\/]server-lifecycle\.log$/
  );
});

async function listen(t) {
  const server = serverModule.createDashboardServer({
    apiKey: "synthetic-hardening-key",
    v1Router: async () => false,
    legacyHandlers: {}
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise(resolve => {
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("static responses carry browser security headers without blocking the current inline UI", async t => {
  const url = await listen(t);
  const response = await fetch(`${url}/mail-code-dashboard.html`);
  const policy = response.headers.get("content-security-policy") || "";

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /style-src[^;]*'unsafe-inline'/);
  assert.match(policy, /frame-src[^;]*'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test("static 404 and 405 responses retain content type and browser security headers", async t => {
  const url = await listen(t);
  const responses = [
    await fetch(`${url}/missing-static-file`),
    await fetch(`${url}/mail-code-dashboard.html`, { method: "POST" })
  ];

  assert.deepEqual(
    responses.map(response => response.status),
    [404, 405]
  );
  for (const response of responses) {
    const policy = response.headers.get("content-security-policy") || "";
    assert.match(response.headers.get("content-type") || "", /^text\/plain/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
  }
});

test("non-Windows cookie refresh fails as platform unavailable before invoking CDP or DPAPI commands", async () => {
  const commands = [];
  const restore = serverModule.__test.setExecFileAsync(async file => {
    commands.push(file);
    throw new Error(`${file}: command not found`);
  });

  try {
    await assert.rejects(
      serverModule.__test.refreshICloudCookiesFromEdge({ platform: "linux" }),
      error =>
        error?.code === "PLATFORM_UNAVAILABLE" &&
        /平台不可用/.test(error.message) &&
        /Windows/.test(error.message) &&
        !/command not found/.test(error.message)
    );
    assert.deepEqual(commands, []);
  } finally {
    restore();
  }
});

test("legacy server mail checks and ForwardMailboxReader share one normalized default configuration", async t => {
  assert.equal(
    typeof forwardMailbox.normalizeForwardMailboxConfig,
    "function",
    "forward-mailbox must export the shared normalizer"
  );
  assert.equal(
    typeof forwardMailbox.FORWARD_MAILBOX_DEFAULTS,
    "object",
    "forward-mailbox must export the shared defaults"
  );
  assert.equal(
    typeof serverModule.__test.readForwardConfig,
    "function",
    "server must expose its config reader for contract verification"
  );

  const directory = await mkdtemp(join(tmpdir(), "forward-config-shared-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "mail-forward.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      email: "forwarding@example.test",
      password: "synthetic-password"
    }),
    "utf8"
  );

  const serviceConfig =
    await forwardMailbox.readForwardMailboxConfig(configPath);
  const legacyConfig = await serverModule.__test.readForwardConfig(configPath);
  assert.deepEqual(legacyConfig, { enabled: true, ...serviceConfig });
  assert.equal(serviceConfig.messageLimit, 100);
  assert.deepEqual(serviceConfig.mailboxes, ["INBOX"]);
});

test("graceful shutdown is injectable, ordered, and idempotent", async () => {
  assert.equal(typeof serverModule.createGracefulShutdown, "function");

  const events = [];
  let closeCallback;
  const shutdown = serverModule.createGracefulShutdown({
    server: {
      close(callback) {
        events.push("server.close");
        closeCallback = callback;
      }
    },
    store: {
      async waitForIdle() {
        events.push("store.waitForIdle");
      }
    },
    async flushLog() {
      events.push("flushLifecycleLog");
    },
    log(message) {
      events.push(`log:${message}`);
    },
    timeoutMs: 1_000,
    forceExit(code) {
      events.push(`forceExit:${code}`);
    }
  });

  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");
  assert.strictEqual(second, first);
  assert.equal(
    events.filter(event => event === "server.close").length,
    1,
    "the first call must stop accepting connections synchronously"
  );

  closeCallback();
  const result = await first;
  assert.deepEqual(result, { signal: "SIGTERM", timedOut: false });
  assert.equal(
    events.filter(event => event === "server.close").length,
    1
  );
  assert.ok(
    events.indexOf("store.waitForIdle") <
      events.indexOf("flushLifecycleLog")
  );
  assert.equal(events.some(event => event.startsWith("forceExit:")), false);
});

test("shutdown waits for a mutation queued by an active request before flushing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "shutdown-active-request-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DashboardStore({
    statePath: join(directory, "dashboard-state-v1.json"),
    backupDir: join(directory, "backups")
  });

  let allowMutation;
  let finishMutation;
  let markRequestStarted;
  let markMutationStarted;
  const requestGate = new Promise(resolve => {
    allowMutation = resolve;
  });
  const mutationGate = new Promise(resolve => {
    finishMutation = resolve;
  });
  const requestStarted = new Promise(resolve => {
    markRequestStarted = resolve;
  });
  const mutationStarted = new Promise(resolve => {
    markMutationStarted = resolve;
  });
  let mutation;

  const server = serverModule.createDashboardServer({
    apiKey: "synthetic-hardening-key",
    legacyHandlers: {},
    async v1Router(req, res) {
      if (req.url !== "/v1/delayed-mutation") {
        return false;
      }
      markRequestStarted();
      await requestGate;
      mutation = store.mutate(async state => {
        markMutationStarted();
        await mutationGate;
        state.inventory.push({
          id: "row-from-active-request",
          email: "active-request@icloud.com",
          group: "unused"
        });
      });
      // Deliberately finish the request after queueing, not after awaiting, the
      // mutation. Shutdown must drain the store rather than assuming an HTTP
      // response means all state writes are already durable.
      res.writeHead(204);
      res.end();
      return true;
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let flushed = false;
  const shutdown = serverModule.createGracefulShutdown({
    server,
    store,
    async flushLog() {
      flushed = true;
    },
    log() {},
    timeoutMs: 1_000,
    forceExit(code) {
      assert.fail(`shutdown unexpectedly forced exit ${code}`);
    }
  });
  const request = new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: "/v1/delayed-mutation",
        agent: false,
        headers: { Connection: "close" }
      },
      response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      }
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
  await requestStarted;

  let shutdownResolved = false;
  const stopping = shutdown("SIGTERM").then(result => {
    shutdownResolved = true;
    return result;
  });
  allowMutation();
  await mutationStarted;
  assert.equal(await request, 204);
  await new Promise(resolve => setImmediate(resolve));
  const resolvedWhileMutationBlocked = shutdownResolved;
  const flushedWhileMutationBlocked = flushed;

  finishMutation();
  await mutation;
  const result = await stopping;

  assert.equal(resolvedWhileMutationBlocked, false);
  assert.equal(flushedWhileMutationBlocked, false);
  assert.equal(flushed, true);
  assert.deepEqual(result, { signal: "SIGTERM", timedOut: false });
  assert.equal(
    (await store.listInventory())[0].email,
    "active-request@icloud.com"
  );
});

test("graceful shutdown has a bounded force-exit fallback", async () => {
  assert.equal(typeof serverModule.createGracefulShutdown, "function");

  const events = [];
  const shutdown = serverModule.createGracefulShutdown({
    server: {
      close() {
        events.push("server.close");
      },
      closeAllConnections() {
        events.push("server.closeAllConnections");
      }
    },
    store: {
      waitForIdle() {
        return new Promise(() => {});
      }
    },
    async flushLog() {
      events.push("flushLifecycleLog");
    },
    log(message) {
      events.push(`log:${message}`);
    },
    timeoutMs: 10,
    forceExit(code) {
      events.push(`forceExit:${code}`);
    }
  });

  const result = await shutdown("SIGINT");

  assert.deepEqual(result, { signal: "SIGINT", timedOut: true });
  assert.deepEqual(
    events.filter(event => event === "server.closeAllConnections"),
    ["server.closeAllConnections"]
  );
  assert.deepEqual(
    events.filter(event => event === "forceExit:1"),
    ["forceExit:1"]
  );
});

test("server close failure still drains the store and flushes logs", async () => {
  const closeError = new Error("synthetic close failure");
  const events = [];
  const shutdown = serverModule.createGracefulShutdown({
    server: {
      close(callback) {
        callback(closeError);
      },
      closeAllConnections() {
        events.push("server.closeAllConnections");
      }
    },
    store: {
      async waitForIdle() {
        events.push("store.waitForIdle");
      }
    },
    async flushLog() {
      events.push("flushLifecycleLog");
    },
    log(message) {
      events.push(`log:${message}`);
    },
    forceExit(code) {
      events.push(`forceExit:${code}`);
    }
  });

  const result = await shutdown("SIGTERM");

  assert.ok(events.includes("store.waitForIdle"));
  assert.ok(events.includes("flushLifecycleLog"));
  assert.ok(events.includes("forceExit:1"));
  assert.strictEqual(result.error, closeError);
  assert.equal(result.timedOut, false);
});

test("store drain failure still flushes logs and remains the shutdown outcome", async () => {
  const storeError = new Error("synthetic store failure");
  const events = [];
  const shutdown = serverModule.createGracefulShutdown({
    server: {
      close(callback) {
        callback();
      },
      closeAllConnections() {
        events.push("server.closeAllConnections");
      }
    },
    store: {
      async waitForIdle() {
        events.push("store.waitForIdle");
        throw storeError;
      }
    },
    async flushLog() {
      events.push("flushLifecycleLog");
    },
    log(message) {
      events.push(`log:${message}`);
    },
    forceExit(code) {
      events.push(`forceExit:${code}`);
    }
  });

  const result = await shutdown("SIGINT");

  assert.ok(events.includes("flushLifecycleLog"));
  assert.ok(events.includes("forceExit:1"));
  assert.strictEqual(result.error, storeError);
  assert.equal(result.timedOut, false);
});

test("signal hooks remain installed for repeated shutdown signals until disposed", () => {
  const fakeProcess = new EventEmitter();
  const signals = [];
  const dispose = serverModule.installGracefulShutdownSignals(
    signal => {
      signals.push(signal);
      return Promise.resolve();
    },
    { processLike: fakeProcess }
  );

  fakeProcess.emit("SIGINT");
  fakeProcess.emit("SIGINT");
  fakeProcess.emit("SIGTERM");
  assert.deepEqual(signals, ["SIGINT", "SIGINT", "SIGTERM"]);

  dispose();
  fakeProcess.emit("SIGINT");
  fakeProcess.emit("SIGTERM");
  assert.deepEqual(signals, ["SIGINT", "SIGINT", "SIGTERM"]);
});

test("legacy raw-mail parsing uses the shared verification-code ranking", async () => {
  const parsed = await serverModule.__test.parseRawMail(
    [
      "Subject: Synthetic verification",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "123456 is your code. Reference code: 987654."
    ].join("\r\n")
  );

  assert.equal(parsed.code, "123456");
});

test("importing server.mjs has no process or log-file side effects", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-import-"));
  const isolatedLogPath = join(directory, "must-not-exist.log");
  const previousLogPath = process.env.MAIL_LIFECYCLE_LOG_PATH;
  t.after(async () => {
    if (previousLogPath === undefined) {
      delete process.env.MAIL_LIFECYCLE_LOG_PATH;
    } else {
      process.env.MAIL_LIFECYCLE_LOG_PATH = previousLogPath;
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MAIL_LIFECYCLE_LOG_PATH = isolatedLogPath;

  const before = {
    beforeExit: process.listenerCount("beforeExit"),
    exit: process.listenerCount("exit"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    uncaughtException: process.listenerCount("uncaughtException"),
    unhandledRejection: process.listenerCount("unhandledRejection"),
    stdoutError: process.stdout.listenerCount("error"),
    stderrError: process.stderr.listenerCount("error")
  };

  await import(`../server.mjs?hardening=${Date.now()}`);

  assert.deepEqual(
    {
      beforeExit: process.listenerCount("beforeExit"),
      exit: process.listenerCount("exit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      uncaughtException: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
      stdoutError: process.stdout.listenerCount("error"),
      stderrError: process.stderr.listenerCount("error")
    },
    before
  );
  await assert.rejects(stat(isolatedLogPath), { code: "ENOENT" });
});
