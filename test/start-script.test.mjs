import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const script = await readFile(
  fileURLToPath(new URL("../scripts/start_dashboard.ps1", import.meta.url)),
  "utf8"
);

test("start script forces the loopback host", () => {
  assert.match(script, /\$env:HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(script, /LocalAddress/);
});

test("start script uses a hidden process only for the Hidden helper mode", () => {
  assert.match(script, /param\s*\([^)]*\[switch\]\$Hidden/s);
  assert.match(
    script,
    /if\s*\(\$Hidden\)\s*\{[\s\S]*Start-Process[\s\S]*-WindowStyle Hidden/
  );
  assert.match(script, /else\s*\{[\s\S]*&\s*node\s+"server\.mjs"/);
});

test("start script prints the API-key path without reading or replacing it", () => {
  assert.match(script, /runtime[\\\/"]+api-key\.txt/i);
  assert.match(script, /API_KEY_FILE=/);
  assert.doesNotMatch(
    script,
    /(Get-Content|Set-Content|Out-File)[^\r\n]*api-key\.txt/i
  );
});
