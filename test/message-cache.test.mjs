import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MESSAGE_CACHE_TTL_MS,
  createMessageCache
} from "../assets/dashboard-state.js";

const entrySource = readFileSync(
  new URL("../assets/dashboard.js", import.meta.url),
  "utf8"
);
const stateSource = readFileSync(
  new URL("../assets/dashboard-state.js", import.meta.url),
  "utf8"
);

function loadCache() {
  const state = { messageCache: new Map() };
  const clock = { now: 0 };
  const api = createMessageCache({
    state,
    now: () => clock.now,
    ttlMs: MESSAGE_CACHE_TTL_MS
  });
  return { ...api, state, clock };
}

test("TTL 是分钟级，长时间挂着的面板不会一直复用第一封邮件", () => {
  assert.ok(
    MESSAGE_CACHE_TTL_MS > 0 && MESSAGE_CACHE_TTL_MS <= 5 * 60 * 1000,
    `TTL ${MESSAGE_CACHE_TTL_MS}ms 太长，缓存只需覆盖收件到查看的几秒`
  );
});

test("TTL 之内读到的还是同一封邮件", () => {
  const cache = loadCache();
  const message = { subject: "验证码 1", codes: ["111111"] };

  cache.cacheMessage("acc-1", message);
  assert.equal(cache.cachedMessage("acc-1"), message);

  cache.clock.now = MESSAGE_CACHE_TTL_MS - 1;
  assert.equal(cache.cachedMessage("acc-1"), message);
});

test("到期后读不到，并且条目当场丢掉", () => {
  const cache = loadCache();
  cache.cacheMessage("acc-1", { subject: "旧验证码" });

  cache.clock.now = MESSAGE_CACHE_TTL_MS;
  assert.equal(cache.cachedMessage("acc-1"), null);
  assert.equal(cache.state.messageCache.size, 0);
});

test("写入时顺手清扫过期条目，Map 不会只增不减", () => {
  const cache = loadCache();
  cache.cacheMessage("acc-1", { subject: "旧的" });

  cache.clock.now = MESSAGE_CACHE_TTL_MS + 1;
  cache.cacheMessage("acc-2", { subject: "新的" });

  assert.deepEqual([...cache.state.messageCache.keys()], ["acc-2"]);
});

test("带 id 只清一条，不带 id 整张表清空", () => {
  const cache = loadCache();
  cache.cacheMessage("acc-1", { subject: "一" });
  cache.cacheMessage("acc-2", { subject: "二" });

  cache.invalidateMessageCache("acc-1");
  assert.equal(cache.cachedMessage("acc-1"), null);
  assert.notEqual(cache.cachedMessage("acc-2"), null);

  cache.invalidateMessageCache();
  assert.equal(cache.state.messageCache.size, 0);
});

test("空 id 或空邮件不会写进缓存", () => {
  const cache = loadCache();
  cache.cacheMessage("", { subject: "无主" });
  cache.cacheMessage("acc-1", null);
  assert.equal(cache.state.messageCache.size, 0);
});

test("只有 state 模块直接操作 messageCache", () => {
  assert.match(stateSource, /state\.messageCache\.(?:set|get|delete|clear)\(/);
  assert.doesNotMatch(
    entrySource,
    /state\.messageCache\.(?:set|get|delete|clear)\(/
  );
});

test("收件、查看和库存变化仍接入缓存契约", () => {
  assert.match(entrySource, /cacheMessage/);
  assert.match(entrySource, /cachedMessage/);
  assert.match(entrySource, /invalidateMessageCache/);
  assert.match(entrySource, /checkInventoryMail/);
  assert.match(entrySource, /runMailBatch/);
  assert.match(entrySource, /loadServerInventory/);
  assert.match(entrySource, /syncIcloudAccountsFromApple/);
  assert.match(entrySource, /releaseClaim/);
  assert.match(entrySource, /purgeAccount/);
});
