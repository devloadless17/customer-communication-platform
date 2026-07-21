-- Per-message hallucination self-score (see REPLY_SCHEMA + lib/ai/hallucination.ts).
-- AlterTable
ALTER TABLE "AiMessageMetadata" ADD COLUMN "hallucinationRisk" DOUBLE PRECISION,
ADD COLUMN "hallucinationNotes" TEXT;

-- Agents can no longer explicitly "disable" the AI assistant on a
-- conversation (only pause/resume remain) — the `disabled` state is now
-- unreachable from application code. Move any pre-existing disabled rows to
-- ai_paused so no conversation is left stuck in a state the UI can no longer
-- surface an action for. The `disabled` enum label itself is left in place
-- (see schema.prisma comment) rather than dropped, since removing a Postgres
-- enum value requires a full type-swap for zero benefit — it is simply dead.
UPDATE "AiConversationState" SET "state" = 'ai_paused', "stateChangedAt" = CURRENT_TIMESTAMP WHERE "state" = 'disabled';
