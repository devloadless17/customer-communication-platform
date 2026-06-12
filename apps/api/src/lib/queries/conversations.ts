import { type ConversationEventKind, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type {
  ConversationWithRefs,
  CursorPage,
  Message,
} from "@ccp/shared/types";

import {
  clampTake,
  mapActivityEvent,
  mapContact,
  mapContactListItem,
  mapConversation,
  ASSIGNED_USER_SELECT,
  mapMessage,
  mapNote,
  mapUser,
  REPLY_TO_INCLUDE,
} from "./_shared";
import {
  encodeConvoCursor,
  encodeMessageCursor,
  parseConvoCursor,
  parseMessageCursor,
} from "./_cursors";

/** Max page size, server-side cap so a hostile client can't ask for 100k rows. */
export const CONVERSATIONS_PAGE = 25;
export const MESSAGES_PAGE = 30;
/**
 * How many recent activity-log events the thread hydration carries. Generous
 * (most threads have a handful of lifecycle changes), but bounded so a thread
 * that gets re-assigned/re-tagged hundreds of times can't bloat the per-open
 * payload. The thread's visibility filter hides any event older than the
 * oldest loaded message anyway, so over-fetching beyond the message window is
 * wasted — this cap keeps it sane. A full audit-history view (if ever needed)
 * is a separate paginated endpoint, not this hot-path hydration.
 */
export const ACTIVITY_WINDOW = 100;

/**
 * ConversationEvent kinds that are written for the DB audit trail but have NO
 * timeline-pill renderer (activity-entry.tsx has no case for them). Today this
 * is the call_* lifecycle family: the visible inline element for a call is the
 * CallBubble built from the Call row, not a pill, so carrying these rows into
 * the thread hydration / events refetch would only waste the ACTIVITY_WINDOW
 * budget. Excluded from both read paths below.
 */
const NON_PILL_EVENT_KINDS: ConversationEventKind[] = [
  "call_completed",
  "call_missed",
  "call_rejected",
  "call_failed",
];

/**
 * Page of conversations for a team, sorted by recency.
 *
 * Keyset cursor on `(lastMessageAt, id)` instead of offset because realtime
 * events constantly bump conversations to the top — an offset cursor would
 * silently skip rows after a bump. Cursor is the *last item shown* so the
 * caller can pass it back to ask "give me the next page after this."
 *
 * `search` filters by contact name / phone / latest-message preview using
 * case-insensitive substring match. Searches the loaded slice's haystack
 * server-side so the user can find threads buried under hundreds of others
 * without scrolling. This OR spans the Contact join (name / phone are relation
 * filters), so Postgres can't BitmapOr it against any single-table index — the
 * plan is a team-partition walk + filter regardless. Fine at pilot scale
 * (single-digit ms for a few thousand rows). A plain trgm GIN on
 * lastMessagePreview does NOT help (cross-table OR — it was dropped, see the
 * Conversation model note); past ~50k conversations, split into a contact-id
 * prefilter + a preview-only query (unioned) and index those.
 *
 * Includes contact + assigned user; does NOT pull messages/notes (the
 * thread page hydrates those separately to keep the list query lean).
 */
export type ListConversationsFilter =
  | { kind: "preset"; id: "active" | "all" | "mine" | "unassigned" | "closed" }
  | { kind: "stage"; stageId: string };

export async function listConversations(
  teamId: string,
  opts: {
    take?: number;
    cursor?: string | null;
    search?: string;
    /**
     * The signed-in agent. Required to evaluate the `mine` preset filter —
     * the WHERE clause narrows by `assignedUserId = viewerUserId`. Omit for
     * server-to-server reads (broadcasts, automations, external API).
     */
    viewerUserId?: string;
    /**
     * Server-side preset / stage narrowing. Without it the list is the
     * full team-recency feed. With it, "Mine" returns only my threads
     * regardless of where they fall in the team's activity, and so on.
     * `mine` requires `viewerUserId` — handled by the filter clause below.
     */
    filter?: ListConversationsFilter;
  } = {},
): Promise<CursorPage<ConversationWithRefs>> {
  const take = clampTake(opts.take, CONVERSATIONS_PAGE);
  const cursor = parseConvoCursor(opts.cursor ?? null);
  const search = opts.search?.trim() ?? "";

  // Keyset clause (recency-paginated). Built separately so it composes
  // with the optional search clause via `AND`.
  const keysetClause: Prisma.ConversationWhereInput | null = cursor
    ? {
        OR: [
          { lastMessageAt: { lt: cursor.lastMessageAt } },
          { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
        ],
      }
    : null;

  // Search clause: name / phone / last-message preview, case-insensitive.
  // Phone numbers are stored normalised so a plain `contains` covers
  // "5551234" matching "+15551234567" — no need for digit-only stripping.
  // NOTE: name/phone are Contact RELATION filters, so this OR spans a join;
  // Postgres can't BitmapOr across tables, so the planner walks the team's
  // conversation partition and filters (no single-table index serves it — the
  // preview trgm GIN was dropped for exactly this reason, 20260611130300).
  const searchClause: Prisma.ConversationWhereInput | null = search
    ? {
        OR: [
          { contact: { name: { contains: search, mode: "insensitive" } } },
          { contact: { phoneNumber: { contains: search } } },
          { lastMessagePreview: { contains: search, mode: "insensitive" } },
        ],
      }
    : null;

  // Preset / stage narrowing. Index coverage:
  //   - status filters use `(teamId, status, lastMessageAt DESC)` index
  //   - assignedUserId filters use `(teamId, assignedUserId)` index
  //   - stage filter joins through Contact, which has `(teamId, stageId)`
  //
  // Preset semantics:
  //   - `active`      → open + pending (the everyday working view).
  //   - `all`         → truly everything, closed included.
  //   - `mine`        → open + pending assigned to the viewer.
  //   - `unassigned`  → open + pending with no assignee.
  //   - `closed`      → closed only.
  //
  // The STAGE view shows all conversations (open + closed) in that stage
  // — stages model the contact's lifecycle, orthogonal to chat status.
  // A "customer"-stage contact with a closed chat is still a customer;
  // hiding them under the stage view caused the badge count to disagree
  // with what appeared after clicking.
  let filterClause: Prisma.ConversationWhereInput | null = null;
  if (opts.filter?.kind === "preset") {
    switch (opts.filter.id) {
      case "active":
        filterClause = { status: { not: "closed" } };
        break;
      case "all":
        // No status narrowing — team scope is applied by the outer where.
        filterClause = null;
        break;
      case "mine":
        // `mine` without a viewer never matches — server-to-server callers
        // hitting this filter is a programming error; the empty result
        // surfaces it loudly without leaking other agents' threads.
        filterClause = opts.viewerUserId
          ? { status: { not: "closed" }, assignedUserId: opts.viewerUserId }
          : { id: "__no_match__" };
        break;
      case "unassigned":
        filterClause = { status: { not: "closed" }, assignedUserId: null };
        break;
      case "closed":
        filterClause = { status: "closed" };
        break;
    }
  } else if (opts.filter?.kind === "stage") {
    // deletedAt:null so the stage-filtered list matches the stage badge count
    // (ConversationsService.counts byStage) and the settings/stages directory
    // count — all three now exclude tombstoned contacts.
    filterClause = {
      contact: { stageId: opts.filter.stageId, deletedAt: null },
    };
  }

  const composedClauses = [keysetClause, searchClause, filterClause].filter(
    (c): c is Prisma.ConversationWhereInput => c !== null,
  );
  const where: Prisma.ConversationWhereInput = {
    teamId,
    ...(composedClauses.length > 1
      ? { AND: composedClauses }
      : composedClauses[0] ?? {}),
  };

  const rows = await db.conversation.findMany({
    where,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: {
      // Explicit select keeps the per-row payload lean — adding heavier
      // relations to Contact (customFields, identityChannel, etc.) doesn't
      // automatically bloat every inbox-list response. Tags come back via
      // the nested `tags` include since they live on Contact in this app
      // (one contact = one conversation, so per-thread tags would be dead
      // complexity).
      contact: {
        // `customFields` is JSONB — potentially many keys × N rows × every
        // refresh. Dropped here because the list UI never renders it (only
        // name/stage/tags). Re-fetched in full by the per-conversation
        // query when an agent opens a thread.
        select: {
          id: true,
          teamId: true,
          name: true,
          firstName: true,
          lastName: true,
          language: true,
          countryCode: true,
          phoneNumber: true,
          identityChannel: true,
          externalContactId: true,
          avatarUrl: true,
          email: true,
          location: true,
          source: true,
          stageId: true,
          createdAt: true,
          // Denormalized — drives the inbox-row 24h-window chip without
          // the lateral MAX(message.timestamp) GROUP BY that the list
          // used to do per page.
          lastInboundAt: true,
          tags: { select: { id: true } },
        },
      },
      assignedUser: { select: ASSIGNED_USER_SELECT },
    },
  });

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeConvoCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
      : null;

  // Pull lastInboundAt straight from the denormalized `Contact.lastInboundAt`
  // column maintained by the ingest path — saves the per-page lateral
  // MAX(m.timestamp) GROUP BY contactId roundtrip the inbox list used to do
  // (still kept below as `fetchLastInboundMap` for any future caller that
  // needs the same value on a contact NOT yet in the SELECT).
  const inboundMap = new Map<string, string | null>(
    sliced.map((r) => [
      r.contact.id,
      r.contact.lastInboundAt ? r.contact.lastInboundAt.toISOString() : null,
    ]),
  );

  // Unread is team-wide only — the row badge + bold cue both read the
  // `unreadCount` counter carried by `mapConversation`. There is no
  // per-agent read state for the inbox (team chat has its own; see
  // TeamChannelReadReceipt). Any member opening a thread clears it for all.
  const items = sliced.map((row) => ({
    conversation: mapConversation(row),
    contact: {
      ...mapContactListItem(row.contact),
      tagIds: row.contact.tags.map((t) => t.id),
    },
    assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
    messages: [],
    notes: [],
    lastInboundAt: inboundMap.get(row.contact.id) ?? null,
  }));

  return { items, nextCursor };
}

/**
 * Hydrate a conversation with its most recent `messageLimit` messages
 * (default 50) and the full notes list. Returns `nextOlderCursor` so the
 * thread can fetch older pages on scroll.
 *
 * Notes aren't paginated for now — there are typically <10 per thread.
 */
export async function getConversationWithRefs(
  teamId: string,
  conversationId: string,
  opts: { messageLimit?: number } = {},
): Promise<{ data: ConversationWithRefs; nextOlderCursor: string | null } | null> {
  const limit = clampTake(opts.messageLimit, MESSAGES_PAGE);

  const row = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    include: {
      contact: { include: { tags: { select: { id: true } } } },
      assignedUser: { select: ASSIGNED_USER_SELECT },
      // +1 to detect "more older exists" without a count query.
      messages: {
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: limit + 1,
        omit: { rawPayload: true },
        include: { replyTo: REPLY_TO_INCLUDE },
      },
      notes: { orderBy: { timestamp: "asc" } },
      // Inline activity log. Bounded to the most recent ACTIVITY_WINDOW events
      // (desc here, reversed to asc below) so a churny thread can't bloat the
      // hydration payload — the thread's note-style visibility filter then
      // hides any that predate the oldest loaded message. `user` is joined for
      // the actor name; `apiKey` for its label so external /v1 changes read as
      // the integration name, not a blank actor. Rides the
      // (conversationId, at DESC) index. call_* kinds are excluded
      // (NON_PILL_EVENT_KINDS) — they're DB-only audit rows with no
      // activity-entry renderer (the visible element is CallBubble from the
      // Call row), so carrying them would only waste the ACTIVITY_WINDOW budget.
      events: {
        where: { kind: { notIn: NON_PILL_EVENT_KINDS } },
        orderBy: { at: "desc" },
        take: ACTIVITY_WINDOW,
        include: {
          user: { select: { name: true } },
          apiKey: { select: { name: true } },
        },
      },
      // Recent calls — same shape as the GET /conversations/:id/calls
      // endpoint emits. Bounded the same way `events` is so the thread
      // hydration payload stays small on chat-switch / SSR refresh.
      calls: {
        orderBy: [{ ringingAt: "desc" }, { id: "desc" }],
        take: ACTIVITY_WINDOW,
        select: {
          id: true,
          conversationId: true,
          externalCallId: true,
          channel: true,
          direction: true,
          status: true,
          initiatedByUserId: true,
          answeredByUserId: true,
          ringingAt: true,
          answeredAt: true,
          endedAt: true,
          durationSeconds: true,
        },
      },
      // Totals computed in the SAME round-trip via a relation aggregate —
      // replaces two separate count() queries (one per message + note) that
      // ran on every thread open (a hot path: chat-switch cache-miss + reconnect
      // refetch). Same numbers, two fewer round-trips.
      _count: { select: { messages: true, notes: true } },
    },
  });
  if (!row) return null;

  const hasMore = row.messages.length > limit;
  const recent = hasMore ? row.messages.slice(0, limit) : row.messages;
  // Reverse to chronological order for the UI; keeps timeline rendering simple.
  const messagesAsc = [...recent].reverse();
  const oldest = messagesAsc[0];
  const nextOlderCursor =
    hasMore && oldest ? encodeMessageCursor({ timestamp: oldest.timestamp, id: oldest.id }) : null;

  // Latest inbound across ALL of this contact's conversations (the 24h
  // window is contact-level on Meta's side). Read from the denormalized
  // `Contact.lastInboundAt` column maintained by the ingest path — the
  // previous Message scan with a join through Conversation seq-scanned
  // a heavy contact's entire history on every thread open.
  const messageCount = row._count.messages;
  const noteCount = row._count.notes;
  const lastInboundAtIso = row.contact.lastInboundAt
    ? row.contact.lastInboundAt.toISOString()
    : null;

  const events = await mapActivityEventRows(row.events);

  // Calls were fetched DESC; reverse to chronological so they merge into
  // the timeline alongside messages/notes the same way.
  const callsAsc = [...row.calls].reverse().map((c) => ({
    id: c.id,
    conversationId: c.conversationId,
    externalCallId: c.externalCallId,
    channel: c.channel,
    direction: c.direction === "in" ? ("in" as const) : ("out" as const),
    status: c.status,
    initiatedByUserId: c.initiatedByUserId,
    answeredByUserId: c.answeredByUserId,
    ringingAt: c.ringingAt.toISOString(),
    answeredAt: c.answeredAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    durationSeconds: c.durationSeconds,
  }));

  return {
    data: {
      conversation: mapConversation(row),
      contact: {
        ...mapContact(row.contact),
        tagIds: row.contact.tags.map((t) => t.id),
      },
      assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
      messages: messagesAsc.map(mapMessage),
      notes: row.notes.map(mapNote),
      events,
      calls: callsAsc,
      lastInboundAt: lastInboundAtIso,
      messageCount,
      noteCount,
    },
    nextOlderCursor,
  };
}

// Shape of the joined ConversationEvent rows both event readers fetch.
type ActivityEventRow = Parameters<typeof mapActivityEvent>[0];

/**
 * Map a DESC-ordered batch of joined ConversationEvent rows into chronological
 * (oldest-first) DTOs, resolving assignee names for `assigned` events in ONE
 * batched lookup (the audit row stores the assignee's id, not a name, and has
 * no FK to join). Shared by the thread hydration and the events-only refetch
 * so the resolution logic lives in one place. Deactivated/removed users still
 * resolve (no deletedAt filter) so "assigned to <name>" survives a departure.
 */
async function mapActivityEventRows(
  rowsDesc: ActivityEventRow[],
): Promise<ConversationWithRefs["events"]> {
  const assigneeIds = new Set<string>();
  for (const e of rowsDesc) {
    if (e.kind !== "assigned") continue;
    const after = e.after as { assignedUserId?: unknown } | null;
    if (after && typeof after.assignedUserId === "string") {
      assigneeIds.add(after.assignedUserId);
    }
  }
  const assigneeNameById = new Map<string, string>();
  if (assigneeIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: [...assigneeIds] } },
      select: { id: true, name: true },
    });
    for (const u of users) assigneeNameById.set(u.id, u.name);
  }
  // Reverse the desc fetch to chronological (oldest-first) so it merges into
  // the timeline the same way messages/notes do.
  return [...rowsDesc].reverse().map((e) => mapActivityEvent(e, assigneeNameById));
}

/**
 * Events-only refetch for the displayed thread. The activity log is written
 * server-side AFTER the realtime frame fans out (audit runs at a lower bus
 * priority than realtime), so when the live thread receives a status/assign/
 * contact/note frame, the authoritative event row exists but the client
 * doesn't have it yet. This re-pulls the recent window so the new pill appears
 * — fully attributed, no client-side actor guessing. Tenant-scoped; returns
 * [] (not an error) for a non-owned id so a racing refetch after delete is a
 * no-op. Same ACTIVITY_WINDOW bound as the hydration.
 */
export async function listConversationEvents(
  teamId: string,
  conversationId: string,
): Promise<ConversationWithRefs["events"]> {
  const owns = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!owns) return [];

  const rows = await db.conversationEvent.findMany({
    // Mirror the hydration's exclusion so the events-only refetch never
    // surfaces a call_* row the timeline can't render (CallBubble owns calls).
    where: { conversationId, teamId, kind: { notIn: NON_PILL_EVENT_KINDS } },
    orderBy: { at: "desc" },
    take: ACTIVITY_WINDOW,
    include: {
      user: { select: { name: true } },
      apiKey: { select: { name: true } },
    },
  });
  return mapActivityEventRows(rows);
}

/**
 * Page of messages older than the given cursor. Returns chronological
 * (oldest-first) within the page so the UI can prepend.
 */
export async function listOlderMessages(
  teamId: string,
  conversationId: string,
  opts: { take?: number; before: string },
): Promise<CursorPage<Message>> {
  const take = clampTake(opts.take, MESSAGES_PAGE);
  const cursor = parseMessageCursor(opts.before);
  if (!cursor) return { items: [], nextCursor: null };

  // Confirm the conversation belongs to the team — a malicious client
  // shouldn't be able to enumerate other tenants' messages by guessing IDs.
  const owns = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!owns) return { items: [], nextCursor: null };

  const rows = await db.message.findMany({
    omit: { rawPayload: true },
    include: { replyTo: REPLY_TO_INCLUDE },
    where: {
      conversationId,
      OR: [
        { timestamp: { lt: cursor.timestamp } },
        { timestamp: cursor.timestamp, id: { lt: cursor.id } },
      ],
    },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const slicedDesc = hasMore ? rows.slice(0, take) : rows;
  const itemsAsc = [...slicedDesc].reverse();
  const oldest = itemsAsc[0];
  const nextCursor =
    hasMore && oldest ? encodeMessageCursor({ timestamp: oldest.timestamp, id: oldest.id }) : null;

  return { items: itemsAsc.map(mapMessage), nextCursor };
}

/**
 * Page of messages strictly NEWER than the given ISO timestamp, chronological
 * (oldest-first). Closes the SSR → socket-subscribe gap: any webhook that
 * landed between server render and the client's `subscribe:conversation` was
 * emitted into an empty room, so on (re)connect the client asks for the
 * delta and dedupes by externalId on the way in.
 *
 * `state` carries the current conversation header (status + assignedUser +
 * unreadCount) so the same backfill also re-syncs non-message events that
 * fired during the gap — without it, an assignment / status / read flip
 * during a reconnect-after-disconnect would stay stuck on the stale value
 * until the agent navigates away and back. Tracked as Finding #7 in the
 * assignment audit.
 *
 * No cursor — the delta is bounded by how long the tab was hydrating or
 * disconnected. We cap at MESSAGES_PAGE; on the rare case it's hit, the
 * client should treat it as "too far behind" and force a thread re-fetch.
 */
export async function listNewerMessages(
  teamId: string,
  conversationId: string,
  opts: { after: string; take?: number },
): Promise<{
  items: Message[];
  state?: {
    status: import("@ccp/shared/types").ConversationStatus;
    assignedUserId: string | null;
    assignedUser: import("@ccp/shared/types").User | null;
    unreadCount: number;
    /** AI Autopilot state — carried in the delta resync so a conversation:ai
     *  frame missed during a socket gap converges on the next backfill (matches
     *  the "every recovery path converges to server state" rule). */
    aiEnabled: boolean;
    /**
     * Customer's most-recent inbound timestamp — drives the 24h-window
     * lock on the reply-box composer. Pulled from `Contact.lastInboundAt`
     * (the same denormalized field the SSR thread reads) so a reconnect
     * during which an inbound arrived doesn't leave the composer stuck
     * on the pre-gap value and falsely greyed out.
     */
    lastInboundAt: string | null;
  };
}> {
  const afterDate = new Date(opts.after);
  if (Number.isNaN(afterDate.getTime())) return { items: [] };

  // Same tenant gate as listOlderMessages — silent empty page so we don't
  // leak which conversation IDs exist in other teams. Pull the header
  // fields the reconnect-resync needs in the same round-trip; selected
  // fields are cheap and avoid a second query.
  const owns = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    include: {
      assignedUser: { select: ASSIGNED_USER_SELECT },
      contact: { select: { lastInboundAt: true } },
    },
  });
  if (!owns) return { items: [] };

  const take = clampTake(opts.take, MESSAGES_PAGE);
  const rows = await db.message.findMany({
    omit: { rawPayload: true },
    include: { replyTo: REPLY_TO_INCLUDE },
    where: { conversationId, timestamp: { gt: afterDate } },
    orderBy: [{ timestamp: "asc" }, { id: "asc" }],
    take,
  });

  return {
    items: rows.map(mapMessage),
    state: {
      status: owns.status,
      assignedUserId: owns.assignedUserId,
      assignedUser: owns.assignedUser ? mapUser(owns.assignedUser) : null,
      unreadCount: owns.unreadCount,
      aiEnabled: owns.aiEnabled,
      lastInboundAt: owns.contact.lastInboundAt
        ? owns.contact.lastInboundAt.toISOString()
        : null,
    },
  };
}

export const ATTACHMENTS_PAGE = 40;

/**
 * Maps the gallery's filter chip to the Prisma `mediaKind` predicate. The
 * `MediaKind` shared union is image / video / audio / document / sticker,
 * so the chip groups them as:
 *   - `image`    matches image OR sticker (both render as a thumbnail)
 *   - `audio` / `video` / `document` map 1:1
 */
function mediaKindFilter(kind: string | undefined): Prisma.MessageWhereInput | null {
  if (!kind) return null;
  switch (kind) {
    case "image":
      return { mediaKind: { in: ["image", "sticker"] } };
    case "audio":
      return { mediaKind: "audio" };
    case "video":
      return { mediaKind: "video" };
    case "document":
      return { mediaKind: "document" };
    default:
      return null;
  }
}

/**
 * Per-conversation attachments list (the "Files" tab in the contact panel).
 * Returns media-bearing messages newest-first, in the same shape as
 * `listOlderMessages` so the gallery can call into the existing
 * jump-to-message machinery without remapping.
 *
 * Excludes inbound rows whose binary is still downloading
 * (mediaUrl IS NULL) — they'd render an empty thumbnail. They'll appear on
 * the next page load once `completePendingMedia` fills them in.
 */
export async function listConversationAttachments(
  teamId: string,
  conversationId: string,
  opts: { cursor?: string; take?: number; kind?: string },
): Promise<CursorPage<Message>> {
  const take = clampTake(opts.take, ATTACHMENTS_PAGE);

  // Tenant gate — silent empty page so we don't leak which conversation IDs
  // exist in other teams (same posture as listOlderMessages).
  const owns = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!owns) return { items: [], nextCursor: null };

  const cursor = opts.cursor ? parseMessageCursor(opts.cursor) : null;
  const kindClause = mediaKindFilter(opts.kind);

  const rows = await db.message.findMany({
    omit: { rawPayload: true },
    include: { replyTo: REPLY_TO_INCLUDE },
    where: {
      conversationId,
      mediaKind: { not: null },
      mediaUrl: { not: null },
      ...(kindClause ?? {}),
      ...(cursor
        ? {
            OR: [
              { timestamp: { lt: cursor.timestamp } },
              { timestamp: cursor.timestamp, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const oldest = items[items.length - 1];
  const nextCursor =
    hasMore && oldest
      ? encodeMessageCursor({ timestamp: oldest.timestamp, id: oldest.id })
      : null;

  return { items: items.map(mapMessage), nextCursor };
}
