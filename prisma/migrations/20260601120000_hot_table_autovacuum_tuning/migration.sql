-- Per-table autovacuum + autoanalyze tuning for the 5 highest-write tables
-- (2026-06-01). Postgres' global defaults (autovacuum_vacuum_scale_factor=0.20,
-- autovacuum_analyze_scale_factor=0.10) trigger maintenance only after a table
-- has grown by 20% / been modified by 10% since the previous run. On our hot
-- tables that means bloat + stale planner statistics accumulate long enough to
-- regress query plans (the partial Message_inbound index, the Conversation
-- list-order composite, the OutboundEvent retention partial). Per-table
-- overrides set tighter thresholds without touching the cluster-wide knobs in
-- docker-compose; Postgres reloads these from pg_class.reloptions on the next
-- autovacuum worker cycle, so no restart is needed.
--
-- HOT tier (scale_factor 0.05 / analyze 0.025): vacuum every ~5% bloat,
-- analyze every ~2.5% writes. Picked for tables on the inbound/outbound write
-- path where every webhook and every send touches them.
--   * Message            — inbound + outbound rows, ~1.1M/month at pilot scale,
--                          partial inbound index needs fresh stats for the
--                          inbox query planner
--   * OutboundEvent      — outbox drainer claims/marks rows continuously; the
--                          retention sweeper deletes daily — high churn floor
--
-- WARM tier (scale_factor 0.10 / analyze 0.05): vacuum at ~10% bloat,
-- analyze at ~5% writes. Updated on every message but row count is far lower
-- than the hot tier.
--   * Conversation             — lastMessageAt + unreadCount bumped per message;
--                                 list ordering depends on stats freshness
--   * ConversationEvent        — audit subscriber writes on every status/
--                                 assignment/tag/note transition; retention at
--                                 90 days
--   * OutboundWebhookDelivery  — delivery worker writes + 5xx retries + 30-day
--                                 retention sweep — high turnover
--
-- Monitoring: watch pg_stat_user_tables.n_live_tup / n_dead_tup, last_vacuum,
-- last_autovacuum, last_analyze, last_autoanalyze. If n_dead_tup keeps growing
-- between autovacuum runs, ratchet scale_factor lower (or add a vacuum_cost
-- override). Inspect current per-table overrides with:
--   SELECT relname, reloptions FROM pg_class WHERE reloptions IS NOT NULL;

ALTER TABLE "Message" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.025
);

ALTER TABLE "OutboundEvent" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.025
);

ALTER TABLE "Conversation" SET (
  autovacuum_vacuum_scale_factor = 0.10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE "ConversationEvent" SET (
  autovacuum_vacuum_scale_factor = 0.10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE "OutboundWebhookDelivery" SET (
  autovacuum_vacuum_scale_factor = 0.10,
  autovacuum_analyze_scale_factor = 0.05
);
