import test from "node:test";
import assert from "node:assert/strict";

import { describeScriptFailure, parseJsonPayload, runJsonScript } from "../lib/script-runner.mjs";

function execFileRejectingWith(error) {
  return async () => {
    throw error;
  };
}

function execFileResolvingWith(stdout) {
  return async () => ({ stdout, stderr: "" });
}

test("parseJsonPayload reads a plain JSON document", () => {
  assert.deepEqual(parseJsonPayload('{"ok":true,"count":9}'), { ok: true, count: 9 });
});

test("parseJsonPayload recovers JSON that PowerShell prefixed with a banner", () => {
  const stdout = 'WARNING: reloading extension\r\n{\r\n  "ok": true,\r\n  "port": 9222\r\n}\r\n';

  assert.deepEqual(parseJsonPayload(stdout), { ok: true, port: 9222 });
});

test("parseJsonPayload returns null for empty or non-object output", () => {
  assert.equal(parseJsonPayload(""), null);
  assert.equal(parseJsonPayload("   "), null);
  assert.equal(parseJsonPayload(undefined), null);
  assert.equal(parseJsonPayload("not json at all"), null);
  assert.equal(parseJsonPayload("42"), null);
});

test("describeScriptFailure surfaces the reason the script printed on stdout", () => {
  // This is the regression: python exits 1 after printing its own diagnosis,
  // so execFile's message is only "Command failed: python ...".
  const error = new Error(
    "Command failed: python C:\\icloud\\scripts\\refresh_edge_icloud_cookies.py C:\\icloud\\runtime\\cookies.txt"
  );
  error.stdout =
    '{"ok": false, "error": "required iCloud session cookies not found; open iCloud in Edge first"}\n';
  error.stderr = "";

  assert.equal(
    describeScriptFailure(error),
    "required iCloud session cookies not found; open iCloud in Edge first"
  );
});

test("describeScriptFailure falls back to the first stderr line", () => {
  const error = new Error("Command failed: powershell ...");
  error.stdout = "";
  error.stderr =
    "\r\nEdge CDP is not open on port 9222. Re-run with -RestartEdge to reopen Edge.\r\n    + CategoryInfo : ...\r\n";

  assert.equal(
    describeScriptFailure(error),
    "Edge CDP is not open on port 9222. Re-run with -RestartEdge to reopen Edge."
  );
});

test("describeScriptFailure falls back to stdout text when it is not JSON", () => {
  const error = new Error("Command failed: python ...");
  error.stdout = "usage: refresh_edge_icloud_cookies.py OUTPUT\n";
  error.stderr = "";

  assert.equal(describeScriptFailure(error), "usage: refresh_edge_icloud_cookies.py OUTPUT");
});

test("describeScriptFailure reports the exception line of a python traceback", () => {
  // A helper that dies before printing its JSON leaves only a traceback, whose
  // first line is the useless banner — the cause is on the last line.
  const error = new Error("Command failed: python refresh_edge_icloud_cookies.py");
  error.stdout = "";
  error.stderr = [
    "Traceback (most recent call last):",
    '  File "C:\\icloud\\scripts\\refresh_edge_icloud_cookies.py", line 8, in <module>',
    "    import win32crypt",
    "ModuleNotFoundError: No module named 'win32crypt'",
    ""
  ].join("\r\n");

  assert.equal(describeScriptFailure(error), "ModuleNotFoundError: No module named 'win32crypt'");
});

test("describeScriptFailure still prefers the script's JSON over a traceback", () => {
  const error = new Error("Command failed: python refresh_edge_icloud_cookies.py");
  error.stdout = '{"ok": false, "error": "Edge stores its cookies with app-bound encryption (v20)"}';
  error.stderr = "Traceback (most recent call last):\r\n  File \"x.py\", line 1\r\nValueError: boom";

  assert.equal(
    describeScriptFailure(error),
    "Edge stores its cookies with app-bound encryption (v20)"
  );
});

test("describeScriptFailure reports a timeout kill distinctly", () => {
  const error = new Error("Command failed: python ...");
  error.stdout = "";
  error.stderr = "";
  error.killed = true;
  error.signal = "SIGTERM";

  assert.match(describeScriptFailure(error), /脚本超时或被终止（signal=SIGTERM）/);
});

test("describeScriptFailure truncates a runaway payload", () => {
  const error = new Error("Command failed");
  error.stdout = JSON.stringify({ ok: false, error: "x".repeat(1000) });

  const detail = describeScriptFailure(error);
  assert.equal(detail.length, 401);
  assert.ok(detail.endsWith("…"));
});

test("runJsonScript resolves the payload when the script reports ok", async () => {
  const payload = await runJsonScript({
    execFileAsync: execFileResolvingWith('{"ok":true,"count":12,"hasMailPcs":true}'),
    file: "python",
    args: ["refresh.py"],
    label: "Edge cookie 刷新"
  });

  assert.deepEqual(payload, { ok: true, count: 12, hasMailPcs: true });
});

test("runJsonScript labels a non-zero exit with the script's own reason", async () => {
  const error = new Error("Command failed: python refresh.py");
  error.stdout = '{"ok": false, "error": "DPAPI unwrap failed"}';

  await assert.rejects(
    runJsonScript({
      execFileAsync: execFileRejectingWith(error),
      file: "python",
      args: ["refresh.py"],
      label: "Edge cookie 刷新"
    }),
    /Edge cookie 刷新失败：DPAPI unwrap failed/
  );
});

test("runJsonScript keeps the original execFile error as the cause", async () => {
  const error = new Error("Command failed: python refresh.py");
  error.stdout = '{"ok": false, "error": "DPAPI unwrap failed"}';

  const failure = await runJsonScript({
    execFileAsync: execFileRejectingWith(error),
    file: "python",
    label: "Edge cookie 刷新"
  }).catch(thrown => thrown);

  assert.equal(failure.cause, error);
});

test("runJsonScript rejects a zero-exit script that reports ok:false", async () => {
  await assert.rejects(
    runJsonScript({
      execFileAsync: execFileResolvingWith('{"ok":false,"error":"cookie file has no session token"}'),
      file: "powershell",
      label: "iCloud Cookie Bridge 同步"
    }),
    /iCloud Cookie Bridge 同步失败：cookie file has no session token/
  );
});

test("runJsonScript rejects output that is not JSON at all", async () => {
  await assert.rejects(
    runJsonScript({
      execFileAsync: execFileResolvingWith("python: can't open file 'refresh.py'"),
      file: "python",
      label: "Edge cookie 刷新"
    }),
    /没有返回 JSON（python: can't open file 'refresh.py'）/
  );
});

test("runJsonScript rejects empty output with a readable hint", async () => {
  await assert.rejects(
    runJsonScript({
      execFileAsync: execFileResolvingWith("   "),
      file: "python",
      label: "Edge cookie 刷新"
    }),
    /没有返回 JSON（输出为空）/
  );
});

test("runJsonScript hides malformed stdout for a sensitive non-zero exit", async () => {
  const secret = "X-APPLE-WEBAUTH-TOKEN=must-not-leak";
  const error = new Error("Command failed: python refresh.py");
  error.stdout = `malformed ${secret}`;
  error.stderr = "";

  const failure = await runJsonScript({
    execFileAsync: execFileRejectingWith(error),
    file: "python",
    label: "Edge cookie 刷新",
    sensitiveOutput: true
  }).catch(thrown => thrown);

  assert.equal(failure.message.includes(secret), false);
  assert.match(failure.message, /输出已隐藏/);
  assert.equal(failure.cause, undefined);
});

test("runJsonScript keeps a wrapped structured reason but drops the sensitive raw cause", async () => {
  const secret = "X-APPLE-WEBAUTH-TOKEN=must-not-leak";
  const error = new Error(`Command failed while processing ${secret}`);
  error.stdout = [
    "PowerShell warning: helper exited 1",
    '{"ok":false,"error":"Edge profile is not signed in"}',
    `debug tail ${secret}`
  ].join("\r\n");
  error.stderr = "";

  const failure = await runJsonScript({
    execFileAsync: execFileRejectingWith(error),
    file: "powershell",
    label: "Edge cookie 刷新",
    sensitiveOutput: true
  }).catch(thrown => thrown);

  assert.match(failure.message, /Edge profile is not signed in/);
  assert.equal(failure.message.includes(secret), false);
  assert.equal(failure.cause, undefined);
});

test("runJsonScript hides arbitrary unstructured sensitive stderr", async () => {
  const secret = "raw-sensitive-cookie-value";
  const error = new Error("Command failed: powershell");
  error.stdout = "";
  error.stderr = `PowerShell wrapper failed while handling ${secret}`;

  const failure = await runJsonScript({
    execFileAsync: execFileRejectingWith(error),
    file: "powershell",
    label: "iCloud Cookie Bridge 同步",
    sensitiveOutput: true
  }).catch(thrown => thrown);

  const serialized = JSON.stringify({
    message: failure.message,
    cause: failure.cause ?? null
  });
  assert.match(failure.message, /输出已隐藏/);
  assert.equal(failure.message.includes(secret), false);
  assert.equal(failure.cause, undefined);
  assert.equal(serialized.includes(secret), false);
});

test("runJsonScript hides malformed stdout for a sensitive zero exit", async () => {
  const secret = "X-APPLE-DS-WEB-SESSION-TOKEN=must-not-leak";

  const failure = await runJsonScript({
    execFileAsync: execFileResolvingWith(`not json ${secret}`),
    file: "python",
    label: "Edge cookie 刷新",
    sensitiveOutput: true
  }).catch(thrown => thrown);

  assert.equal(failure.message.includes(secret), false);
  assert.match(failure.message, /输出已隐藏/);
});

test("runJsonScript keeps structured diagnostics in sensitive-output mode", async () => {
  const error = new Error("Command failed: python refresh.py");
  error.stdout = '{"ok":false,"error":"Edge profile is not signed in"}';
  error.stderr = "";

  await assert.rejects(
    runJsonScript({
      execFileAsync: execFileRejectingWith(error),
      file: "python",
      label: "Edge cookie 刷新",
      sensitiveOutput: true
    }),
    /Edge cookie 刷新失败：Edge profile is not signed in/
  );
});

test("runJsonScript redacts cookie assignments inside a structured sensitive diagnostic", async () => {
  const secret = "must-not-leak";
  const error = new Error("Command failed: python refresh.py");
  error.stdout = JSON.stringify({
    ok: false,
    error: `cookie rejected: X-APPLE-WEBAUTH-TOKEN=${secret}`
  });
  error.stderr = "";

  const failure = await runJsonScript({
    execFileAsync: execFileRejectingWith(error),
    file: "python",
    label: "Edge cookie 刷新",
    sensitiveOutput: true
  }).catch(thrown => thrown);

  assert.match(failure.message, /cookie rejected/);
  assert.equal(failure.message.includes(secret), false);
});

test("runJsonScript redacts a structured sensitive diagnostic on zero exit too", async () => {
  const secret = "must-not-leak";
  const failure = await runJsonScript({
    execFileAsync: execFileResolvingWith(JSON.stringify({
      ok: false,
      error: `cookie rejected: X-APPLE-DS-WEB-SESSION-TOKEN=${secret}`
    })),
    file: "powershell",
    label: "iCloud Cookie Bridge 同步",
    sensitiveOutput: true
  }).catch(thrown => thrown);

  assert.match(failure.message, /cookie rejected/);
  assert.equal(failure.message.includes(secret), false);
});
