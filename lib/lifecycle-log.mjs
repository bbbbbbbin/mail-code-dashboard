import { appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { appendFile, rename, stat, unlink } from "node:fs/promises";

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_BACKUPS = 2;
export const DEFAULT_MAX_QUEUED = 1000;

const DEFAULT_FS = {
  appendFile,
  rename,
  stat,
  unlink,
  appendFileSync,
  renameSync,
  statSync,
  unlinkSync
};

// Every logger registers itself so `flushLifecycleLog()` and the process hooks
// can drain all of them without the app wiring anything up per logger.
const activeLoggers = new Set();
let processHooksInstalled = false;
// Once the runtime starts shutting down, queueing an async append would keep the
// event loop alive and make `beforeExit` fire again -- forever. From that point
// every line goes straight to disk instead.
let shuttingDown = false;

function installProcessHooks() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  const stop = () => {
    shuttingDown = true;
    flushLifecycleLogSync();
  };
  // Listeners run in registration order and the logger is always built before
  // the app registers its own exit handlers, so the lines those handlers write
  // land on the synchronous path above and still reach the disk.
  process.on("beforeExit", stop);
  process.on("exit", stop);
}

/**
 * Build the lifecycle logger.
 *
 * Calls are fire-and-forget: the line is queued and written by a single serial
 * drain, so a slow disk never blocks the event loop. Rotation can never
 * interleave with an append because both happen inside one drain iteration.
 *
 * The size is tracked in memory so the steady-state cost stays one append;
 * `stat` only runs once per process, and again after a write fails, so an
 * externally truncated or deleted file re-syncs.
 *
 * `fs` stays injectable. An object carrying only the `*Sync` members still
 * works -- the async paths fall back to them.
 */
export function createLifecycleLogger({
  filePath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxBackups = DEFAULT_MAX_BACKUPS,
  maxQueued = DEFAULT_MAX_QUEUED,
  fs = DEFAULT_FS,
  now = () => new Date(),
  pid = process.pid
} = {}) {
  /** @type {{ line: string, bytes: number }[]} */
  const queue = [];
  let knownSize = null;
  let draining = null;

  const canWriteSync = typeof fs.appendFileSync === "function";

  function readSizeSync() {
    const stats = fs.statSync(filePath, { throwIfNoEntry: false });
    return stats ? stats.size : 0;
  }

  async function readSize() {
    if (typeof fs.stat !== "function") return readSizeSync();
    try {
      const stats = await fs.stat(filePath);
      return stats ? stats.size : 0;
    } catch (error) {
      // The promise API throws where `statSync({ throwIfNoEntry: false })`
      // returns undefined; a log file that does not exist yet is just empty.
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
  }

  async function removeFile(path) {
    if (typeof fs.unlink === "function") return fs.unlink(path);
    return fs.unlinkSync(path);
  }

  async function moveFile(from, to) {
    if (typeof fs.rename === "function") return fs.rename(from, to);
    return fs.renameSync(from, to);
  }

  function needsRotation(bytes) {
    return knownSize !== null && knownSize > 0 && knownSize + bytes > maxBytes;
  }

  /**
   * Shift `file.1 -> file.2`, `file -> file.1`, and drop whatever fell off the
   * end. Mirrored below in `rotateSync` because the exit path cannot await.
   */
  async function rotate() {
    if (maxBackups < 1) {
      await removeFile(filePath);
      return;
    }
    try {
      await removeFile(`${filePath}.${maxBackups}`);
    } catch {
      // The oldest backup does not have to exist yet.
    }
    for (let index = maxBackups - 1; index >= 1; index -= 1) {
      try {
        await moveFile(`${filePath}.${index}`, `${filePath}.${index + 1}`);
      } catch {
        // A gap in the backup chain is fine; keep shifting the rest.
      }
    }
    await moveFile(filePath, `${filePath}.1`);
  }

  function rotateSync() {
    if (maxBackups < 1) {
      fs.unlinkSync(filePath);
      return;
    }
    try {
      fs.unlinkSync(`${filePath}.${maxBackups}`);
    } catch {
      // The oldest backup does not have to exist yet.
    }
    for (let index = maxBackups - 1; index >= 1; index -= 1) {
      try {
        fs.renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
      } catch {
        // A gap in the backup chain is fine; keep shifting the rest.
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
  }

  async function writeEntry(entry) {
    try {
      if (knownSize === null) knownSize = await readSize();
      if (needsRotation(entry.bytes)) {
        await rotate();
        knownSize = 0;
      }
    } catch {
      // A locked or vanished log file must not stop the line from being written.
      knownSize = null;
    }

    try {
      if (typeof fs.appendFile === "function") await fs.appendFile(filePath, entry.line);
      else fs.appendFileSync(filePath, entry.line);
      if (knownSize !== null) knownSize += entry.bytes;
    } catch {
      // Logging must never take the server down.
      knownSize = null;
    }
  }

  function writeEntrySync(entry) {
    try {
      if (knownSize === null) knownSize = readSizeSync();
      if (needsRotation(entry.bytes)) {
        rotateSync();
        knownSize = 0;
      }
    } catch {
      knownSize = null;
    }

    try {
      fs.appendFileSync(filePath, entry.line);
      if (knownSize !== null) knownSize += entry.bytes;
    } catch {
      knownSize = null;
    }
  }

  function schedule() {
    if (draining) return draining;
    draining = (async () => {
      try {
        while (queue.length > 0) {
          const entry = queue[0];
          // The entry stays queued while it is in flight so a synchronous exit
          // flush can still rescue it. Worst case that writes the line twice --
          // on the way out a duplicate beats a missing last line.
          await writeEntry(entry);
          if (queue[0] === entry) queue.shift();
        }
      } catch {
        // Nothing here should throw, but an unhandled rejection out of a logger
        // would be worse than a lost line.
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  /** Resolve once everything queued so far has been handed to the disk. */
  async function flush() {
    while (queue.length > 0 || draining) {
      await (draining ?? schedule());
    }
  }

  /**
   * The exit-path fallback: `process.on("exit")` and friends run with a dead
   * event loop, so the only way the tail of the queue reaches the disk is a
   * blocking write. Those last lines are the ones worth having.
   */
  function flushSync() {
    if (queue.length === 0) return;
    if (!canWriteSync) {
      // A custom fs without a synchronous escape hatch (test doubles); the async
      // drain is the only way these lines can still land.
      schedule();
      return;
    }
    const pending = queue.splice(0, queue.length);
    for (const entry of pending) writeEntrySync(entry);
  }

  function lifecycleLog(message) {
    const line = `${now().toISOString()} pid=${pid} ${message}\n`;
    queue.push({ line, bytes: Buffer.byteLength(line) });
    // A fire-and-forget queue must not grow without bound when the disk stalls.
    // Overflow drops the oldest lines: in an error storm the newest ones are
    // what explain the failure.
    while (queue.length > maxQueued) queue.shift();

    if (shuttingDown) flushSync();
    else schedule();
  }

  lifecycleLog.flush = flush;
  lifecycleLog.flushSync = flushSync;

  activeLoggers.add(lifecycleLog);
  installProcessHooks();

  return lifecycleLog;
}

/**
 * Drain every logger built by `createLifecycleLogger`. Graceful shutdown awaits
 * this before it lets the process go.
 */
export async function flushLifecycleLog() {
  await Promise.all(
    [...activeLoggers].map(logger =>
      // A shutdown path must not blow up because a log line could not be written.
      logger.flush().catch(() => {})
    )
  );
}

/** The synchronous twin of `flushLifecycleLog`, for exit handlers. */
export function flushLifecycleLogSync() {
  for (const logger of activeLoggers) {
    try {
      logger.flushSync();
    } catch {
      // Nothing left to do this late.
    }
  }
}
