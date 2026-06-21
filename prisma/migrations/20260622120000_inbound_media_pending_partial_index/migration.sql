-- Partial index for the inbound-media phase-2 recovery sweeper (2026-06-22).
--
-- apps/api/src/lib/sweepers/inbound-media.ts runs every 60s:
--   findMany({ direction: 'in', mediaKind: { not: null }, mediaUrl: null,
--              createdAt: { lt: cutoff } }, take: 100)
-- to recover inbound media whose phase-2 download never landed.
--
-- No existing Message index supports this predicate. The only inbound partial
-- (`Message_conversationId_timestamp_inbound_idx`) leads with `conversationId`,
-- which the sweeper does NOT constrain, so the query sequential-scans the
-- hottest-write table in the system every tick (the `take: 100` does not bound
-- the scan because the filter isn't index-backed). This partial — scoped to the
-- tiny "media still pending" subset; rows leave it the instant phase-2 writes
-- `mediaUrl` — turns the 60s tick into an index range scan.
--
-- Prisma-DSL-unrepresentable (no `WHERE ... IS NULL` predicate support), so
-- hand-written and marked permanent, same as the other partial indexes
-- (OutboundEvent_drainer_pending_idx, Contact_teamId_active_idx, ...).
--
-- CONCURRENTLY skipped: runs at migration time; brief lock on a small subset
-- is acceptable, matching the convention of the other partial-index migrations.
CREATE INDEX IF NOT EXISTS "Message_inbound_media_pending_idx"
  ON public."Message" ("createdAt")
  WHERE (
    direction = 'in'::public."MessageDirection"
    AND "mediaKind" IS NOT NULL
    AND "mediaUrl" IS NULL
  );
