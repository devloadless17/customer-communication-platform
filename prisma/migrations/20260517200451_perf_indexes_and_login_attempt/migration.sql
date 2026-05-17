-- Performance indexes + persistent login-attempt table.
--
-- Index rationale (all backed by review findings):
--
--   1. Conversation_teamId_contactId_idx
--      The broadcast runner does `findFirst({ where: { teamId, contactId } })`
--      once per recipient. Without this the planner falls back to
--      Conversation_teamId_status_lastMessageAt_idx and filters contactId in
--      the heap — fine at <1k conversations/team, seq-scan-per-recipient at 50k.
--
--   2. Message inbound-only partial index
--      Every text-send + mark-read + 24h-window check filters
--      `direction = 'in'`. The existing (conversationId, timestamp) indexes
--      don't include direction, so Postgres must filter in-memory after
--      pulling N rows. A partial index on inbound rows only is ~half the
--      size of the full index and lets these queries hit the index directly.
--      The schema.prisma comment claimed this existed; it didn't.
--
--   3. LoginAttempt table
--      Replaces the in-process Map in apps/web/src/lib/rate-limit.ts.
--      Failed-login counters and lockouts now survive process restarts
--      (deploys / OOM / systemd Restart=on-failure). Without this, every
--      restart resets brute-force history — which combined with the lowered
--      password floor leaves a real attack window.

CREATE INDEX "Conversation_teamId_contactId_idx"
  ON "Conversation" ("teamId", "contactId");

CREATE INDEX "Message_conversationId_inbound_timestamp_idx"
  ON "Message" ("conversationId", "timestamp" DESC)
  WHERE "direction" = 'in';

CREATE TABLE "LoginAttempt" (
  "email"        TEXT      NOT NULL,
  "failedCount"  INTEGER   NOT NULL DEFAULT 0,
  "lockedUntil"  TIMESTAMP(3),
  "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("email")
);

CREATE INDEX "LoginAttempt_lockedUntil_idx" ON "LoginAttempt" ("lockedUntil");
