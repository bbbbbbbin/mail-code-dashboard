import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as mailContent from "../lib/mail-content.mjs";
import {
  choosePrimaryLink,
  extractLinks,
  extractVerificationCodes,
  messageMatchesAlias,
  parseMailContent,
  sanitizeMailHtml
} from "../lib/mail-content.mjs";

async function readFixture(name) {
  return readFile(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8"
  );
}

function syntheticMail(headers, body, contentType = "text/plain") {
  return [
    "From: Synthetic Sender <sender@example.test>",
    "To: Forwarding Inbox <forwarding@example.test>",
    "Subject: Synthetic message",
    "Date: Fri, 25 Jul 2026 10:00:00 +0000",
    ...headers,
    `Content-Type: ${contentType}; charset="utf-8"`,
    "",
    body
  ].join("\r\n");
}

test("parseMailContent extracts codes, links, and primaryLink", async () => {
  const raw = await readFixture("verification-message.eml");
  const message = await parseMailContent(raw, { mailbox: "INBOX", uid: 42 });

  assert.deepEqual(message.codes, ["123456"]);
  assert.ok(
    message.links.includes("https://accounts.example.test/verify?token=abc")
  );
  assert.equal(
    message.primaryLink,
    "https://accounts.example.test/verify?token=abc"
  );
  assert.equal(message.id, "INBOX:42");
  assert.equal(message.uid, 42);
  assert.equal(message.mailbox, "INBOX");
});

test("sanitized HTML removes active content and dangerous URLs", async () => {
  const dangerousFixture = syntheticMail(
    ["Delivered-To: alias1@icloud.com"],
    [
      "<script>globalThis.syntheticExecuted = true</script>",
      "<iframe src=\"https://frame.example.test\"></iframe>",
      "<form action=\"https://submit.example.test\"><input></form>",
      "<img src=\"https://pixel.example.test/track\" onerror=\"alert(1)\">",
      "<a href=\"javascript:alert(1)\">unsafe</a>",
      "<a href=\"data:text/html,unsafe\">data</a>",
      "<a href=\"file:///tmp/unsafe\">file</a>",
      "<a href=\"https://safe.example.test/confirm\">Confirm safely</a>"
    ].join(""),
    "text/html"
  );

  const message = await parseMailContent(dangerousFixture, {
    mailbox: "INBOX",
    uid: 43
  });

  assert.doesNotMatch(
    message.html,
    /script|iframe|form|onerror|javascript:|data:|file:|pixel\.example/i
  );
  assert.deepEqual(message.links, [
    "https://safe.example.test/confirm"
  ]);
});

test("parseMailContent constructs one DOM for sanitizing, text, and links", async () => {
  const counterKey = `__mailContentDomCount${Date.now()}`;
  const actualJSDOMUrl = import.meta.resolve("jsdom");
  const virtualJSDOMUrl = `counting-jsdom:${Date.now()}`;
  const mailContentUrl = new URL("../lib/mail-content.mjs", import.meta.url).href;
  const raw = syntheticMail(
    ["Delivered-To: alias1@icloud.com"],
    [
      "<script>unsafe()</script>",
      '<a class="button" href="https://safe.example.test/verify">Verify 445566</a>'
    ].join(""),
    "text/html"
  );
  const wrapperSource = [
    `import { JSDOM as ActualJSDOM } from ${JSON.stringify(actualJSDOMUrl)};`,
    "export class JSDOM extends ActualJSDOM {",
    "  constructor(...args) {",
    `    globalThis[${JSON.stringify(counterKey)}] = (globalThis[${JSON.stringify(counterKey)}] || 0) + 1;`,
    "    super(...args);",
    "  }",
    "}"
  ].join("\n");
  const hookSource = [
    `const virtualJSDOMUrl = ${JSON.stringify(virtualJSDOMUrl)};`,
    `const wrapperSource = ${JSON.stringify(wrapperSource)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    '  if (specifier === "jsdom") return { url: virtualJSDOMUrl, shortCircuit: true };',
    "  return nextResolve(specifier, context);",
    "}",
    "export async function load(url, context, nextLoad) {",
    '  if (url === virtualJSDOMUrl) return { format: "module", source: wrapperSource, shortCircuit: true };',
    "  return nextLoad(url, context);",
    "}"
  ].join("\n");
  const childSource = [
    'import assert from "node:assert/strict";',
    'import { register } from "node:module";',
    `await import(${JSON.stringify(actualJSDOMUrl)});`,
    `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hookSource)}`)}, import.meta.url);`,
    `const countedModule = await import(${JSON.stringify(`${mailContentUrl}?dom-count=${Date.now()}`)});`,
    `const message = await countedModule.parseMailContent(${JSON.stringify(raw)}, { mailbox: "INBOX", uid: 45 });`,
    `assert.equal(globalThis[${JSON.stringify(counterKey)}], 1);`,
    'assert.equal(message.text, "Verify 445566");',
    'assert.deepEqual(message.links, ["https://safe.example.test/verify"]);'
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    { encoding: "utf8" }
  );

  assert.equal(
    result.status,
    0,
    [result.stderr, result.stdout].filter(Boolean).join("\n")
  );
});

test("messageMatchesAlias uses exact normalized addresses", async () => {
  const raw = await readFixture("similar-address-message.eml");
  const parsed = await parseMailContent(raw, { mailbox: "INBOX", uid: 44 });

  assert.equal(messageMatchesAlias(parsed, "ALIAS1@ICLOUD.COM"), true);
  assert.equal(messageMatchesAlias(parsed, "alias@icloud.com"), false);
});

for (const header of [
  "Delivered-To",
  "X-Original-To",
  "Envelope-To",
  "Resent-To",
  "To",
  "Cc"
]) {
  test(`messageMatchesAlias reads ${header}`, async () => {
    const raw = syntheticMail(
      [`${header}: header.alias@icloud.com`],
      "Synthetic body without an address."
    );
    const parsed = await parseMailContent(raw, {
      mailbox: "INBOX",
      uid: 50
    });

    assert.equal(
      messageMatchesAlias(parsed, "header.alias@icloud.com"),
      true
    );
  });
}

test("messageMatchesAlias falls back to a boundary-safe body match", async () => {
  const parsed = await parseMailContent(
    syntheticMail(
      [],
      "Forwarded for body.alias@icloud.com and body.alias2@icloud.com."
    ),
    { mailbox: "INBOX", uid: 60 }
  );

  assert.equal(messageMatchesAlias(parsed, "body.alias@icloud.com"), true);
  assert.equal(messageMatchesAlias(parsed, "alias@icloud.com"), false);
});

test("messageMatchesAlias ignores addresses found only in MIME attachments", async () => {
  const attachmentAlias = "attachment.only@icloud.com";
  const raw = [
    "From: Synthetic Sender <sender@example.test>",
    "To: Forwarding Inbox <forwarding@example.test>",
    "Subject: Message with a hidden attachment address",
    "Date: Fri, 25 Jul 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer-boundary"',
    "",
    "--outer-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Visible body without a forwarded address.",
    "--outer-boundary",
    'Content-Type: text/plain; name="hidden.txt"',
    'Content-Disposition: attachment; filename="hidden.txt"',
    "",
    attachmentAlias,
    "--outer-boundary--",
    ""
  ].join("\r\n");
  const parsed = await parseMailContent(raw, {
    mailbox: "INBOX",
    uid: 64
  });

  assert.equal(parsed.text.includes(attachmentAlias), false);
  assert.equal(
    mailContent.collectMessageAddresses(parsed).has(attachmentAlias),
    false
  );
  assert.equal(messageMatchesAlias(parsed, attachmentAlias), false);
});

test("collectMessageAddresses caches normalized headers and boundary-safe body addresses", async () => {
  assert.equal(typeof mailContent.collectMessageAddresses, "function");
  const parsed = await parseMailContent(
    syntheticMail(
      [
        "Delivered-To: Duplicate.Alias@iCloud.com",
        "X-Original-To: original.alias@icloud.com",
        "Envelope-To: envelope.alias@icloud.com",
        "Resent-To: resent.alias@icloud.com",
        "Cc: duplicate.alias@icloud.com, cc.alias@icloud.com"
      ],
      [
        "Forwarded for Body.Alias@iCloud.com.",
        "Do not match the shorter body.alias@icloud.com inside prefixbody.alias@icloud.com please."
      ].join(" ")
    ),
    { mailbox: "INBOX", uid: 61 }
  );

  const addresses = mailContent.collectMessageAddresses(parsed);
  const secondRead = mailContent.collectMessageAddresses(parsed);
  assert.equal(addresses instanceof Set, true);
  assert.notEqual(secondRead, addresses);
  assert.deepEqual(secondRead, addresses);
  assert.deepEqual([...addresses].sort(), [
    "body.alias@icloud.com",
    "cc.alias@icloud.com",
    "duplicate.alias@icloud.com",
    "envelope.alias@icloud.com",
    "forwarding@example.test",
    "original.alias@icloud.com",
    "prefixbody.alias@icloud.com",
    "resent.alias@icloud.com"
  ]);
  assert.equal(messageMatchesAlias(parsed, "BODY.ALIAS@ICLOUD.COM"), true);
  assert.equal(messageMatchesAlias(parsed, "alias@icloud.com"), false);
  assert.equal(
    Object.keys(parsed).some(key => key.startsWith("_")),
    false
  );
  assert.equal(JSON.stringify(parsed).includes("recipientAddresses"), false);
});

test("collectMessageAddresses rejects an alias prefix followed by local-part characters", async () => {
  const alias = "alias@icloud.com";
  const suffixes = ["_evil", "%evil", "+evil", "`evil", "{evil"];
  const parsed = await parseMailContent(
    syntheticMail(
      [],
      suffixes.map(suffix => `${alias}${suffix}`).join(" ")
    ),
    { mailbox: "INBOX", uid: 62 }
  );

  assert.equal(mailContent.collectMessageAddresses(parsed).has(alias), false);
  assert.equal(messageMatchesAlias(parsed, alias), false);
});

test("public address sets cannot mutate the cached matcher or recipient cache", async () => {
  const headerAlias = "header.alias@icloud.com";
  const bodyAlias = "body.alias@icloud.com";
  const parsed = await parseMailContent(
    syntheticMail(
      [`Delivered-To: ${headerAlias}`],
      `Forwarded for ${bodyAlias}`
    ),
    { mailbox: "INBOX", uid: 63 }
  );

  const exposedAddresses = mailContent.collectMessageAddresses(parsed);
  const exposedRecipients = mailContent.collectMessageRecipients(parsed);
  exposedAddresses.delete(headerAlias);
  exposedAddresses.clear();
  exposedAddresses.add("poison.address@icloud.com");
  exposedRecipients.delete(headerAlias);
  exposedRecipients.clear();
  exposedRecipients.add("poison.recipient@icloud.com");

  assert.equal(messageMatchesAlias(parsed, headerAlias), true);
  assert.equal(messageMatchesAlias(parsed, bodyAlias), true);
  assert.equal(messageMatchesAlias(parsed, "poison.address@icloud.com"), false);
  const freshAddresses = mailContent.collectMessageAddresses(parsed);
  const freshRecipients = mailContent.collectMessageRecipients(parsed);
  assert.notEqual(freshAddresses, exposedAddresses);
  assert.notEqual(freshRecipients, exposedRecipients);
  assert.equal(freshAddresses.has(headerAlias), true);
  assert.equal(freshAddresses.has(bodyAlias), true);
  assert.equal(freshAddresses.has("poison.address@icloud.com"), false);
  assert.equal(freshRecipients.has(headerAlias), true);
  assert.equal(freshRecipients.has(bodyAlias), false);
  assert.equal(freshRecipients.has("poison.recipient@icloud.com"), false);
  assert.equal(
    [...freshRecipients].every(address => freshAddresses.has(address)),
    true
  );
});

test("address collectors reuse the private parse cache without rereading inputs", () => {
  let headerReads = 0;
  let textReads = 0;
  const parsed = {
    headers: {
      get(name) {
        headerReads += 1;
        return name === "to" ? "cache.header@icloud.com" : null;
      }
    },
    get text() {
      textReads += 1;
      return "Forwarded for cache.body@icloud.com";
    }
  };

  const firstAddresses = mailContent.collectMessageAddresses(parsed);
  const readsAfterFirstCollection = { headerReads, textReads };
  const secondAddresses = mailContent.collectMessageAddresses(parsed);
  const recipients = mailContent.collectMessageRecipients(parsed);

  assert.deepEqual(readsAfterFirstCollection, {
    headerReads: 6,
    textReads: 1
  });
  assert.deepEqual({ headerReads, textReads }, readsAfterFirstCollection);
  assert.notEqual(firstAddresses, secondAddresses);
  assert.deepEqual(secondAddresses, firstAddresses);
  assert.deepEqual([...recipients], ["cache.header@icloud.com"]);
});

test("extractLinks deduplicates HTML and plain-text HTTP links", () => {
  const candidates = extractLinks({
    html: [
      "<a href=\"https://safe.example.test/confirm\">Confirm</a>",
      "<a href=\"https://safe.example.test/confirm\">Confirm again</a>"
    ].join(""),
    text: [
      "https://safe.example.test/confirm",
      "http://plain.example.test/path."
    ].join(" ")
  });

  assert.deepEqual(
    candidates.map(candidate => candidate.url),
    [
      "https://safe.example.test/confirm",
      "http://plain.example.test/path"
    ]
  );
});

test("choosePrimaryLink penalizes privacy and unsubscribe links", () => {
  const candidates = extractLinks({
    html: [
      "<a href=\"https://example.test/privacy\">Privacy terms</a>",
      "<a class=\"button\" href=\"https://example.test/activate\">Activate account</a>",
      "<a href=\"https://example.test/unsubscribe\">Unsubscribe</a>"
    ].join(""),
    text: ""
  });

  assert.equal(
    choosePrimaryLink(candidates),
    "https://example.test/activate"
  );
});

test("choosePrimaryLink prefers a direct trial link over a tracking wrapper", () => {
  const direct = "https://chatgpt.com/p/G6ZSWRBD4ZGWVHAZ";
  const candidates = [
    {
      url:
        "https://links.example.test/CL0/https:%2F%2Fchatgpt.com%2Fp%2FG6ZSWRBD4ZGWVHAZ",
      text: "Start your trial →",
      source: "html",
      isButton: false
    },
    {
      url: direct,
      text: "",
      source: "text",
      isButton: false
    }
  ];

  assert.equal(choosePrimaryLink(candidates), direct);
});

test("extractVerificationCodes returns unique codes in encounter order", () => {
  assert.deepEqual(
    extractVerificationCodes(
      "Verification code 123456. Backup code 987654. Repeat 123456."
    ),
    ["123456", "987654"]
  );
});

test("extractVerificationCodes ranks a real code ahead of years and order numbers", () => {
  const codes = extractVerificationCodes(
    "Acme Inc. 2026. Order 87654321. Your verification code is 445566."
  );

  assert.equal(Array.isArray(codes), true);
  assert.equal(codes[0], "445566");
  assert.equal(codes.includes("2026"), false);
});

test("parseMailContent supports a missing HTML part", async () => {
  const message = await parseMailContent(
    syntheticMail(
      ["Envelope-To: plain.alias@icloud.com"],
      "Code 445566. Open https://plain.example.test/verify."
    ),
    {
      mailbox: "Archive",
      uid: 70,
      fallbackDate: new Date("2026-07-25T12:00:00.000Z")
    }
  );

  assert.equal(message.html, "");
  assert.equal(message.text.includes("Code 445566"), true);
  assert.deepEqual(message.codes, ["445566"]);
  assert.deepEqual(message.links, ["https://plain.example.test/verify"]);
});

test("sanitizeMailHtml removes remote resource elements and metadata", () => {
  const sanitized = sanitizeMailHtml(
    [
      "<meta http-equiv=\"refresh\" content=\"0;url=https://unsafe.example\">",
      "<link rel=\"stylesheet\" href=\"https://unsafe.example/style.css\">",
      "<style>@import url(https://unsafe.example/style.css)</style>",
      "<object data=\"https://unsafe.example/object\"></object>",
      "<embed src=\"https://unsafe.example/embed\">",
      "<p style=\"background:url(https://unsafe.example/image)\">Safe text</p>"
    ].join("")
  );

  assert.doesNotMatch(
    sanitized,
    /meta|link|style=|<style|object|embed|unsafe\.example/i
  );
  assert.match(sanitized, /Safe text/);
});
