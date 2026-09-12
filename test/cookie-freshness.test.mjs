import test from "node:test";
import assert from "node:assert/strict";

import {
  COOKIE_STALE_AFTER_MS,
  describeCookieAge,
  summarizeCookieState
} from "../lib/cookie-freshness.mjs";

const FULL_COOKIES = [
  "X-APPLE-DS-WEB-SESSION-TOKEN=aaa",
  "X-APPLE-WEBAUTH-TOKEN=bbb",
  "X-APPLE-WEBAUTH-PCS-Mail=ccc"
].join(";");

test("a freshly written complete cookie file is not stale", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const summary = summarizeCookieState({
    cookies: FULL_COOKIES,
    mtimeMs: now - 10 * 60_000,
    now
  });

  assert.equal(summary.complete, true);
  assert.equal(summary.hasMailPcs, true);
  assert.equal(summary.stale, false);
  assert.equal(summary.ageMinutes, 10);
});

test("a complete cookie file older than the refresh window is stale", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  // This is the reported failure mode: both tokens present, file untouched for
  // a day and a half because all three refresh paths are broken.
  const summary = summarizeCookieState({
    cookies: FULL_COOKIES,
    mtimeMs: now - 36 * 60 * 60_000,
    now
  });

  assert.equal(summary.complete, true);
  assert.equal(summary.stale, true);
  assert.equal(summary.ageMinutes, 36 * 60);
});

test("the stale boundary is the shared two hour refresh window", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  assert.equal(COOKIE_STALE_AFTER_MS, 2 * 60 * 60_000);

  const justInside = summarizeCookieState({
    cookies: FULL_COOKIES,
    mtimeMs: now - (COOKIE_STALE_AFTER_MS - 1),
    now
  });
  const justOutside = summarizeCookieState({
    cookies: FULL_COOKIES,
    mtimeMs: now - COOKIE_STALE_AFTER_MS,
    now
  });

  assert.equal(justInside.stale, false);
  assert.equal(justOutside.stale, true);
});

test("missing tokens make the state stale regardless of age", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const summary = summarizeCookieState({
    cookies: "X-APPLE-DS-WEB-SESSION-TOKEN=aaa",
    mtimeMs: now,
    now
  });

  assert.equal(summary.hasSessionToken, true);
  assert.equal(summary.hasWebauthToken, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.stale, true);
});

test("empty or malformed required cookie values fail closed", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const cases = [
    "X-APPLE-DS-WEB-SESSION-TOKEN=;X-APPLE-WEBAUTH-TOKEN=bbb",
    "X-APPLE-DS-WEB-SESSION-TOKEN=aaa;X-APPLE-WEBAUTH-TOKEN=   ",
    "X-APPLE-DS-WEB-SESSION-TOKEN\r\n=aaa;X-APPLE-WEBAUTH-TOKEN=bbb"
  ];

  for (const cookies of cases) {
    const summary = summarizeCookieState({ cookies, mtimeMs: now, now });
    assert.equal(summary.complete, false, cookies);
    assert.equal(summary.stale, true, cookies);
  }
});

test("an empty or clock-skewed file never reports a negative age", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const skewed = summarizeCookieState({ cookies: "", mtimeMs: now + 60_000, now });

  assert.equal(skewed.ageMinutes, 0);
  assert.equal(skewed.complete, false);
  assert.equal(skewed.stale, true);
});

test("a complete cookie file dated in the future fails closed", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const skewed = summarizeCookieState({
    cookies: FULL_COOKIES,
    mtimeMs: now + 60_000,
    now
  });

  assert.equal(skewed.complete, true);
  assert.equal(skewed.ageMinutes, 0);
  assert.equal(skewed.stale, true);
});

test("non-finite timestamps and stale windows fail closed with a stable age", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const cases = [
    { now: Number.NaN, mtimeMs: now, staleAfterMs: COOKIE_STALE_AFTER_MS },
    { now: Number.POSITIVE_INFINITY, mtimeMs: now, staleAfterMs: COOKIE_STALE_AFTER_MS },
    { now, mtimeMs: Number.NaN, staleAfterMs: COOKIE_STALE_AFTER_MS },
    { now, mtimeMs: Number.NEGATIVE_INFINITY, staleAfterMs: COOKIE_STALE_AFTER_MS },
    { now, mtimeMs: now, staleAfterMs: Number.NaN },
    { now, mtimeMs: now, staleAfterMs: Number.POSITIVE_INFINITY }
  ];

  for (const values of cases) {
    const summary = summarizeCookieState({ cookies: FULL_COOKIES, ...values });
    assert.equal(summary.complete, true);
    assert.equal(summary.ageMinutes, 0);
    assert.equal(summary.stale, true);
  }
});

test("describeCookieAge scales from minutes to days", () => {
  assert.equal(describeCookieAge(0), "0 分钟");
  assert.equal(describeCookieAge(59), "59 分钟");
  assert.equal(describeCookieAge(60), "1 小时");
  assert.equal(describeCookieAge(23 * 60 + 59), "23 小时");
  assert.equal(describeCookieAge(36 * 60), "1 天");
  assert.equal(describeCookieAge(-5), "0 分钟");
  assert.equal(describeCookieAge(Number.NaN), "0 分钟");
  assert.equal(describeCookieAge(Number.POSITIVE_INFINITY), "0 分钟");
});
