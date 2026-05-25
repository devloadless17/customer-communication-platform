-- Backfill missing TeamChannelMember rows for every (user, default-channel)
-- pair where the user belongs to the channel's team but has no membership row.
--
-- Why this exists: the schema docs the default channel ('general') as
-- "implicitly including every team member" — but that invariant is enforced
-- at INSERT time (registration + invite-accept inserts the row). The
-- superadmin seed creates the team + channel + user directly without going
-- through those flows, so the superadmin user ended up with NO membership
-- row for #general.
--
-- The downstream symptom in production: opening /team triggered the redirect
-- to /team/<general-id>, which loaded TeamChatWorkspace with
--   - channels = listChannelsForUser() → []   (no memberships)
--   - initialChannel = getChannelById(generalId) → #general
-- TeamChatWorkspace then hits its "channel got deleted out from under us"
-- guard (channels.some(c => c.id === initialChannel.id) is false) and
-- router.replace("/team") — which re-runs the same loop. Looks like an
-- infinite browser refresh from the user's perspective; really it's a
-- Next.js client-navigation loop.
--
-- Fix is two-part: (a) update the seed to mirror registration's insert
-- (done in this commit), (b) this backfill so the existing prod superadmin
-- (and any other user the seed skipped) gets the missing row.
--
-- The INSERT is idempotent: anyone who already has the row is skipped by
-- ON CONFLICT DO NOTHING. Safe to re-run.

INSERT INTO "TeamChannelMember" ("channelId", "userId", "addedAt", "addedById")
SELECT c."id", u."id", NOW(), NULL
FROM "User" u
JOIN "TeamChannel" c
  ON c."teamId" = u."teamId"
  AND c."isDefault" = true
LEFT JOIN "TeamChannelMember" m
  ON m."channelId" = c."id"
  AND m."userId" = u."id"
WHERE m."channelId" IS NULL
  AND u."deactivatedAt" IS NULL
ON CONFLICT ("channelId", "userId") DO NOTHING;
