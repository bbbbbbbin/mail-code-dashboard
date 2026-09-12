import { ApiError } from "./api.mjs";

export const AUTO_STOCK_TARGET = 1500;
export const AUTO_STOCK_BATCH_SIZE = 5;
export const AUTO_STOCK_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const RECOVERY = "上次生成结果待核对，请先同步 iCloud，再重新开启自动生成。";

function settings(state) {
  return {
    configured: false, enabled: false, prefix: "hme",
    lastGeneratedAt: "", nextAttemptAt: "", pausedReason: "",
    failureCount: 0, lastError: "", inFlight: false,
    ...state.autoStock
  };
}

function countAddresses(inventory) {
  return inventory.filter(item => item.source === "icloud-hme" || /@icloud\.com$/i.test(item.email)).length;
}

function validPrefix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value)) {
    throw new ApiError(400, "BAD_REQUEST", "标签前缀须为 1–32 位字母、数字、下划线或连字符，首位为字母或数字");
  }
  return value;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";
}

function failureDelay(message, failures) {
  return /cookie|token|quota|limit|401|403|429|配额|频繁|上限|登录/i.test(message) || failures >= 3
    ? AUTO_STOCK_INTERVAL_MS : RETRY_MS;
}

function normalizeGenerated(rows) {
  if (!Array.isArray(rows) || rows.some(row =>
    !row || typeof row.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ||
    typeof row.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.label)
  )) throw new ApiError(502, "GENERATION_RESULT_UNCERTAIN", RECOVERY);
  return rows;
}

// One owner per service instance: pages only configure/read this persisted job.
// Automatic and manual generation share a queue, including inventory persistence.
export class AutoStockService {
  constructor({ store, generateBatch, generateOne, now = () => Date.now(),
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, logger = () => {} }) {
    Object.assign(this, { store, generateBatch, generateOne, now, setIntervalImpl, clearIntervalImpl, logger });
    this.queue = Promise.resolve();
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.volatilePause = "";
  }

  serialize(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async status() {
    const state = await this.store.read();
    const value = settings(state);
    return { ...value, pausedReason: this.volatilePause || value.pausedReason || (value.inFlight && !this.running ? RECOVERY : ""),
      running: this.running, total: countAddresses(state.inventory), targetTotal: AUTO_STOCK_TARGET,
      batchSize: AUTO_STOCK_BATCH_SIZE, intervalMs: AUTO_STOCK_INTERVAL_MS };
  }

  async configure(patch, { initializeOnly = false } = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ApiError(400, "BAD_REQUEST", "配置须为对象");
    if (Object.hasOwn(patch, "enabled") && typeof patch.enabled !== "boolean") throw new ApiError(400, "BAD_REQUEST", "enabled 须为布尔值");
    if (Object.hasOwn(patch, "prefix")) validPrefix(patch.prefix);
    await this.store.mutate(state => {
      const current = settings(state);
      if (initializeOnly && current.configured) return;
      const next = { ...current, configured: true };
      if (Object.hasOwn(patch, "enabled")) next.enabled = patch.enabled;
      if (Object.hasOwn(patch, "prefix")) next.prefix = patch.prefix;
      if (initializeOnly) {
        next.lastGeneratedAt = [validDate(current.lastGeneratedAt), validDate(patch.lastGeneratedAt)].sort().at(-1);
        next.nextAttemptAt = [validDate(current.nextAttemptAt), validDate(patch.nextAttemptAt)].sort().at(-1);
        if (next.lastGeneratedAt) {
          next.nextAttemptAt = new Date(Math.max(Date.parse(next.lastGeneratedAt) + AUTO_STOCK_INTERVAL_MS,
            Date.parse(next.nextAttemptAt) || 0)).toISOString();
        }
        next.pausedReason = typeof patch.pausedReason === "string" ? patch.pausedReason.slice(0, 500) : "";
      } else if (patch.enabled === true && !this.running) {
        if (current.inFlight) throw new ApiError(409, "GENERATION_RESULT_UNCERTAIN", RECOVERY);
        next.pausedReason = "";
      }
      state.autoStock = next;
    });
    // Do not reset cooldown when toggling or when another tab initializes.
    return this.status();
  }

  async reconciled() {
    await this.store.mutate(state => {
      if (!state.autoStock || this.running) return;
      state.autoStock.inFlight = false;
      state.autoStock.pausedReason = "";
    });
    this.volatilePause = "";
  }

  start() {
    if (this.timer !== null) return;
    this.stopped = false;
    this.timer = this.setIntervalImpl(() => this.tick(), 30_000);
    this.timer?.unref?.();
    void this.tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
    await this.waitForIdle();
  }

  async waitForIdle() {
    while (true) {
      const pending = this.queue;
      await pending;
      if (pending === this.queue) return;
    }
  }

  tick() {
    if (this.stopped || this.running || this.volatilePause) return Promise.resolve();
    return this.serialize(async () => {
      if (this.stopped) return;
      const state = await this.store.read();
      const job = settings(state);
      if (!job.configured || !job.enabled || job.pausedReason || job.inFlight || this.volatilePause) return;
      const total = countAddresses(state.inventory);
      if (total >= AUTO_STOCK_TARGET || Date.parse(job.nextAttemptAt) > this.now()) return;
      await this.perform(snapshot => {
        const prefix = validPrefix(settings(snapshot).prefix);
        const greatest = snapshot.inventory.reduce((max, row) => {
          const label = String(row.appleLabel || row.label || "");
          const suffix = label.startsWith(`${prefix}-`) ? label.slice(prefix.length + 1) : "";
          return /^\d+$/.test(suffix) && Number.isSafeInteger(Number(suffix)) ? Math.max(max, Number(suffix)) : max;
        }, 0);
        const labels = Array.from({ length: Math.min(AUTO_STOCK_BATCH_SIZE, AUTO_STOCK_TARGET - countAddresses(snapshot.inventory)) },
          (_, i) => `${prefix}-${String(greatest + i + 1).padStart(3, "0")}`);
        return this.generateBatch(labels);
      }, { automatic: true });
    }).catch(error => {
      // Never allow a periodic failure to become an unhandled rejection.
      this.logger(`auto-stock tick failed code=${error.code || "ERROR"}`);
    });
  }

  manualOne(label) {
    return this.serialize(async () => {
      const result = await this.perform(async () => ({ generated: [await this.generateOne(label)], errors: [] }));
      return result.generated[0];
    });
  }

  manualBatch(labels) {
    return this.serialize(async () => {
      const job = settings(await this.store.read());
      // Old tabs may still run their former automatic timer until reloaded.
      // Keep that legacy endpoint from bypassing the shared hourly schedule.
      if (job.configured) {
        throw new ApiError(409, "AUTO_STOCK_SERVER_OWNED", "自动生成已由后台接管，请刷新页面查看计划。");
      }
      return this.perform(() => this.generateBatch(labels));
    });
  }

  async perform(generate, { automatic = false } = {}) {
    if (this.stopped) throw new ApiError(503, "SHUTTING_DOWN", "服务正在停止");
    if (this.volatilePause) throw new ApiError(409, "GENERATION_RESULT_UNCERTAIN", RECOVERY);
    const snapshot = await this.store.mutate(state => {
      const job = settings(state);
      // Re-check inside the atomic claim: a page can disable the task, or an
      // inventory sync can hit the target, after the preliminary read above.
      if (automatic && (!job.configured || !job.enabled || job.pausedReason || job.inFlight ||
        countAddresses(state.inventory) >= AUTO_STOCK_TARGET || Date.parse(job.nextAttemptAt) > this.now())) return null;
      if (job.inFlight) throw new ApiError(409, "GENERATION_RESULT_UNCERTAIN", RECOVERY);
      state.autoStock = { ...job, inFlight: true, nextAttemptAt: new Date(this.now() + AUTO_STOCK_INTERVAL_MS).toISOString() };
      return state;
    });
    if (!snapshot) return;
    this.running = true;
    let response;
    let received = false;
    try {
      response = await generate(snapshot);
      received = true;
      const generated = normalizeGenerated(response?.generated);
      const errors = Array.isArray(response.errors) ? response.errors : [];
      // Server persistence, not a second request from a still-open page.
      if (generated.length) await this.store.createInventoryItems(generated);
      const uncertain = errors.some(error => error.code === "GENERATION_RESULT_UNCERTAIN");
      const message = String(errors[0]?.error || "本批没有生成成功").slice(0, 500);
      await this.store.mutate(state => {
        const job = settings(state);
        const failureCount = generated.length ? 0 : job.failureCount + 1;
        state.autoStock = { ...job, enabled: uncertain ? false : job.enabled, inFlight: uncertain, failureCount,
          lastGeneratedAt: generated.length ? new Date(this.now()).toISOString() : job.lastGeneratedAt,
          nextAttemptAt: new Date(this.now() + (generated.length ? AUTO_STOCK_INTERVAL_MS : failureDelay(message, failureCount))).toISOString(),
          lastError: errors.length ? message : "", pausedReason: uncertain ? RECOVERY : "" };
      });
      return response;
    } catch (error) {
      const uncertain = received || error.code === "GENERATION_RESULT_UNCERTAIN";
      try {
        await this.store.mutate(state => {
          const job = settings(state);
          const failureCount = job.failureCount + 1;
          state.autoStock = { ...job, enabled: uncertain ? false : job.enabled, inFlight: uncertain, failureCount,
            pausedReason: uncertain ? RECOVERY : "", lastError: uncertain ? RECOVERY : String(error.message).slice(0, 500),
            nextAttemptAt: new Date(this.now() + failureDelay(String(error.message), failureCount)).toISOString() };
        });
      } catch {
        // The durable pre-flight marker protects restart; this latch protects
        // the running process when even writing a pause fails (e.g. disk full).
        this.volatilePause = RECOVERY;
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}
