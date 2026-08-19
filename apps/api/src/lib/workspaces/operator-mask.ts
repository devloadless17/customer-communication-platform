import type { PrismaClient } from "@prisma/client";

import { OPERATOR_DISPLAY_NAME } from "@ccp/shared/auth/active-workspace";

export { OPERATOR_DISPLAY_NAME };

type Db = Pick<PrismaClient, "user">;

/**
 * Which of these actor userIds are the PLATFORM OPERATOR relative to the given
 * workspace(s)?
 *
 * Same predicate as `isOperatorAccess` (@ccp/shared/auth/active-workspace):
 * a `User.isSuperAdmin` acting where they hold no `WorkspaceMember` row. In
 * their own anchor workspace the operator IS a member and behaves like any
 * other admin — their name is real there — so membership is checked against
 * the workspace(s) the rows being rendered belong to (for a shared ticket,
 * every participating workspace).
 *
 * WHY THIS EXISTS. The "Support" mask used to live only in the web's
 * member-map fallback (message-thread/utils.ts): an actor id that resolves to
 * no roster member renders as "Support". That holds for every surface the
 * client resolves locally — but several DTOs resolve the actor name SERVER-side
 * by joining the User row (conversation activity pills, ticket
 * events/thread/attachments, and the append-only Notification rows), where the
 * operator's row resolves normally and the real name reached the tenant's UI.
 * This helper is the server-side half; call it at DTO-mapping / write time.
 *
 * Cost: one indexed query filtered to `isSuperAdmin: true` — in the common
 * case (no operator among the actors) the id set short-circuits to empty
 * before any query, and otherwise the result set is at most "the operator".
 */
export async function operatorActorIds(
  db: Db,
  userIds: Iterable<string | null | undefined>,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set([...userIds].filter((id): id is string => !!id))];
  if (ids.length === 0) return new Set();
  const rows = await db.user.findMany({
    where: { id: { in: ids }, isSuperAdmin: true },
    select: {
      id: true,
      workspaceMemberships: {
        where: { workspaceId: { in: [...workspaceIds] } },
        select: { workspaceId: true },
        take: 1,
      },
    },
  });
  return new Set(rows.filter((r) => r.workspaceMemberships.length === 0).map((r) => r.id));
}

/**
 * Drop the PLATFORM OPERATOR from a workforce roster.
 *
 * Activity-derived agent aggregates create a row for any userId that appears in
 * the numbers — deliberately, so a departed member keeps their history as
 * "Former member". The operator lands there too the moment they reply or close
 * while helping a client, and they must never be counted as staff (CLAUDE.md
 * §18: present to administer, workforce in no tenant). Real former members are
 * untouched — only a superAdmin holding no membership here is removed.
 *
 * One definition for both report tabs: the overview's Agents panel and
 * /reports/team disagreeing about who the team IS is exactly the drift this
 * prevents.
 */
export async function withoutOperatorRows<T extends { userId: string }>(
  db: Db,
  workspaceId: string,
  rows: T[],
): Promise<T[]> {
  const operators = await operatorActorIds(
    db,
    rows.map((r) => r.userId),
    [workspaceId],
  );
  return operators.size === 0 ? rows : rows.filter((r) => !operators.has(r.userId));
}

/**
 * Resolve ONE actor's display name for persistence (the Notification write
 * sites), masking the operator. Returns null when the user no longer exists —
 * same contract as the bare `user.findUnique` lookups this replaces.
 */
export async function resolveActorDisplayName(
  db: Db,
  userId: string,
  workspaceIds: readonly string[],
): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      isSuperAdmin: true,
      workspaceMemberships: {
        where: { workspaceId: { in: [...workspaceIds] } },
        select: { workspaceId: true },
        take: 1,
      },
    },
  });
  if (!user) return null;
  if (user.isSuperAdmin && user.workspaceMemberships.length === 0) {
    return OPERATOR_DISPLAY_NAME;
  }
  return user.name;
}
