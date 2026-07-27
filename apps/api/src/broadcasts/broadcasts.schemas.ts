import { z } from "zod";
import { zBroadcastableChannel } from "@/common/channel-schema";

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
  /**
   * The pin for a LOCATION-header template — one place for the whole campaign,
   * which is what a location template means (a store opening, an event venue).
   * Declared with no parameters at create time, so all of it arrives here.
   */
  headerLocation: z
    .object({
      latitude: z.string().min(1).max(32),
      longitude: z.string().min(1).max(32),
      // Optional per Meta: a pin renders from coordinates alone.
      name: z.string().max(120).optional(),
      address: z.string().max(255).optional(),
    })
    .optional(),
  /**
   * TOP-LEVEL button values, campaign-level: the coupon code every recipient
   * gets, or the shared URL suffix. The 4th instance of the "a send-time value
   * the inbox collects but the broadcast path couldn't carry" class — before
   * this, a coupon-code template (the classic marketing campaign) was refused
   * at create. Validated against `requiredTemplateButtonParams` in the service.
   */
  buttons: z
    .array(
      z.object({
        index: z.number().int().min(0).max(9),
        subType: z.enum(["url", "quick_reply", "copy_code"]),
        text: z.string().min(1).max(2048),
      }),
    )
    .max(10)
    .optional(),
  /**
   * Carousel cards, campaign-level: every recipient sees the same strip. The
   * count is fixed by the approved template, so this is validated against it
   * rather than bounded here alone.
   */
  cards: z
    .array(
      z.object({
        kind: z.enum(["image", "video"]),
        link: z.string().url().max(2048),
        body: z.array(z.string()).max(10).optional(),
        buttons: z
          .array(
            z.object({
              index: z.number().int().min(0).max(1),
              subType: z.enum(["url", "quick_reply", "copy_code"]),
              text: z.string().min(1).max(2048),
            }),
          )
          .max(2)
          .optional(),
      }),
    )
    .max(10)
    .optional(),
  /**
   * Campaign-level limited-time-offer expiry, UNIX **milliseconds**. Required
   * when the template carries a LIMITED_TIME_OFFER component — one deadline for
   * the whole campaign, which is what a countdown offer means.
   */
  limitedTimeOfferExpiresAtMs: z.number().int().positive().optional(),
  /**
   * Tap-target override (`tap_target_configuration`): renders the message as
   * a CTA opening `url`, labeled `title`. Campaign-level — one destination
   * for every recipient. Meta gates it (fully-verified, high-quality WABAs)
   * and publishes NO title length cap, so the bound here is a loose sanity
   * limit only — never tighten it to a guess.
   */
  tapTarget: z
    .object({
      url: z.string().url().max(2000),
      title: z.string().trim().min(1).max(300),
    })
    .optional(),
});
export type BroadcastVariablesInput = z.infer<typeof BroadcastVariablesSchema>;

/**
 * Who owns the conversations a campaign creates.
 *
 *   none          — don't touch assignment (default; today's behavior)
 *   fixed         — everything to `userId`
 *   split_counts  — literal counts per member ("first 50 to Ali, next 10 to
 *                   Sara"); recipients past the last count follow `leftover`
 *   split_percent — proportional split of the WHOLE audience by weight,
 *                   apportioned with largest-remainder so the parts sum exactly
 *   policy        — run the named (or default) assignment policy over the
 *                   audience, honoring its membership, roles and weights
 *
 * `overwrite` (default false) decides whether a campaign may take over a
 * conversation that ALREADY has an assignee. Off by default so a marketing
 * blast can never yank a live support thread away from the agent handling it.
 */
export const BroadcastAssignmentSchema = z
  .object({
    mode: z
      .enum(["none", "fixed", "split_counts", "split_percent", "policy"])
      .default("none"),
    userId: z.string().min(1).nullable().optional(),
    policyId: z.string().min(1).nullable().optional(),
    split: z
      .array(
        z.object({
          userId: z.string().min(1),
          // 0 is pointless (it allocates nobody) and is rejected so a typo
          // surfaces in the composer instead of silently dropping a member.
          value: z.number().int().min(1).max(1_000_000),
        }),
      )
      .max(200)
      .optional(),
    leftover: z.enum(["leave_unassigned", "policy"]).default("leave_unassigned"),
    // WHEN the drawn assignee is applied. "on_reply" (default) waits until the
    // customer actually answers — a campaign is mostly one-way, and assigning
    // every recipient up front would bury agents in conversations nobody will
    // reply to and skew the open-conversation counts that capacity limits and
    // least-busy routing read. "on_send" applies right after a successful send.
    trigger: z.enum(["on_reply", "on_send"]).default("on_reply"),
    overwrite: z.boolean().default(false),
  })
  .refine((v) => v.mode !== "fixed" || Boolean(v.userId), {
    message: "assignment.userId is required when mode = fixed",
  })
  .refine(
    (v) =>
      (v.mode !== "split_counts" && v.mode !== "split_percent") ||
      (v.split?.length ?? 0) > 0,
    { message: "assignment.split is required for a split mode" },
  )
  .refine(
    (v) =>
      v.mode !== "split_counts" && v.mode !== "split_percent"
        ? true
        : new Set(v.split!.map((s) => s.userId)).size === v.split!.length,
    { message: "assignment.split cannot list the same member twice" },
  );
export type BroadcastAssignmentInput = z.infer<typeof BroadcastAssignmentSchema>;

export const CreateBroadcastSchema = z
  .object({
    // `template` (WhatsApp, default — back-compat for existing callers) or
    // `freeform` (plain text to in-window Messenger / Instagram contacts).
    kind: z.enum(["template", "freeform"]).default("template"),
    // A broadcast is strictly SINGLE-CHANNEL, single sending account. The
    // omnichannel `customer` mode ("People / best channel") was removed
    // 2026-07-27: it was the one cross-channel send path, and it made "which
    // number is this going out on" unanswerable. The field survives (literal)
    // so existing callers sending `targetMode: "contact"` keep working, and a
    // caller still sending "customer" gets a clear Zod rejection rather than a
    // silently re-interpreted campaign. Historical rows keep their stored
    // value for reporting.
    targetMode: z.literal("contact").default("contact"),
    // template kind:
    templateId: z.string().min(1).optional(),
    variables: BroadcastVariablesSchema.default({ body: [] }),
    // freeform kind:
    channel: zBroadcastableChannel().optional(),
    /**
     * Which of the workspace's accounts on that channel this campaign sends
     * from — a specific WhatsApp number, Page or Instagram handle. Omitted
     * falls back to the channel's default account.
     *
     * Every account is a distinct sender identity to the customer, so this also
     * scopes the audience and the template catalogue (a template belongs to one
     * WhatsApp Business Account and can't be sent from a number outside it).
     */
    channelConnectionId: z.string().min(1).optional(),
    /**
     * Reach contacts belonging to the workspace's OTHER accounts on this
     * channel, not just the sending one.
     *
     * Off by default and deliberately explicit: those customers have never
     * messaged this number/Page, so they see an unfamiliar sender and their
     * reply opens a new thread on it. That is sometimes exactly what an operator
     * wants (a number migration, a merged brand) — it just must not happen by
     * accident.
     */
    includeOtherAccounts: z.boolean().optional().default(false),
    bodyText: z.string().trim().min(1).max(2000).optional(),
    audience: AudienceSchema,
    // Optional operator label (falls back to template name in the UI).
    name: z.string().trim().max(120).optional(),
    // ISO datetime to send later. Omit / null = send now. A past/near-now value
    // is treated as "now" by the service (clamped delay), so no strict future
    // validation here — the UI prevents past picks, the server is tolerant.
    scheduledAt: z.string().datetime().nullable().optional(),
    // Who owns the replies. Omitted = unassigned (today's behavior).
    assignment: BroadcastAssignmentSchema.optional(),
  })
  .refine(
    (v) =>
      v.kind === "freeform"
        ? Boolean(v.channel && v.bodyText)
        : Boolean(v.templateId),
    {
      message: "freeform requires channel + bodyText; template requires templateId",
    },
  );
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
    .enum([
      "all",
      "scheduled",
      "materializing",
      "queued",
      "running",
      "completed",
      "failed",
      "canceled",
      "paused",
    ])
    .optional(),
  search: z.string().trim().max(120).optional(),
  /**
   * Scope the history to ONE channel.
   *
   * Outreach is organized per channel — a campaign is WhatsApp or Messenger or
   * Instagram, never a mix — so the list has to be able to answer "what has this
   * channel sent" without the operator eyeballing a mixed table.
   *
   * `people` selects the omnichannel target mode rather than a channel: those
   * campaigns resolve a channel per recipient, so they belong to none of them
   * and would otherwise be invisible under every filter.
   */
  channel: z
    .enum(["whatsapp", "messenger", "instagram", "people"])
    .optional(),
  // Keyset pagination. `cursor` is the opaque `<createdAtMs>_<id>` of the last
  // row from the previous page; `take` bounds the page (default 100, max 200).
  // Older history beyond the first page is reachable by paging — previously the
  // list was hard-capped at 100 with no way to reach row 101+.
  cursor: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  /** 1-based page for numbered (offset) pagination. When present the query runs
   *  in offset mode (cursor ignored, totalCount returned). */
  // Bounded like its two siblings (contacts, calls) — the only one that wasn't.
  // `page` becomes a literal SQL OFFSET (see BroadcastsService.list), so an
  // unbounded value is an unbounded-cost query: `?page=999999999` asks Postgres
  // to walk and discard ~25 billion rows' worth of offset before returning
  // nothing. Any authenticated member could issue it.
  page: z.coerce.number().int().min(1).max(10_000).optional(),
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

/**
 * Optional narrowing for `POST :id/retry`. Empty/absent = retry every genuine
 * failure (the historical behaviour); `errorCodes` limits it to specific
 * normalized reasons so the report's failure table can offer a bucketed retry.
 */
export const RetryBroadcastSchema = z.object({
  errorCodes: z.array(z.string().max(64)).max(20).optional(),
});
export type RetryBroadcastInput = z.infer<typeof RetryBroadcastSchema>;

/**
 * Recipient CSV export filters — the SAME vocabulary the report's funnel and
 * failure table deep-link with, so "export what I'm looking at" works.
 * `never_received` is the union operators actually ask for (rejected at send OR
 * accepted-then-undeliverable) and exists so they don't have to do set
 * arithmetic across two buckets.
 */
export const BroadcastExportQuerySchema = z.object({
  outcome: z
    .enum([
      "all",
      "never_received",
      "delivered",
      "read",
      "replied",
      "clicked",
      "failed",
      "undelivered",
      "pending",
    ])
    .optional(),
  errorCode: z.string().max(64).optional(),
});
export type BroadcastExportQuery = z.infer<typeof BroadcastExportQuerySchema>;
