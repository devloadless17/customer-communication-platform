-- Make the portfolio 24h messaging budget count ALL template sends.
--
-- WhatsApp's messaging limit caps how many UNIQUE customers a business portfolio
-- may message outside a customer-service window in a rolling 24h. Our counter read
-- `BroadcastRecipient` alone, so template sends driven by a workflow, the inbox
-- composer or the `/v1` API consumed Meta's real budget while being invisible to
-- the gate — the counter self-documented as a LOWER BOUND, and the reason given was
-- exactly this: "widening it to all template sends needs a template marker on
-- Message, which does not exist today".
--
-- `rawPayload` could not serve as the marker: the message-rawpayload-retention
-- sweeper collapses that blob, which is the same reason `broadcastId` was promoted
-- to a real column.

ALTER TABLE "Message" ADD COLUMN "templateName" TEXT;

-- Plain index: per-account reporting and the budget query both filter Message by
-- the account that carried it, and unindexed that is a sequential scan of the
-- largest table in the schema.
CREATE INDEX "Message_channelConnectionId_idx" ON "Message"("channelConnectionId");

-- PARTIAL index for the budget query itself: outbound template sends that are NOT
-- part of a broadcast (broadcasts are still counted from `BroadcastRecipient`,
-- which stays authoritative for them — see the union in `recentUniqueRecipientIds`).
-- Prisma's DSL cannot express a WHERE clause, so this lives in raw SQL and is
-- therefore INVISIBLE to `migrate diff` and `check:prisma-fields`. It is mirrored
-- asserted by `apps/api/test/partial-indexes.spec.ts` — keep both in lockstep.
--
-- Deliberately NOT mirrored into `0_init`'s hand-maintained section, unlike the
-- other raw partial indexes: both columns it references are added HERE, so a copy
-- in the baseline runs before they exist and fails a fresh database outright
-- (P3018 / 42703). See the note left in its place at the bottom of 0_init.
CREATE INDEX "Message_template_send_budget_idx"
  ON "Message" ("channelConnectionId", "createdAt" DESC)
  WHERE ("direction" = 'out' AND "templateName" IS NOT NULL AND "broadcastId" IS NULL);
