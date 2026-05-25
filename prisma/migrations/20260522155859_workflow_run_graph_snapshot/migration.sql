-- Reconstructed migration (file was lost; changes already live in DB). Idempotent.
-- Pins the workflow graph at run-creation so a mid-flight run survives a later
-- edit of the workflow definition.
ALTER TABLE "WorkflowRun" ADD COLUMN IF NOT EXISTS "graphSnapshot" JSONB;
