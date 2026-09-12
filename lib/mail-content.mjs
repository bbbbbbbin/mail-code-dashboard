import { JSDOM } from "jsdom";
import { simpleParser } from "mailparser";

export { extractVerificationCodes } from "./verification-code.mjs";
import { extractVerificationCodes } from "./verification-code.mjs";

const EMAIL_PATTERN =
  /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.!#$%&'*+/=?^_`{|}~-])/gi;
const HEADER_NAMES = [
  "delivered-to",
  "x-original-to",
  "envelope-to",
  "resent-to",
  "to",
  "cc"
];
const messageAddressCache = new WeakMap();
const messageRecipientCache = new WeakMap();
const BLOCKED_ELEMENTS = [
  "script",
  "iframe",
  "form",
  "object",
  "embed",
  "meta",
  "link",
  "style",
  "base",
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track"
].join(",");
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "data",
  "xlink:href"
]);

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function createHtmlDocument(html) {
  return new JSDOM(`<body>${String(html)}</body>`).window.document;
}

function sanitizeMailDocument(document) {
  document.querySelectorAll(BLOCKED_ELEMENTS).forEach(element => element.remove());

  for (const element of document.body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "style") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) {
        continue;
      }
      if (
        element.tagName === "A" &&
        name === "href" &&
        safeHttpUrl(attribute.value)
      ) {
        element.setAttribute("href", safeHttpUrl(attribute.value));
      } else {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

export function sanitizeMailHtml(html) {
  if (!html) {
    return "";
  }

  const document = createHtmlDocument(html);
  sanitizeMailDocument(document);
  return document.body.innerHTML;
}

function trimUrlPunctuation(value) {
  return value.replace(/[.,;:!?)}\]]+$/g, "");
}

function addCandidate(candidates, seen, candidate) {
  const url = safeHttpUrl(trimUrlPunctuation(candidate.url));
  if (!url || seen.has(url)) {
    return;
  }
  seen.add(url);
  candidates.push({
    url,
    text: String(candidate.text || "").trim(),
    source: candidate.source,
    isButton: candidate.isButton === true
  });
}

function collectDocumentLinks(document, candidates, seen) {
  for (const anchor of document.body.querySelectorAll("a[href]")) {
    const classAndRole = [
      anchor.getAttribute("class"),
      anchor.getAttribute("role")
    ]
      .filter(Boolean)
      .join(" ");
    addCandidate(candidates, seen, {
      url: anchor.getAttribute("href"),
      text: anchor.textContent,
      source: "html",
      isButton: /\b(button|btn|cta)\b/i.test(classAndRole)
    });
  }
}

function collectTextLinks(text, candidates, seen) {
  for (const match of String(text).matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    addCandidate(candidates, seen, {
      url: match[0],
      text: "",
      source: "text",
      isButton: false
    });
  }
}

export function extractLinks({ html = "", text = "" } = {}) {
  const candidates = [];
  const seen = new Set();

  if (html) {
    collectDocumentLinks(createHtmlDocument(html), candidates, seen);
  }
  collectTextLinks(text, candidates, seen);

  return candidates;
}

function linkScore(candidate) {
  const context = `${candidate.text || ""} ${candidate.url || ""}`;
  let score = candidate.isButton ? 5 : candidate.source === "text" ? 1 : 0;
  if (
    /(verify|verification|confirm|activate|activation|login|sign[\s-]?in|reset|验证|确认|激活|登录|重置)/i.test(
      context
    )
  ) {
    score += 12;
  }
  if (/(start|trial|claim|get started|开始|试用|领取)/i.test(context)) {
    score += 6;
  }
  if (
    /(unsubscribe|privacy|terms|preferences|退订|隐私|条款)/i.test(context)
  ) {
    score -= 15;
  }
  if (/(pixel|track(?:ing)?|beacon|1x1)/i.test(context)) {
    score -= 12;
  }
  if (/\/(?:CL0\/https(?::|%3A)|ls\/click(?:[/?]|$))/i.test(candidate.url)) {
    score -= 12;
  }
  if (!String(candidate.text || "").trim() && candidate.source === "html") {
    score -= 2;
  }
  return score;
}

export function choosePrimaryLink(candidates) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates || []) {
    const normalized =
      typeof candidate === "string"
        ? { url: candidate, text: "", source: "text", isButton: false }
        : candidate;
    if (!safeHttpUrl(normalized?.url)) {
      continue;
    }
    const score = linkScore(normalized);
    if (score > bestScore) {
      best = safeHttpUrl(normalized.url);
      bestScore = score;
    }
  }
  return best;
}

function collectAddresses(value, addresses) {
  if (!value) {
    return;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(EMAIL_PATTERN)) {
      addresses.add(match[0].toLowerCase());
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectAddresses(item, addresses));
    return;
  }
  if (typeof value === "object") {
    if (typeof value.address === "string") {
      collectAddresses(value.address, addresses);
    }
    if (value.value) {
      collectAddresses(value.value, addresses);
    }
    if (typeof value.text === "string") {
      collectAddresses(value.text, addresses);
    }
  }
}

function cachedMessageRecipients(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return new Set();
  }
  const cached = messageRecipientCache.get(parsed);
  if (cached) {
    return cached;
  }

  const addresses = new Set();
  for (const name of HEADER_NAMES) {
    collectAddresses(parsed.headers?.get?.(name), addresses);
  }
  messageRecipientCache.set(parsed, addresses);
  return addresses;
}

export function collectMessageAddresses(parsed) {
  return new Set(cachedMessageAddresses(parsed));
}

function cachedMessageAddresses(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return new Set();
  }
  const cached = messageAddressCache.get(parsed);
  if (cached) {
    return cached;
  }

  const addresses = new Set(cachedMessageRecipients(parsed));
  collectAddresses(parsed.text, addresses);
  messageAddressCache.set(parsed, addresses);
  return addresses;
}

export function collectMessageRecipients(parsed) {
  return new Set(cachedMessageRecipients(parsed));
}

export function findMatchingAliases(message, aliasSet) {
  const matches = [];
  for (const address of cachedMessageAddresses(message)) {
    if (aliasSet.has(address)) {
      matches.push(address);
    }
  }
  return matches;
}

function hasExplicitPlainPart(raw) {
  const value = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return /^Content-Type:\s*text\/plain\b/im.test(value);
}

function firstAddress(value) {
  const addresses = new Set();
  collectAddresses(value, addresses);
  return [...addresses][0] || "";
}

function receivedAt(parsedDate, fallbackDate) {
  const value = parsedDate || fallbackDate;
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export async function parseMailContent(
  raw,
  { mailbox, uid, fallbackDate } = {}
) {
  const parsed = await simpleParser(raw);
  const html = typeof parsed.html === "string" ? parsed.html : "";
  let sanitizedHtml = "";
  let sanitizedText = "";
  const candidates = [];
  const seenLinks = new Set();
  if (html) {
    const document = createHtmlDocument(html);
    sanitizeMailDocument(document);
    sanitizedHtml = document.body.innerHTML;
    sanitizedText = (document.body.textContent || "").trim();
    collectDocumentLinks(document, candidates, seenLinks);
  }
  const text = String(
    hasExplicitPlainPart(raw) ? parsed.text || sanitizedText : sanitizedText
  ).trim();
  collectTextLinks(text, candidates, seenLinks);
  const codeText = [parsed.subject, text, sanitizedText]
    .filter(Boolean)
    .join("\n");
  const recipientAddresses = cachedMessageRecipients(parsed);
  const messageAddresses = new Set(recipientAddresses);
  collectAddresses(text, messageAddresses);
  collectAddresses(sanitizedText, messageAddresses);
  const message = {
    id: `${mailbox}:${uid}`,
    mailbox,
    uid,
    from: firstAddress(parsed.from),
    subject: String(parsed.subject || ""),
    receivedAt: receivedAt(parsed.date, fallbackDate),
    text,
    html: sanitizedHtml,
    codes: extractVerificationCodes(codeText),
    links: candidates.map(candidate => candidate.url),
    primaryLink: choosePrimaryLink(candidates)
  };
  messageRecipientCache.set(message, recipientAddresses);
  messageAddressCache.set(message, messageAddresses);
  return message;
}

export function messageMatchesAlias(message, email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return cachedMessageAddresses(message).has(normalized);
}
