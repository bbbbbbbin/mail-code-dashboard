import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../scripts/start_dashboard_instance.ps1", import.meta.url), "utf8");

test("isolated instances use only extension supplied cookies", () => {
  assert.match(script, /\$env:HME_COOKIE_REFRESH_MODE = "extension"/);
});

test("multi-instance launcher exposes an explicit instance directory and port", () => {
  assert.match(script, /\[string\]\$InstanceDir/);
  assert.match(script, /\[int\]\$Port\s*=\s*4173/);
  assert.match(script, /\$env:HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(script, /\$env:PORT\s*=\s*\[string\]\$Port/);
});

test("multi-instance launcher isolates cookies, state, keys, sequences and logs", () => {
  for (const variable of [
    "HME_COOKIE_FILE",
    "MAIL_DASHBOARD_STATE_PATH",
    "MAIL_DASHBOARD_BACKUP_DIR",
    "MAIL_DASHBOARD_API_KEY_FILE",
    "HME_LABEL_SEQUENCE_FILE",
    "MAIL_FORWARD_CONFIG",
    "MAIL_LIFECYCLE_LOG_PATH"
  ]) {
    assert.match(script, new RegExp(`\\$env:${variable}\\s*=`), variable);
  }
  assert.match(script, /Start-Process/);
  assert.match(script, /Test-NetConnection/);
});
