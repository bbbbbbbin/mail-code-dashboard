import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "icloud-generation-test-"));
const cookieFile = join(directory, "runtime", "cookies.txt");
const sequenceFile = join(directory, "icloud-label-sequence.json");
process.env.HME_COOKIE_FILE = cookieFile;
process.env.HME_LABEL_SEQUENCE_FILE = sequenceFile;
process.env.HME_LABEL_PREFIX = "hme";

const { __test } = await import(`../server.mjs?icloud-generation=${Date.now()}`);

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function requireHook(name) {
  assert.equal(
    typeof __test[name],
    "function",
    `server.__test.${name} must expose the focused test hook`
  );
  return __test[name];
}

test("cookie names are matched case-insensitively and written with canonical names", async () => {
  const acceptEdgeCookieBridge = requireHook("acceptEdgeCookieBridge");

  const result = await acceptEdgeCookieBridge({
    cookies: [
      { name: "x-apple-ds-web-session-token", value: "session-old" },
      { name: "X-apple-ds-web-session-token", value: "session-new" },
      { name: "x-apple-webauth-token", value: "webauth" },
      { name: "x-apple-webauth-pcs-mail", value: "pcs" },
      { name: "APPLE_MARKETING_ID", value: "must-not-leak" }
    ]
  });

  assert.deepEqual(result, { ok: true, count: 3, hasMailPcs: true });
  assert.equal(
    await readFile(cookieFile, "utf8"),
    [
      "X-APPLE-DS-WEB-SESSION-TOKEN=session-new",
      "X-APPLE-WEBAUTH-TOKEN=webauth",
      "X-APPLE-WEBAUTH-PCS-Mail=pcs"
    ].join(";")
  );
});

test("invalid bridge payloads are client errors and never replace the cookie file", async () => {
  const acceptEdgeCookieBridge = requireHook("acceptEdgeCookieBridge");
  const original = "X-APPLE-DS-WEB-SESSION-TOKEN=old-session";
  await writeFile(cookieFile, original, "utf8");

  for (const body of [
    { cookies: [] },
    {
      cookies: [
        {
          name: "X-APPLE-DS-WEB-SESSION-TOKEN",
          value: "partial-session"
        }
      ]
    },
    {
      cookies: [
        { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" }
      ]
    },
    {
      cookies: [
        { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "   " }
      ]
    },
    {
      cookies: [
        { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "" }
      ]
    },
    {
      cookies: [
        { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session;injected=1" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" }
      ]
    },
    {
      cookies: [
        { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session\r\nInjected: 1" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" }
      ]
    }
  ]) {
    await assert.rejects(
      acceptEdgeCookieBridge(body),
      error =>
        error?.status === 400 &&
        /cookie/i.test(error.message)
    );
    assert.equal(await readFile(cookieFile, "utf8"), original);
  }
});

test("concurrent sequence allocations are serialized and never duplicate a label", async () => {
  const nextReservedHideMyEmailLabel = requireHook("nextReservedHideMyEmailLabel");
  await writeFile(sequenceFile, "{}\n", "utf8");

  const labels = await Promise.all(
    Array.from({ length: 20 }, () => nextReservedHideMyEmailLabel("hme-001"))
  );

  assert.equal(new Set(labels).size, 20);
  assert.deepEqual(
    labels.slice().sort(),
    Array.from(
      { length: 20 },
      (_, index) => `hme-${String(index + 1).padStart(3, "0")}`
    )
  );
  assert.deepEqual(JSON.parse(await readFile(sequenceFile, "utf8")), { hme: 20 });
});

test("a corrupt sequence file fails explicitly instead of resetting the counter", async () => {
  const nextReservedHideMyEmailLabel = requireHook("nextReservedHideMyEmailLabel");
  await writeFile(sequenceFile, "{ definitely-not-json", "utf8");

  await assert.rejects(
    nextReservedHideMyEmailLabel("hme-001"),
    /序列|损坏|JSON|parse/i
  );
});

test("an unsafe numeric suffix is rejected without poisoning the sequence file", async () => {
  const nextReservedHideMyEmailLabel = requireHook("nextReservedHideMyEmailLabel");
  await writeFile(sequenceFile, "{}\n", "utf8");

  await assert.rejects(
    nextReservedHideMyEmailLabel("hme-9007199254740992"),
    /编号|安全范围|safe integer/i
  );
  assert.deepEqual(JSON.parse(await readFile(sequenceFile, "utf8")), {});
});

test("secret files are created through wx temporary files with mode 0600 then renamed", async () => {
  const writeSecretFileAtomic = requireHook("writeSecretFileAtomic");
  const calls = [];
  const target = join(directory, "atomic", "secret.txt");
  const fakeIo = {
    async mkdir(...args) {
      calls.push(["mkdir", ...args]);
    },
    async writeFile(...args) {
      calls.push(["writeFile", ...args]);
    },
    async rename(...args) {
      calls.push(["rename", ...args]);
    },
    async unlink(...args) {
      calls.push(["unlink", ...args]);
    }
  };

  await writeSecretFileAtomic(target, "secret", fakeIo);

  assert.deepEqual(calls[0], ["mkdir", join(directory, "atomic"), { recursive: true }]);
  assert.equal(calls[1][0], "writeFile");
  assert.notEqual(calls[1][1], target);
  assert.match(calls[1][1], /\.secret\.txt\..+\.tmp$/);
  assert.equal(calls[1][2], "secret");
  assert.deepEqual(calls[1][3], {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  assert.deepEqual(calls[2], ["rename", calls[1][1], target]);
  assert.equal(calls.some(([name]) => name === "unlink"), false);
});

test("both the sequence and cookie entry points use the atomic secret writer", async () => {
  const acceptEdgeCookieBridge = requireHook("acceptEdgeCookieBridge");
  const nextReservedHideMyEmailLabel = requireHook("nextReservedHideMyEmailLabel");
  const setSecretFileIo = requireHook("setSecretFileIo");
  const writes = [];
  const restore = setSecretFileIo({
    mkdir,
    async writeFile(path, contents, options) {
      writes.push({ path, contents, options });
      return writeFile(path, contents, options);
    },
    rename,
    unlink
  });

  try {
    await writeFile(sequenceFile, "{}\n", "utf8");
    await acceptEdgeCookieBridge({
      cookies: [
        { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "session" },
        { name: "X-APPLE-WEBAUTH-TOKEN", value: "webauth" }
      ]
    });
    await nextReservedHideMyEmailLabel("hme-001");
  } finally {
    restore();
  }

  assert.equal(writes.length, 2);
  for (const entry of writes) {
    assert.deepEqual(entry.options, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    assert.match(entry.path, /\.tmp$/);
  }
});

test("the Python fallback returns a payload and cannot write the real cookie target", { skip: process.platform !== 'win32' }, async () => {
  const refreshICloudCookiesFromEdge = requireHook("refreshICloudCookiesFromEdge");
  const setExecFileAsync = requireHook("setExecFileAsync");
  const setSecretFileIo = requireHook("setSecretFileIo");
  const header = [
    "X-APPLE-DS-WEB-SESSION-TOKEN=python-session",
    "X-APPLE-WEBAUTH-TOKEN=python-webauth"
  ].join(";");
  const executions = [];
  const writes = [];
  const restoreExec = setExecFileAsync(async (file, args) => {
    executions.push({ file, args });
    if (file === "powershell") {
      const error = new Error("synthetic bridge failure");
      error.stdout = JSON.stringify({ ok: false, error: "bridge unavailable" });
      throw error;
    }
    assert.equal(file, "python");
    return {
      stdout: JSON.stringify({
        ok: true,
        profile: "Profile 2",
        count: 2,
        hasMailPcs: false,
        cookieHeader: header
      }),
      stderr: ""
    };
  });
  const restoreIo = setSecretFileIo({
    mkdir,
    async writeFile(path, contents, options) {
      writes.push({ path, contents, options });
      return writeFile(path, contents, options);
    },
    rename,
    unlink
  });
  let result;

  try {
    result = await refreshICloudCookiesFromEdge();
  } finally {
    restoreIo();
    restoreExec();
  }

  assert.equal(executions.length, 2);
  assert.equal(executions[1].file, "python");
  assert.deepEqual(executions[1].args.slice(1), ["--payload"]);
  assert.equal(executions[1].args.includes(cookieFile), false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].contents, header);
  assert.deepEqual(writes[0].options, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  assert.equal(await readFile(cookieFile, "utf8"), header);
  assert.deepEqual(result, {
    ok: true,
    profile: "Profile 2",
    count: 2,
    hasMailPcs: false
  });
});

test("a slow Python fallback cannot overwrite a newer extension cookie sync", { skip: process.platform !== 'win32' }, async () => {
  const acceptEdgeCookieBridge = requireHook("acceptEdgeCookieBridge");
  const refreshICloudCookiesFromEdge = requireHook("refreshICloudCookiesFromEdge");
  const setExecFileAsync = requireHook("setExecFileAsync");
  let markPythonStarted;
  let releasePython;
  const pythonStarted = new Promise(resolve => {
    markPythonStarted = resolve;
  });
  const pythonGate = new Promise(resolve => {
    releasePython = resolve;
  });
  const oldHeader = [
    "X-APPLE-DS-WEB-SESSION-TOKEN=python-old",
    "X-APPLE-WEBAUTH-TOKEN=python-old"
  ].join(";");
  const newCookies = [
    { name: "X-APPLE-DS-WEB-SESSION-TOKEN", value: "extension-new" },
    { name: "X-APPLE-WEBAUTH-TOKEN", value: "extension-new" }
  ];
  const restoreExec = setExecFileAsync(async file => {
    if (file === "powershell") {
      const error = new Error("synthetic bridge failure");
      error.stdout = JSON.stringify({ ok: false, error: "bridge unavailable" });
      throw error;
    }
    markPythonStarted();
    await pythonGate;
    return {
      stdout: JSON.stringify({
        ok: true,
        profile: "Default",
        count: 2,
        hasMailPcs: false,
        cookieHeader: oldHeader
      }),
      stderr: ""
    };
  });

  try {
    const refresh = refreshICloudCookiesFromEdge();
    await pythonStarted;
    let extensionSettled = false;
    const extension = acceptEdgeCookieBridge({ cookies: newCookies }).then(result => {
      extensionSettled = true;
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforePython = extensionSettled;
    releasePython();
    await Promise.all([refresh, extension]);

    assert.equal(
      settledBeforePython,
      false,
      "the extension write must queue behind the complete Python collection/write transaction"
    );
    assert.equal(
      await readFile(cookieFile, "utf8"),
      "X-APPLE-DS-WEB-SESSION-TOKEN=extension-new;X-APPLE-WEBAUTH-TOKEN=extension-new"
    );
  } finally {
    releasePython();
    restoreExec();
  }
});

test("malformed sensitive Python stdout never reaches the refresh status", { skip: process.platform !== 'win32' }, async () => {
  const getICloudLoginStatus = requireHook("getICloudLoginStatus");
  const refreshICloudCookiesFromEdge = requireHook("refreshICloudCookiesFromEdge");
  const setExecFileAsync = requireHook("setExecFileAsync");
  const secret = "X-APPLE-WEBAUTH-TOKEN=must-never-appear";
  const restoreExec = setExecFileAsync(async file => {
    const error = new Error(`synthetic ${file} failure`);
    error.stderr = "";
    error.stdout = file === "powershell"
      ? JSON.stringify({ ok: false, error: "bridge unavailable" })
      : `malformed payload ${secret}`;
    throw error;
  });

  try {
    const failure = await refreshICloudCookiesFromEdge().catch(error => error);
    const status = await getICloudLoginStatus();
    assert.equal(failure.message.includes(secret), false);
    assert.equal(String(status.lastRefreshError || "").includes(secret), false);
    assert.match(failure.message, /隐藏|敏感|输出/i);
  } finally {
    restoreExec();
  }
});

test("Apple labels are authoritative and empty labels stay empty", () => {
  const assignHideMyEmailLabels = requireHook("assignHideMyEmailLabels");
  const assigned = assignHideMyEmailLabels([
    { hme: "apple@icloud.com", label: "Apple Project" },
    { hme: "empty@icloud.com", label: "" }
  ]);

  assert.deepEqual(assigned, [
    {
      email: "apple@icloud.com",
      appleLabel: "Apple Project",
      label: "Apple Project"
    },
    {
      email: "empty@icloud.com",
      appleLabel: "",
      label: ""
    }
  ]);
});

test("an unsafe numeric suffix is rejected before the non-idempotent generate request", async () => {
  const generateHideMyEmail = requireHook("generateHideMyEmail");
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(
    cookieFile,
    "X-APPLE-DS-WEB-SESSION-TOKEN=session;X-APPLE-WEBAUTH-TOKEN=webauth",
    "utf8"
  );
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("network must not be reached");
  };

  try {
    await assert.rejects(
      generateHideMyEmail("hme-9007199254740992", { refreshCookies: false }),
      /编号|安全范围|safe integer/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 0);
});

test("generate makes exactly one non-idempotent Apple request", async () => {
  const generateHideMyEmail = requireHook("generateHideMyEmail");
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(
    cookieFile,
    "X-APPLE-DS-WEB-SESSION-TOKEN=session;X-APPLE-WEBAUTH-TOKEN=webauth",
    "utf8"
  );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("synthetic network failure");
  };

  try {
    await assert.rejects(
      generateHideMyEmail("hme-001", { refreshCookies: false }),
      error => error.code === "GENERATION_RESULT_UNCERTAIN" && /synthetic network failure/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 1);
});

test("isolated Chrome instances never run Edge collection or change cookie files", async () => {
  const previous = process.env.HME_COOKIE_REFRESH_MODE;
  process.env.HME_COOKIE_REFRESH_MODE = "extension";
  const original = await readFile(cookieFile, "utf8");
  const calls = [];
  const restore = __test.setExecFileAsync(async (...args) => { calls.push(args); throw new Error("unexpected Edge read"); });
  try {
    assert.deepEqual(await __test.refreshICloudCookiesFromEdge(), { ok: true, skipped: true, source: "extension" });
    assert.equal(calls.length, 0);
    assert.equal(await readFile(cookieFile, "utf8"), original);
  } finally {
    restore();
    if (previous === undefined) delete process.env.HME_COOKIE_REFRESH_MODE;
    else process.env.HME_COOKIE_REFRESH_MODE = previous;
  }
});
