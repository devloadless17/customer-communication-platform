import { Prisma, type PrismaClient } from "@prisma/client";

import type { ContactSnapshot, Ticket } from "@ccp/shared/tickets/types";
import { isTicketActive } from "@ccp/shared/tickets/types";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";

import { computeDueDates } from "./sla";
import {
  allocateNumber,
  bumpOpenTicketCount,
  loadSlaContext,
  publishTicketEvent,
  readTicket,
  writeTicketEvent,
  type TicketActor,
} from "./mutations";
import { asContactSnapshot } from "./queries";

/**
 * Cross-workspace ticket escalation ("referral") — the ONLY feature that
 * deliberately spans two workspaces in one organization.
 *
 * Agent X in workspace A can't answer, so the ticket is referred to a sibling
 * workspace: a TWIN ticket is created over there (own number, own board card,
 * that workspace's own SLA) carrying a contact SNAPSHOT, and a
 * `TicketEscalation` row links the pair. Everything the two sides share
 * travels as MIRRORED TicketEvent rows — one per side, each workspace-scoped
 * to its own ticket — so no read path ever crosses the tenancy boundary.
 * Tickets themselves still never cross workspaces.
 *
 * Same posture as mutations.ts: `db` injected, typed outcomes, no NestJS
 * exceptions, `publishInTx` + `kickOutbox`.
 */

type Db = Pick<
  PrismaClient,
  | "ticket"
  | "ticketEvent"
  | "ticketEscalation"
  | "ticketNumberCounter"
  | "ticketSlaPolicy"
  | "conversation"
  | "workspace"
  | "contact"
  | "contactFieldDefinition"
  | "$transaction"
>;

export type EscalateOutcome =
  | { ok: true; sourceTicket: Ticket; targetTicket: Ticket }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "ticket_terminal" }
  | { ok: false; reason: "already_escalated" }
  /** An escalation TARGET cannot be escalated onward — chains are banned so the
   *  mirror stays strictly 1:1 and an A→B→A relay loop cannot exist. */
  | { ok: false; reason: "cannot_escalate_escalated_ticket" }
  /** The ticket has no contact (already-escalated-in, unbound) — nothing to snapshot. */
  | { ok: false; reason: "no_contact" }
  | { ok: false; reason: "target_workspace_not_found" };

export interface EscalateTicketArgs {
  workspaceId: string;
  ticketId: string;
  actor: TicketActor;
  targetWorkspaceId: string;
  /** Why this is being escalated — required; it becomes the twin's description
   *  and the `escalated` timeline row's body. */
  cause: string;
  subject?: string | null;
}

/**
 * Build the profile snapshot the target workspace is handed. Custom-field
 * KEYS are per-workspace vocabulary, so they are resolved to their LABELS
 * here — a `plan_tier` key means nothing in the receiving workspace, but the
 * "Plan tier" label reads fine on the snapshot card.
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
 * Escalate a ticket to a sibling workspace: create the twin + the bridge row +
 * both timeline entries + both (workspace-scoped) events in ONE transaction.
 *
 * The source ticket's own state deliberately does NOT move — parking it
 * `on_hold` while the other workspace works is the agent's call, not a side
 * effect. One escalation per ticket lifetime, DB-enforced by the @unique on
 * `sourceTicketId`.
 */
export async function escalateTicket(db: Db, args: EscalateTicketArgs): Promise<EscalateOutcome> {
  const source = await db.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId },
    select: {
      id: true,
      status: true,
      priority: true,
      subject: true,
      channel: true,
      contactId: true,
      conversationId: true,
      escalationOut: { select: { id: true } },
      escalationIn: { select: { id: true } },
    },
  });
  if (!source) return { ok: false, reason: "ticket_not_found" };
  if (!isTicketActive(source.status)) return { ok: false, reason: "ticket_terminal" };
  if (source.escalationOut) return { ok: false, reason: "already_escalated" };
  if (source.escalationIn) return { ok: false, reason: "cannot_escalate_escalated_ticket" };
  if (!source.contactId) return { ok: false, reason: "no_contact" };

  // The organization is derived from the SOURCE workspace, never taken from
  // input — the caller's session workspace defines whose siblings exist.
  const sourceWorkspace = await db.workspace.findUniqueOrThrow({
    where: { id: args.workspaceId },
    select: { name: true, organizationId: true },
  });

  // Org-scoped and never the caller's own workspace. A cross-org id gets the
  // same answer as a nonexistent one — this route must not confirm what
  // workspaces exist outside the caller's organization.
  const target =
    args.targetWorkspaceId === args.workspaceId
      ? null
      : await db.workspace.findFirst({
          where: { id: args.targetWorkspaceId, organizationId: sourceWorkspace.organizationId },
          select: { id: true, name: true },
        });
  if (!target) return { ok: false, reason: "target_workspace_not_found" };
  const contact = await db.contact.findFirst({
    where: { id: source.contactId, workspaceId: args.workspaceId },
    select: {
      name: true,
      phoneNumber: true,
      email: true,
      identityChannel: true,
      customFields: true,
    },
  });
  if (!contact) return { ok: false, reason: "no_contact" };
  const snapshot = await buildContactSnapshot(db, args.workspaceId, contact);

  const run = () =>
    db.$transaction(async (tx) => {
      const number = await allocateNumber(tx, target.id);
      const { policy, schedule } = await loadSlaContext(tx, target.id, source.priority);
      const due = computeDueDates(Date.now(), policy, schedule);

      const twin = await tx.ticket.create({
        data: {
          workspaceId: target.id,
          number,
          conversationId: null,
          contactId: null,
          channel: source.channel,
          subject: args.subject ?? source.subject,
          // The cause IS the twin's defining context — the receiving team
          // understands the issue without access to the source thread.
          description: args.cause,
          status: "new",
          priority: source.priority,
          slaPolicyId: policy?.id ?? null,
          firstResponseDueAt: due.firstResponseDueAt,
          resolutionDueAt: due.resolutionDueAt,
          source: "escalation",
          createdById: args.actor.userId ?? null,
          createdByApiKeyId: args.actor.apiKeyId ?? null,
        },
        select: { id: true, number: true },
      });

      await tx.ticketEscalation.create({
        data: {
          organizationId: sourceWorkspace.organizationId,
          sourceWorkspaceId: args.workspaceId,
          sourceTicketId: source.id,
          targetWorkspaceId: target.id,
          targetTicketId: twin.id,
          contactSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          createdById: args.actor.userId ?? null,
        },
      });

      await writeTicketEvent(
        tx,
        args.workspaceId,
        source.id,
        "escalated",
        args.actor,
        null,
        {
          targetWorkspaceId: target.id,
          targetWorkspaceName: target.name,
          targetTicketId: twin.id,
          targetTicketNumber: twin.number,
        },
        args.cause,
      );
      // The twin's BIRTH event — `escalation_received` instead of `created`, so
      // its timeline opens with where the work came from.
      await writeTicketEvent(
        tx,
        target.id,
        twin.id,
        "escalation_received",
        args.actor,
        null,
        {
          number: twin.number,
          subject: args.subject ?? source.subject,
          priority: source.priority,
          sourceWorkspaceId: args.workspaceId,
          sourceWorkspaceName: sourceWorkspace.name,
        },
        args.cause,
      );

      const targetTicket = await readTicket(tx, twin.id);
      const sourceTicket = await readTicket(tx, source.id);
      const sourceCount = source.conversationId
        ? await bumpOpenTicketCount(tx, source.conversationId, 0)
        : 0;

      // Two publishes, each carrying its OWN side's workspaceId — the existing
      // fanout rule scopes each frame to its own workspace room. The target
      // sees an ordinary `created` (its board adds the card through the code
      // it already has); the source sees `escalated`.
      await publishTicketEvent(tx, {
        args: { workspaceId: target.id, actor: args.actor },
        ticket: targetTicket,
        openTicketCount: 0,
        action: "created",
        previousStatus: null,
      });
      await publishTicketEvent(tx, {
        args: { workspaceId: args.workspaceId, actor: args.actor },
        ticket: sourceTicket,
        openTicketCount: sourceCount,
        action: "escalated",
        previousStatus: sourceTicket.status,
      });

      return { sourceTicket, targetTicket };
    });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Two P2002s can land here: a concurrent escalate of the SAME ticket hit
      // the `sourceTicketId` unique (a real conflict), or a drifted number
      // counter hit `(workspaceId, number)` (retry once — the counter has
      // advanced past the collision, same rule as createTicket). Which one is
      // decided by RE-READING STATE, not by parsing `err.meta.target` — the
      // driver adapter's error shape has defeated that classifier before.
      const winner = await db.ticketEscalation.findFirst({
        where: { sourceTicketId: source.id },
        select: { id: true },
      });
      if (winner) return { ok: false, reason: "already_escalated" };
      result = await run();
    } else {
      throw err;
    }
  }
  kickOutbox();
  return { ok: true, ...result };
}

// ---------------------------------------------------------------------------
// Shared comments.
// ---------------------------------------------------------------------------

export type EscalationCommentOutcome =
  | { ok: true }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "not_escalated" }
  /** The twin was deleted — there is nobody on the other end any more. */
  | { ok: false; reason: "escalation_severed" }
  | { ok: false; reason: "empty_comment" };

/**
 * Post a comment BOTH workspaces see, from either side of the pair.
 *
 * Written mirrored — one `escalation_note` row per side, each scoped to its
 * own ticket — so each workspace reads its own timeline and nothing else.
 * Like an internal note, this is NOT a ticket update: no `version` bump, no
 * SLA movement. The other side gets a realtime `escalation_update` frame; the
 * poster's own view refetches after the POST, same as `addNote`.
 */
export async function addEscalationComment(
  db: Db,
  args: { workspaceId: string; ticketId: string; actor: TicketActor; body: string },
): Promise<EscalationCommentOutcome> {
  const body = args.body.trim();
  if (!body) return { ok: false, reason: "empty_comment" };

  const ticket = await db.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId },
    select: {
      id: true,
      escalationOut: {
        select: {
          targetTicketId: true,
          targetWorkspaceId: true,
          targetWorkspace: { select: { name: true } },
        },
      },
      escalationIn: {
        select: {
          sourceTicketId: true,
          sourceWorkspaceId: true,
          sourceWorkspace: { select: { name: true } },
        },
      },
    },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  const pair = ticket.escalationOut
    ? { twinId: ticket.escalationOut.targetTicketId, twinWorkspaceId: ticket.escalationOut.targetWorkspaceId }
    : ticket.escalationIn
      ? { twinId: ticket.escalationIn.sourceTicketId, twinWorkspaceId: ticket.escalationIn.sourceWorkspaceId }
      : null;
  if (!pair) return { ok: false, reason: "not_escalated" };
  if (!pair.twinId) return { ok: false, reason: "escalation_severed" };
  const { twinId } = pair;

  const posterWorkspace = await db.workspace.findUniqueOrThrow({
    where: { id: args.workspaceId },
    select: { name: true },
  });

  await db.$transaction(async (tx) => {
    const from = {
      fromWorkspaceId: args.workspaceId,
      fromWorkspaceName: posterWorkspace.name,
    };
    await writeTicketEvent(tx, args.workspaceId, ticket.id, "escalation_note", args.actor, null, from, body);
    await writeTicketEvent(tx, pair.twinWorkspaceId, twinId, "escalation_note", args.actor, null, from, body);

    // Realtime for the OTHER side only — its open detail view refetches the
    // timeline on `escalation_update`. Silent: a mirrored notification must
    // never chain workflows or echo a partner webhook (§9).
    const twin = await readTicket(tx, twinId);
    const twinCount = twin.conversationId ? await bumpOpenTicketCount(tx, twin.conversationId, 0) : 0;
    await publishInTx(tx, {
      type: "ticket.changed",
      workspaceId: pair.twinWorkspaceId,
      ticketId: twin.id,
      conversationId: twin.conversationId,
      contactId: twin.contactId,
      action: "escalation_update",
      ticket: twin,
      previousStatus: twin.status,
      openTicketCount: twinCount,
      changedByUserId: args.actor.userId ?? null,
      changedByApiKeyId: args.actor.apiKeyId ?? null,
      silent: true,
      skipOutboundWebhook: true,
    });
  });
  kickOutbox();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Binding a conversation ("Message customer").
// ---------------------------------------------------------------------------

export type BindConversationOutcome =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "not_escalated_in" }
  | { ok: false; reason: "already_bound" }
  | { ok: false; reason: "conversation_not_found" };

/**
 * Bind a conversation (created via the canonical `startConversation` path from
 * the snapshot's phone) to an escalated-in ticket. From this moment the ticket
 * is a completely normal ticket: inbound replies attach through
 * `routeMessageToTicket`, first response stamps, close-on-last-solved applies.
 */
export async function bindEscalatedTicketConversation(
  db: Db,
  args: { workspaceId: string; ticketId: string; actor: TicketActor; conversationId: string },
): Promise<BindConversationOutcome> {
  const ticket = await db.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId },
    select: { id: true, status: true, conversationId: true, escalationIn: { select: { id: true } } },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  if (!ticket.escalationIn) return { ok: false, reason: "not_escalated_in" };
  if (ticket.conversationId) return { ok: false, reason: "already_bound" };

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: { id: true, contactId: true, channel: true },
  });
  if (!conversation) return { ok: false, reason: "conversation_not_found" };

  const result = await db.$transaction(async (tx) => {
    // CAS on the still-null conversation so a double-click binds exactly once.
    const written = await tx.ticket.updateMany({
      where: { id: ticket.id, workspaceId: args.workspaceId, conversationId: null },
      data: {
        conversationId: conversation.id,
        contactId: conversation.contactId,
        // The twin talks to the customer on ITS OWN channel — a WhatsApp
        // escalation answered from this workspace's number, or even another
        // channel entirely.
        channel: conversation.channel,
        version: { increment: 1 },
      },
    });
    if (written.count === 0) return null;

    const active = isTicketActive(ticket.status);
    const openTicketCount = active
      ? await bumpOpenTicketCount(tx, conversation.id, 1)
      : await bumpOpenTicketCount(tx, conversation.id, 0);
    if (active) {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { activeTicketId: ticket.id },
      });
    }

    await writeTicketEvent(tx, args.workspaceId, ticket.id, "field_changed", args.actor, null, {
      conversationLinked: true,
    });
    const mapped = await readTicket(tx, ticket.id);
    await publishTicketEvent(tx, {
      args: { workspaceId: args.workspaceId, actor: args.actor },
      ticket: mapped,
      openTicketCount,
      action: "updated",
      previousStatus: mapped.status,
    });
    return mapped;
  });
  if (!result) return { ok: false, reason: "already_bound" };
  kickOutbox();
  return { ok: true, ticket: result };
}

/** The snapshot for a ticket's inbound escalation, or null. Used by the
 *  "Message customer" route to pull the phone without re-shaping the JSON. */
export async function getEscalationSnapshot(
  db: Db,
  workspaceId: string,
  ticketId: string,
): Promise<ContactSnapshot | null> {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    select: { escalationIn: { select: { contactSnapshot: true } } },
  });
  if (!ticket?.escalationIn) return null;
  return asContactSnapshot(ticket.escalationIn.contactSnapshot);
}
