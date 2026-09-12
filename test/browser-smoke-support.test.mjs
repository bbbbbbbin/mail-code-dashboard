import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const selfHostedSmokes = [
  "smoke_dashboard.py",
  "smoke_layout_overflow.py",
  "smoke_mail_viewer.py",
  "smoke_migration.py",
  "smoke_tabs_settings.py",
];

function readSupport() {
  try {
    return readFileSync(
      new URL("../scripts/browser_smoke_support.py", import.meta.url),
      "utf8"
    );
  } catch {
    assert.fail("self-hosted browser smokes need shared browser_smoke_support.py");
  }
}

test("shared browser smoke support mirrors static MIME and security policy", () => {
  const support = readSupport();
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

  assert.match(support, /class BrowserSmokeHandler\(SimpleHTTPRequestHandler\)/);
  assert.match(support, /"\.js":\s*"text\/javascript"/);
  assert.match(support, /"\.css":\s*"text\/css"/);
  for (const header of [
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Referrer-Policy"
  ]) {
    assert.match(support, new RegExp(JSON.stringify(header)));
  }
  const serverDirectives = server.match(
    /"Content-Security-Policy":\s*\[([\s\S]*?)\]\.join/
  );
  const supportDirectives = support.match(
    /"Content-Security-Policy":\s*"; "\.join\(\s*\[([\s\S]*?)\]\s*\)/
  );
  assert.ok(serverDirectives && supportDirectives);
  const strings = block =>
    [...block.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(
    strings(supportDirectives[1]),
    strings(serverDirectives[1])
  );
  assert.match(support, /"X-Content-Type-Options":\s*"nosniff"/);
  assert.match(support, /"Referrer-Policy":\s*"no-referrer"/);
  assert.doesNotMatch(strings(supportDirectives[1]).join("; "), /unsafe-eval/);
  assert.match(support, /def capture_browser_errors\(/);
  assert.match(support, /def assert_no_browser_errors\(/);
  assert.match(support, /def wait_for_page_condition\(/);
});

test("every self-hosted Python smoke uses the shared support without local handlers", () => {
  for (const name of selfHostedSmokes) {
    const source = readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
    assert.match(
      source,
      /from browser_smoke_support import[\s\S]*BrowserSmokeHandler/
    );
    assert.match(source, /capture_browser_errors\(/);
    assert.match(source, /assert_no_browser_errors\(/);
    assert.doesNotMatch(
      source,
      /wait_for_function\(/,
      `${name} must not require CSP unsafe-eval`
    );
    assert.doesNotMatch(source, /class QuietHandler\(/);
    assert.doesNotMatch(source, /SimpleHTTPRequestHandler/);
  }
});

test("real-server iCloud controls smoke also fails on browser errors", () => {
  const source = readFileSync(
    new URL("../scripts/smoke_icloud_controls.py", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /from browser_smoke_support import[\s\S]*capture_browser_errors/
  );
  assert.match(source, /assert_no_browser_errors\(/);
});

test("mail viewer keeps a real hostile-script sandbox regression", () => {
  const source = readFileSync(
    new URL("../scripts/smoke_mail_viewer.py", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /<script>parent\.syntheticMailScriptExecuted = true<\/script>/
  );
  assert.match(source, /window\.syntheticMailScriptExecuted = false/);
  assert.match(source, /SANDBOX_SCRIPT_BLOCKED_ERROR/);
  assert.match(source, /len\(sandbox_diagnostics\) != 2/);
  assert.match(
    source,
    /assert_no_browser_errors\(unexpected_browser_errors,\s*"Mail viewer"\)/
  );
});
