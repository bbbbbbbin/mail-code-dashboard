import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptsDir = fileURLToPath(new URL("../scripts", import.meta.url));
const pythonScript = join(scriptsDir, "refresh_edge_icloud_cookies.py");
const bridgeScript = join(scriptsDir, "debug_icloud_cookie_bridge.ps1");
const serverFile = fileURLToPath(new URL("../server.mjs", import.meta.url));
const extensionBackground = fileURLToPath(
  new URL("../extensions/chrome-cookie-bridge/background.js", import.meta.url)
);

const bridgeSource = await readFile(bridgeScript, "utf8");
const pythonSource = await readFile(pythonScript, "utf8");
const serverSource = await readFile(serverFile, "utf8");
const extensionSource = await readFile(extensionBackground, "utf8");

// The helper only runs on the operator's Windows box; skip rather than fail the
// suite where python (or pywin32) is not installed.
const pythonReady = await execFileAsync("python", ["-c", "import win32crypt"])
  .then(() => true)
  .catch(() => false);

/**
 * Build a throwaway Edge "User Data" tree so the script can be driven without
 * touching the operator's real browser profile.
 */
async function makeEdgeTree(profiles) {
  const dir = await mkdtemp(join(tmpdir(), "edge-user-data-"));
  const userData = join(dir, "Microsoft", "Edge", "User Data");
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "Local State"),
    JSON.stringify({ os_crypt: { encrypted_key: "REFQQVBJZmFrZQ==" } }),
    "utf8"
  );

  for (const [profile, cookies] of Object.entries(profiles)) {
    const network = join(userData, profile, "Network");
    await mkdir(network, { recursive: true });
    const spec = JSON.stringify({ db: join(network, "Cookies"), cookies });
    await execFileAsync("python", [
      "-c",
      [
        "import json,sqlite3,sys",
        "spec=json.loads(sys.argv[1])",
        "conn=sqlite3.connect(spec['db'])",
        "conn.execute('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')",
        "conn.executemany('INSERT INTO cookies VALUES (?,?,?,?)',",
        "  [(c['host'], c['name'], c.get('value',''), c.get('encrypted','').encode()) for c in spec['cookies']])",
        "conn.commit()",
        "conn.close()"
      ].join("\n"),
      spec
    ]);
  }
  return { dir, userData };
}

function plain(name, value) {
  return { host: ".icloud.com", name, value };
}

async function runRefresh(localAppData, outputPath, env = {}) {
  try {
    const { stdout } = await execFileAsync("python", [pythonScript, outputPath], {
      env: { ...process.env, LOCALAPPDATA: localAppData, EDGE_PROFILE: "", ...env }
    });
    return JSON.parse(stdout);
  } catch (error) {
    assert.ok(error.stdout, `expected JSON on stdout, got: ${error.stderr || error.message}`);
    return JSON.parse(error.stdout);
  }
}

async function runRefreshPayload(localAppData, cwd, env = {}) {
  try {
    const { stdout } = await execFileAsync("python", [pythonScript, "--payload"], {
      cwd,
      env: { ...process.env, LOCALAPPDATA: localAppData, EDGE_PROFILE: "", ...env }
    });
    return JSON.parse(stdout);
  } catch (error) {
    assert.ok(error.stdout, `expected JSON on stdout, got: ${error.stderr || error.message}`);
    return JSON.parse(error.stdout);
  }
}

function quotedValues(body) {
  return Array.from(body.matchAll(/["']([^"']+)["']/g), match => match[1]);
}

function jsCookieContract(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `${name} list must exist`);
  return quotedValues(match[1]);
}

function pythonCookieContract(source) {
  const match = source.match(/SYNCED_COOKIE_NAMES\s*=\s*\(([\s\S]*?)\)/);
  assert.ok(match, "Python SYNCED_COOKIE_NAMES tuple must exist");
  return quotedValues(match[1]);
}

async function probeAtomicWriteCleanup(target) {
  const source = [
    "import importlib.util,json,pathlib,sys",
    "spec=importlib.util.spec_from_file_location('refresh_cookie_module', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "target=pathlib.Path(sys.argv[2])",
    "if not hasattr(module, 'write_secret_file_atomic'):",
    "  print(json.dumps({'available':False}))",
    "  raise SystemExit(0)",
    "module.os.replace=lambda *_: (_ for _ in ()).throw(OSError('replace blocked'))",
    "try:",
    "  module.write_secret_file_atomic(target, 'replacement')",
    "except OSError:",
    "  pass",
    "print(json.dumps({",
    "  'available':True,",
    "  'contents':target.read_text(encoding='utf-8'),",
    "  'temps':[entry.name for entry in target.parent.glob(f'.{target.name}.*.tmp')]",
    "}))"
  ].join("\n");
  const { stdout } = await execFileAsync("python", ["-c", source, pythonScript, target]);
  return JSON.parse(stdout);
}

test("the refresh script finds the iCloud session in a non-default profile", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({
    Default: [plain("X-APPLE-WEBAUTH-HSA-TRUST", "trust")],
    "Profile 2": [
      plain("X-APPLE-DS-WEB-SESSION-TOKEN", "session"),
      plain("X-APPLE-WEBAUTH-TOKEN", "webauth"),
      plain("X-APPLE-WEBAUTH-PCS-Mail", "pcs")
    ]
  });
  const output = join(dir, "cookies.txt");

  try {
    const result = await runRefresh(dir, output);

    // The old script hardcoded "Default" and reported "cookies not found" here.
    assert.equal(result.ok, true);
    assert.equal(result.profile, "Profile 2");
    assert.equal(result.hasMailPcs, true);
    assert.equal(
      await readFile(output, "utf8"),
      "X-APPLE-DS-WEB-SESSION-TOKEN=session;X-APPLE-WEBAUTH-TOKEN=webauth;X-APPLE-WEBAUTH-PCS-Mail=pcs"
    );
    assert.deepEqual(
      (await readdir(dir)).filter(name => /^\.cookies\.txt\..+\.tmp$/.test(name)),
      []
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(output)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one unreadable profile does not prevent scanning a later valid profile", { skip: !pythonReady }, async () => {
  const { dir, userData } = await makeEdgeTree({
    Default: [],
    "Profile 2": [
      plain("X-APPLE-DS-WEB-SESSION-TOKEN", "session"),
      plain("X-APPLE-WEBAUTH-TOKEN", "webauth")
    ]
  });
  const output = join(dir, "cookies.txt");
  await writeFile(join(userData, "Default", "Network", "Cookies"), "not a sqlite database", "utf8");

  try {
    const result = await runRefresh(dir, output);

    assert.equal(result.ok, true);
    assert.equal(result.profile, "Profile 2");
    assert.equal(
      await readFile(output, "utf8"),
      "X-APPLE-DS-WEB-SESSION-TOKEN=session;X-APPLE-WEBAUTH-TOKEN=webauth"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multiple signed-in profiles require an explicit EDGE_PROFILE", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({
    Default: [
      plain("X-APPLE-DS-WEB-SESSION-TOKEN", "default-session-secret"),
      plain("X-APPLE-WEBAUTH-TOKEN", "default-webauth-secret")
    ],
    "Profile 2": [
      plain("X-APPLE-DS-WEB-SESSION-TOKEN", "profile-two-session-secret"),
      plain("X-APPLE-WEBAUTH-TOKEN", "profile-two-webauth-secret")
    ]
  });
  const output = join(dir, "cookies.txt");

  try {
    const result = await runRefresh(dir, output);

    assert.equal(result.ok, false);
    assert.match(result.error, /Default/);
    assert.match(result.error, /Profile 2/);
    assert.match(result.error, /EDGE_PROFILE/);
    assert.doesNotMatch(result.error, /(?:default|profile-two)-(?:session|webauth)-secret/);
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback errors name profiles without exposing the Edge user-data path", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({});
  const output = join(dir, "cookies.txt");

  try {
    const result = await runRefresh(dir, output);

    assert.equal(result.ok, false);
    assert.match(result.error, /Default/);
    assert.equal(result.error.includes(dir), false);
    assert.doesNotMatch(result.error, /Microsoft[\\/]Edge[\\/]User Data/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone output uses an exclusive 0600 temp file, replace, and cleanup", () => {
  assert.match(pythonSource, /os\.open\([\s\S]*?os\.O_EXCL[\s\S]*?0o600/);
  assert.match(pythonSource, /os\.replace\(/);
  assert.match(pythonSource, /\.unlink\(missing_ok=True\)/);
});

test("a failed standalone replace preserves the old file and removes the temp", { skip: !pythonReady }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cookie-atomic-failure-"));
  const output = join(dir, "cookies.txt");
  await writeFile(output, "original", "utf8");

  try {
    const result = await probeAtomicWriteCleanup(output);

    assert.equal(result.available, true);
    assert.equal(result.contents, "original");
    assert.deepEqual(result.temps, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server, Python, and extension share the exact polyglot cookie contract", () => {
  const marker = "POLYGLOT_COOKIE_CONTRACT";
  assert.ok(serverSource.includes(marker), "server list must declare the duplication boundary");
  assert.ok(pythonSource.includes(marker), "Python list must declare the duplication boundary");
  assert.match(extensionSource, /server\.mjs/);
  assert.match(extensionSource, /refresh_edge_icloud_cookies\.py/);

  const serverNames = jsCookieContract(serverSource, "HME_COOKIE_NAMES");
  assert.deepEqual(pythonCookieContract(pythonSource), serverNames);
  assert.deepEqual(jsCookieContract(extensionSource, "SYNCED_COOKIE_NAMES"), serverNames);
});

test("payload mode returns the cookie header without writing a target", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({
    Default: [
      plain("X-APPLE-DS-WEB-SESSION-TOKEN", "session"),
      plain("X-APPLE-WEBAUTH-TOKEN", "webauth")
    ]
  });

  try {
    const result = await runRefreshPayload(dir, dir);

    assert.equal(result.ok, true);
    assert.equal(
      result.cookieHeader,
      "X-APPLE-DS-WEB-SESSION-TOKEN=session;X-APPLE-WEBAUTH-TOKEN=webauth"
    );
    await assert.rejects(readFile(join(dir, "--payload"), "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("payload mode canonicalizes names and deduplicates mixed-case cookies", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({
    Default: [
      plain("x-apple-ds-web-session-token", "session-old"),
      plain("X-Apple-DS-Web-Session-Token", "session-new"),
      plain("x-apple-webauth-token", "webauth"),
      plain("x-apple-webauth-pcs-mail", "pcs"),
      plain("APPLE_MARKETING_ID", "must-not-leak")
    ]
  });

  try {
    const result = await runRefreshPayload(dir, dir);

    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    assert.equal(result.hasMailPcs, true);
    assert.equal(
      result.cookieHeader,
      [
        "X-APPLE-DS-WEB-SESSION-TOKEN=session-new",
        "X-APPLE-WEBAUTH-TOKEN=webauth",
        "X-APPLE-WEBAUTH-PCS-Mail=pcs"
      ].join(";")
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("EDGE_PROFILE pins the search to one profile", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({
    Default: [plain("X-APPLE-WEBAUTH-HSA-TRUST", "trust")],
    "Profile 2": [
      plain("X-APPLE-DS-WEB-SESSION-TOKEN", "session"),
      plain("X-APPLE-WEBAUTH-TOKEN", "webauth")
    ]
  });
  const output = join(dir, "cookies.txt");

  try {
    const result = await runRefresh(dir, output, { EDGE_PROFILE: "Default" });

    assert.equal(result.ok, false);
    assert.match(result.error, /Edge profile\(s\) Default/);
    assert.match(result.error, /EDGE_PROFILE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app-bound encrypted cookies are named as the reason, not 'not found'", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({
    Default: [
      { host: ".icloud.com", name: "X-APPLE-DS-WEB-SESSION-TOKEN", encrypted: "v20ciphertext" },
      { host: ".icloud.com", name: "X-APPLE-WEBAUTH-TOKEN", encrypted: "v20ciphertext" }
    ]
  });
  const output = join(dir, "cookies.txt");

  try {
    const result = await runRefresh(dir, output);

    assert.equal(result.ok, false);
    assert.match(result.error, /app-bound encryption \(v20\)/);
    assert.match(result.error, /Cookie Bridge/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed refresh never leaves a half-written cookie file", { skip: !pythonReady }, async () => {
  const { dir } = await makeEdgeTree({ Default: [] });
  const output = join(dir, "cookies.txt");

  try {
    const result = await runRefresh(dir, output);

    assert.equal(result.ok, false);
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CDP bridge script keeps the profile configurable", () => {
  assert.match(bridgeSource, /\[string\]\$ProfileDirectory\s*=\s*""/);
  assert.match(bridgeSource, /\$env:EDGE_PROFILE/);
  assert.match(bridgeSource, /--profile-directory=\$ProfileDirectory/);
  assert.doesNotMatch(bridgeSource, /--profile-directory=Default/);
});

test("the CDP bridge script spells out the relaunch command instead of restarting Edge", () => {
  assert.match(bridgeSource, /if \(-not \$RestartEdge\)/);
  assert.match(bridgeSource, /--remote-debugging-port=\{0\}/);
  assert.match(bridgeSource, /-RestartEdge/);
});
