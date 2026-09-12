// iCloud 的 web session cookie 大约两小时就换一轮，超过这个窗口就该重新同步。
export const COOKIE_STALE_AFTER_MS = 2 * 60 * 60_000;

const SESSION_TOKEN = "X-APPLE-DS-WEB-SESSION-TOKEN";
const WEBAUTH_TOKEN = "X-APPLE-WEBAUTH-TOKEN";
const MAIL_PCS_TOKEN = "X-APPLE-WEBAUTH-PCS-Mail";

/**
 * Describe what `runtime/cookies.txt` currently holds and how old it is.
 *
 * The three refresh paths can all fail silently into the error log, so the age
 * has to travel with the status: a file that still contains both tokens but was
 * last written days ago is the failure mode operators actually hit.
 */
export function summarizeCookieState({
  cookies = "",
  mtimeMs = 0,
  now = Date.now(),
  staleAfterMs = COOKIE_STALE_AFTER_MS
} = {}) {
  const values = collectUsableCookieValues(cookies);
  const hasSessionToken = values.has(SESSION_TOKEN.toLowerCase());
  const hasWebauthToken = values.has(WEBAUTH_TOKEN.toLowerCase());
  const hasMailPcs = values.has(MAIL_PCS_TOKEN.toLowerCase());
  const timingValid = Number.isFinite(now)
    && Number.isFinite(mtimeMs)
    && Number.isFinite(staleAfterMs);
  const futureMtime = timingValid && mtimeMs > now;
  const ageMs = timingValid && !futureMtime
    ? Math.max(0, now - mtimeMs)
    : 0;
  const complete = hasSessionToken && hasWebauthToken;
  return {
    hasSessionToken,
    hasWebauthToken,
    hasMailPcs,
    complete,
    ageMinutes: Math.floor(ageMs / 60_000),
    stale: !complete || !timingValid || futureMtime || ageMs >= staleAfterMs
  };
}

function collectUsableCookieValues(cookies) {
  const values = new Map();
  for (const segment of String(cookies || "").split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const rawName = segment.slice(0, separator);
    const rawValue = segment.slice(separator + 1);
    const name = rawName.trim().toLowerCase();
    const value = rawValue.trim();
    if (
      !name ||
      !value ||
      /[\u0000-\u001f\u007f]/u.test(rawName) ||
      /[\u0000-\u001f\u007f]/u.test(rawValue)
    ) {
      continue;
    }
    values.set(name, value);
  }
  return values;
}

export function describeCookieAge(ageMinutes) {
  const numericAge = Number(ageMinutes);
  const minutes = Number.isFinite(numericAge)
    ? Math.max(0, Math.floor(numericAge))
    : 0;
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
