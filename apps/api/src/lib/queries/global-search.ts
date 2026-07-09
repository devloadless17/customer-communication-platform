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

import { clampTake } from "./_shared";
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
  teamId: string,
  opts: { query: string; take?: number; cursor?: string | null },
): Promise<ContactSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  const cursor = parseContactCursor(opts.cursor ?? null);
  const matchOr = [
    { name: { contains: query, mode: "insensitive" as const } },
    { phoneNumber: { contains: query } },
    { email: { contains: query, mode: "insensitive" as const } },
  ];

  const rows = await db.contact.findMany({
    // The match OR and the keyset OR must BOTH hold, so nest both inside AND —
    // a single top-level `OR` key can't hold two independent disjunctions.
    where: cursor
      ? {
          teamId,
          deletedAt: null,
          AND: [
            { OR: matchOr },
            {
              OR: [
                { createdAt: { lt: cursor.sortAt } },
                { createdAt: cursor.sortAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : { teamId, deletedAt: null, OR: matchOr },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
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

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeContactCursor({ sortAt: last.createdAt, id: last.id })
      : null;

  // Unified-identity rollup: collapse matched contacts that belong to the same
  // person (`customerId`) into ONE hit, so a 3-channel person shows once with a
  // channel-badge cluster instead of three duplicate rows. A contact with no
  // customerId (not-yet-linked, ~seconds after create) is its own person keyed
  // by its contactId. Order preserved by the first-matched contact per person.
  const personKey = (c: { customerId: string | null; id: string }) =>
    c.customerId ?? `contact:${c.id}`;

  // Fetch the SIBLING channels for every matched person so the cluster shows all
  // their channels, not only the ones that happened to match the query. Only for
  // linked persons (customerId set); solo persons already have their one channel.
  const customerIds = [
    ...new Set(sliced.map((c) => c.customerId).filter((v): v is string => !!v)),
  ];
  const siblingsByCustomer = new Map<string, ContactSearchHit["channels"]>();
  if (customerIds.length > 0) {
    const siblings = await db.contact.findMany({
      where: { teamId, deletedAt: null, customerId: { in: customerIds } },
      select: {
        id: true,
        customerId: true,
        identityChannel: true,
        conversations: { select: { id: true }, take: 1 },
      },
    });
    for (const s of siblings) {
      if (!s.customerId) continue;
      const list = siblingsByCustomer.get(s.customerId) ?? [];
      list.push({
        contactId: s.id,
        channel: s.identityChannel,
        conversationId: s.conversations[0]?.id ?? null,
      });
      siblingsByCustomer.set(s.customerId, list);
    }
  }

  const lowered = query.toLowerCase();
  const seen = new Set<string>();
  const items: ContactSearchHit[] = [];
  for (const c of sliced) {
    const key = personKey(c);
    if (seen.has(key)) continue; // person already represented by an earlier match
    seen.add(key);

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
 * it lets Postgres BitmapAnd the `teamId` filter with Message_body_trgm_idx;
 * an OR over un-indexed `mediaCaption` would force a BitmapOr that needs an
 * index on every arm, defeating the trgm GIN and degrading to a team-wide
 * seq-scan. (The in-thread search keeps the OR because that query is already
 * scoped to one conversation's tiny slice via the keyset index, so the planner
 * never relies on a trgm index there.)
 */
export async function searchAllMessages(
  teamId: string,
  opts: { query: string; take?: number; cursor?: string | null },
): Promise<GlobalMessageSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  const cursor = parseMessageCursor(opts.cursor ?? null);
  const matchBody = {
    body: { contains: query, mode: "insensitive" as const },
  };

  const rows = await db.message.findMany({
    where: cursor
      ? {
          teamId,
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
      : { teamId, ...matchBody },
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
 * Rides InternalNote_body_trgm_idx. The note's own `teamId` denorm scopes the
 * query directly (no conversation join needed for the WHERE).
 */
export async function searchAllNotes(
  teamId: string,
  opts: { query: string; take?: number; cursor?: string | null },
): Promise<NoteSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  // InternalNote_teamId_timestamp_id_idx (teamId, timestamp desc, id desc)
  // backs this team-wide (timestamp desc, id desc) keyset ORDER BY — added in
  // migration 20260530140000, same shape as the Message search path. The result
  // set per query is small (notes are sparse vs messages) and the trgm GIN on
  // body filters first. Reuse the message cursor codec — same (timestamp, id) shape.
  const cursor = parseMessageCursor(opts.cursor ?? null);
  const matchWhere = {
    teamId,
    body: { contains: query, mode: "insensitive" as const },
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
