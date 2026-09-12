import { ApiError } from "./api.mjs";

function isoNow(now) {
  return now().toISOString();
}

function methodFor(message) {
  return `Forward IMAP/${message.mailbox || "INBOX"}`;
}

function timeValue(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A batch check re-reads the same forwarding mailbox every run, so the newest
 * message for an alias is usually the message that is already stored and
 * already read. Marking it unread again on every scan flipped hundreds of rows
 * back to unread and inflated the header counter, so only a strictly newer
 * message is allowed to raise the unread flag.
 */
function isNewerThanStored(message, previous) {
  const stored = timeValue(previous?.receivedAt);
  if (stored === null) {
    return true;
  }
  const incoming = timeValue(message?.receivedAt);
  if (incoming === null) {
    return false;
  }
  return incoming > stored;
}

function messagePatch(message, checkedAt, previous) {
  const code = Array.isArray(message.codes) ? String(message.codes[0] || "") : "";
  const method = methodFor(message);
  const noCodeReason = code
    ? ""
    : "收到转发邮件，但未识别到验证码；请查看邮件内容";
  const patch = {
    code,
    subject: message.subject || "新邮件",
    preview: String(message.text || "").slice(0, 4_000),
    receivedAt: message.receivedAt || checkedAt,
    statusType: code ? "ok" : "warn",
    statusMessage: code
      ? `已识别验证码 / ${method}`
      : noCodeReason,
    lastCheckedAt: checkedAt,
    lastMethod: method,
    noCodeReason
  };
  if (isNewerThanStored(message, previous)) {
    patch.unread = true;
  }
  return patch;
}

function noMessagePatch(checkedAt) {
  return {
    statusType: "ok",
    statusMessage: "检查完成，暂无匹配邮件",
    lastCheckedAt: checkedAt
  };
}

/**
 * The scan window of a run that never reached IMAP.
 *
 * Reported as "nothing was skipped" rather than omitted, so the caller always
 * finds the same three fields and never has to branch on `undefined`.
 */
function emptyScan() {
  return { scanned: 0, available: 0, truncated: false };
}

/**
 * Reads `{messages, scanned, available, truncated}` off a mailbox reader.
 *
 * A bare `{alias: message}` map is still accepted: the reader is injected, and
 * a double that predates the scan window must not silently degrade every row to
 * "暂无匹配邮件". Alias keys always contain "@", so the presence of a literal
 * `messages` key unambiguously identifies the richer shape.
 */
function scanResult(value) {
  if (!value || typeof value !== "object" || !("messages" in value)) {
    return { messages: value || {}, ...emptyScan() };
  }
  const scanned = Number.isInteger(value.scanned) ? value.scanned : 0;
  return {
    messages: value.messages || {},
    scanned,
    available: Number.isInteger(value.available) ? value.available : scanned,
    truncated: value.truncated === true
  };
}

function unavailableMessage(error) {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "转发邮箱暂时不可用";
}

function singleUpdateResult(result, id) {
  const inventoryItem =
    result.inventory.find(candidate => candidate.id === id) || null;
  if (result.updated.some(candidate => candidate.id === id)) {
    return { disposition: "applied", inventoryItem };
  }
  if (result.skipped.includes(id)) {
    return { disposition: "skipped", inventoryItem };
  }
  return { disposition: "missing", inventoryItem };
}

export class InventoryMailService {
  #batchPromise = null;
  #mailboxReader;
  #now;
  #store;
  #unusedBatchPromise = null;

  constructor({ store, mailboxReader, now = () => new Date() }) {
    this.#store = store;
    this.#mailboxReader = mailboxReader;
    this.#now = now;
  }

  async checkOne(id) {
    const item = await this.#findInventoryItem(id);
    const checkedAt = isoNow(this.#now);
    let mailError = null;
    let mailMessage = null;
    try {
      mailMessage = await this.#mailboxReader.latestForAlias(item.email, {
        waitSeconds: 0
      });
    } catch (error) {
      mailError = error;
    }

    const errorMessage = mailError ? unavailableMessage(mailError) : "";
    const patch = mailError
      ? {
          statusType: "error",
          statusMessage: errorMessage,
          lastCheckedAt: checkedAt
        }
      : mailMessage
        ? {
            ...messagePatch(mailMessage, checkedAt, item),
            ...(item.group === "unused" ? { group: "finished" } : {})
          }
        : noMessagePatch(checkedAt);
    const result = await this.#store.updateInventoryItems([
      { id: item.id, expectedGroup: item.group, patch }
    ]);
    const { disposition, inventoryItem } = singleUpdateResult(result, item.id);
    const applied = disposition === "applied";
    return {
      checked: 1,
      updated: applied && !mailError && Boolean(mailMessage) ? 1 : 0,
      moved:
        applied && !mailError && item.group === "unused" && Boolean(mailMessage)
          ? 1
          : 0,
      disposition,
      errors:
        applied && mailError
          ? [{ inventoryId: item.id, message: errorMessage }]
          : [],
      inventoryItem,
      message: applied && !mailError ? mailMessage : null
    };
  }

  checkFinished() {
    if (!this.#batchPromise) {
      this.#batchPromise = this.#runBatch({
        group: "finished",
        moveToFinished: false
      }).finally(() => {
        this.#batchPromise = null;
      });
    }
    return this.#batchPromise;
  }

  checkUnused() {
    if (!this.#unusedBatchPromise) {
      this.#unusedBatchPromise = this.#runBatch({
        group: "unused",
        moveToFinished: true
      }).finally(() => {
        this.#unusedBatchPromise = null;
      });
    }
    return this.#unusedBatchPromise;
  }

  async #findInventoryItem(id) {
    const inventory = await this.#store.listInventory();
    const item = inventory.find(candidate => candidate.id === id);
    if (!item) {
      throw new ApiError(
        404,
        "INVENTORY_NOT_FOUND",
        "Inventory item not found"
      );
    }
    return item;
  }

  /**
   * Scans one inventory group against the forwarding mailbox.
   *
   * The whole batch lands in a single `updateInventoryItems` call, so the state
   * file is read once and written once instead of once per row. Every entry
   * carries `expectedGroup`, so a row the operator moved elsewhere while the
   * IMAP scan was running keeps its new group instead of being dragged back by
   * a stale snapshot.
   *
   * The result carries the mailbox scan window (`scanned`, `available`,
   * `truncated`) so the UI can warn that "暂无匹配邮件" may just mean the alias
   * sat outside the window. Note these count IMAP messages, not inventory rows
   * — `checked` remains the row counter.
   */
  async #runBatch({ group, moveToFinished }) {
    const targets = (await this.#store.listInventory()).filter(
      item => item.group === group && item.isActive !== false
    );
    const checkedAt = isoNow(this.#now);
    if (!targets.length) {
      return {
        checked: 0,
        updated: 0,
        ...(moveToFinished ? { moved: 0 } : {}),
        ...emptyScan(),
        errors: [],
        inventory: await this.#store.listInventory()
      };
    }

    let scan;
    try {
      scan = scanResult(
        await this.#mailboxReader.latestForAliases(
          targets.map(item => item.email)
        )
      );
    } catch (error) {
      const message = unavailableMessage(error);
      const failure = await this.#store.updateInventoryItems(
        targets.map(item => ({
          id: item.id,
          expectedGroup: group,
          patch: {
            statusType: "error",
            statusMessage: message,
            lastCheckedAt: checkedAt
          }
        }))
      );
      return {
        checked: targets.length,
        updated: 0,
        ...(moveToFinished ? { moved: 0 } : {}),
        ...emptyScan(),
        errors: targets.map(item => ({
          inventoryId: item.id,
          message
        })),
        inventory: failure.inventory
      };
    }

    const entries = [];
    const plan = new Map();
    for (const item of targets) {
      const message = scan.messages[item.email.toLowerCase()] || null;
      if (!message) {
        entries.push({
          id: item.id,
          expectedGroup: group,
          patch: noMessagePatch(checkedAt)
        });
        plan.set(item.id, { matched: false, moves: false });
        continue;
      }

      const patch = messagePatch(message, checkedAt, item);
      if (moveToFinished) {
        patch.group = "finished";
      }
      entries.push({ id: item.id, expectedGroup: group, patch });
      plan.set(item.id, { matched: true, moves: moveToFinished });
    }

    const result = await this.#store.updateInventoryItems(entries);
    const applied = new Set(result.updated.map(item => item.id));
    let updated = 0;
    let moved = 0;
    for (const [id, info] of plan) {
      if (!applied.has(id) || !info.matched) {
        continue;
      }
      updated += 1;
      if (info.moves) {
        moved += 1;
      }
    }

    return {
      checked: targets.length,
      updated,
      ...(moveToFinished ? { moved } : {}),
      scanned: scan.scanned,
      available: scan.available,
      truncated: scan.truncated,
      errors: [],
      inventory: result.inventory
    };
  }
}
