-- New workflow step type: `send_conversions_event` — the Meta Conversions API
-- signal (action_source: business_messaging) that closes the CTWA /
-- click-to-Messenger ad-optimization loop. Enum value only; the step's config
-- lives in the workflow graph JSON, so no table changes.
--
-- PG 16 allows ADD VALUE inside the migration transaction as long as the new
-- value is not USED in the same transaction — it isn't. IF NOT EXISTS keeps a
-- dev-database pre-apply idempotent.
ALTER TYPE "WorkflowStepType" ADD VALUE IF NOT EXISTS 'send_conversions_event';
