import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  errorEnvelope,
  okEnvelope,
  parseBoundedInteger,
  requireApiKey
} from "../lib/api.mjs";

test("okEnvelope returns the stable v1 shape", () => {
  assert.deepEqual(okEnvelope({ value: 1 }, "req-1"), {
    ok: true,
    data: { value: 1 },
    error: null,
    meta: {
      service: "mail-code-dashboard",
      version: "1",
      requestId: "req-1"
    }
  });
});

test("requireApiKey rejects a missing key", () => {
  assert.throws(
    () => requireApiKey({}, "secret"),
    error =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === "UNAUTHORIZED"
  );
});

test("requireApiKey rejects an incorrect key", () => {
  assert.throws(
    () => requireApiKey({ "X-API-Key": "incorrect" }, "secret"),
    error => error instanceof ApiError && error.code === "UNAUTHORIZED"
  );
});

test("requireApiKey accepts a case-insensitive header name", () => {
  assert.doesNotThrow(() =>
    requireApiKey({ "x-api-key": "secret" }, "secret")
  );
  assert.doesNotThrow(() =>
    requireApiKey({ "X-API-Key": "secret" }, "secret")
  );
});

test("errorEnvelope does not leak extra exception fields", () => {
  const error = new ApiError(409, "INVENTORY_EMPTY", "No address");
  error.secret = "must-not-leak";

  assert.deepEqual(errorEnvelope(error, "req-2"), {
    ok: false,
    data: null,
    error: { code: "INVENTORY_EMPTY", message: "No address" },
    meta: {
      service: "mail-code-dashboard",
      version: "1",
      requestId: "req-2"
    }
  });
});

test("parseBoundedInteger applies defaults and rejects out-of-range values", () => {
  assert.equal(parseBoundedInteger(undefined, 20, 1, 50), 20);
  assert.equal(parseBoundedInteger("30", 20, 1, 50), 30);
  assert.throws(
    () => parseBoundedInteger("51", 20, 1, 50),
    error => error instanceof ApiError && error.code === "BAD_REQUEST"
  );
  assert.throws(
    () => parseBoundedInteger("2.5", 20, 1, 50),
    error => error instanceof ApiError && error.code === "BAD_REQUEST"
  );
});
