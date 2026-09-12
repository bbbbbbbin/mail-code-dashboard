import { readFile } from "node:fs/promises";

import { ImapFlow } from "imapflow";

import { ApiError, parseBoundedInteger } from "./api.mjs";
import {
  collectMessageRecipients,
  findMatchingAliases,
  messageMatchesAlias,
  parseMailContent
} from "./mail-content.mjs";

export const FORWARD_MAILBOX_DEFAULTS = Object.freeze({
  host: "imap.qq.com",
  port: 993,
  secure: true,
  mailboxes: Object.freeze(["INBOX"]),
  messageLimit: 100,
  pollIntervalMs: 1_000
});

export const DEFAULT_SCAN_BATCH_SIZE = 20;

function mailboxNotConfigured() {
  return new ApiError(
    503,
    "MAILBOX_NOT_CONFIGURED",
    "Forwarding mailbox is not configured"
  );
}

function mailboxUnavailable() {
  return new ApiError(
    502,
    "MAILBOX_UNAVAILABLE",
    "Forwarding mailbox is unavailable"
  );
}

function boundedConfigInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw mailboxNotConfigured();
  }
  return parsed;
}

export function normalizeForwardMailboxConfig(value) {
  const email = String(value?.email || "").trim();
  const password = String(value?.password || "");
  if (!email || !password) {
    throw mailboxNotConfigured();
  }

  const host =
    String(value?.host || "").trim() || FORWARD_MAILBOX_DEFAULTS.host;
  const mailboxes = Array.isArray(value?.mailboxes)
    ? value.mailboxes.map(item => String(item || "").trim()).filter(Boolean)
    : [];
  return {
    host,
    port: boundedConfigInteger(
      value?.port,
      FORWARD_MAILBOX_DEFAULTS.port,
      1,
      65_535
    ),
    secure:
      value?.secure === undefined
        ? FORWARD_MAILBOX_DEFAULTS.secure
        : value.secure !== false,
    email,
    password,
    mailboxes: mailboxes.length
      ? [...new Set(mailboxes)]
      : [...FORWARD_MAILBOX_DEFAULTS.mailboxes],
    messageLimit: boundedConfigInteger(
      value?.messageLimit,
      FORWARD_MAILBOX_DEFAULTS.messageLimit,
      1,
      500
    ),
    pollIntervalMs: boundedConfigInteger(
      value?.pollIntervalMs,
      FORWARD_MAILBOX_DEFAULTS.pollIntervalMs,
      100,
      30_000
    )
  };
}

export async function readForwardMailboxConfig(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw mailboxNotConfigured();
  }

  return normalizeForwardMailboxConfig(value);
}

function publicMessage(message) {
  return { ...message };
}

function receivedTime(message) {
  const value = new Date(message.receivedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function metadataReceivedTime(message) {
  const envelopeDate = message?.envelope?.date;
  if (envelopeDate !== undefined && envelopeDate !== null) {
    const envelopeTime = new Date(envelopeDate).getTime();
    if (Number.isFinite(envelopeTime)) {
      return envelopeTime;
    }
  }
  const internalTime = new Date(message?.internalDate).getTime();
  return Number.isFinite(internalTime) ? internalTime : 0;
}

function mailSourceId(mailbox, uidValidity, uid) {
  const name = String(mailbox || "");
  const validity = String(uidValidity ?? "");
  const number = Number(uid);
  if (
    !name ||
    !/^[1-9]\d*$/u.test(validity) ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    return "";
  }
  return JSON.stringify([name, validity, number]);
}

function normalizeAliases(emails) {
  return [
    ...new Set(
      (Array.isArray(emails) ? emails : [])
        .map(email => String(email || "").trim().toLowerCase())
        .filter(email => email.includes("@"))
    )
  ];
}

function normalizeUids(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(uid => Number(uid))
        .filter(uid => Number.isSafeInteger(uid) && uid > 0)
    )
  ].sort((left, right) => left - right);
}

function delayFor(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Applies the `messageLimit` scan window and remembers what it cut off.
 *
 * `search({all: true})` answers every UID in the folder but only the newest
 * `messageLimit` of them are ever fetched. Once ~700 aliases share one
 * forwarding mailbox the older ones fall outside that window permanently, and
 * the UI rendered that as "暂无匹配邮件" — indistinguishable from an alias that
 * genuinely never received mail. Counting the skipped UIDs is what lets the
 * caller say "the window ended before your alias" out loud. Raising the limit
 * is a config decision, not a fix.
 *
 * Counters accumulate across every mailbox of one scan, so the totals describe
 * the whole pass rather than the last folder opened.
 *
 * @param {number} messageLimit
 */
function scanWindow(messageLimit) {
  let available = 0;
  let scanned = 0;
  return {
    /**
     * @param {number[]} uids server-side search hits, oldest first
     * @returns {number[]} the newest bounded UIDs, newest first
     */
    take(uids) {
      const all = Array.isArray(uids) ? uids : [];
      available += all.length;
      const newestUids = all.slice(-messageLimit).reverse();
      scanned += newestUids.length;
      return newestUids;
    },
    stats() {
      return { scanned, available, truncated: available > scanned };
    }
  };
}

export class ForwardMailboxReader {
  #clientFactory;
  #configPath;
  #delay;
  #now;

  constructor({
    configPath,
    clientFactory = options => new ImapFlow(options),
    delay = delayFor,
    now = () => Date.now()
  }) {
    this.#configPath = configPath;
    this.#clientFactory = clientFactory;
    this.#delay = delay;
    this.#now = now;
  }

  async listForAlias(email, { limit = 20 } = {}) {
    const boundedLimit = parseBoundedInteger(limit, 20, 1, 100);
    const config = await readForwardMailboxConfig(this.#configPath);
    return this.#withClient(config, client =>
      this.#scan(client, config, email, boundedLimit)
    );
  }

  async latestForAlias(email, { waitSeconds = 0 } = {}) {
    const boundedWait = parseBoundedInteger(waitSeconds, 0, 0, 30);
    const config = await readForwardMailboxConfig(this.#configPath);
    const deadline = this.#now() + boundedWait * 1_000;

    return this.#withClient(config, async client => {
      while (true) {
        const messages = await this.#scan(client, config, email, 1);
        if (messages.length) {
          return messages[0];
        }

        const remaining = deadline - this.#now();
        if (remaining <= 0) {
          return null;
        }
        await this.#delay(Math.min(config.pollIntervalMs, remaining));
      }
    });
  }

  /**
   * Finds the newest message per alias in one pass over every mailbox.
   *
   * Returns the scan window alongside the matches so callers can distinguish
   * "this alias received nothing" from "the scan stopped before this alias's
   * mail". `scanned` counts the messages actually fetched this run, `available`
   * the total the server matched, and `truncated` is `available > scanned`.
   *
   * @param {string[]} emails
   * @returns {Promise<{
   *   messages: Record<string, object>,
   *   scanned: number,
   *   available: number,
   *   truncated: boolean
   * }>} `messages` is keyed by lowercased alias
   */
  async latestForAliases(emails) {
    const aliases = normalizeAliases(emails);
    if (!aliases.length) {
      // No IMAP round trip happened, so nothing was skipped either.
      return { messages: {}, scanned: 0, available: 0, truncated: false };
    }

    const config = await readForwardMailboxConfig(this.#configPath);
    return this.#withClient(config, client =>
      this.#scanAliases(client, config, aliases)
    );
  }

  /**
   * Lists the newest forwarded messages across every configured mailbox.
   *
   * The limit is applied only after INBOX, Junk and any other configured
   * mailbox are merged and sorted, so a burst in one folder cannot hide newer
   * messages sitting in another. Each mailbox scans at least the requested
   * limit while preserving a larger configured window.
   *
   * @param {string[]} emails
   * @param {{limit?: number, includeUnmatched?: boolean}} [options]
   * @returns {Promise<object[]>} newest-first public messages carrying
   *   `recipients` and `matchedEmails`
   */
  async recentForAliases(emails, { limit = 10, includeUnmatched = false } = {}) {
    const boundedLimit = parseBoundedInteger(limit, 10, 1, 200);
    const aliases = normalizeAliases(emails);
    if (!aliases.length && includeUnmatched !== true) {
      return [];
    }

    const config = await readForwardMailboxConfig(this.#configPath);
    return this.#withClient(config, client =>
      this.#scanRecent(
        client,
        config,
        aliases,
        includeUnmatched === true,
        boundedLimit
      )
    );
  }

  /**
   * Scans every configured mailbox without applying `messageLimit`.
   *
   * A full scan fixes its maximum UID before fetching and walks backwards in
   * bounded batches. The callback runs only after the fetch iterator has been
   * fully consumed, because ImapFlow does not allow a second IMAP command while
   * a fetch iterator is active.
   */
  async scanAllForAliases(
    emails,
    {
      mode = "incremental",
      batchSize = DEFAULT_SCAN_BATCH_SIZE,
      scan = { cursors: {}, job: null },
      onBatch = async () => {}
    } = {}
  ) {
    if (mode !== "full" && mode !== "incremental") {
      throw new ApiError(400, "BAD_REQUEST", "Unsupported mailbox scan mode");
    }
    if (typeof onBatch !== "function") {
      throw new ApiError(400, "BAD_REQUEST", "Mailbox scan callback is required");
    }
    const boundedBatchSize = parseBoundedInteger(
      batchSize,
      DEFAULT_SCAN_BATCH_SIZE,
      1,
      1_000
    );
    const aliases = normalizeAliases(emails);
    if (!aliases.length) {
      return {
        requestedMode: mode,
        effectiveMode: mode,
        processed: 0,
        total: 0,
        mailboxes: {},
        cursors: {}
      };
    }

    const config = await readForwardMailboxConfig(this.#configPath);
    return this.#withClient(config, client =>
      this.#scanAllBatches(
        client,
        config,
        aliases,
        mode,
        boundedBatchSize,
        scan,
        onBatch
      )
    );
  }

  async #withClient(config, worker) {
    const client = this.#clientFactory({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.email,
        pass: config.password
      },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 35_000,
      logger: false
    });
    client.on?.("error", () => {});

    try {
      await client.connect();
      return await worker(client);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw mailboxUnavailable();
    } finally {
      await client.logout?.().catch(() => {});
    }
  }

  async #scan(client, config, email, limit) {
    const matches = [];
    const scan = scanWindow(config.messageLimit);
    for (const mailbox of config.mailboxes) {
      try {
        await client.mailboxOpen(mailbox, { readOnly: true });
      } catch {
        continue;
      }

      const found = await client.search({ text: email }, { uid: true });
      const newestUids = scan.take(found);
      if (!newestUids.length) {
        continue;
      }

      // One fetch per mailbox, not one per UID: a 100-message window used to
      // cost 100 IMAP round trips. IMAP may stream the responses in any order,
      // so nothing here may depend on the position within `newestUids` — the
      // sort below is the only thing that establishes the result order.
      for await (const fetched of client.fetch(
        newestUids,
        {
          source: true,
          internalDate: true
        },
        { uid: true }
      )) {
        if (!fetched?.source) {
          continue;
        }
        const parsed = await parseMailContent(fetched.source, {
          mailbox,
          uid: fetched.uid,
          fallbackDate: fetched.internalDate
        });
        if (messageMatchesAlias(parsed, email)) {
          matches.push(publicMessage(parsed));
        }
      }
    }

    matches.sort(
      (left, right) =>
        receivedTime(right) - receivedTime(left) || right.uid - left.uid
    );
    return matches.slice(0, limit);
  }

  async #scanAliases(client, config, aliases) {
    const latest = {};
    const aliasSet = new Set(aliases);
    const scan = scanWindow(config.messageLimit);
    for (const mailbox of config.mailboxes) {
      try {
        await client.mailboxOpen(mailbox, { readOnly: true });
      } catch {
        continue;
      }

      const found = await client.search({ all: true }, { uid: true });
      const newestUids = scan.take(found);
      if (!newestUids.length) {
        continue;
      }

      for await (const fetched of client.fetch(
        newestUids,
        {
          source: true,
          internalDate: true
        },
        { uid: true }
      )) {
        if (!fetched?.source) {
          continue;
        }
        const parsed = await parseMailContent(fetched.source, {
          mailbox,
          uid: fetched.uid,
          fallbackDate: fetched.internalDate
        });
        const candidate = publicMessage(parsed);
        for (const alias of findMatchingAliases(parsed, aliasSet)) {
          const existing = latest[alias];
          if (
            !existing ||
            receivedTime(candidate) > receivedTime(existing) ||
            (receivedTime(candidate) === receivedTime(existing) &&
              candidate.uid > existing.uid)
          ) {
            latest[alias] = candidate;
          }
        }
      }
    }
    return { messages: latest, ...scan.stats() };
  }

  async #scanRecent(client, config, aliases, includeUnmatched, limit) {
    const recent = [];
    const aliasSet = new Set(aliases);
    const scan = scanWindow(Math.max(config.messageLimit, limit));
    const candidates = [];
    for (const mailbox of config.mailboxes) {
      let opened;
      try {
        opened = await client.mailboxOpen(mailbox, { readOnly: true });
      } catch {
        continue;
      }

      const found = await client.search({ all: true }, { uid: true });
      const newestUids = scan.take(found);
      if (!newestUids.length) {
        continue;
      }

      for await (const fetched of client.fetch(
        newestUids,
        {
          uid: true,
          internalDate: true,
          envelope: true
        },
        { uid: true }
      )) {
        candidates.push({
          mailbox,
          uid: fetched.uid,
          sourceId: mailSourceId(
            mailbox,
            opened?.uidValidity,
            fetched.uid
          ),
          receivedTime: metadataReceivedTime(fetched)
        });
      }
    }

    const selected = includeUnmatched
      ? candidates
          .sort(
            (left, right) =>
              right.receivedTime - left.receivedTime ||
              right.uid - left.uid
          )
          .slice(0, limit)
      : candidates;

    for (const mailbox of config.mailboxes) {
      const mailboxCandidates = selected.filter(
        candidate => candidate.mailbox === mailbox
      );
      const selectedUids = mailboxCandidates.map(candidate => candidate.uid);
      if (!selectedUids.length) {
        continue;
      }
      const sourceIds = new Map(
        mailboxCandidates.map(candidate => [candidate.uid, candidate.sourceId])
      );

      try {
        await client.mailboxOpen(mailbox, { readOnly: true });
      } catch {
        continue;
      }

      for await (const fetched of client.fetch(
        selectedUids,
        {
          source: true,
          internalDate: true
        },
        { uid: true }
      )) {
        if (!fetched?.source) {
          continue;
        }
        const parsed = await parseMailContent(fetched.source, {
          mailbox,
          uid: fetched.uid,
          fallbackDate: fetched.internalDate
        });
        const matchedEmails = findMatchingAliases(parsed, aliasSet);
        if (!matchedEmails.length && !includeUnmatched) {
          continue;
        }
        const recipients = [...collectMessageRecipients(parsed)];
        recent.push({
          ...publicMessage(parsed),
          recipients,
          matchedEmails,
          sourceId: sourceIds.get(fetched.uid) || ""
        });
      }
    }

    recent.sort(
      (left, right) =>
        receivedTime(right) - receivedTime(left) || right.uid - left.uid
    );
    return recent.slice(0, limit);
  }

  async #scanAllBatches(
    client,
    config,
    aliases,
    requestedMode,
    batchSize,
    scan,
    onBatch
  ) {
    const aliasSet = new Set(aliases);
    const mailboxes = {};
    const cursors = {};
    let processed = 0;
    let total = 0;
    let effectiveMode =
      scan?.job?.effectiveMode === "full" ? "full" : requestedMode;

    for (const mailbox of config.mailboxes) {
      const opened = await client.mailboxOpen(mailbox, { readOnly: true });

      const uidValidity = String(opened?.uidValidity ?? 0);
      const saved = scan?.job?.mailboxes?.[mailbox];
      if (saved?.uidValidity === uidValidity && saved.complete === true) {
        const checkpoint = { ...saved };
        mailboxes[mailbox] = checkpoint;
        cursors[mailbox] = {
          mailbox,
          uidValidity,
          lastUid: checkpoint.snapshotMaxUid
        };
        processed += checkpoint.processed;
        total += checkpoint.total;
        continue;
      }

      const cursor = scan?.cursors?.[mailbox];
      const mailboxMode =
        requestedMode === "incremental" &&
        cursor?.uidValidity === uidValidity
          ? "incremental"
          : "full";
      if (mailboxMode === "full") {
        effectiveMode = "full";
      }
      const query = mailboxMode === "incremental"
        ? { uid: `${cursor.lastUid + 1}:*` }
        : { all: true };
      const searched = normalizeUids(
        await client.search(query, { uid: true })
      );
      // Some IMAP servers interpret a range above the current maximum as a
      // reversed sequence-set ending at `*`. Keep the server-side filter for
      // speed, then enforce the cursor boundary locally to avoid refetching the
      // last completed message.
      const found = mailboxMode === "incremental"
        ? searched.filter(uid => uid > cursor.lastUid)
        : searched;
      const resume =
        saved?.uidValidity === uidValidity &&
        saved.complete !== true;
      const snapshotMaxUid = resume
        ? saved.snapshotMaxUid
        : (found.at(-1) ?? (mailboxMode === "incremental" ? cursor.lastUid : 0));
      let nextBeforeUid = resume
        ? saved.nextBeforeUid
        : snapshotMaxUid + 1;
      let mailboxProcessed = resume ? saved.processed : 0;
      const mailboxTotal = resume
        ? saved.total
        : found.filter(uid => uid <= snapshotMaxUid).length;
      let complete = false;

      while (!complete) {
        const candidates = found
          .filter(uid => uid <= snapshotMaxUid && uid < nextBeforeUid)
          .slice(-batchSize)
          .reverse();
        if (!candidates.length) {
          complete = true;
          nextBeforeUid = 0;
          break;
        }

        const messages = [];
        for await (const fetched of client.fetch(
          candidates,
          {
            source: true,
            internalDate: true
          },
          { uid: true }
        )) {
          if (!fetched?.source) {
            continue;
          }
          const parsed = await parseMailContent(fetched.source, {
            mailbox,
            uid: fetched.uid,
            fallbackDate: fetched.internalDate
          });
          const matchedEmails = findMatchingAliases(parsed, aliasSet);
          if (!matchedEmails.length) {
            continue;
          }
          messages.push({
            ...publicMessage(parsed),
            recipients: [...collectMessageRecipients(parsed)],
            matchedEmails,
            sourceId: mailSourceId(mailbox, uidValidity, fetched.uid)
          });
        }

        mailboxProcessed = Math.min(
          mailboxTotal,
          mailboxProcessed + candidates.length
        );
        const boundary = Math.min(...candidates);
        complete = !found.some(
          uid => uid <= snapshotMaxUid && uid < boundary
        );
        nextBeforeUid = complete ? 0 : boundary;
        const checkpoint = {
          uidValidity,
          snapshotMaxUid,
          nextBeforeUid,
          processed: mailboxProcessed,
          total: mailboxTotal,
          complete
        };
        const cursor = complete
          ? { mailbox, uidValidity, lastUid: snapshotMaxUid }
          : null;
        await onBatch({
          mailbox,
          messages,
          checkpoint,
          cursor,
          requestedMode,
          effectiveMode: mailboxMode
        });
      }

      const checkpoint = {
        uidValidity,
        snapshotMaxUid,
        nextBeforeUid,
        processed: mailboxProcessed,
        total: mailboxTotal,
        complete
      };
      mailboxes[mailbox] = checkpoint;
      cursors[mailbox] = {
        mailbox,
        uidValidity,
        lastUid: snapshotMaxUid
      };
      processed += mailboxProcessed;
      total += mailboxTotal;
    }

    return {
      requestedMode,
      effectiveMode,
      processed,
      total,
      mailboxes,
      cursors
    };
  }
}
