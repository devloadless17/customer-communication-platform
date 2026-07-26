/**
 * PLATFORM-SPEC helpers only.
 *
 * `superadminTeam()` resolves the maintainer's REAL seeded workspace. It moved
 * here out of `db.ts` (2026-07-26) so the import graph itself enforces the
 * isolation rule: customer-app specs key their fixtures by `appAdmin()`
 * (the dedicated `e2e-app-ws` workspace) and must never seed into — or wipe —
 * the real superadmin workspace. Import this file from `tests/e2e/platform/`
 * specs exclusively, and only for READ-ONLY assertions; platform-spec
 * mutations must target `e2e-`-prefixed orgs.
 */

import { db, ensureDefaultChannel } from "./db";

/**
 * The single superadmin row created by `prisma/seeds/seed-superadmin.ts`.
 * Resolved once at suite start so we don't keep pinging the user table.
 */
export async function superadminTeam(): Promise<{ workspaceId: string; userId: string }> {
  const user = await db().user.findFirst({
    where: { isSuperAdmin: true },
    select: {
      id: true,
      // Users are org-scoped; their workspace comes from the membership.
      workspaceMemberships: {
        select: { workspaceId: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  if (!user) {
    throw new Error("no superAdmin row — run pnpm db:seed:superadmin first");
  }
  const wsId = user.workspaceMemberships[0]?.workspaceId;
  if (!wsId) throw new Error("seeded user has no workspace membership");
  await ensureDefaultChannel(wsId, user.id);
  return { workspaceId: wsId, userId: user.id };
}
