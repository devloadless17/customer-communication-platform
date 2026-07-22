/**
 * Resolves a team's transfer column set: the shared built-in table plus that
 * team's custom fields, plus (on export) the one-off `customFields` bag keys
 * that exist on real rows but have no ContactFieldDefinition.
 *
 * Import and export both go through here so a file exported by this team
 * re-imports into the same columns — round-tripping is a hard requirement, not
 * a nice-to-have: "export, edit in Excel, re-import" is the single most common
 * bulk workflow and it silently corrupts data if the two ends disagree.
 */

import {
  collidesWithBuiltinColumn,
  CUSTOM_FIELD_HEADER_PREFIX,
  isIgnoredTransferHeader,
  matchTransferColumn,
  TRANSFER_COLUMNS,
  type TransferColumnId,
} from "@ccp/shared/contacts/transfer-columns";

import { db } from "@/lib/db";

/** Where one file header sends its value. */
export type HeaderMapping =
  | { kind: "builtin"; id: TransferColumnId }
  | { kind: "field"; key: string }
  | { kind: "ignore" };

export interface TeamFieldDef {
  key: string;
  label: string;
}

/**
 * Max one-off (definition-less) `customFields` keys added as export columns.
 * The keys are attacker-reachable — the /v1 and PATCH customFields bags accept
 * arbitrary keys, unlike field labels which are checked against reserved names
 * — so an unbounded DISTINCT could hand back thousands of columns and produce a
 * file Excel refuses to open (16,384 column limit).
 */
const MAX_ONE_OFF_COLUMNS = 200;

/**
 * The header a team custom field is written under.
 *
 * Normally the human-readable label. But a label that a built-in column would
 * shadow on import ("Language" vs the built-in `language`) is emitted in the
 * `custom:<key>` form instead — otherwise the file carries TWO columns that
 * both resolve to the built-in, the last one wins, and the custom field's data
 * is silently lost on re-import.
 */
export function fieldHeader(def: TeamFieldDef): string {
  return collidesWithBuiltinColumn(def.label)
    ? `${CUSTOM_FIELD_HEADER_PREFIX}${def.key}`
    : def.label;
}

/**
 * Build the export column list for a team.
 *
 * The one-off keys come from ONE aggregate query rather than by scanning loaded
 * rows. The old exporter collected them while iterating every contact, which a
 * streaming export cannot do — the header has to be written before the first
 * row is read.
 */
export async function resolveExportColumns(workspaceId: string): Promise<{
  columns: string[];
  fieldDefs: TeamFieldDef[];
  oneOffKeys: string[];
}> {
  const fieldDefs = await db.contactFieldDefinition.findMany({
    where: { workspaceId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: { key: true, label: true },
  });

  const baseColumns = TRANSFER_COLUMNS.map((c) => c.header);
  const teamColumns = fieldDefs.map(fieldHeader);

  // A one-off bag key that shadows a base column ("phone_number") or a team
  // field label would emit a DUPLICATE header AND overwrite the built-in cell
  // in the row builder (last write wins), corrupting the export and breaking
  // re-import. Drop the collisions — the built-in column already carries the
  // canonical value.
  const reserved = new Set([...baseColumns, ...teamColumns].map((c) => c.toLowerCase()));
  const definedKeys = new Set(fieldDefs.map((d) => d.key));

  const rows = await db.$queryRaw<Array<{ key: string }>>`
    SELECT DISTINCT k AS key
    FROM "Contact" c,
         LATERAL jsonb_object_keys(c."customFields") AS k
    WHERE c."workspaceId" = ${workspaceId}
      AND c."deletedAt" IS NULL
      AND jsonb_typeof(c."customFields") = 'object'
    ORDER BY k
    LIMIT ${MAX_ONE_OFF_COLUMNS}
  `;

  const oneOffKeys = rows
    .map((r) => r.key)
    .filter((k) => !definedKeys.has(k) && !reserved.has(k.toLowerCase()));

  return {
    columns: [...baseColumns, ...teamColumns, ...oneOffKeys],
    fieldDefs,
    oneOffKeys,
  };
}

/**
 * Map raw file headers to targets for an import.
 *
 * `overrides` is the user's explicit choice from the mapping step, keyed by the
 * raw header. It wins over auto-detection — the whole point of the mapping UI
 * is that the user can correct us, including forcing a column to `ignore`.
 */
export function resolveImportMapping(
  headers: string[],
  fieldDefs: TeamFieldDef[],
  overrides: Record<string, string> = {},
): { mapping: Map<string, HeaderMapping>; unknownColumns: string[] } {
  const labelToKey = new Map(fieldDefs.map((d) => [d.label.toLowerCase(), d.key]));
  const keySet = new Set(fieldDefs.map((d) => d.key));
  const mapping = new Map<string, HeaderMapping>();
  const unknownColumns: string[] = [];

  for (const header of headers) {
    const override = overrides[header];
    if (override !== undefined) {
      mapping.set(header, parseOverride(override, keySet));
      continue;
    }

    // `custom:<key>` wins over built-in matching by construction — that is the
    // entire point of the prefix (see CUSTOM_FIELD_HEADER_PREFIX).
    const trimmed = header.trim();
    if (trimmed.toLowerCase().startsWith(CUSTOM_FIELD_HEADER_PREFIX)) {
      const key = trimmed.slice(CUSTOM_FIELD_HEADER_PREFIX.length).trim();
      if (keySet.has(key)) {
        mapping.set(header, { kind: "field", key });
        continue;
      }
      // Names a field that no longer exists — ignore it, and DO report it so
      // the user isn't left wondering where the column went.
      mapping.set(header, { kind: "ignore" });
      unknownColumns.push(header);
      continue;
    }

    const builtin = matchTransferColumn(header);
    if (builtin) {
      // `source` / `id` are emitted by export but never imported.
      mapping.set(
        header,
        builtin.importable ? { kind: "builtin", id: builtin.id } : { kind: "ignore" },
      );
      continue;
    }

    // Custom field, matched on LABEL (what the user sees in the header row).
    const byLabel = labelToKey.get(header.trim().toLowerCase());
    if (byLabel) {
      mapping.set(header, { kind: "field", key: byLabel });
      continue;
    }
    // ...or on the stable key, so a file exported with one-off bag keys as
    // headers re-imports into the same keys.
    if (keySet.has(header.trim())) {
      mapping.set(header, { kind: "field", key: header.trim() });
      continue;
    }

    mapping.set(header, { kind: "ignore" });
    // Don't report `source`/`id` as "unknown" — WE wrote those columns; warning
    // the user about our own export is noise that teaches them to ignore the
    // warning that matters.
    if (!isIgnoredTransferHeader(header)) unknownColumns.push(header);
  }

  return { mapping, unknownColumns };
}

/**
 * Parse a mapping override from the UI. Shapes: `"ignore"`, a built-in column
 * id (`"phone_number"`), or `"field:<key>"`. An override naming a field that no
 * longer exists degrades to `ignore` rather than throwing — a definition can be
 * deleted between the preview step and the run.
 */
function parseOverride(value: string, keySet: Set<string>): HeaderMapping {
  if (value === "ignore" || value === "") return { kind: "ignore" };
  if (value.startsWith("field:")) {
    const key = value.slice("field:".length);
    return keySet.has(key) ? { kind: "field", key } : { kind: "ignore" };
  }
  const builtin = TRANSFER_COLUMNS.find((c) => c.id === value);
  return builtin?.importable ? { kind: "builtin", id: builtin.id } : { kind: "ignore" };
}

/**
 * Auto-detect suggestion for the mapping UI, as the same override strings the
 * run endpoint accepts — so the client can present our guess, let the user edit
 * it, and post the result straight back with no translation layer.
 */
export function suggestMapping(
  headers: string[],
  fieldDefs: TeamFieldDef[],
): Record<string, string> {
  const { mapping } = resolveImportMapping(headers, fieldDefs);
  const out: Record<string, string> = {};
  for (const [header, m] of mapping) {
    out[header] =
      m.kind === "builtin" ? m.id : m.kind === "field" ? `field:${m.key}` : "ignore";
  }
  return out;
}
