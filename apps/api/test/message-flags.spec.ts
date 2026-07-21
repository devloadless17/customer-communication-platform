/**
 * Message flags — domain-layer invariants.
 *
 * Covers what a browser test structurally CANNOT: genuine concurrency. The
 * counter on `Conversation.openFlagCount` is maintained by CAS-gated writes,
 * and the only way to prove those gates work is to fire the racing calls for
 * real and check the arithmetic afterwards.
 *
 * Also pins the `action` semantics. `action` is the transition — not the
 * post-state — and two real bugs lived in getting that wrong: a metadata-only
 * edit of an already-resolved flag published `resolved` (writing a duplicate
 * audit row and re-firing partner "complaint closed" automations for a change
 * that closed nothing), and a genuine reopen published `updated` (which the
 * audit subscriber skips, so the timeline ended at "resolved" while the flag
 * was open again in the queue).
 *
 * Requires a reachable DATABASE_URL. Creates and deletes its own throwaway
 * team, so it never touches existing data.
 *
 *   pnpm --filter @ccp/api exec vitest run test/message-flags.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, setSharedDb } from "@/lib/db";
import { raiseFlag, removeFlag, updateFlag } from "@/lib/message-flags/mutations";
import { sweepMessageFlagCountsOnce } from "@/lib/sweepers/message-flag-count-drift";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// The domain layer resolves its client through lib/db's "set before use" Proxy,
// which NestJS normally seeds at boot. Outside Nest we seed it ourselves so the
// SAME code path runs here as in production.
setSharedDb(
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  }) as unknown as PrismaClient,
);

const SUFFIX = `vt${Date.now().toString().slice(-8)}`;

let teamId: string;
let userId: string;
let conversationId: string;
let messageId: string;
let complaintId: string;
let refundId: string;
let actor: { userId: string };
let base: { teamId: string; messageId: string; actor: { userId: string } };

const openFlagCount = async (): Promise<number> =>
  (
    await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { openFlagCount: true },
    })
  ).openFlagCount;

/** The `action` of the most recent `message.flag_changed` outbox row. */
const lastAction = async (): Promise<string | undefined> => {
  const row = await db.outboundEvent.findFirst({
    where: { teamId, type: "message.flag_changed" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  return (row?.payload as { action?: string } | undefined)?.action;
};

beforeAll(async () => {
  const team = await db.team.create({ data: { name: `flag-spec-${SUFFIX}` } });
  teamId = team.id;
  const user = await db.user.create({
    data: {
      teamId,
      name: "Spec Agent",
      email: `flag-spec-${SUFFIX}@example.test`,
      role: "admin",
    },
  });
  userId = user.id;
  const contact = await db.contact.create({
    data: {
      teamId,
      name: "Spec Contact",
      phoneNumber: `+9990${SUFFIX}`,
      identityChannel: "whatsapp",
    },
  });
  const conversation = await db.conversation.create({
    data: { teamId, contactId: contact.id, channel: "whatsapp" },
  });
  conversationId = conversation.id;
  const message = await db.message.create({
    data: {
      teamId,
      conversationId,
      externalId: `flag-spec-${SUFFIX}`,
      body: "The order arrived late again.",
      direction: "in",
      channel: "whatsapp",
    },
  });
  messageId = message.id;
  complaintId = (
    await db.messageFlagDefinition.create({
      data: { teamId, name: "Complaint", color: "rose" },
    })
  ).id;
  refundId = (
    await db.messageFlagDefinition.create({
      data: { teamId, name: "Refund request", color: "amber" },
    })
  ).id;

  actor = { userId };
  base = { teamId, messageId, actor };
});

afterAll(async () => {
  await db.team.delete({ where: { id: teamId } });
});

describe("raising", () => {
  it("raises a flag and increments the conversation's open count", async () => {
    const result = await raiseFlag(db, { ...base, definitionId: complaintId });
    expect(result.ok).toBe(true);
    expect(await openFlagCount()).toBe(1);
    expect(await lastAction()).toBe("added");
  });

  it("is idempotent under a concurrent double-raise", async () => {
    // Two simultaneous first-raises both miss the existence check and both
    // INSERT; the loser hits the unique constraint. A P2002 inside a Postgres
    // transaction poisons it, so the recovery has to re-run the whole thing —
    // this proves that retry works rather than surfacing an error.
    const [a, b] = await Promise.all([
      raiseFlag(db, { ...base, definitionId: complaintId }),
      raiseFlag(db, { ...base, definitionId: complaintId }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(
      await db.messageFlag.count({ where: { messageId, definitionId: complaintId } }),
    ).toBe(1);
    expect(await openFlagCount()).toBe(1);
  });

  it("counts a second, different flag on the same message", async () => {
    await raiseFlag(db, { ...base, definitionId: refundId });
    expect(await openFlagCount()).toBe(2);
  });

  it("refuses an archived definition", async () => {
    const retired = await db.messageFlagDefinition.create({
      data: { teamId, name: `Retired ${SUFFIX}`, color: "slate", archived: true },
    });
    const result = await raiseFlag(db, { ...base, definitionId: retired.id });
    expect(result).toMatchObject({ ok: false, reason: "definition_archived" });
  });

  it("refuses a message belonging to another team", async () => {
    const other = await db.team.create({ data: { name: `flag-spec-other-${SUFFIX}` } });
    try {
      const result = await raiseFlag(db, {
        teamId: other.id,
        messageId,
        definitionId: complaintId,
        actor,
      });
      expect(result).toMatchObject({ ok: false, reason: "message_not_found" });
    } finally {
      await db.team.delete({ where: { id: other.id } });
    }
  });
});

describe("action semantics", () => {
  let flagId: string;

  beforeAll(async () => {
    flagId = (
      await db.messageFlag.findFirstOrThrow({
        where: { messageId, definitionId: complaintId },
        select: { id: true },
      })
    ).id;
  });

  it("reports 'resolved' for a real resolve", async () => {
    await updateFlag(db, { teamId, flagId, actor, status: "resolved" });
    expect(await lastAction()).toBe("resolved");
  });

  it("reports 'updated' — NOT 'resolved' — for a note edit on a resolved flag", async () => {
    // The regression: deriving `action` from the post-state re-reported
    // "resolved" here, duplicating the audit row and the partner webhook.
    await updateFlag(db, { teamId, flagId, actor, resolutionNote: "refunded" });
    expect(await lastAction()).toBe("updated");
  });

  it("reports 'reopened' for a reopen", async () => {
    // The mirror regression: this reported "updated", which the audit
    // subscriber skips — so a reopen left no trace on the timeline at all.
    await updateFlag(db, { teamId, flagId, actor, status: "open" });
    expect(await lastAction()).toBe("reopened");
  });

  it("reports 'reopened' when re-raising a dismissed flag", async () => {
    await updateFlag(db, { teamId, flagId, actor, status: "dismissed" });
    await raiseFlag(db, { ...base, definitionId: complaintId });
    expect(await lastAction()).toBe("reopened");
  });
});

describe("counter integrity", () => {
  it("decrements exactly once when two agents resolve at the same moment", async () => {
    const flagId = (
      await db.messageFlag.findFirstOrThrow({
        where: { messageId, definitionId: complaintId },
        select: { id: true },
      })
    ).id;
    const before = await openFlagCount();

    const [a, b] = await Promise.all([
      updateFlag(db, { teamId, flagId, actor, status: "resolved" }),
      updateFlag(db, { teamId, flagId, actor, status: "resolved" }),
    ]);

    // BOTH succeed — the loser asked for exactly the state that now holds, so
    // reporting a conflict would be a lie. The counter moves once.
    expect(a.ok && b.ok).toBe(true);
    expect(await openFlagCount()).toBe(before - 1);
  });

  it("does not move the counter for a metadata-only edit", async () => {
    const flagId = (
      await db.messageFlag.findFirstOrThrow({
        where: { messageId, definitionId: refundId },
        select: { id: true },
      })
    ).id;
    const before = await openFlagCount();
    await updateFlag(db, { teamId, flagId, actor, note: "still waiting" });
    expect(await openFlagCount()).toBe(before);
  });

  it("decrements when an OPEN flag is removed outright", async () => {
    const flagId = (
      await db.messageFlag.findFirstOrThrow({
        where: { messageId, definitionId: refundId },
        select: { id: true },
      })
    ).id;
    const before = await openFlagCount();
    await removeFlag(db, { teamId, flagId, actor });
    expect(await openFlagCount()).toBe(before - 1);
  });
});

describe("drift sweeper", () => {
  it("reconciles a counter left stale by a cascade delete, then no-ops", async () => {
    // Deleting the MESSAGE cascades its flags away without going through
    // mutations.ts — nothing decrements the parent. This is the exact drift
    // the sweeper exists for, and the reason the "Flagged" preset can't be
    // trusted to a counter with no reconciler behind it.
    await raiseFlag(db, { ...base, definitionId: complaintId });
    expect(await openFlagCount()).toBeGreaterThan(0);

    await db.message.delete({ where: { id: messageId } });
    expect(await openFlagCount()).toBeGreaterThan(0); // stale, as expected

    expect(await sweepMessageFlagCountsOnce()).toBeGreaterThanOrEqual(1);
    expect(await openFlagCount()).toBe(0);

    // A second pass must find nothing — otherwise the sweeper is rewriting
    // rows every day for no reason.
    expect(await sweepMessageFlagCountsOnce()).toBe(0);
  });
});
