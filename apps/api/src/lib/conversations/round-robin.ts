import type { PrismaClient } from "@prisma/client";

/**
 * Round-robin assignee picker — the single source of rotation shared by every
 * consumer that needs "give me the next agent": the customer-handoff policy
 * (assign_fixed's sibling `round_robin` mode), the workflow `assign_to`
 * round_robin step, and any future API caller. Keep callers thin: this returns
 * a userId (or null); the caller runs the real `assignConversation` mutation.
 *
 * Framework-agnostic (lib/): `db` is injected, so NestJS passes `this.db` and a
 * workflow step passes the lib `db` Proxy — both resolve to the same pool.
 *
 * Pool: active (non-deactivated) members. Prefers those who are "available"
 * (availabilityStatus null is treated as available — it's the implicit UI
 * default); falls back to ALL active members when nobody is marked available,
 * so a handoff never silently lands nowhere just because everyone is offline.
 *
 * Rotation: members ordered stably (createdAt, then id). The cursor
 * (`Team.aiRoundRobinCursorUserId`) holds the LAST user picked; we return the
 * next one after it, wrapping around. The chosen id is persisted back as the
 * new cursor in the same call.
 *
 * Concurrency: the read-modify-write of the cursor is NOT serialized. At
 * single-VPS pilot scale a rare double-pick (two near-simultaneous handoffs
 * landing on the same agent) is harmless — do NOT add locking. If the cursor
 * user has since left the pool, rotation restarts at the head; also acceptable.
 *
 * Returns the picked userId, or `null` when there are no eligible members
 * (caller leaves the conversation unassigned).
 */
export async function pickRoundRobinAssignee(args: {
  db: Pick<PrismaClient, "user" | "team">;
  teamId: string;
}): Promise<string | null> {
  const { db, teamId } = args;

  const members = await db.user.findMany({
    where: { teamId, deactivatedAt: null },
    select: { id: true, availabilityStatus: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (members.length === 0) return null;

  const isAvailable = (s: string | null) => s == null || s === "available";
  const available = members.filter((m) => isAvailable(m.availabilityStatus));
  // Preserve the stable order; just narrow to the preferred subset (or all).
  const pool = (available.length > 0 ? available : members).map((m) => m.id);

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { aiRoundRobinCursorUserId: true },
  });
  const cursor = team?.aiRoundRobinCursorUserId ?? null;

  const idx = cursor ? pool.indexOf(cursor) : -1;
  // idx === -1 (no cursor, or cursor left the pool) → start at the head.
  const picked = pool[idx === -1 ? 0 : (idx + 1) % pool.length]!;

  await db.team.update({
    where: { id: teamId },
    data: { aiRoundRobinCursorUserId: picked },
  });

  return picked;
}
