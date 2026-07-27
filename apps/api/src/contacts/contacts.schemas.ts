import { z } from "zod";
import { zLiveChannel } from "@/common/channel-schema";

const MAX_IDS = 5000;
const MAX_TEXT = 500;
const MAX_FIELDS_PER_PATCH = 50;
const MAX_FIELDS = 50;
// Per-request caps (MAX_FIELDS / MAX_FIELDS_PER_PATCH) bound ONE create/patch.
// MAX_TOTAL_FIELDS bounds the ACCUMULATED customFields bag across many PATCHes —
// without it, repeated PATCHes of fresh one-off keys grow the JSONB unbounded.
// 100 leaves headroom above the 50/team defined-field cap + arbitrary /v1 keys.
export const MAX_TOTAL_FIELDS = 100;

export const SetContactTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(200),
});
export type SetContactTagsInput = z.infer<typeof SetContactTagsSchema>;

export const AudienceCountSchema = z
  .object({
    tagIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
    contactIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
    /** Scope the count to one channel — a broadcast sends on a single channel, so
     *  the composer count must match what actually gets sent. Omit = all channels. */
    channel: zLiveChannel().optional(),
    /** "All contacts" audience: count every team contact (tags/ids ignored),
     *  optionally scoped to `channel`. Distinct from the empty tags+ids case, which
     *  deliberately counts 0 so an unset custom audience never targets everyone. */
    all: z.boolean().optional(),
    /** The "Send from" account — scopes the count to that account's own
     *  contacts exactly like the send does (see BroadcastsService.create's
     *  account scoping), so the composer's numbers move when the checkbox
     *  below does. */
    accountId: z.string().min(1).optional(),
    includeOtherAccounts: z.boolean().optional(),
  })
  // `all` IGNORES tagIds/contactIds server-side, so accepting both would silently
  // answer a different question than the caller asked ("all contacts tagged VIP"
  // → the whole team). Make the conflict a 400 instead of a wrong number.
  .refine((v) => !(v.all && (v.tagIds.length > 0 || v.contactIds.length > 0)), {
    message: "`all` cannot be combined with tagIds/contactIds",
    path: ["all"],
  });
export type AudienceCountInput = z.infer<typeof AudienceCountSchema>;

export const AudiencePreviewSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
  contactIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  /** Scope the preview to one channel, mirroring `AudienceCountSchema`. A
   *  broadcast sends on a single channel, so "who am I sending to" must show the
   *  same set the count and the send resolve. Omit = all channels. */
  channel: zLiveChannel().optional(),
  /** Mirrors `AudienceCountSchema` — the preview answers "who am I sending
   *  to", so it must resolve the same account-scoped set the send does. */
  accountId: z.string().min(1).optional(),
  includeOtherAccounts: z.boolean().optional(),
});
export type AudiencePreviewInput = z.infer<typeof AudiencePreviewSchema>;

// ---------------------------------------------------------------------------
// List query — drives GET /api/contacts. Each filter is optional; the
// `source`/`window` enums silently drop unknown values via `.catch(undefined)`
// so a parse failure on this branch becomes `undefined`, not a 400.
// ---------------------------------------------------------------------------
export const ListContactsQuerySchema = z.object({
  search: z.string().optional(),
  cursor: z.string().optional(),
  /** 1-based page for numbered pagination. When present the query runs in
   *  offset mode (cursor ignored, totalCount always returned).
   *
   *  UPPER-BOUNDED. Offset paging costs a scan-and-discard of everything before
   *  the offset — including the per-row LEFT JOIN LATERAL last-message probe —
   *  so page depth is real server work an authenticated client chooses. There
   *  was no maximum, so `page=1e9` was accepted and ran a full scan of the
   *  tenant's filtered set to return nothing. 10k pages is far past any real
   *  navigation (250k contacts at the 25 default) while making an absurd value
   *  a 400 instead of a scan. Deep-but-legitimate paging is unaffected; the
   *  fast path for large tenants remains search + filters, which are indexed. */
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  /** Page size for numbered pagination (clamped server-side, default 50). */
  take: z.coerce.number().int().min(1).max(100).optional(),
  fieldKey: z.string().optional(),
  fieldValue: z.string().optional(),
  source: z.enum(["inbound", "manual"]).optional().catch(undefined),
  /** Comma-separated list of tag ids; ANY-match. Empty entries are dropped. */
  tagIds: z.string().optional(),
  /** Filter to one channel (whatsapp / messenger / instagram). */
  channel: zLiveChannel().optional().catch(undefined),
  /** "Group by person" view — one row per unified Customer (offset mode). */
  groupByPerson: z.coerce.boolean().optional().catch(undefined),
  window: z.enum(["open", "closed"]).optional().catch(undefined),
  /** Either a stage cuid OR the literal "none" (filter to no-stage). Empty
   *  strings are dropped (`min(1)` enforces non-empty). */
  stageId: z
    .string()
    .min(1)
    .optional()
    .catch(undefined),
});
export type ListContactsQueryInput = z.infer<typeof ListContactsQuerySchema>;

// ---------------------------------------------------------------------------
// Custom-fields shape, shared by create + patch.
//
// Create: values must be strings (no `null` — null on create means "skip",
//         not "remove a key", since there's no existing bag to remove from).
// Patch:  values can be `string | null`. `string` → set, `null` → remove,
//         missing → leave alone.
// ---------------------------------------------------------------------------
const CustomFieldsCreateSchema = z
  .record(
    z.string().min(1).max(80),
    z.union([z.string().max(MAX_TEXT), z.null(), z.literal("")]),
  )
  .refine(
    (obj) => Object.keys(obj).length <= MAX_FIELDS,
    { message: `at most ${MAX_FIELDS} customFields entries` },
  );

const CustomFieldsPatchSchema = z
  .record(
    z.string().min(1).max(80),
    z.union([z.string().max(MAX_TEXT), z.null()]),
  )
  .refine(
    (obj) => Object.keys(obj).length <= MAX_FIELDS_PER_PATCH,
    { message: `at most ${MAX_FIELDS_PER_PATCH} fields per patch` },
  );

// ---------------------------------------------------------------------------
// POST /api/contacts — manual contact create. Phone is required + normalized
// at the service layer (the schema accepts any string so the normalizer can
// produce a precise error message). Pre-migration behavior matched exactly.
// ---------------------------------------------------------------------------
// Shared validators for the new webhook-facing contact fields. Same shapes as
// the /v1 schemas (external-v1.schemas.ts) so both entry points converge.
const LanguageSchema = z.string().trim().min(2).max(12);
const CountryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/)
  .transform((v) => v.toUpperCase());

export const CreateContactSchema = z.object({
  name: z.string().trim().max(MAX_TEXT).optional(),
  firstName: z.string().trim().max(MAX_TEXT).optional(),
  lastName: z.string().trim().max(MAX_TEXT).optional(),
  language: LanguageSchema.optional(),
  countryCode: CountryCodeSchema.optional(),
  phoneNumber: z.string().min(1),
  email: z.string().trim().max(MAX_TEXT).optional(),
  location: z.string().trim().max(MAX_TEXT).optional(),
  customFields: CustomFieldsCreateSchema.optional(),
});
export type CreateContactInput = z.infer<typeof CreateContactSchema>;

// ---------------------------------------------------------------------------
// PATCH /api/contacts/:id — partial update.
//
// `phoneNumber` is rejected at the controller level (BEFORE Zod) with a
// loud, contact-specific 400 — see CLAUDE.md memory "Contact phone immutable".
// We don't put it in the schema because we want the error message to be
// "phoneNumber is not editable — it's the WhatsApp identity for this contact"
// rather than a generic Zod issue.
//
// Zod's default is `.strip()` — unknown keys are silently dropped. We rely on
// this AND on the service-layer destructure (contacts.service.ts) to filter to
// a known field allowlist before any Prisma `data:` spread. Don't use
// `.passthrough()` here — it would let a future `data: input` call smuggle
// arbitrary columns (`workspaceId`, FK fields) into the update.
// ---------------------------------------------------------------------------
export const UpdateContactSchema = z.object({
    name: z.string().trim().min(1).max(MAX_TEXT).optional(),
    firstName: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    lastName: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    language: z.union([LanguageSchema, z.null()]).optional(),
    countryCode: z.union([CountryCodeSchema, z.null()]).optional(),
    email: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    location: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    customFields: CustomFieldsPatchSchema.optional(),
    stageId: z.union([z.string().min(1), z.null()]).optional(),
  });
export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;

// ---------------------------------------------------------------------------
// POST /api/contacts/bulk — discriminated union over `action`.
//
// `delete` carries only contactIds; `tag-add`/`tag-remove` carry a single
// tagId PLUS one of two addressing modes:
//   - `mode: "ids"` (default) — an explicit contactId array (the loaded page
//     selection, capped at MAX_BULK_IDS).
//   - `mode: "filter"`        — the active contacts-list FILTER. The server
//     expands it to every matching contact id server-side (capped at
//     MAX_FILTER_MATCH). This is the Gmail/HubSpot "select all N matching"
//     path — used when more contacts match than are loaded into the page.
//
// DELETE is DELIBERATELY excluded from filter mode (a safety limit — see the
// task brief / contacts-client): a bulk purge stays capped to the explicitly
// loaded + checked selection. Don't add a `mode: "filter"` arm for `delete`.
//
// MAX_BULK_IDS caps the explicit-id payload; MAX_FILTER_MATCH caps how many
// rows a single filter-mode op may touch (a tenant-bounded, but still large,
// safety ceiling so one request can't lock the table indefinitely). The
// tag-add/tag-remove DB ops are a single set-based statement either way, so
// the filter ceiling can be higher than the id-array cap.
// ---------------------------------------------------------------------------
const MAX_BULK_IDS = 500;
export const MAX_FILTER_MATCH = 50_000;

// The filter shape mirrors ListContactsQuerySchema's semantics exactly so the
// server's where-builder produces the same set the list shows. tagIds is an
// ARRAY here (already parsed) rather than the comma-string the GET query uses.
export const BulkFilterSchema = z.object({
  search: z.string().max(MAX_TEXT).optional(),
  fieldKey: z.string().max(80).optional(),
  fieldValue: z.string().max(MAX_TEXT).optional(),
  source: z.enum(["inbound", "manual"]).optional(),
  tagIds: z.array(z.string().min(1)).max(MAX_IDS).optional(),
  window: z.enum(["open", "closed"]).optional(),
  stageId: z.string().min(1).optional(),
  // Load-bearing: without this, a "select all N matching" bulk op run while the
  // list is scoped to one channel silently targets every channel's contacts —
  // the superset the agent explicitly filtered out and never saw.
  channel: zLiveChannel().optional(),
});
export type BulkFilterInput = z.infer<typeof BulkFilterSchema>;

const TagActionSchema = z.enum(["tag-add", "tag-remove"]);

export const BulkContactsSchema = z.union([
  z.object({
    action: z.literal("delete"),
    contactIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS),
  }),
  // Explicit-id tag op (the default — back-compat with callers that omit
  // `mode`). `.default("ids")` makes the discriminant optional on the wire.
  z.object({
    action: TagActionSchema,
    mode: z.literal("ids").default("ids"),
    contactIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS),
    tagId: z.string().min(1),
  }),
  // Filter-mode tag op — "select all N matching". No contactIds; the server
  // expands `filter` to the matching id set.
  z.object({
    action: TagActionSchema,
    mode: z.literal("filter"),
    filter: BulkFilterSchema,
    tagId: z.string().min(1),
  }),
]);
export type BulkContactsInput = z.infer<typeof BulkContactsSchema>;

// CSV import has no JSON body (multipart/form-data, parsed by multer in the
// controller) so no schema lives here. The result shape lives in the service.
