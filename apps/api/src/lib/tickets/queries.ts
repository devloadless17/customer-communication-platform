import type { Prisma, PrismaClient } from "@prisma/client";

import { ticketAccessWhere, ticketByIdWhere } from "./access";

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

type Db = Pick<PrismaClient, "ticket" | "ticketEvent">;

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

export function ticketVisibilityWhere(viewerUserId: string): Prisma.TicketWhereInput {
  return {
    OR: [
      { conversation: { assignedUserId: viewerUserId } },
      { conversationId: null, assignedUserId: viewerUserId },
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
  /** Only tickets another workspace escalated to us — the guest department's
   *  "what did we get asked to do" view. */
  sharedWithUsOnly?: boolean;
  /** Only work nobody in this workspace has claimed yet (either side). */
  untriagedOnly?: boolean;
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
  /** Keyset cursor: the previous page's last `{ createdAt, id }`. */
  cursor?: { createdAt: Date; id: string };
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
): Promise<{ tickets: Ticket[]; nextCursor: { createdAt: string; id: string } | null }> {
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
  if (filters.sharedWithUsOnly) {
    and.push({ shares: { some: { guestWorkspaceId: workspaceId } }, workspaceId: { not: workspaceId } });
  }
  if (filters.untriagedOnly) and.push(untriagedWhere(workspaceId));
  if (filters.restrictToConversationsAssignedTo) {
    and.push(ticketVisibilityWhere(filters.restrictToConversationsAssignedTo));
  }
  if (filters.cursor) {
    // Keyset: strictly older than the cursor, ties broken by id — matches the
    // (createdAt DESC, id DESC) ordering exactly.
    and.push({
      OR: [
        { createdAt: { lt: filters.cursor.createdAt } },
        { createdAt: filters.cursor.createdAt, id: { lt: filters.cursor.id } },
      ],
    });
  }

  const rows = await db.ticket.findMany({
    // The ACCESS predicate ("mine OR shared with me", lib/tickets/access.ts) is
    // pushed as the first AND element, never spread into a sibling position
    // where a later filter object could overwrite it and cross the boundary.
    where: { AND: [ticketAccessWhere(workspaceId), ...and] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: TICKET_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? page[page.length - 1] : undefined;
  return {
    tickets: page.map((row) => mapTicket(row, workspaceId)),
    nextCursor: last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
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
  return row ? mapTicket(row, workspaceId) : null;
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
    where: { ticketId, ticket: ticketAccessWhere(workspaceId) },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: TICKET_EVENT_SELECT,
  });
  return rows.reverse().map((e) => mapTicketEvent(e, ticketId));
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
  const [byStatusRows, mineActive, breached, untriaged, sharedWithUs] = await Promise.all([
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
  ]);

  const byStatus: Partial<Record<TicketStatus, number>> = {};
  let totalActive = 0;
  for (const row of byStatusRows) {
    const n = row._count._all;
    if (n === 0) continue;
    byStatus[row.status] = n;
    if ((TICKET_ACTIVE_STATUSES as readonly string[]).includes(row.status)) totalActive += n;
  }
  return { totalActive, mineActive, breached, untriaged, sharedWithUs, byStatus };
}
