import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { ClaimService } from "./lib/claim-service.mjs";
import { AutoStockService } from "./lib/auto-stock-service.mjs";
import {
  COOKIE_STALE_AFTER_MS,
  describeCookieAge,
  summarizeCookieState
} from "./lib/cookie-freshness.mjs";
import { DashboardStore } from "./lib/dashboard-store.mjs";
import {
  ForwardMailboxReader,
  normalizeForwardMailboxConfig
} from "./lib/forward-mailbox.mjs";
import { InventoryMailService } from "./lib/inventory-mail-service.mjs";
import {
  createLifecycleLogger,
  flushLifecycleLog
} from "./lib/lifecycle-log.mjs";
import { requireApiKey } from "./lib/api.mjs";
import { loadOrCreateApiKey } from "./lib/local-secret.mjs";
import { runJsonScript } from "./lib/script-runner.mjs";
import { createV1Router } from "./lib/v1-router.mjs";
import { extractVerificationCode } from "./lib/verification-code.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const scanOverlapMs = numberFromEnv("MAIL_SCAN_OVERLAP_MS", 10 * 60_000, 0, 60 * 60_000);
const fetchTimeoutMs = numberFromEnv("MAIL_FETCH_TIMEOUT_MS", 18_000, 5_000, 60_000);
const hmeCookieFile = process.env.HME_COOKIE_FILE || join(root, "runtime", "cookies.txt");
const edgeCookieRefreshScript = join(root, "scripts", "refresh_edge_icloud_cookies.py");
const edgeCookieBridgeDebugScript = join(root, "scripts", "debug_icloud_cookie_bridge.ps1");
const forwardConfigFile = process.env.MAIL_FORWARD_CONFIG || join(root, "mail-forward.config.json");
// 可覆盖是为了让测试不去动仓库里那份真实的序列文件——写坏它就等于让下一批地址重号。
const hmeLabelSequenceFile =
  process.env.HME_LABEL_SEQUENCE_FILE || join(root, "icloud-label-sequence.json");
// 和 lib/dashboard-store.mjs 的 SECRET_FILE_MODE 一致：runtime/cookies.txt 里是完整的
// iCloud 网页会话（拿到就能以主号身份操作 iCloud 邮箱），不能以默认权限落盘。
const SECRET_FILE_MODE = 0o600;
// POLYGLOT_COOKIE_CONTRACT: this list is intentionally duplicated in the Python
// fallback and Edge extension; cookie-refresh-scripts.test.mjs compares all three.
const HME_COOKIE_NAMES = [
  "X-APPLE-DS-WEB-SESSION-TOKEN",
  "X-APPLE-WEBAUTH-TOKEN",
  "X-APPLE-WEBAUTH-PCS-Mail",
  "X-APPLE-WEBAUTH-HSA-TRUST",
  "X-APPLE-WEBAUTH-LOGIN",
  "X-APPLE-WEBAUTH-USER"
];
const canonicalHmeCookieNames = new Map(
  HME_COOKIE_NAMES.map(name => [name.toLowerCase(), name])
);
// Same ceiling the v1 router applies to its own bodies.
const MAX_LEGACY_BODY_BYTES = 1_000_000;
let execFileAsync = promisify(execFile);

function numberFromEnv(name, fallback, min, max, env = process.env) {
  const value = Number(env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function resolveLifecycleLogPath(env = process.env) {
  return (
    env.MAIL_LIFECYCLE_LOG_PATH ||
    join(root, "logs", "server-lifecycle.log")
  );
}

function createRuntimeLifecycleLogger(env = process.env) {
  const filePath = resolveLifecycleLogPath(env);
  mkdirSync(dirname(filePath), { recursive: true });
  const log = createLifecycleLogger({
    filePath,
    maxBytes: numberFromEnv(
      "MAIL_LIFECYCLE_LOG_MAX_BYTES",
      2 * 1024 * 1024,
      64 * 1024,
      128 * 1024 * 1024,
      env
    ),
    maxBackups: numberFromEnv(
      "MAIL_LIFECYCLE_LOG_BACKUPS",
      2,
      0,
      10,
      env
    )
  });
  log("process starting");
  return log;
}

function installRuntimeProcessDiagnostics(
  lifecycleLog,
  {
    processLike = process,
    stdout = process.stdout,
    stderr = process.stderr,
    consoleLike = console
  } = {}
) {
  const handlers = {
    beforeExit: code => lifecycleLog(`beforeExit code=${code}`),
    exit: code => lifecycleLog(`exit code=${code}`),
    stdoutError: error => {
      if (error?.code === "EPIPE") return;
      lifecycleLog(`stdout error ${error?.stack || error}`);
    },
    stderrError: error => {
      if (error?.code === "EPIPE") return;
      lifecycleLog(`stderr error ${error?.stack || error}`);
    },
    uncaughtException: error => {
      lifecycleLog(`uncaughtException ${error?.stack || error}`);
      if (error?.code === "EPIPE") return;
      consoleLike.error(error);
    },
    unhandledRejection: reason => {
      lifecycleLog(`unhandledRejection ${reason?.stack || reason}`);
      if (reason?.code === "EPIPE") return;
      consoleLike.error(reason);
    }
  };

  processLike.on("beforeExit", handlers.beforeExit);
  processLike.on("exit", handlers.exit);
  processLike.on("uncaughtException", handlers.uncaughtException);
  processLike.on("unhandledRejection", handlers.unhandledRejection);
  stdout.on("error", handlers.stdoutError);
  stderr.on("error", handlers.stderrError);

  return () => {
    processLike.removeListener("beforeExit", handlers.beforeExit);
    processLike.removeListener("exit", handlers.exit);
    processLike.removeListener("uncaughtException", handlers.uncaughtException);
    processLike.removeListener("unhandledRejection", handlers.unhandledRejection);
    stdout.removeListener("error", handlers.stdoutError);
    stderr.removeListener("error", handlers.stderrError);
  };
}

// 唯一的测试注入点：Windows 的 fs.stat 永远报 0o666/0o444，不返回真实权限位，
// 所以"确实按 0o600 写"只能在传给 writeFile 的参数上断言。
const secretFileIo = { mkdir, writeFile, rename, unlink };
const secretFileQueues = new Map();

function setSecretFileIo(overrides) {
  const previous = { ...secretFileIo };
  Object.assign(secretFileIo, overrides);
  return () => Object.assign(secretFileIo, previous);
}

function setExecFileAsync(replacement) {
  const previous = execFileAsync;
  execFileAsync = replacement;
  return () => {
    execFileAsync = previous;
  };
}

/**
 * 按 lib/dashboard-store.mjs 的写法落盘：先写临时文件再 rename。
 *
 * 直接 writeFile 到目标路径有两个问题，两个都在这个仓库里真的会发生：
 * 崩在半路会留下被截断的文件（cookies.txt 变成半截 Cookie 头，
 * icloud-label-sequence.json 变成解析不了的 JSON）；而且 mode 只在"创建"时生效，
 * 覆盖一个早先以 0644 建出来的文件不会收紧权限。临时文件每次都是新建，
 * rename 之后目标必然是 0o600。
 */
async function writeSecretFileAtomic(targetPath, contents, io = secretFileIo) {
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await io.mkdir(directory, { recursive: true });
    await io.writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: SECRET_FILE_MODE
    });
    await io.rename(temporaryPath, targetPath);
  } catch (error) {
    // rename 失败（Windows 上多半是杀软或同步盘占着目标文件）不能留下临时文件，
    // 否则每次重试都往目录里多丢一个孤儿。
    await io.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function withSerializedSecretFile(targetPath, operation) {
  const previous = secretFileQueues.get(targetPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  secretFileQueues.set(targetPath, current);
  try {
    return await current;
  } finally {
    if (secretFileQueues.get(targetPath) === current) {
      secretFileQueues.delete(targetPath);
    }
  }
}

function writeSecretFileSerialized(targetPath, contents) {
  return withSerializedSecretFile(
    targetPath,
    () => writeSecretFileAtomic(targetPath, contents)
  );
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);
const STATIC_SECURITY_HEADERS = Object.freeze({
  // unsafe-inline. The dashboard business logic is modular now, but the
  // shared policy cannot be tightened until every static page is migrated.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
});

function defaultLegacyHandlers() {
  return {
    checkForwardedHiddenMail,
    generateHideMyEmail,
    generateHideMyEmailBatch,
    acceptEdgeCookieBridge,
    getICloudLoginStatus,
    listHideMyEmailAccounts
  };
}

function redact(value, secrets) {
  let result = String(value || "");
  for (const secret of secrets) {
    if (secret) {
      result = result.replaceAll(secret, "[redacted]");
    }
  }
  return result;
}

export function createDashboardServer({
  apiKey,
  v1Router = async () => false,
  legacyHandlers = defaultLegacyHandlers(),
  staticRoot = root,
  logger = () => {}
}) {
  return createServer(async (req, res) => {
    const suppliedKey = String(req.headers["x-api-key"] || "");
    const secrets = [String(apiKey || ""), suppliedKey];
    try {
      if (await v1Router(req, res)) {
        return;
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        requireApiKey(req.headers, apiKey);
      }

      if (req.method === "POST" && url.pathname === "/api/icloud/generate") {
        const body = await readJson(req);
        const result = await legacyHandlers.generateHideMyEmail(
          String(body.label || "").trim()
        );
        sendJson(res, result);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/api/icloud/generate-batch"
      ) {
        const body = await readJson(req);
        const result = await legacyHandlers.generateHideMyEmailBatch(
          Array.isArray(body.labels) ? body.labels : []
        );
        sendJson(res, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/forward/check") {
        const body = await readJson(req);
        const result = await legacyHandlers.checkForwardedHiddenMail(
          Array.isArray(body.accounts) ? body.accounts : []
        );
        sendJson(res, result);
        return;
      }

      // `POST /api/icloud/deactivate` used to live here and answered 501 on
      // every call, which left the trash with no way out. Final deletion is now
      // `DELETE /v1/inventory/{id}`; Apple-side deactivation stays manual on
      // purpose, because the endpoint acts on the operator's primary Apple ID.

      // The Outlook routes (`POST /api/mail/check`, `GET /api/mail-all`,
      // `GET /api/mail-body`) are gone with the Microsoft Graph/OAuth channel.
      // `mail-all` and `mail-body` also took `refresh_token` and `client_id`
      // from the query string, which leaks credentials into access logs,
      // browser history and any `Referer` the page happens to send.

      if (req.method === "POST" && url.pathname === "/api/edge-cookie-bridge") {
        const body = await readJson(req);
        const result = await legacyHandlers.acceptEdgeCookieBridge(body);
        sendJson(res, result);
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(405, {
          ...STATIC_SECURITY_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end("Method Not Allowed");
        return;
      }

      if (url.pathname === "/api/icloud/status") {
        sendJson(res, await legacyHandlers.getICloudLoginStatus());
        return;
      }

      if (url.pathname === "/api/icloud/list") {
        sendJson(res, await legacyHandlers.listHideMyEmailAccounts());
        return;
      }

      if (url.pathname === "/favicon.ico") {
        res.writeHead(204, {
          ...STATIC_SECURITY_HEADERS,
          "Cache-Control": "no-store"
        });
        res.end();
        return;
      }

      // 白名单而不是拼路径：请求路径永远不参与 join，避免目录穿越。
      const staticFiles = new Map([
        ["/", "mail-code-dashboard.html"],
        ["/mail-code-dashboard.html", "mail-code-dashboard.html"],
        ["/design-system.html", "design-system.html"],
        ["/assets/design-system.css", join("assets", "design-system.css")],
        ["/assets/dashboard.css", join("assets", "dashboard.css")],
        ["/assets/design-system.js", join("assets", "design-system.js")],
        ["/assets/dashboard-state.js", join("assets", "dashboard-state.js")],
        ["/assets/dashboard-api.js", join("assets", "dashboard-api.js")],
        ["/assets/dashboard-mail.js", join("assets", "dashboard-mail.js")],
        ["/assets/dashboard-ui.js", join("assets", "dashboard-ui.js")],
        ["/assets/dashboard.js", join("assets", "dashboard.js")]
      ]);
      const fileName = staticFiles.get(url.pathname);
      if (!fileName) {
        res.writeHead(404, {
          ...STATIC_SECURITY_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end("Not Found");
        return;
      }

      const filePath = join(staticRoot, fileName);
      const content = await readFile(filePath);
      res.writeHead(200, {
        ...STATIC_SECURITY_HEADERS,
        "Content-Type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(content);
    } catch (error) {
      const status = error.status || (error.code === "ENOENT" ? 404 : 500);
      const safeLog = redact(error?.stack || error, secrets);
      logger(safeLog);
      if (req.url?.startsWith("/api/")) {
        const message =
          status >= 500
            ? "请求失败"
            : redact(error.message || "请求失败", secrets);
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: message }));
        return;
      }
      res.writeHead(status, {
        ...STATIC_SECURITY_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(status === 404 ? "Not Found" : "Request failed");
    }
  });
}

export function startDashboardServer(
  server,
  { env = process.env, port: listenPort = 4173, onListening } = {}
) {
  const host = String(env.HOST || "127.0.0.1").trim();
  if (host !== "127.0.0.1") {
    throw new Error("HOST must be 127.0.0.1");
  }
  server.listen(listenPort, host, onListening);
  return { host, port: listenPort };
}

function closeHttpServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    try {
      server.close(error => {
        if (error) {
          if (error.code === "ERR_SERVER_NOT_RUNNING") {
            resolveClose();
            return;
          }
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") {
        resolveClose();
        return;
      }
      rejectClose(error);
    }
  });
}

export function createGracefulShutdown({
  server,
  store,
  autoStock,
  flushLog = flushLifecycleLog,
  log = () => {},
  timeoutMs = 10_000,
  forceExit = code => process.exit(code)
}) {
  let shutdownPromise = null;
  const boundedTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : 10_000;

  return function shutdown(signal = "shutdown") {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    let settle;
    shutdownPromise = new Promise(resolveShutdown => {
      settle = resolveShutdown;
    });

    void (async () => {
      log(`shutdown requested signal=${signal}`);

      // close() is invoked before any await, so the first signal immediately
      // stops accepting new connections. Existing requests and the store write
      // they may have queued are allowed to finish inside the same deadline.
      const serverClosed = closeHttpServer(server);
      const backgroundStopped = autoStock?.stop();
      const cleanup = (async () => {
        const failures = [];
        try {
          await serverClosed;
        } catch (error) {
          failures.push(error);
        }
        try {
          await backgroundStopped;
          await store?.waitForIdle?.();
        } catch (error) {
          failures.push(error);
        }
        try {
          await flushLog();
        } catch (error) {
          failures.push(error);
        }
        if (!failures.length) {
          return { kind: "complete" };
        }
        return {
          kind: "failed",
          error:
            failures.length === 1
              ? failures[0]
              : new AggregateError(
                  failures,
                  "Graceful shutdown cleanup failed"
                )
        };
      })();

      let timeoutHandle;
      const timeout = new Promise(resolveTimeout => {
        timeoutHandle = setTimeout(
          () => resolveTimeout({ kind: "timeout" }),
          boundedTimeoutMs
        );
      });
      const outcome = await Promise.race([cleanup, timeout]);

      if (outcome.kind === "complete") {
        clearTimeout(timeoutHandle);
        return { signal, timedOut: false };
      }

      if (outcome.kind === "timeout") {
        log(`shutdown timeout signal=${signal} timeoutMs=${boundedTimeoutMs}`);
      } else {
        clearTimeout(timeoutHandle);
        log(
          `shutdown failed signal=${signal} ${outcome.error?.stack || outcome.error}`
        );
      }

      // Node's close() waits for active sockets. At the deadline they must not
      // keep the process alive indefinitely; the lifecycle logger's exit hook
      // performs the final synchronous flush when forceExit is the real
      // process.exit.
      try {
        server.closeAllConnections?.();
      } catch {
        // The force-exit fallback below remains authoritative.
      }
      forceExit(1);
      return {
        signal,
        timedOut: outcome.kind === "timeout",
        ...(outcome.kind === "failed" ? { error: outcome.error } : {})
      };
    })().then(
      settle,
      error => {
        try {
          log(`shutdown crashed signal=${signal} ${error?.stack || error}`);
        } finally {
          forceExit(1);
          settle({ signal, timedOut: false });
        }
      }
    );

    return shutdownPromise;
  };
}

export function installGracefulShutdownSignals(
  shutdown,
  { processLike = process } = {}
) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    processLike.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      processLike.removeListener(signal, handler);
    }
  };
}

async function createRuntimeDashboardServer(
  env = process.env,
  { lifecycleLog = () => {}, autoStockOptions = {} } = {}
) {
  const statePath =
    env.MAIL_DASHBOARD_STATE_PATH ||
    join(root, "runtime", "dashboard-state-v1.json");
  const backupDir =
    env.MAIL_DASHBOARD_BACKUP_DIR || join(root, "runtime", "backups");
  const keyPath =
    env.MAIL_DASHBOARD_API_KEY_FILE || join(root, "runtime", "api-key.txt");
  const configPath =
    env.MAIL_FORWARD_CONFIG || join(root, "mail-forward.config.json");
  const store = new DashboardStore({ statePath, backupDir });
  const claimService = new ClaimService({ store });
  const mailboxReader = new ForwardMailboxReader({ configPath });
  const inventoryMailService = new InventoryMailService({
    store,
    mailboxReader
  });
  const apiKeyState = await loadOrCreateApiKey({ env, keyPath });
  const autoStock = new AutoStockService({
    store, generateBatch: generateHideMyEmailBatch, generateOne: generateHideMyEmail,
    logger: lifecycleLog, ...autoStockOptions
  });
  const v1Router = createV1Router({
    apiKey: apiKeyState.key,
    claimService,
    store,
    mailboxReader,
    inventoryMailService,
    autoStockService: autoStock,
    listAliases: async () => {
      const result = await listHideMyEmailAccounts();
      return result.emails;
    }
  });
  const server = createDashboardServer({
    apiKey: apiKeyState.key,
    v1Router,
    legacyHandlers: {
      ...defaultLegacyHandlers(),
      generateHideMyEmail: label => autoStock.manualOne(label),
      generateHideMyEmailBatch: labels => autoStock.manualBatch(labels)
    },
    logger: message => lifecycleLog(`request error ${message}`)
  });
  server.on("listening", () => autoStock.start());
  server.on("close", () => { void autoStock.stop(); });
  return {
    apiKeyStatus: {
      source: apiKeyState.source,
      keyPath: apiKeyState.keyPath
    },
    server,
    autoStock,
    store
  };
}

if (isMainModule()) {
  const lifecycleLog = createRuntimeLifecycleLogger(process.env);
  installRuntimeProcessDiagnostics(lifecycleLog);
  const runtime = await createRuntimeDashboardServer(process.env, {
    lifecycleLog
  });
  runtime.server.on("close", () => lifecycleLog("http server closed"));
  runtime.server.on("error", error =>
    lifecycleLog(`http server error ${error?.stack || error}`)
  );
  const shutdown = createGracefulShutdown({
    server: runtime.server,
    store: runtime.store,
    autoStock: runtime.autoStock,
    log: lifecycleLog
  });
  installGracefulShutdownSignals(shutdown);
  startDashboardServer(runtime.server, {
    env: process.env,
    port,
    onListening: () => {
      console.log(`Mail code dashboard: http://127.0.0.1:${port}`);
      console.log(
        runtime.apiKeyStatus.keyPath
          ? `API key file: ${runtime.apiKeyStatus.keyPath}`
          : "API key source: environment"
      );
      lifecycleLog(`listening host=127.0.0.1 port=${port}`);
    }
  });
}

function validateHideMyEmailLabel(label) {
  if (!label) {
    const error = new Error("缺少标签");
    error.status = 400;
    throw error;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}-[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(label)) {
    const error = new Error("为保护主号，标签必须使用固定前缀，例如 hme-001");
    error.status = 400;
    throw error;
  }
  const numericSuffix = String(label).match(/-(\d+)$/)?.[1];
  if (numericSuffix) assertSafeHideMyEmailLabelNumber(numericSuffix);
}

function assertSafeHideMyEmailLabelNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    const error = new Error("标签编号超出安全范围");
    error.status = 400;
    throw error;
  }
  return number;
}

async function generateHideMyEmailBatch(labels) {
  const cleanLabels = labels.map(label => String(label || "").trim()).filter(Boolean);
  if (!cleanLabels.length) {
    const error = new Error("缺少标签");
    error.status = 400;
    throw error;
  }
  if (cleanLabels.length > 5) {
    const error = new Error("单批最多生成 5 个隐藏邮箱");
    error.status = 400;
    throw error;
  }
  for (const label of cleanLabels) validateHideMyEmailLabel(label);

  await refreshICloudCookiesIfNeeded().catch(error => {
    console.warn(`${new Date().toISOString()} Edge iCloud cookie refresh skipped: ${error.message}`);
  });

  const generated = [];
  const errors = [];
  for (const label of cleanLabels) {
    try {
      generated.push(await generateHideMyEmail(label, { refreshCookies: false }));
    } catch (error) {
      errors.push({ label, error: error.message || String(error), ...(error.code ? { code: error.code } : {}) });
      if (!generated.length || error.code === "GENERATION_RESULT_UNCERTAIN") break;
    }
  }
  return { generated, errors };
}

async function generateHideMyEmail(label, options = {}) {
  validateHideMyEmailLabel(label);

  if (options.refreshCookies !== false) {
    await refreshICloudCookiesIfNeeded().catch(error => {
      console.warn(`${new Date().toISOString()} Edge iCloud cookie refresh skipped: ${error.message}`);
    });
  }
  const cookies = (await readFile(hmeCookieFile, "utf8")).trim();
  if (!cookies.includes("X-APPLE")) throw new Error("cookies.txt 不像 iCloud 登录 cookie");

  const headers = {
    "Connection": "keep-alive",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Content-Type": "text/plain",
    "Accept": "*/*",
    "Origin": "https://www.icloud.com",
    "Referer": "https://www.icloud.com/",
    "Cookie": cookies
  };
  const params = new URLSearchParams({
    clientBuildNumber: "2536Project32",
    clientMasteringNumber: "2536B20",
    clientId: "",
    dsid: ""
  });

  // attempts=1 是刻意的：generate 不幂等。请求体里没有任何标识这次调用的东西，
  // Apple 每收到一次就铸一个新地址并扣一次配额。超时只是"我们放弃等了"，不代表
  // 请求没送到——重试很可能凭空多出一个谁也不知道的孤儿地址。宁可让操作者重点一次。
  let genRes;
  let genData;
  try {
    genRes = await fetchWithRetry(`https://p68-maildomainws.icloud.com/v1/hme/generate?${params}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ langCode: "en-us" })
  }, "iCloud generate", 1, fetchTimeoutMs);
    genData = await genRes.json();
  } catch (error) {
    error.code = "GENERATION_RESULT_UNCERTAIN";
    throw error;
  }
  if (!genRes.ok || !genData?.success) throw new Error(hmeErrorMessage(genData, "生成失败"));
  const email = genData.result?.hme;
  try {
  if (!email) throw new Error("iCloud 没有返回隐藏邮箱地址");
  const reserveLabel = await nextReservedHideMyEmailLabel(label);

  // reserve 反过来：请求体把 hme 和 label 都钉死了，重放一次既不会铸新地址、
  // 也不会再吃掉一个序号，最坏结果是 Apple 回一句"已保留"——和不重试时看到的失败
  // 是同一种。而地址此刻已经生成、配额已经扣掉，放弃它才是真损失，所以这里留着重试。
  const reserveRes = await fetchWithRetry(`https://p68-maildomainws.icloud.com/v1/hme/reserve?${params}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      hme: email,
      label: reserveLabel,
      note: "Generated by local mail code dashboard"
    })
  }, "iCloud reserve", 2, fetchTimeoutMs);
  const reserveData = await reserveRes.json();
  if (!reserveRes.ok || !reserveData?.success) throw new Error(hmeErrorMessage(reserveData, "保留失败"));

  return { email, label: reserveLabel };
  } catch (error) {
    error.code = "GENERATION_RESULT_UNCERTAIN";
    throw error;
  }
}

/**
 * 读取 Apple 那边的隐藏邮箱列表；返回值直接喂给 DashboardStore#syncAliases。
 *
 * @param {object} [options]
 * @param {boolean} [options.refreshCookies] 关掉可以跳过外部刷新脚本（测试用）。
 */
async function listHideMyEmailAccounts({
  refreshCookies = true
} = {}) {
  if (refreshCookies) {
    await refreshICloudCookiesFromEdge().catch(error => {
      console.warn(`${new Date().toISOString()} Edge iCloud cookie refresh skipped: ${error.message}`);
    });
  }
  const cookies = (await readFile(hmeCookieFile, "utf8")).trim();
  if (!cookies.includes("X-APPLE")) throw new Error("cookies.txt 不像 iCloud 登录 cookie");

  const params = new URLSearchParams({
    clientBuildNumber: "2536Project32",
    clientMasteringNumber: "2536B20",
    clientId: "",
    dsid: ""
  });
  const response = await fetchWithRetry(`https://p68-maildomainws.icloud.com/v2/hme/list?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Origin": "https://www.icloud.com",
      "Referer": "https://www.icloud.com/",
      "Cookie": cookies
    }
  }, "iCloud list", 2, fetchTimeoutMs);
  const data = await response.json();
  if (!response.ok || !data?.success) throw new Error(hmeErrorMessage(data, "读取隐藏邮箱列表失败"));
  const rows = Array.isArray(data.result?.hmeEmails) ? data.result.hmeEmails : [];
  return {
    emails: assignHideMyEmailLabels(
      rows.filter(row => row?.hme && row.isActive !== false)
    )
  };
}

/**
 * Apple 标签是隐藏邮箱的唯一权威标签。`label` 暂时作为兼容字段保留，
 * 但它与 `appleLabel` 必须相同；Apple 返回空标签时也不编造本地编号。
 */
function assignHideMyEmailLabels(rows) {
  return rows.map(row => {
    const appleLabel = String(row.label || "");
    return {
      email: row.hme,
      appleLabel,
      label: appleLabel
    };
  });
}

async function nextReservedHideMyEmailLabel(requestedLabel) {
  const match = String(requestedLabel || "").match(/^([A-Za-z0-9][A-Za-z0-9_-]{0,31})-(\d+)$/);
  if (!match) return requestedLabel;
  const prefix = match[1];
  const requestedNumber = assertSafeHideMyEmailLabelNumber(match[2]);
  return withSerializedSecretFile(hmeLabelSequenceFile, async () => {
    const sequence = await readHideMyEmailLabelSequence();
    const currentNumber = Number(sequence[prefix] || 0);
    const nextNumber = Math.max(currentNumber + 1, requestedNumber);
    if (!Number.isSafeInteger(nextNumber)) {
      throw new Error(`iCloud 标签序列 ${prefix} 已超出安全范围`);
    }
    sequence[prefix] = nextNumber;
    await writeSecretFileAtomic(
      hmeLabelSequenceFile,
      `${JSON.stringify(sequence, null, 2)}\n`
    );
    return `${prefix}-${String(nextNumber).padStart(3, "0")}`;
  });
}

async function readHideMyEmailLabelSequence() {
  try {
    const sequence = JSON.parse(await readFile(hmeLabelSequenceFile, "utf8"));
    if (!sequence || typeof sequence !== "object" || Array.isArray(sequence)) {
      throw new Error("根节点必须是对象");
    }
    for (const [prefix, value] of Object.entries(sequence)) {
      if (
        !prefix ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw new Error(`无效序列项 ${prefix}`);
      }
    }
    return sequence;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`iCloud 标签序列文件损坏：${error.message}`, { cause: error });
  }
}

// 三条刷新路径全部失败时，唯一的痕迹以前只有 err.log；把最后一次失败留在内存里，
// /api/icloud/status 才能告诉操作者「为什么」而不是只说「登录态待处理」。
let lastCookieRefreshFailure = null;

async function refreshICloudCookiesFromEdge({
  platform = process.platform
} = {}) {
  // Isolated Chrome instances must never import another profile's Edge login.
  if (process.env.HME_COOKIE_REFRESH_MODE === "extension") {
    return { ok: true, skipped: true, source: "extension" };
  }
  if (platform !== "win32") {
    const error = new Error(
      "iCloud Cookie 自动刷新平台不可用：CDP/DPAPI 刷新仅支持 Windows；请改用 Edge 扩展同步 Cookie。"
    );
    error.code = "PLATFORM_UNAVAILABLE";
    lastCookieRefreshFailure = {
      at: new Date().toISOString(),
      message: error.message
    };
    throw error;
  }

  const reasons = [];
  try {
    const bridge = await runJsonScript({
      execFileAsync,
      file: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        edgeCookieBridgeDebugScript,
        "-CookieFile",
        hmeCookieFile
      ],
      options: {
        timeout: 35_000,
        windowsHide: true,
        maxBuffer: 1024 * 256
      },
      label: "iCloud Cookie Bridge 同步"
    });
    lastCookieRefreshFailure = null;
    return bridge;
  } catch (bridgeError) {
    reasons.push(bridgeError.message);
    console.warn(`${new Date().toISOString()} iCloud cookie bridge sync skipped: ${bridgeError.message}`);
  }

  try {
    const status = await withSerializedSecretFile(hmeCookieFile, async () => {
      const refreshed = await runJsonScript({
        execFileAsync,
        file: "python",
        args: [edgeCookieRefreshScript, "--payload"],
        options: {
          timeout: 20_000,
          windowsHide: true,
          maxBuffer: 1024 * 128
        },
        label: "Edge cookie 刷新",
        sensitiveOutput: true
      });
      const { cookieHeader, ...publicStatus } = refreshed;
      if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
        throw new Error("Edge cookie 刷新失败：脚本没有返回 Cookie payload");
      }
      await writeSecretFileAtomic(hmeCookieFile, cookieHeader);
      return publicStatus;
    });
    lastCookieRefreshFailure = null;
    return status;
  } catch (refreshError) {
    reasons.push(refreshError.message);
    // 两条路径的失败原因通常不同（CDP 没开 / DPAPI 解不开），一起留着才够诊断。
    lastCookieRefreshFailure = {
      at: new Date().toISOString(),
      message: reasons.join(" / ")
    };
    throw refreshError;
  }
}

async function readCookieState() {
  const [cookies, file] = await Promise.all([
    readFile(hmeCookieFile, "utf8"),
    stat(hmeCookieFile)
  ]);
  return {
    summary: summarizeCookieState({ cookies, mtimeMs: file.mtimeMs }),
    mtime: file.mtime
  };
}

async function refreshICloudCookiesIfNeeded() {
  try {
    const { summary } = await readCookieState();
    if (!summary.stale) return { ok: true, skipped: true };
  } catch {
    // Missing or unreadable cookies fall through to the Edge refresh path.
  }
  return refreshICloudCookiesFromEdge();
}

async function getICloudLoginStatus() {
  try {
    const { summary, mtime } = await readCookieState();
    const status = {
      ok: summary.complete,
      lastSyncedAt: mtime.toISOString(),
      ageMinutes: summary.ageMinutes,
      stale: summary.stale,
      staleAfterMinutes: Math.round(COOKIE_STALE_AFTER_MS / 60_000),
      hasSessionToken: summary.hasSessionToken,
      hasWebauthToken: summary.hasWebauthToken,
      hasMailPcs: summary.hasMailPcs
    };
    if (summary.complete && summary.stale) {
      status.staleReason = `iCloud cookie 已 ${describeCookieAge(summary.ageMinutes)} 没有刷新，自动刷新可能已失效，请手动同步。`;
    }
    if (lastCookieRefreshFailure) {
      status.lastRefreshError = lastCookieRefreshFailure.message;
      status.lastRefreshErrorAt = lastCookieRefreshFailure.at;
    }
    return status;
  } catch (error) {
    return {
      ok: false,
      stale: true,
      error: "没有检测到 iCloud 登录态，请在对应账号的浏览器登录 iCloud，并用扩展同步。",
      ...(lastCookieRefreshFailure
        ? {
            lastRefreshError: lastCookieRefreshFailure.message,
            lastRefreshErrorAt: lastCookieRefreshFailure.at
          }
        : {})
    };
  }
}

async function acceptEdgeCookieBridge(body) {
  const cookies = Array.isArray(body?.cookies) ? body.cookies : [];
  const filtered = [];
  for (const item of cookies) {
    if (!item || typeof item.name !== "string") continue;
    const name = canonicalHmeCookieNames.get(item.name.toLowerCase());
    if (!name) continue;
    if (typeof item.value !== "string" || !isSafeBridgeCookieValue(item.value)) {
      throw bridgePayloadError(`iCloud cookie ${name} 的值无效`);
    }
    filtered.push({ name, value: item.value.trim() });
  }
  if (!filtered.length) {
    throw bridgePayloadError("没有收到 Apple/iCloud cookie");
  }
  const deduped = new Map();
  for (const item of filtered) deduped.set(item.name, item.value);
  if (!deduped.has("X-APPLE-DS-WEB-SESSION-TOKEN") || !deduped.has("X-APPLE-WEBAUTH-TOKEN")) {
    throw bridgePayloadError(
      "缺少必要 iCloud 登录 cookie，请确认对应浏览器已登录 iCloud.com"
    );
  }
  const header = Array.from(deduped, ([name, value]) => `${name}=${value}`).join(";");
  await writeSecretFileSerialized(hmeCookieFile, header);
  return {
    ok: true,
    count: deduped.size,
    hasMailPcs: deduped.has("X-APPLE-WEBAUTH-PCS-Mail")
  };
}

function isSafeBridgeCookieValue(value) {
  const normalized = String(value).trim();
  return Boolean(
    normalized &&
      !/[\u0000-\u001f\u007f;]/u.test(value)
  );
}

function bridgePayloadError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function hmeErrorMessage(data, fallback) {
  const error = data?.error;
  if (typeof error === "object" && error?.errorMessage) return error.errorMessage;
  if (data?.reason) return data.reason;
  return fallback;
}

async function checkForwardedHiddenMail(accounts) {
  const config = await readForwardConfig();
  const updates = [];
  const errors = [];
  const checked = [];
  if (!config.enabled) {
    return { updates, errors: [{ email: "", message: config.message }], checked };
  }

  await withPasswordImapClient(config, async client => {
    const targets = accounts
      .filter(account => account?.email)
      .map(account => ({
        ...account,
        lowerEmail: String(account.email).toLowerCase(),
        floor: account.lastReceivedAt ? new Date(applyScanOverlap(account.lastReceivedAt)) : null
      }));
    if (!targets.length) return;

    for (const mailbox of config.mailboxes) {
      try {
        await client.mailboxOpen(mailbox, { readOnly: true });
      } catch {
        continue;
      }
      const allUids = await client.search({ all: true }, { uid: true });
      const latestUids = allUids.slice(-config.messageLimit).reverse();
      for (const uid of latestUids) {
        for await (const message of client.fetch([uid], {
          envelope: true,
          source: true,
          internalDate: true
        }, { uid: true })) {
          const receivedAt = (message.internalDate || message.envelope?.date || new Date()).toISOString();
          const raw = message.source ? message.source.toString("utf8") : "";
          const rawLower = raw.toLowerCase();
          const parsed = await parseRawMail(raw, message.envelope?.subject || "邮件", receivedAt);
          for (const target of targets) {
            if (target.floor && new Date(receivedAt) <= target.floor) continue;
            if (!rawLower.includes(target.lowerEmail)) continue;
            if (updates.some(item => item.email.toLowerCase() === target.lowerEmail && new Date(item.receivedAt) >= new Date(receivedAt))) continue;
            updates.push({
              email: target.email,
              code: parsed.code,
              subject: parsed.subject,
              preview: parsed.preview,
              receivedAt: parsed.receivedAt,
              method: `Forward IMAP/${mailbox}`,
              noCodeReason: parsed.code ? "" : "收到转发邮件，但未识别到验证码；请点“查看邮件”核对内容"
            });
          }
        }
      }
    }
  }).catch(error => {
    errors.push({ email: "", message: simplifyAuthError(error.message || String(error)) });
  });

  for (const account of accounts) {
    if (account?.email) checked.push({ email: account.email, checkedAt: new Date().toISOString() });
  }
  return { updates, errors, checked };
}

async function readForwardConfig(path = forwardConfigFile) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { enabled: false, message: "尚未配置转发邮箱。需要 mail-forward.config.json，里面填邮箱和 IMAP 授权码。" };
  }

  try {
    return {
      enabled: true,
      ...normalizeForwardMailboxConfig(config)
    };
  } catch {
    return { enabled: false, message: "转发邮箱配置缺少或包含无效的 email/password、端口或扫描参数。请检查 mail-forward.config.json。" };
  }
}

async function withPasswordImapClient(config, worker) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.email, pass: config.password },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: fetchTimeoutMs,
    logger: false
  });
  let socketError = null;
  client.on("error", error => {
    socketError = error;
  });
  try {
    await client.connect();
    return await worker(client);
  } catch (error) {
    throw socketError || error;
  } finally {
    await client.logout().catch(() => {});
  }
}

function applyScanOverlap(value) {
  if (!value || !scanOverlapMs) return value || "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  return new Date(Math.max(0, time - scanOverlapMs)).toISOString();
}

async function fetchWithRetry(url, options = {}, label = "fetch", attempts = 2, timeoutMs = 12_000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(350 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  const detail = lastError?.cause?.code || lastError?.cause?.message || lastError?.message || "unknown error";
  throw new Error(`${label} failed: ${detail}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeMimeText(text) {
  return String(text)
    .replace(/=\r?\n/g, "")
    .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeBodyText(value) {
  return decodeMimeText(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function isImapAuthError(message) {
  return /AUTHENTICATE failed|Invalid credentials/i.test(message);
}

function isTimeoutError(message) {
  return /ETIMEOUT|Socket timeout|timed?\s*out|NoConnection|Connection not available|ECONNRESET/i.test(message);
}

// 只剩转发邮箱一条收件链路，所以这里不再区分 OAuth 与 Graph：
// 唯一的凭据是 mail-forward.config.json 里的 IMAP 授权码。
function simplifyAuthError(message) {
  if (isImapAuthError(message)) {
    return "转发邮箱 IMAP 登录失败，请核对 mail-forward.config.json 里的邮箱和授权码";
  }
  if (isTimeoutError(message)) {
    return "转发邮箱 IMAP 超时，本轮未查到邮件；这不代表邮箱失效，可稍后重试";
  }
  return message;
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    // Without this the whole body is buffered in memory before anything looks
    // at it. `lib/v1-router.mjs` has had the same cap since it was written.
    length += chunk.length;
    if (length > MAX_LEGACY_BODY_BYTES) {
      const error = new Error("请求体过大");
      error.status = 400;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, data) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

async function parseRawMail(raw, fallbackSubject = "邮件", fallbackReceivedAt = new Date().toISOString()) {
  const parsed = await simpleParser(raw);
  const subject = parsed.subject || fallbackSubject;
  const bodyText = normalizeBodyText(parsed.text || parsed.html || parsed.textAsHtml || "");
  const preview = bodyText.slice(0, 600);
  const code = extractVerificationCode(`${subject}\n${bodyText}`);
  const receivedAt = parsed.date ? parsed.date.toISOString() : fallbackReceivedAt;
  return { code, subject, preview, receivedAt };
}

export const __test = {
  acceptEdgeCookieBridge,
  assignHideMyEmailLabels,
  createRuntimeLifecycleLogger,
  createRuntimeDashboardServer,
  generateHideMyEmail,
  getICloudLoginStatus,
  installRuntimeProcessDiagnostics,
  nextReservedHideMyEmailLabel,
  readForwardConfig,
  refreshICloudCookiesFromEdge,
  simplifyAuthError,
  setExecFileAsync,
  setSecretFileIo,
  validateHideMyEmailLabel,
  writeSecretFileAtomic,
  normalizeBodyText,
  parseRawMail,
  resolveLifecycleLogPath
};

function isMainModule() {
  return /(^|[\\/])server\.mjs$/i.test(process.argv[1] || "");
}
