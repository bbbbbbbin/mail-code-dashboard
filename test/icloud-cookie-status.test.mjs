import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// `server.mjs` resolves the cookie path at import time, so the fixture has to be
// in place before the module is loaded.
const dir = await mkdtemp(join(tmpdir(), "icloud-cookie-status-"));
const cookieFile = join(dir, "cookies.txt");
process.env.HME_COOKIE_FILE = cookieFile;

const { __test } = await import("../server.mjs");

const FULL_COOKIES = [
  "X-APPLE-DS-WEB-SESSION-TOKEN=aaa",
  "X-APPLE-WEBAUTH-TOKEN=bbb",
  "X-APPLE-WEBAUTH-PCS-Mail=ccc"
].join(";");

async function writeCookies(contents, ageMinutes) {
  await writeFile(cookieFile, contents, "utf8");
  if (ageMinutes) {
    const when = new Date(Date.now() - ageMinutes * 60_000);
    await utimes(cookieFile, when, when);
  }
}

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a fresh cookie file reports its age and is not flagged stale", async () => {
  await writeCookies(FULL_COOKIES, 5);

  const status = await __test.getICloudLoginStatus();

  assert.equal(status.ok, true);
  assert.equal(status.stale, false);
  assert.equal(status.hasMailPcs, true);
  assert.equal(status.staleAfterMinutes, 120);
  assert.ok(status.ageMinutes >= 5 && status.ageMinutes <= 6);
  assert.equal(status.staleReason, undefined);
  assert.ok(status.lastSyncedAt);
});

test("a cookie file nobody refreshed for a day is flagged stale with a reason", async () => {
  await writeCookies(FULL_COOKIES, 26 * 60);

  const status = await __test.getICloudLoginStatus();

  // Both tokens are still there, so `ok` stays true — the age is the only
  // signal that every refresh path is dead.
  assert.equal(status.ok, true);
  assert.equal(status.stale, true);
  assert.match(status.staleReason, /1 天/);
  assert.match(status.staleReason, /手动同步/);
});

test("a cookie file missing the webauth token is not ok", async () => {
  await writeCookies("X-APPLE-DS-WEB-SESSION-TOKEN=aaa", 1);

  const status = await __test.getICloudLoginStatus();

  assert.equal(status.ok, false);
  assert.equal(status.stale, true);
  assert.equal(status.hasSessionToken, true);
  assert.equal(status.hasWebauthToken, false);
});

test("a missing cookie file reports stale instead of pretending to be fresh", async () => {
  await rm(cookieFile, { force: true });

  const status = await __test.getICloudLoginStatus();

  assert.equal(status.ok, false);
  assert.equal(status.stale, true);
  assert.match(status.error, /对应账号.*浏览器.*扩展同步/);
});
