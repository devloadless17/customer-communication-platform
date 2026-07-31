import { z } from "zod";

/**
 * Query for the workspace performance report. `from`/`to` are ISO instants
 * ([from, to) — exclusive upper bound so adjacent ranges never double-count a
 * boundary message); `tz` is the IANA zone daily buckets flip in (defaults to
 * UTC — the web client always sends the browser's zone). Range width and tz
 * shape are re-validated in the domain layer (lib/analytics/reports.ts), which
 * also serves the /v1 parity route.
 */
export const ReportOverviewQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    tz: z.string().min(1).max(64).default("UTC"),
    /**
     * Scope every panel to ONE channel account (`ChannelConnection.id`, from
     * `GET /api/workspace/channel-accounts`). Omitted = the whole workspace.
     *
     * A workspace running a Sales and a Support number is two operations
     * sharing a medium; a blended first-response time hides one drowning
     * behind the other. An id from another workspace is rejected rather than
     * silently returning an empty report.
     */
    accountId: z.string().min(1).optional(),
  })
  .strict();
export type ReportOverviewQuery = z.infer<typeof ReportOverviewQuerySchema>;

/**
 * Query for Meta's ACCOUNT-level analytics (spend, volume, tiers, calls).
 *
 * Separate from the overview query on purpose: this one reads Meta, not our
 * database, so its constraints are Meta's. The window is a ONE-YEAR lookback
 * (Meta cut it from ten years on 2025-12-01) and the granularity vocabulary is
 * only day/month — there is no timezone parameter because these surfaces bucket
 * in UTC, and inventing a local-midnight rebucket over pre-aggregated data would
 * silently misattribute spend across day boundaries.
 *
 * `wabaAccountId` scopes to ONE WhatsApp Business Account. Omitted = every WABA
 * in the workspace, each reported separately — never pooled, because currencies
 * and tier ladders are per-account.
 */
export const WabaAnalyticsQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    granularity: z.enum(["day", "month"]).default("day"),
    wabaAccountId: z.string().min(1).optional(),
  })
  .strict();
export type WabaAnalyticsQueryInput = z.infer<typeof WabaAnalyticsQuerySchema>;

/**
 * GET /api/reports/acquisition — where customers came from.
 *
 * All three filters optional: no window means all time, which is the right
 * default for "which ad has ever worked for us". `channel` narrows to one
 * messaging channel when a business runs ads on several.
 */
export const AcquisitionQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  channel: z.enum(["whatsapp", "messenger", "instagram"]).optional(),
});
export type AcquisitionQuery = z.infer<typeof AcquisitionQuerySchema>;
