import { z } from "zod";

/**
 * POST /api/team/workflows/:id/publish — `{ publish: boolean }`.
 *
 * Defaults to publish=true so an empty body OR `{ publish: true }` both
 * mean "publish" (mirrors the pre-migration `raw.publish !== false`
 * truthy semantics).
 */
export const PublishWorkflowSchema = z.object({
  publish: z.boolean().default(true),
});
export type PublishWorkflowInput = z.infer<typeof PublishWorkflowSchema>;

/**
 * POST /api/team/workflows/:id/manual-trigger
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
 * POST /api/team/workflows/:id/test
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
