import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ClaimService } from "../lib/claim-service.mjs";
import { DashboardStore } from "../lib/dashboard-store.mjs";

function inventory(email, group, label, id = email) {
  return {
    id,
    email,
    group,
    source: "icloud-hme",
    label,
    remark: label,
    appleLabel: "",
    anonymousId: "",
    isActive: true,
    activeClaimId: "",
    code: "",
    subject: "",
    preview: "",
    receivedAt: "",
    unread: false,
    statusType: "ok",
    statusMessage: "",
    lastCheckedAt: "",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z"
  };
}

async function makeClaimService(t, inventoryRows) {
  const directory = await mkdtemp(join(tmpdir(), "mail-dashboard-claims-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let currentTime = new Date("2026-07-25T10:00:00.000Z");
  let claimSequence = 0;
  const now = () => currentTime;
  const store = new DashboardStore({
    statePath: join(directory, "dashboard-state-v1.json"),
    backupDir: join(directory, "backups"),
    now,
    randomUUID: () => `inventory-${++claimSequence}`
  });
  await store.mutate(state => {
    state.inventory = inventoryRows;
  });

  const service = new ClaimService({
    store,
    now,
    randomUUID: () => `claim-${++claimSequence}`
  });
  return {
    service,
    store,
    advance(milliseconds) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    }
  };
}

test("claimNext chooses the lowest numbered unused label", async t => {
  const { service } = await makeClaimService(t, [
    inventory("b@icloud.com", "unused", "hme-010"),
    inventory("a@icloud.com", "unused", "hme-002")
  ]);

  const claim = await service.claimNext({ idempotencyKey: "job-1" });

  assert.equal(claim.email, "a@icloud.com");
  assert.equal(claim.status, "active");
});

test("parallel claims never return the same email", async t => {
  const { service } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001"),
    inventory("b@icloud.com", "unused", "hme-002")
  ]);

  const [first, second] = await Promise.all([
    service.claimNext({ idempotencyKey: "job-a" }),
    service.claimNext({ idempotencyKey: "job-b" })
  ]);

  assert.notEqual(first.email, second.email);
});

test("the same idempotency key returns the original claim", async t => {
  const { service, store } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001"),
    inventory("b@icloud.com", "unused", "hme-002")
  ]);

  const first = await service.claimNext({ idempotencyKey: "retry-key" });
  const retry = await service.claimNext({ idempotencyKey: "retry-key" });

  assert.equal(retry.claimId, first.claimId);
  assert.equal(retry.email, first.email);
  assert.equal((await store.read()).claims.length, 1);
});

test("finished and trash addresses are never claimed", async t => {
  const { service } = await makeClaimService(t, [
    inventory("used@icloud.com", "finished", "hme-001"),
    inventory("trash@icloud.com", "trash", "hme-002")
  ]);

  await assert.rejects(
    service.claimNext({ idempotencyKey: "job-1" }),
    error => error.code === "INVENTORY_EMPTY"
  );
});

test("getClaim returns an active claim and rejects a missing claim", async t => {
  const { service } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001")
  ]);
  const claimed = await service.claimNext({ idempotencyKey: "job-1" });

  assert.deepEqual(await service.getClaim(claimed.claimId), claimed);
  await assert.rejects(
    service.getClaim("missing"),
    error => error.code === "CLAIM_NOT_FOUND" && error.status === 404
  );
});

test("releaseClaim records the reason and restores the associated address", async t => {
  const { advance, service, store } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001")
  ]);
  const claimed = await service.claimNext({ idempotencyKey: "job-1" });
  advance(1_000);

  const released = await service.releaseClaim(
    claimed.claimId,
    "synthetic registration failure"
  );

  assert.equal(released.status, "released");
  assert.equal(released.releaseReason, "synthetic registration failure");
  assert.equal(released.releasedAt, "2026-07-25T10:00:01.000Z");
  const item = (await store.read()).inventory[0];
  assert.equal(item.group, "unused");
  assert.equal(item.activeClaimId, "");
});

test("repeated release preserves the original timestamp and reason", async t => {
  const { advance, service } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001")
  ]);
  const claimed = await service.claimNext({ idempotencyKey: "job-1" });
  advance(1_000);
  const first = await service.releaseClaim(claimed.claimId, "first reason");
  advance(1_000);
  const repeated = await service.releaseClaim(
    claimed.claimId,
    "replacement reason"
  );

  assert.deepEqual(repeated, first);
});

test("release does not restore an address no longer associated with the claim", async t => {
  const { service, store } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001")
  ]);
  const claimed = await service.claimNext({ idempotencyKey: "job-1" });
  await store.mutate(state => {
    state.inventory[0].activeClaimId = "different-claim";
  });

  await service.releaseClaim(claimed.claimId, "no longer associated");

  assert.equal((await store.read()).inventory[0].group, "finished");
});

test("getActiveClaim rejects released claims for mail lookups", async t => {
  const { service } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001")
  ]);
  const claimed = await service.claimNext({ idempotencyKey: "job-1" });
  assert.equal(
    (await service.getActiveClaim(claimed.claimId)).claimId,
    claimed.claimId
  );
  await service.releaseClaim(claimed.claimId, "done");

  await assert.rejects(
    service.getActiveClaim(claimed.claimId),
    error => error.code === "CLAIM_RELEASED" && error.status === 409
  );
});

test("claimNext requires a non-empty bounded idempotency key", async t => {
  const { service } = await makeClaimService(t, [
    inventory("a@icloud.com", "unused", "hme-001")
  ]);

  await assert.rejects(
    service.claimNext({ idempotencyKey: " " }),
    error => error.code === "BAD_REQUEST"
  );
  await assert.rejects(
    service.claimNext({ idempotencyKey: "x".repeat(201) }),
    error => error.code === "BAD_REQUEST"
  );
});

test("a prototype-named idempotency key claims normally instead of erroring", async t => {
  const { service } = await makeClaimService(t, [
    inventory("first@icloud.com", "unused", "hme-001"),
    inventory("second@icloud.com", "unused", "hme-002")
  ]);

  for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const claim = await service.claimNext({ idempotencyKey: key });
    assert.equal(typeof claim.claimId, "string");
    assert.equal(claim.status, "active");
    // Same key twice must still be idempotent, not a second address.
    const repeat = await service.claimNext({ idempotencyKey: key });
    assert.equal(repeat.claimId, claim.claimId);
    await service.releaseClaim(claim.claimId, "test cleanup");
  }
});

test("a claimed address cannot be moved between groups until it is released", async t => {
  const { service, store } = await makeClaimService(t, [
    inventory("held@icloud.com", "unused", "hme-001")
  ]);
  const claim = await service.claimNext({ idempotencyKey: "lockout-check" });
  const held = (await store.listInventory())[0];

  assert.equal(held.group, "finished");
  assert.equal(held.activeClaimId, claim.claimId);

  await assert.rejects(
    () => store.updateInventoryItem(held.id, { group: "unused" }),
    { code: "CLAIM_ACTIVE" }
  );
  // Untouched by the rejected patch.
  assert.equal((await store.listInventory())[0].group, "finished");

  // Unrelated fields still patch fine while the claim is active.
  const remarked = await store.updateInventoryItem(held.id, {
    remark: "still editable"
  });
  assert.equal(remarked.remark, "still editable");

  // Releasing clears the claim and restores the address to "unused".
  await service.releaseClaim(claim.claimId, "done");
  const afterRelease = (await store.listInventory())[0];
  assert.equal(afterRelease.group, "unused");
  assert.equal(afterRelease.activeClaimId, "");

  // Group moves work again now that no claim holds the address.
  const trashed = await store.updateInventoryItem(held.id, { group: "trash" });
  assert.equal(trashed.group, "trash");
  await store.updateInventoryItem(held.id, { group: "unused" });

  const reclaimed = await service.claimNext({ idempotencyKey: "second-round" });
  assert.equal(reclaimed.email, "held@icloud.com");
});
