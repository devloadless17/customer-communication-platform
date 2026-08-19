import { z } from "zod";

import { zLiveChannel } from "@/common/channel-schema";
import {
  IMPORT_MODES,
  IMPORT_TAG_MODES,
  TRANSFER_FORMATS,
} from "@ccp/shared/contacts/transfer-columns";

/**
 * Zod schemas for the contact import/export surface. Same conventions as
 * contacts.schemas.ts: export the schema AND the inferred type, lenient coerce
 * on query params, default `.strip()` on bodies (never `.passthrough()`).
 *
 * Limits that the browser also needs (upload size, row caps, the automations
 * threshold) live in @ccp/shared/contacts/transfer-columns so the client
 * pre-validates against the exact server numbers instead of a copy that drifts.
 */

/** Ids per explicit-selection export — the same ceiling as bulk id mode. */
const MAX_SELECTION_IDS = 50_000;

export const TransferFormatSchema = z.enum(
  TRANSFER_FORMATS as unknown as [string, ...string[]],
);

/**
 * List filters mirrored from ListContactsQuerySchema. Repeated rather than
 * imported because export takes them as a nested object in a POST body while
 * the list takes them as flat query params — same fields, different transport.
 */
export const ExportFiltersSchema = z.object({
  search: z.string().max(200).optional(),
  fieldKey: z.string().max(80).optional(),
  fieldValue: z.string().max(200).optional(),
  fieldMode: z.enum(["contains", "equals"]).optional(),
  // Same enums as the list, not free text: both are interpolated into the
  // shared filter's raw SQL as `::"ContactSource"` / `::"Channel"` casts, so an
  // unknown value failed the export JOB with a raw Postgres cast error stored as
  // its error message instead of a 400 at submit.
  source: z.enum(["inbound", "manual"]).optional(),
  channel: zLiveChannel().optional(),
  // Exporting "current filters" must honour the reachability gate too, or the
  // CSV silently contains people the list on screen was hiding.
  reach: z.enum(["phone", "email"]).optional(),
  window: z.enum(["open", "closed"]).optional(),
  stageId: z.string().max(40).optional(),
  tagIds: z.array(z.string().max(40)).max(50).optional(),
});

export const CreateExportSchema = z
  .object({
    format: TransferFormatSchema.default("csv"),
    /**
     * Explicit selection. Wins over `filters` when present — "export the 12
     * rows I ticked" must never silently become "export everything matching
     * the current search".
     */
    ids: z.array(z.string().max(40)).max(MAX_SELECTION_IDS).optional(),
    filters: ExportFiltersSchema.optional(),
  })
  .strict();
export type CreateExportInput = z.infer<typeof CreateExportSchema>;

export const CreateImportSchema = z
  .object({
    mode: z.enum(IMPORT_MODES as unknown as [string, ...string[]]).default("create_only"),
    tagMode: z.enum(IMPORT_TAG_MODES as unknown as [string, ...string[]]).default("merge"),
    /**
     * Publish per-row contact.created/updated (so workflows and outbound
     * webhooks fire). Forced off above IMPORT_EVENT_FANOUT_CAP regardless of
     * what's requested — see the runner.
     */
    fireAutomations: z.boolean().default(true),
    /** header → `"ignore"` | a built-in column id | `"field:<key>"`. */
    mapping: z.record(z.string().max(200), z.string().max(120)).optional(),
    /**
     * ISO-2 country for the file's NATIONAL-format numbers ("LB", "AE", "GB").
     *
     * A CRM export commonly stores local numbers (`03123456`) — without a
     * country there is nothing to resolve them into a sendable wa_id, and they
     * used to be stored as-is and fail silently at send time. A number that
     * already carries its own country code is unaffected, so a mixed file is
     * handled row by row.
     */
    defaultCountry: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "Country must be a two-letter ISO code")
      .transform((c) => c.toUpperCase())
      .optional(),
  })
  .strict();
export type CreateImportInput = z.infer<typeof CreateImportSchema>;

/**
 * Import options arrive as a multipart FIELD alongside the file, so they're a
 * JSON string rather than a parsed body. Parsed leniently: a malformed blob
 * falls back to defaults instead of 400-ing an upload that already succeeded
 * (the file is the expensive part; the options are all defaultable).
 */
export function parseImportOptions(raw: string | undefined): CreateImportInput {
  if (!raw) return CreateImportSchema.parse({});
  try {
    return CreateImportSchema.parse(JSON.parse(raw));
  } catch {
    return CreateImportSchema.parse({});
  }
}

export const ListTransfersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  kind: z.enum(["import", "export"]).optional(),
});
export type ListTransfersQueryInput = z.infer<typeof ListTransfersQuerySchema>;
