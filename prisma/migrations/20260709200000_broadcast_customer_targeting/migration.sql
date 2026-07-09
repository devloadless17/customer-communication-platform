-- Per-Customer (omnichannel) broadcast targeting: reach each PERSON once on
-- their best live channel. Additive + back-compatible (default 'contact' =
-- today's single-channel behavior).
CREATE TYPE "BroadcastTargetMode" AS ENUM ('contact', 'customer');

ALTER TABLE "Broadcast"
  ADD COLUMN "targetMode" "BroadcastTargetMode" NOT NULL DEFAULT 'contact';

ALTER TABLE "BroadcastRecipient"
  ADD COLUMN "customerId" TEXT;
