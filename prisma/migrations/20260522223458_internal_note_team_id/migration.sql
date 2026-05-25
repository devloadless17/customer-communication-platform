-- Reconstructed migration (file was lost; changes already live in DB). Idempotent.
-- Adds teamId to InternalNote for tenant scoping + an index for note queries.
ALTER TABLE "InternalNote" ADD COLUMN IF NOT EXISTS "teamId" TEXT;

-- Backfill from the parent conversation for any pre-existing rows, then enforce
-- NOT NULL (no-op if already enforced).
UPDATE "InternalNote" n
SET "teamId" = c."teamId"
FROM "Conversation" c
WHERE n."conversationId" = c."id" AND n."teamId" IS NULL;

ALTER TABLE "InternalNote" ALTER COLUMN "teamId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "InternalNote_teamId_idx" ON "InternalNote" ("teamId");
