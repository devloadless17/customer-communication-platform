-- Partial index for the per-team outbox drainer probe (audit fix 2026-07-20).
--
-- lib/events/outbox.ts claimBatch() runs a per-team LATERAL:
--   SELECT ... FROM "OutboundEvent" o
--   WHERE o."teamId" = t."teamId" AND o."publishedAt" IS NULL AND o."failedAt" IS NULL
--   ORDER BY o."createdAt" ASC LIMIT <batch>
--
-- The only pending index (OutboundEvent_drainer_pending_idx) is a partial btree
-- on ("createdAt") ALONE — no teamId. So each small-team probe walks the
-- createdAt-ordered pending index filtering by teamId and, for any team with
-- fewer than <batch> pending rows, scans to the END of the whole pending
-- backlog. Under a large-broadcast backlog (250k-350k rows/campaign) drainer
-- throughput collapses precisely when a backlog exists — stalling ALL tx-event
-- fanout (inbox realtime, outbound webhooks, workflows).
--
-- This partial matches the probe exactly: leading teamId for the equality, then
-- createdAt for the ORDER BY + LIMIT, scoped to the pending subset (rows leave
-- it the instant the drainer stamps publishedAt/failedAt). The createdAt-only
-- partial is kept — the wedge watchdog's global "oldest pending" probe still
-- uses it.
--
-- Prisma-DSL-unrepresentable (WHERE ... IS NULL), hand-written + permanent, same
-- convention as OutboundEvent_drainer_pending_idx.
CREATE INDEX IF NOT EXISTS "OutboundEvent_drainer_pending_team_idx"
  ON public."OutboundEvent" ("teamId", "createdAt")
  WHERE (("publishedAt" IS NULL) AND ("failedAt" IS NULL));
