import { Prisma, type PrismaClient } from "@prisma/client";

import type { TicketAttachment, TicketThreadMessage } from "@ccp/shared/tickets/types";
import { publish } from "@/lib/events/bus";

import { ticketByIdWhere } from "./access";
import type { TicketActor } from "./mutations";
import { ATTACHMENT_SELECT_FIELDS, mapAttachment } from "./queries";

/**
 * The ticket THREAD — the conversation between the departments working one
 * customer's issue, and the per-person "someone replied" signal.
 *
 * Why this is its own entity rather than more `TicketEvent` rows: the audit log
 * answers "who changed what", the thread answers "what did Billing say". Mixing
 * them buried the answer among twenty status flips (the maintainer's actual
 * complaint), and the log's 500-row read cap was SHARED, so on a busy ticket the
 * conversation was what got pushed out.
 *
 * Access is the ticket's access — every read and write here composes
 * `ticketByIdWhere()`, so a guest department reads and writes the same thread as
 * the owner and nobody outside the share reads either.
 */

type Db = Pick<
  PrismaClient,
  "ticket" | "ticketMessage" | "ticketThreadUnread" | "ticketShare" | "$transaction"
>;

/**
 * Per-read cap, same reasoning as the timeline's 500: a ticket bounced through
 * many hands must not ship its whole history on every detail open. Oldest-first
 * within the newest 200 — a thread that long has a scrollback problem worth
 * solving with pagination, not a bigger number.
 */
export const TICKET_THREAD_PAGE = 200;

export const TICKET_MESSAGE_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  clientTempId: true,
  authorUserId: true,
  authorWorkspaceId: true,
  // JOINED, not snapshotted like TicketEvent.after: an event describes a past
  // state and must keep reading correctly after a rename, but a chat author is
  // a live identity that should follow one. Carried on the message because the
  // reader's roster only holds their OWN workspace — a guest cannot resolve an
  // owner-workspace author locally.
  author: { select: { name: true, avatarUrl: true } },
  authorWorkspace: { select: { name: true } },
  attachments: { select: ATTACHMENT_SELECT_FIELDS, orderBy: { createdAt: "asc" } },
} satisfies Prisma.TicketMessageSelect;

type MessageRow = Prisma.TicketMessageGetPayload<{ select: typeof TICKET_MESSAGE_SELECT }>;

export function mapTicketMessage(m: MessageRow, ticketId: string): TicketThreadMessage {
  return {
    id: m.id,
    body: m.body,
    authorUserId: m.authorUserId,
    authorName: m.author?.name ?? null,
    authorAvatarUrl: m.author?.avatarUrl ?? null,
    authorWorkspaceId: m.authorWorkspaceId,
    authorWorkspaceName: m.authorWorkspace?.name ?? null,
    attachments: m.attachments.map((a) => mapAttachment(a, ticketId)),
    createdAt: m.createdAt.toISOString(),
    ...(m.clientTempId ? { clientTempId: m.clientTempId } : {}),
  };
}

/** A ticket's thread, oldest first. Access-gated through the parent. */
export async function listTicketThread(
  db: Db,
  workspaceId: string,
  ticketId: string,
): Promise<TicketThreadMessage[]> {
  const rows = await db.ticketMessage.findMany({
    // Reached through the TICKET's gate, never a bare workspaceId — every
    // message on a shared ticket carries the OWNER's workspaceId, so filtering
    // by the reader's would hand a guest an empty thread.
    where: { ticketId, ticket: ticketByIdWhere(workspaceId, ticketId) },
    orderBy: { createdAt: "desc" },
    take: TICKET_THREAD_PAGE,
    select: TICKET_MESSAGE_SELECT,
  });
  return rows.reverse().map((m) => mapTicketMessage(m, ticketId));
}

/**
 * WHO should be told about a reply.
 *
 * Four arms, all deliberate:
 *  1. the ticket's assignee — the owner side's accountable person;
 *  2. every share's assignee — each guest department's accountable person;
 *  3. every share's CREATOR — the person who escalated. They asked the
 *     question, they are often neither assignee nor poster, and telling them
 *     the answer arrived is the entire point of this feature;
 *  4. everyone who has already spoken in the thread.
 *
 * Deliberately NOT every member of a participating workspace: that badges a
 * whole department for a two-person conversation, which is the noise this is
 * supposed to end. A non-participant who replies joins via arm 4.
 */
export async function resolveThreadParticipants(
  db: Db,
  ticketId: string,
): Promise<string[]> {
  const [ticket, shares, authors] = await Promise.all([
    db.ticket.findUnique({ where: { id: ticketId }, select: { assignedUserId: true } }),
    db.ticketShare.findMany({
      where: { ticketId },
      select: { assignedUserId: true, createdById: true },
    }),
    db.ticketMessage.findMany({
      where: { ticketId },
      select: { authorUserId: true },
      distinct: ["authorUserId"],
    }),
  ]);
  const ids = new Set<string>();
  if (ticket?.assignedUserId) ids.add(ticket.assignedUserId);
  for (const s of shares) {
    if (s.assignedUserId) ids.add(s.assignedUserId);
    if (s.createdById) ids.add(s.createdById);
  }
  for (const a of authors) if (a.authorUserId) ids.add(a.authorUserId);
  return [...ids];
}

export type AddThreadMessageOutcome =
  | { ok: true; message: TicketThreadMessage; notifiedUserIds: string[] }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "empty_message" };

/**
 * Post a message to the thread.
 *
 * Everyone with access to the ticket sees it — that IS the cross-department
 * conversation. (An internal `note` is the other tool: it stays inside the
 * workspace that wrote it. A thread that showed different messages to each side
 * would recreate the two-truths failure the one-ticket rebuild removed.)
 *
 * Not a ticket UPDATE: a reply changes nothing about the work, so it must not
 * bump `version` (which would 409 a colleague's open editor) or move the SLA
 * clock.
 */
export async function addTicketMessage(
  db: Db,
  args: {
    workspaceId: string;
    ticketId: string;
    actor: TicketActor;
    body: string;
    clientTempId?: string | null;
    /**
     * Files that came in WITH the message, filed once the row exists.
     *
     * A callback rather than a second call by the caller, because the realtime
     * frame is published below: attaching afterwards shipped every other
     * client a reply whose evidence was missing until they reloaded the page.
     * One publish site, one complete message.
     */
    attach?: (messageId: string) => Promise<TicketAttachment[]>;
  },
): Promise<AddThreadMessageOutcome> {
  const body = args.body.trim();
  if (!body) return { ok: false, reason: "empty_message" };

  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: {
      id: true,
      number: true,
      workspaceId: true,
      shares: { select: { guestWorkspaceId: true } },
    },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  const authorUserId = args.actor.userId ?? null;

  /**
   * The optimistic-send retry: same (ticket, author, tempId) posted twice
   * because the first response was lost. Return the row that already landed
   * instead of posting again — and, critically, do NOT re-notify, or a retry
   * re-badges a reply the reader has already read.
   *
   * Checked OUTSIDE the transaction, both before and after, because Postgres
   * ABORTS a transaction on the failed statement: catching P2002 inside and
   * then querying gets `current transaction is aborted`, not the row. (Fourth
   * time this repo has hit "try/catch inside a poisoned tx is false safety".)
   */
  const findExisting = async () =>
    args.clientTempId
      ? db.ticketMessage.findFirst({
          where: { ticketId: ticket.id, authorUserId, clientTempId: args.clientTempId },
          select: TICKET_MESSAGE_SELECT,
        })
      : null;

  const alreadySent = await findExisting();
  if (alreadySent) {
    return { ok: true, message: mapTicketMessage(alreadySent, ticket.id), notifiedUserIds: [] };
  }

  let result: { row: MessageRow; notified: string[] };
  try {
    result = await db.$transaction(async (tx) => {
      const row = await tx.ticketMessage.create({
        data: {
          // The ticket's OWNING workspace — one thread per ticket, whoever
          // writes in it.
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          // ...and the ACTING one, which is what the UI renders as the
          // department chip beside the author.
          authorWorkspaceId: args.workspaceId,
          authorUserId,
          authorApiKeyId: args.actor.apiKeyId ?? null,
          body,
          clientTempId: args.clientTempId ?? null,
        },
        select: TICKET_MESSAGE_SELECT,
      });

      const participants = await resolveThreadParticipants(tx, ticket.id);
      // Never notify yourself about your own reply.
      const notified = participants.filter((id) => id !== authorUserId);
      if (notified.length > 0) {
        await tx.ticketThreadUnread.createMany({
          data: notified.map((userId) => ({
            workspaceId: ticket.workspaceId,
            ticketId: ticket.id,
            userId,
            sinceMessageId: row.id,
          })),
          // Keeps the FIRST unread message as the anchor, so the "New replies"
          // divider sits at the first thing you missed rather than the last.
          skipDuplicates: true,
        });
      }
      // The reply is the activity that matters most for ordering: a ticket
      // someone just answered belongs above ones nobody has touched. Inside the
      // transaction so the row and its ordering commit together — and still no
      // `version` bump, so a colleague's open editor does not 409.
      await tx.ticket.updateMany({
        where: { id: ticket.id },
        data: { lastActivityAt: row.createdAt },
      });
      return { row, notified };
    });
  } catch (err) {
    // Lost the race with a concurrent retry of the same send.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await findExisting();
      if (existing) {
        return { ok: true, message: mapTicketMessage(existing, ticket.id), notifiedUserIds: [] };
      }
    }
    throw err;
  }

  const message = mapTicketMessage(result.row, ticket.id);
  if (args.attach) {
    // Failing to store a file must not swallow the reply that explains it —
    // the text is the part people are waiting on.
    message.attachments = await args.attach(result.row.id);
  }
  // Published on the BUS, not through the outbox: the only subscriber is
  // realtime fanout, and a frame lost to a crash is recoverable (every count is
  // server-authoritative on mount and re-seeded on reconnect). The outbox is
  // for subscribers with irreversible side effects — billed sends, partner
  // webhooks, workflow runs. Same call team chat makes for its own messages.
  //
  // Deliberately NOT a `ticket.changed`: a reply moves no ticket state, and
  // republishing the whole Ticket on every reply made every board, sub-sidebar
  // and rail in every participating workspace re-run its counts.
  await publish({
    type: "ticket.thread_message_created",
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    message,
    sharedWithWorkspaceIds: ticket.shares.map((s) => s.guestWorkspaceId),
    notifiedUserIds: result.notified,
  });

  return { ok: true, message, notifiedUserIds: result.notified };
}

/**
 * Clear this user's unread marker on a ticket.
 *
 * A DELETE of at most one row, so it is safe to call whenever the thread is
 * genuinely on screen. The CALLER owns the "genuinely on screen" part — §10's
 * rule that a hidden tab must never clear something nobody saw.
 */
export async function markThreadRead(
  db: Db,
  args: { workspaceId: string; ticketId: string; userId: string },
): Promise<{ ok: true; cleared: boolean } | { ok: false; reason: "ticket_not_found" }> {
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: { id: true },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  const { count } = await db.ticketThreadUnread.deleteMany({
    where: { ticketId: args.ticketId, userId: args.userId },
  });
  return { ok: true, cleared: count > 0 };
}

/** The message this user's "New replies" divider should sit above, or null. */
export async function getThreadUnreadAnchor(
  db: Db,
  ticketId: string,
  userId: string,
): Promise<string | null> {
  const row = await db.ticketThreadUnread.findFirst({
    where: { ticketId, userId },
    select: { sinceMessageId: true },
  });
  return row?.sinceMessageId ?? null;
}
