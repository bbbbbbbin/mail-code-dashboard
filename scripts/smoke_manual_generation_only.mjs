import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../mail-code-dashboard.html", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../assets/dashboard.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

assert.match(
  html,
  /id="autoGenerateToggle"/,
  "dashboard must expose an automatic generation switch",
);
assert.doesNotMatch(
  dashboard,
  /setInterval\(autoGenerateStock|\n\s*autoGenerateStock\(\);/,
  "dashboard must not own automatic generation scheduling",
);
assert.match(server, /server\.on\("listening", \(\) => autoStock\.start\(\)\)/);
assert.match(dashboard, /\/v1\/auto-stock/);
assert.match(
  dashboard,
  /autoGenerateToggle.*addEventListener/s,
  "switch must update generation mode"
);
assert.match(
  server,
  /refreshICloudCookiesIfNeeded/,
  "generation should reuse recently synchronized cookies instead of blocking on every refresh",
);

console.log("automatic generation toggle smoke test passed");
