import { z } from "zod";

// Matches contacts.schemas `MAX_IDS` — the cap the count/preview resolver
// enforces. Without it here, a >5000-id custom audience passes broadcast
// create but the count endpoint 400s, so the UI badge reads 0 for an
// audience that would actually send.
const MAX_AUDIENCE_IDS = 5000;

/**
 * Broadcast create body. Audience is a discriminated union over `mode`;
 * mode-specific fields are required only on their branch. Each branch is
 * tolerant of extra unused fields (e.g. a UI that always sends contactIds=[]
 * for the "all" mode won't 400) — irrelevant fields are silently ignored.
 */

const AudienceAllSchema = z.object({
  mode: z.literal("all"),
});

const AudienceSelectedSchema = z.object({
  mode: z.literal("selected"),
  contactIds: z.array(z.string().min(1)).max(MAX_AUDIENCE_IDS).default([]),
});

const AudienceByTagSchema = z.object({
  mode: z.literal("by_tag"),
  tagIds: z.array(z.string().min(1)).max(MAX_AUDIENCE_IDS).default([]),
});

const AudienceGroupSchema = z.object({
  mode: z.literal("group"),
  groupId: z.string().min(1).nullable().optional(),
});

/**
 * A one-off audience built inline — the UNION of tag membership + hand-picked
 * contacts, exactly like a saved group but not persisted as one. Same
 * `{ tagIds, contactIds }` shape the count/preview endpoints already resolve.
 * `by_tag` and `selected` stay in the union for backwards-compat (history rows
 * + deep links), but the UI now always sends `custom` for inline audiences.
 */
const AudienceCustomSchema = z.object({
  mode: z.literal("custom"),
  tagIds: z.array(z.string().min(1)).max(MAX_AUDIENCE_IDS).default([]),
  contactIds: z.array(z.string().min(1)).max(MAX_AUDIENCE_IDS).default([]),
});

export const AudienceSchema = z.union([
  AudienceAllSchema,
  AudienceSelectedSchema,
  AudienceByTagSchema,
  AudienceGroupSchema,
  AudienceCustomSchema,
]);
export type AudienceInput = z.infer<typeof AudienceSchema>;

export const BroadcastVariablesSchema = z.object({
  body: z.array(z.string()).default([]),
  header: z.string().optional(),
  // Campaign-level media for an IMAGE/VIDEO/DOCUMENT template header — a single
  // stable R2 object link (presigned fresh per send) reused across recipients.
  headerMedia: z
    .object({
      kind: z.enum(["image", "video", "document"]),
      link: z.string().url().max(2048),
      filename: z.string().max(255).optional(),
    })
    .optional(),
});
export type BroadcastVariablesInput = z.infer<typeof BroadcastVariablesSchema>;

export const CreateBroadcastSchema = z.object({
  templateId: z.string().min(1),
  variables: BroadcastVariablesSchema.default({ body: [] }),
  audience: AudienceSchema,
  // Optional operator label (falls back to template name in the UI).
  name: z.string().trim().max(120).optional(),
  // ISO datetime to send later. Omit / null = send now. A past/near-now value
  // is treated as "now" by the service (clamped delay), so no strict future
  // validation here — the UI prevents past picks, the server is tolerant.
  scheduledAt: z.string().datetime().nullable().optional(),
});
export type CreateBroadcastInput = z.infer<typeof CreateBroadcastSchema>;

/**
 * Pre-send preflight: given the SAME audience + template + variables the create
 * body would carry, report how many recipients would resolve a template
 * variable to EMPTY (a field like email is missing, no default on the binding)
 * — which WhatsApp rejects. Read-only; never mutates. Lets the composer warn
 * before the agent sends into a partial failure.
 */
export const PreviewMissingFieldsSchema = z.object({
  templateId: z.string().min(1),
  audience: AudienceSchema,
  variables: BroadcastVariablesSchema.default({ body: [] }),
});
export type PreviewMissingFieldsInput = z.infer<typeof PreviewMissingFieldsSchema>;

/** Status filter for the list page rail. `all` = no filter. */
export const BroadcastListQuerySchema = z.object({
  status: z
    .enum(["all", "scheduled", "queued", "running", "completed", "failed", "canceled", "paused"])
    .optional(),
  search: z.string().trim().max(120).optional(),
  // Keyset pagination. `cursor` is the opaque `<createdAtMs>_<id>` of the last
  // row from the previous page; `take` bounds the page (default 100, max 200).
  // Older history beyond the first page is reachable by paging — previously the
  // list was hard-capped at 100 with no way to reach row 101+.
  cursor: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});
export type BroadcastListQuery = z.infer<typeof BroadcastListQuerySchema>;

/**
 * Recipient-page query for `GET :id/recipients`. `status` is validated against
 * the BroadcastRecipientStatus enum so a bad value (e.g. `?status=bogus`) is
 * rejected with a clean 400 here rather than being cast straight to the Prisma
 * enum and surfacing as a 500 from the DB. Omit `status` = no filter.
 */
export const BroadcastRecipientsQuerySchema = z.object({
  cursor: z.string().optional(),
  status: z.enum(["queued", "sent", "failed"]).optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
});
export type BroadcastRecipientsQuery = z.infer<
  typeof BroadcastRecipientsQuerySchema
>;
