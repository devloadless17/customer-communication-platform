/**
 * The notification centre — the bell.
 *
 * What has to be PROVEN rather than read:
 *
 *   1. Assigning a ticket tells the ASSIGNEE, and nobody else gets that line.
 *   2. Every other change tells whoever RAISED it — the person who asked the
 *      question is usually neither the assignee nor whoever is editing.
 *   3. The ACTOR is never told about their own action, on any path. This is the
 *      single rule that decides whether a bell gets used or muted.
 *   4. Read state is per-person and per-workspace: one reader clearing theirs
 *      leaves everyone else's alone, and an id belonging to someone else
 *      matches nothing rather than clearing their row.
 *   5. Deleting a ticket takes its notifications with it — a bell entry that
 *      opens a 404 is worse than no entry.
 *
 *   BLOB_STORAGE_DRIVER=local pnpm --filter @ccp/api exec vitest run test/notifications.spec.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTicket, deleteTicket, updateTicket } from "@/lib/tickets/mutations";
import { shareTicket } from "@/lib/tickets/shares";
import { addTicketMessage, markThreadRead } from "@/lib/tickets/thread";
import { addTicketAttachment } from "@/lib/tickets/attachments";
import {
  countUnreadNotifications,
  listNotifications,
  markNotificationsRead,
} from "@/lib/notifications/notifications";
import { setSharedDb } from "@/lib/db";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const mdb = prisma as unknown as Parameters<typeof createTicket>[0];
const tdb = prisma as unknown as Parameters<typeof addTicketMessage>[0];
const adb = prisma as unknown as Parameters<typeof addTicketAttachment>[0];
const ndb = prisma as unknown as Parameters<typeof listNotifications>[0];
setSharedDb(prisma as unknown as PrismaClient);

const S = `ntf${Date.now().toString().slice(-8)}`;
let orgId = "";
let wsA = "";
let wsB = "";
/** The person who RAISES every ticket here. */
let raiser = "";
/** The person tickets get handed to. */
let worker = "";
let seq = 0;

async function makeUser(name: string, workspaces: string[]) {
  const u = await prisma.user.create({
    data: { name, email: `ntf-${randomUUID()}@example.test`, organizationId: orgId },
    select: { id: true },
  });
  for (const workspaceId of workspaces) {
    await prisma.workspaceMember.create({ data: { userId: u.id, workspaceId, role: "agent" } });
  }
  return u.id;
}

/** A ticket RAISED by `raiser`, so "notify who raised it" has a subject. */
async function makeTicket() {
  const contact = await prisma.contact.create({
    data: {
      workspaceId: wsA,
      name: `NTF ${seq}`,
      phoneNumber: `+9865${S.slice(3)}${String(seq++).padStart(3, "0")}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId: wsA, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  const created = await createTicket(mdb, {
    workspaceId: wsA,
    conversationId: convo.id,
    actor: { userId: raiser, workspaceId: wsA },
    source: "human",
    subject: "Notify me",
  });
  if (!created.ok) throw new Error("seed ticket failed");
  return created.ticket;
}

/** The fan-out is detached (it must never fail the write it decorates). */
async function settle() {
  await new Promise((r) => setTimeout(r, 400));
}

const bell = (userId: string, workspaceId = wsA) =>
  listNotifications(ndb, workspaceId, userId, { limit: 50 });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `NTF ${S}`, status: "active" } })).id;
  wsA = (await prisma.workspace.create({ data: { name: `NTF A ${S}`, organizationId: orgId } })).id;
  wsB = (await prisma.workspace.create({ data: { name: `NTF B ${S}`, organizationId: orgId } })).id;
  raiser = await makeUser("NTF Raiser", [wsA]);
  worker = await makeUser("NTF Worker", [wsA, wsB]);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("assignment tells the assignee", () => {
  it("notifies the person given the ticket, and never the person who gave it", async () => {
    const ticket = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      assignedUserId: worker,
    });
    await settle();

    const theirs = (await bell(worker)).filter((n) => n.ticketId === ticket.id);
    expect(theirs.map((n) => n.kind)).toContain("ticket_assigned");
    expect(theirs[0]?.actorName).toBe("NTF Raiser");
    expect(theirs[0]?.ticketNumber).toBe(ticket.number);

    // The actor raised it AND assigned it, so they are the audience for the
    // generic line too — but they must not be told about their own action.
    const mine = (await bell(raiser)).filter((n) => n.ticketId === ticket.id);
    expect(mine).toHaveLength(0);
  });
});

describe("every other change tells whoever RAISED it", () => {
  it("notifies the raiser when someone else moves the ticket", async () => {
    const ticket = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      status: "open",
    });
    await settle();

    const mine = (await bell(raiser)).filter((n) => n.ticketId === ticket.id);
    expect(mine.map((n) => n.kind)).toContain("ticket_changed");
    expect(mine[0]?.summary).toContain("status");
    expect(mine[0]?.actorName).toBe("NTF Worker");
    // ...and the person who did it hears nothing about it.
    expect((await bell(worker)).filter((n) => n.ticketId === ticket.id)).toHaveLength(0);
  });

  it("notifies on a reply, and on a file added to the ticket", async () => {
    const ticket = await makeTicket();
    await addTicketMessage(tdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      body: "looking at this now",
    });
    await settle();
    expect(
      (await bell(raiser)).filter((n) => n.ticketId === ticket.id).map((n) => n.kind),
    ).toContain("ticket_replied");

    await addTicketAttachment(adb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      bytes: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000180fe8ecf0000000049454e44ae426082",
        "hex",
      ),
      filename: "evidence.png",
      mimeType: "image/png",
    });
    await settle();
    const kinds = (await bell(raiser)).filter((n) => n.ticketId === ticket.id).map((n) => n.kind);
    expect(kinds).toContain("ticket_file_added");
    // Never the actor, on any path.
    expect((await bell(worker)).filter((n) => n.ticketId === ticket.id)).toHaveLength(0);
  });

  it("an ATTACHMENT-ONLY reply lands, and notifies", async () => {
    // The composer has always allowed a screenshot with no caption, but the
    // schema required `body.min(1)` and the domain refused an empty one — so
    // every caption-less reply 400'd. The row was never written, which is why
    // the UI said "Didn't send" AND no bell/blue-dot ever appeared: no message,
    // no unread marker, no notification. One bug, both symptoms.
    const ticket = await makeTicket();
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000180fe8ecf0000000049454e44ae426082",
      "hex",
    );
    const posted = await addTicketMessage(tdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      body: "",
      attach: (messageId) =>
        addTicketAttachment(adb, {
          workspaceId: wsA,
          ticketId: ticket.id,
          actor: { userId: worker, workspaceId: wsA },
          messageId,
          bytes: png,
          filename: "screenshot.png",
          mimeType: "image/png",
        }).then((r) => (r.ok ? [r.attachment] : [])),
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.body).toBe("");
    expect(posted.message.attachments).toHaveLength(1);

    // The whole point: the person waiting is told, exactly as for a text reply.
    expect(posted.notifiedUserIds).toContain(raiser);
    await settle();
    const mine = (await bell(raiser)).filter((n) => n.ticketId === ticket.id);
    expect(mine.map((n) => n.kind)).toContain("ticket_replied");
    expect(mine[0]?.summary).toContain("attached");
    // ...and the in-app unread marker, which drives the rail's blue dot.
    expect(
      await prisma.ticketThreadUnread.count({ where: { ticketId: ticket.id, userId: raiser } }),
    ).toBe(1);

    // Still refused when there is genuinely nothing: no text, no files.
    const empty = await addTicketMessage(tdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      body: "   ",
    });
    expect(empty).toEqual({ ok: false, reason: "empty_message" });
  });

  it("notifies the raiser when the ticket is escalated to another department", async () => {
    const ticket = await makeTicket();
    await shareTicket(prisma as unknown as Parameters<typeof shareTicket>[0], {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      targetWorkspaceId: wsB,
      cause: "Billing must approve this",
    });
    await settle();
    const mine = (await bell(raiser)).filter((n) => n.ticketId === ticket.id);
    expect(mine.map((n) => n.kind)).toContain("ticket_escalated");
    expect(mine[0]?.summary).toContain(`NTF B ${S}`);
  });
});

describe("create-with-assignee rings the bell", () => {
  it("notifies a person handed a ticket AT BIRTH, and never the raiser-actor", async () => {
    // `updateTicket` told a NEW assignee they own something; a ticket RAISED
    // onto someone (explicit pick, or inheriting the conversation's owner) was
    // handed over in silence — they found out by going to look.
    const assignee = await makeUser("NTF Birth Assignee", [wsA]);
    const contact = await prisma.contact.create({
      data: {
        workspaceId: wsA,
        name: `NTF birth ${seq}`,
        phoneNumber: `+9864${S.slice(3)}${String(seq++).padStart(3, "0")}`,
        identityChannel: "whatsapp",
      },
      select: { id: true },
    });
    const convo = await prisma.conversation.create({
      data: { workspaceId: wsA, contactId: contact.id, channel: "whatsapp" },
      select: { id: true },
    });
    const created = await createTicket(mdb, {
      workspaceId: wsA,
      conversationId: convo.id,
      actor: { userId: raiser, workspaceId: wsA },
      source: "human",
      subject: "Born assigned",
      assignedUserId: assignee,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await settle();

    const theirs = (await bell(assignee)).filter((n) => n.ticketId === created.ticket.id);
    expect(theirs.map((n) => n.kind)).toContain("ticket_assigned");
    expect(theirs[0]?.actorName).toBe("NTF Raiser");
    // The raiser DID the assigning — never the actor.
    expect((await bell(raiser)).filter((n) => n.ticketId === created.ticket.id)).toHaveLength(0);
  });
});

describe("the outcome reaches whoever supplied the answer", () => {
  it("solving notifies a thread AUTHOR who is neither raiser nor assignee", async () => {
    // The audience and the thread's participant list are ONE resolver now —
    // before, `ticketAudience` had four arms and the person who actually wrote
    // the answer in the thread never heard the ticket was solved.
    const answerer = await makeUser("NTF Answerer", [wsA]);
    const ticket = await makeTicket();
    await addTicketMessage(tdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: answerer, workspaceId: wsA },
      body: "the fix is to re-issue the invoice",
    });
    await settle();

    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      status: "solved",
    });
    await settle();

    const theirs = (await bell(answerer)).filter((n) => n.ticketId === ticket.id);
    expect(theirs.map((n) => n.kind)).toContain("ticket_changed");
    expect(theirs.find((n) => n.kind === "ticket_changed")?.summary).toContain("solved");
  });
});

describe("opening the ticket clears EVERYTHING about it", () => {
  it("markThreadRead clears the bell rows for that ticket too", async () => {
    // One read-state rule. Before: the thread marker cleared on open while the
    // bell cleared only on "Mark all read" — the rail dot and the bell badge
    // diverged forever, by construction.
    const ticket = await makeTicket();
    await addTicketMessage(tdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: worker, workspaceId: wsA },
      body: "have a look",
    });
    await settle();
    expect(await countUnreadNotifications(ndb, wsA, raiser)).toBeGreaterThan(0);

    const before = await countUnreadNotifications(ndb, wsA, raiser);
    const otherTicketUnread = (await bell(raiser)).filter(
      (n) => !n.readAt && n.ticketId !== ticket.id,
    ).length;
    await markThreadRead(tdb, { workspaceId: wsA, ticketId: ticket.id, userId: raiser });
    const after = await countUnreadNotifications(ndb, wsA, raiser);
    // THIS ticket's rows cleared; every other ticket's unread untouched.
    expect(after).toBe(otherTicketUnread);
    expect(after).toBeLessThan(before);
  });
});

describe("a recipient reads it in THEIR OWN workspace", () => {
  /**
   * The bell reads `{ userId, workspaceId: session.workspaceId }` and the socket
   * room is `user:<ws>:<uid>`, so a row stamped with the ACTOR's workspace is
   * invisible to a recipient sitting in their own — permanently, when they are
   * not a member of the actor's workspace at all.
   *
   * That is exactly the escalation audience: the whole reason the bell exists.
   * This is the case, and it is asserted on the WORKSPACE, not just on the
   * presence of a row.
   */
  it("reaches a guest-side person who is not a member of the owner workspace", async () => {
    // Billing only. They cannot see wsA at all.
    const billing = await makeUser("NTF Billing", [wsB]);
    const ticket = await makeTicket();
    await shareTicket(prisma as unknown as Parameters<typeof shareTicket>[0], {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      targetWorkspaceId: wsB,
      cause: "Billing must approve this",
    });
    // Billing claims their side — this writes the SHARE's assignee.
    await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: ticket.id,
      actor: { userId: billing, workspaceId: wsB },
      assignedUserId: billing,
    });
    await settle();

    // The owner side answers.
    await addTicketMessage(tdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      body: "any update on this?",
    });
    await settle();

    // Billing sees it where they actually stand...
    const inTheirs = (await bell(billing, wsB)).filter((n) => n.ticketId === ticket.id);
    expect(inTheirs.length).toBeGreaterThan(0);
    expect(await countUnreadNotifications(ndb, wsB, billing)).toBeGreaterThan(0);

    // ...and NOT stamped with the actor's workspace, which they cannot open.
    expect(await countUnreadNotifications(ndb, wsA, billing)).toBe(0);
    expect(
      await prisma.notification.count({ where: { userId: billing, workspaceId: wsA } }),
    ).toBe(0);
  });
});

describe("read state is per person", () => {
  it("one reader clearing theirs leaves everyone else's alone", async () => {
    const ticket = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      assignedUserId: worker,
    });
    await settle();

    const beforeWorker = await countUnreadNotifications(ndb, wsA, worker);
    expect(beforeWorker).toBeGreaterThan(0);

    // A THIRD person clears their own bell — the worker's must not move.
    const bystander = await makeUser("NTF Bystander", [wsA]);
    await markNotificationsRead(ndb, wsA, bystander);
    expect(await countUnreadNotifications(ndb, wsA, worker)).toBe(beforeWorker);

    // Naming someone else's id clears nothing: the update is scoped by userId,
    // so a guessed id simply matches no row.
    const theirs = (await bell(worker))[0];
    if (!theirs) throw new Error("expected a notification");
    expect(await markNotificationsRead(ndb, wsA, bystander, [theirs.id])).toBe(0);
    expect(await countUnreadNotifications(ndb, wsA, worker)).toBe(beforeWorker);

    // Their own clear works, and is idempotent.
    expect(await markNotificationsRead(ndb, wsA, worker)).toBe(beforeWorker);
    expect(await countUnreadNotifications(ndb, wsA, worker)).toBe(0);
    expect(await markNotificationsRead(ndb, wsA, worker)).toBe(0);
  });

  it("is scoped to the workspace it happened in", async () => {
    const before = await countUnreadNotifications(ndb, wsB, worker);
    const ticket = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      assignedUserId: worker,
    });
    await settle();
    // Raised in A, so it belongs to A's bell — not to the same person's bell
    // in the sibling workspace.
    expect(await countUnreadNotifications(ndb, wsB, worker)).toBe(before);
  });
});

describe("a deleted ticket takes its notifications with it", () => {
  it("leaves no bell entry pointing at a ticket that no longer exists", async () => {
    const ticket = await makeTicket();
    await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
      assignedUserId: worker,
    });
    await settle();
    expect(await prisma.notification.count({ where: { ticketId: ticket.id } })).toBeGreaterThan(0);

    const out = await deleteTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId: raiser, workspaceId: wsA },
    });
    expect(out).toEqual({ ok: true });
    // Cascade, not orphan: an entry that opens a 404 is worse than no entry.
    expect(await prisma.notification.count({ where: { ticketId: ticket.id } })).toBe(0);
  });
});
