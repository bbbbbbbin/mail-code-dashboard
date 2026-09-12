import { randomUUID as systemRandomUUID } from "node:crypto";

import { ApiError } from "./api.mjs";

const labelCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

function clone(value) {
  return structuredClone(value);
}

function isoNow(now) {
  return now().toISOString();
}

function requireIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 200) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "Idempotency-Key must contain between 1 and 200 characters"
    );
  }
  return key;
}

function findClaim(state, claimId) {
  const claim = state.claims.find(item => item.claimId === claimId);
  if (!claim) {
    throw new ApiError(404, "CLAIM_NOT_FOUND", "Claim not found");
  }
  return claim;
}

export class ClaimService {
  #now;
  #randomUUID;
  #store;

  constructor({
    store,
    now = () => new Date(),
    randomUUID = systemRandomUUID
  }) {
    this.#store = store;
    this.#now = now;
    this.#randomUUID = randomUUID;
  }

  async claimNext({ idempotencyKey } = {}) {
    const key = requireIdempotencyKey(idempotencyKey);

    return this.#store.mutate(state => {
      // `state.idempotency` is a plain JSON object, so a key such as
      // "constructor" or "toString" would otherwise resolve to a prototype
      // member, look like a previous claim, and permanently fail the lookup
      // below with a misleading STORAGE_ERROR.
      const existingClaimId = Object.hasOwn(state.idempotency, key)
        ? state.idempotency[key]
        : undefined;
      if (existingClaimId) {
        const existing = state.claims.find(
          item => item.claimId === existingClaimId
        );
        if (!existing) {
          throw new ApiError(
            500,
            "STORAGE_ERROR",
            "Claim idempotency state is inconsistent"
          );
        }
        return existing;
      }

      const available = state.inventory
        .filter(
          item =>
            item.group === "unused" &&
            item.isActive !== false &&
            !item.activeClaimId
        )
        .sort((left, right) =>
          labelCollator.compare(left.label || "", right.label || "")
        );
      const item = available[0];
      if (!item) {
        throw new ApiError(
          409,
          "INVENTORY_EMPTY",
          "No unused address is available"
        );
      }

      const claimedAt = isoNow(this.#now);
      const claim = {
        claimId: this.#randomUUID(),
        emailId: item.id,
        email: item.email,
        status: "active",
        idempotencyKey: key,
        claimedAt,
        releasedAt: null,
        releaseReason: ""
      };
      item.group = "finished";
      item.activeClaimId = claim.claimId;
      item.updatedAt = claimedAt;
      state.claims.push(claim);
      state.idempotency[key] = claim.claimId;
      return claim;
    });
  }

  async getClaim(claimId) {
    const state = await this.#store.read();
    return clone(findClaim(state, claimId));
  }

  async getActiveClaim(claimId) {
    const claim = await this.getClaim(claimId);
    if (claim.status === "released") {
      throw new ApiError(409, "CLAIM_RELEASED", "Claim has been released");
    }
    return claim;
  }

  async releaseClaim(claimId, reason = "") {
    return this.#store.mutate(state => {
      const claim = findClaim(state, claimId);
      if (claim.status === "released") {
        return claim;
      }

      const releaseReason = String(reason || "").trim();
      if (releaseReason.length > 500) {
        throw new ApiError(
          400,
          "BAD_REQUEST",
          "Release reason must not exceed 500 characters"
        );
      }

      const releasedAt = isoNow(this.#now);
      claim.status = "released";
      claim.releasedAt = releasedAt;
      claim.releaseReason = releaseReason;

      const item = state.inventory.find(
        candidate =>
          candidate.id === claim.emailId &&
          candidate.activeClaimId === claim.claimId
      );
      if (item) {
        item.group = "unused";
        item.activeClaimId = "";
        item.updatedAt = releasedAt;
      }
      return claim;
    });
  }
}
