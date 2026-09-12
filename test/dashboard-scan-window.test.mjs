import test from "node:test";
import assert from "node:assert/strict";

import {
  checkInventoryMail,
  mailBatchNotice,
  runMailBatch
} from "../assets/dashboard-mail.js";

function batchHarness(response) {
  const notifications = [];
  const state = {
    accounts: [],
    labelNumbers: new Map(),
    mailBatchBusy: false
  };
  return {
    context: {
      state,
      async apiFetch() {
        return response;
      },
      async readApiEnvelope(value) {
        return value;
      },
      async withBusy(_button, worker) {
        return worker();
      },
      setBatchProgress() {},
      invalidateMessageCache() {},
      render() {},
      notify(...args) {
        notifications.push(args);
      }
    },
    notifications,
    state
  };
}

function singleHarness(response, accounts) {
  const notifications = [];
  const invalidated = [];
  const state = {
    accounts: accounts.map(account => ({ ...account })),
    busyEmails: new Set()
  };
  return {
    context: {
      state,
      mailDialog: {},
      async apiFetch() {
        return response;
      },
      async readApiEnvelope(value) {
        return value;
      },
      async withBusy(_button, worker) {
        return worker();
      },
      invalidateMessageCache(id) {
        invalidated.push(id);
      },
      cacheMessage() {},
      renderClaimMessage() {},
      openDialog() {},
      render() {},
      notify(...args) {
        notifications.push(args);
      }
    },
    invalidated,
    notifications,
    state
  };
}

test("checkInventoryMail warns when a changed row skips the scan result", async () => {
  const inventoryItem = {
    id: "changed-row",
    email: "changed@icloud.com",
    group: "trash"
  };
  const original = {
    id: "changed-row",
    email: "changed@icloud.com",
    group: "unused",
    statusMessage: "Existing status"
  };
  const harness = singleHarness(
    {
      disposition: "skipped",
      inventoryItem,
      message: null,
      errors: []
    },
    [original]
  );

  await checkInventoryMail(harness.context, original, {});

  assert.deepEqual(harness.state.accounts, [inventoryItem]);
  assert.deepEqual(harness.invalidated, ["changed-row"]);
  assert.equal(harness.notifications.length, 1);
  const [title, message, tone] = harness.notifications[0];
  assert.equal(title, "状态已变化");
  assert.match(message, /扫描结果未写入/);
  assert.doesNotMatch(message, /暂无匹配邮件/);
  assert.equal(tone, "warn");
});

test("checkInventoryMail warns when the row disappeared during the scan", async () => {
  const original = {
    id: "deleted-row",
    email: "deleted@icloud.com",
    statusMessage: "Existing status"
  };
  const harness = singleHarness(
    {
      disposition: "missing",
      inventoryItem: null,
      message: null,
      errors: []
    },
    [original]
  );

  await checkInventoryMail(harness.context, original, {});

  assert.deepEqual(harness.state.accounts, []);
  assert.deepEqual(harness.invalidated, ["deleted-row"]);
  assert.equal(harness.notifications.length, 1);
  const [title, message, tone] = harness.notifications[0];
  assert.equal(title, "状态已变化");
  assert.match(message, /记录已删除.*扫描结果未写入/);
  assert.doesNotMatch(message, /暂无匹配邮件/);
  assert.equal(tone, "warn");
});

test("checkInventoryMail reports an applied mailbox error instead of an empty inbox", async () => {
  const original = {
    id: "mailbox-error",
    email: "mailbox-error@icloud.com",
    statusType: "checking",
    statusMessage: "正在检查"
  };
  const inventoryItem = {
    ...original,
    statusType: "error",
    statusMessage: "转发邮箱暂时不可用"
  };
  const harness = singleHarness(
    {
      checked: 1,
      updated: 0,
      moved: 0,
      disposition: "applied",
      inventoryItem,
      message: null,
      errors: [
        {
          inventoryId: original.id,
          message: "转发邮箱暂时不可用"
        }
      ]
    },
    [original]
  );

  await checkInventoryMail(harness.context, original, {});

  assert.deepEqual(harness.state.accounts, [inventoryItem]);
  assert.deepEqual(harness.invalidated, ["mailbox-error"]);
  assert.equal(harness.notifications.length, 1);
  const [title, message, tone] = harness.notifications[0];
  assert.equal(title, "收件失败");
  assert.equal(message, "转发邮箱暂时不可用");
  assert.equal(tone, "error");
  assert.doesNotMatch(message, /暂无匹配邮件/);
});

test("runMailBatch warns when the server scanned only part of the mailbox", async () => {
  const harness = batchHarness({
    inventory: [],
    checked: 2,
    updated: 0,
    moved: 0,
    errors: [],
    scanned: 100,
    available: 260,
    truncated: true
  });

  await runMailBatch(harness.context, {
    endpoint: "/v1/inventory/check-unused-mail",
    button: {},
    label: "扫描未使用邮箱"
  });

  assert.equal(harness.notifications.length, 1);
  const [title, message, tone] = harness.notifications[0];
  assert.equal(title, "扫描未使用邮箱完成");
  assert.equal(tone, "warn");
  assert.match(message, /仅扫描最近 100\/260 封邮件/);
  assert.match(message, /未覆盖窗口不能判定无邮件/);
});

test("runMailBatch keeps a complete empty scan as a normal result", async () => {
  const harness = batchHarness({
    inventory: [],
    checked: 0,
    updated: 0,
    errors: [],
    scanned: 0,
    available: 0,
    truncated: false
  });

  await runMailBatch(harness.context, {
    endpoint: "/v1/inventory/check-finished-mail",
    button: {},
    label: "读取已使用邮箱"
  });

  assert.equal(harness.notifications.length, 1);
  const [, message, tone] = harness.notifications[0];
  assert.equal(tone, "ok");
  assert.match(message, /已检查 0 个，更新 0 个，异常 0 个/);
  assert.doesNotMatch(message, /未覆盖窗口/);
});

test("mailBatchNotice clamps untrusted counters before rendering them", () => {
  const notice = mailBatchNotice({
    checked: Number.POSITIVE_INFINITY,
    updated: -12,
    moved: "<img src=x>",
    errors: { length: Number.POSITIVE_INFINITY },
    scanned: "not-a-number",
    available: Number.MAX_SAFE_INTEGER,
    truncated: true
  });

  assert.equal(notice.tone, "warn");
  assert.match(
    notice.message,
    /已检查 0 个，更新 0 个，归入已使用 0 个，异常 0 个/
  );
  assert.match(notice.message, /仅扫描最近 0\/999999 封邮件/);
  assert.doesNotMatch(notice.message, /Infinity|<img/);
});
