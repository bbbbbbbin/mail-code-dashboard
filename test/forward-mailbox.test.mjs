import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  FORWARD_MAILBOX_DEFAULTS,
  ForwardMailboxReader,
  normalizeForwardMailboxConfig,
  readForwardMailboxConfig
} from "../lib/forward-mailbox.mjs";

const verificationFixture = await readFile(
  fileURLToPath(
    new URL("./fixtures/verification-message.eml", import.meta.url)
  ),
  "utf8"
);

const similarAddressFixture = await readFile(
  fileURLToPath(
    new URL("./fixtures/similar-address-message.eml", import.meta.url)
  ),
  "utf8"
);

async function temporaryConfig(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forward-mailbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "mail-forward.config.json");
  const config = {
    host: "imap.example.test",
    port: 993,
    secure: true,
    email: "forwarding@example.test",
    password: "synthetic-app-password",
    mailboxes: ["INBOX", "Junk"],
    messageLimit: 3,
    pollIntervalMs: 1_000,
    ...overrides
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return { config, configPath };
}

function replaceAlias(raw, alias) {
  return raw.replaceAll("alias1@icloud.com", alias);
}

/**
 * Builds a text-only forwarded message.
 *
 * Plain text keeps the bulk fixtures cheap: `parseMailContent` skips JSDOM
 * entirely when a message carries no HTML part, so a few hundred messages parse
 * fast enough for a full-scan test.
 */
function forwardedRaw({ alias, subject, body, date, addressed = true }) {
  return [
    "From: Example Mail <team@example.test>",
    "To: Forwarding Inbox <forwarding@example.test>",
    ...(addressed ? [`Delivered-To: ${alias}`] : []),
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <synthetic-${alias}-${date.getTime()}@example.test>`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    body,
    ""
  ].join("\r\n");
}

const BULK_TOTAL = 220;
const BULK_INBOX_COUNT = 150;

function bulkAliases() {
  return Array.from(
    { length: BULK_TOTAL },
    (_, index) => `alias-${String(index).padStart(3, "0")}@icloud.com`
  );
}

/**
 * Spreads one confirm mail per alias over INBOX and Junk.
 *
 * Every INBOX message is newer than every Junk message, which is the shape that
 * made a merged cap silently drop the whole Junk folder.
 */
function bulkMessages(aliases) {
  const messages = { INBOX: [], Junk: [] };
  aliases.forEach((alias, index) => {
    const inInbox = index < BULK_INBOX_COUNT;
    const base = inInbox
      ? Date.UTC(2026, 6, 25, 12, 0, 0)
      : Date.UTC(2026, 6, 20, 12, 0, 0);
    messages[inInbox ? "INBOX" : "Junk"].push({
      uid: (inInbox ? 1_000 : 2_000) + index,
      raw: forwardedRaw({
        alias,
        subject: "Confirm your email",
        body: [
          "Confirm your email to receive the trial link for Ghana:",
          `https://example.test/claim/SYNTHETIC-${index}`
        ].join("\r\n"),
        date: new Date(base + index * 60_000)
      })
    });
  });
  return messages;
}

class FakeImapClient {
  constructor({
    messages = {},
    failConnect = null,
    onSearch = null,
    // IMAP is free to stream a batch fetch in any order; `orderFetched` lets a
    // test reorder the stream to prove the reader does not rely on it.
    orderFetched = null,
    uidValidities = {}
  } = {}) {
    this.messages = messages;
    this.failConnect = failConnect;
    this.onSearch = onSearch;
    this.orderFetched = orderFetched;
    this.uidValidities = uidValidities;
    this.currentMailbox = null;
    this.calls = [];
    this.searchCount = 0;
  }

  on() {
    return this;
  }

  async connect() {
    this.calls.push(["connect"]);
    if (this.failConnect) {
      throw this.failConnect;
    }
  }

  async mailboxOpen(mailbox, options) {
    this.calls.push(["mailboxOpen", mailbox, options]);
    this.currentMailbox = mailbox;
    const uids = (this.messages[mailbox] || []).map(item => item.uid);
    const configuredUidValidity = Object.hasOwn(this.uidValidities, mailbox)
      ? this.uidValidities[mailbox]
      : 1;
    return {
      path: mailbox,
      uidValidity:
        configuredUidValidity === null
          ? null
          : BigInt(configuredUidValidity),
      uidNext: (uids.length === 0 ? 0 : Math.max(...uids)) + 1,
      exists: uids.length
    };
  }

  async search(query, options) {
    this.calls.push(["search", this.currentMailbox, query, options]);
    this.searchCount += 1;
    if (this.onSearch) {
      return this.onSearch(this);
    }
    const uids = (this.messages[this.currentMailbox] || []).map(item => item.uid);
    if (typeof query?.uid === "string") {
      const [minimumText] = query.uid.split(":");
      const minimum = Number.parseInt(minimumText, 10);
      return uids.filter(uid => uid >= minimum);
    }
    return uids;
  }

  fetch(uids, query, options) {
    this.calls.push(["fetch", this.currentMailbox, uids, query, options]);
    const requested = new Set(uids);
    const selected = (this.messages[this.currentMailbox] || []).filter(item =>
      requested.has(item.uid)
    );
    const messages = this.orderFetched
      ? this.orderFetched(selected, this.currentMailbox)
      : selected;
    return (async function* iterate() {
      for (const message of messages) {
        const rawDateText = String(message.raw || "").match(
          /^Date:\s*(.+)$/im
        )?.[1];
        const rawDate = rawDateText ? new Date(rawDateText.trim()) : undefined;
        const internalDate =
          message.internalDate === undefined
            ? rawDate
            : message.internalDate;
        const envelopeDate =
          Object.hasOwn(message, "envelopeDate")
            ? message.envelopeDate
            : rawDate;
        yield {
          uid: message.uid,
          ...(query?.source === true
            ? { source: Buffer.from(message.raw) }
            : {}),
          ...(query?.internalDate === true ? { internalDate } : {}),
          ...(query?.envelope === true
            ? { envelope: { date: envelopeDate } }
            : {})
        };
      }
    })();
  }

  async logout() {
    this.calls.push(["logout"]);
  }
}

test("missing config throws MAILBOX_NOT_CONFIGURED", async t => {
  const directory = await mkdtemp(join(tmpdir(), "missing-forward-mailbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    readForwardMailboxConfig(join(directory, "missing.json")),
    error => error.code === "MAILBOX_NOT_CONFIGURED" && error.status === 503
  );
});

test("shared forward mailbox defaults are normalized without mutating the input", () => {
  const input = {
    email: " forwarding@example.test ",
    password: "synthetic-password"
  };

  const normalized = normalizeForwardMailboxConfig(input);

  assert.deepEqual(normalized, {
    ...FORWARD_MAILBOX_DEFAULTS,
    mailboxes: ["INBOX"],
    email: "forwarding@example.test",
    password: "synthetic-password"
  });
  assert.deepEqual(input, {
    email: " forwarding@example.test ",
    password: "synthetic-password"
  });
  assert.equal(FORWARD_MAILBOX_DEFAULTS.messageLimit, 100);
});

test("configuration is accepted without exposing credentials in results", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 11,
          raw: verificationFixture,
          internalDate: new Date("2026-07-25T10:00:00.000Z")
        }
      ]
    }
  });
  let clientOptions;
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory(options) {
      clientOptions = options;
      return client;
    }
  });

  const messages = await reader.listForAlias("alias1@icloud.com", {
    limit: 20
  });

  assert.equal(clientOptions.auth.pass, "synthetic-app-password");
  assert.equal(clientOptions.auth.user, "forwarding@example.test");
  assert.equal(JSON.stringify(messages).includes("synthetic-app-password"), false);
  assert.equal(JSON.stringify(messages).includes("mailboxes"), false);
});

test("unavailable IMAP maps to MAILBOX_UNAVAILABLE without credential text", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    failConnect: new Error("authentication failed for synthetic-app-password")
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  await assert.rejects(
    reader.listForAlias("alias1@icloud.com", { limit: 20 }),
    error =>
      error.code === "MAILBOX_UNAVAILABLE" &&
      error.status === 502 &&
      !error.message.includes("synthetic-app-password")
  );
  assert.equal(
    client.calls.some(call => call[0] === "logout"),
    true
  );
});

test("listing scans configured folders and only the newest bounded UIDs", async t => {
  const { configPath } = await temporaryConfig(t, { messageLimit: 2 });
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 1, raw: replaceAlias(verificationFixture, "old@icloud.com") },
        { uid: 2, raw: replaceAlias(verificationFixture, "two@icloud.com") },
        { uid: 3, raw: replaceAlias(verificationFixture, "three@icloud.com") }
      ],
      Junk: [
        { uid: 4, raw: replaceAlias(verificationFixture, "four@icloud.com") }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  await reader.listForAlias("not-present@icloud.com", { limit: 20 });

  assert.deepEqual(
    client.calls
      .filter(call => call[0] === "mailboxOpen")
      .map(call => [call[1], call[2]]),
    [
      ["INBOX", { readOnly: true }],
      ["Junk", { readOnly: true }]
    ]
  );
  assert.deepEqual(
    client.calls
      .filter(call => call[0] === "fetch")
      .map(call => [call[1], call[2]]),
    [
      ["INBOX", [3, 2]],
      ["Junk", [4]]
    ]
  );
});

test("listForAlias fetches one batch per mailbox instead of one per UID", async t => {
  const { configPath } = await temporaryConfig(t, { messageLimit: 50 });
  const client = new FakeImapClient({
    messages: {
      INBOX: Array.from({ length: 12 }, (_, index) => ({
        uid: 100 + index,
        raw: replaceAlias(verificationFixture, `alias-${index}@icloud.com`)
      })),
      Junk: []
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  await reader.listForAlias("alias-3@icloud.com", { limit: 20 });

  const fetches = client.calls.filter(call => call[0] === "fetch");
  assert.equal(
    fetches.length,
    1,
    "12 candidate UIDs must cost one fetch, not twelve round trips"
  );
  assert.deepEqual(fetches[0][1], "INBOX");
  assert.equal(fetches[0][2].length, 12);
});

test("listForAlias reorders an out-of-order batch fetch by received time", async t => {
  const { configPath } = await temporaryConfig(t);
  const hours = ["08:00:00", "12:00:00", "10:00:00"];
  const client = new FakeImapClient({
    messages: {
      INBOX: hours.map((hour, index) => ({
        uid: 70 + index,
        raw: verificationFixture.replace(
          "Fri, 25 Jul 2026 10:00:00 +0000",
          `Fri, 25 Jul 2026 ${hour} +0000`
        )
      }))
    },
    // Stream the batch in an order that matches neither the requested UID order
    // nor the received order.
    orderFetched: messages => [messages[1], messages[2], messages[0]]
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.listForAlias("alias1@icloud.com", {
    limit: 20
  });

  assert.deepEqual(messages.map(item => item.uid), [71, 72, 70]);
  assert.deepEqual(
    messages.map(item => item.receivedAt),
    [
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T10:00:00.000Z",
      "2026-07-25T08:00:00.000Z"
    ]
  );
});

test("listing asks IMAP to prefilter the complete alias before fetching sources", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 10, raw: replaceAlias(verificationFixture, "other@icloud.com") },
        { uid: 11, raw: verificationFixture }
      ]
    },
    onSearch() {
      return [11];
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.listForAlias("alias1@icloud.com", {
    limit: 20
  });

  assert.deepEqual(
    client.calls
      .filter(call => call[0] === "search")
      .map(call => call[2]),
    [
      { text: "alias1@icloud.com" },
      { text: "alias1@icloud.com" }
    ]
  );
  assert.deepEqual(messages.map(item => item.uid), [11]);
});

test("latestForAliases batch-fetches once per mailbox and keeps newest exact matches", async t => {
  const { configPath } = await temporaryConfig(t);
  const first = "first@icloud.com";
  const second = "second@icloud.com";
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 10, raw: replaceAlias(verificationFixture, first) },
        { uid: 11, raw: replaceAlias(verificationFixture, second) }
      ],
      Junk: [
        {
          uid: 20,
          raw: replaceAlias(verificationFixture, first).replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 12:00:00 +0000"
          )
        }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.latestForAliases([
    first,
    second,
    "missing@icloud.com",
    first.toUpperCase()
  ]);

  assert.deepEqual(Object.keys(result.messages).sort(), [first, second]);
  assert.equal(result.messages[first].uid, 20);
  assert.equal(result.messages[first].mailbox, "Junk");
  assert.equal(result.messages[second].uid, 11);
  assert.equal(
    client.calls.filter(call => call[0] === "connect").length,
    1
  );
  assert.equal(
    client.calls.filter(call => call[0] === "logout").length,
    1
  );
  assert.deepEqual(
    client.calls
      .filter(call => call[0] === "search")
      .map(call => [call[1], call[2]]),
    [
      ["INBOX", { all: true }],
      ["Junk", { all: true }]
    ]
  );
  assert.deepEqual(
    client.calls
      .filter(call => call[0] === "fetch")
      .map(call => [call[1], call[2]]),
    [
      ["INBOX", [11, 10]],
      ["Junk", [20]]
    ]
  );
});

test("latestForAliases reports an untruncated scan window", async t => {
  const { configPath } = await temporaryConfig(t, { messageLimit: 3 });
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 10, raw: replaceAlias(verificationFixture, "a@icloud.com") },
        { uid: 11, raw: replaceAlias(verificationFixture, "b@icloud.com") }
      ],
      Junk: [
        { uid: 20, raw: replaceAlias(verificationFixture, "c@icloud.com") }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.latestForAliases(["a@icloud.com"]);

  assert.equal(result.scanned, 3);
  assert.equal(result.available, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(Object.keys(result.messages), ["a@icloud.com"]);
});

test("latestForAliases flags a truncated scan window across mailboxes", async t => {
  const { configPath } = await temporaryConfig(t, { messageLimit: 2 });
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 10, raw: replaceAlias(verificationFixture, "old@icloud.com") },
        { uid: 11, raw: replaceAlias(verificationFixture, "mid@icloud.com") },
        { uid: 12, raw: replaceAlias(verificationFixture, "new@icloud.com") }
      ],
      Junk: [
        { uid: 20, raw: replaceAlias(verificationFixture, "junk@icloud.com") }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.latestForAliases(["old@icloud.com"]);

  // INBOX contributed 2 of 3, Junk 1 of 1: the oldest alias fell out of the
  // window, which is exactly the case the UI must not call "no mail".
  assert.equal(result.scanned, 3);
  assert.equal(result.available, 4);
  assert.equal(result.truncated, true);
  assert.deepEqual(Object.keys(result.messages), []);
});

test("a mailbox shared by hundreds of aliases reports the aliases it could not reach", async t => {
  const { configPath } = await temporaryConfig(t, { messageLimit: 100 });
  const aliases = bulkAliases();
  const client = new FakeImapClient({ messages: bulkMessages(aliases) });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.latestForAliases([
    aliases[0],
    aliases[100],
    aliases[200]
  ]);

  // INBOX holds 150 messages but only the newest 100 fit the window, so the 50
  // oldest aliases are unreachable until the operator narrows the mailbox.
  assert.equal(result.available, BULK_TOTAL);
  assert.equal(result.scanned, 100 + (BULK_TOTAL - BULK_INBOX_COUNT));
  assert.equal(result.truncated, true);
  assert.equal(result.messages[aliases[0]], undefined);
  assert.equal(result.messages[aliases[100]].mailbox, "INBOX");
  assert.equal(result.messages[aliases[200]].mailbox, "Junk");
});

test("latestForAliases avoids per-alias RegExp construction and address probes", async t => {
  const { configPath } = await temporaryConfig(t, {
    mailboxes: ["INBOX"],
    messageLimit: 1
  });
  const aliases = Array.from(
    { length: 2_000 },
    (_, index) => `perf-${index}@icloud.com`
  );
  const target = aliases.at(-1);
  const client = new FakeImapClient({
    messages: {
      INBOX: [{ uid: 1, raw: replaceAlias(verificationFixture, target) }]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });
  const originalHas = Set.prototype.has;
  const OriginalRegExp = globalThis.RegExp;
  let aliasMembershipChecks = 0;
  let regexpConstructions = 0;
  Set.prototype.has = function countedHas(value) {
    if (
      typeof value === "string" &&
      value.toLowerCase().endsWith("@icloud.com")
    ) {
      aliasMembershipChecks += 1;
    }
    return originalHas.call(this, value);
  };
  globalThis.RegExp = new Proxy(OriginalRegExp, {
    construct(target, argumentsList) {
      regexpConstructions += 1;
      return Reflect.construct(target, argumentsList, target);
    }
  });

  let result;
  let baselineRegExpConstructions;
  try {
    const baseline = await reader.latestForAliases([target]);
    assert.equal(baseline.messages[target].uid, 1);
    baselineRegExpConstructions = regexpConstructions;
    regexpConstructions = 0;
    aliasMembershipChecks = 0;
    result = await reader.latestForAliases(aliases);
  } finally {
    Set.prototype.has = originalHas;
    globalThis.RegExp = OriginalRegExp;
  }

  assert.equal(result.messages[target].uid, 1);
  assert.ok(
    regexpConstructions <= baselineRegExpConstructions + 5,
    `expected constant RegExp construction, baseline ${baselineRegExpConstructions}, scan ${regexpConstructions}`
  );
  assert.ok(
    aliasMembershipChecks < 20,
    `expected address-driven matching, observed ${aliasMembershipChecks} alias probes`
  );
});

test("latestForAliases skips IMAP and reports an empty window without aliases", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient();
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  assert.deepEqual(await reader.latestForAliases([]), {
    messages: {},
    scanned: 0,
    available: 0,
    truncated: false
  });
  assert.deepEqual(client.calls, []);
});

test("latestForAliases pairs an out-of-order batch fetch with the right alias", async t => {
  const { configPath } = await temporaryConfig(t);
  const first = "first@icloud.com";
  const second = "second@icloud.com";
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 10,
          raw: replaceAlias(verificationFixture, first).replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 08:00:00 +0000"
          )
        },
        {
          uid: 11,
          raw: replaceAlias(verificationFixture, second).replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 09:00:00 +0000"
          )
        },
        {
          uid: 12,
          raw: replaceAlias(verificationFixture, first).replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 11:00:00 +0000"
          )
        }
      ]
    },
    // Newest first alias arrives before its older sibling, so a reader that
    // trusted the stream order would keep uid 10 for `first`.
    orderFetched: messages => [messages[2], messages[0], messages[1]]
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.latestForAliases([first, second]);

  assert.equal(result.messages[first].uid, 12);
  assert.equal(result.messages[second].uid, 11);
  assert.equal(client.calls.filter(call => call[0] === "fetch").length, 1);
});

test("listForAlias returns only exact matches without internal match fields", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 10,
          raw: replaceAlias(verificationFixture, "alias10@icloud.com")
        },
        { uid: 11, raw: verificationFixture }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.listForAlias("alias1@icloud.com", {
    limit: 20
  });

  assert.deepEqual(messages.map(item => item.uid), [11]);
  assert.equal("_recipientAddresses" in messages[0], false);
  assert.equal("_matchText" in messages[0], false);
});

test("results are newest first and respect limit", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 20,
          raw: verificationFixture.replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 08:00:00 +0000"
          )
        },
        {
          uid: 21,
          raw: verificationFixture.replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 12:00:00 +0000"
          )
        }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.listForAlias("alias1@icloud.com", {
    limit: 1
  });

  assert.deepEqual(messages.map(item => item.uid), [21]);
});

test("polling returns immediately when a message exists", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [{ uid: 30, raw: verificationFixture }]
    }
  });
  let delayCalls = 0;
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client,
    delay: async () => {
      delayCalls += 1;
    }
  });

  const message = await reader.latestForAlias("alias1@icloud.com", {
    waitSeconds: 30
  });

  assert.equal(message.uid, 30);
  assert.equal(delayCalls, 0);
});

test("polling returns null after the bounded wait using one connection", async t => {
  const { configPath } = await temporaryConfig(t, { pollIntervalMs: 1_000 });
  const client = new FakeImapClient();
  let currentTime = 0;
  let factoryCalls = 0;
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => {
      factoryCalls += 1;
      return client;
    },
    now: () => currentTime,
    delay: async milliseconds => {
      currentTime += milliseconds;
    }
  });

  const result = await reader.latestForAlias("alias1@icloud.com", {
    waitSeconds: 2
  });

  assert.equal(result, null);
  assert.equal(factoryCalls, 1);
  assert.equal(currentTime, 2_000);
});

test("recentForAliases merges mailboxes newest first after metadata preselection", async t => {
  const { configPath } = await temporaryConfig(t);
  const first = "first@icloud.com";
  const second = "second@icloud.com";
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 10, raw: replaceAlias(verificationFixture, first) },
        {
          uid: 11,
          raw: replaceAlias(verificationFixture, second).replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 09:00:00 +0000"
          )
        }
      ],
      Junk: [
        {
          uid: 20,
          raw: replaceAlias(verificationFixture, first).replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 12:00:00 +0000"
          )
        }
      ]
    },
    uidValidities: { INBOX: 11, Junk: 22 }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.recentForAliases([first, second], {
    limit: 10
  });

  assert.deepEqual(
    messages.map(item => [item.mailbox, item.uid, item.sourceId]),
    [
      ["Junk", 20, JSON.stringify(["Junk", "22", 20])],
      ["INBOX", 10, JSON.stringify(["INBOX", "11", 10])],
      ["INBOX", 11, JSON.stringify(["INBOX", "11", 11])]
    ]
  );
  assert.deepEqual(messages[0].matchedEmails, [first]);
  assert.deepEqual(messages[0].recipients, [first, "forwarding@example.test"]);
  assert.deepEqual(messages[2].matchedEmails, [second]);
  assert.equal(
    client.calls.filter(call => call[0] === "connect").length,
    1
  );
  assert.deepEqual(
    client.calls
      .filter(call => call[0] === "fetch")
      .map(call => [call[1], call[2], call[3]]),
    [
      [
        "INBOX",
        [11, 10],
        { uid: true, internalDate: true, envelope: true }
      ],
      [
        "Junk",
        [20],
        { uid: true, internalDate: true, envelope: true }
      ],
      ["INBOX", [10, 11], { source: true, internalDate: true }],
      ["Junk", [20], { source: true, internalDate: true }]
    ]
  );
});

test("recentForAliases leaves source identity empty without valid UIDVALIDITY", async t => {
  const alias = "missing-validity@icloud.com";
  const { configPath } = await temporaryConfig(t, { mailboxes: ["INBOX"] });
  const client = new FakeImapClient({
    messages: {
      INBOX: [{ uid: 30, raw: replaceAlias(verificationFixture, alias) }]
    },
    uidValidities: { INBOX: 0 }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.recentForAliases([alias], {
    limit: 1,
    includeUnmatched: true
  });

  assert.equal(messages[0].sourceId, "");
});

test("recentForAliases applies the limit after merging every mailbox", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 40,
          raw: verificationFixture.replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 12:00:00 +0000"
          )
        },
        {
          uid: 41,
          raw: verificationFixture.replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 11:00:00 +0000"
          )
        }
      ],
      Junk: [{ uid: 42, raw: verificationFixture }]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.recentForAliases(["alias1@icloud.com"], {
    limit: 2
  });

  assert.deepEqual(messages.map(item => item.uid), [40, 41]);
});

test("recentForAliases preselects the global newest limit before fetching sources", async t => {
  const limit = 20;
  const alias = "bounded-source@icloud.com";
  const { configPath } = await temporaryConfig(t, { messageLimit: 30 });
  const makeMessages = (mailboxOffset, minuteOffset) =>
    Array.from({ length: 24 }, (_, index) => {
      const date = new Date(
        Date.UTC(2026, 6, 26, 12, minuteOffset + index * 2)
      );
      return {
        uid: mailboxOffset + index,
        ...(mailboxOffset === 100 && index === 0
          ? { internalDate: new Date("2027-01-01T00:00:00.000Z") }
          : {}),
        ...(mailboxOffset === 200 && index === 23
          ? { envelopeDate: null, internalDate: date }
          : {}),
        raw: forwardedRaw({
          alias,
          subject: `Candidate ${mailboxOffset + index}`,
          body: "Confirm your email to continue.",
          date
        })
      };
    });
  const client = new FakeImapClient({
    messages: {
      INBOX: makeMessages(100, 0),
      Junk: makeMessages(200, 1)
    },
    orderFetched: messages => [...messages].reverse()
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.recentForAliases([alias], {
    limit,
    includeUnmatched: true
  });

  const sourceFetches = client.calls.filter(
    call => call[0] === "fetch" && call[3]?.source === true
  );
  const metadataFetches = client.calls.filter(
    call =>
      call[0] === "fetch" &&
      call[3]?.source !== true &&
      call[3]?.envelope === true
  );
  assert.equal(
    sourceFetches.reduce((total, call) => total + call[2].length, 0),
    limit,
    "only the globally selected messages may download full sources"
  );
  assert.equal(
    metadataFetches.reduce((total, call) => total + call[2].length, 0),
    48,
    "metadata may cover the complete per-mailbox candidate window"
  );
  assert.deepEqual(
    messages.map(item => [item.mailbox, item.uid]),
    Array.from({ length: limit }, (_, index) => {
      const rank = 23 - Math.floor(index / 2);
      return index % 2 === 0
        ? ["Junk", 200 + rank]
        : ["INBOX", 100 + rank];
    })
  );
});

test("recentForAliases returns the newest 200 messages from one mailbox", async t => {
  const alias = "bulk-recent@icloud.com";
  const { configPath } = await temporaryConfig(t, {
    mailboxes: ["INBOX"],
    messageLimit: 100
  });
  const client = new FakeImapClient({
    messages: {
      INBOX: Array.from({ length: 201 }, (_, index) => ({
        uid: index + 1,
        raw: forwardedRaw({
          alias,
          subject: `Recent message ${index + 1}`,
          body: "Confirm your email to continue.",
          date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
        })
      }))
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const messages = await reader.recentForAliases([alias], { limit: 200 });

  assert.equal(messages.length, 200);
  assert.equal(messages[0].uid, 201);
  assert.equal(messages.at(-1).uid, 2);
});

test("recentForAliases matches body-only aliases and hides internal fields", async t => {
  const { configPath } = await temporaryConfig(t);
  const bodyAlias = "body-only@icloud.com";
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 50,
          raw: replaceAlias(
            similarAddressFixture.replace(/^X-Original-To:.*\r?\n/m, ""),
            bodyAlias
          )
        },
        {
          uid: 51,
          raw: replaceAlias(verificationFixture, "other@icloud.com")
        }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const matched = await reader.recentForAliases([bodyAlias], { limit: 1 });

  assert.deepEqual(matched.map(item => item.uid), [50]);
  assert.deepEqual(matched[0].matchedEmails, [bodyAlias]);
  assert.deepEqual(matched[0].recipients, ["forwarding@example.test"]);
  assert.equal("_recipientAddresses" in matched[0], false);
  assert.equal("_matchText" in matched[0], false);
  assert.equal(JSON.stringify(matched).includes("_matchText"), false);
});

test("recentForAliases keeps unmatched messages only when asked", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        { uid: 60, raw: verificationFixture },
        {
          uid: 61,
          raw: replaceAlias(verificationFixture, "other@icloud.com").replace(
            "Fri, 25 Jul 2026 10:00:00 +0000",
            "Fri, 25 Jul 2026 08:00:00 +0000"
          )
        }
      ]
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const withUnmatched = await reader.recentForAliases(["alias1@icloud.com"], {
    limit: 10,
    includeUnmatched: true
  });

  assert.deepEqual(withUnmatched.map(item => item.uid), [60, 61]);
  assert.deepEqual(withUnmatched[1].matchedEmails, []);
  assert.equal("_matchText" in withUnmatched[1], false);
});

test("recentForAliases accepts 200 messages and rejects larger limits", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient();
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  assert.deepEqual(
    await reader.recentForAliases(["alias1@icloud.com"], { limit: 200 }),
    []
  );
  await assert.rejects(
    reader.recentForAliases(["alias1@icloud.com"], { limit: 201 }),
    error => error.code === "BAD_REQUEST"
  );
});

test("recentForAliases skips IMAP without aliases", async t => {
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient();
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  assert.deepEqual(await reader.recentForAliases([]), []);
  assert.deepEqual(client.calls, []);
});

test("scanAllForAliases checkpoints the default persistent scan every 20 messages", async t => {
  const alias = "default-batch@icloud.com";
  const total = 45;
  const { configPath } = await temporaryConfig(t, {
    mailboxes: ["INBOX"],
    messageLimit: 3
  });
  const client = new FakeImapClient({
    messages: {
      INBOX: Array.from({ length: total }, (_, index) => ({
        uid: index + 1,
        raw: forwardedRaw({
          alias,
          subject: `Confirm your email ${index + 1}`,
          body: "Confirm your email to continue.",
          date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
        })
      }))
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });
  const batches = [];

  await reader.scanAllForAliases([alias], {
    mode: "full",
    scan: { cursors: {}, job: null },
    onBatch: async batch => batches.push(batch)
  });

  const fetchCalls = client.calls.filter(([name]) => name === "fetch");
  assert.deepEqual(fetchCalls.map(([, , uids]) => uids.length), [20, 20, 5]);
  assert.deepEqual(batches.map(batch => batch.checkpoint.processed), [20, 40, 45]);
});

test("scanAllForAliases reads a full mailbox in resumable UID batches", async t => {
  const alias = "bulk-scan@icloud.com";
  const total = 650;
  const { configPath } = await temporaryConfig(t, {
    mailboxes: ["INBOX"],
    messageLimit: 3
  });
  const client = new FakeImapClient({
    messages: {
      INBOX: Array.from({ length: total }, (_, index) => ({
        uid: index + 1,
        raw: forwardedRaw({
          alias,
          subject: `Confirm your email ${index + 1}`,
          body: "Confirm your email to continue.",
          date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
        })
      }))
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });
  const batches = [];

  const result = await reader.scanAllForAliases([alias], {
    mode: "full",
    batchSize: 300,
    scan: { cursors: {}, job: null },
    onBatch: async batch => batches.push(batch)
  });

  const fetchCalls = client.calls.filter(([name]) => name === "fetch");
  assert.deepEqual(fetchCalls.map(([, , uids]) => uids.length), [300, 300, 50]);
  assert.deepEqual(fetchCalls.map(([, , uids]) => [uids[0], uids.at(-1)]), [
    [650, 351],
    [350, 51],
    [50, 1]
  ]);
  assert.ok(fetchCalls.every(call => call[4]?.uid === true));
  assert.deepEqual(batches.map(batch => batch.messages.length), [300, 300, 50]);
  assert.ok(
    batches
      .flatMap(batch => batch.messages)
      .every(
        message =>
          message.sourceId ===
          JSON.stringify(["INBOX", "1", message.uid])
      )
  );
  assert.ok(
    batches
      .flatMap(batch => batch.messages)
      .every(
        message =>
          !("_recipientAddresses" in message) && !("_matchText" in message)
      )
  );
  assert.deepEqual(batches.map(batch => batch.checkpoint.processed), [300, 600, 650]);
  assert.deepEqual(batches.map(batch => batch.checkpoint.complete), [false, false, true]);
  assert.deepEqual(batches.at(-1).cursor, {
    mailbox: "INBOX",
    uidValidity: "1",
    lastUid: 650
  });
  assert.deepEqual(result, {
    requestedMode: "full",
    effectiveMode: "full",
    processed: 650,
    total: 650,
    mailboxes: {
      INBOX: {
        uidValidity: "1",
        snapshotMaxUid: 650,
        nextBeforeUid: 0,
        processed: 650,
        total: 650,
        complete: true
      }
    },
    cursors: {
      INBOX: {
        mailbox: "INBOX",
        uidValidity: "1",
        lastUid: 650
      }
    }
  });
});

test("scanAllForAliases resumes below the persisted full-scan boundary", async t => {
  const alias = "resume-scan@icloud.com";
  const { configPath } = await temporaryConfig(t, { mailboxes: ["INBOX"] });
  const client = new FakeImapClient({
    messages: {
      INBOX: Array.from({ length: 650 }, (_, index) => ({
        uid: index + 1,
        raw: forwardedRaw({
          alias,
          subject: `Resume ${index + 1}`,
          body: "Confirm your email.",
          date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
        })
      }))
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });
  const batches = [];

  const result = await reader.scanAllForAliases([alias], {
    mode: "full",
    batchSize: 300,
    scan: {
      cursors: {},
      job: {
        mailboxes: {
          INBOX: {
            uidValidity: "1",
            snapshotMaxUid: 650,
            nextBeforeUid: 351,
            processed: 300,
            total: 650,
            complete: false
          }
        }
      }
    },
    onBatch: async batch => batches.push(batch)
  });

  const fetchCalls = client.calls.filter(([name]) => name === "fetch");
  assert.deepEqual(fetchCalls.map(([, , uids]) => uids.length), [300, 50]);
  assert.deepEqual(fetchCalls.map(([, , uids]) => [uids[0], uids.at(-1)]), [
    [350, 51],
    [50, 1]
  ]);
  assert.deepEqual(batches.map(batch => batch.checkpoint.processed), [600, 650]);
  assert.equal(result.processed, 650);
  assert.equal(result.mailboxes.INBOX.complete, true);
});

test("resuming a multi-mailbox job skips mailboxes already completed", async t => {
  const alias = "multi-resume@icloud.com";
  const { configPath } = await temporaryConfig(t);
  const makeMessages = (total, prefix) =>
    Array.from({ length: total }, (_, index) => ({
      uid: index + 1,
      raw: forwardedRaw({
        alias,
        subject: `${prefix} ${index + 1}`,
        body: "Confirm your email.",
        date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
      })
    }));
  const client = new FakeImapClient({
    messages: {
      INBOX: makeMessages(300, "Inbox"),
      Junk: makeMessages(650, "Junk")
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.scanAllForAliases([alias], {
    mode: "full",
    batchSize: 300,
    scan: {
      cursors: {
        INBOX: {
          uidValidity: "1",
          lastUid: 300,
          completedAt: "2026-07-28T00:00:00.000Z"
        }
      },
      job: {
        effectiveMode: "full",
        mailboxes: {
          INBOX: {
            uidValidity: "1",
            snapshotMaxUid: 300,
            nextBeforeUid: 0,
            processed: 300,
            total: 300,
            complete: true
          },
          Junk: {
            uidValidity: "1",
            snapshotMaxUid: 650,
            nextBeforeUid: 351,
            processed: 300,
            total: 650,
            complete: false
          }
        }
      }
    }
  });

  const fetchCalls = client.calls.filter(([name]) => name === "fetch");
  assert.deepEqual(
    fetchCalls.map(([, mailbox, uids]) => [mailbox, uids.length]),
    [
      ["Junk", 300],
      ["Junk", 50]
    ]
  );
  assert.equal(result.processed, 950);
  assert.equal(result.total, 950);
  assert.equal(result.mailboxes.INBOX.complete, true);
  assert.equal(result.mailboxes.Junk.complete, true);
});

test("full scan ignores messages that arrive above its fixed UID snapshot", async t => {
  const alias = "snapshot-scan@icloud.com";
  const initialTotal = 650;
  const { configPath } = await temporaryConfig(t, { mailboxes: ["INBOX"] });
  const messages = Array.from({ length: initialTotal }, (_, index) => ({
    uid: index + 1,
    raw: forwardedRaw({
      alias,
      subject: `Snapshot ${index + 1}`,
      body: "Confirm your email.",
      date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
    })
  }));
  const client = new FakeImapClient({
    messages: { INBOX: messages },
    onSearch(fake) {
      const snapshot = fake.messages.INBOX.map(message => message.uid);
      fake.messages.INBOX.push({
        uid: 651,
        raw: forwardedRaw({
          alias,
          subject: "Arrived during scan",
          body: "Confirm your email.",
          date: new Date(Date.UTC(2026, 6, 30))
        })
      });
      return snapshot;
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.scanAllForAliases([alias], {
    mode: "full",
    batchSize: 300
  });

  const fetchedUids = client.calls
    .filter(([name]) => name === "fetch")
    .flatMap(([, , uids]) => uids);
  assert.equal(fetchedUids.includes(651), false);
  assert.equal(result.total, initialTotal);
  assert.equal(result.cursors.INBOX.lastUid, 650);
});

test("incremental scan searches only UIDs above the completed cursor", async t => {
  const alias = "incremental-scan@icloud.com";
  const { configPath } = await temporaryConfig(t, { mailboxes: ["INBOX"] });
  const client = new FakeImapClient({
    uidValidities: { INBOX: 7 },
    messages: {
      INBOX: Array.from({ length: 105 }, (_, index) => ({
        uid: index + 1,
        raw: forwardedRaw({
          alias,
          subject: `Incremental ${index + 1}`,
          body: "Confirm your email.",
          date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
        })
      }))
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });
  const batches = [];

  const result = await reader.scanAllForAliases([alias], {
    mode: "incremental",
    batchSize: 300,
    scan: {
      cursors: {
        INBOX: {
          uidValidity: "7",
          lastUid: 100,
          completedAt: "2026-07-28T00:00:00.000Z"
        }
      },
      job: null
    },
    onBatch: async batch => batches.push(batch)
  });

  const searchCall = client.calls.find(([name]) => name === "search");
  assert.deepEqual(searchCall.slice(2), [{ uid: "101:*" }, { uid: true }]);
  assert.deepEqual(
    client.calls.find(([name]) => name === "fetch")[2],
    [105, 104, 103, 102, 101]
  );
  assert.equal(result.requestedMode, "incremental");
  assert.equal(result.effectiveMode, "incremental");
  assert.equal(result.processed, 5);
  assert.equal(result.total, 5);
  assert.equal(result.cursors.INBOX.lastUid, 105);
  assert.equal(batches.at(-1).effectiveMode, "incremental");

  client.calls.length = 0;
  // A few servers resolve "106:*" to the current maximum UID (105). The
  // reader must enforce the cursor boundary locally as well.
  client.onSearch = () => [105];
  const unchangedBatches = [];
  const unchanged = await reader.scanAllForAliases([alias], {
    mode: "incremental",
    scan: {
      cursors: result.cursors,
      job: null
    },
    onBatch: async batch => unchangedBatches.push(batch)
  });

  assert.deepEqual(unchangedBatches, []);
  assert.equal(unchanged.processed, 0);
  assert.equal(unchanged.total, 0);
  assert.equal(unchanged.cursors.INBOX.lastUid, 105);
  assert.deepEqual(
    client.calls.find(([name]) => name === "search").slice(2),
    [{ uid: "106:*" }, { uid: true }]
  );
});

test("incremental scan falls back to full when UIDVALIDITY changes", async t => {
  const alias = "uidvalidity-scan@icloud.com";
  const { configPath } = await temporaryConfig(t, { mailboxes: ["INBOX"] });
  const client = new FakeImapClient({
    uidValidities: { INBOX: 8 },
    messages: {
      INBOX: Array.from({ length: 5 }, (_, index) => ({
        uid: index + 1,
        raw: forwardedRaw({
          alias,
          subject: `Replacement mailbox ${index + 1}`,
          body: "Confirm your email.",
          date: new Date(Date.UTC(2026, 6, 1) + index * 60_000)
        })
      }))
    }
  });
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  const result = await reader.scanAllForAliases([alias], {
    mode: "incremental",
    scan: {
      cursors: {
        INBOX: {
          uidValidity: "7",
          lastUid: 100,
          completedAt: "2026-07-28T00:00:00.000Z"
        }
      },
      job: null
    }
  });

  const searchCall = client.calls.find(([name]) => name === "search");
  assert.deepEqual(searchCall.slice(2), [{ all: true }, { uid: true }]);
  assert.equal(result.requestedMode, "incremental");
  assert.equal(result.effectiveMode, "full");
  assert.equal(result.processed, 5);
  assert.equal(result.cursors.INBOX.uidValidity, "8");
  assert.equal(result.cursors.INBOX.lastUid, 5);
});

test("full scan fails visibly when a configured mailbox cannot be opened", async t => {
  const alias = "mailbox-error@icloud.com";
  const { configPath } = await temporaryConfig(t);
  const client = new FakeImapClient({
    messages: {
      INBOX: [
        {
          uid: 1,
          raw: forwardedRaw({
            alias,
            subject: "Confirm your email",
            body: "Confirm your email.",
            date: new Date(Date.UTC(2026, 6, 1))
          })
        }
      ]
    }
  });
  const openMailbox = client.mailboxOpen.bind(client);
  client.mailboxOpen = async (...args) => {
    if (args[0] === "Junk") {
      throw new Error("synthetic mailbox failure");
    }
    return openMailbox(...args);
  };
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => client
  });

  await assert.rejects(
    reader.scanAllForAliases([alias], { mode: "full" }),
    error => error.code === "MAILBOX_UNAVAILABLE"
  );
});

test("waitSeconds and limit bounds are enforced", async t => {
  const { configPath } = await temporaryConfig(t);
  const reader = new ForwardMailboxReader({
    configPath,
    clientFactory: () => new FakeImapClient()
  });

  await assert.rejects(
    reader.latestForAlias("alias1@icloud.com", { waitSeconds: 31 }),
    error => error.code === "BAD_REQUEST"
  );
  await assert.rejects(
    reader.listForAlias("alias1@icloud.com", { limit: 101 }),
    error => error.code === "BAD_REQUEST"
  );
});
