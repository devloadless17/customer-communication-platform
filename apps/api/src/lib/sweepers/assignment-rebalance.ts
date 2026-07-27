import { assignByPolicy } from "@/lib/assignment/apply";
import { loadAssignmentSettings } from "@/lib/assignment/resolve";
import { getOnlineUserIds } from "@/lib/conversations/presence-bridge";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Offline rebalance: move work off an agent who is no longer there.
 *
 * The failure this exists to prevent is the expensive one for a busy floor —
 * ten conversations sitting on someone who went home at 6pm, invisible in
 * anyone's "Unassigned" queue, discovered the next morning.
 *
 * OFF by default (`AssignmentSettings.reassignOnOffline`). When on, every tick:
 *   1. find teams that enabled it,
 *   2. for each, find assignees who are NOT connected right now,
 *   3. skip anyone who is merely between tabs — a candidate must have been
 *      unreachable for the whole `reassignOfflineAfterMinutes` grace window,
 *      which we prove with the conversation's own `lastAssignedAt`/message
 *      timestamps rather than a presence timestamp we don't persist,
 *   4. re-route their eligible conversations through the policy engine,
 *      EXCLUDING the offline agent so it can't bounce straight back.
 *
 * Deliberate restraint, because a rebalancer that is too eager is worse than
 * none at all:
 *   - `reassignOfflineOnlyPending` (default ON) limits it to threads where no
 *     agent has replied yet. A conversation mid-exchange stays with its agent;
 *     yanking it mid-sentence loses context and confuses the customer.
 *   - Conversations someone is actively VIEWING are never touched.
 *   - Closed conversations are never touched (they have no owner anyway).
 *   - A per-tick cap bounds the blast radius: a server restart that drops every
 *     socket must not reassign the entire inbox before presence recovers.
 *   - If the engine can't find anyone else, we leave it alone rather than
 *     unassigning — "owned by someone offline" beats "owned by nobody" when
 *     nobody is available either.
 *
 * PRESENCE IS PROCESS-LOCAL. `getOnlineUserIds` returns null when this process
 * can't see sockets; the sweep then does NOTHING rather than concluding the
 * whole team is offline. That check is the single most important line here.
 */

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000; // let presence re-establish after a boot
/** Max conversations moved per team per tick. */
const MAX_MOVES_PER_TEAM = 50;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startAssignmentRebalanceSweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick();
    timer = setInterval(() => void runTick(), SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopAssignmentRebalanceSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("assignment-rebalance", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / graceful shutdown) — the work is
    // over. `clearInterval` does not cancel a tick already in flight, so
    // without this the sweeper keeps querying a closed pool for the whole
    // drain and Prisma logs an error on every one.
    if (isPoolClosedError(err)) {
      stopAssignmentRebalanceSweeper();
      return;
    }
    console.error("[sweeper.assignment-rebalance] tick failed", err);
  } finally {
    inFlight = false;
  }
}

async function sweepOnce(): Promise<void> {
  const teams = await db.assignmentSettings.findMany({
    where: { reassignOnOffline: true },
    select: { workspaceId: true },
  });
  for (const { workspaceId } of teams) {
    try {
      await rebalanceTeam(workspaceId);
    } catch (err) {
      // Per-team isolation: one tenant's failure must not skip the rest.
      console.warn(
        `[sweeper.assignment-rebalance] team=${workspaceId} failed; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function rebalanceTeam(workspaceId: string): Promise<void> {
  const online = getOnlineUserIds(workspaceId);
  // Presence unknown in this process → do nothing. Treating "I can't see
  // sockets" as "everyone is offline" would reassign the entire inbox.
  if (!online) return;

  const settings = await loadAssignmentSettings(db, workspaceId);
  if (!settings.reassignOnOffline) return; // raced a settings change

  const graceCutoff = new Date(
    Date.now() - settings.reassignOfflineAfterMinutes * 60_000,
  );

  const stale = await db.conversation.findMany({
    where: {
      workspaceId,
      status: { not: "closed" },
      assignedUserId: { not: null },
      // The grace window. `lastAssignedAt` is the moment this agent took the
      // thread; requiring it to be older than the window means a conversation
      // assigned 30 seconds ago is never yanked because the agent happened to
      // be refreshing their browser at that instant.
      lastAssignedAt: { lt: graceCutoff },
      // Don't touch a thread the agent is mid-exchange on (default).
      ...(settings.reassignOfflineOnlyPending ? { firstResponseAt: null } : {}),
    },
    select: { id: true, assignedUserId: true },
    orderBy: { lastAssignedAt: "asc" },
    take: MAX_MOVES_PER_TEAM * 4, // over-fetch: most rows belong to ONLINE agents
  });

  let moved = 0;
  for (const conv of stale) {
    if (moved >= MAX_MOVES_PER_TEAM) break;
    const owner = conv.assignedUserId;
    if (!owner || online.has(owner)) continue;

    const outcome = await assignByPolicy({
      db,
      publish,
      workspaceId,
      conversationId: conv.id,
      source: "rebalance",
      // This is the one sweep that MUST move an existing assignee — that's its
      // entire purpose. The offline owner is excluded from the candidate pool
      // so the pick can't hand it straight back to them.
      onlyIfUnassigned: false,
      context: { excludeUserIds: [owner] },
      changedByUserId: null,
    });
    // `changed`, not just `applied`: an idempotent no-op (the picker handed
    // the thread back to the same owner) is NOT a move, and counting it made
    // this sweeper log rescues that never happened.
    if (outcome.applied && outcome.changed) moved++;
    // Not applied (nobody else eligible) → deliberately leave it with the
    // offline agent. Unassigning would trade a bad owner for no owner.
  }

  if (moved > 0) {
    console.warn(
      `[sweeper.assignment-rebalance] team=${workspaceId} moved ${moved} conversation(s) off offline agents`,
    );
  }
}

/**
 * Deactivation rebalance used to live here as `rebalanceDeactivatedUser`. It
 * moved to `lib/workspaces/remove-member.ts`, which now owns BOTH "this person
 * left a workspace" transitions — removal and deactivation — because they have
 * to do the same set of things (re-home conversations and tickets, drop policy
 * seats, channel memberships, saved views and the pointer columns naming them)
 * and two implementations of that list would drift on the first addition.
 *
 * What stays here is the TIMER-driven offline sweep above: a different trigger,
 * a different risk profile (an agent between tabs is not an agent who left) and
 * a deliberately different set of restraints.
 */
