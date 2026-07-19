-- Team chat: 1:1 direct messages + public/private channels.
--
-- DMs reuse TeamChannel via a `kind` discriminator rather than getting their
-- own tables. A DM's confidentiality requirement is exactly what a private
-- channel already enforces (TeamChannelMember + requireChannelMembership +
-- emitChannelScoped's fail-closed per-user fanout), so a parallel model would
-- duplicate the entire service, event taxonomy, fanout, room gate, media
-- proxy, threading and search for zero security benefit.
--
-- All column additions are nullable or defaulted, so on PG16 this is a
-- metadata-only catalog update — no table rewrite, no long lock.

CREATE TYPE "TeamChannelKind" AS ENUM ('channel', 'dm');
CREATE TYPE "TeamChannelVisibility" AS ENUM ('public', 'private');

ALTER TABLE "TeamChannel"
  ADD COLUMN "kind"       "TeamChannelKind"       NOT NULL DEFAULT 'channel',
  ADD COLUMN "visibility" "TeamChannelVisibility" NOT NULL DEFAULT 'private',
  ADD COLUMN "dmKey"      TEXT;

-- A DM has no name. NULL rather than a synthetic slug so the type checker
-- surfaces every consumer instead of letting a fake name leak into search
-- hits and page headings.
ALTER TABLE "TeamChannel" ALTER COLUMN "name" DROP NOT NULL;

-- Every existing non-default channel STAYS PRIVATE (the column default).
-- They were created under invite-only semantics, and flipping them public
-- would expose their message bodies to every team member through
-- searchAllChannels — the exact leak class the membership intersection in
-- that query exists to prevent. Only "#general", which is already implicitly
-- readable by the whole team, becomes public.
UPDATE "TeamChannel" SET "visibility" = 'public' WHERE "isDefault" = TRUE;

-- Guarantee every team member has an EXPLICIT membership row on their team's
-- default channel. Registration and invite-accept already insert this; the
-- backfill covers teams provisioned before those paths existed.
--
-- This is what lets searchAllChannels drop its `OR isDefault = true` branch.
-- That branch granted workspace search over the default channel regardless of
-- membership — harmless while "default" implied "everyone", but a real leak
-- once visibility is a first-class concept and a default channel could be
-- demoted. After this backfill, dropping it costs nobody their #general
-- search results.
INSERT INTO "TeamChannelMember" ("channelId", "userId", "addedAt")
SELECT c."id", u."id", NOW()
FROM "TeamChannel" c
JOIN "User" u ON u."teamId" = c."teamId"
WHERE c."isDefault" = TRUE
ON CONFLICT DO NOTHING;

-- The DM dedup guarantee: one row per (team, participant-pair), so opening a
-- DM twice — from either side — always resolves to the same channel. The
-- service upserts against this constraint rather than doing a bare create.
CREATE UNIQUE INDEX "TeamChannel_teamId_dmKey_key"
  ON "TeamChannel" ("teamId", "dmKey");

-- Serves the DM list and the channel list, both of which now filter on kind
-- before ordering by recency.
--
-- LOCKING NOTE: plain CREATE INDEX, not CONCURRENTLY, because Prisma applies
-- each migration inside a transaction and CONCURRENTLY cannot run in one.
-- Same documented tradeoff as 20260718110949 — cheap now, expensive later.
CREATE INDEX "TeamChannel_teamId_kind_lastMessageAt_idx"
  ON "TeamChannel" ("teamId", "kind", "lastMessageAt" DESC);
