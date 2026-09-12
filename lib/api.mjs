import { timingSafeEqual } from "node:crypto";

const SERVICE = "mail-code-dashboard";
const VERSION = "1";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function meta(requestId) {
  return {
    service: SERVICE,
    version: VERSION,
    requestId
  };
}

export function okEnvelope(data, requestId) {
  return {
    ok: true,
    data,
    error: null,
    meta: meta(requestId)
  };
}

export function errorEnvelope(error, requestId) {
  const safeError =
    error instanceof ApiError
      ? error
      : new ApiError(500, "STORAGE_ERROR", "Internal server error");

  return {
    ok: false,
    data: null,
    error: {
      code: safeError.code,
      message: safeError.message
    },
    meta: meta(requestId)
  };
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export function requireApiKey(headers, expected) {
  const supplied = String(headerValue(headers, "x-api-key") || "");
  const expectedValue = String(expected || "");
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedValue);

  if (
    suppliedBuffer.length === 0 ||
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new ApiError(401, "UNAUTHORIZED", "Unauthorized");
  }
}

export function parseBoundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, "BAD_REQUEST", "Integer parameter is out of range");
  }
  return parsed;
}
