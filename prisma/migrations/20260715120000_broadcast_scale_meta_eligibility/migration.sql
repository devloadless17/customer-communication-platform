-- Large-scale WhatsApp template broadcasts + Meta messaging-eligibility layer.
--
-- Two additive changes, both safe (no existing-row rewrites):
--
-- 1) WhatsApp messaging-health snapshot on ChannelConnection. Cached from Meta
--    (webhooks + a periodic phone-number-node poll) so large broadcasts can be
--    gated on the number's messaging-limit TIER / quality / throughput BEFORE
--    sending. All nullable — a connection with no snapshot yet is simply ungated.
--    Stored as plain strings/ints (not enums) because Meta's tier/quality vocab
--    churns and we never want a migration just to track a new vendor value.
--
-- 2) A `materializing` value on BroadcastStatus. Large audiences (up to the 100k
--    cap) can't have their BroadcastRecipient rows built inside the create HTTP
--    request without blowing the tx budget, so recipients are inserted async by
--    the broadcast-materialize worker, which then flips `materializing` → `queued`
--    and kicks the runner. Postgres requires each ALTER TYPE ... ADD VALUE to be
--    its own statement and forbids USING the new value in the same transaction it
--    is added — this migration only DECLARES it, so it is safe.

ALTER TABLE "ChannelConnection" ADD COLUMN "messagingTier" TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN "messagingDailyCap" INTEGER;
ALTER TABLE "ChannelConnection" ADD COLUMN "qualityRating" TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN "throughputLevel" TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN "messagingHealthUpdatedAt" TIMESTAMP(3);

ALTER TYPE "BroadcastStatus" ADD VALUE IF NOT EXISTS 'materializing';
