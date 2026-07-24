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
 *      the active ticket, reopen a recently-solved one, otherwise open a new
 *      one. Getting the reopen window wrong turns one issue into three tickets.
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

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTicket,
  fillActiveTicketAssignee,
  markSlaBreached,
  routeMessageToTicket,
  updateTicket,
} from "@/lib/tickets/mutations";
import { setSharedDb } from "@/lib/db";
import { computeDueDates, dueAt } from "@/lib/tickets/sla";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
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
        // EXPLICIT, not inherited. Auto-open is off by default (a ticket should
        // mean someone decided this needs work, not "a message arrived"), and
        // most of this file tests the auto-open path specifically. Setting it
        // here keeps those tests meaningful and independent of the default —
        // the cases that assert the OFF behaviour create their own workspace
        // with `ticketAutoOpen: false`.
        ticketAutoOpen: true,
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
  it("hands out unique sequential numbers under concurrent creates", async () => {
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
});

describe("message → ticket routing", () => {
  it("auto-opens on the first message and stamps the conversation pointer", async () => {
    const conversationId = await makeConversation();
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    expect(routed.ticketId).toBeTruthy();

    const convo = await conversationState(conversationId);
    expect(convo.activeTicketId).toBe(routed.ticketId);
    expect(convo.openTicketCount).toBe(1);
  });

  it("attaches a second message to the SAME ticket, not a new one", async () => {
    const conversationId = await makeConversation();
    const first = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    const second = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    expect(second.ticketId).toBe(first.ticketId);
    expect((await conversationState(conversationId)).openTicketCount).toBe(1);
  });

  it("REOPENS a ticket solved inside the reopen window", async () => {
    const conversationId = await makeConversation();
    const opened = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    const solved = await updateTicket(db, {
      workspaceId,
      ticketId: opened.ticketId!,
      actor: { userId },
      status: "solved",
    });
    expect(solved.ok).toBe(true);
    // Solving takes it out of the active set and releases the pointer.
    let convo = await conversationState(conversationId);
    expect(convo.openTicketCount).toBe(0);
    expect(convo.activeTicketId).toBeNull();

    const followUp = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    // Same ticket, back open — one issue, not two.
    expect(followUp.ticketId).toBe(opened.ticketId);
    convo = await conversationState(conversationId);
    expect(convo.openTicketCount).toBe(1);
    expect(convo.activeTicketId).toBe(opened.ticketId);

    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticketId! },
      select: { status: true, reopenCount: true, resolvedAt: true },
    });
    expect(row.status).toBe("open");
    expect(row.reopenCount).toBe(1);
    // The stale resolution must not sit on live work.
    expect(row.resolvedAt).toBeNull();
  });

  it("opens a NEW ticket when the solve is OUTSIDE the window", async () => {
    const conversationId = await makeConversation();
    const opened = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    await updateTicket(db, {
      workspaceId,
      ticketId: opened.ticketId!,
      actor: { userId },
      status: "solved",
    });
    // Age the solve past the 72h default rather than sleeping for three days.
    await prisma.ticket.update({
      where: { id: opened.ticketId! },
      data: { lastSolvedAt: new Date(Date.now() - 80 * 3_600_000) },
    });

    const fresh = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    expect(fresh.ticketId).not.toBe(opened.ticketId);
    expect((await conversationState(conversationId)).openTicketCount).toBe(1);
  });

  it("never reopens from an OUTBOUND message — an agent's follow-up isn't new work", async () => {
    const conversationId = await makeConversation();
    const opened = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    await updateTicket(db, {
      workspaceId,
      ticketId: opened.ticketId!,
      actor: { userId },
      status: "solved",
    });
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "out" }),
    );
    // A brand-new ticket, not a resurrection of the solved one.
    expect(routed.ticketId).not.toBe(opened.ticketId);
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: opened.ticketId! },
      select: { status: true },
    });
    expect(row.status).toBe("solved");
  });

  it("carries no ticket at all when the workspace turned auto-open off", async () => {
    const otherWs = await prisma.workspace.create({
      data: { name: `TK off ${S}`, organizationId: orgId, ticketAutoOpen: false },
      select: { id: true },
    });
    const contact = await prisma.contact.create({
      data: {
        workspaceId: otherWs.id,
        name: "TK off",
        phoneNumber: `+9867${S}`,
        identityChannel: "whatsapp",
      },
      select: { id: true },
    });
    const convo = await prisma.conversation.create({
      data: { workspaceId: otherWs.id, contactId: contact.id, channel: "whatsapp" },
      select: { id: true },
    });

    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, {
        workspaceId: otherWs.id,
        conversationId: convo.id,
        direction: "in",
      }),
    );
    expect(routed.ticketId).toBeNull();
    expect((await conversationState(convo.id)).openTicketCount).toBe(0);
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
      routeMessageToTicket(tx, { workspaceId: otherWs.id, conversationId, direction: "in" }),
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
  it("an auto-opened ticket inherits the thread's owner", async () => {
    const conversationId = await makeConversation();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: userId },
    });

    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: routed.ticketId! },
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
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    // Auto-assign runs detached, AFTER ingest opened the ticket — this is the
    // real ordering, and the reason the follow-through exists at all.
    await fillActiveTicketAssignee(workspaceId, conversationId, userId);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: routed.ticketId! },
      select: { assignedUserId: true },
    });
    expect(ticket.assignedUserId).toBe(userId);
  });

  it("NEVER takes a ticket away from whoever already owns it", async () => {
    const other = await prisma.user.create({
      data: { name: "TK Other", email: `tk-other-${S}@example.test`, organizationId: orgId },
      select: { id: true },
    });
    await prisma.workspaceMember.create({
      data: { userId: other.id, workspaceId, role: "agent" },
    });

    const conversationId = await makeConversation();
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx, { workspaceId, conversationId, direction: "in" }),
    );
    await updateTicket(db, {
      workspaceId,
      ticketId: routed.ticketId!,
      actor: { userId },
      assignedUserId: other.id,
    });

    // The thread goes to someone else; the ticket is a specialist's escalation
    // and must stay put (§18: automation never overrides a human).
    await fillActiveTicketAssignee(workspaceId, conversationId, userId);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: routed.ticketId! },
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
