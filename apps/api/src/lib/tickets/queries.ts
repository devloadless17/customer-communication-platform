import type { Prisma, PrismaClient } from "@prisma/client";

import type {
  ContactSnapshot,
  Ticket,
  TicketCounts,
  TicketEscalationInfo,
  TicketEvent,
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
  // The escalation pair, from whichever side this ticket is. The only
  // cross-workspace data a read ever surfaces: a sibling workspace's NAME and
  // the twin's number/status — deliberate, minimal, and exactly the feature.
  escalationOut: {
    select: {
      id: true,
      sourceTicketId: true,
      targetTicketId: true,
      targetWorkspaceId: true,
      targetTicket: { select: { number: true, status: true } },
      targetWorkspace: { select: { name: true } },
    },
  },
  escalationIn: {
    select: {
      id: true,
      sourceTicketId: true,
      sourceWorkspaceId: true,
      contactSnapshot: true,
      sourceTicket: { select: { number: true, status: true } },
      sourceWorkspace: { select: { name: true } },
    },
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

function mapEscalation(t: TicketRow): TicketEscalationInfo | undefined {
  if (t.escalationOut) {
    const e = t.escalationOut;
    return {
      id: e.id,
      role: "source",
      otherWorkspaceId: e.targetWorkspaceId,
      otherWorkspaceName: e.targetWorkspace.name,
      otherTicketId: e.targetTicketId,
      otherTicketNumber: e.targetTicket.number,
      otherTicketStatus: e.targetTicket.status,
      // The target FK is Cascade — from the source side the row existing means
      // the twin exists.
      severed: false,
    };
  }
  if (t.escalationIn) {
    const e = t.escalationIn;
    return {
      id: e.id,
      role: "target",
      otherWorkspaceId: e.sourceWorkspaceId,
      otherWorkspaceName: e.sourceWorkspace.name,
      otherTicketId: e.sourceTicketId,
      otherTicketNumber: e.sourceTicket?.number ?? null,
      otherTicketStatus: e.sourceTicket?.status ?? null,
      severed: e.sourceTicketId === null,
      contactSnapshot: asContactSnapshot(e.contactSnapshot),
    };
  }
  return undefined;
}

export function mapTicket(t: TicketRow): Ticket {
  return {
    id: t.id,
    number: t.number,
    conversationId: t.conversationId,
    contactId: t.contactId,
    // An escalated-in ticket has no Contact row until "Message customer" binds
    // one — the board and list keep rendering a name from the snapshot.
    contactName:
      t.contact?.name ??
      (t.escalationIn ? (asContactSnapshot(t.escalationIn.contactSnapshot).name ?? "Unknown") : "Unknown"),
    channel: t.channel,
    subject: t.subject,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assignedUserId: t.assignedUserId,
    assignedTeamId: t.assignedTeamId,
    assignedUserName: t.assignedUser?.name ?? null,
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
    escalation: mapEscalation(t),
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
} satisfies Prisma.TicketEventSelect;

type TicketEventRow = Prisma.TicketEventGetPayload<{ select: typeof TICKET_EVENT_SELECT }>;

function asJsonObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function mapTicketEvent(e: TicketEventRow): TicketEvent {
  return {
    id: e.id,
    kind: e.kind,
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
  tagIds?: string[];
  /** Only tickets that missed a promise — the board's "at risk" view. */
  breachedOnly?: boolean;
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
    and.push({ assignedUserId: filters.assignedUserId });
  }
  if (filters.contactId) and.push({ contactId: filters.contactId });
  if (filters.conversationId) and.push({ conversationId: filters.conversationId });
  if (filters.channel) and.push({ channel: filters.channel as Prisma.EnumChannelFilter["equals"] });
  if (filters.tagIds?.length) and.push({ tags: { some: { id: { in: filters.tagIds } } } });
  if (filters.breachedOnly) {
    and.push({ OR: [{ firstResponseBreached: true }, { resolutionBreached: true }] });
  }
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
    // The tenant key is a SIBLING of the AND array, never spread into it — a
    // spread would let a later filter object silently overwrite `workspaceId`
    // and cross the tenant boundary.
    where: { workspaceId, AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: TICKET_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? page[page.length - 1] : undefined;
  return {
    tickets: page.map(mapTicket),
    nextCursor: last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  };
}

export async function getTicket(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<Ticket | null> {
  const row = await db.ticket.findFirst({ where: { id, workspaceId }, select: TICKET_SELECT });
  return row ? mapTicket(row) : null;
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
    where: { workspaceId, ticketId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: TICKET_EVENT_SELECT,
  });
  return rows.reverse().map(mapTicketEvent);
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
  const scope: Prisma.TicketWhereInput[] = restrictToConversationsAssignedTo
    ? [ticketVisibilityWhere(restrictToConversationsAssignedTo)]
    : [];
  const [byStatusRows, mineActive, breached] = await Promise.all([
    db.ticket.groupBy({
      by: ["status"],
      where: { workspaceId, AND: scope },
      _count: { _all: true },
    }),
    db.ticket.count({
      where: { workspaceId, assignedUserId: viewerUserId, status: active, AND: scope },
    }),
    db.ticket.count({
      where: {
        workspaceId,
        status: active,
        AND: [
          ...scope,
          { OR: [{ firstResponseBreached: true }, { resolutionBreached: true }] },
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
  return { totalActive, mineActive, breached, byStatus };
}
