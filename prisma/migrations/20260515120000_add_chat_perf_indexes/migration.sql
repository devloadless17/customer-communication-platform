-- Performance indexes for the hot chat-listing + thread-load paths.
--
-- These don't change any data and don't change the table shape. Adding an
-- index on a small table is near-instant; on tables with millions of rows
-- this would warrant `CREATE INDEX CONCURRENTLY` (which can't run inside
-- Prisma's migration transaction). At pilot scale every Message /
-- Conversation table here is small enough that the brief AccessExclusive
-- lock is invisible. Re-apply these as CONCURRENTLY by hand if a future
-- run hits a populated production DB.

-- 1. Conversation listing keyset.
--    Query: SELECT … FROM "Conversation" WHERE "teamId" = $1
--           ORDER BY "lastMessageAt" DESC, "id" DESC LIMIT $2;
--    The existing (teamId, status, lastMessageAt) index needs status in
--    WHERE to be useful; the inbox doesn't filter by status server-side.
CREATE INDEX "Conversation_teamId_lastMessageAt_id_idx"
  ON "Conversation" ("teamId", "lastMessageAt" DESC, "id" DESC);

-- 2. Message thread keyset (initial load + load-older).
--    Query: SELECT … FROM "Message" WHERE "conversationId" = $1
--           ORDER BY "timestamp" DESC, "id" DESC LIMIT $2;
--    The existing (conversationId, timestamp) index is ascending; backward
--    scans work but a matching DESC index is faster and adds the id
--    tiebreaker that the keyset cursor depends on for same-ms inserts.
CREATE INDEX "Message_conversationId_timestamp_id_idx"
  ON "Message" ("conversationId", "timestamp" DESC, "id" DESC);

-- 3. Inbound-only partial index.
--    Query: SELECT "timestamp" FROM "Message"
--           WHERE "direction" = 'in' AND "conversationId" IN (…)
--           ORDER BY "timestamp" DESC LIMIT 1;
--    Used by fetchLastInboundMap (24h-window chip on the conversation list)
--    and getConversationWithRefs (per-thread lastInboundAt). In most chat
--    flows outbound rows outnumber inbound; the partial index is smaller
--    and hotter than indexing the full table on direction.
--    Prisma can't express partial indexes — the schema carries a comment
--    pointing at this migration as the source of truth.
CREATE INDEX "Message_inbound_conversationId_timestamp_idx"
  ON "Message" ("conversationId", "timestamp" DESC)
  WHERE "direction" = 'in';
