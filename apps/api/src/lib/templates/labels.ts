// Note: no `server-only` import — loaded by the NestJS api process (see the
// sibling catalog-sync.ts header).

import type { PrismaClient } from "@prisma/client";

/**
 * Template LABELS — the workspace's own organizational taxonomy over its
 * WhatsApp template catalog ("promo", "ramadan-2026", "support").
 *
 * Labels are OURS, like `variableBindings`: Meta has no such concept, nothing
 * about them goes over the Graph wire, and the catalog sync's reconcile writes
 * explicit fields only — so a re-sync leaves them untouched (pinned by
 * test/template-labels.spec.ts). Length/count bounds live in the Zod schemas
 * at both edges (internal PATCH + `/v1`); this module owns the parts Zod
 * can't express: case-insensitive identity and case-insensitive lookup.
 */

/**
 * Dedupe case-insensitively, PRESERVING the first-seen casing.
 *
 * "Promo" and "promo" are the same label to the operator, so both filtering
 * and storage treat lowercase as the identity — but the casing they typed
 * first is what the chips render, so it is what survives.
 */
export function normalizeTemplateLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Ids of the workspace's templates carrying `label`, matched case-insensitively.
 *
 * Raw SQL because Prisma's array filters (`has`/`hasSome`) are exact-case and
 * cannot express `lower()` over an array element. Bounded: Meta caps a WABA at
 * 6,000 templates, and only ids come back — callers AND the list into their own
 * workspaceId-scoped `findMany`, which keeps keyset pagination intact on `/v1`.
 */
export async function templateIdsWithLabel(
  db: PrismaClient,
  workspaceId: string,
  label: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "MessageTemplate"
    WHERE "workspaceId" = ${workspaceId}
      AND EXISTS (
        SELECT 1 FROM unnest("labels") AS l WHERE lower(l) = lower(${label})
      )`;
  return rows.map((r) => r.id);
}
