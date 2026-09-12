const MAX_DETAIL_LENGTH = 400;

function truncate(value) {
  const text = String(value || "").trim();
  if (text.length <= MAX_DETAIL_LENGTH) return text;
  return `${text.slice(0, MAX_DETAIL_LENGTH)}…`;
}

function redactCookieAssignments(value) {
  return String(value || "").replace(
    /\b(X-APPLE-[A-Z0-9-]+)\s*=\s*([^;,\s"'}]+)/gi,
    "$1=[已隐藏]"
  );
}

function safeDetail(value, sensitiveOutput) {
  return truncate(sensitiveOutput ? redactCookieAssignments(value) : value);
}

function meaningfulLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Pick the line of a stream that actually names the failure.
 *
 * A Python helper that dies before it can print its own JSON leaves a
 * traceback, whose *first* line is the useless "Traceback (most recent call
 * last):" banner while the real cause (`ModuleNotFoundError: ...`) is last.
 */
function firstMeaningfulLine(value) {
  const lines = meaningfulLines(value);
  if (!lines.length) return "";
  if (/^Traceback \(most recent call last\)/i.test(lines[0])) {
    return truncate(lines[lines.length - 1]);
  }
  return truncate(lines[0]);
}

/**
 * Parse a helper script's JSON payload.
 *
 * PowerShell happily prepends progress banners and warning records before the
 * `ConvertTo-Json` output, so fall back to the outermost `{...}` span.
 */
export function parseJsonPayload(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * Turn an `execFile` rejection into the reason the script actually reported.
 *
 * The cookie helpers print `{"ok":false,"error":...}` on stdout and then exit
 * non-zero, which makes `execFile` reject with a bare `Command failed: ...`
 * message. Without digging into `error.stdout` the real cause never reaches the
 * log.
 */
export function describeScriptFailure(error, { sensitiveOutput = false } = {}) {
  const payload = parseJsonPayload(error?.stdout);
  if (payload && typeof payload.error === "string" && payload.error.trim()) {
    return safeDetail(payload.error, sensitiveOutput);
  }

  if (sensitiveOutput) {
    return "脚本输出已隐藏，因为其中可能包含敏感信息";
  }

  const stderrLine = firstMeaningfulLine(error?.stderr);
  if (stderrLine) return stderrLine;

  const stdoutLine = firstMeaningfulLine(error?.stdout);
  if (stdoutLine) return stdoutLine;

  if (error?.killed || error?.signal) {
    return truncate(`脚本超时或被终止（signal=${error.signal || "unknown"}）：${error?.message || ""}`);
  }
  return truncate(error?.message || "脚本执行失败");
}

/**
 * Run a helper script that speaks JSON on stdout.
 *
 * Resolves with the parsed payload when the script reports `ok: true`, and
 * throws an Error whose message is the script's own reason otherwise — for both
 * the zero-exit `{"ok":false}` case and the non-zero-exit case.
 */
export async function runJsonScript({
  execFileAsync,
  file,
  args = [],
  options = {},
  label = "脚本",
  sensitiveOutput = false
}) {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(file, args, options));
  } catch (error) {
    const failure = new Error(
      `${label}失败：${describeScriptFailure(error, { sensitiveOutput })}`
    );
    if (!sensitiveOutput) failure.cause = error;
    throw failure;
  }

  const payload = parseJsonPayload(stdout);
  if (!payload) {
    const detail = sensitiveOutput
      ? "输出已隐藏"
      : firstMeaningfulLine(stdout) || "输出为空";
    throw new Error(`${label}失败：脚本没有返回 JSON（${detail}）`);
  }
  if (!payload.ok) {
    throw new Error(
      `${label}失败：${safeDetail(payload.error || "脚本未说明原因", sensitiveOutput)}`
    );
  }
  return payload;
}
