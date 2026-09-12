import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { DashboardStore } from "../lib/dashboard-store.mjs";

const fixturePath = fileURLToPath(
  new URL("./fixtures/local-storage-snapshot.json", import.meta.url)
);
const legacyFixture = JSON.parse(await readFile(fixturePath, "utf8"));

async function makeTemporaryStore(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let id = 0;
  const statePath = join(directory, "runtime", "dashboard-state-v1.json");
  const backupDir = join(directory, "runtime", "backups");
  // Not passed to the store: the tests assert on the *default* location, so a
  // regression that moves the archive somewhere else fails here.
  const archiveDir = join(directory, "runtime", "archive");
  const store = new DashboardStore({
    statePath,
    backupDir,
    now: () => new Date("2026-07-25T10:11:12.345Z"),
    randomUUID: () => `synthetic-id-${++id}`,
    ...overrides
  });
  return { archiveDir, backupDir, directory, statePath, store };
}

// The fixed clock above sits at 2026-07-25, so the default 30 day window cuts
// at 2026-06-25.
const ARCHIVE_FILE = "dashboard-archive-2026-07-25.json";

function claimRecord(claimId, overrides = {}) {
  return {
    claimId,
    emailId: `row-${claimId}`,
    email: `${claimId}@icloud.com`,
    status: "released",
    idempotencyKey: `key-${claimId}`,
    claimedAt: "2026-01-01T00:00:00.000Z",
    releasedAt: "2026-05-01T00:00:00.000Z",
    releaseReason: "done",
    ...overrides
  };
}

async function writeStateFile(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  const document = {
    version: 1,
    inventory: [],
    claims: [],
    idempotency: {},
    migration: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
    ...state
  };
  const raw = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(statePath, raw, "utf8");
  return raw;
}

async function readArchive(archiveDir, fileName = ARCHIVE_FILE) {
  return JSON.parse(await readFile(join(archiveDir, fileName), "utf8"));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

test("initializeFromLegacy preserves group, remark, and mail state", async t => {
  const { store } = await makeTemporaryStore(t);
  const result = await store.initializeFromLegacy(legacyFixture);

  assert.deepEqual(result.summary, {
    total: 3,
    unused: 1,
    finished: 1,
    trash: 1
  });

  const state = await store.read();
  const used = state.inventory.find(
    item => item.email === "used.alias@icloud.com"
  );
  assert.equal(used.group, "finished");
  assert.equal(used.remark, "do not reuse");
  assert.equal(used.label, "hme-001");
  assert.equal(used.code, "123456");
  assert.equal(used.unread, true);
  assert.equal(used.subject, "Synthetic verification");
  assert.equal(used.preview, "Synthetic preview without message content");
  assert.equal(used.receivedAt, "2026-07-24T09:00:00.000Z");
  assert.equal(used.statusType, "ok");
  assert.equal(used.statusMessage, "checked");
  assert.equal(used.lastCheckedAt, "2026-07-24T09:01:00.000Z");
  assert.equal("password" in used, false);
  assert.equal("refreshToken" in used, false);
});

test("waitForIdle resolves only after the mutate queue current at call time drains", async t => {
  const { store } = await makeTemporaryStore(t);
  let releaseWorker;
  let workerStarted;
  const started = new Promise(resolve => {
    workerStarted = resolve;
  });
  const gate = new Promise(resolve => {
    releaseWorker = resolve;
  });

  const mutation = store.mutate(async state => {
    workerStarted();
    await gate;
    state.inventory.push({
      id: "row-after-idle",
      email: "after-idle@icloud.com",
      group: "unused"
    });
  });
  await started;

  let idle = false;
  const waiting = store.waitForIdle().then(() => {
    idle = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);

  releaseWorker();
  await mutation;
  await waiting;
  assert.equal(idle, true);
  assert.equal((await store.listInventory())[0].email, "after-idle@icloud.com");
});

test("waitForIdle also drains mutations queued while it is already waiting", async t => {
  const { store } = await makeTemporaryStore(t);
  let releaseFirst;
  let releaseSecond;
  let markFirstStarted;
  let markSecondStarted;
  const firstStarted = new Promise(resolve => {
    markFirstStarted = resolve;
  });
  const secondStarted = new Promise(resolve => {
    markSecondStarted = resolve;
  });
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise(resolve => {
    releaseSecond = resolve;
  });

  const first = store.mutate(async state => {
    markFirstStarted();
    await firstGate;
    state.inventory.push({
      id: "row-first",
      email: "first@icloud.com",
      group: "unused"
    });
  });
  await firstStarted;

  let idleResolved = false;
  const idle = store.waitForIdle().then(() => {
    idleResolved = true;
  });
  const second = store.mutate(async state => {
    markSecondStarted();
    await secondGate;
    state.inventory.push({
      id: "row-second",
      email: "second@icloud.com",
      group: "unused"
    });
  });

  releaseFirst();
  await secondStarted;
  await new Promise(resolve => setImmediate(resolve));
  const resolvedBeforeSecondFinished = idleResolved;

  releaseSecond();
  await Promise.all([first, second, idle]);

  assert.equal(
    resolvedBeforeSecondFinished,
    false,
    "a mutation appended during the wait must extend the drain"
  );
  assert.deepEqual(
    (await store.listInventory()).map(item => item.email),
    ["first@icloud.com", "second@icloud.com"]
  );
});

test("initializeFromLegacy refuses a silent second initialization", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);

  await assert.rejects(
    store.initializeFromLegacy(legacyFixture),
    error => error.code === "INVENTORY_ALREADY_INITIALIZED"
  );
});

test("syncAliases replaces historical labels with the Apple label only", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  await store.syncAliases([
    {
      email: "used.alias@icloud.com",
      label: "apple-label",
      appleLabel: "Apple label",
      anonymousId: "synthetic-anonymous-id",
      isActive: true
    },
    {
      email: "new.alias@icloud.com",
      label: "hme-999",
      isActive: true
    }
  ]);

  const state = await store.read();
  const used = state.inventory.find(
    item => item.email === "used.alias@icloud.com"
  );
  assert.equal(used.group, "finished");
  assert.equal(used.remark, "do not reuse");
  assert.equal(used.code, "123456");
  assert.equal(used.label, "Apple label");
  assert.equal(used.appleLabel, "Apple label");
  assert.equal(used.anonymousId, "synthetic-anonymous-id");
  const added = state.inventory.find(item => item.email === "new.alias@icloud.com");
  assert.equal(added.group, "unused");
  assert.equal(added.label, "hme-999");
  assert.equal(added.appleLabel, "hme-999");
});

test("initializeFromLegacy deduplicates email addresses case-insensitively", async t => {
  const { store } = await makeTemporaryStore(t);
  const duplicate = {
    ...legacyFixture[0],
    email: legacyFixture[0].email.toUpperCase()
  };

  await store.initializeFromLegacy([legacyFixture[0], duplicate]);

  const state = await store.read();
  assert.equal(state.inventory.length, 1);
  assert.equal(state.inventory[0].email, "unused.alias@icloud.com");
});

test("initializeFromLegacy rejects unsupported groups", async t => {
  const { store } = await makeTemporaryStore(t);

  await assert.rejects(
    store.initializeFromLegacy([
      { email: "invalid.alias@icloud.com", group: "archived" }
    ]),
    error => error.code === "BAD_REQUEST"
  );
});

test("initializeFromLegacy writes the raw submitted snapshot to a backup", async t => {
  const { backupDir, store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);

  const backupFiles = await readdir(backupDir);
  assert.equal(backupFiles.length, 1);
  assert.match(backupFiles[0], /^local-storage-2026-07-25T10-11-12-345Z\.json$/);
  const backup = JSON.parse(
    await readFile(join(backupDir, backupFiles[0]), "utf8")
  );
  assert.deepEqual(backup, legacyFixture);
});

test("read rejects corrupt state instead of silently resetting it", async t => {
  const { statePath, store } = await makeTemporaryStore(t);
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(dirname(statePath), { recursive: true })
  );
  await writeFile(statePath, "{not-json", "utf8");

  await assert.rejects(
    store.read(),
    error => error.code === "STORAGE_ERROR"
  );
  assert.equal(await readFile(statePath, "utf8"), "{not-json");
});

test("mutate serializes concurrent state changes", async t => {
  const { store } = await makeTemporaryStore(t);
  const order = [];

  const first = store.mutate(async state => {
    order.push("first-start");
    await new Promise(resolve => setTimeout(resolve, 20));
    state.claims.push({ claimId: "first" });
    order.push("first-end");
  });
  const second = store.mutate(state => {
    order.push("second-start");
    state.claims.push({ claimId: "second" });
    order.push("second-end");
  });
  await Promise.all([first, second]);

  assert.deepEqual(order, [
    "first-start",
    "first-end",
    "second-start",
    "second-end"
  ]);
  assert.deepEqual(
    (await store.read()).claims.map(item => item.claimId),
    ["first", "second"]
  );
});

test("updateInventoryItem changes only allowed inventory fields", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  const item = (await store.listInventory())[0];

  const updated = await store.updateInventoryItem(item.id, {
    remark: "updated safely",
    group: "finished",
    unread: true,
    lastMethod: "Forward IMAP/Junk",
    noCodeReason: "No numeric code",
    email: "replacement@icloud.com",
    password: "must-not-persist"
  });

  assert.equal(updated.remark, "updated safely");
  assert.equal(updated.group, "finished");
  assert.equal(updated.unread, true);
  assert.equal(updated.lastMethod, "Forward IMAP/Junk");
  assert.equal(updated.noCodeReason, "No numeric code");
  assert.equal(updated.email, item.email);
  assert.equal("password" in updated, false);

  const persisted = (await store.read()).inventory.find(
    candidate => candidate.id === item.id
  );
  assert.equal(persisted.lastMethod, "Forward IMAP/Junk");
  assert.equal(persisted.noCodeReason, "No numeric code");
});

test("updateInventoryItems applies every patch inside a single state write", async t => {
  const { statePath, store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  const rows = await store.listInventory();

  const before = JSON.parse(await readFile(statePath, "utf8"));
  const result = await store.updateInventoryItems(
    rows.map(row => [row.id, { remark: `batch ${row.id}` }])
  );
  const after = JSON.parse(await readFile(statePath, "utf8"));

  assert.equal(result.updated.length, rows.length);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.inventory.length, rows.length);
  for (const row of after.inventory) {
    assert.equal(row.remark, `batch ${row.id}`);
  }
  // The batch must not have rewritten the file once per row.
  assert.notDeepEqual(before.inventory, after.inventory);
});

test("updateInventoryItems skips rows whose group moved and reports missing ids", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  const rows = await store.listInventory();
  const unused = rows.find(row => row.group === "unused");
  const trash = rows.find(row => row.group === "trash");

  const result = await store.updateInventoryItems([
    {
      id: unused.id,
      expectedGroup: "unused",
      patch: { group: "finished", remark: "moved by batch" }
    },
    {
      id: trash.id,
      expectedGroup: "unused",
      patch: { group: "finished", remark: "must not apply" }
    },
    { id: "no-such-row", expectedGroup: "unused", patch: { remark: "ghost" } }
  ]);

  assert.deepEqual(result.updated.map(item => item.id), [unused.id]);
  assert.deepEqual(result.skipped, [trash.id]);
  assert.deepEqual(result.missing, ["no-such-row"]);

  const persisted = new Map(
    (await store.listInventory()).map(item => [item.id, item])
  );
  assert.equal(persisted.get(unused.id).group, "finished");
  assert.equal(persisted.get(unused.id).remark, "moved by batch");
  assert.equal(persisted.get(trash.id).group, "trash");
  assert.equal(persisted.get(trash.id).remark, trash.remark);
});

test("createInventoryItems is idempotent on the email address", async t => {
  const { store } = await makeTemporaryStore(t);

  const first = await store.createInventoryItems([
    { email: "Fresh.Alias@icloud.com", label: "hme-101" },
    { email: "second.alias@icloud.com", label: "hme-102" }
  ]);
  const retry = await store.createInventoryItems([
    { email: "fresh.alias@icloud.com", label: "hme-101" },
    { email: "SECOND.ALIAS@icloud.com", label: "hme-102" }
  ]);

  assert.deepEqual(
    first.created.map(item => item.email),
    ["fresh.alias@icloud.com", "second.alias@icloud.com"]
  );
  assert.deepEqual(first.existing, []);
  assert.deepEqual(retry.created, []);
  assert.deepEqual(
    retry.existing.map(item => item.email),
    ["fresh.alias@icloud.com", "second.alias@icloud.com"]
  );

  const rows = await store.listInventory();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].group, "unused");
  assert.equal(rows[0].label, "hme-101");
  assert.equal(rows[0].remark, "hme-101");
  assert.equal(rows[0].source, "icloud-hme");
  assert.equal(rows[0].activeClaimId, "");
  assert.equal(rows[0].createdAt, "2026-07-25T10:11:12.345Z");
});

test("createInventoryItems refreshes official labels without overwriting operator fields", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  const before = (await store.listInventory()).find(
    item => item.email === "used.alias@icloud.com"
  );

  const result = await store.createInventoryItems([
    {
      email: "USED.alias@icloud.com",
      label: "regenerated-label",
      remark: "regenerated remark",
      group: "unused",
      appleLabel: "Apple label",
      anonymousId: "synthetic-anonymous-id",
      code: "999999"
    }
  ]);

  const after = (await store.listInventory()).find(
    item => item.email === "used.alias@icloud.com"
  );
  assert.deepEqual(result.created, []);
  assert.equal(result.existing.length, 1);
  assert.equal(after.id, before.id);
  assert.equal(after.group, "finished");
  assert.equal(after.remark, "do not reuse");
  assert.equal(after.label, "Apple label");
  assert.equal(after.code, "123456");
  assert.equal(after.appleLabel, "Apple label");
  assert.equal(after.anonymousId, "synthetic-anonymous-id");
});

test("createInventoryItems writes a whole batch in one atomic state write", async t => {
  const { store } = await makeTemporaryStore(t);
  const mutate = store.mutate.bind(store);
  let writes = 0;
  store.mutate = worker => {
    writes += 1;
    return mutate(worker);
  };

  const result = await store.createInventoryItems(
    Array.from({ length: 5 }, (_, index) => ({
      email: `batch-${index}@icloud.com`,
      label: `hme-20${index}`
    }))
  );

  assert.equal(writes, 1);
  assert.equal(result.created.length, 5);
  assert.equal((await store.listInventory()).length, 5);
});

test("createInventoryItems deduplicates one batch case-insensitively", async t => {
  const { store } = await makeTemporaryStore(t);

  const result = await store.createInventoryItems([
    { email: "dup.alias@icloud.com", label: "hme-301" },
    { email: "DUP.ALIAS@icloud.com", label: "hme-302" }
  ]);

  assert.equal(result.created.length, 1);
  const rows = await store.listInventory();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "hme-301");
});

test("createInventoryItems rejects a malformed batch before writing anything", async t => {
  const { statePath, store } = await makeTemporaryStore(t);

  await assert.rejects(() => store.createInventoryItems("not-a-batch"), {
    code: "BAD_REQUEST"
  });
  await assert.rejects(() => store.createInventoryItems([null]), {
    code: "BAD_REQUEST"
  });
  await assert.rejects(
    () =>
      store.createInventoryItems([
        { email: "valid.alias@icloud.com", label: "hme-401" },
        { email: "not-an-email" }
      ]),
    { code: "BAD_REQUEST" }
  );
  await assert.rejects(
    () =>
      store.createInventoryItems(
        Array.from({ length: 101 }, (_, index) => ({
          email: `bulk-${index}@icloud.com`
        }))
      ),
    { code: "BAD_REQUEST" }
  );

  // A rejected batch must not have created a half-written state file either.
  assert.deepEqual(await store.listInventory(), []);
  await assert.rejects(() => readFile(statePath, "utf8"), { code: "ENOENT" });

  const empty = await store.createInventoryItems([]);
  assert.deepEqual(empty.created, []);
  assert.deepEqual(empty.existing, []);
  assert.deepEqual(empty.inventory, []);
});

test("updateInventoryItems rejects malformed entries and tolerates an empty batch", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);

  await assert.rejects(() => store.updateInventoryItems("not-a-batch"), {
    code: "BAD_REQUEST"
  });
  await assert.rejects(() => store.updateInventoryItems([{ patch: {} }]), {
    code: "BAD_REQUEST"
  });
  await assert.rejects(() => store.updateInventoryItems([["id", null]]), {
    code: "BAD_REQUEST"
  });

  const empty = await store.updateInventoryItems([]);
  assert.deepEqual(empty.updated, []);
  assert.equal(empty.inventory.length, 3);
});

test("deleteInventoryItem removes a trashed address and backs it up first", async t => {
  const { backupDir, store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  const trashed = (await store.listInventory()).find(
    item => item.email === "trash.alias@icloud.com"
  );

  const result = await store.deleteInventoryItem(trashed.id);

  assert.equal(result.deleted.id, trashed.id);
  assert.equal(result.deleted.email, "trash.alias@icloud.com");
  assert.equal(
    (await store.listInventory()).some(item => item.id === trashed.id),
    false
  );
  assert.equal((await store.listInventory()).length, 2);

  const backupFile = (await readdir(backupDir)).find(name =>
    name.startsWith("inventory-deleted-")
  );
  assert.ok(backupFile, "the deleted record must be written to the backup dir");
  const restored = JSON.parse(await readFile(join(backupDir, backupFile), "utf8"));
  assert.equal(restored.item.email, "trash.alias@icloud.com");
  assert.equal(restored.item.remark, "discarded");
  assert.equal(restored.deletedAt, "2026-07-25T10:11:12.345Z");
});

test("deleteInventoryItem refuses anything outside the trash group", async t => {
  const { backupDir, store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);

  for (const email of ["unused.alias@icloud.com", "used.alias@icloud.com"]) {
    const item = (await store.listInventory()).find(row => row.email === email);
    await assert.rejects(() => store.deleteInventoryItem(item.id), {
      code: "INVENTORY_NOT_IN_TRASH",
      status: 409
    });
  }

  assert.equal((await store.listInventory()).length, 3);
  assert.equal(
    (await readdir(backupDir)).some(name => name.startsWith("inventory-deleted-")),
    false
  );
});

test("deleteInventoryItem refuses a row that a claim still holds", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  const trashed = (await store.listInventory()).find(
    item => item.email === "trash.alias@icloud.com"
  );
  await store.mutate(state => {
    state.inventory.find(item => item.id === trashed.id).activeClaimId = "claim-1";
  });

  await assert.rejects(() => store.deleteInventoryItem(trashed.id), {
    code: "CLAIM_ACTIVE",
    status: 409
  });
  assert.equal((await store.listInventory()).length, 3);
});

test("deleteInventoryItem rejects a missing id and an unknown id", async t => {
  const { store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);

  await assert.rejects(() => store.deleteInventoryItem(""), {
    code: "BAD_REQUEST",
    status: 400
  });
  await assert.rejects(() => store.deleteInventoryItem("does-not-exist"), {
    code: "INVENTORY_NOT_FOUND",
    status: 404
  });
  assert.equal((await store.listInventory()).length, 3);
});

test("two deletions in the same millisecond do not collide on the backup name", async t => {
  const { backupDir, store } = await makeTemporaryStore(t);
  await store.initializeFromLegacy(legacyFixture);
  await store.createInventoryItems([
    { email: "second.trash@icloud.com", label: "hme-004" }
  ]);
  await store.updateInventoryItems([
    [
      (await store.listInventory()).find(
        item => item.email === "second.trash@icloud.com"
      ).id,
      { group: "trash" }
    ]
  ]);

  const trashedIds = (await store.listInventory())
    .filter(item => item.group === "trash")
    .map(item => item.id);
  assert.equal(trashedIds.length, 2);

  for (const id of trashedIds) {
    await store.deleteInventoryItem(id);
  }

  const backups = (await readdir(backupDir)).filter(name =>
    name.startsWith("inventory-deleted-")
  );
  assert.equal(backups.length, 2);
  assert.equal((await store.listInventory()).length, 2);
});

test("a claim still in use is never archived, however old it is", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    inventory: [
      {
        id: "row-held",
        email: "held.alias@icloud.com",
        group: "finished",
        activeClaimId: "claim-held"
      }
    ],
    claims: [
      // Active since January: age alone must never be enough.
      claimRecord("claim-active", {
        status: "active",
        releasedAt: null,
        releaseReason: ""
      }),
      // Half-written: a stale `releasedAt` next to `status: "active"`. Status
      // is what `getActiveClaim` gates mail polling on, so status wins and the
      // claim stays.
      claimRecord("claim-active-stamped", { status: "active" }),
      // Marked released long ago, but an inventory row still points at it. If
      // this were archived the address could never be handed out again.
      claimRecord("claim-held", { emailId: "row-held" })
    ]
  });

  await store.mutate(() => {});

  assert.deepEqual(
    (await store.read()).claims.map(claim => claim.claimId),
    ["claim-active", "claim-active-stamped", "claim-held"]
  );
  assert.equal(await exists(archiveDir), false);
});

test("a claim the store cannot date or identify stays in the state file", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    claims: [
      // No usable release timestamp, so there is no way to tell whether it is
      // past the window.
      claimRecord("claim-undatable", { releasedAt: "not-a-date" }),
      claimRecord("claim-no-stamp", { releasedAt: null }),
      // Without a claimId the archive cannot deduplicate the row, which is
      // what makes a repeated sweep idempotent.
      claimRecord("", { email: "no.id@icloud.com" })
    ]
  });

  await store.mutate(() => {});

  assert.deepEqual(
    (await store.read()).claims.map(claim => claim.claimId),
    ["claim-undatable", "claim-no-stamp", ""]
  );
  assert.equal(await exists(archiveDir), false);
});

test("an expired released claim moves into the dated archive file", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    claims: [
      claimRecord("claim-old"),
      // Released five days ago, comfortably inside the 30 day window.
      claimRecord("claim-recent", { releasedAt: "2026-07-20T00:00:00.000Z" })
    ]
  });

  await store.mutate(() => {});

  const state = await store.read();
  assert.deepEqual(state.claims.map(claim => claim.claimId), ["claim-recent"]);

  assert.deepEqual(await readdir(archiveDir), [ARCHIVE_FILE]);
  const archive = await readArchive(archiveDir);
  assert.equal(archive.version, 1);
  assert.equal(archive.date, "2026-07-25");
  assert.equal(archive.claims.length, 1);
  assert.equal(archive.claims[0].claimId, "claim-old");
  assert.equal(archive.claims[0].email, "claim-old@icloud.com");
  assert.equal(archive.claims[0].releaseReason, "done");
  assert.equal(archive.claims[0].archivedAt, "2026-07-25T10:11:12.345Z");
});

test("an idempotency key is archived together with the claim it points at", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    claims: [
      claimRecord("claim-old"),
      claimRecord("claim-recent", { releasedAt: "2026-07-20T00:00:00.000Z" })
    ],
    idempotency: {
      "key-claim-old": "claim-old",
      "key-claim-recent": "claim-recent",
      // A key whose claim is already gone can never resolve again; leaving it
      // behind makes every retry of that key fail forever.
      "key-dangling": "claim-that-never-existed",
      // Computed on purpose: a bare `__proto__:` in an object literal is the
      // prototype setter, while this is the real own property that JSON.parse
      // hands the store when the key arrives from disk. The archive must not
      // lose it to the inherited setter on the way out.
      ["__proto__"]: "claim-that-never-existed"
    }
  });

  await store.mutate(() => {});

  const state = await store.read();
  assert.deepEqual(Object.keys(state.idempotency), ["key-claim-recent"]);

  const archive = await readArchive(archiveDir);
  assert.deepEqual(Object.keys(archive.idempotency).sort(), [
    "__proto__",
    "key-claim-old",
    "key-dangling"
  ]);
  assert.equal(archive.idempotency["key-claim-old"], "claim-old");
});

test("reading state never archives anything", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  const raw = await writeStateFile(statePath, {
    claims: [claimRecord("claim-old")],
    idempotency: { "key-claim-old": "claim-old" }
  });

  assert.deepEqual(
    (await store.read()).claims.map(claim => claim.claimId),
    ["claim-old"]
  );
  await store.listInventory();

  assert.equal(await exists(archiveDir), false);
  assert.equal(await readFile(statePath, "utf8"), raw);
});

test("the archive directory and its files stay owner-only", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, { claims: [claimRecord("claim-old")] });

  await store.mutate(() => {});

  const archivePath = join(archiveDir, ARCHIVE_FILE);
  assert.equal(await exists(archivePath), true);
  // Windows does not model POSIX permission bits at all, so the assertion runs
  // where it can actually distinguish 0o600 from 0o644.
  if (process.platform !== "win32") {
    assert.equal((await stat(archiveDir)).mode & 0o777, 0o700);
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
  }
  // No temporary file may survive the rename.
  assert.deepEqual(await readdir(archiveDir), [ARCHIVE_FILE]);
});

test("a blocked archive path fails the whole mutate instead of dropping history", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  const raw = await writeStateFile(statePath, {
    claims: [claimRecord("claim-old")],
    idempotency: { "key-claim-old": "claim-old" }
  });
  // A plain file where the directory belongs: mkdir cannot create the archive.
  await mkdir(dirname(archiveDir), { recursive: true });
  await writeFile(archiveDir, "not a directory", "utf8");

  await assert.rejects(
    () => store.mutate(state => state.inventory.push({ id: "x" })),
    { code: "STORAGE_ERROR", status: 500 }
  );

  // The state file must be byte-identical: no half-write, and above all the
  // claim and its key are still there rather than deleted with nowhere to
  // recover them from.
  assert.equal(await readFile(statePath, "utf8"), raw);
});

test("a corrupt archive file is never overwritten", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  const raw = await writeStateFile(statePath, {
    claims: [claimRecord("claim-old")]
  });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, ARCHIVE_FILE), "{not-json", "utf8");

  await assert.rejects(() => store.mutate(() => {}), {
    code: "STORAGE_ERROR",
    status: 500
  });

  assert.equal(
    await readFile(join(archiveDir, ARCHIVE_FILE), "utf8"),
    "{not-json"
  );
  assert.equal(await readFile(statePath, "utf8"), raw);
});

test("archiving the same rows twice converges instead of duplicating", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    claims: [claimRecord("claim-old")],
    idempotency: { "key-claim-old": "claim-old" }
  });

  await store.mutate(() => {});
  const afterFirst = await readFile(join(archiveDir, ARCHIVE_FILE), "utf8");

  // A second sweep with nothing left to do must not touch the archive at all.
  await store.mutate(() => {});
  assert.equal(
    await readFile(join(archiveDir, ARCHIVE_FILE), "utf8"),
    afterFirst
  );

  // And the case that actually happens: the archive write landed but the state
  // write behind it did not, so the same claim comes back around.
  await store.mutate(state => {
    state.claims.push(claimRecord("claim-old"));
    state.idempotency["key-claim-old"] = "claim-old";
  });

  assert.deepEqual(await readdir(archiveDir), [ARCHIVE_FILE]);
  const archive = await readArchive(archiveDir);
  assert.deepEqual(archive.claims.map(claim => claim.claimId), ["claim-old"]);
  assert.deepEqual(Object.keys(archive.idempotency), ["key-claim-old"]);
  const state = await store.read();
  assert.deepEqual(state.claims, []);
  assert.deepEqual(state.idempotency, {});
});

test("a later sweep adds to the day's archive instead of replacing it", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    claims: [claimRecord("claim-first")],
    idempotency: {
      "key-claim-first": "claim-first",
      // Lands in the archive file as a real own property, so the merge below
      // has to read it back off disk without losing it to the inherited
      // setter on the way through.
      ["__proto__"]: "claim-that-never-existed"
    }
  });
  await store.mutate(() => {});

  // A second, unrelated expired claim swept on the same calendar day. The rows
  // from the first sweep are only on disk now, so merging is the only way they
  // can survive this write.
  await store.mutate(state => {
    state.claims.push(claimRecord("claim-second"));
    state.idempotency["key-claim-second"] = "claim-second";
  });

  assert.deepEqual(await readdir(archiveDir), [ARCHIVE_FILE]);
  const archive = await readArchive(archiveDir);
  assert.deepEqual(archive.claims.map(claim => claim.claimId).sort(), [
    "claim-first",
    "claim-second"
  ]);
  assert.equal(
    archive.claims.find(claim => claim.claimId === "claim-first").email,
    "claim-first@icloud.com"
  );
  assert.deepEqual(Object.keys(archive.idempotency).sort(), [
    "__proto__",
    "key-claim-first",
    "key-claim-second"
  ]);
  assert.equal(archive.idempotency["key-claim-first"], "claim-first");

  const state = await store.read();
  assert.deepEqual(state.claims, []);
  assert.deepEqual(state.idempotency, {});
});

test("the retention window is configurable and rejects nonsense", async t => {
  const seed = {
    claims: [claimRecord("claim-10-days", {
      releasedAt: "2026-07-15T00:00:00.000Z"
    })]
  };

  const shortWindow = await makeTemporaryStore(t, {
    env: { MAIL_DASHBOARD_ARCHIVE_RETENTION_DAYS: "7" }
  });
  await writeStateFile(shortWindow.statePath, seed);
  await shortWindow.store.mutate(() => {});
  assert.deepEqual((await shortWindow.store.read()).claims, []);
  assert.deepEqual(
    (await readArchive(shortWindow.archiveDir)).claims.map(c => c.claimId),
    ["claim-10-days"]
  );

  // A typo must not shrink the window; it falls back to the 30 day default,
  // which keeps a claim released ten days ago.
  for (const value of ["not-a-number", "-1", ""]) {
    const fallback = await makeTemporaryStore(t, {
      env: { MAIL_DASHBOARD_ARCHIVE_RETENTION_DAYS: value }
    });
    await writeStateFile(fallback.statePath, seed);
    await fallback.store.mutate(() => {});
    assert.deepEqual(
      (await fallback.store.read()).claims.map(claim => claim.claimId),
      ["claim-10-days"],
      `retention "${value}" must fall back to the default window`
    );
    assert.equal(await exists(fallback.archiveDir), false);
  }
});

test("released claims survive a release and are archived only once expired", async t => {
  const { archiveDir, statePath, store } = await makeTemporaryStore(t);
  await writeStateFile(statePath, {
    inventory: [
      {
        id: "row-1",
        email: "row.alias@icloud.com",
        group: "finished",
        activeClaimId: "claim-live"
      }
    ],
    claims: [
      claimRecord("claim-live", {
        emailId: "row-1",
        status: "active",
        releasedAt: null
      })
    ]
  });

  // Release it through a mutate: the claim is now released but brand new, so
  // the sweep in that very same mutate must leave it alone.
  await store.mutate(state => {
    const claim = state.claims[0];
    claim.status = "released";
    claim.releasedAt = "2026-07-25T10:11:12.345Z";
    state.inventory[0].activeClaimId = "";
    state.inventory[0].group = "unused";
  });

  assert.deepEqual(
    (await store.read()).claims.map(claim => claim.claimId),
    ["claim-live"]
  );
  assert.equal(await exists(archiveDir), false);
});
