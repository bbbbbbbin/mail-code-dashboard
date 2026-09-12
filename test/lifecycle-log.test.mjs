import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createLifecycleLogger, flushLifecycleLog } from "../lib/lifecycle-log.mjs";

const LOGGER_MODULE_URL = new URL("../lib/lifecycle-log.mjs", import.meta.url).href;

async function withTemporaryLogDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-lifecycle-"));
  try {
    await run({ directory, filePath: join(directory, "server-lifecycle.log") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fixedClock() {
  return new Date("2026-07-27T00:00:00.000Z");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read the live log plus every surviving backup, oldest line first. */
function readAllGenerations(filePath, maxBackups) {
  const chunks = [];
  for (let index = maxBackups; index >= 1; index -= 1) {
    const path = `${filePath}.${index}`;
    if (existsSync(path)) chunks.push(readFileSync(path, "utf8"));
  }
  if (existsSync(filePath)) chunks.push(readFileSync(filePath, "utf8"));
  return chunks.join("");
}

/** Run a snippet in a child process so real exit paths can be observed. */
function runChildModule(source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 30_000
  });
}

test("each line carries the timestamp, pid and message", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, now: fixedClock, pid: 4242 });

    log("process starting");
    await flushLifecycleLog();

    assert.equal(await readFile(filePath, "utf8"), "2026-07-27T00:00:00.000Z pid=4242 process starting\n");
  });
});

test("writes append without rotating while under the size limit", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, maxBytes: 4096, now: fixedClock, pid: 1 });

    log("first");
    log("second");
    await flushLifecycleLog();

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(await exists(`${filePath}.1`), false);
  });
});

test("an oversized log rotates to .1 and the live file restarts empty", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    await writeFile(filePath, "x".repeat(300), "utf8");
    const log = createLifecycleLogger({ filePath, maxBytes: 256, now: fixedClock, pid: 7 });

    log("after rotation");
    await flushLifecycleLog();

    assert.equal(await readFile(filePath, "utf8"), "2026-07-27T00:00:00.000Z pid=7 after rotation\n");
    assert.equal(await readFile(`${filePath}.1`, "utf8"), "x".repeat(300));
  });
});

test("rotation keeps at most maxBackups generations", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, maxBytes: 64, maxBackups: 2, now: fixedClock, pid: 7 });

    // Every line is longer than 64 bytes, so each call rotates the previous one.
    log("generation one padded out beyond the limit ------------------");
    log("generation two padded out beyond the limit ------------------");
    log("generation three padded out beyond the limit ----------------");
    log("generation four padded out beyond the limit -----------------");
    await flushLifecycleLog();

    assert.match(await readFile(filePath, "utf8"), /generation four/);
    assert.match(await readFile(`${filePath}.1`, "utf8"), /generation three/);
    assert.match(await readFile(`${filePath}.2`, "utf8"), /generation two/);
    assert.equal(await exists(`${filePath}.3`), false);
  });
});

test("maxBackups 0 discards the old log instead of keeping a copy", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    await writeFile(filePath, "y".repeat(300), "utf8");
    const log = createLifecycleLogger({ filePath, maxBytes: 128, maxBackups: 0, now: fixedClock, pid: 7 });

    log("fresh start");
    await flushLifecycleLog();

    assert.equal(await readFile(filePath, "utf8"), "2026-07-27T00:00:00.000Z pid=7 fresh start\n");
    assert.equal(await exists(`${filePath}.1`), false);
  });
});

test("the size is tracked in memory so statSync only runs once", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    let statCalls = 0;
    const appended = [];
    const log = createLifecycleLogger({
      filePath,
      maxBytes: 1024,
      now: fixedClock,
      pid: 1,
      fs: {
        statSync: () => {
          statCalls += 1;
          return { size: 0 };
        },
        appendFileSync: (_path, line) => appended.push(line),
        renameSync: () => {
          throw new Error("should not rotate");
        },
        unlinkSync: () => {}
      }
    });

    log("one");
    log("two");
    log("three");
    await flushLifecycleLog();

    assert.equal(statCalls, 1);
    assert.equal(appended.length, 3);
  });
});

test("a rotation failure still lets the line through", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const appended = [];
    const log = createLifecycleLogger({
      filePath,
      maxBytes: 16,
      now: fixedClock,
      pid: 1,
      fs: {
        statSync: () => ({ size: 999 }),
        appendFileSync: (_path, line) => appended.push(line),
        renameSync: () => {
          // Windows keeps a handle on the file often enough to matter.
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        },
        unlinkSync: () => {}
      }
    });

    log("locked file");
    await flushLifecycleLog();

    assert.deepEqual(appended, ["2026-07-27T00:00:00.000Z pid=1 locked file\n"]);
  });
});

test("an append failure never throws out of the logger", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({
      filePath,
      now: fixedClock,
      pid: 1,
      fs: {
        statSync: () => ({ size: 0 }),
        appendFileSync: () => {
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
        renameSync: () => {},
        unlinkSync: () => {}
      }
    });

    assert.doesNotThrow(() => log("disk full"));
    await flushLifecycleLog();
  });
});

test("a write failure re-reads the real size on the next line", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const sizes = [0, 900];
    let statCalls = 0;
    let appendCalls = 0;
    const log = createLifecycleLogger({
      filePath,
      maxBytes: 4096,
      now: fixedClock,
      pid: 1,
      fs: {
        statSync: () => {
          statCalls += 1;
          return { size: sizes.shift() ?? 0 };
        },
        appendFileSync: () => {
          appendCalls += 1;
          if (appendCalls === 1) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        },
        renameSync: () => {},
        unlinkSync: () => {}
      }
    });

    log("one");
    log("two");
    await flushLifecycleLog();

    // The cached size is dropped after a failed write, so the second line
    // re-stats instead of trusting a count that never reached disk.
    assert.equal(statCalls, 2);
    assert.equal(appendCalls, 2);
  });
});

test("an empty log never rotates even when maxBytes is tiny", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    let rotations = 0;
    const log = createLifecycleLogger({
      filePath,
      maxBytes: 8,
      maxBackups: 1,
      now: fixedClock,
      pid: 1,
      fs: {
        statSync: () => ({ size: 0 }),
        appendFileSync: () => {},
        renameSync: () => {
          rotations += 1;
        },
        unlinkSync: () => {}
      }
    });

    log("a line that is far longer than the configured maximum");
    await flushLifecycleLog();

    assert.equal(rotations, 0);
  });
});

test("logging does not touch the disk before the caller returns", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, now: fixedClock, pid: 1 });

    log("queued, not written");

    // The whole point of the queue: no blocking write on the calling tick.
    assert.equal(existsSync(filePath), false);

    await flushLifecycleLog();
    assert.equal(existsSync(filePath), true);
  });
});

test("a burst of calls lands in call order", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, maxBytes: 1024 * 1024, now: fixedClock, pid: 1 });
    const expected = [];

    for (let index = 0; index < 200; index += 1) {
      const message = `line-${String(index).padStart(3, "0")}`;
      expected.push(message);
      log(message);
    }
    await flushLifecycleLog();

    const written = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map(line => line.split(" ").at(-1));
    assert.deepEqual(written, expected);
  });
});

test("interleaved logging and awaiting still keeps call order", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, now: fixedClock, pid: 1 });
    const expected = [];

    // Lines pushed while a drain is already in flight must not overtake it.
    for (let index = 0; index < 20; index += 1) {
      const message = `step-${String(index).padStart(2, "0")}`;
      expected.push(message);
      log(message);
      if (index % 3 === 0) await null;
      if (index % 7 === 0) await new Promise(resolve => setTimeout(resolve, 1));
    }
    await flushLifecycleLog();

    const written = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map(line => line.split(" ").at(-1));
    assert.deepEqual(written, expected);
  });
});

test("no line is lost when rotation happens in the middle of a burst", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    // Each line is 39 bytes, so 80 bytes holds two lines and every third line
    // forces a rotation while the queue is still draining.
    const maxBackups = 10;
    const log = createLifecycleLogger({ filePath, maxBytes: 80, maxBackups, now: fixedClock, pid: 1 });
    const expected = [];

    for (let index = 0; index < 8; index += 1) {
      const message = `line-${String(index).padStart(2, "0")}`;
      expected.push(message);
      log(message);
    }
    await flushLifecycleLog();

    const written = readAllGenerations(filePath, maxBackups)
      .trim()
      .split("\n")
      .map(line => line.split(" ").at(-1));
    assert.deepEqual(written, expected);
    // Two lines per generation means the burst really did rotate.
    assert.equal(existsSync(`${filePath}.3`), true);
  });
});

test("flushLifecycleLog resolves only once every line is on disk", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, now: fixedClock, pid: 1 });

    log("one");
    log("two");
    log("three");
    await flushLifecycleLog();

    // Read synchronously: nothing may still be pending once the flush resolved.
    assert.equal(readFileSync(filePath, "utf8").trim().split("\n").length, 3);
  });
});

test("flushLifecycleLog also drains lines queued while it was running", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, now: fixedClock, pid: 1 });

    log("before");
    const flushed = flushLifecycleLog();
    log("during");
    await flushed;

    assert.deepEqual(
      readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .map(line => line.split(" ").at(-1)),
      ["before", "during"]
    );
  });
});

test("an asynchronous append failure reaches neither the caller nor the flush", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    let appendCalls = 0;
    const log = createLifecycleLogger({
      filePath,
      now: fixedClock,
      pid: 1,
      fs: {
        stat: async () => ({ size: 0 }),
        appendFile: async () => {
          appendCalls += 1;
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
        rename: async () => {},
        unlink: async () => {}
      }
    });

    assert.doesNotThrow(() => log("disk full"));
    await assert.doesNotReject(flushLifecycleLog());

    // A failed line is dropped rather than retried forever, so the next call
    // still gets its own attempt.
    log("still logging");
    await flushLifecycleLog();
    assert.equal(appendCalls, 2);
  });
});

test("flushSync drains the queue without an event loop turn", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const log = createLifecycleLogger({ filePath, now: fixedClock, pid: 1 });

    log("crashing");
    log("goodbye");
    log.flushSync();

    assert.deepEqual(
      readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .map(line => line.split(" ").at(-1)),
      ["crashing", "goodbye"]
    );
    await flushLifecycleLog();
  });
});

test("the queue is capped so a stalled disk cannot grow it forever", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const appended = [];
    let releaseAppend;
    // The drain parks on this until the test lets it go, so every later line
    // piles up in the queue.
    const stalledAppend = new Promise(resolve => {
      releaseAppend = resolve;
    });
    const log = createLifecycleLogger({
      filePath,
      maxQueued: 4,
      now: fixedClock,
      pid: 1,
      fs: {
        appendFile: () => stalledAppend,
        appendFileSync: (_path, line) => appended.push(line),
        stat: async () => ({ size: 0 }),
        statSync: () => ({ size: 0 }),
        rename: async () => {},
        renameSync: () => {},
        unlink: async () => {},
        unlinkSync: () => {}
      }
    });

    for (let index = 0; index < 10; index += 1) log(`line-${index}`);
    log.flushSync();

    // The newest lines survive; the oldest ones are the ones dropped.
    assert.deepEqual(
      appended.map(line => line.split(" ").at(-1).trim()),
      ["line-6", "line-7", "line-8", "line-9"]
    );

    releaseAppend();
    await flushLifecycleLog();
  });
});

test("process.exit still puts the queued lines on disk", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    const source = `
      import { createLifecycleLogger } from ${JSON.stringify(LOGGER_MODULE_URL)};
      const log = createLifecycleLogger({ filePath: ${JSON.stringify(filePath)} });
      log("first");
      log("second");
      process.exit(0);
    `;

    const result = runChildModule(source);
    assert.equal(result.status, 0, `child failed: ${result.stderr || result.error}`);

    const written = readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(written.length, 2);
    assert.match(written[0], / first$/);
    assert.match(written[1], / second$/);
  });
});

test("logging from a beforeExit handler does not keep the loop alive", async () => {
  await withTemporaryLogDir(async ({ filePath }) => {
    // An async append would re-arm the event loop and make beforeExit fire
    // again forever; the child has to terminate on its own.
    const source = `
      import { createLifecycleLogger } from ${JSON.stringify(LOGGER_MODULE_URL)};
      const log = createLifecycleLogger({ filePath: ${JSON.stringify(filePath)} });
      process.on("beforeExit", code => log("beforeExit code=" + code));
      process.on("exit", code => log("exit code=" + code));
      log("process starting");
    `;

    const result = runChildModule(source);
    assert.equal(result.error, undefined, `child did not exit: ${result.error}`);
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);

    const written = readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(written.length, 3);
    assert.match(written[0], / process starting$/);
    assert.match(written[1], / beforeExit code=0$/);
    assert.match(written[2], / exit code=0$/);
  });
});
