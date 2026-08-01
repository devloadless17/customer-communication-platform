import { db } from "@/lib/db";
import type {
  ContactSearchHit,
  ContactSearchPage,
  GlobalMessageHit,
  GlobalMessageSearchPage,
  NoteSearchHit,
  NoteSearchPage,
} from "@ccp/shared/dtos";
import type { MediaKind, MessageDirection } from "@ccp/shared/types";

import { clampTake, siblingChannelsByCustomer } from "./_shared";
import { directoryContactWhere } from "./contacts";
import {
  encodeContactCursor,
  encodeMessageCursor,
  parseContactCursor,
  parseMessageCursor,
} from "./_cursors";

// ---------------------------------------------------------------------------
// GLOBAL inbox search — the tabbed search bar over the conversation list.
//
// Distinct from search.ts's `searchConversationMessages`, which is scoped to a
// SINGLE open conversation (the WhatsApp-style in-thread find). This module
// searches team-wide across EVERY conversation, in three scopes:
//
//   contacts — name / phone / email          (trgm on name, btree on phone)
//   messages — body (caption lives in body)  (Message_body_trgm_idx)
//   notes    — internal-note body            (InternalNote_body_trgm_idx)
//
// All three are case-insensitive substring (ILIKE). We keep substring rather
// than Postgres FTS for the same reason as the in-thread search: agents search
// for fragments ("invoice 88", a partial phone), and the trgm GIN indexes make
// ILIKE fast without the tsvector-column migration + tokenizer surprises.
//
// Every hit carries `conversationId` so the inbox can open the right thread,
// and message/note hits carry the row id so the thread can jump to the match
// via the existing /messages/context window.
//
// Snapshot semantics match useConversationSearch: results are a point-in-time
// query, NOT a live subscription. Re-type to refresh.
// ---------------------------------------------------------------------------

const DEFAULT_TAKE = 25;

/** Trim a body/caption down to a single-line snippet for the result row. */
function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Contacts whose name / phone / email matches `query`, team-wide, excluding
 * soft-deleted rows. Newest-first by createdAt (stable keyset — every contact
 * has a createdAt, unlike lastInboundAt). Each hit resolves the contact's
 * single conversation id (one-per-contact invariant) so the row can open it;
 * null when the contact has never been chatted to.
 */
export async function searchContacts(
  workspaceId: string,
  opts: {
    query: string;
    take?: number;
    cursor?: string | null;
    /**
     * Agent conversation-visibility boundary (lib/conversations/visibility.ts).
     * `{}` for unrestricted viewers, so an un-configured org's search is
     * unchanged; `{ assignedUserId }` restricts an agent to their own threads.
     * Global search is the widest read surface in the product — it returns
     * message bodies, note bodies and contact PII across the whole org — so it
     * must be scoped as tightly as the conversation list itself.
     */
    visibility?: { assignedUserId?: string };
  },
): Promise<ContactSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  const cursor = parseContactCursor(opts.cursor ?? null);
  const overFetch = take * 4 + 1;
  // A restricted agent may only find contacts they actually own a conversation
  // with. `some` (not `every`) because one contact has exactly one conversation
  // per channel and owning any of them is enough to know the person.
  const visibilityClause = opts.visibility?.assignedUserId
    ? { conversations: { some: { assignedUserId: opts.visibility.assignedUserId } } }
    : {};
  const matchOr = [
    { name: { contains: query, mode: "insensitive" as const } },
    { phoneNumber: { contains: query } },
    { email: { contains: query, mode: "insensitive" as const } },
  ];

  const fetchWindow = (from: { sortAt: Date; id: string } | null) =>
    db.contact.findMany({
      // The match OR and the keyset OR must BOTH hold, so nest both inside AND —
      // a single top-level `OR` key can't hold two independent disjunctions.
      // `visibilityClause` goes inside AND, never spread at the top level:
      // `directoryContactWhere` is itself an OR node, and a sibling spread
      // would widen rather than narrow it (a bug this codebase has already
      // paid for once — see lib/identity/identity-service.ts).
      where: from
        ? {
            workspaceId,
            deletedAt: null,
            AND: [
              directoryContactWhere,
              visibilityClause,
              { OR: matchOr },
              {
                OR: [
                  { createdAt: { lt: from.sortAt } },
                  { createdAt: from.sortAt, id: { lt: from.id } },
                ],
              },
            ],
          }
        : {
            workspaceId,
            deletedAt: null,
            AND: [directoryContactWhere, visibilityClause, { OR: matchOr }],
          },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // Over-fetch: we paginate CONTACTS but display PEOPLE, and a person can span
      // several channel-contacts. Fetch enough contacts to still fill a full page
      // of `take` PEOPLE after collapsing to one representative per person.
      take: overFetch,
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        identityChannel: true,
        avatarUrl: true,
        createdAt: true,
        customerId: true,
        conversations: { select: { id: true }, take: 1 },
      },
    });
  type Row = Awaited<ReturnType<typeof fetchWindow>>[number];

  // Unified-identity rollup: collapse matched contacts that belong to the same
  // person (`customerId`) into ONE hit, so a 3-channel person shows once with a
  // channel-badge cluster instead of three duplicate rows.
  //
  // A person is represented EXACTLY ONCE across the whole result set — at their
  // GLOBALLY newest matching contact. We can't dedup with a per-page seen-set:
  // it can't remember a person shown on an earlier page, so an older sibling
  // would re-represent them on a later page (cross-page dup); and advancing the
  // cursor past the (take+1)th person's contact silently DROPS a single-contact
  // person sitting exactly on a page boundary. Instead we ask the DB for each
  // matched person's newest matching contact (page-independent) and treat only
  // THAT contact as the representative — every other matching contact is skipped.
  const newestMatchForWindow = async (rows: Row[]): Promise<Map<string, string>> => {
    const byCustomer = new Map<string, string>();
    const ids = [...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v))];
    if (ids.length === 0) return byCustomer;
    const newest = await db.contact.findMany({
      // The SAME predicate the page query uses, for the same reason it is ANDed
      // there. "The person's newest match" has to mean "newest match THIS VIEWER
      // CAN SEE": computed against the unfiltered set, the winner can be a
      // contact the page query never returns (an ephemeral widget contact that
      // `directoryContactWhere` excludes, or a thread a restricted agent is not
      // assigned), and then no visible sibling is representative — so the person
      // vanishes from search entirely rather than showing under the contact the
      // viewer does have.
      where: {
        workspaceId,
        deletedAt: null,
        customerId: { in: ids },
        AND: [directoryContactWhere, visibilityClause, { OR: matchOr }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["customerId"],
      select: { customerId: true, id: true },
    });
    for (const n of newest) if (n.customerId) byCustomer.set(n.customerId, n.id);
    return byCustomer;
  };

  // Scan windows in keyset order collecting one representative per person until
  // the page is full. A window can be mostly (even entirely) non-representatives
  // — every contact in it belonging to a person already shown on an earlier page
  // — so a single window is NOT guaranteed to yield `take` people. Keep scanning
  // until the page fills, we prove there's an overflow person, or the matches run
  // out. Capped so a pathological audience can't turn one search into an
  // unbounded table walk; hitting the cap just returns a short page with a live
  // cursor (the caller pages on `nextCursor`, never on `items.length`).
  const MAX_SCAN_WINDOWS = 5;
  const reps: Row[] = [];
  let hasMoreReps = false; // saw a (take+1)th person → there is definitely a next page
  let exhausted = false; // walked past the last matching contact
  let lastRow: Row | null = null;
  let scanFrom = cursor;

  for (let i = 0; i < MAX_SCAN_WINDOWS && reps.length < take && !hasMoreReps; i++) {
    const rows = await fetchWindow(scanFrom);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    const newestMatchByCustomer = await newestMatchForWindow(rows);
    // A contact represents its person iff it's that person's newest match.
    // Unlinked contacts (no customerId) are their own person and always represent.
    const isRepresentative = (c: Row) =>
      c.customerId === null || newestMatchByCustomer.get(c.customerId) === c.id;

    for (const c of rows) {
      if (!isRepresentative(c)) continue;
      if (reps.length === take) {
        hasMoreReps = true;
        break;
      }
      reps.push(c);
    }
    lastRow = rows[rows.length - 1]!;
    if (rows.length < overFetch) {
      exhausted = true;
      break;
    }
    scanFrom = { sortAt: lastRow.createdAt, id: lastRow.id };
  }

  const pageReps = reps;
  let nextCursor: string | null = null;
  if (hasMoreReps) {
    // Resume strictly older than the LAST INCLUDED person (never the overflow
    // one), so the overflow person leads the next page — no boundary drop. Reps
    // are globally unique per person, so re-scanning the skipped non-reps in
    // between is a no-op, not a duplicate.
    const last = reps[reps.length - 1]!;
    nextCursor = encodeContactCursor({ sortAt: last.createdAt, id: last.id });
  } else if (!exhausted && lastRow) {
    // The page filled (or the scan cap hit) with matches still unscanned: every
    // rep up to `lastRow` was collected, so resume past it.
    nextCursor = encodeContactCursor({ sortAt: lastRow.createdAt, id: lastRow.id });
  }

  // Fetch the SIBLING channels for every matched person so the cluster shows all
  // their channels, not only the ones that happened to match the query. Only for
  // linked persons (customerId set); solo persons already have their one channel.
  const customerIds = [
    ...new Set(pageReps.map((c) => c.customerId).filter((v): v is string => !!v)),
  ];
  const siblingsByCustomer = await siblingChannelsByCustomer(workspaceId, customerIds, {
    withConversation: true,
  });

  const lowered = query.toLowerCase();
  const items: ContactSearchHit[] = [];
  for (const c of pageReps) {
    // Pick which field actually matched, preferring name > email > phone for
    // the snippet (name is the most human-meaningful when several match).
    let matchedField: ContactSearchHit["matchedField"] = "name";
    let matchedValue = c.name;
    if (!c.name.toLowerCase().includes(lowered)) {
      if (c.email && c.email.toLowerCase().includes(lowered)) {
        matchedField = "email";
        matchedValue = c.email;
      } else if (c.phoneNumber && c.phoneNumber.includes(query)) {
        matchedField = "phone";
        matchedValue = c.phoneNumber;
      }
    }

    const channels: ContactSearchHit["channels"] =
      (c.customerId && siblingsByCustomer.get(c.customerId)) || [
        {
          contactId: c.id,
          channel: c.identityChannel,
          conversationId: c.conversations[0]?.id ?? null,
        },
      ];

    items.push({
      contactId: c.id,
      conversationId: c.conversations[0]?.id ?? null,
      name: c.name,
      phoneNumber: c.phoneNumber,
      channel: c.identityChannel,
      channels,
      matchedField,
      matchedValue,
      ...(c.avatarUrl ? { avatarUrl: c.avatarUrl } : {}),
    });
  }

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Messages (team-wide)
// ---------------------------------------------------------------------------

/**
 * Messages whose body matches `query`, across every conversation in the team,
 * newest-first. Joins the conversation's contact for the row header. Rides
 * Message_body_trgm_idx for the team-wide ILIKE.
 *
 * We match `body` ONLY — NOT `mediaCaption` — even though the in-thread search
 * (search.ts) ORs both. The caption is always copied into `body` at every
 * write site (inbound ingest, outbound media send, forward — verified), so a
 * caption-only match is impossible and the arm is provably redundant. Dropping
 * it lets Postgres BitmapAnd the `workspaceId` filter with Message_body_trgm_idx;
 * an OR over un-indexed `mediaCaption` would force a BitmapOr that needs an
 * index on every arm, defeating the trgm GIN and degrading to a team-wide
 * seq-scan. (The in-thread search keeps the OR because that query is already
 * scoped to one conversation's tiny slice via the keyset index, so the planner
 * never relies on a trgm index there.)
 */
export async function searchAllMessages(
  workspaceId: string,
  opts: {
    query: string;
    take?: number;
    cursor?: string | null;
    /**
     * Agent conversation-visibility boundary (lib/conversations/visibility.ts).
     * `{}` for unrestricted viewers, so an un-configured org's search is
     * unchanged; `{ assignedUserId }` restricts an agent to their own threads.
     * Global search is the widest read surface in the product — it returns
     * message bodies, note bodies and contact PII across the whole org — so it
     * must be scoped as tightly as the conversation list itself.
     */
    visibility?: { assignedUserId?: string };
    /** Narrow to one channel account's threads (the sidebar's account filter). */
    accountId?: string | null;
  },
): Promise<GlobalMessageSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  const cursor = parseMessageCursor(opts.cursor ?? null);
  const conversationWhere = {
    ...(opts.visibility?.assignedUserId
      ? { assignedUserId: opts.visibility.assignedUserId }
      : {}),
    ...(opts.accountId ? { channelConnectionId: opts.accountId } : {}),
  };
  const matchBody = {
    body: { contains: query, mode: "insensitive" as const },
    ...(Object.keys(conversationWhere).length > 0
      ? { conversation: conversationWhere }
      : {}),
  };

  const rows = await db.message.findMany({
    where: cursor
      ? {
          workspaceId,
          ...matchBody,
          AND: [
            {
              OR: [
                { timestamp: { lt: cursor.timestamp } },
                { timestamp: cursor.timestamp, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : { workspaceId, ...matchBody },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      conversationId: true,
      body: true,
      mediaKind: true,
      direction: true,
      timestamp: true,
      conversation: {
        select: { contact: { select: { name: true, avatarUrl: true } } },
      },
    },
  });

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeMessageCursor({ timestamp: last.timestamp, id: last.id })
      : null;

  const items: GlobalMessageHit[] = sliced.map((m) => {
    // `body` already carries any media caption (copied at every write site),
    // so it's the single snippet source — the matched text is always in here.
    const contact = m.conversation.contact;
    return {
      messageId: m.id,
      conversationId: m.conversationId,
      contactName: contact?.name ?? "Unknown",
      snippet: snippet(m.body),
      direction: m.direction as MessageDirection,
      timestamp: m.timestamp.toISOString(),
      ...(contact?.avatarUrl ? { contactAvatarUrl: contact.avatarUrl } : {}),
      ...(m.mediaKind ? { mediaKind: m.mediaKind as MediaKind } : {}),
    };
  });

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Internal notes (team-wide)
// ---------------------------------------------------------------------------

/**
 * Internal notes whose body matches `query`, across every conversation in the
 * team, newest-first. Joins the conversation's contact + the note author.
 * Rides InternalNote_body_trgm_idx. The note's own `workspaceId` denorm scopes the
 * query directly (no conversation join needed for the WHERE).
 */
export async function searchAllNotes(
  workspaceId: string,
  opts: {
    query: string;
    take?: number;
    cursor?: string | null;
    /**
     * Agent conversation-visibility boundary (lib/conversations/visibility.ts).
     * `{}` for unrestricted viewers, so an un-configured org's search is
     * unchanged; `{ assignedUserId }` restricts an agent to their own threads.
     * Global search is the widest read surface in the product — it returns
     * message bodies, note bodies and contact PII across the whole org — so it
     * must be scoped as tightly as the conversation list itself.
     */
    visibility?: { assignedUserId?: string };
    /** Narrow to one channel account's threads (the sidebar's account filter). */
    accountId?: string | null;
  },
): Promise<NoteSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  // InternalNote_teamId_timestamp_id_idx (workspaceId, timestamp desc, id desc)
  // backs this team-wide (timestamp desc, id desc) keyset ORDER BY — added in
  // migration 20260530140000, same shape as the Message search path. The result
  // set per query is small (notes are sparse vs messages) and the trgm GIN on
  // body filters first. Reuse the message cursor codec — same (timestamp, id) shape.
  const cursor = parseMessageCursor(opts.cursor ?? null);
  const noteConversationWhere = {
    ...(opts.visibility?.assignedUserId
      ? { assignedUserId: opts.visibility.assignedUserId }
      : {}),
    ...(opts.accountId ? { channelConnectionId: opts.accountId } : {}),
  };
  const matchWhere = {
    workspaceId,
    body: { contains: query, mode: "insensitive" as const },
    ...(Object.keys(noteConversationWhere).length > 0
      ? { conversation: noteConversationWhere }
      : {}),
  };

  const rows = await db.internalNote.findMany({
    where: cursor
      ? {
          ...matchWhere,
          OR: [
            { timestamp: { lt: cursor.timestamp } },
            { timestamp: cursor.timestamp, id: { lt: cursor.id } },
          ],
        }
      : matchWhere,
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      conversationId: true,
      body: true,
      timestamp: true,
      author: { select: { name: true } },
      conversation: {
        select: { contact: { select: { name: true, avatarUrl: true } } },
      },
    },
  });

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeMessageCursor({ timestamp: last.timestamp, id: last.id })
      : null;

  const items: NoteSearchHit[] = sliced.map((n) => {
    const contact = n.conversation.contact;
    return {
      noteId: n.id,
      conversationId: n.conversationId,
      contactName: contact?.name ?? "Unknown",
      authorName: n.author?.name ?? null,
      snippet: snippet(n.body),
      timestamp: n.timestamp.toISOString(),
      ...(contact?.avatarUrl ? { contactAvatarUrl: contact.avatarUrl } : {}),
    };
  });

  return { items, nextCursor };
}
