const INVENTORY_PERSISTENCE_MESSAGE =
  "地址已在 Apple 生成但库存写入失败，请执行同步 iCloud 恢复。";
const UNCERTAIN_GENERATION_MESSAGE =
  "Apple 返回的生成结果不完整，请执行同步 iCloud 恢复。";

export function createDashboardApi({
  storage,
  fetchImpl,
  apiKeyStorageKey = "mail-code-dashboard-api-key-v1"
}) {
  function getApiKey() {
    return String(storage.getItem(apiKeyStorageKey) || "").trim();
  }

  function setApiKey(value) {
    const key = String(value || "").trim();
    if (key) storage.setItem(apiKeyStorageKey, key);
    return key;
  }

  function clearApiKey() {
    storage.removeItem(apiKeyStorageKey);
  }

  async function apiFetch(input, options = {}) {
    const key = getApiKey();
    if (!key) throw new Error("需要 API Key");
    const headers = new Headers(options.headers || {});
    headers.set("X-API-Key", key);
    return fetchImpl(input, { ...options, headers });
  }

  async function readApiEnvelope(response) {
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const error = new Error(
        body?.error?.message || `请求失败：${response.status}`
      );
      error.code = body?.error?.code || "REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    return body.data;
  }

  return {
    getApiKey,
    setApiKey,
    clearApiKey,
    apiFetch,
    readApiEnvelope
  };
}

export async function parseLegacyResponse(response) {
  const responseText = await response.text();
  try {
    return responseText ? JSON.parse(responseText) : {};
  } catch {
    return { error: responseText };
  }
}

export async function persistGeneratedAddresses(context, addresses) {
  let data;
  try {
    data = await context.readApiEnvelope(
      await context.apiFetch("/v1/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses })
      })
    );
  } catch (cause) {
    const error = new Error(INVENTORY_PERSISTENCE_MESSAGE);
    error.code = "INVENTORY_PERSIST_FAILED";
    error.cause = cause;
    throw error;
  }
  context.state.accounts = Array.isArray(data.inventory)
    ? data.inventory
    : [];
  context.state.claims = Array.isArray(data.claims) ? data.claims : [];
  context.state.labelNumbers.clear();
  context.invalidateMessageCache();
  context.render();
  return data;
}

function pauseAutoStockForRecovery(context, { title, message, error }) {
  Object.assign(context.state.autoStock, {
    pausedReason: message,
    lastError: error?.message || message,
    nextAttemptAt: ""
  });
  for (const [label, action] of [
    ["保存自动补货状态", context.saveAutoStockState],
    ["刷新自动补货状态", context.updateAutoStatus],
    ["显示恢复提示", () => context.notify(title, message, "error")]
  ]) {
    try {
      action();
    } catch (recoveryError) {
      (context.console || globalThis.console).warn(
        `${label}失败`,
        recoveryError
      );
    }
  }
}

function pauseAutoStockAfterInventoryFailure(context, error) {
  pauseAutoStockForRecovery(context, {
    title: "库存写入失败",
    message: error?.message || INVENTORY_PERSISTENCE_MESSAGE,
    error
  });
}

function pauseAutoStockAfterClientFailure(
  context,
  error,
  inventoryWritten = true
) {
  pauseAutoStockForRecovery(context, {
    title: "页面更新失败",
    message: inventoryWritten
      ? "地址已写入库存，但页面状态更新失败。自动补货已暂停，请刷新页面后再继续。"
      : "页面状态更新失败。自动补货已暂停，请刷新页面后再继续。",
    error
  });
}

function pauseAutoStockAfterUncertainGeneration(context, error) {
  pauseAutoStockForRecovery(context, {
    title: "生成结果需同步",
    message: error?.message || UNCERTAIN_GENERATION_MESSAGE,
    error
  });
}

export function normalizeGeneratedAddresses(generated) {
  const fail = () => {
    const error = new Error(UNCERTAIN_GENERATION_MESSAGE);
    error.code = "GENERATION_RESULT_UNCERTAIN";
    throw error;
  };
  if (!Array.isArray(generated)) fail();
  return Array.from(generated, item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail();
    if (typeof item.email !== "string" || typeof item.label !== "string") {
      fail();
    }
    const email = item.email.trim();
    const label = item.label.trim();
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      !label ||
      label.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)
    ) {
      fail();
    }
    return { email, label };
  });
}

export async function createIcloudAddress(
  context,
  label,
  options = {}
) {
  const {
    state,
    generateButton,
    apiFetch,
    withBusy,
    notify,
    saveAutoStockState,
    updateAutoStatus,
    autoGenerateIntervalMs = 60 * 60 * 1000,
    autoRetryIntervalMs = 5 * 60 * 1000
  } = context;
  if (state.generatingIcloud) return false;
  state.generatingIcloud = true;
  return withBusy(generateButton, async () => {
    try {
      let data;
      try {
        const response = await apiFetch("/api/icloud/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label })
        });
        data = await parseLegacyResponse(response);
        if (!response.ok) {
          throw new Error(
            data?.error ||
              data?.message ||
              `生成失败：${response.status}`
          );
        }
      } catch (error) {
        notify(
          "生成失败",
          error.message || "iCloud 隐藏邮箱生成失败。",
          "error"
        );
        if (!options.manual) {
          Object.assign(state.autoStock, {
            nextAttemptAt: new Date(
              Date.now() + autoRetryIntervalMs
            ).toISOString(),
            pausedReason: "",
            failureCount: Number(state.autoStock.failureCount || 0) + 1,
            lastError: error.message || "iCloud 隐藏邮箱生成失败。"
          });
          saveAutoStockState();
        }
        updateAutoStatus();
        return false;
      }

      try {
        const persist =
          context.persistGeneratedAddresses || persistGeneratedAddresses;
        await persist(context, [
          { email: data?.email, label: data?.label || label }
        ]);
      } catch (error) {
        if (error?.code === "INVENTORY_PERSIST_FAILED") {
          pauseAutoStockAfterInventoryFailure(context, error);
        } else {
          pauseAutoStockAfterClientFailure(context, error);
        }
        return false;
      }

      try {
        notify(
          "已生成隐藏邮箱",
          `${data?.label || label} 已加入未使用。`,
          "ok"
        );
        Object.assign(state.autoStock, {
          lastGeneratedAt: new Date().toISOString(),
          nextAttemptAt: new Date(
            Date.now() + autoGenerateIntervalMs
          ).toISOString(),
          pausedReason: "",
          failureCount: 0,
          lastError: ""
        });
        saveAutoStockState();
        updateAutoStatus();
        return true;
      } catch (error) {
        pauseAutoStockAfterClientFailure(context, error);
        return false;
      }
    } finally {
      state.generatingIcloud = false;
    }
  });
}

export async function createIcloudBatch(context, labels) {
  const {
    state,
    generateButton,
    apiFetch,
    withBusy,
    notify,
    saveAutoStockState,
    updateAutoStatus,
    isCookieOrLimitError = () => false,
    autoGenerateIntervalMs = 60 * 60 * 1000,
    autoRetryIntervalMs = 5 * 60 * 1000
  } = context;
  if (state.generatingIcloud) return false;
  state.generatingIcloud = true;
  return withBusy(generateButton, async () => {
    try {
      let data;
      try {
        const response = await apiFetch("/api/icloud/generate-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels })
        });
        data = await parseLegacyResponse(response);
        if (!response.ok) {
          throw new Error(
            data?.error ||
              data?.message ||
              `批量生成失败：${response.status}`
          );
        }
      } catch (error) {
        notify(
          "批量生成失败",
          error.message || "iCloud 隐藏邮箱批量生成失败。",
          "error"
        );
        state.autoStock.failureCount =
          Number(state.autoStock.failureCount || 0) + 1;
        state.autoStock.lastError =
          error.message || "iCloud 隐藏邮箱批量生成失败。";
        state.autoStock.nextAttemptAt = new Date(
          Date.now() +
            (isCookieOrLimitError(state.autoStock.lastError) ||
            state.autoStock.failureCount >= 3
              ? autoGenerateIntervalMs
              : autoRetryIntervalMs)
        ).toISOString();
        state.autoStock.pausedReason = "";
        saveAutoStockState();
        updateAutoStatus();
        return false;
      }

      let generated;
      try {
        generated = normalizeGeneratedAddresses(data?.generated);
      } catch (error) {
        pauseAutoStockAfterUncertainGeneration(context, error);
        return false;
      }
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      if (generated.length) {
        try {
          const persist =
            context.persistGeneratedAddresses || persistGeneratedAddresses;
          await persist(context, generated);
        } catch (error) {
          if (error?.code === "INVENTORY_PERSIST_FAILED") {
            pauseAutoStockAfterInventoryFailure(context, error);
          } else {
            pauseAutoStockAfterClientFailure(context, error);
          }
          return false;
        }
      }

      try {
        const now = Date.now();
        Object.assign(state.autoStock, {
          lastGeneratedAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(
            now +
              (generated.length
                ? autoGenerateIntervalMs
                : autoRetryIntervalMs)
          ).toISOString(),
          pausedReason: "",
          failureCount: generated.length
            ? 0
            : Number(state.autoStock.failureCount || 0) + 1,
          lastError: generated.length
            ? ""
            : errors[0]?.error || "本批没有生成成功。"
        });
        if (
          !generated.length &&
          (isCookieOrLimitError(state.autoStock.lastError) ||
            state.autoStock.failureCount >= 3)
        ) {
          state.autoStock.nextAttemptAt = new Date(
            now + autoGenerateIntervalMs
          ).toISOString();
        }
        saveAutoStockState();
        updateAutoStatus();

        if (generated.length) {
          notify(
            "已批量生成隐藏邮箱",
            `新增 ${generated.length} 个，下一批约 60 分钟后。`,
            "ok"
          );
          return true;
        }
        notify(
          "批量生成失败",
          state.autoStock.failureCount >= 3
            ? "已连续失败，改为约 60 分钟后再试。"
            : errors[0]?.error ||
                "本批没有生成成功，约 5 分钟后重试。",
          "error"
        );
        return false;
      } catch (error) {
        pauseAutoStockAfterClientFailure(
          context,
          error,
          generated.length > 0
        );
        return false;
      }
    } finally {
      state.generatingIcloud = false;
    }
  });
}
