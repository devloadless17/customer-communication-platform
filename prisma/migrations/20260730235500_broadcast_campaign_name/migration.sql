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
-- `migrate diff` and `check:prisma-fields`; the @@index in schema.prisma is the
-- non-partial approximation Prisma is able to represent.
--
-- It stays HERE and is NOT mirrored into 0_init's hand-maintained section. That
-- section carries only indexes the BASELINE itself must recreate, and this one
-- keys on "campaignName" — a column 0_init's CREATE TABLEs do not have, because
-- this migration adds it. Mirroring it there would fail every FRESH database at
-- `column "campaignName" does not exist` while every already-migrated box sailed
-- past, which is exactly how the `*_event_key_uniq` and
-- `Message_template_send_budget_idx` traps went off (see 0_init's notes). Fold
-- it in only when the baseline is next re-squashed, together with its column.
-- `apps/api/test/partial-indexes.spec.ts` asserts it either way.
CREATE INDEX IF NOT EXISTS "Broadcast_campaign_rollup_idx"
  ON "Broadcast" ("workspaceId", "campaignName", "createdAt" DESC)
  WHERE "campaignName" IS NOT NULL;
