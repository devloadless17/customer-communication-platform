import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { ContactStage, TagColor } from "@ccp/shared/types";

export async function listContactStages(teamId: string): Promise<ContactStage[]> {
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
}

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
 *
 * Cached by teamId for 5 minutes — this is called on every inbound message
 * ingest, which previously bought a ~2-5ms findFirst per event. The default
 * stage id changes ~never (only when an admin promotes a different stage),
 * so a 5-min TTL trades a tiny invalidation lag for amortized zero-cost
 * lookups on the webhook hot path. Bust explicitly from the stages admin
 * service when the default flips.
 */
const DEFAULT_STAGE_TTL_MS = 5 * 60 * 1000;
const defaultStageCache = new Map<string, { id: string; exp: number }>();

export function invalidateDefaultStageCache(teamId: string): void {
  defaultStageCache.delete(teamId);
}

export async function ensureDefaultStage(teamId: string): Promise<string> {
  const cached = defaultStageCache.get(teamId);
  if (cached && cached.exp > Date.now()) return cached.id;

  const existingDefault = await db.contactStage.findFirst({
    where: { teamId, isDefault: true },
    select: { id: true },
  });
  if (existingDefault) {
    defaultStageCache.set(teamId, {
      id: existingDefault.id,
      exp: Date.now() + DEFAULT_STAGE_TTL_MS,
    });
    return existingDefault.id;
  }

  // No default — promote the lowest-position stage if any exist, otherwise
  // create one from scratch. Done in a transaction so two concurrent calls
  // can't both create a duplicate.
  let resolvedId: string;
  try {
    resolvedId = await db.$transaction(async (tx) => {
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
  } catch (err) {
    // Concurrent first-contact race: for a brand-new team with zero stages, two
    // ensureDefaultStage calls (e.g. two inbound webhooks landing together) can
    // both pass the in-tx re-read and both attempt the create; the partial
    // unique index (one default per team — or the name unique) rejects the
    // loser with P2002, aborting its tx. Re-read the winner's now-existing
    // default instead of 500-ing the ingest/create path that called us.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.contactStage.findFirst({
        where: { teamId, isDefault: true },
        select: { id: true },
      });
      if (!winner) throw err; // no default despite P2002 — unexpected, surface it
      resolvedId = winner.id;
    } else {
      throw err;
    }
  }
  defaultStageCache.set(teamId, {
    id: resolvedId,
    exp: Date.now() + DEFAULT_STAGE_TTL_MS,
  });
  return resolvedId;
}
