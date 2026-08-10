import type { Prisma, PrismaClient } from "@prisma/client";

import { ticketAccessWhere, ticketByIdWhere } from "./access";
import { OPERATOR_DISPLAY_NAME, operatorActorIds } from "@/lib/workspaces/operator-mask";

import type {
  ContactSnapshot,
  Ticket,
  TicketAttachment,
  TicketCounts,
  TicketEvent,
  TicketSharingInfo,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from "@ccp/shared/tickets/types";
import { TICKET_ACTIVE_STATUSES, TICKET_SOURCES } from "@ccp/shared/tickets/types";

/**
 * Read side of tickets — the SELECT shapes, the row→wire mappers, and the
 * board/list query.
 *
 * Framework-agnostic (lib/): `db` is injected, so the NestJS service, the /v1
 * service, the workflow steps and the SLA sweeper all read tickets through one
 * shape. Same contract as lib/message-flags/queries.ts.
 */

type Db = Pick<PrismaClient, "ticket" | "ticketEvent" | "ticketThreadUnread" | "user">;

/**
 * OPERATOR MASK (see lib/workspaces/operator-mask.ts). Ticket DTOs join actor
 * names server-side — deliberately, because a guest workspace cannot resolve an
 * owner-workspace author from its own roster — which is exactly why the web's
 * member-map "Support" fallback never gets a chance to apply here. Mask at
 * mapping time, relative to the READER's workspace: a superAdmin acting where
 * they hold no membership renders as "Support"; in their own anchor workspace
 * they are a member and their name is real.
 *
 * Applied to every user-name field an operator can occupy: event `actorName`,
 * attachment `uploadedByName`, and the ticket's `resolvedByName`
 * (`assignedUserName` is unreachable — assignment is membership-validated).
 */
async function maskTicketEventNames(
  db: Db,
  workspaceId: string,
  events: TicketEvent[],
): Promise<TicketEvent[]> {
  const masked = await operatorActorIds(
    db,
    events.flatMap((e) => [
      e.actorUserId,
      ...(e.attachments ?? []).map((a) => a.uploadedById),
    ]),
    [workspaceId],
  );
  if (masked.size === 0) return events;
  return events.map((e) => ({
    ...e,
    actorName: e.actorUserId && masked.has(e.actorUserId) ? OPERATOR_DISPLAY_NAME : e.actorName,
    attachments: (e.attachments ?? []).map((a) =>
      a.uploadedById && masked.has(a.uploadedById)
        ? { ...a, uploadedByName: OPERATOR_DISPLAY_NAME }
        : a,
    ),
  }));
}

async function maskTicketNames(
  db: Db,
  workspaceId: string,
  tickets: Ticket[],
): Promise<Ticket[]> {
  const masked = await operatorActorIds(
    db,
    tickets.flatMap((t) => [t.resolvedById, ...t.attachments.map((a) => a.uploadedById)]),
    [workspaceId],
  );
  if (masked.size === 0) return tickets;
  return tickets.map((t) => ({
    ...t,
    resolvedByName:
      t.resolvedById && masked.has(t.resolvedById) ? OPERATOR_DISPLAY_NAME : t.resolvedByName,
    attachments: t.attachments.map((a) =>
      a.uploadedById && masked.has(a.uploadedById)
        ? { ...a, uploadedByName: OPERATOR_DISPLAY_NAME }
        : a,
    ),
  }));
}

/** Board/list page size. Keyset-paginated, so this is a hard per-request bound. */
export const TICKET_PAGE = 50;

/**
 * Attachment columns every read needs. Declared as a bare field object (not a
 * `satisfies Prisma.TicketAttachmentSelect`) so it can be embedded in both the
 * ticket select and the event select without re-listing it.
 */
export const ATTACHMENT_SELECT_FIELDS = {
  id: true,
  filename: true,
  mimeType: true,
  kind: true,
  sizeBytes: true,
  eventId: true,
  messageId: true,
  uploadedById: true,
  createdAt: true,
  uploadedBy: { select: { name: true } },
  workspace: { select: { name: true } },
} as const;

type AttachmentRow = {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  eventId: string | null;
  messageId: string | null;
  uploadedById: string | null;
  createdAt: Date;
  uploadedBy: { name: string } | null;
  workspace: { name: string } | null;
};

/** Bytes are NEVER handed out as a storage URL — the browser fetches them
 *  same-origin so the workspace/share gate applies to every byte. */
export function mapAttachment(a: AttachmentRow, ticketId: string): TicketAttachment {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    kind: a.kind,
    sizeBytes: a.sizeBytes,
    url: `/api/tickets/${ticketId}/attachments/${a.id}`,
    eventId: a.eventId,
    messageId: a.messageId,
    uploadedById: a.uploadedById,
    uploadedByName: a.uploadedBy?.name ?? null,
    workspaceName: a.workspace?.name ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

/**
 * The ticket as every read path returns it.
 *
 * Actor and contact NAMES are joined (not just ids) for the same reason
 * MESSAGE_FLAG_SELECT inlines its definition: a board card, a list row and a
 * realtime frame each have to render without the client holding the roster.
 * The joins select `name` only — a card needs a label, not a full User.
 */
export const TICKET_SELECT = {
  id: true,
  number: true,
  conversationId: true,
  contactId: true,
  channel: true,
  subject: true,
  description: true,
  status: true,
  priority: true,
  assignedUserId: true,
  assignedTeamId: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstResponseAt: true,
  firstResponseBreached: true,
  resolutionBreached: true,
  slaPausedAt: true,
  resolvedAt: true,
  closedAt: true,
  resolvedById: true,
  resolutionCode: true,
  resolutionNote: true,
  reopenCount: true,
  source: true,
  customFields: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
  contact: { select: { name: true } },
  assignedUser: { select: { name: true } },
  resolvedBy: { select: { name: true } },
  tags: { select: { id: true, name: true, color: true } },
  // Which workspace OWNS the ticket. Needed on every read because the viewer
  // may be a guest — the owner/guest split decides which conversation the
  // viewer may open and whether they see the live contact or the snapshot.
  workspaceId: true,
  workspace: { select: { name: true } },
  // Everyone this ticket has been escalated to. Empty for the overwhelming
  // majority. The snapshot + guest conversation are per-share, so a guest's
  // own row supplies both.
  shares: {
    select: {
      id: true,
      guestWorkspaceId: true,
      guestWorkspace: { select: { name: true } },
      contactSnapshot: true,
      guestConversationId: true,
      assignedUserId: true,
      assignedUser: { select: { name: true } },
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  },
  // Ticket-level files (an event's files are joined on the timeline read).
  attachments: {
    select: ATTACHMENT_SELECT_FIELDS,
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.TicketSelect;

export type TicketRow = Prisma.TicketGetPayload<{ select: typeof TICKET_SELECT }>;

/** `source` is a free string in the DB (provenance, not behaviour) — narrow it
 *  at the boundary so an unrecognised legacy value can't leak into the wire type. */
function asSource(v: string): TicketSource {
  return (TICKET_SOURCES as readonly string[]).includes(v) ? (v as TicketSource) : "auto";
}

/** JSONB → the flat string map the wire type promises. Non-string values are
 *  dropped rather than coerced: a number silently becoming "42" would round-trip
 *  back into the DB as a string and quietly change the stored shape. */
function asCustomFields(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

/** JSONB → ContactSnapshot, tolerant of anything a legacy row might hold. */
export function asContactSnapshot(v: unknown): ContactSnapshot {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    name: typeof o.name === "string" ? o.name : null,
    phoneNumber: typeof o.phoneNumber === "string" ? o.phoneNumber : null,
    email: typeof o.email === "string" ? o.email : null,
    identityChannel: typeof o.identityChannel === "string" ? o.identityChannel : "whatsapp",
    customFields: asCustomFields(o.customFields),
  };
}

/**
 * The sharing block, from the VIEWING workspace's point of view.
 *
 * `viewerWorkspaceId` is REQUIRED, not optional: which conversation a caller
 * may open and whether they get the live contact or a frozen snapshot both
 * depend on it, and an optional viewer parameter that callers forget is exactly
 * how this codebase has killed a security control before (see
 * lib/conversations/visibility.ts).
 */
function mapSharing(t: TicketRow, viewerWorkspaceId: string): TicketSharingInfo | undefined {
  if (t.shares.length === 0) return undefined;
  const role = t.workspaceId === viewerWorkspaceId ? "owner" : "guest";
  const mine = t.shares.find((s) => s.guestWorkspaceId === viewerWorkspaceId);
  return {
    role,
    viewerWorkspaceId,
    ownerWorkspaceId: t.workspaceId,
    ownerWorkspaceName: t.workspace.name,
    guests: t.shares.map((s) => ({
      workspaceId: s.guestWorkspaceId,
      workspaceName: s.guestWorkspace.name,
      sharedAt: s.createdAt.toISOString(),
      // Who owns THAT department's side. Visible to every party: "waiting on
      // Billing" is only actionable if you can see nobody there has picked it up.
      assignedUserId: s.assignedUserId,
      assignedUserName: s.assignedUser?.name ?? null,
    })),
    // Only a guest gets a snapshot — the owner reads the live contact.
    ...(role === "guest" && mine
      ? { contactSnapshot: asContactSnapshot(mine.contactSnapshot) }
      : {}),
  };
}

/**
 * Row → wire, from the VIEWING workspace's point of view.
 *
 * The viewer decides two things on a SHARED ticket, and both are boundaries
 * rather than preferences:
 *   - `conversationId` — the owner sees the customer thread the ticket was
 *     raised on; a guest sees only THEIR OWN thread with that customer (null
 *     until they start one). A guest must never receive an id that would let
 *     them request another workspace's conversation.
 *   - `contactId`/`contactName` — a guest gets the frozen snapshot's name, not
 *     a live pointer into the owner's directory.
 */
export function mapTicket(t: TicketRow, viewerWorkspaceId: string): Ticket {
  const isOwner = t.workspaceId === viewerWorkspaceId;
  const myShare = isOwner
    ? undefined
    : t.shares.find((s) => s.guestWorkspaceId === viewerWorkspaceId);
  const snapshot = myShare ? asContactSnapshot(myShare.contactSnapshot) : null;
  return {
    id: t.id,
    number: t.number,
    conversationId: isOwner ? t.conversationId : (myShare?.guestConversationId ?? null),
    contactId: isOwner ? t.contactId : null,
    contactName: (isOwner ? t.contact?.name : snapshot?.name) ?? "Unknown",
    channel: t.channel,
    subject: t.subject,
    description: t.description,
    status: t.status,
    priority: t.priority,
    // A GUEST sees its own department's owner (off the share), never the
    // owner workspace's — that person is not on the guest's roster, so the
    // picker would render a blank and reassigning would clobber them.
    assignedUserId: isOwner ? t.assignedUserId : (myShare?.assignedUserId ?? null),
    assignedUserName: isOwner
      ? (t.assignedUser?.name ?? null)
      : (myShare?.assignedUser?.name ?? null),
    // Teams are the OWNER's queues; a guest has no team dimension on a ticket
    // it does not own.
    assignedTeamId: isOwner ? t.assignedTeamId : null,
    tags: t.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
    sla: {
      firstResponseDueAt: t.firstResponseDueAt?.toISOString() ?? null,
      resolutionDueAt: t.resolutionDueAt?.toISOString() ?? null,
      firstResponseAt: t.firstResponseAt?.toISOString() ?? null,
      firstResponseBreached: t.firstResponseBreached,
      resolutionBreached: t.resolutionBreached,
      // `slaPausedAt` being set IS the paused state — derived here rather than
      // re-deriving "is this status a pausing one" on the client, which would
      // need the policy too.
      paused: t.slaPausedAt !== null,
    },
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    closedAt: t.closedAt?.toISOString() ?? null,
    resolvedById: t.resolvedById,
    resolvedByName: t.resolvedBy?.name ?? null,
    resolutionCode: t.resolutionCode,
    resolutionNote: t.resolutionNote,
    reopenCount: t.reopenCount,
    source: asSource(t.source),
    customFields: asCustomFields(t.customFields),
    version: t.version,
    sharing: mapSharing(t, viewerWorkspaceId),
    attachments: t.attachments.map((a) => mapAttachment(a, t.id)),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    lastActivityAt: t.lastActivityAt.toISOString(),
  };
}

export const TICKET_EVENT_SELECT = {
  id: true,
  kind: true,
  before: true,
  after: true,
  body: true,
  actorUserId: true,
  createdAt: true,
  actorUser: { select: { name: true } },
  // WHICH workspace acted — what makes a shared ticket's log readable.
  actorWorkspace: { select: { name: true } },
  attachments: { select: ATTACHMENT_SELECT_FIELDS, orderBy: { createdAt: "asc" } },
} satisfies Prisma.TicketEventSelect;

type TicketEventRow = Prisma.TicketEventGetPayload<{ select: typeof TICKET_EVENT_SELECT }>;

function asJsonObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function mapTicketEvent(e: TicketEventRow, ticketId: string): TicketEvent {
  return {
    id: e.id,
    kind: e.kind,
    actorWorkspaceName: e.actorWorkspace?.name ?? null,
    attachments: e.attachments.map((a) => mapAttachment(a, ticketId)),
    before: asJsonObject(e.before),
    after: asJsonObject(e.after),
    body: e.body,
    actorUserId: e.actorUserId,
    actorName: e.actorUser?.name ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * THE agent conversation-visibility predicate for tickets — one definition,
 * ANDed in by both the list query and the per-ticket guard.
 *
 * A ticket is normally reached through its conversation, so the rule is the
 * canonical one: the parent thread must be assigned to this agent. But
 * `Ticket.conversationId` is NULLABLE for an escalated-in ticket, and a Prisma
 * relation filter never matches a null relation — so expressed as the
 * conversation clause alone this silently hid every escalation a sibling
 * workspace sent, from the board AND from the detail route, INCLUDING from the
 * agent it was assigned to. That is a deadlock, not just a gap: the only action
 * that binds a conversation (and would restore visibility) is on the ticket
 * page the agent can no longer open.
 *
 * So an UNBOUND ticket falls back to the ticket's own assignee. An unassigned
 * one stays invisible, which matches what "assigned" visibility already means
 * for an unassigned conversation — an admin or manager routes it first.
 */
/**
 * "New work nobody in this workspace has picked up."
 *
 * Two arrivals, one predicate: a ticket WE raised that is still `new`, and an
 * active ticket another workspace escalated to us that nobody here has claimed.
 * The second arm is the one that matters — a shared ticket keeps the status it
 * already had, so counting `status: new` alone made an escalation silent.
 */
export function untriagedWhere(workspaceId: string): Prisma.TicketWhereInput {
  return {
    OR: [
      { workspaceId, status: "new" },
      {
        status: { in: TICKET_ACTIVE_STATUSES as TicketStatus[] },
        shares: { some: { guestWorkspaceId: workspaceId, assignedUserId: null } },
      },
    ],
  };
}

/**
 * Tickets where someone ELSE replied in the thread and this user has not looked.
 *
 * One `some` over the marker table — no watermark comparison, so it composes
 * into the same Prisma `where` as everything else and needs no raw SQL (which
 * would have meant a second hand-written copy of the access predicate).
 */
export function unreadRepliesWhere(viewerUserId: string): Prisma.TicketWhereInput {
  return { threadUnreads: { some: { userId: viewerUserId } } };
}

/**
 * What a RESTRICTED agent (role `agent` + visibility `assigned`) may see on the
 * board. Wraps the conversation rule and adds the two ways a ticket can be
 * yours without the conversation being yours.
 *
 * The last two arms are load-bearing in the one-ticket model: a ticket
 * escalated INTO your workspace keeps the OWNER's conversation, assigned to an
 * agent in the owner's workspace. Matching on the conversation alone therefore
 * hid every escalated-in ticket from every restricted agent in the receiving
 * department — an empty board and a zero rail badge on exactly the work that
 * was handed to them, which is the one case this whole feature exists for.
 */
/**
 * WHOSE internal note this is.
 *
 * A note is private to the workspace that wrote it — the composer promises
 * exactly that ("neither the customer nor the other workspaces on this ticket
 * see it"), and a note is where an agent writes the thing they would never say
 * to the other department. Until 2026-07-31 nothing enforced it: notes are
 * stored with the OWNER's `workspaceId` (one history per ticket) and only
 * `actorWorkspaceId` says who wrote them, so every note on a shared ticket was
 * readable by every department on it, and findable by ticket search.
 *
 * `actorWorkspaceId` is NULL on notes written before sharing existed. Only the
 * owner could have written those — there was nobody else — so they stay with
 * whoever owns the ticket (`TicketEvent.workspaceId` is the owner's).
 *
 * Composed as an AND element by both readers, never spread into a sibling
 * position a later filter could overwrite (§18).
 */
export function noteVisibilityWhere(workspaceId: string): Prisma.TicketEventWhereInput {
  return {
    OR: [{ actorWorkspaceId: workspaceId }, { actorWorkspaceId: null, workspaceId }],
  };
}

export function ticketVisibilityWhere(viewerUserId: string): Prisma.TicketWhereInput {
  return {
    OR: [
      { conversation: { assignedUserId: viewerUserId } },
      // Assigned the WORK, whoever owns the thread it came from.
      { assignedUserId: viewerUserId },
      // ...or assigned it on your department's side of a shared ticket.
      { shares: { some: { assignedUserId: viewerUserId } } },
      // ...or you RAISED it, or you ESCALATED it here. The raiser must be able
      // to follow their own ticket — that is the whole model ("agent X raises a
      // ticket so it gets a solution") — and without these arms a restricted
      // agent lost sight of their ticket the moment the conversation was
      // reassigned, while still receiving its notifications, each of which
      // opened a 404.
      { createdById: viewerUserId },
      { shares: { some: { createdById: viewerUserId } } },
    ],
  };
}

export interface ListTicketsFilters {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  assignedUserId?: string | null;
  /** The team queue. `null` filters to "owned by no team". */
  assignedTeamId?: string | null;
  contactId?: string;
  conversationId?: string;
  channel?: string;
  /** One channel ACCOUNT — matched through the conversation relation. */
  accountId?: string;
  tagIds?: string[];
  /** Only tickets that missed a promise — the board's "at risk" view. */
  breachedOnly?: boolean;
  /**
   * Free-text search. `#47` / `47` matches the NUMBER exactly; anything else
   * matches the subject, the cause, the customer's name, or any comment/note on
   * the timeline — the three places a ticket's words actually live plus who it
   * is about. Backed by trigram GIN indexes (20260730170000).
   */
  query?: string;
  /** Only tickets another workspace escalated to us — the guest department's
   *  "what did we get asked to do" view. */
  sharedWithUsOnly?: boolean;
  /** Only work nobody in this workspace has claimed yet (either side). */
  untriagedOnly?: boolean;
  /** Only tickets with a thread reply this viewer has not read. */
  unreadRepliesFor?: string;
  /** Whose unread markers to report in the envelope. Absent for an API key —
   *  read state is per-USER and a key has no user. */
  viewerUserId?: string;
  /**
   * Agent conversation-visibility boundary: restrict to tickets whose PARENT
   * CONVERSATION is assigned to this user.
   *
   * A REQUIRED-shaped concern expressed as an optional field is how this
   * control has died before — a caller that forgets it gets the whole
   * workspace with no error. It is therefore applied here, in the one query
   * every read path goes through, rather than being each caller's job.
   */
  restrictToConversationsAssignedTo?: string;
  /**
   * Keyset cursor: the previous page's last `{ activityAt, id }`.
   *
   * Keyed on `lastActivityAt`, which is what the board ORDERS by — a cursor on
   * a different column than the sort silently skips and repeats rows.
   */
  cursor?: { activityAt: Date; id: string };
  limit?: number;
}

/**
 * One board/list page, newest first, keyset-paginated.
 *
 * Keyset (not offset) for the standard reason: a board that a team is actively
 * working shifts under an offset cursor, so page 2 would skip or repeat cards.
 * The `(workspaceId, status, createdAt DESC, id DESC)` index carries the sort
 * key, so the scan stops after `take`.
 */
export async function listTickets(
  db: Db,
  workspaceId: string,
  filters: ListTicketsFilters = {},
): Promise<{
  tickets: Ticket[];
  nextCursor: { activityAt: string; id: string } | null;
  /** Ids on THIS page with a thread reply the viewer hasn't read. Envelope-only
   *  — see the comment at the return. */
  unreadTicketIds: string[];
}> {
  const limit = Math.min(filters.limit ?? TICKET_PAGE, TICKET_PAGE);
  const and: Prisma.TicketWhereInput[] = [];

  if (filters.status?.length) and.push({ status: { in: filters.status } });
  if (filters.priority?.length) and.push({ priority: { in: filters.priority } });
  // `null` is a real filter value here ("unassigned"), distinct from `undefined`
  // ("don't filter on assignee") — hence the explicit undefined check.
  if (filters.assignedTeamId !== undefined) {
    // Its own AND element, never merged: a board can legitimately ask for
    // "Sales' queue AND unclaimed", and merging would let one overwrite the
    // other.
    and.push({ assignedTeamId: filters.assignedTeamId });
  }

  if (filters.assignedUserId !== undefined) {
    // "Assigned to me" must find work assigned on EITHER side: the ticket's own
    // assignee (when this workspace owns it) or this workspace's share assignee
    // (when it was escalated in). Without the second arm, a guest agent's
    // "Mine" view was permanently empty for exactly the work they were asked
    // to do.
    and.push({
      OR: [
        { workspaceId, assignedUserId: filters.assignedUserId },
        {
          shares: {
            some: { guestWorkspaceId: workspaceId, assignedUserId: filters.assignedUserId },
          },
        },
      ],
    });
  }
  if (filters.contactId) and.push({ contactId: filters.contactId });
  if (filters.conversationId) and.push({ conversationId: filters.conversationId });
  if (filters.channel) and.push({ channel: filters.channel as Prisma.EnumChannelFilter["equals"] });
  // Through the relation, deliberately — see the schema note on why Ticket
  // carries no account column of its own.
  if (filters.accountId) {
    and.push({ conversation: { channelConnectionId: filters.accountId } });
  }
  if (filters.tagIds?.length) and.push({ tags: { some: { id: { in: filters.tagIds } } } });
  if (filters.breachedOnly) {
    and.push({ OR: [{ firstResponseBreached: true }, { resolutionBreached: true }] });
  }
  if (filters.query) {
    const q = filters.query.trim().slice(0, 200);
    if (q) {
      const or: Prisma.TicketWhereInput[] = [
        { subject: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        // The customer's name, so "find Ali's ticket" works. Reached through the
        // relation rather than a denormalized copy — and a GUEST workspace has
        // no contact row, which is why the snapshot arm below exists.
        { contact: { name: { contains: q, mode: "insensitive" } } },
        // Event bodies that are genuinely shared — a handoff reason, say.
        // `escalation_note` is skipped because its text is searched below as a
        // thread message, and matching both would be one hit counted twice.
        {
          events: {
            some: {
              kind: { notIn: ["note", "escalation_note"] },
              body: { contains: q, mode: "insensitive" },
            },
          },
        },
        // MY OWN notes. Scoped, because an unscoped arm let a guest find a
        // ticket by text in the owner's private note — the body never rendered,
        // but the match itself is the leak.
        {
          events: {
            some: {
              AND: [
                { kind: "note" },
                { body: { contains: q, mode: "insensitive" } },
                noteVisibilityWhere(workspaceId),
              ],
            },
          },
        },
        // The THREAD — where the cross-department discussion actually is now.
        { threadMessages: { some: { body: { contains: q, mode: "insensitive" } } } },
        // A shared ticket's customer name for the GUEST, who sees only the
        // frozen snapshot. `string_contains` is case-SENSITIVE (Postgres JSONB
        // has no case-insensitive containment), so this arm is a best-effort
        // complement to the four above, not a replacement.
        { shares: { some: { guestWorkspaceId: workspaceId, contactSnapshot: { path: ["name"], string_contains: q } } } },
      ];
      // `#47` and `47` both mean the ticket NUMBER — what people actually quote
      // to each other. Added as an extra arm rather than a mode switch, so a
      // subject that happens to contain digits still matches.
      const asNumber = Number.parseInt(q.replace(/^#/, ""), 10);
      if (Number.isSafeInteger(asNumber) && asNumber > 0) or.push({ number: asNumber });
      and.push({ OR: or });
    }
  }
  if (filters.sharedWithUsOnly) {
    and.push({ shares: { some: { guestWorkspaceId: workspaceId } }, workspaceId: { not: workspaceId } });
  }
  if (filters.untriagedOnly) and.push(untriagedWhere(workspaceId));
  if (filters.unreadRepliesFor) and.push(unreadRepliesWhere(filters.unreadRepliesFor));
  if (filters.restrictToConversationsAssignedTo) {
    and.push(ticketVisibilityWhere(filters.restrictToConversationsAssignedTo));
  }
  if (filters.cursor) {
    // Keyset: strictly older than the cursor, ties broken by id — matches the
    // (lastActivityAt DESC, id DESC) ordering exactly.
    and.push({
      OR: [
        { lastActivityAt: { lt: filters.cursor.activityAt } },
        { lastActivityAt: filters.cursor.activityAt, id: { lt: filters.cursor.id } },
      ],
    });
  }

  const rows = await db.ticket.findMany({
    // The ACCESS predicate ("mine OR shared with me", lib/tickets/access.ts) is
    // pushed as the first AND element, never spread into a sibling position
    // where a later filter object could overwrite it and cross the boundary.
    where: { AND: [ticketAccessWhere(workspaceId), ...and] },
    // Newest ACTIVITY first, not newest raised: the ticket someone just replied
    // to belongs above ones nobody has touched in a week, which is the order
    // people actually work in. `id` breaks ties so the keyset above is exact.
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: TICKET_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? page[page.length - 1] : undefined;

  /**
   * Which of THESE cards have a reply this viewer hasn't read.
   *
   * In the list ENVELOPE, never on the `Ticket` DTO: `ticket:changed`
   * broadcasts one Ticket to a whole workspace room, so a per-user field on it
   * would be read by everyone as if it were theirs. One indexed query over the
   * page's ids, not a join.
   */
  let unreadTicketIds: string[] = [];
  if (filters.viewerUserId && page.length > 0) {
    const marks = await db.ticketThreadUnread.findMany({
      where: { userId: filters.viewerUserId, ticketId: { in: page.map((t) => t.id) } },
      select: { ticketId: true },
    });
    unreadTicketIds = marks.map((m) => m.ticketId);
  }

  return {
    tickets: await maskTicketNames(
      db,
      workspaceId,
      page.map((row) => mapTicket(row, workspaceId)),
    ),
    nextCursor: last ? { activityAt: last.lastActivityAt.toISOString(), id: last.id } : null,
    unreadTicketIds,
  };
}

export async function getTicket(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Ticket | null> {
  const row = await db.ticket.findFirst({
    where: ticketByIdWhere(workspaceId, id),
    select: TICKET_SELECT,
  });
  if (!row) return null;
  const [masked] = await maskTicketNames(db, workspaceId, [mapTicket(row, workspaceId)]);
  return masked ?? null;
}

/**
 * This workspace's internal notes on a ticket, oldest first.
 *
 * Its own read rather than a slice of the timeline, for the same reason the
 * thread is its own entity: a note is something someone WROTE, and it was
 * unfindable among the status changes. Private — see `noteVisibilityWhere`.
 */
export async function listTicketNotes(
  db: Db,
  workspaceId: string,
  ticketId: string,
): Promise<TicketEvent[]> {
  const rows = await db.ticketEvent.findMany({
    where: {
      ticketId,
      kind: "note",
      // Reached through the TICKET's gate (a guest may note on a ticket shared
      // with it), then narrowed to notes this workspace may read.
      ticket: ticketAccessWhere(workspaceId),
      AND: [noteVisibilityWhere(workspaceId)],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: TICKET_EVENT_SELECT,
  });
  return maskTicketEventNames(
    db,
    workspaceId,
    rows.reverse().map((e) => mapTicketEvent(e, ticketId)),
  );
}

/** A ticket's own timeline, oldest first (served by `(ticketId, createdAt)`). */
export async function listTicketEvents(
  db: Db,
  workspaceId: string,
  ticketId: string,
): Promise<TicketEvent[]> {
  // Bounded: a years-old ticket bounced through many hands must not ship its
  // entire history on every detail open. 500 covers any realistic timeline;
  // newest-first fetch + reverse keeps the LATEST events when it doesn't.
  const rows = await db.ticketEvent.findMany({
    // Scoped through the PARENT ticket's access gate, not `workspaceId`: on a
    // shared ticket every row carries the OWNER's workspaceId, so filtering by
    // the viewer's would hand a guest an empty history for a ticket they can
    // legitimately work.
    //
    // Neither CONTENT kind belongs in the audit log — it answers "who changed
    // what", and burying the writing among twenty status flips is what made it
    // unreadable. `escalation_note` (the pre-2026-07-31 comments) reads in the
    // THREAD via its migrated `TicketMessage`; `note` reads in the notes panel,
    // scoped to the workspace that wrote it. The rows deliberately stay in this
    // table — deleting them would cascade-delete their attachments.
    where: {
      ticketId,
      kind: { notIn: ["escalation_note", "note"] },
      ticket: ticketAccessWhere(workspaceId),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: TICKET_EVENT_SELECT,
  });
  return maskTicketEventNames(
    db,
    workspaceId,
    rows.reverse().map((e) => mapTicketEvent(e, ticketId)),
  );
}

/**
 * Board header badges in ONE round-trip.
 *
 * A `groupBy` plus two counts, not six separate counts: the board renders all
 * of these together, and six queries against the same partition is the shape
 * that turns a board refresh into a visible stall.
 */
export async function getTicketCounts(
  db: Db,
  workspaceId: string,
  viewerUserId: string,
  /** Same boundary as `listTickets` — a restricted agent's badges must count
   *  only what they can open, or the header advertises work they can't see. */
  restrictToConversationsAssignedTo?: string,
): Promise<TicketCounts> {
  const active = { in: TICKET_ACTIVE_STATUSES as TicketStatus[] };
  // Every count is scoped by the same access gate as the board it labels —
  // a badge that counts tickets the agent can't open is worse than no badge.
  const scope: Prisma.TicketWhereInput[] = [
    ticketAccessWhere(workspaceId),
    ...(restrictToConversationsAssignedTo
      ? [ticketVisibilityWhere(restrictToConversationsAssignedTo)]
      : []),
  ];
  const [byStatusRows, mineActive, breached, untriaged, sharedWithUs, unreadReplies] =
    await Promise.all([
    db.ticket.groupBy({
      by: ["status"],
      where: { AND: scope },
      _count: { _all: true },
    }),
    db.ticket.count({
      // Same two-sided rule as the board's "Mine" filter — see listTickets.
      where: {
        status: active,
        AND: [
          ...scope,
          {
            OR: [
              { workspaceId, assignedUserId: viewerUserId },
              {
                shares: {
                  some: { guestWorkspaceId: workspaceId, assignedUserId: viewerUserId },
                },
              },
            ],
          },
        ],
      },
    }),
    db.ticket.count({
      where: {
        status: active,
        AND: [
          ...scope,
          { OR: [{ firstResponseBreached: true }, { resolutionBreached: true }] },
        ],
      },
    }),
    db.ticket.count({ where: { AND: [...scope, untriagedWhere(workspaceId)] } }),
    db.ticket.count({
      where: {
        status: active,
        AND: [
          ...scope,
          { shares: { some: { guestWorkspaceId: workspaceId } }, workspaceId: { not: workspaceId } },
        ],
      },
    }),
    // "Someone answered you." ANDed into the same `scope` that already carries
    // ticketAccessWhere(), so revoking a share drops the ticket out of the
    // ex-guest's count even though the marker row survives — the gate does the
    // work, and there is no second copy of the tenancy rule.
    db.ticket.count({ where: { AND: [...scope, unreadRepliesWhere(viewerUserId)] } }),
  ]);

  const byStatus: Partial<Record<TicketStatus, number>> = {};
  let totalActive = 0;
  for (const row of byStatusRows) {
    const n = row._count._all;
    if (n === 0) continue;
    byStatus[row.status] = n;
    if ((TICKET_ACTIVE_STATUSES as readonly string[]).includes(row.status)) totalActive += n;
  }
  return { totalActive, mineActive, breached, untriaged, sharedWithUs, unreadReplies, byStatus };
}
