import { Prisma, type PrismaClient } from "@prisma/client";

import type { ContactSnapshot, Ticket } from "@ccp/shared/tickets/types";
import { isTicketActive } from "@ccp/shared/tickets/types";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";

import { ticketByIdWhere } from "./access";
import {
  bumpOpenTicketCount,
  publishTicketEvent,
  readTicket,
  touchTicketActivity,
  writeTicketEvent,
  type TicketActor,
} from "./mutations";
import { asContactSnapshot } from "./queries";

/**
 * Cross-workspace ticket SHARING — how two departments work one customer's
 * issue together.
 *
 * A ticket is the unit of communication between departments, so there is
 * exactly ONE ticket: one number, one status, one priority, one history.
 * Escalating does not copy it into the other workspace; it writes a
 * `TicketShare` row granting that workspace access to the same ticket. Every
 * change either side makes IS the change — nothing is mirrored, nothing can
 * drift, and the log says which department did what.
 *
 * (This replaced a twin-pair design from three days earlier, where each side
 * held its own ticket row and the two were kept in sync. Two rows meant two
 * numbers to quote, two histories to read, and a sync path that was one bug
 * away from disagreeing with itself.)
 *
 * What crosses the boundary is bounded by the share row, not by the ticket:
 *   - the contact SNAPSHOT (frozen at share time, never a live join)
 *   - the guest's OWN conversation with the customer, if they start one
 * The owner's conversation, its messages, and their contact record stay
 * private.
 */

type Db = Pick<
  PrismaClient,
  | "ticket"
  | "ticketEvent"
  | "ticketShare"
  | "conversation"
  | "workspace"
  | "contact"
  | "contactFieldDefinition"
  | "$transaction"
>;

export type ShareOutcome =
  | { ok: true; ticket: Ticket; guestWorkspaceName: string }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "ticket_terminal" }
  | { ok: false; reason: "already_shared" }
  | { ok: false; reason: "no_contact" }
  | { ok: false; reason: "target_workspace_not_found" };

export interface ShareTicketArgs {
  /** The workspace the caller is acting in — must already have access. */
  workspaceId: string;
  ticketId: string;
  actor: TicketActor;
  /** The sibling workspace being granted access. */
  targetWorkspaceId: string;
  /** Why — required, and it becomes the ticket's cause when it has none yet. */
  cause: string;
}

/**
 * Build the profile snapshot a guest workspace is handed. Custom-field KEYS are
 * per-workspace vocabulary, so they are resolved to LABELS here — `plan_tier`
 * means nothing in the receiving department, "Plan tier" reads fine.
 */
export async function buildContactSnapshot(
  db: Pick<Db, "contactFieldDefinition">,
  workspaceId: string,
  contact: {
    name: string;
    phoneNumber: string | null;
    email: string | null;
    identityChannel: string;
    customFields: unknown;
  },
): Promise<ContactSnapshot> {
  const defs = await db.contactFieldDefinition.findMany({
    where: { workspaceId },
    select: { key: true, label: true },
  });
  const labelByKey = new Map(defs.map((d) => [d.key, d.label]));
  const raw =
    contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields)
      ? (contact.customFields as Record<string, unknown>)
      : {};
  const customFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !value) continue;
    customFields[labelByKey.get(key) ?? key] = value;
  }
  return {
    name: contact.name || null,
    phoneNumber: contact.phoneNumber,
    email: contact.email,
    identityChannel: contact.identityChannel,
    customFields,
  };
}

/**
 * Grant a sibling workspace access to this ticket.
 *
 * Callable by ANY workspace that already has access — a guest department that
 * realises Logistics also needs to weigh in can loop them in without going back
 * to the owner. The snapshot always comes from the OWNER's contact record (the
 * one true customer), never from the caller's view of it.
 */
export async function shareTicket(db: Db, args: ShareTicketArgs): Promise<ShareOutcome> {
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: {
      id: true,
      status: true,
      workspaceId: true,
      contactId: true,
      conversationId: true,
      description: true,
      workspace: { select: { organizationId: true, name: true } },
      shares: { select: { guestWorkspaceId: true } },
    },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  if (!isTicketActive(ticket.status)) return { ok: false, reason: "ticket_terminal" };
  if (!ticket.contactId) return { ok: false, reason: "no_contact" };

  // Already a participant — the OWNER counts too (sharing a ticket back to the
  // workspace that raised it is meaningless, not a second key).
  if (
    args.targetWorkspaceId === ticket.workspaceId ||
    ticket.shares.some((s) => s.guestWorkspaceId === args.targetWorkspaceId)
  ) {
    return { ok: false, reason: "already_shared" };
  }

  // Org-scoped: a cross-org id answers exactly like a nonexistent one, so this
  // route never confirms what workspaces exist outside the caller's org.
  const target = await db.workspace.findFirst({
    where: {
      id: args.targetWorkspaceId,
      organizationId: ticket.workspace.organizationId,
    },
    select: { id: true, name: true },
  });
  if (!target) return { ok: false, reason: "target_workspace_not_found" };

  const contact = await db.contact.findFirst({
    where: { id: ticket.contactId, workspaceId: ticket.workspaceId },
    select: { name: true, phoneNumber: true, email: true, identityChannel: true, customFields: true },
  });
  if (!contact) return { ok: false, reason: "no_contact" };
  const snapshot = await buildContactSnapshot(db, ticket.workspaceId, contact);

  const result = await db.$transaction(async (tx) => {
    try {
      await tx.ticketShare.create({
        data: {
          organizationId: ticket.workspace.organizationId,
          ticketId: ticket.id,
          ownerWorkspaceId: ticket.workspaceId,
          guestWorkspaceId: target.id,
          contactSnapshot: { ...snapshot },
          createdById: args.actor.userId ?? null,
        },
      });
    } catch (err) {
      // The unique (ticketId, guestWorkspaceId) — a concurrent escalate to the
      // same department. Not an error worth surfacing as a failure: the key is
      // granted either way.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return null;
      }
      throw err;
    }

    // The ticket has ONE cause, written once. If it was raised without one, the
    // escalation reason becomes it — that is the founding context whoever picks
    // this up will read. If it already has one, the reason is a comment instead,
    // so nothing is rewritten and nothing is lost.
    if (!ticket.description) {
      await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          description: args.cause,
          version: { increment: 1 },
          lastActivityAt: new Date(),
        },
      });
    }
    // Handing the ticket to another department is activity whether or not the
    // cause was filled — the branch above only runs when it was empty.
    await touchTicketActivity(tx, ticket.id);

    await writeTicketEvent(
      tx,
      ticket.workspaceId,
      ticket.id,
      "escalated",
      args.actor,
      null,
      { guestWorkspaceId: target.id, guestWorkspaceName: target.name },
      args.cause,
    );

    const mapped = await readTicket(tx, ticket.id);
    const openTicketCount = ticket.conversationId
      ? await bumpOpenTicketCount(tx, ticket.conversationId, 0)
      : 0;
    // ONE event. The fanout rule emits it to the owner AND every guest, because
    // it reads the ticket's shares — the "who should see this" question has one
    // answer and one place that answers it.
    await publishTicketEvent(tx, {
      args: { workspaceId: ticket.workspaceId, actor: args.actor },
      ticket: mapped,
      openTicketCount,
      action: "escalated",
      previousStatus: mapped.status,
    });
    return mapped;
  });

  if (!result) return { ok: false, reason: "already_shared" };
  kickOutbox();
  return { ok: true, ticket: result, guestWorkspaceName: target.name };
}

export type RevokeOutcome =
  | { ok: true }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "share_not_found" }
  | { ok: false; reason: "forbidden" };

/**
 * Take a workspace's access away.
 *
 * Only the OWNER may revoke, or a guest revoking ITSELF ("we're done here").
 * A guest cannot evict a different department — that decision belongs to the
 * workspace that owns the customer. The history stays: who had the key, and
 * until when.
 */
export async function revokeTicketShare(
  db: Db,
  args: { workspaceId: string; ticketId: string; guestWorkspaceId: string; actor: TicketActor },
): Promise<RevokeOutcome> {
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: {
      id: true,
      workspaceId: true,
      conversationId: true,
      shares: {
        where: { guestWorkspaceId: args.guestWorkspaceId },
        select: { id: true, guestWorkspace: { select: { name: true } } },
      },
    },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  const share = ticket.shares[0];
  if (!share) return { ok: false, reason: "share_not_found" };

  const isOwner = ticket.workspaceId === args.workspaceId;
  const isSelf = args.guestWorkspaceId === args.workspaceId;
  if (!isOwner && !isSelf) return { ok: false, reason: "forbidden" };

  await db.$transaction(async (tx) => {
    await tx.ticketShare.delete({ where: { id: share.id } });
    // Written AFTER the delete but in the same transaction: the entry describes
    // a completed revocation, and rolling back takes both.
    await writeTicketEvent(tx, ticket.workspaceId, ticket.id, "escalation_revoked", args.actor, null, {
      guestWorkspaceId: args.guestWorkspaceId,
      guestWorkspaceName: share.guestWorkspace.name,
    });
    const mapped = await readTicket(tx, ticket.id);
    const openTicketCount = ticket.conversationId
      ? await bumpOpenTicketCount(tx, ticket.conversationId, 0)
      : 0;
    await publishTicketEvent(tx, {
      args: { workspaceId: ticket.workspaceId, actor: args.actor },
      ticket: mapped,
      openTicketCount,
      action: "escalation_update",
      previousStatus: mapped.status,
      // The revoked workspace must be told to drop the card, so the frame goes
      // to it too — one last emit to an audience that just lost access.
      alsoNotifyWorkspaceIds: [args.guestWorkspaceId],
    });
  });
  kickOutbox();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// A guest starting its own conversation with the customer.
// ---------------------------------------------------------------------------

export type BindGuestConversationOutcome =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "not_a_guest" }
  | { ok: false; reason: "already_bound" }
  | { ok: false; reason: "conversation_not_found" };

/**
 * Bind the guest workspace's OWN conversation to the shared ticket.
 *
 * The guest messages the customer from THEIR number, on THEIR channel, in
 * THEIR inbox — the owner's thread is never touched. The binding lives on the
 * share row, so each department keeps its own thread with the same person while
 * both work one ticket.
 */
export async function bindGuestConversation(
  db: Db,
  args: { workspaceId: string; ticketId: string; actor: TicketActor; conversationId: string },
): Promise<BindGuestConversationOutcome> {
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: {
      id: true,
      workspaceId: true,
      shares: {
        where: { guestWorkspaceId: args.workspaceId },
        select: { id: true, guestConversationId: true },
      },
    },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  const share = ticket.shares[0];
  if (!share) return { ok: false, reason: "not_a_guest" };
  if (share.guestConversationId) return { ok: false, reason: "already_bound" };

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: { id: true },
  });
  if (!conversation) return { ok: false, reason: "conversation_not_found" };

  const mapped = await db.$transaction(async (tx) => {
    // CAS on the still-null column so a double-click binds exactly once.
    const written = await tx.ticketShare.updateMany({
      where: { id: share.id, guestConversationId: null },
      data: { guestConversationId: conversation.id },
    });
    if (written.count === 0) return null;
    await writeTicketEvent(tx, ticket.workspaceId, ticket.id, "field_changed", args.actor, null, {
      guestConversationLinked: true,
    });
    const t = await readTicket(tx, ticket.id);
    await publishInTx(tx, {
      type: "ticket.changed",
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      conversationId: t.conversationId,
      contactId: t.contactId,
      action: "escalation_update",
      ticket: t,
      previousStatus: t.status,
      openTicketCount: 0,
      changedByUserId: args.actor.userId ?? null,
      changedByApiKeyId: args.actor.apiKeyId ?? null,
      silent: true,
      skipOutboundWebhook: true,
    });
    return t;
  });
  if (!mapped) return { ok: false, reason: "already_bound" };
  kickOutbox();
  return { ok: true, ticket: mapped };
}

/** The snapshot this workspace was handed for a ticket, or null when it is not
 *  a guest on it. Used by "Message the customer" to find the phone. */
export async function getGuestSnapshot(
  db: Db,
  workspaceId: string,
  ticketId: string,
): Promise<ContactSnapshot | null> {
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(workspaceId, ticketId),
    select: {
      shares: { where: { guestWorkspaceId: workspaceId }, select: { contactSnapshot: true } },
    },
  });
  const share = ticket?.shares[0];
  return share ? asContactSnapshot(share.contactSnapshot) : null;
}
