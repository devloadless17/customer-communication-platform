-- Global inbox search ("Messages" + "Comments" tabs). The team-wide search
-- runs an ILIKE on Message.body / InternalNote.body with NO conversation
-- predicate to narrow the scan, so a trigram GIN index carries it — same
-- pattern already used for Contact.name (Contact_name_trgm_idx) and
-- Conversation.lastMessagePreview (Conversation_lastMessagePreview_trgm_idx).
--
-- pg_trgm is already enabled (see 0_init). IF NOT EXISTS keeps this idempotent
-- against a DB where a hotfix added the index out-of-band.
--
-- These are GIN builds: on a large table they take a write-lock for the build
-- duration. CONCURRENTLY would avoid that but can't run inside Prisma's
-- migration transaction. At pilot scale both tables are small enough that the
-- brief lock is fine; if either grows past a few million rows, build the index
-- out-of-band with CREATE INDEX CONCURRENTLY and mark the migration applied.
CREATE INDEX IF NOT EXISTS "Message_body_trgm_idx" ON "Message" USING GIN ("body" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "InternalNote_body_trgm_idx" ON "InternalNote" USING GIN ("body" gin_trgm_ops);
