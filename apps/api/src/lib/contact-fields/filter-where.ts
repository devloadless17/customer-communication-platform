import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { ContactFieldFilter } from "@ccp/shared/types";

/**
 * Select-field predicates over Contact.customFields — the ONE place a
 * `ContactFieldFilter` becomes a Prisma fragment. Shared by inbox saved views
 * (lib/inbox-views/where.ts composes it into the view document's clause list)
 * and broadcast audiences (lib/queries/audience-groups.ts + broadcasts).
 *
 * The stored value for a select field is the OPTION ID (see
 * lib/contact-fields/select-values.ts), so `equals` on the JSON path is exact
 * and rename-stable. A stale option id or a deleted field key simply matches
 * nothing at SQL level — callers layer their own policy on top (views DROP
 * dangling ids at read so a filter visibly widens; broadcast audiences keep
 * match-nothing, because a silently widened audience is a billed, irreversible
 * send to people the operator excluded).
 */

/**
 * One independent `Prisma.ContactWhereInput` clause PER filter entry —
 * optionIds OR'd within an entry, entries meant to be ANDed by the caller.
 * Returned as an ARRAY of clauses (same contract as inboxViewWhereClauses,
 * and for the same reason: merging by spread lets a later object key clobber
 * an earlier predicate).
 */
export function contactFieldFilterClauses(
  filters: ContactFieldFilter[],
): Prisma.ContactWhereInput[] {
  return filters
    .filter((f) => f.optionIds.length > 0)
    .map((f) => ({
      OR: f.optionIds.map((id) => ({
        customFields: { path: [f.key], equals: id },
      })),
    }));
}

/**
 * The write-side twin of `parseStoredFieldFilters`: a `ContactFieldFilter[]`
 * as a Prisma Json input value. Rebuilt as fresh literals so the anonymous
 * object type satisfies `InputJsonValue` structurally — no assertion needed
 * (the interface itself lacks the implicit index signature Json inputs want).
 */
export function fieldFiltersToJson(
  filters: ContactFieldFilter[],
): Prisma.InputJsonValue {
  return filters.map((f) => ({ key: f.key, optionIds: [...f.optionIds] }));
}

/**
 * Read a stored `fieldFilters` Json column back into the typed shape.
 * Defensive: the column is app-written (validated + owned at write time), but
 * a Json column has no DB-level shape guarantee, so malformed entries are
 * dropped rather than crashing a count or a send.
 */
export function parseStoredFieldFilters(json: unknown): ContactFieldFilter[] {
  if (!Array.isArray(json)) return [];
  const out: ContactFieldFilter[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = (entry as { key?: unknown }).key;
    const optionIds = (entry as { optionIds?: unknown }).optionIds;
    if (typeof key !== "string" || !key) continue;
    if (!Array.isArray(optionIds)) continue;
    const ids = optionIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) continue;
    out.push({ key, optionIds: ids });
  }
  return out;
}

/**
 * Cross-team id-stuffing defense for stored/audited filters (mirrors
 * `ownedTagIds` in audience-groups.service.ts): keeps only entries whose key
 * names one of THIS workspace's select fields, and within each entry only the
 * option ids that belong to that field. Foreign/stale ids are silently
 * dropped; entries that empty out are dropped whole. Stale ids would match
 * nothing anyway — this is about not persisting garbage.
 */
export async function ownedFieldFilters(
  workspaceId: string,
  filters: ContactFieldFilter[],
  client: Pick<typeof db, "contactFieldDefinition"> = db,
): Promise<ContactFieldFilter[]> {
  if (filters.length === 0) return [];
  const defs = await client.contactFieldDefinition.findMany({
    where: { workspaceId, key: { in: filters.map((f) => f.key) }, type: "select" },
    select: { key: true, options: { select: { id: true } } },
  });
  const byKey = new Map(defs.map((d) => [d.key, new Set(d.options.map((o) => o.id))]));
  const owned: ContactFieldFilter[] = [];
  for (const f of filters) {
    const optionSet = byKey.get(f.key);
    if (!optionSet) continue;
    const optionIds = f.optionIds.filter((id) => optionSet.has(id));
    if (optionIds.length === 0) continue;
    owned.push({ key: f.key, optionIds });
  }
  return owned;
}
