import { randomUUID as systemRandomUUID } from "node:crypto";

import {
  ApiError,
  errorEnvelope,
  okEnvelope,
  parseBoundedInteger,
  requireApiKey
} from "./api.mjs";

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1_000_000) {
      throw new ApiError(400, "BAD_REQUEST", "Request body is too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Malformed JSON body");
  }
}

function inventorySummary(inventory) {
  const summary = {
    total: inventory.length,
    unused: 0,
    finished: 0,
    trash: 0
  };
  for (const item of inventory) {
    if (Object.hasOwn(summary, item.group)) {
      summary[item.group] += 1;
    }
  }
  return summary;
}

function claimPath(pathname) {
  const match = pathname.match(/^\/v1\/claims\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    return null;
  }
  try {
    return {
      claimId: decodeURIComponent(match[1]),
      suffix: match[2] || ""
    };
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid claim identifier");
  }
}

function inventoryItemPath(pathname) {
  const match = pathname.match(/^\/v1\/inventory\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid inventory identifier");
  }
}

function inventoryMessagePath(pathname) {
  const match = pathname.match(
    /^\/v1\/inventory\/([^/]+)\/messages\/latest$/
  );
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid inventory identifier");
  }
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

export function createV1Router({
  apiKey,
  claimService,
  store,
  mailboxReader,
  listAliases,
  inventoryMailService,
  autoStockService,
  randomUUID = systemRandomUUID
}) {
  return async function routeV1(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/v1/")) {
      return false;
    }

    const requestId = randomUUID();
    try {
      requireApiKey(req.headers, apiKey);
      let data;
      const inventoryId = inventoryItemPath(url.pathname);
      const inventoryMessageId = inventoryMessagePath(url.pathname);

      if (autoStockService && req.method === "GET" && url.pathname === "/v1/auto-stock") {
        data = await autoStockService.status();
      } else if (autoStockService && req.method === "PATCH" && url.pathname === "/v1/auto-stock") {
        data = await autoStockService.configure(await readJson(req));
      } else if (autoStockService && req.method === "POST" && url.pathname === "/v1/auto-stock/initialize") {
        data = await autoStockService.configure(await readJson(req), { initializeOnly: true });
      } else if (
        req.method === "POST" &&
        url.pathname === "/v1/inventory/check-unused-mail"
      ) {
        data = await inventoryMailService.checkUnused();
      } else if (req.method === "GET" && url.pathname === "/v1/inventory") {
        const state = await store.read();
        data = {
          initialized: state.migration !== null,
          migration: state.migration,
          summary: inventorySummary(state.inventory),
          inventory: state.inventory,
          claims: state.claims
        };
      } else if (req.method === "POST" && url.pathname === "/v1/inventory") {
        // Newly generated addresses have to reach the authoritative store, or a
        // browser restart forgets them and the dashboard asks Apple for more.
        const body = await readJson(req);
        const result = await store.createInventoryItems(body.addresses);
        const state = await store.read();
        data = {
          summary: inventorySummary(state.inventory),
          created: result.created,
          existing: result.existing,
          inventory: state.inventory,
          claims: state.claims
        };
      } else if (req.method === "DELETE" && inventoryId) {
        // The trash used to be a dead end: the legacy deactivate route always
        // answered 501, so a trashed address stayed in the state file forever.
        const result = await store.deleteInventoryItem(inventoryId);
        const state = await store.read();
        data = {
          deleted: result.deleted,
          summary: inventorySummary(state.inventory),
          inventory: state.inventory,
          claims: state.claims
        };
      } else if (
        req.method === "PATCH" &&
        inventoryId
      ) {
        const body = await readJson(req);
        data = {
          inventoryItem: await store.updateInventoryItem(inventoryId, body)
        };
      } else if (
        req.method === "POST" &&
        inventoryMessageId
      ) {
        data = await inventoryMailService.checkOne(inventoryMessageId);
      } else if (
        req.method === "POST" &&
        url.pathname === "/v1/inventory/check-finished-mail"
      ) {
        data = await inventoryMailService.checkFinished();
      } else if (
        req.method === "POST" &&
        url.pathname === "/v1/inventory/sync-icloud"
      ) {
        const aliases = await listAliases();
        await store.syncAliases(aliases);
        await autoStockService?.reconciled();
        const state = await store.read();
        data = {
          summary: inventorySummary(state.inventory),
          inventory: state.inventory,
          claims: state.claims
        };
      } else if (
        req.method === "POST" &&
        url.pathname === "/v1/migrations/local-storage"
      ) {
        const body = await readJson(req);
        if (!Array.isArray(body.records)) {
          throw new ApiError(
            400,
            "BAD_REQUEST",
            "Migration records must be an array"
          );
        }
        data = await store.initializeFromLegacy(body.records);
      } else if (
        req.method === "POST" &&
        url.pathname === "/v1/claims"
      ) {
        data = await claimService.claimNext({
          idempotencyKey: headerValue(req.headers, "idempotency-key")
        });
      } else {
        const parsedPath = claimPath(url.pathname);
        if (!parsedPath) {
          throw new ApiError(404, "BAD_REQUEST", "Route not found");
        }

        const { claimId, suffix } = parsedPath;
        if (req.method === "GET" && suffix === "") {
          data = await claimService.getClaim(claimId);
        } else if (req.method === "POST" && suffix === "release") {
          const body = await readJson(req);
          data = await claimService.releaseClaim(claimId, body.reason);
        } else if (req.method === "GET" && suffix === "messages") {
          const limit = parseBoundedInteger(
            url.searchParams.get("limit") ?? undefined,
            20,
            1,
            100
          );
          const claim = await claimService.getActiveClaim(claimId);
          data = {
            messages: await mailboxReader.listForAlias(claim.email, { limit })
          };
        } else if (
          req.method === "GET" &&
          suffix === "messages/latest"
        ) {
          const waitSeconds = parseBoundedInteger(
            url.searchParams.get("waitSeconds") ?? undefined,
            0,
            0,
            30
          );
          const claim = await claimService.getActiveClaim(claimId);
          data = {
            message: await mailboxReader.latestForAlias(claim.email, {
              waitSeconds
            })
          };
        } else {
          throw new ApiError(404, "BAD_REQUEST", "Route not found");
        }
      }

      sendJson(res, 200, okEnvelope(data, requestId));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      sendJson(res, status, errorEnvelope(error, requestId));
    }
    return true;
  };
}
