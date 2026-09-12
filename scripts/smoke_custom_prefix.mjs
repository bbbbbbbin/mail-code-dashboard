import { __test } from "../server.mjs";

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(
  typeof __test.validateHideMyEmailLabel === "function",
  "server should export validateHideMyEmailLabel for regression testing"
);

__test.validateHideMyEmailLabel("hme-001");
__test.validateHideMyEmailLabel("icloud_test-abc");

let rejected = false;
try {
  __test.validateHideMyEmailLabel("plainlabel");
} catch {
  rejected = true;
}
assert(rejected, "labels without a fixed prefix and hyphen should still be rejected");

console.log("custom prefix smoke test passed");
