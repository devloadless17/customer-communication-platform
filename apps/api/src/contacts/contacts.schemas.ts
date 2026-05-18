import { z } from "zod";

const MAX_IDS = 5000;
const MAX_TEXT = 500;
const MAX_FIELDS_PER_PATCH = 50;
const MAX_FIELDS = 50;

export const SetContactTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(200),
});
export type SetContactTagsInput = z.infer<typeof SetContactTagsSchema>;

export const AudienceCountSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
  contactIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
});
export type AudienceCountInput = z.infer<typeof AudienceCountSchema>;

export const AudiencePreviewSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
  contactIds: z.array(z.string().min(1)).max(MAX_IDS).default([]),
  limit: z.number().int().min(1).max(200).default(50),
});
export type AudiencePreviewInput = z.infer<typeof AudiencePreviewSchema>;

// ---------------------------------------------------------------------------
// List query — drives GET /api/contacts. Each filter is optional; the
// `source`/`window` enums silently drop unknown values to match the
// pre-migration Next.js behavior (`source === "inbound" || === "manual" ?
// source : undefined`). `.catch(undefined)` is the Zod way to spell that:
// a parse failure on this branch becomes `undefined`, not a 400.
// ---------------------------------------------------------------------------
export const ListContactsQuerySchema = z.object({
  search: z.string().optional(),
  cursor: z.string().optional(),
  fieldKey: z.string().optional(),
  fieldValue: z.string().optional(),
  source: z.enum(["inbound", "manual"]).optional().catch(undefined),
  /** Comma-separated list of tag ids; ANY-match. Empty entries are dropped. */
  tagIds: z.string().optional(),
  window: z.enum(["open", "closed"]).optional().catch(undefined),
  /** Either a stage cuid OR the literal "none" (filter to no-stage). Empty
   *  strings dropped to mirror the pre-migration `&& length > 0` check. */
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
  /** Account-manager — must be a member of the team. Validated at the service. */
  assignedUserId: z.string().min(1).optional(),
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
// `.passthrough()` so unknown keys (forward-compat / future fields) don't
// reject; only `phoneNumber` is hard-blocked.
// ---------------------------------------------------------------------------
export const UpdateContactSchema = z
  .object({
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
    /** Account-manager. `null` clears, cuid sets. Member of the team. */
    assignedUserId: z.union([z.string().min(1), z.null()]).optional(),
  })
  .passthrough();
export type UpdateContactInput = z.infer<typeof UpdateContactSchema>;

// ---------------------------------------------------------------------------
// POST /api/contacts/bulk — discriminated union over `action`.
//
// `delete` carries only contactIds; `tag-add`/`tag-remove` additionally
// carry a single tagId. MAX_BULK_IDS caps payload to bound DB roundtrip
// count (tag ops fire one update per id — Prisma's M2M `connect`/`disconnect`
// has no batch primitive that preserves OTHER existing tag links).
// ---------------------------------------------------------------------------
const MAX_BULK_IDS = 500;
export const BulkContactsSchema = z.union([
  z.object({
    action: z.literal("delete"),
    contactIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS),
  }),
  z.object({
    action: z.enum(["tag-add", "tag-remove"]),
    contactIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS),
    tagId: z.string().min(1),
  }),
]);
export type BulkContactsInput = z.infer<typeof BulkContactsSchema>;

// CSV import has no JSON body (multipart/form-data, parsed by multer in the
// controller) so no schema lives here. The result shape lives in the service.
