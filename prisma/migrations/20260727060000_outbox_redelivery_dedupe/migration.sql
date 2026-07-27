-- Redelivery dedupe keys (2026-07-27).
--
-- The outbox became at-least-once (claim lease, 20260727050000). Three
-- subscribers write NON-idempotent side effects, so a crash-window redelivery
-- would duplicate them: a second WorkflowRun re-executing every step
-- (including a second BILLED Meta send), a second partner webhook with a
-- fresh delivery id (defeating dedupe on both sides), and a second identical
-- audit pill. Each now carries a nullable `eventKey` derived from the outbox
-- row id; the PARTIAL UNIQUE indexes below (partial so the sync publish path,
-- which never redelivers, keeps writing NULLs freely) turn the duplicate into
-- a P2002 the writer swallows as "already delivered".
ALTER TABLE "WorkflowRun" ADD COLUMN "eventKey" TEXT;
ALTER TABLE "ConversationEvent" ADD COLUMN "eventKey" TEXT;
ALTER TABLE "OutboundWebhookDelivery" ADD COLUMN "eventKey" TEXT;

-- PARTIAL UNIQUE — invisible to `prisma migrate diff` and the Prisma DSL, so
-- these MUST also be carried by hand in the 0_init baseline's raw-SQL section
-- (see CLAUDE.md §18) and pinned by apps/api/test/partial-indexes.spec.ts.
CREATE UNIQUE INDEX "WorkflowRun_event_key_uniq"
  ON "WorkflowRun" ("eventKey") WHERE "eventKey" IS NOT NULL;
CREATE UNIQUE INDEX "ConversationEvent_event_key_uniq"
  ON "ConversationEvent" ("eventKey") WHERE "eventKey" IS NOT NULL;
CREATE UNIQUE INDEX "OutboundWebhookDelivery_event_key_uniq"
  ON "OutboundWebhookDelivery" ("eventKey") WHERE "eventKey" IS NOT NULL;
