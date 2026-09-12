import { randomUUID as systemRandomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ApiError } from "./api.mjs";

// The state file holds verification codes and mail previews, and the migration
// backups hold whatever the browser submitted. Both are as sensitive as the API
// key, which lib/local-secret.mjs already writes owner-only.
const SECRET_FILE_MODE = 0o600;
// A 0o600 directory cannot be traversed by its own owner, so the archive needs
// the execute bit while staying just as private as the files inside it.
const SECRET_DIRECTORY_MODE = 0o700;
const GROUPS = new Set(["unused", "finished", "trash"]);
const DAY_MS = 24 * 60 * 60 * 1000;
// Why 30 days, and not something tighter or looser:
//
// - an `Idempotency-Key` only has to outlive the caller's retry window, which
//   is seconds to hours in practice, so 30 days is already generous by orders
//   of magnitude;
// - a released claim is kept only so a person can still answer "which job
//   burned this address" while investigating something, and questions like
//   that arrive within an ops cycle, not a quarter;
// - anything shorter risks discarding history while somebody is still reading
//   it, and archiving is the one operation here that a person cannot undo from
//   the UI, so the default errs long.
//
// The state file is append-only without this, so even a conservative window
// turns unbounded growth into a bounded working set.
const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
// One browser batch generates at most a handful of addresses. The cap only
// exists so a runaway loop cannot push an unbounded array through a single
// atomic write.
const MAX_CREATE_BATCH = 100;
const LEGACY_FIELDS = [
  "label",
  "remark",
  "code",
  "subject",
  "preview",
  "receivedAt",
  "unread",
  "statusType",
  "statusMessage",
  "lastCheckedAt",
  "lastMethod",
  "noCodeReason"
];
const PATCH_FIELDS = new Set([
  "group",
  "label",
  "remark",
  "code",
  "subject",
  "preview",
  "receivedAt",
  "unread",
  "statusType",
  "statusMessage",
  "lastCheckedAt",
  "lastMethod",
  "noCodeReason",
  "isActive"
]);

function clone(value) {
  return structuredClone(value);
}

function storageError(cause) {
  // The response stays deliberately generic, but the original errno is kept on
  // `cause` so the lifecycle log can say why a write actually failed.
  const error = new ApiError(
    500,
    "STORAGE_ERROR",
    "Dashboard state is unavailable"
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function asIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw storageError();
  }
  return date.toISOString();
}

function emptyState(updatedAt) {
  return {
    version: 1,
    inventory: [],
    claims: [],
    idempotency: {},
    migration: null,
    updatedAt
  };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ApiError(400, "BAD_REQUEST", "A valid email is required");
  }
  return email;
}

function normalizeGroup(value) {
  const group = String(value || "unused");
  if (!GROUPS.has(group)) {
    throw new ApiError(400, "BAD_REQUEST", "Unsupported inventory group");
  }
  return group;
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function normalizeInventoryRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw storageError();
  }

  const normalized = {
    id: stringValue(record.id),
    email: normalizeEmail(record.email),
    group: normalizeGroup(record.group),
    source: stringValue(record.source || "icloud-hme"),
    label: stringValue(record.label),
    remark: stringValue(record.remark),
    appleLabel: stringValue(record.appleLabel),
    anonymousId: stringValue(record.anonymousId),
    isActive: record.isActive !== false,
    activeClaimId: stringValue(record.activeClaimId),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt)
  };

  for (const field of LEGACY_FIELDS) {
    if (field === "unread") {
      normalized.unread = record.unread === true;
    } else {
      normalized[field] = stringValue(record[field]);
    }
  }
  return normalized;
}

function normalizeState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !Array.isArray(value.inventory) ||
    !Array.isArray(value.claims) ||
    !value.idempotency ||
    typeof value.idempotency !== "object" ||
    Array.isArray(value.idempotency) ||
    (value.migration !== null && typeof value.migration !== "object")
  ) {
    throw storageError();
  }

  return {
    version: 1,
    inventory: value.inventory.map(normalizeInventoryRecord),
    claims: clone(value.claims),
    idempotency: clone(value.idempotency),
    migration: value.migration === null ? null : clone(value.migration),
    ...(value.hostedSequence && typeof value.hostedSequence === "object" && !Array.isArray(value.hostedSequence)
      ? { hostedSequence: clone(value.hostedSequence) } : {}),
    ...(value.autoStock && typeof value.autoStock === "object" && !Array.isArray(value.autoStock)
      ? { autoStock: clone(value.autoStock) } : {}),
    updatedAt: stringValue(value.updatedAt)
  };
}

function summaryFor(inventory) {
  const summary = {
    total: inventory.length,
    unused: 0,
    finished: 0,
    trash: 0
  };
  for (const item of inventory) {
    summary[item.group] += 1;
  }
  return summary;
}

function backupTimestamp(iso) {
  return iso.replaceAll(":", "-").replace(".", "-");
}

// Ids from the legacy browser inventory are whatever localStorage happened to
// hold, so they cannot go into a path unescaped.
function fileNameToken(value) {
  return stringValue(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

// One archive file per calendar day. A day is coarse enough that a busy week
// produces seven files instead of thousands, and fine enough that an operator
// looking for "what disappeared last Tuesday" can open exactly one file.
function archiveFileName(iso) {
  return `dashboard-archive-${iso.slice(0, 10)}.json`;
}

function archiveRetentionMs(env) {
  const raw = String(env?.MAIL_DASHBOARD_ARCHIVE_RETENTION_DAYS ?? "").trim();
  if (!raw) {
    return DEFAULT_ARCHIVE_RETENTION_DAYS * DAY_MS;
  }
  const days = Number(raw);
  // A typo in the environment must not silently shrink the window and sweep a
  // year of history into the archive on the next write, so anything that is
  // not a finite non-negative number falls back to the default.
  if (!Number.isFinite(days) || days < 0) {
    return DEFAULT_ARCHIVE_RETENTION_DAYS * DAY_MS;
  }
  return days * DAY_MS;
}

/**
 * Returns when a claim stopped being in use, or `null` if it still is.
 *
 * Everything about this function is deliberately conservative: a claim is only
 * datable once it carries both `status: "released"` and a parseable
 * `releasedAt`. An active claim, a half-written claim, or one whose timestamp
 * the store cannot read is kept in the state file forever rather than archived
 * on a guess — losing an address that a caller still holds is far worse than
 * carrying a few stale rows.
 */
function releasedAtMs(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    return null;
  }
  if (claim.status !== "released") {
    return null;
  }
  // Without a claimId the entry cannot be deduplicated inside the archive
  // file, which is what makes a repeated sweep idempotent, so it stays put.
  if (!stringValue(claim.claimId)) {
    return null;
  }
  const released = Date.parse(stringValue(claim.releasedAt));
  return Number.isNaN(released) ? null : released;
}

function applyInventoryPatch(item, patch, updatedAt) {
  for (const [field, value] of Object.entries(patch)) {
    if (!PATCH_FIELDS.has(field)) {
      continue;
    }
    if (field === "group") {
      const group = normalizeGroup(value);
      // A claimed address carries `activeClaimId`, and `claimNext` only offers
      // rows where that field is empty. Letting a patch move the group without
      // clearing the claim leaves the address invisible to every future claim
      // with no way back through the API.
      if (group !== item.group && item.activeClaimId) {
        throw new ApiError(
          409,
          "CLAIM_ACTIVE",
          "Release the active claim before moving this address to another group"
        );
      }
      item.group = group;
    } else if (field === "unread" || field === "isActive") {
      item[field] = value === true;
    } else {
      item[field] = stringValue(value);
    }
  }
  item.updatedAt = updatedAt;
  return item;
}

function requirePatchObject(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid inventory patch");
  }
  return patch;
}

function normalizeBatchEntry(entry) {
  const pair = Array.isArray(entry) ? { id: entry[0], patch: entry[1] } : entry;
  if (!pair || typeof pair !== "object") {
    throw new ApiError(400, "BAD_REQUEST", "Invalid inventory patch entry");
  }

  const id = stringValue(pair.id);
  if (!id) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "Inventory patch entry requires an id"
    );
  }
  return {
    id,
    patch: requirePatchObject(pair.patch),
    expectedGroup:
      pair.expectedGroup === undefined || pair.expectedGroup === null
        ? undefined
        : normalizeGroup(pair.expectedGroup)
  };
}

function optionalString(value) {
  return value === undefined ? undefined : stringValue(value);
}

/**
 * Reads the fields a caller is allowed to supply for a brand new address.
 *
 * Everything else — `group`, `id`, `activeClaimId`, mail state — is owned by
 * the server, so it is dropped here rather than trusted from the browser.
 */
function normalizeCreateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid inventory address");
  }

  const label = stringValue(record.label);
  return {
    email: normalizeEmail(record.email),
    label,
    remark:
      record.remark === undefined || record.remark === null
        ? label
        : stringValue(record.remark),
    source: stringValue(record.source || "icloud-hme"),
    statusType: stringValue(record.statusType),
    statusMessage: stringValue(record.statusMessage),
    // `undefined` and an empty string mean different things below: only a
    // field the caller actually sent may touch a row that already exists.
    appleLabel: optionalString(record.appleLabel),
    anonymousId: optionalString(record.anonymousId),
    isActive: record.isActive === undefined ? undefined : record.isActive !== false
  };
}

function normalizeBatchEntries(entries) {
  const list = entries instanceof Map ? [...entries] : entries;
  if (!Array.isArray(list)) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "Inventory patches must be a Map or an array"
    );
  }
  return list.map(normalizeBatchEntry);
}

export class DashboardStore {
  #archiveDir;
  #archiveRetentionMs;
  #backupDir;
  #now;
  #queue = Promise.resolve();
  #randomUUID;
  #statePath;

  constructor({
    statePath,
    backupDir,
    archiveDir,
    now = () => new Date(),
    randomUUID = systemRandomUUID,
    env = process.env
  }) {
    this.#statePath = statePath;
    this.#backupDir = backupDir;
    // Defaulting next to the state file keeps `runtime/archive/` alongside
    // `runtime/dashboard-state-v1.json` without every caller having to know
    // about a second path.
    this.#archiveDir = archiveDir || join(dirname(statePath), "archive");
    this.#archiveRetentionMs = archiveRetentionMs(env);
    this.#now = now;
    this.#randomUUID = randomUUID;
  }

  async read() {
    let raw;
    try {
      raw = await readFile(this.#statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyState(asIso(this.#now));
      }
      throw storageError();
    }

    try {
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ApiError && error.code !== "BAD_REQUEST") {
        throw error;
      }
      throw storageError();
    }
  }

  mutate(worker) {
    const operation = async () => {
      const state = await this.read();
      const result = await worker(state);
      const updatedAt = asIso(this.#now);
      // Archiving runs here, and only here, for three reasons:
      //
      // - `read()` must stay side-effect free. A sweep on the read path would
      //   turn `GET /v1/inventory` into a writer, so a corrupt archive file or
      //   a full disk would start failing plain lookups, and two concurrent
      //   reads would race on the same archive file.
      // - `mutate` already holds the store queue and is already about to
      //   rewrite the whole state file, so the sweep costs one extra file
      //   write instead of a second state write, and never runs concurrently
      //   with itself.
      // - it runs *after* the worker so the worker always sees the state
      //   exactly as it was persisted. A claim lookup can never fail because
      //   the sweep pulled the row out from under it, and anything the worker
      //   just released is by definition younger than the retention window.
      //
      // The sweep is also allowed to throw: if the archive cannot be written,
      // the state file is left untouched rather than dropping the rows on the
      // floor, so the caller sees STORAGE_ERROR and the data is still there on
      // the next attempt.
      await this.#archiveExpired(state, updatedAt);
      state.updatedAt = updatedAt;
      await this.#writeAtomic(state);
      return result === undefined ? clone(state) : clone(result);
    };

    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async waitForIdle() {
    while (true) {
      const queue = this.#queue;
      await queue;
      if (queue === this.#queue) {
        return;
      }
    }
  }

  async initializeFromLegacy(records) {
    if (!Array.isArray(records)) {
      throw new ApiError(400, "BAD_REQUEST", "Legacy inventory must be an array");
    }

    const submitted = clone(records);
    const deduplicated = [];
    const seen = new Set();
    for (const record of submitted) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new ApiError(400, "BAD_REQUEST", "Invalid legacy inventory record");
      }
      const email = normalizeEmail(record.email);
      const group = normalizeGroup(record.group);
      if (seen.has(email)) {
        continue;
      }
      seen.add(email);
      deduplicated.push({ ...record, email, group });
    }

    return this.mutate(async state => {
      if (state.migration !== null) {
        throw new ApiError(
          409,
          "INVENTORY_ALREADY_INITIALIZED",
          "Browser inventory has already been migrated"
        );
      }

      const completedAt = asIso(this.#now);
      const backupFile = `local-storage-${backupTimestamp(completedAt)}.json`;
      await this.#writeBackup(backupFile, submitted);

      const byEmail = new Map(
        state.inventory.map(item => [item.email.toLowerCase(), item])
      );
      for (const legacy of deduplicated) {
        const existing = byEmail.get(legacy.email);
        const createdAt = existing?.createdAt || completedAt;
        const item = {
          ...(existing || {}),
          id: existing?.id || this.#randomUUID(),
          email: legacy.email,
          group: legacy.group,
          source: stringValue(legacy.source || existing?.source || "icloud-hme"),
          label: stringValue(legacy.label),
          remark: stringValue(legacy.remark),
          appleLabel: stringValue(existing?.appleLabel),
          anonymousId: stringValue(existing?.anonymousId),
          isActive: existing?.isActive !== false,
          createdAt,
          updatedAt: completedAt
        };
        for (const field of LEGACY_FIELDS) {
          if (field === "unread") {
            item.unread = legacy.unread === true;
          } else {
            item[field] = stringValue(legacy[field]);
          }
        }

        if (existing) {
          Object.assign(existing, item);
        } else {
          state.inventory.push(item);
          byEmail.set(item.email, item);
        }
      }

      state.migration = {
        completedAt,
        backupFile
      };
      return {
        summary: summaryFor(state.inventory),
        migration: clone(state.migration)
      };
    });
  }

  async syncAliases(rows) {
    if (!Array.isArray(rows)) {
      throw new ApiError(400, "BAD_REQUEST", "Alias rows must be an array");
    }

    return this.mutate(state => {
      const updatedAt = asIso(this.#now);
      const byEmail = new Map(
        state.inventory.map(item => [item.email.toLowerCase(), item])
      );
      for (const row of rows) {
        const email = normalizeEmail(row?.email);
        const officialLabel = stringValue(row?.appleLabel ?? row?.label);
        const existing = byEmail.get(email);
        if (existing) {
          existing.label = officialLabel;
          existing.appleLabel = officialLabel;
          existing.anonymousId = stringValue(
            row.anonymousId ?? existing.anonymousId
          );
          if (row.isActive !== undefined) {
            existing.isActive = row.isActive !== false;
          }
          existing.updatedAt = updatedAt;
          continue;
        }

        const item = normalizeInventoryRecord({
          id: this.#randomUUID(),
          email,
          group: "unused",
          source: row.source || "icloud-hme",
          label: officialLabel,
          remark: row.remark ?? officialLabel,
          appleLabel: officialLabel,
          anonymousId: row.anonymousId,
          isActive: row.isActive,
          createdAt: row.createdAt || updatedAt,
          updatedAt
        });
        state.inventory.push(item);
        byEmail.set(email, item);
      }
      return state.inventory;
    });
  }

  /**
   * Adds freshly generated addresses to the authoritative inventory.
   *
   * The email address is the idempotency key. Unlike `POST /v1/claims`, which
   * consumes a scarce row and therefore needs a caller-supplied
   * `Idempotency-Key` to avoid burning a second address on a retry, a created
   * address already carries its own identity: Apple minted it, it is unique,
   * and the rest of the store (`syncAliases`, `initializeFromLegacy`) already
   * treats the inventory as a set keyed by lowercased email. A header key
   * would also be wrong for batches — a retry that overlaps a previous batch
   * only partially cannot be resolved by one key, while an email-keyed upsert
   * converges row by row.
   *
   * An address that already exists belongs to the operator, so its group,
   * remark, claim and mail state are left alone. The Apple label is
   * authoritative, so a supplied label refreshes both compatibility fields.
   *
   * The whole batch is validated before the mutation starts, so a malformed
   * row cannot leave half of a batch persisted, and every accepted row lands
   * in a single atomic state write.
   *
   * @param {Array<object>} records
   * @returns {Promise<{inventory: object[], created: object[], existing: object[]}>}
   */
  async createInventoryItems(records) {
    if (!Array.isArray(records)) {
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "Inventory addresses must be an array"
      );
    }
    if (records.length > MAX_CREATE_BATCH) {
      throw new ApiError(
        400,
        "BAD_REQUEST",
        `A single request accepts at most ${MAX_CREATE_BATCH} addresses`
      );
    }

    const prepared = [];
    const seen = new Set();
    for (const record of records) {
      const normalized = normalizeCreateRecord(record);
      if (seen.has(normalized.email)) {
        continue;
      }
      seen.add(normalized.email);
      prepared.push(normalized);
    }

    if (!prepared.length) {
      return { inventory: await this.listInventory(), created: [], existing: [] };
    }

    return this.mutate(state => {
      const createdAt = asIso(this.#now);
      const byEmail = new Map(
        state.inventory.map(item => [item.email.toLowerCase(), item])
      );
      const created = [];
      const existing = [];

      for (const record of prepared) {
        const current = byEmail.get(record.email);
        if (current) {
          let touched = false;
          const officialLabel =
            record.appleLabel !== undefined
              ? record.appleLabel
              : record.label;
          if (record.appleLabel !== undefined || officialLabel) {
            current.label = officialLabel;
            current.appleLabel = officialLabel;
            touched = true;
          }
          if (record.anonymousId !== undefined) {
            current.anonymousId = record.anonymousId;
            touched = true;
          }
          if (record.isActive !== undefined) {
            current.isActive = record.isActive;
            touched = true;
          }
          if (touched) {
            current.updatedAt = createdAt;
          }
          existing.push(current);
          continue;
        }

        const item = normalizeInventoryRecord({
          id: this.#randomUUID(),
          email: record.email,
          group: "unused",
          source: record.source,
          label: record.appleLabel ?? record.label,
          remark: record.remark,
          appleLabel: record.appleLabel ?? record.label,
          anonymousId: record.anonymousId,
          isActive: record.isActive,
          statusType: record.statusType,
          statusMessage: record.statusMessage,
          createdAt,
          updatedAt: createdAt
        });
        state.inventory.push(item);
        byEmail.set(item.email, item);
        created.push(item);
      }

      return { inventory: state.inventory, created, existing };
    });
  }

  /**
   * Permanently removes a trashed address from the authoritative inventory.
   *
   * Three guards stand between a click and an unrecoverable row:
   *
   * - only `trash` is deletable, so a mis-aimed request cannot take out an
   *   address that is still in rotation;
   * - an address still held by a claim is refused with `CLAIM_ACTIVE`, matching
   *   what a group change already does;
   * - the record is written to the backup directory before it leaves the state
   *   file, so an operator who deletes the wrong row can put it back by hand.
   *
   * Apple-side deactivation is deliberately not attempted here. The hidden-email
   * deactivate endpoint is unforgiving and the account it would act on is the
   * operator's primary Apple ID, so this stays a local-inventory operation.
   *
   * @param {string} id
   * @returns {Promise<{inventory: object[], deleted: object}>}
   */
  async deleteInventoryItem(id) {
    const targetId = stringValue(id);
    if (!targetId) {
      throw new ApiError(400, "BAD_REQUEST", "Inventory id is required");
    }

    return this.mutate(async state => {
      const index = state.inventory.findIndex(item => item.id === targetId);
      if (index < 0) {
        throw new ApiError(404, "INVENTORY_NOT_FOUND", "Inventory item not found");
      }

      const item = state.inventory[index];
      if (item.activeClaimId) {
        throw new ApiError(
          409,
          "CLAIM_ACTIVE",
          "Release the active claim before deleting this address"
        );
      }
      if (item.group !== "trash") {
        throw new ApiError(
          409,
          "INVENTORY_NOT_IN_TRASH",
          "Only addresses in the trash group can be deleted permanently"
        );
      }

      const deletedAt = asIso(this.#now);
      await this.#writeBackup(
        `inventory-deleted-${backupTimestamp(deletedAt)}-${fileNameToken(item.id)}.json`,
        { deletedAt, item }
      );
      state.inventory.splice(index, 1);
      return { inventory: state.inventory, deleted: item };
    });
  }

  async updateInventoryItem(id, patch) {
    requirePatchObject(patch);

    return this.mutate(state => {
      const item = state.inventory.find(candidate => candidate.id === id);
      if (!item) {
        throw new ApiError(404, "INVENTORY_NOT_FOUND", "Inventory item not found");
      }
      return applyInventoryPatch(item, patch, asIso(this.#now));
    });
  }

  /**
   * Applies many inventory patches inside a single atomic state write.
   *
   * Batch callers previously issued one `updateInventoryItem` per row, and each
   * of those re-read, re-parsed, re-serialized and rewrote the whole state
   * file. At 700 rows that is 700 full read/write cycles on a multi-megabyte
   * document, all serialized on the store queue, which blocks every other
   * request for the duration of the batch. This collapses the same work into
   * one read and one write.
   *
   * `expectedGroup` guards against long-running batches clobbering a decision
   * the operator made while the batch was in flight: a row whose group no
   * longer matches is reported in `skipped` and left untouched.
   *
   * @param {Map<string, object>|Array<[string, object]|{id: string, patch: object, expectedGroup?: string}>} patches
   * @returns {Promise<{inventory: object[], updated: object[], missing: string[], skipped: string[]}>}
   */
  async updateInventoryItems(patches) {
    const entries = normalizeBatchEntries(patches);
    if (!entries.length) {
      return {
        inventory: await this.listInventory(),
        updated: [],
        missing: [],
        skipped: []
      };
    }

    return this.mutate(state => {
      const updatedAt = asIso(this.#now);
      const byId = new Map(state.inventory.map(item => [item.id, item]));
      const updated = [];
      const missing = [];
      const skipped = [];

      for (const entry of entries) {
        const item = byId.get(entry.id);
        if (!item) {
          missing.push(entry.id);
          continue;
        }
        if (
          entry.expectedGroup !== undefined &&
          item.group !== entry.expectedGroup
        ) {
          skipped.push(entry.id);
          continue;
        }
        updated.push(applyInventoryPatch(item, entry.patch, updatedAt));
      }

      return { inventory: state.inventory, updated, missing, skipped };
    });
  }

  async listInventory() {
    return clone((await this.read()).inventory);
  }

  /**
   * Moves expired claims and idempotency keys out of `state` and into the
   * archive, mutating `state` in place.
   *
   * Nothing leaves the state file until the archive write has landed, so a
   * failure anywhere below propagates and aborts the whole `mutate` with the
   * rows still in `state`. The alternative — swallowing the error and writing
   * the trimmed state anyway — would delete history with nowhere to recover it
   * from, which is the one outcome worth failing a request over.
   */
  async #archiveExpired(state, archivedAt) {
    const cutoff = Date.parse(archivedAt) - this.#archiveRetentionMs;
    // An inventory row still pointing at a claim keeps that claim alive no
    // matter what its status says. Archiving it would strand the address:
    // `claimNext` skips rows with an `activeClaimId`, and release needs the
    // claim record to find its way back to `unused`.
    const heldClaimIds = new Set(
      state.inventory.map(item => item.activeClaimId).filter(Boolean)
    );

    const expiredClaims = [];
    const remainingClaims = [];
    for (const claim of state.claims) {
      const released = releasedAtMs(claim);
      if (
        released !== null &&
        released < cutoff &&
        !heldClaimIds.has(claim.claimId)
      ) {
        expiredClaims.push(claim);
      } else {
        remainingClaims.push(claim);
      }
    }

    // A key survives exactly as long as the claim it points at. Keeping a key
    // whose claim has been archived would make every retry of that key fail
    // with "Claim idempotency state is inconsistent" forever, and there is no
    // separate timestamp on a key to date it by anyway.
    const survivingClaimIds = new Set(
      remainingClaims.map(claim => stringValue(claim?.claimId))
    );
    const expiredKeys = Object.entries(state.idempotency).filter(
      ([, claimId]) => !survivingClaimIds.has(stringValue(claimId))
    );

    if (!expiredClaims.length && !expiredKeys.length) {
      return;
    }

    await this.#appendArchive(archivedAt, expiredClaims, expiredKeys);

    // In place, because `mutate` callers and the router hand `state.claims`
    // and `state.idempotency` straight into a response; replacing the array
    // and the object would leave those references pointing at the pre-sweep
    // copies.
    state.claims.length = 0;
    for (const claim of remainingClaims) {
      state.claims.push(claim);
    }
    for (const [key] of expiredKeys) {
      delete state.idempotency[key];
    }
  }

  /**
   * Merges a batch of expired rows into the archive file for `archivedAt`.
   *
   * Merging is keyed by `claimId` and by idempotency key rather than appending
   * blindly, so a sweep that runs twice over the same rows — which happens
   * whenever the archive write succeeded but the state write that followed it
   * did not — converges instead of accumulating duplicates.
   */
  async #appendArchive(archivedAt, claims, idempotencyEntries) {
    const filePath = join(this.#archiveDir, archiveFileName(archivedAt));
    const existing = await this.#readArchive(filePath);

    const byClaimId = new Map(
      existing.claims.map(claim => [stringValue(claim?.claimId), claim])
    );
    for (const claim of claims) {
      byClaimId.set(stringValue(claim.claimId), { ...claim, archivedAt });
    }
    // Null-prototype, because an idempotency key is caller-supplied text: on a
    // normal object `idempotency["__proto__"] = claimId` hits the inherited
    // setter, is ignored, and the key would vanish from the archive after
    // having already been deleted from the state file.
    const idempotency = Object.assign(
      Object.create(null),
      existing.idempotency
    );
    for (const [key, claimId] of idempotencyEntries) {
      idempotency[key] = claimId;
    }

    await this.#writeFileAtomic(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          date: archivedAt.slice(0, 10),
          claims: [...byClaimId.values()],
          idempotency
        },
        null,
        2
      )}\n`,
      SECRET_DIRECTORY_MODE
    );
  }

  async #readArchive(filePath) {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { claims: [], idempotency: {} };
      }
      throw storageError(error);
    }

    // A damaged archive file is never overwritten. Rewriting it would destroy
    // exactly the history this file exists to preserve, so the sweep fails
    // loudly and an operator moves the file aside by hand.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw storageError(error);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray(parsed.claims) ||
      !parsed.idempotency ||
      typeof parsed.idempotency !== "object" ||
      Array.isArray(parsed.idempotency)
    ) {
      throw storageError();
    }
    return parsed;
  }

  async #writeAtomic(state) {
    await this.#writeFileAtomic(
      this.#statePath,
      `${JSON.stringify(state, null, 2)}\n`
    );
  }

  async #writeFileAtomic(targetPath, contents, directoryMode) {
    const directory = dirname(targetPath);
    const temporaryPath = join(
      directory,
      `.${basename(targetPath)}.${process.pid}.${systemRandomUUID()}.tmp`
    );
    try {
      await mkdir(
        directory,
        directoryMode === undefined
          ? { recursive: true }
          : { recursive: true, mode: directoryMode }
      );
      await writeFile(temporaryPath, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: SECRET_FILE_MODE
      });
      await rename(temporaryPath, targetPath);
    } catch (error) {
      // A failed rename (antivirus or a sync client holding the target open on
      // Windows is the common case) used to leave the temporary file behind
      // with no trace of the cause. Every retry then added another multi-
      // megabyte orphan to runtime/.
      await unlink(temporaryPath).catch(() => {});
      throw storageError(error);
    }
  }

  async #writeBackup(fileName, records) {
    try {
      await mkdir(this.#backupDir, { recursive: true });
      await writeFile(
        join(this.#backupDir, fileName),
        `${JSON.stringify(records, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: SECRET_FILE_MODE }
      );
    } catch (error) {
      throw storageError(error);
    }
  }
}
