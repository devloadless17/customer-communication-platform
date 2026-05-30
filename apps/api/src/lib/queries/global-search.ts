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
//   messages — body / mediaCaption           (Message_body_trgm_idx)
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
      avatarUrl: true,
      createdAt: true,
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

  const lowered = query.toLowerCase();
  const items: ContactSearchHit[] = sliced.map((c) => {
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
    return {
      contactId: c.id,
      conversationId: c.conversations[0]?.id ?? null,
      name: c.name,
      phoneNumber: c.phoneNumber,
      matchedField,
      matchedValue,
      ...(c.avatarUrl ? { avatarUrl: c.avatarUrl } : {}),
    };
  });

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Messages (team-wide)
// ---------------------------------------------------------------------------

/**
 * Messages whose body OR mediaCaption matches `query`, across every
 * conversation in the team, newest-first. Joins the conversation's contact for
 * the row header. Rides Message_body_trgm_idx for the team-wide ILIKE.
 */
export async function searchAllMessages(
  teamId: string,
  opts: { query: string; take?: number; cursor?: string | null },
): Promise<GlobalMessageSearchPage> {
  const take = clampTake(opts.take, DEFAULT_TAKE);
  const query = opts.query.trim();
  if (query.length === 0) return { items: [], nextCursor: null };

  const cursor = parseMessageCursor(opts.cursor ?? null);
  const matchOr = [
    { body: { contains: query, mode: "insensitive" as const } },
    { mediaCaption: { contains: query, mode: "insensitive" as const } },
  ];

  const rows = await db.message.findMany({
    where: cursor
      ? {
          teamId,
          AND: [
            { OR: matchOr },
            {
              OR: [
                { timestamp: { lt: cursor.timestamp } },
                { timestamp: cursor.timestamp, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : { teamId, OR: matchOr },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      conversationId: true,
      body: true,
      mediaCaption: true,
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

  const lowered = query.toLowerCase();
  const items: GlobalMessageHit[] = sliced.map((m) => {
    // Prefer the caption as the snippet when IT is what matched (so a media
    // message surfaces the matched caption, not an empty/placeholder body).
    const captionMatched =
      m.mediaCaption != null &&
      m.mediaCaption.toLowerCase().includes(lowered) &&
      !m.body.toLowerCase().includes(lowered);
    const source = captionMatched ? (m.mediaCaption ?? m.body) : m.body;
    const contact = m.conversation.contact;
    return {
      messageId: m.id,
      conversationId: m.conversationId,
      contactName: contact?.name ?? "Unknown",
      snippet: snippet(source),
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
