import type { PrismaClient } from "@prisma/client";

import { getOnlineUserIds } from "./presence-bridge";

/**
 * Round-robin assignee picker — the single source of rotation shared by the
 * AI customer-handoff policy and the workflow `assign_to` round_robin step.
 * Returns a userId (or null); the caller runs the real `assignConversation`.
 *
 * Selection (best teamwork: route to someone who's actually here, and balance):
 *   1. Eligibility tier (first non-empty wins):
 *        a. ONLINE + available — connected via socket AND availabilityStatus
 *           "available"/unset. Mirrors the inbox "Available" list. This is the
 *           fix for the prod bug where a status-"available" teammate who'd
 *           closed their browser got work over a truly-online one.
 *        b. available (status only) — fallback when nobody eligible is
 *           connected (e.g. presence lost on a server restart, or a standalone
 *           worker that can't see sockets).
 *        c. any active member — last resort so a handoff never lands nowhere.
 *   2. Least-busy within the tier — fewest OPEN (non-closed) conversations
 *      currently assigned to them ("Mine"), so load self-balances.
 *   3. Fair rotation as the tie-break — among equally-loaded candidates, take
 *      the next one after the stored cursor (so a fresh day with everyone at 0
 *      still spreads evenly instead of always hitting the first name).
 *
 * Framework-agnostic (lib/): `db` is injected; live presence comes via the
 * presence-bridge the api wires on boot.
 *
 * Concurrency: the cursor read-modify-write isn't serialized; at single-VPS
 * pilot scale a rare double-pick is harmless — don't add locking.
 */

const isStatusAvailable = (s: string | null) => s == null || s === "available";

/**
 * Pure selection — separated from IO so it's unit-testable. `members` must be
 * in a stable order (createdAt, then id). Returns the chosen id or null.
 */
export function chooseRoundRobin(args: {
  members: { id: string; availabilityStatus: string | null }[];
  /** Connected userIds, or null when presence is unknown (→ skip the online tier). */
  onlineUserIds: Set<string> | null;
  /** userId → count of open assigned conversations. Missing = 0. */
  openCounts: Map<string, number>;
  /** Last user picked (rotation tie-break). */
  cursor: string | null;
}): string | null {
  const { members, onlineUserIds, openCounts, cursor } = args;

  const statusAvailable = members.filter((m) => isStatusAvailable(m.availabilityStatus));
  const onlineAvailable = onlineUserIds
    ? statusAvailable.filter((m) => onlineUserIds.has(m.id))
    : [];

  const tier =
    onlineAvailable.length > 0
      ? onlineAvailable
      : statusAvailable.length > 0
        ? statusAvailable
        : members;
  const pool = tier.map((m) => m.id);
  if (pool.length === 0) return null;

  // Least-busy first.
  const countOf = (id: string) => openCounts.get(id) ?? 0;
  const minCount = Math.min(...pool.map(countOf));
  const leastBusy = pool.filter((id) => countOf(id) === minCount);

  // Rotate among the equally-loaded (pool order is the stable member order).
  const idx = cursor ? leastBusy.indexOf(cursor) : -1;
  return leastBusy[idx === -1 ? 0 : (idx + 1) % leastBusy.length]!;
}

export async function pickRoundRobinAssignee(args: {
  db: Pick<PrismaClient, "user" | "team" | "conversation">;
  teamId: string;
}): Promise<string | null> {
  const { db, teamId } = args;

  const members = await db.user.findMany({
    where: { teamId, deactivatedAt: null },
    select: { id: true, availabilityStatus: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (members.length === 0) return null;

  // Open (non-closed) conversations currently assigned, per user — the "Mine"
  // load each agent is carrying right now.
  const grouped = await db.conversation.groupBy({
    by: ["assignedUserId"],
    where: { teamId, assignedUserId: { not: null }, status: { not: "closed" } },
    _count: { _all: true },
  });
  const openCounts = new Map<string, number>();
  for (const g of grouped) {
    if (g.assignedUserId) openCounts.set(g.assignedUserId, g._count._all);
  }

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { aiRoundRobinCursorUserId: true },
  });

  const picked = chooseRoundRobin({
    members,
    onlineUserIds: getOnlineUserIds(teamId),
    openCounts,
    cursor: team?.aiRoundRobinCursorUserId ?? null,
  });
  if (!picked) return null;

  await db.team.update({
    where: { id: teamId },
    data: { aiRoundRobinCursorUserId: picked },
  });
  return picked;
}
