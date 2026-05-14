import "server-only";

import { unstable_cache } from "next/cache";

import { db } from "@/lib/db";
import type { ContactStage, TagColor } from "@/lib/types";

// Customer-lifecycle stages. The catalog is per-team and changes rarely
// (admin edits it occasionally), so the same caching shape as Tags applies.
// `revalidateTag("contact-stages")` is fired from the management routes so
// edits propagate without waiting on the 60s clock.

export const listContactStages = unstable_cache(
  async (teamId: string): Promise<ContactStage[]> => {
    const rows = await db.contactStage.findMany({
      where: { teamId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      name: r.name,
      color: r.color as TagColor,
      position: r.position,
      isDefault: r.isDefault,
    }));
  },
  ["listContactStages"],
  { revalidate: 60, tags: ["contact-stages"] },
);

/**
 * Resolve the team's default stage id, creating one on demand. The migration
 * seeds one default per existing team; this helper covers teams created
 * AFTER the migration (registration flow) and the rare case where an admin
 * deleted every stage. Returns the id we should assign new contacts to —
 * always a real ContactStage row owned by this team.
 *
 * Why a side-effecting "ensure" instead of just relying on the migration's
 * seed: the registration route (app/register/actions.ts) creates a Team
 * without going through the migration, so a brand-new tenant would have
 * zero stages. Better to lazily create than to scatter `db.contactStage`
 * writes through every team-creation site.
 */
export async function ensureDefaultStage(teamId: string): Promise<string> {
  const existingDefault = await db.contactStage.findFirst({
    where: { teamId, isDefault: true },
    select: { id: true },
  });
  if (existingDefault) return existingDefault.id;

  // No default — promote the lowest-position stage if any exist, otherwise
  // create one from scratch. Done in a transaction so two concurrent calls
  // can't both create a duplicate.
  return db.$transaction(async (tx) => {
    const reread = await tx.contactStage.findFirst({
      where: { teamId, isDefault: true },
      select: { id: true },
    });
    if (reread) return reread.id;

    const anyStage = await tx.contactStage.findFirst({
      where: { teamId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (anyStage) {
      await tx.contactStage.update({
        where: { id: anyStage.id },
        data: { isDefault: true },
      });
      return anyStage.id;
    }

    const created = await tx.contactStage.create({
      data: {
        teamId,
        name: "Stage 1",
        color: "slate",
        position: 0,
        isDefault: true,
      },
      select: { id: true },
    });
    return created.id;
  });
}
