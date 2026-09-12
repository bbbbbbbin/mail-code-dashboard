import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadOrCreateApiKey } from "../lib/local-secret.mjs";

async function withTemporaryKeyFile(run) {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-secret-"));
  const keyPath = join(directory, "runtime", "api-key.txt");
  try {
    await run({ directory, keyPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("an existing MAIL_DASHBOARD_API_KEY wins without creating a file", async () => {
  await withTemporaryKeyFile(async ({ keyPath }) => {
    const result = await loadOrCreateApiKey({
      env: { MAIL_DASHBOARD_API_KEY: " environment-secret " },
      keyPath
    });

    assert.deepEqual(result, {
      key: "environment-secret",
      source: "environment",
      keyPath: null
    });
    await assert.rejects(readFile(keyPath), error => error.code === "ENOENT");
  });
});

test("an existing key file is read and trimmed", async () => {
  await withTemporaryKeyFile(async ({ directory, keyPath }) => {
    const runtimeDirectory = join(directory, "runtime");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(runtimeDirectory, { recursive: true })
    );
    await writeFile(keyPath, " file-secret \n", "utf8");

    const result = await loadOrCreateApiKey({ env: {}, keyPath });

    assert.deepEqual(result, {
      key: "file-secret",
      source: "file",
      keyPath
    });
  });
});

test("an absent key file is populated with a random persisted secret", async () => {
  await withTemporaryKeyFile(async ({ keyPath }) => {
    const result = await loadOrCreateApiKey({ env: {}, keyPath });
    const persisted = (await readFile(keyPath, "utf8")).trim();

    assert.equal(result.source, "generated");
    assert.equal(result.keyPath, keyPath);
    assert.equal(result.key, persisted);
    assert.match(result.key, /^[A-Za-z0-9_-]{40,}$/);
  });
});

test("public source status can omit the secret value", async () => {
  await withTemporaryKeyFile(async ({ keyPath }) => {
    const result = await loadOrCreateApiKey({ env: {}, keyPath });
    const status = { source: result.source, keyPath: result.keyPath };

    assert.deepEqual(status, { source: "generated", keyPath });
    assert.equal(JSON.stringify(status).includes(result.key), false);
  });
});
