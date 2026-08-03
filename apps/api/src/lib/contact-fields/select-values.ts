import { BadRequestException } from "@nestjs/common";

import { db } from "@/lib/db";

/**
 * Select-type custom fields — the single authority for turning a caller-sent
 * value into what we STORE.
 *
 * For a select field the stored value in Contact.customFields[key] is the
 * OPTION ID (rename-stable), but callers legitimately send either the id
 * (our UI) or the option name (CSV imports, CRM syncs over /v1, a customer's
 * reply captured by ask_question). Every write path resolves through here so
 * "name-or-id in, id stored" is defined exactly once:
 *
 *   - contacts.service create/update (inbox panel, drawer, contacts page)
 *   - external-v1.service create/re-add/update (CRM sync)
 *   - workflow steps update_field + ask_question
 *   - contact-transfer import runner (per-cell, lenient)
 *
 * Precedence: exact id match first, then case-insensitive trimmed name —
 * documented on the /v1 docs page; keep them in sync.
 */

export interface SelectFieldCatalogEntry {
  key: string;
  options: { id: string; name: string }[];
}

/**
 * Load the select-field catalog for a set of customFields keys. One query;
 * text fields and undefined keys simply don't appear in the result. Safe to
 * call with any client (pass a tx to read inside a transaction).
 */
export async function loadSelectFieldCatalog(
  workspaceId: string,
  keys: string[],
  client: Pick<typeof db, "contactFieldDefinition"> = db,
): Promise<Map<string, SelectFieldCatalogEntry>> {
  if (keys.length === 0) return new Map();
  const defs = await client.contactFieldDefinition.findMany({
    where: { workspaceId, key: { in: keys }, type: "select" },
    select: {
      key: true,
      options: {
        select: { id: true, name: true },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  return new Map(defs.map((d) => [d.key, { key: d.key, options: d.options }]));
}

/**
 * Resolve one raw value against a select field's catalog. Exact option-id
 * match wins; otherwise the trimmed, case-insensitive name. Pure.
 */
export function resolveSelectValue(
  entry: SelectFieldCatalogEntry,
  raw: string,
): { ok: true; id: string } | { ok: false } {
  const byId = entry.options.find((o) => o.id === raw);
  if (byId) return { ok: true, id: byId.id };
  const needle = raw.trim().toLowerCase();
  if (!needle) return { ok: false };
  const byName = entry.options.find((o) => o.name.trim().toLowerCase() === needle);
  return byName ? { ok: true, id: byName.id } : { ok: false };
}

/**
 * Cached select-field catalog for DISPLAY (token rendering): every select
 * def's key + options, per workspace. 5-min TTL like the default-stage memo
 * (lib/queries/stages.ts) — token contexts are built per workflow step and
 * per broadcast recipient, and the catalog changes ~never. Busted explicitly
 * by ContactFieldsService on every field/option mutation. WRITE validation
 * deliberately does NOT use this cache — writes read fresh so a just-deleted
 * option can't be re-stored for up to 5 minutes.
 */
const DISPLAY_DEFS_TTL_MS = 5 * 60 * 1000;
const displayDefsCache = new Map<
  string,
  { defs: { key: string; type: string; options: { id: string; name: string }[] }[]; exp: number }
>();

export function invalidateSelectFieldDisplayCache(workspaceId: string): void {
  displayDefsCache.delete(workspaceId);
}

export async function loadSelectFieldDisplayDefs(
  workspaceId: string,
): Promise<{ key: string; type: string; options: { id: string; name: string }[] }[]> {
  const cached = displayDefsCache.get(workspaceId);
  if (cached && cached.exp > Date.now()) return cached.defs;
  const defs = await db.contactFieldDefinition.findMany({
    where: { workspaceId, type: "select" },
    select: {
      key: true,
      type: true,
      options: { select: { id: true, name: true } },
    },
  });
  displayDefsCache.set(workspaceId, { defs, exp: Date.now() + DISPLAY_DEFS_TTL_MS });
  return defs;
}

/**
 * Strict variant for interactive/API writes: returns the patch with every
 * select-field value replaced by its option id, or throws 400
 * `invalid_option` naming the field and the allowed options. Text fields,
 * one-off keys (no definition), nulls, and empty strings (both mean "clear")
 * pass through untouched.
 */
export async function resolveSelectFieldPatch<T extends Record<string, string | null | undefined>>(
  workspaceId: string,
  patch: T,
  client: Pick<typeof db, "contactFieldDefinition"> = db,
): Promise<T> {
  const keys = Object.keys(patch);
  const catalog = await loadSelectFieldCatalog(workspaceId, keys, client);
  if (catalog.size === 0) return patch;

  const resolved: Record<string, string | null | undefined> = { ...patch };
  for (const [key, entry] of catalog) {
    const raw = patch[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const match = resolveSelectValue(entry, raw);
    if (!match.ok) {
      throw new BadRequestException({
        error: "invalid_option",
        field: key,
        value: raw,
        options: entry.options.map((o) => o.name),
      });
    }
    resolved[key] = match.id;
  }
  return resolved as T;
}
