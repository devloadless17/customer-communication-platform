-- Scale indexes: the three query shapes that degrade as a tenant's data grows.
--
-- LOCKING NOTE: these are plain CREATE INDEX (not CONCURRENTLY) because Prisma
-- applies each migration inside a transaction, and CONCURRENTLY cannot run in
-- one. A plain build holds a write lock on the table for its duration, so this
-- is deliberately shipped NOW, while the tables are still pilot-sized and the
-- build is sub-second. The same index is far more expensive to add later,
-- against a big client's data, which is exactly when it is most needed.

-- "Mine" inbox: WHERE teamId = ? AND assignedUserId = ?
--               ORDER BY lastMessageAt DESC, id DESC.
-- The existing (teamId, assignedUserId) index stopped before the sort key, so
-- every page read all of that agent's conversations and re-sorted them.
CREATE INDEX "Conversation_teamId_assignedUserId_lastMessageAt_id_idx" ON "Conversation"("teamId", "assignedUserId", "lastMessageAt" DESC, "id" DESC);

-- Broadcast send loop: WHERE broadcastId = ? AND status = 'queued'
--                      ORDER BY id ASC, keyset cursor on id.
-- Without id in the index each page rescanned the whole remaining queued set, so
-- a 100k-recipient broadcast got slower the further through it ran.
CREATE INDEX "BroadcastRecipient_broadcastId_status_id_idx" ON "BroadcastRecipient"("broadcastId", "status", "id");

-- Daily auth cleanup: DELETE WHERE expiresAt < now(). Previously a sequential
-- scan of every session row, while holding the sweeper mutex.
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- Pre-existing drift, NOT part of this change: Prisma normalises an index name
-- that exceeded Postgres's 63-character identifier limit. Guarded, because an
-- unguarded ALTER ... RENAME throws when the source name is absent — that would
-- fail the deploy and trip auto-rollback over a purely cosmetic rename.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'ConversationSessionSummary_teamId_conversationId_sessionStartAt'
  ) THEN
    ALTER INDEX "ConversationSessionSummary_teamId_conversationId_sessionStartAt"
      RENAME TO "ConversationSessionSummary_teamId_conversationId_sessionSta_idx";
  END IF;
END $$;
