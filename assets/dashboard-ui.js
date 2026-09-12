export const DASHBOARD_ELEMENT_IDS = Object.freeze([
  "search",
  "clearSearchBtn",
  "searchResult",
  "icloudPrefix",
  "separator",
  "generateIcloudBtn",
  "autoGenerateToggle",
  "syncIcloudBtn",
  "refreshForwardBtn",
  "scanUnusedMailBtn",
  "moreActionsBtn",
  "moreActionsMenu",
  "exportBtn",
  "exportFinishedBtn",
  "exportUnusedBtn",
  "markAllReadBtn",
  "notifyBtn",
  "mailList",
  "rowMenu",
  "groupTabs",
  "previousPageBtn",
  "nextPageBtn",
  "pageSummary",
  "pageSizeSetting",
  "settingsBtn",
  "settingsDialog",
  "resetApiKeyBtn",
  "totalCount",
  "finishedCount",
  "unusedCount",
  "trashCount",
  "newCodeCount",
  "toast",
  "mailDialog",
  "mailPreview",
  "pollStatusText",
  "pollStatusDot",
  "apiKeyDialog",
  "apiKeyInput",
  "apiKeySubmit",
  "apiKeyError",
  "migrationCard",
  "migrationTotal",
  "migrationUnused",
  "migrationFinished",
  "migrationTrash",
  "migrationError",
  "confirmMigrationBtn",
  "claimHistoryList",
  "claimHistoryCount",
  "claimHistoryPanel",
  "batchProgress",
  "themeToggle",
  "themeIcon",
  "themeSegmented"
]);

export function collectElements(documentRef, ids = DASHBOARD_ELEMENT_IDS) {
  return Object.fromEntries(
    ids.map(id => [id, documentRef.getElementById(id)])
  );
}

export function debounce(
  fn,
  wait,
  timerApi = globalThis
) {
  let timer = 0;
  return (...args) => {
    timerApi.clearTimeout(timer);
    timer = timerApi.setTimeout(() => fn(...args), wait);
  };
}

export async function withBusy(button, action) {
  if (button) {
    button.dataset.busy = "true";
    button.disabled = true;
  }
  try {
    return await action();
  } finally {
    if (button) {
      delete button.dataset.busy;
      button.disabled = false;
    }
  }
}

export function setBatchProgress(elements, active) {
  if (elements.batchProgress) {
    elements.batchProgress.hidden = !active;
  }
}

export function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

export function formatRelativeTime(value, now = Date.now()) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = now - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 30 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

export function formatRelativeMinutes(value, now = Date.now()) {
  const diff = Math.max(0, now - new Date(value).getTime());
  if (!Number.isFinite(diff)) return "未知";
  const minutes = Math.floor(diff / 60000);
  return minutes < 1 ? "刚刚" : `${minutes} 分钟前`;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function element(documentRef, tag, className, textContent) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

export function openDialog(dialog) {
  if (dialog && !dialog.open) dialog.showModal();
}

export function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}
