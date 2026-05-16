-- Team chat: internal channels between agents on the same team. See the
-- TeamChannel block in prisma/schema.prisma for the design rationale.
--
-- Backfills one #general channel per existing team in the same migration so
-- the /team route has somewhere to land on first visit.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

CREATE TABLE "TeamChannel" (
    "id"                 TEXT NOT NULL,
    "teamId"             TEXT NOT NULL,
    "name"               TEXT NOT NULL,
    "description"        TEXT,
    "isDefault"          BOOLEAN NOT NULL DEFAULT false,
    "createdById"        TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    "lastMessageAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TeamChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamChannel_teamId_name_key" ON "TeamChannel"("teamId", "name");
CREATE INDEX "TeamChannel_teamId_lastMessageAt_idx" ON "TeamChannel"("teamId", "lastMessageAt" DESC);

ALTER TABLE "TeamChannel"
    ADD CONSTRAINT "TeamChannel_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannel"
    ADD CONSTRAINT "TeamChannel_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------

CREATE TABLE "TeamChannelMessage" (
    "id"               TEXT NOT NULL,
    "channelId"        TEXT NOT NULL,
    "teamId"           TEXT NOT NULL,
    "authorUserId"     TEXT,
    "body"             TEXT NOT NULL,
    "mediaKind"        TEXT,
    "mediaKey"         TEXT,
    "mediaUrl"         TEXT,
    "mediaMimeType"    TEXT,
    "mediaCaption"     TEXT,
    "mediaFilename"    TEXT,
    "mediaSizeBytes"   INTEGER,
    "mediaDurationMs"  INTEGER,
    "editedAt"         TIMESTAMP(3),
    "threadRootId"     TEXT,
    "threadReplyCount" INTEGER NOT NULL DEFAULT 0,
    "threadLastReplyAt" TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TeamChannelMessage_channelId_createdAt_id_idx"
    ON "TeamChannelMessage"("channelId", "createdAt" DESC, "id" DESC);
CREATE INDEX "TeamChannelMessage_threadRootId_createdAt_idx"
    ON "TeamChannelMessage"("threadRootId", "createdAt");
CREATE INDEX "TeamChannelMessage_teamId_idx" ON "TeamChannelMessage"("teamId");

-- Partial index: top-level channel feed reads `WHERE channelId = ? AND
-- threadRootId IS NULL`. Without the predicate, replies pollute the index
-- and bloat it 2-3x on busy channels. Prisma can't model partial indexes
-- in @@index, so declare here. The Prisma schema's @@index for the same
-- columns still serves the thread-panel read.
CREATE INDEX "TeamChannelMessage_channel_root_keyset"
    ON "TeamChannelMessage"("channelId", "createdAt" DESC, "id" DESC)
    WHERE "threadRootId" IS NULL;

ALTER TABLE "TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TeamChannelMessage"
    ADD CONSTRAINT "TeamChannelMessage_threadRootId_fkey"
    FOREIGN KEY ("threadRootId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------

CREATE TABLE "TeamChannelMention" (
    "id"              TEXT NOT NULL,
    "messageId"       TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,

    CONSTRAINT "TeamChannelMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamChannelMention_messageId_mentionedUserId_key"
    ON "TeamChannelMention"("messageId", "mentionedUserId");
CREATE INDEX "TeamChannelMention_mentionedUserId_idx"
    ON "TeamChannelMention"("mentionedUserId");

ALTER TABLE "TeamChannelMention"
    ADD CONSTRAINT "TeamChannelMention_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelMention"
    ADD CONSTRAINT "TeamChannelMention_mentionedUserId_fkey"
    FOREIGN KEY ("mentionedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------

CREATE TABLE "TeamChannelReaction" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "emoji"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamChannelReaction_messageId_userId_emoji_key"
    ON "TeamChannelReaction"("messageId", "userId", "emoji");
CREATE INDEX "TeamChannelReaction_messageId_idx"
    ON "TeamChannelReaction"("messageId");

ALTER TABLE "TeamChannelReaction"
    ADD CONSTRAINT "TeamChannelReaction_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelReaction"
    ADD CONSTRAINT "TeamChannelReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------

CREATE TABLE "TeamChannelPin" (
    "id"         TEXT NOT NULL,
    "channelId"  TEXT NOT NULL,
    "messageId"  TEXT NOT NULL,
    "pinnedById" TEXT,
    "pinnedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelPin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamChannelPin_messageId_key" ON "TeamChannelPin"("messageId");
CREATE INDEX "TeamChannelPin_channelId_pinnedAt_idx"
    ON "TeamChannelPin"("channelId", "pinnedAt" DESC);

ALTER TABLE "TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "TeamChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelPin"
    ADD CONSTRAINT "TeamChannelPin_pinnedById_fkey"
    FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------

CREATE TABLE "TeamChannelReadReceipt" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "channelId"  TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChannelReadReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamChannelReadReceipt_userId_channelId_key"
    ON "TeamChannelReadReceipt"("userId", "channelId");
CREATE INDEX "TeamChannelReadReceipt_channelId_idx"
    ON "TeamChannelReadReceipt"("channelId");

ALTER TABLE "TeamChannelReadReceipt"
    ADD CONSTRAINT "TeamChannelReadReceipt_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamChannelReadReceipt"
    ADD CONSTRAINT "TeamChannelReadReceipt_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- 2. Backfill: one #general channel per existing team.
-- ===========================================================================
--
-- Generates a cuid-shaped id with `'c' || lower(md5(...))` — Prisma's cuid()
-- requires the client, but at SQL level any 25-char string starting with a
-- letter satisfies @id @default(cuid()) for existing rows. Deterministic on
-- teamId so a re-run is idempotent against itself (the unique on (teamId,
-- name) protects against double-inserts anyway).
INSERT INTO "TeamChannel" ("id", "teamId", "name", "description", "isDefault", "createdById", "createdAt", "updatedAt", "lastMessageAt", "lastMessagePreview")
SELECT
    'c' || substring(md5('team_chat_general_' || t."id") from 1 for 24),
    t."id",
    'general',
    'Team-wide chat. Welcome!',
    true,
    NULL,
    NOW(),
    NOW(),
    NOW(),
    ''
FROM "Team" t
ON CONFLICT ("teamId", "name") DO NOTHING;
