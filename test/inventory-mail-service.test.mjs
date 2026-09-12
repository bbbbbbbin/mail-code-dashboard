import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DashboardStore } from "../lib/dashboard-store.mjs";
import { ForwardMailboxReader } from "../lib/forward-mailbox.mjs";
import { InventoryMailService } from "../lib/inventory-mail-service.mjs";

function inventory(id, email, group, overrides = {}) {
  return {
    id,
    email,
    group,
    source: "icloud-hme",
    label: id,
    remark: id,
    appleLabel: id,
    anonymousId: "",
    isActive: true,
    activeClaimId: "",
    code: "",
    subject: "",
    preview: "",
    receivedAt: "",
    unread: false,
    statusType: "ok",
    statusMessage: "",
    lastCheckedAt: "",
    lastMethod: "",
    noCodeReason: "",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides
  };
}

function message(overrides = {}) {
  return {
    id: "Junk:20",
    mailbox: "Junk",
    uid: 20,
    from: "sender@example.test",
    subject: "Confirm your email",
    receivedAt: "2026-07-25T12:00:00.000Z",
    text: "Use code 123456 and open https://example.test/confirm",
    html: "<p>Use code 123456</p>",
    codes: ["123456"],
    links: ["https://example.test/confirm"],
    primaryLink: "https://example.test/confirm",
    ...overrides
  };
}

function forwardedMessage(alias, code) {
  return [
    "From: Sender <sender@example.test>",
    "To: Forwarding Inbox <forwarding@example.test>",
    `Delivered-To: ${alias}`,
    `Subject: Synthetic verification code ${code}`,
    "Date: Sat, 26 Jul 2026 01:00:00 +0000",
    `Message-ID: <${code}@example.test>`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    `Use code ${code} to verify the synthetic account.`,
    ""
  ].join("\r\n");
}

class ContractImapClient {
  constructor(messages) {
    this.messages = messages;
    this.currentMailbox = null;
  }

  on() {
    return this;
  }

  async connect() {}

  async mailboxOpen(mailbox) {
    this.currentMailbox = mailbox;
  }

  async search() {
    return this.messages.map(item => item.uid);
  }

  fetch(uids) {
    const requested = new Set(uids);
    const messages = this.messages.filter(item => requested.has(item.uid));
    return (async function* iterate() {
      for (const item of messages) {
        yield { uid: item.uid, source: Buffer.from(item.raw) };
      }
    })();
  }

  async logout() {}
}

async function realMailboxReader(t, messages) {
  const directory = await mkdtemp(join(tmpdir(), "inventory-mail-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "mail-forward.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      host: "imap.example.test",
      port: 993,
      secure: true,
      email: "forwarding@example.test",
      password: "synthetic-app-password",
      mailboxes: ["INBOX"],
      messageLimit: 1,
      pollIntervalMs: 1_000
    }),
    "utf8"
  );
  const client = new ContractImapClient(messages);
  return new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });
}

async function makeService(t, rows, mailboxReader) {
  const directory = await mkdtemp(join(tmpdir(), "inventory-mail-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = () => new Date("2026-07-26T02:00:00.000Z");
  const store = new DashboardStore({
    statePath: join(directory, "dashboard-state-v1.json"),
    backupDir: join(directory, "backups"),
    now,
    randomUUID: () => "inventory-generated"
  });
  await store.mutate(state => {
    state.inventory = rows;
  });
  return {
    store,
    service: new InventoryMailService({ store, mailboxReader, now })
  };
}

test("checkOne reads exactly one alias and persists its mail summary", async t => {
  const calls = [];
  const mailboxReader = {
    async latestForAlias(email, options) {
      calls.push([email, options]);
      return message();
    }
  };
  const { service, store } = await makeService(
    t,
    [inventory("hme-001", "alias1@icloud.com", "unused")],
    mailboxReader
  );

  const result = await service.checkOne("hme-001");
  const persisted = (await store.listInventory())[0];

  assert.deepEqual(calls, [["alias1@icloud.com", { waitSeconds: 0 }]]);
  assert.equal(result.checked, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.moved, 1);
  assert.equal(result.disposition, "applied");
  assert.equal(result.message.primaryLink, "https://example.test/confirm");
  assert.equal(persisted.group, "finished");
  assert.equal(persisted.subject, "Confirm your email");
  assert.equal(persisted.code, "123456");
  assert.equal(persisted.unread, true);
  assert.equal(persisted.lastMethod, "Forward IMAP/Junk");
  assert.equal(persisted.noCodeReason, "");
  assert.equal(persisted.statusType, "ok");
  assert.equal(persisted.lastCheckedAt, "2026-07-26T02:00:00.000Z");
});

test("checkOne never restores a trash item when mail is found", async t => {
  const mailboxReader = {
    async latestForAlias() {
      return message();
    }
  };
  const { service, store } = await makeService(
    t,
    [inventory("hme-trash", "trash@icloud.com", "trash")],
    mailboxReader
  );

  const result = await service.checkOne("hme-trash");
  const persisted = (await store.listInventory())[0];

  assert.equal(result.updated, 1);
  assert.equal(result.moved, 0);
  assert.equal(persisted.group, "trash");
  assert.equal(persisted.subject, "Confirm your email");
});

test("checkOne persists a final no-message status without changing group", async t => {
  const mailboxReader = {
    async latestForAlias() {
      return null;
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("hme-002", "alias2@icloud.com", "finished", {
        statusType: "checking",
        statusMessage: "收件中"
      })
    ],
    mailboxReader
  );

  const result = await service.checkOne("hme-002");
  const persisted = (await store.listInventory())[0];

  assert.equal(result.updated, 0);
  assert.equal(result.moved, 0);
  assert.equal(result.message, null);
  assert.equal(persisted.group, "finished");
  assert.equal(persisted.statusType, "ok");
  assert.equal(persisted.statusMessage, "检查完成，暂无匹配邮件");
  assert.equal(persisted.lastCheckedAt, "2026-07-26T02:00:00.000Z");
});

test("checkOne propagates a store update failure without attempting a second write", async () => {
  const storeError = new Error("state write failed");
  let updateCalls = 0;
  const row = inventory("store-failure", "store-failure@icloud.com", "unused");
  const store = {
    async listInventory() {
      return [row];
    },
    async updateInventoryItems() {
      updateCalls += 1;
      throw storeError;
    }
  };
  const service = new InventoryMailService({
    store,
    mailboxReader: {
      async latestForAlias() {
        return message();
      }
    }
  });

  await assert.rejects(
    () => service.checkOne("store-failure"),
    error => error === storeError
  );
  assert.equal(updateCalls, 1);
});

test("checkOne leaves a row moved to trash untouched while IMAP is in flight", async t => {
  let releaseScan;
  const scanned = new Promise(resolve => {
    releaseScan = resolve;
  });
  const mailboxReader = {
    async latestForAlias() {
      return scanned;
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("single-race", "race@icloud.com", "unused", {
        subject: "Summary before scan",
        code: "111111"
      })
    ],
    mailboxReader
  );

  const scan = service.checkOne("single-race");
  await store.updateInventoryItem("single-race", { group: "trash" });
  releaseScan(message({ subject: "Stale in-flight summary", codes: ["999999"] }));
  const result = await scan;
  const persisted = (await store.listInventory())[0];

  assert.equal(persisted.group, "trash");
  assert.equal(persisted.subject, "Summary before scan");
  assert.equal(persisted.code, "111111");
  assert.equal(result.updated, 0);
  assert.equal(result.moved, 0);
  assert.equal(result.disposition, "skipped");
  assert.deepEqual(result.errors, []);
  assert.equal(result.message, null);
  assert.deepEqual(result.inventoryItem, persisted);
});

test("checkOne resolves a row deleted while IMAP is in flight without reviving it", async t => {
  let releaseScan;
  const scanned = new Promise(resolve => {
    releaseScan = resolve;
  });
  const mailboxReader = {
    async latestForAlias() {
      return scanned;
    }
  };
  const { service, store } = await makeService(
    t,
    [inventory("single-deleted", "deleted@icloud.com", "unused")],
    mailboxReader
  );

  const scan = service.checkOne("single-deleted");
  await store.updateInventoryItem("single-deleted", { group: "trash" });
  await store.deleteInventoryItem("single-deleted");
  releaseScan(message());
  const result = await scan;

  assert.deepEqual(await store.listInventory(), []);
  assert.equal(result.updated, 0);
  assert.equal(result.moved, 0);
  assert.equal(result.disposition, "missing");
  assert.deepEqual(result.errors, []);
  assert.equal(result.message, null);
  assert.equal(result.inventoryItem, null);
});

test("checkOne does not report a stale IMAP error after the row changes group", async t => {
  let rejectScan;
  const scanned = new Promise((_resolve, reject) => {
    rejectScan = reject;
  });
  const mailboxReader = {
    async latestForAlias() {
      return scanned;
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("rejected-skip", "rejected-skip@icloud.com", "finished", {
        statusType: "ok",
        statusMessage: "Existing status"
      })
    ],
    mailboxReader
  );

  const scan = service.checkOne("rejected-skip");
  await store.updateInventoryItem("rejected-skip", { group: "trash" });
  rejectScan(new Error("mailbox unavailable"));
  const result = await scan;
  const persisted = (await store.listInventory())[0];

  assert.equal(result.disposition, "skipped");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.inventoryItem, persisted);
  assert.equal(persisted.group, "trash");
  assert.equal(persisted.statusType, "ok");
  assert.equal(persisted.statusMessage, "Existing status");
});

test("checkOne does not report a stale IMAP error after the row is deleted", async t => {
  let rejectScan;
  const scanned = new Promise((_resolve, reject) => {
    rejectScan = reject;
  });
  const mailboxReader = {
    async latestForAlias() {
      return scanned;
    }
  };
  const { service, store } = await makeService(
    t,
    [inventory("rejected-missing", "rejected-missing@icloud.com", "unused")],
    mailboxReader
  );

  const scan = service.checkOne("rejected-missing");
  await store.updateInventoryItem("rejected-missing", { group: "trash" });
  await store.deleteInventoryItem("rejected-missing");
  rejectScan(new Error("mailbox unavailable"));
  const result = await scan;

  assert.equal(result.disposition, "missing");
  assert.deepEqual(result.errors, []);
  assert.equal(result.inventoryItem, null);
  assert.deepEqual(await store.listInventory(), []);
});

test("checkFinished reads only active finished aliases and coalesces concurrent batches", async t => {
  let resolveBatch;
  const batchResult = new Promise(resolve => {
    resolveBatch = resolve;
  });
  const calls = [];
  const mailboxReader = {
    async latestForAliases(emails) {
      calls.push(emails);
      return batchResult;
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("hme-001", "first@icloud.com", "finished"),
      inventory("hme-002", "unused@icloud.com", "unused"),
      inventory("hme-003", "inactive@icloud.com", "finished", {
        isActive: false
      }),
      inventory("hme-004", "second@icloud.com", "finished")
    ],
    mailboxReader
  );

  const first = service.checkFinished();
  const second = service.checkFinished();
  for (let attempt = 0; attempt < 20 && !calls.length; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls, [["first@icloud.com", "second@icloud.com"]]);

  resolveBatch({
    messages: {
      "first@icloud.com": message({ subject: "First message" })
    },
    scanned: 40,
    available: 40,
    truncated: false
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.checked, 2);
  assert.equal(firstResult.updated, 1);
  assert.equal(firstResult.scanned, 40);
  assert.equal(firstResult.available, 40);
  assert.equal(firstResult.truncated, false);
  const rows = await store.listInventory();
  assert.equal(
    rows.find(item => item.id === "hme-001").subject,
    "First message"
  );
  assert.equal(
    rows.find(item => item.id === "hme-004").statusMessage,
    "检查完成，暂无匹配邮件"
  );
  assert.equal(rows.find(item => item.id === "hme-002").lastCheckedAt, "");
  assert.equal(rows.find(item => item.id === "hme-003").lastCheckedAt, "");
});

test("checkUnused scans only active unused aliases and coalesces concurrent batches", async t => {
  let resolveBatch;
  const batchResult = new Promise(resolve => {
    resolveBatch = resolve;
  });
  const calls = [];
  const mailboxReader = {
    async latestForAliases(emails) {
      calls.push(emails);
      return batchResult;
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("unused-1", "unused1@icloud.com", "unused"),
      inventory("unused-2", "unused2@icloud.com", "unused"),
      inventory("inactive-1", "inactive@icloud.com", "unused", {
        isActive: false
      }),
      inventory("finished-1", "finished@icloud.com", "finished"),
      inventory("trash-1", "trash@icloud.com", "trash")
    ],
    mailboxReader
  );

  const first = service.checkUnused();
  const second = service.checkUnused();
  for (let attempt = 0; attempt < 20 && !calls.length; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls, [["unused1@icloud.com", "unused2@icloud.com"]]);

  resolveBatch({
    messages: {
      "unused1@icloud.com": message({ subject: "Matched unused message" })
    },
    scanned: 100,
    available: 260,
    truncated: true
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  const rowsById = new Map(
    (await store.listInventory()).map(item => [item.id, item])
  );

  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.checked, 2);
  assert.equal(firstResult.updated, 1);
  assert.equal(firstResult.moved, 1);
  assert.deepEqual(firstResult.errors, []);
  assert.equal(rowsById.get("unused-1").group, "finished");
  assert.equal(rowsById.get("unused-1").subject, "Matched unused message");
  assert.equal(rowsById.get("unused-2").group, "unused");
  assert.equal(
    rowsById.get("unused-2").statusMessage,
    "检查完成，暂无匹配邮件"
  );
  assert.equal(rowsById.get("inactive-1").lastCheckedAt, "");
  assert.equal(rowsById.get("finished-1").lastCheckedAt, "");
  assert.equal(rowsById.get("trash-1").group, "trash");
  // unused-2 shows "暂无匹配邮件", but 160 of 260 messages were never read, so
  // the caller must be able to tell the operator that verdict is not final.
  assert.equal(firstResult.scanned, 100);
  assert.equal(firstResult.available, 260);
  assert.equal(firstResult.truncated, true);
});

test("checkUnused consumes the real mailbox reader batch contract", async t => {
  const alias = "contract@icloud.com";
  const mailboxReader = await realMailboxReader(t, [
    {
      uid: 1,
      raw: forwardedMessage("older@icloud.com", "111111")
    },
    {
      uid: 2,
      raw: forwardedMessage(alias, "654321")
    }
  ]);
  const { service, store } = await makeService(
    t,
    [inventory("contract-row", alias, "unused")],
    mailboxReader
  );

  const result = await service.checkUnused();
  const persisted = (await store.listInventory())[0];

  assert.equal(result.updated, 1);
  assert.equal(result.moved, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.available, 2);
  assert.equal(result.truncated, true);
  assert.equal(persisted.group, "finished");
  assert.equal(persisted.subject, "Synthetic verification code 654321");
  assert.equal(persisted.code, "654321");
});

test("an empty group reports an empty scan window without touching IMAP", async t => {
  let calls = 0;
  const mailboxReader = {
    async latestForAliases() {
      calls += 1;
      return { messages: {}, scanned: 0, available: 0, truncated: false };
    }
  };
  const { service } = await makeService(
    t,
    [inventory("finished-1", "finished@icloud.com", "finished")],
    mailboxReader
  );

  const result = await service.checkUnused();

  assert.equal(calls, 0);
  assert.equal(result.checked, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.available, 0);
  assert.equal(result.truncated, false);
});

test("a failed IMAP batch reports an empty scan window", async t => {
  const mailboxReader = {
    async latestForAliases() {
      throw new Error("mailbox unavailable");
    }
  };
  const { service } = await makeService(
    t,
    [inventory("unused-1", "unused1@icloud.com", "unused")],
    mailboxReader
  );

  const result = await service.checkUnused();

  assert.equal(result.errors.length, 1);
  assert.equal(result.scanned, 0);
  assert.equal(result.available, 0);
  assert.equal(
    result.truncated,
    false,
    "an unreachable mailbox is an error, not a truncated window"
  );
});

test("a reader without scan stats still resolves its messages", async t => {
  const mailboxReader = {
    async latestForAliases(emails) {
      // The bare {alias: message} shape must not degrade every row to
      // "暂无匹配邮件" just because the scan window is missing.
      return Object.fromEntries(
        emails.map(email => [email.toLowerCase(), message()])
      );
    }
  };
  const { service, store } = await makeService(
    t,
    [inventory("unused-1", "unused1@icloud.com", "unused")],
    mailboxReader
  );

  const result = await service.checkUnused();

  assert.equal(result.updated, 1);
  assert.equal(result.truncated, false);
  assert.equal((await store.listInventory())[0].group, "finished");
});

test("checkUnused preserves every unused group when the IMAP batch fails", async t => {
  const mailboxReader = {
    async latestForAliases() {
      throw new Error("mailbox unavailable");
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("unused-1", "unused1@icloud.com", "unused"),
      inventory("unused-2", "unused2@icloud.com", "unused")
    ],
    mailboxReader
  );

  const result = await service.checkUnused();
  const rows = await store.listInventory();

  assert.equal(result.checked, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.moved, 0);
  assert.equal(result.errors.length, 2);
  assert.equal(rows.every(item => item.group === "unused"), true);
  assert.equal(rows.every(item => item.statusType === "error"), true);
});

class CountingStore extends DashboardStore {
  stateWrites = 0;

  mutate(worker) {
    this.stateWrites += 1;
    return super.mutate(worker);
  }
}

async function makeCountingService(t, rows, mailboxReader) {
  const directory = await mkdtemp(join(tmpdir(), "inventory-mail-batch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = () => new Date("2026-07-26T02:00:00.000Z");
  const store = new CountingStore({
    statePath: join(directory, "dashboard-state-v1.json"),
    backupDir: join(directory, "backups"),
    now,
    randomUUID: () => "inventory-generated"
  });
  await store.mutate(state => {
    state.inventory = rows;
  });
  store.stateWrites = 0;
  return {
    store,
    service: new InventoryMailService({ store, mailboxReader, now })
  };
}

test("checkUnused writes the batch once instead of once per row", async t => {
  const rows = Array.from({ length: 25 }, (_, index) =>
    inventory(`unused-${index}`, `unused${index}@icloud.com`, "unused")
  );
  const mailboxReader = {
    async latestForAliases(emails) {
      return Object.fromEntries(
        emails.map((email, index) => [
          email.toLowerCase(),
          message({ subject: `Message ${index}` })
        ])
      );
    }
  };
  const { service, store } = await makeCountingService(t, rows, mailboxReader);

  const result = await service.checkUnused();

  assert.equal(result.checked, 25);
  assert.equal(result.updated, 25);
  assert.equal(result.moved, 25);
  assert.equal(
    store.stateWrites,
    1,
    "a 25-row scan must not rewrite the state file 25 times"
  );
  const persisted = await store.listInventory();
  assert.equal(persisted.every(item => item.group === "finished"), true);
});

test("a failed IMAP batch also records every error in one write", async t => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    inventory(`unused-${index}`, `unused${index}@icloud.com`, "unused")
  );
  const mailboxReader = {
    async latestForAliases() {
      throw new Error("mailbox unavailable");
    }
  };
  const { service, store } = await makeCountingService(t, rows, mailboxReader);

  const result = await service.checkUnused();

  assert.equal(result.errors.length, 10);
  assert.equal(store.stateWrites, 1);
  const persisted = await store.listInventory();
  assert.equal(persisted.every(item => item.statusType === "error"), true);
  assert.equal(persisted.every(item => item.group === "unused"), true);
});

test("a row moved to trash mid-scan keeps its new group", async t => {
  let releaseScan;
  const scanned = new Promise(resolve => {
    releaseScan = resolve;
  });
  const mailboxReader = {
    async latestForAliases(emails) {
      return scanned.then(() =>
        Object.fromEntries(
          emails.map(email => [email.toLowerCase(), message()])
        )
      );
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("stays", "stays@icloud.com", "unused"),
      inventory("moved", "moved@icloud.com", "unused")
    ],
    mailboxReader
  );

  const scan = service.checkUnused();
  // The operator trashes a row while the IMAP scan is still in flight.
  await store.updateInventoryItem("moved", { group: "trash" });
  releaseScan();
  const result = await scan;

  const rowsById = new Map(
    (await store.listInventory()).map(item => [item.id, item])
  );
  assert.equal(rowsById.get("stays").group, "finished");
  assert.equal(
    rowsById.get("moved").group,
    "trash",
    "a stale batch snapshot must not resurrect a trashed row"
  );
  assert.equal(result.checked, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.moved, 1);
});

test("a repeated scan does not mark an already read row unread again", async t => {
  const stored = message({ receivedAt: "2026-07-25T12:00:00.000Z" });
  const mailboxReader = {
    async latestForAliases(emails) {
      return Object.fromEntries(
        emails.map(email => [email.toLowerCase(), stored])
      );
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("read-row", "read@icloud.com", "finished", {
        receivedAt: "2026-07-25T12:00:00.000Z",
        unread: false,
        subject: "Confirm your email"
      })
    ],
    mailboxReader
  );

  await service.checkFinished();
  const persisted = (await store.listInventory())[0];

  assert.equal(
    persisted.unread,
    false,
    "re-reading the same message must not flip the row back to unread"
  );
  assert.equal(persisted.lastCheckedAt, "2026-07-26T02:00:00.000Z");
});

test("a genuinely newer message still raises the unread flag", async t => {
  const mailboxReader = {
    async latestForAliases(emails) {
      return Object.fromEntries(
        emails.map(email => [
          email.toLowerCase(),
          message({
            receivedAt: "2026-07-26T01:00:00.000Z",
            subject: "Newer message"
          })
        ])
      );
    }
  };
  const { service, store } = await makeService(
    t,
    [
      inventory("stale-row", "stale@icloud.com", "finished", {
        receivedAt: "2026-07-25T12:00:00.000Z",
        unread: false
      })
    ],
    mailboxReader
  );

  await service.checkFinished();
  const persisted = (await store.listInventory())[0];

  assert.equal(persisted.unread, true);
  assert.equal(persisted.subject, "Newer message");
});
