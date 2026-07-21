-- Per-message hallucination self-score (see REPLY_SCHEMA + lib/ai/hallucination.ts).
-- AlterTable
ALTER TABLE "AiMessageMetadata" ADD COLUMN "hallucinationRisk" DOUBLE PRECISION,
ADD COLUMN "hallucinationNotes" TEXT;
