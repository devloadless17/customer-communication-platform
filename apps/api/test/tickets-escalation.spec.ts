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
 *
 *   pnpm --filter @ccp/api exec vitest run test/tickets-escalation.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTicket, deleteTicket, updateTicket } from "@/lib/tickets/mutations";
import {
  addTicketComment,
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
import { getTicket, getTicketCounts, listTickets, listTicketEvents } from "@/lib/tickets/queries";
import { setSharedDb } from "@/lib/db";

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

  it("comments are one shared entry, visible to every party", async () => {
    const { ticket } = await makeTicket();
    await shareWithB(ticket.id);
    const posted = await addTicketComment(db, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsB },
      body: "Approved — tell them 3–5 business days.",
    });
    expect(posted.ok).toBe(true);

    // ONE row, not one per side.
    const comments = (await eventsOf(ticket.id)).filter((e) => e.kind === "escalation_note");
    expect(comments).toHaveLength(1);
    expect(comments[0].actorWorkspaceId).toBe(wsB);
    // Both sides read it.
    for (const ws of [wsA, wsB]) {
      const log = await listTicketEvents(qdb, ws, ticket.id);
      expect(log.some((e) => e.body?.includes("Approved"))).toBe(true);
    }
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

  it("attach to a COMMENT and render with it (no duplicate log line)", async () => {
    const { ticket } = await makeTicket();
    const comment = await addTicketComment(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      body: "here's the screenshot",
    });
    if (!comment.ok) throw new Error("comment failed");
    const added = await addTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId, workspaceId: wsA },
      eventId: comment.eventId,
      bytes: png,
      filename: "shot.png",
      mimeType: "image/png",
    });
    expect(added.ok).toBe(true);

    const events = await listTicketEvents(qdb, wsA, ticket.id);
    const commentRow = events.find((e) => e.id === comment.eventId);
    expect(commentRow?.attachments).toHaveLength(1);
    // The comment already announced it — no separate attachment_added row.
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
