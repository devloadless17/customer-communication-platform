-- Outbound index tuning (2026-07-03, perfection audit findings #70 + #29).
--
-- #70 — DROP an unused index. OutboundSendAttempt's @@index([teamId, completedAt])
-- has ZERO query consumers: every read is by `jobId` (the @unique, used by the
-- send-path double-send guard and broadcast reconciler), by `attemptStartedAt`
-- (the retention sweeper scan), or via the raw-SQL join in
-- outbound-send-attempt-retention.ts (matches on jobId text). The composite
-- (teamId, completedAt) index is pure write amplification on the outbound-send
-- hot path, so it is removed.
DROP INDEX IF EXISTS "OutboundSendAttempt_teamId_completedAt_idx";

-- #29 — ADD a partial index for the orphan-webhook-delivery sweeper.
--
-- apps/api/src/lib/sweepers/orphan-webhook-delivery.ts runs every 60s:
--   findMany({ attemptCount: 0, deliveredAt: null, failedAt: null,
--              createdAt: { lt: cutoff } }, orderBy: { createdAt: 'asc' },
--              take: 100)
-- to re-enqueue deliveries whose BullMQ job never got picked up. The existing
-- indexes ([webhookId, createdAt], [createdAt]) don't support the selective
-- predicate: `createdAt < now-5min` matches ~every row, so the planner walks the
-- createdAt index from the oldest row and heap-filter-rejects every settled
-- delivery until it exhausts rows < cutoff. In the steady (zero-orphan) state
-- that is a near-full-table walk once a minute, forever, growing with the 30-day
-- retention window.
--
-- This partial — scoped to the tiny "never-picked-up" subset; rows leave it the
-- instant attemptCount increments or deliveredAt/failedAt is stamped — turns the
-- 60s tick into a bounded index range scan. Prisma-DSL-unrepresentable
-- (no `WHERE ... IS NULL` predicate support), so hand-written and marked
-- permanent, same convention as Message_inbound_media_pending_idx et al.
--
-- CONCURRENTLY skipped: runs at migration time on a subset that is empty in
-- steady state; the brief lock is acceptable, matching the other partial-index
-- migrations.
CREATE INDEX IF NOT EXISTS "OutboundWebhookDelivery_orphan_pending_idx"
  ON public."OutboundWebhookDelivery" ("createdAt")
  WHERE (
    "attemptCount" = 0
    AND "deliveredAt" IS NULL
    AND "failedAt" IS NULL
  );
