-- Add InternalNote.teamId for rule-#2 tenant-scoping consistency (every other
-- table is team-scoped; its sibling audit table ConversationEvent already has
-- teamId). A note's team always equals its parent Conversation's team, so this
-- is a stable denorm. Hand-written as a safe additive sequence
-- (nullable -> backfill -> NOT NULL -> FK -> index) so it never fails on
-- existing rows; every note has a conversation (onDelete: Cascade), so the
-- backfill leaves no NULLs.
ALTER TABLE "InternalNote" ADD COLUMN "teamId" TEXT;

UPDATE "InternalNote" n
SET "teamId" = c."teamId"
FROM "Conversation" c
WHERE n."conversationId" = c."id";

ALTER TABLE "InternalNote" ALTER COLUMN "teamId" SET NOT NULL;

ALTER TABLE "InternalNote"
  ADD CONSTRAINT "InternalNote_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "InternalNote_teamId_idx" ON "InternalNote"("teamId");
