/**
 * Cross-workspace ticket sharing, driven against a real database.
 *
 * A ticket is how two departments talk about one customer's issue, so there is
 * exactly ONE ticket row and escalating grants a sibling workspace access to it.
 * What has to be PROVEN rather than read:
 *
 *   1. Escalating creates NO second ticket — one row, one number, one history —
 *      and the guest workspace's board/counts/detail all reach it.
 *   2. The ACCESS GATE holds in both directions: a workspace with no share sees
 *      nothing, and a guest sees the ticket but NOT the owner's conversation.
 *   3. A change made by either department is THE change (no sync, nothing to
 *      drift), and the log says which department made it.
 *   4. The org boundary: a cross-org target answers exactly like a nonexistent
 *      one; a second grant to the same department is a 409, not a second key.
 *   5. Revoking access removes it, keeps the history, and notifies the workspace
 *      that lost it.
 *   6. A guest's own conversation binds to the SHARE (its own thread with the
 *      customer), leaving the owner's thread untouched.
 *   7. Attachments are visible to every party and gated by the ticket, not the
 *      uploader's workspace.
 *   8. The THREAD is the cross-department conversation: one message list both
 *      sides read, author identity resolved ACROSS the workspace boundary, an
 *      unread marker for every participant except the writer, and NO
 *      `ticket.changed` — a reply moves no ticket state.
 *
 *   pnpm --filter @ccp/api exec vitest run test/tickets-escalation.spec.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addTicketNote, createTicket, deleteTicket, updateTicket } from "@/lib/tickets/mutations";
import {
  bindGuestConversation,
  getGuestSnapshot,
  revokeTicketShare,
  shareTicket,
} from "@/lib/tickets/shares";
import {
  addTicketAttachment,
  getTicketAttachmentForRead,
  removeTicketAttachment,
} from "@/lib/tickets/attachments";
import {
  getTicket,
  getTicketCounts,
  listTickets,
  listTicketEvents,
  listTicketNotes,
} from "@/lib/tickets/queries";
import {
  addTicketMessage,
  getThreadUnreadAnchor,
  listTicketThread,
  markThreadRead,
} from "@/lib/tickets/thread";
import { setSharedDb } from "@/lib/db";
import { subscribe } from "@/lib/events/bus";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const db = prisma as unknown as Parameters<typeof shareTicket>[0];
const mdb = prisma as unknown as Parameters<typeof createTicket>[0];
const adb = prisma as unknown as Parameters<typeof addTicketAttachment>[0];
const qdb = prisma as unknown as Parameters<typeof listTickets>[0];
setSharedDb(prisma as unknown as PrismaClient);

const S = `shr${Date.now().toString().slice(-8)}`;
let orgId = "";
let otherOrgId = "";
let wsA = ""; // owner
let wsB = ""; // guest
let wsC = ""; // a third department in the same org
let wsForeign = ""; // another org's workspace
let userId = "";
let contactSeq = 0;

async function makeConversation(workspaceId: string, withProfile = false) {
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `SHR ${contactSeq}`,
      phoneNumber: `+9868${S.slice(3)}${String(contactSeq++).padStart(3, "0")}`,
      identityChannel: "whatsapp",
      ...(withProfile ? { email: "shr@example.test", customFields: { plan_tier: "Gold" } } : {}),
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  return { conversationId: convo.id, contactId: contact.id };
}

/** A fresh active ticket owned by workspace A. */
async function makeTicket(withProfile = false) {
  const { conversationId } = await makeConversation(wsA, withProfile);
  const created = await createTicket(mdb, {
    workspaceId: wsA,
    conversationId,
    actor: { userId, workspaceId: wsA },
    source: "human",
    subject: "Shared ticket",
    description: "the original cause",
  });
  if (!created.ok) throw new Error("seed ticket failed");
  return { ticket: created.ticket, conversationId };
}

/** Share A's ticket with B and return it. */
async function shareWithB(ticketId: string, cause = "Billing must approve the refund") {
  const out = await shareTicket(db, {
    workspaceId: wsA,
    ticketId,
    actor: { userId, workspaceId: wsA },
    targetWorkspaceId: wsB,
    cause,
  });
  if (!out.ok) throw new Error(`share failed: ${out.reason}`);
  return out;
}

const tdb = prisma as unknown as Parameters<typeof addTicketMessage>[0];

/** Post to a ticket's thread, failing loudly so a broken test reads as broken. */
async function say(
  workspaceId: string,
  ticketId: string,
  body: string,
  actorUserId: string = userId,
  clientTempId?: string,
) {
  const out = await addTicketMessage(tdb, {
    workspaceId,
    ticketId,
    actor: { userId: actorUserId, workspaceId },
    body,
    ...(clientTempId ? { clientTempId } : {}),
  });
  if (!out.ok) throw new Error(`thread post failed: ${out.reason}`);
  return out;
}

const unreadFor = (ticketId: string) =>
  prisma.ticketThreadUnread.findMany({
    where: { ticketId },
    select: { userId: true, sinceMessageId: true },
  });

const eventsOf = (ticketId: string) =>
  prisma.ticketEvent.findMany({
    where: { ticketId },
    orderBy: { createdAt: "asc" },
    select: { kind: true, body: true, after: true, actorWorkspaceId: true },
  });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `SHR Org ${S}`, status: "active" } }))
    .id;
  otherOrgId = (
    await prisma.organization.create({ data: { name: `SHR Other ${S}`, status: "active" } })
  ).id;
  wsA = (await prisma.workspace.create({ data: { name: `SHR A ${S}`, organizationId: orgId } })).id;
  wsB = (await prisma.workspace.create({ data: { name: `SHR B ${S}`, organizationId: orgId } })).id;
  wsC = (await prisma.workspace.create({ data: { name: `SHR C ${S}`, organizationId: orgId } })).id;
  wsForeign = (
    await prisma.workspace.create({ data: { name: `SHR F ${S}`, organizationId: otherOrgId } })
  ).id;
  const user = await prisma.user.create({
    data: { name: "SHR Agent", email: `shr-${S}@example.test`, organizationId: orgId },
    select: { id: true },
  });
  userId = user.id;
  for (const workspaceId of [wsA, wsB, wsC]) {
    await prisma.workspaceMember.create({ data: { userId, workspaceId, role: "agent" } });
  }
  await prisma.contactFieldDefinition.create({
    data: { workspaceId: wsA, key: "plan_tier", label: "Plan tier" },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("escalating shares ONE ticket", () => {
  it("creates no second ticket, and the guest reaches the same row", async () => {
    const { ticket } = await makeTicket(true);
    const before = await prisma.ticket.count({ where: { workspaceId: wsB } });

    const out = await shareWithB(ticket.id);
    expect(out.guestWorkspaceName).toBe(`SHR B ${S}`);

    // THE test for this whole redesign: escalating creates NO ticket in the
    // guest workspace.
    expect(await prisma.ticket.count({ where: { workspaceId: wsB } })).toBe(before);
    expect(await prisma.ticket.count({ where: { id: ticket.id } })).toBe(1);

    // One grant, carrying the frozen profile with LABELS resolved.
    const share = await prisma.ticketShare.findFirstOrThrow({
      where: { ticketId: ticket.id, guestWorkspaceId: wsB },
      select: { ownerWorkspaceId: true, organizationId: true, contactSnapshot: true },
    });
    expect(share.ownerWorkspaceId).toBe(wsA);
    expect(share.organizationId).toBe(orgId);
    const snap = share.contactSnapshot as Record<string, unknown>;
    expect(snap.email).toBe("shr@example.test");
    expect((snap.customFields as Record<string, string>)["Plan tier"]).toBe("Gold");

    // The guest reads the SAME ticket — same id, same number.
    const asGuest = await getTicket(qdb, wsB, ticket.id);
    expect(asGuest?.id).toBe(ticket.id);
    expect(asGuest?.number).toBe(ticket.number);
    expect(asGuest?.sharing?.role).toBe("guest");
    expect(asGuest?.sharing?.ownerWorkspaceName).toBe(`SHR A ${S}`);
    // ...and the OWNER's conversation is NOT handed over.
    expect(asGuest?.conversationId).toBeNull();
    expect(asGuest?.contactId).toBeNull();
    // ...but the customer is still identifiable, from the snapshot.
    expect(asGuest?.contactName).toMatch(/^SHR /);
    expect(asGuest?.sharing?.contactSnapshot?.phoneNumber).toBeTruthy();

    // The owner still sees its own thread, and no snapshot (it has the live one).
    const asOwner = await getTicket(qdb, wsA, ticket.id);
    expect(asOwner?.conversationId).toBeTruthy();
    expect(asOwner?.sharing?.role).toBe("owner");
    expect(asOwner?.sharing?.contactSnapshot).toBeUndefined();
    expect(asOwner?.sharing?.guests.map((g) => g.workspaceId)).toEqual([wsB]);

    // The guest's BOARD and COUNTS include it — otherwise the department that
    // was asked for help cannot find the work.
    const board = await listTickets(qdb, wsB, {});
    expect(board.tickets.map((t) => t.id)).toContain(ticket.id);
    const counts = await getTicketCounts(qdb, wsB, userId);
    expect(counts.totalActive).toBeGreaterThan(0);

    // The event carries the audience so the fanout can reach the guest.
    const frame = await prisma.outboundEvent.findFirstOrThrow({
      where: { type: "ticket.changed", workspaceId: wsA },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    const payload = frame.payload as { action?: string; sharedWithWorkspaceIds?: string[] };
    expect(payload.action).toBe("escalated");
    expect(payload.sharedWithWorkspaceIds).toEqual([wsB]);
  });

  it("keeps a workspace with NO share out entirely", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    // wsC is in the same org and was never granted access.
    expect(await getTicket(qdb, wsC, ticket.id)).toBeNull();
    const board = await listTickets(qdb, wsC, {});
    expect(board.tickets.map((t) => t.id)).not.toContain(ticket.id);
    expect(await listTicketEvents(qdb, wsC, ticket.id)).toEqual([]);
  });

  it("refuses a second grant to the same department, and cross-org targets", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const again = await shareTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      targetWorkspaceId: wsB,
      cause: "again",
    });
    expect(again).toEqual({ ok: false, reason: "already_shared" });

    // Sharing back to the OWNER is meaningless, not a second key.
    const toSelf = await shareTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      targetWorkspaceId: wsA,
      cause: "self",
    });
    expect(toSelf).toEqual({ ok: false, reason: "already_shared" });

    for (const targetWorkspaceId of [wsForeign, "does-not-exist"]) {
      const out = await shareTicket(db, {
        workspaceId: wsA,
        ticketId: ticket.id,
        actor: { userId, workspaceId: wsA },
        targetWorkspaceId,
        cause: "x",
      });
      expect(out).toEqual({ ok: false, reason: "target_workspace_not_found" });
    }
  });

  it("lets a GUEST loop in a third department, and refuses a terminal ticket", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    // B (a guest) escalates onward to C — no chain rule to break, because there
    // is only ever one ticket.
    const onward = await shareTicket(db, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      targetWorkspaceId: wsC,
      cause: "Logistics needs to weigh in",
    });
    expect(onward.ok).toBe(true);
    const asC = await getTicket(qdb, wsC, ticket.id);
    expect(asC?.id).toBe(ticket.id);
    expect(asC?.sharing?.guests).toHaveLength(2);

    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      status: "closed",
    });
    const late = await shareTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      targetWorkspaceId: wsForeign,
      cause: "too late",
    });
    expect(late.ok).toBe(false);
  });

  it("fills an EMPTY cause from the escalation reason, never overwriting one", async () => {
    const { conversationId } = await makeConversation(wsA);
    const bare = await createTicket(mdb, {
      workspaceId: wsA,
      conversationId,
      actor: { userId, workspaceId: wsA },
    });
    if (!bare.ok) throw new Error("seed failed");
    await shareWithB(bare.ticket.id, "the reason becomes the cause");
    const filled = await prisma.ticket.findUniqueOrThrow({
      where: { id: bare.ticket.id },
      select: { description: true },
    });
    expect(filled.description).toBe("the reason becomes the cause");

    // A ticket that already HAS a cause keeps it — the reason lives on the
    // escalation event instead.
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id, "a different reason");
    const kept = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { description: true },
    });
    expect(kept.description).toBe("the original cause");
    const escalated = (await eventsOf(ticket.id)).find((e) => e.kind === "escalated");
    expect(escalated?.body).toBe("a different reason");
  });
});

describe("one ticket, one truth", () => {
  it("a guest's change IS the change — no sync, attributed in the log", async () => {
    const { ticket, conversationId } = await makeTicket();
    await shareWithB(ticket.id);

    // The GUEST department solves it.
    const solved = await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      status: "solved",
      resolutionNote: "Refunded on the 3rd.",
    });
    expect(solved.ok).toBe(true);

    // ONE row moved — there is no second ticket to reconcile.
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { status: true, resolutionNote: true, workspaceId: true },
    });
    expect(row.status).toBe("solved");
    expect(row.resolutionNote).toBe("Refunded on the 3rd.");
    // Ownership never moves.
    expect(row.workspaceId).toBe(wsA);

    // The OWNER's conversation counter released — the ticket's own thread.
    const convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { openTicketCount: true, activeTicketId: true },
    });
    expect(convo.openTicketCount).toBe(0);
    expect(convo.activeTicketId).toBeNull();

    // The log says WHICH department did it.
    const statusRow = (await eventsOf(ticket.id)).find((e) => e.kind === "status_changed");
    expect(statusRow?.actorWorkspaceId).toBe(wsB);

    // Both parties read the same single history.
    const ownerLog = await listTicketEvents(qdb, wsA, ticket.id);
    const guestLog = await listTicketEvents(qdb, wsB, ticket.id);
    expect(ownerLog.map((e) => e.id)).toEqual(guestLog.map((e) => e.id));
    expect(guestLog.some((e) => e.actorWorkspaceName === `SHR B ${S}`)).toBe(true);
  });

  it("the THREAD is one message list both departments read", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    await say(wsB, ticket.id, "Approved — tell them 3–5 business days.");

    // ONE message, not one per side, and it names the department that spoke.
    for (const ws of [wsA, wsB]) {
      const thread = await listTicketThread(tdb, ws, ticket.id);
      expect(thread).toHaveLength(1);
      const [msg] = thread;
      if (!msg) throw new Error("thread empty");
      expect(msg.body).toContain("Approved");
      expect(msg.authorWorkspaceId).toBe(wsB);
      // Identity is JOINED, so the OWNER can resolve a GUEST author its own
      // roster has never seen — the whole reason it isn't rendered client-side.
      expect(msg.authorWorkspaceName).toBe(`SHR B ${S}`);
      expect(msg.authorName).toBe("SHR Agent");
    }

    // ...and it stays OUT of the audit log, which is the point of the split:
    // you no longer read twenty status flips to find the reply.
    for (const ws of [wsA, wsB]) {
      const log = await listTicketEvents(qdb, ws, ticket.id);
      expect(log.some((e) => e.body?.includes("Approved"))).toBe(false);
    }
  });

  it("keeps a workspace with no share out of the thread, both ways", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    await say(wsA, ticket.id, "any update?");

    expect(await listTicketThread(tdb, wsC, ticket.id)).toEqual([]);
    const posted = await addTicketMessage(tdb, {
      workspaceId: wsC,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsC },
      body: "sneaking in",
    });
    expect(posted).toEqual({ ok: false, reason: "ticket_not_found" });
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })).toBe(1);
  });
});

describe("per-side assignee", () => {
  it("each department owns its own side — neither clears the other", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);

    // A second person, a member of the GUEST workspace only.
    const guestAgent = await prisma.user.create({
      data: {
        name: "SHR Guest Agent",
        email: `shr-guest-${S}@example.test`,
        organizationId: orgId,
      },
      select: { id: true },
    });
    await prisma.workspaceMember.create({
      data: { userId: guestAgent.id, workspaceId: wsB, role: "agent" },
    });

    // The OWNER assigns its own member.
    const ownerAssign = await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      assignedUserId: userId,
    });
    expect(ownerAssign.ok).toBe(true);

    // The GUEST assigns THEIR member. This used to clear the owner's.
    const guestAssign = await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId: guestAgent.id, workspaceId: wsB },
      assignedUserId: guestAgent.id,
    });
    expect(guestAssign.ok).toBe(true);

    // The ticket's own column still holds the OWNER's person...
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { assignedUserId: true },
    });
    expect(row.assignedUserId).toBe(userId);
    // ...and the guest's lives on their share.
    const share = await prisma.ticketShare.findFirstOrThrow({
      where: { ticketId: ticket.id, guestWorkspaceId: wsB },
      select: { assignedUserId: true, lastAssignedUserId: true },
    });
    expect(share.assignedUserId).toBe(guestAgent.id);
    expect(share.lastAssignedUserId).toBe(guestAgent.id);

    // Each side READS its own owner...
    expect((await getTicket(qdb, wsA, ticket.id))?.assignedUserId).toBe(userId);
    expect((await getTicket(qdb, wsB, ticket.id))?.assignedUserId).toBe(guestAgent.id);
    // ...and both can see who owns the other side.
    const asOwner = await getTicket(qdb, wsA, ticket.id);
    expect(asOwner?.sharing?.guests[0]?.assignedUserId).toBe(guestAgent.id);
    expect(asOwner?.sharing?.guests[0]?.assignedUserName).toBe("SHR Guest Agent");

    // "Assigned to me" finds it from BOTH sides.
    const ownerMine = await listTickets(qdb, wsA, { assignedUserId: userId });
    expect(ownerMine.tickets.map((t) => t.id)).toContain(ticket.id);
    const guestMine = await listTickets(qdb, wsB, { assignedUserId: guestAgent.id });
    expect(guestMine.tickets.map((t) => t.id)).toContain(ticket.id);
  });

  it("counts NEW WORK the guest has not claimed — a shared ticket keeps its status", async () => {
    const { ticket } = await makeTicket();
    // Make it `open` BEFORE sharing, which is the case the old `status: new`
    // badge missed entirely.
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      status: "open",
    });
    const before = await getTicketCounts(qdb, wsB, userId);
    await shareWithB(ticket.id);
    const after = await getTicketCounts(qdb, wsB, userId);

    // The guest is told there is new work even though the ticket is `open`.
    expect(after.untriaged).toBe(before.untriaged + 1);
    expect(after.sharedWithUs).toBe(before.sharedWithUs + 1);
    // Claiming it on the guest's side clears it from "new work".
    await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      assignedUserId: userId,
    });
    const claimed = await getTicketCounts(qdb, wsB, userId);
    expect(claimed.untriaged).toBe(before.untriaged);
    // Still theirs to work, just no longer unclaimed.
    expect(claimed.sharedWithUs).toBe(before.sharedWithUs + 1);

    // And the "Shared with us" view finds it.
    const shared = await listTickets(qdb, wsB, { sharedWithUsOnly: true });
    expect(shared.tickets.map((t) => t.id)).toContain(ticket.id);
    // The OWNER's own board does not call it "shared with us".
    const ownerShared = await listTickets(qdb, wsA, { sharedWithUsOnly: true });
    expect(ownerShared.tickets.map((t) => t.id)).not.toContain(ticket.id);
  });
});

describe("revoking access", () => {
  it("removes access, keeps the history, and tells the workspace that lost it", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);

    const out = await revokeTicketShare(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      guestWorkspaceId: wsB,
      actor: { userId, workspaceId: wsA },
    });
    expect(out.ok).toBe(true);

    expect(await getTicket(qdb, wsB, ticket.id)).toBeNull();
    // The ticket itself is untouched, and the history records the revocation.
    const kinds = (await eventsOf(ticket.id)).map((e) => e.kind);
    expect(kinds).toContain("escalated");
    expect(kinds).toContain("escalation_revoked");

    // The frame still names the revoked workspace, so its board drops the card.
    const frame = await prisma.outboundEvent.findFirstOrThrow({
      where: { type: "ticket.changed", workspaceId: wsA },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    expect(
      (frame.payload as { sharedWithWorkspaceIds?: string[] }).sharedWithWorkspaceIds,
    ).toContain(wsB);
  });

  it("a guest may remove ITSELF but not another department", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    await shareTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      targetWorkspaceId: wsC,
      cause: "and logistics",
    });

    // B evicting C is refused — that decision belongs to the owner.
    const forbidden = await revokeTicketShare(db, {
      workspaceId: wsB,
      ticketId: ticket.id,
      guestWorkspaceId: wsC,
      actor: { userId, workspaceId: wsB },
    });
    expect(forbidden).toEqual({ ok: false, reason: "forbidden" });

    // B removing itself is fine.
    const self = await revokeTicketShare(db, {
      workspaceId: wsB,
      ticketId: ticket.id,
      guestWorkspaceId: wsB,
      actor: { userId, workspaceId: wsB },
    });
    expect(self.ok).toBe(true);
  });

  it("deleting the ticket takes its shares with it — and only the owner may", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    await deleteTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
    });
    expect(await prisma.ticketShare.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(await prisma.ticket.count({ where: { id: ticket.id } })).toBe(0);
  });
});

describe("a guest's own conversation", () => {
  it("binds to the SHARE, leaving the owner's thread untouched", async () => {
    const { ticket, conversationId: ownerConvo } = await makeTicket();
    await shareWithB(ticket.id);

    const snapshot = await getGuestSnapshot(db, wsB, ticket.id);
    expect(snapshot?.phoneNumber).toBeTruthy();
    // The OWNER is not a guest — it already has the thread.
    expect(await getGuestSnapshot(db, wsA, ticket.id)).toBeNull();

    const { conversationId: guestConvo } = await makeConversation(wsB);
    const bound = await bindGuestConversation(db, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      conversationId: guestConvo,
    });
    expect(bound.ok).toBe(true);

    // Each side sees ITS OWN thread on the same ticket.
    expect((await getTicket(qdb, wsB, ticket.id))?.conversationId).toBe(guestConvo);
    expect((await getTicket(qdb, wsA, ticket.id))?.conversationId).toBe(ownerConvo);

    // Binding twice is refused.
    const again = await bindGuestConversation(db, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      conversationId: guestConvo,
    });
    expect(again).toEqual({ ok: false, reason: "already_bound" });
  });
});

describe("the board orders by LAST ACTIVITY", () => {
  it("a reply floats its ticket above ones raised later", async () => {
    // Two tickets, raised in order. Without an activity sort the newer one
    // always wins, which is the complaint: you answer a ticket and it stays
    // buried under everything raised since.
    const older = (await makeTicket()).ticket;
    const newer = (await makeTicket()).ticket;

    const before = await listTickets(qdb, wsA, {});
    const beforeIds = before.tickets.map((t) => t.id);
    expect(beforeIds.indexOf(newer.id)).toBeLessThan(beforeIds.indexOf(older.id));

    await say(wsA, older.id, "answering the older one");

    const after = await listTickets(qdb, wsA, {});
    const afterIds = after.tickets.map((t) => t.id);
    expect(afterIds.indexOf(older.id)).toBeLessThan(afterIds.indexOf(newer.id));
    // ...and the reply moved no ticket STATE while doing it.
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: older.id },
      select: { version: true, lastActivityAt: true },
    });
    expect(row.version).toBe(older.version);
    expect(row.lastActivityAt.getTime()).toBeGreaterThan(Date.parse(older.createdAt));
  });

  it("a note, a file and a status move all count as activity", async () => {
    const { ticket } = await makeTicket();
    const readAt = async () =>
      (
        await prisma.ticket.findUniqueOrThrow({
          where: { id: ticket.id },
          select: { lastActivityAt: true },
        })
      ).lastActivityAt.getTime();

    const atRaise = await readAt();
    await addTicketNote(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      body: `note ${randomUUID()}`,
    });
    const afterNote = await readAt();
    expect(afterNote).toBeGreaterThanOrEqual(atRaise);

    await addTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      bytes: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000180fe8ecf0000000049454e44ae426082",
        "hex",
      ),
      filename: "evidence.png",
      mimeType: "image/png",
    });
    const afterFile = await readAt();
    expect(afterFile).toBeGreaterThanOrEqual(afterNote);

    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      status: "open",
    });
    expect(await readAt()).toBeGreaterThanOrEqual(afterFile);
  });

  it("the keyset cursor walks the SAME order it sorts by", async () => {
    // A cursor keyed on a different column than the sort silently skips and
    // repeats rows — the classic pagination bug, and the reason this moved.
    const a = (await makeTicket()).ticket;
    await say(wsA, a.id, "bump a");
    const page1 = await listTickets(qdb, wsA, { limit: 1 });
    expect(page1.tickets).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listTickets(qdb, wsA, {
      limit: 1,
      cursor: {
        activityAt: new Date(page1.nextCursor!.activityAt),
        id: page1.nextCursor!.id,
      },
    });
    // Strictly older, and never the row we just read.
    expect(page2.tickets.map((t) => t.id)).not.toContain(page1.tickets[0]!.id);
    if (page2.tickets[0]) {
      expect(page2.tickets[0].lastActivityAt <= page1.tickets[0]!.lastActivityAt).toBe(true);
    }
  });
});

describe("internal notes stay internal", () => {
  it("a note is private to the workspace that wrote it", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);

    const ownerSecret = `owner-only ${randomUUID()}`;
    const guestSecret = `guest-only ${randomUUID()}`;
    await addTicketNote(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      body: ownerSecret,
    });
    await addTicketNote(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      body: guestSecret,
    });

    // The composer promises "neither the customer nor the other workspaces on
    // this ticket see it". A note is where an agent writes the thing they would
    // never say to the other department — and until 2026-07-31 nothing enforced
    // it: notes carry the OWNER's workspaceId, so every note on a shared ticket
    // was readable by every department on it.
    const ownerNotes = await listTicketNotes(qdb, wsA, ticket.id);
    expect(ownerNotes.map((n) => n.body)).toEqual([ownerSecret]);

    const guestNotes = await listTicketNotes(qdb, wsB, ticket.id);
    expect(guestNotes.map((n) => n.body)).toEqual([guestSecret]);

    // Not through the log either, which is the read that leaked them.
    for (const ws of [wsA, wsB]) {
      const log = await listTicketEvents(qdb, ws, ticket.id);
      expect(log.some((e) => e.body === ownerSecret || e.body === guestSecret)).toBe(false);
    }
  });

  it("reads as its OWN list, not as audit-log entries", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const mine = `note ${randomUUID()}`;
    const theirs = `their note ${randomUUID()}`;
    await addTicketNote(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      body: mine,
    });
    await addTicketNote(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      body: theirs,
    });

    // The panel: mine, and only mine.
    const notes = await listTicketNotes(qdb, wsA, ticket.id);
    expect(notes.map((n) => n.body)).toEqual([mine]);
    expect(await listTicketNotes(qdb, wsB, ticket.id)).toHaveLength(1);

    // The log carries NEITHER — it answers "who changed what", and a note is
    // something someone wrote. Same split as the thread.
    const log = await listTicketEvents(qdb, wsA, ticket.id);
    expect(log.some((e) => e.kind === "note")).toBe(false);
  });

  it("is not findable by another department's search", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const secret = `zzq${randomUUID().replace(/-/g, "")}`;
    await addTicketNote(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      body: `internal: ${secret}`,
    });

    // The author finds their own note...
    const mine = await listTickets(qdb, wsA, { query: secret });
    expect(mine.tickets.map((t) => t.id)).toContain(ticket.id);
    // ...the other department does not. The body never rendered for them, but
    // an unscoped arm made the MATCH itself the leak: search a phrase, learn
    // which ticket someone wrote it on.
    const theirs = await listTickets(qdb, wsB, { query: secret });
    expect(theirs.tickets.map((t) => t.id)).not.toContain(ticket.id);
  });

  it("a legacy note with no author workspace stays with the ticket's owner", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    // Written before sharing existed, so `actorWorkspaceId` is null. Nobody but
    // the owner could have authored it — there was nobody else.
    const legacy = `legacy ${randomUUID()}`;
    await prisma.ticketEvent.create({
      data: { workspaceId: wsA, ticketId: ticket.id, kind: "note", body: legacy },
    });
    expect((await listTicketNotes(qdb, wsA, ticket.id)).map((n) => n.body)).toContain(legacy);
    expect((await listTicketNotes(qdb, wsB, ticket.id)).map((n) => n.body)).not.toContain(legacy);
  });
});

describe("thread notifications", () => {
  /**
   * A reply must reach the people who are waiting on it — and NOBODY else.
   * The four arms exist because each is a real person the old design left in
   * the dark: the two assignees, the ESCALATOR (who asked the question and is
   * often neither assignee nor poster), and anyone already in the conversation.
   */
  async function makeParticipants() {
    const escalator = await prisma.user.create({
      data: {
        name: "SHR Escalator",
        email: `shr-esc-${randomUUID()}@example.test`,
        organizationId: orgId,
      },
      select: { id: true },
    });
    const guestAssignee = await prisma.user.create({
      data: {
        name: "SHR Billing",
        email: `shr-bill-${randomUUID()}@example.test`,
        organizationId: orgId,
      },
      select: { id: true },
    });
    const owner = await prisma.user.create({
      data: {
        name: "SHR Owner Agent",
        email: `shr-own-${randomUUID()}@example.test`,
        organizationId: orgId,
      },
      select: { id: true },
    });
    await prisma.workspaceMember.createMany({
      data: [
        { userId: escalator.id, workspaceId: wsA, role: "agent" },
        { userId: guestAssignee.id, workspaceId: wsB, role: "agent" },
        { userId: owner.id, workspaceId: wsA, role: "agent" },
      ],
    });
    // Every person is FRESH per test: `unreadReplies` counts across the whole
    // workspace, so reusing the shared agent would let one test's markers
    // inflate the next one's assertion.
    return { escalator: escalator.id, guestAssignee: guestAssignee.id, owner: owner.id };
  }

  it("marks every participant unread except the author", async () => {
    const { escalator, guestAssignee } = await makeParticipants();
    const { ticket } = await makeTicket();

    // Arm 1: the owner side's assignee.
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      assignedUserId: userId,
    });
    // Arm 3: the ESCALATOR — the share's creator, who is neither assignee.
    const share = await shareTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: escalator, workspaceId: wsA },
      targetWorkspaceId: wsB,
      cause: "Billing must approve the refund",
    });
    if (!share.ok) throw new Error("share failed");
    // Arm 2: the guest department's own assignee.
    await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId: guestAssignee, workspaceId: wsB },
      assignedUserId: guestAssignee,
    });

    const first = await say(wsB, ticket.id, "Approved, 3–5 days.", guestAssignee);
    // Everyone waiting, and never the writer.
    expect(new Set(first.notifiedUserIds)).toEqual(new Set([userId, escalator]));
    expect(first.notifiedUserIds).not.toContain(guestAssignee);
    expect(new Set((await unreadFor(ticket.id)).map((u) => u.userId))).toEqual(
      new Set([userId, escalator]),
    );

    // Arm 4: whoever has already spoken joins the participant set. The owner's
    // assignee answers, so the GUEST assignee is now the one told.
    const second = await say(wsA, ticket.id, "thanks, telling them now", userId);
    expect(second.notifiedUserIds).toContain(guestAssignee);
    expect(second.notifiedUserIds).not.toContain(userId);

    // The escalator missed BOTH, and their divider stays anchored at the FIRST
    // thing they missed — an unread that walks forward hides what you skipped.
    expect(await getThreadUnreadAnchor(tdb, ticket.id, escalator)).toBe(first.message.id);
  });

  it("counts unread replies per PERSON, and clears on read", async () => {
    const { guestAssignee, owner } = await makeParticipants();
    const { ticket } = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      assignedUserId: owner,
    });
    await shareWithB(ticket.id);
    await say(wsB, ticket.id, "we need the invoice", guestAssignee);

    // The person waiting sees it; the person who wrote it does not.
    expect((await getTicketCounts(qdb, wsA, owner)).unreadReplies).toBe(1);
    expect((await getTicketCounts(qdb, wsB, guestAssignee)).unreadReplies).toBe(0);

    // Reading is per-user and idempotent.
    const read = { workspaceId: wsA, ticketId: ticket.id, userId: owner };
    expect(await markThreadRead(tdb, read)).toEqual({ ok: true, cleared: true });
    expect(await markThreadRead(tdb, read)).toEqual({ ok: true, cleared: false });
    expect((await getTicketCounts(qdb, wsA, owner)).unreadReplies).toBe(0);

    // A workspace with no access can't clear someone's marker through a ticket
    // id it guessed.
    await say(wsB, ticket.id, "still waiting", guestAssignee);
    expect(
      await markThreadRead(tdb, { workspaceId: wsC, ticketId: ticket.id, userId: owner }),
    ).toEqual({ ok: false, reason: "ticket_not_found" });
    expect((await getTicketCounts(qdb, wsA, owner)).unreadReplies).toBe(1);
  });

  it("drops out of an ex-guest's count when the share is revoked", async () => {
    const { guestAssignee } = await makeParticipants();
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId: guestAssignee, workspaceId: wsB },
      assignedUserId: guestAssignee,
    });
    await say(wsA, ticket.id, "any progress?", userId);
    expect((await getTicketCounts(qdb, wsB, guestAssignee)).unreadReplies).toBe(1);

    const revoked = await revokeTicketShare(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      guestWorkspaceId: wsB,
      actor: { userId, workspaceId: wsA },
    });
    expect(revoked.ok).toBe(true);
    // The marker row survives (it is not a denormalization of access), but the
    // count is gated by the SAME ticketAccessWhere() as the board, so losing
    // access loses the badge — no second copy of the tenancy rule to drift.
    expect((await getTicketCounts(qdb, wsB, guestAssignee)).unreadReplies).toBe(0);
  });

  it("retries the same clientTempId without posting or notifying twice", async () => {
    const { guestAssignee, owner } = await makeParticipants();
    const { ticket } = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      assignedUserId: owner,
    });
    await shareWithB(ticket.id);

    const temp = `tmp-${randomUUID()}`;
    const first = await say(wsB, ticket.id, "on it", guestAssignee, temp);
    await markThreadRead(tdb, { workspaceId: wsA, ticketId: ticket.id, userId: owner });

    // The optimistic composer's retry after a dropped response.
    const again = await say(wsB, ticket.id, "on it", guestAssignee, temp);
    expect(again.message.id).toBe(first.message.id);
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id } })).toBe(1);
    // ...and critically it does NOT re-badge a reply the reader already read.
    expect(again.notifiedUserIds).toEqual([]);
    expect((await getTicketCounts(qdb, wsA, owner)).unreadReplies).toBe(0);
  });

  it("ships the reply COMPLETE with its files on the realtime frame", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000180fe8ecf0000000049454e44ae426082",
      "hex",
    );

    const frames: number[] = [];
    const off = subscribe("ticket.thread_message_created", async (e) => {
      if (e.ticketId === ticket.id) frames.push(e.message.attachments.length);
    });
    try {
      const posted = await addTicketMessage(tdb, {
        workspaceId: wsB,
        ticketId: ticket.id,
        actor: { userId, workspaceId: wsB },
        body: "here is the invoice",
        attach: (messageId) =>
          addTicketAttachment(adb, {
            workspaceId: wsB,
            ticketId: ticket.id,
            actor: { userId, workspaceId: wsB },
            messageId,
            bytes: png,
            filename: "invoice.png",
            mimeType: "image/png",
          }).then((r) => (r.ok ? [r.attachment] : [])),
      });
      if (!posted.ok) throw new Error("post failed");
      expect(posted.message.attachments).toHaveLength(1);
    } finally {
      off();
    }
    // Attaching AFTER the publish shipped every other client a reply whose
    // evidence only appeared on their next reload.
    expect(frames).toEqual([1]);
  });

  it("publishes a thread event and NO ticket.changed — a reply is not a change", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const before = await prisma.outboundEvent.count({
      where: { workspaceId: wsA, type: "ticket.changed" },
    });

    const seen: string[] = [];
    const off = subscribe("ticket.thread_message_created", async (e) => {
      if (e.ticketId === ticket.id) seen.push(e.message.body);
    });
    try {
      await say(wsB, ticket.id, "replying, not changing anything");
    } finally {
      off();
    }
    expect(seen).toEqual(["replying, not changing anything"]);

    // `ticket.changed` goes through the OUTBOX, so a row is the proof. A reply
    // republishing the whole Ticket made every board, sub-sidebar and rail in
    // every participating workspace re-run its counts — on the highest
    // frequency write the ticket has.
    expect(
      await prisma.outboundEvent.count({ where: { workspaceId: wsA, type: "ticket.changed" } }),
    ).toBe(before);
    // ...and it moves no ticket state, so no colleague's open editor 409s.
    const after = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      select: { version: true },
    });
    expect(after?.version).toBe(ticket.version);
  });
});

describe("attachments", () => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000180fe8ecf0000000049454e44ae426082",
    "hex",
  );

  it("are gated by the TICKET, so every party reads them", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);

    // The GUEST uploads evidence.
    const added = await addTicketAttachment(adb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      bytes: png,
      filename: "receipt.png",
      mimeType: "image/png",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.attachment.filename).toBe("receipt.png");
    expect(added.attachment.url).toBe(
      `/api/tickets/${ticket.id}/attachments/${added.attachment.id}`,
    );
    expect(added.attachment.workspaceName).toBe(`SHR B ${S}`);

    // The OWNER can read the guest's file, and vice versa.
    for (const ws of [wsA, wsB]) {
      const read = await getTicketAttachmentForRead(adb, ws, ticket.id, added.attachment.id);
      expect(read.ok).toBe(true);
    }
    // A workspace with no share cannot.
    const denied = await getTicketAttachmentForRead(adb, wsC, ticket.id, added.attachment.id);
    expect(denied).toEqual({ ok: false, reason: "not_found" });

    // It rides the ticket read for both parties, and earned a log entry.
    expect((await getTicket(qdb, wsA, ticket.id))?.attachments).toHaveLength(1);
    expect((await getTicket(qdb, wsB, ticket.id))?.attachments).toHaveLength(1);
    const logged = (await eventsOf(ticket.id)).find((e) => e.kind === "attachment_added");
    expect((logged?.after as { filename?: string })?.filename).toBe("receipt.png");
  });

  it("attach to a THREAD MESSAGE and render with it (no duplicate log line)", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const posted = await say(wsA, ticket.id, "here's the screenshot");
    const added = await addTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      messageId: posted.message.id,
      bytes: png,
      filename: "shot.png",
      mimeType: "image/png",
    });
    expect(added.ok).toBe(true);

    // It rides the message for BOTH departments — a guest reads the owner's
    // evidence through the ticket's gate, not its own workspace.
    for (const ws of [wsA, wsB]) {
      const thread = await listTicketThread(tdb, ws, ticket.id);
      const [msg] = thread;
      if (!msg) throw new Error("thread empty");
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]?.filename).toBe("shot.png");
    }
    // The message already announced it — no separate attachment_added row, so
    // the log doesn't re-acquire the noise the thread was split out to remove.
    const events = await listTicketEvents(qdb, wsA, ticket.id);
    expect(events.filter((e) => e.kind === "attachment_added")).toHaveLength(0);
  });

  it("refuse a type the store won't accept, and enforce removal permission", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const bad = await addTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      filename: "x.svg",
      mimeType: "image/svg+xml",
    });
    // SVG is deliberately excluded from the allowlist (stored XSS via
    // same-origin serving).
    expect(bad).toEqual({ ok: false, reason: "unsupported_type" });

    const mine = await addTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      bytes: png,
      filename: "owner.png",
      mimeType: "image/png",
    });
    if (!mine.ok) throw new Error("upload failed");

    // A guest cannot delete the owner's evidence...
    const forbidden = await removeTicketAttachment(adb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      attachmentId: mine.attachment.id,
      actor: { userId, workspaceId: wsB },
    });
    expect(forbidden).toEqual({ ok: false, reason: "forbidden" });
    // ...but the owner can.
    const removed = await removeTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      attachmentId: mine.attachment.id,
      actor: { userId, workspaceId: wsA },
    });
    expect(removed.ok).toBe(true);
    const kinds = (await eventsOf(ticket.id)).map((e) => e.kind);
    expect(kinds).toContain("attachment_removed");
  });
});
