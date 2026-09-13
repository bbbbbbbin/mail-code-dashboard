import {
  DASHBOARD_STORAGE_KEYS,
  DEFAULT_ICLOUD_PREFIX,
  createDashboardState,
  loadIcloudPrefix as readIcloudPrefix,
  loadSeparator as readSeparator,
  sanitizeIcloudPrefix,
  saveAutoStockState as persistAutoStockState
} from "./dashboard-state.js";
import {
  createDashboardApi,
  createIcloudAddress as createIcloudAddressController
} from "./dashboard-api.js";
import {
  checkInventoryMail as checkInventoryMailController,
  removeInventoryItem as removeInventoryItemFromState,
  replaceInventoryItem as replaceInventoryItemInState,
  runMailBatch as runMailBatchController
} from "./dashboard-mail.js";
import {
  closeDialog,
  collectElements,
  debounce,
  element as createElement,
  escapeRegExp,
  formatRelativeMinutes,
  formatRelativeTime,
  formatTime,
  openDialog,
  setBatchProgress as setBatchProgressUi,
  withBusy
} from "./dashboard-ui.js";

const AUTO_GENERATE_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_TARGET_TOTAL = 1500;
const SEARCH_DEBOUNCE_MS = 160;
const CLAIM_HISTORY_LIMIT = 50;

const dashboardState = createDashboardState({
  storage: localStorage,
  autoGenerateIntervalMs: AUTO_GENERATE_INTERVAL_MS
});
const {
  state,
  legacyMigrationSnapshot,
  cacheMessage,
  cachedMessage,
  invalidateMessageCache
} = dashboardState;
const els = collectElements(document);
const dashboardApi = createDashboardApi({
  storage: sessionStorage,
  fetchImpl: (...args) => fetch(...args),
  apiKeyStorageKey: DASHBOARD_STORAGE_KEYS.apiKeySession
});
const { apiFetch, readApiEnvelope } = dashboardApi;

/* ============================================================
   Small utilities
   ============================================================ */

function setBatchProgress(active) {
  setBatchProgressUi(els, active);
}

function copyText(text) {
  if (!text) {
    notify("没有可复制内容", "该邮箱还没有收到验证码。", "warn");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => notify("已复制", text, "ok"),
    () => notify("复制失败", "浏览器限制了剪贴板权限。", "error")
  );
}

/* ============================================================
   Theme
   ============================================================ */

function loadTheme() {
  const value = localStorage.getItem(DASHBOARD_STORAGE_KEYS.theme);
  return ["auto", "light", "dark"].includes(value) ? value : "auto";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(DASHBOARD_STORAGE_KEYS.theme, theme);
  if (els.themeIcon) {
    els.themeIcon.textContent =
      theme === "dark" ? "●" : theme === "light" ? "○" : "◐";
  }
  if (els.themeToggle) {
    els.themeToggle.title = `主题：${
      theme === "dark" ? "深色" : theme === "light" ? "浅色" : "跟随系统"
    }`;
  }
  els.themeSegmented?.querySelectorAll("[data-theme-value]").forEach(button => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.themeValue === theme)
    );
  });
}

function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const current = document.documentElement.dataset.theme || "auto";
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
}

/* ============================================================
   Storage helpers
   ============================================================ */

function saveIcloudPrefix() {
  localStorage.setItem(
    DASHBOARD_STORAGE_KEYS.icloudPrefix,
    currentIcloudPrefix()
  );
}

function currentIcloudPrefix() {
  const prefix = sanitizeIcloudPrefix(
    els.icloudPrefix?.value || DEFAULT_ICLOUD_PREFIX
  );
  if (els.icloudPrefix && els.icloudPrefix.value !== prefix) {
    els.icloudPrefix.value = prefix;
  }
  return prefix;
}

function saveAutoStockState() {
  persistAutoStockState(localStorage, state.autoStock);
}

function beginProtectedStartup() {
  if (dashboardApi.getApiKey()) {
    initializeProtectedData().catch(showApiKeyModal);
  } else {
    showApiKeyModal();
  }
}

function showApiKeyModal(error) {
  if (error) {
    dashboardApi.clearApiKey();
    els.apiKeyError.textContent = error.message || "API Key 验证失败";
  }
  openDialog(els.apiKeyDialog);
  els.apiKeyInput?.focus();
}

function hideApiKeyModal() {
  closeDialog(els.apiKeyDialog);
  els.apiKeyError.textContent = "";
  els.apiKeyInput.value = "";
}

async function submitApiKey() {
  const key = String(els.apiKeyInput.value || "").trim();
  if (!key) {
    els.apiKeyError.textContent = "请输入 API Key";
    return;
  }
  els.apiKeyError.textContent = "";
  dashboardApi.setApiKey(key);
  await withBusy(els.apiKeySubmit, async () => {
    try {
      await initializeProtectedData();
      hideApiKeyModal();
    } catch (error) {
      dashboardApi.clearApiKey();
      els.apiKeyError.textContent =
        error.code === "UNAUTHORIZED"
          ? "API Key 无效，请重新输入"
          : error.message || "无法连接本机服务";
    }
  });
}

function resetApiKey() {
  dashboardApi.clearApiKey();
  closeDialog(els.settingsDialog);
  showApiKeyModal();
}

async function initializeProtectedData() {
  await loadServerInventory();
  await loadAutoStock({ initialize: true });
  if (state.protectedStarted) return;
  state.protectedStarted = true;
  checkIcloudLoginStatus();
  window.setInterval(checkIcloudLoginStatus, 5 * 60 * 1000);
  window.setInterval(refreshBackgroundStatus, 30 * 1000);
}

async function loadServerInventory() {
  const data = await readApiEnvelope(await apiFetch("/v1/inventory"));
  // The whole local mirror is about to be replaced, and claims may have been
  // created or released server-side while the page was idle.
  invalidateMessageCache();
  state.claims = Array.isArray(data.claims) ? data.claims : [];
  state.accounts = Array.isArray(data.inventory) ? data.inventory : [];
  state.labelNumbers.clear();
  if (data.initialized) {
    els.migrationCard.hidden = true;
    els.migrationError.textContent = "";
  } else {
    showMigrationSummary(legacyMigrationSnapshot);
  }
  render();
  return data;
}

function showMigrationSummary(records) {
  if (!Array.isArray(records) || records.length === 0) {
    els.migrationCard.hidden = true;
    return;
  }
  const count = group => records.filter(item => item.group === group).length;
  els.migrationTotal.textContent = records.length;
  els.migrationUnused.textContent = count("unused");
  els.migrationFinished.textContent = count("finished");
  els.migrationTrash.textContent = count("trash");
  els.migrationCard.hidden = false;
}

async function confirmLegacyMigration() {
  if (!legacyMigrationSnapshot.length) {
    els.migrationError.textContent = "未找到可迁移的浏览器数据";
    return;
  }
  els.migrationError.textContent = "";
  await withBusy(els.confirmMigrationBtn, async () => {
    try {
      const response = await apiFetch("/v1/migrations/local-storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: legacyMigrationSnapshot })
      });
      await readApiEnvelope(response);
      await loadServerInventory();
    } catch (error) {
      if (error.code === "INVENTORY_ALREADY_INITIALIZED") {
        await loadServerInventory();
        els.migrationError.textContent = "服务端库存已初始化，未覆盖现有数据";
      } else {
        els.migrationError.textContent =
          error.message || "迁移失败，浏览器原数据未改动";
      }
    }
  });
}

/* ============================================================
   iCloud generation
   ============================================================ */

function updateAutoToggleButton() {
  if (!els.autoGenerateToggle) return;
  const enabled = Boolean(state.autoStock.enabled);
  els.autoGenerateToggle.textContent = `自动生成：${enabled ? "开" : "关"}`;
  els.autoGenerateToggle.setAttribute("aria-pressed", String(enabled));
}

async function toggleAutoGeneration() {
  await withBusy(els.autoGenerateToggle, async () => {
    try {
      await updateBackgroundSettings({ enabled: !state.autoStock.enabled, prefix: currentIcloudPrefix() });
    } catch (error) {
      notify("自动生成设置未保存", error.message, "error");
    }
  });
}

async function generateIcloudAddress() {
  if (state.generatingIcloud) return;
  const prefix = currentIcloudPrefix();
  saveIcloudPrefix();
  await createIcloudAddress(nextIcloudLabel(prefix), { manual: true });
}

function generationContext() {
  return {
    state,
    generateButton: els.generateIcloudBtn,
    apiFetch,
    readApiEnvelope,
    withBusy,
    notify,
    saveAutoStockState,
    updateAutoStatus,
    isCookieOrLimitError,
    autoGenerateIntervalMs: AUTO_GENERATE_INTERVAL_MS,
    autoRetryIntervalMs: AUTO_RETRY_INTERVAL_MS,
    invalidateMessageCache,
    render,
    console
  };
}

async function createIcloudAddress(label, options = {}) {
  const result = await createIcloudAddressController(
    generationContext(),
    label,
    options
  );
  await refreshBackgroundStatus();
  return result;
}

function applyAutoStock(data) {
  state.autoStock = data;
  if (els.icloudPrefix && document.activeElement !== els.icloudPrefix) {
    els.icloudPrefix.value = data.prefix;
  }
  saveAutoStockState();
  updateAutoToggleButton();
  updateAutoStatus();
}

async function loadAutoStock({ initialize = false } = {}) {
  let data = await readApiEnvelope(await apiFetch("/v1/auto-stock"));
  if (initialize && !data.configured) {
    data = await readApiEnvelope(await apiFetch("/v1/auto-stock/initialize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...state.autoStock, prefix: currentIcloudPrefix() })
    }));
  }
  applyAutoStock(data);
  return data;
}

async function updateBackgroundSettings(patch) {
  const data = await readApiEnvelope(await apiFetch("/v1/auto-stock", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  }));
  applyAutoStock(data);
}

let refreshingBackground = false;
async function refreshBackgroundStatus() {
  if (!dashboardApi.getApiKey() || refreshingBackground) return;
  refreshingBackground = true;
  try {
    await loadAutoStock();
    // Preserve an in-progress remark edit. The next poll refreshes inventory.
    if (!state.editingRemarkId && !state.mailBatchBusy && !state.generatingIcloud) await loadServerInventory();
  } catch (error) {
    console.warn("读取后台生成状态失败", error);
  } finally {
    refreshingBackground = false;
  }
}

/**
 * The header used to carry one long run-on sentence. It is now a short primary
 * line plus a dot that encodes overall health, with the detail on hover.
 */
function updateAutoStatus() {
  if (!els.pollStatusText) return;
  const totalGenerated = countIcloudAccounts();
  const icloudOk = state.icloudStatus ? state.icloudStatus.ok !== false : null;
  const parts = [];
  let tone = "ok";

  if (state.autoStock.pausedReason) {
    parts.push(`自动补货暂停：${state.autoStock.pausedReason}`);
    tone = "warn";
  } else if (!state.autoStock.enabled) {
    parts.push(`手动生成模式 · 已有 ${totalGenerated} 个`);
    tone = "idle";
  } else {
    const nextAttempt = state.autoStock.nextAttemptAt
      ? new Date(state.autoStock.nextAttemptAt).getTime()
      : 0;
    const remainingMs = nextAttempt ? Math.max(0, nextAttempt - Date.now()) : 0;
    parts.push(`自动生成 ${totalGenerated}/${AUTO_TARGET_TOTAL}`);
    parts.push(state.autoStock.running ? "后台正在生成" : "后台运行 · 关闭页面仍继续");
    if (remainingMs) parts.push(`下次约 ${Math.ceil(remainingMs / 60000)} 分钟后`);
    if (state.autoStock.failureCount) {
      parts.push(`连续失败 ${state.autoStock.failureCount} 次`);
      tone = "warn";
    }
  }

  if (icloudOk === false) {
    parts.push("iCloud 登录态待处理");
    tone = "error";
  } else if (icloudOk === true && state.icloudStatus?.lastSyncedAt) {
    parts.push(`iCloud 同步 ${formatRelativeMinutes(state.icloudStatus.lastSyncedAt)}`);
    // cookie 里两个 token 都在，但文件很久没被刷新过：三条自动刷新链路大概率已经断了。
    if (state.icloudStatus.stale) {
      parts.push("cookie 已过期，需手动刷新");
      if (tone === "ok" || tone === "idle") tone = "warn";
    }
  }

  const text = parts.join(" · ");
  els.pollStatusText.textContent = text;
  els.pollStatusText.title = text;
  if (els.pollStatusDot) els.pollStatusDot.dataset.state = tone;
}

let icloudStaleNotified = false;

async function checkIcloudLoginStatus() {
  try {
    const data = await (await apiFetch("/api/icloud/status")).json();
    state.icloudStatus = data;
    updateAutoStatus();
    const refreshHint = data.lastRefreshError ? `最近一次自动刷新失败：${data.lastRefreshError}` : "";
    if (!data.ok) {
      notify(
        "iCloud 登录态待处理",
        [data.error || "请在对应账号的浏览器登录 iCloud，并用扩展同步后再生成隐藏邮箱。", refreshHint]
          .filter(Boolean)
          .join(" "),
        "warn"
      );
    } else if (data.stale && !icloudStaleNotified) {
      // 每 5 分钟轮询一次，过期状态只提醒一次，恢复新鲜后再解锁。
      icloudStaleNotified = true;
      notify(
        "iCloud cookie 可能已过期",
        [data.staleReason || "iCloud cookie 很久没有刷新了。", refreshHint]
          .filter(Boolean)
          .join(" "),
        "warn"
      );
    }
    if (!data.stale) icloudStaleNotified = false;
  } catch (error) {
    state.icloudStatus = { ok: false, error: error.message || "检测 iCloud 登录态失败。" };
    updateAutoStatus();
  }
}

function countIcloudAccounts() {
  return state.accounts.filter(
    account =>
      account.source === "icloud-hme" ||
      isFixedPrefixLabel(account.label || account.remark)
  ).length;
}

function isFixedPrefixLabel(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}-[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(
    String(value || "")
  );
}

function isCookieOrLimitError(message) {
  return /session|cookie|unauthorized|invalid|limit|too many|rate|global session|登录|过期|限制/i.test(
    message
  );
}

function highestLabelNumber(prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
  let max = 0;
  for (const account of state.accounts) {
    const match = String(account.label || account.remark || "").match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function nextIcloudLabel(prefix) {
  return `${prefix}-${String(highestLabelNumber(prefix) + 1).padStart(3, "0")}`;
}

async function syncIcloudAccountsFromApple(options = {}) {
  const manual = options.manual === true;
  await withBusy(manual ? els.syncIcloudBtn : null, async () => {
    try {
      const data = await readApiEnvelope(
        await apiFetch("/v1/inventory/sync-icloud", { method: "POST" })
      );
      const previousCount = state.accounts.length;
      state.accounts = Array.isArray(data.inventory) ? data.inventory : [];
      state.claims = Array.isArray(data.claims) ? data.claims : state.claims;
      invalidateMessageCache();
      render();
      const added = Math.max(0, state.accounts.length - previousCount);
      await loadAutoStock();
      if (added) {
        notify("已同步隐藏邮箱", `新增 ${added} 个隐藏邮箱。`, "ok");
      } else if (manual) {
        notify("同步完成", "iCloud 当前没有新的隐藏邮箱。", "ok");
      }
    } catch (error) {
      console.warn("sync icloud accounts failed", error);
      if (manual) {
        notify("同步失败", error.message || "读取 iCloud 隐藏邮箱列表失败。", "error");
      }
    }
  });
}

/* ============================================================
   Export
   ============================================================ */

function exportAccounts(group = "") {
  const rowsToExport = group
    ? state.accounts.filter(account => account.group === group)
    : state.accounts;
  if (!rowsToExport.length) {
    notify("暂无可导出邮箱", "列表为空。", "warn");
    return;
  }
  const sep = els.separator?.value || readSeparator(localStorage);
  const rows = rowsToExport.map(account =>
    [
      account.email,
      account.password || "",
      account.clientId || "",
      account.refreshToken || "",
      account.group,
      account.remark || ""
    ].join(sep)
  );
  const blob = new Blob([rows.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const name = group === "finished" ? "已使用" : group === "unused" ? "未使用" : "全部";
  link.download = `mail-accounts-${name}-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);
  notify("已导出", `${rowsToExport.length} 个邮箱`, "ok");
}

async function markAllRead() {
  const unreadAccounts = state.accounts.filter(account => account.unread);
  if (!unreadAccounts.length) {
    notify("无需处理", "当前没有未读邮件。", "ok");
    return;
  }

  setBatchProgress(true);
  try {
    const results = await Promise.allSettled(
      unreadAccounts.map(async account => {
        const data = await readApiEnvelope(
          await apiFetch(`/v1/inventory/${encodeURIComponent(account.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ unread: false })
          })
        );
        replaceInventoryItem(data.inventoryItem);
      })
    );
    const updated = results.filter(result => result.status === "fulfilled").length;
    render();
    notify(
      updated === unreadAccounts.length ? "已全部标记为已读" : "部分标记完成",
      `成功 ${updated} 个，失败 ${unreadAccounts.length - updated} 个。`,
      updated === unreadAccounts.length ? "ok" : "warn"
    );
  } finally {
    setBatchProgress(false);
  }
}

function clearEmailSearch() {
  els.search.value = "";
  state.currentPage = 1;
  render();
  els.search.focus();
}

/* ============================================================
   Rendering
   ============================================================ */

function labelNumber(account) {
  const key = `${account.id}|${account.label}|${account.remark}`;
  const cached = state.labelNumbers.get(key);
  if (cached !== undefined) return cached;
  const text = [account.label, account.remark, account.statusMessage]
    .map(value => String(value || ""))
    .join(" ");
  const match = text.match(/[A-Za-z0-9][A-Za-z0-9_-]{0,31}-(\d+)/);
  const value = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  state.labelNumbers.set(key, value);
  return value;
}

function sortAccountsByLabel(accounts) {
  return [...accounts].sort((a, b) => {
    const difference = labelNumber(a) - labelNumber(b);
    if (difference !== 0) return difference;
    return String(a.email || "").localeCompare(String(b.email || ""), "en");
  });
}

function render() {
  const keyword = els.search.value.trim().toLowerCase();
  if (els.clearSearchBtn) els.clearSearchBtn.hidden = !keyword;

  // Counts and the keyword filter share a single pass over the inventory.
  const counts = { all: 0, unused: 0, finished: 0, trash: 0, unread: 0 };
  const filtered = [];
  for (const account of state.accounts) {
    counts.all += 1;
    if (Object.hasOwn(counts, account.group)) counts[account.group] += 1;
    if (account.unread) counts.unread += 1;
    if (
      !keyword ||
      [account.email, account.label, account.remark].some(value =>
        String(value || "").toLowerCase().includes(keyword)
      )
    ) {
      filtered.push(account);
    }
  }

  els.searchResult.textContent = keyword
    ? `命中 ${filtered.length} / ${counts.all}`
    : `共 ${counts.all} 个邮箱`;

  const selected =
    state.activeGroup === "all"
      ? filtered
      : filtered.filter(account => account.group === state.activeGroup);
  const sorted = sortAccountsByLabel(selected);
  const totalPages = Math.max(1, Math.ceil(sorted.length / state.pageSize));
  state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
  const pageStart = (state.currentPage - 1) * state.pageSize;

  renderList(sorted.slice(pageStart, pageStart + state.pageSize), keyword);

  els.groupTabs?.querySelectorAll("button[data-group]").forEach(button => {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.group === state.activeGroup)
    );
  });
  els.groupTabs?.querySelectorAll("[data-count]").forEach(node => {
    node.textContent = counts[node.dataset.count] ?? 0;
  });

  els.pageSummary.textContent = `第 ${state.currentPage} / ${totalPages} 页 · 共 ${sorted.length} 个`;
  els.previousPageBtn.disabled = state.currentPage <= 1;
  els.nextPageBtn.disabled = state.currentPage >= totalPages;

  els.totalCount.textContent = counts.all;
  els.finishedCount.textContent = counts.finished;
  els.unusedCount.textContent = counts.unused;
  els.trashCount.textContent = counts.trash;
  els.newCodeCount.textContent = counts.unread;

  els.claimHistoryCount.textContent = state.claims.length;
  if (els.claimHistoryPanel?.open) renderClaimHistory();

  document.title = counts.unread
    ? `(${counts.unread}) 信屿 MailIsle`
    : "信屿 MailIsle";
}

function highlightInto(node, value, keyword) {
  const text = String(value || "");
  const index = keyword ? text.toLowerCase().indexOf(keyword) : -1;
  if (index < 0) {
    node.textContent = text;
    return;
  }
  node.replaceChildren(
    document.createTextNode(text.slice(0, index)),
    Object.assign(document.createElement("mark"), {
      textContent: text.slice(index, index + keyword.length)
    }),
    document.createTextNode(text.slice(index + keyword.length))
  );
}

function element(tag, className, textContent) {
  return createElement(document, tag, className, textContent);
}

const GROUP_LABELS = { unused: "未使用", finished: "已使用", trash: "垃圾箱" };
const GROUP_TONES = { unused: "info", finished: "ok", trash: "neutral" };

/**
 * Remark editing survives a re-render.
 *
 * Any batch (mail scan, iCloud sync, search debounce, tab switch, paging)
 * calls `render()`, which replaces every row node. Removing the focused
 * input does not reliably fire `blur`, so the commit handler never runs and
 * the rebuilt input would be re-seeded from the stored remark — the typed
 * text disappears with no error. Lifting the live value into state before
 * the DOM goes away keeps the edit intact without letting the row fall out
 * of sync with the server.
 */
function captureRemarkDraft() {
  if (!state.editingRemarkId || !els.mailList) return;
  const input = els.mailList.querySelector('input[data-action="remark"]');
  if (!input || input.closest(".row")?.dataset.id !== state.editingRemarkId) {
    return;
  }
  rememberRemarkDraft(input);
}

function rememberRemarkDraft(input) {
  state.editingRemarkDraft = input.value;
  state.editingRemarkCaret = input.selectionStart ?? input.value.length;
}

function beginRemarkEditing(account) {
  state.editingRemarkId = account.id;
  state.editingRemarkDraft = account.remark || "";
  state.editingRemarkCaret = state.editingRemarkDraft.length;
}

function endRemarkEditing() {
  state.editingRemarkId = "";
  state.editingRemarkDraft = null;
  state.editingRemarkCaret = null;
}

/**
 * Builds one dense row. Rows are created with DOM nodes rather than an
 * innerHTML template: no per-row HTML parsing, no escaping question, and no
 * per-row event listeners — the list uses delegation instead.
 */
function buildRow(account, keyword) {
  const row = element("article", "row");
  row.dataset.id = account.id;
  row.dataset.marked = String(Boolean(account.unread));

  // Address
  const addressCell = element("div", "cell cell-address");
  const address = element("div", "row-address");
  const addressText = element("span", "address-text");
  addressText.title = account.email;
  highlightInto(addressText, account.email, keyword);
  address.append(addressText);

  const label = account.label || account.remark;
  if (label) address.append(element("span", "chip", label));

  const copyButton = element("button", "row-copy", "⧉");
  copyButton.type = "button";
  copyButton.dataset.action = "copy-email";
  copyButton.title = "复制邮箱";
  copyButton.setAttribute("aria-label", `复制 ${account.email}`);
  address.append(copyButton);
  addressCell.append(address);

  // Remark — keep operator notes separate from the latest mail details.
  const remarkCell = element("div", "cell cell-remark");
  if (state.editingRemarkId === account.id) {
    const input = element("input", "row-remark-input");
    input.dataset.action = "remark";
    // The uncommitted draft wins over the stored remark, otherwise a
    // re-render mid-edit would silently revert what the operator typed.
    input.value = state.editingRemarkDraft ?? account.remark ?? "";
    input.placeholder = "备注…";
    input.setAttribute("aria-label", `${account.email} 的备注`);
    remarkCell.append(input);
  } else {
    const remarkText = element(
      "span",
      "remark-text",
      account.remark || "—"
    );
    if (!account.remark) remarkText.dataset.empty = "true";
    remarkText.title = account.remark || "暂无备注";
    remarkCell.append(remarkText);
  }

  // Latest mail details
  const subjectCell = element("div", "cell cell-subject");
  const subject = element("div", "row-subject");
  const subjectText = element(
    "span",
    "subject-text",
    account.subject || "尚未收到邮件"
  );
  subject.append(subjectText);
  if (account.receivedAt) {
    subject.append(
      element("span", "subject-time", formatRelativeTime(account.receivedAt))
    );
  }
  subjectCell.append(subject);
  if (account.statusMessage && account.statusType !== "ok") {
    const note = element("span", "status-note", account.statusMessage);
    note.dataset.state = account.statusType || "idle";
    note.title = account.statusMessage;
    subjectCell.append(note);
  }

  // Code
  const codeCell = element("div", "cell cell-code");
  const code = element("div", "row-code");
  const codeValue = element("span", "code-value", account.code || "—");
  if (!account.code) codeValue.dataset.empty = "true";
  code.append(codeValue);
  if (account.code) {
    const copyCode = element("button", "row-copy", "⧉");
    copyCode.type = "button";
    copyCode.dataset.action = "copy-code";
    copyCode.title = "复制验证码";
    copyCode.setAttribute("aria-label", `复制验证码 ${account.code}`);
    code.append(copyCode);
  }
  codeCell.append(code);

  // Group tag
  const groupCell = element("div", "cell cell-group");
  const tag = element("span", "tag", GROUP_LABELS[account.group] || account.group);
  tag.dataset.tone = GROUP_TONES[account.group] || "neutral";
  groupCell.append(tag);

  // Actions: one primary inline, the rest behind a menu.
  const actions = element("div", "cell-actions");
  const receive = element("button", "btn btn-outline btn-sm btn-reveal", "收件");
  receive.type = "button";
  receive.dataset.action = "receive";
  const read = element("button", "btn btn-ghost btn-sm btn-reveal", "查看");
  read.type = "button";
  read.dataset.action = "read";
  const more = element("button", "btn btn-ghost btn-sm", "⋯");
  more.type = "button";
  more.dataset.action = "menu";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", `${account.email} 的更多操作`);
  actions.append(receive, read, more);

  row.append(addressCell, remarkCell, subjectCell, codeCell, groupCell, actions);
  return row;
}

function renderList(accounts, keyword) {
  // Must run before any node is replaced: afterwards the input is gone and
  // its value is unrecoverable.
  captureRemarkDraft();
  if (!accounts.length) {
    const empty = element("div", "empty");
    empty.append(
      element(
        "span",
        "",
        keyword
          ? "没有匹配的邮箱"
          : state.activeGroup === "finished"
            ? "已使用分组暂无邮箱"
            : state.activeGroup === "trash"
              ? "垃圾箱为空"
              : state.activeGroup === "unused"
                ? "未使用分组暂无邮箱"
                : "暂无邮箱，先点“生成隐藏邮箱”"
      )
    );
    els.mailList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const account of accounts) fragment.append(buildRow(account, keyword));
  els.mailList.replaceChildren(fragment);

  if (state.editingRemarkId) {
    const input = els.mailList.querySelector(
      `.row[data-id="${CSS.escape(state.editingRemarkId)}"] input`
    );
    if (input) {
      input.focus();
      // Without this the caret jumps to the end on every background
      // refresh, which mangles edits made in the middle of a remark.
      const caret = Math.min(
        state.editingRemarkCaret ?? input.value.length,
        input.value.length
      );
      input.setSelectionRange(caret, caret);
    }
  }
}

function renderClaimHistory() {
  if (!els.claimHistoryList) return;
  if (!state.claims.length) {
    els.claimHistoryList.replaceChildren(element("div", "empty", "暂无领取记录"));
    return;
  }

  const claims = [...state.claims]
    .sort((left, right) => new Date(right.claimedAt || 0) - new Date(left.claimedAt || 0))
    .slice(0, CLAIM_HISTORY_LIMIT);

  const fragment = document.createDocumentFragment();
  for (const claim of claims) {
    const row = element("article", "claim-row");

    const identity = element("div", "claim-detail");
    identity.append(
      element("strong", "", claim.claimId || ""),
      element("span", "", claim.email || "")
    );

    const timing = element("div", "claim-detail");
    timing.append(
      element("span", "", `领取：${claim.claimedAt ? formatRelativeTime(claim.claimedAt) : "暂无"}`),
      element(
        "span",
        "",
        claim.status === "released"
          ? `释放：${claim.releasedAt ? formatRelativeTime(claim.releasedAt) : "暂无"}`
          : "等待邮件"
      )
    );

    const status = element("span", "tag", claim.status === "released" ? "已释放" : "领取中");
    status.dataset.tone = claim.status === "released" ? "neutral" : "ok";

    const released = claim.status === "released";
    const address = claim.email || claim.claimId || "该领取";

    const actions = element("div", "claim-actions");
    const mailButton = element(
      "button",
      "btn btn-outline btn-sm",
      released ? "已停止" : "查看邮件"
    );
    mailButton.type = "button";
    mailButton.dataset.action = "claim-mail";
    mailButton.dataset.claimId = claim.claimId || "";
    mailButton.disabled = released;
    mailButton.setAttribute("aria-label", `查看 ${address} 的邮件`);
    actions.append(mailButton);

    // An address stays invisible to `claimNext` and refuses group changes
    // until its claim is released, so the release has to be reachable from
    // here — it used to require hand-editing the state file. Destructive,
    // hence `.btn-danger` rather than a second primary button.
    if (!released) {
      const releaseButton = element("button", "btn btn-danger btn-sm", "释放");
      releaseButton.type = "button";
      releaseButton.dataset.action = "claim-release";
      releaseButton.dataset.claimId = claim.claimId || "";
      releaseButton.title = "释放领取，地址回到未使用";
      releaseButton.setAttribute("aria-label", `释放 ${address} 的领取`);
      actions.append(releaseButton);
    }

    row.append(identity, timing, status, actions);
    fragment.append(row);
  }

  if (state.claims.length > CLAIM_HISTORY_LIMIT) {
    fragment.append(
      element("div", "empty", `仅显示最近 ${CLAIM_HISTORY_LIMIT} 条，共 ${state.claims.length} 条`)
    );
  }
  els.claimHistoryList.replaceChildren(fragment);
}

/* ============================================================
   Row action menu
   ============================================================ */

function closeRowMenu() {
  if (!els.rowMenu) return;
  els.rowMenu.hidden = true;
  els.rowMenu.dataset.open = "false";
  els.mailList
    ?.querySelectorAll('[data-action="menu"][aria-expanded="true"]')
    .forEach(button => button.setAttribute("aria-expanded", "false"));
}

function openRowMenu(button, account) {
  const isTrash = account.group === "trash";
  const items = [
    { action: "remark", label: "编辑备注" },
    isTrash
      ? { action: "restore", label: "恢复到已使用" }
      : {
          action: "move",
          label: account.group === "finished" ? "移到未使用" : "移到已使用"
        },
    { action: "mark", label: "标记已读" },
    { action: "copy-email", label: "复制邮箱" },
    { separator: true },
    isTrash
      ? { action: "purge", label: "最终删除", variant: "danger" }
      : { action: "delete", label: "删除到垃圾箱", variant: "danger" }
  ];

  els.rowMenu.replaceChildren();
  for (const item of items) {
    if (item.separator) {
      els.rowMenu.append(element("div", "menu-sep"));
      continue;
    }
    const entry = element("button", "", item.label);
    entry.type = "button";
    entry.setAttribute("role", "menuitem");
    entry.dataset.action = item.action;
    entry.dataset.id = account.id;
    if (item.variant) entry.dataset.variant = item.variant;
    els.rowMenu.append(entry);
  }

  // Show first, then measure: the menu is as wide as its longest label, so a
  // fixed offset would push it off the right edge on the last column.
  els.rowMenu.hidden = false;
  els.rowMenu.dataset.open = "true";
  els.rowMenu.style.top = "0px";
  els.rowMenu.style.left = "0px";

  const rect = button.getBoundingClientRect();
  const menu = els.rowMenu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    Math.max(margin, rect.right - menu.width),
    window.innerWidth - menu.width - margin
  );
  // Flip above the trigger when the menu would run past the bottom.
  const fitsBelow = rect.bottom + 4 + menu.height <= window.innerHeight - margin;
  const top = fitsBelow
    ? rect.bottom + 4
    : Math.max(margin, rect.top - 4 - menu.height);

  els.rowMenu.style.left = `${left}px`;
  els.rowMenu.style.top = `${top}px`;
  button.setAttribute("aria-expanded", "true");
  els.rowMenu.querySelector("button")?.focus();
}

/* ============================================================
   Message cache
   ============================================================ */

/**
 * The last message the server reported for an inventory row, so that
 * opening 查看 right after 收件 does not pay for a second IMAP round trip.
 *
 * A cached copy is only trustworthy while both dimensions hold:
 *
 * - Time. New mail lands on the server, and the page has no way to hear
 *   about it, so a copy that is merely "old" is indistinguishable from a
 *   stale one. Without the TTL a panel left open all day keeps showing the
 *   first code it ever fetched as if it were the newest, which is the worst
 *   possible failure for this tool. One minute is deliberately short: the
 *   cache only has to survive the few seconds between 收件 and 查看, and a
 *   miss just replays the fetch that 查看 would have done anyway.
 * - Events. Refreshing the forward mailbox, scanning unused addresses,
 *   reloading the inventory or releasing a claim are the moments the
 *   operator is explicitly asking for current data, so every copy taken
 *   before them is discarded rather than left to expire on its own.
 */
async function patchInventoryItem(account, patch) {
  const data = await readApiEnvelope(
    await apiFetch(`/v1/inventory/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    })
  );
  replaceInventoryItem(data.inventoryItem);
  render();
  return data.inventoryItem;
}

function replaceInventoryItem(updated) {
  replaceInventoryItemInState(state, updated);
}

function removeInventoryItem(id) {
  removeInventoryItemFromState(state, id);
}

function mailContext() {
  return {
    state,
    apiFetch,
    readApiEnvelope,
    withBusy,
    invalidateMessageCache,
    cacheMessage,
    renderClaimMessage,
    openDialog,
    mailDialog: els.mailDialog,
    render,
    notify,
    setBatchProgress
  };
}

async function checkInventoryMail(account, button, showMessage = false) {
  return checkInventoryMailController(
    mailContext(),
    account,
    button,
    showMessage
  );
}

async function runMailBatch(options) {
  return runMailBatchController(mailContext(), options);
}

async function purgeAccount(account) {
  if (
    !confirm(
      `确定最终删除 ${account.email}？\n\n该地址会从本地库存永久移除（服务端会先留一份备份）。\nApple 侧的隐藏邮箱不会被停用，需要时请到 iCloud 设置里手动处理。`
    )
  ) {
    return;
  }
  invalidateMessageCache(account.id);
  try {
    const data = await readApiEnvelope(
      await apiFetch(`/v1/inventory/${encodeURIComponent(account.id)}`, {
        method: "DELETE"
      })
    );
    state.accounts = Array.isArray(data.inventory) ? data.inventory : state.accounts;
    state.claims = Array.isArray(data.claims) ? data.claims : state.claims;
    closeRowMenu();
    render();
    notify("已最终删除", `${account.email} 已从库存永久移除。`, "ok");
  } catch (error) {
    if (error?.code === "INVENTORY_NOT_IN_TRASH") {
      notify(
        "未执行最终删除",
        `${account.email} 不在垃圾箱里。先把它移到垃圾箱，再执行最终删除。`,
        "warn"
      );
      return;
    }
    reportRowActionError(error, account);
  }
}

/* ============================================================
   Message viewer
   ============================================================ */

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function renderClaimMessage(message) {
  els.mailPreview.replaceChildren();

  const metadata = element("section", "message-section");
  const list = element("dl", "message-meta");
  for (const [term, value] of [
    ["发件人", message.from || "未知"],
    ["主题", message.subject || "无主题"],
    ["时间", message.receivedAt ? formatTime(message.receivedAt) : "未知"]
  ]) {
    list.append(element("dt", "", term), element("dd", "", value));
  }
  metadata.append(list);
  els.mailPreview.append(metadata);

  const codes = Array.isArray(message.codes) ? message.codes : [];
  if (codes.length) {
    const section = element("section", "message-section");
    section.append(element("strong", "", "验证码"));
    const codeList = element("div", "message-codes");
    for (const code of codes) {
      const button = element("button", "btn message-code", String(code));
      button.type = "button";
      button.dataset.copy = String(code);
      codeList.append(button);
    }
    section.append(codeList);
    els.mailPreview.append(section);
  }

  const textSection = element("section", "message-section");
  textSection.append(
    element("strong", "", "正文"),
    element("div", "message-body", message.text || "邮件没有纯文本正文")
  );
  els.mailPreview.append(textSection);

  const links = [
    ...new Set(
      (Array.isArray(message.links) ? message.links : [])
        .map(safeExternalUrl)
        .filter(Boolean)
    )
  ];
  if (links.length) {
    const section = element("section", "message-section");
    section.append(element("strong", "", "全部链接"));
    const linkList = element("div", "message-links");
    const primary = safeExternalUrl(message.primaryLink);
    for (const url of links) {
      const anchor = element(
        "a",
        `message-link${url === primary ? " primary-link" : ""}`,
        url === primary ? `${url}（推荐链接）` : url
      );
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      linkList.append(anchor);
    }
    section.append(linkList);
    els.mailPreview.append(section);
  }

  if (message.html) {
    const section = element("section", "message-section");
    section.append(element("strong", "", "安全 HTML 预览"));
    const frame = element("iframe", "mail-html-frame");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "邮件 HTML 预览");
    frame.srcdoc = String(message.html);
    section.append(frame);
    els.mailPreview.append(section);
  }
}

async function openClaimMail(claim, button) {
  els.mailPreview.replaceChildren(element("div", "empty", "正在轮询最新邮件…"));
  openDialog(els.mailDialog);
  await withBusy(button, async () => {
    try {
      const data = await readApiEnvelope(
        await apiFetch(
          `/v1/claims/${encodeURIComponent(claim.claimId)}/messages/latest?waitSeconds=3`
        )
      );
      if (!data.message) {
        els.mailPreview.replaceChildren(element("div", "empty", "尚未收到邮件"));
        return;
      }
      renderClaimMessage(data.message);
    } catch (error) {
      els.mailPreview.replaceChildren(
        element(
          "div",
          "empty",
          error.code === "CLAIM_RELEASED"
            ? "该领取记录已释放，不能继续收件"
            : error.message || "读取邮件失败"
        )
      );
    }
  });
}

/**
 * Releases a claim through `POST /v1/claims/{id}/release`.
 *
 * The server clears `activeClaimId` and puts the address back into
 * `unused`, which is the only way to unblock a group change (the store
 * answers 409 `CLAIM_ACTIVE` otherwise). The call is idempotent, so a
 * double click costs nothing. The inventory is reloaded afterwards rather
 * than patched locally: the release moves a row between groups and touches
 * the counters, and guessing at that is how the two copies drift apart.
 */
async function releaseClaim(claim, button) {
  const address = claim.email || claim.claimId || "该领取";
  if (
    !confirm(
      `确定释放 ${address} 的领取？\n\n该地址会回到「未使用」，正在等待这封邮件的调用方会收到已释放。`
    )
  ) {
    return;
  }
  await withBusy(button, async () => {
    try {
      const released = await readApiEnvelope(
        await apiFetch(
          `/v1/claims/${encodeURIComponent(claim.claimId)}/release`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "收件台手动释放" })
          }
        )
      );
      mergeReleasedClaim(claim.claimId, released);
      // The address goes back into the pool and the next consumer will get
      // its own mail, so nothing fetched under the released claim may be
      // shown as "the latest" afterwards — including when the reload below
      // fails and leaves the mirror untouched.
      invalidateMessageCache();
      renderClaimHistory();
      try {
        await loadServerInventory();
      } catch (error) {
        console.warn("inventory reload after release failed", error);
      }
      notify("已释放领取", `${address} 已回到未使用分组。`, "ok");
    } catch (error) {
      notify("释放失败", error.message || "无法释放该领取。", "error");
    }
  });
}

function mergeReleasedClaim(claimId, released) {
  const index = state.claims.findIndex(item => item.claimId === claimId);
  if (index < 0) return;
  state.claims[index] = {
    ...state.claims[index],
    ...(released && typeof released === "object" ? released : {}),
    status: "released"
  };
}

/**
 * The claim that is holding an address, preferred by id because the
 * inventory record carries `activeClaimId` verbatim.
 */
function activeClaimFor(account) {
  const byId = account?.activeClaimId
    ? state.claims.find(item => item.claimId === account.activeClaimId)
    : null;
  if (byId) return byId;
  const email = String(account?.email || "").toLowerCase();
  const byEmail = state.claims.find(
    item =>
      item.status !== "released" &&
      String(item.email || "").toLowerCase() === email
  );
  if (byEmail) return byEmail;
  return account?.activeClaimId ? { claimId: account.activeClaimId } : null;
}

/**
 * `CLAIM_ACTIVE` is a 409 from `PATCH /v1/inventory/{id}`: the address is
 * still held by a claim. The bare code means nothing to an operator, so it
 * is turned into the one step that unblocks them, and the claim history is
 * expanded so the 释放 button is already on screen.
 */
function reportRowActionError(error, account) {
  if (error?.code !== "CLAIM_ACTIVE") {
    notify("操作未完成", error?.message || "该操作没有完成。", "error");
    return;
  }
  const claim = activeClaimFor(account);
  if (els.claimHistoryPanel && !els.claimHistoryPanel.open) {
    els.claimHistoryPanel.open = true;
  }
  notify(
    "该地址正被领取占用",
    `${account.email} 正被领取 ${
      claim?.claimId || "（进行中）"
    } 占用，先在下方“领取记录”里点「释放」，再改分组。`,
    "warn"
  );
}

/* ============================================================
   Notifications
   ============================================================ */

function notify(title, message, tone = "info") {
  const item = element("div", "notice");
  item.dataset.tone = tone;
  item.append(element("strong", "", title), element("span", "", message));
  els.toast.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    notify("当前浏览器不支持系统提醒", "仍会显示页面内提醒。", "warn");
    return;
  }
  const permission = await Notification.requestPermission();
  state.notificationsReady = permission === "granted";
  notify(
    state.notificationsReady ? "浏览器提醒已开启" : "浏览器提醒未开启",
    "验证码到达时会同步更新页面状态。",
    state.notificationsReady ? "ok" : "warn"
  );
}

/* ============================================================
   Event wiring — the list uses delegation, so adding a row costs
   no listeners at all.
   ============================================================ */

els.generateIcloudBtn?.addEventListener("click", generateIcloudAddress);
els.syncIcloudBtn?.addEventListener("click", () =>
  syncIcloudAccountsFromApple({ manual: true })
);
els.refreshForwardBtn?.addEventListener("click", () =>
  runMailBatch({
    endpoint: "/v1/inventory/check-finished-mail",
    button: els.refreshForwardBtn,
    label: "读取已使用邮箱"
  })
);
els.scanUnusedMailBtn?.addEventListener("click", () =>
  runMailBatch({
    endpoint: "/v1/inventory/check-unused-mail",
    button: els.scanUnusedMailBtn,
    label: "扫描未使用邮箱"
  })
);
els.exportBtn?.addEventListener("click", () => exportAccounts());
els.exportFinishedBtn?.addEventListener("click", () => exportAccounts("finished"));
els.exportUnusedBtn?.addEventListener("click", () => exportAccounts("unused"));
els.markAllReadBtn?.addEventListener("click", markAllRead);
els.notifyBtn?.addEventListener("click", enableNotifications);
els.autoGenerateToggle?.addEventListener("click", toggleAutoGeneration);
els.confirmMigrationBtn?.addEventListener("click", confirmLegacyMigration);
els.resetApiKeyBtn?.addEventListener("click", resetApiKey);

const debouncedRender = debounce(() => {
  state.currentPage = 1;
  render();
}, SEARCH_DEBOUNCE_MS);
els.search?.addEventListener("input", debouncedRender);
els.clearSearchBtn?.addEventListener("click", clearEmailSearch);

els.groupTabs?.addEventListener("click", event => {
  const button = event.target.closest("button[data-group]");
  if (!button) return;
  state.activeGroup = button.dataset.group;
  state.currentPage = 1;
  render();
});

els.groupTabs?.addEventListener("keydown", event => {
  const tabs = [...els.groupTabs.querySelectorAll("button[data-group]")];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!offset) return;
  event.preventDefault();
  tabs[(index + offset + tabs.length) % tabs.length].focus();
});

els.previousPageBtn?.addEventListener("click", () => {
  state.currentPage = Math.max(1, state.currentPage - 1);
  render();
});
els.nextPageBtn?.addEventListener("click", () => {
  state.currentPage += 1;
  render();
});

els.pageSizeSetting?.addEventListener("change", () => {
  const value = Number(els.pageSizeSetting.value);
  state.pageSize = [25, 50, 100].includes(value) ? value : 25;
  localStorage.setItem(
    DASHBOARD_STORAGE_KEYS.pageSize,
    String(state.pageSize)
  );
  state.currentPage = 1;
  render();
});

els.separator?.addEventListener("change", () => {
  const value = String(els.separator.value || "----");
  els.separator.value = value;
  localStorage.setItem(DASHBOARD_STORAGE_KEYS.separator, value);
});

els.icloudPrefix?.addEventListener("change", async () => {
  els.icloudPrefix.value = currentIcloudPrefix();
  try {
    await updateBackgroundSettings({ prefix: currentIcloudPrefix() });
    saveIcloudPrefix();
  } catch (error) {
    notify("标签前缀未保存", error.message, "error");
  }
});

els.settingsBtn?.addEventListener("click", () => openDialog(els.settingsDialog));
els.themeToggle?.addEventListener("click", cycleTheme);
els.themeSegmented?.addEventListener("click", event => {
  const button = event.target.closest("[data-theme-value]");
  if (button) applyTheme(button.dataset.themeValue);
});

els.apiKeySubmit?.addEventListener("click", submitApiKey);
els.apiKeyInput?.addEventListener("keydown", event => {
  if (event.key === "Enter") submitApiKey();
});
// The API key dialog is the gate to the whole page, so Esc must not dismiss it.
els.apiKeyDialog?.addEventListener("cancel", event => event.preventDefault());

document.querySelectorAll("[data-close-dialog]").forEach(button => {
  button.addEventListener("click", () => closeDialog(button.closest("dialog")));
});

// Click on the backdrop closes a dialog.
for (const dialog of [els.mailDialog, els.settingsDialog]) {
  dialog?.addEventListener("click", event => {
    if (event.target === dialog) closeDialog(dialog);
  });
}

els.mailPreview?.addEventListener("click", event => {
  const button = event.target.closest("[data-copy]");
  if (button) copyText(button.dataset.copy);
});

els.claimHistoryPanel?.addEventListener("toggle", () => {
  if (els.claimHistoryPanel.open) renderClaimHistory();
});

els.claimHistoryList?.addEventListener("click", event => {
  const button = event.target.closest('[data-action="claim-mail"][data-claim-id]');
  if (!button || button.disabled) return;
  const claim = state.claims.find(item => item.claimId === button.dataset.claimId);
  if (claim && claim.status !== "released") openClaimMail(claim, button);
});

els.moreActionsBtn?.addEventListener("click", event => {
  event.stopPropagation();
  const open = els.moreActionsMenu.dataset.open === "true";
  els.moreActionsMenu.dataset.open = String(!open);
  els.moreActionsBtn.setAttribute("aria-expanded", String(!open));
});
els.moreActionsMenu?.addEventListener("click", () => {
  els.moreActionsMenu.dataset.open = "false";
  els.moreActionsBtn.setAttribute("aria-expanded", "false");
});

document.addEventListener("click", event => {
  if (!event.target.closest("#moreActionsBtn, #moreActionsMenu")) {
    els.moreActionsMenu?.setAttribute("data-open", "false");
    els.moreActionsBtn?.setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest("#rowMenu, [data-action='menu']")) closeRowMenu();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeRowMenu();
  // "/" focuses search, the way every list-heavy tool does it.
  if (event.key === "/" && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)) {
    event.preventDefault();
    els.search?.focus();
  }
});

function accountById(id) {
  return state.accounts.find(item => item.id === id);
}

async function runRowAction(action, account, button) {
  switch (action) {
    case "receive":
      await checkInventoryMail(account, button);
      break;
    case "read": {
      const cached = cachedMessage(account.id);
      if (cached) {
        renderClaimMessage(cached);
        openDialog(els.mailDialog);
        await patchInventoryItem(account, { unread: false });
      } else {
        await checkInventoryMail(account, button, true);
      }
      break;
    }
    case "remark":
      beginRemarkEditing(account);
      render();
      break;
    case "move":
      await patchInventoryItem(account, {
        group: account.group === "finished" ? "unused" : "finished"
      });
      break;
    case "restore":
      await patchInventoryItem(account, {
        group: "finished",
        statusMessage: account.statusMessage || "已恢复"
      });
      break;
    case "mark":
      await patchInventoryItem(account, { unread: false });
      break;
    case "delete":
      await patchInventoryItem(account, {
        group: "trash",
        unread: false,
        statusType: "warn",
        statusMessage: "已移入垃圾箱，尚未同步停用 Apple"
      });
      break;
    case "purge":
      await purgeAccount(account);
      break;
    case "copy-email":
      copyText(account.email);
      break;
    case "copy-code":
      copyText(account.code || account.email);
      break;
  }
}

els.mailList?.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const account = accountById(button.closest(".row")?.dataset.id);
  if (!account) return;

  if (button.dataset.action === "menu") {
    event.stopPropagation();
    const alreadyOpen = button.getAttribute("aria-expanded") === "true";
    closeRowMenu();
    if (!alreadyOpen) openRowMenu(button, account);
    return;
  }
  await runRowAction(button.dataset.action, account, button);
});

els.rowMenu?.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const account = accountById(button.dataset.id);
  closeRowMenu();
  if (account) await runRowAction(button.dataset.action, account, null);
});

// Every keystroke updates the draft, so a render triggered from anywhere
// (batch finishing, sync, search debounce) rebuilds the input with the text
// the operator has actually typed.
els.mailList?.addEventListener("input", event => {
  const input = event.target.closest('input[data-action="remark"]');
  if (input) rememberRemarkDraft(input);
});

// Remark editing commits on blur or Enter and cancels on Escape.
els.mailList?.addEventListener(
  "blur",
  async event => {
    const input = event.target.closest('input[data-action="remark"]');
    if (!input) return;
    const account = accountById(input.closest(".row")?.dataset.id);
    const value = input.value;
    endRemarkEditing();
    if (!account || value === (account.remark || "")) {
      render();
      return;
    }
    try {
      await patchInventoryItem(account, { remark: value });
    } catch (error) {
      notify("备注保存失败", error.message || "无法保存备注", "error");
      render();
    }
  },
  true
);

els.mailList?.addEventListener("keydown", event => {
  const input = event.target.closest('input[data-action="remark"]');
  if (!input) return;
  if (event.key === "Enter") input.blur();
  if (event.key === "Escape") {
    endRemarkEditing();
    render();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshBackgroundStatus();
});

/* ============================================================
   Boot
   ============================================================ */

applyTheme(loadTheme());
if (els.icloudPrefix) {
  els.icloudPrefix.value = readIcloudPrefix(localStorage);
}
if (els.pageSizeSetting) els.pageSizeSetting.value = String(state.pageSize);
if (els.separator) els.separator.value = readSeparator(localStorage);
updateAutoToggleButton();
updateAutoStatus();
render();
beginProtectedStartup();
