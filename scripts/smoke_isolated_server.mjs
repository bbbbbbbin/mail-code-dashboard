import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const TEMP_PREFIX = "icloud-dashboard-acceptance-";
const tempBase = resolve(tmpdir());
const tempRoot = await mkdtemp(join(tempBase, TEMP_PREFIX));
const apiKey = "synthetic-isolated-acceptance-key";

function assertSafeTemporaryRoot(path) {
  const resolved = resolve(path);
  const child = relative(tempBase, resolved);
  assert.ok(
    child &&
      child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child) &&
      basename(resolved).startsWith(TEMP_PREFIX),
    `refusing to operate on unsafe temporary path: ${resolved}`
  );
  return resolved;
}

assertSafeTemporaryRoot(tempRoot);

Object.assign(process.env, {
  HOST: "127.0.0.1",
  MAIL_DASHBOARD_API_KEY: apiKey,
  MAIL_DASHBOARD_API_KEY_FILE: join(tempRoot, "api-key.txt"),
  MAIL_DASHBOARD_STATE_PATH: join(tempRoot, "dashboard-state.json"),
  MAIL_DASHBOARD_BACKUP_DIR: join(tempRoot, "backups"),
  MAIL_FORWARD_CONFIG: join(tempRoot, "mail-forward.config.json"),
  HME_COOKIE_FILE: join(tempRoot, "cookies.txt"),
  HME_LABEL_SEQUENCE_FILE: join(tempRoot, "label-sequence.json"),
  MAIL_LIFECYCLE_LOG_PATH: join(tempRoot, "logs", "lifecycle.log")
});

let runtime;
let shutdownComplete = false;
try {
  const serverModule = await import("../server.mjs");
  const lifecycleLog =
    serverModule.__test.createRuntimeLifecycleLogger(process.env);
  runtime = await serverModule.__test.createRuntimeDashboardServer(
    process.env,
    { lifecycleLog }
  );

  serverModule.startDashboardServer(runtime.server, {
    env: process.env,
    port: 0
  });
  await once(runtime.server, "listening");
  const port = runtime.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const rootResponse = await fetch(`${baseUrl}/`);
  assert.equal(rootResponse.status, 200);
  assert.match(await rootResponse.text(), /\/assets\/dashboard\.js/);

  const cssResponse = await fetch(`${baseUrl}/assets/dashboard.css`);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get("content-type") || "", /^text\/css/);
  assert.equal(cssResponse.headers.get("cache-control"), "no-store");
  assert.equal(cssResponse.headers.get("x-content-type-options"), "nosniff");

  const privateResponse = await fetch(`${baseUrl}/server.mjs`);
  assert.equal(privateResponse.status, 404);
  await privateResponse.text();

  const unauthorized = await fetch(`${baseUrl}/v1/inventory`);
  assert.equal(unauthorized.status, 401);
  assert.doesNotMatch(await unauthorized.text(), new RegExp(apiKey, "u"));

  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey
  };
  const invalidBridgeResponse = await fetch(
    `${baseUrl}/api/edge-cookie-bridge`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ cookies: [] })
    }
  );
  assert.equal(invalidBridgeResponse.status, 400);
  const invalidBridgeBody = await invalidBridgeResponse.text();
  assert.match(invalidBridgeBody, /cookie/i);
  assert.doesNotMatch(invalidBridgeBody, new RegExp(apiKey, "u"));

  const createdResponse = await fetch(`${baseUrl}/v1/inventory`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      addresses: [
        {
          email: "isolated-acceptance@icloud.com",
          label: "hme-999",
          remark: "hme-999"
        }
      ]
    })
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.data.inventory.length, 1);

  const inventoryResponse = await fetch(`${baseUrl}/v1/inventory`, {
    headers: { "X-API-Key": apiKey }
  });
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  assert.equal(
    inventory.data.inventory[0].email,
    "isolated-acceptance@icloud.com"
  );

  let forcedExitCode = null;
  const shutdown = serverModule.createGracefulShutdown({
    server: runtime.server,
    store: runtime.store,
    log: lifecycleLog,
    forceExit(code) {
      forcedExitCode = code;
    }
  });
  const result = await shutdown("acceptance");
  assert.deepEqual(result, { signal: "acceptance", timedOut: false });
  assert.equal(forcedExitCode, null);
  shutdownComplete = true;

  const lifecycleLogContents = await readFile(
    process.env.MAIL_LIFECYCLE_LOG_PATH,
    "utf8"
  );
  const state = await readFile(process.env.MAIL_DASHBOARD_STATE_PATH, "utf8");
  assert.doesNotMatch(lifecycleLogContents, new RegExp(apiKey, "u"));
  assert.match(lifecycleLogContents, /shutdown requested signal=acceptance/);
  assert.match(state, /isolated-acceptance@icloud\.com/);

  console.log(
    "isolated server smoke passed: assets, auth, state, secrecy, graceful shutdown"
  );
} finally {
  if (runtime?.server?.listening && !shutdownComplete) {
    await new Promise(resolveClose => runtime.server.close(resolveClose));
  }
  const safeRoot = assertSafeTemporaryRoot(tempRoot);
  await rm(safeRoot, { recursive: true, force: true });
}
