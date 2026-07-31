import type { PrismaClient } from "@prisma/client";

import { assignByPolicy } from "@/lib/assignment/apply";
import { invalidateAssignmentCache } from "@/lib/assignment/resolve";
import { assignConversation } from "@/lib/conversations/mutations";
import { publish } from "@/lib/events/bus";

/**
 * Everything that has to happen when someone STOPS being a member of a
 * workspace, in one place.
 *
 * The counterpart to `provisionWorkspace`, and it exists for the same reason:
 * "what does this transition mean" must have exactly one definition. Removal
 * used to delete the `WorkspaceMember` row and nothing else, which left a
 * person who can no longer open the workspace still holding:
 *
 *   - open CONVERSATIONS and TICKETS — owned in name by someone who cannot see
 *     them, and absent from the Unassigned queue, so nobody picks them up;
 *   - an `TeamMember` seat — the routing pool filters on membership
 *     so they stop receiving work, but their weights/capacity linger and the
 *     policy editor still lists a stranger;
 *   - `TeamChannelMember` rows, including #general;
 *   - personal saved inbox views;
 *   - pointer columns naming them: the workspace's AI-handoff assignee and
 *     round-robin cursor, and each policy's fixed / fallback / cursor user;
 *   - open MESSAGE FLAGS assigned to them.
 *
 * DEACTIVATION runs this too, across every workspace the person belonged to
 * (before, it only rebalanced the ACTIVE workspace's conversations — so an agent
 * deactivated from workspace A kept their workspace B queue) — but with
 * `clearGrants: false`, because it is reversible. See that option.
 *
 * Best-effort by contract: the membership write is what the caller cares about
 * and has already committed. Nothing here may throw the request. Whatever fails
 * degrades to "still assigned to an inactive/removed user", which every
 * candidate pool already filters out and which stays visible in the inbox.
 */

export interface RemoveMemberOptions {
  /**
   * Move their open conversations/tickets through the assignment policy.
   * `true` for removal (they genuinely cannot reach the workspace any more);
   * for deactivation the caller passes the team's `reassignOnDeactivate`
   * setting so the existing opt-out keeps working.
   */
  rebalance: boolean;
  /**
   * Drop the grants this workspace holds for them — policy seat, channel
   * memberships (incl. #general), personal saved views, and any policy/workspace
   * pointer naming them.
   *
   * TRUE for removal, FALSE for deactivation, and the asymmetry is the point:
   * deactivation is REVERSIBLE (there is a "Re-enable account" action), so
   * shredding someone's channels, saved views and routing weights on the way out
   * would hand them back a hollowed-out account on the way in. Nothing needs
   * clearing for safety either — every candidate pool already filters
   * `deactivatedAt: null`, and `assignConversation` refuses a deactivated
   * target, so a lingering policy seat routes nothing.
   */
  clearGrants: boolean;
  /**
   * When rebalancing finds nobody eligible, UNASSIGN rather than leaving the
   * thread with them.
   *
   * True for removal and false for deactivation, and the difference is real: a
   * deactivated account may be re-enabled tomorrow, so "owned by someone
   * offline" beats "owned by nobody" (the offline sweeper reasons the same
   * way). A removed member is never coming back to this workspace, so a thread
   * left on them is invisible work — the Unassigned queue is strictly better.
   */
  unassignWhenNoCandidate: boolean;
}

/** Bounded so a departing manager with thousands of threads can't stall the
 *  request. The remainder stays visible in the inbox and is picked up by
 *  manual triage or the offline sweeper. */
const MAX_CONVERSATIONS = 500;

/**
 * The Prisma surface this needs. Taken as an ARGUMENT rather than imported as
 * the module singleton (`@/lib/db`) because every caller is a Nest service that
 * already holds an injected client, and because both call sites run DETACHED
 * from the request — a `void`-ed promise that resolves after the handler has
 * returned. Reaching for the singleton there is how you get "lib/db.ts accessed
 * before DbService booted" in a context that outlives, or precedes, the boot.
 */
export type RemoveMemberDb = PrismaClient;

export async function detachMemberFromWorkspace(
  db: RemoveMemberDb,
  workspaceId: string,
  userId: string,
  options: RemoveMemberOptions,
): Promise<{ conversationsMoved: number; ticketsMoved: number }> {
  let conversationsMoved = 0;
  let ticketsMoved = 0;

  if (options.rebalance) {
    conversationsMoved = await rehomeConversations(db, workspaceId, userId, options);
    ticketsMoved = await rehomeTickets(db, workspaceId, userId);
  }

  if (options.clearGrants) await clearGrants(db, workspaceId, userId);
  return { conversationsMoved, ticketsMoved };
}

async function rehomeConversations(
  db: RemoveMemberDb,
  workspaceId: string,
  userId: string,
  options: RemoveMemberOptions,
): Promise<number> {
  const open = await db.conversation.findMany({
    where: { workspaceId, assignedUserId: userId, status: { not: "closed" } },
    select: { id: true },
    orderBy: { lastMessageAt: "desc" },
    take: MAX_CONVERSATIONS,
  });

  let moved = 0;
  for (const conv of open) {
    const outcome = await assignByPolicy({
      db,
      publish,
      workspaceId,
      conversationId: conv.id,
      source: "rebalance",
      // Moving an EXISTING assignee is the whole point here, so this is one of
      // the few callers that legitimately passes false. The departing user is
      // excluded from the pool so the pick can't hand it straight back.
      onlyIfUnassigned: false,
      context: { excludeUserIds: [userId] },
      changedByUserId: null,
    }).catch(() => null);

    // `changed`, not just `applied`: a no-op write (somehow still the same
    // assignee) must fall through to the unassign below rather than being
    // counted as a successful hand-off — otherwise the departing member keeps
    // the thread and `unassignWhenNoCandidate` never fires.
    if (outcome?.applied && outcome.changed) {
      moved++;
      continue;
    }
    if (!options.unassignWhenNoCandidate) continue;

    // Nobody eligible. Write through `assignConversation` — the single
    // assignment write path — so the unassign is indistinguishable downstream
    // from a manual one (audit row, realtime frame, status handling all
    // included) rather than a silent column poke.
    const result = await assignConversation({
      db,
      publish,
      workspaceId,
      conversationId: conv.id,
      targetUserId: null,
      changedByUserId: null,
    }).catch(() => null);
    if (result && "ok" in result && result.ok) moved++;
  }
  return moved;
}

/**
 * Tickets are unassigned rather than re-routed to a person.
 *
 * That is the ticketing model, not a shortcut: a ticket's queue owner is its
 * TEAM (`assignedTeamId`), and handing an unclaimed ticket to a specific
 * individual is precisely the guess the handoff design refuses to make. Leaving
 * it with its team and no assignee puts it back in that team's queue, where
 * whoever picks it up takes it — which is what would have happened if the
 * departing member had never claimed it.
 */
async function rehomeTickets(
  db: RemoveMemberDb,
  workspaceId: string,
  userId: string,
): Promise<number> {
  // Bulk write, but with the domain bookkeeping the boards depend on: the
  // version bump keeps open editors' CAS honest, and the TicketEvent rows keep
  // the audit timeline from silently losing the unassignment. A per-ticket
  // `updateTicket` loop (with its per-ticket realtime event) is deliberately
  // NOT used — member removal is rare and boards refresh on it, and 500
  // individual `ticket.changed` publishes is the storm §9 warns about.
  const ids = await db.ticket.findMany({
    where: {
      workspaceId,
      assignedUserId: userId,
      status: { notIn: ["solved", "closed"] },
    },
    select: { id: true },
  });
  if (ids.length === 0) return 0;
  await db.ticket.updateMany({
    where: { id: { in: ids.map((t) => t.id) }, workspaceId },
    data: { assignedUserId: null, version: { increment: 1 } },
  });
  await db.ticketEvent.createMany({
    data: ids.map((t) => ({
      workspaceId,
      ticketId: t.id,
      kind: "unassigned" as const,
      before: { assignedUserId: userId },
      after: { assignedUserId: null },
    })),
  });
  return ids.length;
}

/** Drop every grant + pointer this workspace holds for the user. */
async function clearGrants(
  db: RemoveMemberDb,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await Promise.all([
    // Routing seat. `includeAllMembers` policies already stop considering them
    // (the pool filters on WorkspaceMember), but the row would keep showing a
    // stranger in the policy editor with weights and a capacity cap.
    db.teamMember
      .deleteMany({ where: { workspaceId, userId } })
      .catch(() => undefined),

    // Team-chat rooms, #general included. Membership is what gates reading a
    // channel's history, so this is the part that actually closes the door.
    db.teamChannelMember
      .deleteMany({ where: { userId, channel: { workspaceId } } })
      .catch(() => undefined),

    // Their PERSONAL saved views here. Shared views survive deliberately —
    // `InboxView.createdById` is SetNull so a view the whole workspace uses
    // outlives its author.
    db.inboxView
      .deleteMany({ where: { workspaceId, visibility: "personal", createdById: userId } })
      .catch(() => undefined),

    // Follow-ups they owned. The flag itself is triage history and stays; only
    // the ownership is cleared, so it resurfaces as unowned in the flag queue
    // instead of sitting on someone who will never resolve it.
    db.messageFlag
      .updateMany({
        where: { workspaceId, assignedToId: userId, status: "open" },
        data: { assignedToId: null },
      })
      .catch(() => undefined),

    // Workspace-level pointers. Nulling the AI-handoff assignee degrades that
    // setting to "leave unassigned" — the same behaviour the column's SetNull
    // FK gives on a full user delete. The round-robin cursor is just a rotation
    // position; clearing it restarts the rotation, which is harmless.
    db.workspace
      .updateMany({
        where: { id: workspaceId, aiHandoffAssigneeId: userId },
        data: { aiHandoffAssigneeId: null },
      })
      .catch(() => undefined),
    db.workspace
      .updateMany({
        where: { id: workspaceId, aiRoundRobinCursorUserId: userId },
        data: { aiRoundRobinCursorUserId: null },
      })
      .catch(() => undefined),
  ]);

  // Policy pointers are plain ids with NO foreign key (deliberately — a deleted
  // user must degrade a policy, never cascade into it), so nothing clears them
  // automatically. A `fixed` policy still naming them would route every matching
  // conversation to a person who cannot open the workspace, and the picker would
  // find no candidate — traffic silently stops. Three separate updateManys
  // because each column needs its own predicate.
  await Promise.all([
    db.team
      .updateMany({ where: { workspaceId, fixedUserId: userId }, data: { fixedUserId: null } })
      .catch(() => undefined),
    db.team
      .updateMany({
        where: { workspaceId, fallbackUserId: userId },
        data: { fallbackUserId: null },
      })
      .catch(() => undefined),
    db.team
      .updateMany({ where: { workspaceId, cursorUserId: userId }, data: { cursorUserId: null } })
      .catch(() => undefined),
  ]);

  // Policies + their member rows are cached in-process for routing. Without
  // this the picker keeps handing work to the removed member (or to a now-null
  // `fixedUserId`) until the cache expires — the writes above would be real in
  // the database and invisible to the one thing that reads them.
  invalidateAssignmentCache(workspaceId);
}
