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
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, setSharedDb } from "@/lib/db";
import { raiseFlag, removeFlag, updateFlag } from "@/lib/message-flags/mutations";
import { listFlags } from "@/lib/message-flags/queries";
import { sweepMessageFlagCountsOnce } from "@/lib/sweepers/message-flag-count-drift";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// The domain layer resolves its client through lib/db's "set before use" Proxy,
// which NestJS normally seeds at boot. Outside Nest we seed it ourselves so the
// SAME code path runs here as in production.
setSharedDb(
  createTestPrismaClient() as unknown as PrismaClient,
);

const SUFFIX = `vt${Date.now().toString().slice(-8)}`;

let organizationId: string;
let workspaceId: string;
let userId: string;
let conversationId: string;
let messageId: string;
let complaintId: string;
let refundId: string;
let actor: { userId: string };
let base: { workspaceId: string; messageId: string; actor: { userId: string } };

const openFlagCount = async (): Promise<number> =>
  (
    await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { openFlagCount: true },
    })
  ).openFlagCount;

/** The `action` of the most recent `message.flag_changed` outbox row. */
/**
 * `OutboundEvent` ids already accounted for.
 *
 * `lastAction` used to be `orderBy: { createdAt: "desc" }, findFirst`. That is
 * AMBIGUOUS: `createdAt` is millisecond-precision and `id` is a random cuid, so
 * two events written inside the same millisecond tie and Postgres resolves the
 * tie however it likes. Under a full parallel suite run — several spec files
 * sharing one database — writes bunch up and the tie happened often enough to
 * fail ~1 run in 5, reporting the PREVIOUS test's "updated" instead of this
 * test's "reopened".
 *
 * Consuming events instead of sorting them removes the ordering question
 * entirely: each assertion drains exactly the rows its own call produced.
 */
const seenEventIds = new Set<string>();

/**
 * The action reported by the flag event(s) since the last call. Returns the
 * newest when a step legitimately emits more than one (a re-raise emits a
 * dismiss then a reopen), which is unambiguous because they are drained
 * together in insertion order rather than compared by timestamp.
 */
const lastAction = async (): Promise<string | undefined> => {
  const rows = await db.outboundEvent.findMany({
    where: {
      workspaceId,
      type: "message.flag_changed",
      id: { notIn: [...seenEventIds] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, payload: true },
  });
  for (const r of rows) seenEventIds.add(r.id);
  const last = rows.at(-1);
  return (last?.payload as { action?: string } | undefined)?.action;
};

beforeAll(async () => {
  // A workspace now needs an owning Organization, and the role is a
  // per-workspace grant on WorkspaceMember rather than a User column.
  const org = await db.organization.create({
    data: { name: `flag-spec-org-${SUFFIX}`, status: "active" },
  });
  organizationId = org.id;
  const team = await db.workspace.create({
    data: { name: `flag-spec-${SUFFIX}`, organizationId: org.id },
  });
  workspaceId = team.id;
  const user = await db.user.create({
    data: {
      organizationId: org.id,
      name: "Spec Agent",
      email: `flag-spec-${SUFFIX}@example.test`,
    },
  });
  userId = user.id;
  await db.workspaceMember.create({
    data: { userId, workspaceId, role: "admin" },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId,
      name: "Spec Contact",
      phoneNumber: `+9990${SUFFIX}`,
      identityChannel: "whatsapp",
    },
  });
  const conversation = await db.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
  });
  conversationId = conversation.id;
  const message = await db.message.create({
    data: {
      workspaceId,
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
      data: { workspaceId, name: "Complaint", color: "rose" },
    })
  ).id;
  refundId = (
    await db.messageFlagDefinition.create({
      data: { workspaceId, name: "Refund request", color: "amber" },
    })
  ).id;

  actor = { userId };
  base = { workspaceId, messageId, actor };
});

afterAll(async () => {
  // Delete the ORG: users now belong to it, so dropping only the workspace
  // would leave the seeded user behind.
  await db.organization.delete({ where: { id: organizationId } });
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
      data: { workspaceId, name: `Retired ${SUFFIX}`, color: "slate", archived: true },
    });
    const result = await raiseFlag(db, { ...base, definitionId: retired.id });
    expect(result).toMatchObject({ ok: false, reason: "definition_archived" });
  });

  it("refuses a message belonging to another team", async () => {
    // A second tenant: its own Organization + Workspace, to prove the flag
    // refuses a message that lives in a DIFFERENT workspace.
    const otherOrg = await db.organization.create({
      data: { name: `flag-spec-other-org-${SUFFIX}`, status: "active" },
    });
    const other = await db.workspace.create({
      data: { name: `flag-spec-other-${SUFFIX}`, organizationId: otherOrg.id },
    });
    try {
      const result = await raiseFlag(db, {
        workspaceId: other.id,
        messageId,
        definitionId: complaintId,
        actor,
      });
      expect(result).toMatchObject({ ok: false, reason: "message_not_found" });
    } finally {
      await db.organization.delete({ where: { id: otherOrg.id } });
    }
  });
});

describe("action semantics", () => {
  let flagId: string;

  beforeAll(async () => {
    // Drain whatever the earlier describes emitted, so the first assertion
    // below sees only its own event.
    await lastAction();
    flagId = (
      await db.messageFlag.findFirstOrThrow({
        where: { messageId, definitionId: complaintId },
        select: { id: true },
      })
    ).id;
  });

  it("reports 'resolved' for a real resolve", async () => {
    await updateFlag(db, { workspaceId, flagId, actor, status: "resolved" });
    expect(await lastAction()).toBe("resolved");
  });

  it("reports 'updated' — NOT 'resolved' — for a note edit on a resolved flag", async () => {
    // The regression: deriving `action` from the post-state re-reported
    // "resolved" here, duplicating the audit row and the partner webhook.
    await updateFlag(db, { workspaceId, flagId, actor, resolutionNote: "refunded" });
    expect(await lastAction()).toBe("updated");
  });

  it("reports 'reopened' for a reopen", async () => {
    // The mirror regression: this reported "updated", which the audit
    // subscriber skips — so a reopen left no trace on the timeline at all.
    await updateFlag(db, { workspaceId, flagId, actor, status: "open" });
    expect(await lastAction()).toBe("reopened");
  });

  it("reports 'reopened' when re-raising a dismissed flag", async () => {
    await updateFlag(db, { workspaceId, flagId, actor, status: "dismissed" });
    // Consume the dismiss event separately, so the assertion below is about
    // the RE-RAISE alone and never has to order two same-millisecond rows.
    //
    // `resolved`, not `dismissed`: the action names the TRANSITION, and the
    // vocabulary is added|updated|reopened|resolved|removed. Leaving `open` in
    // either direction — genuinely resolved, or dismissed as a mis-flag — is
    // one transition out of the queue. The resolved/dismissed distinction is
    // carried by the flag's `status`, not by the action.
    expect(await lastAction()).toBe("resolved");
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
      updateFlag(db, { workspaceId, flagId, actor, status: "resolved" }),
      updateFlag(db, { workspaceId, flagId, actor, status: "resolved" }),
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
    await updateFlag(db, { workspaceId, flagId, actor, note: "still waiting" });
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
    await removeFlag(db, { workspaceId, flagId, actor });
    expect(await openFlagCount()).toBe(before - 1);
  });
});

describe("search", () => {
  it("still applies on page 2 — search and the keyset cursor must compose", async () => {
    // Regression: `searchWhere` and `keysetWhere` both express an `OR`. Spread
    // as siblings, the cursor's OR overwrote the search's, so paginating a
    // filtered queue silently returned unfiltered rows from page 2 onward.
    const conv = await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contactId: true },
    });
    const needle = `needle${SUFFIX}`;
    const madeIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await db.message.create({
        data: {
          workspaceId,
          conversationId,
          externalId: `flag-spec-search-${SUFFIX}-${i}`,
          // Only the EVEN ones carry the needle, so an unfiltered page 2 is
          // immediately visible as a wrong result.
          body: i % 2 === 0 ? `${needle} complaint ${i}` : `unrelated ${i}`,
          direction: "in",
          channel: "whatsapp",
        },
      });
      const r = await raiseFlag(db, {
        workspaceId,
        messageId: m.id,
        definitionId: complaintId,
        actor,
      });
      if (r.ok) madeIds.push(r.flag.id);
    }
    expect(madeIds.length).toBe(5);

    // take:1 forces pagination, so page 2 exercises the cursor + search combo.
    const page1 = await listFlags(db, workspaceId, { search: needle, take: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.messageExcerpt).toContain(needle);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listFlags(db, workspaceId, {
      search: needle,
      take: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.messageExcerpt).toContain(needle);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);

    // Exactly the three needle-carrying flags, no more.
    const all = await listFlags(db, workspaceId, { search: needle, take: 50 });
    expect(all.items).toHaveLength(3);

    // And search matches the CONTACT too, not just the message body.
    const contact = await db.contact.findUniqueOrThrow({
      where: { id: conv.contactId },
      select: { name: true },
    });
    const byContact = await listFlags(db, workspaceId, {
      search: contact.name!.slice(0, 8),
      take: 50,
    });
    expect(byContact.items.length).toBeGreaterThan(0);

    // Clean up this test's rows. The suite is serial and shares one
    // conversation, so leaking five open flags would silently invalidate the
    // sweeper test's expectations below — tests must not depend on, or
    // sabotage, each other's state.
    await db.messageFlag.deleteMany({ where: { id: { in: madeIds } } });
    await db.message.deleteMany({
      where: { workspaceId, externalId: { startsWith: `flag-spec-search-${SUFFIX}-` } },
    });
    await db.conversation.update({
      where: { id: conversationId },
      data: { openFlagCount: 0 },
    });
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
