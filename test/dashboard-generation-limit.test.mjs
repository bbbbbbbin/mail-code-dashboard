import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dashboardSource = new URL("../assets/dashboard.js", import.meta.url);

test("automatic mailbox generation targets 1500 addresses", async () => {
  const source = await readFile(dashboardSource, "utf8");
  assert.match(source, /const AUTO_TARGET_TOTAL = 1500;/u);
  assert.doesNotMatch(source, /const AUTO_TARGET_TOTAL = 700;/u);
  assert.match(source, /自动生成 \$\{totalGenerated\}\/\$\{AUTO_TARGET_TOTAL\}/u);
});
