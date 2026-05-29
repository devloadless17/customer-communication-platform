-- OutboundEvent retention sweeper index
--
-- The retention sweeper (apps/api/src/lib/sweepers/outbound-event-retention.ts)
-- runs once daily and deletes rows where:
--   publishedAt IS NOT NULL AND publishedAt < cutoff AND failedAt IS NULL
--
-- The only existing OutboundEvent index — OutboundEvent_drainer_pending_idx —
-- is partial and covers ONLY rows with `publishedAt IS NULL AND failedAt IS
-- NULL`. The sweeper's WHERE clause filters the COMPLEMENT, so until this
-- index lands the daily sweep does a full table scan + lock-while-deleting
-- that grows linearly with the (~10⁵–10⁶ rows/team-month) retention window.
--
-- Prisma's schema DSL can't express a partial index keyed on `publishedAt`
-- with the "IS NOT NULL" predicate cleanly — hand-written here, marked
-- permanent in the same way Contact_customFields_gin_idx is permanent.
--
-- CONCURRENTLY skipped: this runs once at migration time on a freshly-rolled
-- schema; a brief write lock during initial build is acceptable.
CREATE INDEX IF NOT EXISTS "OutboundEvent_retention_idx"
  ON public."OutboundEvent" ("publishedAt")
  WHERE "publishedAt" IS NOT NULL AND "failedAt" IS NULL;
