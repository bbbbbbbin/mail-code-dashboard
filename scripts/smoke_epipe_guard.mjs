import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { __test } from "../server.mjs";

const processLike = new EventEmitter();
const stdout = new EventEmitter();
const stderr = new EventEmitter();
const logged = [];
const consoleErrors = [];
const dispose = __test.installRuntimeProcessDiagnostics(
  message => logged.push(message),
  {
    processLike,
    stdout,
    stderr,
    consoleLike: {
      error: value => consoleErrors.push(value)
    }
  }
);

assert.equal(stdout.listenerCount("error"), 1);
assert.equal(stderr.listenerCount("error"), 1);

stdout.emit("error", Object.assign(new Error("closed stdout"), { code: "EPIPE" }));
stderr.emit("error", Object.assign(new Error("closed stderr"), { code: "EPIPE" }));
assert.deepEqual(
  logged,
  [],
  "EPIPE must not recursively log through a broken output pipe"
);

processLike.emit(
  "uncaughtException",
  Object.assign(new Error("closed output"), { code: "EPIPE" })
);
assert.match(logged.at(-1), /^uncaughtException Error: closed output/u);
assert.deepEqual(consoleErrors, []);

stdout.emit("error", new Error("ordinary stdout failure"));
assert.match(logged.at(-1), /^stdout error Error: ordinary stdout failure/u);

dispose();
assert.equal(stdout.listenerCount("error"), 0);
assert.equal(stderr.listenerCount("error"), 0);

console.log("EPIPE guard smoke test passed");
