export const DASHBOARD_STORAGE_KEYS = Object.freeze({
  legacyInventory: "mail-code-dashboard-v1",
  apiKeySession: "mail-code-dashboard-api-key-v1",
  autoStock: "mail-code-dashboard-auto-stock-v2",
  icloudPrefix: "mail-code-dashboard-icloud-prefix-v1",
  pageSize: "mail-code-dashboard-page-size-v1",
  separator: "mail-code-dashboard-separator-v1",
  theme: "mail-code-dashboard-theme-v1"
});

export const DEFAULT_ICLOUD_PREFIX = "hme";
export const MESSAGE_CACHE_TTL_MS = 60 * 1000;

function freezeSnapshot(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(freezeSnapshot);
  return Object.freeze(value);
}

export function readLegacyInventory(storage) {
  try {
    const records = JSON.parse(
      storage.getItem(DASHBOARD_STORAGE_KEYS.legacyInventory) || "[]"
    );
    return Array.isArray(records) ? freezeSnapshot(records) : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}

export function sanitizeIcloudPrefix(value) {
  return (
    String(value || DEFAULT_ICLOUD_PREFIX)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "") || DEFAULT_ICLOUD_PREFIX
  );
}

export function loadPageSize(storage) {
  const value = Number(
    storage.getItem(DASHBOARD_STORAGE_KEYS.pageSize) || 25
  );
  return [25, 50, 100].includes(value) ? value : 25;
}

export function loadSeparator(storage) {
  return storage.getItem(DASHBOARD_STORAGE_KEYS.separator) || "----";
}

export function loadIcloudPrefix(storage) {
  return sanitizeIcloudPrefix(
    storage.getItem(DASHBOARD_STORAGE_KEYS.icloudPrefix) ||
      DEFAULT_ICLOUD_PREFIX
  );
}

export function loadAutoStockState(
  storage,
  { autoGenerateIntervalMs = 60 * 60 * 1000 } = {}
) {
  const fallback = {
    enabled: true,
    lastGeneratedAt: "",
    nextAttemptAt: "",
    pausedReason: "",
    failureCount: 0,
    lastError: ""
  };
  try {
    const value = {
      ...fallback,
      ...JSON.parse(storage.getItem(DASHBOARD_STORAGE_KEYS.autoStock) || "{}")
    };
    if (!value.nextAttemptAt && value.lastGeneratedAt) {
      const last = new Date(value.lastGeneratedAt).getTime();
      if (Number.isFinite(last)) {
        value.nextAttemptAt = new Date(
          last + autoGenerateIntervalMs
        ).toISOString();
      }
    }
    if (value.nextAttemptAt && value.lastGeneratedAt) {
      const last = new Date(value.lastGeneratedAt).getTime();
      const next = new Date(value.nextAttemptAt).getTime();
      const cappedNext = last + autoGenerateIntervalMs;
      if (
        Number.isFinite(last) &&
        Number.isFinite(next) &&
        next > cappedNext
      ) {
        value.nextAttemptAt = new Date(cappedNext).toISOString();
      }
    }
    return value;
  } catch {
    return fallback;
  }
}

export function saveAutoStockState(storage, autoStock) {
  storage.setItem(
    DASHBOARD_STORAGE_KEYS.autoStock,
    JSON.stringify(autoStock)
  );
}

export function createMessageCache({
  state,
  now = () => Date.now(),
  ttlMs = MESSAGE_CACHE_TTL_MS
}) {
  function cacheMessage(id, message) {
    if (!id || !message) return;
    const current = now();
    for (const [cachedId, entry] of state.messageCache) {
      if (current - entry.cachedAt >= ttlMs) {
        state.messageCache.delete(cachedId);
      }
    }
    state.messageCache.set(id, { message, cachedAt: current });
  }

  function cachedMessage(id) {
    const entry = state.messageCache.get(id);
    if (!entry) return null;
    if (now() - entry.cachedAt >= ttlMs) {
      state.messageCache.delete(id);
      return null;
    }
    return entry.message;
  }

  function invalidateMessageCache(id) {
    if (!id) {
      state.messageCache.clear();
      return;
    }
    state.messageCache.delete(id);
  }

  return {
    cacheMessage,
    cachedMessage,
    invalidateMessageCache
  };
}

export function createDashboardState({
  storage,
  now,
  autoGenerateIntervalMs = 60 * 60 * 1000
}) {
  const legacyMigrationSnapshot = readLegacyInventory(storage);
  const state = {
    accounts: [],
    notificationsReady: false,
    busyEmails: new Set(),
    generatingIcloud: false,
    mailBatchBusy: false,
    icloudStatus: null,
    autoStock: loadAutoStockState(storage, { autoGenerateIntervalMs }),
    protectedStarted: false,
    claims: [],
    messageCache: new Map(),
    activeGroup: "all",
    currentPage: 1,
    pageSize: loadPageSize(storage),
    editingRemarkId: "",
    editingRemarkDraft: null,
    editingRemarkCaret: null,
    labelNumbers: new Map()
  };
  return {
    state,
    legacyMigrationSnapshot,
    ...createMessageCache({ state, now })
  };
}
