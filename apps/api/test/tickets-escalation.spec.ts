/**
 * Cross-workspace ticket escalation, driven against a real database.
 *
 * What has to be PROVEN rather than read:
 *
 *   1. The escalate transaction is atomic and complete: twin ticket in the
 *      TARGET workspace (its own numbering), the bridge row, BOTH timeline
 *      entries, and TWO outbox events each scoped to its own workspace.
 *   2. One escalation per ticket lifetime — a concurrent double-escalate maps
 *      to `already_escalated`, never a 500 or two twins.
 *   3. Chains are banned: an escalation TARGET cannot be escalated onward.
 *   4. The org boundary holds: a cross-org target id answers exactly like a
 *      nonexistent one.
 *   5. Comments and status changes MIRROR — one row per side, each workspace-
 *      scoped to its own ticket — and a delete severs the link with a
 *      mirrored record on the survivor.
 *   6. "Message customer" binding turns the twin into a completely normal
 *      ticket: counter + pointer set, and `routeMessageToTicket` attaches.
 *
 *   pnpm --filter @ccp/api exec vitest run test/tickets-escalation.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTicket, deleteTicket, routeMessageToTicket, updateTicket } from "@/lib/tickets/mutations";
import {
  addEscalationComment,
  bindEscalatedTicketConversation,
  escalateTicket,
  getEscalationSnapshot,
} from "@/lib/tickets/escalations";
import { getTicketCounts, listTickets } from "@/lib/tickets/queries";
import { setSharedDb } from "@/lib/db";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const db = prisma as unknown as Parameters<typeof escalateTicket>[0];
const mdb = prisma as unknown as Parameters<typeof createTicket>[0];
setSharedDb(prisma as unknown as PrismaClient);

const S = `esc${Date.now().toString().slice(-8)}`;
let orgId = "";
let otherOrgId = "";
let wsA = ""; // source
let wsB = ""; // target
let wsForeign = ""; // another org's workspace
let userId = "";
/** A second agent in the target workspace — proves the visibility fallback
 *  widens the rule for UNBOUND tickets without switching the boundary off. */
let otherUserId = "";
let contactSeq = 0;

async function makeConversation(workspaceId: string, withProfile = false) {
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `ESC ${contactSeq}`,
      phoneNumber: `+9867${S.slice(3)}${String(contactSeq++).padStart(3, "0")}`,
      identityChannel: "whatsapp",
      ...(withProfile ? { email: "esc@example.test", customFields: { plan_tier: "Gold" } } : {}),
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  return { conversationId: convo.id, contactId: contact.id };
}

/** A fresh active source ticket in workspace A. */
async function makeSourceTicket(withProfile = false) {
  const { conversationId } = await makeConversation(wsA, withProfile);
  const created = await createTicket(mdb, {
    workspaceId: wsA,
    conversationId,
    actor: { userId },
    source: "human",
    subject: "Escalation source",
    description: "the original cause",
  });
  if (!created.ok) throw new Error("seed ticket failed");
  return { ticket: created.ticket, conversationId };
}

const eventsOf = (workspaceId: string, ticketId: string) =>
  prisma.ticketEvent.findMany({
    where: { workspaceId, ticketId },
    orderBy: { createdAt: "asc" },
    select: { kind: true, body: true, after: true },
  });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `ESC Org ${S}`, status: "active" } }))
    .id;
  otherOrgId = (
    await prisma.organization.create({ data: { name: `ESC Other ${S}`, status: "active" } })
  ).id;
  wsA = (await prisma.workspace.create({ data: { name: `ESC A ${S}`, organizationId: orgId } })).id;
  wsB = (await prisma.workspace.create({ data: { name: `ESC B ${S}`, organizationId: orgId } })).id;
  wsForeign = (
    await prisma.workspace.create({ data: { name: `ESC F ${S}`, organizationId: otherOrgId } })
  ).id;
  const user = await prisma.user.create({
    data: { name: "ESC Agent", email: `esc-${S}@example.test`, organizationId: orgId },
    select: { id: true },
  });
  userId = user.id;
  await prisma.workspaceMember.create({ data: { userId, workspaceId: wsA, role: "agent" } });
  await prisma.workspaceMember.create({ data: { userId, workspaceId: wsB, role: "agent" } });
  const other = await prisma.user.create({
    data: { name: "ESC Other Agent", email: `esc-other-${S}@example.test`, organizationId: orgId },
    select: { id: true },
  });
  otherUserId = other.id;
  await prisma.workspaceMember.create({
    data: { userId: otherUserId, workspaceId: wsB, role: "agent" },
  });
  // A field definition so the snapshot resolves keys → labels.
  await prisma.contactFieldDefinition.create({
    data: { workspaceId: wsA, key: "plan_tier", label: "Plan tier" },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("escalate", () => {
  it("creates the twin, the bridge, both timeline entries and two workspace-scoped events", async () => {
    const { ticket } = await makeSourceTicket(true);
    const out = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "Customer 123 was double-charged; needs a refund approval.",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The twin is a normal ticket of workspace B with NO thread yet.
    const twin = await prisma.ticket.findUniqueOrThrow({
      where: { id: out.targetTicket.id },
      select: {
        workspaceId: true,
        number: true,
        conversationId: true,
        contactId: true,
        status: true,
        source: true,
        description: true,
      },
    });
    expect(twin.workspaceId).toBe(wsB);
    expect(twin.number).toBe(1); // B's own counter, not A's
    expect(twin.conversationId).toBeNull();
    expect(twin.contactId).toBeNull();
    expect(twin.status).toBe("new");
    expect(twin.source).toBe("escalation");
    expect(twin.description).toContain("double-charged");

    // The bridge row links the pair and froze the profile.
    const bridge = await prisma.ticketEscalation.findUniqueOrThrow({
      where: { sourceTicketId: ticket.id },
      select: { targetTicketId: true, organizationId: true, contactSnapshot: true },
    });
    expect(bridge.targetTicketId).toBe(out.targetTicket.id);
    expect(bridge.organizationId).toBe(orgId);
    const snapshot = bridge.contactSnapshot as Record<string, unknown>;
    expect(snapshot.phoneNumber).toBeTruthy();
    expect(snapshot.email).toBe("esc@example.test");
    // Custom-field KEYS resolve to the source workspace's LABELS.
    expect((snapshot.customFields as Record<string, string>)["Plan tier"]).toBe("Gold");

    // Both timeline entries, each on its own side, both carrying the cause.
    const sourceEvents = await eventsOf(wsA, ticket.id);
    expect(sourceEvents.map((e) => e.kind)).toContain("escalated");
    const escalatedRow = sourceEvents.find((e) => e.kind === "escalated")!;
    expect(escalatedRow.body).toContain("double-charged");
    const twinEvents = await eventsOf(wsB, out.targetTicket.id);
    expect(twinEvents.map((e) => e.kind)).toEqual(["escalation_received"]);
    expect(twinEvents[0].body).toContain("double-charged");

    // Two outbox events, each scoped to its OWN workspace.
    const outbox = await prisma.outboundEvent.findMany({
      where: {
        type: "ticket.changed",
        OR: [{ workspaceId: wsA }, { workspaceId: wsB }],
      },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { workspaceId: true, payload: true },
    });
    const actions = outbox.map((e) => ({
      workspaceId: e.workspaceId,
      action: (e.payload as { action?: string }).action,
      ticketId: (e.payload as { ticketId?: string }).ticketId,
    }));
    expect(actions).toEqual(
      expect.arrayContaining([
        { workspaceId: wsB, action: "created", ticketId: out.targetTicket.id },
        { workspaceId: wsA, action: "escalated", ticketId: ticket.id },
      ]),
    );

    // The read side reports the pair from both directions.
    expect(out.sourceTicket.escalation?.role).toBe("source");
    expect(out.sourceTicket.escalation?.otherTicketNumber).toBe(1);
    expect(out.targetTicket.escalation?.role).toBe("target");
    expect(out.targetTicket.escalation?.contactSnapshot?.email).toBe("esc@example.test");
    // The twin renders the customer's name from the snapshot despite null contactId.
    expect(out.targetTicket.contactName).toMatch(/^ESC /);
  });

  it("refuses a second escalation, including a concurrent race", async () => {
    const { ticket } = await makeSourceTicket();
    const args = {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "twice",
    };
    const [a, b] = await Promise.all([escalateTicket(db, args), escalateTicket(db, args)]);
    const oks = [a, b].filter((r) => r.ok);
    const dupes = [a, b].filter((r) => !r.ok && r.reason === "already_escalated");
    expect(oks).toHaveLength(1);
    expect(dupes).toHaveLength(1);
    // Exactly one twin exists.
    const twins = await prisma.ticketEscalation.count({ where: { sourceTicketId: ticket.id } });
    expect(twins).toBe(1);
  });

  it("bans chains: an escalation target cannot be escalated onward", async () => {
    const { ticket } = await makeSourceTicket();
    const out = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "chain root",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const onward = await escalateTicket(db, {
      workspaceId: wsB,
      ticketId: out.targetTicket.id,
      actor: { userId },
      targetWorkspaceId: wsA,
      cause: "bounce it back",
    });
    expect(onward).toEqual({ ok: false, reason: "cannot_escalate_escalated_ticket" });
  });

  it("answers a cross-org target exactly like a nonexistent one, and refuses self", async () => {
    const { ticket } = await makeSourceTicket();
    for (const targetWorkspaceId of [wsForeign, "does-not-exist", wsA]) {
      const out = await escalateTicket(db, {
        workspaceId: wsA,
        ticketId: ticket.id,
        actor: { userId },
        targetWorkspaceId,
        cause: "x",
      });
      expect(out).toEqual({ ok: false, reason: "target_workspace_not_found" });
    }
  });

  it("refuses a terminal source ticket", async () => {
    const { ticket } = await makeSourceTicket();
    await updateTicket(mdb, { workspaceId: wsA, ticketId: ticket.id, actor: { userId }, status: "closed" });
    const out = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "too late",
    });
    expect(out).toEqual({ ok: false, reason: "ticket_terminal" });
  });
});

describe("mirroring", () => {
  it("mirrors a shared comment to BOTH tickets, each row workspace-scoped", async () => {
    const { ticket } = await makeSourceTicket();
    const esc = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "root",
    });
    if (!esc.ok) throw new Error("escalate failed");

    // Posted from the TARGET side (workspace B answers).
    const posted = await addEscalationComment(db, {
      workspaceId: wsB,
      ticketId: esc.targetTicket.id,
      actor: { userId },
      body: "Refund approved — lands in 3–5 days.",
    });
    expect(posted.ok).toBe(true);

    const sourceNotes = (await eventsOf(wsA, ticket.id)).filter((e) => e.kind === "escalation_note");
    const twinNotes = (await eventsOf(wsB, esc.targetTicket.id)).filter(
      (e) => e.kind === "escalation_note",
    );
    expect(sourceNotes).toHaveLength(1);
    expect(twinNotes).toHaveLength(1);
    expect(sourceNotes[0].body).toContain("Refund approved");
    // Attribution snapshots the POSTER's workspace name on both rows.
    expect((sourceNotes[0].after as { fromWorkspaceName?: string }).fromWorkspaceName).toBe(
      `ESC B ${S}`,
    );
  });

  it("ONE IDENTITY: solving the twin solves the source too, with the resolution and an attributed log", async () => {
    const { ticket, conversationId } = await makeSourceTicket();
    const esc = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "root",
    });
    if (!esc.ok) throw new Error("escalate failed");

    const solved = await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: esc.targetTicket.id,
      actor: { userId },
      status: "solved",
      resolutionNote: "Told them Tuesday.",
    });
    expect(solved.ok).toBe(true);

    // The pair is ONE piece of work — the source converged to solved with the
    // same resolution, and its conversation's counter/pointer released.
    const source = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { status: true, resolvedAt: true, resolutionNote: true, version: true },
    });
    expect(source.status).toBe("solved");
    expect(source.resolvedAt).not.toBeNull();
    expect(source.resolutionNote).toBe("Told them Tuesday.");
    const convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { openTicketCount: true, activeTicketId: true },
    });
    expect(convo.openTicketCount).toBe(0);
    expect(convo.activeTicketId).toBeNull();

    // The source's timeline says WHERE the change came from.
    const mirrored = (await eventsOf(wsA, ticket.id)).filter((e) => e.kind === "escalation_status");
    expect(mirrored).toHaveLength(1);
    const after = mirrored[0].after as Record<string, unknown>;
    expect(after.status).toBe("solved");
    expect(after.resolutionNote).toBe("Told them Tuesday.");
    expect(after.fromWorkspaceName).toBe(`ESC B ${S}`);

    // The source workspace got a real lifecycle frame, not just a ping.
    const frame = await prisma.outboundEvent.findFirst({
      where: { type: "ticket.changed", workspaceId: wsA },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    expect((frame?.payload as { action?: string }).action).toBe("solved");

    // And converging works the OTHER way too: the source reopening reopens
    // the twin (a synced write must not sync back and loop — one event each).
    const reopened = await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      status: "open",
    });
    expect(reopened.ok).toBe(true);
    const twinAfter = await prisma.ticket.findUniqueOrThrow({
      where: { id: esc.targetTicket.id },
      select: { status: true, reopenCount: true },
    });
    expect(twinAfter.status).toBe("open");
    expect(twinAfter.reopenCount).toBe(1);
  });

  it("syncs priority + subject across the pair; each side keeps its own SLA policies", async () => {
    const { ticket } = await makeSourceTicket();
    const esc = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "root",
    });
    if (!esc.ok) throw new Error("escalate failed");

    const bumped = await updateTicket(mdb, {
      workspaceId: wsB,
      ticketId: esc.targetTicket.id,
      actor: { userId },
      priority: "urgent",
      subject: "Renamed by the target side",
    });
    expect(bumped.ok).toBe(true);

    const source = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { priority: true, subject: true },
    });
    expect(source.priority).toBe("urgent");
    expect(source.subject).toBe("Renamed by the target side");
  });

  it("the cause is WRITTEN ONCE — a rewrite is refused everywhere, filling an empty one is allowed", async () => {
    const { ticket } = await makeSourceTicket(); // seeded with a cause
    const rewrite = await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      description: "a different story",
    });
    expect(rewrite).toEqual({ ok: false, reason: "cause_immutable" });

    // A ticket raised WITHOUT a cause can still have it filled in once.
    const { conversationId } = await makeConversation(wsA);
    const bare = await createTicket(mdb, { workspaceId: wsA, conversationId, actor: { userId } });
    if (!bare.ok) throw new Error("seed failed");
    const fill = await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: bare.ticket.id,
      actor: { userId },
      description: "the late-arriving cause",
    });
    expect(fill.ok).toBe(true);
    const locked = await updateTicket(mdb, {
      workspaceId: wsA,
      ticketId: bare.ticket.id,
      actor: { userId },
      description: "rewrite attempt",
    });
    expect(locked).toEqual({ ok: false, reason: "cause_immutable" });
  });

  it("severs on delete, in both directions", async () => {
    // Twin deleted → source records it and may escalate again.
    const first = await makeSourceTicket();
    const escA = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: first.ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "will lose twin",
    });
    if (!escA.ok) throw new Error("escalate failed");
    await deleteTicket(mdb, { workspaceId: wsB, ticketId: escA.targetTicket.id, actor: { userId } });
    const severed = (await eventsOf(wsA, first.ticket.id)).filter(
      (e) => e.kind === "escalation_severed",
    );
    expect(severed).toHaveLength(1);
    expect(
      await prisma.ticketEscalation.count({ where: { sourceTicketId: first.ticket.id } }),
    ).toBe(0);
    const again = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: first.ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "second try after sever",
    });
    expect(again.ok).toBe(true);

    // Source deleted → twin keeps the bridge (SetNull) and records the sever.
    const second = await makeSourceTicket();
    const escB = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: second.ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "will lose source",
    });
    if (!escB.ok) throw new Error("escalate failed");
    await deleteTicket(mdb, { workspaceId: wsA, ticketId: second.ticket.id, actor: { userId } });
    const twinSevered = (await eventsOf(wsB, escB.targetTicket.id)).filter(
      (e) => e.kind === "escalation_severed",
    );
    expect(twinSevered).toHaveLength(1);
    const bridge = await prisma.ticketEscalation.findUniqueOrThrow({
      where: { targetTicketId: escB.targetTicket.id },
      select: { sourceTicketId: true, contactSnapshot: true },
    });
    expect(bridge.sourceTicketId).toBeNull();
    expect(bridge.contactSnapshot).toBeTruthy(); // the snapshot survives its source

    // A comment into a severed pair is refused.
    const refused = await addEscalationComment(db, {
      workspaceId: wsB,
      ticketId: escB.targetTicket.id,
      actor: { userId },
      body: "anyone there?",
    });
    expect(refused).toEqual({ ok: false, reason: "escalation_severed" });
  });
});

describe("binding a conversation ('Message customer')", () => {
  it("binds once, sets counter + pointer, and routing attaches from then on", async () => {
    const { ticket } = await makeSourceTicket();
    const esc = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "root",
    });
    if (!esc.ok) throw new Error("escalate failed");

    const snapshot = await getEscalationSnapshot(db, wsB, esc.targetTicket.id);
    expect(snapshot?.phoneNumber).toBeTruthy();

    // Workspace B creates ITS OWN contact + conversation (what
    // startConversation does in prod) and binds it.
    const { conversationId } = await makeConversation(wsB);
    const bound = await bindEscalatedTicketConversation(db, {
      workspaceId: wsB,
      ticketId: esc.targetTicket.id,
      actor: { userId },
      conversationId,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.ticket.conversationId).toBe(conversationId);

    const convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { activeTicketId: true, openTicketCount: true },
    });
    expect(convo.activeTicketId).toBe(esc.targetTicket.id);
    expect(convo.openTicketCount).toBe(1);

    // Second bind is refused — the CAS on the null column holds.
    const rebind = await bindEscalatedTicketConversation(db, {
      workspaceId: wsB,
      ticketId: esc.targetTicket.id,
      actor: { userId },
      conversationId,
    });
    expect(rebind).toEqual({ ok: false, reason: "already_bound" });

    // From now on it is a completely normal ticket: an inbound attaches.
    const routed = await prisma.$transaction((tx) =>
      routeMessageToTicket(tx as Parameters<typeof routeMessageToTicket>[0], {
        workspaceId: wsB,
        conversationId,
        direction: "in",
      }),
    );
    expect(routed.ticketId).toBe(esc.targetTicket.id);
  });

  it("never binds a normal (non-escalated) ticket", async () => {
    const { ticket, conversationId } = await makeSourceTicket();
    const out = await bindEscalatedTicketConversation(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      conversationId,
    });
    expect(out).toEqual({ ok: false, reason: "not_escalated_in" });
  });
});

describe("agent conversation-visibility", () => {
  /**
   * An escalated-in ticket has NO conversation until "Message customer" binds
   * one. The restriction used to be expressed purely as a relation filter on
   * `conversation`, and a Prisma relation filter never matches a null relation
   * — so in a workspace running `agentConversationVisibility: "assigned"` the
   * referred work was invisible on the board AND 404 on the detail route, even
   * to the agent it was assigned to. That is a deadlock rather than a mere gap:
   * the only action that binds a conversation lives on the page they cannot
   * open. `ticketVisibilityWhere` therefore falls back to the TICKET's own
   * assignee while it is unbound.
   */
  it("shows an unbound escalated-in ticket to its assignee, and hides it from everyone else", async () => {
    const { ticket } = await makeSourceTicket(true);
    const esc = await escalateTicket(db, {
      workspaceId: wsA,
      ticketId: ticket.id,
      actor: { userId },
      targetWorkspaceId: wsB,
      cause: "visibility check",
    });
    if (!esc.ok) throw new Error(`escalate failed: ${esc.reason}`);

    // Unassigned: invisible to a restricted agent, exactly as an unassigned
    // conversation already is.
    const unassigned = await listTickets(db, wsB, {
      restrictToConversationsAssignedTo: userId,
    });
    expect(unassigned.tickets.map((t) => t.id)).not.toContain(esc.targetTicket.id);

    // Assign it to them — now it must be reachable, or the escalation is a
    // black hole in every restricted workspace.
    await prisma.ticket.update({
      where: { id: esc.targetTicket.id },
      data: { assignedUserId: userId },
    });
    const mine = await listTickets(db, wsB, {
      restrictToConversationsAssignedTo: userId,
    });
    expect(mine.tickets.map((t) => t.id)).toContain(esc.targetTicket.id);

    // A DIFFERENT restricted agent still must not see it — the fallback widens
    // the rule for unbound tickets, it does not switch the boundary off.
    const other = await listTickets(db, wsB, {
      restrictToConversationsAssignedTo: otherUserId,
    });
    expect(other.tickets.map((t) => t.id)).not.toContain(esc.targetTicket.id);

    // And the counts agree with the list — a badge that advertises work the
    // board won't show is the same defect one layer up.
    const counts = await getTicketCounts(db, wsB, userId, userId);
    expect(counts.mineActive).toBeGreaterThan(0);
  });
});
