export function replaceInventoryItem(state, updated) {
  if (!updated?.id) return;
  const index = state.accounts.findIndex(item => item.id === updated.id);
  if (index >= 0) state.accounts[index] = updated;
}

export function removeInventoryItem(state, id) {
  const index = state.accounts.findIndex(item => item.id === id);
  if (index >= 0) state.accounts.splice(index, 1);
}

export async function checkInventoryMail(
  context,
  account,
  button,
  showMessage = false
) {
  const {
    state,
    apiFetch,
    readApiEnvelope,
    withBusy,
    invalidateMessageCache,
    cacheMessage,
    renderClaimMessage,
    openDialog,
    mailDialog,
    render,
    notify
  } = context;
  const emailKey = account.email.toLowerCase();
  if (state.busyEmails.has(emailKey)) return;
  state.busyEmails.add(emailKey);
  const previousStatus = account.statusMessage;
  await withBusy(button, async () => {
    try {
      const data = await readApiEnvelope(
        await apiFetch(
          `/v1/inventory/${encodeURIComponent(account.id)}/messages/latest`,
          { method: "POST" }
        )
      );
      if (data.disposition === "missing") {
        removeInventoryItem(state, account.id);
      } else {
        replaceInventoryItem(state, data.inventoryItem);
      }
      if (
        data.disposition === "skipped" ||
        data.disposition === "missing"
      ) {
        invalidateMessageCache(account.id);
        notify(
          "状态已变化",
          data.disposition === "missing"
            ? "邮箱记录已删除，扫描结果未写入。"
            : "邮箱状态已变化，扫描结果未写入。",
          "warn"
        );
        return;
      }
      const mailboxError = Array.isArray(data.errors)
        ? data.errors.find(
            error =>
              typeof error?.message === "string" && error.message.trim()
          )
        : null;
      if (mailboxError) {
        invalidateMessageCache(account.id);
        notify("收件失败", mailboxError.message, "error");
        return;
      }
      if (data.message) {
        cacheMessage(account.id, data.message);
        if (showMessage) {
          renderClaimMessage(data.message);
          openDialog(mailDialog);
        } else {
          notify(
            "收到邮件",
            data.inventoryItem?.subject || account.email,
            "ok"
          );
        }
      } else {
        invalidateMessageCache(account.id);
        notify("检查完成", "该邮箱暂无匹配邮件。", "ok");
      }
    } catch (error) {
      account.statusType = "error";
      account.statusMessage =
        error.message || previousStatus || "收件失败";
      notify("收件失败", account.statusMessage, "error");
    } finally {
      state.busyEmails.delete(emailKey);
      render();
    }
  });
}

export function boundedBatchCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.min(999999, Math.max(0, Math.trunc(count)));
}

export function mailBatchNotice(data) {
  const checked = boundedBatchCount(data?.checked);
  const updated = boundedBatchCount(data?.updated);
  const errors = Array.isArray(data?.errors)
    ? boundedBatchCount(data.errors.length)
    : 0;
  const movedText =
    data?.moved === undefined
      ? ""
      : `，归入已使用 ${boundedBatchCount(data.moved)} 个`;
  let message =
    `已检查 ${checked} 个，更新 ${updated} 个` +
    `${movedText}，异常 ${errors} 个。`;
  let tone = errors ? "warn" : "ok";

  if (data?.truncated === true) {
    const scanned = boundedBatchCount(data.scanned);
    const available = Math.max(
      scanned,
      boundedBatchCount(data.available)
    );
    message +=
      ` 仅扫描最近 ${scanned}/${available} 封邮件，` +
      "未覆盖窗口不能判定无邮件。";
    tone = "warn";
  }
  return { message, tone };
}

export async function runMailBatch(context, { endpoint, button, label }) {
  const {
    state,
    setBatchProgress,
    withBusy,
    readApiEnvelope,
    apiFetch,
    invalidateMessageCache,
    render,
    notify
  } = context;
  if (state.mailBatchBusy) return;
  state.mailBatchBusy = true;
  setBatchProgress(true);
  await withBusy(button, async () => {
    try {
      const data = await readApiEnvelope(
        await apiFetch(endpoint, { method: "POST" })
      );
      state.accounts = Array.isArray(data.inventory)
        ? data.inventory
        : state.accounts;
      state.labelNumbers.clear();
      invalidateMessageCache();
      render();
      const notice = mailBatchNotice(data);
      notify(`${label}完成`, notice.message, notice.tone);
    } catch (error) {
      notify(
        `${label}失败`,
        error.message || "转发邮箱暂时不可用",
        "error"
      );
    } finally {
      state.mailBatchBusy = false;
      setBatchProgress(false);
    }
  });
}
