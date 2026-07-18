-- Broadcast delivery truth — the correctness fix behind campaign reporting.
--
-- THE BUG THIS FIXES: when Meta accepts a send but the message later fails to
-- deliver (handset off, invalid number, user blocked, per-user marketing cap),
-- Meta fires an async `failed` status webhook. That webhook updated the Message
-- row but NEVER touched BroadcastRecipient, so those recipients stayed
-- status='sent' forever and counted as successes in sentCount. "Who never
-- received it" was answered wrongly — the people who did not receive the
-- message were reported as if they had.
--
-- The delivery data itself has been recorded correctly on Message all along
-- (status ladder + statusErrorCode/Title/Detail), so a follow-up backfill
-- script can retroactively correct EVERY historical campaign.
--
-- LOCKING NOTE: plain CREATE INDEX, not CONCURRENTLY — Prisma applies each
-- migration inside a transaction and CONCURRENTLY cannot run in one. Same
-- deliberate tradeoff documented in 20260718110949: ship the build now while
-- the tables are pilot-sized and it is sub-second, because the same index is
-- far more expensive to add later against a big client's data.
--
-- Column adds are all nullable or defaulted, so on PG16 they are metadata-only
-- (no table rewrite) even on Message, the hottest write table in the product.

CREATE TYPE "BroadcastDeliveryState" AS ENUM (
  'pending', 'failed_at_send', 'sent', 'delivered', 'read', 'undelivered'
);

ALTER TABLE "BroadcastRecipient"
  ADD COLUMN "deliveryState" "BroadcastDeliveryState" NOT NULL DEFAULT 'pending',
  ADD COLUMN "deliveredAt"   TIMESTAMP(3),
  ADD COLUMN "readAt"        TIMESTAMP(3),
  ADD COLUMN "errorCode"     TEXT,
  ADD COLUMN "metaErrorCode" INTEGER,
  -- NOT NULL + DEFAULT so existing rows get a value without a rewrite; Prisma's
  -- @updatedAt maintains it from here.
  ADD COLUMN "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The durable broadcast link. Previously this lived only inside Message.rawPayload,
-- which the retention sweeper collapses to {"sentVia":"broadcast"} — destroying the
-- id. It is also the zero-cost discriminator that lets ingestStatusUpdate decide
-- whether to propagate a status to a recipient without any extra query.
ALTER TABLE "Message" ADD COLUMN "broadcastId" TEXT;

-- Forward-fill: existing recipients must not all read as 'pending'. A completed
-- campaign's rows are 'sent' or 'failed_at_send'. Single statement — safe at the
-- current pilot scale, same reasoning as the index note above.
UPDATE "BroadcastRecipient"
SET "deliveryState" = CASE "status"
  WHEN 'sent'   THEN 'sent'::"BroadcastDeliveryState"
  WHEN 'failed' THEN 'failed_at_send'::"BroadcastDeliveryState"
  ELSE 'pending'::"BroadcastDeliveryState"
END;

-- Campaign report: serves BOTH the funnel GROUP BY deliveryState (leading two
-- columns) and the filtered drill-down ORDER BY id (trailing sort key keeps each
-- page a bounded range scan). No 2-column variant — redundant leftmost prefix.
CREATE INDEX "BroadcastRecipient_broadcastId_deliveryState_id_idx"
  ON "BroadcastRecipient"("broadcastId", "deliveryState", "id");

-- Partial: broadcastId is NULL for every ordinary message, so a full index would
-- be mostly-NULL dead weight on the largest table in the database.
CREATE INDEX "Message_broadcastId_idx" ON "Message"("broadcastId") WHERE "broadcastId" IS NOT NULL;
