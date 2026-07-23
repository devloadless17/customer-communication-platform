import { z } from "zod";

/**
 * POST /api/workspace/workflows/:id/publish — `{ publish: boolean }`.
 *
 * Defaults to publish=true so an empty body OR `{ publish: true }` both
 * mean "publish".
 */
export const PublishWorkflowSchema = z.object({
  publish: z.boolean().default(true),
});
export type PublishWorkflowInput = z.infer<typeof PublishWorkflowSchema>;

/**
 * POST /api/workspace/workflows/:id/manual-trigger
 *
 *   { contactId, conversationId?, metadata? }
 */
export const ManualTriggerSchema = z.object({
  contactId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type ManualTriggerInput = z.infer<typeof ManualTriggerSchema>;

/**
 * POST /api/workspace/workflows/:id/test
 *
 *   { contactId?, conversationId? } — both optional, empty body falls
 *   back to a synthetic stub payload so a draft workflow without any
 *   real contact reference can still be test-run.
 */
export const TestWorkflowSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
  })
  .default({});
export type TestWorkflowInput = z.infer<typeof TestWorkflowSchema>;

// The full workflow create/update body shape is intentionally NOT modeled
// in Zod here. parseWorkflowBody in lib/workflows/parse.ts owns the deep
// validation (graph, trigger conditions, per-step configs against the
// step registry); duplicating that in Zod would mean ~300 lines of
// trigger/step parsing in two places. Controllers pass raw body through.

/**
 * GET /api/workspace/workflows/:id/runs query — keyset pagination. Previously the
 * runs list was hard-capped at 50 with no cursor, so older runs were
 * unreachable. `cursor` is `<startedAtMs>_<id>` of the last row of the prior
 * page; `take` bounds the page (default 50, max 200).
 */
export const ListWorkflowRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListWorkflowRunsQuery = z.infer<typeof ListWorkflowRunsQuerySchema>;
