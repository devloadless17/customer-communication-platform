-- Reconstructed migration (file was lost; changes already live in DB). Idempotent.
-- Drops the legacy Workflow.enabled flag (status is the single source of truth).
ALTER TABLE "Workflow" DROP COLUMN IF EXISTS "enabled";
