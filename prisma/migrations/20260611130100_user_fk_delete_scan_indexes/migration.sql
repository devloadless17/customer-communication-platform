-- Index the User-referencing FK columns that the referential-action scan walks
-- on a `user.delete(...)` (a live admin route). For each child table, the FK
-- trigger runs `WHERE <col> = $1` to SetNull (or Cascade) the deleted user's
-- rows; without an index that's a seq-scan, holding row locks on the inbox's
-- hottest tables inside the delete transaction.
--
-- Mirrors the established pattern (Message_senderUserId_idx 20260602120000,
-- Call_initiatedByUserId_idx 20260602130000) — that second migration's comment
-- even said the FK "mirrors answeredByUserId", but only indexed initiatedBy;
-- this closes that gap plus the five others on the larger tables.
--
-- Names match the Prisma-generated `@@index([col])` names so schema + DB stay
-- drift-free. IF NOT EXISTS = idempotent. No CONCURRENTLY (runs in the migrate
-- transaction; brief lock acceptable at pilot scale).

CREATE INDEX IF NOT EXISTS "InternalNote_authorUserId_idx"
  ON "InternalNote"("authorUserId");

CREATE INDEX IF NOT EXISTS "ConversationEvent_userId_idx"
  ON "ConversationEvent"("userId");

CREATE INDEX IF NOT EXISTS "TeamChannelMessage_authorUserId_idx"
  ON "TeamChannelMessage"("authorUserId");

CREATE INDEX IF NOT EXISTS "TeamChannelReaction_userId_idx"
  ON "TeamChannelReaction"("userId");

CREATE INDEX IF NOT EXISTS "Call_answeredByUserId_idx"
  ON "Call"("answeredByUserId");

CREATE INDEX IF NOT EXISTS "Conversation_assignedUserId_idx"
  ON "Conversation"("assignedUserId");
