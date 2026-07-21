import type { PrismaClient } from "@prisma/client";

/**
 * The candidate POOL of a policy, without the live pick.
 *
 * `resolve.ts` answers "who takes this one, right now" — it needs presence and
 * open-conversation counts. Bulk callers (campaign planning) need something
 * different: the ordered set of members a policy would draw from, with their
 * weights, so an audience can be apportioned across it in one pass.
 *
 * Presence and capacity are DELIBERATELY not applied here. A campaign's replies
 * arrive over hours; who happens to have a socket open at planning time, or how
 * many chats they hold right now, says nothing about who should own a reply
 * that lands tomorrow morning. Membership, the enabled flag and the role filter
 * DO apply — those are durable statements about who belongs in this pool.
 */

type Db = Pick<PrismaClient, "user" | "assignmentPolicy" | "assignmentPolicyMember">;

export interface PoolMember {
  userId: string;
  weight: number;
  /** True when the policy's strategy actually uses `weight`. Callers that
   *  apportion use it to decide between weighted and even splits. */
  weighted: boolean;
}

/**
 * Resolve a policy (by id, or the team default) into its ordered pool.
 * Returns an empty array when the policy is missing, archived, set to `manual`,
 * or has nobody in it — every caller treats that as "assign nobody".
 *
 * `fixed` collapses to a single-member pool, so a campaign pointed at a fixed
 * policy sends everything to that one person, consistent with the live path.
 */
export async function buildPolicyPool(args: {
  db: Db;
  teamId: string;
  policyId?: string | null;
}): Promise<PoolMember[]> {
  const { db, teamId, policyId } = args;

  const policy = policyId
    ? await db.assignmentPolicy.findFirst({
        where: { id: policyId, teamId, archivedAt: null },
      })
    : null;
  const effective =
    policy ??
    (await db.assignmentPolicy.findFirst({
      where: { teamId, archivedAt: null, isDefault: true },
    })) ??
    (await db.assignmentPolicy.findFirst({
      where: { teamId, archivedAt: null },
      orderBy: { createdAt: "asc" },
    }));
  if (!effective || effective.strategy === "manual") return [];

  const [users, overrides] = await Promise.all([
    db.user.findMany({
      where: { teamId, deactivatedAt: null },
      select: { id: true, role: true },
      // Same stable order the live picker uses, so a campaign's first recipient
      // and a live rotation agree on who "first" is.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.assignmentPolicyMember.findMany({
      where: { policyId: effective.id },
      select: { userId: true, weight: true, enabled: true },
    }),
  ]);

  if (effective.strategy === "fixed") {
    const target = effective.fixedUserId;
    if (!target || !users.some((u) => u.id === target)) return [];
    return [{ userId: target, weight: 1, weighted: false }];
  }

  const overrideByUser = new Map(overrides.map((o) => [o.userId, o]));
  const weighted = effective.strategy === "weighted";

  return users
    .filter((u) => {
      const o = overrideByUser.get(u.id);
      if (effective.includeAllMembers) {
        if (o && !o.enabled) return false;
      } else if (!o || !o.enabled) {
        return false;
      }
      if (effective.eligibleRoles.length > 0 && !effective.eligibleRoles.includes(u.role)) {
        return false;
      }
      if (weighted && (o?.weight ?? 1) <= 0) return false;
      return true;
    })
    .map((u) => ({
      userId: u.id,
      weight: overrideByUser.get(u.id)?.weight ?? 1,
      weighted,
    }));
}
