-- Broadcast.campaignName — the free-text label that rolls several sends up into
-- one campaign (one per channel, one per account, a re-send to non-openers, a
-- follow-up next week). See the schema docblock for why this is a string rather
-- than a Campaign table.
ALTER TABLE "Broadcast" ADD COLUMN "campaignName" TEXT;

-- "every send in this campaign, newest first" — the rollup's query.
--
-- PARTIAL, on NOT NULL: an ad-hoc broadcast with no campaign is the common case,
-- and indexing those nulls is pure write cost for rows the query never reaches.
-- Prisma's DSL cannot express a WHERE, so this index is invisible to
-- `migrate diff` and `check:prisma-fields` — it belongs to the hand-maintained
-- set documented at the bottom of 0_init, and the @@index in schema.prisma is
-- the non-partial approximation Prisma is able to represent.
CREATE INDEX IF NOT EXISTS "Broadcast_campaign_rollup_idx"
  ON "Broadcast" ("workspaceId", "campaignName", "createdAt" DESC)
  WHERE "campaignName" IS NOT NULL;
