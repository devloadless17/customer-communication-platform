-- Denormalized API-key actor on close (mirrors closedByUserId) so /v1 + workflow
-- closes are attributable on the durable row. Additive, nullable, no backfill.
ALTER TABLE "Conversation" ADD COLUMN "closedByApiKeyId" TEXT;

-- Workflow actor on the audit timeline so an automation-driven assign/close/AI
-- toggle renders as "by workflow «name»" instead of a bare "System". Additive.
ALTER TABLE "ConversationEvent" ADD COLUMN "workflowId" TEXT;
