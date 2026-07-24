-- Exactly ONE default account per (workspace, channel), enforced by the DB.
--
-- `isDefault` decides which number/Page/handle an outbound-initiated send and a
-- broadcast go out from, and which account the settings + health panels
-- describe. Every read of it is `findFirst({ isDefault: true })` — so with two
-- defaults the answer is whatever Postgres returns first, and a workspace can
-- silently send from the wrong number.
--
-- Nothing prevented that state. `setDefault()` clears-then-sets inside one
-- transaction (correct), but `normalizeDefaultAccount` only PROMOTES when there
-- are zero active defaults; it never demotes extras. So a second default —
-- introduced by a seed, a fixture, a manual fix-up, or a future code path —
-- was permanent and self-healing never kicked in. This is the constraint that
-- makes the invariant structural instead of conventional.
--
-- Partial, because Prisma cannot express `WHERE "isDefault"`: a plain
-- @@unique([workspaceId, channel]) would forbid a workspace holding SEVERAL
-- accounts on one channel, which is the entire feature. Same pattern as
-- Conversation_teamId_openFlag_idx.
--
-- Safe to apply: the clear-then-set ordering inside both existing transactions
-- means the intermediate state always has zero defaults, never two.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_one_default_per_channel"
  ON "ChannelConnection" ("workspaceId", "channel")
  WHERE "isDefault";
