/**
 * Outbox at-least-once lease state machine (2026-07-27).
 *
 * The §9 contract: an event that COMMITTED must reach its subscribers even
 * across a hard crash. The mechanism under test is claimBatch's lease —
 * claim (`claimedAt`, attempts+1) → dispatch → publish (`markDispatched`) —
 * with redelivery when a claim's lease expires unpublished, a terminal
 * ceiling for poison rows, and terminal closure for subscriber errors.
 *
 * A "crash" here is simulated deterministically: claim a row, then BACKDATE
 * its claimedAt past the lease instead of killing the process — byte-for-byte
 * the state a kill -9 mid-dispatch leaves behind.
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Vitest doesn't auto-load .env; same posture as tickets.spec.ts (cwd is
// apps/api under `pnpm test`, the repo root under a bare vitest invocation).
if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

import {
  claimBatch,
  markDispatched,
  markPublishedWithError,
  sweepExhaustedClaims,
} from "@/lib/events/outbox";
import { db, setSharedDb } from "@/lib/db";

// Same standalone-Prisma posture as tickets.spec.ts — the outbox helpers read
// the SHARED db; point it at this connection, no Nest container needed.
const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const WS_ID = "e2e-outbox-lease-ws";
const ORG_ID = "e2e-outbox-lease-org";
// Comfortably past the 10-minute lease.
const PAST_LEASE = new Date(Date.now() - 11 * 60_000);

/**
 * A RUNNING api on this database claims + dispatches every pending outbox row
 * within ~100ms — its drainer races this spec's own claimBatch calls and
 * steals the seeded rows mid-assertion (observed: the dev stack's api). The
 * state machine under test is exercised deterministically in the CI `unit`
 * job, where no api runs. Locally with a live stack we skip rather than
 * flake; the meta/main e2e suites still cover outbox behavior end-to-end.
 */
async function liveDrainerPresent(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:4000/health", {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const skipForLiveDrainer = await liveDrainerPresent();

async function seedEvent(): Promise<string> {
  // Direct insert in exactly publishInTx's shape (which returns void — the
  // tests need the row id back).
  const row = await db.outboundEvent.create({
    data: {
      workspaceId: WS_ID,
      type: "contact.updated",
      payload: { contactId: "c1", kind: "updated" },
    },
    select: { id: true },
  });
  return row.id;
}

async function row(id: string) {
  return db.outboundEvent.findUniqueOrThrow({
    where: { id },
    select: {
      claimedAt: true,
      publishedAt: true,
      dispatchedAt: true,
      failedAt: true,
      lastError: true,
      attempts: true,
    },
  });
}

/** Claim repeatedly until our row appears or the table is drained. */
async function claimOurs(id: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const batch = await claimBatch(200);
    if (batch.some((r) => r.id === id)) return true;
    if (batch.length === 0) return false;
  }
  return false;
}

beforeAll(async () => {
  await db.organization.upsert({
    where: { id: ORG_ID },
    create: { id: ORG_ID, name: "Outbox Lease Org", status: "active" },
    update: {},
  });
  await db.workspace.upsert({
    where: { id: WS_ID },
    create: { id: WS_ID, name: "Outbox Lease WS", organizationId: ORG_ID },
    update: {},
  });
});

beforeEach(async () => {
  await db.outboundEvent.deleteMany({ where: { workspaceId: WS_ID } });
});

afterAll(async () => {
  await db.outboundEvent.deleteMany({ where: { workspaceId: WS_ID } });
  await db.workspace.deleteMany({ where: { id: WS_ID } });
  await db.organization.deleteMany({ where: { id: ORG_ID } });
});

describe.skipIf(skipForLiveDrainer)("outbox claim lease", () => {
  it("a claim stamps the lease, not publishedAt — and a claimed row is NOT re-claimable inside the lease", async () => {
    const id = await seedEvent();
    expect(await claimOurs(id)).toBe(true);

    const after = await row(id);
    expect(after.claimedAt).not.toBeNull();
    expect(after.publishedAt).toBeNull();
    expect(after.attempts).toBe(1);

    // Steady-state: the live claim shields the row from a second drainer.
    expect(await claimOurs(id)).toBe(false);
  });

  it("a crash mid-dispatch REDELIVERS after the lease expires (the §9 promise)", async () => {
    const id = await seedEvent();
    expect(await claimOurs(id)).toBe(true);
    // Simulate kill -9 between claim and publish: nothing else happens to the
    // row; the lease just ages out.
    await db.outboundEvent.update({ where: { id }, data: { claimedAt: PAST_LEASE } });

    expect(await claimOurs(id)).toBe(true);
    expect((await row(id)).attempts).toBe(2);
  });

  it("markDispatched closes the bracket: publishedAt + dispatchedAt land, and the row never redelivers", async () => {
    const id = await seedEvent();
    expect(await claimOurs(id)).toBe(true);
    await markDispatched([id]);

    const after = await row(id);
    expect(after.publishedAt).not.toBeNull();
    expect(after.dispatchedAt).not.toBeNull();
    expect(after.failedAt).toBeNull();

    // Even with the lease aged out, a published row is done.
    await db.outboundEvent.update({ where: { id }, data: { claimedAt: PAST_LEASE } });
    expect(await claimOurs(id)).toBe(false);
  });

  it("a subscriber error closes the row TERMINALLY — kept for triage, never redelivered", async () => {
    const id = await seedEvent();
    expect(await claimOurs(id)).toBe(true);
    await markPublishedWithError(id, "audit subscriber threw");

    const after = await row(id);
    expect(after.publishedAt).not.toBeNull();
    expect(after.failedAt).not.toBeNull();
    expect(after.lastError).toBe("audit subscriber threw");

    await db.outboundEvent.update({ where: { id }, data: { claimedAt: PAST_LEASE } });
    expect(await claimOurs(id)).toBe(false);
  });

  it("a poison row stops at the attempts ceiling: the sweep marks it redelivery_exhausted", async () => {
    const id = await seedEvent();
    // Five crashed deliveries.
    for (let i = 0; i < 5; i++) {
      expect(await claimOurs(id)).toBe(true);
      await db.outboundEvent.update({ where: { id }, data: { claimedAt: PAST_LEASE } });
    }
    await sweepExhaustedClaims();

    const after = await row(id);
    expect(after.failedAt).not.toBeNull();
    expect(after.lastError).toBe("redelivery_exhausted");
    expect(await claimOurs(id)).toBe(false);
  });
});
