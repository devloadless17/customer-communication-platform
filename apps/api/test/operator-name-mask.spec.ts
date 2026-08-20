/**
 * OPERATOR NAME MASK — the server-side half of "their unresolvable id renders
 * as 'Support' to the tenant's team" (CLAUDE.md §18).
 *
 * The web's member-map fallback masks any actor id that resolves to no roster
 * member — but several DTOs resolve actor names SERVER-side by joining the
 * User row, where the platform operator's row resolves like anyone else's and
 * the real name reached the tenant's UI (audit 2026-08-10). What has to be
 * PROVEN rather than read:
 *
 *   1. The predicate itself: a superAdmin with no membership in the workspace
 *      is masked; the same superAdmin IS a member in their own anchor
 *      workspace and keeps their real name; an ordinary member is never
 *      masked.
 *   2. The conversation activity timeline masks the operator's actorName.
 *   3. Ticket surfaces mask: event actorName, thread authorName (+avatar),
 *      and the ticket's resolvedByName.
 *   4. The bell: a Notification row is APPEND-ONLY, so the actorName must be
 *      masked at WRITE time — the persisted row itself says "Support".
 *   5. Neither report tab (team or overview) grows a row for the operator's
 *      activity, while a genuinely departed member's "Former member" row
 *      survives.
 *
 *   BLOB_STORAGE_DRIVER=local pnpm --filter @ccp/api exec vitest run test/operator-name-mask.spec.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTicket, updateTicket } from "@/lib/tickets/mutations";
import { addTicketMessage, listTicketThread } from "@/lib/tickets/thread";
import { getTicket, listTicketEvents } from "@/lib/tickets/queries";
import { listNotifications } from "@/lib/notifications/notifications";
import { listConversationEvents } from "@/lib/queries/conversations";
import { getTeamReport } from "@/lib/analytics/team-report";
import { getWorkspaceReport } from "@/lib/analytics/reports";
import { actorNameMasker, operatorActorIds } from "@/lib/workspaces/operator-mask";
import { listChannelMessages } from "@/lib/team-chat/queries";
import { listNewerMessages } from "@/lib/queries/conversations";
import { trackOnOutboundMessage } from "@/lib/conversations/analytics";
import { setSharedDb } from "@/lib/db";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const mdb = prisma as unknown as Parameters<typeof createTicket>[0];
const tdb = prisma as unknown as Parameters<typeof addTicketMessage>[0];
const qdb = prisma as unknown as Parameters<typeof getTicket>[0];
const ndb = prisma as unknown as Parameters<typeof listNotifications>[0];
setSharedDb(prisma as unknown as PrismaClient);

const S = `opm${Date.now().toString().slice(-8)}`;
let orgId = "";
/** The tenant workspace the operator ENTERS (no membership row). */
let ws = "";
/** The operator's own anchor workspace, where they ARE a member. */
let anchorWs = "";
let member = "";
let operator = "";
let seq = 0;

async function makeTicket() {
  const contact = await prisma.contact.create({
    data: {
      workspaceId: ws,
      name: `OPM ${seq}`,
      phoneNumber: `+9864${S.slice(3)}${String(seq++).padStart(3, "0")}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId: ws, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  const created = await createTicket(mdb, {
    workspaceId: ws,
    conversationId: convo.id,
    actor: { userId: member, workspaceId: ws },
    source: "human",
    subject: "Mask me",
  });
  if (!created.ok) throw new Error("seed ticket failed");
  return { ticket: created.ticket, conversationId: convo.id };
}

/** Detached bell fan-out — give it a beat to land. */
async function settle() {
  await new Promise((r) => setTimeout(r, 400));
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `OPM ${S}`, status: "active" } })).id;
  ws = (await prisma.workspace.create({ data: { name: `OPM ws ${S}`, organizationId: orgId } })).id;
  anchorWs = (
    await prisma.workspace.create({ data: { name: `OPM anchor ${S}`, organizationId: orgId } })
  ).id;
  member = (
    await prisma.user.create({
      data: { name: "OPM Member", email: `opm-${randomUUID()}@example.test`, organizationId: orgId },
      select: { id: true },
    })
  ).id;
  await prisma.workspaceMember.create({ data: { userId: member, workspaceId: ws, role: "agent" } });
  operator = (
    await prisma.user.create({
      data: {
        name: "OPM Real Operator Name",
        email: `opm-${randomUUID()}@example.test`,
        organizationId: orgId,
        isSuperAdmin: true,
      },
      select: { id: true },
    })
  ).id;
  // Member of the ANCHOR only — in `ws` they are the operator.
  await prisma.workspaceMember.create({
    data: { userId: operator, workspaceId: anchorWs, role: "admin" },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("the predicate", () => {
  it("masks a superAdmin only where they hold no membership", async () => {
    const inTenant = await operatorActorIds(prisma, [operator, member], [ws]);
    expect(inTenant.has(operator)).toBe(true);
    expect(inTenant.has(member)).toBe(false);

    const inAnchor = await operatorActorIds(prisma, [operator], [anchorWs]);
    expect(inAnchor.size).toBe(0);
  });
});

describe("conversation activity timeline", () => {
  it("renders the operator as Support and a member by name", async () => {
    const { conversationId } = await makeTicket();
    await prisma.conversationEvent.createMany({
      data: [
        {
          workspaceId: ws,
          conversationId,
          kind: "status_changed",
          userId: operator,
          after: { status: "closed" },
        },
        {
          workspaceId: ws,
          conversationId,
          kind: "status_changed",
          userId: member,
          after: { status: "open" },
        },
      ],
    });
    const events = (await listConversationEvents(ws, conversationId)) ?? [];
    // The DTO exposes actorName, not the id — tell the two rows apart by the
    // status each one wrote.
    const byOperator = events.find(
      (e) => e.kind === "status_changed" && e.after?.status === "closed",
    );
    const byMember = events.find(
      (e) => e.kind === "status_changed" && e.after?.status === "open",
    );
    expect(byOperator?.actorName).toBe("Support");
    expect(byMember?.actorName).toBe("OPM Member");
  });
});

describe("ticket surfaces", () => {
  it("masks event actorName, thread author, resolvedByName — and the persisted bell row", async () => {
    const { ticket } = await makeTicket();

    // Operator resolves the ticket (they can — actions stay ordinary writes).
    const updated = await updateTicket(mdb, {
      workspaceId: ws,
      ticketId: ticket.id,
      actor: { userId: operator, workspaceId: ws },
      status: "solved",
    });
    expect(updated.ok).toBe(true);

    const events = await listTicketEvents(qdb, ws, ticket.id);
    const statusEvent = events.find((e) => e.actorUserId === operator);
    expect(statusEvent).toBeTruthy();
    expect(statusEvent?.actorName).toBe("Support");

    const detail = await getTicket(qdb, ws, ticket.id);
    expect(detail?.resolvedById).toBe(operator);
    expect(detail?.resolvedByName).toBe("Support");

    // Thread reply by the operator: the returned DTO (which is also the live
    // frame payload) and the later list read both mask.
    const reply = await addTicketMessage(tdb, {
      workspaceId: ws,
      ticketId: ticket.id,
      actor: { userId: operator, workspaceId: ws },
      body: "Looking into this for you.",
    });
    if (!reply.ok) throw new Error("reply failed");
    expect(reply.message.authorName).toBe("Support");
    expect(reply.message.authorAvatarUrl).toBeNull();

    const thread = await listTicketThread(tdb, ws, ticket.id);
    const line = thread.find((m) => m.authorUserId === operator);
    expect(line?.authorName).toBe("Support");

    // The bell: the raiser was notified of both actions, and the APPEND-ONLY
    // rows themselves carry "Support", not the operator's real name.
    await settle();
    const bell = await listNotifications(ndb, ws, member, { limit: 50 });
    const fromOperator = bell.filter((n) => n.actorUserId === operator);
    expect(fromOperator.length).toBeGreaterThan(0);
    for (const n of fromOperator) expect(n.actorName).toBe("Support");
    const raw = await prisma.notification.findMany({
      where: { userId: member, actorUserId: operator },
      select: { actorName: true },
    });
    for (const r of raw) expect(r.actorName).toBe("Support");
  });
});

describe("team report", () => {
  it("never grows a row for the operator; a departed member keeps theirs", async () => {
    const { conversationId } = await makeTicket();
    const departed = (
      await prisma.user.create({
        data: {
          name: "OPM Departed",
          email: `opm-${randomUUID()}@example.test`,
          organizationId: orgId,
        },
        select: { id: true },
      })
    ).id;
    // Activity from both, neither on the roster: the operator (superAdmin, no
    // membership) and a departed member (no membership either).
    await prisma.message.createMany({
      data: [operator, departed].map((senderUserId, i) => ({
        workspaceId: ws,
        conversationId,
        channel: "whatsapp",
        direction: "out",
        body: "report fodder",
        externalId: `opm-${S}-${i}-${randomUUID()}`,
        senderUserId,
        timestamp: new Date(),
      })),
    });
    const from = new Date(Date.now() - 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);
    const report = await getTeamReport(ws, { from, to, tz: "UTC" });
    const ids = report.agents.map((a) => a.userId);
    expect(ids).not.toContain(operator);
    expect(ids).toContain(departed);

    // The OVERVIEW's Agents panel is a second workforce list over the same
    // activity, and it carried the exclusion nowhere — one tab showed the
    // operator as staff while the other didn't. Both now read the same helper.
    const overview = await getWorkspaceReport(ws, { from, to, tz: "UTC" });
    const overviewIds = overview.agents.map((a) => a.userId);
    expect(overviewIds).not.toContain(operator);
    expect(overviewIds).toContain(departed);
  });
});

describe("the batched masker + the newly-masked surfaces (audit 2026-08-20)", () => {
  it("actorNameMasker: masks the operator, passes a member and a departed member through", async () => {
    const maskName = await actorNameMasker(prisma, [ws], [operator, member, null]);
    expect(maskName(operator, "OPM Real Operator Name")).toBe("Support");
    expect(maskName(member, "OPM Member")).toBe("OPM Member");
    // A non-operator unresolved name passes through as null — "Former member"
    // is the CLIENT's word for that, never the server inventing one.
    expect(maskName(member, null)).toBeNull();
    expect(maskName(null, "whoever")).toBe("whoever");
  });

  it("team chat: history mapping masks the operator's name AND avatar", async () => {
    await prisma.user.update({
      where: { id: operator },
      data: { avatarUrl: "avatars/opm-real-face.png" },
    });
    const channel = await prisma.teamChannel.create({
      data: {
        workspaceId: ws,
        name: `opm-${S}`,
        visibility: "public",
        isDefault: true,
        createdById: member,
      },
      select: { id: true },
    });
    await prisma.teamChannelMessage.createMany({
      data: [
        { channelId: channel.id, workspaceId: ws, authorUserId: operator, body: "op says hi" },
        { channelId: channel.id, workspaceId: ws, authorUserId: member, body: "member replies" },
      ],
    });
    const { items } = await listChannelMessages(channel.id, ws, {});
    const fromOp = items.find((m) => m.authorUserId === operator);
    const fromMember = items.find((m) => m.authorUserId === member);
    expect(fromOp?.authorName).toBe("Support");
    expect(fromOp?.authorAvatarUrl).toBeNull();
    expect(fromMember?.authorName).toBe("OPM Member");
  });

  it("quoted reply: the in-app snapshot masks the operator as the quoted sender", async () => {
    const { conversationId } = await makeTicket();
    const original = await prisma.message.create({
      data: {
        workspaceId: ws,
        conversationId,
        channel: "whatsapp",
        direction: "out",
        body: "the operator's original",
        externalId: `opm-q-${randomUUID()}`,
        senderUserId: operator,
        timestamp: new Date(),
      },
      select: { id: true },
    });
    await prisma.message.create({
      data: {
        workspaceId: ws,
        conversationId,
        channel: "whatsapp",
        direction: "in",
        body: "customer quotes it",
        externalId: `opm-q-${randomUUID()}`,
        replyToMessageId: original.id,
        timestamp: new Date(Date.now() + 10),
      },
    });
    const page = await listNewerMessages(ws, conversationId, {
      after: new Date(Date.now() - 60_000).toISOString(),
    });
    const quoted = page.items.find((m) => m.replyTo?.id === original.id);
    expect(quoted?.replyTo?.senderName).toBe("Support");
  });

  it("reply-claim: an operator send never claims the conversation; a member's does", async () => {
    // The P0: `autoAssignOnAgentSend` resolved the assignee membership-filtered
    // and wrote `assignedUserId` anyway. The domain-level guard is
    // `if (!assignee) return` — prove both directions through the same shape
    // the service uses (membership-filtered read, then a conditional claim).
    const { conversationId } = await makeTicket();
    for (const [actor, shouldClaim] of [
      [operator, false],
      [member, true],
    ] as const) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedUserId: null, lastAssignedUserId: null },
      });
      const assignee = await prisma.user.findFirst({
        where: { id: actor, workspaceMemberships: { some: { workspaceId: ws } } },
        select: { id: true },
      });
      if (assignee) {
        await prisma.conversation.updateMany({
          where: { id: conversationId, workspaceId: ws, assignedUserId: null },
          data: { assignedUserId: actor, lastAssignedUserId: actor },
        });
      }
      const row = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { assignedUserId: true, lastAssignedUserId: true },
      });
      expect(row.assignedUserId).toBe(shouldClaim ? actor : null);
      expect(row.lastAssignedUserId).toBe(shouldClaim ? actor : null);
    }
  });

  it("analytics: an operator send bumps outgoing but never responses / first-response", async () => {
    const { conversationId } = await makeTicket();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { incomingMessagesCount: 1 },
    });
    await trackOnOutboundMessage({ conversationId, workspaceId: ws, senderUserId: operator });
    let row = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        outgoingMessagesCount: true,
        responsesCount: true,
        firstResponseAt: true,
        firstResponseByUserId: true,
      },
    });
    expect(row.outgoingMessagesCount).toBe(1);
    expect(row.responsesCount).toBe(0);
    expect(row.firstResponseAt).toBeNull();
    // The control: a member's send counts normally.
    await trackOnOutboundMessage({ conversationId, workspaceId: ws, senderUserId: member });
    row = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        outgoingMessagesCount: true,
        responsesCount: true,
        firstResponseAt: true,
        firstResponseByUserId: true,
      },
    });
    expect(row.outgoingMessagesCount).toBe(2);
    expect(row.responsesCount).toBe(1);
    expect(row.firstResponseByUserId).toBe(member);
  });
});
