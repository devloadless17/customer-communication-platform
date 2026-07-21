import type { Prisma, PrismaClient } from "@prisma/client";

import type {
  MessageFlag,
  MessageFlagCounts,
  MessageFlagDefinition,
  MessageFlagQueueItem,
  MessageFlagSource,
  MessageFlagStatus,
} from "@ccp/shared/message-flags/types";
import { isMessageFlagSource } from "@ccp/shared/message-flags/types";

/**
 * Read side of message flags — the SELECT shapes, the row→wire mappers, and
 * the triage queue query.
 *
 * Framework-agnostic (lib/): `db` is injected by the caller, so the NestJS
 * service passes `this.db` and the sweeper passes the lib `db` Proxy. Same
 * contract as lib/conversations/mutations.ts.
 */

/** Minimal Prisma surface these helpers touch. */
type Db = Pick<PrismaClient, "messageFlag" | "messageFlagDefinition">;

/**
 * How much of the flagged message the queue row shows. Truncated in SQL-land
 * (JS `slice` after the select) rather than rendered client-side: a queue page
 * is 50 rows and a message body can be thousands of characters, so shipping
 * full bodies would dominate the payload for text nobody reads.
 */
const EXCERPT_CHARS = 160;

/** Queue page size. Keyset-paginated, so this is a hard per-request bound. */
export const FLAG_QUEUE_PAGE = 50;

export const MESSAGE_FLAG_DEFINITION_SELECT = {
  id: true,
  name: true,
  color: true,
  description: true,
  archived: true,
  sortOrder: true,
} satisfies Prisma.MessageFlagDefinitionSelect;

/**
 * The flag as every read path returns it. The definition is INLINED (not just
 * its id) so a bubble, a queue row, and a realtime frame each render without
 * the client holding the catalog — the same "carry enough context to react
 * without a re-read" rule the event payloads follow.
 *
 * The three actor joins select `name` only; `mapUser` isn't used because a flag
 * chip needs a label, not a full User (avatar, role, availability). Keeping the
 * select narrow matters here: the thread hydration pulls flags for a whole page
 * of messages.
 */
export const MESSAGE_FLAG_SELECT = {
  id: true,
  messageId: true,
  conversationId: true,
  status: true,
  source: true,
  confidence: true,
  note: true,
  createdById: true,
  assignedToId: true,
  resolvedById: true,
  resolvedAt: true,
  resolutionNote: true,
  createdAt: true,
  updatedAt: true,
  definition: { select: MESSAGE_FLAG_DEFINITION_SELECT },
  createdBy: { select: { name: true } },
  assignedTo: { select: { name: true } },
  resolvedBy: { select: { name: true } },
} satisfies Prisma.MessageFlagSelect;

export type MessageFlagRow = Prisma.MessageFlagGetPayload<{
  select: typeof MESSAGE_FLAG_SELECT;
}>;

type DefinitionRow = Prisma.MessageFlagDefinitionGetPayload<{
  select: typeof MESSAGE_FLAG_DEFINITION_SELECT;
}>;

export function mapFlagDefinition(row: DefinitionRow): MessageFlagDefinition {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    archived: row.archived,
    sortOrder: row.sortOrder,
  };
}

export function mapFlag(row: MessageFlagRow): MessageFlag {
  return {
    id: row.id,
    messageId: row.messageId,
    conversationId: row.conversationId,
    definition: mapFlagDefinition(row.definition),
    status: row.status as MessageFlagStatus,
    // `source` is a free-form column (see the schema comment on why it isn't a
    // DB enum). Anything unrecognized — a value written by a newer deploy, or a
    // hand-edited row — degrades to "human" rather than putting an
    // unrenderable string on the wire.
    source: isMessageFlagSource(row.source) ? (row.source as MessageFlagSource) : "human",
    confidence: row.confidence,
    note: row.note,
    createdById: row.createdById,
    createdByName: row.createdBy?.name ?? null,
    assignedToId: row.assignedToId,
    assignedToName: row.assignedTo?.name ?? null,
    resolvedById: row.resolvedById,
    resolvedByName: row.resolvedBy?.name ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ListFlagsFilter {
  /** Defaults to `["open"]` — the queue is a to-do list, not an archive. */
  statuses?: MessageFlagStatus[];
  definitionIds?: string[];
  /** `"unassigned"` matches flags with no owner; a user id matches that user. */
  assignedToId?: string | "unassigned";
  conversationId?: string;
  /** Opaque keyset cursor from the previous page's `nextCursor`. */
  cursor?: string | null;
  take?: number;
  /** Agent conversation-visibility boundary (lib/conversations/visibility.ts).
   *  `{}` for unrestricted viewers. */
  visibility?: { assignedUserId?: string };
}

/**
 * The triage queue: newest-first flags across the team.
 *
 * KEYSET-paginated on `(createdAt DESC, id DESC)` — never offset (§15). The
 * cursor encodes both halves because `createdAt` alone is not unique (two flags
 * raised in the same millisecond by a bulk action would straddle a page
 * boundary and one would be skipped). Rides
 * `MessageFlag_teamId_status_createdAt_id_idx`.
 */
export async function listFlags(
  db: Db,
  teamId: string,
  filter: ListFlagsFilter = {},
): Promise<{ items: MessageFlagQueueItem[]; nextCursor: string | null }> {
  const take = Math.min(Math.max(filter.take ?? FLAG_QUEUE_PAGE, 1), FLAG_QUEUE_PAGE);
  const statuses = filter.statuses?.length ? filter.statuses : (["open"] as const);

  const where: Prisma.MessageFlagWhereInput = {
    teamId,
    // Visibility boundary: the queue selects message body, media caption and
    // the contact's name + phone, so an unscoped read here would hand a
    // restricted agent excerpts of every conversation in the org.
    ...(filter.visibility?.assignedUserId
      ? { conversation: { assignedUserId: filter.visibility.assignedUserId } }
      : {}),
    status: { in: statuses as MessageFlagStatus[] },
    ...(filter.definitionIds?.length ? { definitionId: { in: filter.definitionIds } } : {}),
    ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
    ...(filter.assignedToId === "unassigned"
      ? { assignedToId: null }
      : filter.assignedToId
        ? { assignedToId: filter.assignedToId }
        : {}),
    ...keysetWhere(filter.cursor),
  };

  const rows = await db.messageFlag.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // +1 to detect "there is another page" without a count() query — the same
    // trick the conversation/message lists use.
    take: take + 1,
    select: {
      ...MESSAGE_FLAG_SELECT,
      message: { select: { body: true, timestamp: true, mediaCaption: true } },
      conversation: {
        select: {
          channel: true,
          contact: { select: { id: true, name: true, phoneNumber: true } },
        },
      },
    },
  });

  const page = rows.slice(0, take);
  const last = page.at(-1);
  const nextCursor = rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null;

  return {
    items: page.map((row) => ({
      ...mapFlag(row),
      contactId: row.conversation.contact.id,
      // Falls back to the phone number, then a placeholder — a WhatsApp contact
      // that has never given a name has neither, and a blank queue row is
      // unusable. (Ephemeral widget visitors are handled the same way: they get
      // a phone-less placeholder rather than being hidden, because the queue is
      // about the MESSAGE, not the directory.)
      contactName:
        row.conversation.contact.name ||
        row.conversation.contact.phoneNumber ||
        "Unknown contact",
      messageExcerpt: excerpt(row.message.body || row.message.mediaCaption || ""),
      messageTimestamp: row.message.timestamp.toISOString(),
      channel: row.conversation.channel,
    })),
    nextCursor,
  };
}

/**
 * Queue rail badges. One `groupBy` for the per-definition open counts plus one
 * cheap count for "mine" — deliberately NOT a per-definition loop (that would
 * be an N+1 over the catalog).
 */
export async function flagCounts(
  db: Db,
  teamId: string,
  userId: string,
  visibility?: { assignedUserId?: string },
): Promise<MessageFlagCounts> {
  // Counts must agree with the queue the viewer can actually open, or a
  // restricted agent sees a badge they can never clear.
  const scope = visibility?.assignedUserId
    ? { conversation: { assignedUserId: visibility.assignedUserId } }
    : {};
  const [byDefinition, mineOpen] = await Promise.all([
    db.messageFlag.groupBy({
      by: ["definitionId"],
      where: { teamId, status: "open", ...scope },
      _count: { _all: true },
    }),
    db.messageFlag.count({
      where: { teamId, status: "open", assignedToId: userId, ...scope },
    }),
  ]);

  const openByDefinition: Record<string, number> = {};
  let totalOpen = 0;
  for (const group of byDefinition) {
    openByDefinition[group.definitionId] = group._count._all;
    totalOpen += group._count._all;
  }

  return { totalOpen, mineOpen, openByDefinition };
}

/** Catalog read. `includeArchived` is for the settings screen only — the flag
 *  picker must never offer a retired definition. */
export async function listFlagDefinitions(
  db: Db,
  teamId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<MessageFlagDefinition[]> {
  const rows = await db.messageFlagDefinition.findMany({
    where: { teamId, ...(opts.includeArchived ? {} : { archived: false }) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: MESSAGE_FLAG_DEFINITION_SELECT,
  });
  return rows.map(mapFlagDefinition);
}

// ---------------------------------------------------------------------------
// Keyset cursor helpers.
// ---------------------------------------------------------------------------

/**
 * `<epochMillis>_<id>`. Opaque to the client but deliberately not base64'd —
 * it carries no secret, and a readable cursor is far easier to debug in a
 * request log than an encoded blob.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}_${id}`;
}

function keysetWhere(cursor: string | null | undefined): Prisma.MessageFlagWhereInput {
  if (!cursor) return {};
  const sep = cursor.lastIndexOf("_");
  if (sep <= 0) return {};
  const millis = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  // A malformed cursor returns the FIRST page rather than throwing: it can only
  // come from a stale/hand-edited client, and a 500 on a list read is a worse
  // outcome than a harmless restart at the top.
  if (!Number.isFinite(millis) || !id) return {};

  const createdAt = new Date(millis);
  // Strictly-after in DESC order = strictly-before in time, with `id` breaking
  // same-millisecond ties. Written as an OR rather than a tuple comparison
  // because Prisma has no row-value syntax; the planner still uses the
  // (teamId, status, createdAt DESC, id DESC) index for both branches.
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
  };
}

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > EXCERPT_CHARS
    ? `${collapsed.slice(0, EXCERPT_CHARS - 1)}…`
    : collapsed;
}
