import type { PrismaClient } from "@prisma/client";

import type { AppNotification } from "@ccp/shared/notifications/types";
import { publish } from "@/lib/events/bus";

/**
 * The notification centre — one thing that happened, for ONE person.
 *
 * Before this, the app's only signals were rail badges and toasts. Both are
 * ambient, both are per-surface, and neither survives you being away from the
 * tab: a member assigned a ticket found out by going to look. This is the place
 * a signal lands and WAITS.
 *
 * Two rules shape everything here:
 *
 *  1. **Never notify the actor.** You do not need telling about the thing you
 *     just did, and self-notification is what makes a bell something people
 *     learn to ignore.
 *  2. **Append-only, grouped at READ time.** One row per event, no coalescing
 *     upsert. Coalescing at write needs a read-then-write on "the unread row
 *     for this (user, ticket, actor)" — a race that wants a partial unique
 *     index, and raw partial indexes are invisible to `migrate diff` and to
 *     `check:prisma-fields` (§18). The bell groups by ticket when it renders:
 *     same result on screen, no race, and the history survives being read.
 */

type Db = Pick<
  PrismaClient,
  "notification" | "ticket" | "ticketShare" | "user" | "workspaceMember"
>;

/** Newest-first page size for the bell. A centre, not an archive. */
export const NOTIFICATION_PAGE = 30;

/**
 * What happened. A string on the wire and in the column (not an enum) so adding
 * one is a code-only change and an unknown value degrades to a generic line
 * instead of failing the whole bell.
 */
export const NOTIFICATION_KINDS = [
  /** You were given the ticket. */
  "ticket_assigned",
  /** Someone wrote in the thread of a ticket you are part of. */
  "ticket_replied",
  /** Something about a ticket you RAISED changed. */
  "ticket_changed",
  /** A file landed on a ticket you raised or own. */
  "ticket_file_added",
  /** Another department was brought in — or brought you in. */
  "ticket_escalated",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const SELECT = {
  id: true,
  kind: true,
  ticketId: true,
  ticketNumber: true,
  ticketSubject: true,
  actorUserId: true,
  actorName: true,
  summary: true,
  readAt: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  kind: string;
  ticketId: string | null;
  ticketNumber: number | null;
  ticketSubject: string | null;
  actorUserId: string | null;
  actorName: string | null;
  summary: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export function mapNotification(n: Row): AppNotification {
  return {
    id: n.id,
    kind: n.kind,
    ticketId: n.ticketId,
    ticketNumber: n.ticketNumber,
    ticketSubject: n.ticketSubject,
    actorUserId: n.actorUserId,
    actorName: n.actorName,
    summary: n.summary,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

/**
 * One person, and the workspace THEY will read this in.
 *
 * Not "the workspace it happened in": the bell reads
 * `{ userId, workspaceId: session.workspaceId }` and the socket room is
 * `user:<ws>:<uid>`, so a row stamped with the ACTOR's workspace is invisible
 * to a recipient sitting in their own — permanently, when they are not a member
 * of the actor's workspace at all. That is precisely the escalation audience
 * (§18: the raiser and each side's assignee), i.e. the case the bell exists
 * for. Pairing the person with their own workspace at the point the audience is
 * resolved is what makes that unforgettable — the share row already knows it.
 */
export interface NotificationRecipient {
  userId: string;
  workspaceId: string;
}

export interface NotifyArgs {
  kind: NotificationKind;
  /** Everyone who should hear about it. The actor is filtered out here, once. */
  recipients: NotificationRecipient[];
  actorUserId?: string | null;
  actorName?: string | null;
  ticketId?: string;
  ticketNumber?: number;
  ticketSubject?: string | null;
  /** One human line: "changed the status to Solved". */
  summary?: string | null;
}

/**
 * Raise a notification for everyone in `userIds` except the actor.
 *
 * Returns the ids actually notified, so the caller can put them on the realtime
 * frame — a client uses that to tell "something happened somewhere" from
 * "something happened to ME", exactly as the ticket thread's frame does.
 *
 * Never throws into its caller. A notification is a courtesy attached to a real
 * write (an assignment, a reply); failing the write because the courtesy failed
 * would be the wrong trade every time.
 */
export async function notifyUsers(db: Db, args: NotifyArgs): Promise<string[]> {
  // One row per person. First mapping wins if a person reaches the audience
  // twice (someone who is a member of both departments still has one bell, and
  // the owner side is resolved first).
  const byUser = new Map<string, string>();
  for (const r of args.recipients) {
    if (!r.userId || !r.workspaceId) continue;
    if (r.userId === args.actorUserId) continue;
    if (!byUser.has(r.userId)) byUser.set(r.userId, r.workspaceId);
  }
  if (byUser.size === 0) return [];

  try {
    await db.notification.createMany({
      data: [...byUser].map(([userId, workspaceId]) => ({
        workspaceId,
        userId,
        kind: args.kind,
        actorUserId: args.actorUserId ?? null,
        actorName: args.actorName ?? null,
        ticketId: args.ticketId ?? null,
        ticketNumber: args.ticketNumber ?? null,
        ticketSubject: args.ticketSubject ?? null,
        summary: args.summary ?? null,
      })),
    });
  } catch (err) {
    console.error("[notifications] failed to write", err);
    return [];
  }

  // One frame per workspace, because the per-user room is workspace-keyed
  // (`user:<ws>:<uid>`) — a single frame on the actor's workspace would reach
  // nobody standing in theirs.
  //
  // On the BUS, not through the outbox: the only subscriber is realtime fanout,
  // and a frame lost to a crash is recoverable — the bell is server-authoritative
  // on mount and re-seeded on reconnect. Same call the ticket thread makes.
  const byWorkspace = new Map<string, string[]>();
  for (const [userId, workspaceId] of byUser) {
    const bucket = byWorkspace.get(workspaceId);
    if (bucket) bucket.push(userId);
    else byWorkspace.set(workspaceId, [userId]);
  }
  for (const [workspaceId, userIds] of byWorkspace) {
    await publish({
      type: "notification.created",
      workspaceId,
      userIds,
      kind: args.kind,
      ...(args.ticketId ? { ticketId: args.ticketId } : {}),
      ...(args.ticketNumber !== undefined ? { ticketNumber: args.ticketNumber } : {}),
      ...(args.actorName ? { actorName: args.actorName } : {}),
      ...(args.summary ? { summary: args.summary } : {}),
    });
  }

  return [...byUser.keys()];
}

/**
 * WHO to tell about something on a ticket.
 *
 * The person who RAISED it is always in the set — that is the maintainer's
 * requirement in one line: "any ticket change must notify who raised the ticket
 * so he knows and can act accordingly". They asked the question; they are the
 * one waiting on the answer, and they are frequently neither the assignee nor
 * whoever is currently typing.
 *
 * Around them: whoever owns each side of the work. Deliberately NOT every
 * member of a participating workspace — that turns one person's edit into a
 * department-wide alert, which is how a bell becomes noise.
 */
export async function ticketAudience(
  db: Db,
  ticketId: string,
): Promise<{
  recipients: NotificationRecipient[];
  number: number;
  subject: string | null;
} | null> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      number: true,
      subject: true,
      workspaceId: true,
      createdById: true,
      assignedUserId: true,
      shares: {
        select: { guestWorkspaceId: true, assignedUserId: true, createdById: true },
      },
    },
  });
  if (!ticket) return null;

  // Each side's people are paired with THEIR OWN workspace: the owner's with
  // the ticket's, each guest's with that share's.
  //
  // The one person that does NOT place by column is a share's `createdById` —
  // the escalator. Escalation is access-gated, not owner-only, so a guest can
  // escalate onward, and neither `ownerWorkspaceId` nor `guestWorkspaceId`
  // names the workspace they were standing in. Membership answers it, which is
  // also the question that actually matters ("where will they read this?"), so
  // it is the authority for everyone here.
  const preferred: Array<{ userId: string; workspaceId: string }> = [];
  if (ticket.createdById)
    preferred.push({ userId: ticket.createdById, workspaceId: ticket.workspaceId });
  if (ticket.assignedUserId)
    preferred.push({ userId: ticket.assignedUserId, workspaceId: ticket.workspaceId });
  for (const s of ticket.shares) {
    if (s.assignedUserId)
      preferred.push({ userId: s.assignedUserId, workspaceId: s.guestWorkspaceId });
    // The ESCALATOR is normally standing in the workspace the ticket came FROM,
    // not the one it was handed to, so the owner's is the better first guess —
    // membership below corrects it when they are genuinely a guest-side person.
    // (A guest may escalate onward, which is why this is a preference and not a
    // rule; `TicketShare` records no acting workspace of its own.)
    if (s.createdById)
      preferred.push(
        { userId: s.createdById, workspaceId: ticket.workspaceId },
        { userId: s.createdById, workspaceId: s.guestWorkspaceId },
      );
  }
  if (preferred.length === 0)
    return { recipients: [], number: ticket.number, subject: ticket.subject };

  const participating = [ticket.workspaceId, ...ticket.shares.map((s) => s.guestWorkspaceId)];
  const memberships = await db.workspaceMember.findMany({
    where: {
      userId: { in: [...new Set(preferred.map((p) => p.userId))] },
      workspaceId: { in: [...new Set(participating)] },
    },
    select: { userId: true, workspaceId: true },
  });
  const memberOf = new Map<string, Set<string>>();
  for (const m of memberships) {
    const set = memberOf.get(m.userId);
    if (set) set.add(m.workspaceId);
    else memberOf.set(m.userId, new Set([m.workspaceId]));
  }

  const recipients: NotificationRecipient[] = [];
  const placed = new Set<string>();
  for (const p of preferred) {
    if (placed.has(p.userId)) continue;
    const mine = memberOf.get(p.userId);
    // No membership row in ANY participating workspace still means a real
    // audience member: an org owner/admin and a superAdmin reach a workspace
    // through the DB-verified beyond-membership escape in
    // `resolveActiveWorkspaceId`, so they can raise a ticket somewhere they
    // hold no `WorkspaceMember` row. Dropping them would take the RAISER — the
    // one §18 puts in the audience for every change — out of their own bell.
    // The column-derived workspace is the honest answer there; the bell query
    // is (userId, workspaceId)-scoped either way, so nothing widens.
    if (!mine || mine.size === 0) {
      recipients.push({ userId: p.userId, workspaceId: p.workspaceId });
      placed.add(p.userId);
      continue;
    }
    const workspaceId = mine.has(p.workspaceId)
      ? p.workspaceId
      : // Still on the ticket, just from the other side — the escalator case.
        participating.find((w) => mine.has(w))!;
    recipients.push({ userId: p.userId, workspaceId });
    placed.add(p.userId);
  }
  return { recipients, number: ticket.number, subject: ticket.subject };
}

/** This person's bell, newest first. Scoped to (user, workspace). */
export async function listNotifications(
  db: Db,
  workspaceId: string,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<AppNotification[]> {
  const rows = await db.notification.findMany({
    where: { userId, workspaceId, ...(opts.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? NOTIFICATION_PAGE, 100),
    select: SELECT,
  });
  return rows.map(mapNotification);
}

/** The bell's badge. */
export async function countUnreadNotifications(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<number> {
  return db.notification.count({ where: { userId, workspaceId, readAt: null } });
}

/**
 * Mark this person's notifications read — all of them, or the ones named.
 *
 * Scoped to the caller's own rows by userId, so an id belonging to someone else
 * simply matches nothing. Returns how many changed, which lets the client skip
 * a badge refetch when nothing did.
 */
export async function markNotificationsRead(
  db: Db,
  workspaceId: string,
  userId: string,
  ids?: string[],
): Promise<number> {
  const { count } = await db.notification.updateMany({
    where: {
      userId,
      workspaceId,
      readAt: null,
      ...(ids && ids.length > 0 ? { id: { in: ids.slice(0, 200) } } : {}),
    },
    data: { readAt: new Date() },
  });
  return count;
}
