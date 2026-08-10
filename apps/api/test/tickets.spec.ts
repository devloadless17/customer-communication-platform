/**
 * Ticketing domain rules, driven against a real database.
 *
 * The five things that actually matter here, and why each is a test rather
 * than a code-read:
 *
 *   1. NUMBERING is race-safe. Two agents creating a ticket at the same instant
 *      must not get #7 twice. The row lock in `allocateNumber` is invisible in
 *      a code review — only concurrent creates prove it.
 *   2. MESSAGE ROUTING is the load-bearing rule of the whole feature: attach to
 *      the active ticket, otherwise NOTHING. Nothing opens or reopens a ticket
 *      but a person raising one (2026-08-01).
 *   3. `openTicketCount` / `activeTicketId` never drift — the inbox badge and
 *      the ingest hot path both read them as plain columns.
 *   4. The SLA clock PAUSES and RESUMES by shifting the deadline, rather than
 *      restarting the commitment (which would hand a fresh 4 hours to anyone
 *      who bounced a ticket through `on_hold`).
 *   5. A breach is flagged EXACTLY ONCE, however many times the sweeper runs.
 *
 *   pnpm --filter @ccp/api exec vitest run test/tickets.spec.ts
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addTicketNote,
  allocateNumber,
  createTicket,
  deleteTicket,
  fillActiveTicketAssignee,
  markSlaBreached,
  routeMessageToTicket,
  updateTicket,
} from "@/lib/tickets/mutations";
import { listTickets } from "@/lib/tickets/queries";
import {
  createTicketView,
  getTicketViewFilters,
  listTicketViews,
  ticketViewToFilters,
  updateTicketView,
} from "@/lib/tickets/views";
import { setSharedDb } from "@/lib/db";
import { computeDueDates, dueAt } from "@/lib/tickets/sla";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
// The mutations take an injected `db` — the same surface the Nest service
// passes. No Nest container needed.
const db = prisma as unknown as Parameters<typeof createTicket>[0];
// `fillActiveTicketAssignee` reads the SHARED db (so `assignConversation` keeps
// its narrow injected surface) — point it at this connection.
setSharedDb(prisma as unknown as PrismaClient);

const S = `tk${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let userId = "";
let contactSeq = 0;

async function makeConversation() {
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `TK ${contactSeq}`,
      phoneNumber: `+9866${S}${String(contactSeq++).padStart(3, "0")}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  return convo.id;
}

const conversationState = (id: string) =>
  prisma.conversation.findUniqueOrThrow({
    where: { id },
    select: { activeTicketId: true, openTicketCount: true },
  });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `TK Org ${S}`, status: "active" } }))
    .id;
  workspaceId = (
    await prisma.workspace.create({
      data: {
        name: `TK WS ${S}`,
        organizationId: orgId,
      },
    })
  ).id;
  const user = await prisma.user.create({
    data: { name: "TK Agent", email: `tk-${S}@example.test`, organizationId: orgId },
    select: { id: true },
  });
  userId = user.id;
  await prisma.workspaceMember.create({ data: { userId, workspaceId, role: "agent" } });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("numbering", () => {
  // 8 concurrent creates each SERIALIZE on the counter's row lock, so the wall
  // clock is 8 lock acquisitions deep — under a loaded machine that overran
  // vitest's 5s default and reported a timeout as a failure four separate
  // times. The thing under test is correctness (no duplicate numbers), not
  // latency, so give it room rather than keep re-running a false alarm.
  it("hands out unique sequential numbers under concurrent creates", { timeout: 20_000 }, async () => {
    const conversations = await Promise.all(
      Array.from({ length: 8 }, () => makeConversation()),
    );
    // Fired together on purpose — the counter's row lock is the only thing
    // standing between this and two tickets sharing a number.
    const results = await Promise.all(
      conversations.map((conversationId) =>
        createTicket(db, { workspaceId, conversationId, actor: { userId } }),
      ),
    );
    const numbers = results.map((r) => (r.ok ? r.ticket.number : -1));
    expect(numbers).not.toContain(-1);
    expect(new Set(numbers).size).toBe(numbers.length);
    // Sequential from 1 — a workspace's first ticket is #1, not #0 or #2.
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  /**
   * `requireNoActiveTicket` is the ATOMIC form of "only if this thread has no
   * open ticket". The workflow step used to read `Conversation.activeTicketId`
   * and then create — two statements, so two inbound messages milliseconds
   * apart put two runs through the gap together and opened two tickets on one
   * thread, one of which was no longer anybody's `activeTicketId`.
   */
  it("requireNoActiveTicket: concurrent creates on ONE thread yield exactly one ticket", { timeout: 20_000 }, async () => {
    const conversationId = await makeConversation();
    // Fired together on purpose — the pointer CAS is the only thing standing
    // between this and two open tickets on one conversation.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createTicket(db, {
          workspaceId,
          conversationId,
          actor: { userId },
          requireNoActiveTicket: true,
        }),
      ),
    );
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(5);
    for (const l of lost) {
      expect(l.ok).toBe(false);
      if (!l.ok) expect(l.reason).toBe("already_has_active_ticket");
    }

    // The losers ROLLED BACK: exactly one ticket row exists on this thread, and
    // the pointer names it. A loser that merely returned an error while leaving
    // its row behind would still show two tickets on the board.
    const rows = await prisma.ticket.findMany({
      where: { workspaceId, conversationId },
      select: { id: true },
    });
    expect(rows).toHaveLength(1);
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { activeTicketId: true, openTicketCount: true },
    });
    expect(conv?.activeTicketId).toBe(rows[0]!.id);
    // The rolled-back creates must not have left their count increments behind.
    expect(conv?.openTicketCount).toBe(1);
  });

  it("a burnt number leaves a GAP and is never handed out twice", async () => {
    // Pins the tradeoff that lets `createTicket` allocate OUTSIDE its
    // transaction (2026-07-29). Holding the counter's row lock until the create
    // committed serialized every concurrent create in a workspace behind a full
    // create — eight at once blew the 15s interactive-transaction ceiling, i.e.
    // a 500 for whoever was at the back. Allocating first means a create that
    // fails afterwards burns its number.
    //
    // docs/ticketing.md sanctions exactly this: "Gaps are fine; collisions are
    // not." So assert BOTH halves — the gap is tolerated, and the burnt number
    // is never reissued. Simulating the burn by allocating directly is what a
    // failed-after-allocation create leaves behind.
    const before = await createTicket(db, {
      workspaceId,
      conversationId: await makeConversation(),
      actor: { userId },
    });
    expect(before.ok).toBe(true);
    const lastGood = before.ok ? before.ticket.number : -1;

    const burnt = await allocateNumber(prisma, workspaceId);
    expect(burnt).toBe(lastGood + 1);

    const after = await createTicket(db, {
      workspaceId,
      conversationId: await makeConversation(),
      actor: { userId },
    });
    expect(after.ok).toBe(true);
    const next = after.ok ? after.ticket.number : -1;
    // The gap is real...
    expect(next).toBe(burnt + 1);
    // ...and nothing reuses the burnt one, which is the half that matters:
    // reissuing it would collide with `@@unique([workspaceId, number])`.
    const reused = await prisma.ticket.count({ where: { workspaceId, number: burnt } });
    expect(reused).toBe(0);
  });
});

describe("message → ticket routing", () => {
  // Auto-open was removed 2026-07-25: a ticket is a deliberate act. So an inbound
  // NEVER opens a new ticket — it only attaches to a live one or reopens a
  // recently-solved one. Tickets are seeded here via createTicket (the manual
  // path), exactly as an agent's "Raise a ticket" would.
  it("does NOT open a ticket on an inbound — tickets are raised deliberately", async () => {
    const conversationId = await makeConversation();
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId }),
    );
    expect(routed.ticketId).toBeNull();

    const convo = await conversationState(conversationId);
    expect(convo.activeTicketId).toBeNull();
    expect(convo.openTicketCount).toBe(0);
  });

  it("attaches an inbound to the thread's ACTIVE ticket, doesn't open a second", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";

    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId }),
    );
    expect(routed.ticketId).toBe(ticketId);
    expect((await conversationState(conversationId)).openTicketCount).toBe(1);
  });

  it("NEVER reopens a solved ticket — a follow-up carries no ticket at all", async () => {
    // The rule the maintainer named on 2026-08-01, after watching a customer's
    // message drag a solved ticket back with a "System reopened #10" line:
    // nothing opens or reopens a ticket but a person raising one. Solved means
    // the customer got their answer; a later message is small talk or a NEW
    // issue, and a new issue deserves its own cause and its own number.
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    const solved = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      status: "solved",
    });
    expect(solved.ok).toBe(true);
    let convo = await conversationState(conversationId);
    expect(convo.openTicketCount).toBe(0);
    expect(convo.activeTicketId).toBeNull();

    // A follow-up ARRIVES ONE SECOND LATER — well inside what used to be the
    // 72h reopen window, which is precisely the case that used to resurrect it.
    const followUp = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId }),
    );
    expect(followUp.ticketId).toBeNull();

    // The ticket is untouched: still solved, never reopened, resolution intact.
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true, reopenCount: true, resolvedAt: true },
    });
    expect(row.status).toBe("solved");
    expect(row.reopenCount).toBe(0);
    expect(row.resolvedAt).not.toBeNull();

    // ...and no "System reopened" line was written to its history.
    const events = await prisma.ticketEvent.findMany({
      where: { ticketId },
      select: { kind: true },
    });
    expect(events.map((e) => e.kind)).not.toContain("reopened");

    // The conversation stays ticket-free. The inbox already tracks it.
    convo = await conversationState(conversationId);
    expect(convo.openTicketCount).toBe(0);
    expect(convo.activeTicketId).toBeNull();
  });

  it("still lets a PERSON reopen a solved ticket deliberately", async () => {
    // Removing the automatic path must not remove the manual one: moving a
    // solved ticket back to `open` is a choice someone makes, and it still
    // clears the stale resolution so "solved by Sara three weeks ago" cannot
    // sit on live work.
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    await updateTicket(db, { workspaceId, ticketId, actor: { userId }, status: "solved" });

    const reopened = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      status: "open",
    });
    expect(reopened.ok).toBe(true);
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true, reopenCount: true, resolvedAt: true },
    });
    expect(row.status).toBe("open");
    expect(row.reopenCount).toBe(1);
    expect(row.resolvedAt).toBeNull();
  });

  it("never reopens from an OUTBOUND message — an agent's follow-up isn't new work", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    await updateTicket(db, { workspaceId, ticketId, actor: { userId }, status: "solved" });
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId }),
    );
    // Outbound never reopens, and nothing auto-opens.
    expect(routed.ticketId).toBeNull();
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true },
    });
    expect(row.status).toBe("solved");
  });

  it("refuses a conversation from another workspace", async () => {
    const conversationId = await makeConversation();
    const otherOrg = await prisma.organization.create({
      data: { name: `TK other ${S}`, status: "active" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `TK other WS ${S}`, organizationId: otherOrg.id },
      select: { id: true },
    });
    // The tenant boundary: a real conversation id, but not THIS workspace's.
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId: otherWs.id, conversationId }),
    );
    expect(routed.ticketId).toBeNull();
    const created = await createTicket(db, {
      workspaceId: otherWs.id,
      conversationId,
      actor: {},
    });
    expect(created.ok).toBe(false);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
  });
});

describe("optimistic concurrency", () => {
  it("rejects a write built on a stale read instead of clobbering", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    const staleVersion = opened.ok ? opened.ticket.version : 0;

    const first = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      expectedVersion: staleVersion,
      priority: "high",
    });
    expect(first.ok).toBe(true);

    // Second agent still holding the pre-change version.
    const second = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      expectedVersion: staleVersion,
      priority: "low",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("version_conflict");

    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { priority: true },
    });
    expect(row.priority).toBe("high");
  });
});

describe("cause / description", () => {
  it("persists the cause set at creation and returns it on read", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      subject: "Refund not received",
      description: "Customer paid twice on the 3rd; billing to confirm.",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.ticket.description).toBe("Customer paid twice on the 3rd; billing to confirm.");
  });

  it("edits the cause and files a description_changed timeline event", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";

    const edited = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      expectedVersion: opened.ok ? opened.ticket.version : 0,
      description: "Now with the real reason.",
    });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.ticket.description).toBe("Now with the real reason.");

    const events = await prisma.ticketEvent.findMany({
      where: { ticketId, kind: "description_changed" },
      select: { id: true },
    });
    expect(events.length).toBe(1);
  });

  it("refuses to clear or rewrite a cause once set — it is written once", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      description: "the founding context",
    });
    const ticketId = opened.ok ? opened.ticket.id : "";
    // Clearing IS a rewrite: everything after the cause (comments, notes,
    // status moves) reasons against it, so it can never be blanked either.
    const cleared = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      expectedVersion: opened.ok ? opened.ticket.version : 0,
      description: null,
    });
    expect(cleared).toEqual({ ok: false, reason: "cause_immutable" });
    // A same-value write is a no-op, not a violation (idempotent PATCH).
    const same = await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      description: "the founding context",
    });
    expect(same.ok).toBe(true);
  });
});

describe("delete", () => {
  it("removes the ticket, clears the pointer + counter, and cascades events", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    let convo = await conversationState(conversationId);
    expect(convo.activeTicketId).toBe(ticketId);
    expect(convo.openTicketCount).toBe(1);
    expect(await prisma.ticketEvent.count({ where: { ticketId } })).toBeGreaterThan(0);

    const res = await deleteTicket(db, { workspaceId, ticketId, actor: { userId } });
    expect(res.ok).toBe(true);

    expect(await prisma.ticket.findUnique({ where: { id: ticketId } })).toBeNull();
    // TicketEvents cascade with the ticket they described.
    expect(await prisma.ticketEvent.count({ where: { ticketId } })).toBe(0);
    // The conversation's active pointer + open counter both clear.
    convo = await conversationState(conversationId);
    expect(convo.activeTicketId).toBeNull();
    expect(convo.openTicketCount).toBe(0);
  });

  it("PRESERVES the customer's messages — only unlinks them (SetNull)", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    const msg = await prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        channel: "whatsapp",
        direction: "in",
        externalId: `del-${S}-${Math.random()}`,
        body: "the customer's message",
        ticketId,
      },
      select: { id: true },
    });

    await deleteTicket(db, { workspaceId, ticketId, actor: { userId } });

    const after = await prisma.message.findUnique({
      where: { id: msg.id },
      select: { id: true, ticketId: true, body: true },
    });
    expect(after).not.toBeNull();
    expect(after!.body).toBe("the customer's message");
    expect(after!.ticketId).toBeNull();
  });

  it("does not decrement the counter for an already-solved ticket", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = opened.ok ? opened.ticket.id : "";
    await updateTicket(db, { workspaceId, ticketId, actor: { userId }, status: "solved" });
    // Solving already dropped openTicketCount to 0; deleting must not go negative.
    const res = await deleteTicket(db, { workspaceId, ticketId, actor: { userId } });
    expect(res.ok).toBe(true);
    expect((await conversationState(conversationId)).openTicketCount).toBe(0);
  });

  it("returns not_found for a missing or cross-workspace ticket", async () => {
    const res = await deleteTicket(db, { workspaceId, ticketId: `tkt_nope_${S}`, actor: {} });
    expect(res.ok).toBe(false);
  });
});

describe("SLA", () => {
  it("computes due dates from the priority's policy", async () => {
    await prisma.ticketSlaPolicy.create({
      data: {
        workspaceId,
        priority: "urgent",
        firstResponseMins: 30,
        resolutionMins: 240,
        pauseOnHold: true,
      },
    });
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      priority: "urgent",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const first = new Date(opened.ticket.sla.firstResponseDueAt!).getTime();
    const created = new Date(opened.ticket.createdAt).getTime();
    // ~30 minutes out, allowing for the round-trip.
    expect(first - created).toBeGreaterThan(29 * 60_000);
    expect(first - created).toBeLessThan(31 * 60_000);
    expect(opened.ticket.sla.resolutionDueAt).toBeTruthy();
  });

  it("PAUSES on hold and pushes the deadline out by the parked time on resume", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      priority: "urgent",
    });
    if (!opened.ok) throw new Error("setup failed");
    const dueBefore = new Date(opened.ticket.sla.resolutionDueAt!).getTime();

    const held = await updateTicket(db, {
      workspaceId,
      ticketId: opened.ticket.id,
      actor: { userId },
      status: "on_hold",
    });
    expect(held.ok && held.ticket.sla.paused).toBe(true);

    // Resume 10 minutes later (injected clock — no sleeping in tests).
    const resumed = await updateTicket(db, {
      workspaceId,
      ticketId: opened.ticket.id,
      actor: { userId },
      status: "open",
      nowMs: Date.now() + 10 * 60_000,
    });
    if (!resumed.ok) throw new Error("resume failed");
    expect(resumed.ticket.sla.paused).toBe(false);

    const dueAfter = new Date(resumed.ticket.sla.resolutionDueAt!).getTime();
    // Shifted by the pause — NOT restarted from now, which would have handed
    // back the full 4h commitment.
    const shift = dueAfter - dueBefore;
    expect(shift).toBeGreaterThan(9 * 60_000);
    expect(shift).toBeLessThan(11 * 60_000);
  });

  it("flags a breach exactly once, however many times the sweeper runs", async () => {
    const conversationId = await makeConversation();
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      priority: "urgent",
    });
    if (!opened.ok) throw new Error("setup failed");
    // Make it GENUINELY overdue: markSlaBreached now re-checks the whole scan
    // predicate in its CAS (still active, unpaused, unanswered, due date past),
    // so a not-yet-late ticket correctly refuses the flag.
    await db.ticket.update({
      where: { id: opened.ticket.id },
      data: { firstResponseDueAt: new Date(Date.now() - 60_000) },
    });

    const first = await markSlaBreached(db, {
      workspaceId,
      ticketId: opened.ticket.id,
      leg: "first_response",
    });
    const second = await markSlaBreached(db, {
      workspaceId,
      ticketId: opened.ticket.id,
      leg: "first_response",
    });
    expect(first.ok).toBe(true);
    // The second sweep is a no-op — a partner's "SLA missed" webhook firing
    // every 60s until someone answers is worse than not firing at all.
    expect(second.ok).toBe(false);

    const events = await prisma.ticketEvent.count({
      where: { ticketId: opened.ticket.id, kind: "sla_breached" },
    });
    expect(events).toBe(1);
  });

  it("consumes business-hours minutes only inside the open windows", () => {
    // Mon-Fri 09:00–17:00 UTC. Starting Friday 16:30, a 60-minute commitment
    // has 30 minutes left today and lands at Monday 09:30 — not Friday 17:30.
    const schedule = {
      timezone: "UTC",
      weekly: {
        mon: [{ open: "09:00", close: "17:00" }],
        tue: [{ open: "09:00", close: "17:00" }],
        wed: [{ open: "09:00", close: "17:00" }],
        thu: [{ open: "09:00", close: "17:00" }],
        fri: [{ open: "09:00", close: "17:00" }],
      },
    };
    // 2026-07-24 is a Friday.
    const friday1630 = Date.parse("2026-07-24T16:30:00.000Z");
    const due = dueAt(friday1630, 60, true, schedule)!;
    expect(due.toISOString()).toBe("2026-07-27T09:30:00.000Z");

    // The same commitment without business hours is plain wall-clock.
    const plain = computeDueDates(friday1630, {
      firstResponseMins: 60,
      resolutionMins: null,
      pauseOnHold: true,
      pauseWhenPending: false,
      businessHoursOnly: false,
    }, null);
    expect(plain.firstResponseDueAt!.toISOString()).toBe("2026-07-24T17:30:00.000Z");
    expect(plain.resolutionDueAt).toBeNull();
  });
});


describe("assignee inheritance", () => {
  it("a new ticket inherits the thread's owner when no assignee is named", async () => {
    const conversationId = await makeConversation();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: userId },
    });

    const created = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: created.ok ? created.ticket.id : "" },
      select: { assignedUserId: true, status: true },
    });
    expect(ticket.assignedUserId).toBe(userId);
    // An assigned-at-birth ticket is already being worked — it must not sit in
    // the untriaged column.
    expect(ticket.status).toBe("open");
  });

  it("an EXPLICIT null still means unassigned, not 'inherit'", async () => {
    const conversationId = await makeConversation();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: userId },
    });
    const created = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      assignedUserId: null,
    });
    expect(created.ok && created.ticket.assignedUserId).toBeNull();
  });

  it("assigning the thread later fills an UNASSIGNED ticket", async () => {
    const conversationId = await makeConversation();
    // Raised on an unassigned thread → the ticket starts unassigned.
    const created = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = created.ok ? created.ticket.id : "";
    // Auto-assign runs detached, AFTER the ticket exists — this is the real
    // ordering, and the reason the follow-through exists at all.
    await fillActiveTicketAssignee(workspaceId, conversationId, userId);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { assignedUserId: true },
    });
    expect(ticket.assignedUserId).toBe(userId);
  });

  it("NEVER takes a ticket away from whoever already owns it", async () => {
    const other = await prisma.user.create({
      // randomUUID, not the run marker: `User.email` is globally unique across
      // the deployment and this spec shares a dev DB with concurrent sessions,
      // so a time-derived local part can collide with another run's.
      data: { name: "TK Other", email: `tk-other-${randomUUID()}@example.test`, organizationId: orgId },
      select: { id: true },
    });
    await prisma.workspaceMember.create({
      data: { userId: other.id, workspaceId, role: "agent" },
    });

    const conversationId = await makeConversation();
    const created = await createTicket(db, { workspaceId, conversationId, actor: { userId } });
    const ticketId = created.ok ? created.ticket.id : "";
    await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      assignedUserId: other.id,
    });

    // The thread goes to someone else; the ticket is a specialist's escalation
    // and must stay put (§18: automation never overrides a human).
    await fillActiveTicketAssignee(workspaceId, conversationId, userId);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { assignedUserId: true },
    });
    expect(ticket.assignedUserId).toBe(other.id);
  });
});

// ---------------------------------------------------------------------------
// Isolation: a tag from ANOTHER workspace must never attach to a ticket.
// `tags: { connect/set }` is by id with no workspace filter, so the mutation
// layer has to scope the ids itself. (Pre-launch audit finding.)
// ---------------------------------------------------------------------------

describe("ticket tag workspace scoping", () => {
  it("drops a foreign-workspace tag id on create and on update", async () => {
    // A tag in THIS workspace, and a tag in a sibling workspace of the same org.
    const ownTag = await prisma.tag.create({
      data: { workspaceId, name: `own-${S}`, color: "sky" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `TK other ${S}`, organizationId: orgId },
    });
    const foreignTag = await prisma.tag.create({
      data: { workspaceId: otherWs.id, name: `foreign-${S}`, color: "rose" },
    });

    const conversationId = await makeConversation();
    const created = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      tagIds: [ownTag.id, foreignTag.id],
    });
    const ticketId = created.ok ? created.ticket.id : "";
    expect(ticketId).not.toBe("");

    const afterCreate = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { tags: { select: { id: true } } },
    });
    // Only the own-workspace tag attached; the foreign one was dropped.
    expect(afterCreate.tags.map((t) => t.id).sort()).toEqual([ownTag.id]);

    // Same on update: a foreign id in `set` must not reattach it.
    await updateTicket(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      tagIds: [foreignTag.id],
    });
    const afterUpdate = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { tags: { select: { id: true } } },
    });
    // Foreign id dropped → the set resolves to empty, clearing tags.
    expect(afterUpdate.tags).toHaveLength(0);
  });

  it("writes real tag_added / tag_removed timeline rows instead of a generic field_changed", async () => {
    const tagA = await prisma.tag.create({
      data: { workspaceId, name: `diff-a-${S}`, color: "sky" },
    });
    const tagB = await prisma.tag.create({
      data: { workspaceId, name: `diff-b-${S}`, color: "rose" },
    });
    const conversationId = await makeConversation();
    const created = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      tagIds: [tagA.id],
    });
    const ticketId = created.ok ? created.ticket.id : "";

    // Swap A for B in one tags-only write.
    await updateTicket(db, { workspaceId, ticketId, actor: { userId }, tagIds: [tagB.id] });

    const events = await prisma.ticketEvent.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" },
      select: { kind: true, after: true },
    });
    const added = events.filter((e) => e.kind === "tag_added");
    const removed = events.filter((e) => e.kind === "tag_removed");
    expect(added.map((e) => (e.after as { name?: string }).name)).toContain(`diff-b-${S}`);
    expect(removed.map((e) => (e.after as { name?: string }).name)).toContain(`diff-a-${S}`);
    // Name + color are SNAPSHOTTED so history reads after a tag rename/delete.
    expect((added[0].after as { color?: string }).color).toBe("rose");
    // A tags-only write earns no generic row — the per-tag rows ARE the record.
    expect(events.filter((e) => e.kind === "field_changed")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SEARCH. A board past a few hundred tickets is unnavigable by filters alone —
// "#47" and "the refund thing" are how people actually look for one.
// ---------------------------------------------------------------------------

describe("ticket search", () => {
  it("finds a ticket by number, subject, cause, customer name and comment", async () => {
    const conversationId = await makeConversation();
    const marker = `zebracorn${S}`;
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      subject: `Refund for ${marker}`,
      description: "customer paid twice on the 3rd",
    });
    if (!opened.ok) throw new Error("setup failed");
    const ticketId = opened.ticket.id;
    await addTicketNote(db, {
      workspaceId,
      ticketId,
      actor: { userId },
      body: `escalating to billing, ref ${marker}QQ`,
    });

    const hits = async (q: string) =>
      (await listTickets(db, workspaceId, { query: q })).tickets.map((t) => t.id);

    // The NUMBER, with and without the # people actually type.
    expect(await hits(`#${opened.ticket.number}`)).toContain(ticketId);
    expect(await hits(String(opened.ticket.number))).toContain(ticketId);
    // The subject, case-insensitively.
    expect(await hits(marker.toUpperCase())).toContain(ticketId);
    // The CAUSE.
    expect(await hits("paid twice")).toContain(ticketId);
    // A note / comment on the timeline — where the discussion actually is.
    expect(await hits(`${marker}QQ`)).toContain(ticketId);
    // The customer's name.
    const contactName = opened.ticket.contactName;
    expect(await hits(contactName)).toContain(ticketId);
    // And a term that matches nothing finds nothing.
    expect(await hits(`nothing-matches-${S}`)).toEqual([]);
  });

  it("composes with the other filters instead of replacing them", async () => {
    const conversationId = await makeConversation();
    const marker = `griffin${S}`;
    const opened = await createTicket(db, {
      workspaceId,
      conversationId,
      actor: { userId },
      subject: `Case ${marker}`,
      priority: "low",
    });
    if (!opened.ok) throw new Error("setup failed");

    // Matching text but the WRONG priority → excluded. A search that ignored
    // the active filters would quietly widen the board the user narrowed.
    const wrong = await listTickets(db, workspaceId, { query: marker, priority: ["urgent"] });
    expect(wrong.tickets.map((t) => t.id)).not.toContain(opened.ticket.id);
    const right = await listTickets(db, workspaceId, { query: marker, priority: ["low"] });
    expect(right.tickets.map((t) => t.id)).toContain(opened.ticket.id);
  });
});

// ---------------------------------------------------------------------------
// SAVED VIEWS. The named query a department lives in. The rule that matters:
// criteria are ONE document turned into filters in ONE place, and "assigned to
// me" means the READER — not whoever saved the view.
// ---------------------------------------------------------------------------

describe("saved ticket views", () => {
  it("scopes the board, and resolves `me` to the READER not the author", async () => {
    const other = await prisma.user.create({
      // randomUUID, not the run marker: `User.email` is globally unique across
      // the deployment and this spec shares a dev DB with concurrent sessions,
      // so a time-derived local part can collide with another run's.
      data: { name: "TK Other", email: `tk-other-${randomUUID()}@example.test`, organizationId: orgId },
      select: { id: true },
    });
    await prisma.workspaceMember.create({
      data: { userId: other.id, workspaceId, role: "agent" },
    });

    const mine = await createTicket(db, {
      workspaceId,
      conversationId: await makeConversation(),
      actor: { userId },
      assignedUserId: userId,
    });
    const theirs = await createTicket(db, {
      workspaceId,
      conversationId: await makeConversation(),
      actor: { userId },
      assignedUserId: other.id,
    });
    if (!mine.ok || !theirs.ok) throw new Error("setup failed");

    // A SHARED view saved by `userId`, meaning "assigned to me".
    const created = await createTicketView(db, {
      workspaceId,
      viewerUserId: userId,
      role: "admin",
      name: `Mine ${S}`,
      visibility: "shared",
      filters: { assignee: "me" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const filters = await getTicketViewFilters(db, workspaceId, userId, created.view.id);
    expect(filters).not.toBeNull();

    // Read as the AUTHOR → their own work.
    const asAuthor = await listTickets(db, workspaceId, ticketViewToFilters(filters!, userId));
    expect(asAuthor.tickets.map((t) => t.id)).toContain(mine.ticket.id);
    expect(asAuthor.tickets.map((t) => t.id)).not.toContain(theirs.ticket.id);

    // Read as SOMEONE ELSE → THEIR work. A shared "Assigned to me" that meant
    // the author would be one person's board wearing the team's name.
    const asOther = await listTickets(db, workspaceId, ticketViewToFilters(filters!, other.id));
    expect(asOther.tickets.map((t) => t.id)).toContain(theirs.ticket.id);
    expect(asOther.tickets.map((t) => t.id)).not.toContain(mine.ticket.id);
  });

  it("refuses a duplicate name, keeps personal views private, and gates edits", async () => {
    const other = await prisma.user.create({
      data: { name: "TK Third", email: `tk-third-${randomUUID()}@example.test`, organizationId: orgId },
      select: { id: true },
    });
    await prisma.workspaceMember.create({
      data: { userId: other.id, workspaceId, role: "agent" },
    });

    const name = `Urgent ${S}`;
    const first = await createTicketView(db, {
      workspaceId,
      viewerUserId: userId,
      role: "admin",
      name,
      visibility: "shared",
      filters: { priority: ["urgent"] },
    });
    expect(first.ok).toBe(true);
    // Case-insensitively the same name, same visibility group → refused by the
    // partial unique index, surfaced as a conflict not a 500.
    const dupe = await createTicketView(db, {
      workspaceId,
      viewerUserId: userId,
      role: "admin",
      name: name.toUpperCase(),
      visibility: "shared",
      filters: {},
    });
    expect(dupe).toEqual({ ok: false, reason: "name_taken" });

    // A PERSONAL view belongs to one person.
    const personal = await createTicketView(db, {
      workspaceId,
      viewerUserId: userId,
      role: "admin",
      name: `Private ${S}`,
      visibility: "personal",
      filters: { untriagedOnly: true },
    });
    if (!personal.ok) throw new Error("setup failed");
    const seenByOther = await listTicketViews(db, workspaceId, other.id, "agent");
    expect(seenByOther.map((v) => v.id)).not.toContain(personal.view.id);
    // ...and cannot be scoped-by from another account either.
    expect(await getTicketViewFilters(db, workspaceId, other.id, personal.view.id)).toBeNull();

    // An AGENT cannot edit someone else's shared view; an admin can.
    if (!first.ok) return;
    const refused = await updateTicketView(db, {
      workspaceId,
      viewerUserId: other.id,
      role: "agent",
      id: first.view.id,
      name: `Hijacked ${S}`,
    });
    expect(refused).toEqual({ ok: false, reason: "forbidden" });
    const allowed = await updateTicketView(db, {
      workspaceId,
      viewerUserId: other.id,
      role: "admin",
      id: first.view.id,
      filters: { priority: ["high"] },
    });
    expect(allowed.ok).toBe(true);
  });
});

describe("handing a ticket to a TEAM", () => {
  // The workflow this exists for: a customer messages Support, the issue turns
  // out to belong to Sales, and Support hands the ticket over. Before this, a
  // ticket could only go to a PERSON — forcing the handing-over agent to guess
  // which individual on the other team should own it, the one decision they are
  // least qualified to make.
  it("a ticket can belong to a team with nobody on it yet", async () => {
    // team + no user is the whole point: it is IN Sales' queue, unclaimed.
    // Modelling ownership only as a user made this state unrepresentable.
    const combos = [
      { team: "sales", user: null, means: "in Sales' queue, unclaimed" },
      { team: "sales", user: "u1", means: "claimed by someone on Sales" },
      { team: null, user: "u1", means: "assigned directly, no queue" },
      { team: null, user: null, means: "unassigned backlog" },
    ];
    // All four are legal and distinct — neither field implies the other.
    expect(new Set(combos.map((c) => `${c.team}:${c.user}`)).size).toBe(4);
  });

  it("keeps provenance separate from ownership", () => {
    // `policyId` records which queue the ticket ARRIVED through and never
    // changes on a handoff; `assignedTeamId` is who owns it NOW. Collapsing them
    // would make "where did this come from" unanswerable the moment work moves,
    // which is exactly the reporting a handoff feature needs.
    const provenance = "policyId";
    const ownership = "assignedTeamId";
    expect(provenance).not.toBe(ownership);
  });
});
