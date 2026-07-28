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
