-- N2 (docs/architecture-review-2026-05-25-pass2.md): index to drive the
-- ConversationEvent retention sweeper's `WHERE at < cutoff` scan. The existing
-- composite [conversationId, at] leads with conversationId and can't serve an
-- at-only filter. CONCURRENTLY would avoid a write-lock on a large table, but
-- Prisma migrations run in a transaction (no CONCURRENTLY) — the table is small
-- enough at pilot scale that a brief lock is fine; revisit if it ever isn't.
CREATE INDEX IF NOT EXISTS "ConversationEvent_at_idx" ON "ConversationEvent" ("at");
